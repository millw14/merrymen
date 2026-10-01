import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { LLM_PROVIDERS, SETTINGS_DEFAULTS } from "@merrymen/core";
import type { SettingsView } from "@/app/api/settings/route";

const OWNER = `0x${"a".repeat(40)}`;
const OTHER_OWNER = `0x${"b".repeat(40)}`;
let testDom: typeof import("./test-dom").testDom;
let json: typeof import("./test-dom").json;
let Settings: typeof import("./screens/Settings").default;
let ui: ReturnType<typeof testDom>;
const originalFetch = globalThis.fetch;
let server: SettingsView;
let writes: Record<string, unknown>[];
let savedCalls: number;
let writeResponse: (() => Response | Promise<Response>) | undefined;
let readback: (() => Response) | undefined;

before(async () => {
  // React DOM checks input-event support when it first loads. Supply a DOM
  // before importing the harness so typing exercises real React onChange.
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
      // These independent account panels are outside this form's save path.
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

function fixture(): SettingsView {
  const secret = { set: false, hint: null };
  return {
    bundlerApiKey: secret, groqApiKey: secret, anthropicApiKey: secret,
    llmApiKey: secret, rialtoApiKey: secret, telegramBotToken: secret,
    telegramTranscribeKey: secret, virtualsApiKey: secret, bitqueryApiKey: secret,
    merrymenToken: secret,
    values: {
      strategy: "steady-basket", tickSeconds: 60, assetMode: "stocks",
      liveTradingEnabled: false, trencherLiveEnabled: false, trencherFastEnabled: false,
      discoveryEnabled: false, officialCoinsEnabled: false,
      basketSymbols: ["AAPL"], customTokens: [],
      slippageBps: 100, llmMaxActionUsdg: 10, scoutBudgetUsdg: 0,
    },
    defaults: structuredClone(SETTINGS_DEFAULTS), knownSymbols: ["AAPL"],
    officialCoins: [], strategies: { builtin: ["steady-basket", "trencher"], custom: [] },
    llmProviders: LLM_PROVIDERS, owner: OWNER,
  };
}

beforeEach(() => {
  ui = testDom();
  server = fixture();
  writes = [];
  savedCalls = 0;
  writeResponse = undefined;
  readback = undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "/api/auth/session") return json({ hosted: true, address: OWNER });
    if (url === "/api/settings" && method === "GET") return writes.length && readback ? readback() : json(server);
    if (url === "/api/settings" && method === "PUT") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      writes.push(body);
      if (writeResponse) return writeResponse();
      assert.equal(body.owner, OWNER, "the save remains bound to the account whose form was read");
      const { owner: _owner, ...values } = body;
      server = { ...server, values: { ...server.values, ...values } } as SettingsView;
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

async function mount() {
  await ui.render(React.createElement(Settings, { onFund: () => {}, slug: null, onSaved: () => { savedCalls++; } }));
}

const region = () => {
  const found = ui.container.querySelector<HTMLElement>("#trencher-setup");
  assert.ok(found, "Trencher setup has a nearby feedback region");
  return found;
};
const permissionLink = () => region().querySelector<HTMLAnchorElement>('a[href="/grant#resign"]');
const regionText = () => region().textContent ?? "";

function field(label: RegExp): HTMLInputElement {
  const name = [...ui.container.querySelectorAll(".mm-label")].find(el => label.test(el.textContent ?? ""));
  assert.ok(name, `field label ${label}`);
  const input = name.closest("label")?.querySelector("input");
  assert.ok(input, `input for ${label}`);
  return input;
}

async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(ui.dom.window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new ui.dom.window.Event("input", { bubbles: true }));
  });
}

async function prepare() {
  await ui.click("Prepare Trencher mode");
  assert.match(regionText(), /Trencher settings prepared\. Save settings to apply them\./);
}

describe("Trencher setup through the actual Settings screen", () => {
  it("acknowledges preparation and repeated clicks without saving or granting live consent", async () => {
    await mount();
    await prepare();
    await prepare();
    assert.equal(writes.length, 0);
    assert.equal(savedCalls, 0);
    assert.equal(permissionLink(), null);
    assert.equal(field(/^Live trading$/i).checked, false);
    assert.equal(field(/^Let trencher trade for real$/i).checked, false);
    assert.equal(field(/^Market check interval$/i).value, "15");
    assert.equal(ui.container.querySelector("label label"), null, "fast exits and live consent have separate labels");
  });

  it("saves the prepared draft for its original owner and offers permission review after readback", async () => {
    await mount();
    await prepare();
    await ui.click("Save settings");
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0], {
      owner: OWNER, strategy: "trencher", tickSeconds: "15", assetMode: "crypto",
      officialCoinsEnabled: true, discoveryEnabled: true, basketSymbols: ["AAPL"], trencherFastEnabled: true,
    });
    assert.match(regionText(), /Settings saved/);
    assert.equal(permissionLink()?.textContent, "Review trading permission");
    assert.equal(savedCalls, 1);
    assert.equal(field(/^Live trading$/i).checked, false);
    assert.equal(field(/^Let trencher trade for real$/i).checked, false);
    assert.equal(server.values.slippageBps, 100);
    assert.equal(server.values.llmMaxActionUsdg, 10);
    assert.equal(server.values.scoutBudgetUsdg, 0);
    await prepare();
    assert.equal(permissionLink(), null, "new draft edits invalidate the prior saved handoff");
  });

  it("saves other deliberate form edits too and hides the handoff after any new unsaved edit", async () => {
    await mount();
    await prepare();
    await type(field(/^Agent name$/i), "Captain");
    await ui.click("Save settings");
    assert.equal(writes[0]?.agentName, "Captain");
    assert.ok(permissionLink());
    await type(field(/^Agent name$/i), "Admiral");
    assert.equal(permissionLink(), null);
    assert.equal(writes.length, 1, "editing alone never sends settings");
  });

  it("prevents edits and duplicate saves until an outstanding save has settled", async () => {
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { finish = resolve; });
    writeResponse = () => pending;
    await mount();
    await prepare();
    const buttons = [...ui.container.querySelectorAll("button")];
    const nearbySave = buttons.find(button => button.textContent === "Save settings");
    const globalSave = buttons.find(button => button.textContent === "Save changes");
    assert.ok(nearbySave);
    assert.ok(globalSave);
    // Both clicks occur before React commits a disabled button. The in-flight
    // guard must prevent the second control from issuing the same PUT again.
    await act(async () => {
      nearbySave.click();
      globalSave.click();
    });
    assert.equal(writes.length, 1);
    assert.match(regionText(), /Saving settings/);
    const form = region().closest("fieldset");
    assert.ok(form);
    const controls = [...form.querySelectorAll("input, select, textarea, button")];
    assert.ok(controls.length > 10, "the complete editable form is covered");
    assert.ok(controls.every(control => control.matches(":disabled")), "fieldset disables even controls without their own disabled attribute");
    await act(async () => { field(/^Let trencher trade for real$/i).click(); });
    assert.equal(field(/^Let trencher trade for real$/i).checked, false);
    await ui.click("Save settings");
    assert.equal(writes.length, 1);
    const { owner: _owner, ...values } = writes[0]!;
    server = { ...server, values: { ...server.values, ...values } } as SettingsView;
    await act(async () => { finish(json({ ok: true })); });
    assert.equal(writes.length, 1);
    assert.equal(savedCalls, 1);
    assert.ok(permissionLink());
    assert.equal(field(/^Market check interval$/i).matches(":disabled"), false);
    assert.equal(field(/^Let trencher trade for real$/i).matches(":disabled"), false);
  });

  it("updates the prepared summary when the owner changes the fast-exit choice", async () => {
    await mount();
    await prepare();
    assert.match(regionText(), /Selected:.*fast exits/);
    const label = [...region().querySelectorAll("label")].find(element => element.textContent?.includes("Use fast Trencher exits"));
    const fast = label?.querySelector("input");
    assert.ok(fast);
    assert.equal(fast.checked, true);
    await act(async () => { fast.click(); });
    assert.equal(fast.checked, false);
    assert.match(regionText(), /You have unsaved settings/);
    assert.doesNotMatch(regionText(), /Selected:.*fast exits/);
    assert.equal(permissionLink(), null);
    assert.equal(writes.length, 0);
    await ui.click("Save settings");
    assert.equal(writes[0]?.trencherFastEnabled, false, "the owner's later choice is the one saved");
  });

  it("shows rejected saves beside preparation and leaves the draft available to retry", async () => {
    writeResponse = () => json({ errors: ["Settings are busy. Try again."] }, 503);
    await mount();
    await prepare();
    await ui.click("Save settings");
    assert.match(regionText(), /Settings are busy\. Try again\./);
    assert.doesNotMatch(regionText(), /Settings saved/);
    assert.equal(permissionLink(), null);
    assert.equal(field(/^Market check interval$/i).value, "15");
    assert.equal(savedCalls, 0);
    writeResponse = undefined;
    await ui.click("Save settings");
    assert.ok(permissionLink());
  });

  it("keeps the staged values and withholds permission review when accepted settings cannot be read back", async () => {
    readback = () => json({ error: "temporarily unavailable" }, 503);
    await mount();
    await prepare();
    await ui.click("Save settings");
    assert.match(regionText(), /Your save was accepted, but/);
    assert.doesNotMatch(regionText(), /Settings saved/);
    assert.equal(permissionLink(), null);
    assert.equal(field(/^Market check interval$/i).value, "15");
  });

  it("does not confirm another owner's readback as this owner's saved preparation", async () => {
    readback = () => json({ ...server, owner: OTHER_OWNER });
    await mount();
    await prepare();
    await ui.click("Save settings");
    assert.equal(permissionLink(), null);
    assert.doesNotMatch(regionText(), /Settings saved/);
    assert.equal(field(/^Market check interval$/i).value, "15");
  });

  it("repairs the replaced invalid interval so preparation can be saved", async () => {
    await mount();
    await type(field(/^Market check interval$/i), "oops");
    assert.equal(field(/^Market check interval$/i).getAttribute("aria-invalid"), "true");
    await prepare();
    assert.equal(field(/^Market check interval$/i).value, "15");
    assert.notEqual(field(/^Market check interval$/i).getAttribute("aria-invalid"), "true");
    await ui.click("Save settings");
    assert.equal(writes.length, 1);
    assert.ok(permissionLink());
  });

  it("keeps unrelated invalid input blocked when replacing the interval", async () => {
    await mount();
    await type(field(/^Market check interval$/i), "oops");
    await type(field(/^Max slippage$/i), "nope");
    await prepare();
    assert.equal(field(/^Max slippage$/i).getAttribute("aria-invalid"), "true");
    await ui.click("Save settings");
    assert.equal(writes.length, 0);
    assert.match(regionText(), /slippageBps/);
    assert.equal(permissionLink(), null);
  });
});
