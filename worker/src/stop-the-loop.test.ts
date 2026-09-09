import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { getLogsAdaptive } from "./inflight-reconcile";
import { staleThresholdSec } from "./orchestrator";

/**
 * THE LOOP THAT KILLED THE FLEET, PINNED SO IT CANNOT COME BACK.
 *
 * None of this was a race. `MERRYMEN_TICK_SECONDS=240` against
 * `WATCHDOG_STALE_SEC=180`, with the heartbeat written once per tick, means the
 * minimum gap between two beats exceeds the kill threshold — so every child was
 * SIGKILLed at ~185s, before its second tick ever ran. All 71 observed
 * `heartbeat stale` events landed in a 181-196s band, which is 180 plus one 15s
 * poll and nothing else.
 *
 * The kill fed a re-arm, the re-arm fed a 200,000-block getLogs sweep, the
 * sweep fed the rate limiting, the rate limiting killed the tick one line
 * before the heartbeat, and that fed the kill.
 */

const strip = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");

const at = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

describe("A1 — the watchdog cannot be shorter than the tick", () => {
  it("a 240s tick gets a threshold well above 240s", () => {
    // The exact configuration that was killing the hosted fleet.
    const t = staleThresholdSec(240);
    assert.ok(t > 240, `240s tick must not be killed at ${t}s`);
    assert.equal(t, 240 * 2 + 90);
  });

  it("keeps a floor for fast ticks", () => {
    // A 15s tick must not get a 120s watchdog — the floor is what stops a fast
    // agent being declared dead over one slow pass.
    assert.equal(staleThresholdSec(15), 180);
    // The floor binds up to a 45s tick (45*2+90 = 180); above that the derived
    // value takes over, which is the point.
    assert.equal(staleThresholdSec(45), 180);
    assert.equal(staleThresholdSec(60), 210);
  });

  it("is monotonic, so a slower tick is never treated more harshly", () => {
    let prev = 0;
    for (const tick of [15, 30, 60, 120, 240, 600, 3600]) {
      const t = staleThresholdSec(tick);
      assert.ok(t >= prev, `tick ${tick} gave ${t} after ${prev}`);
      assert.ok(t > tick, `tick ${tick} must not be killed at ${t}`);
      prev = t;
    }
  });

  it("THE HEARTBEAT IS WRITTEN BEFORE ANY NETWORK CALL", () => {
    // The other half. Deriving the threshold does not help if the beat is
    // downstream of a read that a rate limit can kill — which is exactly where
    // it was, one line after `readMarketSafety()`.
    const src = strip(at("./index.ts"));
    const tickAt = src.indexOf("async function tick() {");
    assert.ok(tickAt > 0, "tick() must exist");
    const beatAt = src.indexOf("heartbeat()", tickAt);
    const marketAt = src.indexOf("await readMarketSafety()", tickAt);
    assert.ok(beatAt > 0 && marketAt > 0, "both calls must exist in tick()");
    assert.ok(beatAt < marketAt, "the beat must precede the first network read");
  });
});

describe("A2 — the exit handler only cleans up its own child", () => {
  it("compares identity rather than deleting by key", () => {
    // `children.delete(tenant)` unconditionally meant the watchdog's
    // replacement was evicted by the corpse of the child it replaced, and the
    // respawn guard then spawned a SECOND one. The first was orphaned: still
    // ticking, still hitting the RPC, invisible to the watchdog.
    // Measured: 105 spawns against 61 exits in one window.
    const src = strip(at("./orchestrator.ts"));
    assert.match(src, /if \(children\.get\(tenant\) === child\) children\.delete\(tenant\);/);
    // And the unconditional form must be gone from the exit path.
    const exitAt = src.indexOf('proc.on("exit"');
    const guardAt = src.indexOf("if (children.get(tenant) === child)", exitAt);
    assert.ok(exitAt > 0 && guardAt > exitAt, "the guard must be inside the exit handler");
    // THE RESPAWN MOVED, THE PROPERTY DID NOT. Both restart paths now go
    // through `scheduleRestart` — the watchdog used to spawn on the line after
    // its SIGKILL with no delay and no ceiling — so the check that a
    // replacement is not spawned over a live child lives there, not below this
    // handler. Asserted where it is rather than by position, so relocating it
    // again fails loudly instead of silently finding nothing.
    const policy = src.slice(src.indexOf("function scheduleRestart("), src.indexOf("async function spawnChild("));
    assert.match(policy, /!stopping && !children\.has\(tenant\)/, "no respawn over a live child");
    assert.ok(
      !/proc\.on\("exit"[\s\S]{0,600}spawnChild\(/.test(src),
      "the exit handler must not spawn directly — it goes through the one policy",
    );
  });

  it("the watchdog logs the threshold it actually applied", () => {
    // A number that cannot be read from a log is a number nobody can debug.
    const src = strip(at("./orchestrator.ts"));
    assert.match(src, /child\.staleSec/);
    assert.match(src, /watchdog \$\{staleSec\}s/);
  });
});

describe("A3 — a rate limit is not a block-range error", () => {
  const filter = { address: "0x00000000000000000000000000000000000000e7" as const, topics: [] };

  /** A chain seam that fails the first `fail` calls with `err`, then succeeds. */
  const chainThatFails = (err: () => Error, fail: number) => {
    let calls = 0;
    const spans: bigint[] = [];
    return {
      calls: () => calls,
      spans: () => spans,
      chain: {
        getLogs: async (a: { fromBlock: bigint; toBlock: bigint }) => {
          calls += 1;
          spans.push(a.toBlock - a.fromBlock + 1n);
          if (calls <= fail) throw err();
          return [];
        },
      },
    };
  };

  const rateLimit = () =>
    Object.assign(new Error("RPC Request failed."), {
      name: "RpcRequestError",
      details: "Rate Limit Hit, limit will reset in 60 seconds",
      code: 429,
    });
  const rangeErr = () => new Error("query returned more than 10000 results");

  it("RETRIES THE SAME SPAN on a rate limit — never halves, never advances", () => {
    // The old loop halved on every failure, walked 10,000 -> 1 in fourteen
    // requests, advanced the cursor by ONE BLOCK, reset, and did it again.
    return (async () => {
      const t = chainThatFails(rateLimit, 2);
      const r = await getLogsAdaptive(t.chain as never, filter, 0n, 999n, 1000n);
      assert.equal(r.complete, true);
      // Every attempt asked for the SAME window.
      assert.deepEqual([...new Set(t.spans().map(String))], ["1000"], "the span must not change");
      assert.equal(t.calls(), 3, "two failures then one success");
    })();
  });

  it("halves on a GENUINE range error, which is a hint about the question", () => {
    return (async () => {
      const t = chainThatFails(rangeErr, 2);
      const r = await getLogsAdaptive(t.chain as never, filter, 0n, 999n, 1000n);
      assert.equal(r.complete, true);
      // Only the NARROWING PREFIX is asserted. Once a chunk succeeds the loop
      // keeps that span and walks the rest of the window with it, so the tail is
      // 250s repeating — correct, and not what this test is about.
      assert.deepEqual(t.spans().slice(0, 3).map(String), ["1000", "500", "250"], "the span must narrow");
    })();
  });

  it("NEVER SKIPS A BLOCK — it reports short coverage instead", () => {
    // The worst of the old behaviour: at span 1 it stepped over the block. This
    // sweep exists so a landed operation cannot go unreconciled and under-count
    // the day's spend, so silently skipping blocks broke the one property it is
    // for.
    return (async () => {
      const t = chainThatFails(rateLimit, 1000);
      const r = await getLogsAdaptive(t.chain as never, filter, 100n, 999n, 1000n);
      assert.equal(r.complete, false, "coverage must be reported as short");
      assert.equal(r.scannedTo, 99n, "nothing was scanned, so scannedTo is before the start");
      assert.equal(r.logs.length, 0);
      // Bounded: it gives up rather than spinning.
      assert.ok(t.calls() <= 6, `expected a bounded number of attempts, got ${t.calls()}`);
    })();
  });

  it("a clean pass restores the retry budget", () => {
    return (async () => {
      // Fail once, succeed, and the next chunk still has its full allowance.
      let calls = 0;
      const chain = {
        getLogs: async () => {
          calls += 1;
          if (calls === 1 || calls === 3) throw rateLimit();
          return [];
        },
      };
      const r = await getLogsAdaptive(chain as never, filter, 0n, 1999n, 1000n);
      assert.equal(r.complete, true, "one blip per chunk must not doom the sweep");
    })();
  });
});

describe("A4 — an unreadable market is not a stale feed", () => {
  it("carries `unread` beside `staleFeeds`, mirroring readAccountBalances", () => {
    // The asymmetry was inside one file: readAccountBalances already carried
    // `unread: string[]` and explained why, while readMarketSafety put an
    // unreadable feed into `staleFeeds` — a claim about Chainlink, manufactured
    // out of our own rate limit.
    const src = at("./snapshot.ts");
    assert.match(src, /unread: string\[\]/);
    assert.match(src, /unreadable: boolean/);
    const code = strip(src);
    // The guarded legs: a throw must not escape readMarketSafety any more.
    assert.match(code, /\.catch\(\(\) => null\)/);
  });

  it("the tick FAILS CLOSED on an unreadable market, and returns rather than throws", () => {
    const code = strip(at("./index.ts"));
    assert.match(code, /if \(market\.unreadable\) \{/);
    const guardAt = code.indexOf("if (market.unreadable) {");
    const returnAt = code.indexOf("return;", guardAt);
    const armedAt = code.indexOf("if (!armed || !active) return;");
    assert.ok(guardAt > 0 && returnAt > guardAt, "it must return");
    assert.ok(guardAt < armedAt, "and must do so before any trading work");
  });

  it("an unread block is not a DOWN sequencer claim in the ledger", () => {
    // "sequencer DOWN — all trading paused" is an event every owner reads.
    // Emitting it on the strength of our own 429 would be the same error one
    // level up.
    const code = strip(at("./snapshot.ts"));
    assert.match(code, /block === null \? false :/);
    assert.match(code, /blockNumber: block === null \? null : block\.number/);
  });

  it("and it is not a DOWN sequencer claim in the LOG either", () => {
    // The ledger half above is guarded by the `market.unreadable` return, so an
    // owner never reads that claim. The tick console line prints ABOVE that
    // return, and it rendered the collapsed boolean raw: "block unread ·
    // sequencer DOWN" — the two halves of one sentence contradicting each other,
    // with the alarming half stated as fact. An operator reading it during a
    // rate-limit burst goes looking for a chain outage. That is what happened.
    const code = strip(at("./index.ts"));
    assert.ok(
      code.includes("market.blockNumber === null ? \"unread\" : market.sequencerUp ? \"up\" : \"DOWN\""),
      "the tick line must have three states, because there are three",
    );
    assert.ok(
      !code.includes("sequencer ${market.sequencerUp ? \"up\" : \"DOWN\"}"),
      "the two-state rendering must not come back",
    );
  });
});

describe("A5 — the meter is a seam, not a policy", () => {
  it("every transport goes through it", () => {
    // TWO SPELLINGS, ONE SEAM. `chainRead` IS `metered(http(...))` with
    // batching — see rpc-meter.ts — so a call site using it is metered. The
    // property is that no transport reaches the chain unmeasured, not that
    // every site spells the wrapper out.
    for (const [file, n] of [
      ["./snapshot.ts", 2],
      ["./index.ts", 1],
      ["./executor.ts", 2],
      ["./circle.ts", 1],
    ] as const) {
      const code = strip(at(file));
      const metered = (code.match(/metered\(http\(/g) ?? []).length + (code.match(/chainRead\(/g) ?? []).length;
      assert.equal(metered, n, `${file} must route all ${n} transport(s) through the meter`);
      assert.doesNotMatch(code, /transport: http\(/, `${file} still has a bare transport`);
    }
  });

  it("AND THE READ TRANSPORT BATCHES, because one request per call blinded the fleet", () => {
    // 2026-09-06, a hosted child: 103 calls in 248s, 81 rate-limited, peak
    // concurrency 81, and a tick that ended "market unreadable — no trading
    // this tick" over and over. Thirty-two children, each with its own
    // optionless http(), all pointed at one keyless public endpoint. The
    // agents were not refusing to trade; they could not see the chain.
    const meter = strip(at("./rpc-meter.ts"));
    assert.match(meter, /export function chainRead\(/);
    // Two facts, asserted separately, because the call is laid out over
    // several lines and a single regex over it would break on formatting.
    const body = meter.slice(meter.indexOf("export function chainRead("));
    assert.match(body, /metered\(/, "chainRead must still be metered");
    // AND GOVERNED, which is the layer added after this test was written. The
    // batching below cut what one tick costs; it did nothing about a refusal
    // producing four more requests, which is what kept the fleet collapsing at
    // a tenth of the endpoint's measured capacity. See rpc-governor.ts.
    assert.match(body, /fetchFn: governedFetch,/, "chainRead must be governed as well as metered");
    assert.match(body, /retryCount: 0/, "and viem must not retry a 429 underneath it");
    assert.match(body, /http\(url, \{/, "…around an http transport built from the url");
    assert.match(body, /batch: \{ wait: BATCH_WAIT_MS, batchSize: BATCH_SIZE \}/, "…that batches");
    // AND the refusal stays legible. Batching cost the fleet its own error
    // messages once already: viem cannot read the single error object this
    // node answers a refused batch with, so the 429 was thrown away and every
    // refusal classified as `other`.
    assert.match(body, /onFetchResponse\(response: Response\)/, "a refused batch must still say it was refused");
    assert.match(body, /Status: \$\{response\.status\}/);
    // The send edge is deliberately not batched: a batch fails as a unit, and
    // eth_sendUserOperation must never be refused alongside somebody's read.
    assert.ok(
      !/bundlerTransport: chainRead/.test(strip(at("./executor.ts"))),
      "the bundler must not ride the batched read transport",
    );
  });

  it("THE BUNDLER IS METERED BUT NEVER MANAGED", () => {
    // It carries eth_sendUserOperation. The send-edge rules — persist the hash,
    // send once, never re-send — are why a lost operation is recoverable, and a
    // retrying transport underneath them would silently undo that.
    const code = strip(at("./executor.ts"));
    assert.match(code, /bundlerTransport: metered\(http\(opts\.bundlerUrl\), "bundler"\)/);
    assert.doesNotMatch(code, /retryCount/, "no retry may be configured on any transport here");
  });

  it("changes no behaviour: it forwards, counts, and rethrows", () => {
    // SCOPED TO `metered` ITSELF, which is where this property always lived.
    // It used to be asserted over the whole file, which was the same thing
    // while the file held nothing but the meter. It no longer does: `governed`
    // is in there now and it delays and refuses ON PURPOSE — that is the fix.
    // Reading the file as a whole would either fail on the governor or, if
    // loosened, stop noticing a delay creeping into the meter. So the meter is
    // read on its own, and the governor is asserted separately below.
    const code = strip(at("./rpc-meter.ts"));
    const meter = code.slice(code.indexOf("export function metered("), code.indexOf("const BATCH_SIZE"));
    assert.match(meter, /return await \(inner\.request/, "the result must be forwarded untouched");
    assert.match(meter, /throw e;/, "the error must be rethrown, not swallowed");
    assert.doesNotMatch(meter, /setTimeout|sleep|await new Promise/, "a meter must not delay anything");
  });

  it("AND THE GOVERNOR DELAYS, WHICH IS THE POINT — but still never alters a result", () => {
    // The meter's rule was "a transport that changed an outcome would be
    // measuring itself". The governor changes WHEN a request is made and
    // whether a refusal is repeated. It must not change which call is made or
    // what it returns, or the fleet would be reading a limiter's opinion of the
    // chain instead of the chain.
    const code = strip(at("./rpc-meter.ts"));
    const gov = code.slice(code.indexOf("async function governedFetch("), code.indexOf("function retryAfterFrom("));
    assert.match(gov, /return res;/, "the response is still returned untouched");
    assert.ok(!/catch/.test(gov), "and it never swallows a failure — there is no catch at all");
  });
});

describe("A6 — the gas numbers reach a log", () => {
  it("prints all three limits, the ceiling, and the deploy state", () => {
    // Twenty-four consecutive live attempts died leaving no gas figure anywhere,
    // because GasRefused.detail only carries one on the absurd/unstable
    // branches — and all twenty-four were `gas-unreadable`.
    const code = strip(at("./executor.ts"));
    assert.match(code, /\[gas\] account/);
    assert.match(code, /callGasLimit/);
    assert.match(code, /verificationGasLimit/);
    assert.match(code, /preVerificationGas/);
    assert.match(code, /ceiling \$\{bounds\.absoluteMax\}/);
    // null must print as "unreadable", never as a zero.
    assert.match(code, /"unreadable"/);
  });
});
