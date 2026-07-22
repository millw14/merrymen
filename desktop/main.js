/**
 * merrymen desktop — the one-click app.
 *
 * Electron ships its own Node, so a user double-clicks the installer and never
 * touches a terminal. On launch this main process:
 *   1. shows a loading splash,
 *   2. spawns the merrymen dashboard (next start) + agent worker (tsx) as child
 *      processes, using Electron-as-Node (ELECTRON_RUN_AS_NODE) — no system Node,
 *   3. waits for the dashboard on 127.0.0.1:3100,
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
const { existsSync, mkdirSync, rmSync, writeFileSync } = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const HOST = "127.0.0.1";
const PORT = 3100;
// Shared with the CLI (~/.merrymen); honor an override so data can be relocated.
const HOME = process.env.MERRYMEN_HOME || path.join(os.homedir(), ".merrymen");
const PAUSED_MARKER = path.join(HOME, "paused"); // present = agent paused (worker honors it)
const ICON = path.join(__dirname, "build", "icon.png");

let mainWin = null;
let splashWin = null;
let tray = null;
let quitting = false;
let closeHintShown = false;
let workerChild = null;
const children = [];

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
  workerChild = runNode(tsxCli, [path.join(root, "worker", "src", "index.ts")], { cwd: root, env: { MERRYMEN_HOME: HOME }, tag: "worker" });
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
    webPreferences: { contextIsolation: true },
  });
  splashWin.loadFile(path.join(__dirname, "loading.html"));
}

function showWindow() {
  if (!mainWin) return;
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
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
    webPreferences: { contextIsolation: true },
  });
  mainWin.loadURL(`http://${HOST}:${PORT}`);
  mainWin.once("ready-to-show", () => {
    if (splashWin) {
      splashWin.close();
      splashWin = null;
    }
    mainWin.show();
  });
  // External links open in the real browser, not in-app.
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http") && !url.startsWith(`http://${HOST}:${PORT}`)) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
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
    { type: "separator" },
    { label: `Agent: ${paused ? "PAUSED" : "running"}`, enabled: false },
    paused
      ? { label: "▶  Resume agent (allow trades)", click: () => { setPaused(false); refreshTray(); } }
      : { label: "⏸  Pause agent (no trades)", click: () => { setPaused(true); refreshTray(); } },
    { label: "↻  Restart agent", click: restartWorker },
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
      startBackend();
      await waitForServer();
      makeMain();
      makeTray();
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
