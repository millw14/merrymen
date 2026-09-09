/**
 * WEB'S CHAIN READS WERE INVISIBLE AND UNBATCHED.
 *
 * Twelve places built a bare `http()`, none through a chokepoint. So every
 * logical call was its own HTTP request where a worker child's twenty ride in
 * one — and `rpcSummaryLines()` is only ever called from the worker, so not a
 * single web request has ever appeared in an `[rpc:read]` line. The fleet's
 * measured demand, including the figure this whole incident was sized against,
 * excluded this service.
 *
 * Both halves are silent when they regress: a route that goes back to a bare
 * transport still works, still returns the right answer, and simply costs more
 * requests against a budget nobody is counting.
 *
 * THE CLIENT-SIDE ONES ARE DELIBERATELY LEFT ALONE, and that distinction is the
 * point of the last test here. `session.ts` and `verified-adapter.ts` run in the
 * visitor's browser, from the visitor's IP. They are not part of this problem,
 * and routing them through a server-shaped transport would be a change with no
 * benefit and a bundling risk.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

/** Every module that reads the chain FROM THE SERVER, i.e. from the fleet's egress IP. */
const SERVER_READERS = [
  "./market.ts",
  "./derive-account.ts",
  "./read-discoveries.ts",
  "../app/api/grants/route.ts",
  "../app/api/proposals/route.ts",
  "../app/api/alpha/route.ts",
  "../app/api/circle/route.ts",
] as const;

/** Modules that reach the chain from the VISITOR's browser, on the visitor's own IP. */
const CLIENT_READERS = ["./session.ts", "./verified-adapter.ts"] as const;

describe("every server-side chain read is batched", () => {
  for (const f of SERVER_READERS) {
    it(`${f} goes through webChainRead`, () => {
      const src = read(f);
      assert.match(src, /webChainRead\(/, `${f} must not build its own transport`);
      assert.ok(
        !/transport: http\(/.test(src),
        `${f} still has a bare transport — one logical call, one HTTP request`,
      );
    });
  }

  it("AND NONE OF THEM HARDCODES THE ENDPOINT ANY MORE", () => {
    // Two of these pasted the public URL as a literal, so no environment
    // variable could ever move them — which would silently strand them on the
    // keyless endpoint on the day somebody points the fleet at a paid one.
    const disc = read("./read-discoveries.ts");
    assert.ok(
      !/http\("https:\/\/rpc\.mainnet\.chain\.robinhood\.com"\)/.test(disc),
      "the endpoint must come from configuration, not from a literal",
    );
    assert.match(disc, /webChainRead\(process\.env\.MERRYMEN_RPC_MAINNET\)/);
  });
});

describe("the transport's policy", () => {
  it("BATCHES, AND NEVER RETRIES A REFUSAL", () => {
    // viem's shouldRetry returns true for 429 and the http transport exposes no
    // override, so retryCount:0 is the only setting that keeps a refusal from
    // becoming four requests at 150/300/600ms — the amplifier that took the
    // worker fleet down from a 5% overshoot.
    const src = read("./chain-read.ts");
    assert.match(src, /retryCount: 0/);
    assert.match(src, /batch: \{ wait: BATCH_WAIT_MS, batchSize: BATCH_SIZE \}/);
  });

  it("and a refusal keeps its status and its headers", () => {
    // A plain Error is re-wrapped by viem with neither, which is how a refused
    // batch becomes "Cannot read properties of undefined" and Retry-After stops
    // existing.
    const src = read("./chain-read.ts");
    assert.match(src, /e\.status = response\.status;/);
    assert.match(src, /e\.headers = response\.headers;/);
  });

  it("AND IT CARRIES NO BREAKER, which is a decision and not an omission", () => {
    // The worker's version has one, shared through the filesystem between
    // children in one container. `web` is a different container: it would
    // neither see the fleet's cooldown nor be seen by it, and a process-wide
    // breaker inside a request server turns one bad minute into every page
    // failing at once.
    const src = read("./chain-read.ts");
    assert.ok(!/coolUntil|cooldown|breaker\(/i.test(src.replace(/^[\s\S]*?\*\//, "")));
  });
});

describe("client-side readers are left alone", () => {
  for (const f of CLIENT_READERS) {
    it(`${f} still reaches the chain from the visitor's browser`, () => {
      // If one of these ever moves server-side, this test failing is the signal
      // that it now spends the fleet's budget and needs the batched transport.
      const src = read(f);
      assert.match(src, /transport: http\(/, `${f} is expected to be client-side`);
    });
  }
});
