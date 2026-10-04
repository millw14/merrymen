/** Actual entry against an explicitly opted-in disposable LOCAL PostgreSQL database. */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { runRecoveryReplies, type RecoveryReplyOptions, type ReplyPool } from "./recovery-replies";
import { RecoveryReplyBotLeases } from "./recovery-reply-lease";
import { openRecoveryReplyState, readRecoveryReplyOffset, readReplyPrivacy, RECOVERY_REPLY_SCHEMA } from "./recovery-reply-state";
import { PgTenantLeaseManager, leaseKey } from "./tenant-lease";
import { openSecret, sealSecret } from "./store-crypto";
import { createRecoveryPublicReply, RECOVERY_PUBLIC_HELP } from "./telegram/recovery-public-reply";
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

async function fixture(t: TestContext, count = 1) {
  const pg = createRequire(import.meta.url)("pg") as { Client: new (o: { connectionString: string }) => Client; Pool: new (o: { connectionString: string; max: number }) => RawPool };
  const schema = `mm_reply_entry_${randomBytes(8).toString("hex")}`;
  const admin = new pg.Client({ connectionString: URL! }); await admin.connect(); await admin.query(`CREATE SCHEMA ${schema}`);
  const scoped = new globalThis.URL(URL!); scoped.searchParams.set("options", `-c search_path=${schema}`); const localUrl = scoped.toString();
  const pool = new pg.Pool({ connectionString: localUrl, max: 16 });
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
  const actors = Array.from({ length: count }, (_, i) => ({ tenant: address(101 + i), account: address(201 + i), owner: address(301 + i), session: address(401 + i), ownerId: 701 + i, botId: String(801 + i), token: `${801 + i}:private_fixture_token`, room: -901 - i }));
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
  const health = { tenant: true, bot: true }, audit: string[] = [], sends: Array<{ botId: string; chatId: number; text: string; deadline: number | undefined }> = [], polls: Array<{ botId: string; offset: number; deadline: number | undefined }> = [], replies: string[] = [];
  let hook: ((sql: string, values: unknown[] | undefined, client: Pick<Client, "query"> | null) => Promise<void>) | undefined;
  const audited = async (sql: string, values: unknown[] | undefined, client: Pick<Client, "query"> | null) => {
    audit.push(sql); assert.doesNotMatch(sql, /sealed_session_key|serialized|(?:INSERT INTO|UPDATE|DELETE FROM|ALTER TABLE)\s+(?:agents|trades|cost_basis|risk_periods|fee_accruals|agent_commands|mirror_state|grants|tenant_settings|telegram_bot_claims|fleet_recovery_health)\b/i);
    const result = await (client ?? pool).query(sql, values); await hook?.(sql, values, client); return result;
  };
  const entryPool: ReplyPool = { query: (sql, values) => audited(sql, values, null), end: () => pool.end(), connect: async () => { const c = await pool.connect(); return { query: (sql, values) => audited(sql, values, c), release: error => c.release(error) }; } };
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
  const run = (extra: Partial<RecoveryReplyOptions> = {}) => runRecoveryReplies({ env, pool: entryPool, dek: DEK, readMountInfo: () => mount, onePass: true, now: () => clock,
    acquireTenant: async tenant => { const held = await tenants.acquire(tenant); return held && { ...held, healthy: () => health.tenant && held.healthy() }; },
    acquireBot: async id => { const held = await bots.acquire(id); return held && { ...held, healthy: () => health.bot && held.healthy() }; },
    transport, reply: async req => { replies.push(req.text); return { kind: "public", text: "fresh public code read; trading remains held" }; }, ...extra });
  const msg = (id: number, text = "$FROG chart", i = 0, fields: Partial<TgMessage> = {}): TgMessage => ({ updateId: id, messageId: id + 100, chatId: actors[i]!.ownerId, fromId: actors[i]!.ownerId, text, date: Math.floor(clock / 1000), ...fields });
  const offset = async (botId = actors[0]!.botId) => (await pool.query("SELECT * FROM recovery_reply_offsets WHERE bot_id=$1", [botId])).rows[0];
  const prime = async (offsetId = 0, armedAgo = 0) => { await pool.query(RECOVERY_REPLY_SCHEMA); for (const a of actors) await pool.query("INSERT INTO recovery_reply_offsets VALUES($1,$2,$3,4663,$4,200,$5,$6,$7)", [a.botId, a.tenant, a.account, createHash("sha256").update(a.token).digest("hex").slice(0, 16), offsetId, Math.floor(clock / 1000) - armedAgo, clock]); };
  return { actors, pool, connect, env, home, halt, mount, health, transport, sends, polls, replies, audit, run, msg, offset, prime, original, botClient, tenantClients, clock: () => clock, advance: (ms: number) => { clock += ms; }, hook: (fn: typeof hook) => { hook = fn; } };
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

  await t.test("missing/malformed modes and unsafe halt refuse before any shared SQL", async s => {
    for (const mode of [undefined, "0", "true", " 1", ""]) {
      const f = await fixture(s); f.env.MERRYMEN_FLEET_RECOVERY_REPLIES = mode;
      await assert.rejects(f.run()); assert.equal(f.audit.length, 0);
    }
    const f = await fixture(s); chmodSync(f.halt, 0o644); await assert.rejects(f.run()); assert.equal(f.audit.length, 0);
    const g = await fixture(s); rmSync(g.halt); await assert.rejects(g.run()); assert.equal(g.audit.length, 0);
  });

  await t.test("missing hold/link/claim stays unavailable and malformed grants/tokens refuse without initialization", async s => {
    for (const sql of ["DELETE FROM fleet_recovery_health", "UPDATE tenant_telegram SET owner_id=NULL", "DELETE FROM telegram_bot_claims"]) {
      const f = await fixture(s); await f.pool.query(sql); const before = await f.original(); await f.run(); assert.equal(f.sends.length, 0); assert.deepEqual(await f.original(), before); assert.equal(existsSync(path.join(f.home, "persistent-home.json")), false);
      assert.equal((await f.pool.query("SELECT to_regclass('recovery_reply_offsets') AS table")).rows[0]!.table, null);
    }
    for (const broken of ["grant", "token"]) {
      const f = await fixture(s);
      if (broken === "grant") await f.pool.query("UPDATE grants SET grant_json='{}'");
      else await f.pool.query("UPDATE tenant_settings SET sealed=$1", [sealSecret(JSON.stringify({ telegramEnabled: true, telegramBotToken: "not-a-token", telegramAllowlist: [701] }), DEK)]);
      await assert.rejects(f.run()); assert.equal(f.sends.length, 0); assert.equal((await f.pool.query("SELECT to_regclass('recovery_reply_offsets') AS table")).rows[0]!.table, null);
    }
  });

  await t.test("real tenant/bot contention refuses and releases every successfully acquired lease", async s => {
    const f = await fixture(s), foreign = await f.connect();
    await foreign.query("SELECT pg_advisory_lock($1::bigint)", [leaseKey(f.actors[0]!.tenant).toString()]);
    await assert.rejects(f.run()); assert.equal(f.sends.length, 0);
    await foreign.query("SELECT pg_advisory_unlock($1::bigint)", [leaseKey(f.actors[0]!.tenant).toString()]);
    const other = new RecoveryReplyBotLeases(foreign, () => {}), held = await other.acquire(f.actors[0]!.botId); assert.ok(held);
    await assert.rejects(f.run()); await held.release();
    await f.run(); assert.equal(Number((await f.offset())!.offset_id), 0);
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

  await t.test("a why reply to this bot gets public help without reading prior messages or guessing WHY", async s => {
    const f = await fixture(s), a = f.actors[0]!; let reads = 0;
    f.transport.getUpdates = async () => updates([f.msg(1, "why", 0, { chatId: a.room, fromId: 777, replyTo: { messageId: 98, fromId: Number(a.botId), fromIsBot: true, text: "unavailable prior private context about FROG" } })]);
    await f.run({ reply: createRecoveryPublicReply({ now: f.clock, look: async () => { reads++; throw new Error("must not guess an asset"); } }) });
    assert.equal(reads, 0); assert.equal(f.sends.length, 1); assert.equal(f.sends[0]!.text, RECOVERY_PUBLIC_HELP); assert.equal(Number((await f.offset())!.offset_id), 2);
  });

  await t.test("slash research reaches public code; financial slash/button instructions stay held", async s => {
    const f = await fixture(s);
    f.transport.getUpdates = async () => ({ ...updates([f.msg(1, "/chart FROG"), f.msg(2, "/lore FROG"), f.msg(3, "/market"), f.msg(4, "/buy FROG")], 6), callbacks: [{ updateId: 5, id: "old-financial-button", chatId: 701, fromId: 701, messageId: 100, data: "confirm-buy", date: Math.floor(f.clock() / 1000) }] });
    const callbacks: string[] = []; f.transport.answerCallbackQuery = async (_opts, _id, text) => { callbacks.push(text ?? ""); return { ok: true }; };
    await f.run(); assert.deepEqual([...f.replies].sort(), ["/chart FROG", "/lore FROG", "/market"].sort()); assert.ok(f.sends.some(sent => /held/.test(sent.text))); assert.match(callbacks[0]!, /cannot authorize/);
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

  await t.test("provider-quarantined actors retain leases while other proven bots reply; poll conflicts refuse globally", async s => {
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
    for (const phase of ["getMe", "poll"] as const) {
      const f = await fixture(s, 2), baseMe = f.transport.getMe;
      let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
      f.transport.getMe = async opts => opts.token.startsWith("801:") && phase === "getMe" ? { bot: null, reason: "conflicting poller", errorCode: 409 } : baseMe(opts);
      f.transport.getUpdates = async opts => { if (opts.token.startsWith("801:")) return { ...updates(), reason: "conflicting poller", errorCode: 409 }; await held; return updates([f.msg(1, "$GOOD chart", 1)]); };
      try { await assert.rejects(f.run()); assert.equal(f.sends.length, 0); } finally { release(); }
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
    try { await assert.rejects(f.run({ onePass: undefined, stopSignal: stop.signal })); } finally { clearTimeout(watchdog); stop.abort(); }
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
    try { await assert.rejects(f.run({ onePass: undefined, stopSignal: stop.signal, reply: async req => { reads++; assert.equal(req.text, "$FRESH chart"); assert.equal(req.deadlineMs, at + 30000); return { kind: "public", text: "fresh public read" }; } })); }
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

  await t.test("link/token/grant/lease/halt changes during a transaction refuse and roll back its cursor", async s => {
    for (const change of ["link", "token", "grant", "tenant-lease", "bot-lease", "halt"]) {
      const f = await fixture(s); await f.prime(); let once = false;
      f.transport.getUpdates = async () => updates([f.msg(1)]);
      f.hook(async (sql, _values, client) => { if (once || !/^UPDATE recovery_reply_offsets SET offset_id/.test(sql)) return; once = true;
        if (change === "link") await client!.query("UPDATE tenant_telegram SET owner_id=999 WHERE tenant=$1", [f.actors[0]!.tenant]);
        if (change === "token") await client!.query("UPDATE tenant_settings SET sealed=$1", [sealSecret(JSON.stringify({ telegramEnabled: true, telegramBotToken: "801:changed", telegramAllowlist: [701] }), DEK)]);
        if (change === "grant") await client!.query("UPDATE grants SET updated_at=101");
        if (change === "tenant-lease") f.health.tenant = false;
        if (change === "bot-lease") f.health.bot = false;
        if (change === "halt") writeFileSync(f.halt, "operator halt changed\n");
      });
      await assert.rejects(f.run()); assert.equal(f.sends.length, 0, change); assert.equal(Number((await f.offset())!.offset_id), 0, change);
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
    f.transport.getUpdates = async () => updates([f.msg(1, "/forget")]); const before = await f.original(); await assert.rejects(f.run());
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
      await assert.rejects(f.run()); assert.equal(f.sends.length, 0); assert.equal(Number((await f.offset())!.offset_id), 0); assert.equal((await f.pool.query("SELECT count(*) FROM tenant_recovery_reply_state")).rows[0]!.count, "0");
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
    const before = await f.original(); f.transport.getUpdates = async () => updates([f.msg(1, "/forget")]); await assert.rejects(f.run());
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
