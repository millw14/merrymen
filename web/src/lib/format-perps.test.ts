import assert from "node:assert/strict";
import { test } from "node:test";
import { chartDayUtc, chartTimeUtc, marketPrice, pctPts } from "./format";

test("chart quotes preserve small measured values and distinguish unknown from zero", () => {
  for (const value of [null, NaN, Infinity, -Infinity]) assert.equal(marketPrice(value), "—");
  assert.equal(marketPrice(0), "0.00");
  assert.equal(marketPrice(1234.5), "1,234.50");
  assert.equal(marketPrice(0.004213), "0.004213");
  assert.equal(marketPrice(1e-8), "1.000E-8");
  assert.equal(marketPrice(Number.MIN_VALUE), "5.000E-324");
});

test("chart figures follow the reader's locale, including signs and scientific decimals", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  try {
    Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: { lang: "tr" } } });
    assert.equal(marketPrice(1234.5), "1.234,50");
    assert.equal(marketPrice(1.234e-8), "1,234E-8");
    assert.equal(pctPts(2.5), "+%2,50");
    assert.equal(chartDayUtc(Date.UTC(2026, 0, 1)), "01 Oca");
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
  assert.equal(marketPrice(1234.5), "1,234.50", "locale changes do not reuse a differently localized formatter");
});

test("chart dates keep UTC boundaries in browsers on either side of the date line", () => {
  const previous = process.env.TZ;
  try {
    for (const zone of ["Pacific/Honolulu", "Pacific/Kiritimati"]) {
      process.env.TZ = zone;
      assert.equal(chartTimeUtc(Date.UTC(2026, 0, 1, 0, 5)), "00:05");
      assert.equal(chartDayUtc(Date.UTC(2026, 0, 1, 0, 5)), "Jan 01");
    }
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
  for (const invalid of [null, NaN, Infinity, 8.64e15 + 1]) {
    assert.equal(chartTimeUtc(invalid), "—");
    assert.equal(chartDayUtc(invalid), "—");
  }
});
