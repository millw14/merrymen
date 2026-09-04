import type { AgentProfile } from "@/lib/read-agent";

/**
 * WHAT THE BOOK DID, WITH THE OWNER'S CASH TAKEN OUT OF IT.
 *
 * The profile drew `Sparkline` over raw `equity_usdg`. Two things were wrong
 * with that and they are independent.
 *
 * THE SERIES. A balance reading rises the moment the owner funds the account,
 * and a new epoch's entire opening balance is written as one inbound flow — so
 * drawn raw, a book springs into existence at full value and a deposit reads as
 * a win. This draws the growth index instead: each period's flow divided out
 * before compounding, which is the standard correction and lives in one tested
 * module rather than being re-derived here.
 *
 * THE AXIS. Sparkline spaces by INDEX, which is defensible for a fixed sampling
 * tick and this is not one: the loop period is the tick's own duration plus a
 * settable interval, the setting is re-read every tick, restarts and the
 * watchdog delete arbitrary runs, and the worker deliberately writes NO ROW AT
 * ALL when the book cannot be valued — "a gap is honest; a wrong number is not".
 * Index spacing draws a straight line across every one of those. This segments
 * on the gaps and lays each run out on real elapsed time, the technique the
 * token page's PriceLine established.
 *
 * Server-rendered SVG. Nothing here is interactive.
 */

const W = 640;
const H = 168;
const PAD_X = 2;
const PAD_TOP = 10;
const PAD_BOT = 4;

/** The gutter drawn for a break, in viewBox units. Narrow, but never zero. */
const GUTTER = 5;
/** So a run of one reading does not collapse to no width at all. */
const MIN_RUN = 6;

const pctOf = (g: number) => `${g >= 1 ? "+" : ""}${((g - 1) * 100).toFixed(1)}%`;

const day = (sec: number) =>
  new Date(sec * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/** "8 hours" / "3 days" / "12 minutes" — a window a reader can hold. */
function span(sec: number): string {
  if (sec < 5400) return `${Math.max(1, Math.round(sec / 60))} minutes`;
  if (sec < 172_800) return `${Math.round(sec / 3600)} hours`;
  return `${Math.round(sec / 86_400)} days`;
}

/**
 * Where the feed went quiet for long enough to be a break rather than a tick.
 *
 * DERIVED, not a constant, and with NO UPPER BOUND. The tick is settable from
 * fifteen seconds to an hour, so a fixed threshold either treats every reading
 * as a break at the top of that range or bridges a real outage at the bottom.
 * Six times this agent's own typical spacing is, by definition, a gap that
 * cannot be the loop simply running.
 *
 * A ceiling was tried and was wrong in the other direction: capped at six
 * hours, an agent whose readings are fourteen hours apart has EVERY gap counted
 * as a break, and the chart draws as a field of unconnected dots. If fourteen
 * hours is normal for this agent then fourteen hours is not an outage, which is
 * the whole reason the threshold is derived from the series rather than fixed.
 *
 * The floor stays: a very fast tick must not turn ordinary jitter into breaks.
 */
function breakSec(points: readonly { at: number }[]): number {
  const gaps: number[] = [];
  for (let i = 1; i < points.length; i++) gaps.push(points[i]!.at - points[i - 1]!.at);
  if (!gaps.length) return 600;
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)]!;
  return Math.max(600, median * 6);
}

export function EquityLine({ agent }: { agent: AgentProfile }) {
  const paper = agent.mode === "paper";

  // THREE STATES, CHECKED IN THIS ORDER. Only the first is an error, and an
  // unreadable ledger must never render as a flat book.
  if (!agent.equityRead) {
    return (
      <div className="mm-readfail">
        The ledger turned down this read, so there is no line below. It retries on its own.
      </div>
    );
  }

  // A live agent with no flows on record has no denominator: a rise in its
  // balance cannot be told apart from money its owner put in. A PAPER agent has
  // no flows by construction and its index is simply its own book moving, so
  // that case draws.
  if (!paper && !agent.funded) {
    return (
      <p className="mm-note">
        No deposit or withdrawal is on record for this agent, so a rise in its balance cannot be
        told apart from money its owner put in.
      </p>
    );
  }

  // THE FLOWS THE INDEX DIVIDES OUT HAVE TO BE EVIDENCE.
  //
  // `funded` only says flow rows exist. The growth index subtracts each period's
  // flow from the equity line, so a row inferred from a balance change — every
  // phantom opening balance a redeploy wrote — moves the curve by an amount
  // nothing actually deposited. This page published -4.1% that way while three
  // lines above it correctly refused to publish a return at all, from the same
  // data, at the same moment.
  //
  // The equity history is still real and still worth showing; what cannot be
  // shown is a percentage derived from untrusted flows. So the line stays and
  // the figure goes, which is the same fail-closed rule the return gate follows.
  if (!paper && !agent.contributionsEvidenced) {
    return (
      <p className="mm-note">
        The deposits and withdrawals on record for this agent are inferred from balance changes
        rather than read from the chain, so they cannot be divided out of its equity — and a growth
        figure computed over them would not be its doing. The balance history is above; the return
        is not published until the capital behind it is evidenced.
      </p>
    );
  }

  if (agent.growth.length < 2) {
    return <p className="mm-note">Not enough of a history to draw yet.</p>;
  }

  const pts = agent.growth;
  const t0 = pts[0]!.at;
  const t1 = pts[pts.length - 1]!.at;

  const lo = Math.min(...pts.map((p) => p.g), 1);
  const hi = Math.max(...pts.map((p) => p.g), 1);
  // A book that has not moved sits on its own origin line rather than dividing
  // by zero — which is the correct render for an agent that has never filled.
  const gSpan = hi - lo || 0.02;

  const h = H - PAD_TOP - PAD_BOT;
  const y = (g: number) => PAD_TOP + h - ((g - lo) / gSpan) * h;

  // Segment, then lay the runs out on real elapsed time with a fixed gutter.
  const limit = breakSec(pts);
  const runs: (typeof pts)[] = [];
  let run: typeof pts = [];
  for (const p of pts) {
    const prev = run[run.length - 1];
    if (prev && p.at - prev.at > limit) {
      runs.push(run);
      run = [];
    }
    run.push(p);
  }
  if (run.length) runs.push(run);

  const spans = runs.map((r) => Math.max(r[r.length - 1]!.at - r[0]!.at, 1));
  const totalSpan = spans.reduce((a, b) => a + b, 0);
  const drawable = Math.max(
    1,
    W - PAD_X * 2 - GUTTER * Math.max(0, runs.length - 1) - MIN_RUN * runs.length,
  );

  let cursor = PAD_X;
  const placed = runs.map((r, i) => {
    const width = MIN_RUN + (spans[i]! / totalSpan) * drawable;
    const x0 = cursor;
    cursor += width + GUTTER;
    const start = r[0]!.at;
    return { run: r, x: (at: number) => x0 + ((at - start) / spans[i]!) * width };
  });

  const last = pts[pts.length - 1]!.g;
  const tone = last >= 1 ? "up" : "down";
  const stroke = tone === "up" ? "var(--mm-up)" : "var(--mm-down)";
  const lastPlaced = placed[placed.length - 1]!;
  const lastRun = lastPlaced.run;

  const gaps: number[] = [];
  for (let i = 1; i < pts.length; i++) gaps.push(pts[i]!.at - pts[i - 1]!.at);
  gaps.sort((a, b) => a - b);
  const typical = gaps.length ? gaps[Math.floor(gaps.length / 2)]! : 0;

  return (
    <figure className="mm-equity">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${agent.name} equity less contributions, ${pctOf(last)} over ${span(t1 - t0)}`}
      >
        {/* THE ORIGIN. Everything above this line the agent added, everything
            below it the agent lost. It is the only reference the reader needs
            and the raw equity chart had nothing like it. */}
        <line x1={0} x2={W} y1={y(1)} y2={y(1)} stroke="var(--mm-edge-2)" strokeWidth={1} />

        {placed.map(({ run: r, x }, i) => {
          if (r.length === 1) {
            // A one-point polyline renders as nothing, and the reader would
            // never know the reading was there.
            return <circle key={i} cx={x(r[0]!.at)} cy={y(r[0]!.g)} r={1.6} fill={stroke} />;
          }
          const d = r
            .map((p, j) => `${j === 0 ? "M" : "L"}${x(p.at).toFixed(1)} ${y(p.g).toFixed(1)}`)
            .join(" ");
          return (
            <path
              key={i}
              d={d}
              fill="none"
              stroke={stroke}
              strokeWidth={1.5}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
              /* A pretend book must not look like a real one. */
              strokeDasharray={paper ? "4 3" : undefined}
            />
          );
        })}
        <circle
          cx={lastPlaced.x(lastRun[lastRun.length - 1]!.at)}
          cy={y(last)}
          r={2.5}
          fill={stroke}
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      <div className="axis mono">
        <span>{day(t0)}</span>
        <span className={`px ${tone}`}>{pctOf(last)}</span>
        <span>{day(t1)}</span>
      </div>

      {/* MANDATORY. Without it a reader takes this for the account balance, and
          takes the axis for wall-clock time, which it deliberately is not. */}
      <figcaption>
        Equity with the owner&rsquo;s deposits and withdrawals divided out &mdash; the only part
        that is the agent&rsquo;s doing. {pts.length} readings over {span(t1 - t0)} in{" "}
        {placed.length} {placed.length === 1 ? "run" : "runs"}
        {typical > 0 && <>, about {span(typical)} apart</>}; the stretches where the worker wrote
        nothing are left out rather than drawn across, which is what the breaks are. Gross of gas,
        unlike the return above.
        {paper && (
          <>
            {" "}
            This is a simulated book, and the ledger records no mode per reading &mdash; the label
            is the agent&rsquo;s current one.
          </>
        )}
        {/* The divisor's own evidence class. An inferred flow is a cash change
            no fill explains — and a new epoch's whole opening balance is one.
            The shape is published; the amounts never are. */}
        {agent.flowsTotal > 0 && agent.flowsWithTx < agent.flowsTotal && (
          <>
            {" "}
            {agent.flowsWithTx} of {agent.flowsTotal} deposits and withdrawals carry a transaction;
            the rest were inferred from balance changes.
          </>
        )}
      </figcaption>
    </figure>
  );
}
