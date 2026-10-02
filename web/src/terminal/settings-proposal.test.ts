import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { LLM_PROVIDERS, SETTINGS_DEFAULTS, encodeProposalLink } from "@merrymen/core";
import type { SettingsView } from "@/app/api/settings/route";

// TELL YOUR AGENT, THEN APPROVE — the panel at the top of Settings. The Telegram agent answers "turn on
// launchpad buying" with an Open Settings button to /settings#launchpad-buying,
// and the strip links to /settings#telegram. Both controls sit inside groups
// that start closed, so before this the link reached a page that seemed not to
// have the setting at all ("I don't see launchpad setting anywhere?").

const OWNER = `0x${"a".repeat(40)}`;
let testDom: typeof import("./test-dom").testDom;
let json: typeof import("./test-dom").json;
let Settings: typeof import("./screens/Settings").default;
let ui: ReturnType<typeof testDom>;
const originalFetch = globalThis.fetch;

before(async () => {
  const boot = new JSDOM("<!doctype html><p></p>", { pretendToBeVisual: true });
  const g = globalThis as Record<string, unknown>;
  g.window = boot.window;
  g.document = boot.window.document;
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
  try {
    Settings = createRequire(import.meta.url)(settingsPath).default;
  } finally {
    intercepted.mock.restore();
    Reflect.deleteProperty(g, "window");
    Reflect.deleteProperty(g, "document");
    boot.window.close();
  }
});

let stored: Record<string, unknown> = {};
let writes: Record<string, unknown>[] = [];
let refuseWith: string[] | null = null;

function view(): SettingsView {
  const secret = { set: false, hint: null };
  return {
    bundlerApiKey: secret, groqApiKey: secret, anthropicApiKey: secret,
    llmApiKey: secret, rialtoApiKey: secret, telegramBotToken: secret,
    telegramTranscribeKey: secret, virtualsApiKey: secret, bitqueryApiKey: secret,
    merrymenToken: secret,
    values: { ...stored },
    defaults: structuredClone(SETTINGS_DEFAULTS), knownSymbols: ["AAPL"],
    officialCoins: [], strategies: { builtin: ["steady-basket", "trencher"], custom: [] },
    llmProviders: LLM_PROVIDERS, owner: OWNER,
  };
}

beforeEach(() => {
  stored = { strategy: "steady-basket", liveTradingEnabled: false, customTokens: [], buyPerTickUsdg: 25, strategistStopLossBps: 0 };
  writes = [];
  refuseWith = null;
  ui = testDom();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "/api/auth/session") return json({ hosted: true, address: OWNER });
    if (url === "/api/settings" && method === "GET") return json(view());
    if (url === "/api/settings" && method === "PUT") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      writes.push(body);
      if (refuseWith) return json({ errors: refuseWith }, 400);
      const { owner: _o, ...values } = body;
      stored = { ...stored, ...values };
      return json({ ok: true });
    }
    if (url === "/api/telegram") return json({});
    if (url === "/api/models") return json({ code: "missing_key" }, 400);
    throw new Error(`Unexpected network boundary: ${method} ${url}`);
  }) as typeof fetch;
});

afterEach(async () => {
  await ui.close();
  globalThis.fetch = originalFetch;
});

/**
 * Arrive at /settings with the link already in the address. jsdom announces a
 * hash set from script as a `hashchange` a task later; let that pass before
 * the page mounts, so these tests reach the on-load path and are not rescued
 * by the listener the page adds for later changes.
 */
async function arriveWith(hash: string) {
  let announced = false;
  ui.dom.window.addEventListener("hashchange", () => { announced = true; }, { once: true });
  ui.dom.window.location.hash = hash;
  for (let i = 0; i < 20 && !announced; i++) await new Promise((r) => ui.dom.window.setTimeout(r, 0));
  assert.ok(announced, "jsdom delivered the hash change before mount");
}

async function mount() {
  await ui.render(React.createElement(Settings, { onFund: () => {}, slug: null, onSaved: () => {} }));
}

const panel = () => {
  const el = ui.container.querySelector<HTMLElement>("#proposal");
  assert.ok(el, "the panel is on the page");
  return el;
};
const proposed = () => panel().querySelector<HTMLElement>('[aria-label="Proposed changes"]');
const rowsText = () => [...(proposed()?.querySelectorAll("li[data-key]") ?? [])].map((li) => li.textContent ?? "");

async function say(text: string) {
  const input = panel().querySelector<HTMLInputElement>('input[aria-label="Tell your agent how to work"]');
  assert.ok(input);
  const setter = Object.getOwnPropertyDescriptor(ui.dom.window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, text);
    input.dispatchEvent(new ui.dom.window.Event("input", { bubbles: true }));
  });
  await ui.click("Show me the changes");
}

async function press(label: RegExp) {
  const b = [...panel().querySelectorAll("button")].find((x) => label.test(x.textContent ?? ""));
  assert.ok(b, `a button matching ${label}`);
  await act(async () => {
    b.click();
  });
  // The save is a fetch, then a re-read: let both settle.
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => ui.dom.window.setTimeout(r, 0)); });
}

describe("tell your agent how to work, then approve", () => {
  it("is the first thing on the page", async () => {
    await mount();
    const first = ui.container.querySelector("#proposal");
    const form = ui.container.querySelector("fieldset");
    assert.ok(first && form);
    assert.ok(first.compareDocumentPosition(form) & ui.dom.window.Node.DOCUMENT_POSITION_FOLLOWING, "above the form");
    assert.match(first.textContent ?? "", /Tell your agent how to work/);
  });

  it("says what the agent is doing at a glance, in the chat's own words", async () => {
    await mount();
    const glance = panel().querySelector('[aria-label="At a glance"]');
    assert.ok(glance);
    const lines = [...glance.querySelectorAll("li")].map((li) => li.textContent);
    assert.equal(lines[0], "Real money: off — practising with simulated cash", "practice is the shipped default");
    assert.match(lines[1] ?? "", /^Strategy: steady-basket · buys /);
    assert.equal(lines[2], "Each buy: $25.00 · stop loss: off · take profit: off");
    assert.match(lines[3] ?? "", /^Launchpad buying: off/);
    assert.match(lines[4] ?? "", /^Telegram trade messages: /);
  });

  it("turns a sentence into before-and-after, and saves exactly those keys for this owner on Approve", async () => {
    await mount();
    await say("make each buy $20 and stop loss at 8%");
    assert.deepEqual(rowsText(), ["amount per buy: $25.00 → $20.00", "stop loss at: off → 8%"]);
    assert.equal(writes.length, 0, "nothing is saved by reading a sentence");
    await press(/^Approve all 2$/);
    assert.deepEqual(writes, [{ buyPerTickUsdg: 20, strategistStopLossBps: 800, owner: OWNER }]);
    assert.match(panel().textContent ?? "", /✓ Saved — amount per buy: \$20\.00 · stop loss at: 8%/);
    assert.equal(proposed(), null, "the proposal is gone once applied");
  });

  it("says when it found nothing to change, and saves nothing", async () => {
    await mount();
    await say("what a lovely day");
    assert.match(panel().textContent ?? "", /couldn.t find a setting to change/);
    assert.equal(writes.length, 0);
  });

  it("A REFUSED SAVE IS NEVER CLAIMED AS SAVED", async () => {
    refuseWith = ["buyPerTickUsdg must be at most 100000"];
    await mount();
    await say("each buy $20");
    await press(/^Approve$/);
    assert.match(panel().textContent ?? "", /buyPerTickUsdg must be at most 100000/);
    assert.doesNotMatch(panel().textContent ?? "", /✓ Saved/);
  });
});

describe("the agent's Review & approve link lands here", () => {
  const arriveWith = (search: string) => ui.dom.window.history.replaceState(null, "", `/settings${search}#proposal`);

  it("shows the agent's suggestion with its warning, and that anyone could have made the link", async () => {
    arriveWith(`?propose=${encodeProposalLink([{ key: "liveTradingEnabled", after: true }, { key: "buyPerTickUsdg", after: 15 }])}`);
    await mount();
    assert.match(proposed()?.textContent ?? "", /Your agent suggested these changes/);
    assert.match(proposed()?.textContent ?? "", /anyone can make a link like this/);
    assert.deepEqual(rowsText(), ["live trading (real money): off → on⚠️ This lets the agent spend real money.", "amount per buy: $25.00 → $15.00"]);
    assert.equal(writes.length, 0, "arriving changes nothing");
    await press(/^Approve all 2$/);
    assert.deepEqual(writes, [{ liveTradingEnabled: true, buyPerTickUsdg: 15, owner: OWNER }]);
    assert.equal(new URL(ui.dom.window.location.href).searchParams.get("propose"), null, "the link is spent");
  });

  it("A HAND-MADE LINK CANNOT SLIP IN A SECRET, A BAD VALUE OR AN UNKNOWN KEY", async () => {
    const forged = Buffer.from(JSON.stringify({ v: 1, changes: [["llmApiKey", "sk-steal"], ["slippageBps", 50_000], ["notASetting", 1], ["takeProfitBps", 2500]] })).toString("base64url");
    arriveWith(`?propose=${forged}`);
    await mount();
    // "off", not "not set": a never-saved setting reads as its default, which is what the agent runs on.
    assert.deepEqual(rowsText(), ["take profit at: off → 25%"]);
    assert.doesNotMatch(panel().textContent ?? "", /sk-steal/);
  });

  it("Dismiss leaves everything as it was, and spends the link", async () => {
    arriveWith(`?propose=${encodeProposalLink([{ key: "buyPerTickUsdg", after: 15 }])}`);
    await mount();
    await press(/^Dismiss$/);
    assert.equal(proposed(), null);
    assert.equal(writes.length, 0);
    assert.equal(new URL(ui.dom.window.location.href).searchParams.get("propose"), null);
  });
});
