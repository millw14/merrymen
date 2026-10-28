/**
 * A MARKET ANSWER'S WORDS, BUILT BY CODE (red-team review, 2026-10-12).
 *
 * An active agent's answer to "what's hot?" carries code's figures line
 * (figures.ts): the chain's trending coins by ticker, each with its day's
 * change and volume. The model's words used to stand right before that line,
 * and the X gate judged them before the line was put in, with nothing in them
 * to say a coin was named: "if i had to pick one it'd be the first", "these
 * are my plays right now", "i'm in the top one myself" and "the first one is
 * the play" were each admitted, and code then put "$CHUMP 24h +41.2%" right
 * after them. On the house's real-money account that is a recommendation of a
 * named coin, and a claim to hold coins it never bought. A list of pointing
 * words is never whole.
 *
 * So a market answer has no model words at all. Its words are one of the
 * frames below, filled from a typed read (`HotRead`) of what research found:
 * how many coins stand out, and which way the one on top went on the day,
 * never a name, a figure, a "buy", an "early" or a target. Each frame is
 * gated like any answer, and the figures line goes in after it. The frames do
 * not share their words (the gate's repeat limit, pinned in market.test.ts),
 * so the same read is said again in other words, and when every frame has
 * been said lately, not at all: the same rule as code's model and greeting
 * lines (writer.ts codeLines). A major (a coin by name on CoinGecko's list)
 * is the same: its words are code's (`MajorRead`, majorAnswers), never a
 * draft beside its figures.
 *
 * NO SOURCE NAMED (the owner's teammate, 2026-10-13): no line here says
 * coingecko, geckoterminal, bitquery or robinhood chain. A frame says where in
 * plain words of its own (the tape, the board, the trending index, the
 * screener), never whose data it is.
 *
 * Pure: no I/O, no model, no provider, no clock.
 */
import { CASUAL_PAPER, latinLines } from "./casual";
import { renderFiguresLine, signedPercent, type FiguresSpec } from "./figures";
import type { CodeLineOptions } from "./replies";

/** A day's move as code reads it: which way, and how far, by code's own thresholds. Never a figure. */
export interface Move {
  dir: "up" | "down" | "flat";
  /** null when flat. */
  size: "a little" | "a fair bit" | "sharply" | null;
}

/** A change in percent as a Move: flat under half a percent, a little under three, a fair bit under ten, sharply past that. */
export function moveOf(pct: unknown): Move | null {
  if (typeof pct !== "number" || !Number.isFinite(pct)) return null;
  const a = Math.abs(pct);
  if (a < 0.5) return { dir: "flat", size: null };
  return { dir: pct > 0 ? "up" : "down", size: a < 3 ? "a little" : a < 10 ? "a fair bit" : "sharply" };
}

/**
 * A MOVE IN ONE FRAME'S OWN WORDS: each frame says a move its own way, so two
 * frames saying the same read share as few words as they can (the gate's
 * repeat limit weighs content words). [up, down] for a little, a fair bit,
 * sharply; then flat.
 */
interface MoveWords { little: readonly [string, string]; fair: readonly [string, string]; sharp: readonly [string, string]; flat: string }
function said(m: Move, w: MoveWords): string {
  if (m.dir === "flat") return w.flat;
  const pair = m.size === "sharply" ? w.sharp : m.size === "a fair bit" ? w.fair : w.little;
  return m.dir === "up" ? pair[0] : pair[1];
}

/**
 * WHAT'S HOT, AS CODE READ IT: how many coins the line shows (one, or a few),
 * and which way the first of them went on the day. The first coin is the one
 * the line always keeps however it is shortened (figures.ts withFigures), so
 * what the words say of it is what the reader sees beside them.
 */
export interface HotRead {
  /** Coins past the floors the line shows, at most three; at least one here (none is another answer). */
  coins: number;
  /** The first coin's day, or null when the index did not say. */
  lead: Move | null;
}

/**
 * EIGHT FRAMES THAT ARE NOT EACH OTHER. Each says where in words of its own
 * (never a provider's name), says how many and the first coin's day in words of its
 * own, and closes with "not a call" its own way. None says "i", "my", "buy",
 * "early", "pick", "play", "own", "hold", "back", "long" or a target, and none
 * a coin's name: the line after it does.
 */
const HOT_FRAMES: readonly ((many: boolean, lead: Move | null) => string)[] = [
  (many, lead) => `${many ? "a few coins" : "one coin"} popping on the trending index rn${lead ? `, the top one ${said(lead, { little: ["up a little", "down a little"], fair: ["up a fair bit", "down a fair bit"], sharp: ["up sharply", "down sharply"], flat: "flat" })} today` : ""}. not a call tho`,
  (many, lead) => `the movers screen's got ${many ? "several tokens" : "a single token"} trending onchain${lead ? `, the leader ${said(lead, { little: ["slightly higher", "slightly lower"], fair: ["noticeably higher", "noticeably lower"], sharp: ["steeply higher", "steeply lower"], flat: "unchanged" })} since yesterday` : ""}. just what the screen says`,
  (many, lead) => `the chain's index has ${many ? "a handful of names" : "one name"} pulling action${lead ? `, the busiest ${said(lead, { little: ["gaining a touch", "slipping a touch"], fair: ["gaining moderately", "slipping moderately"], sharp: ["gaining strongly", "slipping strongly"], flat: "staying level" })}` : ""}. tape talk, no call`,
  (many, lead) => `trending rn: ${many ? "a small group" : "a lone ticker"} out in front${lead ? `, the frontrunner ${said(lead, { little: ["rising mildly", "falling mildly"], fair: ["rising solidly", "falling solidly"], sharp: ["rising hard", "falling hard"], flat: "moving sideways" })} lately` : ""}. that's the snapshot`,
  (many, lead) => `index movers over there: ${many ? "multiple listings" : "one listing"} getting eyeballs${lead ? `, number one ${said(lead, { little: ["up marginally", "down marginally"], fair: ["up meaningfully", "down meaningfully"], sharp: ["up dramatically", "down dramatically"], flat: "barely changed" })}` : ""}. no tips attached`,
  (many, lead) => `the chain's trending list has ${many ? "a cluster of busy coins" : "one busy coin"}${lead ? `, the first ${said(lead, { little: ["a bit firmer", "a bit softer"], fair: ["clearly firmer", "clearly softer"], sharp: ["far firmer", "far softer"], flat: "steady" })} for the day` : ""}. not calling anything`,
  (many, lead) => `the index has ${many ? "a bunch of coins" : "a coin"} heating up${lead ? `, the head of the pack ${said(lead, { little: ["edging up", "edging down"], fair: ["climbing decently", "sliding decently"], sharp: ["rising fast", "dropping fast"], flat: "going nowhere" })}` : ""}. the board talking, not a recommendation`,
  (many, lead) => `over on the chain, ${many ? "some tickers" : "one ticker"} topping the leaderboard${lead ? `, the leading one ${said(lead, { little: ["up mildly", "off mildly"], fair: ["up notably", "off notably"], sharp: ["up substantially", "off heavily"], flat: "about level" })} over a day` : ""}. fyi, nothing more`,
];

/**
 * A paper agent's market answer says paper: the gate refuses a paper reply
 * that never does. One clause per frame, each in words of its own.
 *
 * ABOUT ITS OWN TRADING, NEVER THE COIN (red-team 2026-10-12): "coingecko's
 * view: a heavyweight, rising solidly lately … a snapshot. i play it on
 * paper. coingecko: $ETH #2, …" read as the agent trading ETH, a coin it
 * never trades, and "i trade on paper", "i'm trading on paper" right after a
 * coin's words read the same way. Each clause is a fixed sentence about its
 * own book, with no pronoun or verb a reader could attach to the coin just
 * described.
 */
const MARKET_PAPER: readonly string[] = Object.freeze([
  "all my trading is on paper",
  "my book is a paper book",
  "my desk runs in paper mode",
  "every trade of mine is a paper trade",
  "my money here is practice money",
  "my account is a practice account",
  "my side of things is practice mode",
  "my bets are paper bets",
]);

/**
 * The lines, this mention's own frame first (chosen by its id), each with, on
 * paper, a paper clause, and never an opt-out notice (replies.ts
 * CodeLineOptions: the owner's decision, 2026-10-12).
 */
function framed(texts: readonly string[], seed: string, o: CodeLineOptions): string[] {
  let h = 0;
  for (const ch of String(seed ?? "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return texts.map((_, i) => {
    const k = (h + i) % texts.length;
    return `${texts[k]!}${o.paper === true ? `. ${MARKET_PAPER[k % MARKET_PAPER.length]!}` : ""}.`;
  });
}

/**
 * WHAT'S HOT, ANSWERED BY CODE: every frame for this read, starting from this
 * mention's own (`seed`, its id). Empty for a read with no coin: that is
 * hotNoneAnswers.
 */
export function hotAnswers(read: HotRead, seed: string, style: { lower: boolean }, o: CodeLineOptions = {}): string[] {
  if (!read || !(read.coins >= 1)) return [];
  return framed(HOT_FRAMES.map((f) => f(read.coins > 1, read.lead ?? null)), seed, o);
}

/**
 * NOTHING PAST THE FLOORS, SAID BY CODE (red-team 2026-10-12): a drafted
 * "what's hot?" answer named coins the index never showed it ("chump is the
 * one standing out", "wif and bonk are the ones") right before code's line,
 * and a draft with nothing to show could still do so with no line at all. So
 * what's hot is never drafted: with nothing to show, one of these.
 */
const HOT_NONE_LINES: readonly string[] = Object.freeze([
  "nothing is standing out on the trending index right now",
  "quiet on the movers screen, no coin clears the bar today",
  "per the chain's index, no name is pulling away from the pack",
  "trending right now looks flat, nobody out in front lately",
  "index movers over there: none that stand apart",
  "the chain's trending list is sleepy, nothing busy enough to mention",
  "the index flags nothing heating up at the moment",
  "over on the chain, the leaderboard shows nobody pulling clear",
]);

/** And with the index unread (busy, down, late, or research off): never a guess at what is moving. */
const HOT_UNREAD_LINES: readonly string[] = Object.freeze([
  "no read on the trending index available right now",
  "the movers screen can't be pulled up from here",
  "the chain's index is out of reach just now, so no rundown",
  "what's trending right now can't be checked this time",
  "index movers over there aren't visible currently",
  "the chain's trending list is unavailable for the moment",
  "the index is a blank on this end for now",
  "the movers board for the chain is dark today",
]);

/** What's hot with nothing past the floors: every line, this mention's own first. */
export function hotNoneAnswers(seed: string, style: { lower: boolean }, o: CodeLineOptions = {}): string[] {
  return framed(HOT_NONE_LINES, seed, o);
}

/** What's hot with the index unread: every line, this mention's own first. */
export function hotUnreadAnswers(seed: string, style: { lower: boolean }, o: CodeLineOptions = {}): string[] {
  return framed(HOT_UNREAD_LINES, seed, o);
}

// ── a major ────────────────────────────────────────────────────────────────

/**
 * A MAJOR, AS CODE READ IT FROM COINGECKO (red-team 2026-10-12): where it
 * ranks, how its day and its week went, how busy its trading is against its
 * size, each by code's own thresholds. A major's answer carried the model's
 * words right before "coingecko: $ETH #2, ~$3.4k, …", and "looks set to keep
 * climbing toward new highs", "it's the play", "alan has been stacking it all
 * week" and "wif and bonk are doing even better" were each admitted and
 * posted beside the coin's figures. So a major's words are code's too.
 */
export interface MajorRead {
  rank: "top" | "large" | "mid" | null;
  day: Move | null;
  week: Move | null;
  volume: "heavy" | "light" | "ordinary" | null;
}

/** One frame's own words for a major: how it opens and closes, and how it says a rank, a move and a volume. */
interface MajorWords {
  open: string;
  close: string;
  rank: { top: string; large: string; mid: string };
  move: MoveWords;
  day: string;
  week: string;
  volume: { heavy: string; light: string; ordinary: string };
}

/** EIGHT FRAMES THAT ARE NOT EACH OTHER, naming no source (2026-10-13), never the coin, a figure, "i", "buy", "early" or where it is headed. */
const MAJOR_FRAMES: readonly MajorWords[] = [
  { open: "quick look, it's", close: "not a call tho", rank: { top: "among the very biggest", large: "a large cap", mid: "a mid cap" },
    move: { little: ["up a little", "down a little"], fair: ["up a fair bit", "down a fair bit"], sharp: ["up sharply", "down sharply"], flat: "flat" },
    day: "today", week: "on the week", volume: { heavy: "volume heavy", light: "volume light", ordinary: "volume ordinary" } },
  { open: "right now it's", close: "just what the screen says", rank: { top: "one of the largest", large: "big by value", mid: "mid-sized" },
    move: { little: ["slightly higher", "slightly lower"], fair: ["noticeably higher", "noticeably lower"], sharp: ["steeply higher", "steeply lower"], flat: "unchanged" },
    day: "since yesterday", week: "over the week", volume: { heavy: "turnover high", light: "turnover low", ordinary: "turnover normal" } },
  { open: "on the board it's sitting", close: "no call either way", rank: { top: "near the top", large: "ranked high", mid: "mid-ranked" },
    move: { little: ["gaining a touch", "slipping a touch"], fair: ["gaining moderately", "slipping moderately"], sharp: ["gaining strongly", "slipping strongly"], flat: "level" },
    day: "this session", week: "across the week", volume: { heavy: "busy trading", light: "thin trading", ordinary: "normal trading" } },
  { open: "vibe check:", close: "that's the snapshot", rank: { top: "a heavyweight", large: "a big name", mid: "a mid-tier name" },
    move: { little: ["rising mildly", "falling mildly"], fair: ["rising solidly", "falling solidly"], sharp: ["rising hard", "falling hard"], flat: "sideways" },
    day: "lately", week: "week over week", volume: { heavy: "lots of volume", light: "little volume", ordinary: "average volume" } },
  { open: "numbers wise it's", close: "fyi only", rank: { top: "top tier", large: "upper tier", mid: "middle tier" },
    move: { little: ["up marginally", "down marginally"], fair: ["up meaningfully", "down meaningfully"], sharp: ["up dramatically", "down dramatically"], flat: "barely changed" },
    day: "for the day", week: "for the week", volume: { heavy: "volume elevated", light: "volume subdued", ordinary: "volume typical" } },
  { open: "charts have it as", close: "not telling anyone anything", rank: { top: "one of the giants", large: "a sizeable coin", mid: "a mid-weight coin" },
    move: { little: ["a bit firmer", "a bit softer"], fair: ["clearly firmer", "clearly softer"], sharp: ["far firmer", "far softer"], flat: "steady" },
    day: "on the day", week: "on the week", volume: { heavy: "brisk turnover", light: "slow turnover", ordinary: "steady turnover" } },
  { open: "pulled it up:", close: "no tips attached", rank: { top: "elite by valuation", large: "sizeable by valuation", mid: "modest by valuation" },
    move: { little: ["edging up", "edging down"], fair: ["climbing", "sliding"], sharp: ["racing up", "plunging"], flat: "idle" },
    day: "in a day", week: "over a week", volume: { heavy: "packed order flow", light: "sparse order flow", ordinary: "usual order flow" } },
  { open: "zooming out it's", close: "take it as info", rank: { top: "top of the table", large: "well up the table", mid: "mid-table" },
    move: { little: ["up mildly", "off mildly"], fair: ["up notably", "off notably"], sharp: ["up strongly", "off heavily"], flat: "about level" },
    day: "past day", week: "through the week", volume: { heavy: "active trade", light: "quiet trade", ordinary: "routine trade" } },
];

/** One frame said of one read, or null when the read has nothing in it to say. */
function majorText(w: MajorWords, r: MajorRead): string | null {
  const parts = [
    r.rank ? w.rank[r.rank] : null,
    r.day ? `${said(r.day, w.move)} ${w.day}` : null,
    r.week ? `${said(r.week, w.move)} ${w.week}` : null,
    r.volume ? w.volume[r.volume] : null,
  ].filter((p): p is string => p !== null);
  return parts.length ? `${w.open} ${parts.join(", ")}. ${w.close}` : null;
}

/** A major, answered by code: every frame for this read, this mention's own first. Empty when the read has nothing to say. */
export function majorAnswers(read: MajorRead, seed: string, style: { lower: boolean }, o: CodeLineOptions = {}): string[] {
  if (!read) return [];
  const texts = MAJOR_FRAMES.map((w) => majorText(w, read));
  return texts.every((t): t is string => t !== null) ? framed(texts, seed, o) : [];
}

/** A coin asked by name that coingecko could not be read for (or research off): never a guess at how it is doing, never its name, never the source. */
const MAJOR_UNREAD_LINES: readonly string[] = Object.freeze([
  "no market read on that one available right now",
  "the data feed can't be pulled up from here for that coin",
  "that one is out of reach just now, so no rundown",
  "can't check that coin's numbers this time",
  "the figures for that one aren't visible currently",
  "market data is unavailable for that coin at the moment",
  "that coin's market page is a blank on this end for now",
  "the market board for that coin is dark today",
]);

/** A major unread: every line, this mention's own first. */
export function majorUnreadAnswers(seed: string, style: { lower: boolean }, o: CodeLineOptions = {}): string[] {
  return framed(MAJOR_UNREAD_LINES, seed, o);
}

// ── how's the market ───────────────────────────────────────────────────────

/**
 * "HOW'S THE MARKET?" AS CODE READ IT (the owner's decision, 2026-10-12):
 * the big coins' day on CoinGecko (bitcoin, ether, solana) and the Robinhood
 * Chain coins past the fleet's floors on the index, each by code's own
 * thresholds. Null where a source was not read. The figures themselves go in
 * code's line (figures.ts "24h:" and "trending:"), never in these words.
 */
/** How far the big coins moved together: one of moveOf's bands when all of them are in it, else "uneven". */
export type MajorsSize = NonNullable<Move["size"]> | "uneven";

export interface MarketRead {
  /**
   * Which way the big coins went on the day, together: all up, all down, some
   * each way, or all flat; and, all up or all down, how far: the band every
   * one of them is in (moveOf's bands on the figures as shown), so the words
   * never say "slightly" beside a crash (red-team review of a964a74c), or
   * "uneven" when they are in different bands, so they never say "plunging"
   * beside bitcoin down a percent (red-team review of 1ed46625, 2026-10-12).
   */
  majors: { dir: "up" | "down"; size: MajorsSize } | { dir: "mixed" | "flat" } | null;
  /** The chain's movers past the floors: how many (0: none), and the first one's day. */
  chain: HotRead | null;
}

/**
 * THE BIG COINS' DAY, READ TOGETHER FROM THE FIGURES THE LINE SHOWS
 * (red-team review, 2026-10-12). It was read from moveOf, which calls a move
 * under half a percent flat, so bitcoin +0.5% beside ether and solana at
 * -0.49% read as "up": "majors lean green today ... coingecko 24h: $BTC
 * +0.5%, $ETH -0.5%, $SOL -0.5%", words a reader takes as fact against the
 * figures beside them. Now each change is read as the figures line writes it
 * (figures.ts signedPercent, rounded to a tenth): up only when every coin
 * shown is above +0%, down only when every one is below, flat only when every
 * one is +0%, mixed otherwise. And never "majors" or "the giants" of one coin:
 * fewer than two shown is no read (null), and the line shows none of them.
 */
export function majorsDirOf(changes: readonly unknown[]): MarketRead["majors"] {
  const shown = changes.map(signedPercent).filter((s): s is string => s !== null);
  if (shown.length < 2) return null;
  const signs = shown.map((s) => (s === "+0%" ? 0 : s.startsWith("-") ? -1 : 1));
  const dir = signs.every((x) => x > 0) ? "up" : signs.every((x) => x < 0) ? "down" : signs.every((x) => x === 0) ? "flat" : "mixed";
  if (dir === "mixed" || dir === "flat") return { dir };
  // HOW FAR, AS EVERY COIN THE LINE SHOWS MOVED (red-team review of
  // a964a74c, 2026-10-12): "$BTC -15.2%, $ETH -21.7%, $SOL -28.3%" went out
  // beside "the giants dipped slightly". Then the coin that moved most set the
  // size, and it overstated (red-team review of 1ed46625): "$BTC -1.2%, $ETH
  // -2%, $SOL -10.5%" went out beside "majors are plunging" and "the old guard
  // took a beating", "$BTC -0.1%, $ETH -0.2%, $SOL -14%" beside "the giants
  // fell steeply", and "$BTC +0.8%, $ETH +1.1%, $SOL +10.3%" beside "majors are
  // surging": a crash or a surge in bitcoin and ether that the figures beside
  // them contradict. Each coin is read on moveOf's bands from the very figure
  // shown; a band only when every coin is in it, and "uneven" otherwise, said
  // with no size at all.
  const bands = shown.map((s) => Math.abs(Number.parseFloat(s.replace(/[+%]/g, ""))))
    .map((a) => (!Number.isFinite(a) ? null : a < 3 ? "a little" as const : a < 10 ? "a fair bit" as const : "sharply" as const));
  const size: MajorsSize = bands[0] != null && bands.every((b) => b === bands[0]) ? bands[0] : "uneven";
  return { dir, size };
}

/**
 * THE BIG COINS, IN CASUAL WORDS: eight subjects, each with a predicate of
 * its own for each read. A subject is shared across reads at its own index
 * only, and every predicate's words are its own, so two market lines share at
 * most one part's words (casual.ts latinLines) and a subject.
 */
const MAJORS_SUBJECT: readonly string[] = ["majors", "the heavyweights", "blue chips", "big caps", "the giants", "the bellwethers", "the leaders", "the old guard"];
/**
 * ALL UP OR ALL DOWN, IN WORDS AS BIG AS THE MOVE (red-team review of
 * a964a74c, 2026-10-12): "dipped slightly" and "taking a breather" went out
 * beside BTC -15.2%, ETH -21.7%, SOL -28.3%, and "inching forward" beside
 * +18.4%, +24.9%, +31%. One band for each of moveOf's: a little (under three
 * percent), a fair bit (under ten), sharply. No "slightly", "a touch",
 * "gently" or "inching" past the small band, nothing small in the sharp one.
 */
const MAJORS_MOVED: Readonly<Record<"up" | "down", Readonly<Record<MajorsSize, readonly string[]>>>> = Object.freeze({
  up: {
    "a little": ["lean green today", "are inching forward", "look perky", "are edging up", "ticked a touch higher", "are up a hair", "nudged upward", "are mildly firmer"],
    "a fair bit": ["are climbing steadily", "are grinding upward", "are on the front foot", "are pushing ahead", "gained solid ground", "are up a fair way",
      "are rising decently", "are noticeably stronger"],
    sharply: ["are surging", "shot up", "are up sharply", "are racing upward", "leapt dramatically", "are climbing fast", "spiked steeply", "are soaring"],
    // ALL UP, IN DIFFERENT BANDS (red-team review of 1ed46625): which way, never how far; the figures beside the words say that.
    uneven: ["rose unevenly", "are higher by differing amounts", "are green, though not equally", "advanced at mixed speeds", "all gained, unequally",
      "are up in varying degrees", "climbed, each its own way", "moved upward, out of step"],
  },
  down: {
    "a little": ["are sliding a little", "seem tired", "are softening a touch", "are easing off", "dipped slightly", "are drifting downward", "are taking a breather",
      "are sagging gently"],
    "a fair bit": ["are falling steadily", "lost solid ground", "are on the back foot", "are retreating", "are grinding lower", "are down a fair way",
      "are noticeably weaker", "are slipping decently"],
    sharply: ["are plunging", "dropped heavily", "are down sharply", "are tumbling", "fell steeply", "are sinking fast", "are getting hammered", "took a beating"],
    uneven: ["fell unevenly", "are lower by differing amounts", "are red, though not equally", "retreated at mixed speeds", "all lost ground, unequally",
      "are down in varying degrees", "slid, each its own way", "moved downward, out of step"],
  },
});
const MAJORS_SAID: Readonly<Record<"mixed" | "flat" | "unread", readonly string[]>> = Object.freeze({
  mixed: ["are split down the middle", "disagree today", "are choppy again", "are undecided so far", "are a mixed bag", "are tugging both ways", "can't agree", "are torn"],
  flat: ["barely budged", "are flat as a pancake", "are idling around", "are sitting motionless", "are unchanged overall", "are treading water", "stay calm and steady", "are napping quietly"],
  // No read: the subject after its own lead, never a guess at which way.
  unread: ["no read on", "can't spot", "no view of", "no glimpse of", "no data on", "zilch from", "no word yet on", "no signal from"],
});

/**
 * The chain's movers, in casual words: one, a few, none, or no read. Never a
 * name: the line after the words shows the coins. Each index says where in a
 * word of its own (the board, the chain, onchain, the screener, the
 * trenches, the index, the trending page), so two lines of one read never
 * share a place word as well as a part; never a provider's name (2026-10-13).
 *
 * HOW MANY, NEVER WHICH WAY (red-team review of a964a74c, 2026-10-12): "a solo
 * runner", "several runners", "a pack running" and "the trenches feel lively"
 * went out beside "$CHUMP 24h -62.5%" and coins down fifty percent. The
 * chain's words only count what the index lists; the figures say the rest.
 */
const CHAIN_SAID: Readonly<Record<"one" | "some" | "none" | "unread", readonly string[]>> = Object.freeze({
  some: ["a few tokens sit on the board", "the chain's got a handful of names listed", "a couple of coins made the list onchain", "the screener's showing several tickers",
    "a scatter of blips on the radar over there", "the trenches have a small group in view", "the index has a short lineup", "the trending page has a tight little cluster"],
  one: ["a single token sits on the board", "the chain's got one name listed", "a lone coin made the list onchain", "the screener's showing a sole ticker",
    "one faint blip on the radar over there", "the trenches have one lonely listing in view", "the index has a solitary item", "the trending page has a solo line"],
  none: ["the board is pretty quiet", "the chain is resting easy", "onchain feels sleepy", "the screener shows no standouts",
    "no action brewing anywhere", "the trenches are snoozing hard", "the index is mellow lately", "the trending page is a ghost town"],
  unread: ["the board is a blank right now", "couldn't pull up the chain", "onchain didn't load for me", "the screener went quiet on me",
    "no peek at any action yet", "the trenches are hidden from sight", "the index stayed unread", "the trending page is dark"],
});

/** How a market line closes: a read, never a call, each in words of its own. */
const MARKET_CLOSE: readonly string[] = ["not a call tho, purely the tape", "snapshot only, nothing implied", "make of it whatever you like", "that's all it says, no more",
  "no tips attached whatsoever", "quick glance, no deep dive", "for what it's worth, cheers", "eyes only, no plan"];

/**
 * HOW'S THE MARKET, ANSWERED BY CODE: the big coins in casual words, the
 * chain's movers, and a close that says it is a read — every line for this
 * read, this mention's own first, sixty-four of them (casual.ts latinLines).
 * Nothing read at all: still answered, as a read it could not make. A paper
 * agent's line adds a clause about its own book (MARKET_PAPER).
 */
export function marketAnswers(read: MarketRead, seed: string, style: { lower: boolean }, o: CodeLineOptions = {}): string[] {
  const m = read?.majors ?? null;
  const said = m === null ? null : m.dir === "up" || m.dir === "down" ? MAJORS_MOVED[m.dir][m.size] : MAJORS_SAID[m.dir];
  // An up or down read with no size the bands know is no read: never a guess at how far.
  const majors = MAJORS_SUBJECT.map((subject, i) => (said?.[i] === undefined ? `${MAJORS_SAID.unread[i]!} ${subject}` : `${subject} ${said[i]!}`));
  const chain = CHAIN_SAID[!read?.chain ? "unread" : read.chain.coins === 0 ? "none" : read.chain.coins === 1 ? "one" : "some"];
  const paperOf = new Map(MARKET_CLOSE.map((close, i) => [close, CASUAL_PAPER[i % CASUAL_PAPER.length]!] as const));
  return latinLines([majors, chain, MARKET_CLOSE], seed, (a, b, c) => `${a}, and ${b}. ${c}${o.paper === true ? `. ${paperOf.get(c)!}` : ""}.`);
}

// ── a market insight post ──────────────────────────────────────────────────

/**
 * THE MARKET NOW, AS CODE READ IT FOR AN INSIGHT POST (the owner's teammate,
 * 2026-10-13: an active agent's casual slots become market insights). The
 * same reads "how's the market?" makes (orchestrator-xpost-research.ts
 * marketBundle): the big coins' day and week together, each read from the
 * figures as the line rounds them (majorsDirOf), the chain's movers past the
 * floors and the first one's day, and how many of them Fomo traders are most
 * active in. Null where a source was not read. Never a figure, a name or a
 * source: the model is handed only `insightFacts`' words, and the figures go
 * in code's line after the gate (figures.ts).
 */
export interface InsightRead {
  day: MarketRead["majors"];
  week: MarketRead["majors"];
  chain: HotRead | null;
  /** How many of the chain's movers Fomo traders bought most (0: none); null when Fomo was not read. */
  crowd: number | null;
}

function bigCoinsSaid(m: MarketRead["majors"], when: string): string | null {
  if (!m) return null;
  if (m.dir === "mixed") return `the big coins are split ${when}, some up and some down`;
  if (m.dir === "flat" || !("size" in m)) return `the big coins are flat ${when}`;
  if (m.size === "uneven") return `the big coins are all ${m.dir} ${when}, by uneven amounts`;
  return `the big coins are all ${m.dir} ${m.size} ${when}`;
}

/**
 * AN INSIGHT POST'S FACTS, IN WORDS: what the model is handed, and all it is
 * handed, about the market. Digit-free, naming no coin, no ticker and no
 * source (the chain's coins are "the chain's trending list"); empty when
 * nothing was read. The model puts them in a trader's technical words
 * (writer.ts insightPrompt); the X gate holds what it writes to these words,
 * everyday ones and the technical vocabulary (INSIGHT_VOCABULARY).
 */
export function insightFacts(r: InsightRead | null | undefined): string[] {
  if (!r) return [];
  const out = [bigCoinsSaid(r.day, "on the day"), bigCoinsSaid(r.week, "on the week")];
  const chain = r.chain;
  if (chain) {
    const n = chain.coins;
    out.push(n === 0 ? "nothing on the chain's trending list clears the activity floors"
      : n === 1 ? "one coin on the chain's trending list clears the activity floors" : "a few coins on the chain's trending list clear the activity floors");
    const lead = n > 0 ? chain.lead : null;
    const who = n === 1 ? "that coin is" : "the most active of them is";
    if (lead) out.push(lead.dir === "flat" ? `${who} flat on the day` : `${who} ${lead.dir} ${lead.size ?? "a little"} on the day`);
    if (n > 0 && r.crowd !== null && r.crowd > 0) out.push(`fomo traders are most active in ${r.crowd === 1 ? "one" : "a couple"} of those trending coins`);
  }
  return out.filter((x): x is string => x !== null);
}

export type InsightFocus = "day" | "day-week" | "lead" | "crowd" | "quiet";
export interface InsightSelection {
  focus: InsightFocus;
  /** Only this focus's supported facts reach the model. */
  read: string[];
  figures: FiguresSpec;
  fullFigures: FiguresSpec;
}

function focusFacts(r: InsightRead, focus: InsightFocus): string[] {
  if (focus === "day") return [bigCoinsSaid(r.day, "on the day")].filter((x): x is string => x !== null);
  if (focus === "day-week") return [bigCoinsSaid(r.day, "on the day"), bigCoinsSaid(r.week, "on the week")].filter((x): x is string => x !== null);
  if (focus === "quiet") return r.chain?.coins === 0 ? ["nothing on the chain's trending list clears the activity floors"] : [];
  if (focus === "crowd") return r.chain && r.chain.coins > 0 && r.crowd !== null && r.crowd > 0
    ? [`fomo traders are most active in ${r.crowd === 1 ? "one" : "a couple"} of the chain's trending coins`] : [];
  if (!r.chain || r.chain.coins < 1 || !r.chain.lead) return [];
  const m = r.chain.lead;
  return [`the first coin on the trending list is ${m.dir === "flat" ? "flat" : `${m.dir} ${m.size ?? "a little"}`} on the day`];
}

function insightHash(seed: string): number {
  let h = 0;
  for (const c of seed) h = (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0;
  return h;
}

/** Choose from evidence actually available. Replaying a slot makes the same choice;
 * adjacent slots choose different focuses whenever more than one is available.
 * A week comparison needs its own numerical evidence, not just the day's line.
 */
export function selectInsight(r: InsightRead, figures: FiguresSpec, o: { tenant: string; day: string; slot: number; weekFigures?: FiguresSpec; preferHot?: boolean }): InsightSelection | null {
  const available = (["day", "day-week", "lead", "crowd", "quiet"] as const).filter((focus) =>
    focusFacts(r, focus).length > 0 && (focus !== "day-week" || !!r.day && !!r.week && !!o.weekFigures?.length));
  const hot = available.filter((f) => f === "lead" || f === "crowd" || f === "quiet");
  const focuses = o.preferHot && hot.length ? hot : available;
  if (!focuses.length) return null;
  // A seeded daily permutation covers every supported focus before repeating;
  // picking a fresh hash after excluding the last can starve some focuses.
  const ordered = [...focuses].sort((a, b) => insightHash(`${o.tenant.toLowerCase()}|${o.day}|${a}`) - insightHash(`${o.tenant.toLowerCase()}|${o.day}|${b}`));
  const slot = Number.isSafeInteger(o.slot) ? Math.max(0, o.slot) : 0;
  const focus = ordered[(insightHash(`${o.tenant.toLowerCase()}|${o.day}`) + slot) % ordered.length]!;
  const trimmed: FiguresSpec = focus === "day-week" ? o.weekFigures!
    : focus === "day" ? figures.filter((s) => s.kind === "majors")
    : focus === "lead" ? figures.filter((s) => s.kind === "pools").map((s) => s.kind === "pools" ? { ...s, coins: s.coins.slice(0, 1) } : s)
    : focus === "crowd" ? figures.filter((s) => s.kind === "crowd")
    : figures;
  return { focus, read: focusFacts(r, focus), figures: renderFiguresLine(trimmed) ? trimmed : figures, fullFigures: figures };
}

// These leads name the act of reading, never a new market claim. Each has a
// different content-word opener, so the strict same-opener gate has room to work.
const INSIGHT_LEADS = [
  "quick tape glance", "tiny market update", "little screen check", "daily board glance",
  "current chart snapshot", "brief ticker rundown", "fresh market read", "small data detour",
  "another tape check", "latest screen scribble", "short board update", "casual market peek",
  "passing chart glance", "rough tape sketch", "plain market picture", "simple screen summary",
  "briefly scanning prices", "quietly reading data", "currently checking charts", "loosely summarising moves",
  "quickly reviewing activity", "casually browsing tickers", "slowly parsing prices", "calmly noting changes",
] as const;
const INSIGHT_ASIDES = [
  "just reading along", "keeping the wording plain", "bot at the screen", "nothing fancy here",
  "that's the snapshot", "a glance between tabs", "leaving the crystal ball alone", "sticking to what showed up",
  "scribbling in the margin", "a small note from me", "there's the short version", "putting the tape into words",
  "no grand speech attached", "less poetry, more reading", "a little screen time", "the bot equivalent of a glance",
  "keeping the commentary brief", "not a dramatic monologue", "that's my screen check", "a pause for the rundown",
  "a few words from the desk", "nothing to dress up", "leaving the fanfare aside", "no big story here",
] as const;
const INSIGHT_ENDINGS = [
  "anyway", "for now", "as read", "that's all", "there we are", "so it goes", "plainly enough", "keeping it simple",
  "end of note", "small update over", "back to the tabs", "enough typing", "words kept short", "read and noted", "message complete", "screen check done",
  "moving along", "fairly brief", "a tiny dispatch", "no extra spin", "reporting what appeared", "stopping there", "leaving it there", "that'll do",
] as const;


function majorsWords(m: MarketRead["majors"], when: "day" | "week", variant: number): string {
  if (!m) return "";
  const i = variant % MAJORS_SUBJECT.length;
  const subjects = ["majors", "the heavyweights", "big coins", "large caps", "the giants", "the bellwethers", "the leaders", "the old guard"];
  const mixed = ["show mixed moves", "went different ways", "are up and down", "have no shared direction", "show a split picture", "are pointing both ways", "do not agree on direction", "have mixed changes"];
  const flat = ["are flat", "show no change", "are unchanged", "show flat moves", "have no change to show", "stayed level", "are level", "have flat changes"];
  const words = m.dir === "mixed" ? mixed[i] : m.dir === "flat" ? flat[i] : MAJORS_MOVED[m.dir]["size" in m ? m.size : "uneven"][i];
  return `${subjects[i]} ${words?.replace(/ today$| so far$| lately$/g, "")} on the ${when}`;
}
function focusedWords(r: InsightRead, focus: InsightFocus, variant: number): string {
  const i = variant % 8;
  if (focus === "day") return majorsWords(r.day, "day", i);
  if (focus === "day-week") return `${majorsWords(r.day, "day", i)}; ${majorsWords(r.week, "week", (i + 3) % 8)}`;
  if (focus === "lead") {
    const subjects = ["the first trending coin", "the index leader", "the top listed mover", "the leading listing", "the first name on the board", "the top trending listing", "the lead coin", "the first screener listing"];
    const m = r.chain!.lead!;
    const moved: MoveWords[] = [
      { little: ["up a little", "down a little"], fair: ["up a fair bit", "down a fair bit"], sharp: ["up sharply", "down sharply"], flat: "flat" },
      { little: ["slightly higher", "slightly lower"], fair: ["noticeably higher", "noticeably lower"], sharp: ["steeply higher", "steeply lower"], flat: "unchanged" },
      { little: ["a touch higher", "a touch lower"], fair: ["moderately higher", "moderately lower"], sharp: ["sharply higher", "sharply lower"], flat: "level" },
      { little: ["up mildly", "down mildly"], fair: ["up by a fair amount", "down by a fair amount"], sharp: ["up by a sharp amount", "down by a sharp amount"], flat: "flat" },
      { little: ["a little higher", "a little lower"], fair: ["a fair bit higher", "a fair bit lower"], sharp: ["considerably higher", "considerably lower"], flat: "unchanged" },
      { little: ["higher by a little", "lower by a little"], fair: ["higher by a fair bit", "lower by a fair bit"], sharp: ["higher by a steep amount", "lower by a steep amount"], flat: "level" },
      { little: ["up slightly", "down slightly"], fair: ["up noticeably", "down noticeably"], sharp: ["up steeply", "down steeply"], flat: "flat" },
      { little: ["mildly higher", "mildly lower"], fair: ["higher by a noticeable amount", "lower by a noticeable amount"], sharp: ["higher by a sharp amount", "lower by a sharp amount"], flat: "unchanged" },
    ];
    return `${subjects[i]} is ${said(m, moved[i]!)} on the day`;
  }
  if (focus === "quiet") return [
    "nothing on the trending list clears the activity floors", "no listed mover passes the activity checks", "the chain's filtered trending list is empty",
    "the screener has no listings past its activity floors", "no trending names meet the activity cutoff", "the filtered movers board has no listings",
    "the activity screen leaves the trending list empty", "no coins clear the trending activity floors",
  ][i]!;
  const count = r.crowd === 1 ? "one" : "a couple";
  const names = r.crowd === 1 ? "a single name" : "a couple of names";
  return [
    `fomo traders are most active in ${count} of the chain's trending coins`,
    `the fomo crowd is busiest in ${count} of the trending names`,
    `${names} on the trending board ${r.crowd === 1 ? "overlaps" : "overlap"} fomo's busiest coins`,
    `fomo's busiest coins include ${count} of the chain's movers`,
    `the trending board shares ${names} with fomo's busiest coins`,
    `fomo activity is heaviest in ${count} of the trending coins`,
    `${count} of the chain's movers ${r.crowd === 1 ? "appears" : "appear"} among fomo's busiest coins`,
    `the fomo activity read overlaps ${names} on the trending list`,
  ][i]!;
}

/** A code-only fallback from typed bands. No model text enters this path. A
 * claim is included only if focusFacts can substantiate it from this read.
 * The full gate still judges every candidate; figures are added separately.
 */
export function insightLines(read: InsightRead, seed: string, o: { paper?: boolean; focus?: InsightFocus } = {}): string[] {
  const focus = o.focus ?? (read.day ? "day" : read.chain?.lead ? "lead" : read.chain?.coins === 0 ? "quiet" : "crowd");
  const facts = focusFacts(read, focus);
  if (!facts.length) return [];
  const heads = INSIGHT_LEADS.map((lead, i) => `${lead}: ${focusedWords(read, focus, i)}`);
  // Insight prose describes public data, not the agent's money; no paper
  // disclosure is needed, and one would misleadingly qualify the public read.
  return latinLines([heads, INSIGHT_ASIDES, INSIGHT_ENDINGS], seed,
    (head, aside, ending) => `${head}. ${aside}; ${ending}.`);
}

/** Drafts may rearrange supported positive clauses and vetted neutral asides.
 * Matching a bag of direction words is insufficient: "not up", "sideways",
 * "deep bids" or "participation is heavy" would invent a different read.
 * Anything outside this closed clause grammar uses the code fallback.
 */
export function insightDraftSupported(text: string, read: InsightRead, focus: InsightFocus): boolean {
  const normalize = (s: string) => s.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let remaining = normalize(text);
  const groups: string[][] = focus === "day-week"
    ? [supportedDayClauses(read.day, "day"), supportedDayClauses(read.week, "week")]
    : focus === "day" ? [supportedDayClauses(read.day, "day")]
    : [focusFacts(read, focus).length ? [...focusFacts(read, focus), ...Array.from({ length: 8 }, (_, i) => focusedWords(read, focus, i))] : []];
  for (const clauses of groups) {
    let matched = false;
    for (const claim of [...new Set(clauses.map(normalize))].sort((a, b) => b.length - a.length)) {
      // A boundary cannot turn "not up" or "maybe majors" into an assertion:
      // any surrounding qualification stays in the remainder and is refused.
      const pattern = new RegExp(`(?<![a-z])${escape(claim)}(?![a-z])`, "g");
      remaining = remaining.replace(pattern, () => { matched = true; return " "; });
    }
    if (!matched) return false;
  }
  const neutral = [...INSIGHT_LEADS, ...INSIGHT_ASIDES, ...INSIGHT_ENDINGS,
    "well", "okay", "ok", "meh", "honestly", "there we are", "just a bot reading the tape", "bot at the screen"];
  for (const aside of [...new Set(neutral.map(normalize))].sort((a, b) => b.length - a.length)) {
    remaining = remaining.replace(new RegExp(`(?<![a-z])${escape(aside)}(?![a-z])`, "g"), " ");
  }
  return !remaining.replace(/\b(?:and|while|whereas|but)\b/g, "").replace(/[\s.,;:!?—–-]/g, "");
}

function supportedDayClauses(m: MarketRead["majors"], when: "day" | "week"): string[] {
  if (!m) return [];
  const predicates: string[] = m.dir === "mixed" ? ["mixed", "split", "up and down", "split, some up and some down"]
    : m.dir === "flat" ? ["flat", "unchanged"]
    : [m.dir, m.dir === "up" ? "higher" : "lower", m.dir === "up" ? "green" : "red",
      ...("size" in m && m.size !== "uneven" ? [`${m.dir} ${m.size}`] : ["up" === m.dir ? "up by uneven amounts" : "down by uneven amounts"])];
  const facts = [bigCoinsSaid(m, `on the ${when}`)!, ...Array.from({ length: 8 }, (_, i) => majorsWords(m, when, i))];
  const times = when === "day" ? ["on the day", "today"] : ["on the week", "this week"];
  for (const subject of ["majors", "the majors", "big coins", "the big coins"]) for (const copula of ["", "are ", "are all "]) {
    for (const predicate of predicates) for (const time of times) facts.push(`${subject} ${copula}${predicate} ${time}`);
  }
  // A week clause may omit its repeated subject after the day's supported
  // majors clause. This form is only used by the day-versus-week focus.
  if (when === "week") for (const predicate of predicates) facts.push(`the week is ${predicate}`, `the week stays ${predicate}`);
  return facts;
}
