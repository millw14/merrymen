/**
 * A CURVE TRADE MAY SPEND CASH AND THE OWNER'S COINS. NEVER THE EQUITY BOOK.
 *
 * The Pons venues are the only ones in this wall whose COUNTERPARTY is a
 * caller-supplied address that no policy can pin — the launchpad mints ~475 new
 * curve addresses an hour, so there is no set to enumerate — and both
 * `PonsSelfTrade.tradeExactIn` and `PonsClassVault.buy` hand that address a live
 * ERC-20 allowance over the pulled input before calling it.
 *
 * `allowedSpenders` warns twice that an approved spender is "a standing licence
 * to move every share the agent holds", and exempts the adapters because
 * everything they pull they hand straight back. That holds for V4SelfSwap, which
 * pins its PoolManager as an immutable. It does not hold for a Pons curve, and
 * the stock approvals carry no amount condition — so before this scoping, a
 * compromised session key could approve the adapter for an unbounded amount of
 * any tradeable stock, call `tradeExactIn` naming a contract it controlled, and
 * satisfy the output check by returning one wei.
 *
 * Narrowing the CALL is what closes it, not capping the approve: an allowance
 * the wall's call permissions can never spend is inert. These tests pin the
 * narrowing, because every one of them passed before it existed.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CASH,
  STOCK_TOKENS,
  TRADEABLE_SYMBOLS,
  buildCallPermissions,
  type GrantCaps,
} from "../../packages/core/src/index";

const ACCOUNT = "0x1111111111111111111111111111111111111111" as const;
const PONS = "0x2222222222222222222222222222222222222222" as const;
const VAULT = "0x3333333333333333333333333333333333333333" as const;
const FACTORY = "0x4444444444444444444444444444444444444444" as const;
const V4 = "0x5555555555555555555555555555555555555555" as const;
const MYCOIN = "0x6666666666666666666666666666666666666666" as const;

const CAPS: GrantCaps = {
  perTradeUsdg: 25,
  dailyUsdg: 100,
  expiryDays: 14,
  maxDrawdownPct: 20,
  maxOpsPerDay: 20,
};

const USDG = (CASH.USDG as string).toLowerCase();
const TRADEABLE_ADDRESSES = STOCK_TOKENS.filter((t) =>
  (TRADEABLE_SYMBOLS as readonly string[]).includes(t.symbol),
).map((t) => t.address.toLowerCase());

function permissions() {
  return buildCallPermissions(CAPS, ACCOUNT, {
    extraTokens: [{ symbol: "MYCOIN", address: MYCOIN, decimals: 18 }],
    allowUniswapV4: true,
    v4AdapterAddress: V4,
    ponsAdapterAddress: PONS,
    ponsClassVaultAddress: VAULT,
    ponsClassVaultFactoryAddress: FACTORY,
  });
}

/** The ONE_OF values of an argument, lowercased, or null when unpinned. */
function oneOf(arg: unknown): string[] | null {
  if (!arg || typeof arg !== "object") return null;
  const v = (arg as { value?: unknown }).value;
  if (!Array.isArray(v)) return null;
  return v.map((a) => String(a).toLowerCase());
}

function permissionFor(target: string, fn: string) {
  const found = permissions().find(
    (p) =>
      String((p as { target?: unknown }).target).toLowerCase() === target.toLowerCase() &&
      (p as { functionName?: unknown }).functionName === fn,
  );
  assert.ok(found, `no ${fn} permission on ${target}`);
  return found as unknown as { args: unknown[] };
}

describe("the Pons adapter cannot be handed a stock token", () => {
  it("pins assetIn and assetOut to cash and owner coins only", () => {
    const { args } = permissionFor(PONS, "tradeExactIn");
    for (const [i, leg] of [
      [1, "assetIn"],
      [2, "assetOut"],
    ] as const) {
      const allowed = oneOf(args[i]);
      assert.ok(allowed, `${leg} must be pinned, not null`);
      assert.ok(allowed.includes(USDG), `${leg} must still allow USDG`);
      assert.ok(allowed.includes(MYCOIN.toLowerCase()), `${leg} must still allow an owner-added coin`);
      for (const stock of TRADEABLE_ADDRESSES) {
        assert.ok(
          !allowed.includes(stock),
          `${leg} must NOT allow ${stock} — a curve gets a live allowance over whatever is pulled`,
        );
      }
    }
  });

  it("leaves the curve itself unpinned, which is why the assets must be narrow", () => {
    // Stated so the pairing cannot be broken by "fixing" the wrong half: the
    // curve CANNOT be pinned, so the asset list is the only control there is.
    const { args } = permissionFor(PONS, "tradeExactIn");
    assert.equal(args[0], null, "the curve is unpinnable by design");
  });
});

describe("the class vault can only ever be funded with USDG", () => {
  it("pins the funding leg to exactly USDG", () => {
    // `buy` pulls this asset FROM THE ACCOUNT and then approves the
    // caller-supplied curve for it, so the funding list is exactly the list of
    // things a hostile curve can be handed. One capped asset bounds it.
    const allowed = oneOf(permissionFor(VAULT, "buy").args[1]);
    assert.deepEqual(allowed, [USDG], "the class funding leg must be USDG and nothing else");
  });

  it("and no stock token appears anywhere in the class buy arguments", () => {
    const { args } = permissionFor(VAULT, "buy");
    const flat = JSON.stringify(args).toLowerCase();
    for (const stock of TRADEABLE_ADDRESSES) {
      assert.ok(!flat.includes(stock), `${stock} must not be reachable through the class vault`);
    }
  });

  it("still lets the vault SELL, which needs no account approve at all", () => {
    // The exit must stay reachable — that is the reason the vault exists. Its
    // tokens are already in the vault, so no asset argument is needed and none
    // is pinned; what bounds it is that the vault can only sell what it holds.
    const { args } = permissionFor(VAULT, "sell");
    assert.equal(args.length, 4, "sell takes curve, tokensIn, minQuoteOut, deadline");
  });
});

describe("the v4 adapter is deliberately NOT narrowed", () => {
  it("keeps the full asset list, because its counterparty is pinned", () => {
    // The asymmetry is the point. V4SelfSwap pins its PoolManager as an
    // immutable — there is exactly one singleton to trust — so everything it
    // pulls settles into that pool and comes back to msg.sender. A Pons curve
    // has no singleton. Narrowing v4 too would cost the equity book its main
    // venue for no security gain, so this pins the difference on purpose.
    const allowed = oneOf(permissionFor(V4, "swapExactIn").args[0]) ?? oneOf(permissionFor(V4, "swapExactIn").args[1]);
    assert.ok(allowed, "the v4 adapter must still pin its assets to a list");
    assert.ok(
      TRADEABLE_ADDRESSES.some((s) => allowed.includes(s)),
      "v4 must still reach the equity book",
    );
  });
});

describe("the narrowing does not break what the worker actually builds", () => {
  it("a USDG-funded curve buy and its USDG-returning sell are both expressible", () => {
    const { args } = permissionFor(PONS, "tradeExactIn");
    const inLeg = oneOf(args[1])!;
    const outLeg = oneOf(args[2])!;
    // buy: USDG -> coin. sell: coin -> USDG. Both legs of both directions.
    assert.ok(inLeg.includes(USDG) && outLeg.includes(MYCOIN.toLowerCase()), "a buy is expressible");
    assert.ok(inLeg.includes(MYCOIN.toLowerCase()) && outLeg.includes(USDG), "a sell is expressible");
  });
});
