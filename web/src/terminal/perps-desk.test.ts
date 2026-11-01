import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { before, beforeEach, afterEach, test, mock } from "node:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import type { Grant } from "../lib/session";
import type { PrivyOwner } from "./usePrivyOwner";

const OWNER = `0x${"a".repeat(40)}`, ACCOUNT = `0x${"b".repeat(40)}`, OTHER = `0x${"c".repeat(40)}`;
const CAPS = { perTradeUsdg: 25, dailyUsdg: 100, expiryDays: 7, maxDrawdownPct: 10, maxOpsPerDay: 48 };
const grant = () => ({ purpose: "perps", smartAccount: ACCOUNT, owner: OWNER, sessionKeyAddress: `0x${"d".repeat(40)}`, chainId: 4663, caps: CAPS, grantedAt: 10, expiresAt: 4_000_000_000, grantFeatures: [], grantTokens: [], serialized: "saved", demoSessionPrivateKey: `0x${"1".repeat(64)}` }) as Grant;
let testDom: typeof import("./test-dom").testDom, json: typeof import("./test-dom").json, deferred: typeof import("./test-dom").deferred;
let PerpsScreen: typeof import("./PerpsScreen").PerpsScreen;
let PerpsSettings: typeof import("./PerpsSettings").PerpsSettings;
let PerpsWalletView: typeof import("./PerpsWallet").PerpsWalletView;
let ui: ReturnType<typeof testDom>;
let tenant: string | null, activeGrant: Grant | null, localGrant: Grant | null;
let reportMode: "ok" | "not-said" | "unreadable", reportOwner: string, activityOwner: string, chartOwner: string;
let writes: { url: string; method: string; body: Record<string, unknown> }[], events: string[];
let lostWrite: boolean, gate: boolean, settingsEnabled: boolean, settingsVersion: string;
let authWait: ReturnType<typeof deferred<Response>> | null, stopWait: ReturnType<typeof deferred<void>> | null, mintWait: ReturnType<typeof deferred<void>> | null;
let postWait: ReturnType<typeof deferred<Response>> | null, preflightWait: ReturnType<typeof deferred<void>> | null;
let hostedMode: boolean, killReply: () => Response | Promise<Response>;
let archived: Grant[], clearThrows: string | null, grantsFail: boolean;
const originalFetch = globalThis.fetch;
const signer = { account: { address: OWNER }, did: "did:privy:perps-test" } as unknown as PrivyOwner;
const require = createRequire(import.meta.url);

before(async () => {
  const boot = new JSDOM("<!doctype html>", { pretendToBeVisual: true });
  Object.assign(globalThis, { window: boot.window, document: boot.window.document });
  ({ testDom, json, deferred } = await import("./test-dom"));
  const walletPath = fileURLToPath(new URL("./PerpsWallet.tsx", import.meta.url));
  const stopPath = fileURLToPath(new URL("./StopAllAgents.tsx", import.meta.url));
  const loader = Module as unknown as { _load: (id: string, parent: { filename?: string }, isMain: boolean) => unknown };
  const load = loader._load;
  const hook = mock.method(loader, "_load", function (this: typeof loader, id: string, parent: { filename?: string }, main: boolean) {
    if (id.endsWith(".css")) return {};
    if (id === "./HostedControls") return { PRIVY_BETA: false, SignIn: () => React.createElement("p", null, "Sign in") };
    if (id === "./usePrivyOwner") return { usePrivyOwner: () => signer };
    // As session.ts's clearGrant: the slot is archived, then emptied.
    if (parent.filename === stopPath && id === "../lib/session") return { clearGrant: (wallet: string) => {
      if (clearThrows === wallet) throw new Error("storage refused");
      events.push(`clear-${wallet}`);
      if (wallet === "perps" && localGrant) { archived.push(localGrant); localGrant = null; }
    } };
    if (parent.filename === walletPath) {
      if (id === "../lib/session") return {
        loadGrant: () => localGrant,
        localGrantsSnapshot: () => ({ current: localGrant, archived }),
        sameGrantPermission: (a: Grant, b: Grant) => a?.smartAccount === b?.smartAccount && a?.sessionKeyAddress === b?.sessionKeyAddress,
        // As session.ts's: a renewal preflight refuses without the account it renews.
        preflightAgentGrant: async (_owner: unknown, options: { purpose: string; expectAccount?: string }) => { events.push("preflight"); assert.equal(options.purpose, "perps"); if (!options.expectAccount) throw new Error("A renewal preflight requires the existing account address."); if (preflightWait) await preflightWait.promise; },
        createPrivyOwnedWallet: async (_owner: unknown, _did: unknown, options: { purpose: string; expectAccount?: string; beforeCommit: () => Promise<void>; assertCurrent: () => void; minimumValidationNonce?: number }) => { events.push("mint"); if (mintWait) await mintWait.promise; await options.beforeCommit(); options.assertCurrent(); assert.equal(options.purpose, "perps"); if (events.includes("revoke")) assert.equal(options.minimumValidationNonce, 1); assert.equal(options.expectAccount, activeGrant?.smartAccount); const created = grant(); activeGrant = created; localGrant = created; return { local: created, handoff: { ok: true } }; },
        retryGrantHandoff: async () => { events.push("retry"); return { ok: true }; },
      };
      if (id === "../lib/saved-grant-binding") return { loadRecoveryGrants: () => [], trustedSavedGrant: async () => true, saveRecoveryGrant: () => events.push("save-recovery") };
      if (id === "../lib/permission-replacement") return { needsPermissionReplacement: () => false, markPermissionForReplacement: () => events.push("mark") };
      if (id === "../lib/stop-agent") return { stopAgentForReplacement: async (...args: unknown[]) => { events.push("stop"); if (stopWait) await stopWait.promise; assert.deepEqual(args, ["perps", OWNER, ACCOUNT, grant().sessionKeyAddress]); } };
      if (id === "../lib/revoke-client") return { assertRevocationFunded: async () => events.push("funding-preflight"), revokeFromBrowser: async (wallet: { purpose: string; smartAccount: string; ownerAccount: { address: string } }) => { assert.equal(wallet.purpose, "perps"); assert.equal(wallet.smartAccount, ACCOUNT); assert.equal(wallet.ownerAccount.address, OWNER); events.push("revoke"); return { validNonceFrom: 1 }; } };
    }
    return load.call(this, id, parent, main);
  });
  try {
    PerpsScreen = require(fileURLToPath(new URL("./PerpsScreen.tsx", import.meta.url))).PerpsScreen;
    PerpsSettings = require(fileURLToPath(new URL("./PerpsSettings.tsx", import.meta.url))).PerpsSettings;
    PerpsWalletView = require(walletPath).PerpsWalletView;
  } finally { hook.mock.restore(); Reflect.deleteProperty(globalThis, "window"); Reflect.deleteProperty(globalThis, "document"); boot.window.close(); }
});

function report() {
  return { v: 1, mode: "paper", blocker: null, venueReadAt: Date.now(), protectAt: Date.now(), accountIndex: null, positions: [{ market: "BTC-PERP", side: "long", baseAmount: "0.001", entryPrice: "50000", markPrice: null, leverage: 2, marginMicro: "25000000", liqPrice: null, unrealizedMicro: null, stopTrigger: "47500", fundingMicro: null }], openNotionalMicro: "50000000", collateralMicro: "25000000", inTransitMicro: null, minLiqDistanceBps: null, stopsMissing: 0, incident: false };
}
function chart(owner = chartOwner) {
  return { state: "ok", owner, account: { smartAccount: ACCOUNT, chainId: 4663 }, market: "BTC-PERP", book: "paper", window: "24h", generatedAtMs: Date.now(), candles: { state: "none", bars: [], gaps: [], stale: false, asOfMs: null }, entries: [], unknownFills: 0, truncated: false };
}
function accountReport() {
  return { state: activeGrant ? "ready" : "not-configured", owner: reportOwner, account: activeGrant ? { smartAccount: ACCOUNT, agentId: ACCOUNT, chainId: 4663, collateral: null } : null, generatedAtMs: Date.now(), report: reportMode === "ok" ? { state: "ok", report: report(), accountMode: "paper" } : { state: reportMode }, activityCounts: { state: "ready", paper: 0, scope: "recorded-fills-all-epochs" } };
}
beforeEach(() => {
  ui = testDom(); tenant = OWNER; activeGrant = grant(); localGrant = null; reportMode = "ok"; reportOwner = OWNER; activityOwner = OWNER; chartOwner = OWNER;
  hostedMode = true; killReply = () => { activeGrant = null; return json({ ok: true, perps: "stopped" }); };
  archived = []; clearThrows = null; grantsFail = false;
  writes = []; events = []; lostWrite = false; gate = true; settingsEnabled = false; settingsVersion = "version-1"; postWait = null; preflightWait = null; authWait = null; stopWait = null; mintWait = null;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input), "https://app.example.test"), method = init?.method ?? "GET";
    if (method !== "GET") {
      const body = JSON.parse(String(init?.body)); writes.push({ url: `${url.pathname}${url.search}`, method, body });
      if (url.pathname === "/api/orders" || url.pathname === "/api/paper-reset") { if (lostWrite) throw new Error("lost response"); if (postWait) return postWait.promise; return json({ id: "cmd_123", queued: true }); }
      if (url.pathname === "/api/settings") { if (body.perpsEnabled !== undefined) settingsEnabled = body.perpsEnabled; return json({ ok: true }); }
      if (url.pathname === "/api/grants" && method === "DELETE") { if (lostWrite) throw new Error("lost response"); return killReply(); }
      throw new Error(`Unexpected write ${method} ${url}`);
    }
    if (url.pathname === "/api/auth/session" && authWait) return (await authWait.promise).clone();
    if (url.pathname === "/api/auth/session") return json(hostedMode ? { hosted: true, address: tenant } : { hosted: false, address: null });
    if (url.pathname === "/api/grants" && grantsFail) return json({ error: "Couldn't read your Perps wallet. Try again shortly." }, 503);
    if (url.pathname === "/api/grants") { assert.equal(url.searchParams.get("wallet"), "perps"); return json({ exists: !!activeGrant, ...(hostedMode ? { tenant } : {}), ...(activeGrant ? { grant: activeGrant } : {}) }); }
    if (url.pathname === "/api/perps/account") return json(accountReport());
    if (url.pathname === "/api/perps/chart" || url.pathname === "/api/perps/market") return json(chart());
    if (url.pathname === "/api/perps/activity") return json({ state: "ok", owner: activityOwner, account: { smartAccount: ACCOUNT, chainId: 4663 }, market: "all", book: "paper", generatedAtMs: Date.now(), items: [], unknownRows: 0, truncated: false });
    if (url.pathname === "/api/paper-reset") { assert.equal(url.searchParams.get("expectedAccount"), ACCOUNT); assert.equal(url.searchParams.get("owner"), OWNER); events.push("read-reset"); return json({ id: "cmd_123", state: "done", result: "Practice book reset." }); }
    if (url.pathname === "/api/orders") return json({ id: "cmd_123", state: "running", result: null });
    if (url.pathname === "/api/perps/offered") { events.push("offered"); return gate ? json({ offered: true, mode: "paper" }) : json({ error: "Paper is off" }, 404); }
    if (url.pathname === "/api/settings") return json({ owner: tenant, version: settingsVersion, values: { perpsEnabled: settingsEnabled, perpsMarkets: ["BTC-PERP"], perpsDriver: "perp-trend" } });
    throw new Error(`Unexpected network ${url}`);
  }) as typeof fetch;
});
afterEach(async () => { await ui.close(); globalThis.fetch = originalFetch; });
async function settle() { for (let i = 0; i < 12; i++) await act(async () => { await new Promise(resolve => setImmediate(resolve)); }); }
async function mount(node: React.ReactNode) { await ui.render(node); await settle(); }
async function click(label: string) { await ui.click(label); await settle(); }
async function acknowledge() { const input = ui.container.querySelector<HTMLInputElement>('input[type="checkbox"]'); assert.ok(input); await act(async () => input.click()); }

test("desk shows exact paper positions and unknown figures, never a synthetic zero", async () => {
  await mount(React.createElement(PerpsScreen));
  assert.match(ui.container.textContent!, /Perpetuals/);
  assert.match(ui.container.textContent!, /long 0.001/);
  assert.match(ui.container.textContent!, /25.000000 USDG/);
  assert.match(ui.container.textContent!, /Not reported/);
  assert.equal(ui.container.querySelector('a[href="/withdraw?wallet=perps"]')?.textContent, "Withdraw & recover");
  assert.equal(ui.container.textContent!.includes("Resume"), false);
});

test("not-said and unreadable reports do not claim an empty portfolio, but allow reviewed Close all", async () => {
  reportMode = "not-said";
  await mount(React.createElement(PerpsScreen));
  assert.match(ui.container.textContent!, /has not reported its book/);
  assert.doesNotMatch(ui.container.textContent!, /No positions in this report/);
  await click("Close all & halt entries");
  await click("Confirm practice action");
  assert.equal(writes.length, 1);
  assert.equal("book" in writes[0]!.body, false);
  assert.equal(writes[0]!.body.expectedAccount, ACCOUNT);
});

test("a report for another login is discarded even when grants belongs to the current owner", async () => {
  reportOwner = OTHER;
  await mount(React.createElement(PerpsScreen));
  assert.match(ui.container.textContent!, /account changed during the read/);
  assert.doesNotMatch(ui.container.textContent!, /long 0.001/);
  assert.equal([...ui.container.querySelectorAll("button")].some(button => button.textContent?.startsWith("Close ")), false);
});

test("private chart and activity responses must identify the displayed account", async () => {
  activityOwner = OTHER; chartOwner = OTHER;
  await mount(React.createElement(PerpsScreen));
  assert.match(ui.container.textContent!, /chart could not be verified/);
  await click("Activity");
  assert.match(ui.container.textContent!, /Activity could not be verified/);
  assert.doesNotMatch(ui.container.textContent!, /No recorded fills/);
});

test("one confirmed close sends exactly once despite duplicate clicks and a lost response", async () => {
  postWait = deferred<Response>();
  await mount(React.createElement(PerpsScreen));
  await click("Close BTC-PERP");
  await act(async () => { const button = [...ui.container.querySelectorAll("button")].find(item => item.textContent === "Confirm practice action")!; button.click(); button.click(); });
  await settle(); assert.equal(writes.length, 1);
  await act(async () => postWait!.resolve(new Response("gateway", { status: 502 })));
  await settle();
  assert.match(ui.container.textContent!, /may still run.*not sent again/);
  assert.equal(writes.length, 1);
});

test("reset requires explicit review and binds the dedicated account", async () => {
  await mount(React.createElement(PerpsScreen));
  await click("Reset practice book");
  assert.equal(writes.length, 0);
  assert.match(ui.container.textContent!, /new simulated accounting epoch/);
  assert.equal(document.activeElement, ui.container.querySelector(".perps-confirm"), "review receives focus before a command can be sent");
  await click("Confirm practice action");
  assert.equal(writes[0]!.url, "/api/paper-reset?wallet=perps");
  assert.equal(writes[0]!.body.expectedAccount, ACCOUNT);
  assert.equal(writes[0]!.body.expectedTenant, OWNER);
  assert.ok(events.includes("read-reset"));
  assert.match(ui.container.textContent!, /Practice book reset\./);
});

test("login change after review prevents the close before its POST", async () => {
  await mount(React.createElement(PerpsScreen));
  await click("Close BTC-PERP"); tenant = OTHER;
  await click("Confirm practice action");
  assert.equal(writes.length, 0);
  assert.match(ui.container.textContent!, /account changed/);
});

test("settings attach the read version only for an explicit enable; risk save never re-enables", async () => {
  await mount(React.createElement(PerpsSettings, { offered: true }));
  await click("Save risk settings");
  assert.equal("perpsEnabled" in writes[0]!.body, false);
  await click("Enable entries");
  assert.equal(writes[1]!.body.perpsEnabled, true);
  assert.equal(writes[1]!.body.expectedVersion, "version-1");
  await click("Switch entries off");
  assert.equal(writes[2]!.body.perpsEnabled, false);
  assert.equal("expectedVersion" in writes[2]!.body, false);
});

test("offering disabled keeps off and recovery visible while disabling enabling", async () => {
  await mount(React.createElement(PerpsSettings, { offered: false }));
  const enable = [...ui.container.querySelectorAll("button")].find(button => button.textContent === "Enable entries");
  assert.equal(enable?.disabled, true);
  await click("Switch entries off");
  assert.equal(writes[0]!.body.perpsEnabled, false);
  assert.ok(ui.container.querySelector('a[href="/withdraw?wallet=perps"]'));
});

test("renewal checks gate before stop, preserves recovery, and skips only an empty Perps wall", async () => {
  localGrant = grant();
  await mount(React.createElement(PerpsWalletView, { offered: true, creating: false, signer }));
  await acknowledge(); await click("Renew Perps permission");
  assert.deepEqual(events, ["offered", "preflight", "offered", "save-recovery", "mark", "stop", "mint", "offered"]);
});

test("disabled paper gate refuses renewal before any stop, storage mutation or signature", async () => {
  localGrant = grant(); gate = false;
  await mount(React.createElement(PerpsWalletView, { offered: true, creating: false, signer }));
  await acknowledge(); await click("Renew Perps permission");
  assert.deepEqual(events, ["offered"]);
  assert.match(ui.container.textContent!, /Paper is off/);
});

test("fresh public metadata without binding can be renewed only by its owner", async () => {
  activeGrant = { ...grant(), binding: { version: "privy-did-owner-v1" }, serialized: undefined } as unknown as Grant;
  await mount(React.createElement(PerpsWalletView, { offered: true, creating: false, signer: { ...signer, account: { address: OTHER } as PrivyOwner["account"] } }));
  await acknowledge(); await click("Renew Perps permission");
  assert.deepEqual(events, ["offered"]);
  assert.match(ui.container.textContent!, /protected signing wallet for this account/);
});

test("account change during preflight never stops or signs the old wallet", async () => {
  localGrant = grant(); preflightWait = deferred<void>();
  await mount(React.createElement(PerpsWalletView, { offered: true, creating: false, signer }));
  await acknowledge(); await ui.click("Renew Perps permission"); await settle();
  assert.deepEqual(events, ["offered", "preflight"]);
  tenant = OTHER;
  await act(async () => preflightWait!.resolve()); await settle();
  assert.equal(events.includes("stop"), false); assert.equal(events.includes("mint"), false);
});


test("closing settings during account preflight cancels the pending enable", async () => {
  await mount(React.createElement(PerpsSettings, { offered: true }));
  authWait = deferred<Response>();
  await ui.click("Enable entries"); await settle();
  await ui.render(null);
  await act(async () => authWait!.resolve(json({ hosted: true, address: OWNER }))); await settle();
  assert.equal(writes.length, 0, "a closed screen cannot enable entries after a delayed preflight");
});

test("closing a renewal while stop is pending prevents revocation and mint", async () => {
  localGrant = { ...grant(), grantFeatures: ["energy-buy-v1"] } as Grant; activeGrant = localGrant;
  stopWait = deferred<void>();
  await mount(React.createElement(PerpsWalletView, { offered: true, creating: false, signer }));
  await acknowledge(); await ui.click("Renew Perps permission"); await settle();
  assert.ok(events.includes("stop"));
  await ui.render(null);
  await act(async () => stopWait!.resolve()); await settle();
  assert.equal(events.includes("revoke"), false, "stale continuation cannot revoke");
  assert.equal(events.includes("mint"), false);
});


test("a changed protected signer while stop awaits cannot revoke or mint", async () => {
  localGrant = { ...grant(), grantFeatures: ["energy-buy-v1"] } as Grant; activeGrant = localGrant;
  stopWait = deferred<void>();
  await mount(React.createElement(PerpsWalletView, { offered: true, creating: false, signer }));
  await acknowledge(); await ui.click("Renew Perps permission"); await settle();
  assert.ok(events.includes("stop"));
  await ui.render(React.createElement(PerpsWalletView, { offered: true, creating: false, signer: { ...signer, did: "did:privy:changed" } }));
  await ui.render(React.createElement(PerpsWalletView, { offered: true, creating: false, signer }));
  await act(async () => stopWait!.resolve()); await settle();
  assert.equal(events.includes("revoke"), false); assert.equal(events.includes("mint"), false);
});

test("creation rechecks the login after signing before saving or handing off", async () => {
  activeGrant = null; localGrant = null; mintWait = deferred<void>();
  await mount(React.createElement(PerpsWalletView, { offered: true, creating: true, signer }));
  await acknowledge(); await ui.click("Create Perps wallet"); await settle();
  assert.ok(events.includes("mint")); tenant = OTHER;
  await act(async () => mintWait!.resolve()); await settle();
  assert.equal(localGrant, null); assert.equal(activeGrant, null);
  assert.match(ui.container.textContent!, /account changed/);
});


test("a nonempty previous wall revokes only the Perps account and carries its confirmed nonce into renewal", async () => {
  localGrant = { ...grant(), grantFeatures: ["energy-buy-v1"] } as Grant; activeGrant = localGrant;
  await mount(React.createElement(PerpsWalletView, { offered: true, creating: false, signer }));
  await acknowledge(); await click("Renew Perps permission");
  assert.deepEqual(events, ["offered", "preflight", "funding-preflight", "offered", "save-recovery", "mark", "stop", "revoke", "mint", "offered"]);
});

test("a new paper wallet and an owner-verified public renewal both use the dedicated mint", async () => {
  activeGrant = null; localGrant = null;
  await mount(React.createElement(PerpsWalletView, { offered: true, creating: true, signer }));
  await acknowledge(); await click("Create Perps wallet");
  assert.equal(events.includes("preflight"), false); assert.ok(events.includes("mint"));
  assert.equal(events.includes("stop"), false); assert.equal((localGrant as Grant | null)?.purpose, "perps");
  assert.match(ui.container.textContent!, /Permission activated/);
  await ui.render(null); events = []; localGrant = null;
  activeGrant = { ...grant(), binding: { version: "privy-did-owner-v1" }, serialized: undefined, demoSessionPrivateKey: undefined } as unknown as Grant;
  await mount(React.createElement(PerpsWalletView, { offered: true, creating: false, signer }));
  await acknowledge(); await click("Renew Perps permission");
  assert.ok(events.includes("stop")); assert.ok(events.includes("mint")); assert.equal(events.includes("revoke"), false);
});


test("market and ledger navigation never writes or enables trading", async () => {
  await mount(React.createElement(PerpsScreen));
  assert.equal(ui.container.querySelector('.perps-mode-badge')?.textContent, "Paper");
  await click("Activity");
  assert.match(ui.container.textContent!, /No recorded fills or funding/);
  await click("Positions1");
  assert.match(ui.container.textContent!, /long 0.001/);
  assert.equal(writes.length, 0);
});


test("a signed-out visitor sees the market and access path without trading controls", async () => {
  tenant = null; activeGrant = null;
  await mount(React.createElement(PerpsScreen));
  assert.match(ui.container.textContent!, /Not connected/);
  assert.ok(ui.container.querySelector('[aria-label="Market chart"]'));
  assert.ok(ui.container.querySelector('a[href="/perps/join"]'));
  assert.equal(ui.container.querySelector('a[href="/create?for=perps"]'), null);
  assert.equal([...ui.container.querySelectorAll('button')].some(button => /Close |Reset /.test(button.textContent || '')), false);
  assert.equal(ui.container.textContent!.includes("Stop all agents"), false);
  assert.equal(writes.length, 0);
});

const stopNow = () => [...ui.container.querySelectorAll("button")].find(item => item.textContent === "Stop all agents now");
const deletes = () => writes.filter(write => write.url === "/api/grants" && write.method === "DELETE");

test("a Perps-only owner stops every wallet from the desk: one reviewed press, bound to the login, sent once", async () => {
  const reply = deferred<Response>(); const answer = killReply;
  killReply = () => reply.promise.then(() => answer());
  await mount(React.createElement(PerpsScreen));
  await click("Stop all agents");
  assert.match(ui.container.textContent!, /Stop all agents for this login\?/);
  assert.match(ui.container.textContent!, new RegExp(`Signed in as ${OWNER}`));
  assert.match(ui.container.textContent!, /Spot, Perps and Solana for this login will stop managing positions/);
  assert.equal(writes.length, 0);
  await act(async () => { const button = stopNow()!; button.click(); button.click(); });
  await settle(); assert.equal(writes.length, 1);
  await act(async () => reply.resolve(json({}))); await settle();
  assert.deepEqual(deletes(), [{ url: "/api/grants", method: "DELETE", body: { purpose: "delete-agent", expectedTenant: OWNER } }]);
  assert.ok(events.includes("clear-spot")); assert.ok(events.includes("clear-perps"));
  // The desk remounted on its account's removal; the answer outlives it.
  assert.match(ui.container.textContent!, /Stop request accepted for Spot, Perps and Solana/);
  assert.equal(writes.length, 1);
});

test("the stop needs no paper offering or pilot access, on the Wallet & permission page too", async () => {
  gate = false;
  await mount(React.createElement(PerpsWalletView, { offered: false, creating: false, signer }));
  await click("Stop all agents"); await click("Stop all agents now");
  assert.equal(deletes().length, 1); assert.equal(events.includes("offered"), false);
  assert.match(ui.container.textContent!, /Stop request accepted for Spot, Perps and Solana/);
});

test("a self-hosted stop names no tenant, and promises no memory deletion", async () => {
  hostedMode = false; reportOwner = null as unknown as string;
  await mount(React.createElement(PerpsScreen));
  assert.match(ui.container.textContent!, /local agent history is kept/);
  assert.equal(ui.container.textContent!.includes("agent memory"), false);
  await click("Stop all agents"); await click("Stop all agents now");
  assert.deepEqual(deletes().map(write => write.body), [{ purpose: "delete-agent" }]);
});

test("a lost stop reply is reported and never retried; the browser copies are kept", async () => {
  lostWrite = true;
  await mount(React.createElement(PerpsScreen));
  await click("Stop all agents"); await click("Stop all agents now"); await settle();
  assert.equal(deletes().length, 1);
  assert.match(ui.container.textContent!, /not received.*Check your agents before asking again/);
  assert.equal(events.some(event => event.startsWith("clear-")), false);
});

test("a partial kill shows the server's sentence and clears nothing", async () => {
  killReply = () => json({ error: "Kill incomplete: your Robinhood Chain agent is stopped, but your Perps permission was not stopped. Try the kill again.", ownerFacing: true, solana: "stopped", perps: "not-stopped" }, 503);
  await mount(React.createElement(PerpsScreen));
  await click("Stop all agents"); await click("Stop all agents now");
  assert.match(ui.container.textContent!, /Kill incomplete: .*Try the kill again/);
  assert.equal(events.some(event => event.startsWith("clear-")), false);
});

test("a login change after review closes it before anything is sent", async () => {
  await mount(React.createElement(PerpsScreen));
  await click("Stop all agents"); assert.ok(stopNow());
  tenant = OTHER;
  await act(async () => ui.container.querySelector<HTMLButtonElement>('[aria-label="Refresh account"]')!.click()); await settle();
  assert.equal(stopNow(), undefined); assert.equal(deletes().length, 0);
});

test("an unreadable Perps wallet never disables the stop: it confirms the login itself", async () => {
  grantsFail = true;
  await mount(React.createElement(PerpsScreen));
  assert.match(ui.container.textContent!, /Perps wallet could not be verified/);
  await click("Stop all agents"); await click("Stop all agents now");
  assert.deepEqual(deletes().map(write => write.body), [{ purpose: "delete-agent", expectedTenant: OWNER }]);
  assert.match(ui.container.textContent!, /Stop request accepted for Spot, Perps and Solana/);
});

test("after a stop the killed permission is not offered again, and a new wallet can be made in this browser", async () => {
  activeGrant = null; localGrant = grant();
  await mount(React.createElement(PerpsWalletView, { offered: true, creating: false, signer }));
  assert.ok([...ui.container.querySelectorAll("button")].some(button => button.textContent === "Retry saved permission activation"));
  await click("Stop all agents"); await click("Stop all agents now");
  assert.equal((localGrant as Grant | null), null); assert.equal(archived.length, 1);
  assert.equal([...ui.container.querySelectorAll("button")].some(button => button.textContent === "Retry saved permission activation"), false);
  await acknowledge(); await click("Create Perps wallet");
  assert.ok(events.includes("mint")); assert.equal(events.includes("preflight"), false); assert.equal(events.includes("retry"), false);
  assert.match(ui.container.textContent!, /Permission activated/);
});

test("another login's archived Perps record is not replaced from here", async () => {
  activeGrant = null; localGrant = null; archived = [{ ...grant(), owner: OTHER } as Grant];
  await mount(React.createElement(PerpsWalletView, { offered: true, creating: true, signer }));
  await acknowledge(); await click("Create Perps wallet");
  assert.equal(events.includes("mint"), false);
  assert.match(ui.container.textContent!, /could not be matched to this login.*Nothing was stopped or signed/);
});

test("a stop during a create in flight voids it: nothing is saved or handed off after the kill", async () => {
  activeGrant = null; localGrant = null; mintWait = deferred<void>();
  await mount(React.createElement(PerpsWalletView, { offered: true, creating: true, signer }));
  await acknowledge(); await ui.click("Create Perps wallet"); await settle();
  assert.ok(events.includes("mint"));
  await click("Stop all agents"); await click("Stop all agents now");
  assert.equal(deletes().length, 1);
  await act(async () => mintWait!.resolve()); await settle();
  assert.equal(activeGrant, null); assert.equal(localGrant, null);
  assert.equal(ui.container.textContent!.includes("Permission activated"), false);
  assert.match(ui.container.textContent!, /Stop request accepted/);
});

test("one browser copy that cannot be cleared still clears the other, and says so", async () => {
  clearThrows = "spot"; localGrant = grant();
  await mount(React.createElement(PerpsWalletView, { offered: true, creating: false, signer }));
  await click("Stop all agents"); await click("Stop all agents now");
  assert.ok(events.includes("clear-perps")); assert.equal(localGrant, null);
  assert.match(ui.container.textContent!, /saved spot permission could not be cleared/);
});
