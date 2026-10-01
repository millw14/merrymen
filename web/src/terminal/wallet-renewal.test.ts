import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { fileURLToPath } from "node:url";
import React, { act } from "react";
import { bindingMessage, buildCallPermissions, firstEnableEnvelope, wallShape, wallSignable, type GrantCaps, type StoredGrant } from "@merrymen/core";
import type { MintOptions, SavedWallet } from "@/lib/session";
import { JSDOM } from "jsdom";
import { privateKeyToAccount } from "viem/accounts";
import type { LocalAccount } from "viem";
import type { PrivyOwner } from "./usePrivyOwner";
import { needsPermissionReplacement } from "@/lib/permission-replacement";
import { loadRecoveryGrants } from "@/lib/saved-grant-binding";
let deferred: typeof import("./test-dom").deferred;
let json: typeof import("./test-dom").json;
let testDom: typeof import("./test-dom").testDom;

const address = `0x${"1".repeat(40)}` as const;
const grant = {
  smartAccount: address,
  owner: address,
  sessionKeyAddress: `0x${"2".repeat(40)}`,
  demoOwnerPrivateKey: `0x${"3".repeat(64)}`,
  chainId: 4663,
  caps: { perTradeUsdg: 50, dailyUsdg: 500, expiryDays: 14, maxDrawdownPct: 5, maxOpsPerDay: 48 },
  grantedAt: Math.floor(Date.now() / 1000),
  expiresAt: Math.floor(Date.now() / 1000) + 14 * 86_400,
  grantTokens: [],
  grantFeatures: [],
} as unknown as StoredGrant;
const fixtureAddress = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const trencherFactory = fixtureAddress(600);
let renew: (options: MintOptions) => Promise<unknown>;
let preflight: (owner: LocalAccount, options: MintOptions) => Promise<void>;
let preflightCalls = 0;
type RevocationWallet = { ownerKey?: string; smartAccount: string; chainId: number };
let revoke: (wallet: RevocationWallet) => Promise<unknown>;
let revokeWallets: RevocationWallet[] = [];
let restoredKeys: unknown[] = [];
let previewOwner: (key: string, chainId: number) => Promise<{ smartAccount: string; owner: string }>;
let stop: (expectedTenant?: string | null) => Promise<void>;
let stopCalls = 0;
let revokeCalls = 0;
let mintCalls = 0;
let activeGrant = grant;
let storedGrantAvailable = true;
let privyOwner: PrivyOwner | null = null;
let Wallet: typeof import("./screens/Wallet").default;
let ui: ReturnType<typeof testDom>;
let savedWallets: SavedWallet[] = [];
const originalFetch = globalThis.fetch;

before(async () => {
  // Load React DOM while a browser exists so real text-input events work.
  const boot = new JSDOM("<!doctype html><p></p>");
  Object.assign(globalThis, { window: boot.window, document: boot.window.document });
  ({ deferred, json, testDom } = await import("./test-dom"));
  Reflect.deleteProperty(globalThis, "window");
  Reflect.deleteProperty(globalThis, "document");
  boot.window.close();
  // Load the actual screen and its click handler. Only wallet/RPC boundaries
  // are replaced: this test must not sign a permission or contact a chain.
  const walletPath = fileURLToPath(new URL("./screens/Wallet.tsx", import.meta.url));
  const loader = Module as unknown as { _load: (id: string, parent: { filename?: string }, isMain: boolean) => unknown };
  const load = loader._load;
  const intercepted = mock.method(loader, "_load", function (this: typeof loader, id: string, parent: { filename?: string }, isMain: boolean) {
    if (parent?.filename === walletPath) {
      if (id === "next/link") return ({ children, ...props }: React.ComponentProps<"a">) => React.createElement("a", props, children);
      if (id === "@/terminal/usePrivyOwner") return { usePrivyOwner: () => privyOwner };
      if (id === "@/lib/trencher-permission") return { TRENCHER_FACTORY: trencherFactory };
      if (id === "@/lib/verified-adapter") return { verifiedAdapter: async () => undefined };
      if (id === "@/lib/revoke-client") return { revokeFromBrowser: async (wallet: RevocationWallet) => { revokeCalls++; revokeWallets.push(wallet); return revoke(wallet); } };
      if (id === "@/lib/stop-agent") return { stopAgent: (expectedTenant?: string | null) => { stopCalls++; return stop(expectedTenant); } };
      if (id === "@/lib/session") return {
        FAUCET_URL: "https://faucet.testnet.chain.robinhood.com",
        loadGrant: () => storedGrantAvailable ? activeGrant : null,
        listSavedWallets: () => savedWallets,
        isPrivyOwned: (g: StoredGrant | null) => g?.binding?.version === "privy-did-owner-v1",
        previewOwnerAccount: (key: string, chainId: number) => previewOwner(key, chainId),
        readFunding: async () => ({ gasWei: 1n, usdgUnits: 71_580_000n, usdg: 71.58 }),
        preflightAgentGrant: (owner: LocalAccount, options: MintOptions) => { preflightCalls++; return preflight(owner, options); },
        createPrivyOwnedWallet: (_owner: unknown, _did: unknown, options: Parameters<typeof renew>[0]) => { mintCalls++; return renew(options); },
        restoreAgentWallet: (key: unknown, options: Parameters<typeof renew>[0]) => { mintCalls++; restoredKeys.push(key); return renew(options); },
      };
    }
    return load.call(this, id, parent, isMain);
  });
  try {
    Wallet = createRequire(import.meta.url)(walletPath).default;
  } finally {
    intercepted.mock.restore();
  }
});

beforeEach(() => {
  ui = testDom();
  savedWallets = [];
  activeGrant = grant;
  storedGrantAvailable = true;
  privyOwner = null;
  revokeCalls = 0;
  revokeWallets = [];
  restoredKeys = [];
  mintCalls = 0;
  preflightCalls = 0;
  stopCalls = 0;
  revoke = async () => ({ transactionHash: `0x${"4".repeat(64)}` });
  previewOwner = async () => ({ smartAccount: address, owner: address });
  stop = async () => {};
  preflight = async () => {};
  renew = async () => { throw new Error("Unexpected signing request"); };
  Object.defineProperty(ui.dom.window.HTMLElement.prototype, "scrollIntoView", { configurable: true, value() {} });
  localStorage.setItem("merrymen.grant.backedup.v1", "1");
  globalThis.fetch = async (input) => {
    const path = String(input);
    if (path === "/api/grants") return json({ exists: true, grant: activeGrant, gasSponsored: true });
    if (path === "/api/auth/session") return json({ hosted: false, address: null });
    if (path === "/api/settings") return json({ values: { customTokens: [], basketSymbols: [] } });
    throw new Error(`Unexpected request: ${path}`);
  };
});

afterEach(async () => {
  await ui.close();
  globalThis.fetch = originalFetch;
});

async function acknowledge(text: string) {
  const label = [...ui.container.querySelectorAll("label")].find(label => label.textContent?.includes(text));
  assert.ok(label, `missing acknowledgment: ${text}`);
  await act(async () => { (label.querySelector("input") as HTMLInputElement).click(); });
}

async function enterRestoreKey(key = grant.demoOwnerPrivateKey!) {
  const input = ui.container.querySelector("input.restore-input") as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(ui.dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, key);
    input.dispatchEvent(new ui.dom.window.Event("input", { bubbles: true }));
  });
  return input;
}

function renewalButton(): HTMLButtonElement {
  const button = [...ui.container.querySelectorAll<HTMLButtonElement>("#resign button")]
    .find(button => button.textContent?.trim() === "revoke earlier permissions & re-sign");
  assert.ok(button, "the permission renewal action is available");
  return button;
}

function renewalInput(label: string): HTMLInputElement {
  const field = [...ui.container.querySelectorAll("#resign .field")]
    .find(element => element.querySelector(".field-label")?.textContent === label);
  const input = field?.querySelector("input");
  assert.ok(input, `renewal field ${label}`);
  return input;
}

async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(ui.dom.window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new ui.dom.window.Event("input", { bubbles: true }));
  });
}

function useRenewalOwner(kind: "legacy" | "Privy") {
  const owner = privateKeyToAccount(grant.demoOwnerPrivateKey as `0x${string}`);
  activeGrant = { ...grant, owner: owner.address };
  if (kind === "Privy") {
    const did = "did:privy:renewal-preflight";
    privyOwner = { account: owner, did };
    activeGrant = {
      ...activeGrant,
      demoOwnerPrivateKey: undefined,
      binding: { version: "privy-did-owner-v1", did, nonce: "prior-binding", ownerSignature: `0x${"0".repeat(130)}` },
    };
  }
  return owner;
}

function storageSnapshot() {
  return Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)!)
    .sort().map(key => [key, localStorage.getItem(key)]);
}

function assertExistingPermissionKept(before: ReturnType<typeof storageSnapshot>) {
  assert.equal(stopCalls, 0, "preflight refusal must not stop the active worker");
  assert.equal(revokeCalls, 0, "preflight refusal must not request on-chain revocation");
  assert.equal(mintCalls, 0, "preflight refusal must not ask for a replacement signature");
  assert.equal(needsPermissionReplacement(activeGrant), false, "the existing permission must remain re-armable");
  assert.deepEqual(storageSnapshot(), before, "recovery storage and replacement markers must remain unchanged");
  assert.doesNotMatch(ui.container.textContent!, /Earlier permissions were revoked/);
  assert.doesNotMatch(ui.container.textContent!, /this wallet isn't active/);
}

describe("the funded wallet's re-sign control", () => {
  it("jumps to the renewal anchor after the grant loads, and never again on later renders", async () => {
    ui.dom.window.history.replaceState(null, "", "/grant#resign");
    const pendingGrant = deferred<Response>();
    const fetch = globalThis.fetch;
    globalThis.fetch = (input, init) => String(input) === "/api/grants" ? pendingGrant.promise : fetch(input, init);
    const scrolled: string[] = [];
    Object.defineProperty(ui.dom.window.HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value(this: HTMLElement) { scrolled.push(this.id); },
    });
    await ui.render(React.createElement(Wallet));
    assert.equal(ui.container.querySelector("#resign"), null, "the grant is still loading");
    assert.deepEqual(scrolled, []);
    await act(async () => { pendingGrant.resolve(json({ exists: true, grant: activeGrant, gasSponsored: true })); });
    assert.ok(ui.container.querySelector("#resign"));
    assert.deepEqual(scrolled, ["resign"], "loading the grant must make the anchor reachable");
    await acknowledge("I authorize revoking");
    await type(renewalInput("drawdown limit"), "8");
    await ui.render(React.createElement(Wallet));
    assert.deepEqual(scrolled, ["resign"], "form changes must not drag the owner back to the anchor");
  });

  for (const binding of [undefined, { version: "legacy-wallet-owner-v1" }, { version: "privy-did-owner-v1" }] as const) {
    it(`adopts the authenticated server's public grant with ${binding?.version ?? "no binding"} without overwriting local recovery data`, async () => {
      storedGrantAvailable = false;
      activeGrant = { ...grant, demoOwnerPrivateKey: undefined, binding } as StoredGrant;
      const recovery = JSON.stringify({ ...grant, serialized: "private serialized permission", demoSessionPrivateKey: `0x${"6".repeat(64)}` });
      localStorage.setItem("merrymen.grant.v1", recovery);
      localStorage.removeItem("merrymen.grant.backedup.v1");
      await ui.render(React.createElement(Wallet));
      assert.ok(ui.container.querySelector("#resign"), "public grant display does not require a local key or binding version");
      assert.match(ui.container.textContent!, /breaker 5%/);
      assert.match(ui.container.textContent!, /max 50 USDG\/trade/);
      assert.match(ui.container.textContent!, /500 USDG\/day/);
      assert.equal(ui.container.querySelector("input.restore-input"), null, "a second browser is not sent to the lost-wallet form");
      assert.equal(localStorage.getItem("merrymen.grant.v1"), recovery, "the server's public grant cannot erase owner/session recovery material");
      assert.equal(mintCalls, 0);
      assert.equal(revokeCalls, 0);
    });
  }

  for (const missing of ["local grant", "serialized key"] as const) {
    it(`explains a missing ${missing} when re-arming and never submits a public grant`, async () => {
      activeGrant = { ...grant, serialized: undefined } as unknown as StoredGrant;
      let posted = 0;
      globalThis.fetch = async (input, init) => {
        const path = String(input);
        if (path === "/api/grants" && init?.method === "POST") { posted++; return json({ ok: true }); }
        if (path === "/api/grants") return json({ exists: false });
        if (path === "/api/auth/session") return json({ hosted: false, address: null });
        if (path === "/api/settings") return json({ values: { customTokens: [], basketSymbols: [] } });
        throw new Error(`Unexpected request: ${path}`);
      };
      await ui.render(React.createElement(Wallet));
      if (missing === "local grant") storedGrantAvailable = false;
      await ui.click("re-arm this wallet");
      assert.match(ui.container.querySelector(".desync-panel")!.textContent!, /this browser doesn't hold a copy of the signed key/);
      assert.match(ui.container.querySelector(".desync-panel")!.textContent!, /Re-sign the key below instead/);
      assert.equal(posted, 0);
      assert.equal(stopCalls, 0);
      assert.equal(revokeCalls, 0);
      assert.equal(mintCalls, 0);
    });
  }

  for (const [key, label] of [
    ["maxDrawdownPct", "drawdown limit"],
    ["perTradeUsdg", "most it can spend on one trade"],
    ["dailyUsdg", "most it can spend in a day"],
    ["expiryDays", "auto-expire the agent after"],
    ["maxOpsPerDay", "most trades per day"],
  ] as const) {
    it(`blocks an untouched zero ${key} from a legacy grant until its owner corrects it`, async () => {
      activeGrant = { ...grant, caps: { ...grant.caps, [key]: 0 } };
      let signedCaps: GrantCaps | undefined;
      renew = async ({ caps }) => {
        signedCaps = structuredClone(caps);
        return { local: { ...activeGrant, caps }, handoff: { ok: true } };
      };
      await ui.render(React.createElement(Wallet));
      await acknowledge("I authorize revoking");
      assert.equal(renewalInput(label).value, "0", "the loaded limit is displayed without automatic repair");
      assert.equal(renewalButton().disabled, true);
      assert.ok(ui.container.querySelector('#resign [role="alert"]'));
      await ui.click("revoke earlier permissions & re-sign");
      assert.equal(signedCaps, undefined, "an untouched invalid cap must never reach the signer");
      assert.equal(stopCalls, 0, "invalid caps must not stop the current permission");
      assert.equal(revokeCalls, 0, "invalid caps must not spend fees revoking the current permission");
      await type(renewalInput(label), String(grant.caps[key]));
      assert.equal(signedCaps, undefined, "the owner's correction still requires an explicit signature");
      assert.equal(renewalButton().disabled, false);
      await ui.click("revoke earlier permissions & re-sign");
      assert.deepEqual(signedCaps, grant.caps, "only the owner-corrected cap changes");
    });
  }

  it("requires an explicit value for a missing legacy cap instead of inserting a default", async () => {
    const legacyCaps: Partial<GrantCaps> = { ...grant.caps };
    delete legacyCaps.maxOpsPerDay;
    activeGrant = { ...grant, caps: legacyCaps as GrantCaps };
    let signedCaps: GrantCaps | undefined;
    renew = async ({ caps }) => {
      signedCaps = structuredClone(caps);
      return { local: { ...activeGrant, caps }, handoff: { ok: true } };
    };
    await ui.render(React.createElement(Wallet));
    await acknowledge("I authorize revoking");
    assert.equal(renewalButton().disabled, true);
    await ui.click("revoke earlier permissions & re-sign");
    assert.equal(signedCaps, undefined);
    assert.equal(stopCalls, 0);
    assert.equal(revokeCalls, 0);
    await type(renewalInput("most trades per day"), "24");
    await ui.click("revoke earlier permissions & re-sign");
    assert.deepEqual(signedCaps, { ...grant.caps, maxOpsPerDay: 24 });
  });

  it("shows and preserves the existing 5% drawdown limit when renewing without changes", async () => {
    let signedCaps: GrantCaps | undefined;
    renew = async ({ caps }) => {
      signedCaps = structuredClone(caps);
      return { local: { ...grant, caps }, handoff: { ok: true } };
    };
    await ui.render(React.createElement(Wallet));
    await acknowledge("I authorize revoking");
    assert.equal(renewalInput("drawdown limit").value, "5");
    assert.match(ui.container.querySelector("#resign")!.textContent!, /at or above/);
    assert.match(ui.container.querySelector("#resign")!.textContent!, /Raising it allows a larger loss/);
    assert.equal(signedCaps, undefined, "loading the form never signs");
    await ui.click("revoke earlier permissions & re-sign");
    assert.deepEqual(signedCaps, grant.caps);
    await ui.click("Edit permissions again");
    assert.equal(renewalInput("drawdown limit").value, "5");
  });

  it("shows an explicit owner's drawdown edit before signing exactly that choice", async () => {
    let signedCaps: GrantCaps | undefined;
    renew = async ({ caps }) => {
      signedCaps = structuredClone(caps);
      return { local: { ...grant, caps }, handoff: { ok: true } };
    };
    await ui.render(React.createElement(Wallet));
    await acknowledge("I authorize revoking");
    await type(renewalInput("drawdown limit"), "8");
    assert.equal(signedCaps, undefined, "editing does not sign or submit");
    assert.match(ui.container.querySelector("#resign")!.textContent!, /breaker 5 % → 8 %/);
    await ui.click("revoke earlier permissions & re-sign");
    assert.deepEqual(signedCaps, { ...grant.caps, maxDrawdownPct: 8 });
    assert.match(ui.container.textContent!, /Permission renewed/);
  });

  it("refuses blank, non-numeric, fractional, zero and over-maximum drawdown edits", async () => {
    let signs = 0;
    renew = async ({ caps }) => {
      signs++;
      return { local: { ...grant, caps }, handoff: { ok: true } };
    };
    await ui.render(React.createElement(Wallet));
    await acknowledge("I authorize revoking");
    for (const invalid of ["", "oops", "5.5", "0", "51"]) {
      await type(renewalInput("drawdown limit"), invalid);
      assert.equal(renewalInput("drawdown limit").value, invalid, "raw text stays visible");
      assert.equal(renewalInput("drawdown limit").getAttribute("aria-invalid"), "true");
      const button = renewalButton();
      assert.equal(button.disabled, true, `cannot sign invalid ${JSON.stringify(invalid)}`);
      assert.ok(ui.container.querySelector('#resign [role="alert"]'));
      await ui.click("revoke earlier permissions & re-sign");
      assert.equal(signs, 0, "never substitutes the previous valid number into a signature");
      assert.equal(stopCalls, 0, "invalid edits do not stop the existing permission");
      assert.equal(revokeCalls, 0, "invalid edits do not prompt revocation or spend fees");
    }
    await type(renewalInput("drawdown limit"), "4");
    await ui.click("revoke earlier permissions & re-sign");
    assert.equal(signs, 1, "a valid lower owner-chosen limit can be signed");
  });

  it("keeps an invalid limit blocked when another field receives a valid edit", async () => {
    let signs = 0;
    renew = async () => { signs++; return { local: grant, handoff: { ok: true } }; };
    await ui.render(React.createElement(Wallet));
    await acknowledge("I authorize revoking");
    await type(renewalInput("drawdown limit"), "51");
    await type(renewalInput("most it can spend on one trade"), "25");
    assert.equal(renewalButton().disabled, true);
    assert.ok(ui.container.querySelector('#resign [role="alert"]'));
    await ui.click("revoke earlier permissions & re-sign");
    assert.equal(signs, 0);
    assert.equal(stopCalls, 0);
    assert.equal(revokeCalls, 0);
  });

  it("does not call a 500 response a discarded wallet, and recovers on retry", async () => {
    let unavailable = true;
    savedWallets = [{ smartAccount: address, owner: address, chainId: 4663,
      ownerKey: grant.demoOwnerPrivateKey as `0x${string}`, current: true }];
    globalThis.fetch = async (input) => {
      const path = String(input);
      if (path === "/api/grants") return unavailable ? json({ error: "grant store unavailable" }, 500) : json({ exists: true, grant, gasSponsored: true });
      if (path === "/api/auth/session") return json({ hosted: false, address: null });
      if (path === "/api/settings") return json({ values: { customTokens: [], basketSymbols: [] } });
      throw new Error(`Unexpected request: ${path}`);
    };
    await ui.render(React.createElement(Wallet));
    assert.match(ui.container.textContent!, /Couldn.t check your agent/);
    assert.doesNotMatch(ui.container.textContent!, /this wallet isn't active|re-sign this key/);
    assert.match(ui.container.textContent!, /Wallets saved in this browser/);
    await ui.click("show recovery key");
    assert.ok(ui.container.textContent!.includes(grant.demoOwnerPrivateKey!), "local recovery remains available during a server outage");
    unavailable = false;
    await ui.click("Try again");
    assert.ok(ui.container.querySelector("#resign"), "the trusted wallet returns after a successful bound read");
  });

  it("rejects a hosted grant belonging to a different signed-in tenant", async () => {
    const a = `0x${"a".repeat(40)}`;
    const b = `0x${"b".repeat(40)}`;
    globalThis.fetch = async (input) => {
      const path = String(input);
      if (path === "/api/grants") return json({ exists: true, tenant: b, grant });
      if (path === "/api/auth/session") return json({ hosted: true, address: a });
      if (path === "/api/settings") return json({ values: { customTokens: [], basketSymbols: [] } });
      throw new Error(`Unexpected request: ${path}`);
    };
    await ui.render(React.createElement(Wallet));
    assert.match(ui.container.textContent!, /Couldn.t check your agent/);
    assert.doesNotMatch(ui.container.textContent!, /re-sign this key|this wallet isn't active/);
  });

  it("does not let an older account response restore signing controls after tab revalidation", async () => {
    const oldGrant = deferred<Response>();
    let reads = 0;
    globalThis.fetch = async (input) => {
      const path = String(input);
      if (path === "/api/grants") return ++reads === 1 ? oldGrant.promise : json({ exists: false });
      if (path === "/api/auth/session") return json({ hosted: false, address: null });
      if (path === "/api/settings") return json({ values: { customTokens: [], basketSymbols: [] } });
      throw new Error(`Unexpected request: ${path}`);
    };
    await ui.render(React.createElement(Wallet));
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    assert.match(ui.container.textContent!, /this wallet isn't active/);
    await act(async () => { oldGrant.resolve(json({ exists: true, grant })); });
    assert.match(ui.container.textContent!, /this wallet isn't active/);
  });

  for (const kind of ["legacy", "Privy"] as const) it(`${kind} renewal refuses a real oversized class + Trencher + v4 wall before replacing the active grant`, async () => {
    const owner = useRenewalOwner(kind);
    const tokens = [1, 2, 3].map(n => ({ symbol: `T${n}`, address: fixtureAddress(n + 100), decimals: 18 }));
    activeGrant = {
      ...activeGrant,
      grantFeatures: ["pons-class", "trencher-vault-v1"],
      grantTokens: tokens.map(token => token.address),
      ponsClassVaultAddress: fixtureAddress(400),
      ponsClassVaultFactoryAddress: fixtureAddress(500),
      trencherFactoryAddress: trencherFactory,
      trencherVaultAddress: fixtureAddress(700),
    };
    localStorage.setItem("merrymen.grant.v1", JSON.stringify({ ...activeGrant, serialized: "existing recoverable permission" }));
    const fetch = globalThis.fetch;
    globalThis.fetch = (input, init) => String(input) === "/api/settings"
      ? Promise.resolve(json({ values: { customTokens: tokens, basketSymbols: [], v4AdapterAddress: fixtureAddress(800), ponsClassVaultFactory: fixtureAddress(500) } }))
      : fetch(input, init);
    let tooWide = "";
    preflight = async (signer, options) => {
      assert.equal(signer.address, owner.address);
      assert.equal(options.expectAccount, address);
      assert.deepEqual(options.extraTokens, tokens);
      assert.equal(options.v4AdapterAddress, fixtureAddress(800));
      assert.equal(options.ponsClassVaultFactory, fixtureAddress(500));
      assert.equal(options.trencherFactory, trencherFactory);
      const shapeWith = (count: number, v4 = true) => wallShape(buildCallPermissions(options.caps, address, {
        extraTokens: options.extraTokens!.slice(0, count),
        ponsClassVaultAddress: fixtureAddress(400),
        ponsClassVaultFactoryAddress: options.ponsClassVaultFactory,
        trencherVaultAddress: fixtureAddress(700),
        trencherFactoryAddress: options.trencherFactory,
        ...(v4 ? { v4AdapterAddress: options.v4AdapterAddress } : {}),
      }) as never);
      assert.equal(shapeWith(3, false).permissions, 27, "the existing pre-v4 wall matches the production shape");
      const shape = shapeWith(3);
      assert.equal(firstEnableEnvelope(shape, { deploying: false }).expectedBounded, 15_749_392n);
      const verdict = wallSignable(shape, { deploying: false, basket: { count: tokens.length, shapeWith } });
      assert.equal(verdict.ok, false, "the real wall sizing gate must refuse this renewal");
      if (verdict.ok) throw new Error("fixture unexpectedly fits");
      tooWide = verdict.why;
      throw new Error(tooWide);
    };
    await ui.render(React.createElement(Wallet));
    await acknowledge("I authorize revoking");
    const before = storageSnapshot();
    await ui.click("revoke earlier permissions & re-sign");
    const panel = ui.container.querySelector("#resign")!;
    assert.ok(panel, "the current wallet stays open after a pre-signing refusal");
    const alert = panel.querySelector('[role="alert"]');
    assert.ok(alert, "the renewal refusal must be visible in the active renewal panel");
    assert.ok(alert.textContent?.includes(tooWide));
    assert.equal(alert.querySelector("a")?.getAttribute("href"), "/settings");
    assert.match(alert.textContent!, /Review custom tokens/);
    assert.match(ui.container.textContent!, /71\.58/);
    assert.match(alert.textContent!, /kept your existing permission unchanged/i);
    assert.equal(preflightCalls, 1);
    assertExistingPermissionKept(before);
  });

  for (const kind of ["legacy", "Privy"] as const) it(`${kind} renewal completes preflight before stopping and signs only after the revocation receipt`, async () => {
    const owner = useRenewalOwner(kind);
    const checked = deferred<void>();
    const receipt = deferred<unknown>();
    const events: string[] = [];
    let checkedOptions: MintOptions | undefined;
    preflight = async (signer, options) => {
      assert.equal(signer.address, owner.address);
      checkedOptions = options;
      events.push("preflight start");
      await checked.promise;
      events.push("preflight passed");
    };
    stop = async () => {
      events.push("stop");
      assert.equal(needsPermissionReplacement(activeGrant), true, "after preflight, the marker still precedes the stop");
      assert.equal(loadRecoveryGrants().length, 1, "public recovery inputs are saved before the stop");
    };
    revoke = async () => {
      events.push("revoke requested");
      const result = await receipt.promise;
      events.push("revocation confirmed");
      return result;
    };
    renew = async options => {
      events.push("mint fresh grant");
      assert.equal(options, checkedOptions, "the reviewed settings are passed to the fresh signing operation");
      assert.equal(events.at(-2), "revocation confirmed", "nothing signed during preflight can be reused after invalidation");
      return { local: { ...activeGrant, sessionKeyAddress: fixtureAddress(900) }, handoff: { ok: true } };
    };
    await ui.render(React.createElement(Wallet));
    await acknowledge("I authorize revoking");
    const before = storageSnapshot();
    await ui.click("revoke earlier permissions & re-sign");
    assert.deepEqual(events, ["preflight start"]);
    assertExistingPermissionKept(before);
    await act(async () => { checked.resolve(); });
    assert.deepEqual(events, ["preflight start", "preflight passed", "stop", "revoke requested"]);
    assert.equal(mintCalls, 0, "revocation requested without a confirmed receipt must not mint");
    await act(async () => { receipt.resolve({ transactionHash: `0x${"4".repeat(64)}` }); });
    assert.deepEqual(events, ["preflight start", "preflight passed", "stop", "revoke requested", "revocation confirmed", "mint fresh grant"]);
    assert.equal(preflightCalls, 1);
    assert.equal(mintCalls, 1);
    assert.match(ui.container.textContent!, /Permission renewed/);
  });

  const failedSettings = [
    ["network failure", async () => { throw new Error("settings offline"); }],
    ["HTTP failure", async () => json({ values: { customTokens: [] } }, 503)],
    ["error body", async () => json({ error: "settings unavailable" })],
    ["malformed JSON", async () => new Response("not JSON", { status: 200 })],
    ["missing values", async () => json({})],
  ] as const;
  for (const kind of ["legacy", "Privy"] as const) for (const [failure, response] of failedSettings) {
    it(`${kind} renewal keeps its grant on fresh settings ${failure} instead of using the mount-time adapter`, async () => {
      useRenewalOwner(kind);
      localStorage.setItem("merrymen.grant.v1", JSON.stringify({ ...activeGrant, serialized: "old signed permission" }));
      const fetch = globalThis.fetch;
      let settingsReads = 0;
      globalThis.fetch = (input, init) => {
        if (String(input) !== "/api/settings") return fetch(input, init);
        settingsReads++;
        return settingsReads === 1
          ? Promise.resolve(json({ values: { customTokens: [], basketSymbols: [], v4AdapterAddress: fixtureAddress(801) } }))
          : response();
      };
      await ui.render(React.createElement(Wallet));
      await acknowledge("I authorize revoking");
      const before = storageSnapshot();
      await ui.click("revoke earlier permissions & re-sign");
      assert.equal(settingsReads, 2, "renewal requires a fresh settings response");
      assert.equal(preflightCalls, 0, "stale mounted settings must not reach preflight or signing");
      assert.match(ui.container.querySelector('#resign [role="alert"]')?.textContent ?? "", /Could not refresh your trading settings/);
      assertExistingPermissionKept(before);
    });
  }

  it("shows signing progress, then confirms only a server-accepted renewal", async () => {
    const done = deferred<unknown>();
    renew = async ({ onStatus }) => { onStatus("checking your permission…"); return done.promise; };
    await ui.render(React.createElement(Wallet));
    await acknowledge("I authorize revoking");
    await ui.click("revoke earlier permissions & re-sign");
    const panel = ui.container.querySelector("#resign")!;
    assert.match(panel.querySelector('[role="status"]')?.textContent ?? "", /checking your permission/);
    assert.equal(panel.querySelector("fieldset")?.disabled, true);
    await act(async () => { done.resolve({ local: { ...grant, grantedAt: grant.grantedAt + 1 }, handoff: { ok: true } }); });
    assert.match(panel.querySelector('[role="status"]')?.textContent ?? "", /Permission renewed/);
    assert.doesNotMatch(panel.textContent!, /checking your permission/);
    assert.equal(panel.querySelector("fieldset"), null);
    assert.equal(panel.querySelector('a[href="/chat"]')?.textContent, "View agent status");
    assert.equal(mintCalls, 1);
    assert.equal(revokeCalls, 1);
  });

  it("shows a server refusal and never reports that permission renewal succeeded", async () => {
    renew = async () => ({ local: grant, handoff: { ok: false, error: "Sign in again to renew your permission." } });
    await ui.render(React.createElement(Wallet));
    await acknowledge("I authorize revoking");
    await ui.click("revoke earlier permissions & re-sign");
    assert.match(ui.container.textContent!, /Sign in again to renew your permission/);
    assert.doesNotMatch(ui.container.textContent!, /Permission renewed/);
  });

  it("does not carry the previous renewal confirmation through switching wallets", async () => {
    renew = async () => ({ local: grant, handoff: { ok: true } });
    await ui.render(React.createElement(Wallet));
    await acknowledge("I authorize revoking");
    await ui.click("revoke earlier permissions & re-sign");
    assert.match(ui.container.textContent!, /Permission renewed/);
    await ui.click("switch to another wallet");
    assert.doesNotMatch(ui.container.textContent!, /Permission renewed/);
    await ui.click("← never mind, keep 0x1111…1111");
    assert.ok(ui.container.querySelector("#resign"), "the same screen returns to the current grant");
    assert.doesNotMatch(ui.container.textContent!, /Permission renewed/);
  });
  it("does not sign without fee consent and waits for confirmed revocation before minting", async () => {
    const receipt = deferred<unknown>();
    revoke = () => receipt.promise;
    renew = async () => ({ local: { ...grant, sessionKeyAddress: `0x${"8".repeat(40)}` }, handoff: { ok: true } });
    await ui.render(React.createElement(Wallet));
    await ui.click("revoke earlier permissions & re-sign");
    assert.equal(revokeCalls, 0);
    await acknowledge("I authorize revoking");
    await ui.click("revoke earlier permissions & re-sign");
    assert.equal(revokeCalls, 1);
    assert.equal(mintCalls, 0);
    await act(async () => { receipt.resolve({ transactionHash: `0x${"4".repeat(64)}` }); });
    assert.equal(mintCalls, 1);
    assert.match(ui.container.textContent!, /Permission renewed/);
    await ui.click("Edit permissions again");
    assert.ok(ui.container.querySelector("#resign fieldset"));
    const sign = [...ui.container.querySelectorAll("button")].find(button => button.textContent === "revoke earlier permissions & re-sign")!;
    assert.equal(sign.disabled, true, "each new renewal requires fresh fee consent");
  });

  it("unknown revocation preserves recovery and prevents minting or rearming the saved key", async () => {
    revoke = async () => { throw new Error("receipt unconfirmed; retry the pending operation"); };
    await ui.render(React.createElement(Wallet));
    await acknowledge("I authorize revoking");
    await ui.click("revoke earlier permissions & re-sign");
    assert.equal(mintCalls, 0);
    assert.match(ui.container.textContent!, /receipt unconfirmed/);
    assert.doesNotMatch(ui.container.textContent!, /Permission renewed/);
    await ui.click("review and renew permission");
    assert.equal(needsPermissionReplacement(activeGrant), true);
    assert.equal([...ui.container.querySelectorAll("button")].some(button => button.textContent === "re-arm this wallet"), false);
    assert.equal(activeGrant.demoOwnerPrivateKey, grant.demoOwnerPrivateKey);
  });

  it("on-chain revocation remains available when the service stop fails", async () => {
    stop = async () => { throw new Error("service unavailable"); };
    await ui.render(React.createElement(Wallet));
    await acknowledge("I understand revocation uses ETH");
    await ui.click("Stop & revoke on-chain");
    assert.equal(revokeCalls, 1);
    assert.equal(mintCalls, 0);
    const panel = ui.container.querySelector("#permission-security")!;
    assert.match(panel.textContent!, /Earlier permissions.*revoked on-chain/);
    assert.match(panel.textContent!, /service stop was not confirmed/);
  });

  it("moving to mainnet requires real-funds consent separately from fee consent", async () => {
    activeGrant = { ...grant, chainId: 46630 };
    ui.dom.window.history.replaceState({}, "", "/grant?chain=4663");
    await ui.render(React.createElement(Wallet));
    const funding = ui.container.querySelector("[data-renewal-funding]")!;
    assert.ok(funding.textContent?.includes(address), "revocation funding names the exact smart account");
    assert.match(funding.textContent!, /Robinhood Chain testnet \(46630\).*testnet ETH/);
    assert.match(funding.textContent!, /Robinhood Chain \(4663\).*ETH/);
    assert.match(funding.textContent!, /Balances do not move between networks/);
    assert.match(funding.textContent!, /AA21.*fund the named network and retry/);
    assert.equal(funding.querySelector("a")?.getAttribute("href"), "https://faucet.testnet.chain.robinhood.com");
    await acknowledge("I authorize revoking");
    await ui.click("move to Robinhood Chain & re-sign");
    assert.equal(revokeCalls, 0);
    assert.equal(mintCalls, 0);
    revoke = async () => { throw new Error("stop here after consent"); };
    await acknowledge("I understand — real funds");
    await ui.click("move to Robinhood Chain & re-sign");
    assert.equal(revokeCalls, 1);
  });

  it("restoring requires fee consent and confirmed revocation before signing", async () => {
    renew = async () => ({ local: grant, handoff: { ok: true } });
    await ui.render(React.createElement(Wallet));
    await ui.click("switch to another wallet");
    const input = ui.container.querySelector("input.restore-input") as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(ui.dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, grant.demoOwnerPrivateKey);
      input.dispatchEvent(new ui.dom.window.Event("input", { bubbles: true }));
    });
    await ui.click("check this wallet");
    await acknowledge("I understand — real funds");
    const restoreLabel = "Restore & arm 0x1111…1111";
    await ui.click(restoreLabel);
    assert.equal(revokeCalls, 0);
    const receipt = deferred<unknown>();
    revoke = () => receipt.promise;
    await acknowledge("I understand restore first stops");
    await ui.click(restoreLabel);
    assert.equal(revokeCalls, 1);
    assert.equal(mintCalls, 0);
    assert.equal(input.matches(":disabled"), true, "restoration locks the selected key and network during revocation");
    await act(async () => { receipt.resolve({ transactionHash: `0x${"4".repeat(64)}` }); });
    assert.equal(mintCalls, 1);
  });

  it("restoring the same account across networks waits for source and destination revocations", async () => {
    activeGrant = { ...grant, chainId: 46630 };
    ui.dom.window.history.replaceState({}, "", "/grant?chain=4663");
    const source = deferred<unknown>();
    const destination = deferred<unknown>();
    revoke = wallet => wallet.chainId === 46630 ? source.promise : destination.promise;
    stop = async () => {
      assert.equal(needsPermissionReplacement(activeGrant), true, "old-chain marker precedes DELETE");
      assert.equal(loadRecoveryGrants()[0]?.chainId, 46630, "old-chain recovery snapshot precedes DELETE");
    };
    renew = async options => {
      assert.equal(options.chainId, 4663);
      assert.equal(options.expectAccount, address);
      return { local: { ...activeGrant, chainId: 4663, sessionKeyAddress: `0x${"8".repeat(40)}` }, handoff: { ok: true } };
    };
    await ui.render(React.createElement(Wallet));
    await ui.click("switch to another wallet");
    const input = await enterRestoreKey();
    await ui.click("check this wallet");
    const funding = ui.container.querySelector("[data-restore-funding]")!;
    assert.match(funding.textContent!, /both networks.*starting with the current network/);
    assert.ok(funding.textContent?.includes(address));
    assert.match(funding.textContent!, /Robinhood Chain testnet \(46630\).*testnet ETH/);
    assert.match(funding.textContent!, /Robinhood Chain \(4663\).*ETH/);
    assert.match(funding.textContent!, /AA21.*fund the named network and retry/);
    assert.ok(funding.querySelector("a")?.href.includes("faucet"));
    await acknowledge("I understand — real funds");
    await acknowledge("I understand restore first stops");
    await ui.click("Restore & arm 0x1111…1111");
    assert.deepEqual(revokeWallets.map(w => w.chainId), [46630]);
    assert.equal(mintCalls, 0);
    assert.equal(input.matches(":disabled"), true);
    await act(async () => { source.resolve({ transactionHash: `0x${"4".repeat(64)}` }); });
    assert.deepEqual(revokeWallets.map(w => w.chainId), [46630, 4663]);
    assert.equal(mintCalls, 0, "a source receipt alone cannot mint the replacement");
    assert.ok(revokeWallets.every(w => w.smartAccount === address && w.ownerKey === grant.demoOwnerPrivateKey));
    await act(async () => { destination.resolve({ transactionHash: `0x${"5".repeat(64)}` }); });
    assert.equal(mintCalls, 1);
    assert.deepEqual(restoredKeys, [grant.demoOwnerPrivateKey]);
  });

  for (const failedChain of [46630, 4663]) it(`cross-network restore retains recovery after an unconfirmed revocation on ${failedChain}`, async () => {
    activeGrant = { ...grant, chainId: 46630 };
    ui.dom.window.history.replaceState({}, "", "/grant?chain=4663");
    let exists = true;
    globalThis.fetch = async input => {
      const path = String(input);
      if (path === "/api/grants") return json({ exists, ...(exists ? { grant: activeGrant } : {}) });
      if (path === "/api/auth/session") return json({ hosted: false, address: null });
      if (path === "/api/settings") return json({ values: { customTokens: [], basketSymbols: [] } });
      throw new Error(`Unexpected request: ${path}`);
    };
    stop = async () => { exists = false; };
    revoke = async wallet => {
      if (wallet.chainId === failedChain) throw new Error(`Receipt unconfirmed on ${failedChain}; retry the pending operation`);
      return { transactionHash: `0x${"4".repeat(64)}` };
    };
    await ui.render(React.createElement(Wallet));
    await ui.click("switch to another wallet");
    await enterRestoreKey();
    await ui.click("check this wallet");
    await acknowledge("I understand — real funds");
    await acknowledge("I understand restore first stops");
    await ui.click("Restore & arm 0x1111…1111");
    assert.equal(mintCalls, 0);
    assert.deepEqual(revokeWallets.map(w => w.chainId), failedChain === 46630 ? [46630] : [46630, 4663]);
    assert.match(ui.container.textContent!, /Receipt unconfirmed/);
    assert.equal(needsPermissionReplacement(activeGrant), true);
    assert.equal(loadRecoveryGrants()[0]?.chainId, 46630);
    storedGrantAvailable = false;
    await ui.remount(React.createElement(Wallet));
    assert.ok(ui.container.querySelector("#resign"), "the public snapshot survives losing the server grant");
    assert.equal(needsPermissionReplacement(activeGrant), true, "refresh cannot re-arm the old permission");
    assert.equal([...ui.container.querySelectorAll("button")].some(b => b.textContent === "re-arm this wallet"), false);
    assert.equal(mintCalls, 0);
  });

  it("changing the restore network clears preview and fee consent", async () => {
    await ui.render(React.createElement(Wallet));
    await ui.click("switch to another wallet");
    await enterRestoreKey();
    await ui.click("check this wallet");
    await acknowledge("I understand restore first stops");
    const testnet = [...ui.container.querySelectorAll("button.chain-card")].find(b => b.textContent?.includes("Testnet (46630)")) as HTMLButtonElement;
    await act(async () => { testnet.click(); });
    assert.equal(ui.container.querySelector(".restore-preview"), null);
    const ack = [...ui.container.querySelectorAll("label")].find(l => l.textContent?.includes("I understand restore first stops"))!.querySelector("input")!;
    assert.equal(ack.checked, false);
    await ui.click("check your owner key above first");
    assert.equal(stopCalls, 0);
    assert.equal(revokeCalls, 0);
    assert.equal(mintCalls, 0);
    await ui.click("check this wallet");
    assert.match(ui.container.querySelector("[data-restore-funding]")!.textContent!, /both networks/);
  });

  it("a stale owner-key preview cannot restore signing controls after the key changes", async () => {
    const preview = deferred<{ smartAccount: string; owner: string }>();
    previewOwner = () => preview.promise;
    await ui.render(React.createElement(Wallet));
    await ui.click("switch to another wallet");
    await enterRestoreKey();
    await ui.click("check this wallet");
    await enterRestoreKey(`0x${"9".repeat(64)}`);
    await act(async () => { preview.resolve({ smartAccount: address, owner: address }); });
    assert.equal(ui.container.querySelector(".restore-preview"), null);
    assert.equal(ui.container.querySelector("[data-restore-funding]"), null);
    assert.equal(stopCalls, 0);
    assert.equal(revokeCalls, 0);
    assert.equal(mintCalls, 0);
  });

  for (const change of ["chain", "session"] as const) it(`refuses restore when another tab changed the active ${change} for the same account`, async () => {
    let serverGrant = grant;
    globalThis.fetch = async input => {
      const path = String(input);
      if (path === "/api/grants") return json({ exists: true, grant: serverGrant });
      if (path === "/api/auth/session") return json({ hosted: false, address: null });
      if (path === "/api/settings") return json({ values: { customTokens: [], basketSymbols: [] } });
      throw new Error(`Unexpected request: ${path}`);
    };
    await ui.render(React.createElement(Wallet));
    await ui.click("switch to another wallet");
    await enterRestoreKey();
    await ui.click("check this wallet");
    await acknowledge("I understand — real funds");
    await acknowledge("I understand restore first stops");
    serverGrant = change === "chain" ? { ...grant, chainId: 46630 } : { ...grant, sessionKeyAddress: `0x${"8".repeat(40)}` };
    await ui.click("Restore & arm 0x1111…1111");
    assert.equal(stopCalls, 0);
    assert.equal(revokeCalls, 0);
    assert.equal(mintCalls, 0);
    assert.equal(loadRecoveryGrants().length, 0);
    assert.equal(needsPermissionReplacement(grant), false);
    assert.match(ui.container.textContent!, /Couldn.t check your agent/);
    await ui.click("Try again");
    // A different browser's fresh server grant must win over this browser's
    // stale full grant, without deleting its owner recovery access.
    await ui.click("check this wallet");
    await acknowledge("I understand restore first stops");
    revoke = async () => { throw new Error("new permission revocation pending"); };
    await ui.click("Restore & arm 0x1111…1111");
    assert.equal(stopCalls, 1, "retry does not loop on the stale local grant");
    assert.equal(revokeCalls, 1);
    assert.equal(revokeWallets[0]?.chainId, serverGrant.chainId);
    assert.equal(needsPermissionReplacement(serverGrant), true);
    assert.equal(activeGrant.demoOwnerPrivateKey, grant.demoOwnerPrivateKey);
    assert.equal(mintCalls, 0);
  });

  for (const matchingOwner of [true, false]) it(`adopting a fresh legacy grant ${matchingOwner ? "retains only a proven owner key" : "refuses an unrelated saved owner key"}`, async () => {
    const owner = privateKeyToAccount(grant.demoOwnerPrivateKey as `0x${string}`);
    activeGrant = { ...grant, owner: owner.address, chainId: 46630, serialized: "old serialized permission", demoSessionPrivateKey: `0x${"6".repeat(64)}` };
    const serverGrant = { ...grant, owner: matchingOwner ? owner.address : address, demoOwnerPrivateKey: undefined, sessionKeyAddress: `0x${"8".repeat(40)}` };
    globalThis.fetch = async input => {
      const path = String(input);
      if (path === "/api/grants") return json({ exists: true, grant: serverGrant });
      if (path === "/api/auth/session") return json({ hosted: false, address: null });
      if (path === "/api/settings") return json({ values: { customTokens: [], basketSymbols: [] } });
      throw new Error(`Unexpected request: ${path}`);
    };
    await ui.render(React.createElement(Wallet));
    if (matchingOwner) {
      renew = async options => {
        assert.equal(options.chainId, serverGrant.chainId);
        assert.equal(options.expectAccount, address);
        return { local: { ...serverGrant, sessionKeyAddress: `0x${"9".repeat(40)}` }, handoff: { ok: true } };
      };
      await acknowledge("I authorize revoking");
      await ui.click("revoke earlier permissions & re-sign");
      assert.equal(mintCalls, 1);
      assert.deepEqual(restoredKeys, [grant.demoOwnerPrivateKey]);
      assert.deepEqual(revokeWallets.map(w => w.chainId), [serverGrant.chainId]);
      assert.equal(needsPermissionReplacement(serverGrant), true);
      assert.equal(needsPermissionReplacement(activeGrant), false, "the current server permission is replaced, not stale local metadata");
      const recovery = loadRecoveryGrants()[0]!;
      assert.equal(recovery.serialized, undefined);
      assert.equal(recovery.demoSessionPrivateKey, undefined);
      assert.equal(recovery.demoOwnerPrivateKey, undefined);
    } else {
      assert.match(ui.container.textContent!, /Use switch to another wallet below and paste the key in/);
      assert.equal(revokeCalls, 0);
      assert.equal(mintCalls, 0);
    }
    assert.equal(activeGrant.serialized, "old serialized permission", "full local recovery grant is untouched");
    assert.equal(activeGrant.demoOwnerPrivateKey, grant.demoOwnerPrivateKey);
  });

  it("resumes a stopped hosted Privy grant after reload, including an adopted second-browser grant", async () => {
    const owner = privateKeyToAccount(`0x${"7".repeat(64)}`);
    const did = "did:privy:recovery-test";
    const nonce = "historical-binding-nonce";
    const ownerSignature = await owner.signMessage({ message: bindingMessage({ version: "privy-did-owner-v1", origin: window.location.origin, nonce, owner: owner.address, smartAccount: address, chainId: 4663, did }) });
    activeGrant = { ...grant, owner: owner.address, demoOwnerPrivateKey: undefined, binding: { version: "privy-did-owner-v1", did, nonce, ownerSignature } };
    storedGrantAvailable = false; // Only the authenticated server supplied this grant.
    privyOwner = { account: owner, did };
    let exists = true;
    globalThis.fetch = async input => {
      const path = String(input);
      if (path === "/api/grants") return json({ exists, tenant: owner.address, ...(exists ? { grant: activeGrant } : {}) });
      if (path === "/api/auth/session") return json({ hosted: true, address: owner.address });
      if (path === "/api/settings") return json({ values: { customTokens: [], basketSymbols: [] } });
      throw new Error(`Unexpected request: ${path}`);
    };
    stop = async () => {
      assert.equal(needsPermissionReplacement(activeGrant), true, "replacement intent survives even a crash immediately after DELETE");
      exists = false;
    };
    revoke = async () => { throw new Error("Pending revocation; check again"); };
    await ui.render(React.createElement(Wallet));
    // Stop alone must remain usable and leave a renewal route after refresh.
    stop = async () => { exists = false; };
    await ui.click("Stop agent now");
    await ui.remount(React.createElement(Wallet));
    assert.ok(ui.container.querySelector("#resign"));
    assert.equal(revokeCalls, 0);
    assert.equal(mintCalls, 0);
    await ui.click("review and renew permission");
    stop = async () => {
      assert.equal(needsPermissionReplacement(activeGrant), true, "replacement intent is durable before DELETE");
      exists = false;
    };
    await acknowledge("I authorize revoking");
    await ui.click("revoke earlier permissions & re-sign");
    assert.equal(exists, false);
    assert.equal(mintCalls, 0);
    await ui.remount(React.createElement(Wallet));
    assert.ok(ui.container.querySelector("#resign"), "the authenticated owner's renewal survives the missing server grant");
    assert.match(ui.container.textContent!, /this wallet isn't active/);
    revoke = async () => ({ transactionHash: `0x${"4".repeat(64)}` });
    renew = async () => ({ local: { ...activeGrant, sessionKeyAddress: `0x${"8".repeat(40)}` }, handoff: { ok: true } });
    await acknowledge("I authorize revoking");
    await ui.click("revoke earlier permissions & re-sign");
    assert.equal(revokeCalls, 2, "the same owner can resume the pending revocation boundary");
    assert.equal(mintCalls, 1);
    assert.match(ui.container.textContent!, /Permission renewed/);
  });

  it("does not adopt a stopped saved grant from another hosted tenant or forged metadata", async () => {
    const a = privateKeyToAccount(`0x${"7".repeat(64)}`);
    const b = privateKeyToAccount(`0x${"8".repeat(64)}`);
    const did = "did:privy:original-owner";
    const nonce = "historical";
    activeGrant = { ...grant, owner: a.address, demoOwnerPrivateKey: undefined, binding: { version: "privy-did-owner-v1", did, nonce, ownerSignature: await a.signMessage({ message: bindingMessage({ version: "privy-did-owner-v1", origin: window.location.origin, nonce, owner: a.address, smartAccount: address, chainId: 4663, did }) }) } };
    privyOwner = { account: b, did: "did:privy:different-owner" };
    globalThis.fetch = async input => {
      const path = String(input);
      if (path === "/api/grants") return json({ exists: false, tenant: b.address });
      if (path === "/api/auth/session") return json({ hosted: true, address: b.address });
      if (path === "/api/settings") return json({ values: { customTokens: [], basketSymbols: [] } });
      throw new Error(`Unexpected request: ${path}`);
    };
    await ui.render(React.createElement(Wallet));
    assert.equal(ui.container.querySelector("#resign"), null);
    activeGrant = { ...activeGrant, owner: b.address }; // Metadata alone is not authority.
    await ui.remount(React.createElement(Wallet));
    assert.equal(ui.container.querySelector("#resign"), null);
    assert.equal(revokeCalls, 0);
    assert.equal(mintCalls, 0);
  });


});
