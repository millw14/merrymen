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
let Link: typeof import("./Link").default;
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
    Link = createRequire(import.meta.url)(fileURLToPath(new URL("./Link.tsx", import.meta.url))).default;
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
  ui.dom.window.history.replaceState(null, "", "/settings");
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

async function mount(links: React.ReactNode = null) {
  await ui.render(React.createElement(React.Fragment, null, links,
    React.createElement(Settings, { onFund: () => {}, slug: null, onSaved: () => {} })));
}

function settingLinks() {
  return React.createElement("nav", null, ...["telegram", "trencher-mode", "launchpad-buying"].map(id =>
    React.createElement(Link, { key: id, id: `jump-${id}`, href: `/settings#${id}` }, id)));
}

async function follow(id: string) {
  const link = ui.container.querySelector<HTMLAnchorElement>(`#jump-${id}`);
  assert.ok(link);
  await act(async () => { link.click(); });
}

async function traverse(direction: "back" | "forward") {
  await act(async () => {
    await new Promise<void>((resolve, reject) => {
      const timer = ui.dom.window.setTimeout(() => reject(new Error(`No hashchange after history.${direction}()`)), 1000);
      ui.dom.window.addEventListener("hashchange", () => {
        ui.dom.window.clearTimeout(timer);
        resolve();
      }, { once: true });
      ui.dom.window.history[direction]();
    });
  });
}

function groupOf(id: string): HTMLDetailsElement {
  const target = ui.container.querySelector<HTMLElement>(`#${id}`);
  assert.ok(target, `#${id} is on the Settings page`);
  const group = target.closest("details");
  assert.ok(group, `#${id} sits in a collapsible group`);
  return group;
}

describe("a link to one setting opens the group it sits in", () => {
  it("follows the real in-place Link on an already mounted Settings screen", async () => {
    await mount(settingLinks());
    const scrolled: string[] = [];
    for (const id of ["telegram", "trencher-mode", "launchpad-buying"]) {
      ui.container.querySelector<HTMLElement>(`#${id}`)!.scrollIntoView = () => { scrolled.push(id); };
    }
    const telegram = groupOf("telegram");
    assert.equal(telegram.open, false);
    await follow("telegram");
    assert.equal(ui.dom.window.location.hash, "#telegram");
    assert.equal(telegram.open, true);
    assert.deepEqual(scrolled, ["telegram"]);

    // A user can close the drawer and return to the same remedy link.
    telegram.open = false;
    const entries = ui.dom.window.history.length;
    await follow("telegram");
    assert.equal(telegram.open, true);
    assert.equal(ui.dom.window.history.length, entries, "the same anchor does not add duplicate Back entries");
    await follow("trencher-mode");
    await follow("launchpad-buying");
    assert.equal(groupOf("launchpad-buying").open, true);
    assert.deepEqual(scrolled, ["telegram", "telegram", "trencher-mode", "launchpad-buying"]);
  });

  it("Back and Forward restore and reveal the previously selected setting", async () => {
    await mount(settingLinks());
    const scrolled: string[] = [];
    for (const id of ["telegram", "trencher-mode"]) {
      ui.container.querySelector<HTMLElement>(`#${id}`)!.scrollIntoView = () => { scrolled.push(id); };
    }
    await follow("telegram");
    await follow("trencher-mode");
    groupOf("telegram").open = false;
    await traverse("back");
    assert.equal(ui.dom.window.location.hash, "#telegram");
    assert.equal(groupOf("telegram").open, true);
    await traverse("forward");
    assert.equal(ui.dom.window.location.hash, "#trencher-mode");
    assert.deepEqual(scrolled, ["telegram", "trencher-mode", "telegram", "trencher-mode"]);
  });

  it("keeps cross-screen anchor arrival for the Settings mount effect", async () => {
    ui.dom.window.history.replaceState(null, "", "/home");
    await ui.render(settingLinks());
    let earlyHashChanges = 0;
    const count = () => { earlyHashChanges++; };
    ui.dom.window.addEventListener("hashchange", count);
    await follow("telegram");
    assert.equal(ui.dom.window.location.pathname, "/settings");
    assert.equal(ui.dom.window.location.hash, "#telegram");
    assert.equal(earlyHashChanges, 0, "do not send the new screen's anchor to the old screen");
    ui.dom.window.removeEventListener("hashchange", count);
    await mount(settingLinks());
    assert.equal(groupOf("telegram").open, true, "the read-completion effect still reveals a newly mounted Settings screen");
  });

  it("keeps ordinary Link navigation in place without spurious anchor events", async () => {
    await ui.render(React.createElement(Link, { id: "jump-profile", href: "/you" }, "Profile"));
    let hashChanges = 0;
    ui.dom.window.addEventListener("hashchange", () => { hashChanges++; });
    const entries = ui.dom.window.history.length;
    await follow("profile");
    assert.equal(ui.dom.window.location.pathname, "/you");
    assert.equal(ui.dom.window.history.length, entries + 1);
    assert.equal(hashChanges, 0);
    await follow("profile");
    assert.equal(ui.dom.window.history.length, entries + 1, "the current screen remains a no-op");
  });

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
