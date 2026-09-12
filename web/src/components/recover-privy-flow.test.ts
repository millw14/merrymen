/**
 * THE ONE FLOW THAT SOURCE-READING COULD NOT CHECK.
 *
 * Every other test over this panel asserts on its SOURCE. That catches "is the
 * code shaped right" and is structurally blind to "does the flow work" — and
 * this component broke twice, in production, in ways a green source-read suite
 * and a clean typecheck both waved through:
 *
 *   1. Hiding the key input for a Privy owner also hid the chain picker and the
 *      "check what's in it" button, because both were nested inside that
 *      branch. The panel said recovery was authorised by the signed-in wallet
 *      and then offered nothing to press.
 *   2. `browserWallet()` read the account from `ctx.smartAccount`, which hosted
 *      is NEVER populated — `/api/recover` returns `clientSide: true` and no
 *      account, because the server holds no grant file by construction. So it
 *      returned null and the panel told a signed-in owner
 *      "this browser doesn't hold that wallet" about their own agent.
 *
 * Both were found by a human clicking the deployed site with 1,063,408 DOGGOS
 * one dialog away. This test is that click, in jsdom.
 *
 * DELIBERATELY ONE FLOW, not a UI testing project. It mounts the real component
 * with Shogun's real hosted shape and drives it to the disclosure. Two seams are
 * injected and nothing else: `privyOwner` (because `usePrivy` throws outside a
 * PrivyProvider, so the hook lives in a one-line wrapper) and `planFn` (because
 * the engine wants a chain). `loadGrant` is NOT injected — jsdom has a real
 * localStorage, so the test sets the grant the hosted mint would have written
 * and the production code path reads it back. That is the assertion, not a mock.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { JSDOM } from "jsdom";

const OWNER = "0x8e93bad5a60a266b4283855ceffa0979720aed72";
const ACCOUNT = "0x05a198A677Fbcd8f5c168d397Fa7ef5eB6D65487";
const VAULT = "0x3fcdde6e011769ca05f0115f1543290862473216";
const TOKEN = "0x15e498ff2dbca95e8648a1f025cbbd12c2525461";
/** The grant a hosted Privy mint writes to localStorage. Key from session.ts. */
const STORAGE_KEY = "merrymen.grant.v1";

let dom: JSDOM;
/** What `planFn` was called with — the proof of where the account came from. */
let planCalledWith: { smartAccount?: string; ownerAccount?: unknown } | null = null;

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
  // HOSTED, exactly: clientSide true, and NO smartAccount. The second bug lived
  // entirely in the gap this line creates.
  // A plain object, not a jsdom Response: jsdom does not implement Response, so
  // constructing one threw, `expand()`'s catch swallowed it, and ctx came back
  // WITHOUT clientSide — which silently routed the click to the server path.
  // The panel only needs `.json()`.
  g.fetch = async (input: unknown) => {
    const url = String(input);
    if (url.includes("/api/recover")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ hasStoredKey: false, hasBundler: false, clientSide: true, chainId: 4663 }),
      } as unknown as Response;
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  };
  // The grant the hosted mint wrote. `loadGrant()` — the real one — reads this.
  dom.window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      smartAccount: ACCOUNT,
      chainId: 4663,
      grantTokens: [TOKEN],
      binding: { version: "privy-did-owner-v1" },
    }),
  );
});

after(() => dom?.window?.close?.());

describe("a Privy-owned hosted agent can reach its recovery disclosure", () => {
  it("renders, offers a way in, and discloses the class vault", async () => {
    const React = (await import("react")).default;
    const { act } = await import("react");
    // REACT AS A GLOBAL, and only here. `web/tsconfig.json` sets
    // `"jsx": "preserve"` (Next's standard, and Next's own compiler handles it),
    // but tsx honours the nearest tsconfig and so falls back to the CLASSIC
    // transform — emitting bare `React.createElement` into modules that import
    // no React, because they were written for the automatic runtime. Changing
    // Next's jsx setting to satisfy a test would be the tail wagging the dog.
    (globalThis as Record<string, unknown>).React = React;
    const { createRoot } = await import("react-dom/client");
    const { RecoverPanelView } = await import("./RecoverPanel");

    /** A stand-in for Privy's LocalAccount. Only `.address` is read here. */
    const privyOwner = { account: { address: OWNER, type: "local" }, did: "did:privy:test" };

    const planFn = async (w: { smartAccount: string; ownerAccount?: unknown }) => {
      planCalledWith = w;
      return {
        smartAccount: w.smartAccount,
        ownerAddress: OWNER,
        explorer: "https://explorer.test",
        chainId: 4663,
        balances: [{ symbol: "USDG", address: TOKEN, raw: 20_000_000n, decimals: 6, amount: "20.000000" }],
        classVault: VAULT,
        classHoldings: [{ token: TOKEN, symbol: "DOGGOS", raw: 1n, amount: "1,063,408.141815" }],
        classNote: null,
        gasWei: 1_000_000_000_000_000n,
        unreadable: [],
        needsGas: false,
      };
    };

    const container = dom.window.document.getElementById("root")!;
    const root = createRoot(container as unknown as Element);

    await act(async () => {
      root.render(
        React.createElement(RecoverPanelView, { privyOwner, planFn } as never),
      );
    });

    // ── the panel opens ────────────────────────────────────────────────────
    const open = [...container.querySelectorAll("button")].find((b) =>
      /recover my funds/i.test(b.textContent ?? ""),
    );
    assert.ok(open, "the panel must offer a way to open it");
    await act(async () => {
      open!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });

    // ── BUG 1: the way in must exist for an owner with no key ─────────────
    const keyInput = [...container.querySelectorAll("input")].find((i) =>
      /owner key/i.test(i.getAttribute("placeholder") ?? ""),
    );
    assert.equal(keyInput, undefined, "a Privy owner must NOT be asked for a private key");
    assert.ok(
      /authorised by your signed-in wallet/i.test(container.textContent ?? ""),
      "and must be told their wallet authorises it",
    );
    const radios = [...container.querySelectorAll('input[type="radio"]')];
    assert.ok(radios.length >= 2, "the chain selector must be present");
    const check = [...container.querySelectorAll("button")].find((b) =>
      /check what's in it/i.test(b.textContent ?? ""),
    );
    assert.ok(check, "the check button must be present — this is the bug that shipped");

    // ── drive it ──────────────────────────────────────────────────────────
    await act(async () => {
      check!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });

    const text = container.textContent ?? "";
    assert.doesNotMatch(
      text,
      /this browser doesn't hold that wallet/i,
      "BUG 2: hosted ctx has no smartAccount, so the account must come from loadGrant()",
    );

    // ── BUG 2: the account came from localStorage, not from ctx ───────────
    assert.ok(planCalledWith, "the plan must actually have been requested");
    assert.equal(
      planCalledWith!.smartAccount,
      ACCOUNT,
      "the smart account must be the one loadGrant() returned",
    );
    assert.equal(
      (planCalledWith!.ownerAccount as { address: string }).address,
      OWNER,
      "and it must be signed for by the Privy owner, not a key",
    );

    // ── the disclosure ────────────────────────────────────────────────────
    assert.match(text, /1,063,408\.141815/, "the class holding must be disclosed");
    assert.match(text, /DOGGOS/, "by name");
    assert.match(text, /Class vault/i, "under a heading that says where it lives");
    assert.match(text, /20\.000000\s*USDG/, "the account's own balance too");
    assert.match(
      text,
      /Held in a separate contract, not in the account/i,
      "and why it was not already in the balance list",
    );
  });
});
