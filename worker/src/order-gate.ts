/**
 * AN OWNER'S OWN BUY OR SELL, AS THE PROCESS THAT HOLDS THE KEY JUDGES IT.
 *
 * WHY THE VALIDATION IS HERE AND NOT ONLY IN THE ROUTE. Between the route and
 * this code the order crossed a shared Postgres table, an orchestrator that can
 * see every tenant's home, and a JSON file. The route's check is the one that
 * gives the owner a good error; this one stands between a string and a signed
 * UserOperation, and it must hold even if every layer above it is wrong.
 *
 * LIFTED OUT OF main() SO IT RUNS UNDER A TEST. It lived inline in
 * runOrderCommand, where no test can reach, and was pinned by reading the
 * source — so deleting the refusal a between-tick order depends on (a book this
 * tick could not value) typechecked, passed every test, and would have filled
 * the order against the equity the PREVIOUS tick left behind. The gate owns
 * the submit call too, so "refused" provably means "nothing was sent".
 *
 * THE READS COME FIRST, and each refusal says it is a fact about the reads and
 * not about the order. The drawdown breaker judges an order against this
 * tick's equity, and checkPolicy SKIPS the breaker when equity is unknown — so
 * an order placed on a tick that could not read the market or the book, or
 * could not total it, is a trade with that guard silently off. A prompt no is
 * worth more than a late yes, and the owner can ask again in a minute.
 */

/**
 * What the tick that drains an order could read — handed to the drain whole.
 *
 * NONE OF IT IS DEFAULTED. The drain took these as positional booleans that
 * defaulted to false, so a drain site that dropped them still typechecked and
 * the order was judged against whatever the PREVIOUS tick left behind; and
 * `equityKnown` was read off a global beside them. Every drain site now builds
 * one of these with `tickReads` and passes it through, so stating nothing does
 * not compile and a hand-written literal is not the natural edit.
 */
export interface TickReads {
  /** The market could not be read this tick. */
  marketUnreadable: boolean;
  /** A balance could not be read, or a holding could not be priced, this tick. */
  bookUnreadable: boolean;
  /**
   * Whether the book could be totalled. False while something held has neither
   * a price nor a cost on record — the tick then skips equity, and checkPolicy
   * skips the drawdown breaker for every intent it judges.
   */
  equityKnown: boolean;
}

/** The three places a tick drains from, and what each of them has read. */
export const tickReads = {
  /** The market could not be read, so nothing downstream of it was either. */
  marketUnread: (): TickReads => ({ marketUnreadable: true, bookUnreadable: true, equityKnown: false }),
  /** The market was read and the book was not: a balance or a price failed. */
  bookUnread: (): TickReads => ({ marketUnreadable: false, bookUnreadable: true, equityKnown: false }),
  /** Both were read and equity composed; `equityKnown` is whether it could be totalled. */
  composed: (equityKnown: boolean): TickReads => ({ marketUnreadable: false, bookUnreadable: false, equityKnown }),
} as const;

/** What an order is judged against: the tick's reads, and the owner's own settings as they stand. */
export interface OrderReads extends TickReads {
  /** The owner has the agent paused. */
  paused: boolean;
  /** The owner's own ceiling on a typed order, in USDG. Zero means none is set. */
  ceilingUsdg: number;
}

export function orderReadsOf(tick: TickReads, owner: { paused: boolean; ceilingUsdg: number }): OrderReads {
  return {
    marketUnreadable: tick.marketUnreadable,
    bookUnreadable: tick.bookUnreadable,
    equityKnown: tick.equityKnown,
    paused: owner.paused,
    ceilingUsdg: owner.ceilingUsdg,
  };
}

type Side = "buy" | "sell";

/**
 * A TICK THAT COULD NOT READ CANNOT JUDGE AN ORDER. The breaker judges an order
 * against this tick's equity, and a tick that could not read the market, a
 * balance or a price returns before equity is composed ("trading + equity
 * paused"), so the figure it would judge against is exactly the one missing.
 * Both sides are refused, as the tick itself trades nothing. Null when the
 * reads are whole.
 */
function unreadRefusal(reads: TickReads): string | null {
  if (reads.marketUnreadable) {
    return (
      "I could not read the market this tick, so I did not place it — that is a fact about my reads, " +
      "not about your order. Ask again in a minute."
    );
  }
  if (reads.bookUnreadable) {
    return (
      "I could not value your book this tick, so I did not place it — that is a fact about my reads, " +
      "not about your order. Ask again in a minute."
    );
  }
  return null;
}

/**
 * A BOOK THAT CANNOT BE TOTALLED CANNOT JUDGE A BUY. Equity is unknown, so
 * policy.ts runs the breaker only `if (state.equityKnown !== false)` — a buy
 * would go out with the loss limit switched off. A sell is an exit, which the
 * breaker exempts anyway, and refusing it would lock the owner into the very
 * holding that makes the book untotallable. Null when the order may go on.
 */
function untotalledBuy(side: Side, equityKnown: boolean): string | null {
  if (side !== "buy" || equityKnown) return null;
  return (
    "I did not place it: something you hold has no price and no cost on record, so I cannot total your " +
    "book, and without that the drawdown limit can't judge a buy. Selling still works."
  );
}

/** The book as the latest tick left it: what it read, and the last equity it composed. */
export interface TickState {
  reads: TickReads;
  /** The last equity a tick composed. 0n before any has, when the drawdown check would judge garbage. */
  equityUsdg: bigint;
}

/**
 * THE GATE EVERY ORDER MEETS AT submitChatTrade — typed in Telegram, placed
 * from the app, or handed over by the Brain. Null when it may go on to the
 * wall; otherwise the sentence the owner reads, and nothing is built or sent.
 *
 * The same refusals, in the same words, as placeOrder: a tick that could not
 * read the market or value the book, and a buy on a book that could not be
 * totalled. They lived only in placeOrder, which only an app order reaches, so
 * after a tick that could not read, a buy typed in Telegram went out judged on
 * the equity the tick BEFORE it had left behind — the breaker judging a figure
 * the tick had just said it could not produce, while the owner's own feed said
 * "trading + equity paused". It is one set of rules, so it is one function.
 *
 * `book` is the latest tick's (createTickBook), never a pair of globals that a
 * tick which returned early did not write.
 */
export function chatOrderGate(side: Side, book: TickState): string | null {
  if (book.equityUsdg === 0n) return "🐎 the band is still saddling up (first tick pending) — try again in a minute.";
  return unreadRefusal(book.reads) ?? untotalledBuy(side, book.reads.equityKnown);
}

/**
 * Reads a tick has STATED to the book — the only reads a drain accepts.
 *
 * Branded so they cannot be built anywhere but createTickBook: a drain site
 * that hands the drain `tickReads.bookUnread()` without telling the book does
 * not compile. That is what keeps the app's drain and the Telegram gate on one
 * record — a tick that could not read says so once, and both see it.
 */
declare const STATED: unique symbol;
export type StatedReads = TickReads & { readonly [STATED]: true };

/** What the gate hands back: a refusal, or the book the order is judged against. */
export type BookJudgement = { ok: false; line: string } | { ok: true; equityUsdg: bigint; equityKnown: boolean };

/**
 * THE BOOK AS THE LATEST TICK LEFT IT, and the one gate every order placed
 * between ticks meets.
 *
 * This was `lastEquityUsdg` and `lastEquityKnown`, two globals written only
 * after a tick had composed equity. The three returns that end a tick which
 * could not read the market, a balance or a price never wrote them, so they
 * kept the previous tick's `equityKnown: true` — and a buy typed in Telegram
 * went out on it while an app order drained on the same tick was refused by
 * name. Every way a tick can end now states its reads here, and both surfaces
 * judge against the same record:
 *
 *   unread(what)        — the tick could not read the market, or the book (a
 *                         balance, or a price for a holding). The last composed
 *                         equity is kept (for display), and every order is
 *                         refused until a tick composes again.
 *   composed(eq, known) — the tick composed equity; `known` is whether the
 *                         book could be totalled.
 *   during(tick)        — runs one tick. A tick that FAILS before it states
 *                         anything cannot vouch for the book either, so it
 *                         leaves the book unread. One that returns early
 *                         without reading (nothing armed, a grant that expired)
 *                         leaves the last reading standing, as it read nothing.
 *   judge(side)         — chatOrderGate against the latest state, and the
 *                         equity the order is then judged against, taken from
 *                         the same record in the same breath.
 *
 * `unread` and `composed` return the reads branded as stated, and the drains
 * take nothing else — so a tick cannot drain an order on reads the gate for a
 * Telegram order never heard about.
 */
export interface TickBook {
  unread(what: "market" | "book"): StatedReads;
  composed(equityUsdg: bigint, equityKnown: boolean): StatedReads;
  during<T>(tick: () => Promise<T>): Promise<T>;
  judge(side: Side): BookJudgement;
  /** The latest state, for what only displays it or judges an exit (a transfer). */
  latest(): Readonly<TickState>;
}

export function createTickBook(): TickBook {
  // Before any tick nothing has been read. The saddling-up refusal answers
  // first while equity is its 0n initialiser; this answers after that.
  let state: TickState = { reads: tickReads.marketUnread(), equityUsdg: 0n };
  let stated = false;
  const stateThat = (reads: TickReads, equityUsdg: bigint): StatedReads => {
    state = { reads: { ...reads }, equityUsdg };
    stated = true;
    return state.reads as StatedReads;
  };
  return {
    unread: (what) => stateThat(what === "market" ? tickReads.marketUnread() : tickReads.bookUnread(), state.equityUsdg),
    composed: (equityUsdg, equityKnown) => stateThat(tickReads.composed(equityKnown), equityUsdg),
    async during(tick) {
      stated = false;
      try {
        return await tick();
      } catch (e) {
        if (!stated) state = { reads: tickReads.bookUnread(), equityUsdg: state.equityUsdg };
        throw e;
      }
    },
    judge(side) {
      const book = state;
      const line = chatOrderGate(side, book);
      if (line) return { ok: false, line };
      return { ok: true, equityUsdg: book.equityUsdg, equityKnown: book.reads.equityKnown };
    },
    latest: () => state,
  };
}

/**
 * WHICH SUBMITTER AN ORDER GOES TO — decided by an explicit marker, never by
 * its symbol.
 *
 * 'energy' is the owner's get-energy card and nothing else: the app writes
 * `purpose: "energy"` as a FIXED value of that one command (chat-commands.ts),
 * POST /api/orders keeps the marker only when it is exactly that string, and
 * the ferry carries it through like any scalar. Every other order is 'trade',
 * resolved against the watch set by address like any order.
 *
 * WHY NOT THE SYMBOL. This used to route every order whose symbol read
 * MERRYMEN to the energy buy: a plain buy card the model wrote for it, a snipe
 * that resolved to a coin with that name, an approved MCP proposal for a
 * watched LOOKALIKE at another address. None of those cards showed the energy
 * disclosure, and the lookalike's owner asked for one asset and would have got
 * another — a key-unsellable one, booked as capital leaving the book. A symbol
 * is a name anybody can launch a token under; a marker only one card writes is
 * a statement of intent.
 */
export type OrderRoute = "energy" | "trade";

export function orderRoute(args: Record<string, unknown> | undefined): OrderRoute {
  return args?.purpose === "energy" ? "energy" : "trade";
}

/**
 * WHAT AN OWNER ORDER IS FILED UNDER: the decision source and its reason.
 *
 * THE SOURCE IS 'chat' FOR EVERY OWNER-APPROVED ORDER — typed in the app chat,
 * a get-energy card, or an approved MCP proposal. It is not a surface name but
 * a class, and three readers key on it: provenance.ts maps it to
 * owner-command, the MCP proposal's own outcome reader finds the proposal's
 * trade by it (web services/proposals.ts orderTrade, `d.source = 'chat'`), and
 * the inactivity sweep excludes it. Renaming it per surface would make an
 * approved proposal's trade unfindable by the proposal that placed it.
 *
 * WHERE IT CAME FROM GOES IN THE REASON, read off the args the placing route
 * wrote: POST /api/orders never keeps a `source`, and only the MCP proposal
 * service writes `mcp-proposal`. So an approved proposal is no longer filed as
 * "owner asked … in chat" — and an energy ask is filed as one only when it is
 * one (see orderRoute).
 */
export function orderAsked(
  args: Record<string, unknown> | undefined,
  side: Side,
  symbol: string,
  usdgAmount: number,
): { source: "chat"; reason: string } {
  if (orderRoute(args) === "energy") {
    return { source: "chat", reason: `owner asked to top up $${symbol} energy on the app's get-energy card — at most ${usdgAmount} USDG` };
  }
  if (args?.source === "mcp-proposal") {
    return { source: "chat", reason: `owner approved a proposal to ${side} ${usdgAmount} USDG ${symbol}` };
  }
  return { source: "chat", reason: `owner asked to ${side} ${usdgAmount} USDG ${symbol} in chat` };
}

/**
 * Judge an order, and hand it to `submit` only if every gate passes.
 *
 * Returns `submit`'s reply untouched, or a refusal: `ok: false` with the
 * sentence the owner reads. A refusal never calls `submit`.
 *
 * `route` is orderRoute of the same args, decided here so the one function a
 * test drives is the one that says where an order goes.
 */
export async function placeOrder<R>(
  args: Record<string, unknown> | undefined,
  reads: OrderReads,
  submit: (side: Side, symbol: string, size: number, route: OrderRoute) => Promise<R>,
): Promise<R | { ok: false; line: string }> {
  const no = (line: string) => ({ ok: false as const, line });
  // ANSWERED, NOT STARVED. The tick's unreadable-market return sits a thousand
  // lines above the regular drain, so an order on such a tick used to be
  // skipped until it expired. It drains there now, with this flag set, and is
  // refused by name at once. The book, for the same reason: a tick that could
  // not read a balance or price a holding returns before equity is composed.
  // The same sentences a Telegram order gets from chatOrderGate.
  const unread = unreadRefusal(reads);
  if (unread) return no(unread);
  // PAUSE IS HONOURED HERE, not at the drain. The drain runs above the tick's
  // own pause return, deliberately — a paused agent can still be probed. An
  // order is the opposite: pause is the owner's stop button, and a trade that
  // executes through it is the worst surprise this app could produce.
  if (reads.paused) return no("you have me paused, so I did not place it. Un-pause and ask again.");
  const a = args ?? {};
  const side: Side | null = a.side === "buy" || a.side === "sell" ? a.side : null;
  if (!side) return no(`'${String(a.side)}' is not a buy or a sell`);
  // A BOOK THAT CANNOT BE TOTALLED CANNOT JUDGE A BUY — the same rule, and the
  // same sentence, submitChatTrade's gate gives a Telegram order.
  const untotalled = untotalledBuy(side, reads.equityKnown);
  if (untotalled) return no(untotalled);
  // A SYMBOL IS A SHORT PLAIN TICKER OR IT IS NOTHING. It is resolved against
  // the watch set by the submitter, so this only has to stop the shapes that
  // have no business reaching a lookup at all.
  const symbol = typeof a.symbol === "string" ? a.symbol.trim().toUpperCase() : "";
  if (!/^[A-Z0-9]{1,12}$/.test(symbol)) return no(`'${String(a.symbol)}' is not a symbol I can look up`);
  const size = typeof a.usdgAmount === "number" ? a.usdgAmount : Number(a.usdgAmount);
  // FINITE AND POSITIVE, SAID OUT LOUD. The wall refuses a non-positive swap by
  // name too — two gates, neither relying on the other — but NaN and Infinity
  // have to die before `usdg()` turns them into a BigInt throw.
  if (!Number.isFinite(size) || size <= 0) return no(`${String(a.usdgAmount)} is not an amount I can trade`);
  // THE OWNER'S OWN CEILING ON A TYPED ORDER. The sealed per-trade cap is a
  // wall; this is the owner's own smaller fence inside it.
  const ceiling = reads.ceilingUsdg;
  if (ceiling > 0 && size > ceiling) {
    return no(`${size} USDG is over your ${ceiling} USDG limit for a chat order. Raise it in Settings if you mean it.`);
  }
  return submit(side, symbol, size, orderRoute(a));
}
