import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { boundedJson, managedBotIdentity, TelegramManager, validWebhookSecret } from "./telegram-manager";

const config = { token: "11111:manager_test_secret", username: "merrymen_manager_bot", webhookSecret: "a".repeat(32) };
const identity = { id: "22222", username: "my_merrymen_bot" };
const bot = { id: 22222, username: identity.username, is_bot: true };
function transport(result: (method: string, body: Record<string, unknown>) => unknown) {
  return (async (input, init) => {
    const method = String(input).split("/").at(-1)!;
    return Response.json({ ok: true, result: result(method, JSON.parse(String(init?.body))) });
  }) as typeof fetch;
}
describe("Telegram manager transport", () => {
  it("requires Telegram's manager capability and the configured username", async () => {
    for (const me of [{ id: 11111, is_bot: true, username: config.username },
      { id: 11111, is_bot: true, username: "other_bot", can_manage_bots: true }]) {
      await assert.rejects(new TelegramManager(config, transport(() => me)).assertReady());
    }
    await new TelegramManager(config, transport(() => ({ id: 11111, is_bot: true, username: config.username, can_manage_bots: true }))).assertReady();
  });
  it("requests the managed BOT id and verifies its token with getMe", async () => {
    const calls: string[] = [];
    const manager = new TelegramManager(config, transport((method, body) => {
      calls.push(method);
      if (method === "getManagedBotToken") { assert.deepEqual(body, { user_id: 22222 }); return "22222:managed_test_secret"; }
      return bot;
    }));
    assert.deepEqual(await manager.credentials(identity), { token: "22222:managed_test_secret", bot: identity });
    assert.deepEqual(calls, ["getManagedBotToken", "getMe"]);
  });
  it("fails closed when token prefix or live bot identity differs", async () => {
    await assert.rejects(new TelegramManager(config, transport(() => "33333:other_test_secret")).credentials(identity));
    await assert.rejects(new TelegramManager(config, transport(method => method === "getManagedBotToken" ? "22222:managed_test_secret" : { ...bot, id: 33333 })).credentials(identity));
    await assert.rejects(new TelegramManager(config, transport(method => method === "getManagedBotToken" ? "22222:managed_test_secret" : { ...bot, username: "renamed_bot" })).credentials(identity));
  });
  it("never surfaces a token-bearing fetch error or Telegram description", async () => {
    const broken = (async () => { throw new Error(`request failed ${config.token}`); }) as typeof fetch;
    await assert.rejects(new TelegramManager(config, broken).assertReady(), error => !String(error).includes(config.token));
    const denied = (async () => Response.json({ ok: false, description: config.token })) as typeof fetch;
    await assert.rejects(new TelegramManager(config, denied).assertReady(), error => !String(error).includes(config.token));
  });
  it("sends a private request keyboard, no arbitrary correlation parameter", async () => {
    await new TelegramManager(config, transport((method, body) => {
      assert.equal(method, "sendMessage"); assert.equal(body.chat_id, 54321);
      const markup = body.reply_markup as { keyboard: { request_managed_bot: Record<string, unknown> }[][] };
      assert.equal(markup.keyboard[0]![0]!.request_managed_bot.suggested_username, "merrymen_54321_bot");
      assert.ok(!("state" in markup.keyboard[0]![0]!.request_managed_bot));
      return true;
    })).offerCreation(54321);
  });
});
it("authenticates webhook secrets without unequal-length comparison errors", () => {
  assert.equal(validWebhookSecret(config.webhookSecret, config.webhookSecret), true);
  for (const v of [null, "a", "b".repeat(32), "é".repeat(32)]) assert.equal(validWebhookSecret(v, config.webhookSecret), false);
});
it("bounds bodies even without Content-Length", async () => {
  await assert.rejects(boundedJson(new Request("http://localhost", { method: "POST", body: JSON.stringify({ text: "a".repeat(17000) }) })));
  assert.deepEqual(await boundedJson(new Request("http://localhost", { method: "POST", body: "{}" })), {});
});
it("accepts only a real safe numeric bot identity", () => {
  for (const invalid of [{ ...bot, id: "22222" }, { ...bot, is_bot: false }, { ...bot, id: 0 }, { ...bot, id: Number.MAX_SAFE_INTEGER + 1 }, { ...bot, username: "bad/urlbot" }]) assert.equal(managedBotIdentity(invalid), null);
});
