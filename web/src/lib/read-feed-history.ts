/**
 * The oracle's published history, re-exported.
 *
 * The module moved to `worker/src/read-feed-history.ts` when Brain's technical
 * analyst needed it. The worker cannot import from `web/src` — `imports.test.ts`
 * forbids the alias and web is not aliased inward at all — so the choice was to
 * move it or keep a second copy.
 *
 * A SECOND COPY WOULD DRIFT, and what would drift is the guards: the magnitude
 * check that catches a phase-boundary answer 1e18 times the price, the 6-hour
 * break that refuses to draw a line through a closed market, and the
 * `read: false` arm that separates "no history" from "we could not ask". Two
 * copies of those become two different ideas of what the oracle said, and the
 * difference would show up as a chart and a thesis disagreeing about the same
 * feed. This is the same move `thesis-policy.ts` made, for the same reason.
 *
 * Nothing here may add behaviour: a check on this side would apply to the chart
 * and not to the analyst, which is the exact asymmetry the move prevents.
 */
export {
  FEED_GUARDS,
  readFeedHistory,
  segments,
  type FeedHistory,
  type FeedPoint,
} from "@merrymen/feed-history";
