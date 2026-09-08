/**
 * THE SECOND FEE, AND WHY IT IS NOT THE FIRST ONE.
 *
 * `accrueAboveHwm` charges on PROFIT above a high-water mark: no profit, no
 * fee, and climbing back to a previous peak is free. `tradeFeeUsdg` charges on
 * TURNOVER — owed on every trade, win or lose. To an owner those are completely
 * different bills, so they stay separate everywhere: separate function,
 * separate rate, separate column, never summed into one number that hides which
 * is which.
 *
 * ACCRUAL ONLY. Nothing here moves money, and nothing can: collection needs a
 * `transfer` permission sealed into the wall, and no existing grant carries one
 * because `withdrawalAddresses` has always been empty. That is not a gap to be
 * closed quietly — it is the same discipline fees.ts already states about the
 * performance fee: "the ledger records what is owed; actual collection ships
 * with the funded-account flow so the ledger is auditable before any money
 * moves."
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { tradeFeeUsdg } from "./fees";

const codeOf = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");

/** USDG is 6 decimals — 1_000_000n is one dollar. */
const usdg = (n: number) => BigInt(Math.round(n * 1e6));

describe("what 0.5% of a trade is", () => {
  it("charges the configured rate on the notional", () => {
    assert.equal(tradeFeeUsdg(usdg(100), 50), usdg(0.5));
    assert.equal(tradeFeeUsdg(usdg(10), 50), usdg(0.05));
    assert.equal(tradeFeeUsdg(usdg(1), 50), usdg(0.005));
  });

  it("ROUNDS DOWN, toward the owner, on every trade forever", () => {
    // Integer division truncates. That is a choice: a rounding error nobody
    // will ever audit should fall on the side of the person whose money it is.
    // 1 unit of USDG at 50 bps is 0.005 units — less than the smallest unit.
    assert.equal(tradeFeeUsdg(1n, 50), 0n);
    assert.equal(tradeFeeUsdg(199n, 50), 0n);
    assert.equal(tradeFeeUsdg(200n, 50), 1n);
  });

  it("a zero rate charges nothing at all", () => {
    assert.equal(tradeFeeUsdg(usdg(1000), 0), 0n);
  });
});

describe("what it refuses to do", () => {
  it("A NEGATIVE NOTIONAL IS NOT A REBATE", () => {
    // Sizes are unsigned everywhere upstream. If a signed one ever arrives, a
    // proportional fee would be NEGATIVE — crediting the owner out of the fee
    // account. Return nothing rather than invent a payout.
    assert.equal(tradeFeeUsdg(-1n, 50), 0n);
    assert.equal(tradeFeeUsdg(usdg(-100), 50), 0n);
    assert.equal(tradeFeeUsdg(0n, 50), 0n);
  });

  it("and refuses a rate that is not a rate", () => {
    // Same guard shape as accrueAboveHwm: a fee of 100% or more, or a
    // fractional bps, is a configuration error and must not silently apply.
    for (const bad of [-1, 10_000, 20_000, 1.5, NaN]) {
      assert.throws(() => tradeFeeUsdg(usdg(100), bad), /out of range/);
    }
  });
});

describe("it is accrued, and nothing is moved", () => {
  const INDEX = codeOf(readFileSync(new URL("./index.ts", import.meta.url), "utf8"));
  const STORE = codeOf(readFileSync(new URL("./store.ts", import.meta.url), "utf8"));

  it("ONLY A LANDED TRADE OWES IT", () => {
    // A refused, reverted or rejected trade is not turnover. The accrual sits
    // in the landed branch and nowhere else.
    const at = INDEX.indexOf("trade_fee_usdg: usdgNum(tradeFeeUsdg(");
    assert.ok(at > 0, "the fee must be accrued on a trade row");
    const before = INDEX.slice(Math.max(0, at - 600), at);
    assert.match(before, /status: "landed"/, "accrued only where the trade landed");
    // Exactly ONE call site. A second would be a second bill on the same trade,
    // and the two would be indistinguishable in the column that records it.
    assert.equal((INDEX.match(/tradeFeeUsdg\(/g) ?? []).length, 1);
  });

  it("A TRANSFER IS NOT A TRADE", () => {
    // Moving your own money home is not turnover. The ledger already treats it
    // as a flow rather than a trade for the same reason.
    const at = INDEX.indexOf("trade_fee_usdg: usdgNum(tradeFeeUsdg(");
    const around = INDEX.slice(at - 200, at + 120);
    assert.match(around, /intent\.kind === "transfer"\s*\n?\s*\? \{\}/);
  });

  it("NOTHING TRANSFERS THE FEE ANYWHERE", () => {
    // The whole safety property of this change. If a transfer to a fee address
    // ever appears, it must arrive with a wall permission and a re-sign, not as
    // a quiet addition to an accrual.
    assert.ok(
      !/tradeFeeAddress/.test(INDEX),
      "the worker must not send anywhere until the wall covers it",
    );
  });

  it("and an unassessed fee is NULL, not zero", () => {
    // A trade written before this column existed, or one that never landed,
    // owes nothing knowable. Zero would be a claim about it.
    assert.match(STORE, /row\.trade_fee_usdg \?\? null/);
    assert.ok(!/row\.trade_fee_usdg \?\? 0/.test(STORE));
    assert.match(STORE, /ALTER TABLE trades ADD COLUMN trade_fee_usdg REAL/);
  });
});

describe("who may set it", () => {
  it("THE RATE AND THE DESTINATION ARE HOUSE-OWNED", () => {
    // A tenant who could set either would be setting their own bill to zero, or
    // pointing the platform's fee at their own wallet. Same category as
    // sponsorship: not a credential, not our egress — our money.
    const settings = codeOf(
      readFileSync(new URL("../../packages/core/src/settings.ts", import.meta.url), "utf8"),
    );
    const at = settings.indexOf("HOUSE_KEY_FIELDS");
    const list = settings.slice(at, settings.indexOf("]", at));
    assert.match(list, /"tradeFeeBps"/);
    assert.match(list, /"tradeFeeAddress"/);
  });

  it("and the rate is bounded far below the performance fee's ceiling", () => {
    // 5000 bps of PROFIT is survivable; 5000 bps of TURNOVER would empty an
    // account in a fortnight. The same number means something much larger here.
    const worker = codeOf(readFileSync(new URL("./settings.ts", import.meta.url), "utf8"));
    assert.match(worker, /tradeFeeBps: num\(file\.tradeFeeBps, env\.MERRYMEN_TRADE_FEE_BPS, d\.tradeFeeBps \?\? 50, 0, 500\)/);
  });
});
