import { segments, type FeedHistory, type FeedPoint } from "@/lib/read-feed-history";
import { usd } from "@/lib/format";
import { dayLabel } from "@/lib/format";

/**
 * The oracle's own series.
 *
 * NOT Sparkline, and the difference is why this file exists. Sparkline spaces
 * points by INDEX — x = i / (n - 1) — which is right for an equity curve sampled
 * on a fixed tick and wrong here: a session with twenty rounds would get twenty
 * times the width of one with a single round, and the shape would be an artefact
 * of how often the oracle felt like writing.
 *
 * A STRAIGHT REAL-TIME AXIS IS ALSO WRONG, and it was the first thing tried.
 * Measured on the AAPL feed: 400 rounds spanning 61 days drew 44 segments
 * covering 28% OF THE WIDTH, median segment three pixels. The feed runs 24/5 and
 * writes on deviation, so most of the calendar is silence, and a chart that
 * honours that literally is 72% empty and unreadable.
 *
 * So the axis is SESSION-COMPRESSED, the way every trading chart is: real
 * elapsed time inside a session, a fixed narrow gutter between them. Time within
 * a session is therefore true to scale, the breaks stay visible, and the hours
 * nobody published are not drawn as though they were. The caption says all of
 * this, because a compressed axis a reader has not been told about is the
 * dishonest version.
 *
 * Server-rendered SVG, like the sparkline: nothing here is interactive, and a
 * chart is not worth a hydration boundary on a phone.
 */

const W = 640;
const H = 168;
const PAD_X = 2;
const PAD_TOP = 10;
const PAD_BOT = 4;

/** The gutter drawn for a break, in viewBox units. Narrow, but never zero. */
const GUTTER = 5;

/**
 * How much history to draw.
 *
 * The walk fetches 400 rounds because they cost one request either way, but 61
 * days across 640px is roughly ten pixels a session. Two weeks is about ten
 * sessions, which is a chart somebody can actually read a shape off.
 */
const WINDOW_DAYS = 14;

const money = (n: number) =>
  usd(n);

const day = (sec: number) =>
  dayLabel(sec * 1000);

export function PriceLine({ history, symbol }: { history: FeedHistory; symbol: string | null }) {
  // Three states, and only the first is an error.
  if (!history.read) {
    return (
      <div className="mm-readfail">
        The chain turned down the read for this feed&rsquo;s history, so there is no line below. It
        retries on its own.
      </div>
    );
  }
  if (history.points.length < 2) {
    return (
      <p className="mm-note">
        No Chainlink feed publishes a history for this token, so there is no price line to draw.
      </p>
    );
  }

  const newest = history.points[history.points.length - 1]!.at;
  const cutoff = newest - WINDOW_DAYS * 86_400;
  const windowed = history.points.filter((p) => p.at >= cutoff);
  // A feed that writes rarely can have fewer than two rounds in a fortnight.
  // Falling back to everything beats an empty box.
  const pts: FeedPoint[] = windowed.length >= 2 ? windowed : history.points;

  const lo = Math.min(...pts.map((p) => p.px));
  const hi = Math.max(...pts.map((p) => p.px));
  // A feed that has not moved gets a straight line through the middle, not a
  // division by zero and not an empty box.
  const pSpan = hi - lo || 1;

  const h = H - PAD_TOP - PAD_BOT;
  const y = (px: number) => PAD_TOP + h - ((px - lo) / pSpan) * h;

  const runs = segments(pts);

  // Lay the sessions out: real duration inside each, a fixed gutter between.
  // A session of one round has no duration, so it gets a minimum slice rather
  // than collapsing to a line of zero width.
  const MIN_RUN = 6;
  const spans = runs.map((r) => Math.max(r[r.length - 1]!.at - r[0]!.at, 1));
  const totalSpan = spans.reduce((a, b) => a + b, 0);
  const gutters = GUTTER * Math.max(0, runs.length - 1);
  const drawable = Math.max(1, W - PAD_X * 2 - gutters - MIN_RUN * runs.length);

  let cursor = PAD_X;
  const placed = runs.map((run, i) => {
    const width = MIN_RUN + (spans[i]! / totalSpan) * drawable;
    const x0 = cursor;
    cursor += width + GUTTER;
    const t0 = run[0]!.at;
    const span = spans[i]!;
    return {
      run,
      x: (at: number) => x0 + ((at - t0) / span) * width,
    };
  });

  const first = pts[0]!.px;
  const last = pts[pts.length - 1]!.px;
  const tone = last >= first ? "up" : "down";
  const stroke = tone === "up" ? "var(--mm-up)" : "var(--mm-down)";
  const lastPlaced = placed[placed.length - 1]!;
  const lastRun = lastPlaced.run;

  return (
    <figure className="mm-priceline">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${symbol ?? "This token"} oracle price, ${day(pts[0]!.at)} to ${day(newest)}, ${money(lo)} to ${money(hi)}`}
      >
        {placed.map(({ run, x }, i) => {
          if (run.length === 1) {
            // A lone round between two silences. Drawn as a dot: a one-point
            // polyline renders as nothing at all, and the reader would never
            // know the observation was there.
            return <circle key={i} cx={x(run[0]!.at)} cy={y(run[0]!.px)} r={1.6} fill={stroke} />;
          }
          const d = run
            .map((p, j) => `${j === 0 ? "M" : "L"}${x(p.at).toFixed(1)} ${y(p.px).toFixed(1)}`)
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
            />
          );
        })}
        {/* The last observation, marked. It is the only point on this chart a
            reader has any business acting on. */}
        <circle
          cx={lastPlaced.x(lastRun[lastRun.length - 1]!.at)}
          cy={y(last)}
          r={2.5}
          fill={stroke}
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      <div className="axis mono">
        <span>{day(pts[0]!.at)}</span>
        <span className="px">
          {money(lo)} &ndash; {money(hi)}
        </span>
        <span>{day(newest)}</span>
      </div>

      {/* MANDATORY, not decoration. Everything else on this page is a market
          figure, and without this sentence a reader takes the line for one —
          and takes the axis for wall-clock time, which it deliberately is not. */}
      <figcaption>
        Chainlink feed &mdash; not a market. {placed.length}{" "}
        {placed.length === 1 ? "session" : "sessions"}, most recent {WINDOW_DAYS} days. Time runs to
        scale within a session; the hours the feed published nothing are left out rather than drawn
        across, which is what the breaks are.
      </figcaption>
    </figure>
  );
}
