import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { fileURLToPath } from "node:url";
import React, { act } from "react";
import { WALL_TOO_WIDE, type StoredGrant } from "@merrymen/core";
import type { SavedWallet } from "@/lib/session";
import { JSDOM } from "jsdom";
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
  caps: { perTradeUsdg: 50, dailyUsdg: 500, expiryDays: 14, maxDrawdownPct: 10, maxOpsPerDay: 48 },
  grantedAt: Math.floor(Date.now() / 1000),
  expiresAt: Math.floor(Date.now() / 1000) + 14 * 86_400,
  grantTokens: [],
  grantFeatures: [],
} as unknown as StoredGrant;
const tooWide = `${WALL_TOO_WIDE}: installing it would need about 15,980,519 gas against a limit of 14,000,000. You have 20 custom tokens; the most that fits with the features you have enabled is 17. Remove at least 3 custom tokens, then sign again.`;
let renew: (options: { onStatus: (status: string) => void }) => Promise<unknown>;
let revoke: () => Promise<unknown>;
let stop: () => Promise<void>;
let revokeCalls = 0;
let mintCalls = 0;
let activeGrant = grant;
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
      if (id === "@/terminal/usePrivyOwner") return { usePrivyOwner: () => null };
      if (id === "@/lib/verified-adapter") return { verifiedAdapter: async () => undefined };
      if (id === "@/lib/revoke-client") return { revokeFromBrowser: async () => { revokeCalls++; return revoke(); } };
      if (id === "@/lib/stop-agent") return { stopAgent: () => stop() };
      if (id === "@/lib/session") return {
        FAUCET_URL: "https://faucet.testnet.chain.robinhood.com",
        loadGrant: () => activeGrant,
        listSavedWallets: () => savedWallets,
        isPrivyOwned: () => false,
        previewOwnerAccount: async () => ({ smartAccount: address, owner: address }),
        readFunding: async () => ({ gasWei: 1n, usdgUnits: 71_580_000n, usdg: 71.58 }),
        restoreAgentWallet: (_key: unknown, options: Parameters<typeof renew>[0]) => { mintCalls++; return renew(options); },
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
  revokeCalls = 0;
  mintCalls = 0;
  revoke = async () => ({ transactionHash: `0x${"4".repeat(64)}` });
  stop = async () => {};
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

describe("the funded wallet's re-sign control", () => {
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

  it("shows a refused renewal beside the pressed button, with the exact smaller-permission remedy", async () => {
    renew = async () => { throw new Error(tooWide); };
    await ui.render(React.createElement(Wallet));
    await acknowledge("I authorize revoking");
    await ui.click("revoke earlier permissions & re-sign");
    const panel = ui.container.querySelector("#resign")!;
    assert.ok(panel, "the current wallet stays open after a pre-signing refusal");
    const alert = panel.querySelector('[role="alert"]');
    assert.ok(alert, "the renewal refusal must be visible in the active renewal panel");
    assert.ok(alert.textContent?.includes(tooWide));
    assert.equal(alert.querySelector("a")?.getAttribute("href"), "/settings");
    assert.match(alert.textContent!, /Review custom tokens/);
    assert.match(ui.container.textContent!, /71\.58/);
    assert.match(ui.container.textContent!, /this wallet isn't active/);
    assert.match(ui.container.textContent!, /Earlier permissions were revoked/);
  });

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
    await ui.click("re-arm this wallet");
    assert.match(ui.container.textContent!, /cannot be re-armed/);
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

});
