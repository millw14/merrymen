/**
 * THE TAIL NOTIFIER'S I/O: the durable sent log is read strictly (unknown
 * sends nothing), reads are claimed before they are made, every notice is
 * claimed before it may be sent, and a restart over the same store sends
 * nothing twice.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FOMO_STATE_KEYS, type DurableStatePort } from "../fomo-child";
import type { BrokerCallOptions, ChildTail, ChildTailEvent, FomoBroker } from "./contract";
import { robinhoodChain, tokenIdentity } from "./identity";
import { emptyTailLog, NO_RESEARCH_READ, parseTailLog, TAIL_NOTICE_LIMITS, tailNotices } from "./tail-notices";
import { createTailNotifier, TAIL_THESIS_READ_TIMEOUT_MS, type TailNotifierDeps } from "./tail-notifier";
import type { FomoEnvelope, FomoToolName } from "./types";

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 9, 7, 14, 0);
const UNI = "7b1e2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const coin = (n: number) => tokenIdentity(robinhoodChain(), `0x${n.toString(16).padStart(40, "0")}`)!;

function ev(n: number, over: Partial<ChildTailEvent> = {}): ChildTailEvent {
  return { eventKey: `ev-${n}`, kind: "buy", token: coin(n), label: { symbol: `C${n}`, name: null }, at: NOW - 10 * MIN + n * MIN, observedAt: NOW - 10 * MIN + n * MIN, positionValueUsd: null, text: null, ...over };
}
const tail = (events: ChildTailEvent[], over: Partial<ChildTail> = {}): ChildTail => ({
  userId: UNI,
  handle: "unipcs",
  createdAt: NOW - HOUR,
  expiresAt: NOW + 2 * HOUR,
  ended: false,
  consider: false,
  events,
  totals: null,
  ...over,
});

function store() {
  const s = { map: new Map<string, string>(), readable: true, writable: true, ops: [] as string[] };
  const port: DurableStatePort = {
    async read(key) {
      s.ops.push(`read:${key}`);
      if (!s.readable) return { kind: "unknown" };
      const v = s.map.get(key);
      return v === undefined ? { kind: "absent" } : { kind: "found", text: v };
    },
    async write(key, text) {
      s.ops.push(`write:${key}`);
      if (!s.writable) return false;
      s.map.set(key, text);
      return true;
    },
  };
  return { s, port };
}

function broker(answer: (args: Record<string, unknown>) => unknown, ops: string[]) {
  const calls: { tool: FomoToolName; args: Record<string, unknown>; opts: BrokerCallOptions }[] = [];
  const b = {
    async call(tool: FomoToolName, args: Record<string, unknown>, opts: BrokerCallOptions): Promise<FomoEnvelope> {
      calls.push({ tool, args, opts });
      ops.push(`call:${tool}`);
      return { status: "ok", data: answer(args) } as unknown as FomoEnvelope;
    },
  } as unknown as FomoBroker;
  return { b, calls };
}

function notifier(o: Partial<Omit<TailNotifierDeps, "tails">> & { port: DurableStatePort; tails: ChildTail[] }) {
  const { port, tails, ...rest } = o;
  return createTailNotifier({
    broker: () => null,
    readiness: () => ({ mode: "paper", blockers: [] }),
    assessmentOf: () => null,
    now: () => NOW,
    ...rest,
    durable: port,
    tails: () => tails,
  });
}

/** What a caller does: claim, then send only on true. */
async function sendAll(n: ReturnType<typeof notifier>, sent: string[]): Promise<void> {
  for (const x of await n.next()) {
    if (!(await x.claim())) break;
    sent.push(x.html);
  }
}

describe("the tail notifier", () => {
  it("fails closed: an unknown sent log sends nothing and writes nothing", async () => {
    const { s, port } = store();
    s.readable = false;
    const n = notifier({ port, tails: [tail([ev(1)])] });
    assert.deepEqual(await n.next(), []);
    assert.deepEqual(s.ops, [`read:${FOMO_STATE_KEYS.tailNotified}`]);
  });

  it("claims each notice before it is sent; a restart over the same store sends nothing twice", async () => {
    const { s, port } = store();
    const tails = [tail([ev(1), ev(2, { kind: "sell" })])];
    const sent: string[] = [];
    await sendAll(notifier({ port, tails }), sent);
    assert.equal(sent.length, 2);
    assert.equal(FOMO_STATE_KEYS.tailNotified, "state:fomo-tail-notified");
    assert.ok(parseTailLog(s.map.get(FOMO_STATE_KEYS.tailNotified)!), "the stored log is a log");
    // A redeploy: a new process, the same durable store.
    const again: string[] = [];
    await sendAll(notifier({ port, tails }), again);
    assert.deepEqual(again, []);
  });

  it("sends at most four a pass, oldest first; the rest stay unclaimed and come on the next pass", async () => {
    const { s, port } = store();
    // Six coins, so six notices: none coalesces with another.
    const tails = [tail([1, 2, 3, 4, 5, 6].map((n) => ev(n, { kind: "sell" })))];
    assert.equal(TAIL_NOTICE_LIMITS.noticesPerPass, 4);
    const first = await notifier({ port, tails }).next();
    assert.equal(first.length, 4);
    const sent: string[] = [];
    for (const x of first) {
      assert.equal(await x.claim(), true);
      sent.push(x.html);
    }
    assert.deepEqual(sent.map((h) => /<b>(C\d)<\/b>/.exec(h)?.[1]), ["C1", "C2", "C3", "C4"]);
    const stored = parseTailLog(s.map.get(FOMO_STATE_KEYS.tailNotified)!)!;
    assert.equal(Object.keys(stored.sent).filter((k) => k.startsWith("g:")).length, 4, "the stored claims cover the four sent, not the two left");
    const second = await notifier({ port, tails }).next();
    assert.deepEqual(second.map((x) => /<b>(C\d)<\/b>/.exec(x.html)?.[1]), ["C5", "C6"], "the rest, the next pass");
    for (const x of second) assert.equal(await x.claim(), true);
    assert.deepEqual(await notifier({ port, tails }).next(), []);
  });

  it("a claim that cannot be confirmed is not a send", async () => {
    const { s, port } = store();
    s.writable = false;
    const due = await notifier({ port, tails: [tail([ev(1)])] }).next();
    assert.equal(due.length, 1);
    assert.equal(await due[0]!.claim(), false);
  });

  it("claims its thesis reads before making them, at most two per tail, as the owner from the DM, 8 s each", async () => {
    const { s, port } = store();
    const { b, calls } = broker((args) => ({ theses: [{ author: { userId: UNI, handle: "unipcs" }, excerpt: `thesis for ${String(args.token).slice(-4)}`, postedAt: NOW - MIN }] }), s.ops);
    const tails = [tail([ev(1), ev(2), ev(3)])];
    const sent: string[] = [];
    await sendAll(notifier({ port, tails, broker: () => b }), sent);
    assert.equal(calls.length, 2);
    const firstCall = s.ops.indexOf("call:fomo_get_token_theses");
    const firstWrite = s.ops.indexOf(`write:${FOMO_STATE_KEYS.tailNotified}`);
    assert.ok(firstWrite >= 0 && firstWrite < firstCall, "the reads were claimed durably before the first read");
    assert.deepEqual(calls[0]!.args, { token: coin(1).address, chain: "robinhood", trader: UNI, limit: 3 });
    assert.deepEqual(calls[0]!.opts, { surface: "telegram-dm", audience: "owner", priority: "interactive", conversationKey: null, timeoutMs: TAIL_THESIS_READ_TIMEOUT_MS });
    assert.equal(TAIL_THESIS_READ_TIMEOUT_MS, 8_000);
    assert.equal(sent.length, 3);
    assert.match(sent[0]!, /Their thesis \(their words, unverified\): “thesis for 0001”/);
    assert.match(sent[1]!, /“thesis for 0002”/);
    assert.match(sent[2]!, /I didn't look up their thesis on this coin/);
    // A restart never reads a claimed coin again.
    await sendAll(notifier({ port, tails, broker: () => b }), []);
    assert.equal(calls.length, 2);
  });

  it("never shows someone else's thesis as theirs", async () => {
    const { s, port } = store();
    const { b } = broker(() => ({ theses: [{ author: { userId: "someone-else", handle: "x" }, excerpt: "not theirs", postedAt: NOW }] }), s.ops);
    const sent: string[] = [];
    await sendAll(notifier({ port, tails: [tail([ev(1)])], broker: () => b }), sent);
    assert.match(sent[0]!, /No thesis from them on this coin that I could find\./);
    assert.doesNotMatch(sent[0]!, /not theirs/);
  });

  it("does nothing with the switch off or no tails, and starts over at now from a log nobody can read", async () => {
    const { s, port } = store();
    assert.deepEqual(await notifier({ port, tails: [tail([ev(1)])], enabled: () => false }).next(), []);
    assert.deepEqual(await notifier({ port, tails: [] }).next(), []);
    assert.deepEqual(s.ops, [], "neither reads the store");
    s.map.set(FOMO_STATE_KEYS.tailNotified, "{garbage");
    assert.deepEqual(await notifier({ port, tails: [tail([ev(1)])] }).next(), []);
    assert.equal(parseTailLog(s.map.get(FOMO_STATE_KEYS.tailNotified)!)?.floor, NOW, "everything before now counts as told: at most once");
    assert.deepEqual(await notifier({ port, tails: [tail([ev(1)])] }).next(), []);
  });

  it("capSpent: whether her tail of a trader has sent its 30 notices, read-only; false for no tail; null when unknown (review 2026-10-07)", async () => {
    const { s, port } = store();
    const t = tail([]);
    const n = notifier({ port, tails: [t] });
    assert.equal(await n.capSpent(UNI), false, "no log yet");
    // A log whose tail has told all 30: written as the notifier would have.
    const events = Array.from({ length: 40 }, (_, i) => ev(i + 1, { at: NOW - 100 * MIN + i * MIN, observedAt: NOW - 100 * MIN + i * MIN }));
    const long = tail(events, { createdAt: NOW - 2 * HOUR });
    const told = tailNotices({ tails: [long], log: emptyTailLog(0), now: NOW, readiness: null, assessmentOf: () => null, thesisRead: () => null, canRead: false }).notices;
    assert.equal(told.length, TAIL_NOTICE_LIMITS.noticesPerTail);
    s.map.set(FOMO_STATE_KEYS.tailNotified, JSON.stringify(told.at(-1)!.logAfter));
    const writes = s.ops.filter((o) => o.startsWith("write:")).length;
    assert.equal(await notifier({ port, tails: [long] }).capSpent(UNI), true);
    assert.equal(await notifier({ port, tails: [long] }).capSpent("someone-else"), false, "no tail of theirs");
    assert.equal(await notifier({ port, tails: [{ ...long, createdAt: NOW - 30 * MIN }] }).capSpent(UNI), false, "a new tail (a new start) has its own count");
    assert.equal(s.ops.filter((o) => o.startsWith("write:")).length, writes, "read-only");
    s.readable = false;
    assert.equal(await notifier({ port, tails: [long] }).capSpent(UNI), null, "unknown is not said");
    assert.equal(await notifier({ port, tails: [long], enabled: () => false }).capSpent(UNI), null);
  });

  it("passes whether her coins are researched: off, a fresh buy goes at once, saying why there is no read (review 2026-10-07)", async () => {
    const { port } = store();
    const fresh = tail([ev(1, { at: NOW - MIN, observedAt: NOW - MIN })]);
    assert.deepEqual(await notifier({ port, tails: [fresh] }).next(), [], "research on (unsaid): it waits for my read");
    const due = await notifier({ port, tails: [fresh], researched: () => false }).next();
    assert.equal(due.length, 1);
    assert.ok(due[0]!.html.includes(NO_RESEARCH_READ));
    assert.equal((await notifier({ port: store().port, tails: [fresh], researched: () => { throw new Error("x"); } }).next()).length, 0, "unknown: as before, it waits");
  });
});
