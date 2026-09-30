/** Standalone public-feed recorder. Never imported by the production feed loop. */
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, openSync, readFileSync } from "node:fs";
import { parseLighterFeed } from "./feed-reader";
import type { PerpsReplayFrame } from "./backtest";
import { brainFingerprint } from "./brain";

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
/** JSON object key order does not change the identity; array order does. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const out = JSON.stringify(value);
    if (out === undefined) throw new Error("non-JSON replay value");
    return out;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}
/** The same identity the live decision journal records for its exact source frame. */
export const replayFrameHash = (frame: PerpsReplayFrame): string => brainFingerprint(frame);

export interface RecordedFeedSample {
  v: 1;
  kind: "frame" | "gap";
  receivedAtMs: number;
  previousReceivedAtMs: number | null;
  elapsedMs: number | null;
  /** Original bytes, including observation/spec timestamps, retained unchanged. */
  rawFeed: string | null;
  rawSha256: string | null;
  frameSha256: string | null;
  observedAtMs: number | null;
  reason: "unread-input" | "invalid-feed" | null;
}

export function captureFeedSample(rawFeed: string | null, receivedAtMs: number, previousReceivedAtMs: number | null): RecordedFeedSample {
  if (!Number.isSafeInteger(receivedAtMs) || receivedAtMs < 0 || (previousReceivedAtMs !== null &&
      (!Number.isSafeInteger(previousReceivedAtMs) || previousReceivedAtMs < 0 || previousReceivedAtMs >= receivedAtMs)))
    throw new Error("capture clocks must strictly increase");
  let feed: unknown = null;
  try { feed = rawFeed === null ? null : JSON.parse(rawFeed); } catch { /* retained as a gap */ }
  const future = feed && typeof feed === "object" && "observedAt" in feed && typeof feed.observedAt === "number" && feed.observedAt > receivedAtMs;
  const parsed = future ? null : parseLighterFeed(feed, receivedAtMs);
  return {
    v: 1, kind: parsed ? "frame" : "gap", receivedAtMs, previousReceivedAtMs,
    elapsedMs: previousReceivedAtMs === null ? null : receivedAtMs - previousReceivedAtMs,
    rawFeed, rawSha256: rawFeed === null ? null : sha256(rawFeed),
    frameSha256: parsed ? replayFrameHash({ atMs: receivedAtMs, feed }) : null,
    observedAtMs: parsed ? (feed as { observedAt: number }).observedAt : null,
    reason: parsed ? null : rawFeed === null ? "unread-input" : "invalid-feed",
  };
}

/** Gaps remain invalid frames so replay stops instead of silently skipping them. */
export function framesFromRecording(samples: readonly RecordedFeedSample[]): PerpsReplayFrame[] {
  let previous: number | null = null;
  return samples.map(sample => {
    const verified = captureFeedSample(sample.rawFeed, sample.receivedAtMs, previous);
    if (canonicalJson(verified) !== canonicalJson(sample)) throw new Error("recording stamp, hash or gap chain mismatch");
    previous = sample.receivedAtMs;
    return { atMs: sample.receivedAtMs, feed: sample.kind === "frame" ? JSON.parse(sample.rawFeed!) : null };
  });
}

export interface FeedRecordingHeader {
  v: 1;
  kind: "header";
  source: "existing-public-lighter-feed";
  startedAtMs: number;
  intervalMs: number;
}

export function parseFeedRecording(text: string): { header: FeedRecordingHeader; frames: PerpsReplayFrame[] } {
  const rows = text.trim().split("\n").map(line => JSON.parse(line) as unknown);
  const h = rows.shift() as FeedRecordingHeader | undefined;
  if (!h || h.v !== 1 || h.kind !== "header" || h.source !== "existing-public-lighter-feed" ||
      !Number.isSafeInteger(h.startedAtMs) || h.startedAtMs < 0 || !Number.isSafeInteger(h.intervalMs) || h.intervalMs < 1)
    throw new Error("invalid recording header");
  const frames = framesFromRecording(rows as RecordedFeedSample[]);
  if (!frames.length || frames[0]!.atMs < h.startedAtMs) throw new Error("empty recording or invalid start clock");
  return { header: h, frames };
}

/** Finite, explicitly invoked recording. Never creates a connection to a venue. */
export async function recordPublicFeed(args: { inputPath: string; outputPath: string; durationMs: number; intervalMs?: number; signal?: AbortSignal }) {
  const intervalMs = args.intervalMs ?? 2_000;
  if (!Number.isSafeInteger(args.durationMs) || args.durationMs < 1 || args.durationMs > 86_400_000 ||
      !Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > 60_000)
    throw new Error("duration must be 1 ms–24 h; interval must be 100–60000 ms");
  // Exclusive creation protects the live feed and existing evidence from overwrite.
  const fd = openSync(args.outputPath, "wx", 0o600);
  const startedAtMs = Date.now();
  let previous: number | null = null, count = 0;
  try {
    const header: FeedRecordingHeader = { v: 1, kind: "header", source: "existing-public-lighter-feed", startedAtMs, intervalMs };
    appendFileSync(fd, `${JSON.stringify(header)}\n`);
    do {
      if (args.signal?.aborted) break;
      let raw: string | null = null;
      try { raw = readFileSync(args.inputPath, "utf8"); } catch { /* an unread sample is evidence too */ }
      const now = Date.now();
      if (previous !== null && now <= previous) throw new Error("system clock did not advance; recording stopped");
      const sample = captureFeedSample(raw, now, previous);
      appendFileSync(fd, `${JSON.stringify(sample)}\n`);
      previous = now;
      count++;
      const remaining = startedAtMs + args.durationMs - Date.now();
      if (remaining <= 0) break;
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); args.signal?.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, Math.min(intervalMs, remaining));
        args.signal?.addEventListener("abort", done, { once: true });
      });
    } while (Date.now() < startedAtMs + args.durationMs);
  } finally { closeSync(fd); }
  return { samples: count, outputPath: args.outputPath };
}
