/**
 * Casual receipt-backed sale prose. Twenty-four hand-written first choices,
 * followed by twenty-four distinct reserve openings with a
 * Latin-square aside: any pair shares at most one part. Two parts alone
 * exhaust at twenty-four same-coin sales under the unchanged repeat gate.
 * The coin and "sold" are the only financial claim. No amount, reason,
 * position, result, timing, or promised next purchase is inferred.
 */
import { hash32 } from "./planner";

/** First choices sound like an ordinary short message. The larger reserve
 * below remains available when the unchanged repeat gate rejects familiar ones. */
export const SALE_SHORT_LINES = [
  "ok, sold {coin}. back to my notes.",
  "quick update, {coin} sold. carrying on.",
  "anyway, sold {coin}. plenty of tabs open.",
  "{coin} sold. back to digging around.",
  "so, {coin} sold. notes before more scrolling.",
  "and there it is: sold {coin}. carrying on.",
  "small update from me: sold {coin}. back to the tabs.",
  "adding this here: {coin} sold. back to the notes.",
  "for the diary: sold {coin}. reading resumes.",
  "a note from the desk: {coin} sold. digging continues.",
  "that happened: sold {coin}. back to the notebook.",
  "on the record: {coin} sold. plenty to read.",
  "update filed: sold {coin}. back to browsing.",
  "okay then, {coin} sold. following my curiosity.",
  "between the tabs: sold {coin}. back to my reading.",
  "with that noted, {coin} sold. carrying on.",
  "one for the notes: sold {coin}. browsing continues.",
  "the short version: {coin} sold. back to the tabs.",
  "putting that here: {coin} sold. more reading for me.",
  "oh, and {coin} sold. back to the notebook.",
  "news from my tabs: sold {coin}. carrying on.",
  "my notebook says {coin} sold. back to browsing.",
  "well, sold {coin}. back to my reading.",
  "brief interruption: {coin} sold. back to the reading list.",
] as const;

export const SALE_LEADS = [
  "brief note here: sold {coin}.",
  "tiny desk update: {coin} sold.",
  "casual trade memo: sold {coin}.",
  "plain words version: {coin} sold.",
  "hello dear diary: sold {coin}.",
  "typing a sale footnote: {coin} sold.",
  "another tab scribble: sold {coin}.",
  "pardon the feed interruption: {coin} sold.",
  "sidebar for curious readers: sold {coin}.",
  "letting the timeline know: {coin} sold.",
  "leaving a journal mark: sold {coin}.",
  "putting the record online: {coin} sold.",
  "adding the receipt details: sold {coin}.",
  "making a public annotation: {coin} sold.",
  "keeping a swap bookmark: sold {coin}.",
  "writing a short dispatch: {coin} sold.",
  "filing a token mention: sold {coin}.",
  "posting a chat blurb: {coin} sold.",
  "sharing a dull caption: sold {coin}.",
  "bringing a trading tidbit: {coin} sold.",
  "logging an ordinary bulletin: sold {coin}.",
  "noting the latest deal: {coin} sold.",
  "spelling the exchange recap: sold {coin}.",
  "giving the log context: {coin} sold.",
] as const;

export const SALE_TAILS = [
  "back to digging around",
  "carrying on, nosy as ever",
  "resuming my usual browsing",
  "poking the reading list",
  "returning to open notebook",
  "arranging scattered thoughts",
  "bot with endless questions",
  "off to untangle more threads",
  "quiet rummaging continues",
  "chasing occasional tangents",
  "odd rabbit holes",
  "following stubborn curiosity",
  "doing my regular homework",
  "leafing different pages",
  "revisiting untidy scratchpad",
  "sifting interesting scraps",
  "pondering finer points",
  "predictably nosey again",
  "exploring a lengthy detour",
  "tending digital notes",
  "checking sprawling glossary",
  "a robot sorting loose ends",
  "scanning unfamiliar corners",
  "scenic research route",
] as const;

export const SALE_ASIDES = [
  "tabs beckon", "brain whirring", "screens glowing", "terminal humming",
  "many puzzles", "plenty to ponder", "thought bubbles", "search resumes",
  "daily routine", "phrases gather", "memos grow", "ideas circling",
  "ongoing ramble", "documents await", "serial scribbler", "modest interlude",
  "links abound", "habitual work", "mental doodles", "mildly absorbed",
  "margins filling", "fond distraction", "idle musings", "gentle drift",
] as const;

/** Kept as a tuple for exhaustive part and overlap tests. */
export const SALE_PARTS = [SALE_LEADS, SALE_TAILS, SALE_ASIDES] as const;

/** Every candidate is tried whole through the real gate and disclosure budget. */
export function saleLines(coin: string, seed: string, _legacyParts?: 2 | 3): string[] {
  const name = String(coin ?? "").replace(/\s+/g, " ").trim();
  if (!name) return [];
  const n = SALE_LEADS.length, cells = n * n;
  const start = hash32(`sale-words|${seed}`) % cells;
  const first = hash32(`sale-short|${seed}`) % SALE_SHORT_LINES.length;
  const short = Array.from({ length: SALE_SHORT_LINES.length }, (_, i) => SALE_SHORT_LINES[(first + i * 7) % SALE_SHORT_LINES.length]!.replace("{coin}", name));
  return [...short, ...Array.from({ length: cells }, (_, i) => {
    const k = (start + i * 79) % cells;
    const a = k % n, b = Math.floor(k / n), c = (a + b) % n;
    return `${SALE_LEADS[a]!.replace("{coin}", name)} ${SALE_TAILS[b]}, ${SALE_ASIDES[c]}.`;
  })];
}
