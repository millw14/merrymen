/**
 * The pure rules of flow inference (flow-inference.ts) — every branch of what a
 * look decides and what a settlement explains, on hand-built numbers. The same
 * functions run against a real ledger in flow-inference.integration.test.ts.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  attributeSettlements,
  expectedCashUsdg,
  heldBreakerObservationUsdg,
  lookAtCash,
  opsHoldInference,
  settlementDelta,
  STRANDED_RESOLVE_WINDOW_SEC,
  wroteSince,
  type Settlement,
} from "./flow-inference";

const U = 1_000_000n;
const s = (createdAt: number, usdgDelta6: bigint | null, userOpHash = `0x${createdAt}`): Settlement => ({ userOpHash, createdAt, usdgDelta6 });
const base = { baselineUsdg: 100n * U, since: 1_000, unattributed: false, settled: [] as Settlement[], cashUsdg: 100n * U, opsInFlight: false, writesInInterval: false };

describe("opsHoldInference — which ops hold a look", () => {
  it("an op in the current epoch inside the resolver's window holds; past it, or from another epoch, does not", () => {
    const nowSec = 2_000_000_000;
    const at = { epoch: 3, nowSec };
    assert.equal(opsHoldInference([], at), false);
    assert.equal(opsHoldInference([{ epoch: 3, createdAt: nowSec - STRANDED_RESOLVE_WINDOW_SEC }], at), true);
    assert.equal(opsHoldInference([{ epoch: 3, createdAt: nowSec - STRANDED_RESOLVE_WINDOW_SEC - 1 }], at), false);
    assert.equal(opsHoldInference([{ epoch: 2, createdAt: nowSec }], at), false);
  });
});

describe("settlementDelta — what ONE resolved op explains", () => {
  it("a REVERTED op queues nothing: it moved no USDG, so it explains no cash", () => {
    assert.deepEqual(settlementDelta({ success: false, receiptUsdgDelta6: 0n, capitalBooked: null }), { queue: false });
    assert.deepEqual(settlementDelta({ success: false, receiptUsdgDelta6: null, capitalBooked: false }), { queue: false });
  });
  it("a landed trade explains exactly its receipt's movement — or nothing known (null) when the receipt was unread", () => {
    assert.deepEqual(settlementDelta({ success: true, receiptUsdgDelta6: -10n * U, capitalBooked: null }), { queue: true, usdgDelta6: -10n * U });
    assert.deepEqual(settlementDelta({ success: true, receiptUsdgDelta6: null, capitalBooked: null }), { queue: true, usdgDelta6: null });
  });
  it("a capital op explains its movement only if its booking STOOD; a refused booking explains nothing, so inference books it once", () => {
    assert.deepEqual(settlementDelta({ success: true, receiptUsdgDelta6: -10n * U, capitalBooked: true }), { queue: true, usdgDelta6: -10n * U });
    assert.deepEqual(settlementDelta({ success: true, receiptUsdgDelta6: -10n * U, capitalBooked: false }), { queue: true, usdgDelta6: 0n });
  });
});

describe("attributeSettlements — which settlements a baseline may take", () => {
  it("sums the movements of ops created at or after the baseline's `since`, and names the unread ones", () => {
    const r = attributeSettlements([s(1_000, -10n * U), s(1_500, 3n * U), s(1_600, null)], 1_000);
    assert.equal(r.shiftUsdg6, -7n * U);
    assert.deepEqual(r.unread.map((u) => u.createdAt), [1_600]);
  });
  it("an op created BEFORE `since` is already in the baseline's cash: never folded again, never doubted", () => {
    const r = attributeSettlements([s(999, -10n * U), s(998, null)], 1_000);
    assert.equal(r.shiftUsdg6, 0n);
    assert.deepEqual(r.unread, []);
  });
  it("no baseline yet (`since` null) takes nothing", () => {
    assert.deepEqual(attributeSettlements([s(5, -1n), s(6, null)], null), { shiftUsdg6: 0n, unread: [] });
  });
});

describe("lookAtCash — one look, one rule", () => {
  it("THE HOLD IS ASKED FIRST: a ledger write beside an op in flight cannot close the interval over it", () => {
    const l = lookAtCash({ ...base, cashUsdg: 50n * U, writesInInterval: true, opsInFlight: true });
    assert.deepEqual(l.verdict, { action: "hold" });
  });
  it("A HELD LOOK STILL FOLDS its settlements into the baseline — a settled op is explained for good", () => {
    const l = lookAtCash({ ...base, opsInFlight: true, settled: [s(1_200, -10n * U)] });
    assert.deepEqual(l.verdict, { action: "hold" });
    assert.equal(l.baselineUsdg, 90n * U);
  });
  it("the residual is what no settlement explains: a deposit made while a purchase was stranded", () => {
    const l = lookAtCash({ ...base, cashUsdg: 590n * U, settled: [s(1_200, -10n * U)] });
    assert.deepEqual(l.verdict, { action: "infer", deltaUsdg: 500n * U });
  });
  it("a withdrawal beside a settled swap: only the withdrawal is inferred", () => {
    const l = lookAtCash({ ...base, cashUsdg: 70n * U, settled: [s(1_200, -10n * U)] });
    assert.deepEqual(l.verdict, { action: "infer", deltaUsdg: -20n * U });
  });
  it("a ledger write in the interval explains it (the pre-existing rule for trade intervals)", () => {
    assert.deepEqual(lookAtCash({ ...base, cashUsdg: 50n * U, writesInInterval: true }).verdict, { action: "explained", why: "ledger-write" });
  });
  it("AN UNREAD SETTLEMENT closes the interval uninferred, and says so — it is never guessed at zero", () => {
    const l = lookAtCash({ ...base, cashUsdg: 590n * U, settled: [s(1_200, null)] });
    assert.deepEqual(l.verdict, { action: "explained", why: "unread-settlement" });
    assert.equal(l.unread.length, 1);
    assert.equal(l.unattributed, true);
    // One seen by an earlier, held look keeps the interval unattributed.
    const later = lookAtCash({ ...base, cashUsdg: 590n * U, unattributed: true });
    assert.deepEqual(later.verdict, { action: "explained", why: "unread-settlement" });
    assert.deepEqual(later.unread, [], "and is not reported twice");
  });
  it("nothing in flight, nothing written, nothing settled: the change is capital", () => {
    assert.deepEqual(lookAtCash({ ...base, cashUsdg: 80n * U }).verdict, { action: "infer", deltaUsdg: -20n * U });
    assert.deepEqual(lookAtCash(base).verdict, { action: "infer", deltaUsdg: 0n });
  });
});

describe("wroteSince — the first look's durable write rule", () => {
  it("a landed row this process's resolver settled is NOT a write (its settlement explains it); any other landed row is", () => {
    const mine = new Set(["0xa"]);
    assert.equal(wroteSince([], mine), false);
    assert.equal(wroteSince(["0xa"], mine), false, "settled here: explained by its own movement");
    assert.equal(wroteSince(["0xa", "0xb"], mine), true, "a fill, or a settlement, by the earlier process");
    assert.equal(wroteSince([null], mine), true, "a row with no op hash still counts");
  });
});

describe("heldBreakerObservationUsdg — what a held look may still show the breaker", () => {
  const obs = (equity: bigint, cash: bigint, expected: bigint | null) =>
    heldBreakerObservationUsdg({ equityUsdg: equity * U, cashUsdg: cash * U, expectedCashUsdg: expected === null ? null : expected * U });

  it("equity as it is when cash is at or below the expected baseline: a gain in positions is observed", () => {
    assert.equal(obs(150n, 50n, 100n), 150n * U, "bought stock, and it ran");
    assert.equal(obs(100n, 100n, 100n), 100n * U);
  });

  it("CASH ABOVE THE BASELINE IS TAKEN BACK OUT — so an unbooked deposit never reaches a peak", () => {
    assert.equal(obs(600n, 600n, 100n), 100n * U, "a 500 deposit in the hold");
    assert.equal(obs(140n, 140n, 100n), 100n * U, "a sell's proceeds too: the observation errs low, never high");
  });

  it("NO BASELINE: every dollar of cash is treated as possibly unbooked, and it never goes below zero", () => {
    assert.equal(obs(150n, 50n, null), 100n * U);
    assert.equal(obs(10n, 20n, 0n), 0n);
  });

  it("the expected cash folds only what the look itself would: settlements at or after `since`, unread ones not guessed", () => {
    const queued = [s(900, -5n * U), s(1_000, -10n * U), s(1_100, null)];
    assert.equal(expectedCashUsdg({ cashUsdg: 100n * U, since: 1_000 }, queued), 90n * U);
    assert.equal(expectedCashUsdg(null, queued), null);
  });
});
