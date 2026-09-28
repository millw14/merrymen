/**
 * THE THROTTLE, RUN — not read.
 *
 * Every rule a low-energy agent lives by is a pure function in energy.ts, so
 * each one is executed here with the numbers that matter: the UTC day edge, the
 * house baselines an owner cannot inflate, the pacing that keeps a low day from
 * being spent before breakfast, and the three-way balance read in which an
 * unread wallet is never a wallet holding nothing.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CASH, ENERGY, ENERGY_FULL_RAW, STOCK_TOKENS, parseEnergyStatus, type StoredGrant } from "../../packages/core/src/index";
import {
  ENERGY_OFF,
  TRENCHER_REVIEW_SEC,
  claimCap,
  countsAsEntry,
  energyBuyOf,
  energyDayRowOf,
  energyLevel,
  energyModeOf,
  energyPlan,
  energyShortfallRaw,
  energyStatus,
  enforcedCap,
  entryAllowance,
  heldCurveLegs,
  mergeEnergyDay,
  nextUtcMidnight,
  pacedCap,
  planEnergySeed,
  reviewAllowance,
  sellsHeldLeg,
  shouldTellOwner,
  shouldTellOwnerSpent,
  usdgCentsUp,
  utcDay,
  type EnergyDayRow,
} from "./energy";
import { limitsFromGrant } from "./limits";
import { isExitIntent, type TradeIntent } from "./policy";
import { TRENCH_REVIEW_INTERVAL_MS } from "./trencher-brain";

const T = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const tok = (n: number) => BigInt(n) * 10n ** 18n;

describe("the day is a UTC calendar day", () => {
  it("23:59:59 is still today, 00:00:00 is tomorrow", () => {
    assert.equal(utcDay(T("2026-09-27T23:59:59Z")), "2026-09-27");
    assert.equal(utcDay(T("2026-09-28T00:00:00Z")), "2026-09-28");
  });
  it("and the reset is the next midnight, strictly after now", () => {
    assert.equal(nextUtcMidnight(T("2026-09-27T23:59:59Z")), T("2026-09-28T00:00:00Z"));
    assert.equal(nextUtcMidnight(T("2026-09-28T00:00:00Z")), T("2026-09-29T00:00:00Z"));
    assert.equal(nextUtcMidnight(T("2026-09-27T12:34:56Z")), T("2026-09-28T00:00:00Z"));
  });
});

describe("MERRYMEN_ENERGY_GATE defaults to doing nothing", () => {
  it("unset, '0' and garbage are off", () => {
    assert.equal(energyModeOf(undefined), "off");
    assert.equal(energyModeOf(""), "off");
    assert.equal(energyModeOf("0"), "off");
    assert.equal(energyModeOf("yes please"), "off");
    assert.equal(energyModeOf("true"), "off", "only the documented spellings switch it on");
  });
  it("'observe' observes, '1' and 'ENFORCE' enforce", () => {
    assert.equal(energyModeOf(" observe "), "observe");
    assert.equal(energyModeOf("1"), "enforce");
    assert.equal(energyModeOf("ENFORCE"), "enforce");
  });
});

describe("the level: full, low, or unread — and unread is never low", () => {
  const now = T("2026-09-27T12:00:00Z");
  it("every read answered and it clears 100,000 → full, and that reading is remembered", () => {
    assert.deepEqual(energyLevel({ holder: tok(60_000), account: tok(40_000) }, null, now), { level: "full", decided: true });
  });
  it("every read answered and it falls short → low, remembered as not full", () => {
    assert.deepEqual(energyLevel({ holder: tok(60_000), account: tok(39_999) }, null, now), { level: "low", decided: false });
  });
  it("ONE READ FAILED BUT THE OTHER CLEARS IT ALONE → full: what was read is a lower bound", () => {
    assert.deepEqual(energyLevel({ holder: null, account: tok(100_000) }, null, now), { level: "full", decided: true });
  });
  it("one failed, the rest short, a fresh last-good full → full, and NOT re-stamped", () => {
    const r = energyLevel({ holder: null, account: tok(10) }, { full: true, at: now - 3_600 }, now);
    assert.deepEqual(r, { level: "full", decided: null });
  });
  it("a fresh last-good that was low stays low", () => {
    assert.deepEqual(energyLevel({ holder: null, account: undefined }, { full: false, at: now - 60 }, now), { level: "low", decided: null });
  });
  it("A LAST-GOOD OLDER THAN A DAY IS NOT EVIDENCE → unread", () => {
    const r = energyLevel({ holder: null, account: null }, { full: true, at: now - ENERGY.lastGoodMaxAgeSec - 1 }, now);
    assert.equal(r.level, "unread");
  });
  it("no last-good at all → unread, never low", () => {
    assert.deepEqual(energyLevel({ holder: null, account: undefined }, null, now), { level: "unread", decided: null });
  });
  it("no wallet and no counted account is a KNOWABLE zero → low", () => {
    assert.deepEqual(energyLevel({ holder: undefined, account: undefined }, null, now), { level: "low", decided: false });
  });
  it("AN UNREAD RESULT NEVER REPORTS TOKENS AS 0", () => {
    const parts = { holder: null, account: null };
    const plan = energyPlan({ mode: "enforce", level: energyLevel(parts, null, now).level, counters: { reviews: 0, entries: 0, toldAt: null }, reviewsAllowed: 5, entriesAllowed: 2, nowSec: now });
    const s = energyStatus({ plan, parts, hasReviewer: true, buy: "ready", estimateUsdg: null, nowSec: now });
    assert.equal(s.level, "unread");
    assert.equal(s.agentTokens, null);
    assert.equal(s.holderTokens, null);
    const back = parseEnergyStatus(JSON.stringify(s));
    assert.ok(back, "the report round-trips through the core parser");
    assert.equal(back.agentTokens, null);
    assert.equal(back.holderTokens, null);
  });
});

describe("the review allowance comes from HOUSE intervals", () => {
  it("Brain at 300 s → 29", () => {
    assert.equal(reviewAllowance({ brain: true, trencher: false, strategistIntervalMin: null, brainIntervalSec: 300 }), 29);
  });
  it("the fast trencher → 288, and the trencher is not also counted as Brain", () => {
    assert.equal(reviewAllowance({ brain: true, trencher: true, strategistIntervalMin: null, brainIntervalSec: 300 }), 288);
    assert.equal(reviewAllowance({ brain: false, trencher: true, strategistIntervalMin: null, brainIntervalSec: 300 }), 288);
  });
  it("the trencher's interval here is the trencher's own constant", () => {
    assert.equal(TRENCHER_REVIEW_SEC, TRENCH_REVIEW_INTERVAL_MS / 1000);
  });
  it("the strategist at 30 min → 5", () => {
    assert.equal(reviewAllowance({ brain: false, trencher: false, strategistIntervalMin: 30, brainIntervalSec: 300 }), 5);
  });
  it("AN OWNER WHO SETS ONE MINUTE STILL GETS 5 — the throttled party cannot raise their own allowance", () => {
    assert.equal(reviewAllowance({ brain: false, trencher: false, strategistIntervalMin: 1, brainIntervalSec: 300 }), 5);
  });
  it("but may make it smaller: 120 min → 2", () => {
    assert.equal(reviewAllowance({ brain: false, trencher: false, strategistIntervalMin: 120, brainIntervalSec: 300 }), 2);
  });
  it("nothing running → 0; Brain and the strategist together → 34", () => {
    assert.equal(reviewAllowance({ brain: false, trencher: false, strategistIntervalMin: null, brainIntervalSec: 300 }), 0);
    assert.equal(reviewAllowance({ brain: true, trencher: false, strategistIntervalMin: 30, brainIntervalSec: 300 }), 34);
  });
});

describe("the entry allowance is capped by the house baseline", () => {
  it("24 → 2; a grant signed for 10,000 is still 2; 5 → 1; unreadable → 2", () => {
    assert.equal(entryAllowance(24), 2);
    assert.equal(entryAllowance(10_000), 2);
    assert.equal(entryAllowance(5), 1);
    assert.equal(entryAllowance(Number.NaN), 2);
    assert.equal(entryAllowance(0), 1, "never zero — a low day is still a day");
  });
});

describe("reviews are paced across the day", () => {
  it("one at midnight, fifteen of 29 by noon, all 29 by 23:59:59", () => {
    assert.equal(pacedCap(29, T("2026-09-27T00:00:00Z")), 1);
    assert.equal(pacedCap(29, T("2026-09-27T12:00:00Z")), 15);
    assert.equal(pacedCap(29, T("2026-09-27T23:59:59Z")), 29);
  });
  it("never above the allowance, and zero when there is none", () => {
    for (let h = 0; h < 24; h++) assert.ok(pacedCap(5, T("2026-09-27T00:00:00Z") + h * 3600) <= 5);
    assert.equal(pacedCap(0, T("2026-09-27T12:00:00Z")), 0);
  });
});

describe("the plan", () => {
  const now = T("2026-09-27T12:00:00Z");
  it("OFF, or at full energy, limits nothing and counts nothing", () => {
    for (const p of [
      energyPlan({ mode: "off", level: "low", counters: { reviews: 99, entries: 99, toldAt: null }, reviewsAllowed: 5, entriesAllowed: 2, nowSec: now }),
      energyPlan({ mode: "enforce", level: "full", counters: { reviews: 99, entries: 99, toldAt: null }, reviewsAllowed: 5, entriesAllowed: 2, nowSec: now }),
      ENERGY_OFF,
    ]) {
      assert.equal(p.throttled, false);
      assert.equal(p.enforce, false);
      assert.equal(p.reviews.open, true);
      assert.equal(p.entries.open, true);
      assert.equal(p.entries.left, null, "not limited is null, never 0");
      assert.equal(claimCap(p, "entries", now), null, "no claim, so no write");
    }
  });
  it("ENFORCE WITH AN UNREADABLE STORE FAILS CLOSED on new work", () => {
    const p = energyPlan({ mode: "enforce", level: "low", counters: null, reviewsAllowed: 5, entriesAllowed: 2, nowSec: now });
    assert.equal(p.reviews.open, false);
    assert.equal(p.entries.open, false);
    assert.equal(p.entries.left, 0);
  });
  it("AND A CLAIM AGAINST A DAY NOBODY COULD READ CLAIMS NOTHING — the hard filter trusts the claim, not the plan", () => {
    // A rebuilt child whose history the orchestrator could not put back reads
    // the day as null while its table still takes writes; a claim against the
    // day's cap would be made on an EMPTY row — a fresh allowance.
    const p = energyPlan({ mode: "enforce", level: "low", counters: null, reviewsAllowed: 5, entriesAllowed: 2, nowSec: now });
    assert.equal(claimCap(p, "entries", now), 0);
    assert.equal(claimCap(p, "reviews", now), 0);
    const unread = energyPlan({ mode: "enforce", level: "unread", counters: null, reviewsAllowed: 5, entriesAllowed: 2, nowSec: now });
    assert.equal(claimCap(unread, "entries", now), 0, "unread is throttled too");
    // Untouched: full energy claims nothing and needs no count; observe counts and never refuses.
    const full = energyPlan({ mode: "enforce", level: "full", counters: null, reviewsAllowed: 5, entriesAllowed: 2, nowSec: now });
    assert.equal(full.entries.open, true);
    assert.equal(claimCap(full, "entries", now), null);
    const obs = energyPlan({ mode: "observe", level: "low", counters: null, reviewsAllowed: 5, entriesAllowed: 2, nowSec: now });
    assert.equal(obs.entries.open, true);
    assert.equal(claimCap(obs, "entries", now), Number.MAX_SAFE_INTEGER);
    // One readable field is claimed by its own count only.
    const readable = energyPlan({ mode: "enforce", level: "low", counters: { reviews: 0, entries: 0, toldAt: null }, reviewsAllowed: 5, entriesAllowed: 2, nowSec: now });
    assert.equal(claimCap(readable, "entries", now), 2);
  });
  it("enforce, low: open until used, and the reviews by the paced cap", () => {
    const p = energyPlan({ mode: "enforce", level: "low", counters: { reviews: 2, entries: 1, toldAt: null }, reviewsAllowed: 5, entriesAllowed: 2, nowSec: now });
    assert.equal(p.enforce, true);
    assert.equal(p.reviews.open, true, "2 < pacedCap(5, noon) = 3");
    assert.equal(p.entries.open, true);
    assert.equal(p.entries.left, 1);
    const spent = energyPlan({ mode: "enforce", level: "unread", counters: { reviews: 3, entries: 2, toldAt: 5 }, reviewsAllowed: 5, entriesAllowed: 2, nowSec: now });
    assert.equal(spent.reviews.open, false, "3 is the paced cap at noon");
    assert.equal(spent.entries.open, false);
    assert.equal(spent.told, true);
  });
  it("claimCap: observe counts without a cap; enforce uses the paced cap and the day's entries", () => {
    const obs = energyPlan({ mode: "observe", level: "low", counters: { reviews: 50, entries: 50, toldAt: null }, reviewsAllowed: 5, entriesAllowed: 2, nowSec: now });
    assert.equal(obs.throttled, true);
    assert.equal(obs.enforce, false);
    assert.equal(obs.entries.open, true, "observe withholds nothing");
    assert.equal(claimCap(obs, "entries", now), Number.MAX_SAFE_INTEGER);
    assert.equal(enforcedCap(obs, "entries", now), 2, "but can say what enforce would have done");
    const enf = energyPlan({ mode: "enforce", level: "low", counters: { reviews: 0, entries: 0, toldAt: null }, reviewsAllowed: 5, entriesAllowed: 2, nowSec: now });
    assert.equal(claimCap(enf, "reviews", now), 3);
    assert.equal(claimCap(enf, "entries", now), 2);
  });
});

describe("what counts as a new trade", () => {
  const USDG = "0x00000000000000000000000000000000000000dd" as const;
  const TSLA = "0x0000000000000000000000000000000000000001" as const;
  const limits = { cashToken: USDG };
  const ask = (i: TradeIntent) => countsAsEntry(i.kind, isExitIntent(i, limits));
  it("a buy counts", () => {
    assert.equal(ask({ kind: "swap", target: USDG, sellToken: USDG, buyToken: TSLA, sellAmountRaw: 1n, notionalUsdg: 1n }), true);
  });
  it("an exit never does", () => {
    assert.equal(ask({ kind: "swap", target: USDG, sellToken: TSLA, buyToken: USDG, sellAmountRaw: 1n, notionalUsdg: 1n }), false);
    assert.equal(ask({ kind: "vault-withdraw", target: USDG, amountUsdg: 1n }), false);
    assert.equal(ask({ kind: "transfer", target: USDG, recipient: TSLA, amountUsdg: 1n }), false);
  });
  it("NOR DOES THE IDLE-CASH SWEEP — a vault deposit is housekeeping", () => {
    assert.equal(ask({ kind: "vault-deposit", target: USDG, amountUsdg: 1n }), false);
  });
});

/**
 * A LEGACY GRANT, A CURVE QUOTED IN A STOCK TOKEN THE OWNER ADDED.
 *
 * Signed before tradeable-v2, the grant's built-ins are USDG + QQQ/NVDA/TSLA;
 * AAPL and the launch are EXTRAS. The breaker's test therefore reads the sale
 * MEME→AAPL as an entry (and must keep doing so — the breaker is not this
 * file's), and energy used to count it: a low day withheld the way out.
 */
describe("a curve sale into an extra stock token on a legacy grant", () => {
  const AAPL = STOCK_TOKENS.find((t) => t.symbol === "AAPL")!.address as `0x${string}`;
  const MEME = "0x00000000000000000000000000000000000000e1" as const;
  const MEME2 = "0x00000000000000000000000000000000000000e2" as const;
  const CURVE = "0x00000000000000000000000000000000000000c1" as const;
  const CURVE2 = "0x00000000000000000000000000000000000000c2" as const;
  const ADAPTER = "0x00000000000000000000000000000000000000ad" as const;
  const USDG_ADDR = CASH.USDG as `0x${string}`;
  const grant = {
    smartAccount: "0x00000000000000000000000000000000000000a9",
    owner: "0x00000000000000000000000000000000000000b1",
    sessionKeyAddress: "0x00000000000000000000000000000000000000c9",
    serialized: "x",
    caps: { perTradeUsdg: 10, dailyUsdg: 50, expiryDays: 14, maxDrawdownPct: 5, maxOpsPerDay: 24 },
    grantedAt: 1_700_000_000,
    expiresAt: 4_000_000_000,
    chainId: 4663,
    grantFeatures: [],
    grantTokens: [AAPL, MEME, MEME2],
  } as unknown as StoredGrant;
  const limits = limitsFromGrant(grant);
  const curve = (assetIn: `0x${string}`, assetOut: `0x${string}`, on: `0x${string}` = CURVE): TradeIntent => ({
    kind: "curve-trade",
    target: ADAPTER,
    curve: on,
    assetIn,
    assetOut,
    amountInRaw: 1n,
    minAmountOutRaw: 1n,
    notionalUsdg: 1n,
  });
  const book = (over: Partial<Parameters<typeof heldCurveLegs>[0]> = {}) =>
    heldCurveLegs({
      positions: [
        { symbol: "MEME", token: MEME, rawBalance: 10n ** 18n },
        // The book holds the quote stock too — which must not make a BUY paid
        // in it look like a sale.
        { symbol: "AAPL", token: AAPL, rawBalance: 10n ** 18n },
      ],
      curveLegs: new Map([["MEME", { curve: CURVE, quoteToken: AAPL }]]),
      classRows: [],
      classBalances: new Map(),
      ...over,
    });
  const counts = (i: TradeIntent, held = book()) => countsAsEntry(i.kind, isExitIntent(i, limits), sellsHeldLeg(i, held));

  it("the premise: AAPL is not built in on this grant, so the breaker calls the sale an entry", () => {
    assert.ok(!limits.quoteAssets?.map((a) => a.toLowerCase()).includes(AAPL.toLowerCase()));
    assert.equal(isExitIntent(curve(MEME, AAPL), limits), false, "the breaker's own test is unchanged");
    assert.equal(countsAsEntry("curve-trade", false), true, "and asked alone, energy would count it");
  });

  it("SELLING THE HELD LEG BACK INTO ITS QUOTE IS NOT A NEW TRADE", () => {
    assert.equal(counts(curve(MEME, AAPL)), false);
  });

  it("a BUY of the leg still counts — paid in USDG, or in the stock the book also holds", () => {
    assert.equal(counts(curve(USDG_ADDR, MEME)), true);
    assert.equal(counts(curve(AAPL, MEME)), true);
  });

  it("nothing held, another curve, or another quote: counted", () => {
    assert.equal(counts(curve(MEME, AAPL), book({ positions: [{ symbol: "MEME", token: MEME, rawBalance: 0n }] })), true, "sold out");
    assert.equal(counts(curve(MEME, AAPL, CURVE2)), true, "not the curve it was recorded on");
    assert.equal(counts(curve(MEME, MEME2)), true, "not its own quote");
  });

  it("A CLASS POSITION counts as held while the vault holds it, on the curve and quote its row recorded", () => {
    const classRows = [{ token: MEME2, curve: CURVE2, quoteToken: AAPL }];
    const sale = curve(MEME2, AAPL, CURVE2);
    assert.equal(counts(sale, book({ classRows, classBalances: new Map([[MEME2.toLowerCase(), 5n]]) })), false);
    assert.equal(counts(sale, book({ classRows, classBalances: new Map() })), true, "swept or sold: nothing held");
    assert.equal(counts(sale, book({ classRows: [{ token: MEME2, curve: null, quoteToken: AAPL }], classBalances: new Map([[MEME2.toLowerCase(), 5n]]) })), true, "no curve on record is not a known leg");
    assert.equal(counts(sale, book({ classRows: null })), true, "an unreadable list holds nothing");
  });
});

describe("telling the owner", () => {
  const now = T("2026-09-27T12:00:00Z");
  const plan = (mode: "observe" | "enforce", toldAt: number | null) =>
    energyPlan({ mode, level: "low", counters: { reviews: 0, entries: 2, toldAt }, reviewsAllowed: 5, entriesAllowed: 2, nowSec: now });
  it("only enforcing, only when an entry was withheld, only once", () => {
    assert.equal(shouldTellOwner(plan("enforce", null), true), true);
    assert.equal(shouldTellOwner(plan("enforce", null), false), false, "a pacing refusal is not worth a message");
    assert.equal(shouldTellOwner(plan("enforce", now - 5), true), false, "once told, not again today");
    assert.equal(shouldTellOwner(plan("observe", null), true), false, "observe tells nobody");
  });

  // The Trencher, the Brain, the strategist and the class route all stop
  // PROPOSING entries once the day is spent, so a withheld entry may never
  // come. The day becoming spent is its own moment to tell them.
  const at = (mode: "observe" | "enforce", entries: number | null, toldAt: number | null = null, level: "low" | "unread" | "full" = "low") =>
    energyPlan({
      mode,
      level,
      counters: entries === null ? null : { reviews: 0, entries, toldAt },
      reviewsAllowed: 5,
      entriesAllowed: 2,
      nowSec: now,
    });
  it("AND WHEN TODAY'S NEW TRADES ARE USED UP, withheld or not — once, and only enforcing", () => {
    assert.equal(shouldTellOwnerSpent(at("enforce", 2)), true, "the second of two is the moment");
    assert.equal(shouldTellOwnerSpent(at("enforce", 3)), true, "past the allowance still counts as used up");
    assert.equal(shouldTellOwnerSpent(at("enforce", 2, null, "unread")), true, "an unread day on the reduced allowance is spent too");
    assert.equal(shouldTellOwnerSpent(at("enforce", 1)), false, "one left is not spent");
    assert.equal(shouldTellOwnerSpent(at("enforce", 0)), false);
    assert.equal(shouldTellOwnerSpent(at("enforce", 2, now - 5)), false, "once told, not again today");
    assert.equal(shouldTellOwnerSpent(at("observe", 2)), false, "observe tells nobody");
    assert.equal(shouldTellOwnerSpent(at("enforce", 2, null, "full")), false, "full energy is never spent");
    assert.equal(shouldTellOwnerSpent(ENERGY_OFF), false);
  });
  it("AN UNREADABLE COUNTER IS NOT 'SPENT' — the plan fails closed, but the sentence would be a guess", () => {
    const unread = at("enforce", null);
    assert.equal(unread.entries.open, false, "new work is still withheld");
    assert.equal(shouldTellOwnerSpent(unread), false);
    // Nor is a withheld entry on that day: it was withheld by the fail-closed
    // plan, and the day's notice stamp is as unknown as its count.
    assert.equal(shouldTellOwner(unread, true), false);
  });
  it("and it agrees with the report's `spent`, which the desk and Telegram already show", () => {
    for (const entries of [0, 1, 2, 3]) {
      const p = at("enforce", entries);
      const s = energyStatus({ plan: p, parts: { holder: tok(1), account: tok(0) }, hasReviewer: true, buy: "ready", estimateUsdg: null, nowSec: now });
      assert.equal(shouldTellOwnerSpent(p), s.spent, `entries ${entries}`);
    }
  });
});

describe("the report", () => {
  const now = T("2026-09-27T12:00:00Z");
  it("gated only when enforcing; meters only while throttled; spent when the day's entries are used", () => {
    const enf = energyPlan({ mode: "enforce", level: "low", counters: { reviews: 1, entries: 2, toldAt: null }, reviewsAllowed: 5, entriesAllowed: 2, nowSec: now });
    const s = energyStatus({ plan: enf, parts: { holder: tok(12_345), account: tok(0) }, hasReviewer: true, buy: "ready", estimateUsdg: 37.12, nowSec: now });
    assert.equal(s.gated, true);
    assert.equal(s.spent, true);
    assert.deepEqual(s.entries, { used: 2, allowed: 2 });
    assert.deepEqual(s.reviews, { used: 1, allowed: 5 });
    assert.equal(s.holderTokens, 12_345);
    assert.equal(s.holderCounted, true);
    assert.equal(s.agentTokens, 0);
    assert.equal(s.needTokens, ENERGY.fullTokens);
    assert.equal(s.resetsAt, T("2026-09-28T00:00:00Z"));
    assert.deepEqual(parseEnergyStatus(s), s, "exactly the shape the web parses");
    const noReviewer = energyStatus({ plan: enf, parts: { holder: undefined, account: undefined }, hasReviewer: false, buy: "ready", estimateUsdg: null, nowSec: now });
    assert.equal(noReviewer.reviews, null);
    assert.equal(noReviewer.holderTokens, null, "no wallet is not a count of zero either");
    assert.equal(noReviewer.holderCounted, false, "…and it is not a failed read: no wallet counts");
  });
  it("HOLDERCOUNTED TELLS A FAILED WALLET READ FROM NO WALLET AT ALL", () => {
    const enf = energyPlan({ mode: "enforce", level: "low", counters: { reviews: 0, entries: 0, toldAt: null }, reviewsAllowed: 5, entriesAllowed: 2, nowSec: now });
    const at = (holder: bigint | null | undefined) =>
      energyStatus({ plan: enf, parts: { holder, account: tok(5_000) }, hasReviewer: true, buy: "ready", estimateUsdg: null, nowSec: now });
    assert.equal(at(tok(1)).holderCounted, true);
    assert.equal(at(null).holderCounted, true, "a wallet that counts but did not answer");
    assert.equal(at(null).holderTokens, null);
    assert.equal(at(undefined).holderCounted, false, "no wallet counts — the account is the whole figure");
    assert.equal(at(undefined).holderTokens, null);
    assert.deepEqual(parseEnergyStatus(at(undefined)), at(undefined), "and the web parses it back");
  });
  it("OFF AND OBSERVE ARE STILL REPORTED, ungated — so a later report replaces a stale 'spent'", () => {
    for (const mode of ["off", "observe"] as const) {
      const p = energyPlan({ mode, level: "low", counters: null, reviewsAllowed: 5, entriesAllowed: 2, nowSec: now });
      const s = energyStatus({ plan: p, parts: { holder: tok(1), account: undefined }, hasReviewer: true, buy: "paper", estimateUsdg: null, nowSec: now });
      assert.equal(s.gated, false);
      assert.equal(s.spent, false);
      assert.ok(parseEnergyStatus(s));
    }
  });
  it("the buy field, decided in order", () => {
    assert.equal(energyBuyOf({ chainId: 46630, live: true, hasRoute: true }), "not-mainnet");
    assert.equal(energyBuyOf({ chainId: 4663, live: false, hasRoute: true }), "paper");
    assert.equal(energyBuyOf({ chainId: 4663, live: true, hasRoute: false }), "resign");
    assert.equal(energyBuyOf({ chainId: 4663, live: true, hasRoute: true }), "ready");
  });
  it("the shortfall is known only when every present read answered", () => {
    assert.equal(energyShortfallRaw({ holder: tok(40_000), account: tok(10_000) }), ENERGY_FULL_RAW - tok(50_000));
    assert.equal(energyShortfallRaw({ holder: tok(200_000), account: undefined }), 0n);
    assert.equal(energyShortfallRaw({ holder: null, account: tok(1) }), null);
  });
  it("an estimate rounds UP to the cent", () => {
    assert.equal(usdgCentsUp(37_120_000n), 37.12);
    assert.equal(usdgCentsUp(37_120_001n), 37.13);
    assert.equal(usdgCentsUp(0n), 0);
  });
});

describe("durability: merge and seed", () => {
  const row = (over: Partial<EnergyDayRow>): EnergyDayRow => ({ day: "2026-09-27", reviews: 0, entries: 0, entriesRefunded: 0, toldAt: null, readAt: null, readFull: null, ...over });
  it("counters take the larger, the first notice stands, the newer read wins — symmetric", () => {
    const a = row({ reviews: 5, entries: 1, toldAt: 100, readAt: 50, readFull: true });
    const b = row({ reviews: 3, entries: 2, toldAt: 200, readAt: 60, readFull: false });
    for (const m of [mergeEnergyDay(a, b), mergeEnergyDay(b, a)]) {
      assert.equal(m.reviews, 5);
      assert.equal(m.entries, 2);
      assert.equal(m.readAt, 60);
      assert.equal(m.readFull, false);
    }
    assert.equal(mergeEnergyDay(a, b).toldAt, 100);
    assert.equal(mergeEnergyDay(row({}), b).toldAt, 200, "a notice sent on either side is a notice sent");
  });
  it("planEnergySeed keeps today and yesterday, drops malformed rows, merges with the child", () => {
    const plan = planEnergySeed({
      sinceDay: "2026-09-26",
      child: [row({ day: "2026-09-27", reviews: 1 })],
      shared: [
        { day: "2026-09-27", reviews: "4", entries: 2, told_at: null, read_at: 99, read_full: 1 },
        { day: "2026-09-26", reviews: 7, entries: 0, told_at: 5, read_at: null, read_full: null },
        { day: "2026-09-20", reviews: 9, entries: 9, told_at: null, read_at: null, read_full: null },
        { day: "garbage", reviews: 1, entries: 1 },
        { day: "2026-09-27", reviews: -1, entries: 0 },
      ],
    });
    assert.deepEqual(plan, [
      { day: "2026-09-26", reviews: 7, entries: 0, entriesRefunded: 0, toldAt: 5, readAt: null, readFull: null },
      { day: "2026-09-27", reviews: 4, entries: 2, entriesRefunded: 0, toldAt: null, readAt: 99, readFull: true },
    ]);
  });
  it("A REFUND IS ITS OWN RISING COUNT, so the larger of each keeps it — whichever copy is ahead", () => {
    // The child claimed two and gave one back; shared was mirrored between
    // the claim and the refund. The old decrement lost the refund here.
    const child = row({ entries: 2, entriesRefunded: 1 });
    const stale = row({ entries: 2, entriesRefunded: 0 });
    for (const m of [mergeEnergyDay(child, stale), mergeEnergyDay(stale, child)]) {
      assert.equal(m.entries - m.entriesRefunded, 1, "one used, in either order");
    }
    // A later claim on the child and an older refund elsewhere still add up.
    assert.deepEqual(
      [mergeEnergyDay(row({ entries: 3, entriesRefunded: 1 }), row({ entries: 2, entriesRefunded: 1 }))].map((m) => [m.entries, m.entriesRefunded]),
      [[3, 1]],
    );
  });
  it("a table from before the refund counter reads as none refunded; an unreadable one drops the row", () => {
    assert.equal(energyDayRowOf({ day: "2026-09-27", reviews: 0, entries: 2, told_at: null, read_at: null, read_full: null })?.entriesRefunded, 0);
    assert.equal(energyDayRowOf({ day: "2026-09-27", reviews: 0, entries: 2, entries_refunded: "1", told_at: null, read_at: null, read_full: null })?.entriesRefunded, 1);
    assert.equal(energyDayRowOf({ day: "2026-09-27", reviews: 0, entries: 2, entries_refunded: -1, told_at: null, read_at: null, read_full: null }), null);
    assert.equal(energyDayRowOf({ day: "2026-09-27", reviews: 0, entries: 2, entriesRefunded: "x", toldAt: null, readAt: null, readFull: null }), null);
  });
  it("a row with a read time reports its read; without one, read_full means nothing", () => {
    assert.equal(energyDayRowOf({ day: "2026-09-27", reviews: 0, entries: 0, told_at: null, read_at: null, read_full: 1 })?.readFull, null);
    assert.equal(energyDayRowOf({ day: "2026-09-27", reviews: 0, entries: 0, told_at: null, read_at: 7, read_full: 0 })?.readFull, false);
  });
});

describe("the seed reads both shapes of a row", () => {
  it("A PARSED ROW KEEPS ITS NOTICE AND ITS READ — the round trip that once dropped them", () => {
    const parsed: EnergyDayRow = { day: "2026-09-27", reviews: 1, entries: 2, entriesRefunded: 1, toldAt: 123, readAt: 500, readFull: true };
    assert.deepEqual(energyDayRowOf(parsed), parsed);
    assert.deepEqual(planEnergySeed({ shared: [parsed], sinceDay: "2026-09-26" }), [parsed]);
  });
});
