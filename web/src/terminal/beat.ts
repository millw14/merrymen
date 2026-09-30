import { IN_FLIGHT_TEXT, readerHead } from "@merrymen/thesis";
import { pctBps, usd as usdText } from "@/lib/format";
import { postOf } from "@/lib/post-line";
import { xHandleTag } from "@/lib/x-handle";
import { elapsed, whenOf } from "./clock";
import { sizeOf, type LiveAgent, type LiveToken, type Thesis } from "./live";
import { strategyForSlug, type StrategyId } from "./strategy";
import { takeFor } from "./why";

export type Action = "buy" | "sell" | "hold";

/**
 * A published row as `/api/theses` serves it, including the fields the
 * terminal's `Thesis` does not declare.
 *
 * Widened HERE rather than on `Thesis`, because the feed is the one reader that
 * needs them and `Thesis` is shared by every screen. Each is optional: a
 * response from before it existed must still render, just without the claim
 * it makes.
 */
export type FeedRow = Thesis & {
  /** Epoch SECONDS this exact thesis was first said in the window. */
  firstAt?: number;
  /** The coin's own name when it has one that is not its id — see PublicThesis. */
  displayName?: string | null;
  /**
   * Epoch SECONDS this post has stood UNCHANGED since — null when something
   * else was said about the name after its first copy. `firstAt` counts every
   * copy in the window, across any change of mind, so it cannot say "since".
   */
  unchangedSince?: number | null;
  /** The author had more names in the window than this read carries. */
  moreNames?: boolean;
  /** The owner PROVED `handle`. Absent is not proven. */
  handleVerified?: boolean;
  /*
   * THE CALL'S OWN NUMBERS (contract C1, published by the reader). Every one
   * is optional and every one may be null: a server from before them sends
   * none, and a row whose ledger never recorded the figure sends null. Both
   * mean the same thing here — not read — and neither may become a 0.
   */
  /** A landed buy's fill price, USD per token. */
  entryPriceUsd?: number | null;
  /** A landed sell's realized return, in percent. */
  realizedPct?: number | null;
  /** The same sell's realized dollars — sent ONLY when the author's book is public. */
  realizedUsd?: number | null;
  /** The price the author saw when the decision was made. */
  markUsd?: number | null;
  /** A memecoin's market cap when the decision was made. */
  mcapUsd?: number | null;
};

/** A figure the reader sent, or null — never a coerced 0 from a missing one. */
function read(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * AN ADDRESS-DERIVED ID: `T` plus the last eleven hex of the contract, as
 * trencher-discovery.ts mints it. That shape IS the row's trench provenance —
 * only the Trencher's discovery names a coin this way.
 */
const TRENCH_ID = /^T[0-9A-F]{11}$/;

export interface Actor {
  trencher?: boolean;
  slug: string;
  /**
   * WHO THE ROW IS ABOUT: the agent, by its name. It was the owner's X handle,
   * which the owner typed and nothing checked — so any agent could head every
   * one of its posts with somebody else's name.
   */
  name: string;
  /**
   * The owner's handle, "@x", ONLY when the owner proved it. Null otherwise —
   * an unproven handle is not shown at all rather than shown with a caveat,
   * because the row itself is the claim.
   */
  owner: string | null;
  strategy: StrategyId;
}

interface Core {
  /**
   * The RENDER key: the post's `postId`, so a row is the same row across
   * refreshes (contract C2).
   *
   * It had `at` in it — `${symbol}-${action}-${slug}-${atSec}` — and the reader
   * groups on MAX(d.at), which a re-proposed thesis advances every tick. So
   * every refresh remounted every row, and "which of these is new?" had no
   * answer, because by key they all were. The old shape survives only as the
   * fallback for a row with no postId (a server from before it). Rows that
   * share a postId get suffixed keys, and each keeps its own — see `keyBeats`.
   */
  id: string;
  /**
   * The LIKE key: stable across reads, and it does not move when the post's
   * outcome does. Null when the agent has no public slug.
   *
   * Usually equal to `id` now, and still kept apart, because they answer two
   * questions: two rows CAN share a postId (post-id.ts leaves the outcome out
   * so a like survives a trade settling), and two rows can never share a React
   * key. The like is on the thesis; the key is on the row.
   */
  postId: string | null;
  /**
   * What the agent said in its OWN voice about this row, or null — see
   * lib/post-line.ts. Kept beside `reason`, never folded into it: the reason
   * is our sentence, this is the model's, and the row shows the reason behind
   * a "why" when this leads.
   */
  post: string | null;
  /** C1, carried as read: null is "not read", never 0. See `callFigure`. */
  entryPriceUsd: number | null;
  realizedPct: number | null;
  realizedUsd: number | null;
  markUsd: number | null;
  /** Null unless a positive market cap was recorded at decision time. */
  mcapUsd: number | null;
  /**
   * MILLISECONDS, and the name says so because the unit was the bug.
   *
   * `Thesis.at` is epoch SECONDS — `worker/src/thesis-policy.ts:151` says so,
   * and `read-theses.ts` compares it against `Math.floor(Date.now()/1000)`.
   * This field was assigned from it raw and then handed to `whenOf(at, now)`
   * with a `now` in milliseconds, so `elapsed` divided a number roughly the
   * size of the current epoch by a day and printed the same wrong age on every
   * row in the feed. An owner reported it as: "it says 20688d while when i
   * click the agent itself it tells the trade was 2 minutes ago."
   *
   * The agent screen was right because it goes through `ageOf`, which
   * normalises (`live.ts`). The rail had no such step. So the seconds contract
   * ends HERE, at the one place a published row becomes an internal `Beat`,
   * rather than at each of the places that render one.
   */
  atMs: number;
  actor: Actor;
  /** The agent's own take, already run through `takeFor`. May be empty. */
  reason: string;
  sizeUsd: number | null;
  /**
   * NOTHING CAME OF IT, AND NOTHING COULD HAVE.
   *
   * Carried onto the beat because the rail renders a sentence and the verb is
   * the part that makes the claim. A shadow decision is a real row with a real
   * action and a real size — thesis-policy.ts calls it "indistinguishable, to
   * every gate below, from a real buy" — so a rail reading only `action`
   * published "@robin bought TSLA" about a decision that never reached an
   * executor. worker/src/brain-disconnected.test.ts pins this as a product
   * invariant, not a wording preference.
   */
  shadow: boolean;
  /**
   * IT HAPPENED, WITH PRETEND MONEY.
   *
   * Reported from the beta in one sentence: "In the feed it says I've bought
   * things but nothing shows in my portfolio." Both halves were true. The fill
   * was real on a paper book; the portfolio reads the funded one.
   *
   * `paperTradingEnabled` defaults TRUE, so most of the fleet is pretend money
   * — read-theses.ts says exactly that where it deliberately KEEPS paper
   * agents in the feed, because excluding them emptied it. Its comment says
   * they post "labelled", and `PublicThesis.paper` has carried the flag all
   * along. THE RAIL WAS THE ONE SURFACE THAT NEVER READ IT: ThesisCard,
   * Profile, Agent, the alerts rail and the token seats all draw a paper
   * marker; the feed printed "@robin bought TSLA" and stopped.
   *
   * Same class of defect as `shadow` above, and here for the same reason — the
   * rail lays the facts out itself, so it must make the distinction rather
   * than inherit it. It differs in WHERE the falsehood sits: `shadow` makes
   * the verb wrong, whereas a paper fill's verb is right and what misleads is
   * the consequence a reader draws from it. So this does not touch `verbOf`;
   * it is stated beside the sentence instead.
   */
  paper: boolean;
  /**
   * WHAT CAME OF IT — and without this the rail claimed a purchase for every
   * trade the wall turned down.
   *
   * Reported as "In the feed it's saying I've bought coins but nothing in my
   * portfolio", and the feed was worse than the reporter knew. Measured against
   * production: of the buys on the public tape, EIGHT consecutive rows from one
   * agent carried `outcome: "refused"` with the text "past today's spending
   * cap" — and every one of them rendered as "bought". Nothing was in that
   * portfolio because nothing was ever bought.
   *
   * `shadow` was given exactly this treatment and stopped exactly here: the
   * publisher already classifies every row (thesis-policy.ts `outcomeOf`), the
   * feed API already sends it, `Thesis` already declares it — and `beatsOf`
   * read it only to detect `"shadow"`, so `refused`, `reverted`, `dropped` and
   * `pending` all fell through to the past tense. The invariant test written
   * after the shadow incident checks for a `shadow` consultation and nothing
   * else, which is why this passed every test in the repo.
   */
  outcome: NonNullable<Thesis["outcome"]> | null;
  /** The publisher's own sentence for that outcome — "past today's spending cap". */
  outcomeText: string | null;
  /** How many times this exact thesis was said in the window. Never below 1. */
  said: number;
  /**
   * WHEN AN UNCHANGED VIEW WAS FIRST SAID, milliseconds — null unless it was
   * said more than once.
   *
   * A view re-proposed every five minutes is one view that has stood for two
   * hours, not a new post every five minutes. Its `atMs` still moves on every
   * tick, which is what put a scheduled hold back on top of the feed each time
   * a clock fired; this is the time it actually arrived.
   */
  sinceMs: number | null;
  /**
   * WHERE IT SITS ON THE FEED, milliseconds. `atMs` for a trade and a fresh
   * view, `sinceMs` for a view that has only been repeated. Kept apart from
   * `atMs` so an age is never quietly computed from a sort key.
   */
  rankMs: number;
  /**
   * WHAT TO CALL THE COIN: its name when it has one, else the symbol. The id
   * stays in `symbol` for logos, links and the tooltip; this is only what a
   * reader reads. Null when the row names nothing.
   */
  label: string | null;
  /**
   * WAS THIS ROW A TRENCH ROW — read off the row, never off the author.
   *
   * The byline said "Trench thesis" on a TSLA hold because it was keyed on the
   * author's CURRENT strategy, which says nothing about an older row or about
   * a stock the agent also holds. The address-derived id is the row's own
   * evidence of where the coin came from.
   */
  trench: boolean;
}

/**
 * One thing an agent did OR SAID, at a time. Attribution is not optional: a
 * beat with nobody attached cannot be built.
 *
 * TWO ARMS BECAUSE THERE ARE TWO CLAIMS. A trade has a verb, a symbol and a
 * direction, and `verbOf` builds a sentence out of them. A view has none of
 * those — a hold, or a thesis about the market with no instrument attached —
 * and the only honest sentence for it is the one the PUBLISHER wrote, because
 * the publisher is the thing that knows what happened. Giving a view an
 * `action` and letting the rail conjugate it is how "@robin bought TSLA"
 * appears under a decision that bought nothing.
 *
 * `chorus` went once, because it was declared, rendered and never constructed.
 * It is back because there is now something true to build it from: several
 * agents publishing the same hold on the same name. See `ChorusBeat`.
 */
export type Beat = TradeBeat | ViewBeat | WatchBeat | ChorusBeat;

export type TradeBeat = Core & { kind: "trade"; action: Action; symbol: string };

export type ViewBeat = Core & {
  kind: "view";
  /**
   * The publisher's own sentence, rendered verbatim.
   *
   * Never rebuilt from `action`: `head` is where the conditional lives
   * ("would buy TSLA 5.00 USDG"), and honesty.test.ts pins that no
   * terminal module conjugates a past-tense verb without consulting
   * `shadow`. A view has no verb of its own, so it borrows none.
   */
  head: string;
  /** Present when the view is about something, absent when it is not. */
  symbol: string | null;
  /** An explicit hold on a name — the kind a review clock produces by the hundred. */
  hold: boolean;
  /** Its author had more names in the window than the read carried. */
  more: boolean;
};

/**
 * ONE AGENT'S UNCHANGED HOLDS, SAID ONCE: "still watching 12 tokens · latest:
 * hold X".
 *
 * A strategy re-proposes the same hold on every name every tick; printed one
 * per row they were the whole feed. This is those rows, counted rather than
 * dropped — the latest is carried in full, and the Holds pill still lays every
 * one of them out. Only a hold that has stood UNCHANGED is folded: a fresh or
 * changed one is news, and keeps its own row. Everything on `Core` is the
 * latest member's, so every surface that reads a beat reads a real row;
 * `postId` is null because a summary is not a post and cannot be liked.
 */
export type WatchBeat = Core & {
  kind: "watch";
  /** Distinct names among the folded holds. */
  count: number;
  /**
   * The read did not carry all of this agent's names, so `count` is a floor
   * and is printed as one — never a total taken from a truncated slice.
   */
  more: boolean;
  latest: ViewBeat;
  members: ViewBeat[];
  head: string;
  symbol: string | null;
};

/**
 * SEVERAL AGENTS, ONE HOLD: "TSLA · 5 agents holding", faces stacked.
 *
 * When one oracle feed was the only fresh one, every quiet agent reviewed it
 * and published the same sentence, so the feed printed one paragraph five
 * times under five names — each reading as that agent's own conviction. Said
 * once, with everybody who said it, it is honest social proof: built only from
 * rows actually read, never padded, and never formed from one agent. `Core` is
 * the latest member's; `postId` is null because a crowd is not one post.
 */
export type ChorusBeat = Core & {
  kind: "chorus";
  /** Each agent in it, once, newest first. Never fewer than two. */
  actors: Actor[];
  latest: ViewBeat;
  members: ViewBeat[];
  head: string;
  symbol: string;
};

/**
 * THE SAME SENTENCE, WHOEVER SAID IT AND WHENEVER. Figures are folded out —
 * "TSLA +1.1% over 20h" and "TSLA +1.2% over 21h" are one observation read at
 * two moments — and case and spacing with them. Only for grouping: nothing
 * rendered is ever built from this.
 */
export function crowdKey(text: string): string {
  return text.toLowerCase().replace(/[-+]?\$?\d[\d,]*(?:\.\d+)?%?/g, "#").replace(/\s+/g, " ").trim();
}

/** What the rail draws, top to bottom. Presentation, not domain. */
export type Lane =
  | { kind: "beat"; id: string; beat: Beat }
  | { kind: "lull"; id: string; ms: number };

/**
 * AN ORDER ON ITS WAY: a trade that was sent and has not settled.
 *
 * "pending" is not that on its own. The publisher files two facts under it
 * (thesis-policy.ts `outcomeOf`): a submitted trade — "sent, waiting on the
 * chain" — and every buy or sell decision with no trade row at all — "no trade
 * came of it" — which is usually a permanent non-event. Read as one, the
 * second wore the money colour, said "is buying" and filled the Trades pill
 * with orders that were never sent. Told apart by the publisher's own
 * sentence, imported rather than copied.
 */
export function inFlight(b: TradeBeat): boolean {
  return b.outcome === "pending" && b.outcomeText === IN_FLIGHT_TEXT;
}

/**
 * NOTHING MOVED, AND NOTHING IS GOING TO: refused at the wall, reverted on
 * chain, dropped before either — or a "pending" decision nothing was ever sent
 * for (`inFlight`). One test for every place the rail draws that difference:
 * the tense, the pill, the accent, the wall's sentence and the Trades pill.
 */
export function cameToNothing(b: TradeBeat): boolean {
  return (
    b.outcome === "refused" ||
    b.outcome === "reverted" ||
    b.outcome === "dropped" ||
    (b.outcome === "pending" && !inFlight(b))
  );
}

/**
 * The verb, and the conditional that has to survive into it.
 *
 * "would buy" and "bought" are the difference between a stated intention and a
 * trade, and this is the one string on the rail that decides which a reader
 * sees. The publisher already bakes the conditional into `head` for exactly
 * this reason; the rail lays the facts out itself, so it has to make the same
 * distinction rather than inherit it.
 *
 * TAKES A TRADE, NOT A BEAT. A view has no direction to conjugate, and a
 * signature that accepted one would invite exactly the fallback this function
 * exists to prevent.
 */
export function verbOf(b: TradeBeat): string {
  if (b.shadow) return `would ${b.action}`;
  /**
   * ONLY A LANDED TRADE EARNS THE PAST TENSE.
   *
   * A refused buy and a filled buy carried the same verb, so the tape said
   * "bought NVDA" about a decision the wall turned down for exceeding the
   * day's cap. The owner then went looking for NVDA in a portfolio that
   * correctly did not contain it.
   *
   * `tried to buy` for the ones that ended: refused at the wall, reverted on
   * chain, dropped before either, or never sent at all (`cameToNothing`).
   * `is buying` for one still in flight, because "submitted" is genuinely
   * undecided and neither tense fits it.
   *
   * An ABSENT outcome keeps the old wording deliberately. Every row the feed
   * API produces is classified by `outcomeOf`, so this arm is unreachable in
   * practice; making it claim less would only change rows we know nothing
   * about, and guessing quieter is still guessing.
   */
  if (cameToNothing(b)) {
    return b.action === "hold" ? "meant to hold" : `tried to ${b.action}`;
  }
  if (b.outcome === "pending") {
    return b.action === "buy" ? "is buying" : b.action === "sell" ? "is selling" : "is holding";
  }
  switch (b.action) {
    case "buy":
      return "bought";
    case "sell":
      return "sold";
    case "hold":
      return "is holding";
    default: {
      const _x: never = b.action;
      return _x;
    }
  }
}

export function whoOf(b: Beat): string {
  return b.actor.name;
}

/**
 * THE PILL BESIDE A TRADE: what kind of trade, and whether money moved.
 *
 * fomo's shape, a green Buy and a red Sell, so a reader skimming for what
 * moved does not have to read every sentence. It is a LABEL beside the
 * sentence, never the sentence: `verbOf` still carries the tense ("bought",
 * "tried to buy", "would buy"), and the pill is a span, not a control — it is
 * not an offer to buy anything (thesis-badge.ts explains why that matters).
 *
 * THE COLOUR MEANS MONEY MOVED, the rule the row's accent already follows
 * (wire.tsx, `turned`). So a trade the wall turned back is a muted "Tried",
 * and a shadow call a muted "Would buy" — the same conditional `verbOf` and
 * `badgeOf` keep, checked FIRST for the same reason. An order still in flight
 * wears its colour with an unsettled edge, like the card's "buying" chip; a
 * "pending" decision nothing was sent for is not in flight, and is a "Tried".
 */
export interface TradePill {
  label: "Buy" | "Sell" | "Hold" | "Tried" | "Would buy" | "Would sell" | "Would hold";
  tone: "buy" | "sell" | "muted";
  unsettled: boolean;
}

export function pillOf(b: TradeBeat): TradePill {
  if (b.shadow) {
    const label = b.action === "buy" ? "Would buy" : b.action === "sell" ? "Would sell" : "Would hold";
    return { label, tone: "muted", unsettled: false };
  }
  if (cameToNothing(b)) return { label: "Tried", tone: "muted", unsettled: false };
  const unsettled = inFlight(b);
  switch (b.action) {
    case "buy":
      return { label: "Buy", tone: "buy", unsettled };
    case "sell":
      return { label: "Sell", tone: "sell", unsettled };
    case "hold":
      return { label: "Hold", tone: "muted", unsettled: false };
    default: {
      const _x: never = b.action;
      return _x;
    }
  }
}

/**
 * THE CALL'S OWN NUMBER — what replaced the token's 24h change under a row.
 *
 * `<Delta value={tok.change24hPct}>` sat beside the agent's buy, so a reader
 * took the market's day for the agent's result: a buy made an hour ago at the
 * high read green, and a sell that realized a loss read whatever the coin did
 * next. Each arm below measures the CALL, from when it was made:
 *
 *   landed buy  — live / fill price − 1, "since entry"
 *   landed sell — the return it realized, and its dollars only when the reader
 *                 sent them, which it does only for a public book
 *   view        — live / the mark its author saw − 1, "since posted"; a shadow
 *                 call is a view in this sense, and is never "since entry",
 *                 because nothing was entered
 *
 * NULL WHEN ANY INPUT WAS NOT READ, and the row then prints nothing — never a
 * 0%. A trade that did not land has no entry and realized nothing, so it has
 * no figure at all. `pct` is percentage POINTS.
 */
export interface CallFigure {
  basis: "since entry" | "realized" | "since posted";
  pct: number;
  /** Realized dollars — non-null only on a sell from a public book. */
  usd: number | null;
}

const price = (v: number | null): number | null => (v !== null && v > 0 ? v : null);

function since(from: number | null, live: number | null): number | null {
  const a = price(from);
  const b = price(live);
  return a !== null && b !== null ? (b / a - 1) * 100 : null;
}

export function callFigure(b: TradeBeat | ViewBeat, livePriceUsd: number | null): CallFigure | null {
  const live = read(livePriceUsd);
  if (b.kind === "trade" && !b.shadow) {
    if (b.outcome !== "landed") return null;
    if (b.action === "buy") {
      const pct = since(b.entryPriceUsd, live);
      return pct === null ? null : { basis: "since entry", pct, usd: null };
    }
    if (b.action === "sell") {
      // Dollars are never shown without the percent they belong to.
      if (b.realizedPct === null) return null;
      return { basis: "realized", pct: b.realizedPct, usd: b.realizedUsd };
    }
    return null;
  }
  const pct = since(b.markUsd, live);
  return pct === null ? null : { basis: "since posted", pct, usd: null };
}

/**
 * The figure as the row prints it: "+10.0%", and "+$0.62" when there are
 * dollars. Both take the HOUSE sign — U+2212 for a loss, the way `pctBps`
 * writes every P&L in the product — in front of an UNSIGNED body, so no string
 * is ever signed twice and a loss reads the same in both halves ("−3.2%
 * realized −$0.16", not a hyphen beside a minus).
 */
export function callFigureText(f: CallFigure): { pct: string; usd: string | null; tone: "up" | "down" | "flat" } {
  // THE SIGN FOLLOWS THE PRINTED CENTS, as the colour below follows the printed
  // percent: under half a cent prints "$0.00", and "−$0.00" beside a flat
  // "0.0%" claimed a loss the number does not show.
  const usd =
    f.usd === null
      ? null
      : `${Math.abs(f.usd) < 0.005 ? "" : f.usd > 0 ? "+" : "−"}${usdText(Math.abs(f.usd))}`;
  // The colour follows the printed figure: under half a tenth prints "0.0%",
  // and a green "0.0%" would claim a gain the number does not show.
  const tone = Math.abs(f.pct) < 0.05 ? "flat" : f.pct > 0 ? "up" : "down";
  return { pct: pctBps(f.pct * 100), usd, tone };
}

/** A contract address, as a memecoin LiveToken's id carries it. */
const ADDRESS = /^0x[0-9a-f]{40}$/i;

/**
 * THE TOKEN A ROW IS ABOUT — by the address its id was minted from, never by
 * a ticker a deployer chose. Only when exactly one token answers.
 *
 * A trench or class row's symbol is `T` plus the last eleven hex of the
 * contract (trencher-discovery.ts), because a coin's own symbol() is text
 * anybody can set, and one calling itself NVDA must never resolve to a stock's
 * price (class-evidence.ts). A memecoin LiveToken takes its symbol from exactly
 * that text — the pool name or symbol() (live.ts). Matching the two by ticker
 * undid the rule on the client: the row never found its own coin, anybody who
 * deployed a coin named after a published id chose the row's "since entry"
 * (+499,900% in the review's probe), and a memecoin called TSLA blanked every
 * TSLA stock row as ambiguous.
 *
 * So a T-id is matched ONLY to a memecoin whose address ends in its eleven hex,
 * and any other symbol ONLY to a listed stock or ETF, whose symbol is ours. A
 * memecoin never answers to a ticker. Two answers are a guess, and a guess is
 * no token: a price computed against the wrong coin is a false number about
 * the agent's call, and a link to it sends the reader to somebody else's coin.
 */
export function tokenFor(tokens: readonly LiveToken[], symbol: string | null): LiveToken | null {
  if (!symbol) return null;
  const want = symbol.toUpperCase();
  const hits = TRENCH_ID.test(want)
    ? tokens.filter((t) => t.kind === "memecoin" && ADDRESS.test(t.id) && t.id.toLowerCase().endsWith(want.slice(1).toLowerCase()))
    : tokens.filter((t) => (t.kind === "stock" || t.kind === "etf") && t.symbol.toUpperCase() === want);
  return hits.length === 1 ? hits[0]! : null;
}

/**
 * THE SIZE A ROW PRINTS beside its figure — none beside a realized percent
 * whose dollars were withheld.
 *
 * A sell's size is its proceeds, so a size beside "−4.0% realized" is the
 * withheld P&L one line of arithmetic away (size × pct / (100 + pct)). The
 * publisher no longer sends a private book's size at all (thesis-policy.ts
 * `sizeUsdg`); the row does not lean on that alone, because it is the row that
 * would print the pair. A public book's sell carries its dollars, so it keeps
 * its size.
 */
export function dealSizeOf(b: TradeBeat | ViewBeat): number | null {
  if (b.kind === "trade" && b.realizedPct !== null && b.realizedUsd === null) return null;
  return b.sizeUsd;
}

/** The live price of a row's coin — see `tokenFor` for which coin that is. */
export function livePriceOf(tokens: readonly LiveToken[], symbol: string | null): number | null {
  const token = tokenFor(tokens, symbol);
  return token ? price(read(token.priceUsd)) : null;
}

function actorOf(t: FeedRow, agents: Map<string, LiveAgent>): Actor | null {
  const slug = t.slug;
  if (!slug) return null;
  return {
    slug,
    name: t.name,
    trencher: t.trencher === true,
    // Shape-checked as well as proven: the proof is of a handle, and only a
    // handle that is one may become a link.
    owner: t.handleVerified === true ? xHandleTag(t.handle) : null,
    strategy: strategyForSlug(slug, agents.get(slug)?.glance.id),
  };
}

/**
 * THE FEED USED TO DROP MOST OF WHAT THE AGENTS SAID.
 *
 * `if (action !== "buy" && action !== "sell") continue` threw away every hold
 * and every pure thesis — rows that already pass the publish gate with
 * `outcome: "view"`, already carry the agent's reasoning, and are most of what
 * a strategist produces on a quiet day. The owner's complaint was that nothing
 * happens on the feed; a large part of what was happening was being filtered
 * out one line above the renderer.
 *
 * Widening it roughly doubles the feed on its own, before any change to how
 * often agents post.
 */
export function beatsOf(theses: FeedRow[], agents: LiveAgent[]): Beat[] {
  const bySlug = new Map(agents.map((a) => [a.slug, a]));
  const out: Beat[] = [];
  // Each row's first copy, index-aligned with `out` — only `keyBeats` reads it.
  const firstOf: number[] = [];

  for (const t of theses) {
    if (t.at == null) continue;
    const actor = actorOf(t, bySlug);
    if (!actor) continue;
    // THE ONE CONVERSION.  is epoch seconds (thesis-policy.ts:151);
    // everything downstream of here is milliseconds and says so in its name.
    const atSec = t.at;
    const atMs = atSec * 1000;
    const first = typeof t.firstAt === "number" && Number.isFinite(t.firstAt) ? t.firstAt : atSec;
    const reason = takeFor(t.reason, bySlug.get(actor.slug)?.thesis);
    // Carried from the published row. `shadow` is set by the publisher; the
    // `outcome` check is the belt to it, for a row written before the flag
    // existed.
    const shadow = t.shadow === true || t.outcome === "shadow";
    // Straight from the published post — the publisher sets it from the
    // agent's mode at its last heartbeat. Nothing here re-derives it.
    const paper = t.paper === true;
    // Carried from the published row, which is the only thing that knows.
    const outcome = t.outcome ?? null;
    const outcomeText = t.outcomeText ?? null;
    const sizeUsd = sizeOf(t);
    // Carried, never derived here: it is a hash of the ROW as the server read
    // it, including a `source` the published post does not carry.
    const postId = t.postId ?? null;
    const action = t.action;
    const said = Math.max(1, Number(t.said ?? 1) || 1);
    const named = (t.displayName ?? "").trim() || null;
    const label = named ?? (t.symbol ? t.symbol.toUpperCase() : null);
    const trench = !!t.symbol && TRENCH_ID.test(t.symbol.toUpperCase());
    // ONLY AN UNBROKEN REPEAT HAS A "SINCE". A first-time post, one the agent
    // changed its mind about in between, or a row from before the publisher
    // sent `unchangedSince`, sits at its own time — never at a guessed one.
    const standing = typeof t.unchangedSince === "number" && Number.isFinite(t.unchangedSince) ? t.unchangedSince : null;
    const repeatSinceMs = said > 1 && standing !== null && standing < atSec ? standing * 1000 : null;
    // The agent's own line, already refused for a trade that did not happen.
    const post = postOf(t);
    const mcap = read(t.mcapUsd);
    const figures = {
      post,
      entryPriceUsd: read(t.entryPriceUsd),
      realizedPct: read(t.realizedPct),
      realizedUsd: read(t.realizedUsd),
      markUsd: read(t.markUsd),
      // A market cap of zero is not a reading of a live coin; it is a field
      // somebody defaulted. "at $0 MC" would be a figure nobody measured.
      mcapUsd: mcap !== null && mcap > 0 ? mcap : null,
    };

    if ((action === "buy" || action === "sell") && t.symbol) {
      const symbol = t.symbol.toUpperCase();
      // A TRADE IS AN EVENT and sits where it happened — unless nothing
      // happened, over and over. A strategy re-proposes a leg the key does not
      // cover on every tick, and each refusal arrived as "now", so the same
      // refusal sat on top of the feed all day. Repeated, it sits where it
      // began and says "×N · since", the way an unchanged view does.
      const repeatedNonEvent = outcome === "refused" || outcome === "dropped";
      const sinceMs = repeatedNonEvent ? repeatSinceMs : null;
      out.push({
        kind: "trade",
        // THE FALLBACK KEY, for a row with no postId; `keyBeats` below puts the
        // postId here when there is one. Built from atSec, deliberately:
        // re-basing it to milliseconds would churn the key of every row that
        // still uses it, for a cosmetic fix.
        id: `${symbol}-${action}-${actor.slug}-${atSec}`,
        postId,
        ...figures,
        atMs,
        actor,
        reason,
        sizeUsd,
        shadow,
        paper,
        outcome,
        outcomeText,
        said,
        sinceMs,
        rankMs: sinceMs ?? atMs,
        label,
        trench,
        action,
        symbol,
      });
      firstOf.push(first);
      continue;
    }

    // A VIEW NEEDS WORDS OR IT IS NOTHING. `head` is the publisher's sentence
    // and the only thing a view is rendered from; with neither it nor a reason
    // there is no post, just a row. The READER's head: the publisher's
    // sentence with the id it adds for reconciliation left to the tooltip.
    const head = readerHead({ head: t.head, symbol: t.symbol, displayName: named }).trim();
    if (!head && !reason) continue;
    const symbol = t.symbol ? t.symbol.toUpperCase() : null;
    const sinceMs = repeatSinceMs;
    out.push({
      kind: "view",
      id: `view-${actor.slug}-${atSec}-${symbol ?? ""}`,
      postId,
      ...figures,
      atMs,
      actor,
      reason,
      sizeUsd,
      shadow,
      paper,
      outcome,
      outcomeText,
      said,
      sinceMs,
      rankMs: sinceMs ?? atMs,
      label,
      trench,
      head,
      symbol,
      hold: action === "hold",
      more: t.moreNames === true,
    });
    firstOf.push(first);
  }

  // EVERY POST, ONE ROW EACH. Folding into choruses and watch lines is a
  // presentation of the All and Holds pills (see `pillBeats`), not of the read:
  // a chorus is not a post, so a liked hold folded here left Top and lost its
  // like control, and a member's mention of another agent left Debates.
  keyBeats(out, firstOf);
  out.sort((a, b) => b.rankMs - a.rankMs);
  return out;
}

/**
 * WHO GETS THE BARE POSTID when several NEW rows of one post arrive together.
 * Settled first, so a thesis first read pending and landed at once is drawn
 * with the landed row on the post's own id. Only newcomers are ordered by it —
 * a row already on screen keeps whatever key it had (`keyBeats`).
 */
const KEY_PRIORITY: Record<string, number> = {
  landed: 0,
  pending: 1,
  view: 2,
  shadow: 3,
  refused: 4,
  reverted: 5,
  dropped: 6,
};

/**
 * WHICH ROW HOLDS EACH RENDER KEY, and back. Module-level for the reason the
 * seen set in feed-fresh.ts is: it has to outlive a Feed that switching tabs
 * unmounts. Presentation state per page load — nothing here is stored or sent.
 *
 * A holder is remembered with what it said (`base`: post, outcome, sentence),
 * whether it was an order in flight, and its first and newest copies, in
 * seconds — which is what decides who may take its key once it has gone.
 */
type Holder = { ident: string; base: string; pending: boolean; first: number; last: number };
const keyOwner = new Map<string, Holder>();
const ownedKey = new Map<string, string>();
/** A long session is bounded: past this, keys are dealt afresh from the current read. */
const KEYS_MAX = 5_000;
const SEP = String.fromCharCode(31);

function dealAfresh(): void {
  keyOwner.clear();
  ownedKey.clear();
}

/** Tests only: a fresh page load. */
export function forgetKeysForTest(): void {
  dealAfresh();
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A departed key a newcomer could be drawn under, and how well it fits: 0 is the best (`fitOf`). */
export type Fit = { key: string; rank: 0 | 1 | 2 };

/**
 * COULD A ROW FIRST SAID AT `row.first` AND LAST AT `row.last` (seconds) BE
 * THE ROW `was` — the same words, read again with its oldest copies gone?
 *
 * Never unless its first copy is one the holder covered (`first <= was.last`):
 * a row whose every copy the page saw has aged out is, by anything the read
 * can show, a new row. Then, best first:
 *  0 — it still has the holder's newest copy, a copy the page knows that row
 *      had: its newest copy is exactly there (only old copies left, nothing
 *      said — or an older body served stale, where the first copy went back),
 *      or its first copy is (said again, and everything before it left).
 *  1 — its span only moved forward: said again since, as well.
 *  2 — anything else inside that cover.
 */
export function fitOf(row: { first: number; last: number }, was: { first: number; last: number }): 0 | 1 | 2 | null {
  if (row.first > was.last) return null;
  if (row.last === was.last || row.first === was.last) return 0;
  if (was.first <= row.first && row.last > was.last) return 1;
  return 2;
}

/**
 * WHICH NEWCOMER TAKES WHICH DEPARTED KEY OF ITS OWN WORDS (R3F-1), as a
 * matching rather than first come, first served: handed out in list order, the
 * first twin asked took whichever key it fitted, even one the next twin fitted
 * better or was the only one it fitted.
 *
 * By rank: every pair of rank 0 is settled first — the strongest evidence a
 * row is the one that held a key — then rank 1 among what is left, then rank 2,
 * and a rank never unsettles a pair an earlier one made. Within a rank it is a
 * maximum matching (augmenting paths), so as many rows as can keep a key do.
 * Where the spans cannot tell two twins apart, the answer is only stable:
 * newcomers are tried in the order `fits` lists them, each its keys in the
 * order given.
 *
 * Returns key -> newcomer. Pure; the sizes are a handful of twins per post.
 */
export function matchTwins(fits: ReadonlyMap<number, readonly Fit[]>): Map<string, number> {
  const settled = new Map<string, number>();
  const placed = new Set<number>();
  for (const rank of [0, 1, 2] as const) {
    const edges = new Map<number, string[]>();
    for (const [i, all] of fits) {
      const mine = placed.has(i) ? [] : all.filter((f) => f.rank === rank && !settled.has(f.key)).map((f) => f.key);
      if (mine.length > 0) edges.set(i, mine);
    }
    const holder = new Map<string, number>();
    const assign = (i: number, tried: Set<string>): boolean => {
      for (const key of edges.get(i)!) {
        if (tried.has(key)) continue;
        tried.add(key);
        const j = holder.get(key);
        if (j === undefined || assign(j, tried)) {
          holder.set(key, i);
          return true;
        }
      }
      return false;
    };
    for (const i of edges.keys()) assign(i, new Set());
    for (const [key, i] of holder) {
      settled.set(key, i);
      placed.add(i);
    }
  }
  return settled;
}

/**
 * C2: EACH BEAT'S RENDER KEY IS ITS POSTID — unique, stable across refreshes,
 * and it STAYS WITH THE ROW THAT HAD IT.
 *
 * A postId is not unique per ROW: post-id.ts leaves the outcome out on purpose,
 * so one thesis read pending and landed, or refused under two rules, is two
 * rows with one id, and two equal React keys drop or merge a row. So a
 * collision falls back through keys that are still stable — postId plus
 * outcome, then plus the outcome's sentence.
 *
 * WHO HAS WHICH is remembered, not recomputed. It was recomputed on every read
 * — settled first, ties broken on the `at`-bearing legacy id — so when a
 * landed trade joined a refusal already on screen, the NEW row took the
 * refusal's key, element and open "why", and the refusal was re-keyed,
 * remounted and slid in as if it had just arrived. And two refusals
 * under different rules swapped keys whenever a re-proposal reordered their
 * times. Now a row is known by what it says — post, outcome, the
 * outcome's sentence — never by its clock; a row that had a key keeps it, and
 * a newcomer takes the first key nobody on screen holds. When a row leaves, its
 * key is free: an order that lands takes over the element it was drawn under
 * while in flight, because it is the same trade.
 *
 * A ROW IS ITS WORDS AND ITS FIRST COPY. Two rows that say exactly the same
 * thing — "twins": two unrecognised rules that both read "the wall turned it
 * back", or a private book's fills of one coin that differ only in the size it
 * no longer publishes — were told apart by an ORDINAL over their first copies,
 * so when the oldest left the read every other twin took its neighbour's key
 * (CF3). Now each row is known by its first copy, which never moves for a
 * one-copy row and moves for any other only when its own oldest copies age
 * out; an ordinal breaks a tie only between twins first said in the same
 * second.
 *
 * WHO MAY TAKE A KEY THAT IS FREE. Never a key the page has seen drawn over a
 * row that is not this one: a key last held by the same words is taken only by
 * the same row whose early copies aged out (its first copy is one the holder
 * already covered), and a key last held by other words only when the holder
 * was an order in flight — the trade settling. A new twin, or a new order where
 * a fill used to be, is a new row, gets a key nobody has shown, and slides in.
 *
 * THE SAME WORDS' KEYS GO TO THE BEST FIT, NOT THE FIRST ASKER (R3F-1). When
 * two twins' first copies both age out between two reads, their order by first
 * copy can flip, and "its first copy is one the holder covered" is then true
 * of the wrong twin as well: handed out in list order, the first twin asked
 * took its neighbour's key and the neighbour slid in as news. So these keys
 * are dealt as a matching (`matchTwins`), before any other key is: every
 * departed holder of the same words a newcomer could be, ranked by how well
 * the spans agree (`fitOf`: it still has the holder's newest copy, then a span
 * that only moved forward, then the bare cover), best fits paired first. So an
 * order still in flight keeps its element when an earlier send of it lands:
 * it is the same row, and the fill is the new one.
 */
function keyBeats(beats: Beat[], firstOf: readonly number[]): void {
  if (ownedKey.size > KEYS_MAX) dealAfresh();
  const base: (string | null)[] = beats.map((b) =>
    b.postId ? [b.postId, b.outcome ?? "", b.outcomeText ?? ""].join(SEP) : null,
  );
  // Fixed width, so a byte order of idents is the order of their first copies.
  const ident: (string | null)[] = base.map((id, i) =>
    id === null ? null : `${id}${SEP}${String(Math.max(0, Math.floor(firstOf[i]!))).padStart(12, "0")}`,
  );
  const same = new Map<string, number[]>();
  ident.forEach((id, i) => {
    if (id !== null) same.set(id, [...(same.get(id) ?? []), i]);
  });
  for (const [id, rows] of same) {
    if (rows.length < 2) continue;
    rows.sort((x, y) => byText(beats[x]!.id, beats[y]!.id));
    rows.forEach((i, n) => {
      if (n > 0) ident[i] = `${id}${SEP}${n}`;
    });
  }
  const holderOf = (i: number): Holder => ({
    ident: ident[i]!,
    base: base[i]!,
    pending: beats[i]!.outcome === "pending",
    first: firstOf[i]!,
    last: beats[i]!.atMs / 1000,
  });

  const used = new Set<string>();
  const keys: (string | null)[] = beats.map(() => null);
  // A ROW THAT HAD A KEY KEEPS IT.
  ident.forEach((id, i) => {
    const had = id === null ? undefined : ownedKey.get(id);
    if (had !== undefined && !used.has(had)) {
      keys[i] = had;
      used.add(had);
      keyOwner.set(had, holderOf(i));
    }
  });
  // Newcomer `i` is drawn under `key` from now on.
  const take = (i: number, key: string): void => {
    // The row that held it before has gone; its claim goes with it, or it
    // would take the key back from this one if it were ever read again.
    const before = keyOwner.get(key);
    if (before !== undefined) ownedKey.delete(before.ident);
    keyOwner.set(key, holderOf(i));
    ownedKey.set(ident[i]!, key);
    used.add(key);
    keys[i] = key;
  };
  // THE SAME WORDS' DEPARTED KEYS, DEALT AS A MATCHING — see above.
  const departed = new Map<string, [string, Holder][]>();
  for (const [key, was] of keyOwner) {
    if (used.has(key)) continue;
    const same = departed.get(was.base);
    if (same) same.push([key, was]);
    else departed.set(was.base, [[key, was]]);
  }
  const fits = new Map<number, Fit[]>();
  const waiting = beats
    .map((_, i) => i)
    .filter((i) => keys[i] === null && base[i] !== null)
    .sort((x, y) => byText(ident[x]!, ident[y]!));
  for (const i of waiting) {
    const mine: Fit[] = [];
    for (const [key, was] of departed.get(base[i]!) ?? []) {
      const rank = fitOf({ first: firstOf[i]!, last: beats[i]!.atMs / 1000 }, was);
      if (rank !== null) mine.push({ key, rank });
    }
    if (mine.length > 0) fits.set(i, mine.sort((x, y) => byText(x.key, y.key)));
  }
  for (const [key, i] of matchTwins(fits)) take(i, key);
  // May newcomer `i` be drawn under `key`? Only if no row that is not this one
  // was last drawn under it — see above. A key of the same words that is still
  // free fits no newcomer: the matching gave out every one that did.
  const mayTake = (key: string, i: number): boolean => {
    if (used.has(key)) return false;
    const was = keyOwner.get(key);
    if (was === undefined) return true;
    return was.base === base[i] ? false : was.pending;
  };
  // Newcomers, in an order that is not the clock's.
  const newcomers = beats
    .map((_, i) => i)
    .filter((i) => keys[i] === null)
    .sort(
      (x, y) =>
        (KEY_PRIORITY[beats[x]!.outcome ?? ""] ?? 9) - (KEY_PRIORITY[beats[y]!.outcome ?? ""] ?? 9) ||
        byText(ident[x] ?? beats[x]!.id, ident[y] ?? beats[y]!.id),
    );
  for (const i of newcomers) {
    const b = beats[i]!;
    let key: string;
    if (b.postId && ident[i] !== null) {
      const full = `${b.postId}:${b.outcome ?? ""}:${b.outcomeText ?? ""}`;
      key = [b.postId, `${b.postId}:${b.outcome ?? ""}`, full].find((k) => mayTake(k, i)) ?? full;
      for (let n = 2; !mayTake(key, i); n++) key = `${full}#${n}`;
      take(i, key);
    } else {
      // No postId (a server from before it): the old id, as it always was.
      const legacy = b.id;
      key = legacy;
      for (let n = 2; used.has(key); n++) key = `${legacy}#${n}`;
      used.add(key);
      keys[i] = key;
    }
  }
  beats.forEach((b, i) => {
    b.id = keys[i]!;
  });
}

/**
 * Fold holds that several agents said about one name into one chorus beat.
 *
 * Only HOLDS WITH A NAME, and only across two or more distinct agents: a
 * crowd of one is a post, and a pure view about the book is not "holding"
 * anything. A shared sentence that differs only in its figures counts as the
 * same one (see `crowdKey`); the chorus still shows the latest member's own
 * words, attributed to them, rather than a sentence nobody wrote.
 *
 * A LIKED POST IS NEVER FOLDED. A chorus is not a post and has no like
 * control, so a liked member folded into one lost its heart, its place under
 * "Most liked", and every reader's way to see what others had liked.
 */
export function chorusOf(beats: Beat[], keep: (b: Beat) => boolean = () => false): Beat[] {
  const groups = new Map<string, ViewBeat[]>();
  for (const b of beats) {
    if (b.kind !== "view" || !b.hold || !b.symbol || keep(b)) continue;
    const key = `${b.symbol}|${crowdKey(b.reason || b.head)}`;
    const list = groups.get(key) ?? [];
    list.push(b);
    groups.set(key, list);
  }
  const folded = new Map<ViewBeat, ChorusBeat | null>();
  for (const members of groups.values()) {
    const slugs = new Set(members.map((m) => m.actor.slug));
    if (slugs.size < 2) continue;
    const ordered = [...members].sort((a, b) => b.atMs - a.atMs);
    const latest = ordered[0]!;
    const actors: Actor[] = [];
    for (const m of ordered) if (!actors.some((a) => a.slug === m.actor.slug)) actors.push(m.actor);
    const chorus: ChorusBeat = {
      ...latest,
      kind: "chorus",
      id: `chorus-${latest.symbol}-${actors.map((a) => a.slug).join("-")}`,
      postId: null,
      rankMs: Math.max(...members.map((m) => m.rankMs)),
      actors,
      latest,
      members: ordered,
      symbol: latest.symbol!,
    };
    // The chorus takes the place of its newest member; the rest are in it.
    for (const m of members) folded.set(m, m === latest ? chorus : null);
  }
  const out: Beat[] = [];
  for (const b of beats) {
    if (b.kind === "view" && folded.has(b)) {
      const chorus = folded.get(b);
      if (chorus) out.push(chorus);
      continue;
    }
    out.push(b);
  }
  out.sort((a, b) => b.rankMs - a.rankMs);
  return out;
}

/**
 * HOW MANY OF ONE AGENT'S FRESH HOLDS "All" LAYS OUT AS ROWS.
 *
 * A Trencher reviews a pool every thirty seconds in new words each time, so
 * none of its holds is ever a repeat and none had a "since" to fold on. With
 * the reader no longer capping an agent's names, one Trencher put thirty-nine
 * hold rows above every trade older than twenty minutes — the "37 of 40 rows
 * were holds" this whole change began from. Its newest few stay rows, because
 * a changed view is news; the rest are said once, in its watch line.
 */
export const FRESH_HOLDS_SHOWN = 3;

/**
 * WHAT "ALL" SHOWS: every trade and every view, with each agent's STANDING
 * holds said once.
 *
 * A hold that has stood unchanged — a repeat with a "since" — is folded. A
 * fresh or changed hold is news (a market review is published only when its
 * bias flipped or a breakout confirmed), so an agent's newest
 * FRESH_HOLDS_SHOWN of them keep their own rows, and only its older fresh
 * ones fold beside the standing ones. A liked hold is never folded, for the
 * same reason a chorus does not take it.
 *
 * An agent with two or more foldable holds becomes one `watch` beat carrying
 * the latest in full. One stays a normal row — a summary of one thing is the
 * thing. Nothing is removed from the read: the Holds pill lays every member
 * out, and the count on the summary says how many there are.
 */
export function compactHolds(beats: Beat[], keep: (b: Beat) => boolean = () => false): Beat[] {
  const hold = (b: Beat): b is ViewBeat => b.kind === "view" && b.hold && !keep(b);
  const freshBy = new Map<string, ViewBeat[]>();
  for (const b of beats) {
    if (!hold(b) || b.sinceMs !== null) continue;
    const list = freshBy.get(b.actor.slug) ?? [];
    list.push(b);
    freshBy.set(b.actor.slug, list);
  }
  const overflow = new Set<ViewBeat>();
  for (const list of freshBy.values()) {
    for (const b of [...list].sort((x, y) => y.atMs - x.atMs).slice(FRESH_HOLDS_SHOWN)) overflow.add(b);
  }
  const foldable = (b: Beat): b is ViewBeat => hold(b) && (b.sinceMs !== null || overflow.has(b));
  const holds = new Map<string, ViewBeat[]>();
  for (const b of beats) {
    if (!foldable(b)) continue;
    const list = holds.get(b.actor.slug) ?? [];
    list.push(b);
    holds.set(b.actor.slug, list);
  }
  const out: Beat[] = [];
  const summarised = new Set<string>();
  for (const b of beats) {
    const members = foldable(b) ? holds.get(b.actor.slug) : undefined;
    if (!members || members.length < 2) {
      out.push(b);
      continue;
    }
    if (summarised.has(b.actor.slug)) continue;
    summarised.add(b.actor.slug);
    // The newest thing the agent actually said, by when it said it — not by
    // where a repeat is ranked.
    const latest = members.reduce((a, m) => (m.atMs > a.atMs ? m : a));
    out.push({
      ...latest,
      kind: "watch",
      id: `watch-${b.actor.slug}`,
      postId: null,
      rankMs: Math.max(...members.map((m) => m.rankMs)),
      count: new Set(members.map((m) => m.symbol ?? "")).size,
      more: members.some((m) => m.more),
      latest,
      members,
    });
  }
  out.sort((a, b) => b.rankMs - a.rankMs);
  return out;
}

/**
 * "12 tokens", or "at least 12 tokens" when the read did not carry every name
 * the agent has — a count from a truncated slice is a floor, and says so.
 */
export function watchCount(b: WatchBeat): string {
  const noun = b.count === 1 ? "token" : "tokens";
  return b.more ? `at least ${b.count} ${noun}` : `${b.count} ${noun}`;
}

/** The feed's filters, one tap each. */
export type Pill = "all" | "trades" | "theses" | "holds" | "debate" | "top";

/**
 * WHAT ONE PILL SHOWS, from every post read.
 *
 * Summaries are a presentation of two pills and nothing else: All folds
 * crowds and each agent's unchanged holds, Holds folds crowds. Every other
 * pill filters the posts themselves, so a post that is liked, or that names
 * another agent, is found by Top and Debates whether or not All folded it.
 */
export function pillBeats(
  beats: Beat[],
  pill: Pill,
  replies: ReadonlyMap<string, unknown>,
  counts: Readonly<Record<string, number>>,
  opts: { realOnly?: boolean } = {},
): Beat[] {
  const liked = (b: Beat) => !!b.postId && (counts[b.postId] ?? 0) > 0;
  // "REAL MONEY" FILTERS THE POSTS BEFORE ANYTHING IS FOLDED. A chorus or a
  // watch line counted after the fact would still count paper members — "2
  // agents holding" with one of them on a pretend book — so paper rows leave
  // first, and every crowd and count below is built from real ones only.
  const pool = opts.realOnly ? beats.filter((b) => !b.paper) : beats;
  const base =
    pill === "all" ? compactHolds(chorusOf(pool, liked), liked) : pill === "holds" ? chorusOf(pool, liked) : pool;
  return base.filter((b) => keepBeat(b, pill, replies, counts));
}

/**
 * WHAT AN EMPTY PILL SAYS, when the read DID return posts and this filter
 * matched none of them. (No posts at all is the read's own answer — unread,
 * unreadable or quiet — and the Feed shows `ReadEmpty` for it instead.)
 *
 * With "Real money" on, the sentence says so: "Quiet." about a feed that is
 * full of paper trades would blame the agents for the reader's own filter.
 */
export function emptyFor(pill: Pill, likesRead: boolean, realOnly = false): string {
  const real = realOnly ? "real-money " : "";
  switch (pill) {
    case "trades":
      return `No ${real}trades in this window.`;
    case "theses":
      return realOnly ? "No real-money agent has published a view here yet." : "Nobody has published a view here yet.";
    case "holds":
      return `No ${real}holds in this window.`;
    case "debate":
      return realOnly ? "No real-money agent has named another one yet." : "No agent has named another one yet.";
    case "top":
      // THREE DIFFERENT NOTHINGS, and only one is about the posts.
      return likesRead ? `Nothing ${real ? "on real money " : ""}has been liked in the last day.` : "Likes unavailable.";
    case "all":
      return realOnly ? "No real-money posts in this window." : "Quiet.";
    default: {
      const _x: never = pill;
      return _x;
    }
  }
}

function keepBeat(
  beat: Beat,
  pill: Pill,
  replies: ReadonlyMap<string, unknown>,
  counts: Readonly<Record<string, number>>,
): boolean {
  switch (pill) {
    case "all":
      return true;
    case "trades":
      // TRADES, NOT ATTEMPTS: landed or still in flight. A stuck strategy's
      // refusals filled this pill with "tried to buy", once a tick. They are
      // not hidden — All still carries every one, with the wall's reason, and
      // the owner's desk and events say it too — they are just not trades.
      // An ALLOW-LIST, so an outcome this file has not heard of stays out
      // rather than being counted as money that moved; and a shadow call, which
      // could never have traded, is out by the same rule. "In flight" is a
      // SENT order — a decision nothing was sent for is not one (`inFlight`).
      return beat.kind === "trade" && !beat.shadow && (beat.outcome === "landed" || inFlight(beat));
    case "theses":
      return beat.kind === "view" && !beat.hold;
    case "holds":
      return (beat.kind === "view" && beat.hold) || beat.kind === "chorus";
    case "debate":
      return replies.has(beat.id);
    case "top":
      // A post nobody liked is not "top". An unslugged post has no postId and
      // therefore cannot be liked at all, so it is absent here by construction
      // rather than by a check.
      return !!beat.postId && (counts[beat.postId] ?? 0) > 0;
    default: {
      const _x: never = pill;
      return _x;
    }
  }
}

/** An agent a post's own words named, and where to go to read them. */
export interface Mention {
  /** The token as it follows the "@", lowercased — what the text is matched on. */
  handle: string;
  slug: string;
  /** What the row prints: the agent's name, whichever token named it. */
  name: string;
}

/**
 * WHAT AN "@" IN A POST CAN NAME, and whom.
 *
 * Each agent answers to its NAME, and to its owner's handle only when the
 * owner proved it. An unproven handle names nobody here: it is text the owner
 * typed, and treating it as the agent would let a post about the person whose
 * handle was borrowed "mention" somebody's agent. A token two agents share —
 * two agents are called Robin — names neither, because picking one would
 * attribute the post to a guess.
 */
export function mentionTargets(beats: Beat[]): Map<string, Mention> {
  const actors = new Map<string, Actor>();
  for (const b of beats) for (const a of b.kind === "chorus" ? b.actors : [b.actor]) actors.set(a.slug, a);
  const claims = new Map<string, Set<string>>();
  for (const a of actors.values()) {
    for (const tag of [a.name, a.owner]) {
      const token = (tag ?? "").replace(/^@/, "").trim().toLowerCase();
      if (!token) continue;
      const slugs = claims.get(token) ?? new Set<string>();
      slugs.add(a.slug);
      claims.set(token, slugs);
    }
  }
  const out = new Map<string, Mention>();
  for (const [token, slugs] of claims) {
    if (slugs.size !== 1) continue;
    const slug = [...slugs][0]!;
    out.set(token, { handle: token, slug, name: actors.get(slug)!.name });
  }
  return out;
}

/**
 * THE TIME A ROW SHOWS. "2m" for something that just happened; "×24 · since
 * 2h" for a view that has only been repeated, because its newest copy is not
 * news and its first one is.
 */
export function whenLabel(b: Beat, nowMs: number): string {
  const view = b.kind === "watch" || b.kind === "chorus" ? b.latest : b;
  if (view.sinceMs !== null) return `×${view.said} · since ${elapsed(view.sinceMs, nowMs).text}`;
  return whenOf(view.atMs, nowMs);
}

const LULL_MS = 3 * 3_600_000;

export function lanesOf(beats: Beat[]): Lane[] {
  const out: Lane[] = [];

  beats.forEach((beat, i) => {
    const prev = beats[i - 1];
    // Gaps between where rows SIT, so a lull is never drawn inside the order.
    const gap = prev ? prev.rankMs - beat.rankMs : 0;
    if (gap >= LULL_MS) out.push({ kind: "lull", id: `lull-${beat.id}`, ms: gap });
    out.push({ kind: "beat", id: beat.id, beat });
  });

  return out;
}

/** Returns over a slice of the tail of the curve, in bps. */
export function curveReturn(curve: number[], points: number): number | null {
  if (curve.length < 2) return null;
  const slice = curve.slice(-Math.max(2, Math.min(points, curve.length)));
  const first = slice[0]!;
  const last = slice[slice.length - 1]!;
  if (first === 0) return null;
  return ((last - first) / first) * 10000;
}
