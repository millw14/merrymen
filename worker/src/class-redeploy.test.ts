/**
 * THE DESTRUCTIVE TEST: a redeploy must not lose a position.
 *
 * The scenario, exactly as it happens in production: an agent buys a class
 * token, the orchestrator redeploys, the child's sqlite is rebuilt from nothing
 * — `class_positions` is empty — and the tokens are still sitting in the vault.
 *
 * Before the chain became the source of truth, that empty table read as a flat
 * book: no position, no hold clock, no exit, and an equity figure that had
 * silently lost somebody's money. These tests run that sequence and assert the
 * position comes back, with its clock and its actual cost intact.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { foldClassEvents, parseClassLogs, CLASS_BUY_TOPIC, CLASS_SELL_TOPIC } from "./venues/class-log";
import { reconcileClassBook, scoutCostOf } from "./class-reconcile";

const CURVE = "0x1111111111111111111111111111111111111111";
const TOKEN = "0x2222222222222222222222222222222222222222";
const OTHER = "0x4444444444444444444444444444444444444444";

const topic = (a: string) => `0x${"0".repeat(24)}${a.slice(2)}`;
const w = (v: bigint) => v.toString(16).padStart(64, "0");
const buyLog = (quoteIn: bigint, tokensOut: bigint, block: bigint, tx: string, token = TOKEN) => ({
  topics: [CLASS_BUY_TOPIC, topic(CURVE), topic(token)],
  data: `0x${w(quoteIn)}${w(tokensOut)}`,
  blockNumber: block,
  transactionHash: tx,
  logIndex: 0,
});
const sellLog = (tokensIn: bigint, quoteOut: bigint, block: bigint, tx: string) => ({
  topics: [CLASS_SELL_TOPIC, topic(CURVE), topic(TOKEN)],
  data: `0x${w(tokensIn)}${w(quoteOut)}`,
  blockNumber: block,
  transactionHash: tx,
  logIndex: 0,
});

/** The whole sequence: buy, wipe the cache, come back and look again. */
function afterRedeploy(opts: { logs: Parameters<typeof parseClassLogs>[0]; balance: bigint; logComplete?: boolean }) {
  return reconcileClassBook({
    folded: foldClassEvents(parseClassLogs(opts.logs)),
    balances: new Map([[TOKEN, opts.balance]]),
    // THE WIPE. This is what a rebuilt child looks like: it remembers nothing.
    cached: [],
    logComplete: opts.logComplete ?? true,
    balancesComplete: true,
  });
}

describe("a rebuilt child rediscovers its class position", () => {
  const BOUGHT = 410_609_930_000_000_000_000_000n;
  const COST = 4_870_000n; // 4.87 USDG actually spent on a 5.00 request

  it("finds the position even though the cache is empty", () => {
    const r = afterRedeploy({ logs: [buyLog(COST, BOUGHT, 100n, "0xentry")], balance: BOUGHT });
    assert.equal(r.positions.length, 1);
    assert.equal(r.positions[0]!.state, "open", "a wiped cache must not read as flat");
    assert.equal(r.positions[0]!.balanceRaw, BOUGHT);
  });

  it("recovers the ACTUAL cost, not the size that was proposed", () => {
    const r = afterRedeploy({ logs: [buyLog(COST, BOUGHT, 100n, "0xentry")], balance: BOUGHT });
    assert.equal(r.positions[0]!.costRaw, COST);
    assert.equal(r.positions[0]!.qtyRaw, BOUGHT);
  });

  it("the hold clock survives, because the chain keeps it", () => {
    // Without this the exit's age check restarts at every redeploy, and a
    // position could never grow old enough to be sold.
    const r = afterRedeploy({ logs: [buyLog(COST, BOUGHT, 100n, "0xentry")], balance: BOUGHT });
    assert.equal(r.positions[0]!.openedAtBlock, 100n);
    assert.equal(r.positions[0]!.entryTx, "0xentry");
  });

  it("the exit producer has everything it needs to sell it", () => {
    // curve + token + balance is exactly the input set proposeClassExits works
    // from. If any were missing the position would be visible and unsellable,
    // which is the trap wearing a different hat.
    const p = afterRedeploy({ logs: [buyLog(COST, BOUGHT, 100n, "0xentry")], balance: BOUGHT }).positions[0]!;
    assert.equal(p.curve, CURVE);
    assert.ok(p.balanceRaw > 0n);
    assert.equal(p.state, "open");
  });

  it("reconciling twice changes nothing", () => {
    // Every arm reconciles. If the fold were not idempotent the basis would
    // drift once per restart, and the scout budget with it.
    const logs = [buyLog(COST, BOUGHT, 100n, "0xentry")];
    const a = afterRedeploy({ logs, balance: BOUGHT }).positions[0]!;
    const b = afterRedeploy({ logs, balance: BOUGHT }).positions[0]!;
    assert.deepEqual(a, b);
  });
});

describe("a balance the tape cannot explain is RECOVERED, not zero and not flat", () => {
  it("classifies it as recovered with an unknown basis", () => {
    // The buy is outside the scanned window — an old position, or a token
    // somebody transferred in. Booking cost 0 would report the whole exit as
    // profit; dropping it would hide the owner's money.
    const r = afterRedeploy({ logs: [], balance: 500n });
    assert.equal(r.positions.length, 1);
    assert.equal(r.positions[0]!.state, "recovered");
    assert.equal(r.positions[0]!.costRaw, null, "unknown is not zero");
    assert.deepEqual(r.recovered, [TOKEN]);
  });

  it("a recovered position contributes NOTHING to the scout budget", () => {
    // Counting it as zero would quietly free budget for another entry;
    // inventing a figure would be worse. It is reported instead.
    const r = afterRedeploy({ logs: [], balance: 500n });
    const { spentRaw, unknown } = scoutCostOf(r.positions);
    assert.equal(spentRaw, 0n);
    assert.deepEqual(unknown, [TOKEN], "the owner is told which position cannot be priced");
  });

  it("an explained position DOES accrue its actual cost to the budget", () => {
    const r = afterRedeploy({ logs: [buyLog(4_870_000n, 400n, 100n, "0xa")], balance: 400n });
    assert.equal(scoutCostOf(r.positions).spentRaw, 4_870_000n);
  });
});

describe("an incomplete read never closes a position", () => {
  it("a refused log scan does not mark a zero balance closed", () => {
    // The buy might be in the window the node refused. Writing `closed` on that
    // guess erases a live position's basis.
    const r = afterRedeploy({ logs: [], balance: 0n, logComplete: false });
    assert.deepEqual(r.positions, []);
    assert.equal(r.incomplete, true);
    assert.match(r.why!, /could not be read in full/);
  });

  it("but a HELD balance is still reported when the scan was refused", () => {
    // The balance is its own evidence. Refusing to report it because the
    // history is unreadable would hide a real holding behind a log problem.
    const r = afterRedeploy({ logs: [], balance: 700n, logComplete: false });
    assert.equal(r.positions.length, 1);
    assert.equal(r.positions[0]!.state, "recovered");
    assert.equal(r.incomplete, true);
  });

  it("says which half failed, because the remedies differ", () => {
    const both = reconcileClassBook({
      folded: new Map(),
      balances: new Map(),
      cached: [],
      logComplete: false,
      balancesComplete: false,
    });
    assert.match(both.why!, /neither/);
    const bal = reconcileClassBook({
      folded: new Map(),
      balances: new Map(),
      cached: [],
      logComplete: true,
      balancesComplete: false,
    });
    assert.match(bal.why!, /balances/);
  });
});

describe("a closed position is closed, and says what it realised", () => {
  it("zero balance with a complete tape closes and keeps both money terms", () => {
    const r = afterRedeploy({
      logs: [buyLog(5_000_000n, 400n, 100n, "0xin"), sellLog(400n, 4_760_000n, 200n, "0xout")],
      balance: 0n,
    });
    const p = r.positions[0]!;
    assert.equal(p.state, "closed");
    assert.equal(p.costRaw, 5_000_000n);
    assert.equal(p.proceedsRaw, 4_760_000n);
    assert.equal(p.exitTx, "0xout");
    // Realised = proceeds - cost = -0.24 USDG. Both terms present, so the
    // subtraction is possible; the sign is the caller's business.
    assert.equal(p.proceedsRaw! - p.costRaw!, -240_000n);
  });

  it("a closed position stops consuming scout budget", () => {
    const r = afterRedeploy({
      logs: [buyLog(5_000_000n, 400n, 100n, "0xin"), sellLog(400n, 4_760_000n, 200n, "0xout")],
      balance: 0n,
    });
    assert.equal(scoutCostOf(r.positions).spentRaw, 0n, "only open positions hold budget");
  });

  it("tracks several tokens independently", () => {
    const r = reconcileClassBook({
      folded: foldClassEvents(
        parseClassLogs([buyLog(1_000_000n, 100n, 10n, "0xa"), buyLog(2_000_000n, 200n, 20n, "0xb", OTHER)]),
      ),
      balances: new Map([
        [TOKEN, 100n],
        [OTHER, 0n],
      ]),
      cached: [],
      logComplete: true,
      balancesComplete: true,
    });
    const open = r.positions.filter((p) => p.state === "open");
    const closed = r.positions.filter((p) => p.state === "closed");
    assert.equal(open.length, 1);
    assert.equal(closed.length, 1);
    assert.equal(scoutCostOf(r.positions).spentRaw, 1_000_000n, "only the open one counts");
  });
});
