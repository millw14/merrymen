/**
 * THE ANCHOR IS DERIVED AFTER THE DEAD CHILD'S LEDGER IS MIRRORED (R2-MONEY6).
 *
 * The child's durable contributions are the anchor's figure (the shared
 * database at spawn) plus the flows it books at or after the anchor's
 * `generatedAt` (net-contributions.ts). The mirror copies a child every fifteen
 * seconds, so a child that booked a flow and died inside that window left it
 * in its own sqlite only — and a crash or watchdog restart, which keeps that
 * sqlite and respawns within a second or two, wrote an anchor without it while
 * the flow was dated before the anchor. It was in neither half: an energy
 * purchase read as a 10 USDG loss for the new child's whole life.
 *
 * Run against the real schema on both sides (applyLedgerSchema) and the real
 * mirror, through the orchestrator's own writeBootstrapForChild.
 *
 * MERRYMEN_HOME is set before the orchestrator import; node's --test runs each
 * file in its own process, so the override never leaks.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-anchor-mirror-"));
process.env.MERRYMEN_HOME = HOME;
process.env.MERRYMEN_HOSTED = "1";
// Present so writeBootstrapForChild takes the hosted branch; never dialled —
// the test hands it the shared database.
process.env.DATABASE_URL = "postgres://unused-by-this-test";

const { DatabaseSync } = await import("node:sqlite");
const { wrapSqlite } = await import("./db");
const { applyLedgerSchema } = await import("./store");
const { MIRROR_STATE_DDL, mirrorTenant } = await import("./ledger-mirror");
const { deriveBootstrapAccounting } = await import("./bootstrap-source");
const { readAnchor, microToBigint } = await import("./bootstrap-state");
const { durableNetContributionsUsdg6 } = await import("./net-contributions");
const { childHome, finalMirrorBeforeAnchor, writeBootstrapForChild } = await import("./orchestrator");

const TENANT = "0x00000000000000000000000000000000000a11ce" as const;
const SMART = "0x0000000000000000000000000000000000005a1e" as const;
const U = 1_000_000n;

type Raw = InstanceType<typeof DatabaseSync>;
let childRaw: Raw;
let sharedRaw: Raw;
const child = () => wrapSqlite(childRaw);
const shared = () => wrapSqlite(sharedRaw);
const nowSec = () => Math.floor(Date.now() / 1000);

function flow(direction: "in" | "out", amount: number, source: string, at: number, tx: string | null, logIndex: number | null): void {
  childRaw
    .prepare(
      `INSERT INTO flows (agent_id, direction, amount_usdg, tx_hash, block_number, log_index, source, epoch, chain_id, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 4663, ?)`,
    )
    .run(SMART, direction, amount, tx, tx ? 9_000_000 : null, logIndex, source, at);
}
const sharedNet = () =>
  Number(
    (sharedRaw.prepare("SELECT COALESCE(SUM(CASE WHEN direction = 'in' THEN amount_usdg ELSE -amount_usdg END), 0) AS n FROM flows WHERE agent_id = ?").get(SMART) as { n: number }).n,
  );
const sharedFlows = () => Number((sharedRaw.prepare("SELECT COUNT(*) AS n FROM flows WHERE agent_id = ?").get(SMART) as { n: number }).n);

before(async () => {
  const home = childHome(TENANT);
  mkdirSync(home, { recursive: true });
  childRaw = new DatabaseSync(path.join(home, "merrymen.db"));
  await applyLedgerSchema(child());
  sharedRaw = new DatabaseSync(":memory:");
  await applyLedgerSchema(shared());
  sharedRaw.exec(MIRROR_STATE_DDL);
  childRaw
    .prepare(
      `INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, status, hwm_usdg)
       VALUES (?, ?, ?, 4663, '{}', 1700000000, 2000000000, 'armed', 100)`,
    )
    .run(SMART, TENANT, "0x00000000000000000000000000000000000000fe");
  // The owner's 100 USDG, booked long ago and mirrored on an ordinary pass.
  flow("in", 100, "chain-log", nowSec() - 3_600, `0x${"d0".repeat(32)}`, 1);
  await mirrorTenant({ tenant: TENANT, child: child(), shared: shared() });
  assert.equal(sharedNet(), 100);
});
after(() => {
  childRaw.close();
  sharedRaw.close();
  rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("a crash restart's anchor includes what the dead child booked since the last mirror pass", () => {
  it("THE HOLE: the child buys energy (−10) and dies before the next pass — the shared sum still says 100", async () => {
    flow("out", 10, "energy-buy", nowSec() - 5, `0x${"e0".repeat(32)}`, 17);
    const stale = await deriveBootstrapAccounting(shared(), SMART, nowSec());
    assert.equal(stale.kind, "established");
    assert.equal(microToBigint((stale as { netContributionsUsdg: string }).netContributionsUsdg), 100n * U, "the purchase is not in the shared sum");
    // …and it is dated BEFORE any anchor written now, so the child's "since" half misses it too.
    const since = Number((childRaw.prepare("SELECT COUNT(*) AS n FROM flows WHERE at >= ?").get(nowSec()) as { n: number }).n);
    assert.equal(since, 0);
  });

  it("THE FIX: writeBootstrapForChild mirrors the dead child's ledger first, so the anchor says 90 and the child's durable figure is 90", async () => {
    await writeBootstrapForChild(TENANT, SMART, shared());
    assert.equal(sharedNet(), 90, "the purchase reached the shared database before the anchor was derived");
    const v = readAnchor(childHome(TENANT), { tenantId: SMART.toLowerCase() });
    assert.equal(v.kind, "valid");
    if (v.kind !== "valid" || v.accounting.kind !== "established") throw new Error("expected an established anchor");
    const anchorNet = microToBigint(v.accounting.netContributionsUsdg);
    assert.equal(anchorNet, 90n * U);
    // What the new child will compute: the anchor plus its flows at or after generatedAt — none of them the old child's.
    const local = childRaw
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN direction = 'in' THEN amount_usdg ELSE -amount_usdg END), 0) AS net,
                COALESCE(SUM(CASE WHEN at >= ? THEN (CASE WHEN direction = 'in' THEN amount_usdg ELSE -amount_usdg END) ELSE 0 END), 0) AS since
           FROM flows WHERE agent_id = ? AND epoch = 1`,
      )
      .get(v.state.generatedAt, SMART) as { net: number; since: number };
    assert.equal(local.since, 0, "every flow the final pass carried is dated before the anchor");
    assert.equal(
      durableNetContributionsUsdg6({ anchorNetUsdg6: anchorNet, anchorEpoch: v.accounting.accountingEpoch, epoch: 1, localNetUsdg: local.net, localSinceAnchorUsdg: local.since }),
      90n * U,
    );
  });

  it("TWO PASSES AT ONCE COPY EACH ROW ONCE: the spawn's final pass and a loop pass over the same tenant are serialised", async () => {
    // An inferred flow has no chain identity, so only the watermark stands
    // between two concurrent passes and a duplicate in the contributions sum.
    flow("in", 7, "inferred", nowSec() - 2, null, null);
    const before = sharedFlows();
    const [a, b] = await Promise.all([finalMirrorBeforeAnchor(TENANT, shared()), finalMirrorBeforeAnchor(TENANT, shared())]);
    assert.equal(a && b, true);
    assert.equal(sharedFlows(), before + 1, "copied once, not twice");
    assert.equal(sharedNet(), 97);
  });

  it("A REDEPLOY LEAVES NO LEDGER: nothing to copy, and the anchor is derived as before", async () => {
    assert.equal(await finalMirrorBeforeAnchor(TENANT, shared(), path.join(HOME, "children", "0xnobody")), false);
  });
});
