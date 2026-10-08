import assert from "node:assert/strict";
import { afterEach, beforeEach, it } from "node:test";
import React, { act } from "react";
import { LIGHTER_ROUTE_V1 } from "@merrymen/core";
import { PerpsAccount } from "./PerpsAccount";
import { testDom, json, deferred } from "./test-dom";
import type { AccountState } from "./HostedControls";
const owner = `0x${"1".repeat(40)}`, address = `0x${"2".repeat(40)}`;
const account: AccountState = { session: { hosted: true, address: owner }, status: { exists: true, grant: { smartAccount: address, chainId: 4663, caps: { perTradeUsdg: 25, dailyUsdg: 100 } }, balances: { cashUsdg: "12500000", ethWei: null, vaultUsdg: null } } };
const response = { state: "ready", owner, generatedAtMs: Date.now(), account: { agentId: address, smartAccount: address, chainId: 4663, collateral: null }, perps: null, perpsAccount: null, activityCounts: { state: "ready", paper: 0, live: 0, unknown: 0, scope: "recorded-fills-all-epochs" } };
const props = { account, ownerKey: `merrymen.chat.${owner}`, perps: null, onCreate() {}, onPermission() {}, onProfile() {}, onRefreshAccount() {} };
let ui: ReturnType<typeof testDom>;
const realFetch = globalThis.fetch;
beforeEach(() => { ui = testDom(); });
afterEach(async () => { await ui.close(); globalThis.fetch = realFetch; });
it("shows actual base-unit wallet cash and keeps unread venue funds unavailable", async () => {
  globalThis.fetch = (async url => json(String(url).includes("/account") ? response : { owner, values: { perpsMaxCollateralUsdg: 30 } })) as typeof fetch;
  await ui.render(React.createElement(PerpsAccount, props));
  assert.match(ui.container.textContent!, /12.5 USDG/);
  assert.match(ui.container.textContent!, /Real venue equityUnavailable/);
  assert.match(ui.container.textContent!, /dedicated Perps wallet/);
  assert.match(ui.container.textContent!, new RegExp(address));
});
it("saves only the owner-bound collateral ceiling and confirms readback", async () => {
  const writes: unknown[] = [];
  globalThis.fetch = (async (url, init) => {
    if (init?.method === "PUT") { writes.push(JSON.parse(String(init.body))); return json({ saved: ["perpsMaxCollateralUsdg"] }); }
    return json(String(url).includes("/account") ? response : { owner, values: { perpsMaxCollateralUsdg: 30 } });
  }) as typeof fetch;
  await ui.render(React.createElement(PerpsAccount, props));
  await ui.click("Save allocation limit");
  assert.deepEqual(writes, [{ owner, perpsMaxCollateralUsdg: 30 }]);
  assert.match(ui.container.textContent!, /Allocation limit saved/);
});
it("an old owner's delayed account cannot appear after switching sessions", async () => {
  const old = deferred<Response>();
  globalThis.fetch = (async () => old.promise) as typeof fetch;
  await ui.render(React.createElement(PerpsAccount, props));
  const next = { ...account, session: { hosted: true, address: `0x${"3".repeat(40)}` } };
  await ui.render(React.createElement(PerpsAccount, { ...props, account: next, ownerKey: "next-owner" }));
  await act(async () => { old.resolve(json(response)); });
  assert.doesNotMatch(ui.container.textContent!, /12.5 USDG/);
  assert.doesNotMatch(ui.container.textContent!, new RegExp(address));
});
it("waits for an unread session instead of offering sign-in", async () => {
  await ui.render(React.createElement(PerpsAccount, { ...props, account: null }));
  assert.match(ui.container.textContent!, /Reading session/);
  assert.equal(ui.container.querySelector("input"), null);
});
it("clears verified wallet and controls when refresh loses authentication", async () => {
  let lost = false;
  globalThis.fetch = (async (url, init) => {
    assert.equal(init?.credentials, "same-origin");
    assert.ok(init?.signal);
    return lost ? json({}, 401) : json(String(url).includes("/account") ? response : { owner, values: { perpsMaxCollateralUsdg: 30 } });
  }) as typeof fetch;
  await ui.render(React.createElement(PerpsAccount, props));
  lost = true;
  await ui.click("Refresh account");
  assert.doesNotMatch(ui.container.textContent!, /12.5 USDG/);
  assert.doesNotMatch(ui.container.textContent!, new RegExp(address));
  assert.doesNotMatch(ui.container.textContent!, /Save allocation limit/);
});
it("rejects malformed account identity instead of exposing funding controls", async () => {
  globalThis.fetch = (async () => json({ ...response, account: { ...response.account, smartAccount: 123 } })) as typeof fetch;
  await ui.render(React.createElement(PerpsAccount, props));
  assert.match(ui.container.textContent!, /Could not verify/);
  assert.doesNotMatch(ui.container.textContent!, /Add USDG/);
});
it("shows unread allocation and disables funding after a settings failure", async () => {
  globalThis.fetch = (async url => String(url).includes("/account") ? json(response) : json({}, 503)) as typeof fetch;
  await ui.render(React.createElement(PerpsAccount, props));
  assert.match(ui.container.textContent!, /Allocation unread/);
  const buttons = Array.from(ui.container.querySelectorAll("button"));
  assert.equal(buttons.find(b => b.textContent === "Add USDG")?.disabled, true);
  assert.equal(buttons.find(b => b.textContent === "Save allocation limit")?.disabled, true);
});
it("does not offer USDG deposits without verified collateral support", async () => {
  globalThis.fetch = (async url => json(String(url).includes("/account") ? response : { owner, values: { perpsMaxCollateralUsdg: 30 } })) as typeof fetch;
  await ui.render(React.createElement(PerpsAccount, props));
  assert.equal(Array.from(ui.container.querySelectorAll("button")).find(b => b.textContent === "Add USDG")?.disabled, true);
  assert.match(ui.container.textContent!, /USDG deposits are unavailable/);
});

it("enables the USDG funding entry only for the matching supported grant", async () => {
  const supported = { ...response, account: { ...response.account, collateral: { symbol: "USDG", decimals: 6, address: LIGHTER_ROUTE_V1.usdg } } };
  globalThis.fetch = (async url => json(String(url).includes("/account") ? supported : { owner, values: { perpsMaxCollateralUsdg: 30 } })) as typeof fetch;
  await ui.render(React.createElement(PerpsAccount, props));
  assert.equal(Array.from(ui.container.querySelectorAll("button")).find(b => b.textContent === "Add USDG")?.disabled, false);
  await ui.render(React.createElement(PerpsAccount, { ...props, account: { ...account, status: { ...account.status, grant: { ...account.status.grant!, chainId: 46630 } } } }));
  assert.doesNotMatch(ui.container.textContent!, new RegExp(address));
  assert.doesNotMatch(ui.container.textContent!, /Add USDG/);
});
