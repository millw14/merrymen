import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  chainFromProvider,
  chainFromUserText,
  executionAvailabilityOf,
  filterCheckIdentity,
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

describe("network ids observed live but not documented (2026-10-04)", () => {
  it("a bare observed id names its network; a slug alone still never becomes a number", () => {
    assert.deepEqual(chainFromProvider(56, undefined), { namespace: "eip155", networkId: 56, slug: "bsc" });
    assert.deepEqual(chainFromProvider(1, undefined), { namespace: "eip155", networkId: 1, slug: "eth" });
    assert.deepEqual(chainFromProvider(8453, undefined), { namespace: "eip155", networkId: 8453, slug: "base" });
    assert.deepEqual(chainFromProvider(1, "ethereum"), { namespace: "eip155", networkId: 1, slug: "eth" });
    assert.deepEqual(chainFromProvider(56, "bnb"), { namespace: "eip155", networkId: 56, slug: "bsc" });
    assert.deepEqual(chainFromProvider(undefined, "bsc"), { namespace: "eip155", networkId: null, slug: "bsc" });
  });

  it("an observed id that disagrees with the row's slug is trusted for neither", () => {
    assert.deepEqual(chainFromProvider(56, "base"), { namespace: "unknown", networkId: null, slug: "base" });
    assert.equal(tokenIdentity(chainFromProvider(56, "base"), EVM)?.chain.networkId, null);
    assert.equal(chainFromProvider(56, "robinhood").namespace, "unknown");
  });

  it("an EVM address on a numbered but unknown network keeps the number, so two networks stay two tokens", () => {
    const odd = tokenIdentity(chainFromProvider(777_777, undefined), EVM)!;
    assert.equal(odd.key, `eip155:777777:${EVM.toLowerCase()}`);
    const bnb = tokenIdentity(chainFromProvider(56, undefined), EVM)!;
    const eth = tokenIdentity(chainFromProvider(1, undefined), EVM)!;
    assert.notEqual(bnb.key, eth.key);
    assert.equal(isRobinhoodToken(bnb), false);
    assert.equal(executionAvailabilityOf(bnb, { routeVerified: true, permitted: true }), "unsupported-chain");
    assert.equal(executionAvailabilityOf(odd, { routeVerified: true, permitted: true }), "unsupported-chain");
    // A mint on a numbered unknown network is still not placed on that number.
    assert.equal(tokenIdentity(chainFromProvider(777_777, undefined), MINT)?.key, `solana:?:${MINT}`);
  });

  it("keys round-trip with the observed slug", () => {
    const bnb = tokenIdentity(chainFromProvider(56, undefined), EVM)!;
    assert.deepEqual(tokenFromKey(bnb.key), bnb);
  });

  it("filters on named EVM networks are checked by the id their rows carry", () => {
    const bsc = chainFromUserText("bsc")!;
    assert.equal(bsc.networkId, null, "what a person types is not given a number");
    assert.equal(filterCheckIdentity(bsc).networkId, 56);
    assert.equal(filterCheckIdentity(chainFromUserText("ethereum")!).networkId, 1);
    assert.equal(filterCheckIdentity(chainFromUserText("monad")!).networkId, null, "no observation, no number");
    const bnbRow = tokenIdentity(chainFromProvider(56, "bsc"), EVM);
    const ethRow = tokenIdentity(chainFromProvider(1, "ethereum"), EVM);
    assert.equal(verifyChainFilter(filterCheckIdentity(bsc), [bnbRow, bnbRow]).honoured, true);
    assert.equal(verifyChainFilter(filterCheckIdentity(bsc), [bnbRow, ethRow]).honoured, false);
  });

  it("a filter given as a number we cannot place is checked by number alone", () => {
    const requested = chainFromProvider(777_777, undefined);
    assert.equal(requested.namespace, "unknown");
    const row = tokenIdentity(requested, EVM);
    assert.equal(verifyChainFilter(requested, [row]).honoured, true);
    assert.equal(verifyChainFilter(requested, [tokenIdentity(robinhoodChain(), EVM)]).honoured, false);
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

  // The normal caller order is stored copy first, REST copy second; the first
  // (live) copy is kept, and every field it lacks must come from the second.
  it("fills missing fields from a richer copy that arrives second", () => {
    const mk = (over: Partial<TraderEvent>): TraderEvent => ({
      eventKey: "ev:x", identityBasis: "provider-event-id", identityAmbiguous: false, source: "stream", kind: "buy",
      trader: { userId: "u1", handle: "a", displayName: null, verified: null }, token: null, tokenLabel: { symbol: null, name: null },
      tradeId: "t1", swapId: null, transferId: null, txHash: null, fillUsd: null, fillUsdBasis: null, positionValueUsd: 4000,
      positionRealizedPnlUsdCumulative: null, sourceEventAt: 1, execAt: null, observedAt: 100, verification: "provider-reported",
      text: null, replay: false, ...over,
    });
    const tx = "0x" + "d".repeat(64);
    const out = dedupeEvents([
      mk({ observedAt: 40 }),
      mk({ source: "rest-recovery", fillUsd: 123, fillUsdBasis: "onchain-exact", txHash: tx, swapId: "s1", execAt: 7, verification: "provider-verified", observedAt: 90 }),
    ]);
    assert.equal(out.events.length, 1);
    const merged = out.events[0]!;
    assert.equal(merged.source, "stream", "the first live copy is the one kept");
    assert.equal(merged.fillUsd, 123);
    assert.equal(merged.fillUsdBasis, "onchain-exact");
    assert.equal(merged.txHash, tx);
    assert.equal(merged.swapId, "s1");
    assert.equal(merged.execAt, 7);
    assert.equal(merged.verification, "provider-verified");
    assert.equal(merged.observedAt, 40);

    // And a live copy replacing a replayed one still fills what only the replay knew.
    const swapped = dedupeEvents([
      mk({ replay: true, fillUsd: 55, fillUsdBasis: "onchain-exact", txHash: tx, verification: "provider-verified" }),
      mk({ source: "rest-recovery" }),
    ]).events[0]!;
    assert.equal(swapped.source, "rest-recovery", "the live copy replaces the replayed one");
    assert.equal(swapped.replay, false);
    assert.equal(swapped.fillUsd, 55);
    assert.equal(swapped.txHash, tx);
    assert.equal(swapped.verification, "provider-verified");
  });
});

describe("verification is a claim about a fill", () => {
  it("merging copies of a non-trade event never upgrades it to provider-verified", () => {
    const mk = (over: Partial<TraderEvent>): TraderEvent => ({
      eventKey: "ev:t", identityBasis: "provider-event-id", identityAmbiguous: false, source: "stream", kind: "transfer-in",
      trader: { userId: "u1", handle: "a", displayName: null, verified: null }, token: null, tokenLabel: { symbol: null, name: null },
      tradeId: null, swapId: null, transferId: "tr1", txHash: null, fillUsd: null, fillUsdBasis: null, positionValueUsd: null,
      positionRealizedPnlUsdCumulative: null, sourceEventAt: 1, execAt: null, observedAt: 100, verification: "provider-reported",
      text: null, replay: false, ...over,
    });
    const out = dedupeEvents([mk({}), mk({ source: "rest-recovery", verification: "provider-verified" })]);
    assert.equal(out.events[0]!.verification, "provider-reported");
    const buys = dedupeEvents([mk({ kind: "buy" }), mk({ kind: "buy", source: "rest-recovery", verification: "provider-verified" })]);
    assert.equal(buys.events[0]!.verification, "provider-verified", "a buy keeps the stronger basis");
  });
});
