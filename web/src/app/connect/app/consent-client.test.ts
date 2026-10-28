import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { afterEach, before, beforeEach, it, mock } from "node:test";
import { fileURLToPath } from "node:url";
import React, { act } from "react";
import { deferred, json, testDom } from "@/terminal/test-dom";

let ConsentClient: typeof import("./ConsentClient").ConsentClient;
let ui: ReturnType<typeof testDom>;
let signedIn: boolean;
let owner: string;
let failDescribe: boolean;
let failPrivyLogout: boolean;
let failServerLogout: boolean;
let logoutPrivy: ReturnType<typeof deferred<void>>;
let logoutServer: ReturnType<typeof deferred<void>>;
let events: string[];
let calls: Array<Record<string, unknown>>;
const originalFetch = globalThis.fetch;
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
const handle = "tab-local-connection-request";

before(() => {
  const file = fileURLToPath(new URL("./ConsentClient.tsx", import.meta.url));
  const signOut = fileURLToPath(new URL("../../../terminal/SignOut.tsx", import.meta.url));
  const require = createRequire(import.meta.url);
  const loader = Module as unknown as { _load: (id: string, parent: { filename?: string }, isMain: boolean) => unknown };
  const load = loader._load;
  const intercepted = mock.method(loader, "_load", function (this: typeof loader, id: string, parent: { filename?: string }, isMain: boolean) {
    if (parent?.filename === file && id === "@/terminal/HostedControls") return {
      SignIn: ({ onDone }: { onDone: () => void }) => React.createElement("button", { onClick: () => { signedIn = true; onDone(); } }, "Finish test sign-in"),
    };
    if (parent?.filename === signOut) {
      if (id === "@privy-io/react-auth") return { usePrivy: () => ({ logout: async () => { events.push("privy"); await logoutPrivy.promise; if (failPrivyLogout) throw new Error("Privy unavailable"); } }) };
      if (id === "@/lib/privy-client") return { privyEnabled: () => true };
      if (id === "./HostedControls") return require(fileURLToPath(new URL("../../../terminal/request-json.ts", import.meta.url)));
    }
    return load.call(this, id, parent, isMain);
  });
  try { ConsentClient = require(file).ConsentClient; }
  finally { intercepted.mock.restore(); }
});

beforeEach(() => {
  ui = testDom();
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: ui.dom.window.sessionStorage });
  window.history.replaceState(null, "", `/connect/app#request=${handle}`);
  signedIn = true;
  owner = "first";
  failDescribe = false;
  failPrivyLogout = false;
  failServerLogout = false;
  logoutPrivy = deferred<void>();
  logoutServer = deferred<void>();
  events = [];
  calls = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === "/api/auth/logout") {
      events.push("server");
      await logoutServer.promise;
      if (failServerLogout) throw new Error("Server unavailable");
      signedIn = false;
      return json({ ok: true });
    }
    assert.equal(url, "/api/mcp/consent");
    const body = JSON.parse(String(init?.body));
    calls.push(body);
    if (body.action === "decide") return new Promise<Response>(() => undefined);
    if (failDescribe) return json({ error_description: "Could not verify the current account." }, 503);
    return json({
      signedIn,
      client: { name: "Grok", host: "grok.com", registration: "dynamic", redirectHost: "grok.com", local: false },
      agents: signedIn ? [{ slug: owner, name: `${owner} Merryman`, account: null }] : [],
      scopes: [
        { id: "market:read", title: "Read market data", detail: "Market data", level: "read", needsAgent: false, defaultOn: true },
        { id: "agents:read", title: "Read your agent", detail: "Agent details", level: "read", needsAgent: true, defaultOn: true },
        { id: "drafts:write", title: "Suggest setup", detail: "Proposals require review", level: "sensitive", needsAgent: false, defaultOn: false },
      ],
      expiresAt: Date.now() + 600_000,
    });
  };
});

afterEach(async () => {
  await ui.close();
  globalThis.fetch = originalFetch;
  if (storageDescriptor) Object.defineProperty(globalThis, "sessionStorage", storageDescriptor);
  else Reflect.deleteProperty(globalThis, "sessionStorage");
});

const button = (label: string) => Array.from(ui.container.querySelectorAll("button")).find((b) => b.textContent?.trim() === label)!;
const setupCheckbox = () => ui.container.querySelector<HTMLInputElement>('[aria-label="Optional setup and settings permission"] input')!;

it("switches accounts through complete logout, retaining the request but clearing the old owner's choices", async () => {
  await ui.render(React.createElement(ConsentClient));
  assert.equal(window.location.hash, "");
  assert.equal(setupCheckbox().checked, false, "setup permission stays optional");
  await act(async () => { setupCheckbox().click(); });
  assert.equal(setupCheckbox().checked, true);
  await ui.click("Use another account");
  assert.deepEqual(events, ["privy"]);
  assert.equal(button("Allow Grok").disabled, true);
  assert.equal(button("Decline").disabled, true);
  assert.equal(sessionStorage.getItem("merrymen.mcp-consent"), handle);
  await act(async () => { logoutPrivy.resolve(); });
  assert.deepEqual(events, ["privy", "server"]);
  assert.equal(calls.length, 1, "does not reload between the two session logouts");
  await act(async () => { logoutServer.resolve(); });
  assert.ok(button("Finish test sign-in"));
  assert.doesNotMatch(ui.container.textContent!, /first Merryman/);
  owner = "second";
  await ui.click("Finish test sign-in");
  assert.match(ui.container.textContent!, /second Merryman/);
  assert.equal(setupCheckbox().checked, false, "explicit setup access from the previous account is not carried across");
  assert.ok(calls.every((call) => call.request === handle));
  await ui.click("Allow Grok");
  const decision = calls.at(-1)!;
  assert.deepEqual(decision.agents, ["second"]);
  assert.deepEqual(decision.scopes, ["market:read", "agents:read"]);
  assert.equal(button("Use another account").disabled, true, "account switching cannot race an approval");
});

it("does not retain an approval action if the account refresh after logout fails", async () => {
  await ui.render(React.createElement(ConsentClient));
  await ui.click("Use another account");
  failDescribe = true;
  await act(async () => { logoutPrivy.resolve(); logoutServer.resolve(); });
  assert.doesNotMatch(ui.container.textContent!, /first Merryman/);
  assert.equal(button("Allow Grok"), undefined);
  assert.match(ui.container.textContent!, /Could not verify the current account/);
  assert.equal(sessionStorage.getItem("merrymen.mcp-consent"), handle);
});

for (const failure of ["Privy", "server", "both"] as const) {
  it(`keeps consent and sign-in blocked after ${failure} logout failure until a complete retry`, async () => {
    failPrivyLogout = failure !== "server";
    failServerLogout = failure !== "Privy";
    await ui.render(React.createElement(ConsentClient));
    await ui.click("Use another account");
    await act(async () => { logoutPrivy.resolve(); logoutServer.resolve(); });
    assert.deepEqual(events, ["privy", "server"], "server logout is still attempted after a Privy failure");
    assert.equal(calls.length, 1, "partial logout must not reload or remount sign-in");
    assert.equal(button("Finish test sign-in"), undefined);
    assert.equal(button("Allow Grok").disabled, true);
    assert.equal(button("Decline").disabled, true);
    assert.match(ui.container.querySelector('[role="alert"]')?.textContent ?? "", /Sign-out did not finish/);
    assert.equal(button("Retry account switch").disabled, false);
    assert.equal(sessionStorage.getItem("merrymen.mcp-consent"), handle);
    await ui.click("Allow Grok");
    assert.equal(calls.some((call) => call.action === "decide"), false);
    await ui.remount(React.createElement(ConsentClient));
    assert.equal(calls.length, 1, "refresh cannot reopen a partially signed-out account");
    assert.equal(button("Finish test sign-in"), undefined);
    assert.equal(button("Allow Grok"), undefined);
    assert.equal(button("Retry account switch").disabled, false);
    failPrivyLogout = false;
    failServerLogout = false;
    await ui.click("Retry account switch");
    assert.deepEqual(events, ["privy", "server", "privy", "server"]);
    assert.equal(calls.length, 2, "only complete logout may refresh consent");
    assert.ok(button("Finish test sign-in"));
    assert.doesNotMatch(ui.container.textContent!, /first Merryman|Sign-out did not finish/);
    assert.equal(sessionStorage.getItem("merrymen.mcp-consent.switching"), null);
    owner = "second";
    await ui.click("Finish test sign-in");
    assert.match(ui.container.textContent!, /second Merryman/);
    assert.equal(button("Allow Grok").disabled, false);
    assert.equal(setupCheckbox().checked, false);
  });
}
