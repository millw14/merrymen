/**
 * A SPENT QUOTA, THROUGH THE REAL READ TRANSPORT.
 *
 * 2026-09-28 01:48 UTC onward, production: every read from every child failed,
 * the meter said `rate-limited` and `declined`, and every tick ended "market
 * unreadable". The fleet was making about 0.2 calls a second. Asked directly,
 * the house endpoint answered one eth_blockNumber with
 *
 *   HTTP 429  {"jsonrpc":"2.0","id":1,"error":{"code":429,
 *              "message":"Monthly capacity limit exceeded. Visit …"}}
 *
 * — a spent monthly allowance, which no amount of backing off refills. The
 * transport threw that body away and kept only the status, so the fleet's own
 * meter described a rate limit and pointed everyone at the egress IP and the
 * governor.
 *
 * Tested against a stub, like rpc-batch.test.ts: the property is what this
 * process makes of the answer, not what the provider does.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPublicClient } from "viem";
import { afterEach, beforeEach, describe, it } from "node:test";

// The breaker's shared cooldown is a file in the home. Keep it out of the real one.
process.env.MERRYMEN_HOME = mkdtempSync(path.join(tmpdir(), "merrymen-rpc-quota-"));
delete process.env.MERRYMEN_FLEET_HOME;

const { chainRead, resetGovernorForTest, resetRpcMetersForTest, rpcSummaryLines } = await import("./rpc-meter");
const { classifyRpcError } = await import("./rpc-error");

const FAKE = "http://127.0.0.1:9/rpc";
const MONTHLY =
  "Monthly capacity limit exceeded. Visit https://dashboard.alchemy.com/settings/billing to upgrade your scaling policy for continued service.";

const addresses = (n: number, from = 1): `0x${string}`[] =>
  Array.from({ length: n }, (_, i) => `0x${(i + from).toString(16).padStart(40, "0")}` as `0x${string}`);

const realFetch = globalThis.fetch;
const realRandom = Math.random;
let requests = 0;

/** Refuse every request with a 429 carrying this JSON-RPC error message. */
function refuseWith(message: string): void {
  requests = 0;
  globalThis.fetch = (async () => {
    requests += 1;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: 429, message } }), {
      status: 429,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
}

async function refusals(p: Promise<unknown>[]): Promise<unknown[]> {
  const settled = await Promise.allSettled(p);
  return settled.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason);
}

beforeEach(() => {
  resetGovernorForTest();
  resetRpcMetersForTest();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  Math.random = realRandom;
});

describe("a 429 that says the quota is spent", () => {
  it("CLASSIFIES AS quota-exhausted ON A BATCH, not as a rate limit", async () => {
    refuseWith(MONTHLY);
    const client = createPublicClient({ transport: chainRead(FAKE) });
    const failed = await refusals(addresses(6).map((address) => client.getCode({ address })));
    assert.equal(failed.length, 6);
    const kinds = new Set(failed.map((e) => classifyRpcError(e).kind));
    assert.deepEqual([...kinds], ["quota-exhausted"], `a spent quota classified as ${[...kinds].join(", ")}`);
  });

  it("and on a lone read", async () => {
    refuseWith(MONTHLY);
    const client = createPublicClient({ transport: chainRead(FAKE) });
    const [e] = await refusals([client.getBlockNumber({ cacheTime: 0 })]);
    assert.equal(classifyRpcError(e).kind, "quota-exhausted");
    assert.equal(classifyRpcError(e).retryable, false);
  });

  it("A PLAIN 429 IS STILL A RATE LIMIT — reading the body must not reclassify it", async () => {
    refuseWith("Too Many Requests");
    const client = createPublicClient({ transport: chainRead(FAKE) });
    const [e] = await refusals([client.getBlockNumber({ cacheTime: 0 })]);
    assert.equal(classifyRpcError(e).kind, "rate-limited");
  });

  it("CARRIES THE VERDICT, NEVER THE PROVIDER'S WORDS", async () => {
    // A response body is the provider's, not ours to put in a log line. The
    // marker is how the verdict survives viem's wrapping; nothing else rides.
    refuseWith(MONTHLY);
    const client = createPublicClient({ transport: chainRead(FAKE) });
    const [e] = await refusals([client.getBlockNumber({ cacheTime: 0 })]);
    const all = [String(e), (e as Error).message, (e as { details?: string }).details ?? "", JSON.stringify(e)].join("\n");
    assert.ok(!all.includes("dashboard.alchemy.com"), "the provider's body leaked onto the error");
    assert.ok(!all.includes("Monthly capacity"), "the provider's body leaked onto the error");
  });

  it("STILL COUNTS AS A REFUSAL — the breaker is unchanged", async () => {
    // The fix is what the fleet SAYS about this, not how it reacts. Three
    // refusals in a row still open the breaker, so a spent quota costs the
    // endpoint no more requests than any other sustained refusal.
    Math.random = () => 0.99; // a full-width jittered backoff, so the next read lands inside it
    refuseWith(MONTHLY);
    const client = createPublicClient({ transport: chainRead(FAKE) });
    for (let i = 0; i < 3; i++) await refusals([client.getCode({ address: addresses(1, 100 + i)[0]! })]);
    assert.equal(requests, 3);
    const [e] = await refusals([client.getCode({ address: addresses(1, 200)[0]! })]);
    assert.equal(requests, 3, "the fourth read reached the endpoint; the breaker did not open");
    assert.equal(classifyRpcError(e).kind, "declined");
  });
});

describe("the meter says it in words", () => {
  it("NAMES A SPENT QUOTA AND WHO CAN FIX IT", async () => {
    refuseWith(MONTHLY);
    const client = createPublicClient({ transport: chainRead(FAKE, "quota-words") });
    await refusals([client.getBlockNumber({ cacheTime: 0 })]);
    const line = rpcSummaryLines().find((l) => l.startsWith("[rpc:quota-words]"));
    assert.ok(line, "no summary line for the window");
    assert.match(line!, /quota-exhausted:1/);
    assert.match(line!, /PROVIDER QUOTA EXHAUSTED/);
    assert.match(line!, /raise the provider's plan or point the read RPC elsewhere/);
    assert.match(line!, /0 rate-limited/, "a spent quota must not be counted as a rate limit");
  });

  it("and says nothing of the kind for an ordinary rate limit", async () => {
    refuseWith("Too Many Requests");
    const client = createPublicClient({ transport: chainRead(FAKE, "rate-words") });
    await refusals([client.getBlockNumber({ cacheTime: 0 })]);
    const line = rpcSummaryLines().find((l) => l.startsWith("[rpc:rate-words]"));
    assert.ok(line);
    assert.match(line!, /1 rate-limited/);
    assert.doesNotMatch(line!, /QUOTA/);
  });
});
