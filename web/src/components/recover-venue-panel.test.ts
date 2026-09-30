/**
 * THE PANEL NEVER SAYS "EMPTY" OVER LIGHTER (docs/perps.md, "Recover").
 *
 * The browser withdraw screen used to decide "This account is empty — nothing
 * to recover" from the account's own balances. Perp collateral, positions and
 * a pending claim sit in Lighter's custody, which no transfer from the account
 * reaches — so an owner with money on the venue and none in the account would
 * have been told there was nothing left.
 *
 * Mounted the way recover-privy-flow.test.ts mounts it (jsdom, the real
 * component, `planFn` injected because the engine wants a chain), driven to
 * the disclosure, and read as text. The venue group is the engine's own
 * words (`venueDisclosure`), so this checks the wiring, not the wording.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { JSDOM } from "jsdom";
import { venueDisclosure } from "../../../worker/src/recover";

const OWNER = "0x8e93bad5a60a266b4283855ceffa0979720aed72";
const ACCOUNT = "0x05a198A677Fbcd8f5c168d397Fa7ef5eB6D65487";
const STORAGE_KEY = "merrymen.grant.v1";

let dom: JSDOM;
before(() => {
  dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", {
    url: "https://app.merrymen.dev/withdraw",
    pretendToBeVisual: true,
  });
  const g = globalThis as Record<string, unknown>;
  for (const k of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "localStorage", "getComputedStyle"]) {
    g[k] = (dom.window as unknown as Record<string, unknown>)[k];
  }
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.fetch = async (input: unknown) => {
    const url = String(input);
    if (url.includes("/api/recover")) {
      return { ok: true, status: 200, json: async () => ({ hasStoredKey: false, hasBundler: false, clientSide: true, chainId: 4663 }) } as unknown as Response;
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  };
  dom.window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ smartAccount: ACCOUNT, chainId: 4663, grantTokens: [] }));
});
after(() => dom?.window.close());

/** A venue with 12.5 USDG of free cross collateral, one open isolated position and the agent's key. */
const HOLDS = venueDisclosure({
  kind: "account",
  accountIndex: 22149,
  account: {
    read: true,
    value: {
      collateralMicro: 12_500_000n,
      isolatedMarginMicro: 5_000_000n,
      unrealizedMicro: 0n,
      positions: [
        { market: "BTC-PERP", marketId: 1, side: "long", size: "0.00020", marginMode: "isolated", marginMicro: 5_000_000n, unrealizedMicro: 0n, liqPrice: "52000.0", stopsResting: 1 },
      ],
      crossPositions: 0,
      orders: 1,
      poolShareCount: 0,
      spotBalanceCount: 0,
    },
  },
  otherAccounts: { read: true, value: { accounts: [], complete: true } },
  pendingMicro: { read: true, value: 0n },
  withdrawalDelaySec: { read: true, value: 900 },
  keySlot: { read: true, value: { state: "key", publicKey: `0x${"0100000000000000".repeat(5)}`, agents: true } },
  unwind: { kind: "unwind", accountIndex: 22149, calls: ["cancelAllOrders", "changePubKey", "withdraw"], withdrawMicro: 12_500_000n, positionsLeftOpen: 1 },
  claim: null,
  notOffered: [],
});

const UNREAD = venueDisclosure({ kind: "unreadable", why: "the Lighter contract could not be read (account index)" });

async function mount(venueText: ReturnType<typeof venueDisclosure>) {
  const React = (await import("react")).default;
  const { act } = await import("react");
  (globalThis as Record<string, unknown>).React = React;
  const { createRoot } = await import("react-dom/client");
  const { RecoverPanelView } = await import("./RecoverPanel");
  const planFn = async (w: { smartAccount: string }) => ({
    smartAccount: w.smartAccount,
    ownerAddress: OWNER,
    chainId: 4663,
    balances: [],
    classVault: null,
    classHoldings: [],
    classVaults: [],
    classNote: null,
    gasWei: 1_000_000_000_000_000n,
    nativeRecoverableWei: 0n,
    nativeReserveWei: 1_000_000_000_000_000n,
    unreadable: [],
    needsGas: false,
    venueText,
  });
  const container = dom.window.document.getElementById("root")!;
  container.innerHTML = "";
  const root = createRoot(container as unknown as Element);
  const privyOwner = { account: { address: OWNER, type: "local" }, did: "did:privy:test" };
  await act(async () => {
    root.render(React.createElement(RecoverPanelView, { privyOwner, planFn } as never));
  });
  const click = async (re: RegExp) => {
    const b = [...container.querySelectorAll("button")].find((x) => re.test(x.textContent ?? ""));
    assert.ok(b, `a button matching ${re}`);
    await act(async () => {
      b!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
  };
  await click(/recover my funds/i);
  await click(/check what's in it/i);
  const text = container.textContent ?? "";
  await act(async () => root.unmount());
  return text;
}

describe("the withdraw panel and Lighter", () => {
  it("money at Lighter and none in the account: NOT 'empty' — the venue group is shown, and the path to unwind it named", async () => {
    const text = await mount(HOLDS);
    assert.doesNotMatch(text, /This account is empty/);
    assert.match(text, /Nothing to sweep in the account itself/);
    assert.match(text, /12\.5 USDG cross collateral/);
    assert.match(text, /BTC-PERP long 0\.00020/);
    assert.match(text, /the agent's key/);
    // Privy-owned here: no key to take to the CLI, and it is said.
    assert.match(text, /no key to take to the command line/);
    assert.match(text, /INCLUDING the stops on 1 open position/, "what the unwind would do is disclosed even where it cannot run");
  });

  it("Lighter unread: still NOT 'empty'", async () => {
    const text = await mount(UNREAD);
    assert.doesNotMatch(text, /This account is empty/);
    assert.match(text, /could not be read/);
    assert.match(text, /NOT an empty account/);
  });
});
