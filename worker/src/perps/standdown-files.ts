/**
 * THE SELF-HOSTED STAND-DOWN, AS FILES IN THE HOME (docs/perps.md rule 13;
 * review amendments kill-standdown-not-reachable-hosted (6),
 * hosted-kill-cannot-stand-down (d)).
 *
 * Self-hosted, the CLI, the web and Telegram share one MERRYMEN_HOME with the
 * worker, and the worker is the only process holding the Lighter key it needs.
 * So a kill does not stand the perps down itself; it asks:
 *
 *   kill path   writeStanddownRequest   — BEFORE the grant is archived, so the
 *                                         worker still holds the key (and
 *                                         knows the account) when it reads it
 *   worker      readPendingStanddownRequests → runStanddown →
 *               writeStanddownProgress (as it goes) → writeStanddownResult
 *   CLI         waitForStanddownResult  — up to 120 s, printing progress, then
 *                                         the custody sentence built from it
 *
 * ONE FILE PER REQUEST (`standdown-request-<nonce>.json`), never rewritten —
 * the kill-request.ts discipline. Two kills are two files; neither can be
 * lost inside the other's read-modify-write. A request is PENDING while no
 * result names its nonce: the result is the claim, written once, by the one
 * process that ran it. (Re-running a request whose result never landed, after
 * a crash, is safe: a stand-down is exits only — reduce-only closes that
 * cannot flip, cancels on flat markets, and money that can only go home.)
 *
 * ATOMIC, SO NOTHING HALF-WRITTEN IS EVER READ. Every file is written under a
 * dot-prefixed temporary name that no reader lists, fsync'd, and then moved
 * into place in one step: a request by link() (which refuses to replace an
 * existing request, so a nonce is used once), a result or progress file by
 * rename(). A crash leaves a whole file or none. Readers are strict — exact
 * keys, exact types, bounded sizes, a nonce that matches the file name — and a
 * file that fails is ignored, never half-believed: this writer cannot produce
 * one, so it is not a request anyone made.
 *
 * NO KEY MATERIAL, EVER (rule 5). Nothing here takes a key: the request is a
 * reason, a time and a nonce, and the result is StanddownResult, which has no
 * field for one. The free text that does travel — failed steps, market names,
 * progress lines — may carry an executor's error message, so every string is
 * redacted by SHAPE (any run of 64 or more hex digits, 0x or bare: the 80-hex
 * Lighter keys, 64-hex session keys; tx hashes go too, which costs nothing)
 * on the way out AND on the way back in.
 *
 * Self-hosted only. Hosted, the kill writes a sealed `perp_standdown` row and
 * the orchestrator runs a stand-down-only child; that path is not this one.
 */

import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, linkSync, lstatSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { isPerpKey, perpMarketByKey } from "../../../packages/core/src/perps";
import {
  isStanddownReason,
  type StanddownClosed,
  type StanddownOutcome,
  type StanddownReason,
  type StanddownResidual,
  type StanddownResult,
  type StanddownVenue,
} from "./standdown";

export const STANDDOWN_FILE_VERSION = 1;
export const STANDDOWN_REQUEST_PREFIX = "standdown-request-";
export const STANDDOWN_RESULT_PREFIX = "standdown-result-";
export const STANDDOWN_PROGRESS_PREFIX = "standdown-progress-";
const SUFFIX = ".json";

/** The CLI's wait (rule 13: "the CLI waits up to 120 s and prints it"). */
export const STANDDOWN_CLI_WAIT_MS = 120_000;

/** Largest file each reader will open: a request is ~150 bytes, a full result a few KB. */
const MAX_REQUEST_BYTES = 4_096;
const MAX_RESULT_BYTES = 256_000;
const MAX_PROGRESS_BYTES = 256_000;
/** What a result or progress file may carry. More is refused on read and cut on write. */
const MAX_ENTRIES = 128;
const MAX_TEXT = 600;
const MAX_PROGRESS_LINES = 200;

// ── nonces: the one place a caller's string becomes a path ──────────────────

/**
 * A nonce, as a file-name part. THIS IS WHERE A STRING BECOMES A PATH, so it
 * is refused rather than repaired: no dot, slash or leading dash can pass, and
 * a nonce we had to fix is one whose owner is waiting on another file.
 */
const NONCE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;

export function isStanddownNonce(x: unknown): x is string {
  return typeof x === "string" && NONCE_RE.test(x);
}

/** A fresh nonce for a request (a UUID: 36 characters of the allowed set). */
export function newStanddownNonce(): string {
  return randomUUID();
}

function fileFor(home: string, prefix: string, nonce: string): string {
  if (!isStanddownNonce(nonce)) throw new TypeError(`refusing a stand-down file for a nonce that is not one: ${JSON.stringify(String(nonce)).slice(0, 80)}`);
  return path.join(home, `${prefix}${nonce}${SUFFIX}`);
}

export function standdownRequestFile(home: string, nonce: string): string {
  return fileFor(home, STANDDOWN_REQUEST_PREFIX, nonce);
}
export function standdownResultFile(home: string, nonce: string): string {
  return fileFor(home, STANDDOWN_RESULT_PREFIX, nonce);
}
export function standdownProgressFile(home: string, nonce: string): string {
  return fileFor(home, STANDDOWN_PROGRESS_PREFIX, nonce);
}

// ── redaction ───────────────────────────────────────────────────────────────

/** Any run of 64+ hex digits, with or without 0x — every private key shape this system holds. */
const KEY_SHAPE_RE = /(?:0x)?[0-9a-fA-F]{64,}/g;

/** Key-shaped runs replaced, control characters flattened, length bounded. */
export function redactKeyMaterial(s: string): string {
  // eslint-disable-next-line no-control-regex
  const flat = s.replace(KEY_SHAPE_RE, "[redacted]").replace(/[\u0000-\u001f\u007f]+/g, " ");
  return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT - 3)}...` : flat;
}

/** A market name as a result may carry it: a PerpKey or a venue symbol, nothing else. */
const MARKET_NAME_RE = /^[A-Za-z0-9._?-]{1,32}$/;
function safeMarketName(s: string): string {
  const clean = redactKeyMaterial(s).replace(/[^A-Za-z0-9._-]/g, "?").slice(0, 32);
  return clean.length > 0 ? clean : "?";
}

// ── atomic writes ───────────────────────────────────────────────────────────

/**
 * Write `body` to `home/name` so that a reader sees the whole file or none of
 * it. The home must already exist: creating it here would write a request
 * into a directory no worker reads, and the CLI would wait on it for nothing.
 */
function writeAtomic(home: string, name: string, body: string, noClobber: boolean): void {
  const final = path.join(home, name);
  // Dot-prefixed and .tmp-suffixed: no reader lists it. `wx` refuses to open
  // anything already there — including a planted symlink.
  const tmp = path.join(home, `.${name}.${randomUUID()}.tmp`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeFileSync(fd, body, "utf8");
    fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    safeUnlink(tmp);
    throw e;
  }
  closeSync(fd);
  try {
    if (noClobber) {
      try {
        // link() is the atomic "create only if absent": EEXIST if the name is taken.
        linkSync(tmp, final);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "EEXIST") throw new Error(`${name} already exists; a stand-down nonce is used once`);
        // A filesystem without hard links: check, then rename. The window is a
        // second writer choosing the same random nonce in the same instant.
        if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP" && code !== "ENOSYS") throw e;
        if (exists(final)) throw new Error(`${name} already exists; a stand-down nonce is used once`);
        renameSync(tmp, final);
      }
    } else {
      renameSync(tmp, final);
    }
  } finally {
    safeUnlink(tmp);
  }
  fsyncDir(home);
}

function safeUnlink(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // already gone (renamed into place, or never made)
  }
}

function exists(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/** Make the rename itself durable. Best effort: not every platform lets a directory be fsync'd. */
function fsyncDir(dir: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    // the file is whole either way; only a power cut could lose the name
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // nothing to do
      }
    }
  }
}

/** A regular file's text, or null: missing, a symlink, a directory, too big or unreadable. */
function readSmall(file: string, maxBytes: number): string | null {
  try {
    const st = lstatSync(file);
    if (!st.isFile() || st.size > maxBytes) return null;
    const text = readFileSync(file, "utf8");
    return text.length > maxBytes ? null : text;
  } catch {
    return null;
  }
}

function readJson(file: string, maxBytes: number): unknown {
  const text = readSmall(file, maxBytes);
  if (text === null) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

// ── strict reading helpers ──────────────────────────────────────────────────

class Bad extends Error {}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** Exactly these keys (optional ones may be absent), and nothing else. */
function record(x: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!isRecord(x)) throw new Bad("not an object");
  const allowed = new Set([...required, ...optional]);
  for (const k of Object.keys(x)) if (!allowed.has(k)) throw new Bad(`unexpected field ${k}`);
  for (const k of required) if (!(k in x)) throw new Bad(`missing field ${k}`);
  return x;
}

function int(x: unknown, min: number, max: number): number {
  if (typeof x !== "number" || !Number.isSafeInteger(x) || x < min || x > max) throw new Bad("not an integer in range");
  return x;
}

/** A clock reading in ms: finite, not negative, and not absurd. */
function ms(x: unknown): number {
  if (typeof x !== "number" || !Number.isFinite(x) || x < 0 || x > 1e14) throw new Bad("not a ms time");
  return x;
}

const BIG_RE = /^-?(?:0|[1-9]\d{0,39})$/;
function big(x: unknown, min?: bigint): bigint {
  if (typeof x !== "string" || !BIG_RE.test(x)) throw new Bad("not a decimal integer");
  const v = BigInt(x);
  if (min !== undefined && v < min) throw new Bad("below its minimum");
  return v;
}

function bool(x: unknown): boolean {
  if (typeof x !== "boolean") throw new Bad("not a boolean");
  return x;
}

function side(x: unknown): "long" | "short" {
  if (x !== "long" && x !== "short") throw new Bad("not a side");
  return x;
}

function text(x: unknown): string {
  if (typeof x !== "string" || x.length > MAX_TEXT) throw new Bad("not a bounded string");
  return redactKeyMaterial(x);
}

function list<T>(x: unknown, each: (v: unknown) => T): T[] {
  if (!Array.isArray(x) || x.length > MAX_ENTRIES) throw new Bad("not a bounded list");
  return x.map(each);
}

// ── requests ────────────────────────────────────────────────────────────────

export interface StanddownRequest {
  reason: StanddownReason;
  /** ms, on the requester's clock. */
  requestedAt: number;
  nonce: string;
}

/**
 * Leave a NEW stand-down request. Throws when the request is not one (a bad
 * reason, time or nonce), when the nonce was already used, or when the write
 * fails — and a kill path that gets a throw must not archive the grant as if
 * the worker had been asked.
 */
export function writeStanddownRequest(home: string, req: StanddownRequest): void {
  if (!isStanddownReason(req.reason)) throw new TypeError(`unknown stand-down reason ${String(req.reason)}`);
  if (typeof req.requestedAt !== "number" || !Number.isSafeInteger(req.requestedAt) || req.requestedAt <= 0) {
    throw new TypeError("requestedAt must be a positive integer ms time");
  }
  const file = standdownRequestFile(home, req.nonce);
  const body = { v: STANDDOWN_FILE_VERSION, kind: "standdown-request", nonce: req.nonce, reason: req.reason, requestedAt: req.requestedAt };
  writeAtomic(home, path.basename(file), JSON.stringify(body), true);
}

function parseRequest(raw: unknown, nonce: string): StanddownRequest | null {
  try {
    const r = record(raw, ["v", "kind", "nonce", "reason", "requestedAt"]);
    if (r.v !== STANDDOWN_FILE_VERSION || r.kind !== "standdown-request") throw new Bad("not a v1 request");
    if (r.nonce !== nonce) throw new Bad("the nonce inside is not the one in its name");
    if (!isStanddownReason(r.reason)) throw new Bad("unknown reason");
    const requestedAt = int(r.requestedAt, 1, 1e14);
    return { reason: r.reason, requestedAt, nonce };
  } catch {
    return null;
  }
}

/**
 * Every request in this home whose result has not been written, oldest
 * first. A file that does not parse is skipped and reported to `onIgnored`
 * (the worker logs it): the writer above cannot leave one, so it is not a
 * request anyone made. A home that cannot be listed has no requests.
 */
export function readPendingStanddownRequests(home: string, opts: { onIgnored?: (file: string, why: string) => void } = {}): StanddownRequest[] {
  let names: string[];
  try {
    names = readdirSync(home);
  } catch {
    return [];
  }
  const ignored = (file: string, why: string) => {
    try {
      opts.onIgnored?.(file, why);
    } catch {
      // a logger that throws must not hide the other requests
    }
  };
  const out: StanddownRequest[] = [];
  for (const name of names) {
    if (!name.startsWith(STANDDOWN_REQUEST_PREFIX) || !name.endsWith(SUFFIX)) continue;
    const nonce = name.slice(STANDDOWN_REQUEST_PREFIX.length, -SUFFIX.length);
    if (!isStanddownNonce(nonce)) {
      ignored(name, "its nonce is not a nonce");
      continue;
    }
    const req = parseRequest(readJson(path.join(home, name), MAX_REQUEST_BYTES), nonce);
    if (req === null) {
      ignored(name, "it is not a whole, valid stand-down request");
      continue;
    }
    // THE RESULT IS THE CLAIM. Any file under the result's name counts, even
    // one that does not parse: re-running a request forever because its
    // result was mangled is worse than reporting nothing.
    if (exists(standdownResultFile(home, nonce))) continue;
    out.push(req);
  }
  return out.sort((a, b) => a.requestedAt - b.requestedAt || (a.nonce < b.nonce ? -1 : a.nonce > b.nonce ? 1 : 0));
}

// ── results ─────────────────────────────────────────────────────────────────

/** The result as JSON: bigints as decimal strings, every free string redacted and bounded. */
export function serializeStanddownResult(nonce: string, r: StanddownResult): string {
  if (!isStanddownNonce(nonce)) throw new TypeError("serializeStanddownResult: not a nonce");
  const cut = <T>(xs: readonly T[]) => xs.slice(0, MAX_ENTRIES);
  const body = {
    v: STANDDOWN_FILE_VERSION,
    kind: "standdown-result",
    nonce,
    result: {
      reason: r.reason,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      deadlineMs: r.deadlineMs,
      outcome: r.outcome,
      closed: cut(r.closed).map((c) => ({
        market: c.market,
        marketId: c.marketId,
        side: c.side,
        baseAmount: c.baseAmount.toString(),
        filledBase: c.filledBase === null ? null : c.filledBase.toString(),
        ...(c.realizedMicro !== undefined ? { realizedMicro: c.realizedMicro.toString() } : {}),
        attempts: c.attempts,
        sizeDecimals: c.sizeDecimals,
      })),
      residual: cut(r.residual).map((x) => ({
        market: safeMarketName(x.market),
        marketId: x.marketId,
        side: x.side,
        baseAmount: x.baseAmount.toString(),
        stopResting: x.stopResting,
        attempts: x.attempts,
        sizeDecimals: x.sizeDecimals,
      })),
      ordersLeft: r.ordersLeft,
      withdrawRequestedMicro: r.withdrawRequestedMicro === null ? null : r.withdrawRequestedMicro.toString(),
      failedSteps: cut(r.failedSteps).map(redactKeyMaterial),
      ingested: r.ingested,
      venue:
        r.venue === null
          ? null
          : {
              readAt: r.venue.readAt,
              final: r.venue.final,
              collateralMicro: r.venue.collateralMicro.toString(),
              isolatedMarginMicro: r.venue.isolatedMarginMicro.toString(),
              poolShareCount: r.venue.poolShareCount,
              spotBalanceCount: r.venue.spotBalanceCount,
            },
    },
  };
  return JSON.stringify(body, null, 2);
}

const OUTCOMES: ReadonlySet<string> = new Set<StanddownOutcome>(["done", "residual", "unreachable"]);

function parseClosed(x: unknown): StanddownClosed {
  const c = record(x, ["market", "marketId", "side", "baseAmount", "filledBase", "attempts", "sizeDecimals"], ["realizedMicro"]);
  if (!isPerpKey(c.market)) throw new Bad("closed market not in the table");
  const marketId = int(c.marketId, 0, 32_767);
  if (perpMarketByKey(c.market)?.marketId !== marketId) throw new Bad("closed market id does not match its key");
  const out: StanddownClosed = {
    market: c.market,
    marketId,
    side: side(c.side),
    baseAmount: big(c.baseAmount, 1n),
    filledBase: c.filledBase === null ? null : big(c.filledBase, 0n),
    attempts: int(c.attempts, 0, 3),
    sizeDecimals: c.sizeDecimals === null ? null : int(c.sizeDecimals, 0, 18),
  };
  if ("realizedMicro" in c) out.realizedMicro = big(c.realizedMicro);
  return out;
}

function parseResidual(x: unknown): StanddownResidual {
  const r = record(x, ["market", "marketId", "side", "baseAmount", "stopResting", "attempts", "sizeDecimals"]);
  if (typeof r.market !== "string" || !MARKET_NAME_RE.test(r.market)) throw new Bad("residual market name");
  return {
    market: r.market,
    marketId: int(r.marketId, 0, 32_767),
    side: side(r.side),
    baseAmount: big(r.baseAmount, 1n),
    stopResting: bool(r.stopResting),
    attempts: int(r.attempts, 0, 3),
    sizeDecimals: r.sizeDecimals === null ? null : int(r.sizeDecimals, 0, 18),
  };
}

function parseVenue(x: unknown): StanddownVenue | null {
  if (x === null) return null;
  const v = record(x, ["readAt", "final", "collateralMicro", "isolatedMarginMicro", "poolShareCount", "spotBalanceCount"]);
  return {
    readAt: ms(v.readAt),
    final: bool(v.final),
    collateralMicro: big(v.collateralMicro),
    isolatedMarginMicro: big(v.isolatedMarginMicro, 0n),
    poolShareCount: int(v.poolShareCount, 0, 1e9),
    spotBalanceCount: int(v.spotBalanceCount, 0, 1e9),
  };
}

/**
 * A result file's JSON → StanddownResult, or null. Strict: every field typed
 * and bounded, the nonce the one asked for, and the outcome consistent with
 * the read behind it — a result claiming `done` or `residual` must carry a
 * FINAL venue read, because that claim is what the owner's custody sentence
 * is built from.
 */
export function parseStanddownResult(raw: unknown, nonce: string): StanddownResult | null {
  try {
    const top = record(raw, ["v", "kind", "nonce", "result"]);
    if (top.v !== STANDDOWN_FILE_VERSION || top.kind !== "standdown-result") throw new Bad("not a v1 result");
    if (!isStanddownNonce(nonce) || top.nonce !== nonce) throw new Bad("nonce");
    const r = record(top.result, [
      "reason",
      "startedAt",
      "finishedAt",
      "deadlineMs",
      "outcome",
      "closed",
      "residual",
      "ordersLeft",
      "withdrawRequestedMicro",
      "failedSteps",
      "ingested",
      "venue",
    ]);
    if (!isStanddownReason(r.reason)) throw new Bad("reason");
    if (typeof r.outcome !== "string" || !OUTCOMES.has(r.outcome)) throw new Bad("outcome");
    const outcome = r.outcome as StanddownOutcome;
    const venue = parseVenue(r.venue);
    const ordersLeft = r.ordersLeft === null ? null : int(r.ordersLeft, 0, 1e9);
    if (outcome !== "unreachable" && (venue === null || !venue.final || ordersLeft === null)) throw new Bad("an outcome with no final read behind it");
    const startedAt = ms(r.startedAt);
    const finishedAt = ms(r.finishedAt);
    if (finishedAt < startedAt) throw new Bad("finished before it started");
    return {
      reason: r.reason,
      startedAt,
      finishedAt,
      deadlineMs: ms(r.deadlineMs),
      outcome,
      closed: list(r.closed, parseClosed),
      residual: list(r.residual, parseResidual),
      ordersLeft,
      withdrawRequestedMicro: r.withdrawRequestedMicro === null ? null : big(r.withdrawRequestedMicro, 1n),
      failedSteps: list(r.failedSteps, text),
      ingested: bool(r.ingested),
      venue,
    };
  } catch {
    return null;
  }
}

/** Write the stand-down's result — the claim that ends its request's pending life. Replaces a result under the same nonce. */
export function writeStanddownResult(home: string, nonce: string, result: StanddownResult): void {
  const file = standdownResultFile(home, nonce);
  writeAtomic(home, path.basename(file), serializeStanddownResult(nonce, result), false);
}

/** The result for `nonce`, or null: not written yet, or not a whole, valid result. */
export function readStanddownResult(home: string, nonce: string): StanddownResult | null {
  const raw = readJson(standdownResultFile(home, nonce), MAX_RESULT_BYTES);
  return raw === undefined ? null : parseStanddownResult(raw, nonce);
}

// ── progress ────────────────────────────────────────────────────────────────

/**
 * The steps so far, for the waiting CLI. `lines` is every line the run has
 * produced; the file keeps the last MAX_PROGRESS_LINES with the running total,
 * so a reader can tell which lines are new even after the oldest are cut.
 */
export function writeStanddownProgress(home: string, nonce: string, lines: readonly string[]): void {
  const file = standdownProgressFile(home, nonce);
  const kept = lines.slice(-MAX_PROGRESS_LINES).map(redactKeyMaterial);
  const body = { v: STANDDOWN_FILE_VERSION, kind: "standdown-progress", nonce, total: lines.length, lines: kept };
  writeAtomic(home, path.basename(file), JSON.stringify(body), false);
}

/** The progress file: the running total and the lines kept, or null. */
export function readStanddownProgress(home: string, nonce: string): { total: number; lines: string[] } | null {
  try {
    const p = record(readJson(standdownProgressFile(home, nonce), MAX_PROGRESS_BYTES), ["v", "kind", "nonce", "total", "lines"]);
    if (p.v !== STANDDOWN_FILE_VERSION || p.kind !== "standdown-progress" || p.nonce !== nonce) return null;
    const total = int(p.total, 0, 1e9);
    if (!Array.isArray(p.lines) || p.lines.length > MAX_PROGRESS_LINES || p.lines.length > total) return null;
    return { total, lines: p.lines.map(text) };
  } catch {
    return null;
  }
}

export interface StanddownWaitProgress {
  elapsedMs: number;
  /** Progress lines not reported before. */
  lines: string[];
}

/**
 * Wait for the result of `nonce`, reporting progress as it comes: the CLI's
 * half of `merrymen kill`. Resolves to the result, or null when `timeoutMs`
 * passes first — the CLI then says the stand-down has not reported and points
 * to `merrymen recover`, never that it is done.
 */
export async function waitForStanddownResult(
  home: string,
  nonce: string,
  timeoutMs: number,
  onProgress?: (p: StanddownWaitProgress) => void,
  opts: { pollMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<StanddownResult | null> {
  if (!isStanddownNonce(nonce)) throw new TypeError("waitForStanddownResult: not a nonce");
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((d: number) => new Promise<void>((r) => setTimeout(r, d)));
  const pollMs = typeof opts.pollMs === "number" && opts.pollMs > 0 ? opts.pollMs : 500;
  const limit = typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : STANDDOWN_CLI_WAIT_MS;
  const start = now();
  let seen = 0;
  for (;;) {
    const result = readStanddownResult(home, nonce);
    const progress = readStanddownProgress(home, nonce);
    let fresh: string[] = [];
    if (progress !== null && progress.total > seen) {
      const firstKept = progress.total - progress.lines.length;
      fresh = progress.lines.slice(Math.max(0, seen - firstKept));
      seen = progress.total;
    }
    try {
      onProgress?.({ elapsedMs: now() - start, lines: fresh });
    } catch {
      // a printer that throws must not end the wait
    }
    if (result !== null) return result;
    const left = start + limit - now();
    if (left <= 0) return null;
    await sleep(Math.min(pollMs, left));
  }
}

/**
 * Remove a finished stand-down's files. The REQUEST GOES FIRST: a result
 * removed while its request stayed would make the request pending again, and
 * the worker would stand the account down a second time for one kill.
 */
export function clearStanddownFiles(home: string, nonce: string): void {
  for (const file of [standdownRequestFile(home, nonce), standdownProgressFile(home, nonce), standdownResultFile(home, nonce)]) {
    try {
      unlinkSync(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
}
