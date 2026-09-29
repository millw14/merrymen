import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { wrapSqlite } from "./db";
import { applyLedgerSchema } from "./store";
import { adjustRiskCapital, markRiskPeriod, mergeRiskPeriod, readRiskPeriod, startRiskPeriod } from "./risk-period";
import { classifyAnchor, BOOTSTRAP_SCHEMA_VERSION } from "./bootstrap-state";
import { checkPolicy, type AgentLimits, type TradeIntent } from "./policy";
import { accrueAboveHwm } from "./fees";
import { mirrorTenant, MIRROR_STATE_DDL } from "./ledger-mirror";

const account = "0x1111111111111111111111111111111111111111";
const now = 1_800_000_000;
async function fixture() {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  await applyLedgerSchema(db);
  await db.prepare(`INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at,
    mode, contributions_known, hwm_usdg, hwm_withdrawn_usdg) VALUES (?, ?, ?, 4663, '{}', ?, ?, 'live', 1, 75.372964, 30.785344)`)
    .run(account, account, account, now - 100, now + 10000);
  await db.prepare("INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, at, epoch, mode) VALUES (?, '0', 23.669414, 0, 17.959713, 41.629127, ?, 1, 'live')").run(account, now - 1);
  return { raw, db };
}

test("authorized reset opens a separate budget; fees, caps and lifetime peak stay unchanged", async () => {
  const { raw, db } = await fixture();
  try {
    const before = await db.prepare("SELECT * FROM agents").all();
    const period = await startRiskPeriod(db, account, "approved-1", "Owner approved fresh 5% risk period", now);
    assert.equal(period.baseline_usdg, 41.629127);
    assert.deepEqual(await db.prepare("SELECT * FROM agents").all(), before);
    assert.deepEqual({ ...await startRiskPeriod(db, account, "approved-1", period.reason, now + 50) }, period);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n, 1);
    const limits: AgentLimits = { perTradeUsdg: 50000000n, dailyUsdg: 500000000n, allowedTargets: [account], allowedAssets: [account], maxDrawdownBps: 500, expiresAt: now + 1000, maxOpsPerDay: 48 };
    const intent: TradeIntent = { kind: "swap", target: account, sellToken: account, buyToken: account, sellAmountRaw: 1000000n, notionalUsdg: 1000000n };
    const verdict = (peak: bigint, equity: bigint) => checkPolicy(intent, limits, { highWaterMarkUsdg: peak, equityUsdg: equity, nowSec: now, spentTodayUsdg: 0n, opsToday: 0 });
    assert.equal(verdict(44587620n, 41629127n).ok, false);
    assert.equal(verdict(41629127n, 41629127n).ok, true);
    assert.equal(verdict(41629127n, 39547000n).ok, false, "fresh 5% loss budget still trips");
    assert.equal(accrueAboveHwm(42000000n, 44587620n, 1000).profitUsdg, 0n, "recovery is not fee income");
  } finally { raw.close(); }
});

test("new-period peak grows, survives stale mirrors and does not resurrect a prior period", async () => {
  const a = await fixture(), b = await fixture();
  try {
    const first = await startRiskPeriod(a.db, account, "old", "approved", now);
    await markRiskPeriod(a.db, account, 43);
    await b.db.exec(MIRROR_STATE_DDL);
    const mirrored = await mirrorTenant({ tenant: account, child: a.db, shared: b.db });
    assert.deepEqual(mirrored.failed ?? {}, {});
    await mergeRiskPeriod(b.db, first);
    assert.equal(await markRiskPeriod(b.db, account, 42), 43);
    const second = await startRiskPeriod(b.db, account, "new", "approved again", now + 1);
    await mergeRiskPeriod(b.db, (await readRiskPeriod(a.db, account))!);
    assert.equal((await readRiskPeriod(b.db, account))!.id, second.id);
    assert.equal(await markRiskPeriod(b.db, account, null), 41.629127);
    await assert.rejects(mergeRiskPeriod(b.db, { ...second, baseline_usdg: 40 }), /identity/);
  } finally { a.raw.close(); b.raw.close(); }
});

test("capital adjusts the active risk budget, while old periods remain immutable", async () => {
  const { raw, db } = await fixture();
  try {
    await startRiskPeriod(db, account, "old", "approved", now);
    await startRiskPeriod(db, account, "new", "approved", now + 1);
    await adjustRiskCapital(db, account, 10);
    assert.equal(await markRiskPeriod(db, account, null), 51.629127);
    await adjustRiskCapital(db, account, -20);
    assert.ok(Math.abs((await markRiskPeriod(db, account, null))! - 31.629127) < 0.000001);
    assert.equal((await db.prepare("SELECT hwm_usdg FROM risk_periods WHERE id='old'").get() as { hwm_usdg: number }).hwm_usdg, 41.629127);
  } finally { raw.close(); }
});

test("activation refuses stale or unevidenced balances and remains opt-in", async () => {
  const { raw, db } = await fixture();
  try {
    assert.equal(await markRiskPeriod(db, account, 100), null);
    await assert.rejects(startRiskPeriod(db, account, "stale", "approved", now + 301), /Fresh/);
    await db.prepare("UPDATE agents SET contributions_known=0").run();
    await assert.rejects(startRiskPeriod(db, account, "unknown", "approved", now), /evidenced/);
    assert.equal(await readRiskPeriod(db, account), null);
  } finally { raw.close(); }
});

test("bootstrap carries the persisted risk peak and rejects another account's period", async () => {
  const { raw, db } = await fixture();
  try {
    const riskPeriod = await startRiskPeriod(db, account, "approved", "approved", now);
    const state = { schemaVersion: BOOTSTRAP_SCHEMA_VERSION, tenantId: account, generatedAt: now, accounting: { kind: "no-prior-accounting", observedAt: now }, riskPeriod };
    const verdict = classifyAnchor(JSON.stringify(state), { tenantId: account, nowSec: now });
    assert.equal(verdict.kind, "valid");
    if (verdict.kind === "valid") assert.deepEqual(verdict.state.riskPeriod, riskPeriod);
    state.riskPeriod.agent_id = "0x2222222222222222222222222222222222222222";
    assert.equal(classifyAnchor(JSON.stringify(state), { tenantId: account, nowSec: now }).kind, "malformed");
  } finally { raw.close(); }
});

test("a new period's baseline is never a mark taken while flow inference was held", async () => {
  // A held mark's equity may hold a deposit not yet booked: as the baseline it
  // would be counted once there and again when the deposit's booking raises the
  // period's peak (adjustRiskCapital). So the fresh mark is the newest UNHELD one.
  const { raw, db } = await fixture();
  try {
    await db.prepare("INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, at, epoch, mode, flows_held) VALUES (?, '0', 523.669414, 0, 17.959713, 541.629127, ?, 1, 'live', 1)").run(account, now);
    const period = await startRiskPeriod(db, account, "approved-held", "Owner approved fresh 5% risk period", now);
    assert.equal(period.baseline_usdg, 41.629127);
  } finally { raw.close(); }
});

test("A NEW PERIOD STARTS ON THE PEAK BASIS — an open perp gain is not the period's first peak (docs/perps.md rule 12)", async () => {
  // Started over a wick, the whole period would measure drawdown from a gain
  // the account never realised. 12.5 of the 141.629127 is an open winner.
  const { raw, db } = await fixture();
  try {
    await db.prepare(
      `INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, at, epoch, mode,
                           perp_collateral_micro, perp_isolated_margin_micro, perp_unrealized_micro,
                           perp_unrealized_gain_micro, perp_in_transit_micro)
       VALUES (?, '0', 23.669414, 0, 17.959713, 141.629127, ?, 1, 'live', '75000000', '12500000', '12500000', '12500000', '0')`,
    ).run(account, now);
    const period = await startRiskPeriod(db, account, "approved-perp", "Owner approved fresh 5% risk period", now);
    assert.equal(period.baseline_usdg, 129.129127);
    assert.equal(period.hwm_usdg, 129.129127, "and the peak with it");
  } finally { raw.close(); }
});

test("a mark with no perp term, or a zero gain, starts exactly where it always did", async () => {
  const { raw, db } = await fixture();
  try {
    await db.prepare(
      `INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, at, epoch, mode,
                           perp_unrealized_gain_micro, perp_in_transit_micro)
       VALUES (?, '0', 23.669414, 0, 17.959713, 55.123456, ?, 1, 'live', '0', '0')`,
    ).run(account, now);
    const period = await startRiskPeriod(db, account, "approved-zero", "approved", now);
    assert.equal(period.baseline_usdg, 55.123456, "the column itself, not a re-derivation of it");
  } finally { raw.close(); }
});

test("NEVER A MARK TAKEN WHILE PERP MARGIN WAS MOVING — rule 12c: transit can never raise a peak", async () => {
  // The newest mark has 10 in transit; the one before it is too old to start
  // from, so the start is refused until a settled tick writes a mark.
  const { raw, db } = await fixture();
  try {
    await db.prepare("UPDATE equity SET at = ?").run(now - 1_000);
    await db.prepare(
      `INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, at, epoch, mode,
                           perp_collateral_micro, perp_isolated_margin_micro, perp_unrealized_micro,
                           perp_unrealized_gain_micro, perp_in_transit_micro)
       VALUES (?, '0', 13.669414, 0, 17.959713, 41.629127, ?, 1, 'live', '0', '0', '0', '0', '10000000')`,
    ).run(account, now);
    await assert.rejects(startRiskPeriod(db, account, "in-transit", "approved", now), /Fresh/);
    assert.equal(await readRiskPeriod(db, account), null);
  } finally { raw.close(); }
});

test("a corrupted gain term refuses the start rather than guessing a baseline", async () => {
  const { raw, db } = await fixture();
  try {
    await db.prepare(
      `INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, at, epoch, mode, perp_unrealized_gain_micro)
       VALUES (?, '0', 1, 0, 1, 2, ?, 1, 'live', '-5')`,
    ).run(account, now);
    await assert.rejects(startRiskPeriod(db, account, "corrupt", "approved", now), /Unreadable perp gain/);
  } finally { raw.close(); }
});
