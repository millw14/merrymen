import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { retryGrantHandoff, setPrivyTokenSource, type Grant } from "./session";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; setPrivyTokenSource(null); });

it("retries the exact saved Privy permission using fresh authentication without another signing request", async () => {
  const grant = { smartAccount: `0x${"b".repeat(40)}`, owner: `0x${"a".repeat(40)}`, sessionKeyAddress: `0x${"c".repeat(40)}`,
    caps: { perTradeUsdg: 10, dailyUsdg: 50, expiryDays: 7, maxDrawdownPct: 5, maxOpsPerDay: 24 }, chainId: 4663,
    grantedAt: 1, expiresAt: 604801, demoSessionPrivateKey: `0x${"d".repeat(64)}`, serialized: "same-signed-permission", binding: {
    version: "privy-did-owner-v1", nonce: "same-nonce", ownerSignature: "0xsame-signature", did: "did:privy:test",
  } } as Grant;
  let tokenReads = 0;
  setPrivyTokenSource(async () => `fresh-token-${++tokenReads}`);
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  globalThis.fetch = async (input, init) => { requests.push({ url: String(input), init }); return Response.json({ ok: true }); };
  assert.deepEqual(await retryGrantHandoff(grant), { ok: true });
  assert.deepEqual(await retryGrantHandoff(grant), { ok: true });
  assert.equal(tokenReads, 2);
  assert.deepEqual(requests.map(request => request.url), ["/api/grants", "/api/grants"]);
  for (const [index, request] of requests.entries()) {
    assert.equal(new Headers(request.init?.headers).get("Authorization"), `Bearer fresh-token-${index + 1}`);
    assert.deepEqual(JSON.parse(String(request.init?.body)), grant);
  }
});

it("does not claim successful activation when the same permission is refused", async () => {
  globalThis.fetch = async () => Response.json({ error: "permission could not be verified" }, { status: 403 });
  const result = await retryGrantHandoff({ binding: { version: "privy-did-owner-v1" } } as Grant);
  assert.equal(result.ok, false);
  assert.match(result.error!, /permission could not be verified/);
});
