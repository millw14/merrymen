import test from "node:test";
import assert from "node:assert/strict";
import { address, getBase58Decoder } from "@solana/kit";
import { SOLANA_USDG_MINT } from "../../packages/core/src/ids";
import { SOLANA_WRAPPED_SOL_MINT } from "../../packages/core/src/solana-live";
import { PYTH_PUSH_ORACLE_PROGRAM, PYTH_RECEIVER_PROGRAM, PYTH_SOL_USD_ACCOUNT, PYTH_SOL_USD_FEED_ID, PYTH_SPONSORED_SHARD,
  SOLANA_PYTH_DEFAULT_GENERATION, SOLANA_PYTH_FEEDS, SOLANA_REFERENCE_ALERT_REPEAT_MS, SOLANA_REFERENCE_MAX_AGE_MS, createSolanaReferenceAlerts, derivePythPriceFeedAccount,
  parsePythSolUsd, readSolanaReferencePrice, requireSolanaPythGeneration, SOLANA_MARK_DUST_MAX_USDG_RAW, solanaMarkDust, solanaPythFeed, solanaPythGeneration,
  solanaReferenceBound, solanaReferenceNotional, solanaReferenceWsolValue,
  solanaReferenceToleranceBps, verifySolanaReferenceBound, SolanaReferencePriceError, type SolanaPythGeneration,
  type SolanaReferenceRefusal } from "./solana-reference-price";
import { PYTH_SOL_USD_MAINNET_SNAPSHOT, PYTH_SOL_USD_UPGRADED_MAINNET_SNAPSHOT, pythAccount, pythReference,
  pythSnapshotCall, pythSnapshotResult } from "./solana-reference-price-fixture";

const NOW = 1_790_000_000_000;
const sell = { inputMint: SOLANA_WRAPPED_SOL_MINT, outputMint: SOLANA_USDG_MINT, amountRaw: "1000000000", slippageBps: 50 };
const buy = { inputMint: SOLANA_USDG_MINT, outputMint: SOLANA_WRAPPED_SOL_MINT, amountRaw: "25000000", slippageBps: 50 };
/** For reads that are meant to be refused: their alerts are tested below, not printed here. */
const quiet = createSolanaReferenceAlerts({ alert() {}, info() {} });

test("the pinned Pyth identities are canonical public keys", () => {
  for (const value of [PYTH_RECEIVER_PROGRAM, PYTH_PUSH_ORACLE_PROGRAM, PYTH_SOL_USD_ACCOUNT]) assert.equal(address(value), value);
});

// Pyth's upgraded (2026-08-26) price feed program, written out apart from SOLANA_PYTH_FEEDS.upgraded (which a
// test below checks against it), so the derivations here do not merely repeat the module's own constant.
const UPGRADED_PUSH_ORACLE = "pyt2F414BA6dPttK6RddPZUdHfapoBN24GL5wbrPCou";

test("the pinned account is the push oracle's sponsored shard-0 PDA for the SOL/USD feed id", async () => {
  assert.equal(PYTH_SPONSORED_SHARD, 0);
  assert.equal(await derivePythPriceFeedAccount(PYTH_SOL_USD_FEED_ID), PYTH_SOL_USD_ACCOUNT);
  assert.equal(await derivePythPriceFeedAccount(PYTH_SOL_USD_FEED_ID, PYTH_SPONSORED_SHARD, PYTH_PUSH_ORACLE_PROGRAM), PYTH_SOL_USD_ACCOUNT);
  // Fixed outputs of the PDA rule for other shards and programs. Of these, only the upgraded shard-0 read was
  // kept (PYTH_SOL_USD_UPGRADED_MAINNET_SNAPSHOT). The 2026-10-19 check reported the current shard-1 account
  // as owned by rec5EK…, and both shard-1 accounts as existing but stale (unusable); it kept no capture of
  // them. Here they are derivations only, not evidence that the accounts exist or who owns them.
  assert.equal(await derivePythPriceFeedAccount(PYTH_SOL_USD_FEED_ID, 1), "6bWEn5B8eJCRAek5acd3R7d4Sx3e7JWvt84srqqfYgt");
  assert.equal(await derivePythPriceFeedAccount(PYTH_SOL_USD_FEED_ID, 0, UPGRADED_PUSH_ORACLE), PYTH_SOL_USD_UPGRADED_MAINNET_SNAPSHOT.account);
  assert.equal(await derivePythPriceFeedAccount(PYTH_SOL_USD_FEED_ID, 1, UPGRADED_PUSH_ORACLE), "GGdMnioYUC8qFWrWXJP2n3YHAns49MJW87CeuT7sgvrf");
  for (const [feed, shard] of [[PYTH_SOL_USD_FEED_ID.toUpperCase(), 0], [`0x${PYTH_SOL_USD_FEED_ID}`, 0], [PYTH_SOL_USD_FEED_ID.slice(2), 0],
    [PYTH_SOL_USD_FEED_ID, -1], [PYTH_SOL_USD_FEED_ID, 65_536], [PYTH_SOL_USD_FEED_ID, 0.5]] as const) {
    await assert.rejects(derivePythPriceFeedAccount(feed, shard), SolanaReferencePriceError, `${feed} ${shard}`);
  }
});

test("decodes the recorded mainnet SOL/USD account read with this module's own call", async () => {
  const snap = PYTH_SOL_USD_MAINNET_SNAPSHOT, result = pythSnapshotResult(snap);
  assert.equal(snap.account, PYTH_SOL_USD_ACCOUNT);
  const calls: unknown[] = [];
  const price = await readSolanaReferencePrice(async (method, params) => { calls.push([method, params]); return result; }, snap.minContextSlot, snap.fetchedAtMs);
  assert.deepEqual(calls, [pythSnapshotCall(snap)]);
  // $105.16339767 per SOL, ±3 bps, published 1.2 s before the answer arrived.
  assert.deepEqual(price, { source: "pyth", account: PYTH_SOL_USD_ACCOUNT, feedId: PYTH_SOL_USD_FEED_ID, price: "10516339767", conf: "3289584",
    exponent: -8, publishTimeMs: 1_792_380_064_000, postedSlot: 458_681_624, slot: 458_681_624 });
  // The bytes the decoder skips agree with the push-oracle layout: the PDA is its own
  // write authority, the level is Full (one byte), and the byte left for Partial is unused.
  const data = Buffer.from((result.value.data as [string, string])[0], "base64");
  assert.equal(getBase58Decoder().decode(data.subarray(8, 40)), PYTH_SOL_USD_ACCOUNT);
  assert.equal(data[40], 1); assert.equal(data[133], 0);
  assert.equal(data.readBigInt64LE(101), 1_792_380_063n); // previous publish time
  assert.equal(data.readBigInt64LE(109), 10_498_945_660n); // EMA price, $104.99
  // What it bounds: 1 SOL sold is worth 105.163397 USDG; 25 USDG buys 0.237725297 SOL.
  const sell1 = solanaReferenceBound(sell, price, 300), buy25 = solanaReferenceBound(buy, price, 300);
  assert.deepEqual([sell1.referenceOut, sell1.minOutFloor], ["105163397", "102008495"]);
  assert.deepEqual([buy25.referenceOut, buy25.minOutFloor], ["237725297", "230593538"]);
  // The same recorded bytes go stale 120 s after publication.
  assert.doesNotThrow(() => parsePythSolUsd(result.value, result.context.slot, price.publishTimeMs + 120_000));
  assert.throws(() => parsePythSolUsd(result.value, result.context.slot, price.publishTimeMs + 120_001), SolanaReferencePriceError);
  // And a context slot before the post is refused.
  assert.throws(() => parsePythSolUsd(result.value, 458_681_623, snap.fetchedAtMs), SolanaReferencePriceError);
});

test("the recorded upgraded-generation account read shares the layout but is refused while the current generation is selected", () => {
  const snap = PYTH_SOL_USD_UPGRADED_MAINNET_SNAPSHOT, result = pythSnapshotResult(snap);
  assert.notEqual(snap.account, SOLANA_PYTH_FEEDS.current.account);
  assert.equal(result.value.owner, "rec2HHDDnjLfj4kE7VyEtFA1HPGQLK33259532cRyHp");
  assert.throws(() => parsePythSolUsd(result.value, result.context.slot, snap.fetchedAtMs, "current"), SolanaReferencePriceError);
  // Relabelled to the current owner, the same decoder reads it, and it agrees with the current feed to 0.01 bp.
  const decoded = parsePythSolUsd({ ...result.value, owner: SOLANA_PYTH_FEEDS.current.receiverProgram }, result.context.slot, snap.fetchedAtMs, "current");
  assert.deepEqual([decoded.price, decoded.exponent, decoded.publishTimeMs, decoded.postedSlot], ["10516352961", -8, 1_792_380_063_000, 458_681_625]);
});

// Pyth's 2026-08-26 Core upgrade, written out apart from SOLANA_PYTH_FEEDS.upgraded. Offline, the account is
// checked as the price feed program's shard-0 PDA and the receiver as the owner recorded in
// PYTH_SOL_USD_UPGRADED_MAINNET_SNAPSHOT; no read of the programs themselves was kept (see the module comment).
// The pin follows that derivation: the 2026-10-19 pass reported that Pyth's published table still listed
// 7UVim… as the upgraded SOL/USD address.
const UPGRADED = { receiverProgram: "rec2HHDDnjLfj4kE7VyEtFA1HPGQLK33259532cRyHp", priceFeedProgram: "pyt2F414BA6dPttK6RddPZUdHfapoBN24GL5wbrPCou",
  account: "7AviUf9nL62mcxNbQGKm4nKDQnPjswo6c5MX4D57HmyE" };

test("both Pyth generations are pinned, frozen and distinct, and each account is its own price feed program's shard-0 PDA", async () => {
  assert.deepEqual(Object.keys(SOLANA_PYTH_FEEDS).sort(), ["current", "upgraded"]);
  assert.deepEqual(SOLANA_PYTH_FEEDS.current, { generation: "current", receiverProgram: "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ",
    priceFeedProgram: "pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT", account: "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE" });
  assert.deepEqual(SOLANA_PYTH_FEEDS.upgraded, { generation: "upgraded", ...UPGRADED });
  assert.equal(SOLANA_PYTH_FEEDS.upgraded.account, PYTH_SOL_USD_UPGRADED_MAINNET_SNAPSHOT.account);
  // Configuration picks a generation; it can never edit one.
  assert.ok(Object.isFrozen(SOLANA_PYTH_FEEDS) && Object.isFrozen(SOLANA_PYTH_FEEDS.current) && Object.isFrozen(SOLANA_PYTH_FEEDS.upgraded));
  assert.throws(() => { (SOLANA_PYTH_FEEDS.current as { account: string }).account = UPGRADED.account; }, TypeError);
  // The unqualified constants are the default generation's.
  assert.deepEqual([PYTH_RECEIVER_PROGRAM, PYTH_PUSH_ORACLE_PROGRAM, PYTH_SOL_USD_ACCOUNT],
    [SOLANA_PYTH_FEEDS[SOLANA_PYTH_DEFAULT_GENERATION].receiverProgram, SOLANA_PYTH_FEEDS[SOLANA_PYTH_DEFAULT_GENERATION].priceFeedProgram,
      SOLANA_PYTH_FEEDS[SOLANA_PYTH_DEFAULT_GENERATION].account]);
  for (const generation of ["current", "upgraded"] as const) {
    const feed = solanaPythFeed(generation);
    assert.equal(feed, SOLANA_PYTH_FEEDS[generation]);
    for (const value of [feed.receiverProgram, feed.priceFeedProgram, feed.account]) assert.equal(address(value), value);
    assert.equal(await derivePythPriceFeedAccount(PYTH_SOL_USD_FEED_ID, PYTH_SPONSORED_SHARD, feed.priceFeedProgram), feed.account, generation);
    // Nor is it the other generation's program's PDA.
    const other = SOLANA_PYTH_FEEDS[generation === "current" ? "upgraded" : "current"];
    assert.notEqual(await derivePythPriceFeedAccount(PYTH_SOL_USD_FEED_ID, PYTH_SPONSORED_SHARD, other.priceFeedProgram), feed.account, generation);
  }
  const all = Object.values(SOLANA_PYTH_FEEDS).flatMap(f => [f.receiverProgram, f.priceFeedProgram, f.account]);
  assert.equal(new Set(all).size, 6);
  for (const bad of ["Current", "UPGRADED", "", "both", "toString", "__proto__"]) {
    assert.throws(() => solanaPythFeed(bad as SolanaPythGeneration), SolanaReferencePriceError, bad);
  }
});

test("the generation setting defaults to the default generation and accepts only current or upgraded", () => {
  assert.equal(SOLANA_PYTH_DEFAULT_GENERATION, "current");
  assert.equal(solanaPythGeneration({}), SOLANA_PYTH_DEFAULT_GENERATION);
  assert.equal(solanaPythGeneration({ MERRYMEN_SOLANA_PYTH_GENERATION: "" }), SOLANA_PYTH_DEFAULT_GENERATION);
  assert.equal(solanaPythGeneration({ MERRYMEN_SOLANA_PYTH_GENERATION: "current" }), "current");
  assert.equal(solanaPythGeneration({ MERRYMEN_SOLANA_PYTH_GENERATION: "upgraded" }), "upgraded");
  for (const value of ["Upgraded", "UPGRADED", " upgraded", "upgraded ", "new", "both", "1", "pyt2F414BA6dPttK6RddPZUdHfapoBN24GL5wbrPCou", "toString"]) {
    assert.throws(() => solanaPythGeneration({ MERRYMEN_SOLANA_PYTH_GENERATION: value }), SolanaReferencePriceError, value);
  }
});

test("with the upgraded generation selected, the recorded upgraded account answer is read and bounded and the current one is refused", async () => {
  const snap = PYTH_SOL_USD_UPGRADED_MAINNET_SNAPSHOT, result = pythSnapshotResult(snap);
  const calls: unknown[] = [];
  const price = await readSolanaReferencePrice(async (method, params) => { calls.push([method, params]); return result; }, snap.minContextSlot, snap.fetchedAtMs,
    { generation: "upgraded" });
  // The same call shape as the current account's, to the upgraded account.
  assert.deepEqual(calls, [pythSnapshotCall(snap)]);
  assert.equal(snap.request.params[0], UPGRADED.account);
  // $105.16352961 per SOL, ±3 bps; it agrees with the current snapshot to 0.01 bp.
  assert.deepEqual(price, { source: "pyth", account: UPGRADED.account, feedId: PYTH_SOL_USD_FEED_ID, price: "10516352961", conf: "3228192",
    exponent: -8, publishTimeMs: 1_792_380_063_000, postedSlot: 458_681_625, slot: 458_681_625 });
  const data = Buffer.from((result.value.data as [string, string])[0], "base64");
  assert.equal(getBase58Decoder().decode(data.subarray(8, 40)), UPGRADED.account); // the PDA is its own write authority
  // A bound read from it verifies under "upgraded" only.
  const bound = solanaReferenceBound(sell, price, 300);
  assert.deepEqual([bound.referenceOut, bound.minOutFloor], ["105163529", "102008623"]);
  assert.deepEqual(verifySolanaReferenceBound(bound, sell, snap.fetchedAtMs, "upgraded"), bound);
  assert.throws(() => verifySolanaReferenceBound(bound, sell, snap.fetchedAtMs, "current"), SolanaReferencePriceError);
  // And a current-generation bound does not verify under "upgraded".
  const current = pythSnapshotResult(PYTH_SOL_USD_MAINNET_SNAPSHOT);
  const currentBound = solanaReferenceBound(sell, parsePythSolUsd(current.value, current.context.slot, snap.fetchedAtMs, "current"), 300);
  assert.throws(() => verifySolanaReferenceBound(currentBound, sell, snap.fetchedAtMs, "upgraded"), SolanaReferencePriceError);
  assert.throws(() => verifySolanaReferenceBound({ ...currentBound, reference: { ...currentBound.reference, account: UPGRADED.account } }, sell,
    snap.fetchedAtMs, "current"), SolanaReferencePriceError);
  // The current account's recorded bytes are refused under "upgraded", even when served for the upgraded address,
  // and so are the upgraded bytes relabelled to the current receiver.
  assert.throws(() => parsePythSolUsd(current.value, current.context.slot, snap.fetchedAtMs, "upgraded"), SolanaReferencePriceError);
  await assert.rejects(readSolanaReferencePrice(async () => current, snap.minContextSlot, snap.fetchedAtMs, { generation: "upgraded", alerts: quiet }),
    SolanaReferencePriceError);
  assert.throws(() => parsePythSolUsd({ ...result.value, owner: SOLANA_PYTH_FEEDS.current.receiverProgram }, result.context.slot, snap.fetchedAtMs, "upgraded"),
    SolanaReferencePriceError);
  // Freshness and slot checks are the generation-independent ones.
  assert.throws(() => parsePythSolUsd(result.value, result.context.slot, price.publishTimeMs + 120_001, "upgraded"), SolanaReferencePriceError);
  assert.throws(() => parsePythSolUsd(result.value, 458_681_624, snap.fetchedAtMs, "upgraded"), SolanaReferencePriceError);
});

test("without an explicit generation, reads and checks use the default generation, whatever this process's MERRYMEN_SOLANA_PYTH_GENERATION says", async t => {
  const saved = Object.hasOwn(process.env, "MERRYMEN_SOLANA_PYTH_GENERATION") ? process.env.MERRYMEN_SOLANA_PYTH_GENERATION : undefined;
  t.after(() => { if (saved === undefined) delete process.env.MERRYMEN_SOLANA_PYTH_GENERATION; else process.env.MERRYMEN_SOLANA_PYTH_GENERATION = saved; });
  const upgraded = pythSnapshotResult(PYTH_SOL_USD_UPGRADED_MAINNET_SNAPSHOT), current = pythSnapshotResult(PYTH_SOL_USD_MAINNET_SNAPSHOT);
  const at = PYTH_SOL_USD_UPGRADED_MAINNET_SNAPSHOT.fetchedAtMs, min = PYTH_SOL_USD_UPGRADED_MAINNET_SNAPSHOT.minContextSlot;
  const served = (by: Record<string, unknown>) => { const asked: string[] = [];
    return { asked, read: async (_method: string, params: readonly unknown[] = []) => { asked.push(params[0] as string); return by[params[0] as string] ?? { context: { slot: min + 2 }, value: null }; } }; };
  const both = { [SOLANA_PYTH_FEEDS.current.account]: current, [UPGRADED.account]: upgraded };
  const fallback = SOLANA_PYTH_FEEDS[SOLANA_PYTH_DEFAULT_GENERATION];
  assert.equal(fallback.account, PYTH_SOL_USD_MAINNET_SNAPSHOT.account);
  const currentBound = solanaReferenceBound(sell, parsePythSolUsd(current.value, current.context.slot, at, "current"), 300);
  const upgradedBound = solanaReferenceBound(sell, parsePythSolUsd(upgraded.value, upgraded.context.slot, at, "upgraded"), 300);
  // Unset, either generation, or a value that names none (as an operator's shell might export it): a caller
  // that passes no generation never consults the process's env, so none of them changes what it reads or accepts.
  for (const value of [undefined, "current", "upgraded", "Upgraded", "both"]) {
    if (value === undefined) delete process.env.MERRYMEN_SOLANA_PYTH_GENERATION; else process.env.MERRYMEN_SOLANA_PYTH_GENERATION = value;
    const rpc = served(both), rec = recorder(), name = String(value);
    const price = await readSolanaReferencePrice(rpc.read, min, at, { alerts: createSolanaReferenceAlerts(rec.sink) });
    assert.deepEqual([price.account, price.price, rpc.asked], [fallback.account, "10516339767", [fallback.account]], name);
    assert.deepEqual(rec.lines.slice(), [], name);
    assert.equal(parsePythSolUsd(current.value, current.context.slot, at).account, fallback.account, name);
    assert.throws(() => parsePythSolUsd(upgraded.value, upgraded.context.slot, at), SolanaReferencePriceError, name);
    assert.deepEqual(verifySolanaReferenceBound(currentBound, sell, at), currentBound, name);
    // A bound from the other generation is still refused, never translated.
    assert.throws(() => verifySolanaReferenceBound(upgradedBound, sell, at), SolanaReferencePriceError, name);
  }
  // The setting counts only where an env is handed over: the app runtime's, through requireSolanaPythGeneration.
  process.env.MERRYMEN_SOLANA_PYTH_GENERATION = "current";
  assert.equal(requireSolanaPythGeneration({ MERRYMEN_SOLANA_PYTH_GENERATION: "upgraded" }, at, quiet), "upgraded");
  const rpc = served(both);
  assert.equal((await readSolanaReferencePrice(rpc.read, min, at, { generation: "upgraded" })).account, UPGRADED.account);
  assert.deepEqual(verifySolanaReferenceBound(upgradedBound, sell, at, "upgraded"), upgradedBound);
});

test("reads a fresh, fully verified SOL/USD update at or after the trade's slot", async () => {
  const calls: unknown[] = [];
  const price = await readSolanaReferencePrice(async (method, params) => {
    calls.push([method, params]); return { context: { slot: 1001 }, value: pythAccount({ publishTimeMs: NOW - 10_000 }) };
  }, 1000, NOW);
  assert.deepEqual(calls, [["getAccountInfo", [PYTH_SOL_USD_ACCOUNT, { encoding: "base64", commitment: "finalized", minContextSlot: 1000 }]]]);
  assert.equal(price.price, "50000000000"); assert.equal(price.exponent, -8); assert.equal(price.slot, 1001);
  await assert.rejects(readSolanaReferencePrice(async () => ({ context: { slot: 999 }, value: pythAccount({ publishTimeMs: NOW }) }), 1000, NOW, { alerts: quiet }),
    SolanaReferencePriceError);
});

test("refuses stale, future, uncertain, partial, foreign and malformed price accounts", () => {
  const good = { publishTimeMs: NOW - 1_000 };
  assert.doesNotThrow(() => parsePythSolUsd(pythAccount(good), 1000, NOW));
  for (const bad of [
    { ...good, publishTimeMs: NOW - 121_000 }, // stale
    { ...good, publishTimeMs: NOW + 6_000 }, // future-dated
    { ...good, conf: 500_000_001n }, // confidence wider than 1% of $500
    { ...good, level: 0 }, // Partial guardian verification
    { ...good, feedId: "11".repeat(32) }, // another feed
    { ...good, owner: "11111111111111111111111111111111" }, // not the Pyth receiver
    { ...good, price: 0n }, { ...good, price: -1n }, { ...good, exponent: 2 }, { ...good, exponent: -13 },
    { ...good, postedSlot: 1001n }, { ...good, postedSlot: 0n }, { ...good, length: 133 },
  ]) assert.throws(() => parsePythSolUsd(pythAccount(bad), 1000, NOW), SolanaReferencePriceError, JSON.stringify(bad, (_k, v) => typeof v === "bigint" ? v.toString() : v));
  const tampered = pythAccount(good); tampered.data[0] = Buffer.from("x".repeat(134)).toString("base64");
  assert.throws(() => parsePythSolUsd(tampered, 1000, NOW), SolanaReferencePriceError);
  assert.throws(() => parsePythSolUsd(null, 1000, NOW), SolanaReferencePriceError);
});

test("refuses a receiver account of another type and an executable account, each otherwise a valid SOL/USD update", () => {
  const good = { publishTimeMs: NOW - 1_000 };
  // Each case differs from an accepted account in that one field only: the
  // level byte is Full, the feed id, price, times and length are all valid,
  // so only the discriminator or the executable guard can refuse it.
  assert.doesNotThrow(() => parsePythSolUsd(pythAccount({ ...good, accountType: "PriceUpdateV2", executable: false }), 1000, NOW));
  for (const accountType of ["EncodedVaa", "TwapUpdate", "Config", "PriceUpdateV1", "priceUpdateV2"]) {
    const other = pythAccount({ ...good, accountType });
    assert.equal(Buffer.from(other.data[0] as string, "base64")[40], 1, accountType);
    assert.throws(() => parsePythSolUsd(other, 1000, NOW), SolanaReferencePriceError, accountType);
  }
  for (const executable of [true, undefined, "false", 0, null]) {
    assert.throws(() => parsePythSolUsd(pythAccount({ ...good, executable }), 1000, NOW), SolanaReferencePriceError, String(executable));
  }
  const missing: Record<string, unknown> = pythAccount(good); delete missing.executable;
  assert.throws(() => parsePythSolUsd(missing, 1000, NOW), SolanaReferencePriceError);
  // The recorded mainnet bytes are refused the same way once marked executable.
  const recorded = pythSnapshotResult(PYTH_SOL_USD_MAINNET_SNAPSHOT);
  assert.doesNotThrow(() => parsePythSolUsd(recorded.value, recorded.context.slot, PYTH_SOL_USD_MAINNET_SNAPSHOT.fetchedAtMs));
  assert.throws(() => parsePythSolUsd({ ...recorded.value, executable: true }, recorded.context.slot, PYTH_SOL_USD_MAINNET_SNAPSHOT.fetchedAtMs), SolanaReferencePriceError);
});

test("values both directions at the reference and floors guaranteed output by the tolerance", () => {
  const reference = pythReference(NOW); // $500 per SOL
  const s = solanaReferenceBound(sell, reference, 300);
  assert.equal(s.referenceOut, "500000000"); // 1 SOL is 500 USDG
  assert.equal(s.minOutFloor, "485000000");
  assert.equal(s.valueUsdg, "500000000");
  const b = solanaReferenceBound(buy, reference, 300);
  assert.equal(b.referenceOut, "50000000"); // 25 USDG is 0.05 SOL
  assert.equal(b.minOutFloor, "48500000");
  assert.equal(b.valueUsdg, "25000000");
  // A sell is charged at least what it is worth, whatever it was quoted at.
  assert.equal(solanaReferenceNotional(sell, "1", s), 500_000_000n);
  assert.equal(solanaReferenceNotional(sell, "510000000", s), 510_000_000n);
  assert.equal(solanaReferenceNotional(buy, "1", b), 25_000_000n);
  // The tolerance has to leave room for the trade's own slippage, and stays bounded.
  for (const tolerance of [50, 49, 1001]) assert.throws(() => solanaReferenceBound(sell, reference, tolerance), SolanaReferencePriceError);
  assert.throws(() => solanaReferenceBound({ ...sell, amountRaw: "1" }, reference, 300), SolanaReferencePriceError); // too small to value
  assert.throws(() => solanaReferenceBound({ ...sell, outputMint: SOLANA_WRAPPED_SOL_MINT }, reference, 300), SolanaReferencePriceError);
});

test("a zero-output mark is dust only for SOL worth under one cent at the reference, by the bound's own arithmetic", () => {
  assert.equal(SOLANA_MARK_DUST_MAX_USDG_RAW, 10_000n);
  // $150.00000000: 66,666 lamports are worth 9,999 micro-USDG, 66,667 are worth 10,000.
  const at150 = pythReference(NOW, 15_000_000_000n);
  assert.equal(solanaReferenceWsolValue(66_666n, at150), 9_999n);
  assert.deepEqual([0n, 1_000n, 66_666n].map(amount => solanaMarkDust(amount, at150)), [true, true, true]);
  assert.deepEqual([66_667n, 1_000_000_000n].map(amount => solanaMarkDust(amount, at150)), [false, false]);
  // The same valuation solanaReferenceBound charges a sell at.
  assert.equal(solanaReferenceWsolValue(1_000_000_000n, at150).toString(), solanaReferenceBound(sell, at150, 300).valueUsdg);
  // Another exponent scales the same way.
  assert.equal(solanaReferenceWsolValue(1_000_000_000n, { ...at150, price: "15000", exponent: -2 }), 150_000_000n);
  // A reference that cannot value anything refuses, never answers "dust".
  for (const bad of [{ ...at150, price: "0" }, { ...at150, price: "-1" }, { ...at150, price: "1.5" }, { ...at150, exponent: 1 }, { ...at150, exponent: -13 }, { ...at150, exponent: 0.5 }]) {
    assert.throws(() => solanaMarkDust(1n, bad), (error: unknown) => error instanceof SolanaReferencePriceError && error.reason === "bound", JSON.stringify(bad));
  }
  assert.throws(() => solanaMarkDust(-1n, at150), SolanaReferencePriceError);
});

test("a stored bound must recompute exactly from its own reference and stay fresh", () => {
  const bound = solanaReferenceBound(sell, pythReference(NOW), 300);
  assert.deepEqual(verifySolanaReferenceBound(bound, sell, NOW + 1_000), bound);
  for (const forged of [{ ...bound, minOutFloor: "1" }, { ...bound, valueUsdg: "1" }, { ...bound, referenceOut: "1" }, { ...bound, toleranceBps: 1000 },
    { ...bound, reference: { ...bound.reference, price: "1" } }, { ...bound, reference: { ...bound.reference, account: PYTH_RECEIVER_PROGRAM } },
    { ...bound, reference: { ...bound.reference, postedSlot: bound.reference.slot + 1 } }]) {
    assert.throws(() => verifySolanaReferenceBound(forged, sell, NOW + 1_000), SolanaReferencePriceError);
  }
  assert.throws(() => verifySolanaReferenceBound(bound, { ...sell, amountRaw: "2000000000" }, NOW), SolanaReferencePriceError);
  assert.throws(() => verifySolanaReferenceBound(bound, sell, NOW + 121_000), SolanaReferencePriceError);
});

test("a stored bound is checked against the configured tolerance, never only the one it carries", () => {
  // Built at 10%, consistently: it recomputes from its own fields, so only the configured tolerance can refuse it.
  const wide = solanaReferenceBound(sell, pythReference(NOW), 1000);
  assert.deepEqual(verifySolanaReferenceBound(wide, sell, NOW + 1_000), wide);
  assert.throws(() => verifySolanaReferenceBound(wide, sell, NOW + 1_000, undefined, 300),
    (error: unknown) => error instanceof SolanaReferencePriceError && error.reason === "evidence");
  assert.deepEqual(verifySolanaReferenceBound(wide, sell, NOW + 1_000, undefined, 1000), wide);
  const configured = solanaReferenceBound(sell, pythReference(NOW), 300);
  assert.deepEqual(verifySolanaReferenceBound(configured, sell, NOW + 1_000, undefined, 300), configured);
});

test("the tolerance setting defaults to 3% and refuses out-of-range or malformed values", () => {
  assert.equal(solanaReferenceToleranceBps({}), 300);
  assert.equal(solanaReferenceToleranceBps({ MERRYMEN_SOLANA_REFERENCE_TOLERANCE_BPS: "500" }), 500);
  for (const value of ["49", "1001", "3e2", "-300", "300.5", " 300"]) {
    assert.throws(() => solanaReferenceToleranceBps({ MERRYMEN_SOLANA_REFERENCE_TOLERANCE_BPS: value }), SolanaReferencePriceError, value);
  }
});

// The operator alert: a price older than 120 s stops every live trade, so a refused read
// has to be said where an operator can alert on it.
function recorder() {
  const lines: Array<[kind: "alert" | "info", line: string]> = [];
  return { lines, sink: { alert: (line: string) => { lines.push(["alert", line]); }, info: (line: string) => { lines.push(["info", line]); } } };
}
const served = (value: unknown, slot = 1001) => async () => ({ context: { slot }, value });
/** Every refusal but `config`: the age limit alone, which spans a different number of Pyth posts in each generation. */
const TAIL = " — no live Solana trade is admitted until a fresh, fully verified SOL/USD price is read (max age 120 s)";
/** A setting that names no generation is not a Pyth outage: the line says what to fix, and never echoes the value. */
const CONFIG_TAIL = " — MERRYMEN_SOLANA_PYTH_GENERATION must be current or upgraded (unset is current); no live Solana trade is admitted until the setting is fixed";
const CURRENT = SOLANA_PYTH_FEEDS.current.account;
async function refusal(promise: Promise<unknown>, reason: SolanaReferenceRefusal): Promise<SolanaReferencePriceError> {
  let caught: unknown;
  await assert.rejects(promise, error => { caught = error; return error instanceof SolanaReferencePriceError && error.reason === reason; }, reason);
  return caught as SolanaReferencePriceError;
}

test("a stale reference read is one structured [alert], repeated at most once a minute while it lasts, and cleared by the next good read", async () => {
  const rec = recorder(), alerts = createSolanaReferenceAlerts(rec.sink), options = { generation: "current" as const, alerts };
  const said = () => rec.lines.length; // a call, so one count assertion does not narrow the next
  const stale = (at: number) => readSolanaReferencePrice(served(pythAccount({ publishTimeMs: NOW - 180_000 })), 1000, at, options);
  await readSolanaReferencePrice(served(pythAccount({ publishTimeMs: NOW - 1_000 })), 1000, NOW, options);
  assert.deepEqual(rec.lines.slice(), [], "a good read with nothing refused before says nothing");
  const error = await refusal(stale(NOW), "stale");
  assert.deepEqual(error.detail, { ageMs: 180_000, maxAgeMs: 120_000, contextSlot: 1001 });
  assert.deepEqual(rec.lines, [["alert", `[alert] solana-reference-price refused: reason=stale generation=current account=${CURRENT} ageMs=180000 ` +
    `maxAgeMs=120000 contextSlot=1001 failingForMs=0 refused=1 suppressed=0${TAIL}`]]);
  // Every trade in the next minute is still refused, but counted rather than said.
  for (const at of [NOW + 1, NOW + 10_000, NOW + SOLANA_REFERENCE_ALERT_REPEAT_MS - 1]) await refusal(stale(at), "stale");
  assert.equal(said(), 1);
  await refusal(stale(NOW + SOLANA_REFERENCE_ALERT_REPEAT_MS), "stale");
  assert.deepEqual(rec.lines.at(-1), ["alert", `[alert] solana-reference-price refused: reason=stale generation=current account=${CURRENT} ageMs=240000 ` +
    `maxAgeMs=120000 contextSlot=1001 failingForMs=60000 refused=5 suppressed=3${TAIL}`]);
  // A new reason is said at once: Pyth closing the account looks like this.
  await refusal(readSolanaReferencePrice(served(null), 1000, NOW + 61_000, options), "missing");
  assert.deepEqual(rec.lines.at(-1), ["alert", `[alert] solana-reference-price refused: reason=missing generation=current account=${CURRENT} ` +
    `failingForMs=61000 refused=6 suppressed=0${TAIL}`]);
  // The next good read says so once, and the count starts again.
  const price = await readSolanaReferencePrice(served(pythAccount({ publishTimeMs: NOW + 60_000 })), 1000, NOW + 62_000, options);
  assert.equal(price.price, "50000000000");
  assert.deepEqual(rec.lines.at(-1), ["info", `[solana-reference-price] read again: generation=current account=${CURRENT} after refused=6 failingForMs=62000`]);
  await readSolanaReferencePrice(served(pythAccount({ publishTimeMs: NOW + 60_000 })), 1000, NOW + 62_500, options);
  assert.equal(said(), 4);
  await refusal(stale(NOW + 63_000), "stale");
  assert.deepEqual(rec.lines.at(-1), ["alert", `[alert] solana-reference-price refused: reason=stale generation=current account=${CURRENT} ageMs=243000 ` +
    `maxAgeMs=120000 contextSlot=1001 failingForMs=0 refused=1 suppressed=0${TAIL}`]);
  // A clock that stepped back is said at once, with no duration rather than a negative one.
  await refusal(stale(NOW), "stale");
  assert.deepEqual(rec.lines.at(-1), ["alert", `[alert] solana-reference-price refused: reason=stale generation=current account=${CURRENT} ageMs=180000 ` +
    `maxAgeMs=120000 contextSlot=1001 failingForMs=unknown refused=2 suppressed=0${TAIL}`]);
  assert.deepEqual(rec.lines.map(([kind]) => kind), ["alert", "alert", "alert", "info", "alert", "alert"]);
});

test("every kind of refused read is said with its reason, the generation and the account, and never echoes what the RPC served", async () => {
  const said = async (reason: SolanaReferenceRefusal, read: () => Promise<unknown>, min = 1000, generation: SolanaPythGeneration = "current") => {
    const rec = recorder();
    await refusal(readSolanaReferencePrice(read as never, min, NOW, { generation, alerts: createSolanaReferenceAlerts(rec.sink) }), reason);
    assert.equal(rec.lines.length, 1, reason); assert.equal(rec.lines[0]![0], "alert", reason);
    return rec.lines[0]![1];
  };
  const good = { publishTimeMs: NOW - 1_000 };
  const lineFor = (reason: string, fields: string, generation = "current") =>
    `[alert] solana-reference-price refused: reason=${reason} generation=${generation} account=${SOLANA_PYTH_FEEDS[generation as SolanaPythGeneration].account} ` +
    `${fields}failingForMs=0 refused=1 suppressed=0${TAIL}`;
  assert.equal(await said("foreign", served(pythAccount({ ...good, owner: "11111111111111111111111111111111" }))), lineFor("foreign", ""));
  assert.equal(await said("foreign", served(pythAccount({ ...good, executable: true }))), lineFor("foreign", ""));
  assert.equal(await said("layout", served(pythAccount({ ...good, accountType: "TwapUpdate" }))), lineFor("layout", ""));
  assert.equal(await said("unverified", served(pythAccount({ ...good, level: 0 }))), lineFor("unverified", ""));
  assert.equal(await said("feed", served(pythAccount({ ...good, feedId: "22".repeat(32) }))), lineFor("feed", ""));
  assert.equal(await said("confidence", served(pythAccount({ ...good, conf: 500_000_001n }))), lineFor("confidence", ""));
  assert.equal(await said("price", served(pythAccount({ ...good, price: -1n }))), lineFor("price", ""));
  assert.equal(await said("future", served(pythAccount({ publishTimeMs: NOW + 6_000 }))), lineFor("future", "ageMs=-6000 contextSlot=1001 "));
  assert.equal(await said("posted-slot", served(pythAccount({ ...good, postedSlot: 1002n }))), lineFor("posted-slot", "contextSlot=1001 "));
  assert.equal(await said("rpc-slot", served(pythAccount(good), 999)), lineFor("rpc-slot", "contextSlot=999 minContextSlot=1000 "));
  assert.equal(await said("response", async () => ({ value: null })), lineFor("response", ""));
  // The upgraded generation names its own account.
  assert.equal(await said("stale", served({ ...pythAccount({ publishTimeMs: NOW - 121_000 }), owner: SOLANA_PYTH_FEEDS.upgraded.receiverProgram }), 1000, "upgraded"),
    lineFor("stale", "ageMs=121000 maxAgeMs=120000 contextSlot=1001 ", "upgraded"));
  // A generation that names none reads nothing, and is said without echoing it.
  const rec = recorder(); let reads = 0;
  await refusal(readSolanaReferencePrice(async () => { reads++; return {}; }, 1000, NOW,
    { generation: "upgraded\n[alert] forged" as SolanaPythGeneration, alerts: createSolanaReferenceAlerts(rec.sink) }), "config");
  assert.equal(reads, 0);
  assert.deepEqual(rec.lines, [["alert", `[alert] solana-reference-price refused: reason=config generation=invalid failingForMs=0 refused=1 suppressed=0${CONFIG_TAIL}`]]);
  const forged = recorder();
  await refusal(readSolanaReferencePrice(async () => ({}), 1000, NOW, { generation: "evil\n" as SolanaPythGeneration, alerts: createSolanaReferenceAlerts(forged.sink) }), "config");
  assert.deepEqual(forged.lines, rec.lines);
});

test("a stale refusal states the 120 s limit alone in either generation, never a count of missed Pyth posts", async () => {
  // The current account posted every 52-53 s and the upgraded one every 10-15 s, so "two missed
  // heartbeats" would be wrong for one of them: an operator is told the limit, not a guess at the silence.
  for (const generation of ["current", "upgraded"] as const) {
    const rec = recorder();
    await refusal(readSolanaReferencePrice(served(pythAccount({ publishTimeMs: NOW - 121_000, owner: SOLANA_PYTH_FEEDS[generation].receiverProgram })), 1000, NOW,
      { generation, alerts: createSolanaReferenceAlerts(rec.sink) }), "stale");
    assert.equal(rec.lines.length, 1, generation);
    const [, line] = rec.lines[0]!, remedy = line.split(" — ")[1]!;
    assert.equal(remedy, `no live Solana trade is admitted until a fresh, fully verified SOL/USD price is read (max age ${SOLANA_REFERENCE_MAX_AGE_MS / 1000} s)`, generation);
    assert.doesNotMatch(line, /heartbeat|missed/i, generation);
  }
});

test("the alert tracker names only pinned generations and finite numbers, whoever calls it", () => {
  const rec = recorder(), alerts = createSolanaReferenceAlerts(rec.sink);
  alerts.refused({ error: new SolanaReferencePriceError("stale", { ageMs: Number.NaN, maxAgeMs: Number.POSITIVE_INFINITY, contextSlot: 7 }),
    generation: "upgraded\n[alert] forged", nowMs: NOW });
  assert.deepEqual(rec.lines, [["alert", `[alert] solana-reference-price refused: reason=stale generation=invalid contextSlot=7 failingForMs=0 refused=1 suppressed=0${TAIL}`]]);
});

test("an RPC transport error is not a refusal: it is rethrown untouched and not said, so the caller can fail over", async () => {
  const rec = recorder(), alerts = createSolanaReferenceAlerts(rec.sink), transport = new Error("network");
  await assert.rejects(readSolanaReferencePrice(async () => { throw transport; }, 1000, NOW, { generation: "current", alerts }), error => error === transport);
  assert.deepEqual(rec.lines.slice(), []);
  // Nor does it count toward, or clear, a refusal.
  await refusal(readSolanaReferencePrice(served(null), 1000, NOW, { generation: "current", alerts }), "missing");
  await assert.rejects(readSolanaReferencePrice(async () => { throw transport; }, 1000, NOW + 1, { generation: "current", alerts }), error => error === transport);
  await readSolanaReferencePrice(served(pythAccount({ publishTimeMs: NOW })), 1000, NOW + 2, { generation: "current", alerts });
  assert.deepEqual(rec.lines.map(([kind, line]) => [kind, line.split(" — ")[0]]), [
    ["alert", `[alert] solana-reference-price refused: reason=missing generation=current account=${CURRENT} failingForMs=0 refused=1 suppressed=0`],
    ["info", `[solana-reference-price] read again: generation=current account=${CURRENT} after refused=1 failingForMs=2`]]);
});

test("a log sink or alert tracker that throws never changes what a read returns or refuses", async () => {
  const broken = createSolanaReferenceAlerts({ alert: () => { throw new Error("log down"); }, info: () => { throw new Error("log down"); } });
  const throwing = { refused: () => { throw new Error("tracker down"); }, read: () => { throw new Error("tracker down"); } };
  for (const alerts of [broken, throwing]) {
    await refusal(readSolanaReferencePrice(served(pythAccount({ publishTimeMs: NOW - 121_000 })), 1000, NOW, { generation: "current", alerts }), "stale");
    const price = await readSolanaReferencePrice(served(pythAccount({ publishTimeMs: NOW })), 1000, NOW, { generation: "current", alerts });
    assert.equal(price.price, "50000000000");
  }
});

test("without an alerts option, a refused read is said on this process's stderr as the [alert] line", async t => {
  const errors = t.mock.method(console, "error", () => {}), infos = t.mock.method(console, "log", () => {});
  const options = { generation: "current" as const };
  // A good read first clears anything an earlier test left refused in this process.
  await readSolanaReferencePrice(served(pythAccount({ publishTimeMs: NOW })), 1000, NOW, options);
  const before = errors.mock.callCount();
  await refusal(readSolanaReferencePrice(served(pythAccount({ publishTimeMs: NOW - 125_000 })), 1000, NOW, options), "stale");
  assert.equal(errors.mock.callCount(), before + 1);
  assert.deepEqual(errors.mock.calls.at(-1)!.arguments, [`[alert] solana-reference-price refused: reason=stale generation=current account=${CURRENT} ` +
    `ageMs=125000 maxAgeMs=120000 contextSlot=1001 failingForMs=0 refused=1 suppressed=0${TAIL}`]);
  await readSolanaReferencePrice(served(pythAccount({ publishTimeMs: NOW })), 1000, NOW + 1_000, options);
  assert.deepEqual(infos.mock.calls.at(-1)!.arguments, [`[solana-reference-price] read again: generation=current account=${CURRENT} after refused=1 failingForMs=1000`]);
});

test("requireSolanaPythGeneration reads only the env it is given, and says a setting that names no generation as one [alert] before refusing", async t => {
  const saved = Object.hasOwn(process.env, "MERRYMEN_SOLANA_PYTH_GENERATION") ? process.env.MERRYMEN_SOLANA_PYTH_GENERATION : undefined;
  t.after(() => { if (saved === undefined) delete process.env.MERRYMEN_SOLANA_PYTH_GENERATION; else process.env.MERRYMEN_SOLANA_PYTH_GENERATION = saved; });
  process.env.MERRYMEN_SOLANA_PYTH_GENERATION = "both"; // never consulted
  const rec = recorder(), alerts = createSolanaReferenceAlerts(rec.sink);
  assert.equal(requireSolanaPythGeneration({}, NOW, alerts), SOLANA_PYTH_DEFAULT_GENERATION);
  assert.equal(requireSolanaPythGeneration({ MERRYMEN_SOLANA_PYTH_GENERATION: "" }, NOW, alerts), SOLANA_PYTH_DEFAULT_GENERATION);
  assert.equal(requireSolanaPythGeneration({ MERRYMEN_SOLANA_PYTH_GENERATION: "current" }, NOW, alerts), "current");
  assert.equal(requireSolanaPythGeneration({ MERRYMEN_SOLANA_PYTH_GENERATION: "upgraded" }, NOW, alerts), "upgraded");
  assert.deepEqual(rec.lines.slice(), []);
  assert.throws(() => requireSolanaPythGeneration({ MERRYMEN_SOLANA_PYTH_GENERATION: "upgraded\n[alert] forged" }, NOW, alerts),
    (error: unknown) => error instanceof SolanaReferencePriceError && error.reason === "config");
  assert.deepEqual(rec.lines, [["alert", `[alert] solana-reference-price refused: reason=config generation=invalid failingForMs=0 refused=1 suppressed=0${CONFIG_TAIL}`]]);
  // A log or tracker that throws never turns the refusal into an answer.
  const broken = createSolanaReferenceAlerts({ alert: () => { throw new Error("log down"); }, info: () => {} });
  const throwing = { refused: () => { throw new Error("tracker down"); }, read: () => {} };
  for (const sink of [broken, throwing]) {
    assert.throws(() => requireSolanaPythGeneration({ MERRYMEN_SOLANA_PYTH_GENERATION: "Upgraded" }, NOW, sink),
      (error: unknown) => error instanceof SolanaReferencePriceError && error.reason === "config");
  }
});
