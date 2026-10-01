/** A recorded response may veto the causal trend candidate, never invent an order. */
import { brainFingerprint, buildPerpsBrainRequest, validatePerpsBrainResponse, brainMarketStillQualified, PERPS_BRAIN_MAX_DRIFT_BPS,
  type PerpsBrainRequest, type PerpsBrainResponse } from "./brain";
import type { PerpOpenDraft } from "./drafts";
import type { PerpsReplayFrame, PerpsReplayProducer } from "./backtest";
import { canonicalJson, replayFrameHash } from "./replay-recorder";
import type { PerpsNewsEvidence } from "./news";
import { perpsNewsAvailable } from "./news";

export interface RecordedPerpsBrainDecision {
  sourceFrameSha256: string;
  /** Exact per-symbol news observation recorded before the model call. */
  sourceNews: PerpsNewsEvidence;
  sourceNewsSha256: string;
  /** Supplied by the live decision journal; merged into a sampled timeline by the CLI. */
  sourceFrame?: PerpsReplayFrame;
  /** Exact runtime context fingerprint used by the request builder. */
  context: string;
  request: PerpsBrainRequest;
  response: PerpsBrainResponse | null;
  /** Clock when the complete response was available, not when the call began. */
  completedAtMs: number;
}

export function recordedBrainProducer(records: readonly RecordedPerpsBrainDecision[], strategyVersion: string): PerpsReplayProducer {
  const ids = new Set<string>();
  const rows = records.map(record => {
    const r = record.request;
    if (!r || typeof r.run_id !== "string" || !r.run_id || ids.has(r.run_id) ||
        typeof r.agent_id !== "string" || typeof record.context !== "string" || !record.context ||
        !/^[0-9a-f]{64}$/.test(record.sourceFrameSha256) ||
        !/^[0-9a-f]{64}$/.test(record.sourceNewsSha256) ||
        !record.sourceNews || brainFingerprint(record.sourceNews) !== record.sourceNewsSha256 ||
        canonicalJson(record.sourceNews) !== canonicalJson(r.news) || !r.candidate ||
        !Number.isSafeInteger(r.as_of_ms) || !Number.isSafeInteger(r.expires_at_ms) ||
        !Number.isSafeInteger(record.completedAtMs) || record.completedAtMs < r.as_of_ms || r.expires_at_ms <= r.as_of_ms)
      throw new Error("malformed or duplicate recorded Brain run");
    ids.add(r.run_id);
    return { record, candidate: null as PerpOpenDraft | null, observed: false, consumed: false };
  }).sort((a, b) => a.record.request.as_of_ms - b.record.request.as_of_ms);
  for (let i = 1; i < rows.length; i++) {
    const before = rows[i - 1]!.record, after = rows[i]!.record;
    if (before.request.agent_id !== after.request.agent_id || before.context !== after.context ||
        after.request.as_of_ms <= before.request.as_of_ms)
      throw new Error("recorded runs must share one account/context and unique ordered request clocks");
    // Live reviews are single-flight. Admitting an impossible overlap would
    // let an older approval arrive after a newer HOLD and regain authority.
    if (before.completedAtMs > after.request.as_of_ms)
      throw new Error("recorded reviews cannot overlap the runtime's single-flight boundary");
  }
  const observations: { runId: string; atMs: number; result: string }[] = [];
  let previous = -1;
  return {
    id: strategyVersion,
    diagnostics: () => ({ records: rows.length, observed: rows.filter(r => r.observed).length,
      sourceVerifiedRunIds: rows.filter(r => r.candidate !== null).map(r => r.record.request.run_id),
      unused: rows.filter(r => !r.consumed).length, observations: [...observations] }),
    tick({ frame, feed, view, trend }) {
      if (frame.atMs <= previous) throw new Error("recorded producer cannot be reused or rewound");
      previous = frame.atMs;
      const withheld = { ...trend, entry: null, entryCandleT: null };
      for (const row of rows) {
        const { record } = row, r = record.request;
        if (row.observed || row.consumed || r.as_of_ms !== frame.atMs) continue;
        row.observed = true;
        const expected = view && trend.entry && trend.entryCandleT !== null ? buildPerpsBrainRequest({
          agentId: r.agent_id, runId: r.run_id, nowMs: frame.atMs, context: record.context,
          view, candidate: trend.entry, candleT: trend.entryCandleT, feed, news: record.sourceNews,
        }) : null;
        if (replayFrameHash(frame) !== record.sourceFrameSha256 || !expected || canonicalJson(expected) !== canonicalJson(r)) {
          row.consumed = true;
          observations.push({ runId: r.run_id, atMs: frame.atMs, result: "source-snapshot-or-candidate-mismatch" });
        } else row.candidate = trend.entry;
      }
      // No choice among future outcomes: take the latest completed observed run,
      // including HOLD/failure, and invalidate older completed approvals.
      const ready = rows.filter(r => r.observed && !r.consumed && r.record.completedAtMs <= frame.atMs && r.record.request.as_of_ms < frame.atMs);
      if (!ready.length) return withheld;
      const row = ready.at(-1)!;
      for (const old of ready) old.consumed = true;
      const { record, candidate: original } = row, r = record.request;
      const answer = validatePerpsBrainResponse(record.response, r, frame.atMs);
      const candidate = trend.entry;
      let refusal: string | null = null;
      if (!answer || answer.strategy_version !== strategyVersion) refusal = "response-unread-expired-or-version-mismatch";
      else if (answer.action === "hold") refusal = "brain-held";
      else if (!candidate || !original || trend.entryCandleT !== r.candidate.bar_t || candidate.market !== r.market ||
          candidate.side !== r.candidate.side || candidate.notionalUsdg > original.notionalUsdg || candidate.imfBp < original.imfBp)
        refusal = "current-candidate-changed";
      else if (frame.news?.market !== r.market || !perpsNewsAvailable(frame.news.evidence, frame.atMs) ||
               brainFingerprint(frame.news.evidence) !== brainFingerprint(record.sourceNews))
        refusal = "news-observation-unavailable-or-changed";
      else {
        const mark = view?.markets.get(candidate.market)?.markPrice ?? 0n, old = BigInt(r.mark_price);
        const drift = mark > old ? mark - old : old - mark;
        if (mark <= 0n || old <= 0n || drift * 10_000n > old * BigInt(PERPS_BRAIN_MAX_DRIFT_BPS)) refusal = "market-drift";
        else {
          const current = view ? buildPerpsBrainRequest({ agentId: r.agent_id, runId: r.run_id, nowMs: frame.atMs, context: record.context,
            view, candidate, candleT: trend.entryCandleT!, feed, news: frame.news.evidence }) : null;
          if (!current || !brainMarketStillQualified(r, current, answer!)) refusal = "market-economics-changed";
        }
      }
      observations.push({ runId: r.run_id, atMs: frame.atMs, result: refusal ?? "approved" });
      return refusal ? withheld : trend;
    },
  };
}

/** Exclude requests outside a fold; a fold starts flat with no inherited approval. */
export function brainDecisionsForFrames(records: readonly RecordedPerpsBrainDecision[], frames: readonly PerpsReplayFrame[]) {
  const clocks = new Set(frames.map(f => f.atMs));
  return records.filter(r => clocks.has(r.request.as_of_ms));
}

export function verifiedBrainRunIds(diagnostics: unknown): ReadonlySet<string> {
  const ids = diagnostics && typeof diagnostics === "object" && "sourceVerifiedRunIds" in diagnostics ? diagnostics.sourceVerifiedRunIds : null;
  return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []);
}

/** Keep exact decision frames beside regular samples; never overwrite a conflicting observation. */
export function mergeBrainSourceFrames(frames: readonly PerpsReplayFrame[], records: readonly RecordedPerpsBrainDecision[]): PerpsReplayFrame[] {
  const merged = new Map<number, PerpsReplayFrame>();
  let previous = -1;
  for (const frame of frames) {
    if (!Number.isSafeInteger(frame.atMs) || frame.atMs <= previous) throw new Error("replay frame clocks must strictly increase");
    previous = frame.atMs;
    merged.set(frame.atMs, frame);
  }
  for (const record of records) {
    const source = record.sourceFrame;
    if (!source) continue;
    if (!Number.isSafeInteger(source.atMs) || source.atMs < 0 || source.atMs !== record.request.as_of_ms || replayFrameHash(source) !== record.sourceFrameSha256)
      throw new Error("recorded decision source frame mismatch");
    const existing = merged.get(source.atMs);
    if (existing && replayFrameHash(existing) !== record.sourceFrameSha256) throw new Error("conflicting replay source frames");
    merged.set(source.atMs, source);
  }
  return [...merged.values()].sort((a, b) => a.atMs - b.atMs);
}
