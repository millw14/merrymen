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

import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync, statSync } from "node:fs";
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
  /**
   * Set when the failure is a MISSING TOOL that could be installed (never on a
   * dead command or a headless box). Carries the tool's binary name so callers
   * can look it up in the install map and offer a /confirm install.
   */
  missing?: { tool: string };
  /**
   * Set when the tool is INSTALLED but its daemon isn't running (e.g. ydotool
   * without ydotoold) — a recoverable state that a /confirm service-start can
   * fix, distinct from `missing` (which means install a package).
   */
  needsService?: { tool: string; argv: string[] };
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

// ── session detection & tool probes ────────────────────────────────────────

export type SessionType = "wayland" | "x11" | "headless";

/**
 * The display session the worker runs in. Same rule OpenClaw/Hermes use:
 * XDG_SESSION_TYPE first, then WAYLAND_DISPLAY, then DISPLAY. In an XWayland
 * mixed session (both WAYLAND_DISPLAY and DISPLAY set) Wayland wins — X11 tools
 * can't reach native Wayland windows. Non-Linux platforms report "headless"
 * and never act on it.
 */
export function sessionType(): SessionType {
  const xdg = (process.env.XDG_SESSION_TYPE ?? "").toLowerCase();
  if (xdg === "wayland" || process.env.WAYLAND_DISPLAY) return "wayland";
  if (xdg === "x11" || process.env.DISPLAY) return "x11";
  return "headless";
}

/**
 * True when `name` is an executable on PATH. `name` is always a fixed internal
 * string — never caller input — so walking PATH to find it is safe.
 */
export function toolExists(name: string): boolean {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    try {
      accessSync(path.join(dir, name), constants.X_OK);
      return true;
    } catch {
      /* keep walking */
    }
  }
  return false;
}

/** First tool in `tools` the `exists` predicate accepts, else null (pure). */
export function resolveToolChain(tools: readonly string[], exists: (name: string) => boolean): string | null {
  for (const t of tools) if (exists(t)) return t;
  return null;
}

// ── package-manager install plans (Hermes-style scoped NOPASSWD) ─────────────

/** Binary → package name per package manager. null means "don't offer" — an
 * install we're not sure about must never be suggested. Mirrors Hermes'
 * distro-aware show_manual_install_hint: only fill entries we trust. */
const PACKAGE_MAP: Record<string, Record<string, string>> = {
  pacman: {
    "wl-copy": "wl-clipboard",
    "wl-paste": "wl-clipboard",
    xclip: "xclip",
    grim: "grim",
    "gnome-screenshot": "gnome-screenshot",
    spectacle: "spectacle",
    scrot: "scrot",
    maim: "maim",
    import: "imagemagick",
    wtype: "wtype",
    ydotool: "ydotool",
    xdotool: "xdotool",
    playerctl: "playerctl",
    "notify-send": "libnotify",
    wpctl: "wireplumber",
    amixer: "alsa-utils",
  },
  "apt-get": {
    "wl-copy": "wl-clipboard",
    "wl-paste": "wl-clipboard",
    xclip: "xclip",
    grim: "grim",
    "gnome-screenshot": "gnome-screenshot",
    spectacle: "spectacle",
    scrot: "scrot",
    maim: "maim",
    import: "imagemagick",
    wtype: "wtype",
    ydotool: "ydotool",
    xdotool: "xdotool",
    playerctl: "playerctl",
    "notify-send": "libnotify-bin",
    wpctl: "pipewire-bin",
    amixer: "alsa-utils",
  },
  dnf: {
    "wl-copy": "wl-clipboard",
    "wl-paste": "wl-clipboard",
    xclip: "xclip",
    grim: "grim",
    "gnome-screenshot": "gnome-screenshot",
    spectacle: "spectacle",
    scrot: "scrot",
    maim: "maim",
    import: "imagemagick",
    wtype: "wtype",
    ydotool: "ydotool",
    xdotool: "xdotool",
    playerctl: "playerctl",
    "notify-send": "libnotify",
    amixer: "alsa-utils",
  },
  apk: {
    "wl-copy": "wl-clipboard",
    "wl-paste": "wl-clipboard",
    xclip: "xclip",
    grim: "grim",
    "gnome-screenshot": "gnome-screenshot",
    spectacle: "spectacle",
    scrot: "scrot",
    maim: "maim",
    import: "imagemagick",
    wtype: "wtype",
    ydotool: "ydotool",
    xdotool: "xdotool",
    playerctl: "playerctl",
    "notify-send": "libnotify",
    amixer: "alsa-utils",
  },
  brew: {
    "wl-copy": "wl-clipboard",
    "wl-paste": "wl-clipboard",
    xclip: "xclip",
    grim: "grim",
    scrot: "scrot",
    wtype: "wtype",
    ydotool: "ydotool",
    xdotool: "xdotool",
    playerctl: "playerctl",
  },
};

const PM_ORDER = ["pacman", "apt-get", "dnf", "apk", "brew"] as const;
type PmName = (typeof PM_ORDER)[number];

/** The installed package manager, in order (pure — injectable for tests). */
export function pmFor(exists: (name: string) => boolean): PmName | null {
  for (const pm of PM_ORDER) if (exists(pm)) return pm;
  return null;
}

/** The detected package manager on this machine, or null when none. */
export function detectPm(): PmName | null {
  return pmFor(toolExists);
}

/** Package name for `tool` under `pm`, or null when unknown (no offer). */
export function pkgFor(pm: PmName, tool: string): string | null {
  return PACKAGE_MAP[pm]?.[tool] ?? null;
}

/** The exact argv to install `pkg` under `pm`. brew needs no sudo; everything
 * else runs under `sudo -n` (passwordless) — the only non-interactive route. */
export function installArgvFor(pm: PmName, pkg: string): string[] {
  switch (pm) {
    case "brew":
      return ["brew", "install", pkg];
    case "apt-get":
      return ["sudo", "-n", "apt-get", "install", "-y", pkg];
    case "dnf":
      return ["sudo", "-n", "dnf", "install", "-y", pkg];
    case "apk":
      return ["sudo", "-n", "apk", "add", pkg];
    case "pacman":
    default:
      // --noconfirm: pacman prompts "Proceed with installation? [Y/n]" on a
      // piped stdin; without it the install blocks forever. sudo -n only
      // silences the sudo password prompt, not pacman's own.
      return ["sudo", "-n", "pacman", "-S", "--needed", "--noconfirm", pkg];
  }
}

/** A harmless `sudo -n <pm> …` invocation to probe scoped NOPASSWD rules. The
 * probe must name the SAME binary a scoped rule would whitelist (e.g.
 * `NOPASSWD: /usr/bin/pacman`) — `sudo -n true` fails under a scoped rule, so
 * it would falsely report no passwordless sudo. brew needs no sudo at all. */
export function sudoProbeArgvFor(pm: PmName): string[] {
  switch (pm) {
    case "brew":
      return [];
    case "apt-get":
      return ["-n", "apt-get", "--version"];
    case "dnf":
      return ["-n", "dnf", "--version"];
    case "apk":
      return ["-n", "apk", "--version"];
    case "pacman":
    default:
      return ["-n", "pacman", "-V"];
  }
}

/** True when passwordless sudo works for `pm` right now. Defaults to the
 * detected package manager. brew never needs sudo (always true on linux). */
export function canSudoNonInteractive(pm?: PmName): boolean {
  if (PLATFORM !== "linux") return false;
  const target = pm ?? detectPm();
  if (!target) return false;
  if (target === "brew") return true;
  try {
    const r = spawnSync("sudo", sudoProbeArgvFor(target), { stdio: "ignore" });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** A full install plan for `tool`, or null when it can't be offered (no package
 * manager, unknown package, or passwordless sudo unavailable). */
export function installPlanFor(tool: string): { pm: PmName; package: string; argv: string[] } | null {
  const pm = pmFor(toolExists);
  if (!pm) return null;
  const pkg = pkgFor(pm, tool);
  if (!pkg) return null;
  if (!canSudoNonInteractive(pm)) return null;
  return { pm, package: pkg, argv: installArgvFor(pm, pkg) };
}

/** Extra caveat text appended to an install offer, when one applies. */
const INSTALL_CAVEATS: Record<string, string> = {
  ydotool: "note: ydotool needs the ydotoold daemon running and your user in the input group.",
  grim: "note: grim works on wlroots compositors (Sway/Hyprland) only.",
};

/** Caveat for a tool, or "" — appended to the offer message. */
export function installCaveat(tool: string): string {
  return INSTALL_CAVEATS[tool] ?? "";
}

/** Run an install plan with an install-sized timeout. argv is internally
 * generated from the fixed map — never caller text. */
export function runInstall(argv: string[]): Promise<RunResult> {
  return run(argv[0] ?? "", argv.slice(1), { timeoutMs: 300_000 });
}

/** Run a service-start plan (e.g. `systemctl --user enable --now ydotool`).
 * User-level units need no sudo; argv is internally generated from the fixed
 * plan map — never caller text. */
export function runServiceStart(argv: string[]): Promise<RunResult> {
  return run(argv[0] ?? "", argv.slice(1), { timeoutMs: 60_000 });
}

// ── screenshot ────────────────────────────────────────────────────────────

/** Capture the full (multi-monitor) screen to a PNG in the scratch dir. */
export async function capture(): Promise<{ ok: boolean; path?: string; reason?: string; missing?: { tool: string } }> {
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
    r = await captureLinux(out);
  }
  if (!r.ok) return { ok: false, reason: r.reason || r.stderr.slice(0, 200) || "capture failed", missing: r.missing };
  if (!existsSync(out)) return { ok: false, reason: "capture produced no file" };
  return { ok: true, path: out };
}

/**
 * The capture toolchain order for a Linux session. On Wayland the desktop
 * environment's native tool goes first (grim is wlroots-only and GNOME's mutter
 * doesn't speak wlr-screencopy), then the rest as fallbacks; on X11 every tool
 * works so the classic order stands. Pure — injectable for tests.
 */
export function captureChainFor(de: string | undefined, exists: (name: string) => boolean, session: SessionType): readonly string[] {
  const base: readonly string[] =
    session === "wayland"
      ? ["grim", "gnome-screenshot", "spectacle"]
      : ["scrot", "maim", "import", "gnome-screenshot"];
  if (session !== "wayland") return base;
  const preferred = /GNOME/i.test(de ?? "") ? "gnome-screenshot" : /KDE/i.test(de ?? "") ? "spectacle" : "grim";
  if (!exists(preferred) || !base.includes(preferred)) return base;
  return [preferred, ...base.filter((t) => t !== preferred)];
}

/**
 * The typing/hotkey toolchain order for a Linux session, mirroring
 * captureChainFor: the desktop environment's native tool goes first. On KDE
 * and GNOME the compositor (KWin/mutter) doesn't implement the Wayland
 * virtual-keyboard protocol wtype needs, so ydotool (uinput via the ydotoold
 * daemon) is the tool that actually works — it must be offered FIRST, or an
 * installed-but-unusable wtype re-offer loops forever. On wlroots compositors
 * (Sway/Hyprland) wtype is the right first choice. Pure — injectable for tests.
 */
export function typingChainFor(de: string | undefined, session: SessionType): readonly string[] {
  if (session === "x11") return ["xdotool"];
  if (session !== "wayland") return [];
  // The system-preferred tool stays FIRST even when it's missing, so an offer
  // picks the tool that actually works here (ydotool on KDE/GNOME, wtype on
  // wlroots) rather than looping on an installed-but-unusable wtype.
  const preferred = /GNOME|KDE|plasma/i.test(de ?? "") ? "ydotool" : "wtype";
  return [preferred, ...["wtype", "ydotool"].filter((t) => t !== preferred)];
}

/**
 * Which typing tool to OFFER after the whole chain failed. Returns the FIRST
 * tool in the system-preferred order that isn't installed (so on KDE you get
 * "install ydotool", never a pointless wtype re-offer), or null when every
 * tool is present — that's a runtime problem (dead daemon, etc.), not a
 * missing install, and no offer should be made. Pure — injectable for tests.
 */
export function typingOfferFor(chain: readonly string[], exists: (name: string) => boolean): string | null {
  for (const tool of chain) if (!exists(tool)) return tool;
  return null;
}

/**
 * When the whole typing chain is installed but nothing typed, a daemon-based
 * tool (ydotool) can still be recovered by STARTING its service rather than
 * reinstalling. Returns the start plan when the chain uses ydotool and the
 * daemon is down, or null when no service-start applies (daemon running, chain
 * has no daemon-based tool, or the daemon state is unknown). Pure — injectable
 * for tests. The argv is a fixed, internally-generated user-level unit start —
 * never caller text, and `systemctl --user` needs no sudo.
 */
export function typingServicePlanFor(chain: readonly string[], daemonRunning: boolean | null): { tool: string; argv: string[] } | null {
  if (!chain.includes("ydotool") || daemonRunning !== false) return null;
  return { tool: "ydotool", argv: ["systemctl", "--user", "enable", "--now", "ydotool"] };
}

/** What a failing typing run should do NEXT: offer a genuinely-missing tool,
 *  offer to start a down daemon, or give up. Mirrors the decision inside
 *  `typeText` exactly — extracted so the branching is testable without spawning
 *  real tools. Pure — injectable for tests. */
export type TypingOutcome =
  | { kind: "missing"; tool: string }
  | { kind: "service"; plan: { tool: string; argv: string[] } }
  | { kind: "failed" };

export function typingOutcome(deps: {
  chain: readonly string[];
  present: (name: string) => boolean;
  daemonRunning: boolean | null;
}): TypingOutcome {
  const offer = typingOfferFor(deps.chain, deps.present);
  if (offer) return { kind: "missing", tool: offer };
  const servicePlan = typingServicePlanFor(deps.chain, deps.daemonRunning);
  if (servicePlan) return { kind: "service", plan: servicePlan };
  return { kind: "failed" };
}

/** Same decision for hotkeys, but with the executor filter baked in: only wtype
 *  and xdotool have real hotkey drivers today (ydotool has no keycode driver
 *  yet), so a chain that merely prefers ydotool must NOT loop an offer the
 *  executor can't honor. Pure — injectable for tests. */
export function hotkeyOutcome(deps: {
  chain: readonly string[];
  present: (name: string) => boolean;
}): TypingOutcome {
  const offerable = deps.chain.filter((t) => t === "wtype" || t === "xdotool");
  const offer = typingOfferFor(offerable, deps.present);
  if (offer) return { kind: "missing", tool: offer };
  return { kind: "failed" };
}

function typeWith(tool: string, text: string): Promise<RunResult> {
  switch (tool) {
    case "wtype":
      return run("wtype", ["-"], { input: text });
    case "ydotool":
      return run("ydotool", ["type", text]);
    case "xdotool":
      return run("xdotool", ["type", "--", text]);
    default:
      return Promise.resolve({ ok: false, code: null, stdout: "", stderr: "", reason: `unknown typing tool ${tool}` });
  }
}

function hotkeyWith(tool: string, combo: string): Promise<RunResult> {
  switch (tool) {
    case "wtype":
      return run("wtype", ["-s", combo.replace(/\s+/g, "")]);
    case "xdotool":
      return run("xdotool", ["key", combo]);
    default:
      return Promise.resolve({ ok: false, code: null, stdout: "", stderr: "", reason: `unknown hotkey tool ${tool}` });
  }
}

function captureWith(tool: string, out: string): Promise<RunResult> {
  switch (tool) {
    case "grim":
      return run("grim", [out]);
    case "gnome-screenshot":
      return run("gnome-screenshot", ["-f", out]);
    case "spectacle":
      return run("spectacle", ["-b", "-o", out]);
    case "scrot":
      return run("scrot", ["-o", out]);
    case "maim":
      return run("maim", [out]);
    case "import":
      return run("import", ["-window", "root", out]);
    default:
      return Promise.resolve({ ok: false, code: null, stdout: "", stderr: "", reason: `unknown capture tool ${tool}` });
  }
}

/** Session-aware Linux capture. Headless boxes (the VPS) fail fast and clearly. */
async function captureLinux(out: string): Promise<RunResult> {
  const session = sessionType();
  if (session === "headless") {
    return {
      ok: false,
      code: null,
      stdout: "",
      stderr: "",
      reason: "no display server — screenshots need a desktop session, not a headless box",
    };
  }
  const chain = captureChainFor(process.env.XDG_CURRENT_DESKTOP, toolExists, session);
  for (const tool of chain) {
    const r = await captureWith(tool, out);
    if (r.ok) return r;
  }
  const names = session === "wayland" ? "grim, gnome-screenshot, or spectacle" : "scrot, maim, import, or gnome-screenshot";
  const preferred = chain[0] ?? "grim";
  return {
    ok: false,
    code: null,
    stdout: "",
    stderr: "",
    reason: `no screenshot tool works — install one: sudo pacman -S ${session === "wayland" ? "grim" : "scrot"} (${names})`,
    missing: { tool: preferred },
  };
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
  // Linux: PipeWire → PulseAudio → ALSA.
  return setVolumeLinux(s, abs);
}

/**
 * Linux volume — chain PipeWire (wpctl) → PulseAudio (pactl) → ALSA (amixer).
 * Each drives the default sink/device, so no per-user state is needed.
 */
async function setVolumeLinux(s: string, abs: number): Promise<RunResult> {
  if (s !== "mute" && s !== "up" && s !== "down" && !Number.isFinite(abs)) {
    return { ok: false, code: null, stdout: "", stderr: "", reason: "volume: use a number, up, down, or mute" };
  }
  const attempts: Array<() => Promise<RunResult>> = [
    () => {
      if (s === "mute") return run("wpctl", ["set-mute", "@DEFAULT_AUDIO_SINK@", "toggle"]);
      if (s === "up") return run("wpctl", ["set-volume", "@DEFAULT_AUDIO_SINK@", "0.1+"]);
      if (s === "down") return run("wpctl", ["set-volume", "@DEFAULT_AUDIO_SINK@", "0.1-"]);
      return run("wpctl", ["set-volume", "@DEFAULT_AUDIO_SINK@", String(Math.max(0, Math.min(100, abs)) / 100)]);
    },
    () => {
      if (s === "mute") return run("pactl", ["set-sink-mute", "@DEFAULT_SINK@", "toggle"]);
      if (s === "up") return run("pactl", ["set-sink-volume", "@DEFAULT_SINK@", "+10%"]);
      if (s === "down") return run("pactl", ["set-sink-volume", "@DEFAULT_SINK@", "-10%"]);
      return run("pactl", ["set-sink-volume", "@DEFAULT_SINK@", `${Math.max(0, Math.min(100, abs))}%`]);
    },
    () => {
      if (s === "mute") return run("amixer", ["set", "Master", "toggle"]);
      if (s === "up") return run("amixer", ["set", "Master", "10%+"]);
      if (s === "down") return run("amixer", ["set", "Master", "10%-"]);
      return run("amixer", ["set", "Master", `${Math.max(0, Math.min(100, abs))}%`]);
    },
  ];
  let last: RunResult | null = null;
  for (const attempt of attempts) {
    last = await attempt();
    if (last.ok) return last;
  }
  return {
    ok: false,
    code: null,
    stdout: "",
    stderr: "",
    reason: "no volume control works — install one of: wpctl (pipewire), pactl (pulseaudio), amixer (alsa-utils)",
    missing: { tool: "wpctl" },
  };
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
  if (!toolExists("playerctl")) {
    return { ok: false, code: null, stdout: "", stderr: "", reason: "media keys need playerctl — install it (pacman -S playerctl)", missing: { tool: "playerctl" } };
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
  if (!toolExists("notify-send")) {
    return { ok: false, code: null, stdout: "", stderr: "", reason: "notifications need notify-send — install libnotify (pacman -S libnotify)", missing: { tool: "notify-send" } };
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

export async function clipGet(): Promise<{ ok: boolean; text?: string; reason?: string; missing?: { tool: string } }> {
  let r: RunResult;
  const headless = sessionType() === "headless";
  if (PLATFORM === "win32") r = await pwsh("Get-Clipboard -Raw");
  else if (PLATFORM === "darwin") r = await run("pbpaste", []);
  else if (sessionType() === "wayland") {
    if (!toolExists("wl-paste")) return { ok: false, reason: "clipboard needs wl-paste — install wl-clipboard (pacman -S wl-clipboard)", ...(headless ? {} : { missing: { tool: "wl-paste" } }) };
    r = await run("wl-paste", ["--no-newline"]);
  } else {
    if (!toolExists("xclip")) return { ok: false, reason: "clipboard needs xclip — install it (pacman -S xclip)", ...(headless ? {} : { missing: { tool: "xclip" } }) };
    r = await run("xclip", ["-selection", "clipboard", "-o"]);
  }
  if (!r.ok) return { ok: false, reason: r.reason || "clipboard read failed" };
  return { ok: true, text: r.stdout.slice(0, OUT_CAP) };
}

export async function clipSet(text: string): Promise<RunResult> {
  if (PLATFORM === "win32") return pwsh("Set-Clipboard -Value $env:MERRYMEN_CLIP", { MERRYMEN_CLIP: text });
  if (PLATFORM === "darwin") return run("pbcopy", [], { input: text });
  const headless = sessionType() === "headless";
  if (sessionType() === "wayland") {
    if (!toolExists("wl-copy")) {
      return { ok: false, code: null, stdout: "", stderr: "", reason: "clipboard needs wl-copy — install wl-clipboard (pacman -S wl-clipboard)", missing: headless ? undefined : { tool: "wl-copy" } };
    }
    return run("wl-copy", [], { input: text });
  }
  if (!toolExists("xclip")) {
    return { ok: false, code: null, stdout: "", stderr: "", reason: "clipboard needs xclip — install it (pacman -S xclip)", missing: headless ? undefined : { tool: "xclip" } };
  }
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
  if (PLATFORM === "linux") {
    const session = sessionType();
    const chain = typingChainFor(process.env.XDG_CURRENT_DESKTOP, session);
    if (chain.length === 0) {
      return {
        ok: false,
        code: null,
        stdout: "",
        stderr: "",
        reason: "no display server — typing needs a desktop session, not a headless box",
      };
    }
    for (const tool of chain) {
      const r = await typeWith(tool, text);
      if (r.ok) return r;
    }
    const outcome = typingOutcome({
      chain,
      present: toolExists,
      daemonRunning: await procRunning("ydotoold"),
    });
    if (outcome.kind === "missing") {
      return {
        ok: false,
        code: null,
        stdout: "",
        stderr: "",
        reason: `typing needs ${outcome.tool} on this ${session} session — install it and try again`,
        missing: { tool: outcome.tool },
      };
    }
    if (outcome.kind === "service") {
      return {
        ok: false,
        code: null,
        stdout: "",
        stderr: "",
        reason: `typing failed: the ${outcome.plan.tool} daemon (ydotoold) isn't running — start it and try again`,
        needsService: outcome.plan,
      };
    }
    return {
      ok: false,
      code: null,
      stdout: "",
      stderr: "",
      reason: `typing failed: ${chain.join(", ")} ${chain.length > 1 ? "are" : "is"} installed but none could type${
        chain.includes("ydotool") ? " — ydotool needs the ydotoold daemon running and your user in the input group" : ""
      }`,
    };
  }
  if (PLATFORM === "darwin") return unsupported("type");
  return unsupported("type");
}

export async function hotkey(combo: string): Promise<RunResult> {
  if (PLATFORM === "win32") {
    const sk = comboToSendKeys(combo);
    if (!sk) return { ok: false, code: null, stdout: "", stderr: "", reason: `couldn't parse hotkey "${combo}"` };
    return pwsh("(New-Object -ComObject WScript.Shell).SendKeys($env:MERRYMEN_KEYS)", { MERRYMEN_KEYS: sk });
  }
  if (PLATFORM === "linux") {
    const session = sessionType();
    const chain = typingChainFor(process.env.XDG_CURRENT_DESKTOP, session);
    if (chain.length === 0) {
      return {
        ok: false,
        code: null,
        stdout: "",
        stderr: "",
        reason: "no display server — hotkeys need a desktop session, not a headless box",
      };
    }
    for (const tool of chain) {
      const r = await hotkeyWith(tool, combo);
      if (r.ok) return r;
    }
    // Hotkeys only have real executors for wtype/xdotool today. On KDE/GNOME
    // the system-preferred tool is ydotool, which has no keycode driver yet —
    // so don't loop an offer the executor can't honor. Report the true state.
    const outcome = hotkeyOutcome({ chain, present: toolExists });
    if (outcome.kind === "missing") {
      return {
        ok: false,
        code: null,
        stdout: "",
        stderr: "",
        reason: `hotkeys need ${outcome.tool} on this ${session} session — install it and try again`,
        missing: { tool: outcome.tool },
      };
    }
    return {
      ok: false,
      code: null,
      stdout: "",
      stderr: "",
      reason: `hotkeys failed: ${chain.join(", ")} installed but none could fire${
        chain.includes("ydotool") ? " — ydotool hotkeys need a keycode driver (only /type works via ydotool for now)" : ""
      }`,
    };
  }
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

// ── diagnostics (/pc doctor line) ──────────────────────────────────────────

export interface PcDoctorTool {
  name: string;
  present: boolean;
}

export interface PcDoctorReport {
  platform: string;
  session: SessionType;
  tools: PcDoctorTool[];
}

/** Probe the tools the CURRENT session would use, for the /pc status line. */
export function pcDoctor(): PcDoctorReport {
  const st = sessionType();
  if (PLATFORM !== "linux") return { platform: PLATFORM, session: st, tools: [] };
  const capture = captureChainFor(process.env.XDG_CURRENT_DESKTOP, toolExists, st);
  const clipboard = st === "wayland" ? ["wl-paste", "wl-copy"] : ["xclip"];
  const input = typingChainFor(process.env.XDG_CURRENT_DESKTOP, st);
  const names = [...new Set([...capture, ...clipboard, ...input, "wpctl", "pactl", "amixer", "playerctl", "notify-send"])];
  return { platform: PLATFORM, session: st, tools: names.map((name) => ({ name, present: toolExists(name) })) };
}

export { PLATFORM };
