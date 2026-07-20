/**
 * PC-control platform layer — the ONLY place merrymen touches the operating
 * system. Everything here is invoked exclusively by the Telegram executor after
 * the capability + allowlist + confirm gates have passed (executor.ts); this
 * module trusts its callers to have gated, and focuses on doing each OS action
 * safely and cross-platform.
 *
 * SAFETY RULES for this file:
 *  - Never interpolate caller-supplied text into a shell string. Pass dynamic
 *    values as argv entries or via environment variables, never concatenated
 *    into `-Command "…"`. (The one exception is runShell, whose input is an
 *    exact allowlist match the user pre-approved AND confirmed.)
 *  - Every function returns a typed result and NEVER throws — a missing tool or
 *    a dead command degrades to `{ ok: false, reason }`.
 *  - Windows is fully implemented (the primary platform). macOS/Linux use the
 *    standard CLI tools; when one isn't present the action reports "not
 *    supported on <platform>" rather than blowing up.
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureHome, homePaths } from "../home";

const PLATFORM = process.platform; // "win32" | "darwin" | "linux" | …
const OUT_CAP = 3500; // truncate command/dir output for chat

export interface RunResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  reason?: string;
}

/**
 * Spawn a process with an argv array (NO shell) unless `shell` is set.
 * `input` is written to stdin; `env` is merged. Always resolves, never rejects.
 */
function run(
  cmd: string,
  args: string[],
  opts: { shell?: boolean; input?: string; env?: Record<string, string>; timeoutMs?: number; cwd?: string } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        shell: opts.shell ?? false,
        env: { ...process.env, ...(opts.env ?? {}) },
        cwd: opts.cwd,
        windowsHide: true,
      });
    } catch (e) {
      resolve({ ok: false, code: null, stdout: "", stderr: "", reason: e instanceof Error ? e.message : String(e) });
      return;
    }
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (code: number | null, reason?: string) => {
      if (done) return;
      done = true;
      resolve({ ok: code === 0 && !reason, code, stdout, stderr, reason });
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish(null, "timed out");
    }, opts.timeoutMs ?? 15_000);
    child.stdout?.on("data", (d) => (stdout += String(d)));
    child.stderr?.on("data", (d) => (stderr += String(d)));
    child.on("error", (e) => {
      clearTimeout(timer);
      finish(null, e.message);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(code);
    });
    if (opts.input !== undefined) {
      try {
        child.stdin?.end(opts.input);
      } catch {
        /* ignore */
      }
    }
  });
}

/** Run a PowerShell snippet (Windows). Dynamic values go through `env`, never the script text. */
function pwsh(script: string, env?: Record<string, string>, timeoutMs?: number): Promise<RunResult> {
  return run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { env, timeoutMs });
}

function unsupported(action: string): RunResult {
  return { ok: false, code: null, stdout: "", stderr: "", reason: `${action} isn't supported on ${PLATFORM} yet` };
}

// ── screenshot ────────────────────────────────────────────────────────────

/** Capture the full (multi-monitor) screen to a PNG in the scratch dir. */
export async function capture(): Promise<{ ok: boolean; path?: string; reason?: string }> {
  ensureHome();
  const out = path.join(homePaths.scratch(), "screenshot.png");
  let r: RunResult;
  if (PLATFORM === "win32") {
    // System.Drawing over the virtual screen — spans all monitors.
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;",
      "$b=[System.Windows.Forms.SystemInformation]::VirtualScreen;",
      "$bmp=New-Object System.Drawing.Bitmap($b.Width,$b.Height);",
      "$g=[System.Drawing.Graphics]::FromImage($bmp);",
      "$g.CopyFromScreen($b.X,$b.Y,0,0,$bmp.Size);",
      "$bmp.Save($env:MERRYMEN_SHOT,[System.Drawing.Imaging.ImageFormat]::Png);",
      "$g.Dispose();$bmp.Dispose();",
    ].join(" ");
    r = await pwsh(script, { MERRYMEN_SHOT: out });
  } else if (PLATFORM === "darwin") {
    r = await run("screencapture", ["-x", out]);
  } else {
    // Linux: try scrot, then imagemagick, then gnome-screenshot.
    r = await run("scrot", ["-o", out]);
    if (!r.ok) r = await run("import", ["-window", "root", out]);
    if (!r.ok) r = await run("gnome-screenshot", ["-f", out]);
  }
  if (!r.ok) return { ok: false, reason: r.reason || r.stderr.slice(0, 200) || "capture failed" };
  if (!existsSync(out)) return { ok: false, reason: "capture produced no file" };
  return { ok: true, path: out };
}

// ── open app / url ──────────────────────────────────────────────────────────

export async function openUrl(url: string): Promise<RunResult> {
  if (PLATFORM === "win32") return run("cmd", ["/c", "start", "", url], {});
  if (PLATFORM === "darwin") return run("open", [url]);
  return run("xdg-open", [url]);
}

/** Launch an app by name (already allowlist-checked by the caller). */
export async function openApp(name: string): Promise<RunResult> {
  if (PLATFORM === "win32") return run("cmd", ["/c", "start", "", name], {});
  if (PLATFORM === "darwin") return run("open", ["-a", name]);
  // Linux: launch the binary detached.
  return run(name, [], {});
}

// ── system info ───────────────────────────────────────────────────────────

export interface SysInfo {
  host: string;
  platform: string;
  release: string;
  uptimeSec: number;
  cpuModel: string;
  cpuCount: number;
  loadPct: number | null;
  memUsedGb: number;
  memTotalGb: number;
  battery: number | null;
}

/** Cross-platform system snapshot (os module + one battery probe). */
export async function sysInfo(): Promise<{ ok: boolean; info?: SysInfo; reason?: string }> {
  try {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const cpus = os.cpus();
    // loadavg is meaningful on unix; on Windows it's [0,0,0].
    const load = os.loadavg()[0] ?? 0;
    const loadPct = PLATFORM === "win32" || !cpus.length ? null : Math.round((load / cpus.length) * 100);

    let battery: number | null = null;
    if (PLATFORM === "win32") {
      const r = await pwsh("(Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue).EstimatedChargeRemaining", undefined, 6000);
      const n = Number(r.stdout.trim().split(/\r?\n/)[0]);
      if (Number.isFinite(n) && n > 0) battery = n;
    } else if (PLATFORM === "darwin") {
      const r = await run("pmset", ["-g", "batt"], { timeoutMs: 6000 });
      const m = r.stdout.match(/(\d+)%/);
      if (m) battery = Number(m[1]);
    }

    const info: SysInfo = {
      host: os.hostname(),
      platform: `${os.type()} ${PLATFORM}`,
      release: os.release(),
      uptimeSec: Math.round(os.uptime()),
      cpuModel: cpus[0]?.model?.trim() ?? "unknown",
      cpuCount: cpus.length,
      loadPct,
      memUsedGb: Math.round(((totalMem - freeMem) / 1e9) * 10) / 10,
      memTotalGb: Math.round((totalMem / 1e9) * 10) / 10,
      battery,
    };
    return { ok: true, info };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

// ── volume / media / notify / power ─────────────────────────────────────────

/** spec: "mute" | "up" | "down" | a 0-100 number (absolute where the OS allows). */
export async function setVolume(spec: string): Promise<RunResult> {
  const s = spec.trim().toLowerCase();
  const abs = Number(s);
  if (PLATFORM === "win32") {
    // SendKeys media/volume virtual keys — no external tool needed.
    const vk = s === "mute" ? 173 : s === "up" ? 175 : s === "down" ? 174 : null;
    if (vk === null) {
      return { ok: false, code: null, stdout: "", stderr: "", reason: "on Windows use volume up / down / mute" };
    }
    return pwsh(`(New-Object -ComObject WScript.Shell).SendKeys([char]${vk})`);
  }
  if (PLATFORM === "darwin") {
    if (s === "mute") return run("osascript", ["-e", "set volume output muted true"]);
    if (s === "up") return run("osascript", ["-e", "set volume output volume (output volume of (get volume settings) + 10)"]);
    if (s === "down") return run("osascript", ["-e", "set volume output volume (output volume of (get volume settings) - 10)"]);
    if (Number.isFinite(abs)) return run("osascript", ["-e", `set volume output volume ${Math.max(0, Math.min(100, abs))}`]);
    return { ok: false, code: null, stdout: "", stderr: "", reason: "volume: use a number, up, down, or mute" };
  }
  // Linux (amixer)
  if (s === "mute") return run("amixer", ["set", "Master", "toggle"]);
  if (s === "up") return run("amixer", ["set", "Master", "10%+"]);
  if (s === "down") return run("amixer", ["set", "Master", "10%-"]);
  if (Number.isFinite(abs)) return run("amixer", ["set", "Master", `${Math.max(0, Math.min(100, abs))}%`]);
  return { ok: false, code: null, stdout: "", stderr: "", reason: "volume: use a number, up, down, or mute" };
}

/** key: play | pause | next | prev (play/pause share one toggle key). */
export async function mediaKey(key: string): Promise<RunResult> {
  const k = key.trim().toLowerCase();
  if (PLATFORM === "win32") {
    const vk = k === "next" ? 176 : k === "prev" || k === "previous" ? 177 : 179; // 179 = play/pause toggle
    return pwsh(`(New-Object -ComObject WScript.Shell).SendKeys([char]${vk})`);
  }
  if (PLATFORM === "darwin") {
    // No first-party CLI; try the common `media-control`/`nowplaying-cli`, else unsupported.
    return unsupported("media keys");
  }
  const cmd = k === "next" ? "next" : k === "prev" || k === "previous" ? "previous" : "play-pause";
  return run("playerctl", [cmd]);
}

export async function notify(text: string): Promise<RunResult> {
  if (PLATFORM === "win32") {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;",
      "$n=New-Object System.Windows.Forms.NotifyIcon;",
      "$n.Icon=[System.Drawing.SystemIcons]::Information;$n.Visible=$true;",
      "$n.ShowBalloonTip(5000,'merryman',$env:MERRYMEN_NOTIFY,[System.Windows.Forms.ToolTipIcon]::Info);",
      "Start-Sleep -Seconds 6;$n.Dispose();",
    ].join(" ");
    return pwsh(script, { MERRYMEN_NOTIFY: text }, 9000);
  }
  if (PLATFORM === "darwin") {
    return run("osascript", ["-e", "on run argv", "-e", 'display notification (item 1 of argv) with title "merryman"', "-e", "end run", text]);
  }
  return run("notify-send", ["merryman", text]);
}

export async function lockScreen(): Promise<RunResult> {
  if (PLATFORM === "win32") return run("rundll32.exe", ["user32.dll,LockWorkStation"]);
  if (PLATFORM === "darwin") return run("pmset", ["displaysleepnow"]);
  return run("loginctl", ["lock-session"]);
}

export async function powerAction(action: "sleep" | "shutdown"): Promise<RunResult> {
  if (PLATFORM === "win32") {
    if (action === "sleep") return run("rundll32.exe", ["powrprof.dll,SetSuspendState", "0,1,0"]);
    return run("shutdown", ["/s", "/t", "0"]);
  }
  if (PLATFORM === "darwin") {
    if (action === "sleep") return run("pmset", ["sleepnow"]);
    return run("osascript", ["-e", 'tell app "System Events" to shut down']);
  }
  if (action === "sleep") return run("systemctl", ["suspend"]);
  return run("systemctl", ["poweroff"]);
}

// ── files (confined to a root by the caller) ─────────────────────────────────

export interface DirEntry {
  name: string;
  dir: boolean;
  sizeKb: number;
}

/** List a directory. The caller guarantees `absPath` is inside the allowed root. */
export function listDir(absPath: string): { ok: boolean; entries?: DirEntry[]; reason?: string } {
  try {
    if (!existsSync(absPath)) return { ok: false, reason: "no such path" };
    const st = statSync(absPath);
    if (!st.isDirectory()) return { ok: false, reason: "not a directory" };
    const entries: DirEntry[] = readdirSync(absPath)
      .slice(0, 200)
      .map((name) => {
        try {
          const s = statSync(path.join(absPath, name));
          return { name, dir: s.isDirectory(), sizeKb: Math.round(s.size / 102.4) / 10 };
        } catch {
          return { name, dir: false, sizeKb: 0 };
        }
      })
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    return { ok: true, entries };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

// ── clipboard ────────────────────────────────────────────────────────────

export async function clipGet(): Promise<{ ok: boolean; text?: string; reason?: string }> {
  let r: RunResult;
  if (PLATFORM === "win32") r = await pwsh("Get-Clipboard -Raw");
  else if (PLATFORM === "darwin") r = await run("pbpaste", []);
  else r = await run("xclip", ["-selection", "clipboard", "-o"]);
  if (!r.ok) return { ok: false, reason: r.reason || "clipboard read failed" };
  return { ok: true, text: r.stdout.slice(0, OUT_CAP) };
}

export async function clipSet(text: string): Promise<RunResult> {
  if (PLATFORM === "win32") return pwsh("Set-Clipboard -Value $env:MERRYMEN_CLIP", { MERRYMEN_CLIP: text });
  if (PLATFORM === "darwin") return run("pbcopy", [], { input: text });
  return run("xclip", ["-selection", "clipboard"], { input: text });
}

// ── shell (exact allowlist match, already confirmed) ─────────────────────────

/** Run a pre-approved, confirmed command in the platform shell. Agent mode
 * passes a longer timeout (installs/builds run minutes) and its own cwd. */
export async function runShell(cmd: string, opts: { timeoutMs?: number; cwd?: string } = {}): Promise<RunResult> {
  const spawnOpts = { shell: false, timeoutMs: opts.timeoutMs ?? 20_000, cwd: opts.cwd };
  const r =
    PLATFORM === "win32"
      ? await run("cmd.exe", ["/d", "/s", "/c", cmd], spawnOpts)
      : await run("/bin/sh", ["-c", cmd], spawnOpts);
  return { ...r, stdout: r.stdout.slice(0, OUT_CAP), stderr: r.stderr.slice(0, OUT_CAP) };
}

// ── keyboard (type / hotkey) ─────────────────────────────────────────────────

/** SendKeys-escape literal text so specials (+^%~(){}[]) type verbatim (Windows). */
function escapeSendKeys(text: string): string {
  return text.replace(/([+^%~(){}\[\]])/g, "{$1}");
}

/** Translate "ctrl+shift+s" → SendKeys "^+s" (Windows). */
function comboToSendKeys(combo: string): string | null {
  const parts = combo.toLowerCase().split("+").map((p) => p.trim());
  const key = parts.pop();
  if (!key) return null;
  let mods = "";
  for (const m of parts) {
    if (m === "ctrl" || m === "control") mods += "^";
    else if (m === "shift") mods += "+";
    else if (m === "alt") mods += "%";
    else return null;
  }
  const named: Record<string, string> = {
    enter: "{ENTER}", tab: "{TAB}", esc: "{ESC}", escape: "{ESC}", space: " ",
    up: "{UP}", down: "{DOWN}", left: "{LEFT}", right: "{RIGHT}",
    home: "{HOME}", end: "{END}", del: "{DEL}", delete: "{DEL}", backspace: "{BACKSPACE}",
    f1: "{F1}", f2: "{F2}", f3: "{F3}", f4: "{F4}", f5: "{F5}",
  };
  const keyPart = named[key] ?? (key.length === 1 ? key : null);
  if (keyPart === null) return null;
  return mods + keyPart;
}

export async function typeText(text: string): Promise<RunResult> {
  if (PLATFORM === "win32") {
    return pwsh("(New-Object -ComObject WScript.Shell).SendKeys($env:MERRYMEN_KEYS)", {
      MERRYMEN_KEYS: escapeSendKeys(text),
    });
  }
  if (PLATFORM === "linux") return run("xdotool", ["type", "--", text]);
  if (PLATFORM === "darwin") return unsupported("type");
  return unsupported("type");
}

export async function hotkey(combo: string): Promise<RunResult> {
  if (PLATFORM === "win32") {
    const sk = comboToSendKeys(combo);
    if (!sk) return { ok: false, code: null, stdout: "", stderr: "", reason: `couldn't parse hotkey "${combo}"` };
    return pwsh("(New-Object -ComObject WScript.Shell).SendKeys($env:MERRYMEN_KEYS)", { MERRYMEN_KEYS: sk });
  }
  if (PLATFORM === "linux") return run("xdotool", ["key", combo.replace(/\+/g, "+")]);
  return unsupported("hotkey");
}

// ── watcher probes ──────────────────────────────────────────────────────────

/** Instantaneous CPU load percent (0-100), or null if it can't be read. */
export async function cpuPercent(): Promise<number | null> {
  if (PLATFORM === "win32") {
    const r = await pwsh("(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average", undefined, 6000);
    const n = Number(r.stdout.trim().split(/\r?\n/)[0]);
    return Number.isFinite(n) ? n : null;
  }
  // unix: loadavg / cores — an approximation, but good enough for a threshold.
  const load = os.loadavg()[0] ?? 0;
  const cores = os.cpus().length || 1;
  return Math.round((load / cores) * 100);
}

/** Is a process with this image name currently running? null if it can't tell. */
export async function procRunning(name: string): Promise<boolean | null> {
  const bare = name.trim().toLowerCase().replace(/\.exe$/, "");
  if (!bare) return null;
  if (PLATFORM === "win32") {
    const r = await run("tasklist", ["/FO", "CSV", "/NH"], { timeoutMs: 8000 });
    if (r.reason) return null;
    return r.stdout.toLowerCase().includes(`"${bare}.exe"`);
  }
  const r = await run("pgrep", ["-fli", bare], { timeoutMs: 6000 });
  // pgrep exits 1 when nothing matches — that's "not running", not an error.
  if (r.reason) return null;
  return r.stdout.trim().length > 0;
}

/** Capped, chat-safe rendering of command/dir output. */
export function capOutput(s: string): string {
  return s.length > OUT_CAP ? s.slice(0, OUT_CAP) + "\n…(truncated)" : s;
}

export { PLATFORM };
