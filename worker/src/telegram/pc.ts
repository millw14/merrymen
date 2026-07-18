/**
 * PC-control glue: the pure safety helpers (path containment, shell/app
 * allowlists) and the factory that binds the platform layer to a chat.
 *
 * The pure helpers here are the security-critical core and are unit-tested
 * directly (pc.test.ts): a file op can never escape the configured root, and a
 * shell command can never run unless it exactly matches an allowlist entry and
 * carries no chaining/redirect metacharacters.
 */

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import path from "node:path";
import { realpathSync } from "node:fs";
import { esc, sendPhoto, type TelegramOpts } from "./api";
import * as pcp from "../pc/platform";

// ── pure safety helpers (tested directly) ────────────────────────────────────

/**
 * Resolve `rel` inside `root`, rejecting any escape (`..`, absolute paths,
 * symlinks that point outside). Empty `rel` means the root itself.
 */
export function resolveInRoot(
  root: string | undefined,
  rel: string,
): { ok: true; abs: string } | { ok: false; reason: string } {
  if (!root || !root.trim()) return { ok: false, reason: "no files root is set — pick one in the dashboard" };
  const rootAbs = path.resolve(root);
  const target = path.resolve(rootAbs, rel || ".");
  const within = (p: string) => p === rootAbs || p.startsWith(rootAbs + path.sep);
  if (!within(target)) return { ok: false, reason: "that path is outside your files root — refused" };
  // Defeat symlink escape: if it exists, its real path must also be contained.
  try {
    const real = realpathSync(target);
    if (!within(real)) return { ok: false, reason: "that path resolves outside your files root — refused" };
  } catch {
    /* doesn't exist yet — the resolved-path check above already bounded it */
  }
  return { ok: true, abs: target };
}

const SHELL_META = /[&|;`\n\r]|\$\(|>|</; // chaining, redirect, subshell — never allowed

/**
 * A command may run only if it EXACTLY matches an allowlist entry (or an entry
 * followed by a space + args) AND contains no shell metacharacters that could
 * chain or redirect. "git status" allowed; "git status && rm -rf /" refused.
 */
export function shellAllowed(cmd: string, allowlist: string[]): boolean {
  const c = cmd.trim();
  if (!c || SHELL_META.test(c)) return false;
  return allowlist.some((a) => {
    const t = a.trim();
    return t !== "" && (c === t || c.startsWith(t + " "));
  });
}

/** An app may launch only if its name matches an allowlist entry (case-insensitive). */
export function appAllowed(name: string, allowlist: string[]): boolean {
  const n = name.trim().toLowerCase();
  return n !== "" && allowlist.some((a) => a.trim().toLowerCase() === n);
}

export function isUrl(s: string): boolean {
  const t = s.trim();
  // Must be a well-formed http(s) URL AND free of shell metacharacters — it ends
  // up in `cmd /c start "" <url>` / `open <url>`, so &, |, ;, quotes, backticks,
  // $(), redirects, whitespace, or newlines could break out into command exec.
  if (!/^https?:\/\/[^\s"'`]+$/i.test(t)) return false;
  if (/[&|;`$<>^%!\\]|\$\(/.test(t)) return false;
  try {
    const u = new URL(t);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// ── formatters ───────────────────────────────────────────────────────────

function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function fmtSysInfo(i: pcp.SysInfo): string {
  const lines = [
    `🖥️ <b>${esc(i.host)}</b>`,
    `• ${esc(i.platform)} ${esc(i.release)}`,
    `• up ${fmtUptime(i.uptimeSec)}`,
    `• cpu: ${esc(i.cpuModel)} ×${i.cpuCount}${i.loadPct !== null ? ` · load ${i.loadPct}%` : ""}`,
    `• mem: ${i.memUsedGb} / ${i.memTotalGb} GB`,
  ];
  if (i.battery !== null) lines.push(`• battery: ${i.battery}%`);
  return lines.join("\n");
}

function fmtDir(root: string, absPath: string, entries: pcp.DirEntry[]): string {
  const rel = path.relative(root, absPath) || ".";
  const body = entries
    .map((e) => (e.dir ? `📁 ${esc(e.name)}/` : `📄 ${esc(e.name)} · ${e.sizeKb}KB`))
    .join("\n");
  return `📂 <b>${esc(rel)}</b> (${entries.length})\n${body || "(empty)"}`;
}

// ── the chat-bound action set (what CommandDeps.pc points at) ──────────────

export interface PcActions {
  screenshot(): Promise<string>;
  look(question: string): Promise<string>;
  open(target: string): Promise<string>;
  sysinfo(): Promise<string>;
  volume(spec: string): Promise<string>;
  media(key: string): Promise<string>;
  notify(text: string): Promise<string>;
  lock(): Promise<string>;
  ls(relPath: string): Promise<string>;
  clipGet(): Promise<string>;
  clipSet(text: string): Promise<string>;
  // dangerous — only ever invoked from the /confirm handler
  runShell(cmd: string): Promise<string>;
  getFile(relPath: string): Promise<string>;
  typeText(text: string): Promise<string>;
  hotkey(combo: string): Promise<string>;
  power(action: "sleep" | "shutdown"): Promise<string>;
}

export interface PcActionConfig {
  filesRoot: string | undefined;
  shellAllowlist: string[];
  appAllowlist: string[];
  anthropicApiKey: string | undefined;
  llmModel: string;
}

/** Bind the platform layer to a single chat (token+chatId) for outbound media. */
export function makePcActions(
  opts: TelegramOpts,
  chatId: number,
  cfg: PcActionConfig,
  note: (level: "ok" | "warn", msg: string) => void,
): PcActions {
  const fail = (r?: string) => `⚠️ ${esc(r ?? "that didn't work")}`;

  return {
    async screenshot() {
      const r = await pcp.capture();
      if (!r.ok || !r.path) return fail(r.reason);
      const sent = await sendPhoto(opts, chatId, r.path, "📸 your screen");
      note("ok", "Telegram: sent a screenshot");
      return sent.ok ? "" /* photo speaks for itself */ : fail(sent.reason);
    },

    async look(question) {
      if (!cfg.anthropicApiKey) return "👁️ vision needs an Anthropic key — add one in the dashboard.";
      const shot = await pcp.capture();
      if (!shot.ok || !shot.path) return fail(shot.reason);
      try {
        const b64 = readFileSync(shot.path).toString("base64");
        const client = new Anthropic({ apiKey: cfg.anthropicApiKey });
        const resp = await client.messages.create({
          model: cfg.llmModel,
          max_tokens: 700,
          messages: [
            {
              role: "user",
              content: [
                { type: "image", source: { type: "base64", media_type: "image/png", data: b64 } },
                { type: "text", text: question.trim() || "What's on my screen right now? Be concise." },
              ],
            },
          ],
        });
        const text = resp.content.find((b) => b.type === "text");
        note("ok", "Telegram: answered a vision question about the screen");
        return text && text.type === "text" ? `👁️ ${esc(text.text.trim())}` : "👁️ (no answer)";
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },

    async open(target) {
      const t = target.trim();
      if (isUrl(t)) {
        const r = await pcp.openUrl(t);
        note("ok", `Telegram: opened URL ${t}`);
        return r.ok ? `🌐 opened ${esc(t)}` : fail(r.reason);
      }
      if (!appAllowed(t, cfg.appAllowlist)) {
        return `🔒 "${esc(t)}" isn't in your app allowlist. Add it in the dashboard, or send a full https:// URL.`;
      }
      const r = await pcp.openApp(t);
      note("ok", `Telegram: opened app ${t}`);
      return r.ok ? `🚀 opened ${esc(t)}` : fail(r.reason);
    },

    async sysinfo() {
      const r = await pcp.sysInfo();
      return r.ok && r.info ? fmtSysInfo(r.info) : fail(r.reason);
    },

    async volume(spec) {
      const r = await pcp.setVolume(spec);
      return r.ok ? `🔊 volume ${esc(spec)}` : fail(r.reason || r.stderr);
    },

    async media(key) {
      const r = await pcp.mediaKey(key);
      return r.ok ? `⏯️ ${esc(key)}` : fail(r.reason || r.stderr);
    },

    async notify(text) {
      const r = await pcp.notify(text);
      return r.ok ? "🔔 popped a desktop notification" : fail(r.reason || r.stderr);
    },

    async lock() {
      const r = await pcp.lockScreen();
      note("warn", "Telegram: locked the screen");
      return r.ok ? "🔒 locked your screen" : fail(r.reason || r.stderr);
    },

    async ls(relPath) {
      const res = resolveInRoot(cfg.filesRoot, relPath);
      if (!res.ok) return `🔒 ${esc(res.reason)}`;
      const r = pcp.listDir(res.abs);
      return r.ok && r.entries ? fmtDir(path.resolve(cfg.filesRoot!), res.abs, r.entries) : fail(r.reason);
    },

    async clipGet() {
      const r = await pcp.clipGet();
      if (!r.ok) return fail(r.reason);
      const t = (r.text ?? "").trim();
      return t ? `📋 <code>${esc(t)}</code>` : "📋 clipboard is empty";
    },

    async clipSet(text) {
      const r = await pcp.clipSet(text);
      return r.ok ? "📋 copied to your clipboard" : fail(r.reason || r.stderr);
    },

    // ── dangerous (confirmed) ────────────────────────────────────────────
    async runShell(cmd) {
      if (!shellAllowed(cmd, cfg.shellAllowlist)) {
        return `🔒 "${esc(cmd)}" isn't in your shell allowlist (or contains chaining/redirect). Refused.`;
      }
      note("warn", `Telegram: ran shell \`${cmd}\``);
      const r = await pcp.runShell(cmd);
      const out = pcp.capOutput(((r.stdout || "") + (r.stderr ? "\n" + r.stderr : "")).trim());
      return `🖥️ <b>${esc(cmd)}</b> (exit ${r.code ?? "?"})\n<code>${esc(out || "(no output)")}</code>`;
    },

    async getFile(relPath) {
      const res = resolveInRoot(cfg.filesRoot, relPath);
      if (!res.ok) return `🔒 ${esc(res.reason)}`;
      const { sendDocument } = await import("./api");
      const sent = await sendDocument(opts, chatId, res.abs, `📎 ${esc(path.basename(res.abs))}`);
      note("warn", `Telegram: sent file ${path.basename(res.abs)}`);
      return sent.ok ? "" : fail(sent.reason);
    },

    async typeText(text) {
      const r = await pcp.typeText(text);
      note("warn", "Telegram: typed into the active window");
      return r.ok ? `⌨️ typed it` : fail(r.reason || r.stderr);
    },

    async hotkey(combo) {
      const r = await pcp.hotkey(combo);
      note("warn", `Telegram: pressed ${combo}`);
      return r.ok ? `⌨️ pressed ${esc(combo)}` : fail(r.reason || r.stderr);
    },

    async power(action) {
      const r = await pcp.powerAction(action);
      note("warn", `Telegram: ${action}`);
      return r.ok ? `⏻ ${action}…` : fail(r.reason || r.stderr);
    },
  };
}
