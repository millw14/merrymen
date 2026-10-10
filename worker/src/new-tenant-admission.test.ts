/**
 * GENUINELY NEW TENANTS (new-tenant-admission.ts): what "new" means, each
 * part of it on its own, every way a read can fail (each one "not new"), and
 * the durable record written before a first spawn.
 *
 * Over sqlite, through the same Db interface the orchestrator hands it a
 * Postgres pool through. The orchestrator wiring (who is leased, recorded and
 * spawned, in what order) is orchestrator-new-tenants.integration.test.ts.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import { wrapSqlite, type Db } from "./db";
import { FLEET_RECOVERY_SCHEMA } from "./fleet-recovery";
import { MIRROR_STATE_DDL } from "./ledger-mirror";
import { LEDGER_IMPORT_GENERATIONS_SCHEMA, LEDGER_IMPORT_SCHEMA, LEDGER_RESUME_SCHEMA } from "./ledger-import-schema";
import { sharedLedgerHistory } from "./ledger-import";
import { AUTO_PAPER_HEADROOM } from "./ledger-resume";
import {
  NEW_TENANT_ADMISSIONS_DDL,
  NEW_TENANT_HEADROOM,
  admitNewTenant,
  ensureNewTenantAdmissions,
  newTenantEvidenceDigest,
  newTenantRefusal,
  newTenantRoom,
  postgresHistory,
  readNewTenantAdmissions,
  volumeHistory,
  type NewTenantScope,
} from "./new-tenant-admission";
import { PAPER_CHECKPOINT_SCHEMA } from "./paper-checkpoint";
import { applyLedgerSchema } from "./store";

const root = mkdtempSync(path.join(os.tmpdir(), "merrymen-new-tenant-"));
const handles: DatabaseSync[] = [];
after(() => {
  for (const h of handles) h.close();
  rmSync(root, { recursive: true, force: true });
});

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
let next = 0x5000;
/** A fresh tenant, account and owner, and a volume layout of its own with nothing in it yet. */
function scopeFor(): NewTenantScope {
  const n = (next += 0x10);
  const dir = path.join(root, `v${n}`);
  mkdirSync(path.join(dir, "children"), { recursive: true });
  mkdirSync(path.join(dir, "archive"), { recursive: true });
  const tenant = address(n);
  return {
    tenant, account: address(n + 1), owner: address(n + 2), chainId: 4663,
    homes: [path.join(dir, "children", tenant)], archiveRoots: [path.join(dir, "archive")],
  };
}

/** The shared store as the new-book predicate needs it: the book's tables, mirror_state and paper_checkpoints. The resume tables only when asked. */
async function store(o: { resume?: boolean } = {}): Promise<{ raw: DatabaseSync; db: Db }> {
  const raw = new DatabaseSync(":memory:");
  handles.push(raw);
  const db = wrapSqlite(raw);
  await applyLedgerSchema(db);
  await db.exec(MIRROR_STATE_DDL);
  await db.exec(PAPER_CHECKPOINT_SCHEMA);
  if (o.resume) {
    await db.exec(LEDGER_IMPORT_SCHEMA);
    await db.exec(LEDGER_IMPORT_GENERATIONS_SCHEMA);
    for (const ddl of LEDGER_RESUME_SCHEMA) await db.exec(ddl);
    await db.exec(FLEET_RECOVERY_SCHEMA);
    await db.exec(RECOVERY_CONTROLS_DDL);
  }
  return { raw, db };
}

/** recovery-reply-arm.ts's journal, as recovery-reply-arm.test.ts creates it (PR #259 owns the real DDL). */
const RECOVERY_CONTROLS_DDL = `CREATE TABLE IF NOT EXISTS recovery_reply_controls (
 bot_id TEXT NOT NULL, update_id BIGINT NOT NULL, tenant TEXT NOT NULL, smart_account TEXT NOT NULL, chain_id BIGINT NOT NULL,
 token_tag TEXT NOT NULL, claim_stamp BIGINT NOT NULL, grant_tag TEXT NOT NULL, owner_id BIGINT NOT NULL, chat_id BIGINT NOT NULL,
 kind TEXT NOT NULL, request_update_id BIGINT, message_at_sec BIGINT NOT NULL, recorded_at_ms BIGINT NOT NULL, expires_at_ms BIGINT,
 PRIMARY KEY(bot_id,update_id))`;

/**
 * One row in `table`, with `values` as given and every other NOT NULL column
 * filled with something of its type, so a test states only the column the
 * check reads. Unique columns get a fresh value each call.
 */
let fill = 0;
function insert(raw: DatabaseSync, table: string, values: Record<string, string | number>): void {
  const cols = raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string; notnull: number; pk: number }>;
  const row: Record<string, string | number> = {};
  for (const c of cols) {
    if (c.name in values) row[c.name] = values[c.name]!;
    else if (c.notnull || c.pk) row[c.name] = /INT|REAL/i.test(c.type) ? ++fill : `fill-${++fill}`;
  }
  const names = Object.keys(row);
  raw.prepare(`INSERT INTO ${table} (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`).run(...names.map((n) => row[n]!));
}

const yes = () => true;

describe("newTenantRoom: the process cap, the way the automatic lane leaves it", () => {
  it("leaves the automatic lane's headroom free, and never goes below zero", () => {
    assert.equal(NEW_TENANT_HEADROOM, AUTO_PAPER_HEADROOM, "one reserve for both automatic lanes");
    assert.equal(newTenantRoom({ running: 30, cap: 48, namedWaiting: 0 }), 48 - NEW_TENANT_HEADROOM - 30);
    assert.equal(newTenantRoom({ running: 48 - NEW_TENANT_HEADROOM, cap: 48, namedWaiting: 0 }), 0);
    assert.equal(newTenantRoom({ running: 47, cap: 48, namedWaiting: 0 }), 0);
    assert.equal(newTenantRoom({ running: 60, cap: 48, namedWaiting: 0 }), 0);
  });

  it("is none at all while any tenant the list names waits for a slot", () => {
    assert.equal(newTenantRoom({ running: 0, cap: 48, namedWaiting: 1 }), 0);
  });
});

describe("the volume", () => {
  it("nothing there is nothing", () => {
    assert.equal(volumeHistory(scopeFor()), null);
  });

  it("a home in any state is history, an empty directory included, under any of its paths", () => {
    const s = scopeFor();
    const other = path.join(root, "elsewhere", "children", s.tenant);
    const both = { ...s, homes: [...s.homes, other] };
    assert.equal(volumeHistory(both), null);
    mkdirSync(other, { recursive: true });
    assert.match(volumeHistory(both)!, /home on the volume/);
    mkdirSync(s.homes[0]!, { recursive: true });
    assert.match(volumeHistory(s)!, /home on the volume/);
  });

  it("an archive of its home (archive/<tenant>) is history, the home gone or not", () => {
    const s = scopeFor();
    mkdirSync(path.join(s.archiveRoots[0]!, s.tenant, "gen-1"), { recursive: true });
    assert.match(volumeHistory(s)!, /archive of its home/);
  });

  it("a symlink or a file where the home would be is still something there", () => {
    const s = scopeFor();
    writeFileSync(s.homes[0]!, "not a directory");
    assert.match(volumeHistory(s)!, /home on the volume/);
  });

  it("a look that fails other than ENOENT throws rather than answer `nothing`", () => {
    const s = scopeFor();
    const file = path.join(root, `file-${next}`);
    writeFileSync(file, "x");
    // ENOTDIR: the parent of the home is a file.
    assert.throws(() => volumeHistory({ ...s, homes: [path.join(file, "children", s.tenant)] }), /ENOTDIR/);
  });
});

describe("Postgres history: each record on its own", () => {
  it("a clean store is no history, and the resume tables not being there yet is no history either", async () => {
    const { db } = await store();
    assert.equal(await postgresHistory(db, scopeFor()), null);
    const full = await store({ resume: true });
    assert.equal(await postgresHistory(full.db, scopeFor()), null);
  });

  it("every book table the new-book predicate reads, keyed by the account, whatever its case", async () => {
    const tables = ["trades", "events", "flows", "equity", "positions", "paper_book", "journal", "decisions", "agent_commands", "cost_basis", "risk_periods"];
    for (const table of tables) {
      const { raw, db } = await store();
      const s = scopeFor();
      insert(raw, table, { agent_id: s.account.toUpperCase().replace("0X", "0x") });
      assert.equal(await sharedLedgerHistory(db, s.tenant, s.account), table, table);
      assert.equal(await postgresHistory(db, s), `Postgres holds history for it (${table})`, table);
    }
  });

  it("an agents row for the account, a paper checkpoint, and a mirror cursor past zero", async () => {
    {
      const { raw, db } = await store();
      const s = scopeFor();
      insert(raw, "agents", { smart_account: s.account, owner_address: address(0xdead) });
      assert.match((await postgresHistory(db, s))!, /\(agents\)/);
    }
    {
      const { raw, db } = await store();
      const s = scopeFor();
      insert(raw, "paper_checkpoints", { agent_id: s.account });
      assert.match((await postgresHistory(db, s))!, /\(paper_checkpoints\)/);
    }
    {
      const { raw, db } = await store();
      const s = scopeFor();
      insert(raw, "mirror_state", { tenant: s.tenant, table_name: "trades", last_id: 7 });
      assert.match((await postgresHistory(db, s))!, /\(mirror_state\)/);
    }
  });

  it("ANY mirror cursor for the tenant, zero included and in any case: a worker ran for it, under this account or an earlier one", async () => {
    const { raw, db } = await store();
    const s = scopeFor();
    insert(raw, "mirror_state", { tenant: s.tenant.toUpperCase().replace("0X", "0x"), table_name: "trades", last_id: 0 });
    assert.equal(await sharedLedgerHistory(db, s.tenant, s.account), null, "the new-book question is narrower");
    assert.match((await postgresHistory(db, s))!, /a mirror cursor/);
  });

  it("an agent its owner key or its wallet registered, under any account (a re-created agent)", async () => {
    for (const who of ["owner", "tenant"] as const) {
      const { raw, db } = await store();
      const s = scopeFor();
      insert(raw, "agents", { smart_account: address(0xbeef00 + next), owner_address: s[who] });
      assert.match((await postgresHistory(db, s))!, /an agent registered by its owner/, who);
    }
  });

  it("each record beside the book: import receipts, resume approvals and attestations, archived pre-images, recovery holds, owner controls", async () => {
    const cases: Array<[string, (s: NewTenantScope) => Record<string, string | number>, RegExp]> = [
      ["tenant_ledger_import", (s) => ({ tenant: s.tenant, state: "deleted" }), /a ledger-import receipt/],
      ["tenant_ledger_import_generations", (s) => ({ tenant: s.tenant, state: "consumed" }), /a ledger-import generation/],
      ["ledger_resume_approvals", (s) => ({ tenant: address(1), smart_account: s.account, state: "revoked" }), /an attested-gap approval/],
      ["ledger_resume_approvals", (s) => ({ tenant: s.tenant, smart_account: address(1), state: "refused" }), /an attested-gap approval/],
      ["ledger_resume_attestations", (s) => ({ tenant: s.tenant, smart_account: s.account }), /an attested-gap attestation/],
      ["mirror_state_archive", (s) => ({ tenant: s.tenant }), /an archived mirror cursor/],
      ["ledger_snapshot_archive", (s) => ({ tenant: s.tenant }), /an archived snapshot row/],
      ["fleet_recovery_health", (s) => ({ tenant: s.tenant, smart_account: s.account, held: 0 }), /a recovery hold on record/],
      ["fleet_recovery_health", (s) => ({ tenant: address(2), smart_account: s.account, held: 1 }), /a recovery hold on record/],
      ["recovery_reply_controls", (s) => ({ tenant: s.tenant, smart_account: s.account, kind: "kill" }), /an owner control the recovery listener recorded/],
    ];
    for (const [table, values, why] of cases) {
      const { raw, db } = await store({ resume: true });
      const s = scopeFor();
      insert(raw, table, values(s));
      assert.match((await postgresHistory(db, s))!, why, table);
    }
  });

  it("another tenant's history is not this one's", async () => {
    const { raw, db } = await store({ resume: true });
    const s = scopeFor(), other = scopeFor();
    insert(raw, "trades", { agent_id: other.account });
    insert(raw, "mirror_state", { tenant: other.tenant, table_name: "trades", last_id: 3 });
    insert(raw, "agents", { smart_account: other.account, owner_address: other.owner });
    insert(raw, "tenant_ledger_import", { tenant: other.tenant, state: "consumed" });
    insert(raw, "fleet_recovery_health", { tenant: other.tenant, smart_account: other.account, held: 1 });
    assert.equal(await postgresHistory(db, s), null);
  });

  it("a Telegram row is not history: a brand-new owner configures their bot before the first worker", async () => {
    const { raw, db } = await store();
    raw.exec("CREATE TABLE tenant_telegram (tenant TEXT PRIMARY KEY, bot_token TEXT)");
    const s = scopeFor();
    raw.prepare("INSERT INTO tenant_telegram VALUES (?, 'x')").run(s.tenant);
    assert.equal(await postgresHistory(db, s), null);
  });
});

describe("newTenantRefusal: fails closed", () => {
  it("is null only for a tenant with nothing anywhere", async () => {
    const { db } = await store();
    assert.equal(await newTenantRefusal(db, scopeFor()), null);
  });

  it("the volume first, as a fact, without reading Postgres", async () => {
    const s = scopeFor();
    mkdirSync(s.homes[0]!);
    const exploding = { prepare: () => { throw new Error("must not be read"); } } as unknown as Db;
    assert.deepEqual(await newTenantRefusal(exploding, s), { why: "it has a home on the volume", fact: true, onVolume: true });
  });

  it("history is a fact; a fact is said as one", async () => {
    const { raw, db } = await store();
    const s = scopeFor();
    insert(raw, "flows", { agent_id: s.account });
    assert.deepEqual(await newTenantRefusal(db, s), { why: "Postgres holds history for it (flows)", fact: true });
  });

  it("a table the predicate needs that is not there is a store that cannot answer, never an empty one", async () => {
    for (const table of ["mirror_state", "paper_checkpoints", "trades", "agents"]) {
      const { raw, db } = await store();
      raw.exec(`DROP TABLE ${table}`);
      const r = await newTenantRefusal(db, scopeFor());
      assert.equal(r?.fact, false, table);
      assert.match(r!.why, /^its history could not be read \(Error( [A-Z_]+)?\)$/, table);
    }
  });

  it("an optional table with drifted columns throws rather than read as empty", async () => {
    const { raw, db } = await store();
    raw.exec("CREATE TABLE fleet_recovery_health (tenant TEXT)"); // no smart_account
    const r = await newTenantRefusal(db, scopeFor());
    assert.equal(r?.fact, false);
  });

  it("a store that will not answer, and one that answers garbage", async () => {
    const down = { prepare: () => ({ get: async () => { throw Object.assign(new Error("connect ECONNREFUSED 10.0.0.1"), { code: "ECONNREFUSED" }); }, all: async () => { throw Object.assign(new Error("x"), { code: "ECONNREFUSED" }); } }) } as unknown as Db;
    const r = await newTenantRefusal(down, scopeFor());
    assert.deepEqual(r, { why: "its history could not be read (Error ECONNREFUSED)", fact: false });
    assert.doesNotMatch(r!.why, /10\.0\.0\.1/, "never what the error said");
    const garbage = { prepare: () => ({ get: async () => ({ n: "not a number" }), all: async () => [] }) } as unknown as Db;
    assert.equal((await newTenantRefusal(garbage, scopeFor()))?.fact, true, "a count that is not zero is not zero");
  });

  it("a scope that is not lowercase addresses, a chain, and absolute places to look is refused, not answered", async () => {
    const { db } = await store();
    const s = scopeFor();
    const bad: NewTenantScope[] = [
      { ...s, tenant: s.tenant.toUpperCase() },
      { ...s, account: "0x1234" },
      { ...s, owner: "" },
      { ...s, chainId: 0 },
      { ...s, chainId: 1.5 },
      { ...s, homes: [] },
      { ...s, archiveRoots: [] },
      { ...s, homes: ["children/x"] },
    ];
    for (const b of bad) assert.equal((await newTenantRefusal(db, b))?.fact, false, JSON.stringify(b));
  });
});

describe("admitNewTenant: proved again, and recorded, under the caller's lease", () => {
  const level = "observe" as const;

  it("records a new tenant once, durably, with what was proved; a second ask reads the record and proves nothing", async () => {
    const { raw, db } = await store();
    const s = scopeFor();
    const first = await admitNewTenant(db, { ...s, level, nowMs: 1_700_000_000_000, mayWrite: yes });
    assert.deepEqual(first, { admitted: true, digest: newTenantEvidenceDigest(s, level), fresh: true });
    const row = raw.prepare("SELECT * FROM fleet_new_tenant_admissions").get() as Record<string, unknown>;
    assert.equal(row.tenant, s.tenant);
    assert.equal(row.smart_account, s.account);
    assert.equal(Number(row.chain_id), 4663);
    assert.equal(row.level_at_admission, "observe");
    assert.equal(Number(row.admitted_at_ms), 1_700_000_000_000);
    assert.deepEqual(await readNewTenantAdmissions(db), new Set([s.tenant]));
    // ITS FIRST SPAWN GIVES IT A HOME, AND SOON A HISTORY: the record still
    // admits it, which is the whole point of recording it.
    mkdirSync(s.homes[0]!);
    insert(raw, "trades", { agent_id: s.account });
    const again = await admitNewTenant(db, { ...s, level: "trade", nowMs: 1_800_000_000_000, mayWrite: yes });
    assert.deepEqual(again, { admitted: true, digest: first.admitted ? first.digest : "", fresh: false });
    assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM fleet_new_tenant_admissions").get() as { n: number }).n, 1);
    assert.equal((raw.prepare("SELECT level_at_admission AS l FROM fleet_new_tenant_admissions").get() as { l: string }).l, "observe", "never rewritten");
  });

  it("records nothing for a tenant that is not new, and says whether that is a fact", async () => {
    const { raw, db } = await store();
    const homed = scopeFor();
    mkdirSync(homed.homes[0]!);
    assert.deepEqual(await admitNewTenant(db, { ...homed, level, nowMs: 1, mayWrite: yes }),
      { admitted: false, why: "it has a home on the volume", fact: true, onVolume: true });
    const historied = scopeFor();
    insert(raw, "equity", { agent_id: historied.account });
    assert.deepEqual(await admitNewTenant(db, { ...historied, level, nowMs: 1, mayWrite: yes }),
      { admitted: false, why: "Postgres holds history for it (equity)", fact: true });
    assert.deepEqual(await readNewTenantAdmissions(db), new Set());
  });

  it("asks the lease before anything, before the insert, and after it inside the transaction, which rolls back", async () => {
    for (const loseAt of [1, 2, 3]) {
      const { db } = await store();
      const s = scopeFor();
      let asked = 0;
      const r = await admitNewTenant(db, { ...s, level, nowMs: 1, mayWrite: () => ++asked < loseAt });
      assert.deepEqual(r, { admitted: false, why: "the right to record it went first (its lease, FLEET_HALT, a hold, a kill, or the route itself)", fact: false }, `lost at ask ${loseAt}`);
      assert.deepEqual(await readNewTenantAdmissions(db), new Set(), `nothing recorded when lost at ask ${loseAt}`);
    }
  });

  it("an insert the store refuses records nothing and is not a fact", async () => {
    const { db } = await store();
    const r = await admitNewTenant(db, { ...scopeFor(), level: "held" as never, nowMs: 1, mayWrite: yes });
    assert.equal(r.admitted, false);
    assert.equal(r.admitted === false && r.fact, false);
    assert.match(r.admitted === false ? r.why : "", /the admission could not be recorded \(Error/);
  });

  it("a history read that fails records nothing", async () => {
    const { raw, db } = await store();
    raw.exec("DROP TABLE paper_checkpoints");
    const r = await admitNewTenant(db, { ...scopeFor(), level, nowMs: 1, mayWrite: yes });
    assert.equal(r.admitted, false);
    assert.equal(r.admitted === false && r.fact, false);
  });

  it("two at once (two replicas, or a retry) leave one row, and both admit", async () => {
    const { raw, db } = await store();
    const s = scopeFor();
    const [a, b] = await Promise.all([
      admitNewTenant(db, { ...s, level, nowMs: 1, mayWrite: yes }),
      admitNewTenant(db, { ...s, level, nowMs: 2, mayWrite: yes }),
    ]);
    assert.equal(a.admitted && b.admitted, true);
    assert.equal([a, b].filter((r) => r.admitted && r.fresh).length, 1, "exactly one wrote it");
    assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM fleet_new_tenant_admissions").get() as { n: number }).n, 1);
  });

  it("never throws, whatever the store does", async () => {
    const broken = { prepare: () => { throw new Error("boom"); }, exec: async () => { throw new Error("boom"); }, tx: async () => { throw new Error("boom"); } } as unknown as Db;
    const r = await admitNewTenant(broken, { ...scopeFor(), level, nowMs: 1, mayWrite: yes });
    assert.equal(r.admitted, false);
  });
});

describe("the record", () => {
  it("a table not made yet is nobody; any other read failure throws", async () => {
    const { raw, db } = await store();
    assert.deepEqual(await readNewTenantAdmissions(db), new Set());
    raw.exec("CREATE TABLE fleet_new_tenant_admissions (who TEXT)");
    await assert.rejects(readNewTenantAdmissions(db), /no such column/);
  });

  it("is read lowercase, and a row that is not an address admits nobody", async () => {
    const { raw, db } = await store();
    await ensureNewTenantAdmissions(db);
    const ins = raw.prepare("INSERT INTO fleet_new_tenant_admissions VALUES (?, ?, 1, 'trade', 1, 'd')");
    ins.run(address(0xabc).toUpperCase().replace("0X", "0x"), address(1));
    ins.run("not-a-tenant", address(1));
    ins.run(`${address(0xdef)} `, address(1));
    assert.deepEqual(await readNewTenantAdmissions(db), new Set([address(0xabc)]));
  });

  it("is made once per database, and a second maker is harmless", async () => {
    const { db } = await store();
    await Promise.all([ensureNewTenantAdmissions(db), ensureNewTenantAdmissions(db)]);
    await db.exec(NEW_TENANT_ADMISSIONS_DDL);
    assert.deepEqual(await readNewTenantAdmissions(db), new Set());
  });

  it("only accepts the three levels a worker enforces", async () => {
    const { raw, db } = await store();
    await ensureNewTenantAdmissions(db);
    assert.throws(() => raw.prepare("INSERT INTO fleet_new_tenant_admissions VALUES (?, ?, 1, 'held', 1, 'd')").run(address(9), address(1)), /CHECK/);
  });

  it("binds the tenant, its account, chain, owner and level, and nothing about where it was looked for", () => {
    const s = scopeFor();
    const d = newTenantEvidenceDigest(s, "trade");
    assert.match(d, /^[0-9a-f]{64}$/);
    assert.equal(newTenantEvidenceDigest({ ...s, homes: ["/elsewhere"] }, "trade"), d);
    for (const changed of [{ ...s, account: address(1) }, { ...s, owner: address(2) }, { ...s, chainId: 1 }, { ...s, tenant: address(3) }]) {
      assert.notEqual(newTenantEvidenceDigest(changed, "trade"), d);
    }
    assert.notEqual(newTenantEvidenceDigest(s, "observe"), d);
  });
});

describe("one predicate for history", () => {
  it("registerLedgerSource refuses on sharedLedgerHistory itself, so the two can never disagree", () => {
    const src = readFileSync(new URL("./ledger-import.ts", import.meta.url), "utf8");
    const body = src.slice(src.indexOf("export async function registerLedgerSource("));
    assert.match(body, /if \(await sharedLedgerHistory\(db, tenant, account\) !== null\) throw refuse\(\);/);
    assert.doesNotMatch(body.slice(0, body.indexOf("\n}\n")), /FROM paper_checkpoints|FROM mirror_state/, "no second copy of the predicate");
  });

  it("nothing a child runs imports this module, and nothing but the orchestrator writes the record", () => {
    const dir = path.dirname(new URL(import.meta.url).pathname);
    const writers: string[] = [];
    for (const name of ["orchestrator.ts", "index.ts", "worker.ts", "telegram-hold.ts"]) {
      let src: string;
      try { src = readFileSync(path.join(dir, name), "utf8"); } catch { continue; }
      if (/from "\.\/new-tenant-admission"/.test(src)) writers.push(name);
    }
    assert.deepEqual(writers, ["orchestrator.ts"]);
  });
});
