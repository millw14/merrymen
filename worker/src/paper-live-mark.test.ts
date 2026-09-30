/**
 * A PAPER TICK MUST NOT LEAVE ITS PEAK IN THE LIVE MARK.
 *
 * tick() keeps one in-memory `highWaterMarkUsdg`. A paper tick sets it to the
 * paper book's peak (index.ts, the `else if (paper)` accounting branch), which
 * is right for paper: it is the peak the paper breaker judges against. But the
 * live mark was put back only on arm, a booked flow, a landed transfer or an
 * energy purchase — and going live again is none of those. So the first live
 * tick after a paper one:
 *
 *   - accrued a performance fee on live equity above the PAPER peak
 *     (accrueAboveHwm → addFeeAccrual, a journaled row). setAgentHwm's CASE kept
 *     the higher mark in the ledger, but the fee was already booked, and the
 *     in-memory mark then sat at live equity — so every tick of recovery back
 *     to the real peak was charged again. That is the owner's principal.
 *   - judged live drawdown against the paper book whenever no risk period
 *     stood: a paper peak below the real one switched the breaker off for an
 *     account that was really in drawdown; one above it tripped the breaker on
 *     a drawdown that never happened.
 *
 * Two ways in, neither rare: the owner turning Live off and on, and a live rail
 * that broke and recovered — exec-mode.ts falls back to paper while a leg is
 * down, and paper trading is on by default.
 *
 * WHAT IS EXECUTED AND WHAT IS PINNED. tick() is a closure inside index.ts and
 * no test can run it. So the sequence below drives the REAL decisions the tick
 * makes — tickRatchets (paper peak, fee and mark), accrueAboveHwm, drawdownOf
 * and livePeaksStale — in the order tick() calls them, against a ledger that
 * records every fee row. It is run twice: with the reload guard tick() had
 * (which reproduces the fee) and with livePeaksStale. The pins at the bottom
 * hold index.ts to that order and to every place that sets the mark.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { livePeaksStale, tickPlan, tickRatchets, type MarkBook } from "./command-wake";
import { accrueAboveHwm } from "./fees";
import { drawdownOf } from "./strategies/types";

const U = (usdg: number) => BigInt(Math.round(usdg * 1e6));
const FEE_BPS = 1000; // SETTINGS_DEFAULTS.perfFeeBps
const MAX_DRAWDOWN_BPS = 1500;

type Guard = (paper: boolean, markBook: MarkBook, capitalPeakDirty: boolean) => boolean;
/** The guard tick() had: it re-read the live peaks only after an energy purchase. */
const OLD_GUARD: Guard = (paper, _markBook, capitalPeakDirty) => capitalPeakDirty && !paper;

/**
 * One armed agent: the ledger (what getAgentFinancials, getRiskPeriodPeak,
 * addFeeAccrual and setAgentHwm touch) and the tick's in-memory state.
 */
function agent(opts: { liveMark: number; paperBookPeak: number; guard: Guard }) {
  const ledger = { hwm: U(opts.liveMark), risk: null as bigint | null, fees: [] as { profit: bigint; fee: bigint; hwmBefore: bigint }[] };
  const paperBook = { hwmUsdg: opts.paperBookPeak };
  // Arm: the persisted live mark, and a fresh lift (index.ts, at "grant armed").
  const mem = { hwm: ledger.hwm, risk: ledger.risk, lift: 0n, markBook: "live" as MarkBook, capitalPeakDirty: false };

  /** One regular tick, in tick()'s order. Returns the drawdown the wall would judge a buy against. */
  async function tick(mode: "paper" | "live", equityUsdg: number) {
    const paper = mode === "paper";
    const equity = U(equityUsdg);
    if (opts.guard(paper, mem.markBook, mem.capitalPeakDirty)) {
      mem.hwm = ledger.hwm;
      mem.risk = ledger.risk;
      mem.capitalPeakDirty = false;
      mem.markBook = "live";
    }
    const ratchet = tickRatchets(tickPlan("regular"), { incomplete: false, curveMarked: 0 });
    if (paper) {
      mem.hwm = U(await ratchet.paperPeak(paperBook, equityUsdg, async () => {}));
      mem.markBook = "paper";
      mem.lift = 0n;
    } else {
      const accrual = accrueAboveHwm(equity, mem.hwm, FEE_BPS);
      const before = mem.hwm;
      mem.hwm = await ratchet.accrue(accrual, mem.hwm, async () => {
        ledger.fees.push({ profit: accrual.profitUsdg, fee: accrual.feeUsdg, hwmBefore: mem.hwm });
        // setAgentHwm: a one-way CASE ratchet.
        if (accrual.newHwmUsdg > ledger.hwm) ledger.hwm = accrual.newHwmUsdg;
      });
      mem.lift = ratchet.breakerLift(mem.lift, before, mem.hwm);
    }
    // index.ts drawdownPeak(): paper judges its own book; live, the risk period's
    // peak when one stands, else the lifetime mark plus the held lift.
    const peak = paper ? mem.hwm : (mem.risk ?? mem.hwm + mem.lift);
    return drawdownOf({ peakUsdg: peak, equityUsdg: equity, equityKnown: true, maxDrawdownBps: MAX_DRAWDOWN_BPS });
  }
  return { ledger, tick };
}

const tripped = (d: { bps: number; limitBps: number } | null) => d !== null && d.bps >= d.limitBps;

describe("live → paper → live, with no re-arm", () => {
  // A live account 20% under its real peak (5,000 → 4,000). The paper book is
  // fresh: seeded at the default 1,000, and it made 10 in its one paper tick.
  const DRAWDOWN_ACCOUNT = { liveMark: 5_000, paperBookPeak: 1_000 };

  it("REPRODUCED, with the reload guard tick() had: a fee on principal, twice, and the breaker switched off", async () => {
    const a = agent({ ...DRAWDOWN_ACCOUNT, guard: OLD_GUARD });
    const live0 = await a.tick("live", 4_000);
    assert.ok(tripped(live0), "live and 20% down: the breaker is tripped, as it should be");
    assert.equal(a.ledger.fees.length, 0);

    await a.tick("paper", 1_010);
    const live1 = await a.tick("live", 4_000);
    // The whole 2,990 between the paper peak and live equity was charged as
    // profit, on an account that has made nothing since its 5,000 peak.
    assert.deepEqual(a.ledger.fees[0], { profit: U(2_990), fee: U(299), hwmBefore: U(1_010) });
    assert.equal(live1?.bps, 0, "judged against a mark the fee just set at live equity");
    assert.ok(!tripped(live1), "the breaker is off for an account still 20% under its peak");

    // And the recovery toward the real peak is charged again, tick by tick.
    await a.tick("live", 4_100);
    assert.deepEqual(a.ledger.fees[1], { profit: U(100), fee: U(10), hwmBefore: U(4_000) });
    assert.equal(a.ledger.hwm, U(5_000), "setAgentHwm kept the real peak — the fees were booked regardless");
  });

  it("FIXED, with livePeaksStale: no fee below the real peak, and the breaker keeps judging against it", async () => {
    const a = agent({ ...DRAWDOWN_ACCOUNT, guard: livePeaksStale });
    await a.tick("live", 4_000);
    const paper = await a.tick("paper", 1_010);
    assert.equal(paper?.bps, 0, "paper still judges its own book");
    const live1 = await a.tick("live", 4_000);
    const live2 = await a.tick("live", 4_100);
    assert.deepEqual(a.ledger.fees, []);
    assert.equal(live1?.bps, 2_000);
    assert.equal(live2?.bps, 1_800);
    assert.ok(tripped(live1) && tripped(live2), "20% and then 18% under the real peak, against a 15% limit");
    assert.equal(a.ledger.hwm, U(5_000));
  });

  it("and profit above the REAL peak is still charged, exactly once", async () => {
    const a = agent({ ...DRAWDOWN_ACCOUNT, guard: livePeaksStale });
    await a.tick("paper", 1_010);
    await a.tick("live", 5_200);
    assert.deepEqual(a.ledger.fees, [{ profit: U(200), fee: U(20), hwmBefore: U(5_000) }]);
    await a.tick("live", 5_200);
    assert.equal(a.ledger.fees.length, 1);
  });

  it("A PAPER PEAK ABOVE THE REAL ONE: the old guard tripped the breaker on a drawdown that never happened; the fix does not", async () => {
    // Live at its own peak of 4,000; a paper book that ran to 5,000.
    const account = { liveMark: 4_000, paperBookPeak: 5_000 };
    const before = agent({ ...account, guard: OLD_GUARD });
    await before.tick("paper", 5_000);
    assert.ok(tripped(await before.tick("live", 4_000)), "20% 'down' against a paper peak — every non-exit buy refused");

    const after = agent({ ...account, guard: livePeaksStale });
    await after.tick("paper", 5_000);
    const d = await after.tick("live", 4_000);
    assert.equal(d?.bps, 0);
    assert.deepEqual(after.ledger.fees, []);
  });
});

describe("livePeaksStale", () => {
  it("re-reads on a live tick after a paper one, or after an energy purchase — never on a paper tick", () => {
    assert.equal(livePeaksStale(false, "paper", false), true, "the mark is the paper book's");
    assert.equal(livePeaksStale(false, "live", true), true, "an energy purchase lowered the persisted peaks");
    assert.equal(livePeaksStale(false, "paper", true), true);
    assert.equal(livePeaksStale(false, "live", false), false, "the steady live state reads nothing");
    for (const markBook of ["live", "paper"] as const) {
      for (const dirty of [false, true]) {
        assert.equal(livePeaksStale(true, markBook, dirty), false, "a paper tick sets the mark it judges by");
      }
    }
  });
});

// ── the wiring ──────────────────────────────────────────────────────────────

const codeOf = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
const CODE = codeOf(readFileSync(new URL("./index.ts", import.meta.url), "utf8"));
const TICK = (() => {
  const at = CODE.indexOf("  async function tick(");
  assert.ok(at > 0, "tick() must exist for these pins to mean anything");
  return CODE.slice(at, CODE.indexOf("\n  }\n", at));
})();

describe("tick() re-reads the live peaks before anything judges them", () => {
  const RELOAD = "if (livePeaksStale(paper, markBook, capitalPeakDirty)) {";

  it("ONE reload, on the tick's own `paper`, before balances, flow inference, the fee and the breaker", () => {
    assert.equal(CODE.split("livePeaksStale(").length - 1, 1, "one call site");
    assert.doesNotMatch(CODE, /capitalPeakDirty && !paperActive\(\)/, "the old energy-only guard is gone, not duplicated");
    const paper = TICK.indexOf("const paper = paperActive();");
    const reload = TICK.indexOf(RELOAD);
    const order = [
      paper,
      reload,
      TICK.indexOf("readAccountBalances(client, grant.smartAccount)"),
      TICK.indexOf("reconcileFlowsOrRetry("),
      TICK.indexOf("accrueAboveHwm(equityUsdg, highWaterMarkUsdg"),
      TICK.indexOf("peakUsdg: drawdownPeak(),"),
    ];
    assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1]!)), `out of order: ${order.join(" < ")}`);
    assert.match(TICK, /\} else if \(paper\) \{/, "the accounting branch forks on the same reading");
  });

  it("the reload takes both live peaks from the ledger and hands the mark back to the live book", () => {
    const at = TICK.indexOf(RELOAD);
    const block = TICK.slice(at, TICK.indexOf("\n    }\n", at));
    assert.match(block, /highWaterMarkUsdg = usdg\(\(await getAgentFinancials\(agentId\)\)\.hwmUsdg\);/);
    assert.match(block, /const risk = await getRiskPeriodPeak\(agentId\);\s*riskHighWaterMarkUsdg = risk === null \? null : usdg\(risk\);/);
    assert.match(block, /capitalPeakDirty = false;/);
    assert.match(block, /markBook = "live";/);
  });

  it("THE WALL'S OWN READ never judges a live intent against the paper peak", () => {
    // A trade typed in Telegram can join during the tick's reads, before the
    // reload above. With no risk period standing the wall used the in-memory
    // mark — the paper book's, until then — so it takes the ledger's instead.
    const locked = CODE.slice(CODE.indexOf("  async function processIntentLocked("));
    const state = locked.slice(locked.indexOf("const state: AgentState = {"), locked.indexOf("const verdict = checkPolicy("));
    assert.match(
      state,
      /\(await getRiskPeriodPeak\(agentId\)\) \?\?\s*\(markBook === "paper" \? \(await getAgentFinancials\(agentId\)\)\.hwmUsdg : usdgNum\(lifetimeBreakerPeak\(\)\)\)/,
    );
  });

  it("EVERY assignment of the mark says which book it came from", () => {
    // A new way to set the mark has to decide this too, or a paper figure can
    // leak into the live one again. These are all of them today.
    const sites = [...CODE.matchAll(/(?<!let )\bhighWaterMarkUsdg = ([^;]*);/g)].map((m) => m[1]!.trim());
    const fromLedger = sites.filter((s) => s === "usdg((await getAgentFinancials(agentId)).hwmUsdg)");
    const fromPaper = sites.filter((s) => s.startsWith("usdg(await ratchet.paperPeak("));
    const fromAccrual = sites.filter((s) => s.startsWith("await ratchet.accrue("));
    assert.equal(fromPaper.length, 1, "the paper branch is the only paper source");
    assert.equal(fromLedger.length + fromPaper.length + fromAccrual.length, sites.length, `an unclassified assignment: ${sites.join(" | ")}`);

    // The paper source marks the book, on the next statement.
    assert.match(CODE, /highWaterMarkUsdg = usdg\(await ratchet\.paperPeak\([^;]*\);\s*markBook = "paper";/);
    assert.equal(CODE.split('markBook = "paper";').length - 1, 1);
    // The accrual runs only on the live branch, after the reload.
    const accrueAt = TICK.indexOf("highWaterMarkUsdg = await ratchet.accrue(");
    assert.ok(accrueAt > TICK.indexOf("} else if (paper) {"), "the fee's ratchet is in the live branch");
    // Arm reads the live mark and says so.
    assert.match(CODE, /highWaterMarkUsdg = usdg\(\(await getAgentFinancials\(agentId\)\)\.hwmUsdg\);\s*markBook = "live";\s*heldBreakerLiftUsdg = 0n;/);
  });
});
