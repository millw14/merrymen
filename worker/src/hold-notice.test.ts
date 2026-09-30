/**
 * THE HOLD NOTICE'S OWN RULES, over sqlite and a fake bot.
 *
 * restore-hold.integration.test.ts replaces the whole notice through its seam,
 * so it proves when the orchestrator tries to tell an owner, not what telling
 * them does. This drives notifyHoldOnce, which the orchestrator runs over
 * Postgres: the switches, the allowlist, the send before the record, and the
 * durable "told" that is the reason the record is in a database at all.
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, it } from "node:test";
import { wrapSqlite, type Db } from "./db";
import { notifyHoldOnce, type HoldNoticeDeps } from "./hold-notice";
import { holdNoticeText } from "./restore-block";
import { TELEGRAM_HOLD_NOTIFIED_DDL, TELEGRAM_STATE_DDL, holdNotifiedClasses } from "./telegram-store";

const TENANT = "0x00000000000000000000000000000000000000a8" as const;
const OWNER = 4242;
const NEWER = "trades newer than the last valuation";
const NO_BASIS = "a holding has no cost basis";

let db: Db;
let sent: { token: string; chatId: number; text: string }[];
let sendOk: boolean;
let enabled: boolean;
let allowlist: number[];
let logged: string[];

/** Fresh deps over the same database: what a redeployed orchestrator would build. */
const deps = (): HoldNoticeDeps => ({
  db,
  recipient: async () => ({ botToken: "111:a", chatId: OWNER, enabled }),
  allowlist: async () => allowlist,
  send: async (token, chatId, text) => {
    sent.push({ token, chatId, text });
    return sendOk ? { ok: true } : { ok: false, reason: "Forbidden: bot was blocked by the user" };
  },
  log: (line) => logged.push(line),
});

beforeEach(async () => {
  db = wrapSqlite(new DatabaseSync(":memory:"));
  await db.exec(TELEGRAM_STATE_DDL);
  await db.exec(TELEGRAM_HOLD_NOTIFIED_DDL);
  await db.prepare("INSERT INTO tenant_telegram (tenant, owner_id, updated_at) VALUES (?, ?, 0)").run(TENANT, OWNER);
  sent = [];
  sendOk = true;
  enabled = true;
  allowlist = [OWNER];
  logged = [];
});

describe("telling an owner their trading is held", () => {
  it("SENDS THE NOTICE TO THE LINKED CHAT THROUGH THE OWNER'S OWN BOT, AND RECORDS THE CLASS", async () => {
    assert.equal(await notifyHoldOnce(deps(), TENANT, NEWER, true), "sent");
    assert.deepEqual(sent, [{ token: "111:a", chatId: OWNER, text: holdNoticeText(NEWER, true) }]);
    assert.deepEqual(await holdNotifiedClasses(db, TENANT), [NEWER]);
  });

  it("OFFERS THE PRACTICE RESET ONLY WHERE IT WOULD BE HONOURED", async () => {
    assert.equal(await notifyHoldOnce(deps(), TENANT, NEWER, false), "sent");
    assert.equal(sent[0]!.text, holdNoticeText(NEWER, false));
    assert.doesNotMatch(sent[0]!.text, /Start over|start practice over/, "an owner it would be refused for is not sent round the loop");
    assert.match(sent[0]!.text, /don't need to do anything/);
    assert.match(holdNoticeText(NEWER, true), /Wallet → Start over/);
  });

  it("ONCE PER CLASS ACROSS A REDEPLOY: 'told' COMES FROM THE DATABASE, NOT FROM MEMORY", async () => {
    await notifyHoldOnce(deps(), TENANT, NEWER, true);
    // New deps, nothing remembered: the next process.
    assert.equal(await notifyHoldOnce(deps(), TENANT, NEWER, true), "told");
    assert.equal(sent.length, 1, "not said again");
    // A new cause is news, and a return to the first one is not.
    assert.equal(await notifyHoldOnce(deps(), TENANT, NO_BASIS, true), "sent");
    assert.equal(await notifyHoldOnce(deps(), TENANT, NEWER, true), "told");
    assert.deepEqual(sent.map((m) => m.text), [holdNoticeText(NEWER, true), holdNoticeText(NO_BASIS, true)]);
  });

  it("A SEND THAT FAILS RECORDS NOTHING, SO THE NEXT ATTEMPT SENDS", async () => {
    sendOk = false;
    assert.equal(await notifyHoldOnce(deps(), TENANT, NEWER, true), "failed");
    assert.deepEqual(await holdNotifiedClasses(db, TENANT), [], "at least once, not at most");
    assert.ok(logged.some((l) => l.includes("did not send — Forbidden")));
    sendOk = true;
    assert.equal(await notifyHoldOnce(deps(), TENANT, NEWER, true), "sent");
    assert.equal(sent.length, 2);
  });

  it("OBEYS THE SWITCHES: TELEGRAM OR ITS ALERTS OFF IS NO MESSAGE, AND NO RECORD", async () => {
    enabled = false;
    assert.equal(await notifyHoldOnce(deps(), TENANT, NEWER, true), "no-owner");
    assert.equal(sent.length, 0);
    assert.deepEqual(await holdNotifiedClasses(db, TENANT), [], "so it is said once they switch it back on");
  });

  it("NO LINKED CHAT IS NO MESSAGE", async () => {
    const none: HoldNoticeDeps = { ...deps(), recipient: async () => null };
    assert.equal(await notifyHoldOnce(none, TENANT, NEWER, true), "no-owner");
    assert.equal(sent.length, 0);
  });

  it("A LINKED CHAT THE OWNER HAS SINCE TAKEN OFF THE ALLOWLIST IS NOT TOLD", async () => {
    // owner_id is the first chat that ever linked, and nothing clears it.
    allowlist = [9999];
    assert.equal(await notifyHoldOnce(deps(), TENANT, NEWER, true), "no-owner");
    assert.equal(sent.length, 0);
    allowlist = [9999, OWNER];
    assert.equal(await notifyHoldOnce(deps(), TENANT, NEWER, true), "sent");
  });

  it("A DATABASE THAT FAILS IS A FAILED ATTEMPT, NOT A THROW", async () => {
    const broken: HoldNoticeDeps = {
      ...deps(),
      db: { ...db, prepare: () => { throw new Error("Connection terminated unexpectedly"); } } as unknown as Db,
    };
    assert.equal(await notifyHoldOnce(broken, TENANT, NEWER, true), "failed");
    assert.equal(sent.length, 0, "and nothing is sent without the record to check first");
  });
});
