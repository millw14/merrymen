/**
 * merrymen desktop — the one-click app.
 *
 * Electron ships its own Node, so a user double-clicks the installer and never
 * touches a terminal. On launch this main process:
 *   1. shows a loading splash,
 *   2. spawns the merrymen dashboard (next start) + agent worker (tsx) as child
 *      processes, using Electron-as-Node (ELECTRON_RUN_AS_NODE) — no system Node,
  *   3. waits for the dashboard on 127.0.0.1:17430,
 *   4. loads it in a native window.
 *
 * CONTROL (same as the CLI, without a terminal): a system-tray icon lets you
 * Pause/Resume the agent (writes ~/.merrymen/paused, the exact marker the tick
 * loop honors — same as Telegram /pause), restart it, reopen the dashboard, or
 * quit. Closing the window keeps the agent running in the tray; only "Quit" stops
 * everything. The dashboard itself still handles settings, the grant, and the
 * kill switch. Data lives in ~/.merrymen (shared with the CLI).
 */

const { app, BrowserWindow, Menu, Tray, nativeImage, shell, dialog } = require("electron");
const { spawn } = require("node:child_process");
const { accessSync, constants, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const HOST = "127.0.0.1";
// Env override first: a fixed port that is already taken must never be a
// silent exit. See ensurePortFree below — the default is 17430 (NOT 3100: the
// CLI dashboard and half the dev-tool ecosystem live there, and the desktop
// app sharing it meant a daily port fight). MERRYMEN_PORT overrides.
const PORT = Number(process.env.MERRYMEN_PORT) || 17430;
// Shared with the CLI (~/.merrymen); honor an override so data can be relocated.
const HOME = process.env.MERRYMEN_HOME || path.join(os.homedir(), ".merrymen");
// ── writable app copy (the AppImage squashfs is read-only) ────────────────
// Next's runtime cache (.next/cache) — and any future state the backend
// writes — fails inside the mount with ENOENT. So on launch: if this
// directory is writable (dev checkout, classic installer), run in place;
// otherwise copy the app tree once to ~/.merrymen/app/ and run from the copy.
// Re-copies when the bundle changes (fingerprinted on main.js); the marker
// makes repeat launches free. DATA is untouched — the ledger/settings stay in
// ~/.merrymen directly. This is code, not data: never the reverse.
function bundleFingerprint() {
  try {
    const st = statSync(__filename);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return `fallback-${Date.now()}`;
  }
}
function ensureWritableApp() {
  try {
    accessSync(__dirname, constants.W_OK);
    return __dirname;
  } catch {
    /* read-only mount — fall through to the copy */
  }
  const dest = path.join(HOME, "app");
  let current = "";
  try {
    current = readFileSync(path.join(dest, ".bundle-fingerprint"), "utf8");
  } catch {
    /* first launch — nothing copied yet */
  }
  if (current !== bundleFingerprint()) {
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    cpSync(__dirname, dest, {
      recursive: true,
      // The dashboard rebuilds its cache on boot; copying hundreds of MB of
      // stale cache only slows first launch.
      filter: (src) => !src.includes(`${path.sep}.next${path.sep}cache`),
    });
    writeFileSync(path.join(dest, ".bundle-fingerprint"), bundleFingerprint(), "utf8");
  }
  return dest;
}
const APP_DIR = ensureWritableApp();

// ── boot sentinels: never launch children from a broken copy ───────────────
// A first-launch copy can die halfway (Ctrl+C during the ~1.4GB copy is the
// classic) leaving node_modules without @next/env or @esbuild/linux-x64 —
// exactly the "Cannot find module" crash loop. Verify the load-bearing pieces
// resolve from the copy; on failure wipe + re-copy once, and if still broken
// say which piece is missing instead of booting half an app.
const BOOT_SENTINELS = [
  "build/icon.png",
  "loading.html",
  "node_modules/merrymen/package.json",
  "node_modules/merrymen/worker/src/index.ts",
];
function canResolveFrom(request, dir) {
  // Both known layouts: CI hoists deps to the app top level, local staging
  // nests them under node_modules/merrymen. Node never descends into a nested
  // package's node_modules on its own, so try both roots.
  const roots = [dir, path.join(dir, "node_modules", "merrymen")];
  return roots.some((root) => {
    try {
      require.resolve(request, { paths: [root] });
      return true;
    } catch {
      return false;
    }
  });
}
function missingBootPieces(dir) {
  const missing = BOOT_SENTINELS.filter((f) => {
    try {
      accessSync(path.join(dir, f));
      return false;
    } catch {
      return true;
    }
  });
  // Plain package resolutions only — deep subpaths (tsx/dist/cli.mjs) hit
  // exports maps; presence of the package is the correct check here.
  for (const request of ["@next/env", "@esbuild/linux-x64/package.json", "tsx/package.json"]) {
    if (!canResolveFrom(request, dir)) missing.push(`module:${request}`);
  }
  return missing;
}
function ensureBootableApp() {
  let missing = missingBootPieces(APP_DIR);
  if (missing.length && APP_DIR !== __dirname) {
    // One repair attempt: the copy is corrupt, redo it from the bundle.
    try {
      rmSync(path.join(HOME, "app"), { recursive: true, force: true });
      ensureWritableApp(); // fingerprint is gone with the dir → full re-copy
      missing = missingBootPieces(APP_DIR);
    } catch {
      /* fall through to the dialog with the original list */
    }
  }
  if (missing.length) {
    dialog.showMessageBoxSync({
      type: "error",
      title: "merrymen — broken install",
      message: "The app copy is incomplete and can't start.",
      detail: `Missing: ${missing.join(", ")}. Reinstall the AppImage; if it persists, report these names.`,
      buttons: ["Quit"],
    });
    quitting = true;
    app.quit();
    return false;
  }
  return true;
}
const PAUSED_MARKER = path.join(HOME, "paused"); // present = agent paused (worker honors it)
const ICON = path.join(APP_DIR, "build", "icon.png");

// ── OS integration self-repair: the launcher tile ──────────────────────────
// The in-app updater replaces ONLY the AppImage file — never the launcher
// entry or the icon. Without this, updater users keep a stale (or generic)
// tile forever; only install.sh users would see a fixed one. So the app
// maintains its own integration on every boot: icon file into hicolor +
// desktop entry with Icon=, rewritten whenever stale. Best effort throughout
// — a missing tile must never block boot. Same content install.sh writes,
// except Exec= points at the running AppImage when there is one.
function desiredDesktopEntry() {
  const execTarget = process.env.APPIMAGE || path.join(APP_DIR, "merrymen-desktop");
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=merrymen desktop",
    "Comment=Autonomous agents for Robinhood Chain — dashboard + worker",
    `Exec=${execTarget} %U`,
    "Icon=merrymen-desktop",
    "Terminal=false",
    "Categories=Finance;",
    "StartupWMClass=merrymen-desktop",
    "",
  ].join("\n");
}
function ensureDesktopIntegration() {
  if (process.platform !== "linux") return;
  try {
    const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
    try {
      const want = statSync(ICON).size;
      let have = -1;
      try {
        have = statSync(path.join(dataHome, "icons", "hicolor", "1024x1024", "apps", "merrymen-desktop.png")).size;
      } catch {
        /* missing — copy below */
      }
      if (have !== want) {
        mkdirSync(path.join(dataHome, "icons", "hicolor", "1024x1024", "apps"), { recursive: true });
        cpSync(ICON, path.join(dataHome, "icons", "hicolor", "1024x1024", "apps", "merrymen-desktop.png"));
      }
    } catch {
      /* icon unavailable (dev checkout without the asset?) — tile falls back */
    }
    if (!process.env.APPIMAGE) return; // dev runs have no stable Exec= target
    const file = path.join(dataHome, "applications", "merrymen-desktop.desktop");
    let current = "";
    try {
      current = readFileSync(file, "utf8");
    } catch {
      /* missing — write below */
    }
    if (current !== desiredDesktopEntry()) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, desiredDesktopEntry(), "utf8");
    }
  } catch {
    /* best effort — never block boot over a tile */
  }
}

let mainWin = null;
let splashWin = null;
let tray = null;
let quitting = false;
let closeHintShown = false;
let workerChild = null;
const children = [];

// ── port: probe before binding, never fail silent ──────────────────────────
// The dashboard binds a fixed port and the app used to discover a conflict by
// exiting 0 with no window and no message. Probe first; on conflict offer
// Retry (the holder may be shutting down) or Quit. MERRYMEN_PORT is the
// escape hatch for a permanently busy 17430.
function isPortFree() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(PORT, HOST);
  });
}
async function ensurePortFree() {
  for (;;) {
    if (await isPortFree()) return true;
    const choice = dialog.showMessageBoxSync({
      type: "warning",
      title: "merrymen — port in use",
      message: `Port ${PORT} is already in use on this machine.`,
      detail: "The dashboard needs it. Free the port (or set MERRYMEN_PORT to another one), then Retry — or Quit.",
      buttons: ["Retry", "Quit"],
      defaultId: 0,
      cancelId: 1,
    });
    if (choice !== 0) {
      quitting = true;
      app.quit();
      return false;
    }
  }
}

// ── pause control (the same marker the worker's tick loop + Telegram /pause use) ─
function isPaused() {
  return existsSync(PAUSED_MARKER);
}
function setPaused(paused) {
  try {
    if (paused) {
      mkdirSync(HOME, { recursive: true });
      writeFileSync(PAUSED_MARKER, "paused", "utf8");
    } else {
      rmSync(PAUSED_MARKER, { force: true });
    }
  } catch {
    /* best effort */
  }
}

// ── resolve the bundled merrymen + its tool bins (hoisting-safe) ─────────────
function merrymenRoot() {
  // Prefer the writable copy: the dashboard's cwd lives under it, so its
  // runtime cache writes land on disk instead of the read-only mount.
  const cand = path.join(APP_DIR, "node_modules", "merrymen", "package.json");
  if (existsSync(cand)) return path.dirname(cand);
  return path.dirname(require.resolve("merrymen/package.json"));
}
// Locate a tool binary ON DISK, not via require.resolve — packages like tsx have
// an `exports` map that blocks deep subpaths (tsx/dist/cli.mjs), which throws even
// though the file exists. Search the two node_modules layouts npm can produce.
function findTool(relPath, roots, what) {
  for (const nm of roots) {
    const p = path.join(nm, relPath);
    if (existsSync(p)) return p;
  }
  throw new Error(`couldn't find ${what} — looked in ${roots.join(" | ")}`);
}

// Run a Node script using Electron's own Node runtime (no system Node needed).
function runNode(scriptPath, args, opts) {
  const child = spawn(process.execPath, [scriptPath, ...args], {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", (d) => process.stdout.write(`[${opts.tag}] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[${opts.tag}] ${d}`));
  child.on("exit", (code) => console.log(`[${opts.tag}] exited ${code}`));
  children.push(child);
  return child;
}

function nmRoots(root) {
  // merrymen's own nested deps, and the dir that CONTAINS merrymen (hoisted deps).
  return [path.join(root, "node_modules"), path.dirname(root)];
}
function startDashboard() {
  const root = merrymenRoot();
  const nextBin = findTool(path.join("next", "dist", "bin", "next"), nmRoots(root), "next");
  runNode(nextBin, ["start", "-p", String(PORT), "-H", HOST], { cwd: path.join(root, "web"), env: { MERRYMEN_HOME: HOME }, tag: "dashboard" });
}
function startWorker() {
  const root = merrymenRoot();
  const tsxCli = findTool(path.join("tsx", "dist", "cli.mjs"), nmRoots(root), "tsx");
  workerChild = runNode(tsxCli, [path.join(root, "worker", "src", "index.ts")], { cwd: root, env: { MERRYMEN_HOME: HOME, MERRYMEN_PORT: String(PORT) }, tag: "worker" });
}
function startBackend() {
  startDashboard();
  startWorker();
}
function restartWorker() {
  killChild(workerChild);
  startWorker();
  refreshTray();
}

// Poll the dashboard's version endpoint until it answers (or we give up).
function waitForServer() {
  return new Promise((resolve, reject) => {
    let tries = 0;
    const tick = () => {
      const req = http.get({ host: HOST, port: PORT, path: "/api/version", timeout: 2000 }, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", retry);
      req.on("timeout", () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (++tries > 120) return reject(new Error("the dashboard didn't start in time")); // ~60s
      setTimeout(tick, 500);
    };
    tick();
  });
}

// ── windows ──────────────────────────────────────────────────────────────────
function makeSplash() {
  splashWin = new BrowserWindow({
    width: 420,
    height: 300,
    frame: false,
    resizable: false,
    backgroundColor: "#0b0b0d",
    icon: ICON,
    webPreferences: { contextIsolation: true },
  });
  splashWin.loadFile(path.join(APP_DIR, "loading.html"));
}

function showWindow() {
  if (!mainWin) return;
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
}

const LOCAL_ORIGIN = `http://${HOST}:${PORT}`;

/** True only when `u` is EXACTLY our local dashboard origin. Parsing to compare
 * origins (not a string prefix) is what rejects tricks like
 * "http://127.0.0.1:3100@evil.com/", whose real host is evil.com. */
function isLocalUrl(u) {
  try {
    return new URL(u).origin === LOCAL_ORIGIN;
  } catch {
    return false;
  }
}

function makeMain() {
  mainWin = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 640,
    show: false,
    backgroundColor: "#0b0b0d",
    title: "merrymen",
    icon: ICON,
    // Renderer stays fully sandboxed: no Node, isolated context, no preload. Even
    // a compromised dashboard page can't reach the host — it's just a web view.
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  mainWin.loadURL(`http://${HOST}:${PORT}`);
  mainWin.once("ready-to-show", () => {
    if (splashWin) {
      splashWin.close();
      splashWin = null;
    }
    mainWin.show();
  });
  // External links open in the real browser, never in an in-app window. Exact
  // origin match — a prefix check would let "http://127.0.0.1:3100@evil.com" through.
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (isLocalUrl(url)) return { action: "allow" };
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  // The main window may only ever sit on the local dashboard. Block any in-place
  // top-level navigation to another origin and hand it to the real browser instead.
  mainWin.webContents.on("will-navigate", (e, url) => {
    if (isLocalUrl(url)) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });
  // Closing the window keeps the agent running in the tray — only "Quit" stops it.
  mainWin.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    mainWin.hide();
    if (process.platform === "win32" && tray && !closeHintShown) {
      closeHintShown = true;
      try {
        tray.displayBalloon({ title: "merrymen is still running", content: "Your agent keeps working in the tray. Right-click the tray icon to pause or quit." });
      } catch {
        /* balloons unsupported — no-op */
      }
    }
  });
  mainWin.on("closed", () => {
    mainWin = null;
  });
}

// ── system tray — the control panel (no terminal needed) ─────────────────────
function trayMenu() {
  const paused = isPaused();
  return Menu.buildFromTemplate([
    { label: "Open dashboard", click: showWindow },
    { label: `merrymen ${app.getVersion()}`, enabled: false },
    { type: "separator" },
    { label: `Agent: ${paused ? "PAUSED" : "running"}`, enabled: false },
    paused
      ? { label: "▶  Resume agent (allow trades)", click: () => { setPaused(false); refreshTray(); } }
      : { label: "⏸  Pause agent (no trades)", click: () => { setPaused(true); refreshTray(); } },
    { label: "↻  Restart agent", click: restartWorker },
    { type: "separator" },
    {
      label:
        updateState.status === "available"
          ? `⬇  Download update ${updateState.version || ""}`.trim()
          : updateState.status === "ready"
            ? `↻  Restart to install ${updateState.version || "update"}`.trim()
            : updateState.status === "checking" || updateState.status === "downloading"
              ? "…  Checking for updates"
              : "⟳  Check for updates",
      click: () => void checkForUpdates(true),
    },
    {
      label: "Beta channel (offer pre-releases)",
      type: "checkbox",
      checked: readDesktopPrefs().betaChannel,
      click: (item) => {
        writeDesktopPrefs({ betaChannel: item.checked });
        refreshTray();
      },
    },
    { type: "separator" },
    {
      // Auto-start, via Electron's own login-item API rather than the CLI's
      // service verbs. Same intent, different owner: the desktop app launches
      // itself (window + tray + worker), so scheduling `merrymen start` too
      // would leave two workers fighting over one database.
      label: "Start merrymen when I log in",
      type: "checkbox",
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked, openAsHidden: true });
        refreshTray();
      },
    },
    { type: "separator" },
    { label: "Quit merrymen", click: () => { quitting = true; app.quit(); } },
  ]);
}
function refreshTray() {
  if (!tray) return;
  tray.setToolTip(isPaused() ? "merrymen — agent paused" : "merrymen — agent running");
  tray.setContextMenu(trayMenu());
}
function makeTray() {
  let img = nativeImage.createFromPath(ICON);
  if (!img.isEmpty()) img = img.resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.on("click", showWindow); // left-click reopens the dashboard
  refreshTray();
}

// ── updates (GitHub releases via electron-updater) ──────────────────────────
// Manual-download only: we check (on boot, delayed + non-blocking, and from
// the tray), but nothing downloads without an explicit click, and nothing
// installs without an explicit restart. Drafts are never offered (the updater
// only considers published releases); the beta channel additionally offers
// published prereleases. Stable-only by default.
const DESKTOP_PREFS = path.join(HOME, "desktop.json");
function readDesktopPrefs() {
  try {
    const raw = require("node:fs").readFileSync(DESKTOP_PREFS, "utf8");
    const p = JSON.parse(raw);
    return { betaChannel: p.betaChannel === true };
  } catch {
    return { betaChannel: false };
  }
}
function writeDesktopPrefs(prefs) {
  try {
    mkdirSync(HOME, { recursive: true });
    writeFileSync(DESKTOP_PREFS, JSON.stringify({ betaChannel: !!prefs.betaChannel }, null, 2), "utf8");
  } catch {
    /* prefs are convenience — a failed write just doesn't stick */
  }
}
let updateState = { status: "unchecked", version: null };
function loadUpdater() {
  try {
    // Lazy: dev checkouts without the dep installed must still boot.
    return require("electron-updater").autoUpdater;
  } catch {
    return null;
  }
}
async function checkForUpdates(manual) {
  const autoUpdater = loadUpdater();
  if (!autoUpdater) {
    if (manual) dialog.showMessageBoxSync({ type: "info", title: "merrymen — updates", message: "Updater unavailable in this build." });
    return;
  }
  const beta = readDesktopPrefs().betaChannel;
  autoUpdater.allowPrerelease = beta;
  autoUpdater.autoDownload = false;
  // Fork-based testing without touching upstream: point the feed at a fork
  // that carries test releases. Unset = millw14/merrymen (the default).
  if (process.env.MERRYMEN_UPDATE_OWNER || process.env.MERRYMEN_UPDATE_REPO) {
    autoUpdater.setFeedURL({
      provider: "github",
      owner: process.env.MERRYMEN_UPDATE_OWNER || "millw14",
      repo: process.env.MERRYMEN_UPDATE_REPO || "merrymen",
    });
  }
  updateState = { status: "checking", version: null };
  refreshTray();
  try {
    const found = await autoUpdater.checkForUpdates();
    const info = found && found.updateInfo;
    if (!info || info.version === app.getVersion()) {
      updateState = { status: "current", version: null };
      if (manual) {
        dialog.showMessageBoxSync({ type: "info", title: "merrymen — updates", message: `You're on the latest version (${app.getVersion()}).` });
      }
    } else {
      updateState = { status: "available", version: info.version };
      const choice = dialog.showMessageBoxSync({
        type: "question",
        title: "merrymen — update available",
        message: `Version ${info.version} is available (you have ${app.getVersion()}).`,
        detail: "Download now? Nothing installs until you restart.",
        buttons: ["Download", "Later"],
        defaultId: 0,
        cancelId: 1,
      });
      if (choice === 0) {
        updateState = { status: "downloading", version: info.version };
        refreshTray();
        await autoUpdater.downloadUpdate();
        // update-downloaded handler below prompts the restart.
      } else {
        refreshTray();
      }
    }
  } catch (e) {
    updateState = { status: "error", version: null };
    if (manual) {
      dialog.showMessageBoxSync({ type: "warning", title: "merrymen — updates", message: `Update check failed: ${e && e.message ? e.message : e}` });
    }
  }
  refreshTray();
}
function wireUpdaterEvents() {
  const autoUpdater = loadUpdater();
  if (!autoUpdater || autoUpdater.__merrymenWired) return;
  autoUpdater.__merrymenWired = true;
  autoUpdater.on("update-downloaded", (info) => {
    updateState = { status: "ready", version: (info && info.version) || null };
    refreshTray();
    const choice = dialog.showMessageBoxSync({
      type: "question",
      title: "merrymen — update ready",
      message: `Version ${updateState.version || "new"} downloaded. Restart now to install?`,
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      cancelId: 1,
    });
    if (choice === 0) {
      quitting = true;
      autoUpdater.quitAndInstall(false, true);
    }
  });
  autoUpdater.on("error", () => {
    // Background-check noise stays out of the user's face; manual checks
    // report their own errors in checkForUpdates.
    updateState = { status: "error", version: null };
    refreshTray();
  });
}

// ── process control ──────────────────────────────────────────────────────────
function killChild(c) {
  if (!c || c.killed) return;
  try {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(c.pid), "/T", "/F"], { windowsHide: true });
    else c.kill("SIGTERM");
  } catch {
    /* best effort */
  }
}
function killBackend() {
  for (const c of children) killChild(c);
}

// ── lifecycle ────────────────────────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null); // app-like; the dashboard is the whole UI
    makeSplash();
    try {
      if (!ensureBootableApp()) return;
      ensureDesktopIntegration(); // tile + icon self-repair (best effort)
      if (!(await ensurePortFree())) return;
      startBackend();
      await waitForServer();
      makeMain();
      makeTray();
      wireUpdaterEvents();
      // Delayed background check: never blocks boot, never downloads alone.
      setTimeout(() => void checkForUpdates(false), 90000);
    } catch (e) {
      dialog.showErrorBox("merrymen couldn't start", String(e && e.message ? e.message : e));
      quitting = true;
      app.quit();
    }
  });

  // Keep running in the tray when all windows are closed (it's a background agent).
  app.on("window-all-closed", () => {
    /* intentionally do NOT quit — the tray keeps the agent alive */
  });
  app.on("before-quit", () => {
    quitting = true;
    killBackend();
  });
}
process.on("exit", killBackend);
