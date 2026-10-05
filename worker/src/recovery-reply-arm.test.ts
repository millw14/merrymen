/**
 * THE OWNER'S RECORDED STOPS: the fold over #259's journal, the legacy pause
 * from the events table, and the arm that applies each exactly once.
 *
 * The shared database is a real sqlite one with the ledger schema, and the
 * journal table is #259's own DDL (copied here, because #259 is not merged:
 * the arm reads it through readRecoveryControls and nothing else). The kill
 * itself is the orchestrator's honourKill; here it is a recorded callback, so
 * each test can say what the store answered.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import { wrapSqlite, type Db } from "./db";
import { applyLedgerSchema } from "./store";
import {
  CONTROLS_ARMED_FILE, LEGACY_EVENTS_BOT, PAUSED_FILE, RECORDED_DURING_UPGRADE,
  armOwnerControls, foldRecoveryControls, readControlsEvidence, readLegacyPause, readRecoveryControls, type KillForward,
} from "./recovery-reply-arm";
import { readDurablePause } from "./telegram-store";

/** #259's journal, as that PR creates it (recovery-reply-controls.ts RECOVERY_REPLY_CONTROLS_SCHEMA). */
const JOURNAL = `CREATE TABLE IF NOT EXISTS recovery_reply_controls (
 bot_id TEXT NOT NULL, update_id BIGINT NOT NULL, tenant TEXT NOT NULL, smart_account TEXT NOT NULL, chain_id BIGINT NOT NULL,
 token_tag TEXT NOT NULL, claim_stamp BIGINT NOT NULL, grant_tag TEXT NOT NULL, owner_id BIGINT NOT NULL, chat_id BIGINT NOT NULL,
 kind TEXT NOT NULL, request_update_id BIGINT, message_at_sec BIGINT NOT NULL, recorded_at_ms BIGINT NOT NULL, expires_at_ms BIGINT,
 PRIMARY KEY(bot_id,update_id))`;

const root = mkdtempSync(path.join(os.tmpdir(), "merrymen-arm-controls-"));
const handles: DatabaseSync[] = [];
after(() => { for (const h of handles) h.close(); rmSync(root, { recursive: true, force: true }); });

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const NOW = 1_800_000_000_000;
const NOW_SEC = NOW / 1000;
let n = 0;

async function fixture(withJournal = true) {
  const id = ++n, tenant = addr(0xa000 + id), account = addr(0xb000 + id);
  const raw = new DatabaseSync(":memory:"); handles.push(raw);
  const shared = wrapSqlite(raw);
  await applyLedgerSchema(shared);
  if (withJournal) raw.exec(JOURNAL);
  const home = path.join(root, `home-${id}`);
  const scope = { tenant, smartAccount: account, chainId: 4663 };
  return { tenant, account, raw, shared, home, scope };
}

function control(raw: DatabaseSync, f: { tenant: string; account: string }, row: {
  bot?: string; update: number; kind: string; request?: number; at: number; expires?: number; token?: string; chat?: number;
}) {
  raw.prepare(`INSERT INTO recovery_reply_controls (bot_id,update_id,tenant,smart_account,chain_id,token_tag,claim_stamp,grant_tag,owner_id,chat_id,
    kind,request_update_id,message_at_sec,recorded_at_ms,expires_at_ms) VALUES (?,?,?,?,4663,?,1,'g',7,?,?,?,?,?,?)`)
    .run(row.bot ?? "111", row.update, f.tenant, f.account, row.token ?? "t1", row.chat ?? 7, row.kind, row.request ?? null, row.at, row.at * 1000, row.expires ?? null);
}

describe("foldRecoveryControls", () => {
  const r = (o: Record<string, unknown>) => ({ bot_id: "111", chat_id: 7, request_update_id: null, expires_at_ms: null, ...o });
  it("a /pause folds to a pause", () => {
    const f = foldRecoveryControls([r({ update_id: 5, kind: "pause", message_at_sec: 100 })], NOW);
    assert.deepEqual(f.pauses.map((p) => p.updateId), [5]);
    assert.equal(f.malformed, null);
  });
  it("/kill then /confirm inside the window is a confirmed kill, dated by the /confirm", () => {
    const f = foldRecoveryControls([
      r({ update_id: 5, kind: "kill-request", message_at_sec: 100, expires_at_ms: 190_000 }),
      r({ update_id: 6, kind: "kill-confirm", request_update_id: 5, message_at_sec: 150 }),
    ], NOW);
    assert.deepEqual(f.confirmedKills, [{ botId: "111", requestUpdateId: 5, confirmUpdateId: 6, confirmAtSec: 150, chatId: 7 }]);
    assert.equal(f.pendingKills, 0);
  });
  it("/kill then /cancel is nothing, and lifts nothing else", () => {
    const f = foldRecoveryControls([
      r({ update_id: 4, kind: "pause", message_at_sec: 90 }),
      r({ update_id: 5, kind: "kill-request", message_at_sec: 100, expires_at_ms: 190_000 }),
      r({ update_id: 6, kind: "kill-cancel", request_update_id: 5, message_at_sec: 150 }),
    ], NOW);
    assert.deepEqual(f.confirmedKills, []);
    assert.deepEqual(f.pauses.map((p) => p.updateId), [4]);
  });
  it("an unanswered /kill is pending inside its window and nothing once it has closed", () => {
    const rows = [r({ update_id: 5, kind: "kill-request", message_at_sec: 100, expires_at_ms: 190_000 })];
    assert.equal(foldRecoveryControls(rows, 150_000).pendingKills, 1);
    assert.equal(foldRecoveryControls(rows, 190_001).pendingKills, 0);
    assert.deepEqual(foldRecoveryControls(rows, 190_001).confirmedKills, []);
  });
  it("a token rotation keeps the pause: the fold spans every bot, token and claim", () => {
    const f = foldRecoveryControls([
      r({ update_id: 5, kind: "pause", message_at_sec: 100 }),
      r({ bot_id: "222", update_id: 1, kind: "pause", message_at_sec: 200 }),
    ], NOW);
    assert.equal(f.pauses.length, 2);
  });
  it("malformed rows hold rather than read as no controls", () => {
    assert.match(foldRecoveryControls([r({ update_id: 6, kind: "kill-confirm", request_update_id: 5, message_at_sec: 150 })], NOW).malformed ?? "", /names no \/kill/);
    assert.match(foldRecoveryControls([r({ update_id: 6, kind: "resume", message_at_sec: 150 })], NOW).malformed ?? "", /unreadable/);
    assert.match(foldRecoveryControls([
      r({ update_id: 5, kind: "kill-request", message_at_sec: 100, expires_at_ms: 190_000 }),
      r({ update_id: 6, kind: "kill-confirm", request_update_id: 5, message_at_sec: 200 }),
    ], NOW).malformed ?? "", /after its window/);
    assert.match(foldRecoveryControls([r({ update_id: "x", kind: "pause", message_at_sec: 1 })], NOW).malformed ?? "", /unreadable/);
    assert.match(foldRecoveryControls([null], NOW).malformed ?? "", /not an object/);
  });
});

describe("readRecoveryControls", () => {
  it("a missing journal (42P01, or sqlite's no such table) is no controls, not a failure", async () => {
    const f = await fixture(false);
    assert.deepEqual(await readRecoveryControls(f.shared, f.scope), { absent: true });
    const pg: Db = { ...f.shared, prepare: () => ({ run: async () => ({ changes: 0, lastInsertRowid: 0 }), get: async () => undefined,
      all: async () => { throw Object.assign(new Error("relation does not exist"), { code: "42P01" }); } }) } as Db;
    assert.deepEqual(await readRecoveryControls(pg, f.scope), { absent: true });
  });
  it("any other failure throws: an unreadable journal is not an empty one", async () => {
    const f = await fixture();
    const broken: Db = { ...f.shared, prepare: () => ({ run: async () => ({ changes: 0, lastInsertRowid: 0 }), get: async () => undefined,
      all: async () => { throw Object.assign(new Error("connection reset"), { code: "08006" }); } }) } as Db;
    await assert.rejects(readRecoveryControls(broken, f.scope), /connection reset/);
    const evidence = await readControlsEvidence(broken, f.scope, NOW);
    assert.equal(evidence.readable, false);
  });
});

const noKill = async (): Promise<KillForward> => { throw new Error("no kill was expected"); };

describe("armOwnerControls", () => {
  it("a recorded /pause is applied once: receipt, durable stamp, events row and the file", async () => {
    const f = await fixture();
    control(f.raw, f, { update: 9, kind: "pause", at: NOW_SEC - 60, chat: 42 });
    const first = await armOwnerControls({ scope: f.scope, home: f.home, shared: f.shared, mayWrite: () => true, forwardKill: noKill, nowMs: NOW });
    assert.deepEqual(first, { ok: true, paused: true, applied: ["pause 111:9"] });
    assert.equal(readFileSync(path.join(f.home, PAUSED_FILE), "utf8"), "paused");
    assert.equal(await readDurablePause(f.shared, f.tenant), NOW_SEC);
    const events = f.raw.prepare("SELECT message FROM events WHERE agent_id = ?").all(f.account) as Array<{ message: string }>;
    assert.equal(events.length, 1);
    assert.match(events[0]!.message, /^Telegram: paused by chat 42 /);
    assert.ok(events[0]!.message.endsWith(RECORDED_DURING_UPGRADE));
    const again = await armOwnerControls({ scope: f.scope, home: f.home, shared: f.shared, mayWrite: () => true, forwardKill: noKill, nowMs: NOW + 1000 });
    assert.deepEqual(again, { ok: true, paused: true, applied: [] });
    assert.equal((f.raw.prepare("SELECT count(*) AS n FROM recovery_reply_control_receipts").get() as { n: number }).n, 1);
    assert.equal((f.raw.prepare("SELECT count(*) AS n FROM events").get() as { n: number }).n, 1, "and the events row is written once");
  });

  it("the pause survives a rebuilt home", async () => {
    const f = await fixture();
    control(f.raw, f, { update: 9, kind: "pause", at: NOW_SEC - 60 });
    await armOwnerControls({ scope: f.scope, home: f.home, shared: f.shared, mayWrite: () => true, forwardKill: noKill, nowMs: NOW });
    rmSync(f.home, { recursive: true, force: true });
    const rebuilt = await armOwnerControls({ scope: f.scope, home: f.home, shared: f.shared, mayWrite: () => true, forwardKill: noKill, nowMs: NOW + 5000 });
    assert.deepEqual(rebuilt, { ok: true, paused: true, applied: ["durable-pause-restored"] });
    assert.ok(existsSync(path.join(f.home, PAUSED_FILE)));
  });

  it("an owner /resume after arm is not undone by a respawn, nor by a later rebuild", async () => {
    const f = await fixture();
    control(f.raw, f, { update: 9, kind: "pause", at: NOW_SEC - 60 });
    await armOwnerControls({ scope: f.scope, home: f.home, shared: f.shared, mayWrite: () => true, forwardKill: noKill, nowMs: NOW });
    rmSync(path.join(f.home, PAUSED_FILE)); // the child's setPaused(false), on the owner's /resume
    const respawn = await armOwnerControls({ scope: f.scope, home: f.home, shared: f.shared, mayWrite: () => true, forwardKill: noKill, nowMs: NOW + 60_000 });
    assert.deepEqual(respawn, { ok: true, paused: false, applied: [] });
    assert.equal(await readDurablePause(f.shared, f.tenant), null, "the durable stamp is lifted with it");
    rmSync(f.home, { recursive: true, force: true });
    const rebuilt = await armOwnerControls({ scope: f.scope, home: f.home, shared: f.shared, mayWrite: () => true, forwardKill: noKill, nowMs: NOW + 120_000 });
    assert.deepEqual(rebuilt, { ok: true, paused: false, applied: [] });
  });

  it("restores a legacy pause from the events table only when nothing acted after it, once", async () => {
    const f = await fixture(false);
    f.raw.prepare("INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, status) VALUES (?, ?, ?, 4663, '{}', 1, 2, 'armed')")
      .run(addr(0xbeef), f.tenant, addr(1));
    // The pause was recorded under the owner's EARLIER account: it still counts.
    f.raw.prepare("INSERT INTO events (agent_id, level, message, created_at) VALUES (?, 'warn', 'Telegram: paused by chat 42', ?)").run(addr(0xbeef), NOW_SEC - 7200);
    const legacy = await readLegacyPause(f.shared, f.scope);
    assert.ok(legacy);
    const armed = await armOwnerControls({ scope: f.scope, home: f.home, shared: f.shared, mayWrite: () => true, forwardKill: noKill, nowMs: NOW });
    assert.deepEqual(armed, { ok: true, paused: true, applied: [`legacy-restore ${legacy.eventId}`] });
    const receipt = f.raw.prepare("SELECT bot_id, kind FROM recovery_reply_control_receipts").get() as { bot_id: string; kind: string };
    assert.deepEqual({ ...receipt }, { bot_id: LEGACY_EVENTS_BOT, kind: "legacy-restore" });
    assert.equal(await readLegacyPause(f.shared, f.scope), null, "its own events row is not read back as a new pause");
    rmSync(path.join(f.home, PAUSED_FILE));
    assert.deepEqual(await armOwnerControls({ scope: f.scope, home: f.home, shared: f.shared, mayWrite: () => true, forwardKill: noKill, nowMs: NOW + 1000 }),
      { ok: true, paused: false, applied: [] });
  });

  it("does not restore a legacy pause the agent acted past, or one a resume followed", async () => {
    const f = await fixture(false);
    f.raw.prepare("INSERT INTO events (agent_id, level, message, created_at) VALUES (?, 'warn', 'Telegram: paused by chat 42', ?)").run(f.account, NOW_SEC - 7200);
    f.raw.prepare("INSERT INTO decisions (id, agent_id, source, action, at) VALUES ('d1', ?, 'strategy', 'buy', ?)").run(f.account, NOW_SEC - 3600);
    assert.equal(await readLegacyPause(f.shared, f.scope), null);
    const g = await fixture(false);
    g.raw.prepare("INSERT INTO events (agent_id, level, message, created_at) VALUES (?, 'warn', 'Telegram: paused by chat 42', ?)").run(g.account, NOW_SEC - 7200);
    g.raw.prepare("INSERT INTO events (agent_id, level, message, created_at) VALUES (?, 'warn', 'Telegram: resumed by chat 42', ?)").run(g.account, NOW_SEC - 3600);
    assert.equal(await readLegacyPause(g.shared, g.scope), null);
    const h = await fixture(false);
    h.raw.prepare("INSERT INTO events (agent_id, level, message, created_at) VALUES (?, 'warn', 'Telegram: paused by chat 42', ?)").run(h.account, NOW_SEC - 7200);
    h.raw.prepare("INSERT INTO decisions (id, agent_id, source, action, at) VALUES ('d1', ?, 'brain', 'buy', ?)").run(h.account, NOW_SEC - 3600);
    assert.ok(await readLegacyPause(h.shared, h.scope), "a Brain decision is made before the pause gate, so it proves no resume");
  });

  it("a confirmed /kill is forwarded, and its receipt is written only after honourKill returns", async () => {
    const f = await fixture();
    control(f.raw, f, { update: 5, kind: "kill-request", at: NOW_SEC - 100, expires: (NOW_SEC - 10) * 1000 });
    control(f.raw, f, { update: 6, kind: "kill-confirm", request: 5, at: NOW_SEC - 50 });
    const asked: Array<[number, string]> = [];
    const receiptsAt: number[] = [];
    const count = () => (f.raw.prepare("SELECT count(*) AS n FROM recovery_reply_control_receipts").get() as { n: number }).n;
    // Not carried out: no receipt, and the tenant stays held.
    const failed = await armOwnerControls({ scope: f.scope, home: f.home, shared: f.shared, mayWrite: () => true, nowMs: NOW,
      forwardKill: async (at, tag) => { asked.push([at, tag]); receiptsAt.push(count()); return "failed"; } });
    assert.deepEqual(failed, { ok: false, hold: "kill-not-carried-out", why: "a recorded kill could not be carried out yet" });
    assert.equal(count(), 0);
    const revoked = await armOwnerControls({ scope: f.scope, home: f.home, shared: f.shared, mayWrite: () => true, nowMs: NOW,
      forwardKill: async (at, tag) => { asked.push([at, tag]); receiptsAt.push(count()); return "revoked"; } });
    assert.equal(revoked.ok, false);
    assert.equal(!revoked.ok && revoked.hold, "revoked");
    assert.deepEqual(asked, [[NOW_SEC - 50, "111:5"], [NOW_SEC - 50, "111:5"]]);
    assert.deepEqual(receiptsAt, [0, 0], "no receipt existed while the kill was being carried out");
    assert.equal(count(), 1);
    assert.equal(existsSync(path.join(f.home, PAUSED_FILE)), false);
  });

  it("a kill superseded by a newer grant keeps that grant and pauses it", async () => {
    const f = await fixture();
    control(f.raw, f, { update: 5, kind: "kill-request", at: NOW_SEC - 100, expires: (NOW_SEC - 10) * 1000 });
    control(f.raw, f, { update: 6, kind: "kill-confirm", request: 5, at: NOW_SEC - 50 });
    const armed = await armOwnerControls({ scope: f.scope, home: f.home, shared: f.shared, mayWrite: () => true, nowMs: NOW, forwardKill: async () => "superseded" });
    assert.deepEqual(armed, { ok: true, paused: true, applied: ["kill-superseded-pause 111:6"] });
    const kinds = (f.raw.prepare("SELECT kind FROM recovery_reply_control_receipts ORDER BY kind").all() as Array<{ kind: string }>).map((r) => r.kind);
    assert.deepEqual(kinds, ["kill-forwarded", "kill-superseded-pause"]);
    // Forwarded once: the next arm asks nothing.
    assert.deepEqual(await armOwnerControls({ scope: f.scope, home: f.home, shared: f.shared, mayWrite: () => true, nowMs: NOW + 1000, forwardKill: noKill }),
      { ok: true, paused: true, applied: [] });
  });

  it("holds on a malformed journal and on a /kill still inside its window", async () => {
    const f = await fixture();
    control(f.raw, f, { update: 6, kind: "kill-confirm", request: 5, at: NOW_SEC - 50 });
    const bad = await armOwnerControls({ scope: f.scope, home: f.home, shared: f.shared, mayWrite: () => true, nowMs: NOW, forwardKill: noKill });
    assert.equal(!bad.ok && bad.hold, "malformed");
    const g = await fixture();
    control(g.raw, g, { update: 5, kind: "kill-request", at: NOW_SEC - 10, expires: (NOW_SEC + 80) * 1000 });
    const pending = await armOwnerControls({ scope: g.scope, home: g.home, shared: g.shared, mayWrite: () => true, nowMs: NOW, forwardKill: noKill });
    assert.equal(!pending.ok && pending.hold, "kill-awaiting-confirm");
    assert.equal(existsSync(path.join(g.home, CONTROLS_ARMED_FILE)), false, "a held arm records nothing");
  });

  it("a lost lease applies nothing", async () => {
    const f = await fixture();
    control(f.raw, f, { update: 9, kind: "pause", at: NOW_SEC - 60 });
    let healthy = true;
    const lostEarly = await armOwnerControls({ scope: f.scope, home: f.home, shared: f.shared, mayWrite: () => false, nowMs: NOW, forwardKill: noKill });
    assert.equal(!lostEarly.ok && lostEarly.hold, "lost-writer");
    // Lost inside the transaction: the receipt and the stamp roll back with it.
    let asked = 0;
    await assert.rejects(armOwnerControls({ scope: f.scope, home: f.home, shared: f.shared, nowMs: NOW, forwardKill: noKill,
      mayWrite: () => { asked += 1; if (asked > 1) healthy = false; return healthy; } }), /lost its tenant lease/);
    assert.equal((f.raw.prepare("SELECT count(*) AS n FROM recovery_reply_control_receipts").get() as { n: number }).n, 0);
    assert.equal(await readDurablePause(f.shared, f.tenant), null);
    assert.equal(existsSync(path.join(f.home, PAUSED_FILE)), false);
  });

  it("an owner pause the child wrote itself is left exactly as it is", async () => {
    const f = await fixture();
    mkdirSync(f.home, { recursive: true });
    writeFileSync(path.join(f.home, PAUSED_FILE), "paused");
    const armed = await armOwnerControls({ scope: f.scope, home: f.home, shared: f.shared, mayWrite: () => true, nowMs: NOW, forwardKill: noKill });
    assert.deepEqual(armed, { ok: true, paused: true, applied: [] });
  });
});
