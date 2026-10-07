import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { gasFields } from "./key-install-accounting";

/**
 * A REVERTED TRADE STILL PAID FOR ITS GAS, AND ITS ROW SAYS SO.
 *
 * The executor has always handed the receipt's per-operation cost and payer to
 * the revert it throws (executor.ts perOperationGasProof). The trade path threw
 * it away and wrote the reverted row with no gas at all — and the board reads
 * one such row as an unrecorded cost, withholding the agent's whole P&L for the
 * run ("Gas accounting unavailable", web book-performance.ts gasAt). Pinned at
 * the source because the failure is silent: nothing errors, the figure just
 * never appears.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const INDEX = readFileSync(`${HERE}index.ts`, "utf8");
/** The trade path's revert branch: from the typed on-chain test to the row it writes. */
const BRANCH = INDEX.slice(INDEX.indexOf("const onChain = e instanceof UserOpReverted;"));
const ROW = BRANCH.slice(0, BRANCH.indexOf("...sim,"));

describe("the trade path's revert row", () => {
  it("takes its gas from the revert's receipt proof, through gasFields", () => {
    assert.ok(BRANCH.length > 0 && ROW.length > 0, "the revert branch moved; re-point this test");
    assert.match(ROW, /const revertProof = onChain \? e\.gasProof : undefined;/);
    assert.match(ROW, /revertGas = gasFields\(revertProof, priced\)/);
    assert.match(ROW, /\.\.\.\(revertGas \?\? \{\}\)/);
    assert.match(ROW, /tx_hash: revertProof\.txHash/);
  });

  it("prices only what the owner paid, at this moment's ETH price", () => {
    assert.match(ROW, /revertProof\.gasPayer === "owner"[\s\S]{0,120}?ethPrice8\(\)[\s\S]{0,120}?priceGas\(revertProof\.gasWei/);
  });

  it("does not decide the payer from the sponsorship setting", () => {
    assert.doesNotMatch(ROW, /gasSponsored\(\)/);
  });
});

describe("what such a row carries", () => {
  const proof = { txHash: "0xabc" as const, gasWei: 1_000_000_000_000n, gasUnits: 210_000n };

  it("books an owner-paid revert as an owner cost, priced", () => {
    assert.deepEqual(gasFields({ ...proof, gasPayer: "owner" }, 0.004), {
      gas_wei: "1000000000000", gas_usdg: 0.004, gas_units: "210000",
    });
  });

  it("books an owner-paid revert with no price as wei, never as zero", () => {
    assert.deepEqual(gasFields({ ...proof, gasPayer: "owner" }, null), { gas_wei: "1000000000000", gas_units: "210000" });
  });

  it("books a sponsored revert as the sponsor's, which costs the owner nothing", () => {
    assert.deepEqual(gasFields({ ...proof, gasPayer: "sponsor" }, 0.004), {
      sponsored_gas_wei: "1000000000000", gas_units: "210000",
    });
  });
});
