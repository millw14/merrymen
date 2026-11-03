import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { wrapSqlite, type Db } from "../db";
import { applyLedgerSchema } from "../store";
import { recordPerpsWallet } from "../perps-wallets";
import { armOwnerControls, durablePauseLifted, readLegacyPause } from "../recovery-reply-arm";
import { readDurablePause } from "../telegram-store";
import { applyPerpsBotControl } from "./telegram-controls";
import type { PerpsBotRequest } from "./telegram-bridge";

const NOW = 1_800_000_000_000;
const OWNER = "0x1111111111111111111111111111111111111111";
const ACCOUNT = "0x2222222222222222222222222222222222222222";
const OTHER = "0x3333333333333333333333333333333333333333";

async function fixture(t: TestContext) {
  const home = mkdtempSync(path.join(os.tmpdir(), "perps-bot-controls-"));
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  t.after(() => { raw.close(); rmSync(home, { recursive: true, force: true }); });
  await applyLedgerSchema(db);
  await recordPerpsWallet(db, { owner: OWNER, smartAccount: ACCOUNT, chainId: 4663, nowSec: NOW / 1000 });
  raw.prepare(`INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at)
    VALUES (?, ?, ?, 4663, '{}', ?, ?)`).run(ACCOUNT, OWNER, OTHER, NOW / 1000 - 1, NOW / 1000 + 3600);
  const paused = path.join(home, "paused");
  const scope = { tenant: OWNER, smartAccount: ACCOUNT, chainId: 4663 };
  const request = (kind: "pause" | "resume", updateId: number, at = NOW, bot = "123"): PerpsBotRequest => ({
    kind, expectedAccount: ACCOUNT, requestId: `tg-perps-${bot}-${updateId}`, askedAtSec: Math.floor(at / 1000),
  });
  const apply = (r: PerpsBotRequest, opts: { db?: Db; mayWrite?: () => boolean; nowMs?: number; tenant?: string } = {}) =>
    applyPerpsBotControl({ db, tenant: OWNER, home, request: r, mayWrite: () => true, nowMs: NOW, ...opts });
  return { home, raw, db, paused, scope, request, apply };
}

function faultOn(db: Db, match: RegExp, failure: () => void): Db {
  return {
    exec: sql => db.exec(sql),
    tx: fn => db.tx(tx => fn(faultOn(tx, match, failure))),
    prepare(sql) {
      const statement = db.prepare(sql);
      return {
        ...statement,
        run: async (...args) => { if (match.test(sql)) failure(); return statement.run(...args); },
      };
    },
  };
}

test("Perps-only pause and resume are durable across rebuilt homes, with truthful control events", async t => {
  const f = await fixture(t);
  const settings = path.join(f.home, "settings.json");
  writeFileSync(settings, JSON.stringify({ perpsEnabled: false, entriesHalted: true }));
  assert.match(await f.apply(f.request("pause", 1)), /login is paused/);
  assert.ok(existsSync(f.paused));
  const stamp = await readDurablePause(f.db, OWNER);
  assert.equal(stamp, NOW / 1000);
  rmSync(f.home, { recursive: true });
  const armed = await armOwnerControls({ shared: f.db, scope: f.scope, home: f.home,
    mayWrite: () => true, nowMs: NOW + 1000, forwardKill: async () => "revoked" });
  assert.equal(armed.ok && armed.paused, true);
  assert.ok(existsSync(f.paused));
  writeFileSync(settings, JSON.stringify({ perpsEnabled: false, entriesHalted: true }));
  assert.match(await f.apply(f.request("resume", 2, NOW + 2000), { nowMs: NOW + 2000 }), /pause is lifted/);
  assert.equal(existsSync(f.paused), false);
  assert.equal(await readDurablePause(f.db, OWNER), null);
  assert.equal(await durablePauseLifted(f.db, f.scope, stamp!), true);
  assert.equal(await readLegacyPause(f.db, f.scope), null);
  assert.deepEqual(JSON.parse(readFileSync(settings, "utf8")), { perpsEnabled: false, entriesHalted: true });
  rmSync(f.home, { recursive: true });
  const resumed = await armOwnerControls({ shared: f.db, scope: f.scope, home: f.home,
    mayWrite: () => true, nowMs: NOW + 3000, forwardKill: async () => "revoked" });
  assert.equal(resumed.ok && resumed.paused, false);
});

test("an old resume receipt cannot undo a later pause, and a pause receipt cannot replay after resume", async t => {
  const f = await fixture(t);
  const pause = f.request("pause", 1), resume = f.request("resume", 2);
  await f.apply(pause);
  await f.apply(resume);
  assert.match(await f.apply(pause), /already recorded/);
  assert.equal(existsSync(f.paused), false);
  await f.apply(f.request("pause", 3));
  const later = readFileSync(f.paused, "utf8");
  assert.match(await f.apply(resume), /later owner control/);
  assert.equal(readFileSync(f.paused, "utf8"), later);
  assert.equal(await durablePauseLifted(f.db, f.scope, NOW / 1000), false);
  assert.equal((f.raw.prepare("SELECT count(*) AS n FROM perps_telegram_control_receipts").get() as { n: number }).n, 3);
});

test("numeric Telegram ordering rejects a delayed unseen resume and delayed unseen pause", async t => {
  const f = await fixture(t);
  await f.apply(f.request("pause", 10));
  assert.match(await f.apply(f.request("resume", 9)), /stale/);
  assert.ok(existsSync(f.paused));
  await f.apply(f.request("resume", 11));
  assert.match(await f.apply(f.request("pause", 8)), /stale/);
  assert.equal(existsSync(f.paused), false);
});

test("bot rotation cannot use a same-second ambiguous resume or an older request to lift a pause", async t => {
  const f = await fixture(t);
  await f.apply(f.request("pause", 10));
  assert.match(await f.apply(f.request("resume", 1, NOW, "456")), /stale/);
  assert.match(await f.apply(f.request("resume", 2, NOW - 1000, "456")), /stale/);
  assert.ok(existsSync(f.paused));
  assert.match(await f.apply(f.request("resume", 3, NOW + 1000, "456"), { nowMs: NOW + 1000 }), /pause is lifted/);
});

test("a receipt is bound to its tenant, account, action, and message time", async t => {
  const f = await fixture(t);
  const pause = f.request("pause", 1);
  await f.apply(pause);
  const changes: Partial<PerpsBotRequest>[] = [{ kind: "resume" }, { expectedAccount: OTHER }, { askedAtSec: pause.askedAtSec + 1 }];
  for (const changed of changes) {
    assert.match(await f.apply({ ...pause, ...changed }), /could not be identified/);
    assert.ok(existsSync(f.paused));
  }
  assert.equal(await readDurablePause(f.db, OTHER), null);
});

test("malformed, expired, future, and non-control requests cannot write owner controls", async t => {
  const f = await fixture(t);
  const valid = f.request("resume", 1);
  for (const changed of [{ requestId: "arbitrary" }, { requestId: "tg-perps-123-9007199254740992" },
    { askedAtSec: NOW / 1000 - 91 }, { askedAtSec: NOW / 1000 + 6 }, { kind: "flatten" as const }]) {
    assert.match(await f.apply({ ...valid, ...changed }), /could not be identified/);
  }
  assert.equal(f.raw.prepare("SELECT name FROM sqlite_master WHERE name = 'perps_telegram_control_receipts'").get(), undefined);
});

test("a failed pause transaction leaves no receipt; a failed resume keeps the pause and durable stamp", async t => {
  const f = await fixture(t);
  const broken = faultOn(f.db, /INSERT INTO events/, () => { throw new Error("shared journal unavailable"); });
  await assert.rejects(f.apply(f.request("pause", 1), { db: broken }), /journal unavailable/);
  assert.equal(await readDurablePause(f.db, OWNER), null);
  await f.apply(f.request("pause", 1));
  await assert.rejects(f.apply(f.request("resume", 2), { db: broken }), /journal unavailable/);
  assert.ok(existsSync(f.paused));
  assert.equal(await readDurablePause(f.db, OWNER), NOW / 1000);
  assert.equal((f.raw.prepare("SELECT count(*) AS n FROM perps_telegram_control_receipts").get() as { n: number }).n, 1);
});

test("a pause replaces a marker symlink introduced during its transaction without following it", async t => {
  const f = await fixture(t);
  const target = path.join(f.home, "other-owner-state.json");
  writeFileSync(target, "state that the pause must not overwrite");
  const raced = faultOn(f.db, /UPDATE perps_telegram_control_state SET request_id/, () => {
    symlinkSync(target, f.paused);
  });
  assert.match(await f.apply(f.request("pause", 1), { db: raced }), /login is paused/);
  assert.equal(readFileSync(target, "utf8"), "state that the pause must not overwrite");
  assert.equal(lstatSync(f.paused).isFile(), true);
  assert.equal(await readDurablePause(f.db, OWNER), NOW / 1000);
  assert.match(await f.apply(f.request("resume", 2)), /pause is lifted/);
  assert.equal(existsSync(f.paused), false);
});

test("a resume that expires during a shared-store read cannot clear the pause", async t => {
  const f = await fixture(t);
  await f.apply(f.request("pause", 1));
  let clock = NOW;
  t.mock.method(Date, "now", () => clock);
  const delayed: Db = {
    exec: sql => f.db.exec(sql),
    prepare: sql => f.db.prepare(sql),
    tx: fn => f.db.tx(tx => fn({
      exec: sql => tx.exec(sql), tx: nested => tx.tx(nested),
      prepare(sql) {
        const statement = tx.prepare(sql);
        return { ...statement, get: async (...args) => {
          const row = await statement.get(...args);
          if (/SELECT paused_at/.test(sql)) clock += 91_000;
          return row;
        } };
      },
    })),
  };
  assert.match(await applyPerpsBotControl({ db: delayed, tenant: OWNER, home: f.home,
    request: f.request("resume", 2), mayWrite: () => true }), /stale/);
  assert.ok(existsSync(f.paused));
  assert.equal(await readDurablePause(f.db, OWNER), NOW / 1000);
  assert.equal((f.raw.prepare("SELECT count(*) AS n FROM perps_telegram_control_receipts").get() as { n: number }).n, 1);
});

test("pause marker durability failure rolls back the receipt and shared stamp", async t => {
  const f = await fixture(t);
  mkdirSync(f.paused);
  await assert.rejects(f.apply(f.request("pause", 1)));
  assert.equal(await readDurablePause(f.db, OWNER), null);
  assert.equal((f.raw.prepare("SELECT count(*) AS n FROM perps_telegram_control_receipts").get() as { n: number }).n, 0);
});

test("lease loss before commit rolls back, and after resume commit leaves only restrictive cleanup", async t => {
  const f = await fixture(t);
  await assert.rejects(f.apply(f.request("pause", 1), { mayWrite: () => false }), /lease/);
  await f.apply(f.request("pause", 1));
  let healthy = true;
  const loseBeforeCommit = faultOn(f.db, /UPDATE perps_telegram_control_state SET request_id/, () => { healthy = false; });
  await assert.rejects(f.apply(f.request("resume", 2), { db: loseBeforeCommit, mayWrite: () => healthy }), /lease/);
  assert.ok(existsSync(f.paused));
  assert.equal(await readDurablePause(f.db, OWNER), NOW / 1000);
  healthy = true;
  const loseAfterCommit: Db = { exec: sql => f.db.exec(sql), prepare: sql => f.db.prepare(sql),
    tx: async fn => { const result = await f.db.tx(fn); healthy = false; return result; } };
  await assert.rejects(f.apply(f.request("resume", 2), { db: loseAfterCommit, mayWrite: () => healthy }), /lease/);
  assert.ok(existsSync(f.paused), "receipt committed, but stale writer must not unlink");
  assert.equal(await readDurablePause(f.db, OWNER), null);
  assert.match(await f.apply(f.request("resume", 2)), /pause is lifted/);
  assert.equal(existsSync(f.paused), false);
});

test("a pause replaced after resume commit survives its crash retry, even with identical text", async t => {
  const f = await fixture(t);
  await f.apply(f.request("pause", 1));
  let healthy = true;
  const interrupted: Db = { exec: sql => f.db.exec(sql), prepare: sql => f.db.prepare(sql),
    tx: async fn => { const result = await f.db.tx(fn); healthy = false; return result; } };
  await assert.rejects(f.apply(f.request("resume", 2), { db: interrupted, mayWrite: () => healthy }), /lease/);
  const text = readFileSync(f.paused, "utf8");
  rmSync(f.paused);
  writeFileSync(f.paused, text);
  assert.match(await f.apply(f.request("resume", 2)), /Another login pause/);
  assert.equal(readFileSync(f.paused, "utf8"), text);
});

test("a crash after a new pause marker but before COMMIT cannot let an old resume remove it", async t => {
  const f = await fixture(t);
  await f.apply(f.request("pause", 1));
  await f.apply(f.request("resume", 2));
  const crashAtCommit: Db = { exec: sql => f.db.exec(sql), prepare: sql => f.db.prepare(sql),
    tx: fn => f.db.tx(async tx => { await fn(tx); throw new Error("commit failed"); }) };
  await assert.rejects(f.apply(f.request("pause", 3), { db: crashAtCommit }), /commit failed/);
  assert.ok(existsSync(f.paused), "the restrictive marker survives the failed transaction");
  assert.equal(await readDurablePause(f.db, OWNER), null, "the new pause receipt and stamp rolled back");
  assert.match(await f.apply(f.request("resume", 2)), /Another login pause/);
  assert.ok(existsSync(f.paused));
});

test("concurrent pause/resume requests serialize through file cleanup, with the later pause standing", async t => {
  const f = await fixture(t);
  const lines = await Promise.all([f.apply(f.request("pause", 1)), f.apply(f.request("resume", 2)), f.apply(f.request("pause", 3))]);
  assert.match(lines[0]!, /login is paused/);
  assert.match(lines[1]!, /pause is lifted/);
  assert.match(lines[2]!, /login is paused/);
  assert.ok(existsSync(f.paused));
  assert.equal(await readDurablePause(f.db, OWNER), NOW / 1000);
});

test("another tenant's Perps resume event cannot lift this owner's durable pause", async t => {
  const f = await fixture(t);
  await f.apply(f.request("pause", 1));
  f.raw.prepare("INSERT INTO events (agent_id, message, created_at) VALUES (?, 'Telegram: resumed by chat (Perps owner controls)', ?)")
    .run(OTHER, NOW / 1000 + 1);
  assert.equal(await durablePauseLifted(f.db, f.scope, NOW / 1000), false);
  assert.ok(await readLegacyPause(f.db, f.scope));
});
