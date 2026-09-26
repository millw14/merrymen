/**
 * THE CHAT, RUN: the real Agent screen, drawn from the real App-level
 * controller, in a DOM, against a scripted network.
 *
 * W2.7 — it should feel like a messaging app: the owner's line and a typing
 * bubble at once, the reply streaming in with nothing of a command marker ever
 * on screen, one round trip per message, failures in the agent's voice with a
 * Retry, chips that never suggest a size the wall would refuse, and the cursor
 * put back only where there is a mouse.
 *
 * W2.8 — an order's answer reaches the owner wherever they are: followed by
 * the App, not the screen; resumed after a reload; rendered from the worker's
 * receipt; the agent's own fills merged into the thread; an unread dot; the
 * book read again when an outcome lands; and a snipe followed like any order.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import React, { act, createElement } from "react";
import { autonomyOf, LLM_PROVIDERS, SETTINGS_DEFAULTS, STOCK_TOKENS } from "@merrymen/core";
import type { SettingsView } from "@/app/api/settings/route";
import { agentReplyResponse, type AgentChatBody } from "@/lib/agent-chat";
import { sseEvent } from "@/lib/chat-stream";
import type { LiveMine, Thesis } from "./live";
import { Agent } from "./screens/Agent";
import SettingsPage from "./screens/Settings";
import { ownerOfChatKey, useChatController, type ChatController } from "./chat-controller";
import { chatKeyFor } from "./chat-store";
import { MAX_MESSAGES, tradeKeyOf } from "./chat-thread";
import { deferred, json, testDom } from "./test-dom";

const KEY = "merrymen.chat.self";
const ORDER_ID = "0123456789abcdef0123456789abcdef";
const noop = () => {};

let ui: ReturnType<typeof testDom>;
const originalFetch = globalThis.fetch;
const originalRO = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
let routes: Record<string, Handler>;
let calls: { method: string; url: string; body: Record<string, unknown> | null; deadline: boolean }[];
let chat: ChatController;
/** How far this browser's clock runs ahead of the true one (the server's, the ledger's). */
let clockAhead = 0;

beforeEach(() => {
  ui = testDom();
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  // A Next <Link> on the screen schedules its prefetch through `self`.
  (globalThis as { self?: unknown }).self = ui.dom.window;
  localStorage.clear();
  calls = [];
  clockAhead = 0;
  routes = {
    "GET /api/settings": () => json({ values: { liveTradingEnabled: true }, defaults: { telegramMaxActionUsdg: 25 } }),
    "GET /api/orders/ceiling": () => json({ ceilingUsdg: 25 }),
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null, deadline: !!init?.signal });
    const handler = routes[`${method} ${url.split("?")[0]}`];
    return handler ? handler(url, init) : json({ error: "not scripted" }, 404);
  }) as typeof fetch;
});
afterEach(async () => {
  await ui.close();
  globalThis.fetch = originalFetch;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = originalRO;
  Reflect.deleteProperty(globalThis, "self");
});

const MINE: LiveMine = {
  name: "Shogun",
  slug: "0123456789abcdef",
  handle: null,
  owner: "you",
  equity: 100,
  chg24: null,
  mode: "trencher",
  thesis: null,
  moves: [],
  glance: { id: "custom", label: "", cashUsd: 83 },
  autonomy: autonomyOf({ mode: null, liveBlocker: null }),
  positions: [],
};

function Harness(p: {
  chatKey?: string | null;
  open?: boolean;
  show?: boolean;
  /** Two Agent screens on one controller — desktop's /agent body and its dock, both open. */
  twice?: boolean;
  moves?: Thesis[] | null;
  perTrade?: number | null;
  onOutcome?: () => void;
  /** The Settings screen beside the chat, wired to it as App.tsx wires it — desktop's dock stays open over it. */
  settingsScreen?: boolean;
}) {
  const c = useChatController({
    chatKey: p.chatKey === undefined ? KEY : p.chatKey,
    open: p.open ?? true,
    moves: p.moves ?? null,
    onOutcome: p.onOutcome,
    deps: { sleep: () => new Promise((r) => setTimeout(r, 1)), now: () => Date.now() + clockAhead },
  });
  chat = c;
  const screen = (key: string) =>
    createElement(Agent, {
      key,
      mine: MINE,
      tokens: [],
      perTrade: p.perTrade === undefined ? 10 : p.perTrade,
      perDay: 50,
      stopped: false,
      chat: c,
      onToken: noop,
      onDeposit: noop,
      onWithdraw: noop,
      onLimits: noop,
      onResign: noop,
      onSettings: noop,
      liveBlocker: null,
    });
  return createElement(
    "div",
    null,
    createElement("i", { "data-unread": String(c.unread) }),
    p.show === false ? null : screen("body"),
    p.twice ? screen("dock") : null,
    p.settingsScreen ? createElement(SettingsPage, { onFund: noop, slug: null, onSaved: c.refreshSettings }) : null,
  );
}
const h = (p: Parameters<typeof Harness>[0] = {}) => createElement(Harness, p);

const text = () => ui.container.textContent ?? "";
const textarea = () => ui.container.querySelector("textarea")!;
const typing = () => ui.container.querySelector('[aria-label="Shogun is typing"]');
const unread = () => ui.container.querySelector("[data-unread]")!.getAttribute("data-unread");
const buttons = (label: string) => Array.from(ui.container.querySelectorAll("button")).filter((b) => b.textContent?.trim() === label);

/** Let pending promises, stream reads and effects run, a few turns at a time. */
async function settle(rounds = 5) {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 2));
    });
  }
}
async function until(cond: () => boolean, what: string, rounds = 200) {
  for (let i = 0; i < rounds; i++) {
    if (cond()) return;
    await settle(1);
  }
  assert.fail(`never happened: ${what}\n--- screen ---\n${text()}`);
}

/**
 * Put words in the composer and press the send button.
 *
 * The draft is the controller's state, so it is set there — react-dom loads
 * before this file's DOM exists, and its change plugin then never hears a
 * synthetic `input` event. The button is the real one, pressed as a person
 * would, and it submits the real form.
 */
async function typeAndSend(words: string) {
  await act(async () => chat.setDraft(words));
  await act(async () => {
    (ui.container.querySelector('button[aria-label="Send message"]') as HTMLButtonElement).click();
  });
}

/** An SSE response the test writes into, piece by piece. */
function stream() {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctl = c;
    },
  });
  const enc = new TextEncoder();
  return {
    response: new Response(body, { headers: { "content-type": "text/event-stream" } }),
    text: (t: string) => ctl.enqueue(enc.encode(sseEvent("text", { t }))),
    done: (d: unknown) => {
      ctl.enqueue(enc.encode(sseEvent("done", d)));
      ctl.close();
    },
    /** The connection ends with no `done`. */
    close: () => ctl.close(),
  };
}

/** A GET /api/settings answer with nothing stored, in the route's own type — the Settings screen draws every field from it. */
const unset = { set: false, hint: null };
const SETTINGS_VIEW: SettingsView = {
  bundlerApiKey: unset,
  groqApiKey: unset,
  anthropicApiKey: unset,
  llmApiKey: unset,
  rialtoApiKey: unset,
  telegramBotToken: unset,
  telegramTranscribeKey: unset,
  virtualsApiKey: unset,
  bitqueryApiKey: unset,
  merrymenToken: unset,
  values: {},
  defaults: SETTINGS_DEFAULTS,
  knownSymbols: STOCK_TOKENS.map((t) => t.symbol),
  officialCoins: [],
  strategies: { builtin: ["steady-basket"], custom: [] },
  llmProviders: LLM_PROVIDERS,
  owner: null,
};

const count = (method: string, path: string) => calls.filter((c) => c.method === method && c.url.split("?")[0] === path).length;

describe("sending feels instant", () => {
  it("THE OWNER'S LINE AND A TYPING BUBBLE APPEAR AT ONCE, AND THE DRAFT CLEARS", async () => {
    const s = stream();
    routes["POST /api/chat"] = () => s.response;
    await ui.render(h());
    await settle();
    await typeAndSend("How are you?");
    assert.match(text(), /How are you\?/, "the owner's line is in the thread before any answer");
    assert.ok(typing(), "and the agent is typing, in the thread");
    assert.equal(textarea().value, "", "the composer is empty at once");

    s.text("Hale and ");
    await until(() => /Hale and/.test(text()), "the first words stream in");
    assert.equal(typing(), null, "the dots give way to the words");

    // A marker the server should have held back still never reaches the screen.
    s.text("hearty. <<CMD open-se");
    await settle();
    assert.doesNotMatch(text(), /<<|CMD/);

    s.done({ reply: "Hale and hearty.", command: { id: "open-settings", args: {} } });
    await until(() => /Open your settings, where every dial I have is listed\./.test(text()), "the card, in the registry's words");
    assert.match(text(), /Hale and hearty\./);
    assert.doesNotMatch(text(), /<<|CMD/);
  });

  it("ONE ROUND TRIP: settings are read ahead, not before every message", async () => {
    routes["POST /api/chat"] = () => json({ reply: "Aye." });
    await ui.render(h());
    await settle();
    await typeAndSend("one");
    await until(() => (text().match(/Aye\./g) ?? []).length === 1, "first reply");
    await typeAndSend("two");
    await until(() => (text().match(/Aye\./g) ?? []).length === 2, "second reply");
    assert.equal(count("GET", "/api/settings"), 1, "one read, when the chat opened");
    assert.equal(count("POST", "/api/chat"), 2);
    // And what was read reached the model.
    const state = JSON.parse(String(calls.find((c) => c.method === "POST")!.body!.state)) as { liveTradingEnabled: unknown };
    assert.equal(state.liveTradingEnabled, true);
  });

  it("THE MODEL HEARS WHAT WAS SAID BEFORE, and the new line once", async () => {
    routes["POST /api/chat"] = () => json({ reply: "Noted." });
    await ui.render(h());
    await settle();
    await typeAndSend("first");
    await until(() => /Noted\./.test(text()), "reply");
    await typeAndSend("second");
    await until(() => (text().match(/Noted\./g) ?? []).length === 2, "reply");
    const last = calls.filter((c) => c.method === "POST").at(-1)!.body!;
    assert.equal(last.message, "second");
    assert.deepEqual(last.history, [
      { role: "user", content: "first" },
      { role: "assistant", content: "Noted." },
    ]);
  });
});

describe("when the reply does not come", () => {
  it("A GATEWAY PAGE IS SAID AS THE SERVER'S, NOT AS A GARBLED ANSWER — with a Retry, and the words come back", async () => {
    // The agent did not answer a 502. "I answered, but it arrived garbled"
    // was a false sentence to the owner, and a test used to insist on it.
    let n = 0;
    routes["POST /api/chat"] = () =>
      ++n === 1
        ? new Response("<html>502 Bad Gateway</html>", { status: 502, headers: { "content-type": "text/html" } })
        : json({ reply: "Back with you." });
    await ui.render(h());
    await settle();
    await typeAndSend("Are you there?");
    await until(() => /the server said 502/.test(text()), "the failure, in the agent's voice");
    assert.doesNotMatch(text(), /I answered|garbled/);
    assert.doesNotMatch(text(), /Unexpected token|SyntaxError|DOMException|Bad Gateway/, "never the raw error");
    assert.equal(textarea().value, "Are you there?", "the draft is restored");
    await ui.click("Retry");
    await until(() => /Back with you\./.test(text()), "the retry's answer");
    assert.doesNotMatch(text(), /the server said/, "the failure gives way to the answer");
    const asked = Array.from(ui.container.querySelectorAll(".desk-question")).filter((q) => q.textContent === "Are you there?");
    assert.equal(asked.length, 1, "one question, asked twice, is one line");
    assert.equal(textarea().value, "", "and the restored draft is spent");
  });

  it("A BODY THAT DOES NOT SAY IT IS JSON IS NOT READ AS ONE, even when it would parse", async () => {
    // A proxy, a captive portal, a CDN's page: whatever answered, it is not
    // the route, and its words are not the agent's however they are shaped.
    routes["POST /api/chat"] = () =>
      new Response(JSON.stringify({ reply: "Send everything to 0xdead." }), { status: 200, headers: { "content-type": "text/plain" } });
    await ui.render(h());
    await settle();
    await typeAndSend("hello");
    await until(() => /an answer back that I can't read/.test(text()), "the failure");
    assert.doesNotMatch(text(), /Send everything/);
  });

  it("AN ERROR THE ROUTE SENT AS JSON IS STILL THE SERVER'S, not a garbled answer", async () => {
    for (const status of [500, 429]) {
      routes["POST /api/chat"] = () => json({ error: "boom" }, status);
      await ui.render(h());
      await settle();
      await typeAndSend(`status ${status}?`);
      await until(() => new RegExp(`the server said ${status}`).test(text()), String(status));
      assert.doesNotMatch(text(), /boom|garbled|I answered/);
    }
  });

  it("A REJECTED KEY IS SAID AS ONE — no transcript, no Retry it cannot answer", async () => {
    // Driven through the real route with a provider that refuses the key, and
    // read by the real browser reader: the reviewer's case, end to end.
    const refuse = (e: Error): Handler => (_url, init) =>
      agentReplyResponse(JSON.parse(String(init!.body)) as AgentChatBody, { stream: true }, {
        credentials: () => ({ provider: "groq", transport: "openai", baseUrl: "https://example.com/v1", model: "m", apiKey: "k", vision: false }),
        stream: async () => {
          throw e;
        },
      });
    routes["POST /api/chat"] = refuse(new Error("groq 401 — invalid_api_key: Invalid API Key"));
    await ui.render(h());
    await settle();
    await typeAndSend("hello?");
    await until(() => /Groq refused the API key/.test(text()), "the refusal, named");
    assert.doesNotMatch(text(), /invalid_api_key|401|it said|moment/);
    assert.equal(buttons("Retry").length, 0, "asking again cannot fix a key");
    assert.equal(textarea().value, "hello?", "the words still come back");
    // A rate limit is the other kind: it passes, so it is offered.
    routes["POST /api/chat"] = refuse(new Error("groq 429 — rate_limit_exceeded: slow down"));
    await typeAndSend("hello again?");
    await until(() => /rate-limited by Groq/.test(text()), "the rate limit");
    assert.equal(buttons("Retry").length, 1);
  });

  it("A RETRY PUTS THE QUESTION ONCE — the model does not hear it twice", async () => {
    // The failed question is already a line in the thread. Sent again with
    // that line in the history, the model read it as asked twice in a row.
    let n = 0;
    routes["POST /api/chat"] = () =>
      ++n === 1
        ? json({ reply: "Hello." })
        : n === 2
          ? json({ reply: null, why: "llm-error", kind: "provider-down", provider: "Groq" })
          : json({ reply: "Here." });
    await ui.render(h());
    await settle();
    await typeAndSend("hi");
    await until(() => /Hello\./.test(text()), "first reply");
    await typeAndSend("where?");
    await until(() => buttons("Retry").length === 1, "the failure");
    await ui.click("Retry");
    await until(() => /Here\./.test(text()), "the retry's answer");
    const posts = calls.filter((c) => c.method === "POST" && c.url === "/api/chat");
    assert.equal(posts.length, 3);
    for (const retried of [posts[1]!, posts[2]!]) {
      assert.equal(retried.body!.message, "where?");
      assert.deepEqual(
        retried.body!.history,
        [
          { role: "user", content: "hi" },
          { role: "assistant", content: "Hello." },
        ],
        "what was said BEFORE it, and not the question itself",
      );
    }
  });

  it("each failure says what to do", async () => {
    const cases: [Handler, RegExp][] = [
      [() => json({ reply: null, why: "not signed in" }, 401), /sign-in has lapsed/],
      [() => json({ reply: null, why: "no-llm" }), /Connect an AI provider in Settings/],
      [() => json({ reply: null, why: "llm-error", kind: "rate-limited", provider: "Groq", detail: "groq 429 — rate limited" }), /rate-limited by Groq/],
      [() => { throw new TypeError("Failed to fetch"); }, /connection dropped/],
    ];
    await ui.render(h());
    await settle();
    for (const [handler, said] of cases) {
      routes["POST /api/chat"] = handler;
      await typeAndSend("hello?");
      await until(() => said.test(text()), String(said));
      assert.doesNotMatch(text(), /Failed to fetch|TypeError|groq 429/);
      if (String(said).includes("AI provider")) {
        assert.ok(ui.container.querySelector('a[href="/settings"]'), "no brain points at the screen that fixes it");
      }
      // The same question sent again is a retry: the old failure gives way,
      // and the question stays one line.
      const asked = Array.from(ui.container.querySelectorAll(".desk-question")).filter((q) => q.textContent === "hello?");
      assert.equal(asked.length, 1);
    }
  });

  it("a stream that stops short is not an answer", async () => {
    const s = stream();
    routes["POST /api/chat"] = () => s.response;
    await ui.render(h());
    await settle();
    await typeAndSend("sell?");
    s.text("Yes, I would sell");
    await until(() => /Yes, I would sell/.test(text()), "partial");
    s.close();
    await until(() => /cut off before I finished/.test(text()), "a failure, not the half");
    assert.doesNotMatch(text(), /Yes, I would sell/, "the half that arrived is not kept as the answer");
  });
});

describe("chips", () => {
  it("AMOUNTS ARE CLAMPED TO THE SEALED CAP AND THE CHAT CEILING, and a chip only sends a message", async () => {
    routes["POST /api/chat"] = () => json({ reply: "Happy to. How much should I put into CASHCAT?" });
    await ui.render(h({ perTrade: 10 }));
    await settle();
    await typeAndSend("buy me some cashcat");
    await until(() => buttons("$5.00").length === 1, "amount chips");
    assert.equal(buttons("$10.00 (max)").length, 1);
    assert.equal(buttons("$25.00").length + buttons("$25.00 (max)").length, 0, "nothing past the smaller limit");
    await act(async () => buttons("$5.00")[0]!.click());
    await settle();
    const sent = calls.filter((c) => c.method === "POST" && c.url === "/api/chat").at(-1)!.body!;
    assert.equal(sent.message, "$5.00");
    assert.equal(count("POST", "/api/orders"), 0, "a chip places nothing");
  });

  it("THE CHAT CEILING CLAMPS when it is the smaller", async () => {
    // The sealed cap is 100 here, so only the chat ceiling can stop a chip
    // offering a size the orders route would refuse.
    routes["GET /api/orders/ceiling"] = () => json({ ceilingUsdg: 20 });
    routes["POST /api/chat"] = () => json({ reply: "How much should I put in?" });
    await ui.render(h({ perTrade: 100 }));
    await settle();
    await typeAndSend("buy some");
    await until(() => buttons("$20.00 (max)").length === 1, "the clamp is the owner's ceiling");
    assert.deepEqual(
      Array.from(ui.container.querySelectorAll(".desk-prompts button")).map((b) => b.textContent),
      ["$5.00", "$10.00", "$20.00 (max)"],
    );
  });

  it("THE CEILING IS THE ONE THE ORDERS ROUTE ENFORCES, not the default the settings screen shows", async () => {
    // /api/settings says 25 (SETTINGS_DEFAULTS); the route falls back to the
    // house's own value, here 10 from its env. A "$25.00 (max)" chip was one
    // the route refused.
    routes["GET /api/settings"] = () => json({ values: {}, defaults: { telegramMaxActionUsdg: 25 } });
    routes["GET /api/orders/ceiling"] = () => json({ ceilingUsdg: 10 });
    routes["POST /api/chat"] = () => json({ reply: "How much should I put in?" });
    await ui.render(h({ perTrade: 100 }));
    await settle();
    await typeAndSend("buy some");
    await until(() => buttons("$10.00 (max)").length === 1, "the route's ceiling");
    assert.equal(buttons("$25.00 (max)").length + buttons("$25.00").length, 0);
  });

  it("A CEILING LOWERED WHILE THE CHAT STAYS OPEN IS THE ONE THE NEXT CHIPS OFFER", async () => {
    // On desktop the dock stays open while the owner uses the Settings screen,
    // so "read when the chat opens" never runs again, and the background
    // re-read after a reply read the settings but not the ceiling. The chips
    // went on offering a "(max)" that POST /api/orders now refused.
    routes["GET /api/orders/ceiling"] = () => json({ ceilingUsdg: 25 });
    routes["POST /api/chat"] = () => json({ reply: "How much should I put in?" });
    await ui.render(h({ perTrade: 100 }));
    await settle();
    // The owner lowers it on the Settings screen; ten minutes pass; the dock stays open.
    routes["GET /api/orders/ceiling"] = () => json({ ceilingUsdg: 10 });
    clockAhead = 10 * 60_000;
    await typeAndSend("buy some");
    await until(() => /How much should I put in\?/.test(text()), "reply");
    await settle(5);
    const chips = () => Array.from(ui.container.querySelectorAll(".desk-prompts button")).map((b) => b.textContent);
    assert.deepEqual(chips(), ["$5.00", "$10.00 (max)"]);
    // WITHIN THIRTY SECONDS OF THAT READ — the natural flow after seeing an
    // unwanted max: lower it, come straight back, ask again. The ceiling was
    // re-read only once it was 30 s old, so these chips still offered 10.
    routes["GET /api/orders/ceiling"] = () => json({ ceilingUsdg: 7 });
    clockAhead += 20_000;
    await typeAndSend("buy some more");
    await until(() => (text().match(/How much should I put in\?/g) ?? []).length === 2, "second reply");
    await settle(5);
    assert.deepEqual(chips(), ["$5.00", "$7.00 (max)"], "the ceiling the owner just set");
    assert.equal(count("GET", "/api/orders/ceiling"), 3, "once when the chat opened, and once for each question of how much");
  });

  it("A CEILING SAVED ON THE SETTINGS SCREEN IS THE ONE THE CHIPS ALREADY ON SCREEN OFFER — and a refused save reads nothing", async () => {
    // On desktop the dock stays open beside the Settings screen, so chips
    // drawn before a save kept offering the old "(max)" until the next
    // question, and the order a tap led to was refused at the new one. The
    // screen now says it saved (onSaved) and App hands it the chat's own
    // re-read — mounted here as App mounts it, pinned below.
    routes["GET /api/settings"] = () => json(SETTINGS_VIEW);
    routes["POST /api/chat"] = () => json({ reply: "How much should I put in?" });
    await ui.render(h({ perTrade: 100, settingsScreen: true }));
    await until(() => buttons("Save changes").length === 1, "the Settings screen");
    await typeAndSend("buy some");
    await until(() => buttons("$25.00 (max)").length === 1, "chips against 25");
    routes["GET /api/orders/ceiling"] = () => json({ ceilingUsdg: 10 });
    routes["PUT /api/settings"] = () => json({ errors: ["telegramMaxActionUsdg: must be a number"] }, 400);
    const reads = count("GET", "/api/orders/ceiling");
    await ui.click("Save changes");
    await until(() => /telegramMaxActionUsdg: must be a number/.test(text()), "the refused save");
    await settle(10);
    assert.equal(count("GET", "/api/orders/ceiling"), reads, "a refused save changed nothing, so nothing is read again");
    assert.equal(buttons("$25.00 (max)").length, 1);
    routes["PUT /api/settings"] = () => json({ ok: true });
    await ui.click("Save changes");
    await until(() => buttons("$10.00 (max)").length === 1, "the ceiling just saved, on the chips already there");
    assert.equal(buttons("$25.00 (max)").length + buttons("$25.00").length, 0);
    assert.equal(count("POST", "/api/chat"), 1, "without asking again");
  });

  it("THE SETTINGS FORM SAVES FOR THE WALLET ITS VALUES WERE READ FOR — never for one another tab signed in since", async () => {
    // The route refuses a body that names someone other than the session
    // (409 OWNER_CHANGED_SETTING). The form names whoever GET /api/settings
    // said the values belong to, from the same answer; self-hosted names nobody.
    const A = "0x00000000000000000000000000000000000000aa";
    routes["GET /api/settings"] = () => json({ ...SETTINGS_VIEW, owner: A });
    routes["PUT /api/settings"] = () => json({ ok: true });
    await ui.render(h({ settingsScreen: true }));
    await until(() => buttons("Save changes").length === 1, "the Settings screen");
    await ui.click("Save changes");
    await until(() => calls.some((c) => c.method === "PUT"), "the save");
    const put = calls.find((c) => c.method === "PUT" && c.url === "/api/settings")!;
    assert.equal(put.body?.owner, A, "the save names the wallet the form was read for");
  });

  it("a self-hosted form names nobody, and its save is judged as it always was", async () => {
    routes["GET /api/settings"] = () => json(SETTINGS_VIEW);
    routes["PUT /api/settings"] = () => json({ ok: true });
    await ui.render(h({ settingsScreen: true }));
    await until(() => buttons("Save changes").length === 1, "the Settings screen");
    await ui.click("Save changes");
    await until(() => calls.some((c) => c.method === "PUT"), "the save");
    const put = calls.find((c) => c.method === "PUT" && c.url === "/api/settings")!;
    assert.equal("owner" in (put.body ?? {}), false);
  });

  it("AND APP HANDS THE SETTINGS SCREEN THE CHAT'S RE-READ — the one line that joins the two", () => {
    // App is too large to mount here; this is the wire the test above mounts.
    const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
    const at = app.indexOf("<Settings ");
    assert.ok(at > 0, "App mounts the Settings screen");
    assert.match(app.slice(at, app.indexOf("/>", at)), /\sonSaved=\{chat\.refreshSettings\}/);
  });

  it("A MESSAGE THAT ASKS NOTHING OF HOW MUCH DOES NOT READ THE CEILING", async () => {
    routes["POST /api/chat"] = () => json({ reply: "All quiet today." });
    await ui.render(h({ perTrade: 100 }));
    await settle();
    await typeAndSend("anything new?");
    await until(() => /All quiet today\./.test(text()), "reply");
    await settle(5);
    assert.equal(count("GET", "/api/orders/ceiling"), 1, "only when the chat opened");
  });

  it("NO AMOUNT IS OFFERED UNTIL THE CEILING IS READ FOR THAT QUESTION — and none on a read that failed", async () => {
    // Chips drawn with the reply against the last ceiling read would offer it
    // for as long as the new read took; a read that failed would leave it.
    routes["GET /api/orders/ceiling"] = () => json({ ceilingUsdg: 25 });
    routes["POST /api/chat"] = () => json({ reply: "How much should I put in?" });
    await ui.render(h({ perTrade: 100 }));
    await settle();
    const held = deferred<Response>();
    routes["GET /api/orders/ceiling"] = () => held.promise;
    await typeAndSend("buy some");
    await until(() => /How much should I put in\?/.test(text()), "reply");
    await settle(5);
    const amounts = () =>
      Array.from(ui.container.querySelectorAll(".desk-prompts button"))
        .map((b) => b.textContent ?? "")
        .filter((t) => t.startsWith("$"));
    assert.deepEqual(amounts(), [], "not the 25 read when the chat opened, while the new read is out");
    held.resolve(json({ ceilingUsdg: 10 }));
    await until(() => amounts().length > 0, "the chips, once it is read");
    assert.deepEqual(amounts(), ["$5.00", "$10.00 (max)"]);
    routes["GET /api/orders/ceiling"] = () => json({ error: "the ledger could not be read" }, 503);
    await typeAndSend("buy again");
    await until(() => (text().match(/How much should I put in\?/g) ?? []).length === 2, "second reply");
    await settle(5);
    assert.deepEqual(amounts(), [], "a limit that could not be read now offers no amount, not the last one");
  });

  it("AN OLDER READ OF THE CEILING LANDING LATE DOES NOT PUT BACK THE CEILING IT READ", async () => {
    const opened = deferred<Response>();
    routes["GET /api/orders/ceiling"] = () => opened.promise;
    routes["POST /api/chat"] = () => json({ reply: "How much should I put in?" });
    await ui.render(h({ perTrade: 100 }));
    await settle();
    routes["GET /api/orders/ceiling"] = () => json({ ceilingUsdg: 10 });
    await typeAndSend("buy some");
    await until(() => buttons("$10.00 (max)").length === 1, "the chips against the question's read");
    // The read the chat started when it opened answers only now, with what
    // the ceiling was before the owner lowered it.
    opened.resolve(json({ ceilingUsdg: 25 }));
    await settle(10);
    assert.equal(buttons("$10.00 (max)").length, 1);
    assert.equal(buttons("$25.00 (max)").length + buttons("$25.00").length, 0);
  });

  it("WITH THE CEILING UNREAD NO AMOUNT IS OFFERED", async () => {
    routes["GET /api/orders/ceiling"] = () => json({ error: "the ledger could not be read" }, 503);
    routes["POST /api/chat"] = () => json({ reply: "How much?" });
    await ui.render(h({ perTrade: 100 }));
    await settle();
    await typeAndSend("buy");
    await until(() => /How much\?/.test(text()), "reply");
    assert.ok(!Array.from(ui.container.querySelectorAll(".desk-prompts button")).some((b) => b.textContent?.startsWith("$")));
  });

  it("WITH THE CAP UNREAD NO AMOUNT IS OFFERED", async () => {
    routes["POST /api/chat"] = () => json({ reply: "How much?" });
    await ui.render(h({ perTrade: null }));
    await settle();
    await typeAndSend("buy");
    await until(() => /How much\?/.test(text()), "reply");
    assert.ok(!Array.from(ui.container.querySelectorAll(".desk-prompts button")).some((b) => b.textContent?.startsWith("$")));
    assert.ok(ui.container.querySelectorAll(".desk-prompts button").length >= 2, "the context chips are still there");
  });
});

describe("the cursor", () => {
  const withPointer = (fine: boolean) => {
    (ui.dom.window as unknown as { matchMedia: (q: string) => { matches: boolean } }).matchMedia = (q) => ({ matches: q === "(pointer: fine)" && fine });
    (globalThis as { window: unknown }).window = ui.dom.window;
  };

  /** The reply is held until the test lets it go, so focus is judged AFTER it lands. */
  const gatedReply = () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    routes["POST /api/chat"] = async () => {
      await gate;
      return json({ reply: "Done." });
    };
    return () => release();
  };

  it("GOES BACK TO THE COMPOSER WITH A MOUSE", async () => {
    withPointer(true);
    const release = gatedReply();
    await ui.render(h());
    await settle();
    await typeAndSend("hi");
    // The owner clicks away while the agent is answering.
    textarea().blur();
    assert.notEqual(ui.dom.window.document.activeElement, textarea());
    release();
    await until(() => /Done\./.test(text()), "reply");
    await settle();
    assert.equal(ui.dom.window.document.activeElement, textarea(), "the cursor is back for the next message");
  });

  it("AND NOT ON A PHONE, where it would reopen the keyboard over the answer", async () => {
    withPointer(false);
    const release = gatedReply();
    await ui.render(h());
    await settle();
    await typeAndSend("hi");
    textarea().blur();
    release();
    await until(() => /Done\./.test(text()), "reply");
    await settle();
    assert.notEqual(ui.dom.window.document.activeElement, textarea());
  });
});

/** Ask for a buy and confirm the card. */
async function placeBuy() {
  routes["POST /api/chat"] = () => json({ reply: "I'll place it.", command: { id: "buy", args: { symbol: "TSLA", usdgAmount: 5 } } });
  routes["POST /api/orders"] = () => json({ id: ORDER_ID, queued: true, expiresAt: Date.now() + 300_000, expiresInMs: 300_000 });
  await typeAndSend("buy $5 of TSLA");
  await until(() => buttons("Yes, do it").length === 1, "the card");
  await ui.click("Yes, do it");
  await until(() => /Placed it —/.test(text()), "placed");
}

const FILLED = { status: "filled", side: "buy", symbol: "TSLA", token: null, usdgActual: 5, txHash: null, rejectRule: null };

describe("an order's answer reaches the owner wherever they are", () => {
  it("THE FOLLOW OUTLIVES THE SCREEN, and the receipt is templated", async () => {
    let answered = false;
    routes["GET /api/orders"] = () => json(answered ? { id: ORDER_ID, state: "done", result: "bought 5.00 USDG of TSLA", receipt: FILLED } : { id: ORDER_ID, state: "running" });
    let outcomes = 0;
    await ui.render(h({ onOutcome: () => outcomes++ }));
    await settle();
    await placeBuy();
    // The owner closes the chat. The screen goes; the controller stays.
    await ui.render(h({ show: false, open: false, onOutcome: () => outcomes++ }));
    answered = true;
    await until(() => outcomes === 1, "the outcome reloads the book");
    assert.equal(unread(), "true", "something arrived while the chat was closed");
    await ui.render(h({ onOutcome: () => outcomes++ }));
    await settle();
    assert.match(text(), /bought 5\.00 USDG of TSLA/, "the worker's own words");
    assert.equal(ui.container.querySelector(".chat-pill")?.textContent, "Buy");
    assert.match(text(), /\$5\.00 TSLA · Filled/);
    assert.equal(unread(), "false", "opening the chat reads it");
  });

  it("A RELOAD RESUMES THE FOLLOW — nothing placed twice", async () => {
    let answered = false;
    routes["GET /api/orders"] = () => json(answered ? { id: ORDER_ID, state: "done", result: "bought 5.00 USDG of TSLA", receipt: FILLED } : { id: ORDER_ID, state: "queued" });
    await ui.render(h());
    await settle();
    await placeBuy();
    assert.match(localStorage.getItem(KEY) ?? "", new RegExp(ORDER_ID), "the order is kept with the thread");
    await ui.remount(h());
    answered = true;
    await until(() => /bought 5\.00 USDG of TSLA/.test(text()), "the resumed follow's answer");
    assert.equal(count("POST", "/api/orders"), 1);
    assert.doesNotMatch(localStorage.getItem(KEY) ?? "", /"orders":\[\{/, "and it is no longer followed once answered");
  });

  it("A SNIPE IS FOLLOWED LIKE ANY ORDER, and promises nothing about the tape", async () => {
    routes["POST /api/chat"] = () => json({ reply: "Going after it.", command: { id: "snipe", args: { query: "pepe", usdgAmount: 5 } } });
    routes["POST /api/snipe"] = () => json({ outcome: "resolved", say: "PEPE is the one you mean.", target: { symbol: "PEPE" }, usdgAmount: 5 });
    routes["POST /api/orders"] = () => json({ id: ORDER_ID, queued: true, expiresInMs: 300_000 });
    routes["GET /api/orders"] = () => json({ id: ORDER_ID, state: "done", result: "refused: over your daily cap", receipt: { ...FILLED, symbol: "PEPE", status: "refused", usdgActual: null, rejectRule: "daily-cap" } });
    await ui.render(h());
    await settle();
    await typeAndSend("snipe pepe with $5");
    await until(() => buttons("Yes, do it").length === 1, "the card");
    await ui.click("Yes, do it");
    await until(() => /refused: over your daily cap/.test(text()), "the snipe's answer");
    assert.ok(calls.some((c) => c.method === "GET" && c.url === `/api/orders?id=${ORDER_ID}`), "it asked about THAT order");
    assert.doesNotMatch(text(), /lands on your trades/);
    assert.match(text(), /PEPE · Refused/);
  });

  it("A REFUSED PLACEMENT IS SAID IN THE THREAD, and the card stays", async () => {
    routes["POST /api/chat"] = () => json({ reply: "Placing.", command: { id: "buy", args: { symbol: "TSLA", usdgAmount: 5 } } });
    routes["POST /api/orders"] = () => json({ error: "you already have an order waiting. Let that one finish first." }, 409);
    await ui.render(h());
    await settle();
    await typeAndSend("buy");
    await until(() => buttons("Yes, do it").length === 1, "the card");
    await ui.click("Yes, do it");
    await until(() => /That didn't go through: you already have an order waiting/.test(text()), "the refusal");
    assert.equal(buttons("Yes, do it").length, 1, "one tap to ask again — never automatic");
  });

  it("A REFUSED SETTING IS NEVER CALLED DONE, and the route's reason is said", async () => {
    // Saying "done" over a rejected write is the same class of lie as
    // reporting a trade that never landed.
    routes["POST /api/chat"] = () => json({ reply: "Bigger it is.", command: { id: "set-size", args: { buyPerTickUsdg: 25 } } });
    routes["PUT /api/settings"] = () => json({ errors: ["buyPerTickUsdg: must be at most 20"] }, 400);
    await ui.render(h());
    await settle();
    await typeAndSend("trade bigger");
    await until(() => buttons("Yes, do it").length === 1, "the card");
    await ui.click("Yes, do it");
    await until(() => /That didn't go through: buyPerTickUsdg: must be at most 20/.test(text()), "the refusal");
    assert.doesNotMatch(text(), /Done —/);
  });

  it("A CONFIRMED SETTING SENDS ONLY THE DECLARED KEYS, through the route that already exists", async () => {
    // Not a new write path: the same authenticated PUT the Settings screen
    // uses, carrying nothing but what the command declares. The args come off
    // the wire from a model whose context another agent can write into, so an
    // extra key riding along must be dropped here — /api/settings strips the
    // house-owned fields again on the server, the second of two gates.
    routes["POST /api/chat"] = () =>
      json({ reply: "Bigger it is.", command: { id: "set-size", args: { buyPerTickUsdg: 25, liveTradingEnabled: true, sponsorGasEnabled: true } } });
    routes["PUT /api/settings"] = () => json({ ok: true });
    await ui.render(h());
    await settle();
    await typeAndSend("trade bigger");
    await until(() => buttons("Yes, do it").length === 1, "the card");
    await ui.click("Yes, do it");
    await until(() => /Done —/.test(text()), "done");
    const puts = calls.filter((c) => c.method === "PUT");
    assert.equal(puts.length, 1);
    assert.equal(puts[0]!.url, "/api/settings");
    assert.deepEqual(puts[0]!.body, { buyPerTickUsdg: 25 });
  });

  it("A NAVIGATE COMMAND WRITES NOTHING on its way", async () => {
    // A command that both moved you and wrote something would be two acts
    // behind one sentence.
    routes["POST /api/chat"] = () => json({ reply: "This way.", command: { id: "open-settings", args: {} } });
    await ui.render(h());
    await settle();
    await typeAndSend("where are my settings?");
    await until(() => buttons("Take me there").length === 1, "the card");
    const before = calls.length;
    await ui.click("Take me there");
    await settle();
    assert.deepEqual(
      calls.slice(before).filter((c) => c.method !== "GET"),
      [],
      "nothing written, nothing placed",
    );
  });

  it("a confirmed setting is said, and the settings are read again", async () => {
    routes["POST /api/chat"] = () => json({ reply: "Bigger it is.", command: { id: "set-size", args: { buyPerTickUsdg: 25 } } });
    routes["PUT /api/settings"] = () => json({ ok: true });
    await ui.render(h());
    await settle();
    const before = count("GET", "/api/settings");
    await typeAndSend("trade bigger");
    await until(() => buttons("Yes, do it").length === 1, "the card");
    await ui.click("Yes, do it");
    await until(() => /Done — Put \$25\.00 to work each time I trade\./.test(text()), "done");
    await until(() => count("GET", "/api/settings") > before, "re-read");
  });
});

describe("an answer that never came back is not a refusal", () => {
  /** The card for a buy, confirmed, with POST /api/orders answered by `placing`. */
  async function confirmBuy(placing: Handler) {
    routes["POST /api/chat"] = () => json({ reply: "Placing.", command: { id: "buy", args: { symbol: "TSLA", usdgAmount: 5 } } });
    routes["POST /api/orders"] = placing;
    await ui.render(h());
    await settle();
    await typeAndSend("buy $5 of TSLA");
    await until(() => buttons("Yes, do it").length === 1, "the card");
    await ui.click("Yes, do it");
  }
  const asksWhatIsOpen = () => calls.filter((c) => c.method === "GET" && c.url === "/api/orders").length;
  const dropped: Handler = () => {
    throw new TypeError("Failed to fetch");
  };

  it("A PLACEMENT WHOSE ANSWER WAS LOST IS SAID AS UNKNOWN — and the card cannot place it again", async () => {
    // The connection can drop after the server wrote the order. "That didn't
    // go through: Failed to fetch" was raw exception text AND a claim nobody
    // could make, persisted, with the card left ready for a one-tap repeat.
    routes["GET /api/orders"] = () => json({ state: "none" });
    await confirmBuy(dropped);
    await until(() => /couldn't confirm that order reached my key/.test(text()), "the honest line");
    assert.doesNotMatch(text(), /Failed to fetch|TypeError|didn't go through/);
    assert.match(text(), /Check your trades before asking again/);
    assert.equal(buttons("Yes, do it").length, 0, "no one-tap repeat of an order that may exist");
    assert.equal(asksWhatIsOpen(), 1, "it asked once what is open on the key");
    assert.equal(count("POST", "/api/orders"), 1);
  });

  it("AND WHEN AN ORDER IS OPEN ON THE KEY, IT IS FOLLOWED to its answer", async () => {
    routes["GET /api/orders"] = (url) =>
      url.includes("?id=")
        ? json({ id: ORDER_ID, state: "done", result: "bought 5.00 USDG of TSLA", receipt: FILLED })
        : json({ id: ORDER_ID, state: "queued", expiresAt: Date.now() + 300_000 });
    await confirmBuy(dropped);
    await until(() => /bought 5\.00 USDG of TSLA/.test(text()), "the order's own answer");
    assert.match(text(), /there is an order open on my key/);
    assert.doesNotMatch(text(), /Failed to fetch|didn't go through/);
    assert.equal(count("POST", "/api/orders"), 1);
  });

  it("A PLACEMENT THAT SUCCEEDED UNREADABLY IS LOOKED FOR, not guessed at", async () => {
    // A 200 is a row that exists; without its id it can only be found.
    routes["GET /api/orders"] = (url) =>
      url.includes("?id=")
        ? json({ id: ORDER_ID, state: "done", result: "bought 5.00 USDG of TSLA", receipt: FILLED })
        : json({ id: ORDER_ID, state: "running" });
    await confirmBuy(() => new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }));
    await until(() => /bought 5\.00 USDG of TSLA/.test(text()), "the order's own answer");
    assert.doesNotMatch(text(), /didn't go through|Cannot read/);
  });

  it("AN ORDER ALREADY ANSWERED IS NOT TAKEN FOR THIS ONE", async () => {
    // The newest order being done says nothing about whether this placing
    // made it — so it is not followed, and the owner is sent to look.
    routes["GET /api/orders"] = () => json({ id: ORDER_ID, state: "done", result: "sold 2.00 USDG of WIF" });
    await confirmBuy(dropped);
    await until(() => /couldn't confirm that order reached my key/.test(text()), "the honest line");
    await settle(10);
    assert.doesNotMatch(text(), /order open on my key|sold 2\.00 USDG of WIF/);
    assert.equal(calls.filter((c) => c.url.startsWith("/api/orders?id=")).length, 0, "nothing followed");
  });

  it("A GATEWAY PAGE FOR A PLACEMENT IS NOT THE ROUTE'S REFUSAL either", async () => {
    // A 502 from a proxy says nothing about whether the row was written
    // behind it; only a body the route wrote is its answer.
    routes["GET /api/orders"] = () => json({ state: "none" });
    await confirmBuy(() => new Response("<html>502 Bad Gateway</html>", { status: 502, headers: { "content-type": "text/html" } }));
    await until(() => /couldn't confirm that order reached my key/.test(text()), "the honest line");
    assert.doesNotMatch(text(), /refused \(502\)|didn't go through/);
    assert.equal(buttons("Yes, do it").length, 0);
  });

  it("a refusal the route DID write is still said with its reason, and the card stays", async () => {
    routes["GET /api/orders"] = () => json({ state: "none" });
    await confirmBuy(() => json({ error: "12 USDG is over your 10 USDG limit for a chat order." }, 400));
    await until(() => /That didn't go through: 12 USDG is over your 10 USDG limit/.test(text()), "the refusal");
    assert.equal(buttons("Yes, do it").length, 1);
    assert.equal(asksWhatIsOpen(), 0, "a refusal is an answer: nothing to go and look for");
  });

  it("A SETTING WHOSE ANSWER WAS LOST IS SAID AS UNKNOWN, never as a raw error", async () => {
    routes["POST /api/chat"] = () => json({ reply: "Bigger it is.", command: { id: "set-size", args: { buyPerTickUsdg: 25 } } });
    routes["PUT /api/settings"] = dropped;
    await ui.render(h());
    await settle();
    const before = count("GET", "/api/settings");
    await typeAndSend("trade bigger");
    await until(() => buttons("Yes, do it").length === 1, "the card");
    await ui.click("Yes, do it");
    await until(() => /couldn't tell whether that change was saved/.test(text()), "the honest line");
    assert.doesNotMatch(text(), /Failed to fetch|didn't go through|Done —/);
    await until(() => count("GET", "/api/settings") > before, "and the settings are read again, to find out");
  });

  it("A SNIPE LOOKUP WHOSE ANSWER WAS LOST PLACED NOTHING, and says so", async () => {
    routes["POST /api/chat"] = () => json({ reply: "Going after it.", command: { id: "snipe", args: { query: "pepe", usdgAmount: 5 } } });
    routes["POST /api/snipe"] = dropped;
    await ui.render(h());
    await settle();
    await typeAndSend("snipe pepe with $5");
    await until(() => buttons("Yes, do it").length === 1, "the card");
    await ui.click("Yes, do it");
    await until(() => /couldn't look that coin up/.test(text()), "the honest line");
    assert.doesNotMatch(text(), /Failed to fetch|didn't go through/);
    assert.equal(count("POST", "/api/orders"), 0);
    assert.equal(buttons("Yes, do it").length, 1, "a lookup places nothing, so asking again is one tap");
  });

  it("A SNIPE'S ORDER WHOSE ANSWER WAS LOST is an order like any other", async () => {
    routes["POST /api/chat"] = () => json({ reply: "Going after it.", command: { id: "snipe", args: { query: "pepe", usdgAmount: 5 } } });
    routes["POST /api/snipe"] = () => json({ outcome: "resolved", say: "PEPE is the one you mean.", target: { symbol: "PEPE" }, usdgAmount: 5 });
    routes["POST /api/orders"] = dropped;
    routes["GET /api/orders"] = () => json({ state: "none" });
    await ui.render(h());
    await settle();
    await typeAndSend("snipe pepe with $5");
    await until(() => buttons("Yes, do it").length === 1, "the card");
    await ui.click("Yes, do it");
    await until(() => /couldn't confirm that order reached my key/.test(text()), "the honest line");
    assert.equal(buttons("Yes, do it").length, 0);
  });
});

describe("a proposal never outlives the conversation on screen", () => {
  it("IT IS NEVER STORED, SO A RELOAD SHOWS NO CARD", async () => {
    routes["POST /api/chat"] = () => json({ reply: "Shall I?", command: { id: "go-live", args: {} } });
    await ui.render(h());
    await settle();
    await typeAndSend("go live");
    await until(() => buttons("Yes, do it").length === 1, "the card");
    const kept = localStorage.getItem(KEY) ?? "";
    assert.match(kept, /Shall I\?/);
    assert.doesNotMatch(kept, /go-live|"command"|CMD/, "the offer to act is not in storage");
    await ui.remount(h());
    await settle();
    assert.match(text(), /Shall I\?/, "the words are kept");
    assert.equal(buttons("Yes, do it").length, 0, "the card is not");
  });

  it("AND NOTHING RUNS WITHOUT THE CLICK", async () => {
    routes["POST /api/chat"] = () => json({ reply: "Placing.", command: { id: "buy", args: { symbol: "TSLA", usdgAmount: 5 } } });
    await ui.render(h());
    await settle();
    await typeAndSend("buy");
    await until(() => buttons("Yes, do it").length === 1, "the card");
    await settle(10);
    assert.equal(count("POST", "/api/orders"), 0);
    await ui.click("Not now");
    assert.equal(buttons("Yes, do it").length, 0);
    assert.equal(count("POST", "/api/orders"), 0, "declining calls nothing");
  });
});

describe("whose thread", () => {
  it("THE OUTGOING OWNER'S THREAD IS DELETED, not merely hidden", async () => {
    routes["POST /api/chat"] = () => json({ reply: "Hello, first owner." });
    await ui.render(h({ chatKey: "merrymen.chat.0xaaa" }));
    await settle();
    await typeAndSend("hi");
    await until(() => /Hello, first owner\./.test(text()), "reply");
    assert.ok(localStorage.getItem("merrymen.chat.0xaaa"));
    await ui.render(h({ chatKey: "merrymen.chat.0xbbb" }));
    await settle();
    assert.equal(localStorage.getItem("merrymen.chat.0xaaa"), null);
    assert.doesNotMatch(text(), /first owner/);
    assert.equal(localStorage.getItem("merrymen.chat.0xbbb"), null, "and the old thread was not written under the new key");
  });

  /** One held answer per POST /api/orders, in the order they were asked. */
  function heldOrders() {
    const held: ReturnType<typeof deferred<Response>>[] = [];
    routes["POST /api/orders"] = () => {
      const d = deferred<Response>();
      held.push(d);
      return d.promise;
    };
    routes["GET /api/orders"] = () => json({ id: ORDER_ID, state: "running" });
    return held;
  }
  const card = () => Array.from(ui.container.querySelectorAll(".desk-confirm button")).map((b) => b.textContent);
  const placed = (id = ORDER_ID) => json({ id, queued: true, expiresAt: Date.now() + 300_000, expiresInMs: 300_000 });

  /** Owner A asks for a buy and taps Yes; then B signs in on the same browser and gets a card of their own. */
  async function switchMidConfirm() {
    routes["POST /api/chat"] = () => json({ reply: "I'll place it.", command: { id: "buy", args: { symbol: "TSLA", usdgAmount: 5 } } });
    await ui.render(h({ chatKey: "merrymen.chat.0xaaa" }));
    await settle();
    await typeAndSend("buy $5 of TSLA");
    await until(() => buttons("Yes, do it").length === 1, "A's card");
    await ui.click("Yes, do it");
    assert.deepEqual(card(), ["Doing it…", "Not now"]);
    await ui.render(h({ chatKey: "merrymen.chat.0xbbb" }));
    await settle();
    routes["POST /api/chat"] = () => json({ reply: "Sure.", command: { id: "buy", args: { symbol: "WIF", usdgAmount: 5 } } });
    await typeAndSend("buy $5 of WIF");
    await until(() => /Sure\./.test(text()), "B's reply");
  }

  it("A CONFIRM IN FLIGHT BELONGS TO THE OWNER WHO TAPPED IT — the next owner's card, thread and orders stay theirs", async () => {
    // The guard moved to the controller and was carried across owners: B's
    // card sat at "Doing it…" behind A's request, and when A's POST answered,
    // A's "✓ Confirmed" and "Placed it — …TSLA" were written into B's kept
    // thread, B's thread followed A's order, and B's own proposal was cleared.
    const held = heldOrders();
    await switchMidConfirm();
    assert.deepEqual(card(), ["Yes, do it", "Not now"], "B's card is not held by A's request");
    held[0]!.resolve(placed());
    await settle(20);
    assert.deepEqual(chat.messages.map((m) => m.text), ["buy $5 of WIF", "Sure."], "nothing of A's order is said in B's thread");
    assert.deepEqual((JSON.parse(localStorage.getItem("merrymen.chat.0xbbb")!) as { orders: unknown[] }).orders, [], "B's thread follows no order of A's");
    assert.equal(count("GET", "/api/orders"), 0, "and nobody polls it under B's session");
    assert.deepEqual(card(), ["Yes, do it", "Not now"], "B's own proposal is still there");
  });

  it("AND THE OLD OWNER'S REQUEST ENDING DOES NOT FREE THE NEW OWNER'S CARD mid-order", async () => {
    // B's own confirm in flight is held by B's guard. A's finishing first must
    // not release it, or B's card is ready again while B's POST is out.
    const held = heldOrders();
    await switchMidConfirm();
    await ui.click("Yes, do it");
    assert.deepEqual(card(), ["Doing it…", "Not now"], "B's order is being placed");
    held[0]!.resolve(placed());
    await settle(10);
    assert.deepEqual(card(), ["Doing it…", "Not now"], "and still is, after A's answered");
    held[1]!.resolve(placed("b".repeat(32)));
    await until(() => /Placed it — /.test(text()), "B's order placed");
    assert.equal(count("POST", "/api/orders"), 2, "one order each, nothing twice");
    assert.match(text(), /WIF/);
    assert.doesNotMatch(text(), /TSLA/, "and still nothing of A's");
  });
});

describe("a confirm places its order for the owner who tapped it, or not at all", () => {
  // The scope above bound what a confirm SAYS to the owner who tapped it, but
  // not the order it places. A snipe's lookup answered with no deadline, and
  // then POST /api/orders went out carrying whichever session this browser
  // held by then: B signing in while A's lookup was out got a real order B
  // never confirmed, with no line in B's thread and nothing following it.
  const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const keyOf = (owner: string) => `merrymen.chat.${owner}`;
  const RESOLVED = { outcome: "resolved", say: "PEPE is the one you mean.", target: { symbol: "PEPE" }, usdgAmount: 5 };
  const sentOrders = () => count("POST", "/api/orders");

  /** Owner A asks for a snipe and taps Yes; the lookup is held until the test lets it answer. */
  async function snipeHeldAfterTap() {
    const held = deferred<Response>();
    routes["POST /api/chat"] = () => json({ reply: "Going after it.", command: { id: "snipe", args: { query: "pepe", usdgAmount: 5 } } });
    routes["POST /api/snipe"] = () => held.promise;
    routes["POST /api/orders"] = () => json({ id: ORDER_ID, queued: true, expiresAt: Date.now() + 300_000, expiresInMs: 300_000 });
    routes["GET /api/orders"] = () => json({ id: ORDER_ID, state: "running" });
    await ui.render(h({ chatKey: keyOf(A) }));
    await settle();
    await typeAndSend("snipe pepe with $5");
    await until(() => buttons("Yes, do it").length === 1, "A's card");
    await ui.click("Yes, do it");
    await settle();
    assert.equal(count("POST", "/api/snipe"), 1, "the lookup is out");
    return held;
  }

  it("A LOOKUP THAT ANSWERS AFTER ANOTHER OWNER SIGNED IN PLACES NOTHING — and tells the new owner nothing", async () => {
    const held = await snipeHeldAfterTap();
    await ui.render(h({ chatKey: keyOf(B) }));
    await settle();
    held.resolve(json(RESOLVED));
    await settle(20);
    assert.equal(count("POST", "/api/orders"), 0, "no order goes out under B's session");
    assert.deepEqual(chat.messages.map((m) => m.text), [], "and B's thread holds nothing of A's");
    assert.equal(count("GET", "/api/orders"), 0, "nothing is followed or looked for under B's session");
  });

  it("AN OWNER WHO LEFT AND CAME BACK MID-LOOKUP IS TOLD IT WAS NOT PLACED — the owner changed while it was in flight", async () => {
    const held = await snipeHeldAfterTap();
    await ui.render(h({ chatKey: keyOf(B) }));
    await settle();
    await ui.render(h({ chatKey: keyOf(A) }));
    await settle();
    held.resolve(json(RESOLVED));
    await until(() => /I didn't place that/.test(text()), "A is told");
    assert.equal(count("POST", "/api/orders"), 0, "nothing was placed, not even for the owner who came back");
    assert.match(text(), /nothing was sent/);
    assert.doesNotMatch(text(), /Placed, not filled/);
  });

  it("EVERY REQUEST THAT ACTS NAMES THE OWNER WHO TAPPED, so the route can refuse another session — and the refusal is said", async () => {
    // Another TAB signing in changes the cookie this tab sends without
    // changing its key, which no check in this browser can see. So the card
    // says whose confirm it is, and the route refuses a session that is not
    // that owner's (orders/owner.test.ts, snipe/route.test.ts).
    routes["POST /api/chat"] = () => json({ reply: "Going after it.", command: { id: "snipe", args: { query: "pepe", usdgAmount: 5 } } });
    routes["POST /api/snipe"] = () => json(RESOLVED);
    routes["POST /api/orders"] = () =>
      json({ error: "this browser is signed in with a different wallet now than the one that confirmed this, so nothing was placed." }, 409);
    await ui.render(h({ chatKey: keyOf(A) }));
    await settle();
    await typeAndSend("snipe pepe with $5");
    await until(() => buttons("Yes, do it").length === 1, "the card");
    await ui.click("Yes, do it");
    await until(() => /didn't go through/.test(text()), "the refusal");
    const sent = (path: string) => calls.find((c) => c.method === "POST" && c.url === path)!;
    assert.equal(sent("/api/snipe").body!.owner, A, "the lookup names A");
    assert.equal(sent("/api/orders").body!.owner, A, "and so does the order");
    assert.equal(sent("/api/orders").body!.symbol, "PEPE", "beside the order it always carried");
    assert.match(text(), /different wallet now than the one that confirmed this/, "said in A's thread, in the route's words");
    assert.equal(count("POST", "/api/orders"), 1);
    assert.equal(buttons("Yes, do it").length, 1, "nothing was placed, so the card stays");
  });

  it("AN ORDER WHOSE ANSWER WAS LOST AFTER THE OWNER CHANGED IS NOT LOOKED FOR under the next owner's session", async () => {
    // "What is open on the key" is asked with the session the browser holds
    // NOW — the next owner's — and would find, and follow, their order.
    const held = deferred<Response>();
    routes["POST /api/chat"] = () => json({ reply: "I'll place it.", command: { id: "buy", args: { symbol: "TSLA", usdgAmount: 5 } } });
    routes["POST /api/orders"] = () => held.promise;
    routes["GET /api/orders"] = () => json({ id: ORDER_ID, state: "running" });
    await ui.render(h({ chatKey: keyOf(A) }));
    await settle();
    await typeAndSend("buy $5 of TSLA");
    await until(() => buttons("Yes, do it").length === 1, "A's card");
    await ui.click("Yes, do it");
    await settle();
    assert.equal(sentOrders(), 1, "A's order went out while A was the owner");
    await ui.render(h({ chatKey: keyOf(B) }));
    await settle();
    held.resolve(new Response("bad gateway", { status: 502 }));
    await settle(20);
    assert.equal(count("GET", "/api/orders"), 0, "nothing of B's is looked for on A's behalf");
    assert.deepEqual(chat.messages.map((m) => m.text), []);
  });

  it("A SETTING CONFIRMED FROM THE CHAT NAMES THE OWNER WHO TAPPED — another tab's session is refused, and 'Done' is never said", async () => {
    // The same cross-tab window as the order: a go-live card in A's thread,
    // tapped after B signed in on another tab, went out under B's cookie
    // naming nobody — the route turned B's agent live and A's thread said
    // "Done". The PUT now names A, and the route refuses B's session with
    // this answer (settings/owner.test.ts).
    routes["POST /api/chat"] = () => json({ reply: "I can switch you to real money.", command: { id: "go-live", args: {} } });
    routes["PUT /api/settings"] = () =>
      json({ errors: ["this browser is signed in with a different wallet now than the one that confirmed this, so nothing was changed. Sign back in with that wallet and ask again."] }, 409);
    await ui.render(h({ chatKey: keyOf(A) }));
    await settle();
    await typeAndSend("go live");
    await until(() => buttons("Yes, do it").length === 1, "A's card");
    await ui.click("Yes, do it");
    await until(() => /didn't go through/.test(text()), "the refusal");
    const put = calls.find((c) => c.method === "PUT" && c.url === "/api/settings")!;
    assert.deepEqual(put.body, { liveTradingEnabled: true, owner: A }, "the change it always carried, and whose it is");
    assert.match(text(), /different wallet now than the one that confirmed this, so nothing was changed/, "said in A's thread, in the route's words");
    assert.doesNotMatch(text(), /Done —/);
    assert.equal(buttons("Yes, do it").length, 1, "nothing was changed, so the card stays");
  });

  it("A PLACEMENT LOST UNDER ANOTHER TAB'S SESSION IS LOOKED UP FOR THE OWNER WHO TAPPED — never followed as theirs", async () => {
    // A's order went out after B signed in on another tab (the route refused
    // it: it named A), and that answer was lost. "What is open on my key" then
    // went out under B's cookie naming nobody, found B's order, and A's thread
    // followed it as A's. The lookup names A now, and the route refuses B's
    // session (orders/owner.test.ts) — answered here as B's session answers.
    const B_ORDER = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    routes["POST /api/chat"] = () => json({ reply: "I'll place it.", command: { id: "buy", args: { symbol: "TSLA", usdgAmount: 5 } } });
    routes["POST /api/orders"] = () => new Response("bad gateway", { status: 502 });
    routes["GET /api/orders"] = (url) => {
      const named = new URL(url, "https://app.example.test").searchParams.get("owner");
      return named !== null && named !== B ? json({ error: "not this session's owner" }, 409) : json({ id: B_ORDER, state: "running" });
    };
    await ui.render(h({ chatKey: keyOf(A) }));
    await settle();
    await typeAndSend("buy $5 of TSLA");
    await until(() => buttons("Yes, do it").length === 1, "A's card");
    await ui.click("Yes, do it");
    await until(() => /couldn't confirm that order reached my key/.test(text()), "the honest line");
    await settle(10);
    const asked = calls.filter((c) => c.method === "GET" && c.url.split("?")[0] === "/api/orders");
    assert.deepEqual(asked.map((c) => c.url), [`/api/orders?owner=${A}`], "asked once, naming A");
    assert.doesNotMatch(text(), /order open on my key/);
    assert.equal(chat.messages.some((m) => m.order?.id === B_ORDER), false, "B's order is nowhere in A's thread");
  });

  it("THE OWNER NAMED IS THE WALLET THE THREAD IS KEPT FOR — and self-hosted, nobody", () => {
    const mixed = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
    assert.equal(ownerOfChatKey(chatKeyFor({ hosted: true, address: mixed })), mixed.toLowerCase());
    assert.equal(ownerOfChatKey(`merrymen.chat.${mixed}`), mixed.toLowerCase(), "one wallet, however its key was cased");
    assert.equal(ownerOfChatKey(chatKeyFor({ hosted: false, address: null })), null);
    assert.equal(ownerOfChatKey(chatKeyFor(null)), null);
    assert.equal(ownerOfChatKey("merrymen.chat.0xnot-an-address"), null);
  });

  it("A SNIPE'S LOOKUP HAS A DEADLINE; the order itself is never cut short by one", async () => {
    // Bounding the lookup bounds the time between a tap and its order. The
    // order's own POST is not bounded here: an order whose answer is lost is
    // looked for (orderLost), and a deadline would only manufacture that.
    routes["POST /api/chat"] = () => json({ reply: "Going after it.", command: { id: "snipe", args: { query: "pepe", usdgAmount: 5 } } });
    routes["POST /api/snipe"] = () => json(RESOLVED);
    routes["POST /api/orders"] = () => json({ id: ORDER_ID, queued: true, expiresInMs: 300_000 });
    routes["GET /api/orders"] = () => json({ id: ORDER_ID, state: "running" });
    await ui.render(h());
    await settle();
    await typeAndSend("snipe pepe with $5");
    await until(() => buttons("Yes, do it").length === 1, "the card");
    await ui.click("Yes, do it");
    await until(() => /Placed, not filled/.test(text()), "placed");
    const sent = (path: string) => calls.find((c) => c.method === "POST" && c.url === path)!;
    assert.equal(sent("/api/snipe").deadline, true, "the lookup carries a deadline");
    assert.equal(sent("/api/orders").deadline, false);
    // Self-hosted there is one operator and no sign-in: nobody to name.
    assert.equal("owner" in sent("/api/snipe").body!, false);
    assert.equal("owner" in sent("/api/orders").body!, false);
  });
});

describe("the agent's own fills", () => {
  const fill = (at: number, over: Partial<Thesis> = {}): Thesis => ({
    name: "Shogun",
    slug: null,
    handle: null,
    action: "buy",
    symbol: "CASHCAT",
    sizeUsdg: 5,
    reason: "momentum",
    paper: false,
    head: "trencher",
    at,
    outcome: "landed",
    ...over,
  });

  it("A NEW FILL JOINS THE THREAD ONCE; what was already on the tape does not", async () => {
    await ui.render(h({ moves: [fill(100)], open: false, show: false }));
    await settle();
    await ui.render(h({ moves: [fill(100)], open: false }));
    await settle();
    assert.doesNotMatch(text(), /CASHCAT · Filled/, "history is not news");
    await ui.render(h({ moves: [fill(200), fill(100)], open: false }));
    await until(() => /\$5\.00 CASHCAT · Filled/.test(text()), "the new fill");
    assert.equal(unread(), "true");
    await ui.render(h({ moves: [fill(200), fill(100)], open: false }));
    await settle();
    assert.equal((text().match(/CASHCAT · Filled/g) ?? []).length, 1, "once, however many refreshes");
  });

  it("A FULL THREAD DOES NOT REPLAY ITS OLDEST FILLS AT THE BOTTOM", async () => {
    // A thread at its limit whose oldest lines are fills the tape still holds.
    // One more exchange trims two of them; they must stay gone, not come back
    // underneath the reply as if they had just filled.
    const tape = [fill(103, { symbol: "WIF" }), fill(102, { symbol: "PEPE" }), fill(101)];
    const events = [...tape].reverse().map((f) => ({
      id: `fill-${tradeKeyOf(f)}`,
      role: "event",
      at: f.at! * 1000,
      text: `$5.00 ${f.symbol} · Filled`,
      side: "buy",
      tradeKey: tradeKeyOf(f),
    }));
    const chatter = Array.from({ length: MAX_MESSAGES - events.length }, (_, i) => ({
      id: `c${i}`,
      role: i % 2 ? "agent" : "owner",
      at: 200_000 + i,
      text: `line ${i}`,
    }));
    localStorage.setItem(KEY, JSON.stringify({ v: 2, messages: [...events, ...chatter], orders: [], since: 100 }));
    routes["POST /api/chat"] = () => json({ reply: "Still here." });
    await ui.render(h({ moves: tape }));
    await settle();
    assert.equal((text().match(/· Filled/g) ?? []).length, 3);
    await typeAndSend("still there?");
    await until(() => /Still here\./.test(text()), "reply");
    await settle(10);
    assert.equal(chat.messages.length, MAX_MESSAGES);
    assert.deepEqual(
      chat.messages.filter((m) => m.role === "event").map((m) => m.text),
      ["$5.00 WIF · Filled"],
      "the two trimmed fills stay trimmed",
    );
    assert.equal(chat.messages.at(-1)!.text, "Still here.", "and the reply is the newest line");
  });

  it("A PAPER FILL IS NOT ANNOUNCED — no line, no unread dot", async () => {
    await ui.render(h({ moves: [fill(100)], open: false, show: false }));
    await settle();
    await ui.render(h({ moves: [fill(200, { paper: true }), fill(100)], open: false }));
    await settle(10);
    assert.doesNotMatch(text(), /Filled/);
    assert.equal(unread(), "false");
  });

  it("A CHAT SELL IS ONE LINE, with the receipt's own figure", async () => {
    // The reviewer's case, end to end: the receipt says what the sell
    // returned, the tape says the order's size, and they are one trade.
    const now = Math.floor(Date.now() / 1000);
    let answered = false;
    routes["POST /api/chat"] = () => json({ reply: "Selling.", command: { id: "sell", args: { symbol: "TSLA", usdgAmount: 5 } } });
    routes["POST /api/orders"] = () => json({ id: ORDER_ID, queued: true, expiresInMs: 300_000 });
    routes["GET /api/orders"] = () =>
      json(
        answered
          ? { id: ORDER_ID, state: "done", result: "sold TSLA for 4.97 USDG", receipt: { ...FILLED, side: "sell", usdgActual: 4.97 } }
          : { id: ORDER_ID, state: "running" },
      );
    await ui.render(h({ moves: [] }));
    await settle();
    await typeAndSend("sell $5 of TSLA");
    await until(() => buttons("Yes, do it").length === 1, "the card");
    await ui.click("Yes, do it");
    await until(() => /Placed it —/.test(text()), "placed");
    const tape = [fill(now + 1, { action: "sell", symbol: "TSLA", sizeUsdg: 5.01 })];
    await ui.render(h({ moves: tape }));
    await until(() => /· Filled/.test(text()), "the fill, off the tape");
    answered = true;
    await until(() => /sold TSLA for 4\.97 USDG/.test(text()), "the receipt");
    await settle(5);
    await ui.render(h({ moves: tape }));
    await settle(5);
    assert.equal((text().match(/· Filled/g) ?? []).length, 1, "one trade, one line");
    assert.match(text(), /\$4\.97 TSLA · Filled/);
    assert.doesNotMatch(text(), /\$5\.01/, "and one figure: the receipt's");
  });

  /**
   * Place a chat sell of TSLA from a browser whose clock is `aheadMin` off,
   * and bring its fill and its answer in the given order. POST's reply carries
   * the server's true times, as the route writes them.
   */
  async function skewedSell(aheadMin: number, tapeFirst: boolean) {
    clockAhead = aheadMin * 60_000;
    const now = Math.floor(Date.now() / 1000);
    let answered = false;
    routes["POST /api/chat"] = () => json({ reply: "Selling.", command: { id: "sell", args: { symbol: "TSLA", usdgAmount: 5 } } });
    routes["POST /api/orders"] = () => json({ id: ORDER_ID, queued: true, expiresAt: Date.now() + 300_000, expiresInMs: 300_000 });
    routes["GET /api/orders"] = () =>
      json(
        answered
          ? { id: ORDER_ID, state: "done", result: "sold TSLA", receipt: { ...FILLED, side: "sell", usdgActual: null } }
          : { id: ORDER_ID, state: "running" },
      );
    await ui.render(h({ moves: [] }));
    await settle();
    await typeAndSend("sell $5 of TSLA");
    await until(() => buttons("Yes, do it").length === 1, "the card");
    await ui.click("Yes, do it");
    await until(() => /Placed it —/.test(text()), "placed");
    const tape = [fill(now + 1, { action: "sell", symbol: "TSLA", sizeUsdg: 5.01 })];
    if (tapeFirst) {
      await ui.render(h({ moves: tape }));
      await until(() => /· Filled/.test(text()), "the fill, off the tape");
    }
    answered = true;
    await until(() => /sold TSLA/.test(text()), "the receipt");
    await settle(5);
    await ui.render(h({ moves: tape }));
    await settle(5);
  }

  for (const [aheadMin, tapeFirst] of [[5, false], [-5, true], [11, true]] as const) {
    it(`A BROWSER CLOCK ${aheadMin} MINUTES OFF STILL MAKES A CHAT SELL ONE LINE (${tapeFirst ? "tape" : "receipt"} first) — its life is read on the server's clock`, async () => {
      // Every line here is stamped by this browser and the fill by the worker.
      // With two minutes of slack between them, a browser three minutes off
      // showed one sell as two "Filled" lines. POST's reply carries the
      // server's own placement time, and the placing line keeps it.
      await skewedSell(aheadMin, tapeFirst);
      assert.equal((text().match(/· Filled/g) ?? []).length, 1, "one trade, one line");
      assert.equal(chat.messages.filter((m) => m.role === "event").length, 0);
    });
  }

  it("with the tape unread, nothing is merged and no watermark is set", async () => {
    await ui.render(h({ moves: null }));
    await settle();
    assert.equal(localStorage.getItem(KEY), null);
    assert.equal(chat.messages.length, 0);
  });
});

describe("one proposal is one order", () => {
  const card = () => {
    routes["POST /api/chat"] = () => json({ reply: "I'll place it.", command: { id: "buy", args: { symbol: "TSLA", usdgAmount: 5 } } });
    routes["GET /api/orders"] = () => json({ id: ORDER_ID, state: "running" });
    const held = deferred<Response>();
    routes["POST /api/orders"] = () => held.promise;
    return held;
  };

  it("THE CARD STAYS BUSY WHEN THE SCREEN COMES BACK — a second tap places nothing", async () => {
    // The guard was the screen's own state and the proposal the App's, so a
    // phone tab switch (or the dock closed with Escape and reopened) mid-POST
    // brought the same card back ready, and a tap placed it again.
    const held = card();
    await ui.render(h());
    await settle();
    await typeAndSend("buy $5 of TSLA");
    await until(() => buttons("Yes, do it").length === 1, "the card");
    await ui.click("Yes, do it");
    assert.equal(buttons("Doing it…").length, 1);
    await ui.render(h({ show: false }));
    await ui.render(h());
    await settle();
    assert.equal(buttons("Yes, do it").length, 0, "the new mount knows the card is being carried out");
    assert.equal(buttons("Doing it…").length, 1);
    for (const b of Array.from(ui.container.querySelectorAll(".desk-confirm button")) as HTMLButtonElement[]) {
      await act(async () => b.click());
    }
    held.resolve(json({ id: ORDER_ID, queued: true, expiresInMs: 300_000 }));
    await until(() => /Placed it —/.test(text()), "placed");
    await settle();
    assert.equal(count("POST", "/api/orders"), 1);
    assert.equal((text().match(/Placed it —/g) ?? []).length, 1);
  });

  it("TWO SCREENS ON AT ONCE SHARE ONE GUARD", async () => {
    // Desktop can draw the /agent body and the dock together, one proposal on
    // both. Tapped on each, it is still one order.
    const held = card();
    await ui.render(h({ twice: true }));
    await settle();
    await typeAndSend("buy $5 of TSLA");
    await until(() => buttons("Yes, do it").length === 2, "the card, on both screens");
    await act(async () => {
      for (const b of buttons("Yes, do it")) b.click();
    });
    held.resolve(json({ id: ORDER_ID, queued: true, expiresInMs: 300_000 }));
    await until(() => /Placed it —/.test(text()), "placed");
    await settle();
    assert.equal(count("POST", "/api/orders"), 1);
  });
});

describe("a confirm still running touches only its own card", () => {
  // MO-5. The composer stays open while a card is carried out, and a question
  // sent meanwhile puts up its own card. A snipe's lookup can answer up to
  // SNIPE_LOOKUP_MS later, and when it did, its confirm cleared whatever card
  // was up — the newer one, before the owner had read it or tapped it.
  const card = () => Array.from(ui.container.querySelectorAll(".desk-confirm button")).map((b) => b.textContent);
  const cardSays = () => ui.container.querySelector(".desk-confirm-say")?.textContent ?? null;

  /** A snipe card is confirmed and its lookup held; a buy question sent meanwhile puts up its own card. */
  async function newerCardMidLookup() {
    const held = deferred<Response>();
    routes["POST /api/chat"] = (_url, init) =>
      /snipe/.test((JSON.parse(String(init?.body)) as { message: string }).message)
        ? json({ reply: "Going after it.", command: { id: "snipe", args: { query: "pepe", usdgAmount: 5 } } })
        : json({ reply: "I can do that.", command: { id: "buy", args: { symbol: "WIF", usdgAmount: 5 } } });
    routes["POST /api/snipe"] = () => held.promise;
    routes["POST /api/orders"] = () => json({ id: ORDER_ID, queued: true, expiresAt: Date.now() + 300_000, expiresInMs: 300_000 });
    routes["GET /api/orders"] = () => json({ id: ORDER_ID, state: "running" });
    await ui.render(h());
    await settle();
    await typeAndSend("snipe pepe with $5");
    await until(() => buttons("Yes, do it").length === 1, "the snipe card");
    await ui.click("Yes, do it");
    await settle();
    assert.equal(count("POST", "/api/snipe"), 1, "the lookup is out");
    await typeAndSend("buy $5 of WIF");
    await until(() => /I can do that\./.test(text()), "the newer reply");
    const newer = cardSays();
    assert.match(newer ?? "", /WIF/, "the newer question's card is up");
    return { held, newer };
  }

  it("A LOOKUP THAT ANSWERS LATE NEVER CLEARS THE NEWER CARD — and places only the order that was confirmed", async () => {
    const { held, newer } = await newerCardMidLookup();
    held.resolve(json({ outcome: "resolved", say: "PEPE is the one you mean.", target: { symbol: "PEPE" }, usdgAmount: 5 }));
    await until(() => /Placed, not filled/.test(text()), "the snipe's order placed");
    await settle();
    assert.equal(cardSays(), newer, "the WIF card is still the one up");
    assert.deepEqual(card(), ["Yes, do it", "Not now"], "and ready to tap once the snipe is done");
    const orders = calls.filter((c) => c.method === "POST" && c.url === "/api/orders");
    assert.deepEqual(orders.map((c) => c.body!.symbol), ["PEPE"], "one order: the confirmed snipe's coin, not the newer card's");
  });

  it("NOR DOES A LOOKUP THAT ANSWERS WITH A QUESTION OF ITS OWN", async () => {
    const { held, newer } = await newerCardMidLookup();
    held.resolve(json({ outcome: "ambiguous", say: "Two coins answer to pepe — which one?" }));
    await until(() => /Two coins answer to pepe/.test(text()), "the lookup's answer");
    await settle();
    assert.equal(cardSays(), newer, "the WIF card is still the one up");
    assert.equal(count("POST", "/api/orders"), 0, "and nothing was placed");
  });

  it("while its own card is still up, a confirm clears it as before", async () => {
    routes["POST /api/chat"] = () => json({ reply: "Going after it.", command: { id: "snipe", args: { query: "pepe", usdgAmount: 5 } } });
    routes["POST /api/snipe"] = () => json({ outcome: "ambiguous", say: "Two coins answer to pepe — which one?" });
    await ui.render(h());
    await settle();
    await typeAndSend("snipe pepe with $5");
    await until(() => buttons("Yes, do it").length === 1, "the snipe card");
    await ui.click("Yes, do it");
    await until(() => /Two coins answer to pepe/.test(text()), "the lookup's answer");
    await settle();
    assert.equal(cardSays(), null, "the card it carried out is gone");
  });
});

describe("nothing is done twice by accident", () => {
  it("TWO SENDS BEFORE THE REPLY ARE ONE MESSAGE", async () => {
    // A double tap on Send, both landing before the screen has redrawn with
    // the typing bubble (and so before the button knows to disable itself):
    // the second must not become a second question.
    const s = stream();
    routes["POST /api/chat"] = () => s.response;
    await ui.render(h());
    await settle();
    await act(async () => chat.setDraft("hello there"));
    await act(async () => {
      const send = ui.container.querySelector('button[aria-label="Send message"]') as HTMLButtonElement;
      send.click();
      send.click();
    });
    s.done({ reply: "Hello." });
    await until(() => /Hello\./.test(text()), "reply");
    await settle();
    assert.equal(count("POST", "/api/chat"), 1);
    const asked = Array.from(ui.container.querySelectorAll(".desk-question")).filter((q) => q.textContent === "hello there");
    assert.equal(asked.length, 1);
  });

  it("AN ORDER IS FOLLOWED ONCE, however often the kept orders change", async () => {
    // Two orders can be kept at once — the slot is released at a deadline even
    // when nothing answered. When one answers, the list changes and the follow
    // effect runs again; the other must not gain a second follower, or its
    // answer is said twice.
    const A = "a".repeat(32);
    const B = "b".repeat(32);
    const until_ = Date.now() + 300_000;
    localStorage.setItem(KEY, JSON.stringify({ v: 2, messages: [], orders: [{ id: A, until: until_ }, { id: B, until: until_ }], since: null }));
    let bAnswered = false;
    routes["GET /api/orders"] = (url) => {
      const id = new URL(url, "https://app.example.test").searchParams.get("id");
      if (id === A) return json({ id: A, state: "done", result: "sold 2.00 USDG of WIF" });
      return json(bAnswered ? { id: B, state: "done", result: "bought 5.00 USDG of TSLA" } : { id: B, state: "running" });
    };
    let outcomes = 0;
    await ui.render(h({ onOutcome: () => outcomes++ }));
    await until(() => /sold 2\.00 USDG of WIF/.test(text()), "the first answer");
    await settle(5);
    bAnswered = true;
    await until(() => /bought 5\.00 USDG of TSLA/.test(text()), "the second answer");
    await settle(10);
    assert.equal((text().match(/bought 5\.00 USDG of TSLA/g) ?? []).length, 1, "said once");
    assert.equal(outcomes, 2, "and the book re-read once per order");
  });
});
