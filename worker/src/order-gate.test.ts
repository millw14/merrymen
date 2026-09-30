/**
 * THE SECOND GATE, RUN RATHER THAN READ.
 *
 * Between the route that validated an owner's order and the code that signs
 * it, the order crossed a shared table, an orchestrator that can see every
 * tenant's home, and a JSON file. This gate is the one standing between a
 * string and a signed UserOperation. It used to live inline in main(), where
 * nothing could run it, and was pinned by reading the source — so the one
 * refusal a between-tick order depends on (a book this tick could not value)
 * could be deleted and every test stayed green.
 *
 * Every test here hands placeOrder a submitter that records being called: a
 * refusal is only a refusal if nothing reached it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  chatOrderGate,
  createTickBook,
  orderAsked,
  orderReadsOf,
  orderRoute,
  placeOrder,
  tickReads,
  type OrderReads,
  type OrderRoute,
  type StatedReads,
} from "./order-gate";

const READ: OrderReads = { marketUnreadable: false, bookUnreadable: false, equityKnown: true, paused: false, ceilingUsdg: 0 };
const BUY = { side: "buy", symbol: "TSLA", usdgAmount: 5 };
const SELL = { side: "sell", symbol: "TSLA", usdgAmount: 5 };

/** Run the gate with a submitter that records every call. */
async function place(args: Record<string, unknown> | undefined, reads: Partial<OrderReads> = {}) {
  const sent: { side: string; symbol: string; size: number }[] = [];
  const reply = await placeOrder(args, { ...READ, ...reads }, async (side, symbol, size) => {
    sent.push({ side, symbol, size });
    return { ok: true, line: "submitted" };
  });
  return { reply, sent };
}

/** A refusal: ok false, the sentence, and nothing sent. */
async function refused(args: Record<string, unknown> | undefined, reads: Partial<OrderReads>, line: RegExp) {
  const { reply, sent } = await place(args, reads);
  assert.equal(reply.ok, false);
  assert.match(reply.line, line);
  assert.deepEqual(sent, [], "a refusal is only a refusal if nothing reached the submitter");
}

describe("an order is never placed on numbers this tick could not read", () => {
  it("AN UNREADABLE MARKET REFUSES IT BY NAME — the breaker would be judging nothing", async () => {
    await refused(BUY, { marketUnreadable: true }, /I could not read the market this tick, so I did not place it/);
    await refused(SELL, { marketUnreadable: true }, /fact about my reads, not about your order/);
  });

  it("AN UNREAD BOOK REFUSES IT BY NAME — the order is never filled against the previous tick's equity", async () => {
    // The command tick's unread-book and unpriced-holding returns drain with
    // this flag set. Without the refusal the order fills against the equity
    // the PREVIOUS tick left behind: the forbidden "drain without re-reading".
    await refused(BUY, { bookUnreadable: true }, /I could not value your book this tick, so I did not place it/);
    await refused(SELL, { bookUnreadable: true }, /could not value your book/);
  });

  it("the reads come first — before the pause, and before the arguments are even looked at", async () => {
    await refused({ side: "yolo" }, { marketUnreadable: true, paused: true }, /could not read the market/);
    await refused({ side: "yolo" }, { bookUnreadable: true, paused: true }, /could not value your book/);
  });

  it("A BUY WITH THE BOOK UNTOTALLED IS REFUSED — checkPolicy would skip the drawdown breaker for it", async () => {
    // equityKnown is false when a holding has neither a price nor a cost on
    // record. policy.ts then runs the breaker only `if (state.equityKnown !==
    // false)`, so the buy would go out with the loss limit switched off.
    await refused(BUY, { equityKnown: false }, /I did not place it[\s\S]*the drawdown limit can't judge a buy/);
    await refused(BUY, { equityKnown: false }, /Selling still works/);
  });

  it("BUT A SELL STILL GOES THROUGH — exits are exempt from the breaker, and the owner can always get out", async () => {
    const { reply, sent } = await place(SELL, { equityKnown: false });
    assert.equal(reply.ok, true);
    assert.deepEqual(sent, [{ side: "sell", symbol: "TSLA", size: 5 }]);
  });
});

describe("pause is the owner's stop button", () => {
  it("A PAUSED AGENT PLACES NOTHING", async () => {
    await refused(BUY, { paused: true }, /you have me paused, so I did not place it/);
    await refused(SELL, { paused: true }, /Un-pause and ask again/);
  });
});

describe("what an argument may be, proved a second time", () => {
  it("A SIDE IS BUY OR SELL", async () => {
    await refused({ ...BUY, side: "yolo" }, {}, /'yolo' is not a buy or a sell/);
    await refused({ ...BUY, side: undefined }, {}, /is not a buy or a sell/);
    await refused(undefined, {}, /is not a buy or a sell/);
  });

  it("A SYMBOL IS A SHORT TICKER, not a sentence or a path", async () => {
    await refused({ ...BUY, symbol: "../../x" }, {}, /is not a symbol I can look up/);
    await refused({ ...BUY, symbol: "ABCDEFGHIJKLM" }, {}, /is not a symbol I can look up/);
    await refused({ ...BUY, symbol: 7 }, {}, /is not a symbol I can look up/);
    const { sent } = await place({ ...BUY, symbol: "  tsla " });
    assert.deepEqual(sent, [{ side: "buy", symbol: "TSLA", size: 5 }], "trimmed and upper-cased, as the watch set is keyed");
  });

  it("A SIZE IS FINITE AND POSITIVE — NaN and Infinity die before usdg() turns them into a throw", async () => {
    for (const usdgAmount of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, "lots", undefined]) {
      await refused({ ...BUY, usdgAmount }, {}, /is not an amount I can trade/);
    }
    const { sent } = await place({ ...BUY, usdgAmount: "2.5" });
    assert.deepEqual(sent, [{ side: "buy", symbol: "TSLA", size: 2.5 }], "a numeric string from the file is read as its number");
  });

  it("THE OWNER'S OWN CEILING ON A TYPED ORDER HOLDS HERE TOO", async () => {
    await refused({ ...BUY, usdgAmount: 26 }, { ceilingUsdg: 25 }, /26 USDG is over your 25 USDG limit for a chat order/);
    assert.equal((await place({ ...BUY, usdgAmount: 25 }, { ceilingUsdg: 25 })).reply.ok, true, "at the ceiling is allowed");
    assert.equal((await place({ ...BUY, usdgAmount: 10_000 }, { ceilingUsdg: 0 })).reply.ok, true, "no ceiling set is no ceiling");
  });
});

describe("an order that passes every gate is handed on exactly as validated", () => {
  it("side, symbol and size reach the submitter once, and its reply comes back untouched", async () => {
    const reply = { ok: true, line: "bought 5.00 USDG of TSLA", verdict: { kind: "no-row" as const } };
    let calls = 0;
    const out = await placeOrder(BUY, READ, async (side, symbol, size) => {
      calls += 1;
      assert.deepEqual([side, symbol, size], ["buy", "TSLA", 5]);
      return reply;
    });
    assert.equal(calls, 1);
    assert.equal(out, reply);
  });
});

/**
 * WHERE AN ORDER GOES IS DECIDED BY A MARKER, NEVER BY ITS SYMBOL.
 *
 * runOrderCommand used to send every order whose symbol read MERRYMEN to the
 * energy buy — a plain buy card, a snipe that resolved to a lookalike, an
 * approved MCP proposal for a watched coin at another address — none of which
 * showed the energy disclosure, and the lookalike's owner got a different,
 * key-unsellable asset. placeOrder now hands the submitter the route it
 * decided, and only get-energy's fixed `purpose: "energy"` makes it 'energy'.
 */
describe("the energy route is reached only by get-energy's marker", () => {
  /** Run placeOrder and record the route each call was handed. */
  async function routeOf(args: Record<string, unknown>): Promise<OrderRoute | null> {
    let got: OrderRoute | null = null;
    await placeOrder(args, READ, async (_side, _symbol, _size, route) => {
      got = route;
      return { ok: true, line: "submitted" };
    });
    return got;
  }

  it("A BUY CARD, A SNIPE AND AN MCP PROPOSAL NAMING MERRYMEN ARE ORDINARY TRADES — never the energy buy", async () => {
    // The three shapes, exactly as each placing path writes them.
    const buyCard = { side: "buy", symbol: "MERRYMEN", usdgAmount: 50 }; // chat-commands `buy`
    const snipe = { side: "buy", symbol: "merrymen", usdgAmount: 20 }; // Agent.tsx after /api/snipe resolved
    const mcp = { side: "buy", symbol: "MERRYMEN", usdgAmount: 20, source: "mcp-proposal", proposal: "p_1" }; // services/proposals.ts
    const mcpSell = { ...mcp, side: "sell" };
    for (const args of [buyCard, snipe, mcp, mcpSell]) {
      assert.equal(await routeOf(args), "trade", JSON.stringify(args));
    }
  });

  it("the get-energy card's marker, and only that exact value, routes to the energy buy", async () => {
    assert.equal(await routeOf({ side: "buy", symbol: "MERRYMEN", usdgAmount: 30, purpose: "energy" }), "energy");
    for (const purpose of ["Energy", "ENERGY", " energy", "energy ", true, 1, null, "reserve"]) {
      assert.equal(orderRoute({ side: "buy", symbol: "MERRYMEN", usdgAmount: 30, purpose }), "trade", String(purpose));
    }
    assert.equal(orderRoute(undefined), "trade");
    assert.equal(orderRoute({}), "trade");
  });

  it("a refused order is routed nowhere — the gates still run before the route matters", async () => {
    const { reply, sent } = await place({ side: "buy", symbol: "MERRYMEN", usdgAmount: 30, purpose: "energy" }, { paused: true });
    assert.equal(reply.ok, false);
    assert.deepEqual(sent, []);
  });
});

describe("what an owner order is filed under", () => {
  it("EVERY OWNER ORDER IS SOURCE 'chat' — the class the MCP outcome reader, provenance and inactivity key on", () => {
    for (const args of [{}, { source: "mcp-proposal" }, { purpose: "energy" }, undefined]) {
      assert.equal(orderAsked(args, "buy", "TSLA", 5).source, "chat");
    }
  });

  it("an approved MCP proposal says so, and is not filed as a chat message or an energy ask", () => {
    const r = orderAsked({ source: "mcp-proposal", proposal: "p_1" }, "buy", "MERRYMEN", 20).reason;
    assert.match(r, /approved a proposal to buy 20 USDG MERRYMEN/);
    assert.doesNotMatch(r, /in chat|energy/);
  });

  it("only the marked order is filed as an energy ask", () => {
    assert.match(orderAsked({ purpose: "energy" }, "buy", "MERRYMEN", 30).reason, /top up \$MERRYMEN energy on the app's get-energy card — at most 30 USDG/);
    assert.doesNotMatch(orderAsked({}, "buy", "MERRYMEN", 30).reason, /energy/);
    assert.equal(orderAsked({}, "sell", "TSLA", 5).reason, "owner asked to sell 5 USDG TSLA in chat");
  });
});

/**
 * EVERY DRAIN SAYS WHAT ITS TICK READ.
 *
 * runQueuedCommand, runCommand and runOrderCommand took the two read flags as
 * positional booleans defaulting to false, so a drain site that dropped them
 * still typechecked — and an order drained on a tick that could not value the
 * book was judged against the PREVIOUS tick's equity, which the doNotDo list
 * forbids by name. And the order's equityKnown was a literal read off a global
 * beside them. The tick now hands its reads over whole, built here, and none is
 * defaulted: a drain that states nothing does not compile.
 */
describe("every drain states what its tick read", () => {
  const OWNER = { paused: false, ceilingUsdg: 0 };
  /** placeOrder, fed the reads a drain site builds. */
  const drained = async (args: Record<string, unknown>, tick: ReturnType<typeof tickReads.composed>, owner = OWNER) => {
    const sent: string[] = [];
    const reply = await placeOrder(args, orderReadsOf(tick, owner), async (side) => {
      sent.push(side);
      return { ok: true, line: "submitted" };
    });
    return { reply, sent };
  };

  it("A TICK THAT COULD NOT READ THE MARKET REFUSES THE ORDER BY NAME — a buy and a sell alike", async () => {
    for (const args of [BUY, SELL]) {
      const { reply, sent } = await drained(args, tickReads.marketUnread());
      assert.match(reply.line, /I could not read the market this tick/);
      assert.deepEqual(sent, []);
    }
  });

  it("A TICK THAT COULD NOT VALUE THE BOOK REFUSES IT BY NAME — never judged on the last tick's equity", async () => {
    for (const args of [BUY, SELL]) {
      const { reply, sent } = await drained(args, tickReads.bookUnread());
      assert.match(reply.line, /I could not value your book this tick/);
      assert.deepEqual(sent, []);
    }
  });

  it("A TICK THAT READ THE BOOK BUT COULD NOT TOTAL IT REFUSES A BUY, AND PLACES A SELL", async () => {
    const buy = await drained(BUY, tickReads.composed(false));
    assert.match(buy.reply.line, /the drawdown limit can't judge a buy/);
    assert.deepEqual(buy.sent, []);
    const sell = await drained(SELL, tickReads.composed(false));
    assert.deepEqual(sell.sent, ["sell"]);
  });

  it("a tick that totalled its book places the order", async () => {
    assert.deepEqual((await drained(BUY, tickReads.composed(true))).sent, ["buy"]);
  });

  it("the owner's pause and ceiling ride along with the tick's reads, unchanged", async () => {
    assert.match((await drained(BUY, tickReads.composed(true), { paused: true, ceilingUsdg: 0 })).reply.line, /you have me paused/);
    assert.match(
      (await drained({ ...BUY, usdgAmount: 26 }, tickReads.composed(true), { paused: false, ceilingUsdg: 25 })).reply.line,
      /over your 25 USDG limit/,
    );
  });
});

/**
 * ONE GATE FOR EVERY ORDER, WHOEVER PLACED IT — judged on the book the latest
 * tick actually left.
 *
 * The refusals lived only in placeOrder, which only an app order reaches. A
 * buy typed in Telegram went straight to submitChatTrade, which judged it on
 * two globals — lastEquityUsdg and lastEquityKnown — that only a tick which
 * COMPOSED equity wrote. The three returns that end a tick which could not read
 * the market, a balance or a price left them as the tick before had set them,
 * `equityKnown: true` included, so the Telegram buy went on to the wall with
 * the previous tick's equity while an app order drained on the same tick was
 * refused by name, and the owner's own feed said "trading + equity paused".
 *
 * Both now judge against one record, createTickBook, which every way a tick
 * ends writes. The tests drive it the way tick() does and compare each
 * Telegram answer with what placeOrder says to an app order drained on the
 * very reads the book handed that drain.
 */
describe("one gate for every order, whoever placed it", () => {
  const EQUITY = 100_000_000n;
  /** The app's answer to `args`, drained with the reads the tick stated to the book. */
  const appSays = async (args: Record<string, unknown>, reads: StatedReads) => {
    const sent: string[] = [];
    const reply = await placeOrder(args, orderReadsOf(reads, { paused: false, ceilingUsdg: 0 }), async (side) => {
      sent.push(side);
      return { ok: true, line: "submitted" };
    });
    return { reply, sent };
  };
  /** A book whose last tick composed and totalled its equity. */
  const good = () => {
    const book = createTickBook();
    book.composed(EQUITY, true);
    return book;
  };

  for (const what of ["market", "book"] as const) {
    it(`AFTER A TICK THAT COULD NOT READ THE ${what.toUpperCase()}, A TELEGRAM BUY IS REFUSED EXACTLY AS THE APP ORDER IS`, async () => {
      const book = good();
      // The early return: it states its reads, and drains the app's order with them.
      const drained = book.unread(what);
      const app = await appSays(BUY, drained);
      assert.equal(app.reply.ok, false);
      assert.deepEqual(app.sent, [], "the app's order was refused");
      // A buy typed in Telegram a moment later, before the next tick.
      const telegram = book.judge("buy");
      assert.equal(telegram.ok, false, "the Telegram buy must not go on to the wall on the last tick's equity");
      assert.equal(telegram.ok ? "" : telegram.line, (app.reply as { line: string }).line, "the same sentence");
      assert.match(telegram.ok ? "" : telegram.line, what === "market" ? /could not read the market/ : /could not value your book/);
    });

    it(`and a sell after it is answered the same way on both surfaces (${what})`, async () => {
      const book = good();
      const app = await appSays(SELL, book.unread(what));
      const telegram = book.judge("sell");
      assert.equal(telegram.ok, false);
      assert.equal(telegram.ok ? "" : telegram.line, (app.reply as { line: string }).line);
    });
  }

  it("THE NEXT TICK THAT COMPOSES LIFTS IT — the book, not a latch, decides", () => {
    const book = good();
    book.unread("book");
    book.composed(120_000_000n, true);
    assert.deepEqual(book.judge("buy"), { ok: true, equityUsdg: 120_000_000n, equityKnown: true });
  });

  it("an unread tick keeps the last composed figure for display, and vouches for none of it", () => {
    const book = good();
    book.unread("market");
    assert.equal(book.latest().equityUsdg, EQUITY);
    assert.equal(book.latest().reads.equityKnown, false);
    assert.equal(book.latest().reads.marketUnreadable, true);
  });

  it("A TELEGRAM BUY WITH THE BOOK UNTOTALLED IS REFUSED WITH THE APP ORDER'S OWN SENTENCE", async () => {
    const book = createTickBook();
    const drained = book.composed(EQUITY, false);
    const app = await appSays(BUY, drained);
    assert.equal(app.reply.ok, false);
    const telegram = book.judge("buy");
    assert.equal(telegram.ok ? "" : telegram.line, (app.reply as { line: string }).line);
  });

  it("BUT A SELL STILL GOES THROUGH — the owner can always get out of the holding that untotals the book", async () => {
    const book = createTickBook();
    const drained = book.composed(EQUITY, false);
    assert.deepEqual((await appSays(SELL, drained)).sent, ["sell"]);
    // And the wall is told the book could not be totalled, not the opposite.
    assert.deepEqual(book.judge("sell"), { ok: true, equityUsdg: EQUITY, equityKnown: false });
  });

  it("with the book read and totalled nothing is refused here — the wall judges the rest, on this tick's equity", async () => {
    const book = good();
    for (const side of ["buy", "sell"] as const) {
      assert.deepEqual(book.judge(side), { ok: true, equityUsdg: EQUITY, equityKnown: true });
    }
    assert.deepEqual((await appSays(BUY, book.composed(EQUITY, true))).sent, ["buy"]);
  });

  it("BEFORE THE FIRST TICK HAS READ THE BOOK, NOTHING IS PLACED — a buy or a sell", () => {
    // Equity is still its 0n initialiser, and the breaker would judge garbage.
    const book = createTickBook();
    for (const side of ["buy", "sell"] as const) {
      const j = book.judge(side);
      assert.match(j.ok ? "" : j.line, /still saddling up \(first tick pending\)/);
    }
    // Nor after a first tick that could not read.
    book.unread("book");
    assert.match((j => (j.ok ? "" : j.line))(book.judge("buy")), /still saddling up/);
  });

  it("chatOrderGate itself: the saddle, then the reads, then the untotalled buy", () => {
    assert.match(chatOrderGate("buy", { reads: tickReads.composed(true), equityUsdg: 0n }) ?? "", /saddling up/);
    assert.match(chatOrderGate("buy", { reads: tickReads.marketUnread(), equityUsdg: EQUITY }) ?? "", /could not read the market/);
    assert.match(chatOrderGate("sell", { reads: tickReads.bookUnread(), equityUsdg: EQUITY }) ?? "", /could not value your book/);
    assert.match(chatOrderGate("buy", { reads: tickReads.composed(false), equityUsdg: EQUITY }) ?? "", /can't judge a buy/);
    assert.equal(chatOrderGate("sell", { reads: tickReads.composed(false), equityUsdg: EQUITY }), null);
    assert.equal(chatOrderGate("buy", { reads: tickReads.composed(true), equityUsdg: EQUITY }), null);
  });
});

/**
 * A TICK THAT FAILS BEFORE IT SAYS WHAT IT READ CANNOT VOUCH FOR THE BOOK.
 *
 * A tick that throws between its market read and its equity leaves nothing
 * behind but the previous tick's statement, which is the stale-global shape the
 * book exists to end. tick() runs through during(), so such a tick leaves the
 * book unread; one that composed before it failed, or returned early having
 * read nothing, leaves what it last stated.
 */
describe("a tick that fails states that it failed", () => {
  it("A TICK THAT THROWS BEFORE STATING ITS READS REFUSES EVERY ORDER UNTIL ONE DOES", async () => {
    const book = createTickBook();
    book.composed(100_000_000n, true);
    await assert.rejects(book.during(async () => {
      throw new Error("getBasis failed");
    }));
    const j = book.judge("buy");
    assert.equal(j.ok, false);
    assert.match(j.ok ? "" : j.line, /could not value your book this tick/);
  });

  it("one that composed before it threw keeps what it composed", async () => {
    const book = createTickBook();
    await assert.rejects(book.during(async () => {
      book.composed(90_000_000n, true);
      throw new Error("a producer failed after the book was read");
    }));
    assert.deepEqual(book.judge("buy"), { ok: true, equityUsdg: 90_000_000n, equityKnown: true });
  });

  it("one that returned early having read nothing leaves the last statement standing", async () => {
    const book = createTickBook();
    book.composed(90_000_000n, true);
    assert.equal(await book.during(async () => 7), 7);
    assert.deepEqual(book.judge("sell"), { ok: true, equityUsdg: 90_000_000n, equityKnown: true });
  });

  it("the tick is called before during() first awaits — a flag it reads in its first statement is still set", () => {
    const book = createTickBook();
    let flag = true;
    let seen: boolean | null = null;
    const run = book.during(async () => {
      seen = flag;
    });
    flag = false;
    assert.equal(seen, true);
    return run;
  });

  it("a failure that follows a good tick does not leak into the one after it", async () => {
    const book = createTickBook();
    await assert.rejects(book.during(async () => {
      throw new Error("x");
    }));
    await book.during(async () => {
      book.composed(80_000_000n, true);
    });
    assert.deepEqual(book.judge("buy"), { ok: true, equityUsdg: 80_000_000n, equityKnown: true });
  });
});
