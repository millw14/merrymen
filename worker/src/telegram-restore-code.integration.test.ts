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
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";

const FLEET = mkdtempSync(path.join(os.tmpdir(), "merrymen-tg-restore-code-"));
process.env.MERRYMEN_HOME = FLEET;
process.env.MERRYMEN_HOSTED = "1";
delete process.env.DATABASE_URL;
process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 7).toString("base64");
after(() => rmSync(FLEET, { recursive: true, force: true }));

const { childHome, restoredTelegramFile, writeTelegramForChild } = await import("./orchestrator");
const { getSettingsStore, useSettingsStoreForTest } = await import("./settings-store");
const { TELEGRAM_STATE_DDL, publishTenantTelegram } = await import("./telegram-store");
const { wrapSqlite } = await import("./db");

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
    assert.deepEqual(written(t), { linkCode: "NTE49D" });
    assert.ok(said.some((l) => l.includes("telegram link code restored (shown on the dashboard)")));
    assert.ok(!said.some((l) => l.includes("NTE49D")), "the code is never logged");
  });

  it("a linked tenant gets its owner, when it linked, and the code", async () => {
    const t = tenant();
    await publishTenantTelegram(shared, t, { linkCode: "JS945A", ownerId: 555, linkedAt: 1_790_000_000 });
    await writeTelegramForChild(t, shared);
    assert.deepEqual(written(t), { linkCode: "JS945A", ownerId: 555, linkedAt: 1_790_000_000 });
    assert.ok(said.some((l) => l.includes("telegram link restored")));
    assert.ok(!said.some((l) => l.includes("JS945A")));
  });

  it("an owner recovered from the allowlist, with no mirror row, gets no code and no made-up linkedAt", async () => {
    const t = tenant();
    allowlists.set(t, [-1001, 777, 555]);
    await writeTelegramForChild(t, shared);
    assert.deepEqual(written(t), { ownerId: 555 }, "the child mints a code and starts the bond at the next link");
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
    assert.deepEqual(restoredTelegramFile({ linkCode: "ABCDEF", linkedAt: null }, null), { linkCode: "ABCDEF" });
    assert.deepEqual(restoredTelegramFile(null, 555), { ownerId: 555 });
    const all = restoredTelegramFile({ linkCode: "ABCDEF", linkedAt: 7 }, 555)!;
    assert.deepEqual(all, { linkCode: "ABCDEF", ownerId: 555, linkedAt: 7 });
    assert.ok(!("linkedChats" in all) && !("offset" in all));
  });
});
