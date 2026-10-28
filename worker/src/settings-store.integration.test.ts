/**
 * The per-tenant settings store — durable, isolated, sealed at rest.
 *
 * Proven against a real temp filesystem: a tenant's settings round-trip, one
 * tenant never sees another's, and a secret inside the settings (a Telegram bot
 * token) is CIPHERTEXT on disk, not plaintext.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MerrymenSettings } from "../../packages/core/src/index";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-sstore-"));
process.env.MERRYMEN_HOME = HOME;
process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 5).toString("base64");

const { FileSettingsStore } = await import("./settings-store");

after(() => {
  try {
    rmSync(HOME, { recursive: true, force: true });
  } catch {
    /* windows temp lock; disposable */
  }
});

const ALICE = "0x00000000000000000000000000000000000000a1" as const;
const BOB = "0x00000000000000000000000000000000000000b2" as const;
const BOT_TOKEN = "123456:AAHsecretBotToken_do_not_leak";

describe("FileSettingsStore", () => {
  const store = new FileSettingsStore("spot");

  it("round-trips a tenant's settings", async () => {
    const s: MerrymenSettings = { strategy: "trencher", basketSymbols: ["AAPL", "TSLA"], slippageBps: 300 };
    await store.put(ALICE, s);
    const got = await store.get(ALICE);
    assert.deepEqual(got, s);
  });

  it("SEALS a secret at rest — the bot token is not plaintext on disk", async () => {
    await store.put(ALICE, { telegramBotToken: BOT_TOKEN, strategy: "steady-basket" });
    const raw = readFileSync(path.join(HOME, "tenant-settings", `${ALICE}.json`), "utf8");
    assert.ok(!raw.includes(BOT_TOKEN), "a stored secret must never touch disk in the clear");
    assert.ok(raw.includes("sealed"), "…it is stored sealed");
    // …but reads back intact.
    assert.equal((await store.get(ALICE))!.telegramBotToken, BOT_TOKEN);
  });

  it("isolates tenants and lists them", async () => {
    await store.put(ALICE, { strategy: "trencher" });
    await store.put(BOB, { strategy: "weekend-gap" });
    assert.equal((await store.get(ALICE))!.strategy, "trencher");
    assert.equal((await store.get(BOB))!.strategy, "weekend-gap");
    assert.deepEqual((await store.listTenants()).sort(), [ALICE, BOB].sort());
  });

  it("remove forgets exactly one tenant; get on unknown is null", async () => {
    await store.put(ALICE, { strategy: "trencher" });
    await store.put(BOB, { strategy: "weekend-gap" });
    await store.remove(ALICE);
    assert.equal(await store.get(ALICE), null);
    assert.ok(await store.get(BOB));
    assert.equal(await store.get("0x00000000000000000000000000000000000000ff"), null);
  });
});
