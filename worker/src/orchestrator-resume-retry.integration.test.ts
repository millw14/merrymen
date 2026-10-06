/**
 * AN ATTESTED BOOK WHOSE FIRST SPAWN WAS REFUSED AFTER ITS SEEDS IS ADMITTED
 * ON A LATER PASS — AND THE SIX TENANTS PRODUCTION LEFT THAT WAY ARE TOO.
 *
 * What production saw (deployment 64ee6698, main@dd5dc6c5): six paper tenants
 * archived ("carried telegram.json"), registered, seeded, then refused by the
 * offset handoff, and on every later pass "persistent original book is
 * unconfirmed", for good. Two faults: the carried telegram.json was the
 * orchestrator's restored link, which has no offset and which the handoff
 * refuses; and the seeds (the restored practice book, the basis, the floors)
 * left rows in a book no worker had armed on, which the ordinary gates'
 * existingBookIdentity refused on the next pass however the first refusal
 * cleared.
 *
 * Driven through the real reconcile() with the recovery gates live: the
 * shared database is a sqlite stand-in where the orchestrator has a seam for
 * it, and DATABASE_URL names an address nothing answers (as in
 * orchestrator-spawn-guard.test.ts), so the privacy proof and the offset
 * handoff run as they do in production. The grant and settings stores are
 * taken before it is set, so they stay on files. The paper restore is a seam
 * that writes what restorePaperCheckpoint writes: a practice book and its
 * paper basis, and no agent row; and the day's energy, which
 * seedEnergyForChild writes before the handoff in production.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, it } from "node:test";
import type { ChildProcess } from "node:child_process";
import type { StoredGrant } from "../../packages/core/src/index";
import { wrapSqlite } from "./db";
import { applyLedgerSchema } from "./store";
import { MIRROR_STATE_DDL } from "./ledger-mirror";
import { PAPER_CHECKPOINT_SCHEMA } from "./paper-checkpoint";
import { RECOVERY_REPLY_SCHEMA, sealRecoveryReplyState } from "./recovery-reply-state";
import { TG_GROUPS_TABLE_SQL } from "./tg-groups-ferry";
import { PERSONAL_MEMORY_TABLE_SQL } from "./personal-memory-ferry";
import type { TenantLease } from "./tenant-lease";

const fleet = realpathSync(mkdtempSync(path.join(os.tmpdir(), "merrymen-resume-retry-")));
process.env.MERRYMEN_HOME = fleet;
process.env.MERRYMEN_HOSTED = "1";
delete process.env.DATABASE_URL;
const dek = Buffer.alloc(32, 23);
process.env.MERRYMEN_STORE_DEK = dek.toString("base64");

const orch = await import("./orchestrator");
const { childHome, reconcile, setSpawnForTest, setRetirementMemoryStoreForTest, setPaperRestoreForTest, setPersistentHomeVerifierForTest,
  setLeaseAcquireForTest, setResumeChainForTest, runResumeAdmissionControlsForTest, setKillConfirmForTest, setBasisSeedSharedForTest,
  setPersonalMemoryStoreForTest } = orch;
// Taken now, while DATABASE_URL is unset, so both stay on files for the whole file.
const grants = (await import("./grant-store")).getGrantStore();
const settingsStore = (await import("./settings-store")).getSettingsStore();
// A hosted deployment from here on: the privacy proof and the offset handoff
// run. Nothing answers at this address; the gates read the stand-in below.
process.env.DATABASE_URL = "postgres://resume-retry.invalid/not-a-real-connection";

const raw = new DatabaseSync(":memory:"), shared = wrapSqlite(raw);
await applyLedgerSchema(shared); await shared.exec(MIRROR_STATE_DDL); await shared.exec(PAPER_CHECKPOINT_SCHEMA);
raw.exec(RECOVERY_REPLY_SCHEMA + TG_GROUPS_TABLE_SQL + PERSONAL_MEMORY_TABLE_SQL);
raw.exec("CREATE TABLE grants(tenant TEXT PRIMARY KEY,grant_json TEXT NOT NULL,updated_at INTEGER NOT NULL,row_version INTEGER NOT NULL)");
const volumeStat = lstatSync(fleet, { bigint: true });
setPersistentHomeVerifierForTest(() => ({ id: "vol_resume_retry", mountPath: fleet, homeRoot: fleet, device: String(volumeStat.dev), inode: String(volumeStat.ino) }));
setRetirementMemoryStoreForTest({ shared, dek, dialect: "sqlite" });
setPersonalMemoryStoreForTest({ shared, dek, dialect: "sqlite" });
setBasisSeedSharedForTest(shared);
setKillConfirmForTest(async () => {});
setResumeChainForTest(() => { throw new Error("a paper tenant must not read the chain"); });
const unhealthy = new Set<string>();
setLeaseAcquireForTest(async (tenant) => ({ tenant, backend: "postgres", healthy: () => !unhealthy.has(tenant), async release() {} }) as TenantLease);

/** What restorePaperCheckpoint writes into an empty book: the practice book and its paper basis. Never an agent row. */
let afterRestore: ((tenant: string) => void | Promise<void>) | null = null;
/** Tenants whose practice book will not restore: spawnChild holds them (spawnHolder). */
const unrestorable = new Set<string>();
setPaperRestoreForTest(async (tenant, account) => {
  if (unrestorable.has(tenant)) return { ok: false, reason: "paper fills are newer than the recoverable valuation" };
  const book = new DatabaseSync(path.join(childHome(tenant), "merrymen.db"));
  let line: string;
  try {
    await applyLedgerSchema(wrapSqlite(book));
    if (book.prepare("SELECT 1 FROM paper_book WHERE agent_id = ?").get(account)) line = "local book retained";
    else {
      book.prepare("INSERT INTO paper_book (agent_id, cash_usdg, vault_usdg, hwm_usdg, shares, updated_at) VALUES (?, 90, 0, 100, '{}', 1)").run(account);
      book.prepare("INSERT INTO cost_basis VALUES (?, 'paper', 'COIN', '10', '20', 1)").run(account);
      // And the day's energy, which seedEnergyForChild writes before the
      // privacy proof and the handoff in production; its own seed cannot
      // reach this harness's shared stand-in, so it is written here.
      book.prepare("INSERT OR IGNORE INTO energy_days (agent_id, day, reviews, entries) VALUES (?, '2026-10-05', 3, 1)").run(account);
      line = "paper cash, holdings and basis restored";
    }
  } finally { book.close(); }
  await afterRestore?.(tenant);
  return { ok: true, line };
});

class FakeProc extends EventEmitter {
  readonly stdout = null; readonly stderr = null;
  constructor(readonly pid: number) { super(); }
  kill() { return true; }
}
const forks: string[] = [], holds: string[] = [];
setSpawnForTest((_c, args, options) => {
  if (args.some((a) => a.endsWith("telegram-hold.ts"))) holds.push(String(options.env?.MERRYMEN_HOME));
  else forks.push(String(options.env?.MERRYMEN_HOME));
  return new FakeProc(70_000 + forks.length + holds.length) as unknown as ChildProcess;
});

const said: string[] = [];
const realLog = console.log;
console.log = (...a: unknown[]) => { said.push(a.map(String).join(" ")); };

after(() => {
  console.log = realLog;
  setRetirementMemoryStoreForTest(null); setPersonalMemoryStoreForTest(null); setPaperRestoreForTest(null); setPersistentHomeVerifierForTest(null);
  setLeaseAcquireForTest(null); setResumeChainForTest(null); setBasisSeedSharedForTest(null);
  raw.close(); rmSync(fleet, { recursive: true, force: true });
});

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const nowSec = () => Math.floor(Date.now() / 1000);
const OLD = nowSec() - 5 * 86_400;
const grant = (account: `0x${string}`, owner: `0x${string}`, n = 1): StoredGrant => ({
  smartAccount: account, owner, sessionKeyAddress: addr(0x5e5), serialized: `fixture-resume-retry-${account}-${n}`,
  chainId: 4663, grantedAt: nowSec() - 60, expiresAt: nowSec() + 86_400,
  caps: { perTradeUsdg: 10, dailyUsdg: 50, maxDrawdownPct: 20, expiryDays: 7 },
  grantFeatures: ["tradeable-v2"], grantTokens: [], demoSessionPrivateKey: `0x${"ab".repeat(32)}`,
}) as unknown as StoredGrant;
async function putGrant(tenant: `0x${string}`, g: StoredGrant) {
  await grants.put(tenant, g);
  raw.prepare("INSERT INTO grants VALUES (?, ?, ?, 1) ON CONFLICT (tenant) DO UPDATE SET grant_json = excluded.grant_json, updated_at = excluded.updated_at, row_version = grants.row_version + 1")
    .run(tenant, JSON.stringify({ smartAccount: g.smartAccount, owner: g.owner, chainId: g.chainId }), nowSec());
}

/** The restored link exactly as writeTelegramForChild writes it (restoredTelegramFile): no offset at all. */
const RESTORED_LINK = { linkCode: "K7M2QX", ownerId: 555, linkedAt: 1_790_000_000 };

let seq = 0;
/**
 * One pre-incident paper tenant with a bot: its Postgres history and cursors,
 * its blocked home on the volume (with `telegram` as its telegram.json), its
 * grant, and settings that switch its bot on.
 */
async function preIncident(o: { telegram?: { body: string; mode: number } } = {}) {
  seq += 1;
  const tenant = addr(0xc00000 + seq), account = addr(0xcac000 + seq), owner = addr(0xd00000 + seq), bot = String(9100 + seq);
  raw.prepare(`INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, status, epoch, hwm_usdg, mode)
    VALUES (?, ?, ?, 4663, '{}', 1, 9999999999, 'armed', 2, 120, 'paper')`).run(account, owner, addr(1));
  raw.prepare("INSERT INTO trades (agent_id, kind, target, amount_usdg, status, created_at, epoch) VALUES (?, 'swap', 'x', 5, 'paper', ?, 2)").run(account, OLD);
  raw.prepare("INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, at, epoch, mode) VALUES (?, '0', 90, 0, 10, 100, ?, 2, 'paper')").run(account, OLD);
  raw.prepare("INSERT INTO positions (agent_id, symbol, token, raw_balance, ui_multiplier, price_usd, price_stale, price_source, value_usdg, updated_at) VALUES (?, 'COIN', ?, '10', '1', 1, 0, 'pool', 10, ?)").run(account, addr(5), OLD);
  raw.prepare("INSERT INTO cost_basis VALUES (?, 'live', 'COIN', '10', '20', ?)").run(account, OLD);
  raw.prepare("INSERT INTO position_floors VALUES (?, 'live', 'COIN', 1500, 'r1', 'entry', ?)").run(account, OLD);
  for (const [table, id] of [["trades", 40], ["events", 90], ["equity", 12]] as const) {
    raw.prepare("INSERT INTO mirror_state (tenant, table_name, last_id, last_stamp, updated_at) VALUES (?, ?, ?, ?, ?)").run(tenant, table, id, OLD, nowSec() - 40 * 3600);
  }
  const home = childHome(tenant); mkdirSync(home, { recursive: true, mode: 0o700 });
  for (const [name, body] of [["ledger-source-blocked.json", '{"version":1,"state":"missing-live-source"}'], ["grant.json", "OLD SESSION KEY"]] as const) {
    writeFileSync(path.join(home, name), body, { mode: 0o600 });
  }
  if (o.telegram) { writeFileSync(path.join(home, "telegram.json"), o.telegram.body); chmodSync(path.join(home, "telegram.json"), o.telegram.mode); }
  const stale = new DatabaseSync(path.join(home, "merrymen.db")); stale.exec("CREATE TABLE junk (x); INSERT INTO junk VALUES (1)"); stale.close();
  await putGrant(tenant, grant(account, owner));
  await settingsStore.put(tenant, { telegramEnabled: true, telegramBotToken: `${bot}:resume_retry_fixture` } as never);
  return { tenant, account, owner, home, bot, n: seq };
}
/** The recovery listener's high-water mark for the tenant's bot, as recovery_reply_offsets holds it. */
const offsetRow = (bot: string, tenant: string, account: string, offset: number) =>
  raw.prepare("INSERT INTO recovery_reply_offsets VALUES(?,?,?,4663,?,200,?,100,1000) ON CONFLICT (bot_id) DO UPDATE SET tenant = excluded.tenant, smart_account = excluded.smart_account, offset_id = excluded.offset_id")
    .run(bot, tenant, account, "a".repeat(16), offset);
async function approve(tenant: string) {
  await runResumeAdmissionControlsForTest({ MERRYMEN_RESUME_PREVIEW: tenant });
  const run = raw.prepare("SELECT run FROM ledger_resume_preview_runs ORDER BY created_at_ms DESC, rowid DESC LIMIT 1").get() as { run: string };
  await runResumeAdmissionControlsForTest({ MERRYMEN_RESUME_APPROVE: `run:${run.run}` });
  assert.equal(approval(tenant)?.state, "approved");
}
const approval = (tenant: string) => raw.prepare("SELECT state, reason, generation FROM ledger_resume_approvals WHERE tenant = ? ORDER BY created_at_ms DESC, rowid DESC LIMIT 1").get(tenant) as
  { state: string; reason: string | null; generation: string | null } | undefined;
const forksOf = (tenant: string) => forks.filter((h) => h === childHome(tenant)).length;
const pass = async () => { await reconcile(); await new Promise((r) => setTimeout(r, 20)); };
const linesOf = (tenant: string) => said.filter((l) => l.includes(tenant));
/** The book as the next pass meets it: whether a worker armed on it, and what the seeds put in it. */
function book(home: string) {
  const b = new DatabaseSync(path.join(home, "merrymen.db"), { readOnly: true });
  try {
    return {
      agents: (b.prepare("SELECT count(*) AS n FROM agents").get() as { n: number }).n,
      paper: (b.prepare("SELECT count(*) AS n FROM paper_book").get() as { n: number }).n,
      basis: (b.prepare("SELECT count(*) AS n FROM cost_basis").get() as { n: number }).n,
      energy: (b.prepare("SELECT count(*) AS n FROM energy_days").get() as { n: number }).n,
    };
  } finally { b.close(); }
}
const telegram = (home: string) => JSON.parse(readFileSync(path.join(home, "telegram.json"), "utf8")) as Record<string, unknown>;
const remove = async (...tenants: string[]) => { for (const t of tenants) await grants.remove(t as `0x${string}`); await reconcile(); };

it("THE SIX: registered, seeded, its carried link refused by the handoff — the next pass on this build admits it, with no data surgery", async () => {
  const t = await preIncident({ telegram: { body: JSON.stringify({ offset: 1 }), mode: 0o600 } });
  // The listener's row names another account at first, so the first pass is
  // refused AT THE HANDOFF, after the seeds, exactly where production's was.
  offsetRow(t.bot, addr(0x5eee), addr(0x5fff), 4100);
  await approve(t.tenant);
  await pass();
  assert.equal(approval(t.tenant)?.state, "registered");
  assert.equal(forksOf(t.tenant), 0);
  assert.ok(linesOf(t.tenant).some((l) => /recovery reply offset not handed over \(Error HANDOFF_ROW\)/.test(l)), said.join("\n"));
  assert.ok(existsSync(path.join(t.home, "attested-seed.json")), "seeded and proved, as production logged");
  assert.deepEqual(book(t.home), { agents: 0, paper: 1, basis: 2, energy: 1 }, "the seeds' rows, and no agent row: what the ordinary gates refused on every later pass");
  // What production holds now: the carried telegram.json as the build before
  // this one left it — the orchestrator's restored link, copied with its
  // bytes and mode — and the listener's row, which names this tenant.
  rmSync(path.join(t.home, "telegram.json"));
  writeFileSync(path.join(t.home, "telegram.json"), JSON.stringify(RESTORED_LINK, null, 2), { mode: 0o600 });
  offsetRow(t.bot, t.tenant, t.account, 4100);

  await pass();
  assert.equal(forksOf(t.tenant), 1, "its first worker starts");
  assert.equal(approval(t.tenant)?.state, "applied");
  assert.deepEqual(telegram(t.home), { offset: 4100, ...RESTORED_LINK }, "the link kept, and the listener's high-water mark handed over");
  assert.equal(lstatSync(path.join(t.home, "telegram.json")).mode & 0o777, 0o600);
  assert.ok(!linesOf(t.tenant).some((l) => /persistent original book is unconfirmed/.test(l)), said.join("\n"));
  assert.ok(linesOf(t.tenant).some((l) => /normalised for the offset handoff \(telegram\.json: offset\)/.test(l)), said.join("\n"));
  await remove(t.tenant);
});

it("a carry of the restored link, or of a file at the umask, is handed over on the first pass", async () => {
  const a = await preIncident({ telegram: { body: JSON.stringify(RESTORED_LINK, null, 2), mode: 0o600 } });
  const b = await preIncident({ telegram: { body: JSON.stringify({ offset: 20, botId: "9999", priorBots: [] }), mode: 0o644 } });
  offsetRow(a.bot, a.tenant, a.account, 777);
  offsetRow(b.bot, b.tenant, b.account, 888);
  await approve(a.tenant); await approve(b.tenant);
  await pass();
  for (const t of [a, b]) {
    assert.equal(approval(t.tenant)?.state, "applied", t.tenant);
    assert.equal(forksOf(t.tenant), 1, t.tenant);
    assert.equal(lstatSync(path.join(t.home, "telegram.json")).mode & 0o777, 0o600);
    assert.ok(!linesOf(t.tenant).some((l) => /not handed over/.test(l)), said.join("\n"));
  }
  assert.deepEqual(telegram(a.home), { offset: 777, ...RESTORED_LINK });
  assert.ok(linesOf(a.tenant).some((l) => /carried telegram\.json \(normalised telegram\.json: offset\)/.test(l)), said.join("\n"));
  // Another bot was last local: the arriving bot's mark goes first among the prior bots.
  assert.deepEqual(telegram(b.home), { offset: 20, botId: "9999", priorBots: [{ botId: b.bot, offset: 888 }] });
  await remove(a.tenant, b.tenant);
});

it("a registered tenant whose practice book will not restore is held, its carried link handed over to the hold process's poll", async () => {
  const t = await preIncident();
  await settingsStore.put(t.tenant, { telegramEnabled: true, telegramBotToken: `${t.bot}:resume_retry_fixture`, paperTradingEnabled: true } as never);
  offsetRow(t.bot, addr(0x5eee), addr(0x5fff), 1); // the first pass is refused after registration, at the handoff
  await approve(t.tenant);
  await pass();
  assert.equal(approval(t.tenant)?.state, "registered");
  // As the build before this one carried it, and the listener's row as production holds it.
  writeFileSync(path.join(t.home, "telegram.json"), JSON.stringify(RESTORED_LINK, null, 2), { mode: 0o600 });
  offsetRow(t.bot, t.tenant, t.account, 6100);
  unrestorable.add(t.tenant);
  try { await pass(); } finally { unrestorable.delete(t.tenant); }
  assert.equal(holds.filter((h) => h === t.home).length, 1, "a hold process answers its bot");
  assert.equal(forksOf(t.tenant), 0, "and no worker trades over a book that did not restore");
  assert.deepEqual(telegram(t.home), { offset: 6100, ...RESTORED_LINK });
  await remove(t.tenant);
});

it("a carried file the handoff refuses for what it is, not for a shape we left, still refuses — and the tenant is admitted once it is repaired", async () => {
  const t = await preIncident({ telegram: { body: JSON.stringify({ offset: 5, botId: 9101 }), mode: 0o600 } });
  offsetRow(t.bot, t.tenant, t.account, 300);
  await approve(t.tenant);
  await pass();
  assert.equal(approval(t.tenant)?.state, "registered");
  assert.equal(forksOf(t.tenant), 0);
  assert.ok(linesOf(t.tenant).some((l) => /offset not handed over \(Error HANDOFF_BOT\)/.test(l)), "a numeric bot id is no build's: refused, by name");
  assert.deepEqual(telegram(t.home), { offset: 5, botId: 9101 }, "and left as it was");
  await pass();
  assert.equal(forksOf(t.tenant), 0, "refused again, for the same reason, not for its seeded book");
  assert.ok(!linesOf(t.tenant).some((l) => /persistent original book is unconfirmed/.test(l)), said.join("\n"));
  // An operator repairs the file: the next pass admits.
  writeFileSync(path.join(t.home, "telegram.json"), JSON.stringify({ offset: 5, botId: t.bot }), { mode: 0o600 });
  await pass();
  assert.equal(approval(t.tenant)?.state, "applied");
  assert.equal(telegram(t.home).offset, 300);
  await remove(t.tenant);
});

it("every later gate that refuses after the seeds is retried, and admission completes once it clears", async () => {
  // THE PRIVACY PROOF: a group erasure journaled while held, and a group file
  // with a second name that the proof cannot vouch for.
  const privacy = await preIncident();
  const op = { id: "00000000-0000-4000-8000-0000000000c1", atMs: 1000, kind: "group" as const, chatId: -11 };
  const sealed = sealRecoveryReplyState(privacy.tenant, { version: 1, privacy: [op], turns: [] }, dek);
  raw.prepare("INSERT INTO tenant_recovery_reply_state VALUES(?,?,?,1000)").run(privacy.tenant, sealed.sealed, sealed.bytes);
  // A LOST LEASE after the practice book was restored: the later seeds and the
  // attested seed's proof refuse to write.
  const lease = await preIncident();
  // THE GRANT RE-SIGNED during preparation (same owner, same account).
  const resigned = await preIncident();
  let resignedOnce = false, privacyOnce = false;
  afterRestore = async (tenant) => {
    if (tenant === privacy.tenant && !privacyOnce) {
      privacyOnce = true;
      writeFileSync(path.join(privacy.home, "tg-groups.json"), JSON.stringify({ version: 1, rooms: {} }), { mode: 0o600 });
      linkSync(path.join(privacy.home, "tg-groups.json"), path.join(privacy.home, "tg-groups.second-name"));
    }
    if (tenant === lease.tenant && forksOf(tenant) === 0 && !unhealthy.has(tenant) && !said.some((l) => l.includes(`${tenant}: the attested book's seed is not complete`))) unhealthy.add(tenant);
    if (tenant === resigned.tenant && forksOf(tenant) === 0 && !resignedOnce) {
      resignedOnce = true;
      await putGrant(resigned.tenant, grant(resigned.account, resigned.owner, 2));
    }
  };
  try {
    for (const t of [privacy, lease, resigned]) await approve(t.tenant);
    await pass();
    for (const t of [privacy, lease, resigned]) {
      assert.equal(approval(t.tenant)?.state, "registered", t.tenant);
      assert.equal(forksOf(t.tenant), 0, t.tenant);
      assert.equal(book(t.home).agents, 0, t.tenant);
      assert.equal(book(t.home).paper, 1, `${t.tenant}: the practice book is in, so the old gates refused the next pass`);
    }
    assert.ok(linesOf(privacy.tenant).some((l) => /privacy proof unavailable or refused \(Error PRIVACY_FILE\)/.test(l)), said.join("\n"));
    assert.ok(linesOf(lease.tenant).some((l) => /seed is not complete/.test(l)), said.join("\n"));
    // The re-signed grant is refused at the source report's own grant check,
    // which says nothing (reportFleetSource), before the fork's.
    assert.equal(JSON.parse(readFileSync(path.join(resigned.home, "grant.json"), "utf8")).serialized, `fixture-resume-retry-${resigned.account}-1`,
      "the key written for this spawn is the one signed before it changed");
    // The refusals clear: the unprovable group memory goes (both its names),
    // the lease answers again, the re-signed grant stands.
    rmSync(path.join(privacy.home, "tg-groups.second-name")); rmSync(path.join(privacy.home, "tg-groups.json"));
    unhealthy.delete(lease.tenant);
    await pass();
    for (const t of [privacy, lease, resigned]) {
      assert.equal(approval(t.tenant)?.state, "applied", `${t.tenant}: ${linesOf(t.tenant).slice(-4).join(" | ")}`);
      assert.equal(forksOf(t.tenant), 1, t.tenant);
      assert.ok(!linesOf(t.tenant).some((l) => /persistent original book is unconfirmed/.test(l)), said.join("\n"));
    }
    const proved = new DatabaseSync(path.join(lease.home, "merrymen.db"), { readOnly: true });
    try {
      assert.deepEqual(proved.prepare("SELECT mode, symbol, qty_raw, cost_usdg FROM cost_basis ORDER BY mode").all().map((r) => ({ ...r })),
        [{ mode: "live", symbol: "COIN", qty_raw: "10", cost_usdg: "20" }, { mode: "paper", symbol: "COIN", qty_raw: "10", cost_usdg: "20" }],
        "the seed the lost lease cut short is completed before the worker");
    } finally { proved.close(); }
  } finally { afterRestore = null; unhealthy.clear(); }
  await remove(privacy.tenant, lease.tenant, resigned.tenant);
});

it("a foreign or tampered book still refuses: a row only a worker writes, another book in its place, an attestation that does not match", async () => {
  const worker = await preIncident(), swapped = await preIncident(), tampered = await preIncident();
  // Each first pass is refused after the seeds (the handoff's row names another account).
  for (const t of [worker, swapped, tampered]) { offsetRow(t.bot, addr(0x5eee), addr(0x5fff), 1); await approve(t.tenant); }
  await pass();
  for (const t of [worker, swapped, tampered]) { assert.equal(approval(t.tenant)?.state, "registered"); offsetRow(t.bot, t.tenant, t.account, 1); }
  // A trade with no agent row: nothing the spawn path seeds, so not this registration's to vouch for.
  const w = new DatabaseSync(path.join(worker.home, "merrymen.db"));
  try { w.prepare("INSERT INTO trades (agent_id, kind, target, amount_usdg, status, created_at) VALUES (?, 'swap', 'x', 1, 'paper', 1)").run(worker.account); }
  finally { w.close(); }
  // Another book in its place, at another inode: the same rows, its own identity copied in.
  const file = path.join(swapped.home, "merrymen.db"), copy = `${file}.copy`;
  writeFileSync(copy, readFileSync(file), { mode: 0o600 }); rmSync(file); writeFileSync(file, readFileSync(copy), { mode: 0o600 }); rmSync(copy);
  // An attestation recording another receipt.
  raw.prepare("UPDATE ledger_resume_attestations SET receipt_digest = ? WHERE tenant = ?").run("0".repeat(64), tampered.tenant);
  await pass();
  for (const t of [worker, swapped, tampered]) {
    assert.equal(forksOf(t.tenant), 0, t.tenant);
    assert.equal(approval(t.tenant)?.state, "registered", t.tenant);
    assert.ok(linesOf(t.tenant).some((l) => /persistent original book is unconfirmed/.test(l)), `${t.tenant}: ${linesOf(t.tenant).slice(-3).join(" | ")}`);
  }
  await remove(worker.tenant, swapped.tenant, tampered.tenant);
});

it("THE SIX, from before #198: the restored link as the earlier writer left it at the umask is admitted the same way", async () => {
  const t = await preIncident();
  offsetRow(t.bot, addr(0x5eee), addr(0x5fff), 4200);
  await approve(t.tenant);
  await pass();
  assert.equal(approval(t.tenant)?.state, "registered");
  assert.equal(forksOf(t.tenant), 0);
  assert.equal(book(t.home).energy, 1, "the day's energy is in the book too, with no agent row");
  // writeTelegramForChild before #202: writeFileSync at the umask, an empty code, a zero link time.
  const legacy = { linkCode: "", ownerId: 555, linkedAt: 0 };
  rmSync(path.join(t.home, "telegram.json"), { force: true });
  writeFileSync(path.join(t.home, "telegram.json"), JSON.stringify(legacy, null, 2)); chmodSync(path.join(t.home, "telegram.json"), 0o644);
  offsetRow(t.bot, t.tenant, t.account, 4200);
  await pass();
  assert.equal(forksOf(t.tenant), 1);
  assert.equal(approval(t.tenant)?.state, "applied");
  assert.deepEqual(telegram(t.home), { offset: 4200, ...legacy });
  assert.equal(lstatSync(path.join(t.home, "telegram.json")).mode & 0o777, 0o600);
  assert.ok(linesOf(t.tenant).some((l) => /normalised for the offset handoff \(telegram\.json: offset, telegram\.json: mode\)/.test(l)), said.join("\n"));
  await remove(t.tenant);
});

it("a carried or live-home telegram.json someone else could write is still refused by its mode, and nothing is reported to the owner it names", async () => {
  const foreign = { ownerId: 424242, linkCode: "EVIL01" }, planted = { ownerId: 31337, linkCode: "FOREIGN" };
  // Carried: a 0666 link in the old home.
  const carried = await preIncident({ telegram: { body: JSON.stringify(foreign), mode: 0o666 } });
  offsetRow(carried.bot, carried.tenant, carried.account, 500);
  // In the live home: a 0666 link put there after registration.
  const live = await preIncident();
  offsetRow(live.bot, addr(0x5eee), addr(0x5fff), 1);
  await approve(carried.tenant); await approve(live.tenant);
  await pass();
  assert.equal(approval(live.tenant)?.state, "registered");
  rmSync(path.join(live.home, "telegram.json"), { force: true });
  writeFileSync(path.join(live.home, "telegram.json"), JSON.stringify(planted)); chmodSync(path.join(live.home, "telegram.json"), 0o666);
  offsetRow(live.bot, live.tenant, live.account, 600);
  for (let i = 0; i < 2; i += 1) {
    await pass();
    for (const [t, body] of [[carried, foreign], [live, planted]] as const) {
      assert.equal(approval(t.tenant)?.state, "registered", t.tenant);
      assert.equal(forksOf(t.tenant), 0, t.tenant);
      assert.equal(holds.filter((h) => h === t.home).length, 0, t.tenant);
      assert.deepEqual(telegram(t.home), body, `${t.tenant}: left exactly as it was`);
      assert.equal(lstatSync(path.join(t.home, "telegram.json")).mode & 0o777, 0o666, `${t.tenant}: its mode kept for the handoff to refuse`);
      assert.ok(linesOf(t.tenant).some((l) => /offset not handed over \(Error HANDOFF_MODE\)/.test(l)), said.join("\n"));
      assert.ok(!linesOf(t.tenant).some((l) => /persistent original book is unconfirmed|normalised/.test(l)), said.join("\n"));
    }
  }
  await remove(carried.tenant, live.tenant);
});

it("a carried telegram.json with a second name stays in the archive, and the tenant is admitted on a file of its own", async () => {
  const t = await preIncident();
  const elsewhere = path.join(fleet, `elsewhere-${t.n}.json`);
  writeFileSync(elsewhere, JSON.stringify({ ownerId: 31337, linkCode: "FOREIGN", offset: 9 }), { mode: 0o600 });
  linkSync(elsewhere, path.join(t.home, "telegram.json"));
  offsetRow(t.bot, t.tenant, t.account, 700);
  await approve(t.tenant);
  await pass();
  assert.equal(approval(t.tenant)?.state, "applied", linesOf(t.tenant).join("\n"));
  assert.equal(forksOf(t.tenant), 1);
  assert.ok(linesOf(t.tenant).some((l) => /left in the archive, not the home's own: telegram\.json/.test(l)), said.join("\n"));
  const archived = path.join(fleet, "archive", t.tenant, approval(t.tenant)!.generation!, "telegram.json");
  assert.equal(readFileSync(archived, "utf8"), JSON.stringify({ ownerId: 31337, linkCode: "FOREIGN", offset: 9 }), "kept in the archive as it was");
  assert.equal(telegram(t.home).linkCode, undefined, "never the new home's");
  assert.equal(telegram(t.home).ownerId, undefined);
  assert.equal(telegram(t.home).offset, 700, "the listener's mark, handed over into a file of the tenant's own");
  await remove(t.tenant);
});
