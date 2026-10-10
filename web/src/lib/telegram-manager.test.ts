import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { boundedJson, managedBotIdentity, managerNotices, managerWebhookUrl, parsePress, pressData, TelegramManager, validWebhookSecret } from "./telegram-manager";

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
  it("offers the native keyboard and the iPhone/iPad link separately with the same intent-specific username", async () => {
    const calls: { method: string; body: Record<string, unknown> }[] = [];
    const suggested = "merrymen_a123456789abcdef_bot";
    await new TelegramManager(config, transport((method, body) => { calls.push({ method, body }); return true; })).offerCreation(54321, suggested);
    assert.equal(calls.length, 2, "reply and inline keyboards need separate messages");
    assert.ok(calls.every(call => call.method === "sendMessage" && call.body.chat_id === 54321));
    assert.deepEqual(calls[0]!.body.reply_markup, { keyboard: [[{ text: "Create my Telegram bot", request_managed_bot: {
      request_id: 1, suggested_name: "My Merrymen", suggested_username: suggested,
    } }]], resize_keyboard: true, one_time_keyboard: true });
    assert.deepEqual(calls[1]!.body.reply_markup, { inline_keyboard: [[{ text: "Create my bot on iPhone or iPad",
      url: `https://t.me/newbot/merrymen_manager_bot/${suggested}?name=My%20Merrymen`,
    }]] });
    assert.match(String(calls[1]!.body.text), /iPhone or iPad/);
    assert.match(String(calls[1]!.body.text), /Keep the suggested username/);
  });
  it("rejects an invalid suggestion before sending either offer", async () => {
    let calls = 0;
    const manager = new TelegramManager(config, transport(() => { calls++; return true; }));
    for (const name of ["", "merrymen_54321_bot", "merrymen_a123456789abcdef_bot?tenant=owner"]) {
      await assert.rejects(manager.offerCreation(54321, name));
    }
    assert.equal(calls, 0);
  });
  it("reads the webhook URL and its update types, and calls a webhook ours, stale, unset or elsewhere", async () => {
    const ours = "https://app.merrymen.test/api/telegram/manager/webhook";
    const elsewhere = "https://staging.merrymen.test/api/telegram/manager/webhook";
    const all = ["message", "managed_bot", "callback_query"];
    for (const [url, allowed, state] of [
      ["", undefined, "unset"],
      [ours, all, "ours"],
      [ours, [...all, "edited_message"].reverse(), "ours"],
      [ours, ["message", "managed_bot"], "stale"],
      [ours, undefined, "stale"],
      [elsewhere, all, "elsewhere"],
      [elsewhere, ["message"], "elsewhere"],
    ] as const) {
      const info = { url, pending_update_count: 0, ...(allowed ? { allowed_updates: allowed } : {}) };
      assert.equal(await new TelegramManager(config, transport(method => { assert.equal(method, "getWebhookInfo"); return info; })).webhook(ours), state, `${url} ${allowed}`);
    }
    await assert.rejects(new TelegramManager(config, transport(() => ({}))).webhook(ours));
  });
  it("sets the webhook with this deployment's secret and the update types the webhook reads", async () => {
    const calls: { method: string; body: Record<string, unknown> }[] = [];
    await new TelegramManager(config, transport((method, body) => { calls.push({ method, body }); return true; })).setWebhook("https://app.merrymen.test/api/telegram/manager/webhook");
    assert.deepEqual(calls, [{ method: "setWebhook", body: { url: "https://app.merrymen.test/api/telegram/manager/webhook", secret_token: config.webhookSecret, allowed_updates: ["message", "managed_bot", "callback_query"] } }]);
    await assert.rejects(new TelegramManager(config, transport(() => false)).setWebhook("https://app.merrymen.test/api/telegram/manager/webhook"));
  });
  it("sends, edits and answers with exactly the notice's text and buttons", async () => {
    const calls: { method: string; body: Record<string, unknown> }[] = [];
    const manager = new TelegramManager(config, transport((method, body) => { calls.push({ method, body }); return true; }));
    const ready = managerNotices.ready(identity, "4f1c2b8e-1111-4222-8333-944455556666");
    await manager.send(54321, ready);
    await manager.edit(54321, 77, managerNotices.expired(null));
    await manager.answer("cbq-1");
    await manager.answer("cbq-2", "This setup expired.");
    assert.deepEqual(calls, [
      { method: "sendMessage", body: { chat_id: 54321, text: ready.text, reply_markup: { inline_keyboard: ready.buttons } } },
      { method: "editMessageText", body: { chat_id: 54321, message_id: 77, text: "This setup expired. Start again from Merrymen." } },
      { method: "answerCallbackQuery", body: { callback_query_id: "cbq-1" } },
      { method: "answerCallbackQuery", body: { callback_query_id: "cbq-2", text: "This setup expired." } },
    ]);
  });
  it("bounds each probe call by the caller's timeout", async () => {
    let signal: AbortSignal | undefined;
    const hang = (async (_input, init) => { signal = init?.signal ?? undefined; return await new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))); }) as typeof fetch;
    const started = Date.now();
    // AbortSignal.timeout's timer does not hold the event loop open; this one
    // does, so the test waits for the abort rather than ending with it pending.
    const keepAlive = setTimeout(() => {}, 5_000);
    try {
      await assert.rejects(new TelegramManager(config, hang).assertReady(30));
    } finally { clearTimeout(keepAlive); }
    assert.ok(signal?.aborted);
    assert.ok(Date.now() - started < 2_000);
  });
});
it("builds the manager webhook only under an https public origin", () => {
  assert.equal(managerWebhookUrl("https://app.merrymen.dev"), "https://app.merrymen.dev/api/telegram/manager/webhook");
  assert.equal(managerWebhookUrl("https://app.merrymen.dev/"), "https://app.merrymen.dev/api/telegram/manager/webhook");
  for (const origin of [undefined, null, "", "http://app.merrymen.dev", "https://app.merrymen.dev/base", "https://user:pw@app.merrymen.dev", "https://app.merrymen.dev?x=1", "not a url"]) {
    assert.equal(managerWebhookUrl(origin), null, String(origin));
  }
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

describe("what the manager says, and what its buttons carry", () => {
  const intentId = "4f1c2b8e-1111-4222-8333-944455556666";
  const home = "https://app.merrymen.test";
  it("offers the made bot with Connect and Not this bot, naming only the intent and the bot, in at most 64 bytes", () => {
    const ready = managerNotices.ready(identity, intentId);
    assert.equal(ready.text, "✅ @my_merrymen_bot is ready.\nConnect it to your Merrymen agent?");
    assert.deepEqual(ready.buttons, [[{ text: "Connect @my_merrymen_bot", callback_data: `mc:${intentId}:22222` }], [{ text: "Not this bot", callback_data: `mx:${intentId}:22222` }]]);
    // The longest a bot id can be still fits Telegram's 64-byte limit.
    const longest = pressData("connect", intentId, "9".repeat(20));
    assert.ok(Buffer.byteLength(longest) <= 64, `${Buffer.byteLength(longest)} bytes`);
    assert.deepEqual(parsePress(`mc:${intentId}:22222`), { action: "connect", intentId, botId: "22222" });
    assert.deepEqual(parsePress(`mx:${intentId}:22222`), { action: "cancel", intentId, botId: "22222" });
  });
  it("reads no other button: anything malformed, padded or longer is nobody's press", () => {
    for (const data of [undefined, null, 7, "", `mc:${intentId}`, `mc:${intentId}:22222:1`, `mz:${intentId}:22222`, `mc:${intentId}:0`, `mc:${intentId}:-5`,
      `mc:short:22222`, `mc:${intentId}x:22222`, ` mc:${intentId}:22222`, `mc:${intentId}:22222\n`, `mc:${"a".repeat(37)}:22222`, `mc:${intentId}:${"1".repeat(21)}`]) {
      assert.equal(parsePress(data), null, String(data));
    }
    assert.throws(() => pressData("connect", "not/an/id-0123456789", "22222"));
  });
  it("says what happened in plain words, with the way back to Merrymen, and nothing else", () => {
    const back = [[{ text: "Back to Merrymen", url: home }]];
    assert.deepEqual(managerNotices.unmatched("my_merrymen_bot", home), {
      text: "Your bot @my_merrymen_bot was created, but no Merrymen setup is waiting for it, so it wasn't connected. To connect a new bot, start again from Merrymen and create it within 30 minutes.",
      buttons: back,
    });
    // Saved is not running: a held agent (outside the rollout, an expired
    // session key, a recovery or accounting hold) never starts the bot, so the
    // message says what the bot waits for, never that it will soon answer.
    assert.deepEqual(managerNotices.connected("my_merrymen_bot", home), {
      text: "✅ Connected @my_merrymen_bot to your Merrymen agent.\n@my_merrymen_bot replies once your agent is running. Merrymen then shows \"Open my bot\" to link your chat with it. If your agent is paused for recovery, that waits until it resumes.",
      buttons: back,
    });
    assert.doesNotMatch(managerNotices.connected("my_merrymen_bot", home).text, /will show|has started|is live|is listening/);
    assert.deepEqual(managerNotices.expired(home), { text: "This setup expired. Start again from Merrymen.", buttons: back });
    assert.match(managerNotices.cancelled("my_merrymen_bot", home).text, /^Cancelled\. Start again from Merrymen when you're ready\.\n.*@my_merrymen_bot.*@BotFather/);
    assert.match(managerNotices.alreadyHasBot("my_merrymen_bot", home).text, /already has a Telegram bot.*replace the bot in Settings/);
    assert.match(managerNotices.claimed("my_merrymen_bot", home).text, /already connected to another Merrymen agent/);
    const failed = managerNotices.failed(identity, intentId);
    assert.equal(failed.text, "Couldn't connect right now. Try again, or connect from Merrymen.");
    assert.deepEqual(failed.buttons, managerNotices.ready(identity, intentId).buttons, "the buttons stay, to try again");
    assert.deepEqual(managerNotices.expired(null).buttons, [], "no public origin: no button, rather than a broken one");
  });
});
