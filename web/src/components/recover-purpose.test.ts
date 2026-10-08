import assert from "node:assert/strict";
import { it } from "node:test";
import React, { act } from "react";
import { RecoverPanelView } from "./RecoverPanel";
import { testDom, json } from "../terminal/test-dom";
const owner = `0x${"1".repeat(40)}`, spot = `0x${"2".repeat(40)}`, perps = `0x${"3".repeat(40)}`;
// Synthetic test fixture only; never read a user's stored key.
const key = `0x${"4".repeat(64)}`;
async function click(ui: ReturnType<typeof testDom>, match: RegExp) {
  const button = [...ui.container.querySelectorAll("button")].find(b => match.test(b.textContent ?? ""));
  assert.ok(button); await act(async () => button.click());
}
it("Perps recovery selects the dedicated wallet for a shared legacy owner key", async () => {
  const ui = testDom(), original = globalThis.fetch; const planned: string[] = [], urls: string[] = [];
  try {
    localStorage.setItem("merrymen.grant.v1", JSON.stringify({ owner, smartAccount: spot, demoOwnerPrivateKey: key, chainId: 4663 }));
    localStorage.setItem("merrymen.grant.perps.v1", JSON.stringify({ purpose: "perps", owner, smartAccount: perps, demoOwnerPrivateKey: key, chainId: 4663 }));
    globalThis.fetch = async url => { urls.push(String(url)); return json({ clientSide: true, hasStoredKey: false, hasBundler: false, chainId: 4663 }); };
    await ui.render(React.createElement(RecoverPanelView, { purpose: "perps", expectedAccount: perps, initialOwnerKey: key, privyOwner: null, planFn: async w => { planned.push(w.smartAccount); throw new Error("test stops before any transfer"); } }));
    await click(ui, /recover my funds/i); await click(ui, /check what's in it/i);
    assert.deepEqual(planned, [perps]); assert.deepEqual(urls, ["/api/recover?purpose=perps"]);
  } finally { globalThis.fetch = original; await ui.close(); }
});
it("missing dedicated local grant cannot recover the Spot grant through a Perps Privy flow", async () => {
  const ui = testDom(), original = globalThis.fetch; let planned = false;
  try {
    localStorage.setItem("merrymen.grant.v1", JSON.stringify({ owner, smartAccount: spot, chainId: 4663 }));
    globalThis.fetch = async () => json({ clientSide: true, hasStoredKey: false, hasBundler: false, chainId: 4663 });
    await ui.render(React.createElement(RecoverPanelView, { purpose: "perps", expectedAccount: perps, privyOwner: { account: { address: owner }, did: "did:privy:test" } as never, planFn: async () => { planned = true; throw new Error("unexpected"); } }));
    await click(ui, /recover my funds/i); await click(ui, /check what's in it/i);
    assert.equal(planned, false); assert.match(ui.container.textContent!, /doesn't hold that wallet/);
  } finally { globalThis.fetch = original; await ui.close(); }
});
