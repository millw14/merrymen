/**
 * ONE FUNNEL PER TICK, so "why isn't it trading?" takes seconds.
 *
 * An autonomous trader that is working correctly and an autonomous trader that
 * is broken look identical from outside: both do nothing. The difference is
 * only visible as a shape — how many tokens were seen, how many survived each
 * narrowing, and what stopped the rest. Without that, diagnosing a quiet agent
 * means reading the tick by hand, which is hours; with it, it is one line.
 *
 * COUNTS ARE MEASUREMENTS AND NEVER DEFAULTS. A stage that did not run is null,
 * not zero. "Nothing was quoted" and "quoting never happened because nothing
 * survived verification" are different diagnoses, and a funnel that renders
 * both as `quoted 0` has thrown away the distinction it exists to preserve.
 *
 * IT DESCRIBES; IT NEVER DECIDES. Nothing reads these counters back into a
 * trading decision. A funnel that fed the strategist would make the agent's
 * behaviour depend on its own telemetry, and the first flaky count would become
 * a trade.
 */
import type { RefusalKind } from "./candidate-score";
import type { VenueId } from "./venue";

export interface FunnelRefusal {
  symbol: string;
  reason: string;
  kind: RefusalKind;
}

export interface ScanFunnel {
  venue: VenueId;
  /** Tokens the venue reported. */
  discovered: number;
  /** Survived venue verification — tradable right now, with real numbers. */
  verified: number;
  /** Priced. Null when quoting never ran. */
  quoted: number | null;
  /** Passed the owner's risk style. Null when scoring never ran. */
  eligible: number | null;
  /** Survived the policy mirror. Null when policy never ran. */
  policyPassed: number | null;
  /** Rehearsed against live state. Null when simulation never ran. */
  simulated: number | null;
  buys: number;
  sells: number;
  /** Every rejection, with the sentence and the groupable cause. */
  refusals: FunnelRefusal[];
}

export function emptyFunnel(venue: VenueId): ScanFunnel {
  return {
    venue,
    discovered: 0,
    verified: 0,
    quoted: null,
    eligible: null,
    policyPassed: null,
    simulated: null,
    buys: 0,
    sells: 0,
    refusals: [],
  };
}

/** Refusal counts by cause, most common first. */
export function byKind(f: ScanFunnel): { kind: RefusalKind; count: number }[] {
  const n = new Map<RefusalKind, number>();
  for (const r of f.refusals) n.set(r.kind, (n.get(r.kind) ?? 0) + 1);
  return [...n.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
}

const stage = (n: number | null): string => (n === null ? "—" : String(n));

/**
 * The OPERATOR's line. One per tick, dense, and greppable.
 *
 * `—` for a stage that did not run, never 0. See the header.
 */
export function funnelLine(f: ScanFunnel): string {
  const causes = byKind(f)
    .map((c) => `${c.kind} ${c.count}`)
    .join(", ");
  return (
    `[funnel:${f.venue}] discovered ${f.discovered} → verified ${f.verified} → quoted ${stage(f.quoted)} → ` +
    `eligible ${stage(f.eligible)} → policy ${stage(f.policyPassed)} → simulated ${stage(f.simulated)} → ` +
    `buys ${f.buys}, sells ${f.sells}` +
    (causes ? ` · refused: ${causes}` : "")
  );
}

/**
 * The OWNER's sentence — what the agent is doing, in words they did not have to
 * learn.
 *
 * The brief is explicit that `no-exit`, `wrong-chain` and `live-not-enabled`
 * must never be the primary explanation, and the same applies to every count in
 * this module. An owner asking "what is it doing" wants "still scanning —
 * nothing has enough real liquidity yet", not `eligible 0`.
 *
 * It reports the DOMINANT cause rather than listing all of them, because a list
 * is a second thing to read and the tail is rarely actionable. The full
 * breakdown stays one `funnelLine` away in Advanced.
 *
 * Returns null when the agent DID trade this tick — there is nothing to explain
 * about an agent that just bought something, and manufacturing a sentence there
 * is how a feed ends up narrating its own silence.
 */
export function idleSentence(f: ScanFunnel, opts: { holding: number }): string | null {
  if (f.buys > 0 || f.sells > 0) return null;

  const held = opts.holding > 0 ? `Holding ${opts.holding} position${opts.holding === 1 ? "" : "s"}. ` : "";

  if (f.discovered === 0) {
    return `${held}Scanning — no new tokens have appeared on ${f.venue} yet.`;
  }
  if (f.verified === 0) {
    const top = byKind(f)[0];
    if (top) return `${held}${sentenceFor(top.kind, f.discovered, top.count)}`;
    return `${held}Scanned ${f.discovered} tokens — none of them can be traded from here.`;
  }
  if (f.eligible === 0) {
    const top = byKind(f)[0];
    if (top) return `${held}${sentenceFor(top.kind, f.discovered, top.count)}`;
    return `${held}Scanned ${f.discovered} tokens, ${f.verified} tradable — none met your risk settings.`;
  }
  if (f.eligible !== null && f.eligible > 0 && f.buys === 0) {
    // Qualified, and still did not buy. Almost always a cap or the wall, and
    // saying "found some" without saying "and stopped" would read as progress.
    return `${held}Found ${f.eligible} candidate${f.eligible === 1 ? "" : "s"} on ${f.venue}, but the trade did not pass your limits.`;
  }
  return `${held}Scanning ${f.discovered} tokens on ${f.venue}…`;
}

/**
 * One sentence per cause.
 *
 * Written as things a person would say. The figures are the ones already
 * measured — no new arithmetic here, because a number invented for a sentence is
 * a number nobody can check.
 */
function sentenceFor(kind: RefusalKind, discovered: number, count: number): string {
  const scanned = `Scanned ${discovered} token${discovered === 1 ? "" : "s"}`;
  switch (kind) {
    case "depth":
      return `${scanned} — nothing currently has enough real liquidity (${count} were too thin).`;
    case "impact":
      return `${scanned} — ${count} would have cost too much to get in and out of.`;
    case "graduation":
      return `${scanned} — ${count} were too close to graduating to sell safely afterwards.`;
    case "age":
      return `${scanned} — ${count} were too new to judge yet.`;
    case "activity":
      return `${scanned} — ${count} had almost no trading going on.`;
    case "unpriceable":
      return `${scanned} — ${count} could not be priced this pass, so they were left alone.`;
    case "venue":
      return `${scanned} — ${count} cannot be reached from this account.`;
    default: {
      const _x: never = kind;
      return _x;
    }
  }
}
