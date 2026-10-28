/**
 * REVIEW CANDIDATES — the coins an opted-in agent's Trencher review is about
 * to look at, asked of shared research so that the NEXT review of each one
 * carries its dossier and trader-flow lens (docs/fomo.md "Research for review
 * candidates").
 *
 * WHY THIS EXISTS. Shared research follows the trader cohort: a coin none of
 * the watched traders touched gets no dossier, and so no lens. The coins the
 * Brain actually reviews come from the tape (volume, verified routes), which
 * the cohort mostly never touches, so the review saw the lens for almost none
 * of them. A child now names the entry candidates its review rotates through,
 * and the orchestrator queues research for exactly those.
 *
 * WHO MAY ASK. Only an account on the operator's research allowlist
 * (MERRYMEN_DECISION_RESEARCH_ACCOUNTS, decision-research.ts), only while its
 * owner has research on (data access, and monitoring or follow), and only on
 * the live rail of a fast Trencher. The child checks all three before it
 * sends. The orchestrator checks the allowlist and the owner's switches again
 * before it carries or queues anything (orchestrator-fomo.ts
 * syncReviewCandidates), so a child can never widen either; it cannot see the
 * rail or the strategy, so those are the child's check alone, and coins named
 * before an agent left them stay carried until keepMs runs out.
 *
 * HOW MUCH. At most `perWindow` distinct coins per rolling `windowMs`, on BOTH
 * sides of the IPC channel: the child sends no more, and the orchestrator keeps
 * no more if a child ever did. A coin already admitted in the window is a
 * duplicate, never a second coin. Research is queued at DISCOVERY priority, so
 * it is paid from the discovery share under the background research cap
 * (service.ts BACKGROUND_RESEARCH_CAP), waits behind held coins, watches and a
 * due cohort refresh, is queued only for a coin the owner's file actually
 * carried, and is queued again for one coin no more often than
 * `refreshEveryMs` on one replica. A refused budget or a provider outage leaves the coin with
 * no lens or a lens that says "unavailable"; no review ever waits for it.
 *
 * WHAT IT NEVER IS. Not a buy signal, a nomination or breadth. A candidate
 * signal carries no trader triggers, the child does not run the follow machine
 * on a coin that is only a candidate (fomo-child.ts assessAll), and every entry
 * floor, price guard, cap and policy check is exactly as it was.
 *
 * Pure: no clock, no I/O. The child and the service each hold their own window.
 */

export interface ReviewCandidateLimits {
  perWindow: number;
  windowMs: number;
  keepMs: number;
  carriedMax: number;
  refreshEveryMs: number;
  memoryMax: number;
}

export const REVIEW_CANDIDATES: Readonly<ReviewCandidateLimits> = Object.freeze({
  /** Distinct coins one child may name per rolling window. */
  perWindow: 10,
  windowMs: 10 * 60_000,
  /**
   * A named coin stays a `candidate` signal this long after it was last
   * admitted. Longer than the window, so a coin the review keeps rotating
   * through (named again once its admission ages out) never drops out between.
   */
  keepMs: 20 * 60_000,
  /** Candidates carried per tenant at once, newest first. */
  carriedMax: 10,
  /**
   * One coin's candidate research is queued again no sooner than this after
   * it was last queued (on one replica; orchestrator-fomo.ts
   * queueCandidateResearch): the thesis class's own freshness (freshness.ts,
   * 30 minutes), so a sooner refresh would mostly be served from cache anyway.
   */
  refreshEveryMs: 30 * 60_000,
  /** Coins remembered for fair rotation (least recently admitted first). */
  memoryMax: 200,
});

/** A coin a review named, and when it was last admitted. */
export interface ReviewCandidate {
  tokenKey: string;
  admittedAt: number;
}

function finiteTime(v: number): boolean {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * One child's rolling window of named coins. `admit` returns only the coins
 * newly admitted (never a duplicate, never one past the window's room);
 * `carried` returns the coins admitted within `keepMs`, newest first.
 *
 * FAIR ROTATION. A review may rotate through more coins than one window
 * admits. Offered coins are taken least-recently-admitted first (never
 * admitted before them all, in the order given), so the same first ten cannot
 * take every window while the rest are never researched.
 */
export class ReviewCandidateWindow {
  /** Admitted inside the current window → when. */
  private readonly inWindow = new Map<string, number>();
  /** Every recent admission → when, for `carried` and for rotation order. */
  private readonly last = new Map<string, number>();

  constructor(private readonly limits: ReviewCandidateLimits = REVIEW_CANDIDATES) {}

  private prune(now: number): void {
    for (const [k, at] of this.inWindow) if (now - at >= this.limits.windowMs || at > now) this.inWindow.delete(k);
    while (this.last.size > this.limits.memoryMax) this.last.delete(this.last.keys().next().value as string);
  }

  admit(keys: readonly string[], now: number): string[] {
    if (!finiteTime(now) || !Array.isArray(keys)) return [];
    this.prune(now);
    const offered = [...new Set(keys.filter((k): k is string => typeof k === "string" && k.length > 0))];
    const order = offered
      .map((k, i) => ({ k, i, at: this.last.get(k) ?? Number.NEGATIVE_INFINITY }))
      .sort((a, b) => a.at - b.at || a.i - b.i);
    const out: string[] = [];
    for (const { k } of order) {
      if (this.inWindow.has(k)) continue;
      if (this.inWindow.size >= this.limits.perWindow) break;
      this.inWindow.set(k, now);
      // Re-inserted, so the memory bound drops the least recently admitted.
      this.last.delete(k);
      this.last.set(k, now);
      out.push(k);
    }
    this.prune(now);
    return out;
  }

  /**
   * UNDO AN ADMISSION THAT WAS NEVER DELIVERED (the report carrying it was
   * refused, never sent or never answered), so the next offer sends these
   * coins again, and first: forgotten, they rank as never admitted. Only the
   * admission made at `at` is undone; a coin admitted again since keeps its
   * newer admission. Admitting before sending and forgetting on failure, rather
   * than admitting on success, keeps a report still in flight from being sent
   * twice by the next review.
   */
  forget(keys: readonly string[], at: number): void {
    if (!Array.isArray(keys)) return;
    for (const k of keys) {
      if (this.inWindow.get(k) === at) this.inWindow.delete(k);
      if (this.last.get(k) === at) this.last.delete(k);
    }
  }

  carried(now: number): ReviewCandidate[] {
    if (!finiteTime(now)) return [];
    return [...this.last]
      .filter(([, at]) => now - at < this.limits.keepMs && at <= now)
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, this.limits.carriedMax)
      .map(([tokenKey, admittedAt]) => ({ tokenKey, admittedAt }));
  }
}
