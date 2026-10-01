import assert from "node:assert/strict";
import { afterEach, before, beforeEach, it } from "node:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import type { BrowserPlan } from "@/lib/recover-client";
let testDom: typeof import("../terminal/test-dom").testDom;
let json: typeof import("../terminal/test-dom").json;
let RecoverPanelView: typeof import("./RecoverPanel").RecoverPanelView;
let ui: ReturnType<typeof testDom>;
const realFetch = globalThis.fetch;
const ACCOUNT = "0x05a198A677Fbcd8f5c168d397Fa7ef5eB6D65487";
const OWNER = "0x8e93bad5a60a266b4283855ceffa0979720aed72";
const KEY = `0x${"31".repeat(32)}`;

before(async () => {
  const boot = new JSDOM("<p></p>");
  Object.assign(globalThis, { window: boot.window, document: boot.window.document });
  ({ testDom, json } = await import("../terminal/test-dom"));
  Reflect.deleteProperty(globalThis, "window");
  Reflect.deleteProperty(globalThis, "document");
  boot.window.close();
});
beforeEach(async () => { ui = testDom(); ({ RecoverPanelView } = await import("./RecoverPanel")); });
afterEach(async () => { await ui.close(); globalThis.fetch = realFetch; });

for (const hosted of [true, false]) it(`${hosted ? "hosted" : "local stored-key"} ETH-only recovery discloses the whole sponsored balance and fee payer`, async () => {
  const common = { smartAccount: ACCOUNT, ownerAddress: OWNER, chainId: 4663, explorer: "https://explorer.test", balances: [], classHoldings: [], classVault: null, classVaults: [], unreadable: [], nativeRecoverableWei: "1000000000000000", nativeReserveWei: "0", gasSponsored: true };
  globalThis.fetch = async () => json(hosted ? { clientSide: true, hasStoredKey: false, hasBundler: false } : { ...common, hasStoredKey: true, hasBundler: true });
  localStorage.setItem("merrymen.grant.v1", JSON.stringify({ smartAccount: ACCOUNT, chainId: 4663, demoOwnerPrivateKey: KEY, binding: { version: "privy-did-owner-v1" } }));
  const planFn = async () => ({ ...common, gasWei: 1_000_000_000_000_000n, nativeRecoverableWei: 1_000_000_000_000_000n, nativeReserveWei: 0n, needsGas: false, sponsorshipReason: null } as unknown as BrowserPlan);
  await ui.render(React.createElement(RecoverPanelView, { privyOwner: hosted ? { account: { address: OWNER, type: "local" }, did: "did:privy:test" } as never : null, initialOwnerKey: KEY, planFn }));
  await ui.click("🏹 recover my funds");
  if (hosted) await ui.click("check what's in it");
  assert.match(ui.container.textContent!, /0.001000000/);
  assert.doesNotMatch(ui.container.textContent!, /account is empty/);
  const input = ui.container.querySelector('input[placeholder^="send to"]') as HTMLInputElement;
  assert.ok(input, "ETH is a recoverable balance even with no tokens");
  await act(async () => {
    Object.getOwnPropertyDescriptor(ui.dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, OWNER);
    input.dispatchEvent(new ui.dom.window.Event("input", { bubbles: true }));
  });
  let confirmation = "";
  ui.dom.window.confirm = message => { confirmation = message ?? ""; return false; };
  await ui.click("recover funds →");
  assert.match(confirmation, /0.001000000/);
  assert.match(confirmation, /Merrymen covers the network fees/);
  assert.doesNotMatch(confirmation, /keeps a little ETH/);
});
