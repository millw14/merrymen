/**
 * AN ORDINARY TENANT'S RESTORED LINK IS HANDED THE LISTENER'S OFFSET THROUGH
 * reconcile(), WHETHER THIS BUILD RESTORED IT OR AN EARLIER ONE DID.
 *
 * What production was left with (main@4c76fded): an ordinary tenant, never
 * archived or registered, whose telegram.json was lost and whose bot the
 * recovery listener answered while it had no worker (a recovery_reply_offsets
 * row for the bot). spawnChild restored its link (writeTelegramForChild) with
 * no offset, and the offset handoff refused it (HANDOFF_OFFSET) on every
 * pass: no worker, and held no hold process, for as long as the row stood.
 * restoredTelegramFile writes `offset: 0` now. But the restore writes only
 * into a home with no telegram.json, and child homes live on the fleet volume
 * (persistent-home.ts), so the file an earlier build restored is still there
 * after the deploy; the spawn path gives it its offset just before the
 * handoff (offsetEarlierRestoredLink, ledger-resume.ts offsetRestoredLink),
 * and nothing else.
 *
 * Driven through the real reconcile() with the recovery gates live, as
 * orchestrator-resume-retry.integration.test.ts drives a registered tenant:
 * the shared database is a sqlite stand-in where the orchestrator has a seam
 * for it (the privacy proof, the handoff, and now the restore's read of the
 * mirror, writeTelegramForChild's `shared`), and DATABASE_URL names an
 * address nothing answers. The homes are on a verified volume, as
 * production's are. The fork is a stub that reads the home's telegram.json
 * at the moment the worker or hold process would start, the way it loads it
 * (telegram/state.ts loadTelegramState). Nothing in this file reaches
 * Telegram: the bot confirmation and the owner's hold notice are stubbed.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
import { RECOVERY_REPLY_SCHEMA } from "./recovery-reply-state";
import { TG_GROUPS_TABLE_SQL } from "./tg-groups-ferry";
import { PERSONAL_MEMORY_TABLE_SQL } from "./personal-memory-ferry";
import { TELEGRAM_STATE_DDL, publishTenantTelegram } from "./telegram-store";
import type { TenantLease } from "./tenant-lease";

const fleet = realpathSync(mkdtempSync(path.join(os.tmpdir(), "merrymen-restored-link-offset-")));
process.env.MERRYMEN_HOME = fleet;
process.env.MERRYMEN_HOSTED = "1";
delete process.env.DATABASE_URL;
const dek = Buffer.alloc(32, 29);
process.env.MERRYMEN_STORE_DEK = dek.toString("base64");

const orch = await import("./orchestrator");
const { childHome, reconcile, setSpawnForTest, setRetirementMemoryStoreForTest, setPaperRestoreForTest, setPersistentHomeVerifierForTest,
  setLeaseAcquireForTest, setResumeChainForTest, setKillConfirmForTest, setBasisSeedSharedForTest, setPersonalMemoryStoreForTest,
  setBotConfirmForTest, setHoldNoticeForTest, isHeldForTest } = orch;
const { loadTelegramState } = await import("./telegram/state");
// Taken now, while DATABASE_URL is unset, so both stay on files for the whole file.
const grants = (await import("./grant-store")).getGrantStore();
const settingsStore = (await import("./settings-store")).getSettingsStore();
// A hosted deployment from here on: the privacy proof and the offset handoff
// run. Nothing answers at this address; the gates read the stand-in below.
process.env.DATABASE_URL = "postgres://restored-link-offset.invalid/not-a-real-connection";

const raw = new DatabaseSync(":memory:"), shared = wrapSqlite(raw);
await applyLedgerSchema(shared); await shared.exec(MIRROR_STATE_DDL); await shared.exec(PAPER_CHECKPOINT_SCHEMA);
raw.exec(RECOVERY_REPLY_SCHEMA + TG_GROUPS_TABLE_SQL + PERSONAL_MEMORY_TABLE_SQL + TELEGRAM_STATE_DDL);
raw.exec("CREATE TABLE grants(tenant TEXT PRIMARY KEY,grant_json TEXT NOT NULL,updated_at INTEGER NOT NULL,row_version INTEGER NOT NULL)");
const volumeStat = lstatSync(fleet, { bigint: true });
setPersistentHomeVerifierForTest(() => ({ id: "vol_restored_link_offset", mountPath: fleet, homeRoot: fleet, device: String(volumeStat.dev), inode: String(volumeStat.ino) }));
setRetirementMemoryStoreForTest({ shared, dek, dialect: "sqlite" });
setPersonalMemoryStoreForTest({ shared, dek, dialect: "sqlite" });
setBasisSeedSharedForTest(shared);
setKillConfirmForTest(async () => {});
setResumeChainForTest(() => { throw new Error("an ordinary tenant must not read the chain"); });
// No call reaches Telegram from this file.
setBotConfirmForTest(async () => null);
const notices: string[] = [];
setHoldNoticeForTest(async (tenant) => { notices.push(tenant); return "sent"; });
setLeaseAcquireForTest(async (tenant) => ({ tenant, backend: "postgres", healthy: () => true, async release() {} }) as TenantLease);

/** Tenants whose practice book will not restore: spawnChild holds them (spawnHolder). */
const unrestorable = new Set<string>();
setPaperRestoreForTest(async (tenant) => unrestorable.has(tenant)
  ? { ok: false, reason: "paper fills are newer than the recoverable valuation" }
  : { ok: true, line: null });

/** telegram.json as the process starting in `home` loads it (telegram/state.ts loadTelegramState). */
function loadedIn(home: string) {
  const prior = process.env.MERRYMEN_HOME;
  process.env.MERRYMEN_HOME = home;
  try { return loadTelegramState(); } finally { process.env.MERRYMEN_HOME = prior; }
}
class FakeProc extends EventEmitter {
  readonly stdout = null; readonly stderr = null;
  constructor(readonly pid: number) { super(); }
  kill() { return true; }
}
/** Every start: whose home, worker or hold process, and its telegram.json then, as written and as loaded. */
const starts: Array<{ home: string; kind: "worker" | "hold"; file: Record<string, unknown> | null; offset: number; ownerId: number | null }> = [];
setSpawnForTest((_c, args, options) => {
  const home = String(options.env?.MERRYMEN_HOME);
  const file = path.join(home, "telegram.json");
  const state = loadedIn(home);
  starts.push({
    home, kind: args.some((a) => a.endsWith("telegram-hold.ts")) ? "hold" : "worker",
    file: existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown> : null,
    offset: state.offset, ownerId: state.ownerId,
  });
  return new FakeProc(80_000 + starts.length) as unknown as ChildProcess;
});

const said: string[] = [];
const realLog = console.log;
console.log = (...a: unknown[]) => { said.push(a.map(String).join(" ")); };

after(() => {
  console.log = realLog;
  setRetirementMemoryStoreForTest(null); setPersonalMemoryStoreForTest(null); setPaperRestoreForTest(null); setPersistentHomeVerifierForTest(null);
  setLeaseAcquireForTest(null); setResumeChainForTest(null); setBasisSeedSharedForTest(null); setBotConfirmForTest(null);
  raw.close(); rmSync(fleet, { recursive: true, force: true });
});

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const nowSec = () => Math.floor(Date.now() / 1000);
const grant = (account: `0x${string}`, owner: `0x${string}`): StoredGrant => ({
  smartAccount: account, owner, sessionKeyAddress: addr(0x5e5), serialized: `fixture-restored-link-offset-${account}`,
  chainId: 4663, grantedAt: nowSec() - 60, expiresAt: nowSec() + 86_400,
  caps: { perTradeUsdg: 10, dailyUsdg: 50, maxDrawdownPct: 20, expiryDays: 7 },
  grantFeatures: ["tradeable-v2"], grantTokens: [], demoSessionPrivateKey: `0x${"ab".repeat(32)}`,
}) as unknown as StoredGrant;

/**
 * The link exactly as writeTelegramForChild restored it (restoredTelegramFile)
 * before it wrote `offset: 0`: no offset at all. What an ordinary home on the
 * volume holds after an earlier build restored it.
 */
const EARLIER_RESTORE = { linkCode: "QX7M2K", ownerId: 555, linkedAt: 1_790_000_000 };

let seq = 0;
/**
 * One ordinary tenant with a bot: its grant, settings that switch the bot on,
 * and its home on the volume, holding `telegram` as its telegram.json if given.
 * No Postgres history, no archive, no approval: nothing the resume path sees.
 */
async function ordinary(o: { telegram?: { body: string; mode: number }; bot?: boolean; paper?: boolean } = {}) {
  seq += 1;
  const tenant = addr(0xe00000 + seq), account = addr(0xeac000 + seq), owner = addr(0xf00000 + seq), bot = String(9300 + seq);
  const home = childHome(tenant); mkdirSync(home, { recursive: true, mode: 0o700 });
  if (o.telegram) { writeFileSync(path.join(home, "telegram.json"), o.telegram.body); chmodSync(path.join(home, "telegram.json"), o.telegram.mode); }
  const g = grant(account, owner);
  await grants.put(tenant, g);
  raw.prepare("INSERT INTO grants VALUES (?, ?, ?, 1)").run(tenant, JSON.stringify({ smartAccount: account, owner, chainId: 4663 }), nowSec());
  await settingsStore.put(tenant, { telegramEnabled: o.bot !== false, telegramBotToken: `${bot}:restored_link_offset_fixture`, ...(o.paper ? { paperTradingEnabled: true } : {}) } as never);
  return { tenant, account, home, bot, file: path.join(home, "telegram.json") };
}
/** The recovery listener's high-water mark for the tenant's bot, as recovery_reply_offsets holds it. */
const listened = (t: { bot: string; tenant: string; account: string }, offset: number) =>
  raw.prepare("INSERT INTO recovery_reply_offsets VALUES(?,?,?,4663,?,200,?,100,1000)").run(t.bot, t.tenant, t.account, "a".repeat(16), offset);
const startsIn = (home: string) => starts.filter((s) => s.home === home);
const pass = async () => { await reconcile(); await new Promise((r) => setTimeout(r, 20)); };
const linesOf = (tenant: string) => said.filter((l) => l.includes(tenant));
const telegram = (file: string) => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
const remove = async (...tenants: string[]) => { for (const t of tenants) await grants.remove(t as `0x${string}`); await reconcile(); };

it("no telegram.json: the link comes back from the mirror with offset 0, the handoff raises it, and the worker starts past the listener's mark", async () => {
  const t = await ordinary();
  await publishTenantTelegram(shared, t.tenant, EARLIER_RESTORE);
  listened(t, 4321);
  await pass();
  assert.deepEqual(startsIn(t.home).map((s) => s.kind), ["worker"], linesOf(t.tenant).join("\n"));
  const [start] = startsIn(t.home);
  assert.deepEqual(start!.file, { offset: 4321, ...EARLIER_RESTORE }, "the link restored, and the listener's high-water mark handed over before the fork");
  assert.equal(start!.offset, 4321, "the worker's first poll asks past everything the listener answered");
  assert.equal(start!.ownerId, 555, "and the owner still hears from it");
  assert.ok(linesOf(t.tenant).some((l) => /telegram link restored/.test(l)), said.join("\n"));
  assert.ok(!linesOf(t.tenant).some((l) => /not handed over|earlier build restored it/.test(l)), said.join("\n"));
  await remove(t.tenant);
});

it("THE STUCK ONES: a home holding the link an earlier build restored, with no offset, is admitted on the first pass after this deploy", async () => {
  const t = await ordinary({ telegram: { body: JSON.stringify(EARLIER_RESTORE, null, 2), mode: 0o600 } });
  // The mirror holds the same link: the restore would write it again, but a
  // file that is there is never rewritten by it.
  await publishTenantTelegram(shared, t.tenant, EARLIER_RESTORE);
  listened(t, 5150);
  await pass();
  assert.deepEqual(startsIn(t.home).map((s) => s.kind), ["worker"], linesOf(t.tenant).join("\n"));
  assert.deepEqual(startsIn(t.home)[0]!.file, { offset: 5150, ...EARLIER_RESTORE }, "the link kept, and the listener's mark handed over");
  assert.equal(startsIn(t.home)[0]!.offset, 5150);
  assert.equal(lstatSync(t.file).mode & 0o777, 0o600);
  assert.ok(linesOf(t.tenant).some((l) => /telegram\.json as an earlier build restored it, given the offset its restore writes now, for the offset handoff \(telegram\.json: offset\)/.test(l)), said.join("\n"));
  assert.ok(!linesOf(t.tenant).some((l) => /not handed over/.test(l)), said.join("\n"));
  await remove(t.tenant);
});

it("a held tenant (its practice book will not restore): the hold process starts past the listener's mark, its link from the mirror or from an earlier build's file", async () => {
  const fresh = await ordinary({ paper: true });
  await publishTenantTelegram(shared, fresh.tenant, EARLIER_RESTORE);
  const earlier = await ordinary({ paper: true, telegram: { body: JSON.stringify({ ownerId: 555 }, null, 2), mode: 0o600 } });
  listened(fresh, 610);
  listened(earlier, 620);
  unrestorable.add(fresh.tenant); unrestorable.add(earlier.tenant);
  try { await pass(); } finally { unrestorable.clear(); }
  for (const [t, file, offset] of [[fresh, { offset: 610, ...EARLIER_RESTORE }, 610], [earlier, { offset: 620, ownerId: 555 }, 620]] as const) {
    assert.deepEqual(startsIn(t.home).map((s) => s.kind), ["hold"], `${t.tenant}: a hold process answers its bot, and no worker trades: ${linesOf(t.tenant).join("\n")}`);
    assert.deepEqual(startsIn(t.home)[0]!.file, file, t.tenant);
    assert.equal(startsIn(t.home)[0]!.offset, offset, `${t.tenant}: its first poll asks past what the listener answered`);
    assert.equal(isHeldForTest(t.tenant), true);
    assert.ok(!linesOf(t.tenant).some((l) => /not handed over/.test(l)), said.join("\n"));
  }
  assert.ok(linesOf(earlier.tenant).some((l) => /earlier build restored it, given the offset .*\(telegram\.json: offset\)/.test(l)), said.join("\n"));
  await remove(fresh.tenant, earlier.tenant);
});

it("not loosened: any other file without an offset is still refused by name and left as it is, a restored link at the umask by its mode, and with the bot off nothing is touched", async () => {
  // Not the restored link: a key the restore never wrote.
  const other = { ...EARLIER_RESTORE, linkedChats: [555] };
  const shaped = await ordinary({ telegram: { body: JSON.stringify(other), mode: 0o600 } });
  // The restored link as written before #198, at the umask: never a mode, outside a registered home.
  const umask = await ordinary({ telegram: { body: JSON.stringify(EARLIER_RESTORE), mode: 0o644 } });
  // An earlier build's restored link, with the bot switched off: no handoff, so no step either.
  const off = await ordinary({ bot: false, telegram: { body: JSON.stringify(EARLIER_RESTORE), mode: 0o600 } });
  listened(shaped, 700); listened(umask, 710); listened(off, 720);
  for (let i = 0; i < 2; i += 1) {
    await pass();
    for (const [t, body, mode, code] of [[shaped, other, 0o600, "HANDOFF_OFFSET"], [umask, EARLIER_RESTORE, 0o644, "HANDOFF_MODE"]] as const) {
      assert.equal(startsIn(t.home).length, 0, `${t.tenant}: no worker and no hold process`);
      assert.deepEqual(telegram(t.file), body, `${t.tenant}: left exactly as it was`);
      assert.equal(lstatSync(t.file).mode & 0o777, mode, `${t.tenant}: with its own mode`);
      assert.ok(linesOf(t.tenant).some((l) => new RegExp(`offset not handed over \\(Error ${code}\\)`).test(l)), said.join("\n"));
      assert.ok(!linesOf(t.tenant).some((l) => /earlier build restored it/.test(l)), said.join("\n"));
    }
  }
  assert.deepEqual(startsIn(off.home).map((s) => s.kind), ["worker"], "the bot off: the worker starts as it always did");
  assert.deepEqual(telegram(off.file), EARLIER_RESTORE, "and its file is never touched");
  assert.equal(startsIn(off.home)[0]!.offset, 0, "read as offset 0, as a missing one always was");
  assert.ok(!linesOf(off.tenant).some((l) => /earlier build restored it|not handed over/.test(l)), said.join("\n"));
  await remove(shaped.tenant, umask.tenant, off.tenant);
});
