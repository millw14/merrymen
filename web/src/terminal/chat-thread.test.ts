/**
 * THE THREAD'S RULES, RUN: receipts templated from ledger facts, the agent's
 * own fills merged in once each, the model told only what was said, chips that
 * never suggest a size the wall would refuse, and failures said as the agent.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ChatMessage, ChatTurn } from "./account";
import type { Thesis } from "./live";
import type { OrderReceipt } from "@/lib/order-state";
import {
  absorbFill,
  amountCeiling,
  capThread,
  chatChips,
  chatTape,
  failureLine,
  fillParts,
  historyFor,
  MAX_MESSAGES,
  mergeFills,
  newestAt,
  receiptParts,
  receiptText,
  llmFailureOf,
  refocusAfterSend,
  retryHelps,
  tradeKeyOf,
  turnsToMessages,
} from "./chat-thread";

const receipt = (over: Partial<OrderReceipt> = {}): OrderReceipt => ({
  status: "filled",
  side: "buy",
  symbol: "CASHCAT",
  token: null,
  usdgActual: 5,
  txHash: null,
  rejectRule: null,
  ...over,
});

const move = (over: Partial<Thesis> = {}): Thesis => ({
  name: "Robin",
  slug: "robin",
  handle: null,
  action: "buy",
  symbol: "CASHCAT",
  sizeUsdg: 5,
  reason: "momentum",
  paper: false,
  head: "trencher",
  at: 1_800_000_000,
  outcome: "landed",
  ...over,
});

const msg = (over: Partial<ChatMessage>): ChatMessage => ({ id: "m", role: "agent", at: null, text: "", ...over });

describe("a receipt is templated, never written", () => {
  it('RENDERS "[Buy] $5.00 CASHCAT · Filled"', () => {
    assert.equal(receiptText(receipt()), "[Buy] $5.00 CASHCAT · Filled");
    assert.deepEqual(receiptParts(receipt({ side: "sell", usdgActual: 12.5 })), { side: "Sell", line: "$12.50 CASHCAT · Filled" });
  });

  it("A REFUSAL SAYS WHICH RULE, in words", () => {
    const t = receiptText(receipt({ status: "refused", usdgActual: null, rejectRule: "no-cash" }));
    assert.equal(t, "[Buy] CASHCAT · Refused — the account held no USDG to trade with");
  });

  it("an unknown rule is named rather than dropped", () => {
    assert.match(receiptText(receipt({ status: "refused", usdgActual: null, rejectRule: "brand-new-rule" })), /Refused — brand-new-rule$/);
  });

  it("A FIGURE NOBODY READ IS NOT PRINTED — never $0.00, never a guessed coin", () => {
    const t = receiptText(receipt({ usdgActual: null, symbol: null, token: null }));
    assert.equal(t, "[Buy] Token label unavailable · Filled");
    assert.ok(!t.includes("$"));
    // An address the ledger did record is shown as one, not dressed as a ticker.
    assert.equal(receiptParts(receipt({ symbol: null, token: "0x" + "ab".repeat(20) })).line, "$5.00 0xabab…abab · Filled");
  });

  it("a side nobody recorded gets no pill", () => {
    assert.deepEqual(receiptParts(receipt({ side: null, status: "expired", usdgActual: null })), { side: null, line: "CASHCAT · Expired" });
  });
});

describe("the agent's own fills, merged into the thread", () => {
  const since = 1_800_000_000 - 1;

  it("A NEW LANDED FILL APPEARS ONCE, keyed by the trade", () => {
    const first = mergeFills([], [move()], since);
    assert.equal(first.length, 1);
    assert.equal(first[0]!.role, "event");
    assert.equal(first[0]!.side, "buy");
    assert.equal(first[0]!.text, "$5.00 CASHCAT · Filled");
    assert.equal(first[0]!.trade?.symbol, "CASHCAT");
    // The next refresh brings the same tape: nothing is added twice.
    const again = mergeFills(first, [move()], since);
    assert.equal(again, first, "an unchanged tape changes nothing");
  });

  it("NOTHING OLDER THAN THE WATERMARK IS DUMPED INTO THE THREAD", () => {
    assert.deepEqual(mergeFills([], [move({ at: since - 100 }), move({ at: since })], since), []);
  });

  it("refusals, pendings, views and holds are not fills", () => {
    const tape = [
      move({ outcome: "refused", at: since + 1 }),
      move({ outcome: "pending", at: since + 2 }),
      move({ action: "hold", at: since + 3 }),
      move({ outcome: "reverted", at: since + 4 }),
    ];
    assert.deepEqual(mergeFills([], tape, since), []);
  });

  it("A PAPER FILL IS NOT ANNOUNCED AS A FILL", () => {
    // The tape books a paper trade as "landed", and the thread read that as a
    // fill: "$5.00 CASHCAT · Filled on paper" on a surface that reads as money,
    // an unread dot for every practice trade, and a paper agent that trades
    // every tick turning the eighty-line thread into a trade log. The worker's
    // receipt refuses to call a paper trade "filled" for the same reason.
    assert.deepEqual(mergeFills([], [move({ paper: true })], since), []);
    assert.deepEqual(mergeFills([], [move({ paper: true, action: "sell" }), move({ paper: true, at: since + 5 })], since), []);
    // And a real fill beside it still is one.
    assert.equal(mergeFills([], [move({ paper: true, at: since + 5 }), move()], since).length, 1);
  });

  it("A CHAT ORDER'S RECEIPT IS THE SAME TRADE, not a second one", () => {
    const placed = msg({ id: "o", at: 1_800_000_000 * 1000 - 30_000, text: "bought 5.00 USDG of CASHCAT", order: { id: "abc", receipt: receipt() } });
    const merged = mergeFills([placed], [move()], since);
    assert.equal(merged.length, 1, "the fill joins the receipt instead of repeating it");
    assert.equal(merged[0]!.trade?.symbol, "CASHCAT");
    assert.ok(merged[0]!.tradeKey);
  });

  it("but a DIFFERENT fill of the same coin is its own event", () => {
    const placed = msg({ id: "o", at: 1_800_000_000 * 1000, order: { id: "abc", receipt: receipt({ usdgActual: 20 }) } });
    assert.equal(mergeFills([placed], [move()], since).length, 2);
  });

  it("A RELOADED THREAD GETS ITS CARDS BACK from the tape, however old", () => {
    // `trade` is never stored — only its key — so a reload re-reads it.
    const key = tradeKeyOf(move({ at: since - 500 }))!;
    const kept = msg({ id: "f", role: "event", text: "$5.00 CASHCAT · Filled", tradeKey: key, side: "buy" });
    const back = mergeFills([kept], [move({ at: since - 500 })], since);
    assert.equal(back[0]!.trade?.at, since - 500);
    assert.equal(back.length, 1);
  });

  it("A RECEIPT THAT ARRIVES AFTER ITS FILL ABSORBS IT, rather than repeating it", () => {
    // The tape can show the fill before the order's poll hears back. The
    // receipt then takes the fill's card and the fill's own line goes.
    const merged = mergeFills([], [move()], since);
    const answer = msg({ id: "o", at: 1_800_000_000 * 1000 + 5_000, text: "bought it", order: { id: "abc", receipt: receipt() } });
    const after = absorbFill([...merged, answer], "o");
    assert.equal(after.length, 1);
    assert.equal(after[0]!.id, "o");
    assert.equal(after[0]!.tradeKey, merged[0]!.tradeKey);
    assert.equal(after[0]!.trade?.symbol, "CASHCAT");
    // A receipt for a different size leaves the fill where it was.
    const other = msg({ id: "p", at: 1_800_000_000 * 1000, order: { id: "def", receipt: receipt({ usdgActual: 9 }) } });
    assert.equal(absorbFill([...merged, other], "p").length, 2);
  });

  it("A FILL THAT FALLS OFF THE TOP OF A FULL THREAD IS NOT NEWS AGAIN", () => {
    // The thread keeps its newest lines, so a busy agent's oldest fill lines
    // go first — while the tape (the newest thirty operations) still holds
    // those trades. Trimmed and forgotten, the next refresh found them
    // "missing" and newer than the watermark, and put them back at the BOTTOM
    // of the thread as if they had just happened, one per refresh, pushing
    // out the conversation as they went.
    const tape = [move({ at: since + 1 }), move({ at: since + 2, symbol: "PEPE" })];
    const fills = mergeFills([], tape, since);
    const chatter = Array.from({ length: MAX_MESSAGES - 2 }, (_, i) => msg({ id: `c${i}`, role: "owner", text: `line ${i}` }));
    const full = [...fills, ...chatter, msg({ id: "new", role: "owner", text: "one more" })];
    const kept = capThread({ messages: full, since });
    assert.equal(kept.messages.length, MAX_MESSAGES);
    assert.equal(kept.messages[0]!.id, fills[1]!.id, "the oldest line went");
    assert.equal(mergeFills(kept.messages, tape, kept.since!), kept.messages, "and the tape does not bring it back as news");
    // A fill newer than anything trimmed is still news.
    const later = mergeFills(kept.messages, [move({ at: since + 3, symbol: "WIF" }), ...tape], kept.since!);
    assert.equal(later.at(-1)!.text, "$5.00 WIF · Filled");
  });

  it("a thread under the limit is returned as it was, watermark and all", () => {
    const t = { messages: [msg({ id: "a" })], since: 7 };
    assert.equal(capThread(t), t);
    // A watermark the tape never set stays unset: "first sight" is still first.
    const unset = capThread({ messages: Array.from({ length: MAX_MESSAGES + 1 }, (_, i) => msg({ id: `x${i}` })), since: null });
    assert.equal(unset.since, null);
  });

  it("A TAPE NOBODY READ IS NOT AN EMPTY ONE", () => {
    // Handed [] for a failed read, the thread would take "nothing" as its
    // first sight, and the next good read would pour every fill in as news.
    const tape = [move()];
    assert.equal(chatTape({ agentExists: true, read: "ok", moves: tape }), tape);
    assert.deepEqual(chatTape({ agentExists: true, read: "ok", moves: [] }), [], "read and empty is empty");
    for (const read of ["unread", "failed", "unreadable", undefined]) {
      assert.equal(chatTape({ agentExists: true, read, moves: [] }), null, `${read} is not a tape`);
    }
    assert.equal(chatTape({ agentExists: false, read: "ok", moves: tape }), null, "no agent, no tape");
    assert.equal(chatTape({ agentExists: undefined, read: "ok", moves: tape }), null, "an account not read yet, no tape");
    assert.equal(chatTape({ agentExists: true, read: "ok", moves: undefined }), null);
  });

  it("the watermark is the newest trade already on the tape", () => {
    assert.equal(newestAt([move({ at: 5 }), move({ at: 9 }), move({ at: undefined })]), 9);
    assert.equal(newestAt([]), 0);
  });

  it("the key prefers the chain hash when the tape carries one", () => {
    const tx = "0x" + "cd".repeat(32);
    assert.equal(tradeKeyOf({ ...move(), txHash: tx } as Thesis), `tx:${tx}`);
    assert.equal(tradeKeyOf(move({ action: "hold" })), null);
  });
});

describe("a chat SELL joins its fill too", () => {
  // A sell's receipt and its tape row do not carry the same figure: the tape's
  // size is the order's (amount_usdg), the receipt's is the cash the fill
  // returned, or nothing when the cost was booked from the quote. The join
  // demanded the two agree to the cent, so every sell was two "Filled" lines,
  // sometimes with two different dollar figures.
  const T = 1_800_000_000;
  const since = T - 3_600;
  const sold = (over: Partial<Thesis> = {}) => move({ action: "sell", symbol: "TSLA", sizeUsdg: 5.01, at: T, ...over });
  const placed = msg({ id: "p", at: T * 1000 - 60_000, text: "Placed it — sell TSLA.", order: { id: "abc" } });
  const answer = (over: Partial<OrderReceipt> = {}, at = T * 1000 + 20_000) =>
    msg({ id: "o", at, text: "sold TSLA", order: { id: "abc", receipt: receipt({ side: "sell", symbol: "TSLA", usdgActual: null, ...over }) } });
  const events = (m: ChatMessage[]) => m.filter((x) => x.role === "event");

  it("A QUOTE-BOOKED SELL IS ONE LINE — its receipt names no figure", () => {
    const merged = mergeFills([placed, answer()], [sold()], since);
    assert.equal(events(merged).length, 0, "no second line");
    assert.equal(merged[1]!.trade?.symbol, "TSLA", "the receipt holds the fill's card");
  });

  it("A RECEIPT-BOOKED SELL IS ONE LINE, whatever its figure says", () => {
    const merged = mergeFills([placed, answer({ usdgActual: 4.97 })], [sold()], since);
    assert.equal(events(merged).length, 0);
    assert.ok(merged[1]!.tradeKey);
  });

  it("AND WHEN THE TAPE SHOWS IT FIRST, the receipt absorbs it", () => {
    const tapeFirst = mergeFills([placed], [sold()], since);
    assert.equal(events(tapeFirst).length, 1);
    const after = absorbFill([...tapeFirst, answer()], "o");
    assert.equal(events(after).length, 0);
    assert.equal(after.at(-1)!.tradeKey, tapeFirst.at(-1)!.tradeKey);
  });

  it("A SELL OF THE SAME COIN FROM BEFORE THE ORDER WAS PLACED IS NOT ITS FILL", () => {
    // With no size to go on, the order's own life is the window: after it was
    // placed, and before it was answered. The agent's own earlier sell of the
    // same coin is its own line, in either order of arrival.
    const earlier = sold({ at: T - 600, sizeUsdg: 2 });
    const merged = mergeFills([placed, answer()], [sold(), earlier], since);
    assert.equal(merged[1]!.trade?.at, T, "the receipt took the order's fill");
    assert.deepEqual(events(merged).map((e) => e.trade?.at), [T - 600], "and the earlier sell kept its own line");
    const tapeFirst = mergeFills([placed], [earlier], since);
    assert.equal(absorbFill([...tapeFirst, answer()], "o").filter((m) => m.role === "event").length, 1, "an earlier sell is never absorbed");
  });

  it("NOR IS ONE THAT FILLED AFTER THE ORDER WAS ANSWERED", () => {
    // A receipt is written after its fill, so a sell minutes after the answer
    // is the agent's own next trade.
    const later = sold({ at: T + 600 });
    assert.equal(events(mergeFills([placed, answer()], [later], since)).length, 1);
  });

  it("TWO FILLS IN THE WINDOW: the receipt takes the one nearest its answer", () => {
    const soon = sold({ at: T - 50, sizeUsdg: 1 });
    const merged = mergeFills([placed, answer()], [sold(), soon], since);
    assert.equal(merged[1]!.trade?.at, T);
    const tapeFirst = mergeFills([placed], [soon, sold()], since);
    const after = absorbFill([...tapeFirst, answer()], "o");
    assert.equal(after.find((m) => m.id === "o")!.trade?.at, T);
    assert.deepEqual(events(after).map((e) => e.trade?.at), [T - 50]);
  });

  it("THE CHAIN HASH DECIDES when both sides carry one", () => {
    const tx = "0x" + "ab".repeat(32);
    const other = "0x" + "cd".repeat(32);
    const withHash = (h: string) => ({ ...sold(), txHash: h }) as Thesis;
    assert.equal(events(mergeFills([placed, answer({ txHash: tx })], [withHash(tx)], since)).length, 0, "the same hash is one trade");
    assert.equal(events(mergeFills([placed, answer({ txHash: tx })], [withHash(other)], since)).length, 1, "a different hash is not, whatever else agrees");
  });

  it("a buy's size must still agree — two buys of one coin are two trades", () => {
    const bought = answer({ side: "buy", symbol: "CASHCAT", usdgActual: 20 });
    assert.equal(events(mergeFills([placed, bought], [move({ at: T })], since)).length, 1);
  });

  it("TWO SELLS OF ONE COIN: each receipt takes its own fill, and the second is not shown twice", () => {
    // Both orders' lives can hold the first fill — the second order was placed
    // before the first one's fill had reached the tape — so both receipts can
    // claim it. Only one may. Otherwise, when the second fill arrives, both
    // receipts are already keyed to the first, and the second sell shows twice:
    // once on its receipt and once as a fill line of its own.
    const two = [
      msg({ id: "p1", at: T * 1000 - 100_000, text: "Placed 1", order: { id: "aaa" } }),
      msg({ id: "o1", at: T * 1000 + 20_000, text: "sold 1", order: { id: "aaa", receipt: receipt({ side: "sell", symbol: "TSLA", usdgActual: null }) } }),
      msg({ id: "p2", at: T * 1000 + 30_000, text: "Placed 2", order: { id: "bbb" } }),
      msg({ id: "o2", at: T * 1000 + 90_000, text: "sold 2", order: { id: "bbb", receipt: receipt({ side: "sell", symbol: "TSLA", usdgActual: null }) } }),
    ];
    const first = mergeFills(two, [sold()], since);
    assert.equal(first.find((m) => m.id === "o1")!.trade?.at, T, "the first receipt takes the first fill");
    assert.equal(first.find((m) => m.id === "o2")!.tradeKey, undefined, "and the second does not take it too");
    const second = mergeFills(first, [sold({ at: T + 60 }), sold()], since);
    assert.equal(second.find((m) => m.id === "o2")!.trade?.at, T + 60, "the second receipt takes the second fill");
    assert.deepEqual(events(second), [], "two sells, two lines — no fill line left over");
  });
});

describe("a browser clock that is wrong does not split one trade", () => {
  // Every line's `at` is THIS BROWSER's clock; a fill's is the worker's. The
  // join held one against the other with two minutes of slack, so a browser
  // three minutes off showed one chat buy as two "Filled" lines — the half
  // hour either side it had before tolerated that — and a sell the same.
  // order-follow.ts documents browser clocks eleven minutes fast.
  const T = 1_800_000_000;
  const since = T - 3_600;
  /** The true moments: placed twenty seconds before the fill, answered fifteen after. */
  const PLACED = T * 1000 - 20_000;
  const ANSWERED = T * 1000 + 15_000;
  const SKEWS = [0, 3, 5, 11, -3, -5, -11];
  /**
   * The two lines a chat order leaves, stamped by a browser `skewMin` off. The
   * placing line keeps the server's own placement time when POST gave it.
   */
  const lines = (side: "buy" | "sell", skewMin: number, server = true) => [
    msg({ id: "p", at: PLACED + skewMin * 60_000, text: "Placed it", order: { id: "abc", ...(server ? { serverPlacedAt: PLACED } : {}) } }),
    msg({
      id: "o",
      at: ANSWERED + skewMin * 60_000,
      text: "done",
      order: { id: "abc", receipt: receipt({ side, symbol: "TSLA", usdgActual: side === "buy" ? 5 : null }) },
    }),
  ];
  const fill = (side: "buy" | "sell", over: Partial<Thesis> = {}) => move({ action: side, symbol: "TSLA", sizeUsdg: 5, at: T, ...over });
  const events = (m: ChatMessage[]) => m.filter((x) => x.role === "event");
  /** Extra lines for one trade, in both orders of arrival. */
  const extra = (side: "buy" | "sell", skewMin: number, server = true) => {
    const [placed, answer] = lines(side, skewMin, server);
    const receiptFirst = events(mergeFills([placed!, answer!], [fill(side)], since)).length;
    const tapeFirst = events(absorbFill([...mergeFills([placed!], [fill(side)], since), answer!], "o")).length;
    return [receiptFirst, tapeFirst];
  };

  for (const side of ["buy", "sell"] as const) {
    it(`A CHAT ${side.toUpperCase()} IS ONE LINE HOWEVER FAR THE BROWSER'S CLOCK IS OFF — the order's life is read on the server's`, () => {
      for (const skew of SKEWS) assert.deepEqual(extra(side, skew), [0, 0], `${skew} minutes off`);
    });
  }

  it("A BUY WHOSE PLACING THE SERVER DID NOT TIME STILL JOINS ON ITS SIZE, within half an hour either side", () => {
    // A thread kept from before the placing line carried the server's time, or
    // an order found after its placing was lost: its size is what tells two
    // buys apart, and the old tolerance holds for it.
    for (const skew of SKEWS) assert.deepEqual(extra("buy", skew, false), [0, 0], `${skew} minutes off`);
    assert.deepEqual(extra("buy", 40, false), [1, 1], "but not a fill forty minutes from the answer");
  });

  it("ON THE SERVER'S CLOCK THE ORDER'S LIFE STILL SHUTS OUT THE AGENT'S OWN SELLS of the same coin", () => {
    for (const skew of [5, -5, 11]) {
      const earlier = fill("sell", { at: T - 600, sizeUsdg: 2 });
      const later = fill("sell", { at: T + 600, sizeUsdg: 3 });
      const merged = mergeFills(lines("sell", skew), [later, fill("sell"), earlier], since);
      assert.equal(merged.find((m) => m.id === "o")!.trade?.at, T, `${skew}m: the receipt took the order's own fill`);
      assert.deepEqual(events(merged).map((e) => e.trade?.at), [T - 600, T + 600], `${skew}m: the others kept their own lines`);
    }
  });

  it("OF TWO SELLS INSIDE THE ORDER'S LIFE, THE NEAREST IS JUDGED ON THE SERVER'S CLOCK TOO", () => {
    // The agent's own sell of the coin 100 s after the chat sell filled is
    // still inside the order's life and its slack, so both sells match and the
    // nearer one wins. Measured from the answer line's own `at` — this
    // browser's clock, eleven minutes fast — the agent's sell was the nearer:
    // the receipt took the agent's trade's card, and the chat order's own fill
    // became a second "Filled" line. Two trades crossed, one sell shown twice.
    for (const skew of [11, -11, 0]) {
      const own = fill("sell");
      const agents = fill("sell", { at: T + 100, sizeUsdg: 3 });
      const [placed, answer] = lines("sell", skew);
      const receiptFirst = mergeFills([placed!, answer!], [agents, own], since);
      const tapeFirst = absorbFill([...mergeFills([placed!], [agents, own], since), answer!], "o");
      for (const [order, merged] of [["receipt first", receiptFirst], ["tape first", tapeFirst]] as const) {
        assert.equal(merged.find((m) => m.id === "o")!.trade?.at, T, `${skew}m, ${order}: the receipt took the order's own fill`);
        assert.deepEqual(events(merged).map((e) => e.trade?.at), [T + 100], `${skew}m, ${order}: the agent's sell is its own line, once`);
      }
    }
  });

  it("AND A BUY OF THE SAME SIZE FROM BEFORE THE ORDER IS NOT ITS FILL, once its life is on the server's clock", () => {
    // The agent's own $5 buy of the coin ten minutes before the owner asked
    // agrees on every fact but time. With the order's life known, a receipt
    // whose own fill has not reached the tape yet waits for it.
    const earlier = fill("buy", { at: T - 600 });
    const early = mergeFills(lines("buy", 5), [earlier], since);
    assert.equal(early.find((m) => m.id === "o")!.tradeKey, undefined, "the receipt waits");
    assert.deepEqual(events(early).map((e) => e.trade?.at), [T - 600]);
    const later = mergeFills(early, [fill("buy"), earlier], since);
    assert.equal(later.find((m) => m.id === "o")!.trade?.at, T, "and takes its own fill when it comes");
    assert.deepEqual(events(later).map((e) => e.trade?.at), [T - 600]);
  });
});

describe("the tape learning a trade's hash", () => {
  it("A LINE KEYED BEFORE THE TAPE CARRIED THE HASH IS NOT REPEATED ONCE IT DOES", () => {
    // Owner moves now carry t.tx_hash, and the hash is the better key. A fill
    // already in the thread under its old key must not come back as news
    // under the new one.
    const since = 1_800_000_000 - 1;
    const first = mergeFills([], [move()], since);
    assert.equal(first.length, 1);
    const hashed = { ...move(), txHash: "0x" + "ef".repeat(32) } as Thesis;
    const kept = first.map(({ trade: _t, ...m }) => m);
    const again = mergeFills(kept, [hashed], since);
    assert.equal(again.length, 1, "one trade, one line");
    assert.equal(again[0]!.trade?.symbol, "CASHCAT", "and it gets its card back");
  });
});

describe("what the model is told was said", () => {
  it("OWNER AND AGENT, IN ORDER; the agent's failures are ours, not its words", () => {
    const h = historyFor([
      msg({ id: "1", role: "owner", text: "buy tsla" }),
      msg({ id: "2", role: "agent", text: "How much?" }),
      msg({ id: "3", role: "owner", text: "$5" }),
      msg({ id: "4", role: "agent", text: "I couldn't reach you", failed: "network" }),
      msg({ id: "5", role: "event", side: "buy", text: "$5.00 TSLA · Filled" }),
    ]);
    assert.deepEqual(h, [
      { role: "user", content: "buy tsla" },
      { role: "assistant", content: "How much?" },
      { role: "user", content: "$5" },
      { role: "assistant", content: "[Buy] $5.00 TSLA · Filled" },
    ]);
  });

  it("only the last eight", () => {
    const many = Array.from({ length: 20 }, (_, i) => msg({ id: String(i), role: i % 2 ? "agent" : "owner", text: `t${i}` }));
    const h = historyFor(many);
    assert.equal(h.length, 8);
    assert.equal(h.at(-1)!.content, "t19");
  });

  it("A KEPT CONVERSATION FROM BEFORE MESSAGES STILL READS", () => {
    const turns: ChatTurn[] = [
      { question: "hi", answer: "hello" },
      { question: "✓ confirmed", answer: "Placed it." },
      { question: "", answer: "bought 5.00 USDG of TSLA" },
    ];
    const m = turnsToMessages(turns);
    assert.deepEqual(
      m.map((x) => [x.role, x.text]),
      [
        ["owner", "hi"],
        ["agent", "hello"],
        ["owner", "✓ Confirmed"],
        ["agent", "Placed it."],
        ["agent", "bought 5.00 USDG of TSLA"],
      ],
    );
    assert.ok(m.every((x) => x.at === null), "a time nobody recorded is not invented");
  });
});

describe("chips", () => {
  const base = { liveBlocker: null, stopped: false, latestSymbol: null, holding: [], lastAgent: null, perTrade: 10, ceiling: 25 };

  it("TWO TO FOUR, and about this agent", () => {
    const c = chatChips({ ...base, liveBlocker: "no-gas", latestSymbol: "CASHCAT", holding: ["CASHCAT"] });
    assert.ok(c.length >= 2 && c.length <= 4);
    assert.deepEqual(c.slice(0, 2).map((x) => x.label), ["Why can't you trade?", "Why CASHCAT?"]);
    assert.ok(chatChips(base).length >= 2);
  });

  it("an agent that is trading is not asked why it can't", () => {
    const c = chatChips({ ...base, latestSymbol: "TSLA" });
    assert.ok(!c.some((x) => x.label === "Why can't you trade?"));
  });

  it("AMOUNT CHIPS ANSWER 'HOW MUCH', clamped to the smaller of the sealed cap and the chat ceiling", () => {
    const c = chatChips({ ...base, lastAgent: "Happy to. How much should I put into CASHCAT?", perTrade: 10, ceiling: 25 });
    assert.deepEqual(c.map((x) => x.label), ["$5.00", "$10.00 (max)"]);
    for (const chip of c) assert.ok(Number(chip.message.replace(/[^0-9.]/g, "")) <= 10);
    const d = chatChips({ ...base, lastAgent: "How much?", perTrade: 100, ceiling: 25 });
    assert.deepEqual(d.map((x) => x.label), ["$5.00", "$10.00", "$25.00 (max)"]);
  });

  it("A CEILING OF ZERO IS NO CHAT CEILING, and the sealed cap still clamps", () => {
    assert.equal(amountCeiling(40, 0), 40);
    assert.equal(amountCeiling(40, 25), 25);
    assert.equal(amountCeiling(3, 25), 3);
  });

  it("WITH EITHER LIMIT UNREAD THERE IS NO AMOUNT TO SUGGEST", () => {
    assert.equal(amountCeiling(null, 25), null);
    assert.equal(amountCeiling(10, null), null);
    assert.equal(amountCeiling(0, 25), null);
    const c = chatChips({ ...base, lastAgent: "How much?", perTrade: null });
    assert.ok(!c.some((x) => x.label.startsWith("$")), "no size is offered that nobody read");
    assert.ok(c.length >= 2);
  });

  it("a tiny cap still yields two chips, and the only amount is the cap", () => {
    const c = chatChips({ ...base, lastAgent: "How much?", perTrade: 3, ceiling: 25 });
    assert.equal(c[0]!.label, "$3.00 (max)");
    assert.ok(c.length >= 2);
  });

  it("A CEILING PAST THE CENT IS ROUNDED DOWN, never up past what the route enforces", () => {
    // /api/settings takes any float in [1, 100000], and the orders route
    // refuses `usdgAmount > ceiling`. A chip printed and sent to the cent
    // rounded 9.999 up to "$10.00 (max)" — an order the route refused.
    const amounts = (ceiling: number) =>
      chatChips({ ...base, lastAgent: "How much?", perTrade: 100, ceiling }).filter((x) => x.label.startsWith("$"));
    assert.deepEqual(amounts(9.999).map((x) => x.label), ["$5.00", "$9.99 (max)"]);
    assert.equal(amounts(7.556).at(-1)!.label, "$7.55 (max)");
    assert.equal(amounts(12.345).at(-1)!.label, "$12.34 (max)");
    // A cent that binary floating point stores a hair low is still that cent.
    assert.equal(amounts(8.2).at(-1)!.label, "$8.20 (max)");
    assert.equal(amounts(19.99).at(-1)!.label, "$19.99 (max)");
    assert.equal(amountCeiling(100, 9.999), 9.99);
    assert.equal(amountCeiling(4.5678, 25), 4.56, "the sealed cap is rounded down the same way");
    for (const ceiling of [9.999, 7.556, 12.345, 8.2, 19.99, 0.1 + 0.2, 1.005, 9.999999995, 25]) {
      for (const chip of amounts(ceiling)) {
        const sent = Math.round(Number(chip.message.replace(/[^0-9.]/g, "")) * 100) / 100;
        assert.ok(sent <= ceiling, `${chip.label} is within ${ceiling}`);
      }
    }
    // Less than a cent to offer is no amount at all, not "$0.00 (max)".
    assert.equal(amountCeiling(0.004, 25), null);
  });
});

describe("failures, in the agent's voice", () => {
  it("NEVER THE RAW ERROR TEXT, and each says what to do", () => {
    for (const kind of ["signed-out", "no-llm", "llm-error", "unreadable", "network", "timeout", "cut-off", "server"] as const) {
      const line = failureLine(kind);
      assert.match(line, /^(I|My)\b/, `${kind} is said as the agent, in the first person`);
      assert.doesNotMatch(line, /DOMException|TypeError|Failed to fetch|undefined/);
    }
    assert.match(failureLine("no-llm"), /Settings/);
    assert.match(failureLine("signed-out"), /[Ss]ign in/);
  });

  it("A MODEL FAILURE IS SAID BY ITS KIND, never in the provider's words", () => {
    // It used to paste them: "(it said: groq 401 — invalid_api_key: Invalid
    // API Key). Give it a moment and try again." — a transcript, and advice no
    // moment could make true.
    const facts = (kind: "key-rejected" | "model-missing" | "other" | "rate-limited" | "provider-down" | "unreachable") => ({
      llm: { kind, provider: "Groq" },
    });
    for (const kind of ["key-rejected", "model-missing", "other", "rate-limited", "provider-down", "unreachable"] as const) {
      const line = failureLine("llm-error", facts(kind));
      assert.match(line, /^(I|My)\b/, kind);
      assert.doesNotMatch(line, /[{}]|invalid_api_key|\b[45]\d\d\b/, kind);
    }
    assert.match(failureLine("llm-error", facts("key-rejected")), /Groq refused the API key/);
    assert.match(failureLine("llm-error", facts("rate-limited")), /rate-limited by Groq/);
    // With no provider to name, it is still a sentence.
    assert.match(failureLine("llm-error", { llm: { kind: "key-rejected", provider: null } }), /its provider refused the API key/);
  });

  it("RETRY ONLY WHERE ASKING AGAIN CAN HELP — and no line promises it where it cannot", () => {
    const helps = (kind: "key-rejected" | "model-missing" | "other" | "rate-limited" | "provider-down" | "unreachable") =>
      retryHelps("llm-error", { llm: { kind, provider: "Groq" } });
    for (const kind of ["rate-limited", "provider-down", "unreachable"] as const) {
      assert.equal(helps(kind), true, kind);
      assert.match(failureLine("llm-error", { llm: { kind, provider: "Groq" } }), /[Tt]ry again/, kind);
    }
    for (const kind of ["key-rejected", "model-missing", "other"] as const) {
      assert.equal(helps(kind), false, kind);
      assert.doesNotMatch(failureLine("llm-error", { llm: { kind, provider: "Groq" } }), /moment|try again/i, kind);
    }
    // A model failure the server did not classify is not guessed to be passing.
    assert.equal(retryHelps("llm-error"), false);
    for (const kind of ["signed-out", "no-llm", "unreadable", "network", "timeout", "cut-off", "server"] as const) {
      assert.equal(retryHelps(kind), true, kind);
    }
  });

  it("WHAT THE ROUTE CLASSIFIED IS CHECKED, not trusted", () => {
    // A kind this browser has never heard of is not guessed at: it is a
    // reason it does not recognise, and no Retry is promised for it.
    const unknown = llmFailureOf("brand-new-kind", "Groq");
    assert.deepEqual(unknown, { kind: "other", provider: "Groq" });
    assert.equal(retryHelps("llm-error", { llm: unknown }), false);
    assert.deepEqual(llmFailureOf("rate-limited", "Groq"), { kind: "rate-limited", provider: "Groq" });
    // A provider "name" that is not a short plain name is not repeated.
    for (const provider of ["<b>Groq</b>", "x".repeat(41), "", 42, null, "groq 401 — {\"error\":1}"]) {
      assert.equal(llmFailureOf("rate-limited", provider).provider, null, String(provider));
    }
  });

  it("A SERVER THAT DID NOT ANSWER IS NOT 'I ANSWERED'", () => {
    // A 502 gateway page was said as "I answered, but it arrived garbled" —
    // a sentence about an answer that never existed.
    const line = failureLine("server", { status: 502 });
    assert.match(line, /the server said 502/);
    assert.doesNotMatch(line, /I answered|garbled/);
    assert.doesNotMatch(failureLine("server"), /said/, "no status is invented");
    assert.doesNotMatch(failureLine("unreadable"), /I answered/, "and an unreadable body claims no answer either");
  });
});

describe("refocusing the composer", () => {
  it("ONLY WITH A FINE POINTER — a phone keyboard must not reopen over the answer", () => {
    const win = (fine: boolean) => ({ matchMedia: (q: string) => ({ matches: q === "(pointer: fine)" && fine }) });
    assert.equal(refocusAfterSend(win(true)), true);
    assert.equal(refocusAfterSend(win(false)), false);
    assert.equal(refocusAfterSend({}), false, "a browser that cannot say is not assumed to have a mouse");
  });
});
