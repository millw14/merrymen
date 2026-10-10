import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { LLM_PROVIDERS, SETTINGS_DEFAULTS } from "@merrymen/core";
import type { SettingsView } from "@/app/api/settings/route";

const OWNER = `0x${"a".repeat(40)}`;
const OTHER = `0x${"b".repeat(40)}`;
const ID = "settings-create-1234";
let testDom: typeof import("./test-dom").testDom;
let json: typeof import("./test-dom").json;
let Settings: typeof import("./screens/Settings").default;
let ui: ReturnType<typeof testDom>;
const originalFetch = globalThis.fetch;
let server: SettingsView;
let writes: Record<string, unknown>[];
let phase: string;
let refreshedOwner: string;
let loseConfirmation: boolean;
let telegramReads: string[];
let telegramReply: () => Response;
let hosted: boolean;
let missingIntent: boolean;
/** What the create endpoint's readiness probe says. */
let createAvailable: boolean;
let fomo: boolean;
const setup = () => ({ id: ID, status: phase, expiresAt: Date.now() + 60_000, botUsername: phase === "confirm" || phase === "connected" ? "merrymen_testbot" : null, botId: phase === "confirm" || phase === "connected" ? "1234567" : null });

before(async () => {
  const boot = new JSDOM("<!doctype html><p></p>", { pretendToBeVisual: true });
  const g = globalThis as Record<string, unknown>;
  g.window = boot.window; g.document = boot.window.document;
  ({ testDom, json } = await import("./test-dom"));
  const settingsPath = fileURLToPath(new URL("./screens/Settings.tsx", import.meta.url));
  const loader = Module as unknown as { _load: (id: string, parent: { filename?: string }, isMain: boolean) => unknown };
  const load = loader._load;
  const intercepted = mock.method(loader, "_load", function (this: typeof loader, id: string, parent: { filename?: string }, isMain: boolean) {
    if (parent?.filename === settingsPath) {
      if (id === "next/link") return ({ children, ...props }: React.ComponentProps<"a">) => React.createElement("a", props, children);
      if (id === "../SetupChecklist") return () => null;
      if (id === "../HolderLink") return { HolderLink: () => null };
      if (id === "../XPosting") return { XPosting: () => null };
      if (id === "../AgentImageField") return { AgentImageField: () => null };
      if (id === "../tier") return { loadTier: async () => null };
    }
    return load.call(this, id, parent, isMain);
  });
  try { Settings = createRequire(import.meta.url)(settingsPath).default; }
  finally { intercepted.mock.restore(); Reflect.deleteProperty(g, "window"); Reflect.deleteProperty(g, "document"); boot.window.close(); }
});

function fixture(): SettingsView {
  const secret = { set: false, hint: null };
  return {
    bundlerApiKey: secret, groqApiKey: secret, anthropicApiKey: secret, llmApiKey: secret,
    rialtoApiKey: secret, telegramBotToken: secret, telegramTranscribeKey: secret,
    virtualsApiKey: secret, bitqueryApiKey: secret, merrymenToken: secret,
    values: { agentName: "Captain", strategy: "steady-basket", basketSymbols: ["AAPL"], telegramEnabled: false, telegramGroupsEnabled: true, telegramAllowlist: [] },
    defaults: structuredClone(SETTINGS_DEFAULTS), knownSymbols: ["AAPL"], officialCoins: [],
    strategies: { builtin: ["steady-basket"], custom: [] }, llmProviders: LLM_PROVIDERS, owner: OWNER,
  };
}
beforeEach(() => {
  ui = testDom();
  ui.dom.window.open = () => null;
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
  server = fixture(); writes = []; phase = "waiting_telegram"; refreshedOwner = OWNER; loseConfirmation = false; telegramReads = [];
  hosted = true;
  missingIntent = false;
  createAvailable = true;
  fomo = false;
  telegramReply = () => json({ botUsername: "merrymen_testbot", linkCode: "link-proof" });
  globalThis.fetch = async (input, init) => {
    const url = String(input), method = init?.method ?? "GET";
    if (url === "/api/auth/session") return json({ hosted, address: OWNER, fomo });
    if (url === "/api/settings" && method === "GET") return json({ ...server, owner: phase === "connected" ? refreshedOwner : server.owner });
    if (url === "/api/settings" && method === "PUT") { writes.push(JSON.parse(String(init?.body))); return json({ ok: true }); }
    if (url === "/api/telegram") return json({});
    if (url.startsWith("/api/telegram?")) { telegramReads.push(url); return telegramReply(); }
    if (url === "/api/models") return json({ code: "missing_key" }, 400);
    if (url.startsWith("/api/telegram/create?") && method === "GET") {
      const params = new URL(url, "https://app.example.test").searchParams;
      assert.equal(params.get("owner"), OWNER);
      if (params.has("intent") && missingIntent) return json({ error: "setup_not_found" }, 404);
      return json({ available: createAvailable, ...(params.has("intent") ? { intent: setup() } : {}) });
    }
    if (url === "/api/telegram/create" && method === "POST") {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.owner, OWNER);
      if (body.action === "begin") { phase = "confirm"; return json({ intent: { ...setup(), status: "waiting_telegram", botUsername: null, botId: null }, telegramUrl: "https://t.me/MerrymenManagerBot?start=nonce" }); }
      if (body.action === "confirm") {
        if (missingIntent) return json({ error: "setup_not_found" }, 404);
        phase = "connected";
        server = { ...server, telegramBotToken: { set: true, hint: "masked" }, values: { ...server.values, telegramEnabled: true } };
        if (loseConfirmation) throw new Error("connection lost after commit");
        return json({ intent: setup() });
      }
      return json({ intent: setup() });
    }
    throw new Error(`Unexpected network boundary: ${method} ${url}`);
  };
});
afterEach(async () => { await ui.close(); mock.timers.reset(); globalThis.fetch = originalFetch; });
const drain = () => act(async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); });
const mount = () => ui.render(React.createElement(Settings, { onFund: () => {}, slug: null }));
async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(ui.dom.window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(input, value); input.dispatchEvent(new ui.dom.window.Event("input", { bubbles: true })); });
}
const token = () => ui.container.querySelector<HTMLInputElement>('#telegram input[type="password"]')!;
const agentName = () => [...ui.container.querySelectorAll(".mm-label")].find(label => label.textContent === "Agent name")!.closest("label")!.querySelector<HTMLInputElement>("input")!;
async function prepare() {
  await mount();
  assert.equal(ui.container.querySelector("#telegram-groups")?.closest("details#telegram"), ui.container.querySelector("#telegram"));
  await type(token(), "123456:obsolete-manual-token");
  await type(agentName(), "Robin Hood");
  const group = ui.container.querySelector<HTMLInputElement>("#telegram-groups + .mm-grid input")!;
  await act(async () => group.click());
  const allowlist = ui.container.querySelector<HTMLInputElement>('input[placeholder="add chat id…"]')!;
  await act(async () => { allowlist.value = "999"; allowlist.dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { bubbles: true, key: "Enter" })); });
  await ui.click("Create Telegram bot");
  assert.equal(token().disabled, true);
  assert.equal([...ui.container.querySelectorAll("button")].find(button => button.textContent === "Save settings")?.disabled, true);
  await ui.click("Save settings");
  assert.equal(writes.length, 0);
  await act(async () => mock.timers.tick(3000)); await drain();
}

describe("managed Telegram creation through Settings", () => {
  it("preserves the manual bot path when self-hosted Settings has no tenant owner", async () => {
    hosted = false; server.owner = null;
    await mount();
    assert.ok(token());
    assert.match(ui.container.textContent ?? "", /Connect an existing bot/);
    assert.equal([...ui.container.querySelectorAll("button")].some(button => button.textContent === "Create Telegram bot"), false);
  });
  it("opens Connect an existing bot, with no dead Create button, when creation is not ready", async () => {
    createAvailable = false;
    await mount(); await drain();
    const drawer = [...ui.container.querySelectorAll<HTMLDetailsElement>("#telegram details")].find(d => d.querySelector("summary")?.textContent === "Connect an existing bot")!;
    assert.ok(drawer, "the manual drawer is rendered");
    assert.equal(drawer.open, true, "the manual path is open when it is the only one");
    assert.equal([...ui.container.querySelectorAll("button")].some(button => button.textContent === "Create Telegram bot"), false);
    assert.equal(token().disabled, false);
  });
  it("keeps Connect an existing bot collapsed while one-click creation is ready", async () => {
    await mount(); await drain();
    const drawer = [...ui.container.querySelectorAll<HTMLDetailsElement>("#telegram details")].find(d => d.querySelector("summary")?.textContent === "Connect an existing bot")!;
    assert.equal(drawer.open, false);
    assert.equal([...ui.container.querySelectorAll("button")].some(button => button.textContent === "Create Telegram bot"), true);
  });
  it("reloads both owner-bound views and preserves unrelated drafts while removing the old token", async () => {
    await prepare();
    await ui.click("Connect this bot"); await drain();
    assert.equal(token().value, "");
    assert.equal(token().disabled, false);
    assert.equal(agentName().value, "Robin Hood");
    assert.deepEqual(telegramReads, [`/api/telegram?owner=${OWNER}`]);
    const link = ui.container.querySelector<HTMLAnchorElement>(`a[href="https://t.me/merrymen_testbot?start=link-proof"]`);
    assert.equal(link?.textContent, "Open my bot →");
    await ui.click("Save settings");
    assert.deepEqual(writes[0], { owner: OWNER, agentName: "Robin Hood", telegramGroupsEnabled: false, telegramAllowlist: [999] });
    assert.equal("telegramBotToken" in writes[0], false);
    assert.equal("telegramEnabled" in writes[0], false);
  });

  it("keeps Save blocked when readback belongs to another owner and retries safely", async () => {
    await prepare(); refreshedOwner = OTHER;
    await ui.click("Connect this bot"); await drain();
    assert.match(ui.container.textContent ?? "", /Refresh Settings before saving/);
    await ui.click("Save settings");
    assert.equal(writes.length, 0);
    assert.equal(token().value, "123456:obsolete-manual-token");
    refreshedOwner = OWNER;
    await ui.click("Refresh Settings"); await drain();
    assert.equal(token().value, "");
    assert.equal(agentName().value, "Robin Hood");
  });

  it("reconciles a connected Cancel response after lost confirmation before permitting a save", async () => {
    await prepare(); loseConfirmation = true;
    await ui.click("Connect this bot"); await drain();
    await ui.click("Save settings"); assert.equal(writes.length, 0);
    await ui.click("Cancel setup"); await drain();
    assert.equal(token().value, "");
    assert.equal(token().disabled, false);
    await ui.click("Save settings");
    assert.equal(writes.length, 1);
    assert.equal("telegramBotToken" in writes[0], false);
    assert.equal(writes[0].agentName, "Robin Hood");
  });

  it("reconciles a missing intent after lost confirmation before discarding an obsolete token draft", async () => {
    await prepare(); loseConfirmation = true;
    await ui.click("Connect this bot"); await drain();
    missingIntent = true; refreshedOwner = OTHER;
    await ui.click("Try again"); await drain();
    await ui.click("Save settings"); assert.equal(writes.length, 0);
    assert.equal(token().value, "123456:obsolete-manual-token");
    assert.equal(localStorage.getItem(`merrymen.telegram.create.v1:${OWNER}`), ID);
    refreshedOwner = OWNER;
    await ui.click("Try again"); await drain();
    assert.equal(localStorage.getItem(`merrymen.telegram.create.v1:${OWNER}`), null);
    assert.equal(token().value, "");
    assert.equal(token().disabled, false);
    assert.equal(agentName().value, "Robin Hood");
    assert.ok(ui.container.querySelector('a[href="https://t.me/merrymen_testbot?start=link-proof"]'));
    await ui.click("Save settings");
    assert.deepEqual(writes[0], { owner: OWNER, agentName: "Robin Hood", telegramGroupsEnabled: false, telegramAllowlist: [999] });
    assert.equal("telegramBotToken" in writes[0], false);
    assert.equal("telegramEnabled" in writes[0], false);
  });

  it("keeps the verified existing bot's launch link after a persisted missing intent is reconciled", async () => {
    localStorage.setItem(`merrymen.telegram.create.v1:${OWNER}`, ID);
    missingIntent = true;
    server = { ...server, telegramBotToken: { set: true, hint: "masked" }, values: { ...server.values, telegramEnabled: true } };
    await mount(); await drain();
    assert.equal(localStorage.getItem(`merrymen.telegram.create.v1:${OWNER}`), null);
    assert.ok(ui.container.querySelector('a[href="https://t.me/merrymen_testbot?start=link-proof"]'));
    assert.equal([...ui.container.querySelectorAll("button")].find(button => button.textContent === "Save settings")?.disabled, false);
    assert.equal([...ui.container.querySelectorAll("button")].some(button => button.textContent === "Create Telegram bot"), false);
  });

  it("lets an unconnected missing candidate start over without discarding manual edits", async () => {
    await prepare();
    missingIntent = true;
    await ui.click("Connect this bot"); await drain();
    await ui.click("Try again"); await drain();
    assert.equal(localStorage.getItem(`merrymen.telegram.create.v1:${OWNER}`), null);
    assert.equal(token().value, "123456:obsolete-manual-token");
    assert.equal(agentName().value, "Robin Hood");
    assert.equal([...ui.container.querySelectorAll("button")].find(button => button.textContent === "Save settings")?.disabled, false);
    assert.ok([...ui.container.querySelectorAll("button")].some(button => button.textContent === "Create Telegram bot"));
  });

  it("preserves current-main Fomo research drafts when a bot is connected", async () => {
    fomo = true;
    await prepare();
    const checkbox = (label: string) => [...ui.container.querySelectorAll(".mm-label")].find(node => node.textContent === label)!.closest("label")!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => { checkbox("answer Fomo questions").click(); checkbox("watch the Fomo trader cohort").click(); });
    await ui.click("Connect this bot"); await drain();
    assert.equal(checkbox("answer Fomo questions").checked, false);
    assert.equal(checkbox("watch the Fomo trader cohort").checked, true);
    await ui.click("Save settings");
    assert.deepEqual(writes[0], { owner: OWNER, agentName: "Robin Hood", fomoDataAccess: false, fomoMonitoringEnabled: true, telegramGroupsEnabled: false, telegramAllowlist: [999] });
  });

  it("releases Save after readback while waiting briefly for the matching bot's launch link", async () => {
    await prepare();
    telegramReply = () => json({ botUsername: "merrymen_testbot", linkCode: null, linkPending: true });
    await ui.click("Connect this bot"); await drain();
    assert.equal([...ui.container.querySelectorAll("button")].find(button => button.textContent === "Save settings")?.disabled, false);
    assert.match(ui.container.textContent ?? "", /Your bot is saved\. Waiting for your agent to pick it up and make its link/);
    assert.equal(ui.container.querySelector('a[href*="?start="]'), null);
    telegramReply = () => json({ botUsername: "merrymen_testbot", linkCode: "new-link-proof" });
    await act(async () => mock.timers.tick(3000)); await drain();
    const link = ui.container.querySelector<HTMLAnchorElement>('a[href="https://t.me/merrymen_testbot?start=new-link-proof"]');
    assert.equal(link?.textContent, "Open my bot →");
    assert.equal(link?.className, "mm-btn primary");
    const reads = telegramReads.length;
    await act(async () => mock.timers.tick(60_000)); await drain();
    assert.equal(telegramReads.length, reads);
  });

  it("stops the launch-link wait after sixty seconds without claiming the bot is listening", async () => {
    await prepare();
    telegramReply = () => json({ botUsername: "merrymen_testbot", linkCode: null, linkPending: true });
    await ui.click("Connect this bot"); await drain();
    await act(async () => mock.timers.tick(60_000)); await drain();
    assert.match(ui.container.textContent ?? "", /Its link appears here once your agent is running and has picked it up\. Refresh Settings to check again\./);
    assert.doesNotMatch(ui.container.textContent ?? "", /bot is listening/i);
    assert.equal(ui.container.querySelector('a[href*="?start="]'), null);
    const reads = telegramReads.length;
    await act(async () => mock.timers.tick(60_000)); await drain();
    assert.equal(telegramReads.length, reads);
  });

  it("does not publish a launch link for a different bot returned during the wait", async () => {
    await prepare();
    telegramReply = () => json({ botUsername: "merrymen_testbot", linkCode: null });
    await ui.click("Connect this bot"); await drain();
    telegramReply = () => json({ botUsername: "someone_else_bot", linkCode: "wrong-bot-code" });
    await act(async () => mock.timers.tick(3000)); await drain();
    assert.match(ui.container.textContent ?? "", /Telegram connection changed/);
    assert.equal(ui.container.querySelector('a[href*="someone_else_bot"]'), null);
    assert.doesNotMatch(ui.container.textContent ?? "", /wrong-bot-code/);
    const reads = telegramReads.length;
    await act(async () => mock.timers.tick(30_000)); await drain();
    assert.equal(telegramReads.length, reads);
  });

  it("stops for a bot claimed elsewhere without exposing its code", async () => {
    await prepare();
    telegramReply = () => json({ botUsername: "merrymen_testbot", linkCode: null });
    await ui.click("Connect this bot"); await drain();
    telegramReply = () => json({ botUsername: "merrymen_testbot", linkCode: "elsewhere-code", botElsewhere: true });
    await act(async () => mock.timers.tick(3000)); await drain();
    assert.equal(ui.container.querySelector('a[href*="?start="]'), null);
    assert.doesNotMatch(ui.container.textContent ?? "", /elsewhere-code/);
    const reads = telegramReads.length;
    await act(async () => mock.timers.tick(30_000)); await drain();
    assert.equal(telegramReads.length, reads);
  });

  it("cleans up the launch-link timer when Settings is closed", async () => {
    await prepare();
    telegramReply = () => json({ botUsername: "merrymen_testbot", linkCode: null });
    await ui.click("Connect this bot"); await drain();
    await ui.render(null);
    const reads = telegramReads.length;
    await act(async () => mock.timers.tick(60_000)); await drain();
    assert.equal(telegramReads.length, reads);
  });
});
