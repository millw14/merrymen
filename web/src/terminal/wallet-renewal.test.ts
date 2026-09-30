import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { fileURLToPath } from "node:url";
import React, { act } from "react";
import { WALL_TOO_WIDE, type StoredGrant } from "@merrymen/core";
import { deferred, json, testDom } from "./test-dom";

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
let Wallet: typeof import("./screens/Wallet").default;
let ui: ReturnType<typeof testDom>;
const originalFetch = globalThis.fetch;

before(() => {
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
      if (id === "@/lib/session") return {
        loadGrant: () => grant,
        listSavedWallets: () => [],
        isPrivyOwned: () => false,
        readFunding: async () => ({ gasWei: 1n, usdgUnits: 71_580_000n, usdg: 71.58 }),
        restoreAgentWallet: (_key: unknown, options: Parameters<typeof renew>[0]) => renew(options),
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
  localStorage.setItem("merrymen.grant.backedup.v1", "1");
  globalThis.fetch = async (input) => {
    const path = String(input);
    if (path === "/api/grants") return json({ exists: true, grant, gasSponsored: true });
    if (path === "/api/auth/session") return json({ hosted: false, address: null });
    if (path === "/api/settings") return json({ values: { customTokens: [], basketSymbols: [] } });
    throw new Error(`Unexpected request: ${path}`);
  };
});

afterEach(async () => {
  await ui.close();
  globalThis.fetch = originalFetch;
});

describe("the funded wallet's re-sign control", () => {
  it("shows a refused renewal beside the pressed button, with the exact smaller-permission remedy", async () => {
    renew = async () => { throw new Error(tooWide); };
    await ui.render(React.createElement(Wallet));
    await ui.click("re-sign this key (free)");
    const panel = ui.container.querySelector("#resign")!;
    assert.ok(panel, "the current wallet stays open after a pre-signing refusal");
    const alert = panel.querySelector('[role="alert"]');
    assert.ok(alert, "the renewal refusal must be visible in the active renewal panel");
    assert.ok(alert.textContent?.includes(tooWide));
    assert.equal(alert.querySelector("a")?.getAttribute("href"), "/settings");
    assert.match(alert.textContent!, /Review custom tokens/);
    assert.match(ui.container.textContent!, /71\.58/);
    assert.doesNotMatch(ui.container.textContent!, /this wallet isn't active/);
  });

  it("shows signing progress, then confirms only a server-accepted renewal", async () => {
    const done = deferred<unknown>();
    renew = async ({ onStatus }) => { onStatus("checking your permission…"); return done.promise; };
    await ui.render(React.createElement(Wallet));
    await ui.click("re-sign this key (free)");
    const panel = ui.container.querySelector("#resign")!;
    assert.match(panel.querySelector('[role="status"]')?.textContent ?? "", /checking your permission/);
    assert.equal(panel.querySelector("button")?.disabled, true);
    await act(async () => { done.resolve({ local: { ...grant, grantedAt: grant.grantedAt + 1 }, handoff: { ok: true } }); });
    assert.match(panel.querySelector('[role="status"]')?.textContent ?? "", /Permission renewed/);
    assert.doesNotMatch(panel.textContent!, /checking your permission/);
    assert.equal(panel.querySelector("button")?.disabled, false);
  });

  it("shows a server refusal and never reports that permission renewal succeeded", async () => {
    renew = async () => ({ local: grant, handoff: { ok: false, error: "Sign in again to renew your permission." } });
    await ui.render(React.createElement(Wallet));
    await ui.click("re-sign this key (free)");
    assert.match(ui.container.textContent!, /Sign in again to renew your permission/);
    assert.doesNotMatch(ui.container.textContent!, /Permission renewed/);
  });

  it("does not carry the previous renewal confirmation through switching wallets", async () => {
    renew = async () => ({ local: grant, handoff: { ok: true } });
    await ui.render(React.createElement(Wallet));
    await ui.click("re-sign this key (free)");
    assert.match(ui.container.textContent!, /Permission renewed/);
    await ui.click("switch to another wallet");
    assert.doesNotMatch(ui.container.textContent!, /Permission renewed/);
    await ui.click("← never mind, keep 0x1111…1111");
    assert.ok(ui.container.querySelector("#resign"), "the same screen returns to the current grant");
    assert.doesNotMatch(ui.container.textContent!, /Permission renewed/);
  });
});
