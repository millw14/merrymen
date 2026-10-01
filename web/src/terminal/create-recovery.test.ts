import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { afterEach, before, beforeEach, it, mock } from "node:test";
import { fileURLToPath } from "node:url";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import type { Grant } from "@/lib/session";
import type { AccountState } from "./HostedControls";
import { markPermissionForReplacement } from "@/lib/permission-replacement";

const tenant = `0x${"a".repeat(40)}`;
const grant = { smartAccount: `0x${"b".repeat(40)}`, owner: tenant, sessionKeyAddress: `0x${"c".repeat(40)}`, chainId: 4663, binding: { version: "privy-did-owner-v1" }, caps: { perTradeUsdg: 10, dailyUsdg: 50 } } as Grant;
const account: AccountState = { session: { hosted: true, address: tenant }, status: { exists: false, tenant } };
let stored: Grant | null;
let snapshots: Grant[];
let trusted: boolean;
let storageFailed: boolean;
let mintCalls: number;
let signerAddress: string;
let writes: string[];
let current: { kind: "ready"; account: AccountState } | { kind: "changed" };
let CreateAgent: typeof import("./screens/CreateAgent").CreateAgent;
let testDom: typeof import("./test-dom").testDom;
let ui: ReturnType<typeof testDom>;
const originalFetch = globalThis.fetch;

before(async () => {
  const boot = new JSDOM("<!doctype html><p></p>");
  Object.assign(globalThis, { window: boot.window, document: boot.window.document });
  ({ testDom } = await import("./test-dom"));
  Reflect.deleteProperty(globalThis, "window"); Reflect.deleteProperty(globalThis, "document"); boot.window.close();
  const screen = fileURLToPath(new URL("./screens/CreateAgent.tsx", import.meta.url));
  const loader = Module as unknown as { _load: (id: string, parent: { filename?: string }, isMain: boolean) => unknown };
  const load = loader._load;
  const intercepted = mock.method(loader, "_load", function (this: typeof loader, id: string, parent: { filename?: string }, isMain: boolean) {
    if (parent?.filename === screen) {
      if (id === "@/terminal/usePrivyOwner") return { usePrivyOwner: () => ({ account: { address: signerAddress }, did: "did:privy:test" }) };
      if (id === "@/lib/verified-adapter") return { verifiedAdapter: async () => undefined };
      if (id === "../tier") return { loadTier: async () => null, newAgentQualifies: () => true };
      if (id === "../account-session") return { fetchAccountForSession: async () => current };
      if (id === "@/lib/saved-grant-binding") return {
        loadRecoveryGrants: () => { if (storageFailed) throw new Error("storage unreadable"); return snapshots; },
        trustedSavedGrant: async (candidate: Grant) => !!candidate && trusted,
      };
      if (id === "@/lib/session") return {
        loadGrant: () => stored,
        isPrivyOwned: () => true,
        createPrivyOwnedWallet: async () => { mintCalls++; return { local: grant, handoff: { ok: false, error: "temporary activation failure" } }; },
      };
    }
    return load.call(this, id, parent, isMain);
  });
  try { CreateAgent = createRequire(import.meta.url)(screen).CreateAgent; }
  finally { intercepted.mock.restore(); }
});

beforeEach(() => {
  ui = testDom(); stored = null; snapshots = []; trusted = true; storageFailed = false; mintCalls = 0; signerAddress = tenant; writes = [];
  current = { kind: "ready", account };
  globalThis.fetch = async (input, init) => {
    const route = String(input);
    if (init?.method && init.method !== "GET") writes.push(route);
    if (route === "/api/settings") return Response.json({ values: {} });
    if (route === "/api/grants") return Response.json({ ok: true });
    throw new Error(`Unexpected request: ${route}`);
  };
});
afterEach(async () => { await ui.close(); globalThis.fetch = originalFetch; });
const screen = () => React.createElement(CreateAgent, { account, onRefresh() {}, onSignedIn() {}, onBack() {}, onDone() {}, onFund() {} });

async function limits() {
  await ui.render(screen());
  const input = ui.container.querySelector<HTMLInputElement>("#agent-name")!;
  assert.ok(input, "new-agent form is reachable for an account without a saved wallet");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(ui.dom.window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, "Test agent");
    input.dispatchEvent(new ui.dom.window.Event("input", { bubbles: true }));
  });
  await ui.click("Set trading limits");
  await ui.click("Continue");
}
async function failedActivation() {
  await limits(); await ui.click("Create agent");
  assert.equal(mintCalls, 1);
  await act(async () => { ui.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(); });
  await ui.click("Continue");
  assert.match(ui.container.textContent!, /Retry activation/);
  writes = [];
}

it("a verified stopped local wallet resumes instead of minting another permission", async () => {
  stored = grant;
  await ui.render(screen());
  assert.match(ui.container.textContent!, /Resume your saved wallet/);
  assert.equal(ui.container.querySelector("a")?.getAttribute("href"), "/grant#resign");
  assert.equal(ui.container.querySelector("#agent-name"), null);
  assert.equal(mintCalls, 0); assert.deepEqual(writes, []);
});
it("a verified public recovery snapshot resumes without a browser's full grant", async () => {
  snapshots = [grant];
  await ui.render(screen());
  assert.match(ui.container.textContent!, /Resume your saved wallet/);
  assert.equal(mintCalls, 0); assert.deepEqual(writes, []);
});
it("another tenant's unverified saved metadata is not adopted", async () => {
  stored = grant; trusted = false;
  await ui.render(screen());
  assert.ok(ui.container.querySelector("#agent-name"));
  assert.doesNotMatch(ui.container.textContent!, /Resume your saved wallet/);
});
it("an unreadable recovery journal fails closed", async () => {
  storageFailed = true;
  await ui.render(screen());
  assert.match(ui.container.textContent!, /Couldn.t check your saved wallet/);
  assert.equal(ui.container.querySelector("#agent-name"), null);
  assert.equal(mintCalls, 0);
});
it("a saved wallet appearing after setup opens blocks all mint and settings writes", async () => {
  await limits(); stored = grant;
  await ui.click("Create agent");
  assert.match(ui.container.textContent!, /Resume your saved wallet/);
  assert.equal(mintCalls, 0); assert.deepEqual(writes, []);
});
it("a replacement marker added after rendering prevents Retry activation from posting", async () => {
  await failedActivation();
  markPermissionForReplacement(grant);
  await ui.click("Retry activation");
  assert.deepEqual(writes, []);
  assert.match(ui.container.textContent!, /Resume your saved wallet/);
});
it("Retry activation rechecks the signed-in account and never posts after a tenant change", async () => {
  await failedActivation(); current = { kind: "changed" };
  await ui.click("Retry activation");
  assert.deepEqual(writes, []);
  assert.match(ui.container.textContent!, /could not be verified for your current account/);
});

it("a stale Privy signer from another hosted login cannot mint or change settings", async () => {
  await limits(); signerAddress = `0x${"d".repeat(40)}`;
  await ui.render(screen());
  await ui.click("Create agent");
  assert.equal(mintCalls, 0); assert.deepEqual(writes, []);
  assert.match(ui.container.textContent!, /Your signing wallet changed/);
});
