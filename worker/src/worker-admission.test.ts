/**
 * WHAT A WORKER MAY START — read from its environment, judged per intent, and
 * drained on the way out.
 *
 * The three things worker-admission.ts decides, each run for real here:
 *
 *   - the level a process runs at, which must fail CLOSED on a hosted worker
 *     the orchestrator did not tell, and on any value nobody can read;
 *   - which intents a level refuses, asked with the same entry test the tick
 *     uses, over every kind of intent the book can send;
 *   - how long a draining worker waits for its intent chain, which must follow
 *     a chain that grows and must never wait past its budget.
 *
 * Where index.ts calls these — the top of processIntentLocked, and the
 * SIGTERM handler — is pinned over its source in admission-invariant.test.ts.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { HeldCurveLeg } from "./energy";
import type { AgentLimits, TradeIntent } from "./policy";
import {
  ADMISSION_LEVEL_ENV,
  DRAIN_INTENT_CHAIN_MS,
  DrainingRefused,
  admissionFrom,
  admissionRefusal,
  drainIntentChain,
  type AdmissionLevel,
} from "./worker-admission";

const USDG = "0x00000000000000000000000000000000000000dd" as const;
const TSLA = "0x0000000000000000000000000000000000000001" as const;
const MEME = "0x00000000000000000000000000000000000000ee" as const;
const EXTRA = "0x00000000000000000000000000000000000000e1" as const;
const ROUTER = "0x00000000000000000000000000000000000000ff" as const;
const VAULT = "0x00000000000000000000000000000000000000aa" as const;
const ADAPTER = "0x00000000000000000000000000000000000000ab" as const;
const CURVE = "0x00000000000000000000000000000000000000ac" as const;

describe("the level, from the environment", () => {
  it("EACH OF THE THREE WORDS IS ITS OWN LEVEL, hosted or not", () => {
    for (const level of ["observe", "exits-only", "trade"] as const) {
      for (const hosted of [true, false]) {
        assert.equal(admissionFrom(level, hosted).level, level, `${level}, hosted=${hosted}`);
        assert.equal(admissionFrom(` ${level}\n`, hosted).level, level, "surrounding whitespace is not a different word");
      }
    }
  });

  it("A HOSTED WORKER THE ORCHESTRATOR DID NOT TELL ADMITS NOTHING", () => {
    for (const raw of [undefined, "", "   "]) {
      const a = admissionFrom(raw, true);
      assert.equal(a.level, "observe", JSON.stringify(raw));
      assert.match(a.why, new RegExp(`${ADMISSION_LEVEL_ENV} is not set on a hosted worker`));
    }
  });

  it("a self-hosted worker with nothing set trades as it always has", () => {
    for (const raw of [undefined, ""]) assert.equal(admissionFrom(raw, false).level, "trade");
  });

  it("A VALUE NOBODY CAN READ IS NOT PERMISSION — observe, hosted or not, and the value is not echoed", () => {
    // `held` and `halt` are words the rollout grammar does not hand a child;
    // a list is the orchestrator's variable, not this one.
    for (const raw of ["TRADE", "Exits-Only", "exits_only", "held", "halt", "all", "trade,observe", "1", "yes"]) {
      for (const hosted of [true, false]) {
        const a = admissionFrom(raw, hosted);
        assert.equal(a.level, "observe", `${raw}, hosted=${hosted}`);
        assert.ok(!a.why.includes(raw), `the boot line must not echo operator input: ${a.why}`);
      }
    }
  });
});

const swap = (sellToken: `0x${string}`, buyToken: `0x${string}`): TradeIntent => ({
  kind: "swap",
  target: ROUTER,
  sellToken,
  buyToken,
  sellAmountRaw: 1_000_000n,
  notionalUsdg: 1_000_000n,
});
const curve = (assetIn: `0x${string}`, assetOut: `0x${string}`): TradeIntent => ({
  kind: "curve-trade",
  target: ADAPTER,
  curve: CURVE,
  assetIn,
  assetOut,
  amountInRaw: 1_000_000n,
  minAmountOutRaw: 1n,
  notionalUsdg: 1_000_000n,
});

/**
 * Every kind of intent, and whether exits-only lets it go on to the usual
 * gates. A LEGACY grant's limits (quote assets = cash plus one stock), so the
 * curve sale quoted in an owner-added stock (EXTRA) is the one the breaker's
 * test calls an entry and the held-leg test calls a sale.
 */
const LIMITS: Pick<AgentLimits, "cashToken" | "quoteAssets"> = { cashToken: USDG, quoteAssets: [USDG, TSLA] };
const HELD: ReadonlyMap<string, HeldCurveLeg> = new Map([[MEME, { curve: CURVE, quote: EXTRA }]]);

const EXITS_ONLY: [string, TradeIntent, "admitted" | "refused"][] = [
  ["swap into cash (a sell)", swap(TSLA, USDG), "admitted"],
  ["swap out of cash (a buy)", swap(USDG, TSLA), "refused"],
  ["stock to stock", swap(TSLA, MEME), "refused"],
  ["curve back into cash", curve(MEME, USDG), "admitted"],
  ["curve back into a built-in quote stock", curve(MEME, TSLA), "admitted"],
  ["curve sale of a held leg into its own owner-added quote", curve(MEME, EXTRA), "admitted"],
  ["curve buy paid in that same quote", curve(EXTRA, MEME), "refused"],
  ["curve into an extra (an entry)", curve(USDG, MEME), "refused"],
  ["vault withdraw", { kind: "vault-withdraw", target: VAULT, amountUsdg: 1_000_000n }, "admitted"],
  // countsAsEntry's own carve-out: parking cash is not a new position.
  ["vault deposit", { kind: "vault-deposit", target: VAULT, amountUsdg: 1_000_000n }, "admitted"],
  ["transfer home", { kind: "transfer", target: USDG, recipient: MEME, amountUsdg: 1_000_000n }, "admitted"],
  ["equity buy", { kind: "equity-order", ticker: "TSLA", side: "buy", notionalUsdg: 1_000_000n }, "refused"],
  ["equity sell", { kind: "equity-order", ticker: "TSLA", side: "sell", notionalUsdg: 1_000_000n }, "admitted"],
  [
    "the energy buy",
    { kind: "energy-buy", target: ROUTER, sellToken: USDG, buyToken: MEME, sellAmountRaw: 1_000_000n, notionalUsdg: 1_000_000n },
    "refused",
  ],
];

const judge = (level: AdmissionLevel, intent: TradeIntent, draining = false, held = HELD) =>
  admissionRefusal({ level, draining }, intent, LIMITS, held);

describe("which intents a level refuses", () => {
  it("OBSERVE REFUSES EVERYTHING, exits included", () => {
    for (const [name, intent] of EXITS_ONLY) assert.equal(judge("observe", intent), "rollout-hold", name);
  });

  for (const [name, intent, want] of EXITS_ONLY) {
    it(`exits-only: ${name} is ${want}`, () => {
      assert.equal(judge("exits-only", intent), want === "admitted" ? null : "rollout-hold");
    });
  }

  it("TRADE REFUSES NOTHING — every other gate is still there for what it lets past", () => {
    for (const [name, intent] of EXITS_ONLY) assert.equal(judge("trade", intent), null, name);
  });

  it("A DRAINING WORKER REFUSES EVERYTHING NEW, whatever its level, and says it is draining", () => {
    for (const level of ["observe", "exits-only", "trade"] as const) {
      for (const [name, intent] of EXITS_ONLY) assert.equal(judge(level, intent, true), "draining", `${level}: ${name}`);
    }
  });

  it("BEFORE ANY TICK HAS SAID WHAT IT HOLDS, the held-leg sale is judged by the breaker's test alone — the strict reading", () => {
    const sale = curve(MEME, EXTRA);
    assert.equal(judge("exits-only", sale, false, new Map()), "rollout-hold");
    assert.equal(judge("exits-only", sale), null, "and admitted once the tick has seen the leg");
  });

  it("THE LATE REFUSAL AT A BROADCAST SAYS WHAT THE GATE SAYS: `draining`, and that nothing was sent", () => {
    const e = new DrainingRefused();
    assert.ok(e instanceof Error);
    assert.equal(e.name, "DrainingRefused");
    assert.equal(e.rule, "draining");
    assert.equal(e.rule, judge("trade", EXITS_ONLY[0]![1], true), "the same rule however late it came");
    assert.match(e.message, /Nothing was sent/);
  });

  it("a held-leg map cannot turn a buy into a sale: only paying WITH the held token, on its curve, into its quote", () => {
    // The buy that pays in the held leg's quote, the same leg on another
    // curve, and the leg sold into something other than its recorded quote.
    const otherCurve: TradeIntent = { ...(curve(MEME, EXTRA) as Extract<TradeIntent, { kind: "curve-trade" }>), curve: ROUTER };
    for (const intent of [curve(EXTRA, MEME), otherCurve, curve(MEME, VAULT)]) {
      assert.equal(judge("exits-only", intent), "rollout-hold", JSON.stringify(intent, (_, v) => (typeof v === "bigint" ? `${v}` : v)));
    }
  });
});

describe("draining the intent chain", () => {
  /** Real timers, small budgets: what main() passes, at a scale a test can wait for. */
  const timers = { now: Date.now, setTimer: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimer: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>) };
  /** A chain like index.ts's: a tail replaced each time work joins, never rejecting. */
  function chain() {
    let tail: Promise<unknown> = Promise.resolve();
    return {
      tail: () => tail,
      /** Put work on the chain; the returned function finishes it. */
      join: () => {
        let done!: () => void;
        const work = new Promise<void>((r) => (done = r));
        tail = tail.then(() => work);
        return done;
      },
    };
  }

  it("the budget is eighteen seconds — inside a fleet drain's twenty, far inside the watchdog", () => {
    assert.equal(DRAIN_INTENT_CHAIN_MS, 18_000);
  });

  it("AN EMPTY CHAIN DRAINS AT ONCE", async () => {
    const c = chain();
    const started = Date.now();
    assert.equal(await drainIntentChain({ ...timers, tail: c.tail, budgetMs: 5_000 }), true);
    assert.ok(Date.now() - started < 1_000);
  });

  it("A TRADE ON THE CHAIN IS WAITED FOR, and the drain ends when it lands", async () => {
    const c = chain();
    const land = c.join();
    let drained: boolean | null = null;
    const run = drainIntentChain({ ...timers, tail: c.tail, budgetMs: 5_000 }).then((v) => (drained = v));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(drained, null, "still waiting while the trade is out");
    land();
    await run;
    assert.equal(drained, true);
  });

  it("WORK THAT JOINS DURING THE DRAIN IS WAITED FOR TOO — the refusal is still a row being written", async () => {
    const c = chain();
    const landFirst = c.join();
    let drained: boolean | null = null;
    const run = drainIntentChain({ ...timers, tail: c.tail, budgetMs: 5_000 }).then((v) => (drained = v));
    await new Promise((r) => setTimeout(r, 10));
    const landSecond = c.join(); // a Telegram order typed a second after SIGTERM
    landFirst();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(drained, null, "the first landing is not the end: the tail moved while it waited");
    landSecond();
    await run;
    assert.equal(drained, true);
  });

  it("A TRADE THAT NEVER LANDS IS LEFT AT THE BUDGET — the process does not wait on it for ever", async () => {
    const c = chain();
    c.join();
    const started = Date.now();
    assert.equal(await drainIntentChain({ ...timers, tail: c.tail, budgetMs: 60 }), false);
    const waited = Date.now() - started;
    assert.ok(waited >= 55 && waited < 1_000, `waited ${waited}ms against a 60ms budget`);
  });

  it("A CHAIN THAT KEEPS GROWING CANNOT HOLD IT PAST THE BUDGET: one deadline across every pass", async () => {
    const c = chain();
    let landing = c.join();
    const keepJoining = setInterval(() => {
      const next = c.join();
      landing();
      landing = next;
    }, 10);
    const started = Date.now();
    try {
      assert.equal(await drainIntentChain({ ...timers, tail: c.tail, budgetMs: 80 }), false);
    } finally {
      clearInterval(keepJoining);
      landing();
    }
    assert.ok(Date.now() - started < 1_000);
  });

  it("a tail that rejects is over all the same — the drain never throws", async () => {
    const tail = Promise.reject(new Error("an intent that threw"));
    tail.catch(() => {});
    assert.equal(await drainIntentChain({ ...timers, tail: () => tail, budgetMs: 1_000 }), true);
  });
});
