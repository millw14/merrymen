import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import React, { act } from "react";
import { TelegramCreateBot } from "./TelegramCreateBot";
import { deferred, json, testDom } from "./test-dom";

const OWNER = `0x${"1".repeat(40)}`;
const OTHER = `0x${"2".repeat(40)}`;
const ID = "setup-1234567890";
const storageKey = (owner: string) => `merrymen.telegram.create.v1:${owner}`;
const originalFetch = globalThis.fetch;
type Call = { url: string; init?: RequestInit };
let ui: ReturnType<typeof testDom>;
let calls: Call[];
let respond: (call: Call) => Promise<Response>;
let refreshed: { owner: string; signal: AbortSignal }[];
let active: boolean[];
let refresh: () => Promise<void>;
let reconcile: () => Promise<void>;
let reconciled: { owner: string; signal: AbortSignal }[];
let hasBot: boolean;
let opened: number;
let popup: Window | null;
let closed: number;
let navigations: string[];
const intent = (status = "waiting_telegram", extra: Record<string, unknown> = {}) => ({ id: ID, status, expiresAt: Date.now() + 60_000, botUsername: status === "confirm" || status === "connected" ? "merrymen_testbot" : null, botId: status === "confirm" || status === "connected" ? "1234567" : null, ...extra });
const post = (call: Call) => JSON.parse(String(call.init?.body)) as Record<string, unknown>;
const posts = () => calls.filter(call => call.init?.method === "POST");
const drain = () => act(async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); });
async function advance(ms: number) { await act(async () => mock.timers.tick(ms)); await drain(); }
const render = (owner: string | null = OWNER) => ui.render(React.createElement(TelegramCreateBot, { owner, hasBot, onActiveChange: value => active.push(value), onConnected: async (scope, signal) => { refreshed.push({ owner: scope, signal }); await refresh(); }, onIntentMissing: async (scope, signal) => { reconciled.push({ owner: scope, signal }); await reconcile(); } }));

beforeEach(() => {
  ui = testDom();
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
  calls = [];
  refreshed = [];
  reconciled = [];
  active = [];
  hasBot = false;
  opened = closed = 0;
  navigations = [];
  popup = null;
  ui.dom.window.open = () => { opened++; return popup; };
  refresh = async () => {};
  reconcile = async () => {};
  respond = async call => {
    if (call.init?.method === "POST") {
      if (post(call).action === "begin") return json({ intent: intent(), telegramUrl: "https://t.me/MerrymenManagerBot?start=server_nonce" });
      if (post(call).action === "confirm") return json({ intent: intent("connected") });
      return json({ intent: intent("cancelled") });
    }
    return json({ available: true });
  };
  globalThis.fetch = async (input, init) => { const call = { url: String(input), init }; calls.push(call); return respond(call); };
});
afterEach(async () => { await ui.close(); mock.timers.reset(); globalThis.fetch = originalFetch; });

describe("Telegram bot creation through the actual client component", () => {
  it("reads availability for the exact owner and opens a safe native link after begin", async () => {
    await render();
    assert.equal(new URL(calls[0].url, "https://app.example.test").searchParams.get("owner"), OWNER);
    await ui.click("Create Telegram bot");
    assert.deepEqual(post(posts()[0]), { action: "begin", owner: OWNER });
    const link = ui.container.querySelector<HTMLAnchorElement>('a[href^="https://t.me/"]');
    assert.equal(link?.href, "https://t.me/MerrymenManagerBot?start=server_nonce");
    assert.equal(link?.target, "_blank");
    assert.equal(link?.rel, "noopener noreferrer");
    assert.equal(localStorage.getItem(storageKey(OWNER)), ID, "only the intent ID is persisted, never the start link or credential");
    assert.equal(refreshed.length, 0);
    assert.doesNotMatch(ui.container.textContent ?? "", /Bot connected|listening/i);
    assert.equal(active.at(-1), true);
    assert.equal(opened, 1, "a blocked native popup leaves the usable Open Telegram link");
  });

  it("pre-opens Telegram during the click, then navigates only after a validated response", async () => {
    popup = { opener: {}, location: { replace: (url: string) => navigations.push(url) }, close: () => { closed++; } } as unknown as Window;
    await render();
    const response = deferred<Response>();
    respond = async () => response.promise;
    await ui.click("Create Telegram bot");
    assert.equal(opened, 1);
    assert.equal(popup.opener, null);
    assert.equal(navigations.length, 0);
    response.resolve(json({ intent: intent(), telegramUrl: "https://t.me/MerrymenManagerBot?start=server_nonce" }));
    await drain();
    assert.deepEqual(navigations, ["https://t.me/MerrymenManagerBot?start=server_nonce"]);
    assert.equal(closed, 0);
  });

  it("accepts the server's valid digit/underscore-leading bot usernames and manager links", async () => {
    await render();
    for (const username of ["3_ManagerBot", "_ManagerBot"]) {
      respond = async call => call.init?.method === "POST" && post(call).action === "begin" ? json({ intent: intent(), telegramUrl: `https://t.me/${username}?start=nonce` }) : json({ intent: intent("cancelled") });
      await ui.click("Create Telegram bot");
      assert.equal(ui.container.querySelector<HTMLAnchorElement>("a")?.href, `https://t.me/${username}?start=nonce`);
      await ui.click("Cancel setup");
    }
    for (const botUsername of ["3_Testbot", "_Testbot"]) {
      localStorage.setItem(storageKey(OWNER), ID);
      respond = async () => json({ available: true, intent: intent("confirm", { botUsername }) });
      await ui.remount(React.createElement(TelegramCreateBot, { owner: OWNER, hasBot: false, onConnected: async () => {}, onIntentMissing: async () => {} }));
      assert.match(ui.container.textContent ?? "", new RegExp(`@${botUsername}`));
      assert.ok([...ui.container.querySelectorAll("button")].some(button => button.textContent === "Connect this bot"));
    }
  });

  it("waits for Telegram acceptance and explicitly confirms the displayed bot identity", async () => {
    await render();
    await ui.click("Create Telegram bot");
    respond = async call => call.init?.method === "POST" ? json({ intent: intent("connected") }) : json({ available: true, intent: intent("confirm") });
    await advance(3000);
    assert.match(ui.container.textContent ?? "", /@merrymen_testbot/);
    assert.equal(posts().length, 1, "Telegram acceptance alone never saves the bot");
    await ui.click("Connect this bot");
    await drain();
    assert.deepEqual(post(posts()[1]), { action: "confirm", owner: OWNER, intentId: ID, botId: "1234567" });
    assert.equal(refreshed.length, 1);
    assert.equal(refreshed[0].owner, OWNER);
    assert.match(ui.container.textContent ?? "", /Open your bot below to finish linking Telegram/);
    assert.doesNotMatch(ui.container.textContent ?? "", /listening|private reports/i);
    assert.equal(localStorage.getItem(storageKey(OWNER)), null);
    assert.equal(active.at(-1), false);
  });

  it("restores only the stored intent ID, scoped to the signed-in owner", async () => {
    localStorage.setItem(storageKey(OWNER), ID);
    respond = async () => json({ available: true, intent: intent("confirm") });
    await render();
    const params = new URL(calls[0].url, "https://app.example.test").searchParams;
    assert.equal(params.get("owner"), OWNER);
    assert.equal(params.get("intent"), ID);
    assert.match(ui.container.textContent ?? "", /@merrymen_testbot/);
    assert.equal(posts().length, 0);
  });

  it("forgets a missing persisted intent after reconciliation and rechecks availability without it", async () => {
    localStorage.setItem(storageKey(OWNER), ID);
    respond = async call => new URL(call.url, "https://app.example.test").searchParams.has("intent") ? json({ error: "not found" }, 404) : json({ available: true });
    await render(); await drain();
    assert.equal(reconciled.length, 1);
    assert.equal(reconciled[0].owner, OWNER);
    assert.deepEqual(calls.map(call => new URL(call.url, "https://app.example.test").searchParams.get("intent")), [ID, null]);
    assert.equal(localStorage.getItem(storageKey(OWNER)), null);
    assert.equal(active.at(-1), false);
    assert.ok([...ui.container.querySelectorAll("button")].some(button => button.textContent === "Create Telegram bot"));
  });

  it("clears malformed persisted IDs and checks availability without sending them", async () => {
    for (const saved of ["setup-short", "a".repeat(65), "invalid?stored-value"]) {
      localStorage.setItem(storageKey(OWNER), saved);
      await ui.remount(React.createElement(TelegramCreateBot, { owner: OWNER, hasBot: false, onConnected: async () => {}, onIntentMissing: async () => { assert.fail("malformed IDs must not reach reconciliation"); } }));
      assert.equal(new URL(calls.at(-1)!.url, "https://app.example.test").searchParams.has("intent"), false);
      assert.equal(localStorage.getItem(storageKey(OWNER)), null);
      assert.ok([...ui.container.querySelectorAll("button")].some(button => button.textContent === "Create Telegram bot"));
    }
  });

  it("retains the missing intent and Save hold until Settings reconciliation succeeds", async () => {
    localStorage.setItem(storageKey(OWNER), ID);
    respond = async call => new URL(call.url, "https://app.example.test").searchParams.has("intent") ? json({ error: "not found" }, 404) : json({ available: true });
    reconcile = async () => { throw new Error("Settings unavailable"); };
    await render(); await drain();
    assert.equal(active.at(-1), true);
    assert.equal(localStorage.getItem(storageKey(OWNER)), ID);
    assert.equal(calls.length, 1, "availability cannot bypass an unverified Settings state");
    assert.equal([...ui.container.querySelectorAll("button")].some(button => button.textContent === "Create Telegram bot"), false);
    reconcile = async () => {};
    await ui.click("Try again"); await drain();
    assert.equal(reconciled.length, 2);
    assert.equal(localStorage.getItem(storageKey(OWNER)), null);
    assert.equal(active.at(-1), false);
    assert.deepEqual(calls.map(call => new URL(call.url, "https://app.example.test").searchParams.get("intent")), [ID, ID, null]);
  });

  it("holds Save while restoring an intent and handles a missing row during pending polling", async () => {
    localStorage.setItem(storageKey(OWNER), ID);
    const restored = deferred<Response>();
    respond = async () => restored.promise;
    await render();
    assert.equal(active.at(-1), true, "a persisted request is unverified until its first owner-bound read completes");
    restored.resolve(json({ available: true, intent: intent() })); await drain();
    const readback = deferred<void>();
    reconcile = () => readback.promise;
    respond = async call => new URL(call.url, "https://app.example.test").searchParams.has("intent") ? json({ error: "not found" }, 404) : json({ available: true });
    await advance(3000);
    assert.equal(reconciled.length, 1);
    assert.equal(localStorage.getItem(storageKey(OWNER)), ID);
    assert.equal(active.at(-1), true);
    readback.resolve(); await drain();
    assert.equal(localStorage.getItem(storageKey(OWNER)), null);
    assert.equal(active.at(-1), false);
    const count = calls.length;
    await advance(30_000);
    assert.equal(calls.length, count, "the missing request's old poll loop is stopped");
  });

  it("offers reconciliation retry when local expiry interrupts a missing-row readback", async () => {
    localStorage.setItem(storageKey(OWNER), ID);
    respond = async () => json({ available: true, intent: intent("waiting_bot", { expiresAt: Date.now() + 6000 }) });
    await render();
    const readback = deferred<void>();
    reconcile = () => readback.promise;
    respond = async call => new URL(call.url, "https://app.example.test").searchParams.has("intent") ? json({ error: "not found" }, 404) : json({ available: true });
    await advance(3000);
    assert.equal(reconciled.length, 1);
    await advance(3000);
    assert.equal(reconciled[0].signal.aborted, true);
    assert.equal(active.at(-1), true);
    assert.ok([...ui.container.querySelectorAll("button")].some(button => button.textContent === "Check setup"));
    assert.equal([...ui.container.querySelectorAll("button")].some(button => button.textContent === "Create Telegram bot"), false);
    reconcile = async () => {};
    await ui.click("Check setup"); await drain();
    assert.equal(active.at(-1), false);
    assert.equal(localStorage.getItem(storageKey(OWNER)), null);
    readback.resolve(); await drain();
    assert.equal(active.at(-1), false, "the expired readback cannot overwrite the reconciled state");
  });

  it("aborts old-owner requests and ignores a late response after the wallet changes", async () => {
    await render();
    const late = deferred<Response>();
    respond = async call => call.init?.method === "POST" ? late.promise : json({ available: true });
    popup = { opener: {}, location: { replace: (url: string) => navigations.push(url) }, close: () => { closed++; } } as unknown as Window;
    await ui.click("Create Telegram bot");
    const oldSignal = posts()[0].init?.signal;
    await render(OTHER);
    assert.equal(oldSignal?.aborted, true);
    late.resolve(json({ intent: intent(), telegramUrl: "https://t.me/MerrymenManagerBot?start=old_owner" }));
    await drain();
    assert.equal(localStorage.getItem(storageKey(OWNER)), null);
    assert.equal(ui.container.querySelector('a[href*="old_owner"]'), null);
    assert.equal(navigations.length, 0);
    assert.ok(closed >= 1);
    await ui.click("Create Telegram bot");
    assert.equal(post(posts()[1]).owner, OTHER);
  });

  it("clears the previous owner's persisted intent when the owner changes", async () => {
    localStorage.setItem(storageKey(OWNER), ID);
    respond = async call => new URL(call.url, "https://app.example.test").searchParams.get("owner") === OWNER ? json({ available: true, intent: intent() }) : json({ available: true });
    await render();
    await render(OTHER);
    assert.equal(localStorage.getItem(storageKey(OWNER)), null);
    assert.equal(ui.container.querySelector("strong"), null);
    assert.equal(active.at(-1), false);
  });

  it("expires an unanswered setup and stops polling rather than waiting indefinitely", async () => {
    await render();
    await ui.click("Create Telegram bot");
    respond = async () => json({ available: true, intent: intent("waiting_bot", { expiresAt: 1_800_000_060_000 }) });
    await advance(60_000);
    assert.match(ui.container.textContent ?? "", /setup expired/);
    const count = calls.length;
    await advance(120_000);
    assert.equal(calls.length, count);
    assert.equal(active.at(-1), false);
  });

  it("bounds even an excessively long server expiry to fifteen minutes", async () => {
    respond = async call => call.init?.method === "POST" ? json({ intent: intent("waiting_telegram", { expiresAt: Date.now() + 86_400_000 }), telegramUrl: "https://t.me/MerrymenManagerBot?start=server_nonce" }) : json({ available: true });
    await render();
    await ui.click("Create Telegram bot");
    await advance(15 * 60_000);
    assert.match(ui.container.textContent ?? "", /setup expired/);
    const count = calls.length;
    await advance(30_000);
    assert.equal(calls.length, count);
  });

  it("rejects non-Telegram or malformed start links without showing or storing them", async () => {
    await render();
    for (const telegramUrl of ["https://evil.test/manager?start=x", "javascript:alert(1)", "https://t.me.evil.test/ManagerBot?start=x", "https://t.me/ManagerBot?start=x&redirect=evil", "https://t.me/ManagerBot?start=x#token", "https://user:password@t.me/ManagerBot?start=x"]) {
      respond = async () => json({ intent: intent(), telegramUrl });
      await ui.click("Create Telegram bot");
      assert.equal(ui.container.querySelector("a"), null);
      assert.equal(localStorage.getItem(storageKey(OWNER)), null);
      assert.match(ui.container.textContent ?? "", /Couldn't check Telegram setup/);
    }
  });

  it("shows unavailable configuration and authentication failures separately with no token inputs", async () => {
    respond = async () => json({ available: false });
    await render();
    assert.match(ui.container.textContent ?? "", /Bot creation isn't available right now/);
    assert.equal(ui.container.querySelector("input"), null);
    assert.equal(ui.container.querySelector("button"), null);
    respond = async () => json({ error: "sensitive diagnostic should not render" }, 403);
    await ui.remount(React.createElement(TelegramCreateBot, { owner: OWNER, hasBot: false, onConnected: async () => {}, onIntentMissing: async () => {} }));
    assert.match(ui.container.textContent ?? "", /signed-in account changed/);
    assert.doesNotMatch(ui.container.textContent ?? "", /sensitive diagnostic/);
  });

  it("retains the safe save hold after connection when its required readback fails", async () => {
    localStorage.setItem(storageKey(OWNER), ID);
    respond = async () => json({ available: true, intent: intent("connected") });
    refresh = async () => { throw new Error("readback failed"); };
    await render();
    await drain();
    assert.equal(active.at(-1), true);
    assert.equal(localStorage.getItem(storageKey(OWNER)), ID);
    assert.match(ui.container.textContent ?? "", /Refresh Settings before saving/);
    refresh = async () => {};
    await ui.click("Refresh Settings");
    await drain();
    assert.equal(refreshed.length, 2);
    assert.equal(active.at(-1), false);
    assert.equal(localStorage.getItem(storageKey(OWNER)), null);
  });

  it("cancels the exact setup, clears its ID and stops old polling", async () => {
    await render();
    await ui.click("Create Telegram bot");
    await ui.click("Cancel setup");
    assert.deepEqual(post(posts()[1]), { action: "cancel", owner: OWNER, intentId: ID });
    assert.equal(localStorage.getItem(storageKey(OWNER)), null);
    const count = calls.length;
    await advance(30_000);
    assert.equal(calls.length, count);
    assert.equal(active.at(-1), false);
  });

  it("checks a committed connection after its confirmation response was lost", async () => {
    localStorage.setItem(storageKey(OWNER), ID);
    respond = async call => {
      if (call.init?.method !== "POST") return json({ available: true, intent: intent("confirm") });
      if (post(call).action === "confirm") throw new Error("connection lost after commit");
      return json({ intent: intent("connected") });
    };
    const readback = deferred<void>();
    refresh = () => readback.promise;
    await render();
    await ui.click("Connect this bot");
    assert.equal(active.at(-1), true);
    await ui.click("Cancel setup");
    await drain();
    assert.equal(refreshed.length, 1);
    assert.equal(active.at(-1), true, "a connected cancellation result must complete readback before releasing Save");
    assert.equal(localStorage.getItem(storageKey(OWNER)), ID);
    readback.resolve();
    await drain();
    assert.equal(active.at(-1), false);
    assert.equal(localStorage.getItem(storageKey(OWNER)), null);
  });

  it("does not release an uncertain confirmation when the local deadline expires", async () => {
    localStorage.setItem(storageKey(OWNER), ID);
    respond = async call => call.init?.method === "POST" ? Promise.reject(new Error("lost confirmation")) : json({ available: true, intent: intent("confirm") });
    await render();
    await ui.click("Connect this bot");
    await advance(60_000);
    assert.equal(active.at(-1), true);
    assert.match(ui.container.textContent ?? "", /connection hasn't been checked/);
    assert.equal([...ui.container.querySelectorAll("button")].some(button => button.textContent === "Create Telegram bot"), false);
    respond = async () => json({ intent: intent("cancelled") });
    await ui.click("Cancel setup");
    assert.equal(active.at(-1), false);
  });

  it("aborts all work on unmount and neither polls nor offers creation for an existing bot", async () => {
    await render();
    await ui.click("Create Telegram bot");
    const count = calls.length;
    await ui.render(null);
    await advance(30_000);
    assert.equal(calls.length, count);
    assert.equal(active.at(-1), false);
    hasBot = true;
    await render();
    assert.equal(posts().length, 1, "existing bot remains managed by the existing Settings controls");
    assert.equal(ui.container.querySelector('button.mm-btn.primary'), null);
  });
});
