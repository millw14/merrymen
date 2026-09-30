/**
 * THE STAND-DOWN, against a fake venue that keeps the venue's own rules: a
 * reduce-only close can only shrink a position, position-tied stops cancel
 * themselves at zero, and closing an isolated position hands its margin back
 * to cross collateral. The fake records every call in order and every breach
 * of the contract's lines (a cancel on a market still open, a close that is
 * not the full venue-read size, a withdrawal of more than was free), so each
 * test can assert both what happened and that nothing forbidden did.
 *
 * The clock is the fake's: every call costs it time and every wait advances
 * it, so the deadline tests are exact. One test runs on the real clock with a
 * call that never returns, to prove the bound is a real one.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  custodySentence,
  notionalMicro,
  perpMarketById,
  worstPriceForTaker,
  type PerpKey,
  type PerpMarketSpec,
  type PerpSide,
} from "../../../packages/core/src/perps";
import type { PerpExitIntent } from "../policy";
import type { LighterFeedRead, PerpFeedMarket } from "./feed-reader";
import type { PerpDecimals } from "./markets";
import { PROTECT_THRESHOLDS } from "./protect";
import {
  STANDDOWN_LIMITS,
  STANDDOWN_WITHDRAWS,
  isFinalResolution,
  runStanddown,
  standdownExposure,
  standdownLines,
  standdownSlipBps,
  standdownStepLine,
  type StanddownAccount,
  type StanddownExecutor,
  type StanddownOptions,
  type StanddownPlaceContext,
  type StanddownPlaceResult,
  type StanddownReconcile,
  type StanddownResolution,
  type StanddownResult,
  type StanddownSend,
  type StanddownStep,
} from "./standdown";

const u = (usdg: number) => BigInt(Math.round(usdg * 1e6));
const T0 = 1_800_000_000_000;

const SPEC: Record<number, PerpMarketSpec> = {
  0: { marketId: 0, sizeDecimals: 4, priceDecimals: 2, minBaseAmount: 50n, minQuoteMicro: u(10), minImfBp: 200, defaultImfBp: 5_000, mmfBp: 120, closeoutBp: 80, status: "active" },
  1: { marketId: 1, sizeDecimals: 5, priceDecimals: 1, minBaseAmount: 20n, minQuoteMicro: u(10), minImfBp: 200, defaultImfBp: 5_000, mmfBp: 120, closeoutBp: 80, status: "active" },
  3: { marketId: 3, sizeDecimals: 3, priceDecimals: 3, minBaseAmount: 50n, minQuoteMicro: u(10), minImfBp: 400, defaultImfBp: 5_000, mmfBp: 240, closeoutBp: 160, status: "active" },
};
const DECIMALS: ReadonlyMap<number, PerpDecimals> = new Map(
  Object.values(SPEC).map((s) => [s.marketId, { sizeDecimals: s.sizeDecimals, priceDecimals: s.priceDecimals }]),
);
const BTC_MARK = 830_000n; // 83,000.0
const ETH_MARK = 268_100n; // 2,681.00
const SOL_MARK = 118_450n; // 118.450

// ── the fake venue ──────────────────────────────────────────────────────────

type Outcome = "fill" | "none" | "partial" | "throw" | "hang" | { submitted: ("submitted" | "unknown" | "filled" | "cancelled")[] };

interface Row {
  marketId: number;
  key: PerpKey | null;
  symbol: string;
  side: PerpSide;
  base: bigint;
  margin: bigint;
  mode: "isolated" | "cross";
  mark: bigint;
  /** position-tied (the stop, and a take-profit if any) */
  tied: number;
  /** ordinary resting orders */
  open: number;
  pending: number;
}

class FakeVenue {
  t = T0;
  callMs = 100;
  placeMs = 100;
  collateral = u(20);
  pnl = u(1);
  rows = new Map<number, Row>();
  scripts = new Map<number, Outcome[]>();
  log: string[] = [];
  violations: string[] = [];
  intents: PerpExitIntent[] = [];
  placeSignals: AbortSignal[] = [];
  /** Reads that fail before one succeeds, or "always". */
  accountFails: number | "always" = 0;
  withdrawStatus: StanddownSend["status"] = "submitted";
  pending = new Map<string, { marketId: number; base: bigint; answers: ("submitted" | "unknown" | "filled" | "cancelled")[] }>();
  seq = 0;
  realClock = false;

  now = (): number => (this.realClock ? Date.now() : this.t);
  sleep = async (ms: number): Promise<void> => {
    this.t += ms;
  };
  private tick(ms: number): void {
    if (!this.realClock) this.t += ms;
  }

  hold(r: Partial<Row> & { marketId: number }): this {
    const listed = perpMarketById(r.marketId);
    const mark = r.mark ?? (r.marketId === 1 ? BTC_MARK : r.marketId === 0 ? ETH_MARK : SOL_MARK);
    this.rows.set(r.marketId, {
      key: listed?.key ?? null,
      symbol: listed?.symbol ?? `M${r.marketId}`,
      side: "long",
      base: 0n,
      margin: 0n,
      mode: "isolated",
      tied: 0,
      open: 0,
      pending: 0,
      ...r,
      mark,
    });
    return this;
  }

  script(marketId: number, ...outcomes: Outcome[]): this {
    this.scripts.set(marketId, outcomes);
    return this;
  }

  account(): StanddownAccount | null {
    this.tick(this.callMs);
    this.log.push("read");
    if (this.accountFails === "always") throw new Error("HTTP 429: rate limited");
    if (this.accountFails > 0) {
      this.accountFails -= 1;
      throw new Error("HTTP 429: rate limited");
    }
    const positions = [...this.rows.values()].map((r) => {
      const d = DECIMALS.get(r.marketId) ?? { sizeDecimals: 4, priceDecimals: 2 };
      const held = r.base > 0n;
      return {
        marketId: r.marketId,
        symbol: r.symbol,
        key: r.key,
        side: held ? r.side : null,
        baseAmount: r.base,
        marginMode: r.mode,
        allocatedMarginMicro: held && r.mode === "isolated" ? r.margin : 0n,
        positionValueMicro: held ? notionalMicro(r.base, r.mark, d, "floor") : 0n,
        openOrderCount: r.open,
        pendingOrderCount: r.pending,
        positionTiedOrderCount: r.tied,
      };
    });
    return {
      collateralMicro: this.collateral,
      positions,
      totalOrderCount: positions.reduce((n, p) => n + p.openOrderCount, 0),
      pendingOrderCount: positions.reduce((n, p) => n + p.pendingOrderCount, 0),
      poolShareCount: 0,
      pendingUnlockCount: 0,
      spotHoldings: [],
      decimals: DECIMALS,
    };
  }

  private fill(row: Row, filled: bigint): void {
    const before = row.base;
    row.base -= filled;
    const released = row.base === 0n ? row.margin : (row.margin * filled) / before;
    row.margin -= released;
    this.collateral += released + (row.base === 0n ? this.pnl : 0n);
    // The venue's own behaviour: position-tied stops and takes cancel themselves at zero.
    if (row.base === 0n) row.tied = 0;
  }

  place(intent: PerpExitIntent, ctx: StanddownPlaceContext): Promise<StanddownPlaceResult> {
    this.tick(this.placeMs);
    this.log.push(`place ${intent.market} #${ctx.attempt}`);
    this.intents.push(intent);
    this.placeSignals.push(ctx.signal);
    const row = this.rows.get(intent.marketId);
    if (intent.kind !== "perp-order" || intent.reduceOnly !== true || intent.effect !== "close") this.violations.push("a close that is not reduce-only");
    if (row === undefined || row.base === 0n) this.violations.push(`a close on flat market ${intent.marketId}`);
    else {
      if (row.side !== intent.side) this.violations.push(`a close naming ${intent.side} on a ${row.side}`);
      if (intent.baseAmount !== row.base) this.violations.push(`a close of ${intent.baseAmount}, not the venue-read ${row.base}`);
    }
    const outcome = this.scripts.get(intent.marketId)?.shift() ?? "fill";
    const id = `row-${++this.seq}`;
    if (outcome === "hang") return new Promise(() => {});
    if (outcome === "throw") return Promise.reject(new Error("sendTx: socket hang up"));
    if (row === undefined) return Promise.resolve({ status: "rejected", orderRowId: id, filledBase: 0n });
    if (typeof outcome === "object") {
      this.pending.set(id, { marketId: intent.marketId, base: intent.baseAmount, answers: [...outcome.submitted] });
      return Promise.resolve({ status: "submitted", orderRowId: id, filledBase: 0n });
    }
    if (outcome === "none") return Promise.resolve({ status: "cancelled", orderRowId: id, filledBase: 0n, detail: "TooMuchSlippage" });
    const filled = outcome === "partial" ? row.base / 2n : row.base;
    this.fill(row, filled);
    return Promise.resolve({
      status: outcome === "partial" ? "partial" : "filled",
      orderRowId: id,
      filledBase: filled,
      ...(row.base === 0n ? { realizedMicro: this.pnl } : { realizedMicro: 0n }),
    });
  }

  resolve(rowId: string): StanddownResolution {
    this.tick(this.callMs);
    const p = this.pending.get(rowId);
    if (p === undefined) return { status: "unknown" };
    const ans = p.answers.shift() ?? "filled";
    this.log.push(`resolve ${p.marketId} ${ans}`);
    const row = this.rows.get(p.marketId);
    if (ans === "filled" && row !== undefined) {
      const filled = p.base < row.base ? p.base : row.base;
      this.fill(row, filled);
      return { status: "filled", filledBase: filled, ...(row.base === 0n ? { realizedMicro: this.pnl } : {}) };
    }
    if (ans === "cancelled") return { status: "cancelled", filledBase: 0n };
    return { status: ans === "filled" ? "filled" : ans };
  }

  cancelMarket(marketId: number): StanddownSend {
    this.tick(this.callMs);
    this.log.push(`cancel ${marketId}`);
    const row = this.rows.get(marketId);
    if (row !== undefined && row.base > 0n) this.violations.push(`cancelled market ${marketId} while its position was open`);
    if (row !== undefined) {
      row.open = 0;
      row.pending = 0;
      row.tied = 0;
    }
    return { status: "submitted" };
  }

  cancelAll(): StanddownSend {
    this.tick(this.callMs);
    this.log.push("cancel-all");
    for (const r of this.rows.values()) {
      if (r.base > 0n) this.violations.push(`an account-wide cancel while market ${r.marketId} was open`);
      r.open = 0;
      r.pending = 0;
      r.tied = 0;
    }
    return { status: "submitted" };
  }

  withdraw(amount: bigint, free: bigint): StanddownSend {
    this.tick(this.callMs);
    this.log.push(`withdraw ${amount}`);
    if (amount > this.collateral) this.violations.push(`a withdrawal of ${amount} with ${this.collateral} free`);
    if (amount > free) this.violations.push("a withdrawal above the free figure it was judged against");
    if (this.withdrawStatus !== "rejected") this.collateral -= amount;
    return { status: this.withdrawStatus };
  }
}

function executorOf(v: FakeVenue, o: { resolve?: boolean; cancelAll?: boolean } = {}): StanddownExecutor {
  const ex: StanddownExecutor = {
    account: async () => v.account(),
    place: (intent, ctx) => v.place(intent, ctx),
    cancelMarket: async (id) => v.cancelMarket(id),
    requestWithdraw: async (a, f) => v.withdraw(a, f),
  };
  if (o.resolve !== false) ex.resolve = async (id) => v.resolve(id);
  if (o.cancelAll) ex.cancelAll = async () => v.cancelAll();
  return ex;
}

function reconcileOf(v: FakeVenue, o: { fast?: boolean; fail?: boolean } = {}): StanddownReconcile {
  const rec: StanddownReconcile = {
    reconcileOnce: async () => {
      v.t += v.realClock ? 0 : v.callMs;
      v.log.push("reconcile");
      if (o.fail) throw new Error("trades read: HTTP 500");
      return { ok: true };
    },
  };
  if (o.fast !== false) {
    rec.resolveSubmitted = async () => {
      v.t += v.realClock ? 0 : v.callMs;
      v.log.push("resolve-submitted");
    };
  }
  return rec;
}

function feedOf(marks: Record<number, { mark: bigint; fresh?: boolean }>): () => LighterFeedRead {
  return () => {
    const markets = new Map<number, PerpFeedMarket>();
    const stale = new Set<number>();
    for (const [id, m] of Object.entries(marks)) {
      const marketId = Number(id);
      const listed = perpMarketById(marketId);
      const spec = SPEC[marketId];
      if (listed === null || spec === undefined) throw new Error(`test feed: no market ${marketId}`);
      const fresh = m.fresh !== false;
      if (!fresh) stale.add(marketId);
      markets.set(marketId, {
        marketId,
        key: listed.key,
        symbol: listed.symbol,
        observedAt: T0,
        priceSource: "ws",
        mark: m.mark,
        index: m.mark,
        fundingRatePpm: 0,
        lastFunding: null,
        status: "active",
        spec,
        specObservedAt: T0,
        takerFeePpm: 0,
        makerFeePpm: 0,
        bids: [],
        asks: [],
        bookObservedAt: T0,
        bookSource: "ws",
        closed4h: null,
        funding8h: null,
        fresh,
        bookFresh: fresh,
      });
    }
    return { observedAt: T0, markets, stale, staleBooks: new Set(stale) };
  };
}

function opts(v: FakeVenue, o: Partial<StanddownOptions> & { ex?: { resolve?: boolean; cancelAll?: boolean }; rec?: { fast?: boolean; fail?: boolean } } = {}): StanddownOptions {
  const { ex, rec, ...rest } = o;
  return {
    reason: "kill",
    deadlineMs: v.now() + 110_000,
    now: v.now,
    executor: executorOf(v, ex),
    reconcile: reconcileOf(v, rec),
    settings: { maxSlippageBps: 50 },
    feed: null,
    sleep: v.sleep,
    ...rest,
  };
}

const at = (log: readonly string[], prefix: string) => log.findIndex((l) => l.startsWith(prefix));
const lastAt = (log: readonly string[], prefix: string) => log.map((l, i) => (l.startsWith(prefix) ? i : -1)).reduce((a, b) => Math.max(a, b), -1);

const EXTRA = { pendingWithdrawalsMicro: 0n, depositsInTransitMicro: 0n, otherAccounts: { count: 0, valueMicro: 0n }, withdrawalDelaySec: 900 };

// ── the order ───────────────────────────────────────────────────────────────

describe("stand-down: the order of things", () => {
  it("closes every position before any cancel, cancels only markets that read flat, withdraws, then books", async () => {
    const v = new FakeVenue()
      .hold({ marketId: 1, side: "long", base: 30n, margin: u(5), tied: 1 })
      .hold({ marketId: 0, side: "short", base: 100n, margin: u(3), tied: 1, open: 1 })
      .hold({ marketId: 3, open: 2 }); // flat, with stale orders
    const steps: StanddownStep[] = [];
    const r = await runStanddown(
      opts(v, {
        onStep: (s) => {
          steps.push(s);
          throw new Error("a progress sink that throws must not stop the stand-down");
        },
      }),
    );
    assert.deepEqual(v.violations, []);
    assert.deepEqual(
      v.log.filter((l) => l !== "read"),
      ["resolve-submitted", "place ETH-PERP #1", "place BTC-PERP #1", "cancel 0", "cancel 3", `withdraw ${u(30)}`, "reconcile"],
    );
    assert.ok(lastAt(v.log, "place") < at(v.log, "cancel"));
    assert.equal(r.outcome, "done");
    assert.deepEqual(
      r.closed.map((c) => [c.market, c.side, c.baseAmount, c.filledBase, c.realizedMicro, c.attempts]),
      [
        ["ETH-PERP", "short", 100n, 100n, u(1), 1],
        ["BTC-PERP", "long", 30n, 30n, u(1), 1],
      ],
    );
    assert.deepEqual(r.residual, []);
    assert.equal(r.ordersLeft, 0);
    // 20 cross + 5 and 3 of isolated margin back + 1 P&L each.
    assert.equal(r.withdrawRequestedMicro, u(30));
    assert.equal(r.ingested, true);
    assert.deepEqual(r.failedSteps, []);
    assert.equal(r.venue?.final, true);
    assert.equal(steps[0]?.kind, "begin");
    assert.equal(steps.at(-1)?.kind, "end");
    assert.ok(steps.every((s) => typeof standdownStepLine(s) === "string"));
  });

  it("never cancels a market whose position is still open: the residual keeps its stop", async () => {
    const v = new FakeVenue()
      .hold({ marketId: 1, side: "long", base: 30n, margin: u(5), tied: 1 })
      .hold({ marketId: 0, side: "short", base: 100n, margin: u(3), tied: 1, open: 1 })
      .script(1, "none", "none", "none");
    const r = await runStanddown(opts(v, { reason: "incident", ex: { cancelAll: true } }));
    assert.deepEqual(v.violations, []);
    assert.equal(v.log.filter((l) => l.startsWith("place BTC-PERP")).length, STANDDOWN_LIMITS.maxCloseAttempts);
    assert.ok(!v.log.includes("cancel 1"), "BTC is still open: its stop must stay");
    assert.ok(!v.log.includes("cancel-all"), "an incident cancels account-wide only on a flat account");
    assert.ok(v.log.includes("cancel 0"), "ETH read flat, so its leftover order goes");
    assert.equal(v.rows.get(1)?.tied, 1, "the stop is still resting at the venue");
    assert.equal(r.outcome, "residual");
    assert.deepEqual(r.residual, [{ market: "BTC-PERP", marketId: 1, side: "long", baseAmount: 30n, stopResting: true, attempts: 3, sizeDecimals: 5 }]);
    assert.ok(r.failedSteps.some((s) => s.startsWith("BTC-PERP: still open after 3 close attempts within 150 bps of mark") && s.endsWith("its stop stays resting.")));
    assert.deepEqual(standdownLines(r).residual, ["BTC-PERP long 0.00030 (its stop is still resting)"]);
    const text = custodySentence(standdownExposure(r, EXTRA));
    assert.match(text, /Could not be closed: BTC-PERP long 0\.00030 \(its stop is still resting\)/);
    assert.match(text, /stops resting at Lighter stay in place/);
    assert.doesNotMatch(text, /stay in your smart account/);
  });

  it("an incident on an account that reads flat cancels account-wide; a kill never does", async () => {
    const mk = () =>
      new FakeVenue()
        .hold({ marketId: 1, side: "long", base: 30n, margin: u(5), tied: 1, open: 1 })
        .hold({ marketId: 3, open: 2 });
    const inc = mk();
    const ri = await runStanddown(opts(inc, { reason: "incident", ex: { cancelAll: true } }));
    assert.deepEqual(inc.violations, []);
    assert.ok(inc.log.includes("cancel-all"));
    assert.equal(at(inc.log, "cancel "), -1, "no market-scoped cancel beside the account-wide one");
    assert.ok(lastAt(inc.log, "place") < at(inc.log, "cancel-all"));
    assert.equal(ri.outcome, "done");

    const kill = mk();
    await runStanddown(opts(kill, { reason: "kill", ex: { cancelAll: true } }));
    assert.deepEqual(kill.violations, []);
    assert.ok(!kill.log.includes("cancel-all"));
    assert.deepEqual(
      kill.log.filter((l) => l.startsWith("cancel")),
      ["cancel 1", "cancel 3"],
    );
  });
});

// ── the withdrawal ──────────────────────────────────────────────────────────

describe("stand-down: only free cross collateral goes home", () => {
  it("never takes the isolated margin of a residual position", async () => {
    const v = new FakeVenue().hold({ marketId: 1, side: "long", base: 30n, margin: u(5), tied: 1 }).script(1, "none", "none", "none");
    v.collateral = u(20);
    const r = await runStanddown(opts(v));
    assert.deepEqual(v.violations, []);
    assert.ok(v.log.includes(`withdraw ${u(20)}`), "the 20 of cross collateral, not 25");
    assert.equal(r.withdrawRequestedMicro, u(20));
    assert.equal(v.rows.get(1)?.margin, u(5), "the residual's margin stays with it");
    assert.equal(r.venue?.isolatedMarginMicro, u(5));
    // Custody counts the residual's margin as still on Lighter.
    const exp = standdownExposure(r, EXTRA);
    assert.equal(exp.kind, "known");
    if (exp.kind === "known") assert.equal(exp.collateralMicro, u(5));
  });

  it("holds the collateral when it backs a position open in cross margin", async () => {
    const v = new FakeVenue().hold({ marketId: 1, side: "long", base: 30n, mode: "cross", tied: 1 }).script(1, "none", "none", "none");
    const r = await runStanddown(opts(v));
    assert.equal(at(v.log, "withdraw"), -1);
    assert.equal(r.withdrawRequestedMicro, null);
    assert.ok(r.failedSteps.some((s) => s.includes("backs BTC-PERP, still open in cross margin")));
    assert.equal(r.outcome, "residual");
  });

  it("/flatten closes and cancels but keeps the collateral at Lighter", async () => {
    assert.equal(STANDDOWN_WITHDRAWS.flatten, false);
    const v = new FakeVenue().hold({ marketId: 1, side: "long", base: 30n, margin: u(5), tied: 1 }).hold({ marketId: 3, open: 1 });
    const r = await runStanddown(opts(v, { reason: "flatten" }));
    assert.equal(at(v.log, "withdraw"), -1);
    assert.ok(v.log.includes("cancel 3"));
    assert.equal(r.withdrawRequestedMicro, null);
    assert.equal(r.outcome, "done", "collateral kept on purpose is not something left behind");
  });

  it("asks for nothing when nothing is free, and a refused withdrawal is a residual", async () => {
    const empty = new FakeVenue();
    empty.collateral = 0n;
    const r0 = await runStanddown(opts(empty));
    assert.equal(at(empty.log, "withdraw"), -1);
    assert.equal(r0.outcome, "done");

    const refused = new FakeVenue();
    refused.withdrawStatus = "rejected";
    const r1 = await runStanddown(opts(refused));
    assert.ok(refused.log.includes(`withdraw ${u(20)}`));
    assert.equal(r1.withdrawRequestedMicro, null);
    assert.equal(r1.outcome, "residual");
    assert.ok(r1.failedSteps.some((s) => s.startsWith("The withdrawal of 20.000000 USDG was refused")));
  });
});

// ── the attempts ────────────────────────────────────────────────────────────

describe("stand-down: attempts are bounded and sequential", () => {
  it("signs a market's next attempt only after the previous one resolved", async () => {
    const v = new FakeVenue()
      .hold({ marketId: 1, side: "long", base: 30n, margin: u(5), tied: 1 })
      .script(1, { submitted: ["submitted", "unknown", "cancelled"] }, { submitted: ["submitted", "filled"] });
    const r = await runStanddown(opts(v));
    assert.deepEqual(v.violations, []);
    const btc = v.log.filter((l) => l.includes("BTC") || l.startsWith("resolve 1"));
    assert.deepEqual(btc, [
      "place BTC-PERP #1",
      "resolve 1 submitted",
      "resolve 1 unknown",
      "resolve 1 cancelled",
      "place BTC-PERP #2",
      "resolve 1 submitted",
      "resolve 1 filled",
    ]);
    assert.equal(r.outcome, "done");
    assert.deepEqual(
      r.closed.map((c) => [c.market, c.attempts, c.filledBase, c.realizedMicro]),
      [["BTC-PERP", 2, 30n, u(1)]],
    );
  });

  it("never more than three attempts, however many rounds are left", async () => {
    const v = new FakeVenue().hold({ marketId: 1, side: "long", base: 30n, tied: 1 }).script(1, "none", "none", "none", "fill");
    await runStanddown(opts(v));
    assert.equal(v.log.filter((l) => l.startsWith("place")).length, 3);
  });

  it("stacks nothing behind a close that never resolves", async () => {
    const v = new FakeVenue()
      .hold({ marketId: 1, side: "long", base: 30n, tied: 1 })
      .script(1, { submitted: Array.from({ length: 500 }, () => "submitted" as const) });
    const r = await runStanddown(opts(v, { deadlineMs: v.now() + 30_000 }));
    assert.equal(v.log.filter((l) => l.startsWith("place")).length, 1);
    assert.equal(r.outcome, "residual");
    assert.ok(r.failedSteps.some((s) => s.includes("close attempt 1 was sent and not resolved in time, so none was signed behind it")));
    assert.equal(r.residual[0]?.stopResting, true);
  });

  it("an executor that cannot resolve gets one attempt per market", async () => {
    const v = new FakeVenue().hold({ marketId: 1, side: "long", base: 30n, tied: 1 }).script(1, { submitted: ["filled"] }, "fill");
    const r = await runStanddown(opts(v, { ex: { resolve: false } }));
    assert.equal(v.log.filter((l) => l.startsWith("place")).length, 1);
    assert.equal(r.residual.length, 1);
    assert.ok(r.failedSteps.some((s) => s.includes("cannot be shown resolved")));
  });

  it("sizes each attempt from the venue read, which includes the last attempt's fills", async () => {
    const v = new FakeVenue().hold({ marketId: 1, side: "long", base: 30n, margin: u(6), tied: 1 }).script(1, "partial", "fill");
    const r = await runStanddown(opts(v));
    assert.deepEqual(v.violations, []);
    assert.deepEqual(
      v.intents.map((i) => i.baseAmount),
      [30n, 15n],
    );
    assert.equal(r.outcome, "done");
    assert.deepEqual(r.closed.map((c) => [c.baseAmount, c.filledBase]), [[30n, 30n]]);
  });

  it("signs a reduce-only close anew after one that threw, and a close that then succeeds leaves no failed step", async () => {
    const v = new FakeVenue().hold({ marketId: 1, side: "long", base: 30n, tied: 1 }).script(1, "throw", "fill");
    const r = await runStanddown(opts(v));
    assert.equal(v.log.filter((l) => l.startsWith("place")).length, 2);
    assert.equal(r.outcome, "done");
    assert.deepEqual(r.failedSteps, []);
    // The first attempt's fill is unknown, so the total is too — never assumed 0.
    assert.equal(r.closed[0]?.filledBase, null);
    assert.equal(r.closed[0]?.realizedMicro, undefined);
  });
});

// ── the price ───────────────────────────────────────────────────────────────

describe("stand-down: the close's price", () => {
  it("floors the slippage at 150 bps and caps it at 450 (protect.ts's cap, inside the venue band); unreadable is the floor", () => {
    assert.equal(standdownSlipBps(50), 150);
    assert.equal(standdownSlipBps(150), 150);
    assert.equal(standdownSlipBps(300), 300);
    assert.equal(standdownSlipBps(900), 450);
    assert.equal(standdownSlipBps(450), 450);
    assert.equal(standdownSlipBps(451), 450);
    // ONE BOUND FOR EVERY EXIT OF A POSITION: the stand-down never accepts a
    // worse fill than the protective loop's own close would.
    assert.equal(STANDDOWN_LIMITS.slipCapBps, PROTECT_THRESHOLDS.closeSlipCapBps);
    assert.equal(standdownSlipBps(null), 150);
    assert.equal(standdownSlipBps(0), 150);
    assert.equal(standdownSlipBps(Number.NaN), 150);
  });

  it("prices every attempt from a fresh mark at the same bound — never widened", async () => {
    const v = new FakeVenue().hold({ marketId: 1, side: "long", base: 30n, tied: 1 }).script(1, "none", "none", "none");
    await runStanddown(opts(v, { feed: feedOf({ 1: { mark: BTC_MARK } }), settings: { maxSlippageBps: 50 } }));
    const worst = worstPriceForTaker({ isAsk: true, mark: BTC_MARK, maxSlippageBps: 150 });
    assert.equal(worst, 817_550n);
    assert.deepEqual(
      v.intents.map((i) => [i.worstPrice, i.markPrice, i.side, i.reduceOnly, i.effect]),
      [
        [worst, BTC_MARK, "long", true, "close"],
        [worst, BTC_MARK, "long", true, "close"],
        [worst, BTC_MARK, "long", true, "close"],
      ],
    );
    // A short's close buys: its bound is above the mark.
    const s = new FakeVenue().hold({ marketId: 0, side: "short", base: 100n, tied: 1 });
    await runStanddown(opts(s, { settings: { maxSlippageBps: 300 } }));
    assert.equal(s.intents[0]?.worstPrice, worstPriceForTaker({ isAsk: false, mark: ETH_MARK, maxSlippageBps: 300 }));
  });

  it("takes the mark from the account read when the feed is stale, and closes nothing it cannot price", async () => {
    const stale = new FakeVenue().hold({ marketId: 1, side: "long", base: 30n, tied: 1, mark: 820_000n });
    await runStanddown(opts(stale, { feed: feedOf({ 1: { mark: 900_000n, fresh: false } }) }));
    assert.equal(stale.intents[0]?.markPrice, 820_000n, "position_value's mark, not a stale feed's");

    // No feed and no decimals: no mark can be derived — the stop is left to do its job.
    const blind = new FakeVenue().hold({ marketId: 1, side: "long", base: 30n, tied: 1 });
    const ex = executorOf(blind);
    const noDecimals: StanddownExecutor = { ...ex, account: async (ctx) => ({ ...(await ex.account(ctx))!, decimals: new Map() }) };
    const r = await runStanddown(opts(blind, { executor: noDecimals }));
    assert.equal(at(blind.log, "place"), -1);
    assert.equal(r.outcome, "residual");
    assert.ok(r.failedSteps.some((s) => s.startsWith("BTC-PERP: no fresh mark could be read")));
    assert.equal(r.residual[0]?.stopResting, true);
  });

  it("builds no close for a market outside the table, and says so", async () => {
    const v = new FakeVenue().hold({ marketId: 99, side: "long", base: 10n, tied: 0, mark: 1_000n });
    const r = await runStanddown(opts(v));
    assert.equal(at(v.log, "place"), -1);
    assert.equal(r.residual[0]?.market, "M99");
    assert.equal(r.residual[0]?.stopResting, false);
    assert.ok(r.failedSteps.some((s) => s.includes("M99: it is not a market this agent trades") && s.endsWith("no stop was seen resting under it.")));
  });
});

// ── the clock ───────────────────────────────────────────────────────────────

describe("stand-down: bounded by its deadline", () => {
  it("stops sending at the cutoff, keeps time to read and book, and lists what is left", async () => {
    const v = new FakeVenue()
      .hold({ marketId: 0, side: "short", base: 100n, margin: u(3), tied: 1, open: 1 })
      .hold({ marketId: 1, side: "long", base: 30n, margin: u(5), tied: 1 })
      .script(0, "none", "none", "none")
      .script(1, "none", "none", "none");
    v.placeMs = 12_000;
    // 40 s: a 10 s reserve, so nothing is sent after +30 s.
    const r = await runStanddown(opts(v, { deadlineMs: v.now() + 40_000 }));
    assert.deepEqual(v.violations, []);
    assert.deepEqual(
      v.log.filter((l) => l.startsWith("place")),
      ["place ETH-PERP #1", "place BTC-PERP #1", "place ETH-PERP #2"],
    );
    assert.equal(at(v.log, "cancel"), -1, "no cancel after the cutoff — and ETH never read flat anyway");
    assert.equal(at(v.log, "withdraw"), -1);
    assert.equal(v.log.at(-1), "reconcile", "the final ingest still ran, inside the deadline");
    assert.ok(v.t <= T0 + 40_000);
    assert.equal(r.outcome, "residual");
    assert.deepEqual(
      r.residual.map((x) => [x.market, x.attempts, x.stopResting]),
      [
        ["ETH-PERP", 2, true],
        ["BTC-PERP", 1, true],
      ],
    );
    assert.equal(r.ordersLeft, 3);
    assert.ok(r.failedSteps.some((s) => s.startsWith("ETH-PERP: the deadline came before it could be closed")));
    assert.ok(r.failedSteps.some((s) => s.startsWith("The deadline came before the stand-down finished")));
    assert.equal(r.venue?.final, true);
  });

  it("abandons a send that never returns half-way into the reserve, aborts it, and still reads and books", async () => {
    const v = new FakeVenue().hold({ marketId: 1, side: "long", base: 30n, tied: 1 }).script(1, "hang");
    v.realClock = true;
    const began = Date.now();
    // 800 ms: a 200 ms reserve, sends stop at +600 and are abandoned at +700.
    const r = await runStanddown(opts(v, { deadlineMs: began + 800, sleep: undefined }));
    const took = Date.now() - began;
    assert.ok(took < 2_000, `took ${took} ms`);
    assert.equal(v.placeSignals[0]?.aborted, true, "the abandoned send was told to stop");
    assert.ok(v.log.indexOf("reconcile") > v.log.indexOf("place BTC-PERP #1"), "the ingest still ran in the time kept back");
    assert.equal(r.ingested, true);
    assert.equal(r.venue?.final, true);
    assert.equal(r.outcome, "residual");
    assert.deepEqual(r.residual.map((x) => [x.market, x.stopResting]), [["BTC-PERP", true]]);
    assert.ok(r.failedSteps.some((s) => s.startsWith("BTC-PERP: the deadline came before it could be closed (close attempt 1 failed")));
  });

  it("an account read that hangs at the end is an unreachable venue, told as unread", async () => {
    const v = new FakeVenue().hold({ marketId: 1, side: "long", base: 30n, tied: 1 }).script(1, "none", "none", "none");
    v.realClock = true;
    const ex = executorOf(v);
    let reads = 0;
    const hangsLater: StanddownExecutor = { ...ex, account: (ctx) => (++reads > 1 ? new Promise(() => {}) : ex.account(ctx)) };
    const began = Date.now();
    const r = await runStanddown(opts(v, { executor: hangsLater, deadlineMs: began + 600, sleep: undefined, limits: { retryPauseMs: 1 } }));
    assert.ok(Date.now() - began < 2_000);
    assert.equal(r.outcome, "unreachable");
    assert.equal(r.venue?.final, false);
    assert.deepEqual(r.residual.map((x) => x.market), ["BTC-PERP"], "the last read's positions, as last known");
    assert.deepEqual(standdownExposure(r, EXTRA), { kind: "unread" });
    assert.match(custodySentence(standdownExposure(r, EXTRA)), /Lighter could not be read/);
  });

  it("sends nothing when the venue cannot be read, keeps trying until the cutoff, and still attempts the ingest", async () => {
    const v = new FakeVenue().hold({ marketId: 1, side: "long", base: 30n, tied: 1 });
    v.accountFails = "always";
    const r = await runStanddown(opts(v, { deadlineMs: v.now() + 30_000 }));
    assert.deepEqual(
      v.log.filter((l) => l !== "read"),
      ["resolve-submitted", "reconcile"],
    );
    assert.ok(v.log.filter((l) => l === "read").length > STANDDOWN_LIMITS.readTries, "the first read is persistent");
    assert.ok(v.t <= T0 + 30_000);
    assert.equal(r.outcome, "unreachable");
    assert.deepEqual(r.residual, []);
    assert.equal(r.ordersLeft, null, "never read is unknown, not zero");
    assert.equal(r.venue, null);
    assert.ok(r.failedSteps.includes("Lighter could not be read, so nothing was closed, cancelled or withdrawn."));
  });

  it("recovers from a first read refused by a rate limit", async () => {
    const v = new FakeVenue().hold({ marketId: 1, side: "long", base: 30n, tied: 1 });
    v.accountFails = 4;
    const r = await runStanddown(opts(v));
    assert.equal(r.outcome, "done");
    assert.ok(v.log.includes("place BTC-PERP #1"));
  });

  it("treats a read it cannot trust as unread", async () => {
    const v = new FakeVenue().hold({ marketId: 1, side: "long", base: 30n, tied: 1 });
    const ex = executorOf(v);
    const bad: StanddownExecutor = {
      ...ex,
      account: async (ctx) => {
        const a = (await ex.account(ctx))!;
        return { ...a, positions: a.positions.map((p) => ({ ...p, side: null })) }; // held with no side
      },
    };
    const r = await runStanddown(opts(v, { executor: bad, deadlineMs: v.now() + 20_000 }));
    assert.equal(at(v.log, "place"), -1);
    assert.equal(r.outcome, "unreachable");
  });
});

// ── the ledger ──────────────────────────────────────────────────────────────

describe("stand-down: resolve first, book last", () => {
  it("falls back to a full reconcile for step (a), and books with one at the end", async () => {
    const v = new FakeVenue().hold({ marketId: 1, side: "long", base: 30n, tied: 1 });
    await runStanddown(opts(v, { rec: { fast: false } }));
    const nonRead = v.log.filter((l) => l !== "read");
    assert.equal(nonRead[0], "reconcile");
    assert.equal(nonRead.at(-1), "reconcile");
    assert.equal(nonRead.filter((l) => l === "reconcile").length, 2);
  });

  it("a final ingest that fails leaves the ledger unknown and says so, without changing what the venue shows", async () => {
    const v = new FakeVenue().hold({ marketId: 1, side: "long", base: 30n, tied: 1 });
    const r = await runStanddown(opts(v, { rec: { fail: true } }));
    assert.equal(r.outcome, "done");
    assert.equal(r.ingested, false);
    assert.ok(r.failedSteps.some((s) => s.includes("fills and funding were not booked") && s.includes("perps ledger stays unknown")));
  });
});

// ── what the owner is told ──────────────────────────────────────────────────

describe("stand-down: the custody sentence", () => {
  it("a flat venue with unread transfers never claims that Lighter reads empty", async () => {
    const r = await runStanddown(opts(new FakeVenue()));
    assert.equal(r.outcome, "done");
    for (const unknown of [{ pendingWithdrawalsMicro: null }, { depositsInTransitMicro: null }]) {
      const exposure = standdownExposure(r, { ...EXTRA, ...unknown });
      assert.deepEqual(exposure, { kind: "unread" });
      assert.doesNotMatch(custodySentence(exposure), /reads empty/);
    }
  });

  it("a clean stand-down reads empty, names what closed and the withdrawal — never 'funds stay in your smart account'", async () => {
    const v = new FakeVenue().hold({ marketId: 1, side: "long", base: 30n, margin: u(5), tied: 1 });
    const r: StanddownResult = await runStanddown(opts(v));
    const text = custodySentence(standdownExposure(r, EXTRA));
    assert.match(text, /^Lighter reads empty/);
    assert.match(text, /Closed: BTC-PERP long 0\.00030 \(realized \+1\.00 USDG\)\./);
    assert.match(text, /A withdrawal of 26\.00 USDG was requested; it reaches your smart account after Lighter's withdrawal delay \(about 15 min\)/);
    assert.doesNotMatch(text, /stay in your smart account/);
    // Other accounts not read: said out loud, and never "reads empty".
    const unknownOthers = custodySentence(standdownExposure(r, { ...EXTRA, otherAccounts: null }));
    assert.doesNotMatch(unknownOthers, /reads empty/);
    assert.match(unknownOthers, /could not be read/);
  });
});

// ── arguments ───────────────────────────────────────────────────────────────

describe("stand-down: arguments", () => {
  it("refuses a reason, clock or deadline that is not one", async () => {
    const v = new FakeVenue();
    await assert.rejects(runStanddown({ ...opts(v), reason: "pause" as never }), TypeError);
    await assert.rejects(runStanddown({ ...opts(v), deadlineMs: Number.POSITIVE_INFINITY }), TypeError);
    await assert.rejects(runStanddown({ ...opts(v), now: 5 as never }), TypeError);
  });

  it("cuts a deadline past the hosted TTL to 15 minutes", async () => {
    const v = new FakeVenue();
    const r = await runStanddown(opts(v, { deadlineMs: v.now() + 86_400_000 }));
    assert.equal(r.deadlineMs, r.startedAt + STANDDOWN_LIMITS.maxBudgetMs);
  });

  it("knows which resolutions end an attempt", () => {
    assert.equal(isFinalResolution({ status: "filled" }), true);
    assert.equal(isFinalResolution({ status: "expired" }), true);
    assert.equal(isFinalResolution({ status: "submitted" }), false);
    assert.equal(isFinalResolution({ status: "unknown" }), false);
    assert.equal(isFinalResolution({ status: "weird" } as never), false);
  });
});
