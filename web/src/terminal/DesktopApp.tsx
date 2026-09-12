"use client";

import { useEffect, useState } from "react";

/**
 * In-app desktop controls — the control surface for installs with no system
 * tray (tray-less Wayland compositors, etc.). Renders ONLY inside the real
 * Electron window: the bridge below exists solely via preload.js, so
 * browser/CLI users never see dead buttons. All flows reuse the main-process
 * backends the tray already drives (see desktop/main.js) — data, not dialogs.
 */

export interface DesktopState {
  status: "unchecked" | "checking" | "current" | "available" | "downloading" | "ready" | "error" | string;
  version: string | null;
  percent: number | null;
  appVersion: string;
  beta: boolean;
  paused: boolean;
}

export interface DesktopBridge {
  getState(): Promise<DesktopState>;
  check(): Promise<DesktopState>;
  download(): Promise<DesktopState>;
  install(): Promise<DesktopState>;
  setBeta(on: boolean): Promise<boolean>;
  setPaused(paused: boolean): Promise<boolean>;
  restartWorker(): Promise<boolean>;
  quitApp(): Promise<void>;
  appVersion(): Promise<string>;
}

declare global {
  interface Window {
    merrymenDesktop?: DesktopBridge;
  }
}

export function isDesktopApp(): boolean {
  return typeof window !== "undefined" && !!window.merrymenDesktop;
}

/** Fast poll while an update is in flight, slow idle poll otherwise. */
export function desktopPollDelay(status: string): number {
  return status === "checking" || status === "downloading" ? 5000 : 20000;
}

export function desktopStatusLine(st: DesktopState): string {
  switch (st.status) {
    case "checking":
      return "Checking for updates…";
    case "current":
      return `Up to date — ${st.appVersion} is the latest.`;
    case "available":
      return `Version ${st.version} is available (you have ${st.appVersion}).`;
    case "downloading":
      return `Downloading ${st.version ?? "update"}… ${st.percent ?? 0}%`;
    case "ready":
      return `Version ${st.version ?? "new"} downloaded — restart to install.`;
    case "error":
      return "Update check failed.";
    default:
      return `App version ${st.appVersion}.`;
  }
}

export default function DesktopAppSection() {
  const [st, setSt] = useState<DesktopState | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  // Self-perpetuating poll: each cycle fetches once and schedules the next,
  // with the delay matched to the latest status (fast during downloads).
  // A status change reschedules early via the dep below; cleanup prevents
  // pileup on unmount or rapid transitions.
  useEffect(() => {
    const b = typeof window !== "undefined" ? window.merrymenDesktop : undefined;
    if (!b) return;
    let cancelled = false;
    b.getState()
      .then((s) => {
        if (!cancelled) setSt(s);
      })
      .catch((e) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      });
    const id = setTimeout(() => setTick((t) => t + 1), desktopPollDelay(st?.status ?? "unchecked"));
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
    // tick drives the loop; status re-times it on transitions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, st?.status]);

  if (typeof window === "undefined" || !window.merrymenDesktop) return null;

  const run = async (fn: (b: DesktopBridge) => Promise<DesktopState | boolean | void>) => {
    const b = window.merrymenDesktop;
    if (!b || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fn(b);
      if (r && typeof r === "object" && "status" in (r as DesktopState)) setSt(r as DesktopState);
      else setSt(await b.getState());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="mm-section">Desktop app</div>
      <p className="mm-note" role="status">
        {st ? desktopStatusLine(st) : "Loading app status…"}
      </p>
      {err && (
        <p className="mm-danger" role="alert">
          Desktop control failed: {err}
        </p>
      )}
      <div className="mm-grid">
        <div className="mm-field">
          <span className="mm-label">Updates</span>
          <span className="mm-input">
            <button type="button" className="mm-btn sm" disabled={busy} onClick={() => void run((b) => b.check())}>
              Check for updates
            </button>
            {st?.status === "available" && (
              <button type="button" className="mm-btn sm" disabled={busy} onClick={() => void run((b) => b.download())}>
                Download
              </button>
            )}
            {st?.status === "ready" && (
              <button type="button" className="mm-btn sm" disabled={busy} onClick={() => void run((b) => b.install())}>
                Restart to install
              </button>
            )}
          </span>
        </div>
        <div className="mm-field">
          <span className="mm-label">Release channel</span>
          <span className="mm-input">
            <label>
              <input
                type="checkbox"
                checked={st?.beta ?? false}
                disabled={busy || !st}
                onChange={(e) => void run(async (b) => {
                  await b.setBeta(e.target.checked);
                  return b.getState();
                })}
              />{" "}
              Beta channel (offer pre-releases)
            </label>
          </span>
        </div>
        <div className="mm-field">
          <span className="mm-label">Agent</span>
          <span className="mm-input">
            <button
              type="button"
              className="mm-btn sm"
              disabled={busy || !st}
              onClick={() => void run(async (b) => {
                await b.setPaused(!(st?.paused ?? false));
                return b.getState();
              })}
            >
              {st?.paused ? "Resume agent" : "Pause agent"}
            </button>
            <button type="button" className="mm-btn sm" disabled={busy} onClick={() => void run((b) => b.restartWorker())}>
              Restart agent
            </button>
            <button
              type="button"
              className="mm-btn danger sm"
              disabled={busy}
              onClick={() => {
                if (window.confirm("Quit merrymen? The worker stops too.")) void run((b) => b.quitApp());
              }}
            >
              Quit
            </button>
          </span>
        </div>
      </div>
    </>
  );
}
