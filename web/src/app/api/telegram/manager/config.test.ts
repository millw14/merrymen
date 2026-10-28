import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { telegramManagerConfig } from "./config";

const fixture = {
  MERRYMEN_HOSTED: "1",
  MERRYMEN_TELEGRAM_CREATE_ENABLED: "true",
  DATABASE_URL: "postgres://fixture@127.0.0.1:55441/unused",
  MERRYMEN_STORE_DEK: Buffer.alloc(32, 73).toString("base64"),
  MERRYMEN_TELEGRAM_MANAGER_TOKEN: "11111:manager_test_secret",
  MERRYMEN_TELEGRAM_MANAGER_USERNAME: "merrymen_manager_bot",
  MERRYMEN_TELEGRAM_MANAGER_WEBHOOK_SECRET: "a".repeat(32),
};
type Key = keyof typeof fixture;
let saved: Record<Key, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(Object.keys(fixture).map(key => [key, process.env[key]])) as typeof saved;
  Object.assign(process.env, fixture);
});
afterEach(() => {
  for (const key of Object.keys(fixture) as Key[]) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
});

describe("managed Telegram API configuration", () => {
  it("requires explicit hosted activation and every credential before becoming available", () => {
    assert.deepEqual(telegramManagerConfig(), {
      token: fixture.MERRYMEN_TELEGRAM_MANAGER_TOKEN,
      username: fixture.MERRYMEN_TELEGRAM_MANAGER_USERNAME,
      webhookSecret: fixture.MERRYMEN_TELEGRAM_MANAGER_WEBHOOK_SECRET,
    });
    for (const key of Object.keys(fixture) as Key[]) {
      delete process.env[key];
      assert.equal(telegramManagerConfig(), null, `missing ${key} must keep creation unavailable`);
      process.env[key] = fixture[key];
    }
    for (const [key, value] of [
      ["MERRYMEN_HOSTED", "false"],
      ["MERRYMEN_TELEGRAM_CREATE_ENABLED", "false"],
      ["MERRYMEN_STORE_DEK", Buffer.alloc(31).toString("base64")],
      ["MERRYMEN_TELEGRAM_MANAGER_TOKEN", "11111:bad/token"],
      ["MERRYMEN_TELEGRAM_MANAGER_USERNAME", "not_a_bot_username"],
      ["MERRYMEN_TELEGRAM_MANAGER_WEBHOOK_SECRET", "short"],
    ] as [Key, string][]) {
      process.env[key] = value;
      assert.equal(telegramManagerConfig(), null, `invalid ${key} must keep creation unavailable`);
      process.env[key] = fixture[key];
    }
  });
  it("reads activation at request time so disabling it takes effect without rebuilding", () => {
    assert.ok(telegramManagerConfig());
    process.env.MERRYMEN_TELEGRAM_CREATE_ENABLED = "false";
    assert.equal(telegramManagerConfig(), null);
  });
});
