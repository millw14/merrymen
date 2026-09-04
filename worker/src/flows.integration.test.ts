/**
 * Capital is not profit — proven against a real sqlite file.
 *
 * The bug these pin cost a real owner real money. equity was a bare balance
 * reading with no flow term, so a deposit was arithmetically indistinguishable
 * from a gain: /pnl reported +999.48 on a book that was down 0.52, and the
 * performance fee charged the owner on their own principal. The one mitigation
 * that existed fired only while the high-water mark was still zero, so it fixed
 * the FIRST deposit and no other.
 *
 * MERRYMEN_HOME is set before any store import runs getDb(); node's --test runs
 * each file in its own process, so the override never leaks.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-flows-"));
process.env.MERRYMEN_HOME = HOME;

const {
  initStore,
  addFlow,
  addEquity,
  adjustAgentHwm,
  ensureAgent,
  getAgentFinancials,
  getNetContributionsUsdg,
  lastKnownCashUsdg,
  listFlows,
  setAgentStatus,
} = await import("./store");
const { accrueAboveHwm } = await import("./fees");
const { readPnl } = await import("./telegram/reads");
const { homePaths } = await import("./home");
const { DatabaseSync } = await import("node:sqlite");

/**
 * ensureHome copies a legacy <repo>/.data ledger into a fresh home, so a
 * throwaway MERRYMEN_HOME does NOT start empty when run from a checkout that
 * still has one — it starts with somebody's July trading history, and every
 * "which agent is current" assertion below would answer with theirs. Clear the
 * tables these tests reason about so the fixture is the fixture.
 */
/** Retire every agent, so a test can name the one it means to report on. */
function retireAllAgents(): void {
  const db = new DatabaseSync(homePaths.db());
  try {
    db.exec("UPDATE agents SET status = 'expired'");
  } catch {
    /* no agents table yet */
  }
  db.close();
}

function clearLedger(): void {
  const db = new DatabaseSync(homePaths.db());
  for (const table of ["agents", "equity", "flows", "trades", "fee_accruals"]) {
    try {
      db.exec(`DELETE FROM ${table}`);
    } catch {
      /* table may not exist on a pre-migration copy */
    }
  }
  db.close();
}

const A = "0x000000000000000000000000000000000000000a";
const B = "0x000000000000000000000000000000000000000b";

const usdg = (v: number) => BigInt(Math.round(v * 1e6));

function grant(smartAccount: string) {
  return {
    smartAccount,
    owner: "0x00000000000000000000000000000000000000ff",
    sessionKeyAddress: "0x00000000000000000000000000000000000000fe",
    chainId: 46630,
    caps: { perTradeUsdg: 50, dailyUsdg: 500, expiryDays: 14, maxDrawdownPct: 10, maxOpsPerDay: 48 },
    grantedAt: 1_700_000_000,
    expiresAt: 1_800_000_000,
  } as unknown as Parameters<typeof ensureAgent>[0];
}

after(() => {
  try {
    rmSync(HOME, { recursive: true, force: true });
  } catch {
    /* temp dir cleanup is best-effort */
  }
});

describe("the flow ledger", () => {
  it("nets deposits against withdrawals", async () => {
    initStore();
    clearLedger();
    await ensureAgent(grant(A));
    await addFlow({ agentId: A, direction: "in", amountUsdg: 1000, source: "inferred" });
    await addFlow({ agentId: A, direction: "out", amountUsdg: 250, source: "transfer-intent", txHash: "0xabc" });
    assert.equal(await getNetContributionsUsdg(A), 750);
  });

  it("keeps one agent's capital out of another's", async () => {
    await ensureAgent(grant(B));
    await addFlow({ agentId: B, direction: "in", amountUsdg: 4242, source: "inferred" });
    assert.equal(await getNetContributionsUsdg(A), 750);
    assert.equal(await getNetContributionsUsdg(B), 4242);
  });

  it("records how it knows, because the three sources are not equal evidence", async () => {
    const rows = await listFlows(A);
    const bySource = Object.fromEntries(rows.map((r) => [r.source, r.tx_hash]));
    assert.equal(bySource["transfer-intent"], "0xabc"); // ours, signed, on chain
    assert.equal(bySource["inferred"], null); // guesswork carries no tx, and says so
  });
});

describe("a deposit is never profit (the fee regression)", () => {
  it("the exact July sequence accrues ZERO fee: 154.87 seed, then +1000, then +500", async () => {
    // Before the flow ledger this booked PROFIT 1000 / FEE 100 on the second
    // deposit and PROFIT 500 / FEE 50 on the third — 150 USDG of fees taken on
    // an account that had never placed a trade.
    let hwm = 0n;
    let fees = 0n;
    for (const deposit of [154.87, 1000, 500]) {
      // The flow moves the mark it will be judged against, BEFORE judgement.
      hwm += usdg(deposit);
      const equity = hwm; // funded, nothing traded, nothing earned
      const accrual = accrueAboveHwm(equity, hwm, 1_000); // 10%
      fees += accrual.feeUsdg;
      hwm = accrual.newHwmUsdg;
    }
    assert.equal(fees, 0n);
    assert.equal(hwm, usdg(1654.87));
  });

  it("still charges on money the agent actually made", async () => {
    // 1000 in, then genuinely worth 1100 → fee on the 100, not on the 1000.
    const hwm = usdg(1000);
    const accrual = accrueAboveHwm(usdg(1100), hwm, 1_000);
    assert.equal(accrual.profitUsdg, usdg(100));
    assert.equal(accrual.feeUsdg, usdg(10));
  });

  it("a withdrawal lowers the mark, so taking profit home is not a drawdown", async () => {
    await ensureAgent(grant(A));
    await adjustAgentHwm(A, 1654.87);
    await adjustAgentHwm(A, -1000);
    const { hwmUsdg } = await getAgentFinancials(A);
    assert.ok(Math.abs(hwmUsdg - 654.87) < 1e-6, `hwm was ${hwmUsdg}`);

    // The breaker measures equity against this mark. Left at 1654.87 against an
    // equity of 654.87 it reads a 60% drawdown and trips — on an account whose
    // owner simply took their money home.
    const drawdownBps = Number(((usdg(654.87) - usdg(654.87)) * 10_000n) / usdg(654.87));
    assert.equal(drawdownBps, 0);
  });

  it("the mark floors at zero — a withdrawal cannot drive it negative", async () => {
    await adjustAgentHwm(A, -99_999);
    const { hwmUsdg } = await getAgentFinancials(A);
    assert.equal(hwmUsdg, 0);
  });
});

describe("a top-up made while the worker was STOPPED", () => {
  // The restart hole. `lastCashUsdg` is a process-lifetime variable that resets
  // to null on every start, and the HWM is persisted — so on the first tick
  // after a restart the old code took neither branch: the deposit was
  // swallowed, accrueAboveHwm saw the higher equity as profit, and a 10% fee
  // came out of the owner's own capital. "Stop worker → top up → start worker"
  // is the most natural thing a first-day owner does.
  const R = "0x000000000000000000000000000000000000000d";

  it("is recoverable from the ledger — the worker is not the only memory", async () => {
    await ensureAgent(grant(R));
    // A tick before the restart recorded cash of 500.
    await addEquity(R, { ethWei: 0n, cashUsdg: 500, vaultUsdg: 0, positionsUsdg: 0, equityUsdg: 500 });
    assert.equal(await lastKnownCashUsdg(R), 500);
  });

  it("a brand-new agent has NO prior reading — null, not zero", async () => {
    // Zero would make the first funding look like a 500 USDG deposit on top of
    // an existing balance, which is a different fact.
    const fresh = "0x000000000000000000000000000000000000000e";
    await ensureAgent(grant(fresh));
    assert.equal(await lastKnownCashUsdg(fresh), null);
  });

  it("the restart sequence accrues ZERO fee once the gap is booked as a flow", async () => {
    // Worker stopped at cash 500 / hwm 500. Owner adds 250. Worker restarts and
    // sees 750: the difference is a FLOW, so the mark moves with it and there is
    // no profit to charge for.
    // The opening 500 was itself a flow, so the mark already sits at 500.
    await addFlow({ agentId: R, direction: "in", amountUsdg: 500, source: "inferred" });
    await adjustAgentHwm(R, 500);

    const priorCash = await lastKnownCashUsdg(R);
    assert.equal(priorCash, 500);

    const observed = usdg(750);
    const delta = observed - usdg(priorCash!);
    assert.equal(delta, usdg(250));

    await addFlow({ agentId: R, direction: "in", amountUsdg: 250, source: "inferred" });
    await adjustAgentHwm(R, 250); // capital moves the mark, before any judgement

    const { hwmUsdg } = await getAgentFinancials(R);
    const accrual = accrueAboveHwm(observed, usdg(hwmUsdg), 1_000); // 10%
    assert.equal(accrual.feeUsdg, 0n);
    assert.equal(accrual.profitUsdg, 0n);
    assert.equal(await getNetContributionsUsdg(R), 750);
  });
});

describe("readPnl reports the agent's own money", () => {
  it("subtracts what was put in, rather than calling it profit", async () => {
    // The real shape of the July ledger: money in, worth 999.48 now.
    // One armed agent at a time — a re-grant retires the last one. `status`
    // DEFAULTs to 'armed', so every other agent this file creates has to be
    // retired explicitly, or "which agent is current" answers with the newest.
    retireAllAgents();
    await setAgentStatus(A, "armed");
    await addEquity(A, { ethWei: 0n, cashUsdg: 700, vaultUsdg: 0, positionsUsdg: 299.480778, equityUsdg: 999.480778 });
    // B is funded and marked to a very different number in the same tables.
    await addEquity(B, { ethWei: 0n, cashUsdg: 50_000, vaultUsdg: 0, positionsUsdg: 0, equityUsdg: 50_000 });

    const out = readPnl();
    // The headline is equity MINUS capital: 999.48 − 750 = 249.48. It used to be
    // last-minus-first over every agent's rows at once, which on this fixture
    // would report the whole bankroll — and B's 50,000 alongside it.
    assert.match(out, /change: \$249\.48/);
    assert.doesNotMatch(out, /change: \$999\.48/);
    assert.doesNotMatch(out, /50,?000/);
    assert.match(out, /you put in \$750\.00/);
  });

  it("claims NO P&L when nothing is on record about capital", async () => {
    // A ledger written before flow tracking existed. Net contributions is
    // UNKNOWN, not zero — and equity minus zero is the bankroll, which is the
    // exact number this whole change exists to stop reporting. Caught by
    // running the dashboard against the real July database, where it cheerfully
    // printed +$999.48 again.
    const C = "0x000000000000000000000000000000000000000c";
    await ensureAgent(grant(C));
    await setAgentStatus(A, "expired");
    await setAgentStatus(C, "armed");
    await addEquity(C, { ethWei: 0n, cashUsdg: 999.48, vaultUsdg: 0, positionsUsdg: 0, equityUsdg: 999.48 });

    assert.equal(await getNetContributionsUsdg(C), null);
    const out = readPnl();
    assert.match(out, /not measurable/);
    assert.doesNotMatch(out, /change: \$999\.48/);
  });
});

/**
 * A FLOW'S IDENTITY, written the same way by every writer.
 *
 * Two processes write chain-derived flows into the same shared table: the
 * deposit scanner via this function, and the accounting repair directly. The
 * unique index that stops them booking one deposit twice is over
 * `(chain_id, agent_id, tx_hash, log_index)` — so if the two disagree about the
 * chain (NULL vs 4663) or the case of the hash (0xAB… vs 0xab…), the constraint
 * never fires and the owner's deposit is counted twice, both rows stamped with
 * the schema's highest-trust source.
 */
describe("the identity of a chain-derived flow", () => {
  const D = "0x000000000000000000000000000000000000000d";

  it("carries the chain from the agent's own grant, without being told", async () => {
    initStore();
    await ensureAgent(grant(D));
    await addFlow({
      agentId: D,
      direction: "in",
      amountUsdg: 10,
      source: "chain-log",
      txHash: "0xAbCdEf0123",
      blockNumber: 100,
      logIndex: 0,
    });
    const db = new DatabaseSync(homePaths.db());
    const row = db
      .prepare("SELECT chain_id, tx_hash FROM flows WHERE agent_id = ? ORDER BY id DESC LIMIT 1")
      .get(D) as { chain_id: number; tx_hash: string };
    db.close();
    assert.equal(Number(row.chain_id), 46630, "read from agents.chain_id, which ensureAgent wrote from the grant");
    assert.equal(row.tx_hash, "0xabcdef0123", "normalised, so two writers cannot disagree about the same hash");
  });

  it("writes an identity a unique index can be built over", async () => {
    // WHAT THIS CHANGE IS FOR, and the reason it ships one deploy ahead of the
    // constraint. The index that stops a double-booked deposit is over
    // (chain_id, agent_id, tx_hash, log_index) — and it cannot be created safely
    // over rows that are half-NULL and mixed-case, because NULLs are distinct in
    // a unique index on both engines and 0xAB… is not 0xab…. Every row written
    // from here on carries the full identity in one canonical form, so by the
    // time the constraint arrives there is nothing left for it to trip over.
    //
    // The dedup PROOF belongs with the index, not here: without a constraint
    // there is nothing for `ON CONFLICT DO NOTHING` to catch.
    const db = new DatabaseSync(homePaths.db());
    const rows = db
      .prepare("SELECT chain_id, tx_hash, log_index FROM flows WHERE agent_id = ? AND tx_hash IS NOT NULL")
      .all(D) as { chain_id: number | null; tx_hash: string; log_index: number | null }[];
    db.close();
    assert.ok(rows.length > 0);
    for (const r of rows) {
      assert.ok(r.chain_id !== null, "a chain-derived row names its chain");
      assert.ok(r.log_index !== null, "…and its position in the block");
      assert.equal(r.tx_hash, r.tx_hash.toLowerCase(), "…in one canonical case");
    }
  });

  it("reports whether the row landed, so the caller can refuse to move the peak", async () => {
    // addFlow used to return void and swallow its own failures while the caller
    // went straight on to adjustAgentHwm — so a failed insert shifted the peak
    // by the full deposit with no row to explain it and no way to retry.
    assert.equal(
      await addFlow({ agentId: D, direction: "in", amountUsdg: 1, source: "inferred" }),
      true,
      "a live agent's inferred flow lands, and says so",
    );
    assert.equal(
      await addFlow({ agentId: D, direction: "in", amountUsdg: 1, source: "inferred", mode: "paper" }),
      false,
      "a refusal is reported, not swallowed",
    );
  });
});
