import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import type { Grant, MintOptions } from "@/lib/session";
import type { AccountState } from "./HostedControls";

const OWNER = `0x${"a".repeat(40)}`;
const FACTORY = `0x${"e".repeat(40)}`;
const ACCOUNT: AccountState = { session: { hosted: true, address: OWNER }, status: { exists: false, tenant: OWNER } };
const GRANT = { smartAccount: `0x${"b".repeat(40)}`, owner: OWNER, sessionKeyAddress: `0x${"c".repeat(40)}`, chainId: 4663,
  caps: { perTradeUsdg: 10, dailyUsdg: 50, expiryDays: 7, maxDrawdownPct: 5, maxOpsPerDay: 24 },
  serialized: "same-signed-permission", grantedAt: 1, expiresAt: 604801, demoSessionPrivateKey: `0x${"d".repeat(64)}`,
  binding: { version: "privy-did-owner-v1", nonce: "same-nonce", ownerSignature: "0xsame-signature", did: "did:privy:test" },
} as Grant;
let testDom: typeof import("./test-dom").testDom;
let CreateAgent: typeof import("./screens/CreateAgent").CreateAgent;
let ui: ReturnType<typeof testDom>;
let factory: string | undefined;
let stored: Grant | null;
let writes: Record<string, unknown>[];
let mints: MintOptions[];
let retries: Grant[];
let handedOff: boolean;
let signError: Error | null;
let saveResponse: (() => Response | Promise<Response>) | undefined;
let current: { kind: "ready"; account: AccountState } | { kind: "changed" };
let values: Record<string, unknown>;
const originalFetch = globalThis.fetch;

before(async () => {
  const boot = new JSDOM("<!doctype html><p></p>", { pretendToBeVisual: true });
  Object.assign(globalThis, { window: boot.window, document: boot.window.document });
  ({ testDom } = await import("./test-dom"));
  Reflect.deleteProperty(globalThis, "window"); Reflect.deleteProperty(globalThis, "document"); boot.window.close();
  const path = fileURLToPath(new URL("./screens/CreateAgent.tsx", import.meta.url));
  const loader = Module as unknown as { _load: (id: string, parent: { filename?: string }, isMain: boolean) => unknown };
  const load = loader._load;
  const intercepted = mock.method(loader, "_load", function (this: typeof loader, id: string, parent: { filename?: string }, isMain: boolean) {
    if (parent?.filename === path) {
      if (id === "@/terminal/usePrivyOwner") return { usePrivyOwner: () => ({ account: { address: OWNER }, did: "did:privy:test" }) };
      if (id === "@/lib/trencher-permission") return { get TRENCHER_FACTORY() { return factory; } };
      if (id === "@/lib/verified-adapter") return { verifiedAdapter: async () => undefined };
      if (id === "../tier") return { loadTier: async () => null, newAgentQualifies: () => true };
      if (id === "../account-session") return { fetchAccountForSession: async () => current };
      if (id === "@/lib/saved-grant-binding") return { loadRecoveryGrants: () => [], trustedSavedGrant: async (candidate: Grant) => candidate.owner === OWNER };
      if (id === "@/lib/session") return {
        loadGrant: () => stored,
        isPrivyOwned: (grant: Grant) => grant.binding?.version === "privy-did-owner-v1",
        createPrivyOwnedWallet: async (_owner: unknown, _did: string, options: MintOptions) => {
          mints.push(options);
          if (signError) throw signError;
          stored = { ...GRANT, caps: options.caps };
          return { local: stored, handoff: { ok: handedOff, ...(!handedOff ? { error: "temporary activation failure" } : {}) } };
        },
        retryGrantHandoff: async (grant: Grant) => { retries.push(grant); return { ok: handedOff, ...(!handedOff ? { error: "still unavailable" } : {}) }; },
      };
    }
    return load.call(this, id, parent, isMain);
  });
  try { CreateAgent = createRequire(import.meta.url)(path).CreateAgent; }
  finally {
    intercepted.mock.restore();
  }
});

beforeEach(() => {
  ui = testDom(); factory = FACTORY; stored = null; writes = []; mints = []; retries = [];
  handedOff = true; signError = null; saveResponse = undefined; values = { customTokens: [] };
  current = { kind: "ready", account: ACCOUNT };
  globalThis.fetch = (async (input, init) => {
    if (String(input) !== "/api/settings") throw new Error(`Unexpected request: ${input}`);
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      writes.push(body);
      if (saveResponse) return saveResponse();
      values = { ...values, ...body };
      return Response.json({ ok: true });
    }
    return Response.json({ values });
  }) as typeof fetch;
});
afterEach(async () => { await ui.close(); globalThis.fetch = originalFetch; });
const screen = (account=ACCOUNT) => React.createElement(CreateAgent, { account, onRefresh() {}, onSignedIn() {}, onBack() {}, onDone() {}, onFund() {} });
const mount = async () => ui.render(screen());
const text = () => ui.container.textContent ?? "";
async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(ui.dom.window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(input, value); input.dispatchEvent(new ui.dom.window.Event("input", { bubbles: true })); });
}
async function chooseStrategy(strategy: string) {
  await ui.click("Customise strategy and limits");
  await act(async () => { ui.container.querySelector<HTMLInputElement>(`input[value="${strategy}"]`)!.click(); });
  await ui.click("Set trading limits");
}

describe("new Trencher setup through the actual CreateAgent screen", () => {
  it("starts live with one explicit action, puts Trencher into the first permission, and skips the nonexistent Privy key backup", async () => {
    await mount();
    assert.match(text(), /real-money trades/);
    assert.match(text(), /\$2.50/);
    assert.match(text(), /\$5 per buy · \$25 per 24 hours/);
    assert.match(text(), /\$10 per trade · \$50 per day/);
    assert.match(text(), /7 days · 5% drawdown · 24 operations\/day/);
    assert.equal(ui.container.querySelector<HTMLInputElement>("#agent-name")?.value, "My Merryman");
    assert.equal(writes.length, 0); assert.equal(mints.length, 0);
    await ui.click("Start live Trencher");
    assert.deepEqual(writes, [{ owner: OWNER, agentName: "My Merryman", strategy: "trencher", paperTradingEnabled: true,
      liveTradingEnabled: true, assetMode: "crypto", basketSymbols: [], customTokens: [], discoveryEnabled: true,
      officialCoinsEnabled: true, trencherFastEnabled: true, trencherLiveEnabled: true, tickSeconds: 15 }]);
    assert.equal(mints.length, 1);
    assert.equal(mints[0]!.trencherFactory, FACTORY);
    assert.deepEqual(mints[0]!.caps, GRANT.caps);
    assert.equal(mints[0]!.hostedAs, OWNER);
    assert.equal(mints[0]!.chainId, 4663);
    assert.match(text(), /Your wallet is connected/);
    assert.match(text(), /Add trading funds/);
    assert.doesNotMatch(text(), /I saved my recovery key|I understand: if I lose|Retry activation/);
    assert.match(text(), /Keep access to the sign-in account/);
  });

  it("offers explicit practice with both real-trading switches off and the same initial permission", async () => {
    await mount(); await ui.click("Practise first");
    assert.equal(writes[0]!.liveTradingEnabled, false);
    assert.equal(writes[0]!.trencherLiveEnabled, false);
    assert.equal(writes[0]!.paperTradingEnabled, true);
    assert.equal(mints[0]!.trencherFactory, FACTORY);
    assert.match(text(), /follow paper trades/);
    assert.doesNotMatch(text(), /Add trading funds/);
  });

  it("keeps a saved Privy wallet ready after account refresh and reload while retaining legacy key backup", async () => {
    await mount(); await ui.click("Start live Trencher");
    const active = { ...ACCOUNT, status: { ...ACCOUNT.status, exists: true, grant: GRANT } };
    await ui.render(screen(active));
    assert.match(text(), /Your wallet is connected/);
    assert.doesNotMatch(text(), /I understand: if I lose|I saved my recovery key/);
    await ui.remount(screen(active));
    assert.match(text(), /Your wallet is connected/);
    assert.doesNotMatch(text(), /I understand: if I lose|I saved my recovery key/);
    assert.equal(mints.length, 1);
    stored = { ...GRANT, binding: { ...GRANT.binding!, version: "legacy-wallet-owner-v1" }, demoOwnerPrivateKey: `0x${"f".repeat(64)}` };
    await ui.remount(screen(active));
    assert.match(text(), /I saved my recovery key/);
  });

  it("blocks duplicate clicks before a slow settings save finishes", async () => {
    let finish!: (response: Response) => void;
    saveResponse = () => new Promise(resolve => { finish = resolve; });
    await mount();
    const live = [...ui.container.querySelectorAll("button")].find(button => button.textContent === "Start live Trencher")!;
    await act(async () => { live.click(); live.click(); });
    assert.equal(writes.length, 1); assert.equal(mints.length, 0);
    await act(async () => { finish(Response.json({ ok: true })); });
    assert.equal(mints.length, 1);
  });

  it("does not sign or show success when settings fail, and allows a safe retry", async () => {
    saveResponse = () => Response.json({ error: "settings unavailable", ownerFacing: true }, { status: 503 });
    await mount(); await ui.click("Start live Trencher");
    assert.equal(mints.length, 0);
    assert.match(text(), /settings unavailable/);
    assert.doesNotMatch(text(), /Your wallet is connected/);
    saveResponse = undefined;
    await ui.click("Start live Trencher");
    assert.equal(mints.length, 1);
  });

  it("keeps incomplete signing explicit and does not advertise a connected wallet", async () => {
    signError = new Error("Wallet approval was declined.");
    await mount(); await ui.click("Start live Trencher");
    assert.match(text(), /Wallet approval was declined/);
    assert.doesNotMatch(text(), /Your wallet is connected/);
    assert.equal(retries.length, 0);
    signError = null;
    await ui.click("Start live Trencher");
    assert.equal(mints.length, 2, "a declined signature has no permission to resubmit");
    assert.match(text(), /Your wallet is connected/);
  });

  it("retries a failed activation with the same permission and no second mint or settings write", async () => {
    handedOff = false;
    await mount(); await ui.click("Start live Trencher");
    assert.match(text(), /Retry activation/);
    assert.doesNotMatch(text(), /Your wallet is connected/);
    await ui.click("Retry activation");
    assert.match(text(), /still unavailable/);
    handedOff = true;
    await ui.click("Retry activation");
    assert.equal(mints.length, 1); assert.equal(writes.length, 1);
    assert.equal(retries.length, 2);
    assert.deepEqual(retries[0], stored); assert.deepEqual(retries[1], stored);
    assert.match(text(), /Your wallet is connected/);
  });

  it("does not mint or write for an existing agent or a changed account", async () => {
    await ui.render(screen({ ...ACCOUNT, status: { ...ACCOUNT.status, exists: true } }));
    assert.match(text(), /Your agent is already set up/);
    assert.equal(mints.length, 0); assert.equal(writes.length, 0);
    await ui.remount(screen()); current = { kind: "changed" };
    await ui.click("Start live Trencher");
    assert.equal(mints.length, 0); assert.equal(writes.length, 0);
    assert.match(text(), /couldn.t confirm your account/);
  });

  it("keeps another strategy available when the verified Trencher deployment is missing", async () => {
    factory = undefined;
    await mount();
    assert.match(text(), /verified trading vault is not configured/);
    await ui.click("Start live Trencher");
    assert.equal(writes.length, 0); assert.equal(mints.length, 0);
    await chooseStrategy("steady-basket");
    assert.match(text(), /What should it trade/);
    await ui.click("Continue"); await ui.click("Create agent");
    assert.equal(writes[0]!.strategy, "steady-basket");
    assert.equal(writes[0]!.liveTradingEnabled, false);
    assert.equal(mints[0]!.trencherFactory, undefined);
  });

  it("retains alternative strategies and includes a custom coin in their first permission", async () => {
    await mount(); await chooseStrategy("steady-basket");
    const contract = `0x${"d".repeat(40)}`;
    const field = (label: string) => [...ui.container.querySelectorAll("label")].find(node => node.textContent?.startsWith(label))!.querySelector("input")!;
    await type(field("Symbol"), "TEST"); await type(field("Contract address"), contract);
    await ui.click("add coin"); await ui.click("Continue"); await ui.click("Create agent");
    assert.equal(writes[0]!.strategy, "steady-basket");
    assert.ok((writes[0]!.basketSymbols as string[]).includes("TEST"));
    assert.deepEqual(mints[0]!.extraTokens, [{ symbol: "TEST", address: contract, decimals: 18 }]);
    assert.equal(mints[0]!.trencherFactory, undefined);
    assert.equal(writes[0]!.trencherLiveEnabled, undefined);
  });

  it("lets a customised Trencher keep lower limits and still skips manual token entry", async () => {
    await mount(); await chooseStrategy("trencher");
    assert.match(text(), /Clear limits/);
    assert.doesNotMatch(text(), /What should it trade|Contract address/);
    const perTrade = [...ui.container.querySelectorAll("label")].find(label => label.textContent?.startsWith("Per trade, USD"))!.querySelector("input")!;
    const perDay = [...ui.container.querySelectorAll("label")].find(label => label.textContent?.startsWith("Per day, USD"))!.querySelector("input")!;
    await type(perTrade, "2"); await type(perDay, "5");
    await ui.click("Create agent");
    assert.equal(mints[0]!.caps.perTradeUsdg, 2);
    assert.equal(mints[0]!.caps.dailyUsdg, 5);
    assert.equal(mints[0]!.trencherFactory, FACTORY);
    assert.equal(writes[0]!.liveTradingEnabled, false);
    assert.equal(writes[0]!.trencherLiveEnabled, false);
  });
});
