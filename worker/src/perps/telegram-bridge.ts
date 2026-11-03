import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, unlinkSync } from "node:fs";
import path from "node:path";
import { parsePerpsReport, type PerpKey } from "../../../packages/core/src/index";
import { fsyncDirSync, writeFileAtomicSync } from "../atomic-write";
import type { TelegramPerpsPort, TelegramPerpsSnapshot } from "../telegram/perps";
import { botIdOf, tokenTagOf } from "../telegram/state";

export const PERPS_BOT_SNAPSHOT = "perps-bot-view.json";
export const PERPS_BOT_OUTBOX = "perps-bot-requests";
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_AGE_MS = 60_000;
const MAX_DIRECTORY_FILES = 4_096;
const REQUEST_NAME = /^[a-f0-9]{64}\.json$/;
const RESULT_NAME = /^[a-f0-9]{64}\.result\.json$/;

/** Bounds apply to the opened inode too: no symlinks, devices, pipes or growing-file reads. */
export function readBoundedPerpsJson(file: string, limit: number): unknown {
  if (!lstatSync(file).isFile()) throw new Error("The Perps bridge file is not regular.");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new Error("The Perps bridge file is too large.");
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length <= limit) {
      const n = readSync(fd, buffer, length, buffer.length - length, null);
      if (n === 0) break;
      length += n;
    }
    if (length > limit) throw new Error("The Perps bridge file is too large.");
    return JSON.parse(buffer.toString("utf8", 0, length));
  } finally { closeSync(fd); }
}

/** fsync of a file's own directory does not persist newly created ancestors. */
function ensureDirectory(dir: string): void {
  const first = mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!lstatSync(dir).isDirectory()) throw new Error("The Perps bridge directory is not regular.");
  if (first) {
    let current = path.resolve(dir), stop = path.resolve(first);
    for (;;) {
      fsyncDirSync(path.dirname(current));
      if (current === stop) break;
      current = path.dirname(current);
    }
  }
}
function namesIn(dir: string): string[] {
  if (!lstatSync(dir).isDirectory()) throw new Error("The Perps bridge directory is not regular.");
  const handle = opendirSync(dir), names: string[] = [];
  try {
    for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
      if (names.length >= MAX_DIRECTORY_FILES) throw new Error("The Perps request queue is busy.");
      names.push(entry.name);
    }
  } finally { handle.closeSync(); }
  return names;
}
type Receipt = { key: string; line: string; at: number; kind: PerpsBotRequest["kind"] };
function readReceipt(file: string, key: string): Receipt | "unread" | null {
  try {
    const value = readBoundedPerpsJson(file, 4_096) as Partial<Receipt> | null;
    if (!value || value.key !== key || typeof value.line !== "string" || value.line.length > 2_000
        || !Number.isSafeInteger(value.at) || value.at! <= 0 || !["close", "flatten", "pause", "resume", "kill"].includes(String(value.kind))) return "unread";
    return { key, line: value.line, at: value.at!, kind: value.kind! };
  } catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? null : "unread"; }
}

export interface PerpsBotAuthority {
  botId: string;
  tokenTag: string;
  ownerId: number;
  linkedAtSec: number;
}
function authorityOf(value: unknown): PerpsBotAuthority | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const a = value as Record<string, unknown>;
  if (Object.keys(a).length !== 4 || Object.keys(a).some(key => !["botId", "tokenTag", "ownerId", "linkedAtSec"].includes(key))
      || typeof a.botId !== "string" || !/^[1-9][0-9]{0,19}$/.test(a.botId)
      || typeof a.tokenTag !== "string" || !/^[a-f0-9]{16}$/.test(a.tokenTag)
      || typeof a.ownerId !== "number" || !Number.isSafeInteger(a.ownerId) || a.ownerId <= 0
      || typeof a.linkedAtSec !== "number" || !Number.isSafeInteger(a.linkedAtSec) || a.linkedAtSec <= 0) return null;
  return { botId: a.botId, tokenTag: a.tokenTag, ownerId: a.ownerId, linkedAtSec: a.linkedAtSec };
}

/** Fresh local settings AND the persisted link must authorize this exact bot generation. */
export function readPerpsBotAuthority(home: string): PerpsBotAuthority | null {
  try {
    const cfg = readBoundedPerpsJson(path.join(home, "settings.json"), 256_000) as Record<string, unknown> | null;
    const state = readBoundedPerpsJson(path.join(home, "telegram.json"), 256_000) as Record<string, unknown> | null;
    if (!cfg || !state || cfg.telegramEnabled !== true || (cfg.telegramControlEnabled !== undefined && cfg.telegramControlEnabled !== true) || typeof cfg.telegramBotToken !== "string" || cfg.telegramBotToken.length > 256
        || !Array.isArray(cfg.telegramAllowlist) || cfg.telegramAllowlist.length > 1_000
        || !cfg.telegramAllowlist.every(id => typeof id === "number" && Number.isSafeInteger(id))
        || !cfg.telegramAllowlist.includes(state.ownerId) || !state.linkedChatAt || typeof state.linkedChatAt !== "object" || Array.isArray(state.linkedChatAt)) return null;
    const botId = botIdOf(cfg.telegramBotToken), tokenTag = tokenTagOf(cfg.telegramBotToken);
    if (state.botId !== botId || state.tokenTag !== tokenTag) return null;
    const authority = authorityOf({ botId, tokenTag, ownerId: state.ownerId, linkedAtSec: (state.linkedChatAt as Record<string, unknown>)[String(state.ownerId)] });
    if (!authority || authority.linkedAtSec > Math.floor(Date.now() / 1000)) return null;
    return authority;
  } catch { return null; }
}

export type PerpsBotRequest = {
  kind: "close" | "flatten" | "pause" | "resume" | "kill";
  expectedAccount: `0x${string}`;
  requestId: string;
  askedAtSec: number;
  market?: PerpKey;
  authority?: PerpsBotAuthority;
};

/** A request never chooses a home, tenant or ledger. The parent supplies all three. */
export function parsePerpsBotRequest(value: unknown, nowMs = Date.now()): PerpsBotRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const authority = v.authority === undefined ? undefined : authorityOf(v.authority);
  const update = typeof v.requestId === "string" ? /^tg-perps-([1-9][0-9]{0,19})-(0|[1-9][0-9]{0,15})$/.exec(v.requestId) : null;
  if (Object.keys(v).some(key => !["kind", "expectedAccount", "requestId", "askedAtSec", "market", "authority"].includes(key))
      || !["close", "flatten", "pause", "resume", "kill"].includes(String(v.kind))
      || typeof v.expectedAccount !== "string" || !ADDRESS.test(v.expectedAccount)
      || typeof v.requestId !== "string" || !ID.test(v.requestId)
      || typeof v.askedAtSec !== "number" || !Number.isSafeInteger(v.askedAtSec)
      || !Number.isSafeInteger(nowMs) || nowMs <= 0 || v.askedAtSec <= 0 || !Number.isSafeInteger(v.askedAtSec * 1000)
      || v.askedAtSec * 1000 > nowMs + 5_000 || (v.kind !== "kill" && nowMs - v.askedAtSec * 1000 > 90_000)
      || (v.authority !== undefined && (!authority || (v.kind !== "kill" && (!update || update[1] !== authority.botId || !Number.isSafeInteger(Number(update[2]))))))
      || (v.kind === "close" ? typeof v.market !== "string" || !/^[A-Z0-9]{1,24}-PERP$/.test(v.market) : v.market !== undefined)) return null;
  return v as PerpsBotRequest;
}

export function perpsBotRequestKey(input: PerpsBotRequest): string {
  return createHash("sha256").update(JSON.stringify(["telegram-perps-v1", input.requestId])).digest("hex");
}

function snapshotOf(value: unknown): TelegramPerpsSnapshot {
  const s = value as Partial<Extract<TelegramPerpsSnapshot, { state: "ready" }>> | null;
  if ((value as { state?: unknown } | null)?.state === "absent") return { state: "absent" };
  if (s?.state !== "ready" || typeof s.account !== "string" || !ADDRESS.test(s.account)
      || (s.grantExpiresAt !== null && (!Number.isSafeInteger(s.grantExpiresAt) || s.grantExpiresAt! <= 0))) return { state: "unread" };
  const report = s.report === null ? null : parsePerpsReport(s.report);
  if (s.report !== null && (!report || report.mode === "live" || report.accountIndex !== null)) return { state: "unread" };
  return { state: "ready", account: s.account, report, grantExpiresAt: s.grantExpiresAt! };
}

/** Whitelist the report; no grant, key, owner token or other tenant's state crosses the bridge. */
export function writePerpsBotSnapshot(home: string, snapshot: TelegramPerpsSnapshot, nowMs = Date.now()): void {
  ensureDirectory(home);
  const file = path.join(home, PERPS_BOT_SNAPSHOT);
  try { if (!lstatSync(file).isFile()) throw new Error("The Perps snapshot is not regular."); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  writeFileAtomicSync(file, JSON.stringify({ v: 1, at: nowMs, snapshot: snapshotOf(snapshot) }), 0o600, { followSymlinks: false });
}

export function readPerpsBotSnapshot(home: string, nowMs = Date.now()): TelegramPerpsSnapshot {
  try {
    const v = readBoundedPerpsJson(path.join(home, PERPS_BOT_SNAPSHOT), 256_000) as { v?: unknown; at?: unknown; snapshot?: unknown } | null;
    if (v?.v !== 1 || typeof v.at !== "number" || !Number.isSafeInteger(v.at) || v.at <= 0 || v.at > nowMs || nowMs - v.at > MAX_AGE_MS) return { state: "unread" };
    return snapshotOf(v.snapshot);
  } catch { return { state: "unread" }; }
}

export function writePerpsBotRequest(home: string, request: PerpsBotRequest): string {
  if (!parsePerpsBotRequest(request)) throw new Error("The Perps request is invalid or expired.");
  ensureDirectory(home);
  const dir = path.join(home, PERPS_BOT_OUTBOX), key = perpsBotRequestKey(request);
  ensureDirectory(dir);
  const receipt = readReceipt(path.join(dir, `${key}.result.json`), key);
  if (receipt === "unread") throw new Error("The earlier Perps result could not be read. Check the desk before asking again.");
  if (receipt) return key;
  const file = path.join(dir, `${key}.json`);
  try {
    const pending = parsePerpsBotRequest(readBoundedPerpsJson(file, 2_048));
    if (!pending || perpsBotRequestKey(pending) !== key) throw new Error("The earlier Perps request could not be read.");
    return key;
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  if (namesIn(dir).filter(name => REQUEST_NAME.test(name)).length >= 16) throw new Error("The Perps request queue is busy. Check the desk before asking again.");
  writeFileAtomicSync(file, JSON.stringify(request), 0o600, { durable: true, followSymlinks: false });
  return key;
}

async function ask(home: string, request: PerpsBotRequest): Promise<string> {
  const authority = readPerpsBotAuthority(home);
  if (!authority) throw new Error("The linked Perps owner changed. Nothing was queued; use the desk.");
  const key = writePerpsBotRequest(home, { ...request, authority }), file = path.join(home, PERPS_BOT_OUTBOX, `${key}.result.json`);
  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    const receipt = readReceipt(file, key);
    if (receipt && receipt !== "unread") return receipt.line;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return "The request was recorded, but the service has not confirmed it. Check the Perps desk before asking again; nothing is retried automatically.";
}

export function fileTelegramPerpsPort(home: string): TelegramPerpsPort {
  return {
    read: async () => readPerpsBotSnapshot(home),
    exit: input => ask(home, { kind: input.action, expectedAccount: input.expectedAccount, requestId: input.requestId, askedAtSec: input.askedAtSec, ...(input.market ? { market: input.market } : {}) }),
  };
}

export async function askPerpsBotControl(home: string, kind: "pause" | "resume", input: { requestId: string; askedAtSec: number }): Promise<string> {
  const snapshot = readPerpsBotSnapshot(home);
  if (snapshot.state !== "ready") return "The Perps wallet could not be identified. Nothing was changed; check the desk.";
  return ask(home, { ...input, kind, expectedAccount: snapshot.account });
}

export function queuePerpsBotKill(home: string): { ok: true; revocation: "queued"; archived: null } | { ok: false; reason: string } {
  const authority = readPerpsBotAuthority(home);
  if (!authority) return { ok: false, reason: "The linked Perps owner could not be verified; use Kill all agents on the web" };
  try {
    ensureDirectory(home);
    const paused = path.join(home, "paused");
    try { if (!lstatSync(paused).isFile()) throw new Error("The login pause marker is unreadable."); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    // Restrict immediately, even if the parent's database or queue is offline.
    // A failed enqueue leaves this pause in place and never promises revocation.
    writeFileAtomicSync(paused, "paused while the Perps owner kill awaits confirmation\n", 0o600, { durable: true, followSymlinks: false });
    const snapshot = readPerpsBotSnapshot(home);
    if (snapshot.state !== "ready") return { ok: false, reason: "The login is paused, but the Perps wallet is unreadable; use Kill all agents on the web" };
    writePerpsBotRequest(home, { kind: "kill", expectedAccount: snapshot.account, requestId: randomUUID(), askedAtSec: Math.floor(Date.now() / 1000), authority });
    return { ok: true, revocation: "queued", archived: null };
  } catch { return { ok: false, reason: "The kill could not be confirmed; use Kill all agents on the web" }; }
}

/** Time order matters for pause/resume; Telegram IDs are decimal numbers, not strings. */
function compareRequests(a: { key: string; request: PerpsBotRequest | null }, b: { key: string; request: PerpsBotRequest | null }): number {
  const time = (a.request?.askedAtSec ?? 0) - (b.request?.askedAtSec ?? 0);
  if (time) return time;
  const aa = /^tg-perps-([1-9][0-9]*)-([0-9]+)$/.exec(a.request?.requestId ?? "");
  const bb = /^tg-perps-([1-9][0-9]*)-([0-9]+)$/.exec(b.request?.requestId ?? "");
  if (aa && bb) {
    const leftBot = BigInt(aa[1]!), rightBot = BigInt(bb[1]!);
    if (leftBot !== rightBot) return leftBot < rightBot ? -1 : 1;
    const left = BigInt(aa[2]!), right = BigInt(bb[2]!);
    if (left !== right) return left < right ? -1 : 1;
  } else if (aa || bb) return aa ? -1 : 1;
  return a.key.localeCompare(b.key);
}

/** At most 16 small requests per pass. Apply must be idempotent across a crash before the result write. */
export async function drainPerpsBotRequests(home: string, mayWrite: () => boolean, apply: (request: PerpsBotRequest) => Promise<string>): Promise<void> {
  const dir = path.join(home, PERPS_BOT_OUTBOX);
  let names: string[];
  try { names = namesIn(dir); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
  const pending = names.filter(name => REQUEST_NAME.test(name)).map(name => {
    const key = name.slice(0, -5), file = path.join(dir, name);
    let request: PerpsBotRequest | null = null;
    try { request = parsePerpsBotRequest(readBoundedPerpsJson(file, 2_048)); } catch { /* invalid requests are refused */ }
    if (request && perpsBotRequestKey(request) !== key) request = null;
    return { key, file, request };
  }).sort(compareRequests).slice(0, 16);
  for (const { key, file, request } of pending) {
    if (!mayWrite()) return;
    const resultFile = path.join(dir, `${key}.result.json`), prior = readReceipt(resultFile, key);
    // An obstructed/corrupt result is unknown, not permission to retry or erase.
    if (prior === "unread") continue;
    let line = "The Perps request is invalid or expired. Nothing was changed; check the desk and ask again if needed.";
    if (request && !prior) line = await apply(request);
    if (!mayWrite()) return;
    if (typeof line !== "string" || line.length > 2_000) throw new Error("The Perps answer is invalid.");
    if (!prior) writeFileAtomicSync(resultFile, JSON.stringify({ key, line, at: Date.now(), kind: request?.kind ?? "close" }), 0o600, { durable: true, followSymlinks: false });
    unlinkSync(file);
    fsyncDirSync(dir);
  }
  // Only expired inputs may lose receipts. Kills have no expiry, so their
  // durable replay fences are retained even across long outages and restarts.
  for (const name of names.filter(name => RESULT_NAME.test(name))) {
    if (!mayWrite()) return;
    const file = path.join(dir, name), receipt = readReceipt(file, name.slice(0, -12));
    if (receipt && receipt !== "unread" && receipt.kind !== "kill" && Date.now() - receipt.at > 86_400_000) {
      unlinkSync(file);
      fsyncDirSync(dir);
    }
  }
}
