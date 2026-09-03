import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createPublicClient } from "viem";
import {
  countedHttp,
  providerOf,
  resetWebRpcForTest,
  robinhoodChain,
  robinhoodTestnet,
  rpcUrlFor,
  webRpcSnapshot,
  webRpcSummaryLines,
} from "./rpc";

/**
 * WHY WEB NEEDED ITS OWN COPY OF THIS.
 *
 * Eleven sites in `web` built their own viem client and every one pointed at the
 * same host as the hosted worker fleet — two by hard-coding the literal, eight
 * by inheriting the chain default, one by reading settings. So the fleet's
 * `provider_http_attempts` figure was never web-inclusive, and nothing could
 * move web off that endpoint even if the house changed its RPC.
 *
 * Whether that host's QUOTA is shared between the two Railway services is a
 * separate question these tests do not answer and do not pretend to; see the
 * module header. What they pin is that web now resolves its endpoint from
 * configuration and counts what it sends.
 */

const withFetch = async <T>(fn: typeof fetch, run: () => Promise<T>): Promise<T> => {
  const real = globalThis.fetch;
  globalThis.fetch = fn;
  try {
    return await run();
  } finally {
    globalThis.fetch = real;
  }
};

const jsonOk = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });

test("NEVER THE URL, ONLY THE HOST — an RPC URL can carry a credential", () => {
  assert.equal(providerOf("https://api.pimlico.io/v2/4663/rpc?apikey=SECRET"), "api.pimlico.io");
  const host = providerOf("https://rpc.example.test/v1/KEY123?token=abc");
  assert.equal(host, "rpc.example.test");
  assert.doesNotMatch(host, /KEY123|abc|token|\//);
});

test("THE CANONICAL RESOLUTION: file, then environment, then chain default", () => {
  const before = { main: process.env.MERRYMEN_RPC_MAINNET, test: process.env.MERRYMEN_RPC_TESTNET };
  try {
    delete process.env.MERRYMEN_RPC_MAINNET;
    delete process.env.MERRYMEN_RPC_TESTNET;

    // Last resort — and it is a RESORT now, not the first choice the eight bare
    // http() calls made it.
    assert.equal(rpcUrlFor(robinhoodChain.id), robinhoodChain.rpcUrls.default.http[0]);
    assert.equal(rpcUrlFor(robinhoodTestnet.id), robinhoodTestnet.rpcUrls.default.http[0]);

    // The environment beats the default. Hosted, this is the case that applies:
    // the house strips rpcMainnet from a tenant's settings file, so the file
    // value is absent and only the environment carries it.
    process.env.MERRYMEN_RPC_MAINNET = "https://house.example.test";
    assert.equal(rpcUrlFor(robinhoodChain.id), "https://house.example.test");
    assert.equal(rpcUrlFor(robinhoodTestnet.id), robinhoodTestnet.rpcUrls.default.http[0], "chains resolve apart");

    // A tenant's own file beats the environment (self-hosted).
    assert.equal(
      rpcUrlFor(robinhoodChain.id, { rpcMainnet: "https://tenant.example.test" }),
      "https://tenant.example.test",
    );
    // Blank is not a value — it must fall through, not become an empty URL.
    assert.equal(rpcUrlFor(robinhoodChain.id, { rpcMainnet: "   " }), "https://house.example.test");
  } finally {
    if (before.main === undefined) delete process.env.MERRYMEN_RPC_MAINNET;
    else process.env.MERRYMEN_RPC_MAINNET = before.main;
    if (before.test === undefined) delete process.env.MERRYMEN_RPC_TESTNET;
    else process.env.MERRYMEN_RPC_TESTNET = before.test;
  }
});

test("every HTTP attempt is counted, with the method read off the body", async () => {
  resetWebRpcForTest();
  let n = 0;
  const stub = (async (_u: unknown, init?: RequestInit) => {
    n += 1;
    assert.match(String(init?.body), /eth_getBalance/, "the body is what names the method");
    return jsonOk({ jsonrpc: "2.0", id: n, result: "0x1" });
  }) as unknown as typeof fetch;

  const client = createPublicClient({
    chain: robinhoodChain,
    transport: countedHttp("https://rpc.example.test", "grants", 4663),
  });
  await withFetch(stub, () =>
    client.request({ method: "eth_getBalance", params: ["0x" + "11".repeat(20), "latest"] } as never),
  );

  const snap = webRpcSnapshot();
  assert.equal(snap.length, 1);
  assert.equal(snap[0]!.key, "grants:4663:rpc.example.test");
  assert.equal(snap[0]!.attempts, 1);
  assert.deepEqual(snap[0]!.byStatus, { 200: 1 });
  assert.ok(snap[0]!.methods.includes("eth_getBalance"), "no AsyncLocalStorage needed for the method");
});

test("A RETRIED 429 IS VISIBLE HERE TOO — the same blind spot the worker had", async () => {
  resetWebRpcForTest();
  let n = 0;
  const stub = (async () => {
    n += 1;
    if (n === 1) return new Response(JSON.stringify({ error: "Rate Limit Hit" }), { status: 429 });
    return jsonOk({ jsonrpc: "2.0", id: n, result: "0x1" });
  }) as unknown as typeof fetch;

  const client = createPublicClient({
    chain: robinhoodChain,
    transport: countedHttp("https://rpc.example.test", "market", 4663),
  });
  await withFetch(stub, () => client.request({ method: "eth_blockNumber" } as never));

  assert.equal(n, 2, "viem retried");
  const snap = webRpcSnapshot();
  assert.equal(snap[0]!.attempts, 2, "both attempts counted, not one logical call");
  assert.equal(snap[0]!.rateLimited, 1);
  assert.deepEqual(snap[0]!.byStatus, { 429: 1, 200: 1 });
});

test("a 200 that is really a rate limit is caught, off the request path", async () => {
  resetWebRpcForTest();
  const body = { jsonrpc: "2.0", id: 1, error: { message: "Rate Limit Hit, limit will reset in 6s" } };
  const text = JSON.stringify(body);
  const stub = (async () =>
    jsonOk(body, { "content-length": String(Buffer.byteLength(text)) })) as unknown as typeof fetch;

  const client = createPublicClient({
    chain: robinhoodChain,
    transport: countedHttp("https://rpc.example.test", "market", 4663),
  });
  await withFetch(stub, async () => {
    await client.request({ method: "eth_blockNumber" } as never).catch(() => null);
  });
  await new Promise((r) => setImmediate(r));
  assert.ok(webRpcSnapshot()[0]!.rateLimited >= 1);
});

test("the summary names the counter and carries no credential", async () => {
  resetWebRpcForTest();
  const stub = (async () => jsonOk({ jsonrpc: "2.0", id: 1, result: "0x1" })) as unknown as typeof fetch;
  const client = createPublicClient({
    chain: robinhoodChain,
    transport: countedHttp("https://rpc.example.test/v1/SECRETKEY", "market", 4663),
  });
  await withFetch(stub, () => client.request({ method: "eth_chainId" } as never));

  const line = webRpcSummaryLines()[0]!;
  assert.match(line, /provider_http_attempts 1\b/);
  assert.match(line, /\[http:web:market:4663:rpc\.example\.test\]/);
  assert.doesNotMatch(line, /SECRETKEY|\/v1\//, "a summary line must never carry a credential");
});

test("NO WEB SITE BUILDS AN UNCONFIGURED TRANSPORT ANY MORE", () => {
  // Two sites hard-coded https://rpc.mainnet.chain.robinhood.com as a literal,
  // so no configuration could move them — not the house endpoint, not a
  // failover, not a tenant's own. Eight more passed a bare http() and silently
  // took the chain default.
  const files = [
    "../app/api/circle/route.ts",
    "../app/api/grants/route.ts",
    "./derive-account.ts",
    "./market.ts",
    "./read-discoveries.ts",
    "./read-feed-history.ts",
    "./session.ts",
  ];
  for (const f of files) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(code, /transport:\s*http\(/, `${f} still builds an unconfigured transport`);
    assert.doesNotMatch(
      code,
      /https:\/\/rpc\.(mainnet|testnet)\.chain\.robinhood\.com/,
      `${f} still hard-codes a production RPC URL`,
    );
  }
});

test("THE BROWSER CLIENT IS DELIBERATELY LEFT ALONE, and the reason is on the record", () => {
  // grant/page.tsx is "use client": it runs on the viewer's machine, its
  // requests leave the viewer's IP, and it therefore consumes no quota of ours.
  // Instrumenting it would ship a counter nobody reads and would put node
  // built-ins into a browser bundle.
  const page = readFileSync(new URL("../app/grant/page.tsx", import.meta.url), "utf8");
  assert.match(page.slice(0, 40), /"use client"/, "still a client component");
  const header = readFileSync(new URL("./rpc.ts", import.meta.url), "utf8");
  assert.match(header, /browser bundle/, "and the exclusion is explained where the decision lives");
});
