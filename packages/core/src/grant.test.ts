import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { publicGrantView, uncoveredBasketSymbols } from "./grant";
/**
 * THE BANNER THAT COULD NOT FIRE FOR THE TOKEN THAT NEEDED IT.
 *
 * `uncoveredBasketSymbols` filtered `STOCK_TOKENS`, so a CUSTOM token in the
 * basket simply fell out of the filter and the red "update your trading
 * permissions to buy or sell X" warning never appeared for a memecoin — which is
 * exactly the token an owner is most likely to have added after signing, and the
 * one the `no-exit` rule then refuses at the wall.
 */
describe("uncovered basket symbols include the owner's own tokens", () => {
  const CATE = { symbol: "CATE", address: "0xcacacacacacacacacacacacacacacacacacacace" };
  const covered = { grantFeatures: ["tradeable-v2"], grantTokens: [CATE.address] } as never;
  const bare = { grantFeatures: ["tradeable-v2"], grantTokens: [] } as never;

  it("A CUSTOM TOKEN THE GRANT CANNOT SELL IS REPORTED", () => {
    assert.deepEqual(uncoveredBasketSymbols(["CATE"], bare, [CATE]), ["CATE"]);
  });

  it("and one the grant CAN sell is not", () => {
    assert.deepEqual(uncoveredBasketSymbols(["CATE"], covered, [CATE]), []);
  });

  it("with no custom tokens passed, behaviour is byte-identical to before", () => {
    // The default keeps the two callers that already union in `tokenCoverage`
    // — Wallet.tsx and the worker's coverage note — from double-reporting.
    assert.deepEqual(uncoveredBasketSymbols(["CATE"], bare), []);
  });
});

/**
 * A GRANT BECOMES A RESPONSE ONLY THROUGH AN ALLOWLIST.
 *
 * GET /api/grants stripped three top-level keys and spread the rest, so a
 * nested `perp` block — sealed private key and all — would have gone to every
 * browser tab and into the iOS app's URL cache. The test fills a grant with
 * every secret it can carry, plus one nobody has invented yet, and scans the
 * JSON for each in every spelling a leak would take.
 */
describe("publicGrantView carries no secret, sealed or not", () => {
  const SESSION_KEY = `0x${"1a".repeat(32)}`;
  const OWNER_KEY = `0x${"2b".repeat(32)}`;
  const WALLET_SIG = `0x${"3c".repeat(65)}`;
  const OWNER_SIG = `0x${"4d".repeat(65)}`;
  const SERIALIZED = `eyJzZXNzaW9u${"QkFE".repeat(20)}`;
  const SEALED = `v1.${"5e".repeat(48)}`;
  const API_PRIVATE_KEY = `0x${"6f".repeat(40)}`; // 80 hex, the shape of a Lighter private key
  const NONCE = "nonce-7d1c3f";
  const DID = "did:privy:secret-ish-9f2e";
  const PUBKEY = "0x2427c4493c2df1a3ecdd750f1398b865e5428907c41065f0612cb3fa6b5ea0d7ac00465b07f3acd7";
  const ACCOUNT = "0x8e93b78ef08d5e36da2e2473cd9027f8c286c176";
  const ADAPTER = "0x00000000000000000000000000000000000000d4";

  const grant = {
    smartAccount: ACCOUNT,
    owner: "0x00000000000000000000000000000000000000a1",
    sessionKeyAddress: "0x00000000000000000000000000000000000000b2",
    serialized: SERIALIZED,
    caps: { perTradeUsdg: 25, dailyUsdg: 100, expiryDays: 14, maxDrawdownPct: 20, maxOpsPerDay: 48, note: API_PRIVATE_KEY },
    grantedAt: 1_790_000_000,
    expiresAt: 1_791_209_600,
    chainId: 4663,
    grantFeatures: ["tradeable-v2", "perp-lighter-v1", API_PRIVATE_KEY.slice(2)],
    grantTokens: ["0x00000000000000000000000000000000000000e7", SESSION_KEY],
    v4AdapterAddress: ADAPTER,
    ponsClassVaultAddress: OWNER_KEY, // a secret in a sealed-address field: wrong shape, dropped
    binding: { version: "privy-did-owner-v1", nonce: NONCE, walletSignature: WALLET_SIG, ownerSignature: OWNER_SIG, did: DID },
    perp: { route: "perp-lighter-v1", apiKeyIndex: 16, apiPublicKey: PUBKEY, apiKeySealed: SEALED, apiPrivateKey: API_PRIVATE_KEY },
    demoSessionPrivateKey: SESSION_KEY,
    demoOwnerPrivateKey: OWNER_KEY,
    // A field nobody has invented yet — the case a denylist cannot cover.
    futureVenueKey: API_PRIVATE_KEY,
    nested: { deeper: { apiKey: API_PRIVATE_KEY } },
  };

  const spellings = (secret: string) => {
    const bare = secret.startsWith("0x") ? secret.slice(2) : secret;
    return [secret, bare, bare.toUpperCase(), bare.toLowerCase(), `0x${bare.toUpperCase()}`];
  };

  it("none of the secrets appears in the JSON, in any spelling", () => {
    const json = JSON.stringify(publicGrantView(grant));
    for (const secret of [SESSION_KEY, OWNER_KEY, WALLET_SIG, OWNER_SIG, SERIALIZED, SEALED, API_PRIVATE_KEY, NONCE, DID]) {
      for (const s of spellings(secret)) {
        assert.ok(!json.includes(s), `leaked ${s.slice(0, 18)}…`);
      }
    }
    // By shape too: nothing that looks like a 64- or 80-hex key survives,
    // except the one 80-hex value that is public by design.
    const hexRuns = json.match(/[0-9a-fA-F]{64,}/g) ?? [];
    assert.deepEqual(hexRuns, [PUBKEY.slice(2)], "the only long hex run is the API PUBLIC key");
  });

  it("and carries exactly the allowlisted fields, with the perp block's public half", () => {
    const v = publicGrantView(grant);
    assert.deepEqual(Object.keys(v).sort(), [
      "binding",
      "caps",
      "chainId",
      "expiresAt",
      "grantFeatures",
      "grantTokens",
      "grantedAt",
      "owner",
      "perp",
      "sessionKeyAddress",
      "smartAccount",
      "v4AdapterAddress",
    ]);
    assert.deepEqual(v.perp, { route: "perp-lighter-v1", apiKeyIndex: 16, apiPublicKey: PUBKEY });
    assert.deepEqual(v.binding, { version: "privy-did-owner-v1" });
    assert.deepEqual(v.caps, { perTradeUsdg: 25, dailyUsdg: 100, expiryDays: 14, maxDrawdownPct: 20, maxOpsPerDay: 48 });
    assert.deepEqual(v.grantFeatures, ["tradeable-v2", "perp-lighter-v1"]);
    assert.deepEqual(v.grantTokens, ["0x00000000000000000000000000000000000000e7"]);
    assert.equal(v.smartAccount, ACCOUNT);
    assert.equal(v.v4AdapterAddress, ADAPTER);
    assert.equal(v.chainId, 4663);
  });

  it("a legacy binding keeps no version it did not have; an unknown one is not echoed", () => {
    assert.deepEqual(publicGrantView({ binding: { nonce: NONCE, ownerSignature: OWNER_SIG } }).binding, {});
    assert.deepEqual(publicGrantView({ binding: { version: API_PRIVATE_KEY } }).binding, {});
  });

  it("a malformed perp block is left out rather than half-shown", () => {
    for (const perp of [
      { route: "perp-lighter-v1", apiKeyIndex: 16, apiPublicKey: `0x${"0".repeat(80)}` },
      { route: "perp-lighter-v2", apiKeyIndex: 16, apiPublicKey: PUBKEY },
      { route: "perp-lighter-v1", apiKeyIndex: "16", apiPublicKey: PUBKEY },
      { route: "perp-lighter-v1", apiKeyIndex: 16 },
      "perp-lighter-v1",
    ]) {
      assert.equal(publicGrantView({ perp }).perp, undefined, JSON.stringify(perp));
    }
  });

  it("anything that is not a grant yields an empty view, never a throw", () => {
    for (const g of [null, undefined, 42, "grant", []]) assert.deepEqual(publicGrantView(g), {});
  });
});
