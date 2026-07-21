/**
 * merrymen desktop — the one-click app.
 *
 * Electron ships its own Node, so a user double-clicks the installer and never
 * touches a terminal or installs anything. On launch this main process:
 *   1. shows a loading splash,
 *   2. spawns the merrymen dashboard (next start) + agent worker (tsx) as child
 *      processes, using Electron-as-Node (ELECTRON_RUN_AS_NODE) — no system Node
 *      required,
 *   3. waits for the dashboard to answer on 127.0.0.1:3100,
 *   4. loads it in a native window.
 *
 * Data lives in ~/.merrymen (same as the CLI), so the app and `merrymen` share
 * one home — install either way, your wallet/keys/history carry over.
 *
 * The merrymen package is a dependency (see package.json), so `npm install`
 * pulls the prebuilt dashboard + worker + all deps into node_modules; nothing is
 * fetched at runtime.
 */

const { app, BrowserWindow, Menu, shell, dialog } = require("electron");
const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const HOST = "127.0.0.1";
const PORT = 3100;
// Shared with the CLI (~/.merrymen); honor an override so data can be relocated.
const HOME = process.env.MERRYMEN_HOME || path.join(os.homedir(), ".merrymen");

let mainWin = null;
let splashWin = null;
const children = [];

// ── resolve the bundled merrymen + its tool bins (hoisting-safe) ─────────────
function merrymenRoot() {
  // require.resolve finds merrymen wherever npm placed it (nested or hoisted).
  return path.dirname(require.resolve("merrymen/package.json"));
}

// Locate a tool binary ON DISK, not via require.resolve — packages like tsx have
// an `exports` map that blocks deep subpaths (e.g. tsx/dist/cli.mjs), which throws
// even though the file exists. We search the two node_modules layouts npm can
// produce (merrymen's own nested deps, or hoisted next to merrymen).
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

function startBackend() {
  const root = merrymenRoot();
  const webDir = path.join(root, "web");
  const workerEntry = path.join(root, "worker", "src", "index.ts");
  // node_modules layouts to search: merrymen's own nested deps, and the dir that
  // CONTAINS merrymen (hoisted deps sit here).
  const nmRoots = [path.join(root, "node_modules"), path.dirname(root)];
  const env = { MERRYMEN_HOME: HOME };

  // Dashboard: the prebuilt Next production server, served from the package's web/.
  const nextBin = findTool(path.join("next", "dist", "bin", "next"), nmRoots, "next");
  runNode(nextBin, ["start", "-p", String(PORT), "-H", HOST], { cwd: webDir, env, tag: "dashboard" });

  // Agent worker: the tsx runner executes the TypeScript worker directly.
  const tsxCli = findTool(path.join("tsx", "dist", "cli.mjs"), nmRoots, "tsx");
  runNode(tsxCli, [workerEntry], { cwd: root, env, tag: "worker" });
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
    show: true,
    backgroundColor: "#0b0b0d",
    webPreferences: { contextIsolation: true },
  });
  splashWin.loadFile(path.join(__dirname, "loading.html"));
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
    icon: path.join(__dirname, "build", "icon.png"),
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
  // External links (explorer, docs, get-a-key) open in the real browser, not in-app.
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http") && !url.startsWith(`http://${HOST}:${PORT}`)) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });
  mainWin.on("closed", () => {
    mainWin = null;
  });
}

// ── lifecycle ────────────────────────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWin) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.focus();
    }
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null); // app-like; the dashboard is the whole UI
    makeSplash();
    try {
      startBackend();
      await waitForServer();
      makeMain();
    } catch (e) {
      dialog.showErrorBox("merrymen couldn't start", String(e && e.message ? e.message : e));
      app.quit();
    }
  });

  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", killBackend);
}

// Kill the worker + dashboard (and their children) when the app closes.
function killBackend() {
  for (const c of children) {
    if (!c || c.killed) continue;
    try {
      if (process.platform === "win32") spawn("taskkill", ["/pid", String(c.pid), "/T", "/F"], { windowsHide: true });
      else c.kill("SIGTERM");
    } catch {
      /* best effort */
    }
  }
}
process.on("exit", killBackend);
