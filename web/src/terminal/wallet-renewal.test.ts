import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { WALL_TOO_WIDE, type GrantCaps, type StoredGrant } from "@merrymen/core";
import type { SavedWallet } from "@/lib/session";

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
let loadedGrant: StoredGrant = grant;
const tooWide = `${WALL_TOO_WIDE}: installing it would need about 15,980,519 gas against a limit of 14,000,000. You have 20 custom tokens; the most that fits with the features you have enabled is 17. Remove at least 3 custom tokens, then sign again.`;
let renew: (options: { caps: GrantCaps; onStatus: (status: string) => void }) => Promise<unknown>;
let Wallet: typeof import("./screens/Wallet").default;
let ui: ReturnType<typeof testDom>;
let savedWallets: SavedWallet[] = [];
const originalFetch = globalThis.fetch;

before(async () => {
  // Real input events require React DOM to see a browser at initial import.
  const boot = new JSDOM("<!doctype html><p></p>", { url: "https://app.example.test", pretendToBeVisual: true });
  const g = globalThis as Record<string, unknown>;
  g.window = boot.window;
  g.document = boot.window.document;
  ({ deferred, json, testDom } = await import("./test-dom"));
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
        loadGrant: () => loadedGrant,
        listSavedWallets: () => savedWallets,
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
    Reflect.deleteProperty(g, "window");
    Reflect.deleteProperty(g, "document");
    boot.window.close();
  }
});

beforeEach(() => {
  ui = testDom();
  loadedGrant = grant;
  savedWallets = [];
  renew = async () => { throw new Error("Unexpected signing request"); };
  localStorage.setItem("merrymen.grant.backedup.v1", "1");
  globalThis.fetch = async (input) => {
    const path = String(input);
    if (path === "/api/grants") return json({ exists: true, grant: loadedGrant, gasSponsored: true });
    if (path === "/api/auth/session") return json({ hosted: false, address: null });
    if (path === "/api/settings") return json({ values: { customTokens: [], basketSymbols: [] } });
    throw new Error(`Unexpected request: ${path}`);
  };
});

afterEach(async () => {
  await ui.close();
  globalThis.fetch = originalFetch;
});

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

describe("the funded wallet's re-sign control", () => {
  for (const [key, label] of [
    ["maxDrawdownPct", "drawdown limit"],
    ["perTradeUsdg", "most it can spend on one trade"],
    ["dailyUsdg", "most it can spend in a day"],
    ["expiryDays", "auto-expire the agent after"],
    ["maxOpsPerDay", "most trades per day"],
  ] as const) {
    it(`blocks an untouched zero ${key} from a legacy grant until its owner corrects it`, async () => {
      loadedGrant = { ...grant, caps: { ...grant.caps, [key]: 0 } };
      let signedCaps: GrantCaps | undefined;
      renew = async ({ caps }) => {
        signedCaps = structuredClone(caps);
        return { local: { ...loadedGrant, caps }, handoff: { ok: true } };
      };
      await ui.render(React.createElement(Wallet));
      assert.equal(renewalInput(label).value, "0", "the loaded limit is displayed without automatic repair");
      assert.equal(ui.container.querySelector<HTMLButtonElement>("#resign button")!.disabled, true);
      assert.ok(ui.container.querySelector('#resign [role="alert"]'));
      await ui.click("re-sign this key (free)");
      assert.equal(signedCaps, undefined, "an untouched invalid cap must never reach the signer");
      await type(renewalInput(label), String(grant.caps[key]));
      assert.equal(signedCaps, undefined, "the owner's correction still requires an explicit signature");
      assert.equal(ui.container.querySelector<HTMLButtonElement>("#resign button")!.disabled, false);
      await ui.click("re-sign this key (free)");
      assert.deepEqual(signedCaps, grant.caps, "only the owner-corrected cap changes");
    });
  }

  it("requires an explicit value for a missing legacy cap instead of inserting a default", async () => {
    const legacyCaps: Partial<GrantCaps> = { ...grant.caps };
    delete legacyCaps.maxOpsPerDay;
    loadedGrant = { ...grant, caps: legacyCaps as GrantCaps };
    let signedCaps: GrantCaps | undefined;
    renew = async ({ caps }) => {
      signedCaps = structuredClone(caps);
      return { local: { ...loadedGrant, caps }, handoff: { ok: true } };
    };
    await ui.render(React.createElement(Wallet));
    assert.equal(ui.container.querySelector<HTMLButtonElement>("#resign button")!.disabled, true);
    await ui.click("re-sign this key (free)");
    assert.equal(signedCaps, undefined);
    await type(renewalInput("most trades per day"), "24");
    await ui.click("re-sign this key (free)");
    assert.deepEqual(signedCaps, { ...grant.caps, maxOpsPerDay: 24 });
  });

  it("shows and preserves the existing 5% drawdown limit when renewing without changes", async () => {
    let signedCaps: GrantCaps | undefined;
    renew = async ({ caps }) => {
      signedCaps = structuredClone(caps);
      return { local: { ...grant, caps }, handoff: { ok: true } };
    };
    await ui.render(React.createElement(Wallet));
    assert.equal(renewalInput("drawdown limit").value, "5");
    assert.match(ui.container.querySelector("#resign")!.textContent!, /at or above/);
    assert.match(ui.container.querySelector("#resign")!.textContent!, /Raising it allows a larger loss/);
    assert.equal(signedCaps, undefined, "loading the form never signs");
    await ui.click("re-sign this key (free)");
    assert.deepEqual(signedCaps, grant.caps);
    assert.equal(renewalInput("drawdown limit").value, "5");
  });

  it("shows an explicit owner's drawdown edit before signing exactly that choice", async () => {
    let signedCaps: GrantCaps | undefined;
    renew = async ({ caps }) => {
      signedCaps = structuredClone(caps);
      return { local: { ...grant, caps }, handoff: { ok: true } };
    };
    await ui.render(React.createElement(Wallet));
    await type(renewalInput("drawdown limit"), "8");
    assert.equal(signedCaps, undefined, "editing does not sign or submit");
    assert.match(ui.container.querySelector("#resign")!.textContent!, /breaker 5 % → 8 %/);
    await ui.click("re-sign this key (free)");
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
    for (const invalid of ["", "oops", "5.5", "0", "51"]) {
      await type(renewalInput("drawdown limit"), invalid);
      assert.equal(renewalInput("drawdown limit").value, invalid, "raw text stays visible");
      assert.equal(renewalInput("drawdown limit").getAttribute("aria-invalid"), "true");
      const button = ui.container.querySelector<HTMLButtonElement>("#resign button")!;
      assert.equal(button.disabled, true, `cannot sign invalid ${JSON.stringify(invalid)}`);
      assert.ok(ui.container.querySelector('#resign [role="alert"]'));
      await ui.click("re-sign this key (free)");
      assert.equal(signs, 0, "never substitutes the previous valid number into a signature");
    }
    await type(renewalInput("drawdown limit"), "4");
    await ui.click("re-sign this key (free)");
    assert.equal(signs, 1, "a valid lower owner-chosen limit can be signed");
  });

  it("keeps an invalid limit blocked when another field receives a valid edit", async () => {
    let signs = 0;
    renew = async () => { signs++; return { local: grant, handoff: { ok: true } }; };
    await ui.render(React.createElement(Wallet));
    await type(renewalInput("drawdown limit"), "51");
    await type(renewalInput("most it can spend on one trade"), "25");
    assert.equal(ui.container.querySelector<HTMLButtonElement>("#resign button")!.disabled, true);
    assert.ok(ui.container.querySelector('#resign [role="alert"]'));
    await ui.click("re-sign this key (free)");
    assert.equal(signs, 0);
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
