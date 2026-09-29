/**
 * A CHAT THE OWNER REMOVES ON THE DASHBOARD STAYS REMOVED.
 *
 * A hosted /link is made durable by the orchestrator promoting the child's
 * `linkedChats` into the tenant's stored allowlist (publishChildTelegram).
 * That list only grows, and the promotion added back whatever of it the store
 * lacked, on every mirror pass. So a chat the owner removed in Settings →
 * Telegram (the one way to revoke a chat that linked with a shared or leaked
 * code) was refused for one pass, put back on the next, handed to the child
 * again, and kept full command authority until a redeploy wiped the home. The
 * hold process links through the same code and feeds the same list.
 *
 * Driven through the real publish, run as the mirror pass runs it, over the
 * file settings store (no DATABASE_URL) and a node:sqlite shared database.
 * MERRYMEN_HOME is per process (node --test forks per file).
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, afterEach, beforeEach, describe, it, mock } from "node:test";

const FLEET = mkdtempSync(path.join(os.tmpdir(), "merrymen-link-promotion-"));
process.env.MERRYMEN_HOME = FLEET;
process.env.MERRYMEN_HOSTED = "1";
process.env.MERRYMEN_SESSION_SECRET ??= randomBytes(32).toString("hex");
delete process.env.DATABASE_URL;
after(() => rmSync(FLEET, { recursive: true, force: true }));

const { childHome, publishChildTelegramForTest } = await import("./orchestrator");
const { getSettingsStore } = await import("./settings-store");
const { wrapSqlite } = await import("./db");
const { TELEGRAM_LIVENESS_DDL, TELEGRAM_STATE_DDL } = await import("./telegram-store");

const T = 1_790_000_000;
let n = 0;
let lines: string[] = [];
beforeEach(() => {
  lines = [];
  mock.method(console, "log", (...a: unknown[]) => {
    lines.push(a.map(String).join(" "));
  });
});
afterEach(() => mock.restoreAll());

async function shared() {
  const db = wrapSqlite(new DatabaseSync(":memory:"));
  await db.exec(TELEGRAM_STATE_DDL);
  for (const ddl of TELEGRAM_LIVENESS_DDL) await db.exec(ddl);
  return db;
}

/** A tenant whose child (or hold process) has written a telegram.json, and whose owner has stored settings. */
async function tenantWith(childState: string) {
  const tenant = `0x00000000000000000000000000000000000000${(0xa0 + n++).toString(16)}` as `0x${string}`;
  const home = childHome(tenant);
  mkdirSync(home, { recursive: true });
  const db = await shared();
  return {
    tenant,
    /** What the child's telegram.json says, as tryLink leaves it. */
    linked: (linkedChats: number[], linkedChatAt?: Record<string, number>) =>
      writeFileSync(path.join(home, "telegram.json"), JSON.stringify({ linkCode: "K7M2QX", linkedChats, ...(linkedChatAt ? { linkedChatAt } : {}) })),
    /** The owner saves the allowlist on the dashboard. */
    store: async (allowlist: number[]) => {
      const stored = (await getSettingsStore().get(tenant)) ?? {};
      await getSettingsStore().put(tenant, { ...stored, telegramAllowlist: allowlist });
    },
    allowlist: async () => [...((await getSettingsStore().get(tenant))?.telegramAllowlist ?? [])].sort((a, b) => a - b),
    pass: () => publishChildTelegramForTest(tenant, db, childState),
    home,
  };
}

for (const childState of ["trading", "held:cost basis and holdings disagree"]) {
  describe(`publishChildTelegram, ${childState === "trading" ? "for a trading child" : "for a held tenant's hold process"}`, () => {
    it("A LINKED CHAT IS PROMOTED; ONE THE OWNER THEN REMOVES STAYS REMOVED, pass after pass", async () => {
      const t = await tenantWith(childState);
      await t.store([111]);
      t.linked([111, 222], { "111": T, "222": T + 5 });
      await t.pass();
      assert.deepEqual(await t.allowlist(), [111, 222], "the link is made durable");
      // The owner removes 222 in Settings → Telegram. The child's list still has it.
      await t.store([111]);
      await t.pass();
      await t.pass();
      assert.deepEqual(await t.allowlist(), [111], "not put back");
    });

    it("a chat that links afterwards is still promoted, and the removed one only if it links again", async () => {
      const t = await tenantWith(childState);
      t.linked([111, 222], { "111": T, "222": T + 5 });
      await t.pass();
      await t.store([111]);
      await t.pass();
      t.linked([111, 222, 333], { "111": T, "222": T + 5, "333": T + 60 });
      await t.pass();
      assert.deepEqual(await t.allowlist(), [111, 333]);
      // 222 is given a new code and links with it: a new link, promoted.
      t.linked([111, 222, 333], { "111": T, "222": T + 900, "333": T + 60 });
      await t.pass();
      assert.deepEqual(await t.allowlist(), [111, 222, 333]);
    });

    it("a telegram.json from before link times were kept is promoted once, then left alone", async () => {
      const t = await tenantWith(childState);
      t.linked([444]);
      await t.pass();
      assert.deepEqual(await t.allowlist(), [444]);
      await t.store([]);
      await t.pass();
      assert.deepEqual(await t.allowlist(), []);
    });
  });
}

describe("the promotion record", () => {
  it("A RECORD THAT WILL NOT READ PROMOTES NOTHING, rather than everything the owner removed", async () => {
    const t = await tenantWith("trading");
    t.linked([111, 222], { "111": T, "222": T + 5 });
    await t.pass();
    await t.store([111]);
    writeFileSync(path.join(t.home, "telegram-promoted.json"), "{ torn");
    await t.pass();
    assert.deepEqual(await t.allowlist(), [111], "the removed chat is not put back");
    assert.ok(lines.some((l) => l.includes(t.tenant) && /link record unreadable/.test(l)));
    // Rewritten, so the next link is promoted as usual.
    t.linked([111, 222, 333], { "111": T, "222": T + 5, "333": T + 60 });
    await t.pass();
    assert.deepEqual(await t.allowlist(), [111, 333]);
  });

  it("A HOME A REDEPLOY WIPED STARTS BOTH OVER TOGETHER: the fresh child's links are new", async () => {
    const t = await tenantWith("trading");
    t.linked([111], { "111": T });
    await t.pass();
    await t.store([]);
    rmSync(t.home, { recursive: true, force: true });
    mkdirSync(t.home, { recursive: true });
    // writeTelegramForChild restores no linkedChats; the owner links again.
    t.linked([111], { "111": T + 7_200 });
    await t.pass();
    assert.deepEqual(await t.allowlist(), [111]);
  });
});
