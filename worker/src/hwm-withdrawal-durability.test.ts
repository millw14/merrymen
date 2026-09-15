/**
 * A WITHDRAWAL-REDUCED PEAK MUST SURVIVE A REDEPLOY.
 *
 * THE FAILURE THIS PINS, from production. Shogun's owner funded 25.000000 USDG,
 * withdrew 20.000000 to their own address, later swept the rest home through the
 * Recover panel, and re-funded 24.915968. The child booked the deposits — every
 * one of them raised the peak, correctly — and the peak ended at 49.915968
 * against 24.915968 of equity. The drawdown breaker read 5008bps against a
 * signed 500bps cap and refused every buy, on an account that had never sold
 * anything and never lost a penny.
 *
 * `adjustAgentHwm` was already right: it lowers the peak when capital leaves,
 * and its own comment says why — "leave the peak up and the account is
 * permanently 'in drawdown' by the amount its owner took home". The reduction
 * simply could not reach the shared database. `ledger-mirror` copies `agents`
 * with an upward-only ratchet, and that ratchet is ALSO right: a hosted child
 * rebuilt by a redeploy recreates its row at the schema default of hwm 0, and an
 * unconditional write would carry that zero over durable history, hand the whole
 * principal to `accrueAboveHwm` as profit, and charge a fee on the owner's own
 * money. Two modules, each correct alone, contradicting each other the moment a
 * container restarts.
 *
 * WHAT IS ACTUALLY EXERCISED HERE. The real store SQL, the real `mirrorTenant`,
 * the real `deriveBootstrapAccounting`, the real `accountingLicence`. The only
 * thing simulated is the container rebuild itself — the child's `agents` row is
 * dropped and re-created through the real `ensureAgent`, which is exactly the
 * row a fresh container produces. A test that reimplemented the SQL would pass
 * against a mirror that had been reverted, which is the one thing it must not
 * do.
 *
 * MERRYMEN_HOME is set before any store import runs getDb(); node's --test runs
 * each file in its own process, so the override never leaks.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-hwm-"));
process.env.MERRYMEN_HOME = HOME;

const { initStore, ensureAgent, adjustAgentHwm, getAgentFinancials, restoreAgentHwmParts } =
  await import("./store");
const { mirrorTenant, MIRROR_STATE_DDL } = await import("./ledger-mirror");
const { deriveBootstrapAccounting } = await import("./bootstrap-source");
const { accountingLicence } = await import("./bootstrap-state");
const { wrapSqlite } = await import("./db");
const { homePaths } = await import("./home");
const { DatabaseSync } = await import("node:sqlite");

const ACCOUNT = "0x05a198a677fbcd8f5c168d397fa7ef5eb6d65487";
const OWNER = "0x8e93bad5a60a266b4283855ceffa0979720aed72";

/** The grant shape `ensureAgent` wants. Only the ledger columns matter here. */
const GRANT = {
  smartAccount: ACCOUNT,
  owner: OWNER,
  sessionKeyAddress: "0x1111111111111111111111111111111111111111",
  chainId: 4663,
  caps: { maxDrawdownPct: 5 },
  grantedAt: 1,
  expiresAt: 2_000_000_000,
} as never;

/**
 * The shared ledger, with the same shape Postgres has.
 *
 * COPIED FROM THE CHILD'S OWN `sqlite_master` rather than hand-written, and that
 * is deliberate. The two existing mirror fixtures spell their schemas out by
 * hand, and the file records twice what that costs: a column the mirror's SELECT
 * named and the fixture lacked made the copy move ZERO rows silently, and a
 * missing `position_floors` made everything after it in the snapshot pass never
 * run. A fixture whose job is to model the real schema should not be able to
 * drift from it, and replaying the real DDL is the cheapest way to make that
 * structurally true.
 */
function sharedLedger() {
  const src = childRaw();
  const ddl = (
    src
      .prepare(
        // `sqlite_sequence` is created by the engine for AUTOINCREMENT tables and
        // replaying its DDL is an error ("object name reserved for internal
        // use"). Excluded by name rather than by swallowing the throw, so a
        // genuinely bad statement still fails loudly.
        "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'",
      )
      .all() as { sql: string }[]
  ).map((r) => r.sql);
  src.close();
  const raw = new DatabaseSync(":memory:");
  for (const stmt of ddl) raw.exec(`${stmt};`);
  raw.exec(MIRROR_STATE_DDL);
  return { db: wrapSqlite(raw), raw };
}

/** The child's own handle, for the one thing the store API cannot do: forget. */
const childRaw = () => new DatabaseSync(homePaths.db());

/**
 * What a redeploy does to a hosted child: the container's disk is discarded and
 * the next boot recreates the row from the grant at schema defaults.
 *
 * Deleting the row and calling the real `ensureAgent` reproduces that exactly —
 * and reproduces the trap, because `ensureAgent` inserts only the grant columns,
 * so hwm and hwm_withdrawn both come back as 0.
 */
async function rebuildChild(): Promise<void> {
  const raw = childRaw();
  raw.exec(`DELETE FROM agents WHERE smart_account = '${ACCOUNT}'`);
  raw.close();
  await ensureAgent(GRANT);
}

let shared: ReturnType<typeof sharedLedger>;

before(async () => {
  await initStore();
  // A throwaway home can inherit a checkout's .data ledger, so clear the tables
  // these assertions reason about — the fixture has to be the fixture.
  const raw = childRaw();
  for (const t of ["agents", "flows", "equity", "fee_accruals", "trades"]) {
    try {
      raw.exec(`DELETE FROM ${t}`);
    } catch {
      /* table not in this schema yet */
    }
  }
  raw.close();
  await ensureAgent(GRANT);
  shared = sharedLedger();
});

after(() => {
  shared?.raw?.close?.();
  // Windows holds the sqlite handle until the process exits, so a failed unlink
  // here is housekeeping, not a result. Swallowing it keeps a green suite green.
  try {
    rmSync(HOME, { recursive: true, force: true });
  } catch {
    /* the OS still has the file open */
  }
});

describe("a peak lowered by a withdrawal survives the redeploy that follows it", () => {
  it("SHOGUN'S ARITHMETIC: deposits raise it, the withdrawal lowers it", async () => {
    // 25.000000 in, then 24.915968 in. Both are capital, so both raise the peak
    // — this is the half that already worked, and the half that produced 49.9.
    await adjustAgentHwm(ACCOUNT, 25.0);
    await adjustAgentHwm(ACCOUNT, 24.915968);
    let f = await getAgentFinancials(ACCOUNT);
    assert.equal(Number(f.hwmUsdg.toFixed(6)), 49.915968, "both deposits raised the peak");

    // 20.000000 home to the owner. THE PEAK MUST FOLLOW THE CAPITAL.
    await adjustAgentHwm(ACCOUNT, -20.0);
    f = await getAgentFinancials(ACCOUNT);
    assert.equal(Number(f.hwmUsdg.toFixed(6)), 29.915968, "the withdrawal lowered the effective peak");
    // And it did so WITHOUT lowering anything: both stored halves only grew.
    assert.equal(Number(f.hwmGrossUsdg.toFixed(6)), 49.915968, "the gross is untouched — it is a ratchet");
    assert.equal(Number(f.hwmWithdrawnUsdg.toFixed(6)), 20.0, "the reduction is carried as its own total");
  });

  it("THE REGRESSION: the reduction survives mirror → rebuild → anchor", async () => {
    // The mirror needs a child HANDLE, not the store's singleton. Open the same
    // file a second time — which is also what the orchestrator does.
    const raw = childRaw();
    const child = wrapSqlite(raw);

    await mirrorTenant({ tenant: OWNER, child, shared: shared.db });

    const durable = (await shared.db
      .prepare("SELECT hwm_usdg, hwm_withdrawn_usdg FROM agents WHERE smart_account = ?")
      .get(ACCOUNT)) as { hwm_usdg: number; hwm_withdrawn_usdg: number };
    assert.equal(Number(durable.hwm_usdg.toFixed(6)), 49.915968, "the gross reached the shared row");
    assert.equal(
      Number(durable.hwm_withdrawn_usdg.toFixed(6)),
      20.0,
      "AND SO DID THE WITHDRAWAL — this is the assertion that was impossible before",
    );

    // ── the redeploy ──────────────────────────────────────────────────────
    raw.close();
    await rebuildChild();
    const afterRebuild = await getAgentFinancials(ACCOUNT);
    assert.equal(afterRebuild.hwmUsdg, 0, "a rebuilt child starts at the schema default, as it must");

    // ── the anchor, derived from the shared ledger by the real code ───────
    const anchor = await deriveBootstrapAccounting(shared.db, ACCOUNT);
    assert.equal(anchor.kind, "established", `the anchor must resolve: ${JSON.stringify(anchor)}`);
    const licence = accountingLicence({ kind: "valid", accounting: anchor } as never, { hosted: true });
    await restoreAgentHwmParts(ACCOUNT, {
      grossUsdg: licence.highWaterMarkUsdg === null ? null : Number(licence.highWaterMarkUsdg) / 1e6,
      withdrawnUsdg:
        licence.highWaterWithdrawnUsdg === null ? null : Number(licence.highWaterWithdrawnUsdg) / 1e6,
    });

    const restored = await getAgentFinancials(ACCOUNT);
    assert.equal(
      Number(restored.hwmUsdg.toFixed(6)),
      29.915968,
      "THE SAME CORRECTED PEAK — not the 49.915968 the upward-only ratchet used to restore",
    );
  });

  it("AND A FURTHER WITHDRAWAL STILL LANDS, which seeding the total at zero would lose", async () => {
    // The subtle half. If the rebuilt child had been seeded with withdrawn = 0,
    // this 5.785344 would make its local total SMALLER than the 20.000000 the
    // shared row already holds — and the ratchet, correctly on its own terms,
    // would discard it. The peak would silently stop falling after the first
    // withdrawal of an account's life.
    await adjustAgentHwm(ACCOUNT, -5.785344);
    const local = await getAgentFinancials(ACCOUNT);
    assert.equal(Number(local.hwmWithdrawnUsdg.toFixed(6)), 25.785344, "the child accumulated onto the durable total");

    const raw = childRaw();
    await mirrorTenant({ tenant: OWNER, child: wrapSqlite(raw), shared: shared.db });
    raw.close();

    const durable = (await shared.db
      .prepare("SELECT hwm_usdg, hwm_withdrawn_usdg FROM agents WHERE smart_account = ?")
      .get(ACCOUNT)) as { hwm_usdg: number; hwm_withdrawn_usdg: number };
    assert.equal(Number(durable.hwm_withdrawn_usdg.toFixed(6)), 25.785344, "and the shared row carried it");
    assert.equal(
      Number((durable.hwm_usdg - durable.hwm_withdrawn_usdg).toFixed(6)),
      24.130624,
      "the durable effective peak fell twice, across a redeploy",
    );
  });

  it("A REBUILT CHILD STILL CANNOT CLOBBER THE DURABLE PEAK WITH ITS ZEROES", async () => {
    // The property the upward-only ratchet was added for, which this change must
    // not cost. A container that has forgotten everything reports 0 and 0, and
    // BOTH ratchets must ignore both.
    await rebuildChild();
    const raw = childRaw();
    await mirrorTenant({ tenant: OWNER, child: wrapSqlite(raw), shared: shared.db });
    raw.close();

    const durable = (await shared.db
      .prepare("SELECT hwm_usdg, hwm_withdrawn_usdg FROM agents WHERE smart_account = ?")
      .get(ACCOUNT)) as { hwm_usdg: number; hwm_withdrawn_usdg: number };
    assert.equal(Number(durable.hwm_usdg.toFixed(6)), 49.915968, "the gross survived the empty child");
    assert.equal(
      Number(durable.hwm_withdrawn_usdg.toFixed(6)),
      25.785344,
      "and so did the withdrawn total — a forgotten zero is not a withdrawal being undone",
    );
  });
});

/**
 * THE TRAP THAT COST 5.000000 USDG OF SHOGUN'S PEAK, PINNED.
 *
 * `addFlow` inserts `ON CONFLICT DO NOTHING` and returns `true` whenever the
 * statement did not throw. For the deposit scanner that is fine: it pre-filters
 * on `knownFlowKeys`, and its `true` only ever has to mean "nothing failed".
 *
 * It is not fine for a caller that moves the high-water mark on the strength of
 * that return, because a duplicate is indistinguishable from a fresh row. The
 * class-sweep booking runs on EVERY reconcile pass, so it re-booked the same
 * 5.000000 withdrawal on every arm — 10.000000 off the peak in two — and
 * `adjustAgentHwm`'s clamp would have walked the effective peak to zero within a
 * few more. A zero peak does not merely understate the drawdown: `policy.ts`
 * applies the breaker only while the peak is above zero, so it switches the
 * guard off entirely.
 *
 * Both halves are asserted: the trap itself, so nobody "simplifies" the
 * read-before-write away on the reasonable-looking belief that the return value
 * already says this, and the check that replaces it.
 */
describe("a chain-log flow can be recognised as already booked", () => {
  const SWEEP_TX = "0x06cd8dba8f0000000000000000000000000000000000000000000000000000abcd";

  it("addFlow's TRUE does not mean it inserted — this is the trap", async () => {
    const { addFlow, hasChainFlow } = await import("./store");

    assert.equal(await hasChainFlow(ACCOUNT, SWEEP_TX, 7), false, "nothing booked yet");

    const first = await addFlow({
      agentId: ACCOUNT,
      direction: "out",
      amountUsdg: 5,
      source: "chain-log",
      txHash: SWEEP_TX,
      logIndex: 7,
      mode: "live",
      chainId: 4663,
    });
    assert.equal(first, true, "the first insert lands");
    assert.equal(await hasChainFlow(ACCOUNT, SWEEP_TX, 7), true, "and is visible afterwards");

    const second = await addFlow({
      agentId: ACCOUNT,
      direction: "out",
      amountUsdg: 5,
      source: "chain-log",
      txHash: SWEEP_TX,
      logIndex: 7,
      mode: "live",
      chainId: 4663,
    });
    assert.equal(
      second,
      true,
      "AND SO DOES THE DUPLICATE — ON CONFLICT DO NOTHING is silent, so this return " +
        "cannot gate anything that moves money",
    );
  });

  it("a DIFFERENT log on the same transaction is a different flow", async () => {
    // Two positions swept in one transaction are two withdrawals, and the log
    // index is what separates them. Keying on the hash alone would book one.
    const { hasChainFlow } = await import("./store");
    assert.equal(await hasChainFlow(ACCOUNT, SWEEP_TX, 8), false);
  });

  it("case does not hide a booked flow", async () => {
    // An RPC may hand back either case, and the repair path and the scanner
    // must agree about whether the same log is already on the books.
    const { hasChainFlow } = await import("./store");
    assert.equal(await hasChainFlow(ACCOUNT, SWEEP_TX.toUpperCase().replace("0X", "0x"), 7), true);
  });
});
