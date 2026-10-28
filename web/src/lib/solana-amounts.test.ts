import assert from "node:assert/strict";
import { test } from "node:test";
import { solanaUnits, displaySolanaAmount, displaySolanaAmountOrNull } from "./solana-amounts";
test("Solana amounts preserve u64 precision and signed accounting displays", () => {
  assert.equal(solanaUnits("18446744073709.551615", 6), "18446744073709551615");
  assert.equal(displaySolanaAmount("18446744073709551615"), "18446744073709.551615");
  assert.equal(displaySolanaAmount("-1500001"), "-1.500001");
  assert.equal(displaySolanaAmount("-1"), "-0.000001");
  assert.equal(displaySolanaAmount("0", 0), "0");
  assert.equal(solanaUnits("0.00", 2, true), "0");
  for (const input of ["0", "01", "-1", "1e6", "1.0000001", "18446744073709.551616"]) assert.throws(() => solanaUnits(input, 6));
});
test("optional status amounts display when raw and are hidden, never thrown, when malformed", () => {
  assert.equal(displaySolanaAmountOrNull("1500000", 9), "0.0015");
  assert.equal(displaySolanaAmountOrNull("0", 9), "0");
  for (const input of [undefined, null, 5000, "", "-1", "1.5", "01", "1e9", "9".repeat(41)]) assert.equal(displaySolanaAmountOrNull(input, 9), null, String(input));
});
