/** Bounded local capture of the existing fleet's public feed. This module has
 * no network, grant, environment loader, private ledger or signing imports. */
import { constants, openSync, closeSync, fstatSync, readSync, mkdirSync, writeSync, fsyncSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { LIGHTER_FEED_FILE, parseLighterFeed } from "./feed-reader";
import type { PerpsReplayFrame } from "./backtest";

export const CAPTURE_LIMITS = { maxFrameBytes: 1_048_576, maxRecordingBytes: 67_108_864, maxSamples: 8_640, maxDurationMs: 86_400_000 } as const;
export const CAPTURE_REPLAY_CONFIG = { initialCashUsdg: 100, perTradeUsdg: 25, dailyUsdg: 100, maxOpsPerDay: 48, energyOpensPerDay: 2, maxDrawdownBps: 500 } as const;
const fields = (value: unknown, allowed: readonly string[]): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));
const SPEC = ["marketId", "sizeDecimals", "priceDecimals", "minBaseAmount", "minQuoteMicro", "minImfBp", "defaultImfBp", "mmfBp", "closeoutBp", "liquidationFeeBp", "status"];
const MARKET = ["observedAt", "priceSource", "mark", "index", "fundingRatePctPerHour", "lastFundingRatePctPerHour", "lastFundingAt", "status", "spec", "specObservedAt", "takerFeePpm", "makerFeePpm", "bids", "asks", "bookObservedAt", "bookSource", "closed4h", "candlesObservedAt", "fundings1h", "fundingsObservedAt"];

/** Reject unknown fields, including nested fields, rather than persisting an
 * accidental grant/key or making malformed data look valid by dropping it. */
export function publicFeedOnly(value: unknown, atMs: number): boolean {
  if (!fields(value, ["v", "observedAt", "markets"]) || typeof value.observedAt !== "number" || value.observedAt > atMs || !value.markets || typeof value.markets !== "object" || Array.isArray(value.markets)) return false;
  for (const market of Object.values(value.markets)) {
    if (!fields(market, MARKET) || !fields(market.spec, SPEC)) return false;
    if (market.closed4h !== undefined && (!Array.isArray(market.closed4h) || market.closed4h.some(candle => !fields(candle, ["t", "o", "h", "l", "c"])))) return false;
    if (market.fundings1h !== undefined && (!Array.isArray(market.fundings1h) || market.fundings1h.some(funding => !fields(funding, ["t", "rate", "direction"])))) return false;
  }
  return parseLighterFeed(value, atMs) !== null;
}

/** Open one regular file without following a final symlink; bound the actual
 * read even if it grows between stat and read. Feed publication is atomic. */
export function readPublicFeedFrame(source: string, atMs: number): PerpsReplayFrame {
  if (path.basename(source) !== LIGHTER_FEED_FILE) throw new Error("Source must be the existing lighter-feed.json public feed.");
  let fd: number | undefined;
  try {
    fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > CAPTURE_LIMITS.maxFrameBytes) return { atMs, feed: null };
    const bytes = Buffer.alloc(CAPTURE_LIMITS.maxFrameBytes + 1);
    let size = 0;
    while (size < bytes.length) { const n = readSync(fd, bytes, size, bytes.length - size, null); if (!n) break; size += n; }
    if (size > CAPTURE_LIMITS.maxFrameBytes) return { atMs, feed: null };
    const feed: unknown = JSON.parse(bytes.subarray(0, size).toString("utf8"));
    return { atMs, feed: publicFeedOnly(feed, atMs) ? feed : null };
  } catch { return { atMs, feed: null }; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export interface CaptureOptions { source: string; output: string; samples: number; intervalMs: number; optIn: string | undefined; signal?: AbortSignal }
export interface CaptureEdges { now: () => number; wait: (ms: number, signal?: AbortSignal) => Promise<void> }
const edges: CaptureEdges = { now: Date.now, wait: (ms, signal) => new Promise(resolve => {
  const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve(); };
  const timer = setTimeout(finish, ms); signal?.addEventListener("abort", finish, { once: true }); if (signal?.aborted) finish();
}) };
export async function capturePublicFeed(options: CaptureOptions, io: CaptureEdges = edges) {
  if (options.optIn !== "1") throw new Error("Set MERRYMEN_PERPS_CAPTURE_PUBLIC_FEED=1 to record the existing public feed.");
  if (path.basename(options.source) !== LIGHTER_FEED_FILE) throw new Error("Source must be the existing lighter-feed.json public feed.");
  if (!Number.isSafeInteger(options.samples) || options.samples < 1 || options.samples > CAPTURE_LIMITS.maxSamples
      || !Number.isSafeInteger(options.intervalMs) || options.intervalMs < 1_000 || options.intervalMs > 60_000
      || (options.samples - 1) * options.intervalMs > CAPTURE_LIMITS.maxDurationMs) throw new Error("Capture exceeds the sample, interval or duration limit.");
  // A fresh directory is mandatory: no overwrite, append-to-old-run or resume.
  mkdirSync(options.output, { mode: 0o700 });
  const fd = openSync(path.join(options.output, "frames.ndjson"), "wx", 0o600);
  const frames: PerpsReplayFrame[] = [];
  let bytes = 0, unreadFrames = 0, reason: "finished" | "interrupted" | "byte-limit" | "clock-invalid" = "finished";
  const startedAtMs = io.now();
  try {
    for (let i = 0; i < options.samples; i++) {
      if (options.signal?.aborted) { reason = "interrupted"; break; }
      const atMs = io.now();
      if (!Number.isSafeInteger(atMs) || atMs < 0 || atMs <= (frames.at(-1)?.atMs ?? -1)) { reason = "clock-invalid"; break; }
      const frame = readPublicFeedFrame(options.source, atMs);
      const line = `${JSON.stringify(frame)}\n`;
      bytes += Buffer.byteLength(line);
      if (bytes > CAPTURE_LIMITS.maxRecordingBytes) { reason = "byte-limit"; break; }
      const chunk = Buffer.from(line);
      for (let offset = 0; offset < chunk.length;) {
        const written = writeSync(fd, chunk, offset, chunk.length - offset);
        if (written <= 0) throw new Error("Public feed capture could not write a complete frame.");
        offset += written;
      }
      fsyncSync(fd);
      frames.push(frame); if (frame.feed === null) unreadFrames++;
      if (i + 1 < options.samples) await io.wait(options.intervalMs, options.signal);
    }
  } finally { closeSync(fd); }
  const capture = { v: 1, source: "existing-public-lighter-feed", startedAtMs, endedAtMs: io.now(), requestedSamples: options.samples, intervalMs: options.intervalMs, frames: frames.length, unreadFrames, complete: reason === "finished" && frames.length === options.samples, reason };
  // A capture gap stays null in replay input. It must stop replay as unread,
  // never disappear and make a continuous performance story out of an outage.
  const output = { config: CAPTURE_REPLAY_CONFIG, capture, frames };
  const temp = path.join(options.output, ".replay.json.tmp");
  writeFileSync(temp, `${JSON.stringify(output)}\n`, { flag: "wx", mode: 0o600 });
  renameSync(temp, path.join(options.output, "replay.json"));
  writeFileSync(path.join(options.output, "capture.json"), `${JSON.stringify(capture, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return capture;
}
