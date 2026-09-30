/**
 * NEW REAL-MONEY FILLS, AS THE FEED READS ARRIVE — what the chime plays for and
 * what the tab title counts while nobody is looking.
 *
 * Only a trade that LANDED, with real money. The feed is mostly views and
 * scheduled holds, which arrive every few minutes whether or not anything
 * happened; a title that counted them would climb all day, and a chime for them
 * would be noise. A paper fill is excluded for the reason the rest of the
 * product keeps it apart from `landed` (read-agent.ts): it is simulated money,
 * and it fills on every proposal, so it would be the loudest thing on the feed
 * and the least news. Refusals and pending orders are not fills.
 *
 * ONE RULE, AND IT CANNOT ANNOUNCE A FILL THAT DID NOT HAPPEN: a landed row is
 * news when its `at` is newer than any `at` this page has ever seen for the
 * same agent, side and coin. Each of those keeps that high-water time, and it
 * only goes up.
 *
 * KEYED ON WHAT THE PUBLICATION GATE NEVER REWRITES. The post id hashes the
 * published size and reason, and both change when the owner flips the book
 * public or private (a private book publishes no size and no figures) — or
 * when one read could not tell which it was and published it as private. Keyed
 * on the id, every recent fill came back as a post never seen, and chimed
 * again. The agent, the side and the coin are the same whatever the book.
 *
 * The id names a THESIS, not a trade (lib/post-id.ts hashes the author, side,
 * symbol, size and reason, and leaves the outcome and the time out on purpose),
 * and the feed groups every landed copy of one post into a row whose `at` is
 * MAX(d.at). So a steady-basket leg's next fill arrives as the same id with a
 * newer `at` — news — and a pending trade that lands keeps its id and becomes
 * news when it does.
 *
 * WHY NOT `said`. Four rounds of review measured fills by a row's count of
 * copies, and every rule built on it announced fills that never happened: the
 * action lane serves only its newest rows, so an older row of a post falls off
 * the read and comes back with every copy it always had; a post body written
 * for one copy splits a row in two; a private book's rows share one id across
 * sizes; copies leave the 24h window. A count read against another reading of
 * a different shape is not evidence of a fill. The time is: nothing but a new
 * landed decision moves a post's newest `at` past everything seen before, and a
 * row coming back, splitting or shrinking never does.
 *
 * WHAT IT GIVES UP, on purpose, because a missed chime is silence and a false
 * one is a lie: two fills of one row between two reads count one; an order
 * decided earlier that lands after a newer copy of the same post (`at` stands
 * still) is not announced; a row of a post that never showed above its
 * newest is not announced. The fills are all on the feed and the desk either
 * way — this is only the tone and the tab count.
 *
 * NEVER ON THE FIRST READ. Everything on the feed when the page opened is what
 * the reader walked in on. And a fill first seen long after it happened is not
 * announced either: a reader that re-ranks its rows, or a deploy that changes
 * which rows it returns, would otherwise chime a dozen old trades at once.
 */
import type { Thesis } from "./live";

/** How recent a fill must be, when it first appears, to be announced. */
export const FRESH_SEC = 15 * 60;

/**
 * What `outcomeOf` (worker/src/thesis-policy.ts) says of a trade whose status
 * is "paper". It shares the "landed" outcome with a chain fill, so this text is
 * the only thing on a post that is about the FILL: `paper` beside it is the
 * author's mode at its last heartbeat, which flips when the owner goes live and
 * takes every recent paper fill with it.
 */
const PAPER_FILL_TEXT = "filled on paper";

export function isLandedTrade(t: Thesis): boolean {
  return (
    (t.action === "buy" || t.action === "sell") &&
    t.outcome === "landed" &&
    t.paper !== true &&
    t.outcomeText !== PAPER_FILL_TEXT &&
    t.shadow !== true &&
    typeof t.postId === "string" &&
    t.postId.length > 0
  );
}

/** What one read's news amounts to: the rows to chime for, and how many fills they are. */
export interface Arrivals {
  /** The rows with a new fill, oldest first. The chime plays once for them. */
  rows: Thesis[];
  /** How many fills those rows stand for — the tab title's count. */
  fills: number;
}

const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function createArrivals(opts: { freshSec?: number; cap?: number } = {}) {
  const freshSec = opts.freshSec ?? FRESH_SEC;
  const cap = opts.cap ?? 2_000;
  /** Each agent, side and coin's newest landed `at` ever read. It never goes down. */
  const high = new Map<string, number>();
  let seeded = false;
  return {
    /**
     * The landed fills in this READ answer newer than anything read before.
     * Hand it only answers that were read: an unreadable one has no rows, and
     * the first readable one is the one that seeds.
     */
    take(theses: readonly Thesis[], nowSec: number): Arrivals {
      // One entry per (post, time): two rows of one post in the same second are
      // one fill at most, however the feed split them.
      const read = new Map<string, Map<number, Thesis>>();
      for (const t of theses) {
        const at = finite(t.at);
        if (!isLandedTrade(t) || at === null) continue;
        const id = `${t.slug ?? ""}|${t.action}|${t.symbol ?? ""}`;
        const times = read.get(id) ?? new Map<number, Thesis>();
        read.set(id, times);
        if (!times.has(at)) times.set(at, t);
      }
      const rows: Thesis[] = [];
      for (const [id, times] of read) {
        const before = high.get(id);
        const newest = Math.max(...times.keys());
        // A post seen for the first time is one fill, on its newest row: its
        // older rows may well predate the page.
        const fresh = before === undefined ? [newest] : [...times.keys()].filter((at) => at > before);
        high.delete(id);
        high.set(id, before === undefined ? newest : Math.max(before, newest));
        if (!seeded) continue;
        for (const at of fresh) {
          const age = nowSec - at;
          // A minute of clock skew either way, and no further.
          if (age <= freshSec && age >= -60) rows.push(times.get(at)!);
        }
      }
      seeded = true;
      // The least recently read go first. A post forgotten and seen again is
      // long past fresh by the time the map has turned over, so it stays quiet.
      for (const id of high.keys()) {
        if (high.size <= cap) break;
        high.delete(id);
      }
      rows.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
      return { rows, fills: rows.length };
    },
    size: () => high.size,
  };
}
