/**
 * THE ENERGY ROUTE'S ARITHMETIC, AND ITS SILENCES.
 *
 * The pool quotes $MERRYMEN before the token's buy tax; what ARRIVES is after
 * it. Two helpers turn one into the other and must be exact inverses in the
 * safe direction: asking for grossNeededFor(x) and flooring it back through
 * energyMinOut must never come out below x, or the estimate an owner is shown
 * would buy less than it says. And every chain read says "no answer" as null,
 * never as a zero that would look like a price.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { ENERGY_ROUTE_V1, MERRYMEN_TOKEN } from "../../../packages/core/src/index";
import {
  energyAmountInFor,
  energyMinOut,
  grossNeededFor,
  quoteEnergyOut,
  readEnergyTaxBps,
  type ReadClient,
} from "./uniswap-v2";

type Call = { address: string; functionName: string; args?: readonly unknown[] };
const fake = (answer: (c: Call) => unknown) => {
  const calls: Call[] = [];
  const client: ReadClient = {
    async readContract(c) {
      calls.push(c);
      const r = answer(c);
      if (r instanceof Error) throw r;
      return r;
    },
  };
  return { client, calls };
};

describe("tax, then slippage, floored", () => {
  it("gross 1e24 at 1% tax and 1% slippage is exactly 0.99 × 0.99", () => {
    assert.equal(energyMinOut(10n ** 24n, 100, 100), (10n ** 24n * 99n * 99n) / 10_000n);
  });
  it("zero tax and zero slippage is the quote itself", () => {
    assert.equal(energyMinOut(123_456n, 0, 0), 123_456n);
  });
  it("a tax figure that is not bps is refused, not used", () => {
    assert.throws(() => energyMinOut(1n, 10_000, 0));
    assert.throws(() => energyMinOut(1n, -1, 0));
    assert.throws(() => grossNeededFor(1n, 0, 10_000));
  });
});

describe("grossNeededFor is energyMinOut's inverse, rounded the safe way", () => {
  it("PROPERTY: energyMinOut(grossNeededFor(x)) ≥ x, and not by more than rounding", () => {
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    for (let i = 0; i < 2_000; i++) {
      const x = BigInt(rnd(1_000_000_000)) * 10n ** BigInt(rnd(19)) + BigInt(rnd(1000)) + 1n;
      const tax = rnd(500);
      const slip = rnd(500);
      const g = grossNeededFor(x, tax, slip);
      const back = energyMinOut(g, tax, slip);
      assert.ok(back >= x, `x=${x} tax=${tax} slip=${slip} g=${g} back=${back}`);
      // And not by more than the rounding: an estimate must not quietly over-ask.
      assert.ok(g === 0n || back - x <= (x / 1_000_000n) + 3n, `overshoot x=${x} back=${back}`);
    }
  });
  it("nothing needed is nothing asked", () => {
    assert.equal(grossNeededFor(0n, 100, 100), 0n);
  });
});

describe("the reads say 'no answer' as null", () => {
  it("getAmountsOut: the last hop, over the frozen route", async () => {
    const { client, calls } = fake(() => [1_000_000n, 5n * 10n ** 18n, 7n * 10n ** 22n]);
    assert.equal(await quoteEnergyOut(client, 1_000_000n), 7n * 10n ** 22n);
    assert.equal(calls[0]!.address, ENERGY_ROUTE_V1.router);
    assert.equal(calls[0]!.functionName, "getAmountsOut");
    assert.deepEqual(calls[0]!.args, [1_000_000n, ENERGY_ROUTE_V1.path]);
  });
  it("A REVERTING getAmountsOut IS NO QUOTE", async () => {
    const { client } = fake(() => new Error("execution reverted"));
    assert.equal(await quoteEnergyOut(client, 1_000_000n), null);
  });
  it("an empty pool or a malformed answer is no quote either", async () => {
    assert.equal(await quoteEnergyOut(fake(() => [1n, 1n, 0n]).client, 1n), null);
    assert.equal(await quoteEnergyOut(fake(() => [1n, 2n]).client, 1n), null);
    assert.equal(await quoteEnergyOut(fake(() => "7").client, 1n), null);
  });
  it("getAmountsIn: the first hop; a revert (not enough liquidity) is null", async () => {
    const ok = fake(() => [37_120_000n, 1n, 1n]);
    assert.equal(await energyAmountInFor(ok.client, 10n ** 18n), 37_120_000n);
    assert.equal(ok.calls[0]!.functionName, "getAmountsIn");
    assert.equal(await energyAmountInFor(fake(() => new Error("INSUFFICIENT_LIQUIDITY")).client, 10n ** 18n), null);
  });
  it("the tax is read from the token itself; a failed or absurd read is null", async () => {
    const ok = fake(() => 100n);
    assert.equal(await readEnergyTaxBps(ok.client), 100);
    assert.equal(ok.calls[0]!.address.toLowerCase(), MERRYMEN_TOKEN.address.toLowerCase());
    assert.equal(ok.calls[0]!.functionName, "totalBuyTaxBasisPoints");
    assert.equal(await readEnergyTaxBps(fake(() => new Error("no")).client), null);
    assert.equal(await readEnergyTaxBps(fake(() => 10_000n).client), null);
    assert.equal(await readEnergyTaxBps(fake(() => 3).client), null);
  });
});

describe("read-only, and no transport of its own", () => {
  const code = readFileSync(new URL("./uniswap-v2.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");
  it("builds no call and imports no write ABI", () => {
    assert.doesNotMatch(code, /encodeFunctionData|UNISWAP_V2_ENERGY_ABI|sendUserOp|writeContract/);
  });
  it("opens no client of its own", () => {
    assert.doesNotMatch(code, /createPublicClient|chainRead\(|metered\(|http\(/);
  });
});
