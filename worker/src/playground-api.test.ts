import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_USDG_UI, usdgUnits } from "../../packages/core/src/index";
import { parsePlaygroundRequest } from "./playground-api";

const VALID = {
  strategy: "steady-basket",
  symbols: ["AAPL", "QQQ"],
  days: 30,
  startingCashUsdg: 500,
  seed: 42,
};

describe("parsePlaygroundRequest", () => {
  it("accepts a bounded request", () => {
    assert.deepEqual(parsePlaygroundRequest(VALID), { ok: true, value: VALID });
  });

  it("rejects malformed bodies and unsafe numeric inputs", () => {
    const invalid: unknown[] = [
      null,
      [],
      "not an object",
      { ...VALID, symbols: "QQQ" },
      { ...VALID, symbols: [null, {}, 1] },
      { ...VALID, days: 1e9 },
      { ...VALID, days: Infinity },
      { ...VALID, startingCashUsdg: Infinity },
      { ...VALID, startingCashUsdg: 1e303 },
      { ...VALID, startingCashUsdg: MAX_USDG_UI + 1 },
      { ...VALID, seed: -1 },
      { ...VALID, seed: 0x1_0000_0000 },
    ];
    for (const input of invalid) {
      assert.equal(parsePlaygroundRequest(input).ok, false, JSON.stringify(input));
    }
  });
});

describe("usdgUnits", () => {
  it("converts six-decimal UI values exactly", () => {
    assert.equal(usdgUnits(12.345678), 12_345_678n);
  });

  it("refuses non-finite and unsafe values before BigInt conversion", () => {
    for (const value of [Infinity, -Infinity, Number.NaN, 1e303, MAX_USDG_UI + 1]) {
      assert.throws(() => usdgUnits(value), RangeError);
    }
  });
});
