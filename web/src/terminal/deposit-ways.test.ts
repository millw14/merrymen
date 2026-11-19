import assert from "node:assert/strict";
import { afterEach, before, beforeEach, describe, it } from "node:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { CASH } from "@merrymen/core";
import type { DepositWaysProps } from "./DepositWays";
import { QR_QUIET_ZONE, qrModules, qrPath } from "./QrCode";
import { SOURCE_RPC } from "../lib/source-balance";

// React DOM decides whether `input` events exist when it first loads, so a DOM
// is in place before the harness (and react-dom with it) is imported. Typing
// then reaches the real onChange, as in SolanaScreen.test.ts.
let testDom: typeof import("./test-dom").testDom;
let DepositWays: typeof import("./DepositWays").DepositWays;
before(async () => {
  const boot = new JSDOM("<!doctype html><p></p>", { pretendToBeVisual: true });
  Object.assign(globalThis as Record<string, unknown>, { window: boot.window, document: boot.window.document });
  ({ testDom } = await import("./test-dom"));
  ({ DepositWays } = await import("./DepositWays"));
});

/**
 * THE ADD MONEY PANEL, RENDERED. No request leaves the test: Relay and the
 * public RPCs are answered by `stubFetch`, in the shapes they returned live on
 * 2026-11-19.
 */

const AGENT = "0x12aB000000000000000000000000000000c0DEF0";
const OWNER = "0x00000000000000000000000000000000000000aa";
const SOL_WALLET = "9mAdjznSUjrVFJKuacoFg8tkA6UfTqTboeuqN3eGr842";
const ETH = 10n ** 18n;

type Call = { url: string; body: Record<string, unknown> };
let ui: ReturnType<typeof import("./test-dom").testDom>;
let calls: Call[];
let opened: string[];

/** Relay's /price answer for exactly the request it was sent. */
function priceFor(body: Record<string, unknown>, over: { recipient?: string } = {}) {
  const sol = body.originChainId === 792703809;
  const currency = { chainId: body.originChainId, address: body.originCurrency, symbol: sol ? "SOL" : "ETH", decimals: sol ? 9 : 18 };
  const amount = BigInt(String(body.amount));
  // $1,796 per ETH and $74.56 per SOL, as on the day; USDG out is 99.8% of that.
  const usdMicros = sol ? (amount * 74_560_000n) / 10n ** 9n : (amount * 1_796_000_000n) / ETH;
  const out = (usdMicros * 998n) / 1000n;
  const bps = BigInt(String(body.slippageTolerance));
  return {
    fees: {
      gas: { currency, amount: sol ? "8975" : "211615385242", amountUsd: "0.000398" },
      relayer: { currency, amount: sol ? "851245" : "26897566254439", amountUsd: "0.048310" },
      app: { currency, amount: "0", amountUsd: "0" },
    },
    details: {
      recipient: over.recipient ?? body.recipient,
      currencyIn: { currency, amount: String(body.amount), amountUsd: `${usdMicros / 1_000_000n}.${String(usdMicros % 1_000_000n).padStart(6, "0")}` },
      currencyOut: {
        currency: { chainId: 4663, address: CASH.USDG.toLowerCase(), symbol: "USDG", decimals: 6 },
        amount: String(out),
        minimumAmount: String((out * (10_000n - bps)) / 10_000n),
      },
      totalImpact: { percent: "-0.25" },
      slippageTolerance: { total: String(body.slippageTolerance) },
      timeEstimate: 1,
    },
  };
}

type Balance = bigint | "fail";
function stubFetch(options: { balance?: Balance | (() => Balance); relay?: "ok" | "refuse" | "wrong-recipient" } = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url, body });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (url === "https://api.relay.link/price") {
      if (options.relay === "refuse") return json({ message: "Amount too low", errorCode: "AMOUNT_TOO_LOW" }, 400);
      return json(priceFor(body, options.relay === "wrong-recipient" ? { recipient: "0x2222222222222222222222222222222222222222" } : {}));
    }
    if (Object.values(SOURCE_RPC).includes(url)) {
      const balance = typeof options.balance === "function" ? options.balance() : options.balance;
      if (balance === "fail") return json({ error: { code: 403, message: "Access forbidden" } }, 403);
      const value = balance ?? ETH;
      return body.method === "getBalance"
        ? json({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: Number(value) } })
        : json({ jsonrpc: "2.0", id: 1, result: `0x${value.toString(16)}` });
    }
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch;
}

beforeEach(() => {
  ui = testDom();
  calls = [];
  opened = [];
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, writable: true, value: ui.dom.window.sessionStorage });
  // Record link navigation instead of leaving for relay.link. React's own
  // onClick still runs first, because it listens at the root.
  ui.dom.window.document.addEventListener("click", (event) => {
    const link = (event.target as Element).closest?.("a");
    if (link) { opened.push(link.getAttribute("href") ?? ""); event.preventDefault(); }
  });
});
afterEach(async () => {
  await ui.close();
  Reflect.deleteProperty(globalThis, "sessionStorage");
});

const props = (over: Partial<DepositWaysProps> = {}): DepositWaysProps => ({
  agent: AGENT,
  chainId: 4663,
  balances: { ethWei: "1000000000000000", cashUsdg: "5000000", vaultUsdg: "0" },
  gasSponsored: false,
  ownerAddress: OWNER,
  fetchImpl: stubFetch(),
  ...over,
});
const view = (over: Partial<DepositWaysProps> = {}) => React.createElement(DepositWays, props(over));
const text = () => ui.container.textContent ?? "";
const settle = (ms = 0) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

async function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(ui.dom.window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new ui.dom.window.Event("input", { bubbles: true }));
  });
}
const inputs = () => Array.from(ui.container.querySelectorAll("input")) as HTMLInputElement[];
const tab = async (label: string) => {
  const button = Array.from(ui.container.querySelectorAll('[role="tab"]')).find((b) => b.textContent === label) as HTMLButtonElement;
  await act(async () => { button.click(); });
};
const clickLink = async (label: string) => {
  const link = Array.from(ui.container.querySelectorAll("a")).find((a) => a.textContent === label)!;
  await act(async () => { link.click(); });
  return link;
};

describe("Send USDG, the way that shows first", () => {
  it("shows the address as text and QR code, names the network and token, and warns against any other chain", async () => {
    await ui.render(view());
    const tabs = Array.from(ui.container.querySelectorAll('[role="tab"]'));
    assert.deepEqual(tabs.map((t) => [t.textContent, t.getAttribute("aria-selected")]), [["Send USDG", "true"], ["From ETH", "false"], ["From SOL", "false"]]);
    assert.equal(ui.container.querySelector(".funding-address")!.textContent, AGENT);
    const qr = ui.container.querySelector('svg[role="img"]')!;
    assert.match(qr.getAttribute("aria-label")!, new RegExp(AGENT));
    assert.match(text(), /NetworkRobinhood Chain/);
    assert.match(text(), new RegExp(`TokenUSDG ${CASH.USDG}`));
    assert.match(text(), /Send USDG on Robinhood Chain, and only there\./);
    assert.match(text(), /funds sent there are stuck, and no re-sign moves them back/);
    assert.equal(calls.length, 0, "showing an address reads nothing");
  });

  it("copies the exact address, and says so when it can't", async () => {
    const writes: string[] = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (v: string) => { writes.push(v); } } });
    await ui.render(view());
    await ui.click("Copy deposit address");
    await settle();
    assert.deepEqual(writes, [AGENT]);
    assert.ok(Array.from(ui.container.querySelectorAll("button")).some((b) => b.textContent === "Address copied"));

    await ui.remount(view());
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("denied"); } } });
    await ui.click("Copy deposit address");
    await settle();
    assert.equal(ui.container.querySelector('[role="alert"]')!.textContent, "Could not copy. Select the address above to copy it.");
  });

  it("offers no conversions off Robinhood Chain mainnet, where they would not reach this agent", async () => {
    await ui.render(view({ chainId: 46630 }));
    assert.equal(ui.container.querySelector('[role="tablist"]'), null);
    assert.match(text(), /Send USDG on chain 46630, and only there\./);
    assert.match(text(), /Copy deposit address/);
  });

  it("draws the QR code module for module from the encoder, quiet zone included", () => {
    const modules = qrModules(AGENT);
    assert.equal(modules.length, 29, "an address fits a version-3 code at level M");
    // The three finder patterns: dark 7x7 rings at three corners.
    for (const [r, c] of [[0, 0], [0, 22], [22, 0]]) {
      for (let i = 0; i < 7; i++) {
        assert.equal(modules[r]![c + i], true);
        assert.equal(modules[r + 6]![c + i], true);
        assert.equal(modules[r + i]![c], true);
      }
    }
    const darks = modules.flat().filter(Boolean).length;
    const path = qrPath(modules);
    assert.equal(path.split("M").length - 1, darks);
    assert.ok(path.startsWith(`M${QR_QUIET_ZONE} ${QR_QUIET_ZONE}h1v1h-1z`));
  });
});

describe("From ETH", () => {
  it("reads the sending wallet, keeps the reserve on Max, and prices exactly that amount with Relay", async () => {
    await ui.render(view());
    await tab("From ETH");
    const sources = Array.from(ui.container.querySelectorAll(".deposit-sources button"));
    assert.deepEqual(sources.map((b) => [b.textContent, b.getAttribute("aria-pressed")]),
      [["Ethereum", "true"], ["Base", "false"], ["Arbitrum", "false"], ["Robinhood Chain", "false"]]);
    assert.equal(inputs()[0]!.value, OWNER, "the owner's wallet is offered, and can be changed");
    await settle();
    assert.equal(calls[0]!.url, "https://ethereum-rpc.publicnode.com");
    assert.deepEqual(calls[0]!.body.params, [OWNER, "latest"]);
    assert.match(text(), /This wallet holds 1 ETH on Ethereum\. Max keeps 0\.002 ETH on Ethereum so this wallet can pay its next fee\./);

    await ui.click("Max");
    await settle();
    assert.equal(inputs()[1]!.value, "0.998");
    assert.equal(calls.filter((c) => c.url === "https://ethereum-rpc.publicnode.com").length, 2, "Max reads the wallet again");
    await settle(450);
    const price = calls.find((c) => c.url === "https://api.relay.link/price")!;
    assert.deepEqual(price.body, {
      user: "0x0000000000000000000000000000000000000001",
      recipient: AGENT,
      originChainId: 1,
      destinationChainId: 4663,
      originCurrency: "0x0000000000000000000000000000000000000000",
      destinationCurrency: CASH.USDG,
      amount: "998000000000000000",
      tradeType: "EXACT_INPUT",
      slippageTolerance: "50",
    });
    assert.ok(!JSON.stringify(price.body).includes(OWNER), "the owner's own wallet never goes to Relay");

    const quote = ui.container.querySelector(".deposit-quote")!.textContent!;
    // Dollars go through format.ts, so the locale places the symbol and groups the digits.
    assert.match(quote, /You send0\.998 ETH on Ethereum \(about \$1,792\.40\)/);
    assert.match(quote, /Your agent getsabout 1788\.82 USDG/);
    assert.match(quote, /At least1779\.87 USDG, or Relay refunds you/);
    assert.match(quote, /RouteRelay: ETH on Ethereum → USDG on Robinhood Chain/);
    assert.match(quote, /FeesRelay fee 0\.000026 ETH \(\$0\.04\) · Network fee on Ethereum 0 ETH \(<\$0\.01\)/);
    assert.match(quote, /Slippage cap0\.5%/);
    assert.match(quote, /Price impact, fees included0\.25%/);
    assert.match(quote, /Arrivesunder a minute after you sign/);

    const link = new URL(ui.container.querySelector<HTMLAnchorElement>("a.flow-primary")!.href);
    assert.equal(link.origin + link.pathname, "https://relay.link/bridge/robinhood");
    assert.equal(link.searchParams.get("toAddress"), AGENT);
    assert.equal(link.searchParams.get("toCurrency"), CASH.USDG);
    assert.equal(link.searchParams.get("fromChainId"), "1");
    assert.equal(link.searchParams.get("amount"), "0.998");
    assert.match(text(), /Relay asks you to confirm the recipient: it should be your agent's account, ending DEF0\./);
    assert.match(text(), /its slippage starts on Auto: set Max Slippage to 0\.5% or less\. Merrymen never holds or moves these funds\./);
  });

  it("leaves Max off, and says why, when the wallet's balance can't be read", async () => {
    await ui.render(view({ fetchImpl: stubFetch({ balance: "fail" }) }));
    await tab("From ETH");
    await settle();
    assert.match(text(), /Couldn't read this wallet's ETH on Ethereum, so Max is off\. Type an amount instead\./);
    const max = Array.from(ui.container.querySelectorAll("button")).find((b) => b.textContent === "Max")!;
    assert.equal(max.disabled, true);
    assert.doesNotMatch(text(), /holds 0 ETH/);
  });

  it("refuses Max on a wallet holding no more than its reserve", async () => {
    await ui.render(view({ fetchImpl: stubFetch({ balance: 300_000_000_000_000n }) }));
    await tab("From ETH");
    await ui.click("Base");
    await settle();
    assert.match(text(), /This wallet holds 0\.0003 ETH on Base\. Max keeps 0\.0003 ETH on Base/);
    assert.equal(Array.from(ui.container.querySelectorAll("button")).find((b) => b.textContent === "Max")!.disabled, true);
  });

  it("reads the wallet again on Max, so funds sent since the first reading aren't offered twice", async () => {
    let held: Balance = ETH;
    await ui.render(view({ fetchImpl: stubFetch({ balance: () => held }) }));
    await tab("From ETH");
    await settle();
    assert.match(text(), /This wallet holds 1 ETH on Ethereum\./);
    // The owner sends half of it on Relay, then comes back and presses Max.
    held = ETH / 2n;
    await ui.click("Max");
    await settle();
    assert.equal(inputs()[1]!.value, "0.498");
    assert.match(text(), /This wallet holds 0\.5 ETH on Ethereum\./);
  });

  it("turns Max off, and fills nothing, when the second reading fails", async () => {
    let held: Balance = ETH;
    await ui.render(view({ fetchImpl: stubFetch({ balance: () => held }) }));
    await tab("From ETH");
    await settle();
    held = "fail";
    await ui.click("Max");
    await settle();
    assert.equal(inputs()[1]!.value, "");
    assert.match(text(), /Couldn't read this wallet's ETH on Ethereum, so Max is off\./);
    assert.equal(Array.from(ui.container.querySelectorAll("button")).find((b) => b.textContent === "Max")!.disabled, true);
  });

  it("says Max has nothing to send when the wallet has dropped to its reserve since the first reading", async () => {
    let held: Balance = ETH;
    await ui.render(view({ fetchImpl: stubFetch({ balance: () => held }) }));
    await tab("From ETH");
    await settle();
    held = 2_000_000_000_000_000n;
    await ui.click("Max");
    await settle();
    assert.equal(inputs()[1]!.value, "");
    assert.match(text(), /This wallet now holds no more than it needs for its own fee, so Max has nothing to send\./);
  });

  it("shows Relay's refusal in our words and offers no link to sign", async () => {
    await ui.render(view({ fetchImpl: stubFetch({ relay: "refuse" }) }));
    await tab("From ETH");
    await typeInto(inputs()[1]!, "0.0001");
    await settle(450);
    assert.match(text(), /That amount is below what Relay will convert on this route\. Try a larger amount\./);
    assert.doesNotMatch(text(), /Amount too low/);
    assert.equal(ui.container.querySelector("a.flow-primary"), null);
  });

  it("shows no quote at all for an answer naming another recipient", async () => {
    await ui.render(view({ fetchImpl: stubFetch({ relay: "wrong-recipient" }) }));
    await tab("From ETH");
    await typeInto(inputs()[1]!, "0.02");
    await settle(450);
    assert.match(text(), /Relay's answer didn't match this request \(recipient\), so no quote is shown\. Nothing was sent\./);
    assert.equal(ui.container.querySelector(".deposit-quote"), null);
    assert.equal(ui.container.querySelector("a.flow-primary"), null);
  });

  it("refuses a malformed amount and warns past the wallet's balance", async () => {
    await ui.render(view());
    await tab("From ETH");
    await settle();
    await typeInto(inputs()[1]!, "1e3");
    assert.match(text(), /Enter an amount like 0\.05\./);
    await typeInto(inputs()[1]!, "2");
    assert.match(text(), /That is more than this wallet holds\./);
    await typeInto(inputs()[1]!, "0.9995");
    assert.match(text(), /That leaves less than 0\.002 ETH in this wallet for its next fee\./);
  });

  it("asks for about $2 of ETH for the agent's fees only when its ETH reads zero, and says when it couldn't read it", async () => {
    for (const [ethWei, expect] of [["0", /Your agent has no ETH/], [null, /We couldn't read your agent's ETH just now/], ["5", null]] as const) {
      await ui.remount(view({ balances: { ethWei, cashUsdg: "0", vaultUsdg: "0" } }));
      await tab("From ETH");
      await ui.click("Base");
      await typeInto(inputs()[1]!, "0.02");
      await settle(450);
      const gas = ui.container.querySelector(".deposit-gas");
      if (expect === null) { assert.equal(gas, null, "a funded agent is not asked for more"); continue; }
      assert.match(gas!.textContent!, expect);
      const link = new URL(gas!.querySelector("a")!.href);
      assert.equal(link.searchParams.get("toCurrency"), "0x0000000000000000000000000000000000000000");
      assert.equal(link.searchParams.get("toAddress"), AGENT);
      assert.equal(link.searchParams.get("amount"), "0.001114");
    }
  });

  it("sets the agent's gas top-up aside on Max, so the wallet can still send it", async () => {
    await ui.render(view({ balances: { ethWei: "0", cashUsdg: "0", vaultUsdg: "0" } }));
    await tab("From ETH");
    await ui.click("Base");
    await settle();
    assert.match(text(), /Max keeps 0\.0003 ETH on Base so this wallet can pay its next fee, and sets aside about \$2 of ETH for your agent's gas\./);
    await ui.click("Max");
    await settle();
    // Priced from Relay first (1 ETH less the reserve), then 0.001114 ETH set aside.
    const probe = calls.find((c) => c.url === "https://api.relay.link/price")!;
    assert.equal(probe.body.amount, "999700000000000000");
    assert.equal(inputs()[1]!.value, "0.998586");
    assert.match(text(), /and sets aside 0\.001114 ETH for your agent's gas\./);
    await settle(450);
    const gas = new URL(ui.container.querySelector<HTMLAnchorElement>(".deposit-gas a")!.href);
    assert.equal(gas.searchParams.get("amount"), "0.001114", "the top-up asked for is the one set aside");
  });

  it("says so when it can't price the agent's top-up, rather than spend it", async () => {
    await ui.render(view({ balances: { ethWei: null, cashUsdg: "0", vaultUsdg: "0" }, fetchImpl: stubFetch({ relay: "refuse" }) }));
    await tab("From ETH");
    await settle();
    await ui.click("Max");
    await settle();
    assert.equal(inputs()[1]!.value, "");
    assert.match(text(), /Couldn't price your agent's gas top-up, so Max can't set it aside\. Type an amount instead\./);
  });

  it("on Robinhood Chain itself, says to send the gas straight to the same address", async () => {
    await ui.render(view({ balances: { ethWei: "0", cashUsdg: "0", vaultUsdg: "0" } }));
    await tab("From ETH");
    await ui.click("Robinhood Chain");
    await typeInto(inputs()[1]!, "0.02");
    await settle(450);
    assert.match(ui.container.querySelector(".deposit-gas")!.textContent!, /Also send about 0\.001114 ETH \(about \$2\) straight to the same address on Robinhood Chain\./);
    assert.match(text(), /Relay swap on Robinhood Chain: ETH → USDG/);
  });

  it("never asks a sponsored agent for gas", async () => {
    await ui.render(view({ balances: { ethWei: "0", cashUsdg: "0", vaultUsdg: "0" }, gasSponsored: true }));
    await tab("From ETH");
    await typeInto(inputs()[1]!, "0.02");
    await settle(450);
    assert.ok(ui.container.querySelector(".deposit-quote"));
    assert.equal(ui.container.querySelector(".deposit-gas"), null);
  });
});

describe("From SOL", () => {
  it("prices SOL from Solana with the 1% cap and a 0.005 SOL reserve, and links Relay from Solana", async () => {
    await ui.render(view({ fetchImpl: stubFetch({ balance: 1_000_000_000n }) }));
    await tab("From SOL");
    assert.equal(ui.container.querySelector(".deposit-sources"), null, "one source, no picker");
    assert.equal(inputs()[0]!.value, "", "no EVM address is offered for Solana");
    assert.match(text(), /Add the wallet you're sending from to use Max\. Max keeps 0\.005 SOL so your wallet stays open and can pay its next fee\./);
    await typeInto(inputs()[0]!, SOL_WALLET);
    await settle();
    assert.equal(calls[0]!.url, "https://solana-rpc.publicnode.com");
    assert.equal(calls[0]!.body.method, "getBalance");
    assert.match(text(), /This wallet holds 1 SOL on Solana/);
    await ui.click("Max");
    assert.equal(inputs()[1]!.value, "0.995");
    await settle(450);
    const price = calls.find((c) => c.url === "https://api.relay.link/price")!;
    assert.equal(price.body.originChainId, 792703809);
    assert.equal(price.body.user, "11111111111111111111111111111111");
    assert.equal(price.body.slippageTolerance, "100");
    assert.match(ui.container.querySelector(".deposit-quote")!.textContent!, /Slippage cap1%/);
    const link = new URL(ui.container.querySelector<HTMLAnchorElement>("a.flow-primary")!.href);
    assert.equal(link.searchParams.get("fromChainId"), "792703809");
    assert.equal(link.searchParams.get("fromCurrency"), "11111111111111111111111111111111");
    assert.equal(link.searchParams.get("amount"), "0.995");
  });

  it("calls an EVM address no Solana wallet", async () => {
    await ui.render(view());
    await tab("From SOL");
    await typeInto(inputs()[0]!, OWNER);
    assert.match(text(), /That isn't a Solana address\./);
    assert.equal(calls.length, 0);
  });
});

describe("after the owner leaves for Relay", () => {
  async function leave(cashUsdg: string | null = "5000000") {
    await ui.render(view({ balances: { ethWei: "1", cashUsdg, vaultUsdg: "0" } }));
    await tab("From ETH");
    await typeInto(inputs()[1]!, "0.02");
    await settle(450);
    await clickLink("Continue on Relay");
    assert.equal(opened.length, 1);
  }

  it("watches the agent's balance from the reading taken when the owner left, until it rises by the minimum", async () => {
    await leave();
    assert.match(ui.container.querySelector(".deposit-watch")!.textContent!, /Watching for at least 35\.66 USDG to reach your agent\./);
    await ui.render(view({ balances: { ethWei: "1", cashUsdg: "6000000", vaultUsdg: "0" } }));
    assert.match(ui.container.querySelector(".deposit-watch")!.textContent!, /Some USDG arrived \(1\.00\), less than the 35\.66 USDG minimum\./);
    await ui.render(view({ balances: { ethWei: "1", cashUsdg: "45000000", vaultUsdg: "0" } }));
    assert.match(ui.container.querySelector(".deposit-watch")!.textContent!, /Arrived: 40\.00 USDG reached your agent\./);
    await ui.click("Done");
    assert.equal(ui.container.querySelector(".deposit-watch"), null);
  });

  it("says its read failed, never that nothing arrived, when the balance is unread", async () => {
    await leave();
    await ui.render(view({ balances: { ethWei: "1", cashUsdg: null, vaultUsdg: null } }));
    assert.match(ui.container.querySelector(".deposit-watch")!.textContent!, /We couldn't read your agent's balance just now\. That's our read failing, not your deposit\./);
  });

  it("will not compare against a starting balance it never read", async () => {
    await leave(null);
    assert.match(ui.container.querySelector(".deposit-watch")!.textContent!, /we can't tell when this deposit lands/);
    assert.ok(Array.from(ui.container.querySelectorAll(".deposit-watch a")).some((a) => a.textContent === "Find your request on Relay"));
  });

  it("says 'not seen yet' after fifteen minutes, and points to Relay for a refund", async () => {
    await leave();
    const later = Date.now() + 16 * 60_000;
    await ui.render(view({ now: () => later }));
    const watch = ui.container.querySelector(".deposit-watch")!.textContent!;
    assert.match(watch, /Nothing has arrived after 15 minutes\./);
    assert.match(watch, /refunded to the wallet you sent from/);
    assert.doesNotMatch(watch, /fail/i);
  });

  it("keeps a seen arrival when the agent then trades the USDG away, across a reload too, until Done", async () => {
    await leave();
    await ui.render(view({ balances: { ethWei: "1", cashUsdg: "45000000", vaultUsdg: "0" } }));
    assert.match(ui.container.querySelector(".deposit-watch")!.textContent!, /Arrived: 40\.00 USDG reached your agent\./);
    // The agent buys with it: the balance falls below where it started.
    await ui.render(view({ balances: { ethWei: "1", cashUsdg: "1000000", vaultUsdg: "0" } }));
    assert.match(ui.container.querySelector(".deposit-watch")!.textContent!, /Arrived: 40\.00 USDG reached your agent\./);
    await ui.render(view({ balances: { ethWei: "1", cashUsdg: null, vaultUsdg: null }, now: () => Date.now() + 16 * 60_000 }));
    assert.match(ui.container.querySelector(".deposit-watch")!.textContent!, /Arrived: 40\.00 USDG reached your agent\./);
    await ui.remount(view({ balances: { ethWei: "1", cashUsdg: "1000000", vaultUsdg: "0" } }));
    assert.match(ui.container.querySelector(".deposit-watch")!.textContent!, /Arrived: 40\.00 USDG reached your agent\./);
    await ui.click("Done");
    assert.equal(ui.container.querySelector(".deposit-watch"), null);
    await ui.remount(view({ balances: { ethWei: "1", cashUsdg: "1000000", vaultUsdg: "0" } }));
    assert.equal(ui.container.querySelector(".deposit-watch"), null, "dismissed stays dismissed");
  });

  it("starts fresh, from the balance now, when the owner leaves for another deposit", async () => {
    await leave();
    await ui.render(view({ balances: { ethWei: "1", cashUsdg: "45000000", vaultUsdg: "0" } }));
    assert.match(ui.container.querySelector(".deposit-watch")!.textContent!, /Arrived:/);
    await clickLink("Continue on Relay");
    assert.match(ui.container.querySelector(".deposit-watch")!.textContent!, /Watching for at least 35\.66 USDG to reach your agent\./);
  });

  it("remembers what it is waiting for across a reload of the tab", async () => {
    await leave();
    await ui.remount(view({ balances: { ethWei: "1", cashUsdg: "45000000", vaultUsdg: "0" } }));
    assert.match(ui.container.querySelector(".deposit-watch")!.textContent!, /Arrived: 40\.00 USDG reached your agent\./);
  });
});
