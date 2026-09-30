/**
 * WHICH ROWS THE PAGE HAS NOT SHOWN BEFORE — what the feed's slide-in is drawn
 * from.
 *
 * Possible only since beats are keyed on `postId` (beat.ts, contract C2): with
 * `at` in the key every row was "new" on every refresh. Now a key the page has
 * not seen is a post it has not shown — or, for a landed trade, a fill it has
 * not shown (`freshKeyOf`).
 *
 * MODULE-LEVEL, NOT COMPONENT STATE, on purpose. Switching tabs unmounts the
 * Feed; component state would forget everything and coming back would slide in
 * the whole page. The set outlives the component, so only what arrived while
 * the reader was away moves.
 *
 * THE FIRST READ IS NOT NEWS. The first non-empty set of keys primes the set
 * and nothing slides in — a page arriving is not forty posts arriving. An
 * empty first read (unread, unreadable, a quiet window) does not prime, so the
 * first real rows are still treated as the page.
 *
 * READING NEVER MARKS. `freshAmong` is pure over the set, and only `markSeen`
 * — called after commit — changes it. A render React discards, or StrictMode's
 * second render, must see the same answer as the one that paints; marking
 * during render would make the second render see nothing new, and a row would
 * never animate in development.
 *
 * Presentation state, per viewer and per page load. Nothing here is stored,
 * sent, or read by anything but the row's class.
 */
import type { Beat } from "./beat";

const seen = new Set<string>();
let primed = false;

/** A long session is bounded: past this, the set restarts from the current page. */
const SEEN_MAX = 5_000;

/** The keys in `keys` the page has not shown before. Pure: changes nothing. */
export function freshAmong(keys: readonly string[]): ReadonlySet<string> {
  if (!primed) return new Set();
  return new Set(keys.filter((k) => !seen.has(k)));
}

/** The page has now shown these. Called after the render that drew them commits. */
export function markSeen(keys: readonly string[]): void {
  if (keys.length === 0) return;
  if (seen.size + keys.length > SEEN_MAX) seen.clear();
  for (const k of keys) seen.add(k);
  primed = true;
}

/**
 * WHAT MAKES A ROW NEWS: its key — and, for a trade that landed, its key AT
 * THE TIME of its newest fill.
 *
 * The reader groups identical copies into one row with a count (read-theses.ts
 * has no `d.at` in its GROUP BY), so the day's second DCA leg — same reason,
 * same size — arrives as the same row with `said` 2 and a newer `at`. By key
 * alone it had been seen: the row jumped to the top as "now" and did not move.
 * A new fill is news whether or not it has a row of its own, so a landed
 * trade is new when its newest fill is. Everything else stays keyed on the
 * post alone: a view re-said every five minutes, a refusal re-proposed every
 * tick and an order re-sent while in flight are not new every time they recur.
 */
export function freshKeyOf(beat: Beat): string {
  return beat.kind === "trade" && !beat.shadow && beat.outcome === "landed" ? `${beat.id}@${beat.atMs}` : beat.id;
}

/**
 * WHETHER A ROW ON SCREEN IS NEW, against the keys `freshKeyOf` gave the read.
 * A summary — a watch line or a chorus — is not a post and has no key of its
 * own worth diffing (its id is the agent or the crowd, which is always
 * "seen"), so it is new when the member it leads with is: a fresh hold that
 * joined a watch line moves the line, exactly as it would have moved its own
 * row.
 */
export function isFresh(beat: Beat, fresh: ReadonlySet<string> | undefined): boolean {
  if (!fresh || fresh.size === 0) return false;
  if (fresh.has(freshKeyOf(beat))) return true;
  return (beat.kind === "watch" || beat.kind === "chorus") && fresh.has(freshKeyOf(beat.latest));
}

/** Tests only: a fresh page load. */
export function forgetSeenForTest(): void {
  seen.clear();
  primed = false;
}
