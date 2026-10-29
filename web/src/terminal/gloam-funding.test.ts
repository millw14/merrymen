import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import React, { act } from "react";
import { GLOAM_PAY_URL, gloamFundingEnabled, gloamFundingLink } from "../lib/gloam-funding";
import { EN } from "../lib/messages/en";
import { CATALOGUES } from "../lib/messages";
import { GloamFunding } from "./GloamFunding";
import { deferred, testDom } from "./test-dom";

const ADDRESS = "0x1111111111111111111111111111111111111111";
const NEXT_ADDRESS = "0x2222222222222222222222222222222222222222";
const originalFlag = process.env.NEXT_PUBLIC_GLOAM_FUNDING_ENABLED;
let ui: ReturnType<typeof testDom>;
let navigations: number;

beforeEach(() => {
  process.env.NEXT_PUBLIC_GLOAM_FUNDING_ENABLED = "1";
  ui = testDom();
  navigations = 0;
  // Observe attempted link navigation without opening an external service.
  ui.container.addEventListener("click", (event) => {
    if ((event.target as Element).closest("a")) {
      navigations++;
      event.preventDefault();
    }
  });
});

afterEach(async () => {
  await ui.close();
  if (originalFlag === undefined) delete process.env.NEXT_PUBLIC_GLOAM_FUNDING_ENABLED;
  else process.env.NEXT_PUBLIC_GLOAM_FUNDING_ENABLED = originalFlag;
});

const view = (address = ADDRESS, chainId = 4663) => React.createElement(GloamFunding, { address, chainId });
const clipboard = (writeText?: (value: string) => Promise<void>) => Object.defineProperty(navigator, "clipboard", {
  configurable: true, value: writeText ? { writeText } : undefined,
});

describe("Gloam funding deployment and network boundaries", () => {
  it("requires an explicit deployment opt-in and hides every other value", async () => {
    for (const value of [undefined, "", "0", "true", "yes"]) {
      if (value === undefined) delete process.env.NEXT_PUBLIC_GLOAM_FUNDING_ENABLED;
      else process.env.NEXT_PUBLIC_GLOAM_FUNDING_ENABLED = value;
      assert.equal(gloamFundingEnabled(), false);
      await ui.render(view());
      assert.equal(ui.container.textContent, "");
    }
    process.env.NEXT_PUBLIC_GLOAM_FUNDING_ENABLED = "1";
    await ui.render(view());
    assert.ok(ui.container.querySelector("a"));
  });

  it("offers funding only on Robinhood Chain mainnet", async () => {
    assert.equal(gloamFundingLink(4663), GLOAM_PAY_URL);
    for (const chainId of [46630, 1, 8453, 0]) {
      assert.equal(gloamFundingLink(chainId), null);
      await ui.render(view(ADDRESS, chainId));
      assert.equal(ui.container.textContent, "");
    }
  });

  it("opens a generic Pay page without passing the agent or referring page", async () => {
    await ui.render(view());
    const link = ui.container.querySelector("a")!;
    const url = new URL(link.href);
    assert.equal(url.origin, "https://gloam.trade");
    assert.deepEqual([...url.searchParams.entries()].sort(), [["mode", "pay"], ["tab", "move"]]);
    assert.equal(url.hash, "");
    assert.equal(link.target, "_blank");
    assert.ok(link.relList.contains("noopener"));
    assert.ok(link.relList.contains("noreferrer"));
  });
});

describe("copying the destination and opening Gloam are separate actions", () => {
  it("copies the exact address, announces success and waits for an explicit Open click", async () => {
    const writes: string[] = [];
    clipboard(async value => { writes.push(value); });
    await ui.render(view());
    await ui.click(EN["fund.gloam.copy"]);
    assert.deepEqual(writes, [ADDRESS]);
    assert.equal(ui.container.querySelector('[role="status"]')?.textContent, EN["fund.gloam.copied"]);
    assert.equal(navigations, 0);
    await act(async () => { ui.container.querySelector("a")!.click(); });
    assert.equal(navigations, 1);
    assert.deepEqual(writes, [ADDRESS], "opening does not race a second clipboard write");
  });

  it("shows clipboard rejection and the full manual-copy address without navigating", async () => {
    clipboard(async () => { throw new Error("Permission denied"); });
    await ui.render(view());
    await ui.click(EN["fund.gloam.copy"]);
    const alert = ui.container.querySelector('[role="alert"]')!;
    assert.ok(alert.textContent?.includes(EN["fund.gloam.copyFailed"]));
    assert.equal(alert.querySelector(".funding-address")?.textContent, ADDRESS);
    assert.equal(ui.container.querySelector('[role="status"]'), null);
    assert.equal(navigations, 0);
  });

  it("supports manual copying when the browser has no clipboard API", async () => {
    clipboard();
    await ui.render(view());
    await ui.click(EN["fund.gloam.copy"]);
    assert.ok(ui.container.querySelector('[role="alert"]')?.textContent?.includes(ADDRESS));
    assert.equal(navigations, 0);
  });

  it("never labels a newly selected account as copied when an old copy finishes", async () => {
    const pending = deferred<void>();
    clipboard(() => pending.promise);
    await ui.render(view());
    await ui.click(EN["fund.gloam.copy"]);
    assert.equal(ui.container.querySelector("button")!.disabled, true);
    await ui.render(view(NEXT_ADDRESS));
    await act(async () => pending.resolve());
    assert.equal(ui.container.querySelector('[role="status"]'), null);
    assert.equal(ui.container.querySelector("button")!.disabled, false);
    const writes: string[] = [];
    clipboard(async value => { writes.push(value); });
    await ui.click(EN["fund.gloam.copy"]);
    assert.deepEqual(writes, [NEXT_ADDRESS]);
    assert.equal(navigations, 0);
  });
});

it("shows relay conditions, public-chain limits, beta fees and recipient checks together", async () => {
  await ui.render(view());
  const text = ui.container.textContent!;
  assert.match(text, /Hide my wallet enabled and its relay available/);
  assert.match(text, /owning wallet, balance and trades remain visible on chain/);
  assert.match(text, /amounts and times, which can still link them/);
  assert.match(text, /Gloam is in beta/);
  assert.match(text, /Review its fees/);
  assert.match(text, /credits only the USDG that arrives/);
  assert.match(text, /Check the full recipient address before confirming/);
  assert.match(text, /Robinhood Chain mainnet and USDG/);
});

it("keeps fund.* English until the whole funding screen is translated", () => {
  for (const [tag, table] of Object.entries(CATALOGUES)) {
    assert.deepEqual(Object.keys(table ?? {}).filter(key => key.startsWith("fund.")), [], tag);
  }
});
