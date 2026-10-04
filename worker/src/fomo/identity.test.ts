import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  chainFromProvider,
  chainFromUserText,
  executionAvailabilityOf,
  isRobinhoodToken,
  robinhoodChain,
  tokenFromKey,
  tokenIdentity,
  verifyChainFilter,
} from "./identity";
import { dedupeEvents, eventIdentity } from "./events";
import type { TraderEvent } from "./types";

const EVM = "0xAbCdEf0123456789aBCDef0123456789ABcdEF01";
const MINT = "So11111111111111111111111111111111111111112";

describe("chain identity from provider rows", () => {
  it("maps documented ids and slugs, and keeps the id a row carried", () => {
    assert.deepEqual(chainFromProvider(4663, "robinhood"), { namespace: "eip155", networkId: 4663, slug: "robinhood" });
    assert.deepEqual(chainFromProvider(undefined, "hood"), { namespace: "eip155", networkId: 4663, slug: "robinhood" });
    assert.deepEqual(chainFromProvider(1399811149, undefined), { namespace: "solana", networkId: 1399811149, slug: "solana" });
    assert.deepEqual(chainFromProvider(1337, "hyperliquid"), { namespace: "hyperliquid", networkId: 1337, slug: "hyperliquid" });
  });

  it("never assumes an undocumented EVM network is Robinhood", () => {
    assert.deepEqual(chainFromProvider(undefined, "base"), { namespace: "eip155", networkId: null, slug: "base" });
    assert.deepEqual(chainFromProvider(8453, "base"), { namespace: "eip155", networkId: 8453, slug: "base" });
  });

  it("distrusts a row whose id and slug disagree", () => {
    assert.equal(chainFromProvider(4663, "solana").namespace, "unknown");
    assert.equal(chainFromProvider(4663, "solana").networkId, null);
    assert.equal(chainFromProvider(1399811149, "base").namespace, "unknown");
  });

  it("an unknown id with no slug stays unknown, not mainnet", () => {
    assert.deepEqual(chainFromProvider(999_999, undefined), { namespace: "unknown", networkId: 999_999, slug: null });
  });

  it("reads chain words people type", () => {
    assert.equal(chainFromUserText("RH")?.networkId, 4663);
    assert.equal(chainFromUserText("robinhood chain")?.networkId, 4663);
    assert.equal(chainFromUserText("sol")?.namespace, "solana");
    assert.equal(chainFromUserText("pepe"), null);
  });
});

describe("token identity", () => {
  it("lowercases EVM addresses and keys them by network", () => {
    const rh = tokenIdentity(robinhoodChain(), EVM)!;
    assert.equal(rh.address, EVM.toLowerCase());
    assert.equal(rh.key, `eip155:4663:${EVM.toLowerCase()}`);
    const base = tokenIdentity(chainFromProvider(8453, "base"), EVM)!;
    assert.notEqual(base.key, rh.key, "the same hex on two EVM networks is two tokens");
  });

  it("preserves Solana mint case", () => {
    const t = tokenIdentity(chainFromProvider(1399811149, "solana"), MINT)!;
    assert.equal(t.address, MINT);
    assert.equal(tokenIdentity(chainFromProvider(1399811149, "solana"), MINT.toLowerCase())?.address, MINT.toLowerCase());
    assert.notEqual(tokenIdentity(chainFromProvider(1399811149, "solana"), MINT.toLowerCase())?.key, t.key);
  });

  it("refuses addresses that do not fit the chain", () => {
    assert.equal(tokenIdentity(chainFromProvider(1399811149, "solana"), EVM), null);
    assert.equal(tokenIdentity(robinhoodChain(), MINT), null);
    assert.equal(tokenIdentity(robinhoodChain(), "0x1234"), null);
    assert.equal(tokenIdentity(robinhoodChain(), "PEPE"), null);
  });

  it("an EVM address on an unknown chain is kept but never executable", () => {
    const t = tokenIdentity(chainFromProvider(undefined, undefined), EVM)!;
    assert.equal(t.chain.namespace, "eip155");
    assert.equal(t.chain.networkId, null);
    assert.equal(isRobinhoodToken(t), false);
    assert.equal(executionAvailabilityOf(t, { routeVerified: true, permitted: true }), "unresolved-identity");
  });

  it("round-trips keys", () => {
    const t = tokenIdentity(robinhoodChain(), EVM)!;
    assert.deepEqual(tokenFromKey(t.key), t);
    assert.equal(tokenFromKey("eip155:4663:nonsense"), null);
  });

  it("classifies execution availability separately from research", () => {
    const rh = tokenIdentity(robinhoodChain(), EVM)!;
    const sol = tokenIdentity(chainFromProvider(1399811149, "solana"), MINT)!;
    assert.equal(executionAvailabilityOf(null, { routeVerified: true, permitted: true }), "unresolved-identity");
    assert.equal(executionAvailabilityOf(sol, { routeVerified: true, permitted: true }), "unsupported-chain");
    assert.equal(executionAvailabilityOf(rh, { routeVerified: null, permitted: true }), "unsupported-venue");
    assert.equal(executionAvailabilityOf(rh, { routeVerified: true, permitted: false }), "supported-permission-missing");
    assert.equal(executionAvailabilityOf(rh, { routeVerified: true, permitted: true }), "supported-authorized");
  });
});

describe("chain filter verification", () => {
  it("detects a filter the provider ignored", () => {
    const rh = tokenIdentity(robinhoodChain(), EVM);
    const sol = tokenIdentity(chainFromProvider(1399811149, "solana"), MINT);
    assert.deepEqual(verifyChainFilter(robinhoodChain(), [rh, rh]), { honoured: true, offending: 0, unplaced: 0 });
    assert.equal(verifyChainFilter(robinhoodChain(), [rh, sol]).honoured, false);
    assert.equal(verifyChainFilter(robinhoodChain(), [null, null]).honoured, null);
    assert.equal(verifyChainFilter(robinhoodChain(), [rh, null]).honoured, false);
  });
});

describe("event identity", () => {
  const base = { kind: "buy" as const, userId: "u1", tokenKey: "eip155:4663:0xabc", sourceEventAt: 1_788_378_001_234 };

  it("prefers the provider event id, which is shared by stream and REST", () => {
    const id = "149318d0-1111-2222-3333-444455556666";
    const a = eventIdentity({ ...base, eventId: id });
    const b = eventIdentity({ ...base, eventId: id.toUpperCase(), swapId: "s9" });
    assert.equal(a.eventKey, b.eventKey);
    assert.equal(a.basis, "provider-event-id");
    assert.equal(a.ambiguous, false);
  });

  it("two fills in one transaction keep two identities", () => {
    const tx = "0x" + "a".repeat(64);
    const f1 = eventIdentity({ ...base, txHash: tx, swapId: "swap-1" });
    const f2 = eventIdentity({ ...base, txHash: tx, swapId: "swap-2" });
    assert.notEqual(f1.eventKey, f2.eventKey);
    const l1 = eventIdentity({ ...base, txHash: tx, logIndex: 3 });
    const l2 = eventIdentity({ ...base, txHash: tx, logIndex: 4 });
    assert.notEqual(l1.eventKey, l2.eventKey);
  });

  it("falls back to a fingerprint that admits it is ambiguous", () => {
    const tx = "0x" + "b".repeat(64);
    const a = eventIdentity({ ...base, txHash: tx, amountToken: 12345.6, usd: 3871.2 });
    const b = eventIdentity({ ...base, txHash: tx.toUpperCase().replace("0X", "0x"), amountToken: 12345.6000001, usd: 3871.2, sourceEventAt: base.sourceEventAt + 900 });
    assert.equal(a.basis, "fingerprint");
    assert.equal(a.ambiguous, true);
    assert.equal(a.eventKey, b.eventKey, "re-serialised copies inside the provider's 5 s quantum collapse");
    const c = eventIdentity({ ...base, txHash: tx, amountToken: 999, usd: 3871.2 });
    assert.notEqual(a.eventKey, c.eventKey);
  });

  it("dedupes stream, replay and REST copies, keeping what each knew", () => {
    const mk = (over: Partial<TraderEvent>): TraderEvent => ({
      eventKey: "ev:x", identityBasis: "provider-event-id", identityAmbiguous: false, source: "stream", kind: "buy",
      trader: { userId: "u1", handle: "a", displayName: null, verified: null }, token: null, tokenLabel: { symbol: null, name: null },
      tradeId: "t1", swapId: null, transferId: null, txHash: null, fillUsd: null, fillUsdBasis: null, positionValueUsd: 4000,
      positionRealizedPnlUsdCumulative: null, sourceEventAt: 1, execAt: null, observedAt: 100, verification: "provider-reported",
      text: null, replay: false, ...over,
    });
    const out = dedupeEvents([
      mk({ replay: true, observedAt: 50 }),
      mk({ source: "rest-recovery", fillUsd: 3871, fillUsdBasis: "onchain-exact", txHash: "0x" + "c".repeat(64), verification: "provider-verified" }),
      mk({ eventKey: "ev:y" }),
    ]);
    assert.equal(out.events.length, 2);
    assert.equal(out.duplicates, 1);
    const merged = out.events[0]!;
    assert.equal(merged.replay, false);
    assert.equal(merged.fillUsd, 3871);
    assert.equal(merged.verification, "provider-verified");
    assert.equal(merged.observedAt, 50);
  });
});
