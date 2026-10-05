/** Actual entry against an explicitly opted-in disposable LOCAL PostgreSQL database. */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { REPLY_SUPERVISOR_EVERY_MS, runRecoveryReplies, type RecoveryReplyOptions, type ReplyPool } from "./recovery-replies";
import { RecoveryReplyFleetRefusal } from "./recovery-reply-isolation";
import { RecoveryReplyBotLeases } from "./recovery-reply-lease";
import { openRecoveryReplyState, readRecoveryReplyOffset, readReplyPrivacy, RECOVERY_REPLY_SCHEMA } from "./recovery-reply-state";
import { PgTenantLeaseManager, leaseKey } from "./tenant-lease";
import { openSecret, sealSecret } from "./store-crypto";
import { createRecoveryPublicReply, RECOVERY_PUBLIC_CONTEXT, RECOVERY_PUBLIC_GREETING, RECOVERY_PUBLIC_HELD, RECOVERY_PUBLIC_BUTTON_HELD } from "./telegram/recovery-public-reply";
import type { Db } from "./db";
import type { TelegramOpts, TgMessage } from "./telegram/api";

const URL = process.env.MERRYMEN_TEST_PG_URL;
const DEK = Buffer.alloc(32, 13);
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
type Query = { rows: Record<string, unknown>[]; rowCount?: number | null };
interface Client { connect(): Promise<void>; query(sql: string, values?: unknown[]): Promise<Query>; end(): Promise<void>; release(error?: Error): void; on(event: string, fn: () => void): void; }
type RawPool = ReplyPool;
type Transport = NonNullable<RecoveryReplyOptions["transport"]>;
type Poll = Awaited<ReturnType<Transport["getUpdates"]>>;
const updates = (messages: TgMessage[] = [], nextOffset = Math.max(0, ...messages.map(m => m.updateId + 1))): Poll => ({ messages, callbacks: [], members: [], service: [], nextOffset });
function fileFacts(home: string): unknown {
  return readdirSync(home).sort().map(name => { const file = path.join(home, name), s = lstatSync(file); return [name, s.mode, s.ino, s.nlink, s.size, s.isDirectory() ? fileFacts(file) : readFileSync(file).toString("base64")]; });
}

const LOG_LINE = /^\[recovery-replies\] (?:\[alert\] )?(?:actor-start|actor-stop|admit-wait|backoff|fleet-pause|release|roster-row-skipped|roster-unreadable|stats)(?: [a-z]+=(?:0x[0-9a-f]{6}|\?|[0-9]+s?|[a-z0-9-]+))*$/;
function assertRedacted(lines: readonly string[], actors: ReadonlyArray<Record<string, string | number>>): void {
  for (const line of lines) {
    assert.match(line, LOG_LINE, `log line outside the redacted grammar: ${line}`);
    assert.doesNotMatch(line, /0x[0-9a-f]{7,}/i, `more than an eight-character address prefix: ${line}`);
    for (const a of actors) for (const value of Object.values(a)) {
      const text = String(value);
      if (/^-?\d+$/.test(text)) assert.doesNotMatch(line, new RegExp(`(?<![0-9])${text.replace("-", "\\-")}(?![0-9])`), `log line carries a fixture id: ${line}`);
      else assert.ok(!line.includes(text), `log line carries a fixture secret or address: ${line}`);
    }
    assert.doesNotMatch(line, /private_fixture_token|replacement_fixture_token|FROG|chart|forget|Hiii|synthetic/i, `log line carries message or provider text: ${line}`);
  }
}

async function fixture(t: TestContext, count = 1) {
  const pg = createRequire(import.meta.url)("pg") as { Client: new (o: { connectionString: string }) => Client; Pool: new (o: { connectionString: string; max: number }) => RawPool };
  const schema = `mm_reply_entry_${randomBytes(8).toString("hex")}`;
  const admin = new pg.Client({ connectionString: URL! }); await admin.connect(); await admin.query(`CREATE SCHEMA ${schema}`);
  const scoped = new globalThis.URL(URL!); scoped.searchParams.set("options", `-c search_path=${schema}`); const localUrl = scoped.toString();
  const pool = new pg.Pool({ connectionString: localUrl, max: 16 });
  // The fixture's own pool absorbs an IDLE client's error, as the entry's
  // owned pool does. A CHECKED-OUT client has no pool listener at all (pg-pool
  // removes it): that one is the entry's to handle, and a test that kills one
  // fails loudly if it does not.
  (pool as unknown as { on(event: "error", fn: () => void): void }).on("error", () => {});
  const clients: Client[] = [];
  const parent = realpathSync(mkdtempSync(path.join(os.tmpdir(), "merrymen-reply-entry-"))), home = path.join(parent, "volume"); mkdirSync(home, { mode: 0o700 });
  t.after(async () => { await pool.end(); await Promise.allSettled(clients.map(c => c.end())); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); rmSync(parent, { recursive: true, force: true }); });
  const connect = async () => { const c = new pg.Client({ connectionString: localUrl }); clients.push(c); await c.connect(); return c; };
  await pool.query(readFileSync(new globalThis.URL("./testdata/shared-schema-75995697.sql", import.meta.url), "utf8"));
  await pool.query(`ALTER TABLE tenant_telegram ADD COLUMN bot_id TEXT, ADD COLUMN poll_ok_at INTEGER, ADD COLUMN poll_err TEXT, ADD COLUMN poll_err_at INTEGER, ADD COLUMN child_state TEXT;
    CREATE TABLE telegram_bot_claims(bot_id TEXT PRIMARY KEY,tenant TEXT NOT NULL,claimed_at INTEGER NOT NULL);
    CREATE TABLE fleet_recovery_health(tenant TEXT NOT NULL,smart_account TEXT NOT NULL,chain_id INTEGER NOT NULL,held INTEGER NOT NULL,cause TEXT NOT NULL,since_at BIGINT NOT NULL,checked_at BIGINT NOT NULL,PRIMARY KEY(tenant,smart_account,chain_id));
    CREATE TABLE tenant_personal_memory(tenant TEXT PRIMARY KEY,sealed TEXT NOT NULL,bytes INTEGER NOT NULL,updated_at_ms BIGINT NOT NULL);
    CREATE TABLE tenant_tg_groups(tenant TEXT PRIMARY KEY,sealed TEXT NOT NULL,bytes INTEGER NOT NULL,updated_at_ms BIGINT NOT NULL);
    CREATE TABLE original_financial(id BIGINT,nonce TEXT,amount TEXT,risk TEXT,fee TEXT);
    CREATE TABLE tenant_ledger_import(tenant TEXT,payload TEXT);`);
  let clock = Math.floor(Date.now() / 1000) * 1000;
  // Tenant addresses differ in their first hex digits: a log line carries only
  // an eight-character prefix, and each fixture tenant must still be told apart.
  const actors = Array.from({ length: count }, (_, i) => ({ tenant: `0x${(0xa1 + i).toString(16)}${"0".repeat(38)}` as `0x${string}`, account: address(201 + i), owner: address(301 + i), session: address(401 + i), ownerId: 701 + i, botId: String(801 + i), token: `${801 + i}:private_fixture_token`, room: -901 - i }));
  for (const a of actors) {
    const grant = { smartAccount: a.account, owner: a.owner, sessionKeyAddress: a.session, chainId: 4663, grantedAt: 1, expiresAt: 2, serialized: "never-read-private-session-payload" };
    await pool.query("INSERT INTO grants VALUES($1,4663,$2,'intentionally-invalid-sealed-key',100)", [a.tenant, JSON.stringify(grant)]);
    await pool.query("INSERT INTO tenant_settings VALUES($1,$2,100)", [a.tenant, sealSecret(JSON.stringify({ telegramEnabled: true, telegramBotToken: a.token, telegramAllowlist: [a.ownerId, a.room], signedDailyLimit: "must-remain-original" }), DEK)]);
    await pool.query("INSERT INTO telegram_bot_claims VALUES($1,$2,200)", [a.botId, a.tenant]);
    await pool.query("INSERT INTO tenant_telegram(tenant,link_code,owner_id,linked_at,updated_at,bot_id,child_state) VALUES($1,'original-link',$2,100,100,$3,'held:source')", [a.tenant, a.ownerId, a.botId]);
    await pool.query("INSERT INTO fleet_recovery_health VALUES($1,$2,4663,1,'persistent-source',100,100)", [a.tenant, a.account]);
    const personal = { version: 1, soul: { "IDENTITY.md": "agent identity", "OWNER.md": "original owner facts", "ARCHIVE.md": "original mixed archive" }, chats: [{ chatId: a.ownerId, turns: [{ role: "user", content: "original private conversation", at: 50 }] }, { chatId: 9999, turns: [{ role: "user", content: "unrelated retained chat", at: 50 }] }], forgets: [], applied: {} };
    const group = { version: 1, rooms: { [a.room]: { chatId: a.room, title: "public room", status: "approved", kind: "supergroup", lines: [{ messageId: 1, fromId: a.ownerId, name: "owner", text: "original room conversation never enters a reply", atMs: 50 }], people: [], coins: [], claims: { "1:original": 50 }, summary: "original room summary", sinceSummary: 1 } }, llm: { day: "2026-10-04", used: 12 }, nominations: { day: "2026-10-04", n: 4, entries: 1 } };
    for (const [table, header, data] of [["tenant_personal_memory", "personal-memory/v1", personal], ["tenant_tg_groups", "tg-groups/v1", group]] as const) { const text = JSON.stringify(data); await pool.query(`INSERT INTO ${table} VALUES($1,$2,$3,100)`, [a.tenant, sealSecret(`${header} ${a.tenant}\n${text}`, DEK), Buffer.byteLength(text)]); }
    await pool.query("INSERT INTO agents(smart_account,owner_address,session_key_address,chain_id,caps,granted_at,expires_at,hwm_usdg,accrued_fee_usdg,epoch) VALUES($1,$2,$3,4663,'original-risk-caps',1,2,120,3,4)", [a.account, a.owner, a.session]);
    await pool.query("INSERT INTO trades(agent_id,kind,target,amount_usdg,status,user_op_hash,epoch) VALUES($1,'swap','fixture',12.5,'submitted','unresolved-original-op',4)", [a.account]);
    await pool.query("INSERT INTO cost_basis(agent_id,mode,symbol,qty_raw,cost_usdg) VALUES($1,'live','COIN','1000000000','21.7')", [a.account]);
    await pool.query("INSERT INTO risk_periods VALUES($1,$2,1000,100,120,4,'original carry')", [`original-risk-${a.botId}`, a.account]);
    await pool.query("INSERT INTO fee_accruals(agent_id,profit_usdg,fee_usdg,hwm_before_usdg,hwm_after_usdg,epoch) VALUES($1,20,3,100,120,4)", [a.account]);
    await pool.query("INSERT INTO agent_commands(id,agent_id,kind,created_at) VALUES($1,$2,'trade',1000)", [`original-intent-${a.botId}`, a.account]);
    await pool.query("INSERT INTO mirror_state(tenant,table_name,last_id,last_stamp) VALUES($1,'trades',73,1073)", [a.tenant]);
    await pool.query("INSERT INTO tenant_ledger_import VALUES($1,'original-book-import-receipt')", [a.tenant]);
    const child = path.join(home, "children", a.tenant); mkdirSync(child, { recursive: true, mode: 0o700 });
    for (const [name, text] of [["merrymen.db", "original-book-must-not-open"], ["merrymen.db-wal", "original-WAL"], ["merrymen.db-shm", "original-SHM"], ["grant.json", "original-private-grant"], [".source-required", "immutable original-source hold"]] as const) writeFileSync(path.join(child, name), text, { mode: 0o600 });
    mkdirSync(path.join(child, "soul"), { mode: 0o700 }); writeFileSync(path.join(child, "soul", "OWNER.md"), "private local memory remains held", { mode: 0o600 });
  }
  const halt = path.join(home, "FLEET_HALT"); writeFileSync(halt, "operator halt\n", { mode: 0o600 });
  const st = lstatSync(home, { bigint: true }), major = ((st.dev >> 8n) & 0xfffn) | ((st.dev >> 32n) & 0xfffff000n), minor = (st.dev & 0xffn) | ((st.dev >> 12n) & 0xffffff00n);
  const mount = `40 20 ${major}:${minor} / ${home} rw - ext4 /dev/fixture rw\n`;
  const env: NodeJS.ProcessEnv = { MERRYMEN_HOME: home, RAILWAY_VOLUME_MOUNT_PATH: home, MERRYMEN_HOME_VOLUME_ID: "d6481580-14af-430c-af4a-f3540dfb833d", MERRYMEN_HOSTED: "1", MERRYMEN_PERSISTENT_HOME_REQUIRED: "1", MERRYMEN_FLEET_RECOVERY_REPORT_ONLY: "1", MERRYMEN_FLEET_RECOVERY_REPLIES: "1", DATABASE_URL: localUrl };
  const tables = (await pool.query("SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename", [schema])).rows.map(r => String(r.tablename));
  const original = async (except: string[] = ["tenant_telegram"]) => { const rows: unknown[] = []; for (const table of tables.filter(name => !except.includes(name))) rows.push([table, (await pool.query(`SELECT * FROM ${table} ORDER BY ctid`)).rows]); return rows; };
  // health.tenant/bot fail every lease at once; health.lost fails one lease OBJECT
  // (health.current names the newest per tenant or bot), so a lease the
  // listener re-acquires afterwards is healthy again.
  const health = { tenant: true, bot: true, lost: new Set<object>(), current: new Map<string, object>(), acquired: [] as string[] }, logs: string[] = [], audit: string[] = [], sends: Array<{ botId: string; chatId: number; text: string; deadline: number | undefined }> = [], polls: Array<{ botId: string; offset: number; deadline: number | undefined }> = [], replies: string[] = [];
  let hook: ((sql: string, values: unknown[] | undefined, client: Pick<Client, "query"> | null) => Promise<void>) | undefined;
  const audited = async (sql: string, values: unknown[] | undefined, client: Pick<Client, "query"> | null) => {
    audit.push(sql); assert.doesNotMatch(sql, /sealed_session_key|serialized|(?:INSERT INTO|UPDATE|DELETE FROM|ALTER TABLE)\s+(?:agents|trades|cost_basis|risk_periods|fee_accruals|agent_commands|mirror_state|grants|tenant_settings|telegram_bot_claims|fleet_recovery_health)\b/i);
    const result = await (client ?? pool).query(sql, values); await hook?.(sql, values, client); return result;
  };
  // The checked-out client is an EventEmitter in production; the wrapper
  // passes its 'error' subscription through so the entry can listen to it.
  const entryPool: ReplyPool = { query: (sql, values) => audited(sql, values, null), end: () => pool.end(), connect: async () => { const c = await pool.connect(); return { query: (sql, values) => audited(sql, values, c), release: error => c.release(error), on: (event, fn) => c.on?.(event, fn), removeListener: (event, fn) => c.removeListener?.(event, fn) }; } };
  const tenantClients: Client[] = [];
  const tenants = new PgTenantLeaseManager(async () => { const c = new pg.Client({ connectionString: localUrl }); clients.push(c); tenantClients.push(c); return c; });
  const botClient = await connect(), bots = new RecoveryReplyBotLeases(botClient, () => {});
  const transport: Transport = {
    getMe: async opts => ({ bot: { id: Number(opts.token.split(":")[0]), username: `bot_${opts.token.split(":")[0]}`, firstName: "Robin", isBot: true } }),
    getUpdates: async (opts, offset) => { polls.push({ botId: opts.token.split(":")[0]!, offset, deadline: opts.deadlineAtMs }); return updates(); },
    sendMessage: async (opts, chatId, text) => { sends.push({ botId: opts.token.split(":")[0]!, chatId, text, deadline: opts.deadlineAtMs }); return { ok: true, messageId: sends.length }; },
    sendPhotoBytes: async () => ({ ok: false, noDelivery: true, reason: "fixture image refused" }),
    answerCallbackQuery: async () => ({ ok: true }),
  };
  const acquireTenant = async (tenant: `0x${string}`) => { const held = await tenants.acquire(tenant); if (!held) return held; const lease = { ...held, healthy: () => health.tenant && !health.lost.has(lease) && held.healthy() }; health.current.set(tenant, lease); health.acquired.push(tenant); return lease; };
  const run = (extra: Partial<RecoveryReplyOptions> = {}) => runRecoveryReplies({ env, pool: entryPool, dek: DEK, readMountInfo: () => mount, onePass: true, now: () => clock, log: (_stream, line) => { logs.push(line); },
    acquireTenant,
    acquireBot: async id => { const held = await bots.acquire(id); if (!held) return held; const lease = { ...held, healthy: () => health.bot && !health.lost.has(lease) && held.healthy() }; health.current.set(id, lease); return lease; },
    transport, reply: async req => { replies.push(req.text); return { kind: "public", text: "fresh public code read; trading remains held" }; }, ...extra });
  const msg = (id: number, text = "$FROG chart", i = 0, fields: Partial<TgMessage> = {}): TgMessage => ({ updateId: id, messageId: id + 100, chatId: actors[i]!.ownerId, fromId: actors[i]!.ownerId, text, date: Math.floor(clock / 1000), ...fields });
  const offset = async (botId = actors[0]!.botId) => (await pool.query("SELECT * FROM recovery_reply_offsets WHERE bot_id=$1", [botId])).rows[0];
  const prime = async (offsetId = 0, armedAgo = 0) => { await pool.query(RECOVERY_REPLY_SCHEMA); for (const a of actors) await pool.query("INSERT INTO recovery_reply_offsets VALUES($1,$2,$3,4663,$4,200,$5,$6,$7)", [a.botId, a.tenant, a.account, createHash("sha256").update(a.token).digest("hex").slice(0, 16), offsetId, Math.floor(clock / 1000) - armedAgo, clock]); };
  // EVERY LINE THE ENTRY PRINTED IN THIS FIXTURE, held to the redaction rule:
  // a fixed grammar of reason codes, counts and eight-character tenant
  // prefixes, and none of the fixture's tokens, ids, addresses or texts.
  t.after(() => assertRedacted(logs, actors));
  return { actors, pool, connect, env, home, halt, mount, health, logs, transport, sends, polls, replies, audit, run, msg, offset, prime, original, botClient, tenantClients, acquireTenant, clock: () => clock, advance: (ms: number) => { clock += ms; }, hook: (fn: typeof hook) => { hook = fn; } };
}

test("actual reply entry: local PostgreSQL authority, deadlines, cursor handoff and atomic privacy", { skip: !URL, timeout: 120_000 }, async t => {
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new globalThis.URL(URL!).hostname), "LOCAL test database only");
  const beforeDatabaseUrl = process.env.DATABASE_URL;
  t.after(() => assert.equal(process.env.DATABASE_URL, beforeDatabaseUrl, "test must not set DATABASE_URL"));

  await t.test("expired/stopped owner!=tenant scopes reply while every financial table and home fact remains intact", async s => {
    const f = await fixture(s, 2), stopped = f.actors[1]!;
    await f.pool.query("UPDATE grants SET grant_json=jsonb_set(jsonb_set(grant_json,'{expiresAt}','0'),'{replacementStop}',$1::jsonb),sealed_session_key='' WHERE tenant=$2", [JSON.stringify({ sessionKeyHash: "a".repeat(64), sessionKeyAddress: stopped.session, stoppedAt: 2 }), stopped.tenant]);
    f.transport.getUpdates = async opts => updates([f.msg(5, "$FROG chart", Number(opts.token.split(":")[0]) - 801)]);
    const rows = await f.original(), files = fileFacts(f.home);
    await f.run();
    assert.equal(f.sends.length, 2); assert.equal(f.replies.length, 2);
    assert.deepEqual(await f.original(), rows); assert.deepEqual(fileFacts(f.home), files);
    for (const a of f.actors) { assert.equal(Number((await f.offset(a.botId))!.offset_id), 6); assert.equal((await f.pool.query("SELECT child_state FROM tenant_telegram WHERE tenant=$1", [a.tenant])).rows[0]!.child_state, "held:recovery-replies"); }
    assert.ok(f.audit.some(sql => /FOR SHARE NOWAIT/.test(sql))); assert.ok(f.audit.some(sql => /FOR UPDATE/.test(sql)));
  });

  await t.test("default entry-owned PostgreSQL factories reply and close their fenced sessions without cold financial initialization", async s => {
    const f = await fixture(s), a = f.actors[0]!, original = await f.original(), files = fileFacts(f.home), probe = await f.connect();
    const baseSend = f.transport.sendMessage; let heldDuringSend = false;
    f.transport.getUpdates = async () => updates([f.msg(1)], 2);
    f.transport.sendMessage = async (opts, chat, text, extra) => {
      assert.equal((await probe.query("SELECT pg_try_advisory_lock($1::bigint) AS held", [leaseKey(a.tenant).toString()])).rows[0]!.held, false);
      assert.equal(await new RecoveryReplyBotLeases(probe, () => {}).acquire(a.botId), null); heldDuringSend = true;
      return baseSend(opts, chat, text, extra);
    };
    await f.run({ acquireTenant: undefined, acquireBot: undefined });
    assert.equal(heldDuringSend, true); assert.equal(f.sends.length, 1); assert.equal(Number((await f.offset())!.offset_id), 2);
    assert.equal((await probe.query("SELECT pg_try_advisory_lock($1::bigint) AS held", [leaseKey(a.tenant).toString()])).rows[0]!.held, true);
    await probe.query("SELECT pg_advisory_unlock($1::bigint)", [leaseKey(a.tenant).toString()]);
    const bot = await new RecoveryReplyBotLeases(probe, () => {}).acquire(a.botId); assert.ok(bot); await bot.release();
    assert.deepEqual(await f.original(), original); assert.deepEqual(fileFacts(f.home), files);
  });

  await t.test("text send refusal and uncertain delivery are sanitized without stopping another bot or replaying committed updates", async s => {
    const warnings: unknown[][] = [];
    s.mock.method(console, "warn", (...args: unknown[]) => { warnings.push(args); });
    for (const definite of [true, false]) {
      warnings.length = 0;
      const f = await fixture(s, 2), bad = f.actors[0]!, good = f.actors[1]!;
      await f.prime(40, 100);
      const rows = await f.original(), files = fileFacts(f.home), offsets: number[] = [];
      f.transport.getUpdates = async (opts, offset) => { offsets.push(offset); return updates([f.msg(41, "$PUBLIC chart", opts.token === bad.token ? 0 : 1)], 42); };
      const baseSend = f.transport.sendMessage;
      let failedAttempts = 0;
      f.transport.sendMessage = async (opts, chat, text, extra) => {
        if (opts.token !== bad.token) return baseSend(opts, chat, text, extra);
        failedAttempts++;
        assert.equal(Number((await f.offset(bad.botId))!.offset_id), 42, "cursor committed before a refused or uncertain send");
        return { ok: false, reason: `403 synthetic private reason ${bad.token} ${chat}`, ...(definite ? { noDelivery: true } : {}) };
      };
      await f.run();
      assert.deepEqual(warnings, [[definite
        ? "Reply-only Telegram send refused without delivery; update remains acknowledged."
        : "Reply-only Telegram send delivery unconfirmed; update remains acknowledged."]]);
      assert.equal(failedAttempts, 1); assert.equal(f.sends.length, 1); assert.equal(f.sends[0]!.botId, good.botId);
      for (const a of f.actors) assert.equal(Number((await f.offset(a.botId))!.offset_id), 42);
      await f.run();
      assert.deepEqual(offsets, [40, 40, 42, 42]); assert.equal(failedAttempts, 1); assert.equal(f.sends.length, 1); assert.equal(warnings.length, 1);
      assert.deepEqual(await f.original(), rows); assert.deepEqual(fileFacts(f.home), files);
    }
  });

  await t.test("photo outcomes report the final fallback result and never retry uncertain delivery or replay", async s => {
    const warnings: unknown[][] = [];
    s.mock.method(console, "warn", (...args: unknown[]) => { warnings.push(args); });
    for (const scenario of ["text-refused", "text-uncertain", "photo-uncertain", "text-delivered"] as const) {
      warnings.length = 0;
      const f = await fixture(s, 2), bad = f.actors[0]!, good = f.actors[1]!;
      await f.prime(40, 100);
      const rows = await f.original(), files = fileFacts(f.home), offsets: number[] = [];
      f.transport.getUpdates = async (opts, offset) => { offsets.push(offset); return updates([f.msg(41, opts.token === bad.token ? "$PHOTO chart" : "$GOOD chart", opts.token === bad.token ? 0 : 1)], 42); };
      let photoAttempts = 0, fallbackAttempts = 0;
      f.transport.sendPhotoBytes = async (opts, chat) => {
        assert.equal(opts.token, bad.token); photoAttempts++;
        assert.equal(Number((await f.offset(bad.botId))!.offset_id), 42);
        return { ok: false, reason: `synthetic private photo reason ${bad.token} ${chat}`, ...(scenario === "photo-uncertain" ? {} : { noDelivery: true }) };
      };
      const baseSend = f.transport.sendMessage;
      f.transport.sendMessage = async (opts, chat, text, extra) => {
        if (opts.token !== bad.token) return baseSend(opts, chat, text, extra);
        fallbackAttempts++;
        if (scenario === "text-delivered") return baseSend(opts, chat, text, extra);
        return { ok: false, reason: `synthetic private fallback reason ${bad.token} ${chat}`, ...(scenario === "text-refused" ? { noDelivery: true } : {}) };
      };
      const reply: NonNullable<RecoveryReplyOptions["reply"]> = async req => ({ kind: "public", text: req.text, ...(req.text.includes("PHOTO") ? { photo: new Uint8Array([1, 2, 3]) } : {}) });
      await f.run({ reply });
      assert.deepEqual(warnings, scenario === "text-delivered" ? [] : [[scenario === "text-refused"
        ? "Reply-only Telegram send refused without delivery; update remains acknowledged."
        : "Reply-only Telegram send delivery unconfirmed; update remains acknowledged."]]);
      assert.equal(photoAttempts, 1); assert.equal(fallbackAttempts, scenario === "photo-uncertain" ? 0 : 1);
      assert.equal(f.sends.filter(sent => sent.botId === good.botId).length, 1);
      assert.equal(f.sends.filter(sent => sent.botId === bad.botId).length, scenario === "text-delivered" ? 1 : 0);
      for (const a of f.actors) assert.equal(Number((await f.offset(a.botId))!.offset_id), 42);
      await f.run({ reply });
      assert.deepEqual(offsets, [40, 40, 42, 42]); assert.equal(photoAttempts, 1); assert.equal(fallbackAttempts, scenario === "photo-uncertain" ? 0 : 1);
      assert.equal(warnings.length, scenario === "text-delivered" ? 0 : 1);
      assert.deepEqual(await f.original(), rows); assert.deepEqual(fileFacts(f.home), files);
    }
  });

  await t.test("failed or uncertain forget acknowledgements retain durable erasure and receipt without replay or stopping another bot", async s => {
    const warnings: unknown[][] = [];
    s.mock.method(console, "warn", (...args: unknown[]) => { warnings.push(args); });
    for (const definite of [true, false]) {
      warnings.length = 0;
      const f = await fixture(s, 2), bad = f.actors[0]!, good = f.actors[1]!;
      await f.prime(40, 100);
      const rows = await f.original(["tenant_telegram", "tenant_personal_memory", "tenant_tg_groups"]), files = fileFacts(f.home);
      f.transport.getUpdates = async opts => updates([f.msg(41, opts.token === bad.token ? "/forget" : "$GOOD chart", opts.token === bad.token ? 0 : 1)], 42);
      const baseSend = f.transport.sendMessage;
      let failedAttempts = 0, receiptId: string | undefined;
      f.transport.sendMessage = async (opts, chat, text, extra) => {
        if (opts.token !== bad.token) return baseSend(opts, chat, text, extra);
        failedAttempts++; assert.match(text, /forget request was applied/);
        assert.equal(Number((await f.offset(bad.botId))!.offset_id), 42);
        const stored = (await f.pool.query("SELECT sealed FROM tenant_recovery_reply_state WHERE tenant=$1", [bad.tenant])).rows[0]!;
        const state = openRecoveryReplyState(bad.tenant, stored.sealed, DEK);
        assert.equal(state.privacy.length, 1); assert.equal(state.privacy[0]!.kind, "personal-chat"); receiptId = state.privacy[0]!.id;
        const memory = (await f.pool.query("SELECT sealed FROM tenant_personal_memory WHERE tenant=$1", [bad.tenant])).rows[0]!;
        const plain = JSON.parse(openSecret(String(memory.sealed), DEK).split("\n").slice(1).join("\n")) as { chats: Array<{ chatId: number }>; applied: Record<string, string> };
        assert.deepEqual(plain.chats.map(c => c.chatId), [9999]); assert.equal(plain.applied[`chat:${bad.ownerId}`], receiptId);
        return { ok: false, reason: `synthetic private acknowledgement reason ${bad.token} ${chat}`, ...(definite ? { noDelivery: true } : {}) };
      };
      await f.run();
      assert.deepEqual(warnings, [[definite
        ? "Reply-only Telegram send refused without delivery; update remains acknowledged."
        : "Reply-only Telegram send delivery unconfirmed; update remains acknowledged."]]);
      assert.equal(failedAttempts, 1); assert.equal(f.sends.length, 1); assert.equal(f.sends[0]!.botId, good.botId);
      await f.run();
      assert.equal(failedAttempts, 1); assert.equal(f.sends.length, 1); assert.equal(warnings.length, 1);
      const stored = (await f.pool.query("SELECT sealed FROM tenant_recovery_reply_state WHERE tenant=$1", [bad.tenant])).rows[0]!;
      const state = openRecoveryReplyState(bad.tenant, stored.sealed, DEK);
      assert.equal(state.privacy.length, 1); assert.equal(state.privacy[0]!.id, receiptId);
      for (const a of f.actors) assert.equal(Number((await f.offset(a.botId))!.offset_id), 42);
      assert.deepEqual(await f.original(["tenant_telegram", "tenant_personal_memory", "tenant_tg_groups"]), rows); assert.deepEqual(fileFacts(f.home), files);
    }
  });

  await t.test("missing/malformed modes and unsafe halt refuse before any shared SQL", async s => {
    for (const mode of [undefined, "0", "true", " 1", ""]) {
      const f = await fixture(s); f.env.MERRYMEN_FLEET_RECOVERY_REPLIES = mode;
      await assert.rejects(f.run()); assert.equal(f.audit.length, 0);
    }
    const f = await fixture(s); chmodSync(f.halt, 0o644); await assert.rejects(f.run()); assert.equal(f.audit.length, 0);
    const g = await fixture(s); rmSync(g.halt); await assert.rejects(g.run()); assert.equal(g.audit.length, 0);
  });

  await t.test("an explicit empty accounting hold list replies under the unchanged global halt", async s => {
    const f = await fixture(s);
    f.env.MERRYMEN_ACCOUNTING_HOLD_TENANTS = "";
    f.transport.getUpdates = async () => updates([f.msg(1)], 2);
    const rows = await f.original(), files = fileFacts(f.home);
    await f.run();
    assert.equal(f.sends.length, 1); assert.equal(Number((await f.offset())!.offset_id), 2);
    assert.equal(f.env.MERRYMEN_ACCOUNTING_HOLD_TENANTS, "");
    assert.equal(f.env.MERRYMEN_FLEET_RECOVERY_REPORT_ONLY, "1");
    assert.equal(f.env.MERRYMEN_FLEET_RECOVERY_REPLIES, "1");
    assert.deepEqual(await f.original(), rows); assert.deepEqual(fileFacts(f.home), files);
  });

  await t.test("missing hold/link/claim stays unavailable and malformed grants/tokens skip only that tenant without initialization", async s => {
    for (const sql of ["DELETE FROM fleet_recovery_health", "UPDATE tenant_telegram SET owner_id=NULL", "DELETE FROM telegram_bot_claims"]) {
      const f = await fixture(s); await f.pool.query(sql); const before = await f.original(); await f.run(); assert.equal(f.sends.length, 0); assert.deepEqual(await f.original(), before); assert.equal(existsSync(path.join(f.home, "persistent-home.json")), false);
      assert.equal((await f.pool.query("SELECT to_regclass('recovery_reply_offsets') AS table")).rows[0]!.table, null);
    }
    // A malformed row or sealed scope used to refuse the whole listener. Now it
    // is that tenant's alone: skipped with a redacted [alert], still fenced, and
    // nothing is initialized on its behalf.
    for (const broken of ["grant", "token"]) {
      const f = await fixture(s), probe = await f.connect(), tag = f.actors[0]!.tenant.slice(0, 8);
      if (broken === "grant") await f.pool.query("UPDATE grants SET grant_json='{}'");
      else await f.pool.query("UPDATE tenant_settings SET sealed=$1", [sealSecret(JSON.stringify({ telegramEnabled: true, telegramBotToken: "not-a-token", telegramAllowlist: [701] }), DEK)]);
      let fenced = false;
      // The probe runs inside the entry's own awaited queries, never beside a lease acquisition; a lock it wins is handed straight back.
      f.hook(async () => {
        if (fenced) return;
        const key = leaseKey(f.actors[0]!.tenant).toString();
        if ((await probe.query("SELECT pg_try_advisory_lock($1::bigint) AS held", [key])).rows[0]!.held === true) await probe.query("SELECT pg_advisory_unlock($1::bigint)", [key]);
        else fenced = true;
      });
      assert.equal(await f.run(), "one-pass"); assert.equal(f.sends.length, 0); assert.equal(f.polls.length, 0);
      assert.equal((await f.pool.query("SELECT to_regclass('recovery_reply_offsets') AS table")).rows[0]!.table, null);
      assert.ok(f.logs.includes(broken === "grant" ? `[recovery-replies] [alert] roster-row-skipped tenant=${tag}` : `[recovery-replies] [alert] admit-wait tenant=${tag} reason=snapshot-invalid retry=60s`), f.logs.join("\n"));
      if (broken === "token") assert.equal(fenced, true, "a tenant whose scope cannot be read stays fenced while the listener runs");
    }
  });

  await t.test("omitted allowlist with a valid or malformed token leaves linked owner unavailable while all tenant leases and another bot remain active", async s => {
    for (const malformedToken of [false, true]) {
      const f = await fixture(s, 2), missing = f.actors[0]!, good = f.actors[1]!, probe = await f.connect();
      const settings = (await f.pool.query("SELECT sealed FROM tenant_settings WHERE tenant=$1", [missing.tenant])).rows[0]!;
      const cfg = JSON.parse(openSecret(String(settings.sealed), DEK));
      delete cfg.telegramAllowlist;
      if (malformedToken) cfg.telegramBotToken = "synthetic malformed nonempty token";
      await f.pool.query("UPDATE tenant_settings SET sealed=$1 WHERE tenant=$2", [sealSecret(JSON.stringify(cfg), DEK), missing.tenant]);
      const rows = await f.original(), files = fileFacts(f.home);
      const linkBefore = (await f.pool.query("SELECT * FROM tenant_telegram WHERE tenant=$1", [missing.tenant])).rows[0]!;
      assert.equal(Number(linkBefore.owner_id), missing.ownerId); assert.ok(Number(linkBefore.linked_at) > 0); assert.equal(linkBefore.bot_id, missing.botId);
      const providerBots: string[] = [], baseMe = f.transport.getMe, baseSend = f.transport.sendMessage;
      let missingTenantHeld = false;
      f.transport.getMe = async opts => {
        assert.equal(opts.token, good.token); providerBots.push(`me:${good.botId}`);
        assert.equal((await probe.query("SELECT pg_try_advisory_lock($1::bigint) AS held", [leaseKey(missing.tenant).toString()])).rows[0]!.held, false);
        missingTenantHeld = true;
        return baseMe(opts);
      };
      f.transport.getUpdates = async opts => { assert.equal(opts.token, good.token); providerBots.push(`poll:${good.botId}`); return updates([f.msg(1, "$GOOD chart", 1)], 2); };
      f.transport.sendMessage = async (opts, chat, text, extra) => { assert.equal(opts.token, good.token); providerBots.push(`send:${good.botId}`); return baseSend(opts, chat, text, extra); };
      await f.run();
      assert.equal(missingTenantHeld, true); assert.deepEqual(providerBots, [`me:${good.botId}`, `poll:${good.botId}`, `send:${good.botId}`]);
      assert.equal(f.sends.length, 1); assert.equal(f.sends[0]!.botId, good.botId); assert.deepEqual(f.replies, ["$GOOD chart"]);
      assert.equal(await f.offset(missing.botId), undefined); assert.equal(Number((await f.offset(good.botId))!.offset_id), 2);
      assert.deepEqual((await f.pool.query("SELECT * FROM tenant_telegram WHERE tenant=$1", [missing.tenant])).rows[0], linkBefore);
      assert.deepEqual(await f.original(), rows); assert.deepEqual(fileFacts(f.home), files);
    }
  });

  await t.test("present null, scalar, object and malformed allowlists refuse that tenant before provider calls or offset initialization; another bot replies", async s => {
    for (const allowlist of [null, 701, "701", { owner: 701 }, ["701"], [0]]) {
      const f = await fixture(s, 2), bad = f.actors[0]!, good = f.actors[1]!;
      await f.pool.query("UPDATE tenant_settings SET sealed=$1 WHERE tenant=$2", [sealSecret(JSON.stringify({ telegramEnabled: true, telegramBotToken: bad.token, telegramAllowlist: allowlist }), DEK), bad.tenant]);
      const rows = await f.original(), files = fileFacts(f.home), badLink = (await f.pool.query("SELECT * FROM tenant_telegram WHERE tenant=$1", [bad.tenant])).rows;
      let providerCalls = 0;
      const baseMe = f.transport.getMe;
      f.transport.getMe = async opts => { if (opts.token === bad.token) { providerCalls++; throw new Error("malformed scope must not call getMe"); } return baseMe(opts); };
      f.transport.getUpdates = async opts => { if (opts.token === bad.token) { providerCalls++; throw new Error("malformed scope must not poll"); } return updates([f.msg(1, "$GOOD chart", 1)]); };
      await f.run();
      assert.equal(providerCalls, 0); assert.equal(f.sends.length, 1); assert.equal(f.sends[0]!.botId, good.botId); assert.deepEqual(f.replies, ["$GOOD chart"]);
      assert.equal(await f.offset(bad.botId), undefined); assert.equal(Number((await f.offset(good.botId))!.offset_id), 2);
      assert.ok(f.logs.includes(`[recovery-replies] [alert] admit-wait tenant=${bad.tenant.slice(0, 8)} reason=snapshot-invalid retry=60s`), f.logs.join("\n"));
      assert.deepEqual((await f.pool.query("SELECT * FROM tenant_telegram WHERE tenant=$1", [bad.tenant])).rows, badLink);
      assert.deepEqual(await f.original(), rows); assert.deepEqual(fileFacts(f.home), files);
    }
  });

  await t.test("real tenant/bot contention skips only that tenant and releases every successfully acquired lease", async s => {
    const f = await fixture(s, 2), foreign = await f.connect(), [a, b] = [f.actors[0]!, f.actors[1]!], tag = a.tenant.slice(0, 8);
    await foreign.query("SELECT pg_advisory_lock($1::bigint)", [leaseKey(a.tenant).toString()]);
    await f.run(); assert.equal(f.sends.length, 0); assert.deepEqual(f.polls.map(p => p.botId), [b.botId]);
    assert.ok(f.logs.includes(`[recovery-replies] [alert] admit-wait tenant=${tag} reason=lease-busy retry=5s`), f.logs.join("\n"));
    assert.equal(await f.offset(a.botId), undefined);
    await foreign.query("SELECT pg_advisory_unlock($1::bigint)", [leaseKey(a.tenant).toString()]);
    const other = new RecoveryReplyBotLeases(foreign, () => {}), held = await other.acquire(a.botId); assert.ok(held);
    await f.run(); assert.deepEqual(f.polls.map(p => p.botId), [b.botId, b.botId]);
    assert.ok(f.logs.includes(`[recovery-replies] [alert] admit-wait tenant=${tag} reason=bot-busy retry=5s`), f.logs.join("\n"));
    // Every lease this listener took is released when it returns.
    assert.equal((await foreign.query("SELECT pg_try_advisory_lock($1::bigint) AS held", [leaseKey(a.tenant).toString()])).rows[0]!.held, true);
    await foreign.query("SELECT pg_advisory_unlock($1::bigint)", [leaseKey(a.tenant).toString()]);
    await held.release();
    await f.run(); assert.equal(Number((await f.offset())!.offset_id), 0); assert.equal(f.polls.filter(p => p.botId === a.botId).length, 1);
  });

  await t.test("approved group request grammar answers actual phrasing and rejects ordinary, mixed, anonymous and unapproved lines", async s => {
    const f = await fixture(s), a = f.actors[0]!, ca = address(888), username = `bot_${a.botId}`;
    const text = [`Thoughts on ${ca}`, `what about ${ca}`, `Robin chart ${ca}`, `@${username} lore ${ca}`, "check out cashcat, I think good entry?", "how is the market currently", ca, "cashcat looking good", "$CASHCAT", `Thoughts on ${ca} and DOG`, `buy ${ca}`];
    const messages = text.map((line, i) => f.msg(i + 1, line, 0, { chatId: a.room, fromId: 777 }));
    messages.push(f.msg(20, `chart ${ca}`, 0, { chatId: a.room - 100, fromId: 777 }), f.msg(21, `chart ${ca}`, 0, { chatId: a.room, fromId: 777, senderChatId: a.room }));
    f.transport.getUpdates = async () => updates(messages);
    await f.run();
    assert.equal(f.sends.length, 7); assert.equal(f.replies.length, 7);
    assert.ok(f.replies.some(line => line.startsWith("Thoughts on"))); assert.ok(f.replies.includes(`chart ${ca}`)); assert.ok(f.replies.includes(ca));
    assert.ok(f.replies.every(line => !/buy|DOG|looking good|\$CASHCAT/.test(line)));
    assert.equal(Number((await f.offset())!.offset_id), 22);
  });

  await t.test("sealed and operator group toggles suppress public scope while keeping direct replies and actual privacy erasure", async s => {
    for (const flag of ["telegramGroupsEnabled", "telegramGroupCoinsEnabled", "operator-0", "operator-false"] as const) {
      const f = await fixture(s), a = f.actors[0]!, ca = address(888);
      if (flag === "operator-0" || flag === "operator-false") f.env.MERRYMEN_TG_GROUPS = flag.slice("operator-".length);
      else await f.pool.query("UPDATE tenant_settings SET sealed=$1", [sealSecret(JSON.stringify({ telegramEnabled: true, telegramBotToken: a.token, telegramAllowlist: [a.ownerId, a.room], [flag]: false }), DEK)]);
      const original = await f.original(["tenant_telegram", "tenant_tg_groups"]), files = fileFacts(f.home);
      f.transport.getUpdates = async () => updates([
        f.msg(1, `Thoughts on ${ca}`, 0, { chatId: a.room, fromId: 777 }),
        f.msg(2, "how is the market currently", 0, { chatId: a.room, fromId: 777 }),
        f.msg(3, `chart ${ca}`), f.msg(4, "how is the market currently"),
        f.msg(5, "/forgetme", 0, { chatId: a.room, fromId: a.ownerId }),
      ], 6);
      await f.run();
      const groupMarket = flag === "telegramGroupCoinsEnabled";
      assert.equal(f.sends.length, groupMarket ? 4 : 3); assert.equal(f.replies.length, groupMarket ? 3 : 2);
      assert.equal(f.replies.filter(text => text === `chart ${ca}`).length, 1); assert.ok(!f.replies.some(text => text.startsWith("Thoughts on")));
      assert.equal(f.replies.filter(text => text === "how is the market currently").length, groupMarket ? 2 : 1);
      assert.equal(f.sends.filter(sent => sent.chatId === a.room && !/forget request/.test(sent.text)).length, groupMarket ? 1 : 0);
      assert.ok(f.sends.some(sent => sent.chatId === a.room && /forget request was applied/.test(sent.text)));
      const sealed = (await f.pool.query("SELECT sealed FROM tenant_tg_groups WHERE tenant=$1", [a.tenant])).rows[0]!.sealed;
      const group = JSON.parse(openSecret(String(sealed), DEK).split("\n").slice(1).join("\n"));
      assert.equal(group.rooms[a.room].lines.length, 0);
      const stored = (await f.pool.query("SELECT sealed FROM tenant_recovery_reply_state WHERE tenant=$1", [a.tenant])).rows[0]!;
      const state = openRecoveryReplyState(a.tenant, stored.sealed, DEK); assert.equal(state.privacy.length, 1); assert.equal(state.privacy[0]!.kind, "person");
      assert.equal(Number((await f.offset())!.offset_id), 6); assert.deepEqual(await f.original(["tenant_telegram", "tenant_tg_groups"]), original); assert.deepEqual(fileFacts(f.home), files);
    }
  });

  await t.test("a why reply to this bot asks for context without reading prior messages or guessing WHY", async s => {
    const f = await fixture(s), a = f.actors[0]!; let reads = 0;
    f.transport.getUpdates = async () => updates([f.msg(1, "why", 0, { chatId: a.room, fromId: 777, replyTo: { messageId: 98, fromId: Number(a.botId), fromIsBot: true, text: "unavailable prior private context about FROG" } })]);
    await f.run({ reply: createRecoveryPublicReply({ now: f.clock, look: async () => { reads++; throw new Error("must not guess an asset"); } }) });
    assert.equal(reads, 0); assert.equal(f.sends.length, 1); assert.equal(f.sends[0]!.text, RECOVERY_PUBLIC_CONTEXT); assert.equal(Number((await f.offset())!.offset_id), 2);
  });

  await t.test("casual DMs and addressed approved-room greetings reply without lookup or changing financial state", async s => {
    const f = await fixture(s), a = f.actors[0]!; let reads = 0;
    const rows = await f.original(), files = fileFacts(f.home);
    f.transport.getUpdates = async () => updates([
      f.msg(1, "Hiii"), f.msg(2, "eh"), f.msg(3, "how are you?"),
      f.msg(4, "Hiii", 0, { chatId: 777, fromId: 777 }),
      f.msg(5, "Hiii", 0, { chatId: a.room, fromId: 777 }),
      f.msg(6, "Robin, Hiii!", 0, { chatId: a.room, fromId: 777 }),
      f.msg(7, "eh", 0, { chatId: a.room, fromId: 777, replyTo: { messageId: 98, fromId: Number(a.botId), fromIsBot: true, text: "private earlier context must not be used" } }),
      f.msg(8, "@bot_801 Hiii", 0, { chatId: a.room - 100, fromId: 777 }),
      f.msg(9, "hi, buy FROG"),
    ]);
    await f.run({ reply: createRecoveryPublicReply({ now: f.clock, look: async () => { reads++; throw new Error("casual messages must not look up coins"); } }) });
    assert.equal(reads, 0); assert.equal(f.sends.length, 6);
    assert.equal(f.sends.filter(sent => sent.chatId === a.room).length, 2);
    const held = f.sends.filter(sent => sent.text === RECOVERY_PUBLIC_HELD);
    assert.equal(held.length, 1);
    for (const sent of f.sends.filter(sent => sent !== held[0])) {
      assert.equal(sent.text, RECOVERY_PUBLIC_GREETING);
      assert.match(sent.text, /upgrade.*underway/); assert.match(sent.text, /trading is temporarily paused/);
      assert.doesNotMatch(sent.text, /fresh public data|data recovery|accounting|earlier context/);
    }
    assert.equal(Number((await f.offset())!.offset_id), 10);
    assert.deepEqual(await f.original(), rows); assert.deepEqual(fileFacts(f.home), files);
    assert.equal((await f.pool.query("SELECT child_state FROM tenant_telegram WHERE tenant=$1", [a.tenant])).rows[0]!.child_state, "held:recovery-replies");
  });

  await t.test("slash research reaches public code; financial slash/button instructions stay held", async s => {
    const f = await fixture(s);
    f.transport.getUpdates = async () => ({ ...updates([f.msg(1, "/chart FROG"), f.msg(2, "/lore FROG"), f.msg(3, "/market"), f.msg(4, "/buy FROG")], 6), callbacks: [{ updateId: 5, id: "old-financial-button", chatId: 701, fromId: 701, messageId: 100, data: "confirm-buy", date: Math.floor(f.clock() / 1000) }] });
    const callbacks: string[] = []; f.transport.answerCallbackQuery = async (_opts, _id, text) => { callbacks.push(text ?? ""); return { ok: true }; };
    await f.run(); assert.deepEqual([...f.replies].sort(), ["/chart FROG", "/lore FROG", "/market"].sort()); assert.ok(f.sends.some(sent => sent.text === RECOVERY_PUBLIC_HELD)); assert.equal(callbacks[0], RECOVERY_PUBLIC_BUTTON_HELD);
    assert.equal(Number((await f.offset())!.offset_id), 6);
  });

  await t.test("filtered updates advance durable high-water and restart/token rebind never rewind or replay", async s => {
    const f = await fixture(s); const offsets: number[] = [];
    f.transport.getUpdates = async (_opts, offset) => { offsets.push(offset); return updates([], 101); }; await f.run(); assert.equal(Number((await f.offset())!.offset_id), 101);
    f.transport.getUpdates = async (_opts, offset) => { offsets.push(offset); return updates([f.msg(100, "$FROG chart"), f.msg(101, "$FROG chart")], 102); }; await f.run(); assert.equal(f.sends.length, 1); assert.deepEqual(offsets, [0, 101]);
    f.advance(5000); const a = f.actors[0]!, newToken = `${a.botId}:replacement_fixture_token`;
    await f.pool.query("UPDATE tenant_settings SET sealed=$1", [sealSecret(JSON.stringify({ telegramEnabled: true, telegramBotToken: newToken, telegramAllowlist: [a.ownerId] }), DEK)]);
    f.transport.getUpdates = async (_opts, offset) => { offsets.push(offset); return updates([f.msg(102, "$FROG chart", 0, { date: Math.floor(f.clock() / 1000) - 1 }), f.msg(103, "$FROG chart")], 104); }; await f.run();
    const row = (await f.offset())!; assert.equal(Number(row.offset_id), 104); assert.equal(Number(row.armed_at), Math.floor(f.clock() / 1000)); assert.equal(row.token_tag, createHash("sha256").update(newToken).digest("hex").slice(0, 16)); assert.equal(f.sends.length, 2); assert.deepEqual(offsets, [0, 101, 102]);
  });

  await t.test("a slow bot poll/read/send cannot block another bot; late units do not get a new deadline", async s => {
    for (const phase of ["poll", "read", "send"]) {
      const f = await fixture(s, 2); const events: string[] = [];
      let release!: () => void; const stalled = new Promise<void>(resolve => { release = resolve; });
      const baseSend = f.transport.sendMessage;
      f.transport.getUpdates = async opts => { const i = Number(opts.token.split(":")[0]) - 801; if (i === 0 && phase === "poll") { events.push("slow-start"); await stalled; } return updates([f.msg(1, i === 0 ? "$SLOW chart" : "$FAST chart", i)]); };
      const run = f.run({ reply: async req => { if (req.text.includes("SLOW") && phase === "read") { events.push("slow-read"); await stalled; } return { kind: "public", text: req.text }; }, transport: { ...f.transport, sendMessage: async (opts, chatId, text, extra) => { const slow = opts.token.startsWith("801:"); if (slow && phase === "send") { events.push("slow-send"); await stalled; } if (!slow) { events.push("fast-send"); release(); } return baseSend(opts, chatId, text, extra); } } });
      await run; assert.ok(events.includes("fast-send")); assert.equal(f.sends.length, 2); assert.ok(f.sends.every(sent => sent.deadline! <= f.clock() + 30_000));
    }
    const f = await fixture(s); await f.prime(0, 100); const at = f.clock();
    f.transport.getUpdates = async () => updates([f.msg(1, "$FROG chart", 0, { date: Math.floor(at / 1000) - 20 }), f.msg(2, "$FROG chart", 0, { date: Math.floor(at / 1000) - 20 })]);
    let reads = 0;
    await f.run({ reply: async req => { assert.equal(req.deadlineMs, at + 10_000); reads++; f.advance(11_000); return { kind: "public", text: "late read discarded" }; } });
    assert.ok(reads >= 1); assert.equal(f.sends.length, 0); assert.equal(Number((await f.offset())!.offset_id), 3);
  });

  await t.test("provider-quarantined actors retain leases while other proven bots reply; one bot's conflict backs off only that bot", async s => {
    for (const failure of ["getMe-401", "getMe-404", "wrong-bot", "poll-401", "poll-404"] as const) {
      const f = await fixture(s, 2), bad = f.actors[0]!, good = f.actors[1]!, other = await f.connect();
      await f.pool.query("UPDATE tenant_telegram SET poll_ok_at=$1 WHERE tenant=$2", [Math.floor(f.clock() / 1000), bad.tenant]);
      const original = await f.original(), files = fileFacts(f.home), baseMe = f.transport.getMe, baseSend = f.transport.sendMessage;
      f.transport.getMe = async opts => {
        if (!opts.token.startsWith(`${bad.botId}:`)) return baseMe(opts);
        if (failure === "wrong-bot") return { bot: { id: Number(good.botId), username: `bot_${good.botId}`, firstName: "Robin", isBot: true } };
        return failure.startsWith("getMe") ? { bot: null, reason: "synthetic invalid credentials", errorCode: Number(failure.slice(-3)) } : baseMe(opts);
      };
      f.transport.getUpdates = async opts => opts.token.startsWith(`${bad.botId}:`) ? { ...updates(), reason: "synthetic provider quarantine", errorCode: Number(failure.slice(-3)) } : updates([f.msg(1, "$GOOD chart", 1)]);
      let checkedRetained = false;
      f.transport.sendMessage = async (opts, chat, text, extra) => {
        assert.equal(opts.token.split(":")[0], good.botId);
        const tenantLock = await other.query("SELECT pg_try_advisory_lock($1::bigint) AS held", [leaseKey(bad.tenant).toString()]);
        assert.equal(tenantLock.rows[0]!.held, false, "quarantined tenant must remain fenced until listener shutdown");
        const competing = new RecoveryReplyBotLeases(other, () => {}); assert.equal(await competing.acquire(bad.botId), null, "quarantined Telegram stream must remain fenced");
        checkedRetained = true; return baseSend(opts, chat, text, extra);
      };
      await f.run(); assert.equal(checkedRetained, true); assert.equal(f.sends.length, 1); assert.deepEqual(f.replies, ["$GOOD chart"]);
      assert.equal(Number((await f.offset(good.botId))!.offset_id), 2);
      const badOffset = await f.offset(bad.botId); assert.equal(badOffset ? Number(badOffset.offset_id) : 0, 0);
      const liveness = (await f.pool.query("SELECT poll_ok_at,poll_err,child_state FROM tenant_telegram WHERE tenant=$1", [bad.tenant])).rows[0]!;
      assert.equal(liveness.poll_ok_at, null); assert.match(String(liveness.poll_err), /reply listener unavailable/); assert.equal(liveness.child_state, "held:recovery-replies");
      assert.equal(Number((await f.pool.query("SELECT poll_ok_at FROM tenant_telegram WHERE tenant=$1", [good.tenant])).rows[0]!.poll_ok_at), Math.floor(f.clock() / 1000));
      const releasedTenant = await other.query("SELECT pg_try_advisory_lock($1::bigint) AS held", [leaseKey(bad.tenant).toString()]); assert.equal(releasedTenant.rows[0]!.held, true);
      await other.query("SELECT pg_advisory_unlock($1::bigint)", [leaseKey(bad.tenant).toString()]);
      const releasedBot = await new RecoveryReplyBotLeases(other, () => {}).acquire(bad.botId); assert.ok(releasedBot); await releasedBot.release();
      assert.deepEqual(await f.original(), original); assert.deepEqual(fileFacts(f.home), files);
    }
    // A 409 used to refuse the whole listener. One bot's conflict is that
    // bot's: marked on its existing liveness columns in the dashboard's format,
    // backed off, and the other bot keeps answering.
    for (const phase of ["getMe", "poll"] as const) {
      const f = await fixture(s, 2), baseMe = f.transport.getMe, bad = f.actors[0]!, good = f.actors[1]!;
      await f.pool.query("UPDATE tenant_telegram SET poll_ok_at=$1 WHERE tenant=$2", [Math.floor(f.clock() / 1000), bad.tenant]);
      const original = await f.original(), files = fileFacts(f.home);
      f.transport.getMe = async opts => opts.token.startsWith("801:") && phase === "getMe" ? { bot: null, reason: "Conflict: terminated by other getUpdates request", errorCode: 409 } : baseMe(opts);
      f.transport.getUpdates = async opts => { if (opts.token.startsWith("801:")) return { ...updates(), reason: "Conflict: terminated by other getUpdates request", errorCode: 409 }; return updates([f.msg(1, "$GOOD chart", 1)]); };
      assert.equal(await f.run(), "one-pass");
      assert.equal(f.sends.length, 1); assert.equal(f.sends[0]!.botId, good.botId); assert.equal(Number((await f.offset(good.botId))!.offset_id), 2);
      const marked = (await f.pool.query("SELECT poll_ok_at,poll_err,poll_err_at,child_state FROM tenant_telegram WHERE tenant=$1", [bad.tenant])).rows[0]!;
      assert.equal(marked.poll_ok_at, null); assert.equal(marked.poll_err, "conflict: another program is reading this bot's updates (409)");
      assert.equal(Number(marked.poll_err_at), Math.floor(f.clock() / 1000)); assert.equal(marked.child_state, "held:recovery-replies");
      assert.ok(f.logs.includes(`[recovery-replies] [alert] backoff tenant=${bad.tenant.slice(0, 8)} reason=telegram-409 wait=60s`), f.logs.join("\n"));
      const badOffset = await f.offset(bad.botId); assert.equal(badOffset ? Number(badOffset.offset_id) : 0, 0);
      assert.deepEqual(await f.original(), original); assert.deepEqual(fileFacts(f.home), files);
    }
  });

  await t.test("temporary getMe and poll failures retry without changing the cursor or resetting message deadlines", async s => {
    const f = await fixture(s), stop = new AbortController(); await f.prime(37, 100);
    const original = await f.original(), baseMe = f.transport.getMe, at = f.clock(), offsets: number[] = [], pollDeadlines: number[] = [];
    let identityCalls = 0, polls = 0;
    f.transport.getMe = async opts => ++identityCalls === 1 ? { bot: null, reason: "temporary provider outage", errorCode: 503 } : baseMe(opts);
    f.transport.getUpdates = async (opts, offset) => {
      offsets.push(offset); pollDeadlines.push(opts.deadlineAtMs!); polls++;
      if (polls === 1) return { ...updates([], 999), reason: "temporary poll outage", errorCode: 503, retryAfter: 0 };
      if (polls === 2) return updates([f.msg(37)], 38);
      stop.abort(); return updates([], 10000);
    };
    const watchdog = setTimeout(() => stop.abort(), 8000);
    // The trusted stop signal is a clean stop: the entry resolves, it does not refuse.
    try { assert.equal(await f.run({ onePass: undefined, stopSignal: stop.signal }), "stopped"); } finally { clearTimeout(watchdog); stop.abort(); }
    assert.equal(identityCalls, 2); assert.deepEqual(offsets, [37, 37, 38]); assert.ok(pollDeadlines.every(deadline => deadline === at + 8000));
    assert.equal(f.sends.length, 1); assert.equal(f.sends[0]!.deadline, at + 30000); assert.equal(Number((await f.offset())!.offset_id), 38); assert.deepEqual(await f.original(), original);
    f.transport.getMe = baseMe; f.transport.getUpdates = async (_opts, offset) => { assert.equal(offset, 38); return updates([f.msg(38)], 39); };
    await f.run(); assert.equal(f.sends.length, 2); assert.equal(Number((await f.offset())!.offset_id), 39);
  });

  await t.test("normal runtime drains old hundred-update batches before a fresh reply without resetting its original deadline", async s => {
    const f = await fixture(s), stop = new AbortController(); await f.prime(0, 100);
    const at = f.clock(), original = await f.original(), offsets: number[] = []; let polls = 0, reads = 0, firstPollWall = 0, sentWall = 0;
    const baseSend = f.transport.sendMessage;
    f.transport.getUpdates = async (opts, offset) => {
      offsets.push(offset); assert.equal(opts.deadlineAtMs, f.clock() + 8000);
      if (++polls <= 4) {
        if (!firstPollWall) firstPollWall = Date.now(); f.advance(4000);
        const first = (polls - 1) * 100 + 1;
        return updates(Array.from({ length: 100 }, (_, i) => f.msg(first + i, "$STALE chart", 0, { date: Math.floor(at / 1000) - 31 })), first + 100);
      }
      if (polls === 5) { f.advance(4000); return updates([f.msg(401, "$FRESH chart", 0, { date: Math.floor(at / 1000) })], 402); }
      stop.abort(); return updates([], 10000);
    };
    f.transport.sendMessage = async (opts, chat, text, extra) => { sentWall = Date.now(); assert.equal(opts.deadlineAtMs, at + 30000); return baseSend(opts, chat, text, extra); };
    const watchdog = setTimeout(() => stop.abort(), 30000);
    try { assert.equal(await f.run({ onePass: undefined, stopSignal: stop.signal, reply: async req => { reads++; assert.equal(req.text, "$FRESH chart"); assert.equal(req.deadlineMs, at + 30000); return { kind: "public", text: "fresh public read" }; } }), "stopped"); }
    finally { clearTimeout(watchdog); stop.abort(); }
    assert.deepEqual(offsets, [0, 101, 201, 301, 401, 402]); assert.equal(reads, 1); assert.equal(f.sends.length, 1); assert.ok(sentWall - firstPollWall < 30000);
    assert.equal(Number((await f.offset())!.offset_id), 402); assert.deepEqual(await f.original(), original);
  });

  await t.test("fleet-wide public and response caps admit bounded work without queuing or late sends", async s => {
    // Keep the public-work and response bounds independent: held sends use
    // pinned transaction clients, so the read fixture leaves eight pool slots.
    for (const scenario of [{ bots: 1, perBot: 16, public: true }, { bots: 2, perBot: 8, public: true }, { bots: 3, perBot: 16, public: false }]) {
      const f = await fixture(s, scenario.bots), stop = new AbortController(), at = f.clock();
      const original = await f.original(), drained = new Set<Pick<Client, "query">>();
      let drains = 0, releaseDrains!: () => void, releaseWork!: () => void, admitted!: () => void, batchReady!: () => void;
      const drainBarrier = new Promise<void>(resolve => { releaseDrains = resolve; }), workBarrier = new Promise<void>(resolve => { releaseWork = resolve; }), ready = new Promise<void>(resolve => { admitted = resolve; }), committed = new Promise<void>(resolve => { batchReady = resolve; });
      let reads = 0, activeReads = 0, peakReads = 0, activeSends = 0, peakSends = 0;
      const expectedReads = scenario.public ? 8 : 0, expectedActiveSends = scenario.public ? 8 : 16;
      const checkReady = () => { if (activeReads === expectedReads && activeSends === expectedActiveSends) admitted(); };
      f.hook(async (sql, _values, client) => {
        if (/^UPDATE tenant_telegram SET poll_ok_at/.test(sql)) drained.add(client!);
        if (sql === "COMMIT" && client && drained.delete(client)) { if (++drains === scenario.bots) { releaseDrains(); batchReady(); } await drainBarrier; }
      });
      f.transport.getUpdates = async opts => { const i = Number(opts.token.split(":")[0]) - 801; return updates(Array.from({ length: scenario.perBot }, (_, n) => f.msg(n + 1, scenario.public ? "$FROG chart" : "/status", i)), scenario.perBot + 1); };
      const baseSend = f.transport.sendMessage;
      f.transport.sendMessage = async (opts, chat, text, extra) => {
        assert.equal(opts.deadlineAtMs, at + 30000); assert.ok(f.clock() < opts.deadlineAtMs!);
        activeSends++; peakSends = Math.max(peakSends, activeSends); checkReady();
        try { await workBarrier; return baseSend(opts, chat, text, extra); } finally { activeSends--; }
      };
      const run = f.run({ stopSignal: stop.signal, reply: async req => {
        assert.equal(req.deadlineMs, at + 30000); reads++; activeReads++; peakReads = Math.max(peakReads, activeReads); checkReady();
        try { await workBarrier; return { kind: "public", text: "bounded public read" }; } finally { activeReads--; }
      } }).then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
      try {
        await Promise.race([committed, run.then(() => { throw new Error("actor stopped before the cap fixture's committed drain"); }), delay(15000, undefined, { ref: false }).then(() => { throw new Error("cap fixture startup did not finish"); })]);
        await Promise.race([ready, delay(1250, undefined, { ref: false }).then(() => { throw new Error(`bounded work was not admitted: reads=${reads}, sends=${activeSends}`); })]);
        assert.equal(reads, expectedReads); assert.equal(peakReads, expectedReads); assert.equal(peakSends, expectedActiveSends); releaseWork();
        const result = await run; assert.equal(result.ok, true);
        assert.equal(f.sends.length, scenario.public ? 16 : 32);
        if (scenario.public) assert.equal(f.sends.filter(sent => /handling several public requests/.test(sent.text)).length, 8);
        for (const a of f.actors) { assert.ok(f.sends.filter(sent => sent.botId === a.botId).length <= 16); assert.equal(Number((await f.offset(a.botId))!.offset_id), scenario.perBot + 1); }
        assert.deepEqual(await f.original(), original);
      } finally { releaseDrains(); releaseWork(); stop.abort(); await run; }
    }

    const late = await fixture(s, 2); await late.prime(0, 100); const receivedAt = late.clock();
    let lateReads = 0, releaseLate!: () => void, allLate!: () => void;
    const lateBarrier = new Promise<void>(resolve => { releaseLate = resolve; }), lateReady = new Promise<void>(resolve => { allLate = resolve; });
    late.transport.getUpdates = async opts => { const i = Number(opts.token.split(":")[0]) - 801; return updates(Array.from({ length: 4 }, (_, n) => late.msg(n + 1, "$FROG chart", i, { date: Math.floor(receivedAt / 1000) - 20 })), 5); };
    const lateRun = late.run({ reply: async req => { assert.equal(req.deadlineMs, receivedAt + 10000); if (++lateReads === 8) allLate(); await lateBarrier; return { kind: "public", text: "late public result discarded" }; } });
    try { await lateReady; late.advance(11000); } finally { releaseLate(); }
    await lateRun; assert.equal(lateReads, 8); assert.equal(late.sends.length, 0);
    for (const a of late.actors) assert.equal(Number((await late.offset(a.botId))!.offset_id), 5);
  });

  await t.test("link/token/allowlist/grant/lease changes during a transaction stop that actor and roll back its cursor; a halt change refuses the fleet", async s => {
    // Each scope change is this tenant's: its actor stops under the change's own
    // reason and its uncommitted cursor rolls back. Only the root proof (the
    // halt) is fleet-wide.
    const reasons: Record<string, string> = { link: "snapshot-invalid", token: "snapshot-invalid", allowlist: "snapshot-invalid", grant: "roster-changed", "tenant-lease": "lease-lost retry=5s", "bot-lease": "lease-lost retry=5s" };
    for (const change of ["link", "token", "allowlist", "grant", "tenant-lease", "bot-lease", "halt"]) {
      const f = await fixture(s); await f.prime(); let once = false;
      f.transport.getUpdates = async () => updates([f.msg(1)]);
      f.hook(async (sql, _values, client) => { if (once || !/^UPDATE recovery_reply_offsets SET offset_id/.test(sql)) return; once = true;
        if (change === "link") await client!.query("UPDATE tenant_telegram SET owner_id=999 WHERE tenant=$1", [f.actors[0]!.tenant]);
        if (change === "token") await client!.query("UPDATE tenant_settings SET sealed=$1", [sealSecret(JSON.stringify({ telegramEnabled: true, telegramBotToken: "801:changed", telegramAllowlist: [701] }), DEK)]);
        if (change === "allowlist") await client!.query("UPDATE tenant_settings SET sealed=$1", [sealSecret(JSON.stringify({ telegramEnabled: true, telegramBotToken: f.actors[0]!.token }), DEK)]);
        if (change === "grant") await client!.query("UPDATE grants SET updated_at=101");
        if (change === "tenant-lease") f.health.tenant = false;
        if (change === "bot-lease") f.health.bot = false;
        if (change === "halt") writeFileSync(f.halt, "operator halt changed\n");
      });
      if (change === "halt") await assert.rejects(f.run(), (e: unknown) => e instanceof RecoveryReplyFleetRefusal && e.reason === "root-proof");
      else {
        assert.equal(await f.run(), "one-pass", change);
        const stop = f.logs.filter(line => /actor-stop/.test(line));
        assert.equal(stop.length, 1, `${change}: ${f.logs.join("\n")}`); assert.ok(stop[0]!.endsWith(`actor-stop tenant=${f.actors[0]!.tenant.slice(0, 8)} reason=${reasons[change]}`), `${change}: ${stop[0]}`);
      }
      assert.equal(f.sends.length, 0, change); assert.equal(Number((await f.offset())!.offset_id), 0, change);
    }
  });

  await t.test("forget commits cursor, encrypted receipt and actual legacy erasure together, without changing financial rows or local books", async s => {
    const f = await fixture(s), a = f.actors[0]!; f.transport.getUpdates = async () => updates([f.msg(1, "/forget")]);
    const rows = await f.original(["tenant_telegram", "tenant_personal_memory", "tenant_tg_groups"]), files = fileFacts(f.home);
    await f.run(); assert.equal(Number((await f.offset())!.offset_id), 2); assert.equal(f.sends.length, 1); assert.match(f.sends[0]!.text, /applied/);
    const stored = (await f.pool.query("SELECT sealed FROM tenant_recovery_reply_state WHERE tenant=$1", [a.tenant])).rows[0]!;
    const state = openRecoveryReplyState(a.tenant, stored.sealed, DEK); assert.equal(state.privacy.length, 1); assert.equal(state.privacy[0]!.kind, "personal-chat"); assert.deepEqual(state.turns, []);
    const memory = (await f.pool.query("SELECT sealed FROM tenant_personal_memory WHERE tenant=$1", [a.tenant])).rows[0]!;
    const plain = JSON.parse(openSecret(String(memory.sealed), DEK).split("\n").slice(1).join("\n")) as { chats: Array<{ chatId: number }>; applied: Record<string, string> };
    assert.deepEqual(plain.chats.map(c => c.chatId), [9999]); assert.equal(plain.applied[`chat:${a.ownerId}`], state.privacy[0]!.id);
    assert.deepEqual(await f.original(["tenant_telegram", "tenant_personal_memory", "tenant_tg_groups"]), rows); assert.deepEqual(fileFacts(f.home), files);
  });

  await t.test("a corrupt legacy memory refuses forget and rolls back both durable cursor and privacy receipt", async s => {
    const f = await fixture(s); await f.prime(); await f.pool.query("UPDATE tenant_personal_memory SET sealed='corrupt-retained-memory'");
    f.transport.getUpdates = async () => updates([f.msg(1, "/forget")]); const before = await f.original(); await f.run();
    assert.ok(f.logs.includes(`[recovery-replies] [alert] actor-stop tenant=${f.actors[0]!.tenant.slice(0, 8)} reason=actor-error retry=60s`), f.logs.join("\n"));
    assert.equal(Number((await f.offset())!.offset_id), 0); assert.equal(f.sends.length, 0); assert.equal((await f.pool.query("SELECT count(*) FROM tenant_recovery_reply_state")).rows[0]!.count, "0"); assert.deepEqual(await f.original(), before);
  });

  await t.test("malformed target group memory refuses erasure and rolls back its receipt and cursor", async s => {
    for (const field of ["atMs", "fromId"] as const) {
      const f = await fixture(s), a = f.actors[0]!; await f.prime();
      const row = (await f.pool.query("SELECT sealed FROM tenant_tg_groups WHERE tenant=$1", [a.tenant])).rows[0]!;
      const group = JSON.parse(openSecret(String(row.sealed), DEK).split("\n").slice(1).join("\n")); group.rooms[a.room].lines[0][field] = field === "atMs" ? null : 0;
      await f.pool.query("UPDATE tenant_tg_groups SET sealed=$1 WHERE tenant=$2", [sealSecret(`tg-groups/v1 ${a.tenant}\n${JSON.stringify(group)}`, DEK), a.tenant]);
      const original = await f.original(), files = fileFacts(f.home);
      f.transport.getUpdates = async () => updates([f.msg(1, "/forgetme", 0, { chatId: a.room })], 2);
      await f.run(); assert.ok(f.logs.some(line => line.endsWith(`actor-stop tenant=${a.tenant.slice(0, 8)} reason=actor-error retry=60s`)), f.logs.join("\n"));
      assert.equal(f.sends.length, 0); assert.equal(Number((await f.offset())!.offset_id), 0); assert.equal((await f.pool.query("SELECT count(*) FROM tenant_recovery_reply_state")).rows[0]!.count, "0");
      assert.deepEqual(await f.original(), original); assert.deepEqual(fileFacts(f.home), files);
    }
  });

  await t.test("duplicate legacy personal receipt scopes refuse atomically instead of selecting an ambiguous receipt", async s => {
    const f = await fixture(s); await f.prime(); const a = f.actors[0]!;
    const row = (await f.pool.query("SELECT sealed FROM tenant_personal_memory WHERE tenant=$1", [a.tenant])).rows[0]!;
    const plain = JSON.parse(openSecret(String(row.sealed), DEK).split("\n").slice(1).join("\n"));
    const first = "00000000-0000-4000-8000-000000000001", newer = "00000000-0000-4000-8000-000000000002";
    plain.forgets = [{ id: first, atMs: 80, kind: "chat", chatId: a.ownerId, completed: true }, { id: newer, atMs: 90, kind: "chat", chatId: a.ownerId, completed: true }];
    plain.applied = { [`chat:${a.ownerId}`]: newer };
    await f.pool.query("UPDATE tenant_personal_memory SET sealed=$1 WHERE tenant=$2", [sealSecret(`personal-memory/v1 ${a.tenant}\n${JSON.stringify(plain)}`, DEK), a.tenant]);
    const before = await f.original(); f.transport.getUpdates = async () => updates([f.msg(1, "/forget")]); await f.run();
    assert.ok(f.logs.some(line => line.endsWith(`actor-stop tenant=${a.tenant.slice(0, 8)} reason=actor-error retry=60s`)), f.logs.join("\n"));
    assert.equal(f.sends.length, 0); assert.equal(Number((await f.offset())!.offset_id), 0); assert.equal((await f.pool.query("SELECT count(*) FROM tenant_recovery_reply_state")).rows[0]!.count, "0"); assert.deepEqual(await f.original(), before);
  });

  await t.test("missing optional reply tables do not abort an existing PostgreSQL transaction", async s => {
    const f = await fixture(s), client = await f.connect();
    let disappear: "tenant_recovery_reply_state" | "recovery_reply_offsets" | undefined;
    const db: Pick<Db, "prepare"> = { prepare(sql) { let at = 0; const translated = sql.replace(/\?/g, () => `$${++at}`); return {
      get: async (...values) => { const row = (await client.query(translated, values)).rows[0]; if (disappear && translated === `SELECT to_regclass('${disappear}') AS table_name`) { assert.ok(row?.table_name); await client.query(`DROP TABLE ${disappear}`); } return row; },
      all: async (...values) => (await client.query(translated, values)).rows,
      run: async (...values) => ({ changes: (await client.query(translated, values)).rowCount ?? 0, lastInsertRowid: 0 }),
    }; } };
    await client.query("BEGIN");
    assert.deepEqual(await readReplyPrivacy(db, f.actors[0]!.tenant, DEK), []);
    assert.equal(await readRecoveryReplyOffset(db, { tenant: f.actors[0]!.tenant, smartAccount: f.actors[0]!.account, chainId: 4663 }, f.actors[0]!.botId), null);
    assert.equal((await client.query("SELECT 1 AS still_live")).rows[0]!.still_live, 1);
    await client.query("ROLLBACK");
    assert.equal((await f.pool.query("SELECT to_regclass('recovery_reply_offsets') AS table")).rows[0]!.table, null);
    await f.pool.query(RECOVERY_REPLY_SCHEMA);
    for (const table of ["tenant_recovery_reply_state", "recovery_reply_offsets"] as const) {
      disappear = table; await client.query("BEGIN");
      if (table === "tenant_recovery_reply_state") await assert.rejects(readReplyPrivacy(db, f.actors[0]!.tenant, DEK));
      else await assert.rejects(readRecoveryReplyOffset(db, { tenant: f.actors[0]!.tenant, smartAccount: f.actors[0]!.account, chainId: 4663 }, f.actors[0]!.botId));
      await assert.rejects(client.query("SELECT 1"), { code: "25P02" }); await client.query("ROLLBACK");
      assert.ok((await f.pool.query(`SELECT to_regclass('${table}') AS present`)).rows[0]!.present, "rollback restores only the disposable fixture table");
    }
  });

  await t.test("actual private-row contention keeps cursor uncommitted until erasure can commit", async s => {
    const f = await fixture(s); await f.prime(); const locker = await f.connect();
    await locker.query("BEGIN"); await locker.query("SELECT * FROM tenant_personal_memory FOR UPDATE");
    f.transport.getUpdates = async () => updates([f.msg(1, "/forget")]); let reached!: () => void; const pending = new Promise<void>(resolve => { reached = resolve; });
    f.hook(async sql => { if (/^UPDATE recovery_reply_offsets SET offset_id/.test(sql)) reached(); });
    const job = f.run(); await pending;
    assert.equal(Number((await f.offset())!.offset_id), 0); assert.equal(f.sends.length, 0);
    let waiting = false;
    for (let i = 0; i < 50 && !waiting; i++) { waiting = Number((await f.pool.query("SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT sealed FROM tenant_personal_memory%'")).rows[0]!.count) > 0; if (!waiting) await delay(5); }
    assert.equal(waiting, true); await locker.query("ROLLBACK"); await job; assert.equal(Number((await f.offset())!.offset_id), 2); assert.equal(f.sends.length, 1);
  });
});

/**
 * ONE TENANT'S PROBLEM STOPS ONE TENANT, against the actual entry, the actual
 * supervisor and real PostgreSQL advisory locks. Each case runs the listener
 * continuously (not one pass), with a 50ms supervisor period, and ends it with
 * the trusted stop signal — a clean stop, so every run must resolve "stopped"
 * unless the case is about a fleet-wide refusal.
 */
const until = async (what: string, ready: () => boolean | Promise<boolean>, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!(await ready())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await delay(20, undefined, { ref: false });
  }
};
type Fixture = Awaited<ReturnType<typeof fixture>>;
function live(f: Fixture, extra: Partial<RecoveryReplyOptions> = {}) {
  const stop = new AbortController();
  const done = f.run({ onePass: undefined, stopSignal: stop.signal, supervisorEveryMs: 50, ...extra })
    .then(value => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
  return { stop, done };
}
const sent = (f: Fixture, botId: string) => f.sends.filter(x => x.botId === botId).length;
const lockFree = async (probe: Client, tenant: string) => {
  const key = leaseKey(tenant).toString(), free = (await probe.query("SELECT pg_try_advisory_lock($1::bigint) AS held", [key])).rows[0]!.held === true;
  if (free) await probe.query("SELECT pg_advisory_unlock($1::bigint)", [key]);
  return free;
};

test("actual reply entry isolation: one tenant's or one bot's problem stops only that tenant or bot", { skip: !URL, timeout: 180_000 }, async t => {
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new globalThis.URL(URL!).hostname), "LOCAL test database only");

  await t.test("another tenant's grant write never stops an actor; a tenant's own write stops only it and the supervisor re-admits it", async s => {
    const f = await fixture(s, 2), [a, b] = [f.actors[0]!, f.actors[1]!], tagA = a.tenant.slice(0, 8), tagB = b.tenant.slice(0, 8);
    const original = await f.original(["tenant_telegram", "grants"]), baseMe = f.transport.getMe;
    let bIdentity = 0;
    f.transport.getMe = async opts => { if (opts.token === b.token) bIdentity++; return baseMe(opts); };
    f.transport.getUpdates = async (opts, offset) => opts.token === a.token ? updates([f.msg(offset, "$A chart", 0)], offset + 1) : updates();
    const { stop, done } = live(f);
    try {
      await until("A's first reply", () => sent(f, a.botId) >= 1);
      // The production trigger: a user signs a grant (any tenant's grants row is
      // written). The whole-roster receipt used to stop every actor right here.
      await f.pool.query("UPDATE grants SET updated_at=updated_at+1 WHERE tenant=$1", [b.tenant]);
      const before = sent(f, a.botId);
      await until("B stopped and re-admitted", () => bIdentity >= 2 && f.logs.filter(l => l === `[recovery-replies] actor-start tenant=${tagB}`).length >= 2);
      await until("A still replying", () => sent(f, a.botId) >= before + 2);
    }
    finally { stop.abort(); }
    const result = await done; assert.deepEqual(result, { ok: true, value: "stopped" });
    assert.deepEqual(f.logs.filter(l => /actor-stop/.test(l)), [`[recovery-replies] actor-stop tenant=${tagB} reason=roster-changed`]);
    assert.equal(f.logs.filter(l => l === `[recovery-replies] actor-start tenant=${tagA}`).length, 1, "A was never stopped or restarted");
    assert.equal(Number((await f.offset(a.botId))!.offset_id), sent(f, a.botId));
    assert.deepEqual(await f.original(["tenant_telegram", "grants"]), original);
  });

  await t.test("a tenant whose grant appears while the listener runs is fenced and gets an actor on the next supervisor pass", async s => {
    const f = await fixture(s, 2), [a, b] = [f.actors[0]!, f.actors[1]!], probe = await f.connect();
    const row = (await f.pool.query("SELECT * FROM grants WHERE tenant=$1", [b.tenant])).rows[0]!;
    await f.pool.query("DELETE FROM grants WHERE tenant=$1", [b.tenant]);
    let aPolls = 0, bIdentityAt = -1;
    const baseMe = f.transport.getMe;
    f.transport.getMe = async opts => { if (opts.token === b.token && bIdentityAt < 0) bIdentityAt = f.audit.length; return baseMe(opts); };
    f.transport.getUpdates = async (opts, offset) => { if (opts.token === a.token) { aPolls++; return updates(); } return updates([f.msg(offset, "$B chart", 1)], offset + 1); };
    const { stop, done } = live(f, { supervisorEveryMs: 300 });
    try {
      await until("A polling", () => aPolls >= 1);
      assert.equal(await lockFree(probe, b.tenant), true, "a tenant outside the roster is not fenced");
      const insertedAt = f.audit.length;
      await f.pool.query("INSERT INTO grants VALUES($1,$2,$3::jsonb,$4,$5)", [row.tenant, row.chain_id, JSON.stringify(row.grant_json), row.sealed_session_key, row.updated_at]);
      await until("B admitted", () => bIdentityAt >= 0);
      // At most ONE roster read between the insert and B's first provider call:
      // the first supervisor pass to see the row fenced and admitted it.
      assert.ok(f.audit.slice(insertedAt, bIdentityAt).filter(sql => /FROM grants ORDER BY tenant LIMIT/.test(sql)).length <= 1);
      assert.equal(await lockFree(probe, b.tenant), false, "fenced once it is in the roster");
      await until("B replying", () => sent(f, b.botId) >= 1);
    }
    finally { stop.abort(); }
    assert.deepEqual(await done, { ok: true, value: "stopped" });
    assert.ok(!f.logs.some(l => /actor-stop/.test(l)), f.logs.join("\n"));
    assert.equal(await lockFree(probe, a.tenant), true); assert.equal(await lockFree(probe, b.tenant), true);
  });

  await t.test("a 409 on one bot backs off and marks only that bot; the other bot keeps replying", async s => {
    const f = await fixture(s, 2), [a, b] = [f.actors[0]!, f.actors[1]!];
    let aPolls = 0;
    f.transport.getUpdates = async (opts, offset) => {
      if (opts.token === a.token) { aPolls++; return { ...updates([], offset), reason: "Conflict: terminated by other getUpdates request", errorCode: 409 }; }
      return updates([f.msg(offset, "$B chart", 1)], offset + 1);
    };
    const { stop, done } = live(f);
    try { await until("B replies", () => sent(f, b.botId) >= 3); }
    finally { stop.abort(); }
    assert.deepEqual(await done, { ok: true, value: "stopped" });
    assert.equal(aPolls, 1, "the conflicted bot waits its 60s back-off instead of fighting the other poller");
    assert.deepEqual(f.logs.filter(l => /telegram-409/.test(l)), [`[recovery-replies] [alert] backoff tenant=${a.tenant.slice(0, 8)} reason=telegram-409 wait=60s`]);
    assert.match(String((await f.pool.query("SELECT poll_err FROM tenant_telegram WHERE tenant=$1", [a.tenant])).rows[0]!.poll_err), /^conflict: /);
    assert.equal((await f.pool.query("SELECT poll_err FROM tenant_telegram WHERE tenant=$1", [b.tenant])).rows[0]!.poll_err, null);
    assert.ok(!f.logs.some(l => /actor-stop/.test(l)), f.logs.join("\n"));
  });

  await t.test("a transport exception on one bot backs off only that bot", async s => {
    const f = await fixture(s, 2), [a, b] = [f.actors[0]!, f.actors[1]!];
    let aPolls = 0;
    f.transport.getUpdates = async (opts, offset) => {
      if (opts.token === a.token) { aPolls++; throw new Error(`synthetic socket reset for ${a.token}`); }
      return updates([f.msg(offset, "$B chart", 1)], offset + 1);
    };
    const { stop, done } = live(f);
    try { await until("B replies", () => sent(f, b.botId) >= 3); }
    finally { stop.abort(); }
    assert.deepEqual(await done, { ok: true, value: "stopped" });
    assert.ok(aPolls >= 1 && aPolls <= 2, `bot A was asked ${aPolls} times inside its back-off`);
    assert.equal(f.logs.filter(l => l === `[recovery-replies] backoff tenant=${a.tenant.slice(0, 8)} reason=telegram-network wait=2s`).length, 1, f.logs.join("\n"));
    assert.ok(!f.logs.some(l => /actor-stop/.test(l) || l.includes(`tenant=${b.tenant.slice(0, 8)} reason=telegram-network`)), f.logs.join("\n"));
  });

  await t.test("a statement timeout (57014) on one tenant's read retries that actor in place; the other never notices", async s => {
    const f = await fixture(s, 2), [a, b] = [f.actors[0]!, f.actors[1]!];
    let thrown = 0;
    // The production trigger: `FOR SHARE NOWAIT` on one tenant's settings row
    // cancelled by statement_timeout. It used to stop every bot.
    f.hook(async (sql, values) => {
      if (thrown || !/FROM tenant_settings WHERE tenant=\$1 FOR SHARE NOWAIT/.test(sql) || values?.[0] !== a.tenant) return;
      thrown++;
      throw Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
    });
    f.transport.getUpdates = async (opts, offset) => updates([f.msg(offset, opts.token === a.token ? "$A chart" : "$B chart", opts.token === a.token ? 0 : 1)], offset + 1);
    const { stop, done } = live(f);
    try { await until("both reply after the retry", () => sent(f, a.botId) >= 1 && sent(f, b.botId) >= 3); }
    finally { stop.abort(); }
    assert.deepEqual(await done, { ok: true, value: "stopped" });
    assert.equal(thrown, 1);
    assert.deepEqual(f.logs.filter(l => /backoff/.test(l)), [`[recovery-replies] backoff tenant=${a.tenant.slice(0, 8)} reason=db-transient wait=2s`]);
    assert.ok(!f.logs.some(l => /actor-stop/.test(l)), f.logs.join("\n"));
    assert.equal(f.logs.filter(l => /actor-start/.test(l)).length, 2, "retried in place, not re-admitted");
  });

  await t.test("a lost tenant lease stops only that actor; the supervisor re-acquires it after back-off and re-admits it", async s => {
    const f = await fixture(s, 2), [a, b] = [f.actors[0]!, f.actors[1]!], tagA = a.tenant.slice(0, 8);
    f.transport.getUpdates = async (opts, offset) => updates([f.msg(offset, opts.token === a.token ? "$A chart" : "$B chart", opts.token === a.token ? 0 : 1)], offset + 1);
    const { stop, done } = live(f);
    let bAtLoss = 0, aAtLoss = 0;
    try {
      await until("both replying", () => sent(f, a.botId) >= 1 && sent(f, b.botId) >= 1);
      f.health.lost.add(f.health.current.get(a.tenant)!);
      await until("A stopped", () => f.logs.includes(`[recovery-replies] [alert] actor-stop tenant=${tagA} reason=lease-lost retry=5s`));
      bAtLoss = sent(f, b.botId); aAtLoss = sent(f, a.botId);
      await until("A re-admitted", () => f.logs.filter(l => l === `[recovery-replies] actor-start tenant=${tagA}`).length === 2);
      assert.ok(sent(f, b.botId) >= bAtLoss + 3, "B kept replying while A waited");
      await until("A replying again", () => sent(f, a.botId) > aAtLoss);
    }
    finally { stop.abort(); }
    assert.deepEqual(await done, { ok: true, value: "stopped" });
    assert.equal(f.health.acquired.filter(x => x === a.tenant).length, 2, "A's tenant lease was released and re-acquired");
    assert.equal(f.health.acquired.filter(x => x === b.tenant).length, 1);
    assert.deepEqual(f.logs.filter(l => /actor-stop/.test(l)), [`[recovery-replies] [alert] actor-stop tenant=${tagA} reason=lease-lost retry=5s`]);
  });

  await t.test("a changed root proof still refuses the whole fleet and releases every lease", async s => {
    const f = await fixture(s, 2), [a, b] = [f.actors[0]!, f.actors[1]!], probe = await f.connect();
    f.transport.getUpdates = async (opts, offset) => updates([f.msg(offset, "$X chart", opts.token === a.token ? 0 : 1)], offset + 1);
    const { stop, done } = live(f);
    try {
      await until("both replying", () => sent(f, a.botId) >= 1 && sent(f, b.botId) >= 1);
      writeFileSync(f.halt, "operator halt changed\n");
      const result = await done;
      assert.equal(result.ok, false); assert.ok(!result.ok && result.error instanceof RecoveryReplyFleetRefusal && result.error.reason === "root-proof");
    }
    finally { stop.abort(); await done; }
    assert.ok(!f.logs.some(l => /actor-stop/.test(l)), "a fleet refusal is one line from the entry, not one per actor");
    assert.equal(await lockFree(probe, a.tenant), true); assert.equal(await lockFree(probe, b.tenant), true);
  });

  await t.test("409s on fewer than three bots stay per bot; three of three pause every actor, keep every lease and do not exit", async s => {
    const conflict = { ...updates(), reason: "Conflict: terminated by other getUpdates request", errorCode: 409 };
    const two = await fixture(s, 3);
    two.transport.getUpdates = async opts => opts.token === two.actors[2]!.token ? updates([two.msg(1, "$C chart", 2)], 2) : conflict;
    assert.equal(await two.run(), "one-pass");
    assert.equal(two.sends.length, 1); assert.equal(two.sends[0]!.botId, two.actors[2]!.botId);
    assert.equal(two.logs.filter(l => /telegram-409/.test(l)).length, 2);
    assert.ok(!two.logs.some(l => /fleet-pause/.test(l)), two.logs.join("\n"));
    // Three of three, live. This used to EXIT (telegram-409-fleet), handing
    // every fenced tenant to whatever else was polling and spending a restart.
    const three = await fixture(s, 3), probe = await three.connect();
    const polled = () => three.polls.length;
    three.transport.getUpdates = async (opts, offset) => { three.polls.push({ botId: opts.token.split(":")[0]!, offset, deadline: opts.deadlineAtMs }); return conflict; };
    const { stop, done } = live(three, { conflictPauseMs: 2_000 });
    try {
      await until("the fleet pause", () => three.logs.some(l => /fleet-pause/.test(l)));
      assert.deepEqual(three.logs.filter(l => /fleet-pause/.test(l)), ["[recovery-replies] [alert] fleet-pause reason=telegram-409-fleet bots=3 serving=3 wait=2s"]);
      // Every tenant stays fenced through the pause, and nothing polls.
      for (const a of three.actors) assert.equal(await lockFree(probe, a.tenant), false, "fenced while paused");
      const atPause = polled(); await delay(500); assert.equal(polled(), atPause, "no bot is polled during the pause");
      await until("re-admitted after the pause", () => three.logs.filter(l => /actor-start/.test(l)).length >= 6);
      await until("each bot met its conflict again", () => polled() >= atPause + 3);
      await delay(300);
      assert.equal(three.logs.filter(l => /fleet-pause/.test(l)).length, 1, "the same standing conflicts cannot pause the fleet twice");
    }
    finally { stop.abort(); }
    assert.deepEqual(await done, { ok: true, value: "stopped" });
    assert.equal(three.sends.length, 0);
    assert.ok(!three.logs.some(l => /actor-stop/.test(l)), "a pause is one fleet line, not one per actor");
  });

  await t.test("webhook 409s on three of five bots stay per bot: the healthy bots keep replying and nothing pauses", async s => {
    const f = await fixture(s, 5);
    const webhook = { ...updates(), reason: "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first", errorCode: 409 };
    f.transport.getUpdates = async (opts, offset) => { const i = Number(opts.token.split(":")[0]) - 801; return i < 3 ? webhook : updates([f.msg(offset, "$OK chart", i)], offset + 1); };
    const { stop, done } = live(f);
    try { await until("the healthy bots reply", () => sent(f, f.actors[3]!.botId) >= 3 && sent(f, f.actors[4]!.botId) >= 3); }
    finally { stop.abort(); }
    assert.deepEqual(await done, { ok: true, value: "stopped" });
    assert.ok(!f.logs.some(l => /fleet-pause/.test(l)), f.logs.join("\n"));
    assert.equal(f.logs.filter(l => /reason=telegram-409/.test(l)).length, 3);
    for (const a of f.actors.slice(0, 3)) assert.equal((await f.pool.query("SELECT poll_err FROM tenant_telegram WHERE tenant=$1", [a.tenant])).rows[0]!.poll_err, "conflict: this bot has a webhook set (409)");
  });

  await t.test("a connection killed under one actor's open transaction is that actor's db-transient back-off, never an uncaught exception", async s => {
    for (const owned of [false, true]) {
      const f = await fixture(s, 2), [a, b] = [f.actors[0]!, f.actors[1]!], probe = await f.connect(), tagA = a.tenant.slice(0, 8);
      let lastA = 0, killed = 0;
      // The injected pool: A's last authority read inside a transaction names its backend.
      f.hook(async (sql, values, client) => { if (client && values?.[0] === a.tenant && /FROM tenant_settings WHERE tenant=\$1 FOR SHARE NOWAIT/.test(sql)) lastA = (client as unknown as { processID: number }).processID; });
      f.transport.getUpdates = async (opts, offset) => updates([f.msg(offset, opts.token === a.token ? "$A chart" : "$B chart", opts.token === a.token ? 0 : 1)], offset + 1);
      const baseSend = f.transport.sendMessage;
      f.transport.sendMessage = async (opts, chat, text, extra) => {
        if (opts.token === a.token && !killed++) {
          // A's respond transaction sits idle in transaction around this send:
          // a failover, a reaper or an operator ends exactly that backend.
          const pids = owned
            ? (await probe.query("SELECT pid FROM pg_stat_activity WHERE state='idle in transaction' AND datname=current_database() AND pid<>pg_backend_pid()")).rows.map(r => Number(r.pid))
            : [lastA];
          assert.ok(pids.length >= 1 && pids.every(pid => pid > 0));
          for (const pid of pids) await probe.query("SELECT pg_terminate_backend($1)", [pid]);
          await until("the backend gone", async () => Number((await probe.query("SELECT count(*) FROM pg_stat_activity WHERE pid=ANY($1::int[])", [pids])).rows[0]!.count) === 0);
          await delay(100);
        }
        return baseSend(opts, chat, text, extra);
      };
      const { stop, done } = live(f, owned ? { pool: undefined } : {});
      try {
        await until("A's connection killed", () => killed > 0);
        const aAt = sent(f, a.botId), bAt = sent(f, b.botId);
        await until("A replying again", () => sent(f, a.botId) > aAt);
        await until("B still replying", () => sent(f, b.botId) >= bAt + 2);
      }
      finally { stop.abort(); }
      assert.deepEqual(await done, { ok: true, value: "stopped" }, owned ? "entry-owned pool" : "injected pool");
      assert.ok(f.logs.includes(`[recovery-replies] backoff tenant=${tagA} reason=db-transient wait=2s`), f.logs.join("\n"));
      assert.ok(!f.logs.some(l => /actor-stop/.test(l)), f.logs.join("\n"));
      if (!owned) assert.ok(!f.logs.some(l => l.includes(`tenant=${b.tenant.slice(0, 8)}`) && /backoff/.test(l)), f.logs.join("\n"));
    }
  });

  await t.test("a lost bot stream session stops a bot in a long 409 back-off at once, so the healthy bot resumes within seconds", async s => {
    const f = await fixture(s, 2), [a, b] = [f.actors[0]!, f.actors[1]!], probe = await f.connect(), tagA = a.tenant.slice(0, 8);
    f.transport.getUpdates = async (opts, offset) => opts.token === a.token
      ? { ...updates([], offset), reason: "Conflict: terminated by other getUpdates request", errorCode: 409 }
      : updates([f.msg(offset, "$B chart", 1)], offset + 1);
    // The entry's own lease sessions (one bot stream session for both bots),
    // at the production supervisor period: the 5s re-admission back-off must
    // be honoured as 5s, not rounded up to the next 30s pass.
    const { stop, done } = live(f, { acquireTenant: undefined, acquireBot: undefined, supervisorEveryMs: REPLY_SUPERVISOR_EVERY_MS });
    let resumedMs = 0;
    try {
      await until("B replies and A sits in its 60s back-off", () => sent(f, b.botId) >= 2 && f.logs.some(l => /telegram-409/.test(l)));
      const pids = (await probe.query("SELECT DISTINCT pid FROM pg_locks WHERE locktype='advisory' AND classid=$1::oid", [0x4d525042])).rows.map(r => Number(r.pid));
      assert.equal(pids.length, 1, "one bot stream session");
      await probe.query("SELECT pg_terminate_backend($1)", [pids[0]]);
      const lostAt = Date.now(), atLoss = sent(f, b.botId);
      // It used to wait for A's 60s (up to 10 min, or Telegram's retry_after up
      // to an hour): A kept its dead lease and no new session could open.
      await until("B resumes", () => sent(f, b.botId) > atLoss + 1, 30_000);
      resumedMs = Date.now() - lostAt;
    }
    finally { stop.abort(); }
    assert.deepEqual(await done, { ok: true, value: "stopped" });
    assert.ok(resumedMs < 15_000, `B resumed after ${resumedMs}ms`);
    assert.ok(f.logs.includes(`[recovery-replies] [alert] actor-stop tenant=${tagA} reason=lease-lost retry=5s`), f.logs.join("\n"));
    assert.ok(!f.logs.some(l => /admit-wait .*reason=db-transient/.test(l)), "a session renewal is never reported as database weather");
  });

  await t.test("a drain that fails every time backs off longer each time; the other bot never notices", async s => {
    const f = await fixture(s, 2), [a, b] = [f.actors[0]!, f.actors[1]!], tagA = a.tenant.slice(0, 8);
    f.hook(async (sql, values) => {
      if (/^UPDATE tenant_telegram SET poll_ok_at=\$1/.test(sql) && values?.[1] === a.tenant) throw Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
    });
    f.transport.getUpdates = async (opts, offset) => updates([f.msg(offset, opts.token === a.token ? "$A chart" : "$B chart", opts.token === a.token ? 0 : 1)], offset + 1);
    const { stop, done } = live(f);
    try {
      await until("A backed off twice", () => f.logs.filter(l => l.startsWith(`[recovery-replies] backoff tenant=${tagA} `)).length >= 2, 15_000);
      await until("B replying", () => sent(f, b.botId) >= 3);
    }
    finally { stop.abort(); }
    assert.deepEqual(await done, { ok: true, value: "stopped" });
    // A clean getUpdates is not progress: only a committed drain is.
    assert.deepEqual(f.logs.filter(l => l.startsWith(`[recovery-replies] backoff tenant=${tagA} `)).slice(0, 2),
      [`[recovery-replies] backoff tenant=${tagA} reason=db-transient wait=2s`, `[recovery-replies] backoff tenant=${tagA} reason=db-transient wait=4s`]);
    assert.equal(sent(f, a.botId), 0); assert.equal(Number((await f.offset(a.botId))!.offset_id), 0, "A's cursor never moved");
  });

  await t.test("database weather on the startup roster read is waited out; anything else, or a one-pass run, still refuses", async s => {
    const f = await fixture(s);
    let failed = 0;
    f.hook(async sql => { if (!failed && /FROM grants ORDER BY tenant LIMIT/.test(sql)) { failed++; throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" }); } });
    f.transport.getUpdates = async (_opts, offset) => updates([f.msg(offset)], offset + 1);
    const { stop, done } = live(f);
    try { await until("replying after the wait", () => f.sends.length >= 1, 15_000); }
    finally { stop.abort(); }
    assert.deepEqual(await done, { ok: true, value: "stopped" });
    assert.equal(f.logs[0], "[recovery-replies] backoff scope=roster reason=db-transient wait=2s");
    for (const error of [Object.assign(new Error("relation \"grants\" does not exist"), { code: "42P01" }), Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" })]) {
      const g = await fixture(s);
      g.hook(async sql => { if (/FROM grants ORDER BY tenant LIMIT/.test(sql)) throw error; });
      // A missing table refuses in live mode; weather refuses only a bounded one-pass run.
      const live42 = error.code === "42P01";
      const result = live42 ? await live(g).done : await g.run().then(value => ({ ok: true as const, value }), (e: unknown) => ({ ok: false as const, error: e }));
      assert.ok(!result.ok && result.error instanceof RecoveryReplyFleetRefusal && result.error.reason === "roster-unreadable", error.code);
    }
  });

  await t.test("our own unsettled release is reported as lease-settling, never as another process's lease-busy", async s => {
    const f = await fixture(s, 2), [a, b] = [f.actors[0]!, f.actors[1]!], tagA = a.tenant.slice(0, 8);
    let slowed = 0;
    f.transport.getUpdates = async (opts, offset) => updates([f.msg(offset, opts.token === a.token ? "$A chart" : "$B chart", opts.token === a.token ? 0 : 1)], offset + 1);
    // A's first lease takes 6.5s to unlock: longer than the release bound
    // (1.5s) and than the 5s re-admission back-off. Until it settles, the
    // lease manager refuses a new acquisition of the same lease — ours.
    const { stop, done } = live(f, { acquireTenant: async tenant => {
      const held = await f.acquireTenant(tenant);
      if (!held || tenant !== a.tenant || slowed++) return held;
      return { ...held, release: async () => { await delay(6_500); await held.release(); } };
    } });
    try {
      await until("both replying", () => sent(f, a.botId) >= 1 && sent(f, b.botId) >= 1);
      f.health.lost.add(f.health.current.get(a.tenant)!);
      await until("A waits on its own release", () => f.logs.some(l => l.includes(`tenant=${tagA} reason=lease-settling`)), 15_000);
    }
    finally { stop.abort(); }
    assert.deepEqual(await done, { ok: true, value: "stopped" });
    assert.ok(f.logs.includes(`[recovery-replies] [alert] admit-wait tenant=${tagA} reason=lease-settling retry=10s`), f.logs.join("\n"));
    assert.ok(!f.logs.some(l => /lease-busy/.test(l)), f.logs.join("\n"));
    // Let the slow unlock finish before the fixture ends its sessions.
    await delay(2_500);
  });

  await t.test("another tenant's row claiming this tenant's smart account stops both actors at their next step, not at the next pass", async s => {
    const f = await fixture(s, 2), [a, b] = [f.actors[0]!, f.actors[1]!], tagA = a.tenant.slice(0, 8), tagB = b.tenant.slice(0, 8);
    f.transport.getUpdates = async (opts, offset) => updates([f.msg(offset, opts.token === a.token ? "$A chart" : "$B chart", opts.token === a.token ? 0 : 1)], offset + 1);
    // No supervisor pass after startup in this test: only the per-operation check can see it.
    const { stop, done } = live(f, { supervisorEveryMs: 600_000 });
    try {
      await until("both replying", () => sent(f, a.botId) >= 1 && sent(f, b.botId) >= 1);
      await f.pool.query("UPDATE grants SET grant_json=jsonb_set(grant_json,'{smartAccount}',to_jsonb($1::text)) WHERE tenant=$2", [a.account.toUpperCase().replace(/^0X/, "0x"), b.tenant]);
      await until("both stopped", () => f.logs.includes(`[recovery-replies] actor-stop tenant=${tagA} reason=roster-changed`) && f.logs.includes(`[recovery-replies] actor-stop tenant=${tagB} reason=roster-changed`), 10_000);
      const aAt = sent(f, a.botId), bAt = sent(f, b.botId);
      await delay(300);
      assert.equal(sent(f, a.botId), aAt); assert.equal(sent(f, b.botId), bAt);
    }
    finally { stop.abort(); }
    assert.deepEqual(await done, { ok: true, value: "stopped" });
  });

  await t.test("a checksummed tenant column is fenced under its lowercase address and never served", async s => {
    const f = await fixture(s, 2), [a, b] = [f.actors[0]!, f.actors[1]!], probe = await f.connect();
    await f.pool.query("UPDATE grants SET tenant='0x'||upper(substr(tenant,3)) WHERE tenant=$1", [b.tenant]);
    f.transport.getUpdates = async (opts, offset) => updates([f.msg(offset, "$X chart", opts.token === a.token ? 0 : 1)], offset + 1);
    const { stop, done } = live(f);
    try {
      await until("A replying", () => sent(f, a.botId) >= 2);
      assert.equal(await lockFree(probe, b.tenant), false, "fenced under its lowercase address");
    }
    finally { stop.abort(); }
    assert.deepEqual(await done, { ok: true, value: "stopped" });
    assert.equal(sent(f, b.botId), 0); assert.ok(!f.polls.some(p => p.botId === b.botId));
    assert.ok(f.logs.includes(`[recovery-replies] [alert] roster-row-skipped tenant=${b.tenant.slice(0, 8)}`), f.logs.join("\n"));
    assert.equal(await lockFree(probe, b.tenant), true, "released on stop");
  });

  await t.test("SIGTERM is a clean stop: the entry resolves \"stopped\" and releases every lease", async s => {
    const f = await fixture(s, 2), [a, b] = [f.actors[0]!, f.actors[1]!], probe = await f.connect();
    f.transport.getUpdates = async (opts, offset) => updates([f.msg(offset, "$X chart", opts.token === a.token ? 0 : 1)], offset + 1);
    const before = process.listeners("SIGTERM").length;
    const done = f.run({ onePass: undefined, supervisorEveryMs: 50 });
    try {
      await until("both replying", () => sent(f, a.botId) >= 1 && sent(f, b.botId) >= 1);
      const listeners = process.listeners("SIGTERM");
      assert.equal(listeners.length, before + 1);
      // The entry's own handler, exactly as a SIGTERM would call it (no signal
      // is sent to the test process, and no other listener is invoked).
      (listeners.at(-1) as () => void)();
      assert.equal(await done, "stopped");
    }
    finally { const fallback = process.listeners("SIGTERM").at(-1); if (process.listeners("SIGTERM").length > before) (fallback as () => void)(); await done.catch(() => {}); }
    assert.equal(process.listeners("SIGTERM").length, before);
    assert.ok(!f.logs.some(l => /actor-stop/.test(l)), f.logs.join("\n"));
    assert.equal(await lockFree(probe, a.tenant), true); assert.equal(await lockFree(probe, b.tenant), true);
  });
});
