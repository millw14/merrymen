import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createPublicClient } from "viem";
import { robinhoodChain } from "../../packages/core/src/index";
import {
  countedHttp,
  httpMeterSnapshot,
  providerOf,
  resetRpcMetersForTest,
  rpcMeterSnapshot,
  rpcSummaryLines,
} from "./rpc-meter";

/**
 * THE GAP THIS CLOSES WAS MEASURED, NOT SUSPECTED.
 *
 * `metered()` wraps the object `http()` returns, and viem builds its retry loop
 * INSIDE that object — so the wrapper counted one logical operation however many
 * HTTP requests actually left the box. Measured on 2026-09-03: a 21-chunk
 * eth_getLogs sweep produced 22 HTTP requests (`statuses 200:26 429:1`) because
 * a 429 was retried into a success. The sweep reported no error and `metered()`
 * saw one clean call, while a provider quota — denominated in HTTP requests —
 * had been charged twice.
 *
 * These tests drive the real transport over a stub server, so the retry they
 * observe is viem's own rather than a simulation of it.
 */

/** A fetch that answers however the test says, and counts what it was asked. */
function stubFetch(plan: (n: number) => { status: number; body: unknown; headers?: Record<string, string> }) {
  let n = 0;
  const seen: number[] = [];
  const fn = async () => {
    n += 1;
    seen.push(n);
    const { status, body, headers } = plan(n);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...(headers ?? {}) },
    });
  };
  return { fn, attempts: () => n, seen };
}

/** Patch global fetch for one call, since countedHttp closes over the real one. */
async function withFetch<T>(fn: typeof fetch, run: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = fn;
  try {
    return await run();
  } finally {
    globalThis.fetch = real;
  }
}

const ok = (n: number) => ({ status: 200, body: { jsonrpc: "2.0", id: n, result: "0x1" } });

test("providerOf keeps the HOST and drops the path, because a path can hold a key", () => {
  assert.equal(providerOf("https://api.pimlico.io/v2/4663/rpc?apikey=SECRET"), "api.pimlico.io");
  assert.equal(providerOf("https://rpc.mainnet.chain.robinhood.com"), "rpc.mainnet.chain.robinhood.com");
  assert.equal(providerOf(undefined), "chain-default");
  assert.equal(providerOf("not a url"), "unknown");
  // The whole point: no summary line may ever carry a credential.
  const line = providerOf("https://api.pimlico.io/v2/4663/rpc?apikey=SECRET");
  assert.doesNotMatch(line, /SECRET|apikey|\//);
});

test("THE 429-RETRIED-INTO-SUCCESS IS NOW VISIBLE — 1 logical call, 2 HTTP attempts", async () => {
  resetRpcMetersForTest();
  // Exactly the measured case: first attempt 429, viem retries, second succeeds.
  const stub = stubFetch((n) => (n === 1 ? { status: 429, body: { error: "Rate Limit Hit" } } : ok(n)));
  const client = createPublicClient({
    chain: robinhoodChain,
    transport: countedHttp("https://rpc.example.test", "read", 4663),
  });

  await withFetch(stub.fn, () => client.request({ method: "eth_blockNumber" } as never));

  assert.equal(stub.attempts(), 2, "viem retried the 429");

  const logical = rpcMeterSnapshot();
  assert.equal(logical.length, 1);
  assert.equal(logical[0]!.calls, 1, "logical_rpc_calls counts the OPERATION");
  assert.equal(logical[0]!.errors, 0, "and it succeeded, which is why it left no trace before");

  const http = httpMeterSnapshot();
  assert.equal(http.length, 1);
  assert.equal(http[0]!.attempts, 2, "provider_http_attempts counts what the PROVIDER was sent");
  assert.equal(http[0]!.retries, 1, "and knows the second was a retry");
  assert.equal(http[0]!.rateLimited, 1, "the hidden 429 is counted");
  assert.deepEqual(http[0]!.byStatus, { 429: 1, 200: 1 });
  assert.equal(http[0]!.noContext, 0, "every attempt was attributed to its operation");
});

test("a JSON-RPC rate limit carrying HTTP 200 is caught too", async () => {
  resetRpcMetersForTest();
  // This chain returns rate limiting BOTH ways. Status alone misses this one.
  const body = { jsonrpc: "2.0", id: 1, error: { code: -32029, message: "Rate Limit Hit, limit will reset in 6s" } };
  const text = JSON.stringify(body);
  const stub = stubFetch(() => ({
    status: 200,
    body,
    headers: { "content-length": String(Buffer.byteLength(text)) },
  }));
  const client = createPublicClient({
    chain: robinhoodChain,
    transport: countedHttp("https://rpc.example.test", "read", 4663),
  });

  await withFetch(stub.fn, async () => {
    await client.request({ method: "eth_blockNumber" } as never).catch(() => null);
  });
  // The body scan is off the request path, so give the microtask queue a turn.
  await new Promise((r) => setImmediate(r));

  const http = httpMeterSnapshot();
  assert.ok(http[0]!.rateLimited >= 1, "a 200 that is really a rate limit is counted");
  assert.deepEqual(http[0]!.byStatus, { 200: http[0]!.byStatus[200] }, "and its status is recorded honestly as 200");
});

test("THE CONFLATION IS FIXED: two chains on two hosts are two buckets", async () => {
  resetRpcMetersForTest();
  const stub = stubFetch(ok);
  const main = createPublicClient({
    chain: robinhoodChain,
    transport: countedHttp("https://rpc.mainnet.example", "read", 4663),
  });
  const test46630 = createPublicClient({
    chain: robinhoodChain,
    transport: countedHttp("https://rpc.testnet.example", "read", 46630),
  });

  await withFetch(stub.fn, async () => {
    await main.request({ method: "eth_blockNumber" } as never);
    await test46630.request({ method: "eth_blockNumber" } as never);
    await test46630.request({ method: "eth_blockNumber" } as never);
  });

  // Sorted lexicographically, where "46630" precedes "4663:" because '0' < ':'.
  const keys = rpcMeterSnapshot().map((m) => m.key).sort();
  assert.deepEqual(keys, ["read:46630:rpc.testnet.example", "read:4663:rpc.mainnet.example"]);
  const byKey = new Map(rpcMeterSnapshot().map((m) => [m.key, m.calls]));
  assert.equal(byKey.get("read:4663:rpc.mainnet.example"), 1);
  assert.equal(byKey.get("read:46630:rpc.testnet.example"), 2, "the testnet half is no longer hidden inside mainnet");
});

test("both counters appear in the emitted lines, named", async () => {
  resetRpcMetersForTest();
  const stub = stubFetch((n) => (n === 1 ? { status: 429, body: { error: "rate limit" } } : ok(n)));
  const client = createPublicClient({
    chain: robinhoodChain,
    transport: countedHttp("https://rpc.example.test", "read", 4663),
  });
  await withFetch(stub.fn, () => client.request({ method: "eth_call" } as never));

  const lines = rpcSummaryLines();
  const rpc = lines.find((l) => l.startsWith("[rpc:"));
  const http = lines.find((l) => l.startsWith("[http:"));
  assert.ok(rpc && http, "one line per layer");
  assert.match(rpc!, /logical_rpc_calls 1\b/);
  assert.match(http!, /provider_http_attempts 2\b/);
  assert.match(http!, /\+1 retries/);
  assert.match(http!, /statuses .*429:1/);
  assert.match(http!, /peak http concurrency \d+/);
  assert.match(http!, /p50 \d+ms p95 \d+ms/);
  // Both carry the tenant and the resolved target.
  assert.match(rpc!, /tenant \w+/);
  assert.match(http!, /read:4663:rpc\.example\.test/);
});

test("IN-FLIGHT HTTP CONCURRENCY IS COUNTED AT THE SOCKET, not at the operation", async () => {
  resetRpcMetersForTest();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let started = 0;
  const slow = (async () => {
    started += 1;
    await gate;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const client = createPublicClient({
    chain: robinhoodChain,
    transport: countedHttp("https://rpc.example.test", "read", 4663),
  });
  await withFetch(slow, async () => {
    const all = Promise.all([
      client.request({ method: "eth_call" } as never),
      client.request({ method: "eth_call" } as never),
      client.request({ method: "eth_call" } as never),
    ]);
    while (started < 3) await new Promise((r) => setImmediate(r));
    // All three sockets are open at once — this is the number a fleet limiter
    // has to bound, and the number the old meter could only report per process.
    assert.equal(httpMeterSnapshot()[0]!.peakInFlight, 3);
    release();
    await all;
  });
});

test("THE SEND EDGE: retries are observed, never added", () => {
  // The no-retry guarantee on a broadcast comes from viem issuing
  // eth_sendUserOperation with a per-call retryCount: 0 and from metered()
  // forwarding its second argument so that override survives the wrapper. The
  // HTTP layer only watches. A wrapper that dropped reqOpts, or a fetch layer
  // that re-issued, would silently restore three retries on a real send.
  const src = readFileSync(new URL("./rpc-meter.ts", import.meta.url), "utf8");
  assert.match(src, /\(args, reqOpts\)/, "the request options must be forwarded");
  assert.match(src, /await fetch\(input, init\)/, "the fetch layer calls fetch exactly once");
  const fetchLayer = src.slice(src.indexOf("export function meteredFetch"), src.indexOf("export function metered("));
  assert.doesNotMatch(fetchLayer, /for \(|while \(|retry/i, "the fetch layer must contain no retry loop");

  const exec = readFileSync(new URL("./executor.ts", import.meta.url), "utf8");
  assert.match(exec, /bundlerTransport: countedHttp\(opts\.bundlerUrl, "bundler", opts\.chain\.id\)/);
  // And the send itself is still one call with no wrapper of its own.
  const send = exec.slice(exec.indexOf("accepted = await client.sendUserOperation("));
  assert.doesNotMatch(send.slice(0, 400), /retry|for \(|while \(/i, "nothing may re-send");
});

test("EVERY PRODUCTION TRANSPORT IS COUNTED, including the two that never were", () => {
  // paymaster.ts pointed at the same Pimlico host as the bundler and was never
  // metered, so the bundler figures understated the quota by exactly the
  // sponsorship traffic. snapshot.ts's boot client used a bare http() against
  // the public default.
  for (const f of ["snapshot.ts", "circle.ts", "index.ts", "executor.ts", "paymaster.ts"]) {
    const src = readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
    const lines = src.split("\n").filter((l) => /transport:\s*http\(|createPaymasterClient\(\{ transport: http\(/.test(l));
    assert.deepEqual(lines, [], `${f} still builds an uncounted transport: ${lines.join(" | ")}`);
  }
  const pm = readFileSync(new URL("./paymaster.ts", import.meta.url), "utf8");
  assert.match(pm, /countedHttp\(opts\.url, "paymaster", opts\.chainId\)/, "the sponsor gets its OWN label");
});
