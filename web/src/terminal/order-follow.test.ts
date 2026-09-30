/**
 * THE CARD SAYS WHAT THE SERVER SAID, AND NOTHING ON A TIMER OF ITS OWN.
 *
 * It polled for a fixed seven minutes and then told the owner "nothing was
 * sent". At the hosted 240 s tick the order's own window is 8m15s, so the
 * owner could be told nothing happened, ask again, be refused with "you
 * already have an order waiting", and then watch the first one fill.
 *
 * These drive the loop with a fake clock and a scripted server: whatever the
 * owner is told is the server's terminal answer, or — if none arrives by the
 * order's own deadline — a sentence that does not claim to know.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ORDER_STALE_GRACE_MS } from "@/lib/order-state";
import { followDeadline, followOrder, followOrderUntil, followWindowMs, routeAnswer, serverPlacedAt, type OrderPoll } from "./order-follow";

const MIN = 60_000;
const T = 1_800_000_000_000;
/** What POST hands back: the order's window as a DURATION from the response. */
const WINDOW_MS = (2 * 240 + 15) * 1000;
const EXPIRES = T + WINDOW_MS;

/** A fake clock, a server scripted by time, and a record of what was said. */
function harness(script: (at: number) => OrderPoll | "throw", alive = () => true) {
  let now = T;
  const said: { at: number; line: string }[] = [];
  const polls: number[] = [];
  const deps = {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
    poll: async () => {
      polls.push(now);
      const r = script(now);
      if (r === "throw") throw new Error("network");
      return r;
    },
    alive,
    say: (line: string) => said.push({ at: now, line }),
  };
  return { deps, said, polls, clock: () => now };
}

describe("an order that fills after seven minutes", () => {
  it("IS REPORTED AS FILLED, and nothing claims otherwise first", async () => {
    const h = harness((at) =>
      at < T + 8 * MIN
        ? { state: "queued" }
        : at < T + 9 * MIN
          ? { state: "running" }
          : { state: "done", result: "bought 25.00 USDG of TSLA" },
    );
    await followOrder("a1", WINDOW_MS, h.deps);
    assert.deepEqual(h.said.map((s) => s.line), ["bought 25.00 USDG of TSLA"]);
    assert.ok(h.said[0]!.at >= T + 9 * MIN);
  });

  it("it does not stop polling at seven minutes", async () => {
    const h = harness((at) => (at < T + 8 * MIN ? { state: "queued" } : { state: "done", result: "filled" }));
    await followOrder("a1", WINDOW_MS, h.deps);
    assert.ok(h.polls.some((p) => p > T + 7 * MIN), "the poll must outlive the old fixed window");
  });
});

describe("an order that really expired", () => {
  it("SAYS NOTHING WAS SENT — because the server said so", async () => {
    const h = harness((at) => (at <= EXPIRES + ORDER_STALE_GRACE_MS ? { state: "queued" } : { state: "expired" }));
    await followOrder("a1", WINDOW_MS, h.deps);
    assert.equal(h.said.length, 1);
    assert.match(h.said[0]!.line, /nothing was sent/);
    assert.ok(h.said[0]!.at > EXPIRES + ORDER_STALE_GRACE_MS, "and not a moment before the server knew");
  });
});

describe("when the server never answers", () => {
  it("A CLAIMED ORDER WITH NO ANSWER IS NOT CALLED A FAILURE", async () => {
    // The worker took it and has not reported back. It may still have filled;
    // "nothing was sent" here is the exact false sentence this replaces.
    const h = harness(() => ({ state: "running" }));
    await followOrder("a1", WINDOW_MS, h.deps);
    assert.equal(h.said.length, 1);
    assert.doesNotMatch(h.said[0]!.line, /nothing was sent|never|did not/i);
    assert.match(h.said[0]!.line, /trades/, "it points the owner at where the answer will be");
    assert.ok(h.clock() > EXPIRES + ORDER_STALE_GRACE_MS, "and it waited out the order's own window first");
  });

  it("a dropped poll is not an outcome", async () => {
    let n = 0;
    const h = harness(() => (++n < 4 ? "throw" : n < 6 ? null : { state: "done", result: "sold 5.00 USDG of GME" }));
    await followOrder("a1", WINDOW_MS, h.deps);
    assert.deepEqual(h.said.map((s) => s.line), ["sold 5.00 USDG of GME"]);
  });

  it("the loop still ends when the server is unreachable throughout", async () => {
    const h = harness(() => "throw");
    await followOrder("a1", WINDOW_MS, h.deps);
    assert.equal(h.said.length, 1);
    assert.doesNotMatch(h.said[0]!.line, /nothing was sent/);
  });

  it("with no deadline from the server it still ends, and still does not guess", async () => {
    const h = harness(() => ({ state: "queued" }));
    await followOrder("a1", null, h.deps);
    assert.equal(h.said.length, 1);
    assert.doesNotMatch(h.said[0]!.line, /nothing was sent/);
  });
});

describe("THE CARD WAITS ON ITS OWN CLOCK, NOT THE SERVER'S", () => {
  // The give-up time was the server's `expiresAt` compared with the browser's
  // Date.now(). A browser clock eleven minutes fast gave up before asking once
  // — "I could not get an answer" about an order about to fill — and a smaller
  // skew stopped asking before the fill arrived, so the owner never heard it.
  /** The same scripted server, seen from a browser whose clock is `skewMs` off. */
  function skewed(skewMs: number, script: (elapsed: number) => OrderPoll) {
    let local = T + skewMs;
    const start = local;
    const said: string[] = [];
    let polls = 0;
    return {
      said,
      polls: () => polls,
      deps: {
        now: () => local,
        sleep: async (ms: number) => {
          local += ms;
        },
        poll: async () => {
          polls += 1;
          return script(local - start);
        },
        alive: () => true,
        say: (line: string) => said.push(line),
      },
    };
  }
  // Fills at nine minutes — inside the window and grace, as the server sees it.
  const fillsLate = (elapsed: number): OrderPoll =>
    elapsed < 9 * MIN ? { state: "running" } : { state: "done", result: "bought 25.00 USDG of TSLA" };

  for (const skew of [11 * MIN, 3 * MIN, -7 * MIN]) {
    it(`a browser clock ${skew / MIN} min off still hears the fill`, async () => {
      const h = skewed(skew, fillsLate);
      await followOrder("a1", WINDOW_MS, h.deps);
      assert.deepEqual(h.said, ["bought 25.00 USDG of TSLA"]);
    });
  }

  it("and asks exactly as often whatever the skew", async () => {
    const counts = await Promise.all(
      [0, 11 * MIN, -30 * MIN].map(async (skew) => {
        const h = skewed(skew, () => ({ state: "running" }));
        await followOrder("a1", WINDOW_MS, h.deps);
        return h.polls();
      }),
    );
    assert.ok(counts[0]! > 0);
    assert.deepEqual(counts, [counts[0], counts[0], counts[0]]);
  });
});

describe("what the card takes from the POST", () => {
  it("THE DURATION, never the server's epoch", () => {
    assert.equal(followWindowMs({ id: "a1", expiresAt: EXPIRES, expiresInMs: WINDOW_MS }), WINDOW_MS);
    // A reply with only the epoch is not something this clock can use.
    assert.equal(followWindowMs({ id: "a1", expiresAt: EXPIRES }), null);
  });

  it("and only a real, non-negative number", () => {
    for (const bad of [null, undefined, {}, { expiresInMs: "495000" }, { expiresInMs: Number.NaN }, { expiresInMs: -1 }]) {
      assert.equal(followWindowMs(bad), null, JSON.stringify(bad));
    }
    assert.equal(followWindowMs({ expiresInMs: 0 }), 0);
  });

  it("AND THE SERVER'S OWN PLACEMENT TIME, which the thread holds against the ledger's clock", () => {
    // POST computed both from one `now`, so their difference is that `now` —
    // on the server's clock, whatever this browser's says.
    assert.equal(serverPlacedAt({ id: "a1", expiresAt: EXPIRES, expiresInMs: WINDOW_MS }), EXPIRES - WINDOW_MS);
    for (const bad of [null, undefined, {}, { expiresAt: EXPIRES }, { expiresInMs: WINDOW_MS }, { expiresAt: String(EXPIRES), expiresInMs: WINDOW_MS }, { expiresAt: EXPIRES, expiresInMs: -1 }, { expiresAt: Number.NaN, expiresInMs: 0 }, { expiresAt: 5, expiresInMs: 10 }]) {
      assert.equal(serverPlacedAt(bad), null, JSON.stringify(bad));
    }
  });
});

describe("the screen going away", () => {
  it("stops the poll and says nothing — even when the answer lands afterwards", async () => {
    let live = true;
    let goneAt = 0;
    const h = harness(
      (at) => {
        if (at > T + MIN && live) {
          live = false;
          goneAt = at;
        }
        return at > T + 2 * MIN ? { state: "done", result: "bought 25.00 USDG of TSLA" } : { state: "queued" };
      },
      () => live,
    );
    await followOrder("a1", WINDOW_MS, h.deps);
    assert.deepEqual(h.said, [], "nothing is said into a screen that has gone");
    assert.ok(h.polls.every((p) => p <= goneAt), "and nothing is asked after it went");
  });
});

describe("AN ORDER OUTLIVES THE SCREEN THAT PLACED IT", () => {
  // The poll used to die with the Agent screen, which is mounted only while
  // the chat is open — so closing the dock, switching tabs or reloading ended
  // it, and the outcome of an order the owner had just placed never reached
  // them. The chat now keeps the order's deadline on this browser's clock and
  // resumes it; these drive the resume.
  it("THE DEADLINE IS FIXED ONCE, on this clock, and resuming keeps it", async () => {
    const until = followDeadline(WINDOW_MS, T);
    assert.equal(until, T + WINDOW_MS + ORDER_STALE_GRACE_MS + 60_000);
    // Resumed five minutes later, after a reload: it waits out the SAME end.
    const h = harness(() => ({ state: "running" }));
    for (let i = 0; i < 5 * 12; i++) await h.deps.sleep(5_000);
    await followOrderUntil("a1", until, h.deps);
    assert.ok(h.clock() >= until, "it did not stop before the order's own end");
    assert.ok(h.clock() < until + 10_000, "nor wait a second window from the reload");
  });

  it("A RESUME PAST ITS DEADLINE STILL ASKS ONCE before saying it does not know", async () => {
    // Reopened an hour later: the answer has long been on the server, and
    // "I could not get an answer" without asking would be false.
    const h = harness(() => ({ state: "done", result: "bought 25.00 USDG of TSLA" }));
    await followOrderUntil("a1", T - 60 * MIN, h.deps);
    assert.deepEqual(h.said.map((s) => s.line), ["bought 25.00 USDG of TSLA"]);
    assert.equal(h.polls.length, 1);
  });

  it("THE TERMINAL POLL IS HANDED ON, so its receipt can be rendered", async () => {
    const receipt = { status: "filled", side: "buy", symbol: "TSLA", token: null, usdgActual: 25, txHash: null, rejectRule: null };
    const heard: OrderPoll[] = [];
    const h = harness(() => ({ state: "done", result: "bought 25.00 USDG of TSLA", receipt }));
    await followOrder("a1", WINDOW_MS, { ...h.deps, say: (_line, poll) => heard.push(poll ?? null) });
    assert.deepEqual(heard, [{ state: "done", result: "bought 25.00 USDG of TSLA", receipt }]);
  });

  it("and an unanswered end hands on nothing that could pass for one", async () => {
    const heard: (OrderPoll | undefined)[] = [];
    const h = harness(() => ({ state: "running" }));
    await followOrder("a1", WINDOW_MS, { ...h.deps, say: (_line, poll) => heard.push(poll) });
    assert.deepEqual(heard, [null]);
  });
});
describe("A LOOKUP GIVEN A DEADLINE", () => {
  it("IS GIVEN UP ON AT IT, and said as an answer that never came back", async () => {
    // A snipe's lookup had no deadline, and the order it resolved to went out
    // whenever it answered — however long after the owner tapped.
    const original = globalThis.fetch;
    let signalled = false;
    globalThis.fetch = ((_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        // With nothing to stop it, it answers a second later: too late to be the deadline.
        if (!signal) return void setTimeout(() => _resolve(new Response("{}", { headers: { "content-type": "application/json" } })), 1_000);
        signalled = true;
        signal.addEventListener("abort", () => reject(signal.reason));
      })) as typeof fetch;
    // AbortSignal.timeout does not hold the process open; this does, for the wait.
    const awake = setTimeout(() => {}, 10_000);
    try {
      const started = Date.now();
      assert.equal(await routeAnswer("/api/snipe", { method: "POST" }, 20), null);
      assert.ok(signalled, "the request carried the deadline");
      assert.ok(Date.now() - started < 5_000, "and was given up on at it");
    } finally {
      clearTimeout(awake);
      globalThis.fetch = original;
    }
  });
});
