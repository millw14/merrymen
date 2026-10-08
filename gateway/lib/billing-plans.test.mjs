/**
 * The plan table and token arithmetic. `node --test lib/billing-plans.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ONE_TOKEN, PERIOD_DAYS, PERIOD_MS, PLANS, TOKEN, ceilTokens, formatTokens, parseTokens, validatePlans } from "./billing-plans.mjs";

test("the table is the one the owner set: Free, then 100k to 1M MERRYMEN per 30 days", () => {
  assert.equal(PERIOD_MS, 2_592_000_000);
  assert.equal(PERIOD_MS, PERIOD_DAYS * 86_400_000);
  const rows = Object.values(PLANS).map((p) => [p.id, p.price_raw / ONE_TOKEN, p.requests, p.rpm]);
  assert.deepEqual(rows, [
    ["free", 0n, 1_000, 30],
    ["crumbs", 100_000n, 50_000, 60],
    ["loaf", 400_000n, 250_000, 120],
    ["feast", 1_000_000n, 1_000_000, 300],
  ]);
  // Prices are bigint raw units: 1M tokens is 1e24 raw, past what a double holds exactly.
  for (const p of Object.values(PLANS)) assert.equal(typeof p.price_raw, "bigint");
  assert.ok(Object.isFrozen(PLANS) && Object.isFrozen(PLANS.feast), "the table cannot be edited at runtime");
});

test("the token and explorer mirror packages/core, so a payment is checked against the real contract", () => {
  // Read, not imported: the gateway is plain ESM and ships without packages/.
  const core = (rel) => readFileSync(fileURLToPath(new URL(`../../packages/core/src/${rel}`, import.meta.url)), "utf8");
  const token = core("token.ts");
  const block = /export const MERRYMEN_TOKEN = \{([\s\S]*?)\} as const;/.exec(token)?.[1] ?? "";
  assert.match(block, new RegExp(`address: "${TOKEN.address}"`));
  assert.match(block, new RegExp(`decimals: ${TOKEN.decimals},`));
  assert.match(block, new RegExp(`chainId: ${TOKEN.chainId},`));
  assert.match(block, new RegExp(`symbol: "${TOKEN.symbol}"`));
  assert.ok(core("chain.ts").includes(`url: "${TOKEN.explorer}"`), "explorer drifted from packages/core/src/chain.ts");
  assert.equal(ONE_TOKEN, 10n ** 18n);
});

test("a table that would mis-bill is refused", () => {
  const ok = { free: PLANS.free, crumbs: PLANS.crumbs };
  assert.equal(validatePlans(ok), ok);
  const bad = [
    { crumbs: PLANS.crumbs },
    { free: { ...PLANS.free, price_raw: 1n } },
    { free: PLANS.free, crumbs: { ...PLANS.crumbs, price_raw: 0n } },
    { free: PLANS.free, crumbs: { ...PLANS.crumbs, price_raw: 100 } },
    { free: PLANS.free, crumbs: { ...PLANS.crumbs, requests: 0 } },
    { free: PLANS.free, crumbs: { ...PLANS.crumbs, rpm: 1.5 } },
    { free: PLANS.free, crumbs: { ...PLANS.crumbs, id: "loaf" } },
    { free: PLANS.free, Crumbs: { ...PLANS.crumbs, id: "Crumbs" } },
  ];
  for (const plans of bad) assert.throws(() => validatePlans(plans), /plans:/, JSON.stringify(Object.keys(plans)));
});

test("amounts format exactly, and what to send rounds up to a whole token", () => {
  assert.equal(formatTokens(0n), "0");
  assert.equal(formatTokens(100_000n * ONE_TOKEN), "100000");
  assert.equal(formatTokens(96_666_666_666_666_666_666_667n), "96666.666666666666666667");
  assert.equal(formatTokens(-5n * ONE_TOKEN / 2n), "-2.5");
  assert.equal(formatTokens("1"), "0.000000000000000001");
  assert.equal(ceilTokens(1n), "1");
  assert.equal(ceilTokens(ONE_TOKEN), "1");
  assert.equal(ceilTokens(ONE_TOKEN + 1n), "2");
  assert.equal(ceilTokens(96_666_666_666_666_666_666_667n), "96667");
  assert.equal(ceilTokens(0n), "0");
  assert.equal(ceilTokens(-1n), "0");
});

test("parseTokens reads what an operator types and refuses what it cannot read exactly", () => {
  assert.equal(parseTokens("100000"), 100_000n * ONE_TOKEN);
  assert.equal(parseTokens("+1.5"), 3n * ONE_TOKEN / 2n);
  assert.equal(parseTokens("-0.000000000000000001"), -1n);
  for (const bad of ["", "1e6", "1,000", "0x10", "1.0000000000000000001", "abc", "--1", null]) {
    assert.throws(() => parseTokens(bad), /not a token amount/, String(bad));
  }
});
