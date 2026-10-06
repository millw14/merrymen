/**
 * A REDEPLOY GIVES A FRESH CHILD BACK THE CODE THE DASHBOARD SHOWS.
 *
 * Link codes are random now (telegram/state.ts). The old ones were a hash of
 * the token and a round, so a child that came back with no telegram.json
 * minted the same code it had before, give or take a round. A random one would
 * be new on every redeploy, and a tenant who had not linked yet would find the
 * code they were about to type replaced under them. So writeTelegramForChild
 * restores the published code even when there is no owner to restore, and
 * writes only the fields it has.
 *
 * Driven through the real writeTelegramForChild against a node:sqlite mirror
 * and a stubbed settings store, then read back the way the child reads it.
 *
 * AND THE RESTORED LINK IS ONE THE OFFSET HANDOFF ADMITS. spawnChild restores
 * the link and then hands the recovery listener's poll offset over
 * (handoffRecoveryReplyOffset), which refuses a telegram.json with no offset.
 * The restore wrote none, so an ordinary tenant whose bot the listener had
 * answered while it had no worker was refused (HANDOFF_OFFSET) on every pass
 * and got none. Driven here through both, in spawnChild's order, against the
 * listener's row in the same stand-in.
 */
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";

// At its real path: the handoff refuses a home reached through a link
// (HANDOFF_HOME), and macOS's tmpdir is one.
const FLEET = realpathSync(mkdtempSync(path.join(os.tmpdir(), "merrymen-tg-restore-code-")));
process.env.MERRYMEN_HOME = FLEET;
process.env.MERRYMEN_HOSTED = "1";
delete process.env.DATABASE_URL;
process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 7).toString("base64");
after(() => rmSync(FLEET, { recursive: true, force: true }));

const { childHome, restoredTelegramFile, writeTelegramForChild } = await import("./orchestrator");
const { getSettingsStore, useSettingsStoreForTest } = await import("./settings-store");
const { TELEGRAM_STATE_DDL, publishTenantTelegram } = await import("./telegram-store");
const { wrapSqlite } = await import("./db");
const { RECOVERY_REPLY_SCHEMA } = await import("./recovery-reply-state");
const { handoffRecoveryReplyOffset } = await import("./recovery-reply-handoff");
const { loadTelegramState } = await import("./telegram/state");

const allowlists = new Map<string, number[]>();
const stub = Object.create(getSettingsStore()) as ReturnType<typeof getSettingsStore>;
stub.get = async (t) => (allowlists.has(t) ? ({ telegramAllowlist: allowlists.get(t) } as never) : null);
useSettingsStoreForTest(stub);

const said: string[] = [];
const realLog = console.log;
console.log = (...a: unknown[]) => {
  said.push(a.map(String).join(" "));
};
after(() => {
  console.log = realLog;
});

let n = 0;
const tenant = (): `0x${string}` => `0x${(++n).toString(16).padStart(40, "0")}`;
const file = (t: string) => path.join(childHome(t), "telegram.json");
const written = (t: string) => JSON.parse(readFileSync(file(t), "utf8")) as Record<string, unknown>;

let raw: DatabaseSync;
let shared: ReturnType<typeof wrapSqlite>;
beforeEach(() => {
  raw = new DatabaseSync(":memory:");
  raw.exec(TELEGRAM_STATE_DDL);
  shared = wrapSqlite(raw);
  said.length = 0;
});

describe("writeTelegramForChild restores the published code", () => {
  it("a tenant who never linked gets the dashboard's code back, and nothing else", async () => {
    const t = tenant();
    await publishTenantTelegram(shared, t, { linkCode: "NTE49D", ownerId: null, linkedAt: null });
    await writeTelegramForChild(t, shared);
    assert.deepEqual(written(t), { offset: 0, linkCode: "NTE49D" });
    assert.ok(said.some((l) => l.includes("telegram link code restored (shown on the dashboard)")));
    assert.ok(!said.some((l) => l.includes("NTE49D")), "the code is never logged");
  });

  it("a linked tenant gets its owner, when it linked, and the code", async () => {
    const t = tenant();
    await publishTenantTelegram(shared, t, { linkCode: "JS945A", ownerId: 555, linkedAt: 1_790_000_000 });
    await writeTelegramForChild(t, shared);
    assert.deepEqual(written(t), { offset: 0, linkCode: "JS945A", ownerId: 555, linkedAt: 1_790_000_000 });
    assert.ok(said.some((l) => l.includes("telegram link restored")));
    assert.ok(!said.some((l) => l.includes("JS945A")));
  });

  it("an owner recovered from the allowlist, with no mirror row, gets no code and no made-up linkedAt", async () => {
    const t = tenant();
    allowlists.set(t, [-1001, 777, 555]);
    await writeTelegramForChild(t, shared);
    assert.deepEqual(written(t), { offset: 0, ownerId: 555 }, "the child mints a code and starts the bond at the next link");
  });

  it("nothing to restore writes no file", async () => {
    const t = tenant();
    await publishTenantTelegram(shared, t, { linkCode: null, ownerId: null, linkedAt: null });
    await writeTelegramForChild(t, shared);
    assert.equal(existsSync(file(t)), false);
  });

  it("never touches a live child's own file", async () => {
    const t = tenant();
    await publishTenantTelegram(shared, t, { linkCode: "OLD234", ownerId: 555, linkedAt: 1 });
    mkdirSync(childHome(t), { recursive: true });
    writeFileSync(file(t), JSON.stringify({ linkCode: "NEW567", ownerId: 999 }));
    await writeTelegramForChild(t, shared);
    assert.deepEqual(written(t), { linkCode: "NEW567", ownerId: 999 });
  });
});

describe("restoredTelegramFile", () => {
  it("writes only the fields it has, and never the chats the owner may have removed since", () => {
    assert.equal(restoredTelegramFile(null, null), null);
    assert.equal(restoredTelegramFile({ linkCode: "", linkedAt: 5 }, null), null, "a linkedAt with no owner means nothing");
    assert.deepEqual(restoredTelegramFile({ linkCode: "ABCDEF", linkedAt: null }, null), { offset: 0, linkCode: "ABCDEF" });
    assert.deepEqual(restoredTelegramFile(null, 555), { offset: 0, ownerId: 555 });
    const all = restoredTelegramFile({ linkCode: "ABCDEF", linkedAt: 7 }, 555)!;
    assert.deepEqual(all, { offset: 0, linkCode: "ABCDEF", ownerId: 555, linkedAt: 7 });
    assert.ok(!("linkedChats" in all));
    // Never a saved offset: 0, what every reader takes a missing one to be,
    // written out for the handoff, which refuses a file with none.
    assert.equal(all.offset, 0);
  });
});

describe("an ordinary tenant whose bot the recovery listener answered is admitted on its restored link", () => {
  const BOT = "8802";
  const account = (t: string) => `0x${(BigInt(t) + 0xacc000n).toString(16).padStart(40, "0")}`;
  /** The recovery listener's high-water mark for the tenant's bot, as recovery_reply_offsets holds it. */
  const listened = (t: string, offset: number) => {
    raw.exec(RECOVERY_REPLY_SCHEMA);
    raw.prepare("INSERT INTO recovery_reply_offsets VALUES(?,?,?,4663,?,200,?,100,1000)").run(BOT, t, account(t), "a".repeat(16), offset);
  };
  /** The handoff as spawnChild calls it, right after the restore: accepted, or the code it refused by. */
  const handoff = async (t: string) => {
    try {
      await handoffRecoveryReplyOffset({
        tenant: t, smartAccount: account(t), chainId: 4663, token: `${BOT}:restore_offset_fixture`, home: childHome(t), shared, mayWrite: () => true,
      });
      return "accepted";
    } catch (e) {
      return String((e as { code?: unknown }).code);
    }
  };
  /** telegram.json as the child loads it (telegram/state.ts loadTelegramState), from the tenant's home. */
  const childReads = (t: string) => {
    const fleet = process.env.MERRYMEN_HOME;
    process.env.MERRYMEN_HOME = childHome(t);
    try { return loadTelegramState(); } finally { process.env.MERRYMEN_HOME = fleet; }
  };

  it("a linked tenant: the restore writes offset 0, the handoff raises it to the listener's mark, and the child starts past it", async () => {
    const t = tenant();
    await publishTenantTelegram(shared, t, { linkCode: "QX7M2K", ownerId: 555, linkedAt: 1_790_000_000 });
    listened(t, 4321);
    // spawnChild's order: the link back first, then the handoff.
    await writeTelegramForChild(t, shared);
    assert.deepEqual(written(t), { offset: 0, linkCode: "QX7M2K", ownerId: 555, linkedAt: 1_790_000_000 });
    assert.equal(await handoff(t), "accepted", "admitted: with no offset this was HANDOFF_OFFSET on every pass, and no worker");
    assert.deepEqual(written(t), { offset: 4321, linkCode: "QX7M2K", ownerId: 555, linkedAt: 1_790_000_000 },
      "the link kept, and the listener's high-water mark handed over");
    assert.equal(lstatSync(file(t)).mode & 0o777, 0o600);
    const state = childReads(t);
    assert.equal(state.offset, 4321, "the child's first poll asks past everything the listener answered");
    assert.equal(state.ownerId, 555, "and the owner still hears from it");
    assert.equal(state.botId, null, "no bot recorded: the child adopts this one without resetting the offset (bindToken)");
    // The next pass: the file is there, so the restore leaves it, and the
    // handoff never lowers what it handed over.
    await writeTelegramForChild(t, shared);
    assert.equal(await handoff(t), "accepted");
    assert.equal(written(t).offset, 4321);
  });

  it("an owner recovered from the allowlist with no mirror row, the fleet's usual case, is admitted the same way", async () => {
    const t = tenant();
    allowlists.set(t, [-1001, 555]);
    listened(t, 77);
    await writeTelegramForChild(t, shared);
    assert.deepEqual(written(t), { offset: 0, ownerId: 555 });
    assert.equal(await handoff(t), "accepted");
    assert.deepEqual(written(t), { offset: 77, ownerId: 555 });
  });

  it("nothing to restore still writes nothing, and the handoff writes the listener's mark into a file of its own", async () => {
    const t = tenant();
    listened(t, 900);
    // The home spawnChild has by then: grant, settings and bootstrap are written first.
    mkdirSync(childHome(t), { recursive: true, mode: 0o700 });
    await writeTelegramForChild(t, shared);
    assert.equal(existsSync(file(t)), false);
    assert.equal(await handoff(t), "accepted");
    assert.deepEqual(written(t), { offset: 900, botId: null, priorBots: [] });
  });

  it("the handoff is not loosened: a link as a build before this one restored it, with no offset, is still refused by name and left as it is", async () => {
    const t = tenant();
    listened(t, 4321);
    const legacy = JSON.stringify({ linkCode: "QX7M2K", ownerId: 555, linkedAt: 1_790_000_000 }, null, 2);
    mkdirSync(childHome(t), { recursive: true });
    writeFileSync(file(t), legacy, { mode: 0o600 });
    assert.equal(await handoff(t), "HANDOFF_OFFSET");
    // Nor does the restore replace it: a file that is there is never
    // rewritten (a running child is the authority on its own link).
    await publishTenantTelegram(shared, t, { linkCode: "QX7M2K", ownerId: 555, linkedAt: 1_790_000_000 });
    await writeTelegramForChild(t, shared);
    assert.equal(readFileSync(file(t), "utf8"), legacy);
    assert.equal(await handoff(t), "HANDOFF_OFFSET");
  });
});
