/**
 * The gateway must not remember a balance it never read.
 *
 * A tester was locked out of Merrymen AI for ten minutes at a time and told his
 * wallet "no longer meets the $MERRYMEN holding requirement" — about tokens he
 * still held. The read had thrown; the catch returned `false`; `false` was then
 * written into the balance cache with the full BALANCE_TTL, so one blink of the
 * mainnet RPC became a ten-minute confident lie about somebody's wallet. His
 * strategist proposed nothing for the duration.
 *
 * Failing closed and REMEMBERING a failure are different things. `isHolder` now
 * answers `{ ok, read }`: only an answered read is cached, and every route can
 * tell "you do not hold enough" (403, about the wallet) from "we could not
 * check" (503, about us) — the same three-way split /api/alpha and
 * worker/src/circle.ts spell out, because the two have different remedies and
 * only one of them is the caller's problem.
 *
 * The gateway is plain ESM and is not in `npm run check`'s CI path, so this pin
 * lives here, in the suite that actually runs. It imports the REAL core through
 * a computed specifier — a hand-written mock of `isHolder` would pass while the
 * shipped file failed open.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { privateKeyToAccount } from "viem/accounts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CORE = pathToFileURL(path.join(ROOT, "gateway", "lib", "core.mjs")).href;
const STORE = pathToFileURL(path.join(ROOT, "gateway", "lib", "store.mjs")).href;

// A computed specifier: tsc cannot resolve a .mjs sibling of the worker project,
// and we want the shipped file, not a declaration of it.
const { createGateway } = (await import(/* @vite-ignore */ CORE)) as any;
const { createStore } = (await import(/* @vite-ignore */ STORE)) as any;

const SECRET = "test-secret-at-least-32-bytes-long-for-hmac!!";
const HOLDER = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);

/** A gateway whose chain read does whatever `read` says. */
function gatewayWith(read: () => Promise<bigint>) {
  const store = createStore();
  const gw = createGateway({
    secret: SECRET,
    upstreamUrl: "https://example.invalid",
    upstreamKey: "x",
    bitqueryKey: "test-bitquery-key",
    model: "test-model",
    domain: "merrymen.dev",
    minTokens: 100000n,
    tokenAddress: "0x0000000000000000000000000000000000000000",
    publicClient: { readContract: () => read() },
    store,
  });
  return { gw, store };
}

const THROWS = async (): Promise<bigint> => {
  throw new Error("HTTP request failed: 429 Too Many Requests");
};
const RICH = async () => 10n ** 18n * 200000n;
const POOR = async () => 0n;

test("a failed balance read is refused, not remembered", async () => {
  const { gw, store } = gatewayWith(THROWS);
  const first = await gw.isHolder(HOLDER.address);
  assert.equal(first.ok, false, "fails closed for this request");
  assert.equal(first.read, false, "and says the read did not happen");
  assert.equal(
    await store.getBal(HOLDER.address.toLowerCase()),
    null,
    "NOTHING is written to the cache — this is the ten-minute lie",
  );
});

test("an answered read is cached; a low balance is a real, cacheable fact", async () => {
  const { gw, store } = gatewayWith(POOR);
  const r = await gw.isHolder(HOLDER.address);
  assert.equal(r.ok, false);
  assert.equal(r.read, true, "the chain answered — that IS a verdict about the wallet");
  assert.equal(await store.getBal(HOLDER.address.toLowerCase()), false, "and it is cached");
});

test("the next request after a failure tries the chain again", async () => {
  let calls = 0;
  const { gw } = gatewayWith(async () => {
    calls += 1;
    if (calls === 1) throw new Error("boom");
    return 10n ** 18n * 200000n;
  });
  assert.equal((await gw.isHolder(HOLDER.address)).read, false);
  const second = await gw.isHolder(HOLDER.address);
  assert.equal(second.ok, true, "recovery is immediate — no sticky negative to wait out");
  assert.equal(calls, 2, "the failure was not cached, so the second call reached the chain");
});

test("/claim answers 503 for an unread balance and 403 only for a real shortfall", async () => {
  for (const [read, status, forbidden] of [
    [THROWS, 503, "doesn't hold"],
    [POOR, 403, "could not"],
  ] as const) {
    const { gw } = gatewayWith(read);
    const n = await gw.nonce({ address: HOLDER.address, ip: "1.1.1.1" });
    const signature = await HOLDER.signMessage({ message: n.json.message });
    const res = await gw.claim({
      body: { address: HOLDER.address, signature, nonce: n.json.nonce },
      ip: "1.1.1.1",
    });
    assert.equal(res.status, status, `claim with this read is ${status}`);
    assert.ok(
      !String(res.json.error).includes(forbidden),
      "the 503 must not read as a verdict on the wallet, nor the 403 as our outage",
    );
  }
});

test("/v1 and /bitquery answer 503 for an unread balance, not 403", async () => {
  const { gw } = gatewayWith(THROWS);
  const token = gw._tokens.issueToken(HOLDER.address);

  const chat = await gw.chat({ token, body: { messages: [] }, ip: "1.1.1.1" });
  assert.equal(chat.status, 503, "a holder with a token is not accused when our read fails");

  const bq = await gw.bitquery({ token, body: { query: "nope" }, ip: "1.1.1.1" });
  assert.equal(bq.status, 503, "same on the discovery route");
});

test("a genuine non-holder is still refused on every gated route", async () => {
  const { gw } = gatewayWith(POOR);
  const token = gw._tokens.issueToken(HOLDER.address);
  assert.equal((await gw.chat({ token, body: {}, ip: "1.1.1.1" })).status, 403);
  assert.equal((await gw.bitquery({ token, body: {}, ip: "1.1.1.1" })).status, 403);
});

test("every gated route destructures the holder result", () => {
  // `!(await isHolder(x))` is now ALWAYS false — an object is truthy — so the
  // half-finished version of this change failed OPEN on all three routes. A
  // behaviour test above catches it for the routes it exercises; this catches
  // the fourth route somebody adds next.
  const src = readFileSync(path.join(ROOT, "gateway", "lib", "core.mjs"), "utf8");
  assert.ok(
    !/!\(await isHolder\(/.test(src),
    "isHolder returns an object; a bare truthiness test on it admits everyone",
  );
  const gated = src.match(/await isHolder\(/g) ?? [];
  const reads = src.match(/\.read\b/g) ?? [];
  assert.ok(gated.length >= 3, "the three gated routes still call it");
  assert.ok(reads.length >= gated.length, "and each call site asks whether the read happened");
});
