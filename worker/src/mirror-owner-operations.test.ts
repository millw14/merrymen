/**
 * OWNER OPERATIONS REACH POSTGRES BY THEIR IDENTITY, PER ACCOUNT, UNDER THE
 * MIRROR'S OWN TENANT, ON THE CHILD'S OWN id (never its clock) — and a child
 * that never had the table stops nothing.
 *
 * Against the real ledger schema on both sides (applyLedgerSchema), and again
 * through the Postgres translation of the mirror's own SQL, as
 * mirror-op-dedupe.test.ts does: production's destination is Postgres.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { translateQuery, wrapSqlite, type Db, type RunResult } from "./db";
import { MIRROR_STATE_DDL, mirrorCountsLine, mirrorTenant } from "./ledger-mirror";
import { applyLedgerSchema } from "./store";
import { OWNER_OPERATION_COLUMNS, ownerOperationOf, ownerOperationRow } from "./owner-operations";

type FixtureLog = [string, string[], string, string];
const FX = JSON.parse(readFileSync(new URL("./testdata/owner-operations-receipts.json", import.meta.url), "utf8")) as
  Record<string, { tx: string; block: string; timestamp: number; logs: FixtureLog[] }>;
const TENANT = "0x4b6dcd559c82ea897c34dacfb785fb0c8f85d4c5";
const ACCOUNT = "0xa96bf429888e1aab4255762d17d29c53f6a0370d";
const OTHER = `0x${"0b".repeat(20)}`;
const OTHER_TENANT = `0x${"0d".repeat(20)}`;
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const OPS = {
  invalidateNonce: "0x496e7211db25d250d9142105ab5024debcf05519c734d83191145af8eac09ffa",
  recoverFunds: "0x04f8241f6d02241469b9c2bc2d2f8cc4cca719eb5c6d54f3a77077c7e41ab3a7",
} as const;
const rowOf = (name: keyof typeof OPS, agentId = ACCOUNT) => {
  const f = FX[name]!;
  const r = ownerOperationOf({ receiptLogs: f.logs.map(([address, topics, data, logIndex]) => ({ address, topics, data, logIndex })), userOpHash: OPS[name],
    txHash: f.tx, account: ACCOUNT, custody: [], usdg: USDG, chainId: 4663 })!;
  return ownerOperationRow(r, { agentId, chainId: 4663, blockNumber: BigInt(f.block), blockTime: f.timestamp, recordedEpoch: 1 });
};

/** A child ledger on the current schema, holding the given owner operations at the given created_at. */
async function childWith(rows: Array<{ row: ReturnType<typeof rowOf>; at: number; tenant?: string }>, o: { dropTable?: boolean } = {}) {
  const raw = new DatabaseSync(":memory:");
  await applyLedgerSchema(wrapSqlite(raw));
  if (o.dropTable) raw.exec("DROP TABLE owner_operations");
  const cols = OWNER_OPERATION_COLUMNS;
  for (const { row, at, tenant } of rows) {
    raw.prepare(`INSERT INTO owner_operations (tenant, ${cols.join(", ")}, created_at) VALUES (?, ${cols.map(() => "?").join(", ")}, ?)`)
      .run(tenant ?? null, ...cols.map((c) => row[c]), at);
  }
  return { raw, db: wrapSqlite(raw) };
}

/** The mirror's SQL, run the way PgDb sends it: translated, then bound as $1..$n. */
function pgTranslated(raw: DatabaseSync): Db {
  const bind = (params: unknown[]) => Object.fromEntries(params.map((p, i) => [`$${i + 1}`, p])) as never;
  const db: Db = {
    prepare(sql: string) {
      const text = translateQuery(sql);
      return {
        run: async (...p: unknown[]) => raw.prepare(text).run(bind(p)) as RunResult,
        get: async (...p: unknown[]) => raw.prepare(text).get(bind(p)),
        all: async (...p: unknown[]) => raw.prepare(text).all(bind(p)),
      };
    },
    exec: async (sql: string) => raw.exec(sql),
    tx: async (fn) => {
      raw.exec("BEGIN");
      try { const out = await fn(db); raw.exec("COMMIT"); return out; } catch (e) { raw.exec("ROLLBACK"); throw e; }
    },
  };
  return db;
}

for (const [label, destination] of [
  ["sqlite", (raw: DatabaseSync) => wrapSqlite(raw)],
  ["the Postgres translation", pgTranslated],
] as const) {
  describe(`owner operations through the mirror — ${label}`, () => {
    const shared = async (o: { grant?: string | null } = {}) => {
      const raw = new DatabaseSync(":memory:");
      await applyLedgerSchema(wrapSqlite(raw));
      raw.exec(MIRROR_STATE_DDL);
      raw.exec("CREATE TABLE grants (tenant TEXT PRIMARY KEY, grant_json TEXT NOT NULL)");
      if (o.grant !== null) raw.prepare("INSERT INTO grants VALUES (?, ?)").run(TENANT, JSON.stringify({ smartAccount: o.grant ?? ACCOUNT }));
      return { raw, db: destination(raw) };
    };
    const held = (raw: DatabaseSync) => raw.prepare("SELECT tenant, agent_id, user_op_hash, disposition, created_at FROM owner_operations ORDER BY user_op_hash, agent_id").all() as
      Array<{ tenant: string; agent_id: string; user_op_hash: string; disposition: string; created_at: number }>;
    const cursor = (raw: DatabaseSync) => raw.prepare("SELECT last_id, last_stamp, updated_at FROM mirror_state WHERE tenant = ? AND table_name = 'owner_operations'").get(TENANT) as
      { last_id: number; last_stamp: number | null; updated_at: number } | undefined;
    const cols = OWNER_OPERATION_COLUMNS;
    const record = (raw: DatabaseSync, row: ReturnType<typeof rowOf>, at: number) =>
      raw.prepare(`INSERT INTO owner_operations (${cols.join(", ")}, created_at) VALUES (${cols.map(() => "?").join(", ")}, ?)`).run(...cols.map((c) => row[c]), at);

    it("copies each record once, stamped with the MIRROR's tenant (never the child's), and the next pass is silent and moves nothing", async () => {
      const s = await shared();
      const child = await childWith([{ row: rowOf("invalidateNonce"), at: 1000, tenant: OTHER }, { row: rowOf("recoverFunds"), at: 1010 }]);
      const r = await mirrorTenant({ tenant: TENANT, child: child.db, shared: s.db, nowSec: 2000 });
      assert.equal(r.failed, undefined);
      assert.equal(r.copied.owner_operations, 2);
      assert.deepEqual(held(s.raw).map((x) => [x.tenant, x.agent_id, x.disposition]), [[TENANT, ACCOUNT, "review"], [TENANT, ACCOUNT, "acknowledged"]]);
      assert.deepEqual({ ...cursor(s.raw) }, { last_id: 2, last_stamp: 1010, updated_at: 2000 }, "the child's own id, and that row's created_at as its witness");
      const again = await mirrorTenant({ tenant: TENANT, child: child.db, shared: s.db, nowSec: 3000 });
      assert.equal(again.copied.owner_operations, 0);
      assert.equal(again.copied.owner_operations_already_mirrored, undefined, "nothing is read twice");
      assert.deepEqual({ ...cursor(s.raw) }, { last_id: 2, last_stamp: 1010, updated_at: 2000 }, "a pass with nothing new does not say the book was written");
      assert.equal(mirrorCountsLine(TENANT, again)?.endsWith("idle"), true);
    });

    it("a CHILD FROM BEFORE THE TABLE is zero rows, not a failure: no cursor, nothing withheld", async () => {
      const s = await shared();
      const child = await childWith([], { dropTable: true });
      const r = await mirrorTenant({ tenant: TENANT, child: child.db, shared: s.db, nowSec: 2000 });
      assert.equal(r.failed, undefined, "finalMirrorBeforeAnchor, drains, retirement and the checkpoint all refuse on any failed table");
      assert.equal(r.copied.owner_operations, 0);
      assert.equal(cursor(s.raw), undefined, "and no trace of a table it never had");
      assert.equal(r.restarted, undefined);
    });

    it("any OTHER error reading the child is a failure, recorded and retried, as for every table", async () => {
      const s = await shared();
      const child = await childWith([]);
      child.raw.exec("ALTER TABLE owner_operations DROP COLUMN recorded_epoch");
      const r = await mirrorTenant({ tenant: TENANT, child: child.db, shared: s.db, nowSec: 2000 });
      assert.match(r.failed?.owner_operations ?? "", /recorded_epoch/);
    });

    it("a record under ANOTHER account is never copied, is counted once when passed, and the cursor passes it", async () => {
      const s = await shared();
      const child = await childWith([{ row: rowOf("recoverFunds", OTHER), at: 1000 }, { row: rowOf("invalidateNonce"), at: 1001 }]);
      const r = await mirrorTenant({ tenant: TENANT, child: child.db, shared: s.db, nowSec: 2000 });
      assert.equal(r.copied.owner_operations, 1);
      assert.equal(r.copied.owner_operations_foreign, 1);
      assert.deepEqual(held(s.raw).map((x) => x.agent_id), [ACCOUNT]);
      assert.match(mirrorCountsLine(TENANT, r) ?? "", /\+1 rows \(.*owner_operations 1.*\) · not copied 1 \(owner_operations foreign 1\)/);
      assert.equal(cursor(s.raw)?.last_id, 2);
      const again = await mirrorTenant({ tenant: TENANT, child: child.db, shared: s.db, nowSec: 3000 });
      assert.equal(again.copied.owner_operations_foreign, undefined, "said once, on the pass that passed it");
    });

    it("a row that is not a full root record is never copied by any account: counted apart as invalid, and passed", async () => {
      const s = await shared();
      const child = await childWith([{ row: { ...rowOf("recoverFunds"), user_op_hash: OPS.recoverFunds.toUpperCase().replace(/^0X/, "0x") }, at: 1000 },
        { row: { ...rowOf("recoverFunds"), tx_hash: "0x1234" }, at: 1001 }, { row: rowOf("invalidateNonce"), at: 1002 }]);
      const r = await mirrorTenant({ tenant: TENANT, child: child.db, shared: s.db, nowSec: 2000 });
      assert.equal(r.copied.owner_operations, 1);
      assert.equal(r.copied.owner_operations_invalid, 2);
      assert.equal(r.copied.owner_operations_foreign, undefined);
      assert.deepEqual(held(s.raw).map((x) => x.user_op_hash), [OPS.invalidateNonce]);
      assert.match(mirrorCountsLine(TENANT, r) ?? "", /not copied 2 \(owner_operations invalid 2\)/);
      assert.equal(cursor(s.raw)?.last_id, 3);
    });

    it("the account comes from the orchestrator (the argument) or its grant, never the child: with neither, nothing is copied and nothing advances", async () => {
      const s = await shared({ grant: null });
      const child = await childWith([{ row: rowOf("recoverFunds"), at: 1000 }]);
      const r = await mirrorTenant({ tenant: TENANT, child: child.db, shared: s.db, nowSec: 2000 });
      assert.equal(r.failed, undefined);
      assert.equal(r.copied.owner_operations, 0);
      assert.equal(r.copied.owner_operations_unattributed, 1);
      assert.equal(cursor(s.raw), undefined, "left for a pass that can name the account");
      assert.match(mirrorCountsLine(TENANT, r) ?? "", /no new rows · not copied 1 \(owner_operations unattributed 1\)/);
      const still = await mirrorTenant({ tenant: TENANT, child: child.db, shared: s.db, nowSec: 2050 });
      assert.equal(still.copied.owner_operations_unattributed, 1, "said on every pass that cannot place it, never skipped silently");
      // The argument names it.
      const named = await mirrorTenant({ tenant: TENANT, child: child.db, shared: s.db, nowSec: 2100, account: ACCOUNT });
      assert.equal(named.copied.owner_operations, 1);
      // A grant naming another account makes the child's row foreign.
      const other = await shared({ grant: OTHER });
      const foreign = await mirrorTenant({ tenant: TENANT, child: child.db, shared: other.db, nowSec: 2000 });
      assert.equal(foreign.copied.owner_operations_foreign, 1);
      assert.deepEqual(held(other.raw), []);
    });

    it("an argument that DISAGREES with the grant places nothing and passes nothing: a stale account never turns a genuine record foreign", async () => {
      const s = await shared({ grant: ACCOUNT });
      const child = await childWith([{ row: rowOf("recoverFunds"), at: 1000 }]);
      const r = await mirrorTenant({ tenant: TENANT, child: child.db, shared: s.db, nowSec: 2000, account: OTHER });
      assert.equal(r.copied.owner_operations, 0);
      assert.equal(r.copied.owner_operations_unattributed, 1);
      assert.equal(r.copied.owner_operations_foreign, undefined);
      assert.equal(cursor(s.raw), undefined, "the cursor did not pass it");
      const agreed = await mirrorTenant({ tenant: TENANT, child: child.db, shared: s.db, nowSec: 2100, account: ACCOUNT });
      assert.equal(agreed.copied.owner_operations, 1, "copied by the first pass whose account the grant agrees with");
      assert.deepEqual(held(s.raw).map((x) => [x.tenant, x.agent_id]), [[TENANT, ACCOUNT]]);
    });

    it("a REBUILT child that records the same operation again adds nothing: its witness differs, it is read from the start, and the re-recorded one is counted once", async () => {
      const s = await shared();
      const first = await childWith([{ row: rowOf("recoverFunds"), at: 1000 }]);
      await mirrorTenant({ tenant: TENANT, child: first.db, shared: s.db, nowSec: 2000 });
      const rebuilt = await childWith([{ row: rowOf("invalidateNonce"), at: 5000 }, { row: rowOf("recoverFunds"), at: 5001 }]);
      const r = await mirrorTenant({ tenant: TENANT, child: rebuilt.db, shared: s.db, nowSec: 6000 });
      assert.equal(r.restarted, undefined, "a re-read of this table can neither duplicate nor lose a record, so it is no restart");
      assert.equal(r.copied.owner_operations, 1, "the new one");
      assert.equal(r.copied.owner_operations_already_mirrored, 1, "the re-recorded one, said once");
      assert.equal(held(s.raw).length, 2);
      assert.equal(held(s.raw).find((x) => x.user_op_hash === OPS.recoverFunds)!.created_at, 1000, "the first record stands");
      assert.deepEqual({ ...cursor(s.raw) }, { last_id: 2, last_stamp: 5001, updated_at: 6000 });
      const again = await mirrorTenant({ tenant: TENANT, child: rebuilt.db, shared: s.db, nowSec: 7000 });
      assert.equal(again.copied.owner_operations_already_mirrored, undefined);
    });

    it("a rebuilt child holding only what Postgres has does not say the book was written; an empty one forgets the cursor", async () => {
      const s = await shared();
      const first = await childWith([{ row: rowOf("recoverFunds"), at: 1000 }, { row: rowOf("invalidateNonce"), at: 1001 }]);
      await mirrorTenant({ tenant: TENANT, child: first.db, shared: s.db, nowSec: 2000 });
      const same = await childWith([{ row: rowOf("invalidateNonce"), at: 4000 }]);
      const r = await mirrorTenant({ tenant: TENANT, child: same.db, shared: s.db, nowSec: 5000 });
      assert.equal(r.copied.owner_operations, 0);
      assert.equal(r.copied.owner_operations_already_mirrored, 1);
      assert.deepEqual({ ...cursor(s.raw) }, { last_id: 1, last_stamp: 4000, updated_at: 2000 }, "the cursor follows the new ledger; updated_at keeps what it said");
      const empty = await childWith([]);
      const e = await mirrorTenant({ tenant: TENANT, child: empty.db, shared: s.db, nowSec: 6000 });
      assert.equal(e.copied.owner_operations, 0);
      assert.deepEqual({ ...cursor(s.raw) }, { last_id: 0, last_stamp: null, updated_at: 2000 });
      record(empty.raw, rowOf("recoverFunds", ACCOUNT), 6500);
      const next = await mirrorTenant({ tenant: TENANT, child: empty.db, shared: s.db, nowSec: 7000 });
      assert.equal(next.copied.owner_operations_already_mirrored, 1, "read from the start of the new ledger");
      assert.deepEqual({ ...cursor(s.raw) }, { last_id: 1, last_stamp: 6500, updated_at: 7000 }, "a row no pass had passed moves updated_at");
    });

    it("a CLOCK THAT STEPPED BACK by far more than any overlap loses nothing: the cursor is the child's id, not its clock", async () => {
      const s = await shared();
      const child = await childWith([{ row: rowOf("invalidateNonce"), at: 1_000_000 }]);
      await mirrorTenant({ tenant: TENANT, child: child.db, shared: s.db, nowSec: 1_000_100 });
      record(child.raw, rowOf("recoverFunds"), 1_000_000 - 86_400);
      const r = await mirrorTenant({ tenant: TENANT, child: child.db, shared: s.db, nowSec: 1_000_200 });
      assert.equal(r.copied.owner_operations, 1);
      assert.equal(held(s.raw).length, 2);
      assert.deepEqual({ ...cursor(s.raw) }, { last_id: 2, last_stamp: 1_000_000 - 86_400, updated_at: 1_000_200 });
    });

    it("a cursor an earlier build wrote (a created_at watermark, no witness) is not trusted: read from the start, and a record Postgres lacks is copied", async () => {
      const s = await shared();
      const child = await childWith([{ row: rowOf("invalidateNonce"), at: 900 }, { row: rowOf("recoverFunds"), at: 950 }]);
      s.raw.prepare("INSERT INTO mirror_state (tenant, table_name, last_id, last_stamp, updated_at) VALUES (?, 'owner_operations', 5000, NULL, 1234)").run(TENANT);
      const r = await mirrorTenant({ tenant: TENANT, child: child.db, shared: s.db, nowSec: 6000 });
      assert.equal(r.copied.owner_operations, 2);
      assert.deepEqual({ ...cursor(s.raw) }, { last_id: 2, last_stamp: 950, updated_at: 6000 });
    });

    it("ANOTHER TENANT'S CHILD CANNOT PRE-EMPT a genuine record: the identity is per account", async () => {
      const s = await shared();
      s.raw.prepare("INSERT INTO grants VALUES (?, ?)").run(OTHER_TENANT, JSON.stringify({ smartAccount: OTHER }));
      // The other tenant's child records THIS account's operation hash under its own account, and its pass runs first.
      const theirs = await childWith([{ row: rowOf("invalidateNonce", OTHER), at: 1000 }]);
      const first = await mirrorTenant({ tenant: OTHER_TENANT, child: theirs.db, shared: s.db, nowSec: 1100 });
      assert.equal(first.copied.owner_operations, 1, "copied under the other tenant, under its own account");
      const ours = await childWith([{ row: rowOf("invalidateNonce"), at: 1050 }]);
      const r = await mirrorTenant({ tenant: TENANT, child: ours.db, shared: s.db, nowSec: 1200 });
      assert.equal(r.copied.owner_operations, 1, "the genuine record lands");
      assert.equal(r.copied.owner_operations_already_mirrored, undefined);
      assert.deepEqual(held(s.raw).map((x) => [x.tenant, x.agent_id]), [[OTHER_TENANT, OTHER], [TENANT, ACCOUNT]]);
    });

    it("more than a batch says so (hasMore), and the next pass carries on", async () => {
      const s = await shared();
      const child = await childWith([]);
      const base = rowOf("invalidateNonce");
      for (let i = 0; i < 5; i++) record(child.raw, { ...base, user_op_hash: `0x${i.toString(16).padStart(64, "0")}` }, 1000 + i * 1000);
      const r = await mirrorTenant({ tenant: TENANT, child: child.db, shared: s.db, nowSec: 9000, batch: 3 });
      assert.equal(r.hasMore, true);
      assert.equal(r.copied.owner_operations, 3);
      const next = await mirrorTenant({ tenant: TENANT, child: child.db, shared: s.db, nowSec: 9100, batch: 3 });
      assert.equal(next.copied.owner_operations, 2);
      assert.notEqual(next.hasMore, true);
    });
  });
}
