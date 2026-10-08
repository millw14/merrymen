import assert from "node:assert/strict";
import { test } from "node:test";
import { readRequestPurpose, scopedAccountUrl } from "./account-purpose";
import { loadGrant, clearGrant } from "./session";
test("purpose selector preserves legacy default and refuses duplicate or unrecognised values", () => {
 for (const [query, expected] of [["", "spot"], ["?purpose=perps", "perps"], ["?purpose=spot", "spot"], ["?purpose=", null], ["?purpose=unknown", null], ["?purpose=spot&purpose=perps", null], ["?purpose=perps&purpose=perps", null]]) {
  assert.equal(readRequestPurpose({ url: `https://merrymen.dev/api/grants${query}` }), expected);
 }
 assert.equal(scopedAccountUrl("/api/grants?owner=one#fund", "perps"), "/api/grants?owner=one&purpose=perps#fund");
});
test("clearing a Perps browser grant archives it without touching the Spot grant", () => {
 const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
 const map = new Map<string, string>();
 const storage = { getItem: (k:string) => map.get(k) ?? null, setItem: (k:string,v:string) => map.set(k,v), removeItem: (k:string) => map.delete(k) };
 Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
 try {
  const spot = { smartAccount: "0x1111111111111111111111111111111111111111", demoOwnerPrivateKey: "test-owner" };
  const perps = { ...spot, purpose: "perps", smartAccount: "0x2222222222222222222222222222222222222222" };
  storage.setItem("merrymen.grant.v1", JSON.stringify(spot));
  storage.setItem("merrymen.grant.perps.v1", JSON.stringify(perps));
  assert.equal(loadGrant()?.smartAccount, spot.smartAccount);
  assert.equal(loadGrant("perps")?.smartAccount, perps.smartAccount);
  clearGrant("perps");
  assert.equal(loadGrant("perps"), null);
  assert.equal(loadGrant()?.smartAccount, spot.smartAccount);
  assert.ok([...map.values()].some(raw => raw.includes(perps.smartAccount)), "revoking trading retains owner recovery data");
 } finally { if(original) Object.defineProperty(globalThis,"localStorage",original); else Reflect.deleteProperty(globalThis,"localStorage"); }
});
