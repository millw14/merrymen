/**
 * WHAT THE OWNER'S P&L IS MEASURED AT, out of /api/feed.
 *
 * The feed's `equity` series is the book's value as it was read — held marks
 * included (held-marks.ts), because "equity now", the curve and the daily
 * change are about the value, and a late booking cannot move a raw series.
 * A RETURN is not: it subtracts the booked contributions, and a mark taken
 * while flow inference was held can carry a top-up or withdrawal not booked
 * yet. So the feed also sends `measured`: the newest measured mark of that
 * book and the contributions booked by it, and the return pairs those two.
 *
 * `measured` ABSENT is an older server: the old pairing, the newest mark over
 * every flow. PRESENT BUT NULL is a book with no measured mark yet — every
 * mark since it began was held — and has no numerator; the contributions stay
 * the whole record, so the reason given is the one it always was.
 *
 * No imports, so the rule is testable without a page.
 */

export interface FeedMeasured {
  equityUsdg: number;
  /** When the mark was taken, formatted as the feed formats every time. */
  at: string;
  /** Net contributions booked at or before it; null when none was. */
  netContributionsUsdg: number | null;
}

export interface FeedPnlSource {
  equity?: readonly { equity_usdg: number }[];
  netContributionsUsdg?: number | null;
  measured?: FeedMeasured | null;
}

/** The numerator and denominator the owner's return is computed from. */
export function pnlBasisOf(feed: FeedPnlSource | null | undefined): { latest: number | null; contributed: number | null } {
  const contributions = feed?.netContributionsUsdg ?? null;
  if (feed && "measured" in feed && feed.measured !== undefined) {
    const m = feed.measured;
    return m === null
      ? { latest: null, contributed: contributions }
      : { latest: Number.isFinite(m.equityUsdg) ? m.equityUsdg : null, contributed: m.netContributionsUsdg };
  }
  const curve = (feed?.equity ?? []).map((e) => Number(e.equity_usdg)).filter(Number.isFinite);
  return { latest: curve.length ? curve[curve.length - 1]! : null, contributed: contributions };
}
