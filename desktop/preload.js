/**
 * merrymen desktop — preload bridge.
 *
 * Deliberately thin: argument-checked forwarding to ipcMain handlers, no
 * logic of its own. The renderer stays sandboxed with context isolation on;
 * this is the ONLY privileged surface the dashboard page holds, and it is
 * only present inside the real app window (browser/CLI users never load it,
 * so their UI must gate on `window.merrymenDesktop` existing).
 *
 * Channel contract (see main.js "desktop IPC" section — keep in sync):
 *   desktop:get-state      → { status, version, percent, appVersion, beta, paused }
 *   desktop:check          → same shape, after triggering a check
 *   desktop:download       → starts download if an update is available; state
 *   desktop:install        → restart + install if an update is ready
 *   desktop:get-beta       → boolean
 *   desktop:set-beta       → (on: boolean) => boolean
 *   desktop:get-paused     → boolean
 *   desktop:set-paused     → (paused: boolean) => boolean
 *   desktop:restart-worker → boolean
 *   desktop:quit           → void
 */
const { contextBridge, ipcRenderer } = require("electron");

const bool = (v) => v === true;

contextBridge.exposeInMainWorld("merrymenDesktop", {
  getState: () => ipcRenderer.invoke("desktop:get-state"),
  check: () => ipcRenderer.invoke("desktop:check"),
  download: () => ipcRenderer.invoke("desktop:download"),
  install: () => ipcRenderer.invoke("desktop:install"),
  getBeta: () => ipcRenderer.invoke("desktop:get-beta"),
  setBeta: (on) => ipcRenderer.invoke("desktop:set-beta", bool(on)),
  getPaused: () => ipcRenderer.invoke("desktop:get-paused"),
  setPaused: (paused) => ipcRenderer.invoke("desktop:set-paused", bool(paused)),
  restartWorker: () => ipcRenderer.invoke("desktop:restart-worker"),
  quitApp: () => ipcRenderer.invoke("desktop:quit"),
  appVersion: () => ipcRenderer.invoke("desktop:app-version"),
});
