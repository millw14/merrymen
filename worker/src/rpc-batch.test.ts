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

/** A node that answers anything, and records how many requests carried it. */
function stubFetch(): void {
  requests = [];
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? "[]") as unknown;
    const calls = Array.isArray(body) ? body : [body];
    requests.push(calls);
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
