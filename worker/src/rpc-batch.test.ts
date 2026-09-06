/**
 * ONE HTTP REQUEST PER CALL IS WHAT BLINDED THE FLEET.
 *
 * Thirty-two children, each with its own optionless `http()`, all pointed at
 * one keyless public endpoint, all waking on the same cadence. A hosted child's
 * own meter, 2026-09-06:
 *
 *   [rpc:read] 103 calls in 248s · 81 err · 81 rate-limited · peak concurrency 81
 *   [tick] market unreadable (AAPL, AMD, AMZN, BABA, BE, COIN…) — no trading this tick.
 *
 * The agents were not refusing to trade. They could not read the chain, and the
 * tick fails closed, correctly, on an unreadable market. Measured against the
 * live node, batching takes twenty-four independent reads from twenty-four HTTP
 * requests to two.
 *
 * So the property under test is a COUNT OF REQUESTS, not a count of calls — the
 * thing the endpoint is rate-limiting. It is tested against a stub rather than
 * the chain: the point is what leaves this process.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPublicClient } from "viem";
import { afterEach, beforeEach, describe, it } from "node:test";

import { chainRead } from "./rpc-meter";

const FAKE = "http://127.0.0.1:9/rpc";

/** N distinct addresses, so nothing can be answered by deduplication. */
const addresses = (n: number): `0x${string}`[] =>
  Array.from({ length: n }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}` as `0x${string}`);

let requests: unknown[][] = [];
const realFetch = globalThis.fetch;

/** When set, the stub refuses every request with this status. */
let refuseWith: number | null = null;

/** A node that answers anything, and records how many requests carried it. */
function stubFetch(): void {
  requests = [];
  refuseWith = null;
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? "[]") as unknown;
    const calls = Array.isArray(body) ? body : [body];
    requests.push(calls);
    if (refuseWith !== null) {
      // EXACTLY WHAT THE REAL NODE DOES to a batch it will not serve: a single
      // error object where the protocol says an array, under a non-200. That
      // shape is what viem cannot read, and what threw the status away.
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", error: { code: refuseWith, message: "Too Many Requests" } }),
        { status: refuseWith, headers: { "content-type": "text/plain" } },
      );
    }
    const answer = (c: { id: number; method: string }) => ({
      jsonrpc: "2.0",
      id: c.id,
      // Any well-formed hex answers every method used below.
      result: c.method === "eth_getCode" ? "0x" : "0x1",
    });
    const payload = Array.isArray(body) ? (calls as { id: number; method: string }[]).map(answer) : answer(calls[0] as never);
    return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
}

beforeEach(stubFetch);
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the read transport batches", () => {
  it("COLLAPSES CONCURRENT READS INTO ONE REQUEST", async () => {
    // DISTINCT addresses. Twelve IDENTICAL reads collapse to one request
    // without any batching at all, because viem dedupes in-flight duplicates —
    // a different and also useful behaviour, which hid this one when the first
    // version of this test asked twelve times for the same block number. The
    // traffic that blinded the fleet was per-token reads: all different.
    const client = createPublicClient({ transport: chainRead(FAKE) });
    await Promise.all(addresses(12).map((address) => client.getCode({ address })));

    assert.ok(
      requests.length < 12,
      `twelve concurrent reads still cost ${requests.length} requests — batching is off`,
    );
    const carried = requests.reduce((n, r) => n + r.length, 0);
    assert.equal(carried, 12, "every call must still be sent — batching moves calls, it never drops them");
  });

  it("keeps a batch small, because a batch fails as a unit", async () => {
    // One 429 refuses every call riding in the same request. That is the reason
    // for the cap, and it is why the cap is not "as many as the node accepts".
    const client = createPublicClient({ transport: chainRead(FAKE) });
    await Promise.all(addresses(60).map((address) => client.getCode({ address })));
    const biggest = Math.max(...requests.map((r) => r.length));
    assert.ok(biggest <= 20, `a request carried ${biggest} calls; a refusal would cost all of them`);
  });

  it("a lone read is still a lone read", async () => {
    const client = createPublicClient({ transport: chainRead(FAKE) });
    await client.getBlockNumber({ cacheTime: 0 });
    assert.equal(requests.length, 1);
  });

  it("still counts LOGICAL calls, so the meter keeps measuring the same thing", async () => {
    // The meter exists to size a limiter. If batching made it count requests
    // instead of calls, the number it reports would silently change meaning.
    const { rpcMeterSnapshot, resetRpcMetersForTest } = await import("./rpc-meter");
    resetRpcMetersForTest();
    const client = createPublicClient({ transport: chainRead(FAKE, "batch-test") });
    await Promise.all(addresses(8).map((address) => client.getCode({ address })));
    const m = rpcMeterSnapshot().find((x) => x.label === "batch-test");
    assert.equal(m?.calls, 8, "the meter must count calls, not the requests that carried them");
  });
});

describe("the send edge is never batched", () => {
  it("the bundler transport is built without batching", () => {
    // eth_sendUserOperation lives under persist-the-hash, send-once,
    // never-re-send. A batch fails as a unit, which is the wrong shape for an
    // operation that must not be retried alongside somebody else's read.
    const src = readFileSync(new URL("./executor.ts", import.meta.url), "utf8");
    assert.match(src, /bundlerTransport:\s*metered\(http\(opts\.bundlerUrl\), "bundler"\)/);
    assert.ok(
      !/bundlerTransport:\s*chainRead/.test(src),
      "the bundler must not use the batched read transport",
    );
  });

  it("the hot read clients DO use it — a seam nothing goes through is not a seam", () => {
    const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
    assert.match(read("./index.ts"), /transport: chainRead\(rpc\)/);
    assert.match(read("./executor.ts"), /transport: chainRead\(opts\.rpcUrl\)/);
  });
});

describe("a refused batch still says it was refused", () => {
  it("A 429 ON A BATCH CLASSIFIES AS RATE-LIMITED, NOT AS `other`", async () => {
    // This is the regression that batching introduced and that nearly made it
    // a worse trade than the rate limiting it fixed. viem indexes the array it
    // expected in a batch response, finds undefined on a single error object,
    // and raises "Cannot read properties of undefined (reading 'error')" — so
    // the 429 never reaches the classifier, and the fleet's own meter reports
    // an unrecognised failure instead of the one thing it is steered by.
    const { classifyRpcError } = await import("./rpc-error");
    refuseWith = 429;
    const client = createPublicClient({ transport: chainRead(FAKE) });

    const results = await Promise.allSettled(addresses(12).map((address) => client.getCode({ address })));
    const refusals = results.filter((r) => r.status === "rejected");
    assert.ok(refusals.length > 0, "the stub was told to refuse; something must have failed");

    const kinds = new Set(refusals.map((r) => classifyRpcError((r as PromiseRejectedResult).reason).kind));
    assert.ok(
      kinds.has("rate-limited"),
      `a refused batch classified as ${[...kinds].join(", ")} — the status was lost on the way`,
    );
    assert.ok(!kinds.has("other"), "no refusal may reach the meter unrecognised");
  });

  it("and a healthy answer is not disturbed", async () => {
    const client = createPublicClient({ transport: chainRead(FAKE) });
    const codes = await Promise.all(addresses(4).map((address) => client.getCode({ address })));
    assert.equal(codes.length, 4);
  });
});

describe("the fleet does not wake together", () => {
  it("SPREADS THIRTY-TWO CHILDREN ACROSS THE TICK", async () => {
    // The orchestrator forks one child per tenant and they all reach the loop
    // within a second of each other, so every deploy fires thirty-two identical
    // first ticks at one endpoint. Batching cut what one tick costs and does
    // nothing about thirty-two of them arriving together — measured after
    // batching shipped, the boot burst still came back "market unreadable"
    // while a child that happened to start late read the market cleanly.
    const { startupSlotMs } = await import("./stagger");
    const tick = 240_000;
    const homes = Array.from({ length: 32 }, (_, i) => `/data/children/0x${i.toString(16).padStart(40, "0")}`);
    const slots = homes.map((h) => startupSlotMs(h, tick));

    for (const s of slots) {
      assert.ok(s >= 0 && s < tick, `a slot of ${s}ms falls outside the tick it is spreading over`);
    }
    // The property that matters: they are not all in the same place. Ten
    // buckets, and a spread worth having fills most of them.
    const buckets = new Set(slots.map((s) => Math.floor((s / tick) * 10)));
    assert.ok(buckets.size >= 6, `thirty-two children landed in only ${buckets.size} of ten buckets`);
  });

  it("the same tenant always takes the same slot", () => {
    // Not random, so a crash-looping child cannot walk into a different
    // neighbour's slot on every restart, and two deploys are comparable.
    return import("./stagger").then(({ startupSlotMs }) => {
      assert.equal(startupSlotMs("/data/children/0xabc", 240_000), startupSlotMs("/data/children/0xabc", 240_000));
      assert.notEqual(startupSlotMs("/data/children/0xabc", 240_000), startupSlotMs("/data/children/0xdef", 240_000));
    });
  });

  it("a nonsensical tick is not a stagger", () => {
    return import("./stagger").then(({ startupSlotMs }) => {
      assert.equal(startupSlotMs("", 240_000), 0);
      assert.equal(startupSlotMs("/x", 0), 0);
      assert.equal(startupSlotMs("/x", Number.NaN), 0);
    });
  });
});
