import assert from "node:assert/strict";
import { test } from "node:test";
import { tradeDigestLine } from "./notifier";

test("tradeDigestLine summarises only the non-empty status buckets", () => {
  const line = tradeDigestLine(
    [
      { status: "paper", c: 12, s: 75 },
      { status: "rejected", c: 3, s: 22.5 },
    ],
    15,
  );
  assert.match(line, /last 15m/);
  assert.match(line, /12× paper \(75\.00 USDG\)/);
  assert.match(line, /3× turned back/);
  assert.doesNotMatch(line, /landed/); // no landed bucket → not shown
});

test("tradeDigestLine labels periods nicely (m / h / d)", () => {
  assert.match(tradeDigestLine([{ status: "paper", c: 1, s: 6.25 }], 5), /last 5m/);
  assert.match(tradeDigestLine([{ status: "paper", c: 1, s: 6.25 }], 60), /last 1h/);
  assert.match(tradeDigestLine([{ status: "paper", c: 1, s: 6.25 }], 1440), /last 1d/);
});

test("tradeDigestLine with nothing new reads as quiet", () => {
  assert.match(tradeDigestLine([], 30), /quiet/);
});
