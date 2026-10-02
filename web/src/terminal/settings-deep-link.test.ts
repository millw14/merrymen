import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { LLM_PROVIDERS, SETTINGS_DEFAULTS } from "@merrymen/core";
import type { SettingsView } from "@/app/api/settings/route";

// A LINK TO ONE SETTING HAS TO LAND ON IT. The Telegram agent answers "turn on
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

function view(): SettingsView {
  const secret = { set: false, hint: null };
  return {
    bundlerApiKey: secret, groqApiKey: secret, anthropicApiKey: secret,
    llmApiKey: secret, rialtoApiKey: secret, telegramBotToken: secret,
    telegramTranscribeKey: secret, virtualsApiKey: secret, bitqueryApiKey: secret,
    merrymenToken: secret,
    values: { strategy: "steady-basket", liveTradingEnabled: false, customTokens: [] },
    defaults: structuredClone(SETTINGS_DEFAULTS), knownSymbols: ["AAPL"],
    officialCoins: [], strategies: { builtin: ["steady-basket", "trencher"], custom: [] },
    llmProviders: LLM_PROVIDERS, owner: OWNER,
  };
}

beforeEach(() => {
  ui = testDom();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "/api/auth/session") return json({ hosted: true, address: OWNER });
    if (url === "/api/settings" && method === "GET") return json(view());
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

function groupOf(id: string): HTMLDetailsElement {
  const target = ui.container.querySelector<HTMLElement>(`#${id}`);
  assert.ok(target, `#${id} is on the Settings page`);
  const group = target.closest("details");
  assert.ok(group, `#${id} sits in a collapsible group`);
  return group;
}

describe("a link to one setting opens the group it sits in", () => {
  it("lands on launchpad buying, under the name the agent uses for it", async () => {
    await arriveWith("#launchpad-buying");
    await mount();
    const group = groupOf("launchpad-buying");
    assert.equal(group.open, true, "Custom tokens & discovery is opened for the link");
    assert.match(group.querySelector("summary")?.textContent ?? "", /Custom tokens & discovery/);
    const block = ui.container.querySelector("#launchpad-buying")!;
    assert.match(block.textContent ?? "", /launchpad buying/i);
    const label = [...group.querySelectorAll(".mm-label")].find((el) => /launchpad buying/i.test(el.textContent ?? ""));
    assert.ok(label, "the switch itself is labelled launchpad buying");
    assert.equal(label.closest("label")?.querySelector("input")?.type, "checkbox");
  });

  it("leaves every group closed when the page is opened without a link to a setting", async () => {
    await mount();
    assert.equal(groupOf("launchpad-buying").open, false);
    const telegram = ui.container.querySelector<HTMLDetailsElement>("details#telegram");
    assert.ok(telegram);
    assert.equal(telegram.open, false);
  });

  it("opens a group that is itself the target, and follows a later change of link", async () => {
    await mount();
    const telegram = ui.container.querySelector<HTMLDetailsElement>("details#telegram");
    assert.ok(telegram);
    assert.equal(telegram.open, false);
    await act(async () => {
      ui.dom.window.location.hash = "#telegram";
      ui.dom.window.dispatchEvent(new ui.dom.window.HashChangeEvent("hashchange"));
    });
    assert.equal(telegram.open, true);
  });

  it("ignores a link to nothing on the page, and one that cannot be decoded", async () => {
    await arriveWith("#%E0%A4%A");
    await mount();
    await act(async () => {
      ui.dom.window.location.hash = "#no-such-setting";
      ui.dom.window.dispatchEvent(new ui.dom.window.HashChangeEvent("hashchange"));
    });
    assert.equal(groupOf("launchpad-buying").open, false);
  });
});
