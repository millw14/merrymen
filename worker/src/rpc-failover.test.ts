/**
 * WHEN THE HOUSE RPC WILL NOT SERVE, THE CHAIN'S OWN DOES.
 *
 * 2026-09-28 01:48 UTC onward the house endpoint answered every read with
 * "Monthly capacity limit exceeded", and every child went blind — "market
 * unreadable" on every tick — while the chain's public endpoint served
 * normally. These tests drive the real read transport against a stubbed house
 * endpoint and a stubbed public one, and pin:
 *
 *   - a spent quota, a refused key, a 5xx, a dead socket or a hang moves the
 *     read to the chain's public endpoint;
 *   - the house endpoint is skipped while it is down and asked again after,
 *     and the fleet goes back to it by itself when it answers;
 *   - nothing is ever sent twice to the same endpoint, and a bad request is
 *     not shopped around;
 *   - the fallback is the client's OWN chain's default, never configurable;
 *   - the API key in the house URL never reaches a log line or a file name.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPublicClient, defineChain } from "viem";
import { afterEach, beforeEach, describe, it } from "node:test";

process.env.MERRYMEN_HOME = mkdtempSync(path.join(tmpdir(), "merrymen-rpc-failover-"));
delete process.env.MERRYMEN_FLEET_HOME;

const { chainRead, resetGovernorForTest, resetRpcMeters, resetRpcMetersForTest, rpcSummaryLines } = await import("./rpc-meter");
const { classifyRpcError } = await import("./rpc-error");
const { DOWN_HOLD_MS, ERROR_HOLD_MS, endpointKey, failoverEndpoints, holdFor, verdictFor } = await import("./rpc-failover");

const HOUSE = "http://127.0.0.1:9/v2/SECRETKEY123";
const PUBLIC = "http://127.0.0.1:9/public";
const OTHER_PUBLIC = "http://127.0.0.1:9/other-chain";
const chain = defineChain({
  id: 4663, name: "stub", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [PUBLIC] } },
});
const otherChain = defineChain({
  id: 46630, name: "stub-other", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [OTHER_PUBLIC] } },
});
const MONTHLY = "Monthly capacity limit exceeded. Visit https://dashboard.alchemy.com/settings/billing to upgrade your scaling policy for continued service.";

type Behaviour = "ok" | "quota" | "429" | "401" | "500" | "400" | "dead" | "hang" | "endless-quota" | "500-unreadable";
/** What happened to the bodies of the two streaming behaviours. */
const stream = { pulls: 0, cancelled: 0 };
const behaviour = new Map<string, Behaviour>();
const sent: string[] = [];
const sentHeaders: Headers[] = [];
const realFetch = globalThis.fetch;
const realNow = Date.now;
const realWarn = console.warn;
let warnings: string[] = [];
let skew = 0;

function answer(body: unknown): Response {
  const calls = (Array.isArray(body) ? body : [body]) as { id: number; method: string }[];
  const one = (c: { id: number; method: string }) => ({ jsonrpc: "2.0", id: c.id, result: c.method === "eth_getCode" ? "0x" : "0x10" });
  return new Response(JSON.stringify(Array.isArray(body) ? calls.map(one) : one(calls[0]!)), { headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  behaviour.clear();
  sent.length = 0;
  sentHeaders.length = 0;
  stream.pulls = 0;
  stream.cancelled = 0;
  warnings = [];
  skew = 0;
  Date.now = () => realNow() + skew;
  console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(" ")); };
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    sent.push(url);
    sentHeaders.push(new Headers(init?.headers));
    const b = behaviour.get(url) ?? "ok";
    const err = (status: number, message: string) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: status, message } }), { status, headers: { "content-type": "application/json" } });
    if (b === "quota") return err(429, MONTHLY);
    if (b === "429") return err(429, "Too Many Requests");
    if (b === "401") return err(401, "Must be authenticated!");
    if (b === "500") return new Response("upstream exploded", { status: 500 });
    if (b === "400") return err(400, "invalid request");
    if (b === "dead") throw new TypeError("fetch failed");
    if (b === "endless-quota" || b === "500-unreadable") {
      // A body that never ends: the quota JSON, then filler forever. Reading
      // it whole would never return; the 500 one fails any read outright.
      const enc = new TextEncoder();
      let first = true;
      const body = new ReadableStream<Uint8Array>({
        pull(ctl) {
          stream.pulls += 1;
          if (b === "500-unreadable") throw new Error("a body nobody should read");
          ctl.enqueue(enc.encode(first ? JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: 429, message: MONTHLY } }) : "x".repeat(65_536)));
          first = false;
        },
        cancel() { stream.cancelled += 1; },
      }, { highWaterMark: 0 }); // pull only what is actually read — no prefetch to miscount
      return new Response(body, { status: b === "500-unreadable" ? 500 : 429, headers: { "content-type": "application/json" } });
    }
    if (b === "hang") {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason ?? new Error("aborted")));
      });
    }
    return answer(JSON.parse(String(init?.body ?? "{}")));
  }) as typeof globalThis.fetch;
  resetGovernorForTest();
  resetRpcMetersForTest();
  resetRpcMeters();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  Date.now = realNow;
  console.warn = realWarn;
});

const house = () => createPublicClient({ chain, transport: chainRead(HOUSE) });
const readBlock = (c: { getBlockNumber: (a: { cacheTime: number }) => Promise<bigint> }) => c.getBlockNumber({ cacheTime: 0 });
const count = (url: string) => sent.filter((u) => u === url).length;

describe("the verdicts", () => {
  it("A SPENT QUOTA, A REFUSED KEY OR AN UNPAID BILL IS DOWN; a rate limit is only refused", () => {
    assert.equal(verdictFor(429, JSON.stringify({ error: { code: 429, message: MONTHLY } })), "down");
    for (const s of [401, 402, 403]) assert.equal(verdictFor(s, ""), "down", String(s));
    assert.equal(verdictFor(429, "Too Many Requests"), "refused");
    assert.equal(verdictFor(503, ""), "refused");
    for (const s of [500, 502, 504, 522]) assert.equal(verdictFor(s, ""), "error", String(s));
    assert.equal(verdictFor(200, ""), "answer");
    // A bad REQUEST is a bad request everywhere: not a reason to try elsewhere.
    for (const s of [400, 404, 413]) assert.equal(verdictFor(s, ""), "answer", String(s));
    assert.equal(holdFor("down"), DOWN_HOLD_MS);
    assert.equal(holdFor("error"), ERROR_HOLD_MS);
    assert.equal(holdFor("refused"), 0);
  });

  it("the configured endpoint first, the chain's own default after it, never twice", () => {
    assert.deepEqual(failoverEndpoints(HOUSE, PUBLIC), [HOUSE, PUBLIC]);
    assert.deepEqual(failoverEndpoints(undefined, PUBLIC), [PUBLIC]);
    assert.deepEqual(failoverEndpoints(`${PUBLIC}/`, PUBLIC), [`${PUBLIC}/`], "the same endpoint spelled twice is one endpoint");
    assert.deepEqual(failoverEndpoints(undefined, undefined), []);
  });

  it("an endpoint's written name gives nothing of its URL away", () => {
    const k = endpointKey(HOUSE);
    assert.match(k, /^[0-9a-f]{12}$/);
    assert.ok(!k.includes("SECRET"));
    assert.notEqual(k, endpointKey(PUBLIC));
    assert.equal(k, endpointKey(HOUSE), "and it is stable, so every child shares one file per endpoint");
  });
});

describe("a house RPC that will not serve", () => {
  it("A SPENT QUOTA: the read is served by the chain's RPC, and the house RPC is left alone while it is down", async () => {
    behaviour.set(HOUSE, "quota");
    const c = house();
    assert.equal(await readBlock(c), 16n, "the read succeeded — from the fallback");
    assert.deepEqual(sent, [HOUSE, PUBLIC]);

    sent.length = 0;
    for (let i = 0; i < 5; i++) await readBlock(c);
    assert.equal(count(HOUSE), 0, "a down endpoint is not asked again inside its hold");
    assert.equal(count(PUBLIC), 5);

    // Said once, in words, without the URL or the key.
    assert.equal(warnings.length, 1, warnings.join("\n"));
    assert.match(warnings[0]!, /configured read RPC is unavailable \(its quota for the period is spent\)/);
    assert.ok(!warnings[0]!.includes("SECRET") && !warnings[0]!.includes("127.0.0.1"), "no URL, no key");

    // And every summary window says the fleet is running on the fallback.
    const line = rpcSummaryLines().find((l) => l.startsWith("[rpc:failover]"));
    assert.match(line ?? "", /6 request\(s\) in \d+s served by the chain's public RPC — the configured read RPC is unavailable: its quota for the period is spent/);
  });

  it("AND GOES BACK BY ITSELF when the house RPC answers again", async () => {
    behaviour.set(HOUSE, "quota");
    const c = house();
    await readBlock(c);
    // Still spent when the hold runs out: one probe, back to the fallback, no new warning.
    skew += DOWN_HOLD_MS + 1;
    sent.length = 0;
    await readBlock(c);
    assert.deepEqual(sent, [HOUSE, PUBLIC]);
    assert.equal(warnings.length, 1, "a long outage is reported once, not every probe");

    // The operator pays the bill. Within one hold, with no restart, reads are home.
    behaviour.set(HOUSE, "ok");
    skew += DOWN_HOLD_MS + 1;
    sent.length = 0;
    await readBlock(c);
    await readBlock(c);
    assert.deepEqual(sent, [HOUSE, HOUSE]);
    assert.match(warnings.at(-1)!, /configured read RPC is answering again/);
  });

  it("a refused key or an unpaid bill is treated the same way", async () => {
    behaviour.set(HOUSE, "401");
    const c = house();
    assert.equal(await readBlock(c), 16n);
    assert.match(warnings[0]!, /refused the key or the bill \(HTTP 401\)/);
    sent.length = 0;
    await readBlock(c);
    assert.deepEqual(sent, [PUBLIC]);
  });

  it("A 5xX OR A DEAD SOCKET moves the read, and costs the house RPC only a short hold", async () => {
    for (const b of ["500", "dead"] as const) {
      resetGovernorForTest();
      behaviour.set(HOUSE, b);
      sent.length = 0;
      const c = house();
      assert.equal(await readBlock(c), 16n, b);
      assert.deepEqual(sent, [HOUSE, PUBLIC], b);
      behaviour.set(HOUSE, "ok");
      skew += ERROR_HOLD_MS + 1;
      sent.length = 0;
      await readBlock(c);
      assert.deepEqual(sent, [HOUSE], `${b}: back on the house RPC after ${ERROR_HOLD_MS}ms`);
    }
  });

  it("A HANG is cut short, so the fallback still gets a live request", async () => {
    // One signal governs every attempt at a request. A house RPC that never
    // answers would otherwise use all of viem's deadline and hand the fallback
    // a request that is already cancelled.
    behaviour.set(HOUSE, "hang");
    const c = house();
    const started = realNow();
    assert.equal(await readBlock(c), 16n);
    assert.deepEqual(sent, [HOUSE, PUBLIC]);
    assert.ok(realNow() - started < 9_000, "inside viem's own 10s deadline");
  });

  it("A RATE LIMIT moves this read without a long hold; a pattern of them opens the breaker, which is skipped, not waited on", async () => {
    // A full-width jittered backoff, so the read after the third strike lands
    // inside the breaker's window rather than racing a near-zero draw.
    const realRandom = Math.random;
    Math.random = () => 0.99;
    try {
    behaviour.set(HOUSE, "429");
    const c = house();
    assert.equal(await readBlock(c), 16n);
    assert.deepEqual(sent, [HOUSE, PUBLIC], "one refusal: this read moves on");
    sent.length = 0;
    await readBlock(c);
    await readBlock(c);
    assert.deepEqual(sent, [HOUSE, PUBLIC, HOUSE, PUBLIC], "and the house RPC is still preferred");
    // Third strike opened the house RPC's breaker: now it is not even asked.
    sent.length = 0;
    await readBlock(c);
    assert.deepEqual(sent, [PUBLIC]);
    assert.equal(warnings.length, 0, "a rate limit is not an outage");
    } finally {
      Math.random = realRandom;
    }
  });
});

describe("reading a refusal's body", () => {
  it("AN ENDLESS BODY IS READ ONLY AS FAR AS THE VERDICT, then cancelled", async () => {
    behaviour.set(HOUSE, "endless-quota");
    const c = house();
    assert.equal(await readBlock(c), 16n, "classified as a spent quota and served by the fallback");
    assert.deepEqual(sent, [HOUSE, PUBLIC]);
    // The quota line, then at most a filler chunk or two: bounded, not "all of it".
    assert.ok(stream.pulls <= 4, `read ${stream.pulls} chunks of a body that never ends`);
    assert.ok(stream.cancelled >= 1, "and the stream was let go");
  });

  it("and so is one with nowhere to fail over to — the caller still hears it was a spent quota", async () => {
    behaviour.set(HOUSE, "endless-quota");
    const alone = createPublicClient({ transport: chainRead(HOUSE) }); // no chain: no fallback
    const e = await readBlock(alone).then(() => null, (err: unknown) => err);
    assert.equal(classifyRpcError(e).kind, "quota-exhausted");
    assert.ok(stream.pulls <= 4, `read ${stream.pulls} chunks`);
  });

  it("A 5xx BODY IS NEVER READ — it is somebody else's error page, of any size", async () => {
    behaviour.set(HOUSE, "500-unreadable");
    const c = house();
    assert.equal(await readBlock(c), 16n);
    assert.deepEqual(sent, [HOUSE, PUBLIC]);
    assert.equal(stream.pulls, 0);
  });
});

describe("what failover must never do", () => {
  it("matches viem's normalized root URL when locating the fallback", async () => {
    const configured = "http://127.0.0.1:9";
    behaviour.set(`${configured}/`, "quota");
    const c = createPublicClient({ chain, transport: chainRead(configured) });
    assert.equal(await readBlock(c), 16n);
    assert.deepEqual(sent, [`${configured}/`, PUBLIC]);
  });

  it("keeps the primary provider's Basic credentials away from the public RPC", async () => {
    behaviour.set(HOUSE, "quota");
    const configured = HOUSE.replace("http://", "http://reader:private-key@");
    const c = createPublicClient({ chain, transport: chainRead(configured) });
    assert.equal(await readBlock(c), 16n);
    assert.deepEqual(sent, [HOUSE, PUBLIC]);
    assert.equal(sentHeaders[0]!.get("authorization"), `Basic ${Buffer.from("reader:private-key").toString("base64")}`);
    assert.equal(sentHeaders[1]!.get("authorization"), null);
    assert.ok([...warnings, ...rpcSummaryLines()].every(line => !line.includes("private-key")));
  });

  it("NEVER SENDS A REQUEST TWICE TO ONE ENDPOINT, and surfaces the last refusal when both refuse", async () => {
    behaviour.set(HOUSE, "quota");
    behaviour.set(PUBLIC, "429");
    const c = house();
    const e = await readBlock(c).then(() => null, (err: unknown) => err);
    assert.ok(e, "nothing served it, so it failed");
    assert.deepEqual(sent, [HOUSE, PUBLIC], "each endpoint asked exactly once");
    assert.equal(classifyRpcError(e).kind, "rate-limited", "the caller sees the last endpoint's own refusal");
  });

  it("A BAD REQUEST IS NOT SHOPPED AROUND", async () => {
    behaviour.set(HOUSE, "400");
    const c = house();
    await readBlock(c).catch(() => null);
    assert.deepEqual(sent, [HOUSE], "the fallback would say the same; asking it doubles the load");
  });

  it("WITH NO HOUSE RPC, there is one endpoint and nothing changes", async () => {
    behaviour.set(PUBLIC, "quota");
    const c = createPublicClient({ chain, transport: chainRead(undefined) });
    const e = await readBlock(c).then(() => null, (err: unknown) => err);
    assert.deepEqual(sent, [PUBLIC]);
    assert.equal(classifyRpcError(e).kind, "quota-exhausted");
  });

  it("THE FALLBACK IS THE CLIENT'S OWN CHAIN'S — and a URL claimed by two chains gets none", async () => {
    behaviour.set(HOUSE, "quota");
    const mainnetOnly = createPublicClient({ chain, transport: chainRead(HOUSE) });
    await readBlock(mainnetOnly);
    assert.ok(sent.includes(PUBLIC) && !sent.includes(OTHER_PUBLIC));

    // The same house URL configured for a second chain is a misconfiguration.
    // Whichever chain registered last must not decide where the other's reads go.
    // (No reset in between: the first client's registration is the point.)
    sent.length = 0;
    const confused = createPublicClient({ chain: otherChain, transport: chainRead(HOUSE) });
    await readBlock(confused).catch(() => null);
    await readBlock(mainnetOnly).catch(() => null);
    assert.ok(!sent.includes(OTHER_PUBLIC) && !sent.includes(PUBLIC), `ambiguous: ${sent.join(", ")}`);
  });

  it("MERRYMEN_RPC_FAILOVER=off keeps every read on the configured endpoint", async (t) => {
    const prior = process.env.MERRYMEN_RPC_FAILOVER;
    process.env.MERRYMEN_RPC_FAILOVER = "off";
    t.after(() => { if (prior === undefined) delete process.env.MERRYMEN_RPC_FAILOVER; else process.env.MERRYMEN_RPC_FAILOVER = prior; });
    behaviour.set(HOUSE, "quota");
    const c = house();
    const e = await readBlock(c).then(() => null, (err: unknown) => err);
    assert.deepEqual(sent, [HOUSE], "the public endpoint is never asked");
    assert.equal(classifyRpcError(e).kind, "quota-exhausted");
  });

  it("THE KEY NEVER REACHES A FILE NAME OR A LOG LINE", async () => {
    // Force every path that writes: a quota outage (warns), and a breaker on
    // the fallback (publishes the shared cooldown file).
    behaviour.set(HOUSE, "quota");
    behaviour.set(PUBLIC, "429");
    const c = house();
    for (let i = 0; i < 4; i++) await readBlock(c).catch(() => null);
    const files = readdirSync(process.env.MERRYMEN_HOME!);
    assert.ok(files.some((f) => f.startsWith("rpc-cooldown-")), `the fallback's breaker was published: ${files.join(", ")}`);
    for (const f of files) assert.ok(!f.includes("SECRET"), f);
    for (const w of [...warnings, ...rpcSummaryLines()]) assert.ok(!w.includes("SECRET"), w);
  });
});
