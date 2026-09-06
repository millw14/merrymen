/**
 * Quote a manual ETH→USDG swap for the /swap page: balances, the gas reserve
 * the worker would keep, the convertible surplus, and an execution quote for
 * the requested amount — all read-only, nothing submitted.
 *
 * TWAP-ONLY, deliberately. The quote comes from readPoolPrice (the same
 * time-averaged number that values the book) gated by poolPriceUsable (depth
 * floor + divergence band). A pool with no TWAP history simply has no quote —
 * fresh pools wait for history rather than executing off a manipulable spot.
 *
 * THE NUMBERS MUST MATCH THE WORKER. The reserve comes from convertReserve
 * (the same function the tick will use), the slippage from the owner's
 * settings. If this route and the tick ever disagree, the tick wins at submit
 * time and caps to the real surplus — the preview is honest effort, the chain
 * is the authority.
 */
import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { createPublicClient, erc20Abi, http } from "viem";
import {
  CASH,
  USDG_DECIMALS,
  chainForId,
  grantHasNativeSwap,
  isHostedMode,
  type MerrymenSettings,
} from "@merrymen/core";
import { homePaths } from "@merrymen/home";
import { getGrantStore } from "@merrymen/grant-store";
import { getSettingsStore } from "@merrymen/settings-store";
import { mergeSettings } from "@merrymen/settings";
import { cashRawToUsdg, poolPriceUsable, readPoolPrice } from "@merrymen/pool-price";
import { convertReserve } from "@merrymen/convert-reserve";
import { tenantOf } from "@/lib/auth";

export const dynamic = "force-dynamic";

async function readGrant(req: Request) {
  if (isHostedMode()) {
    const tenant = tenantOf(req);
    if (!tenant) return null;
    return await getGrantStore().get(tenant);
  }
  try {
    return JSON.parse(await readFile(homePaths.grant(), "utf8")) as {
      smartAccount?: string;
      chainId?: number;
      grantFeatures?: string[];
    };
  } catch {
    return null;
  }
}

async function readSettings(tenant: `0x${string}` | null): Promise<MerrymenSettings> {
  if (tenant) return (await getSettingsStore().get(tenant)) ?? {};
  try {
    return JSON.parse(await readFile(homePaths.settings(), "utf8")) as MerrymenSettings;
  } catch {
    return {};
  }
}

export async function GET(req: Request) {
  const grant = await readGrant(req);
  const smartAccount = grant?.smartAccount as `0x${string}` | undefined;
  const chainId = grant?.chainId;
  if (!smartAccount || !chainId) {
    return NextResponse.json({ ok: false, reason: "no-grant" }, { status: 200 });
  }
  if (chainId !== 4663) {
    return NextResponse.json({ ok: false, reason: "wrong-chain", chainId }, { status: 200 });
  }

  const tenant = isHostedMode() ? tenantOf(req) : null;
  const cfg = mergeSettings(await readSettings(tenant), process.env);
  const chain = chainForId(chainId);
  const client = createPublicClient({
    chain,
    transport: http(cfg.rpcMainnet || undefined),
  });

  const url = new URL(req.url);
  const requestedWei = /^\d{1,30}$/.test(url.searchParams.get("wei") ?? "")
    ? BigInt(url.searchParams.get("wei") as string)
    : 0n;

  const [ethWei, usdgRaw, gasPrice, code] = await Promise.all([
    client.getBalance({ address: smartAccount }).catch(() => null),
    client
      .readContract({
        address: CASH.USDG as `0x${string}`,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [smartAccount],
      })
      .catch(() => null) as Promise<bigint | null>,
    client.getGasPrice().catch(() => null),
    client.getCode({ address: smartAccount }).catch(() => null),
  ]);
  // A read that fails is unknown, never zero: rendering a zero balance or a
  // zero gas price would silently erase the reserve it protects.
  if (ethWei === null || usdgRaw === null || gasPrice === null || code === null) {
    return NextResponse.json({ ok: false, reason: "rpc-unreadable" }, { status: 200 });
  }
  const deployed = code !== "0x";
  const sponsored = cfg.sponsorGasEnabled && !!cfg.bundlerApiKey;
  const { reserve, surplus } = convertReserve(
    ethWei,
    gasPrice,
    deployed,
    cfg.autoConvertReservePct,
    sponsored,
  );
  const amount = requestedWei < surplus ? requestedWei : surplus;

  let quote: {
    expectedOut: string;
    minOut: string;
    fee: number;
    source: "twap";
    divergenceBps: number;
  } | null = null;
  let quoteReason: string | null = null;
  if (amount > 0n) {
    const price = await readPoolPrice(client, {
      token: CASH.WETH as `0x${string}`,
      tokenDecimals: 18,
      cash: CASH.USDG as `0x${string}`,
      cashDecimals: USDG_DECIMALS,
    });
    if (!price) {
      quoteReason = "no-pool";
    } else {
      // Single-pool depth in USDG, the same conversion readRoutedPrice uses
      // (the cash leg here IS USDG ≈ $1 = 1e8).
      const usable = poolPriceUsable(
        {
          price8: price.price8,
          liquidityUsdg: cashRawToUsdg(price.liquidityCashRaw, price.cashDecimals, 100_000_000n),
          twapWindowSec: price.twapWindowSec,
          divergenceBps: price.divergenceBps,
        },
        {
          minLiquidityUsdg: BigInt(Math.round(cfg.minPoolLiquidityUsdg * 1_000_000)),
          maxDivergenceBps: cfg.maxPriceDivergenceBps,
        },
      );
      if (!usable.ok) {
        quoteReason = usable.kind;
      } else {
        const expect6 = (price.price8 * amount) / 1_000_000_000_000_000_000_00n; // ÷1e20
        // Same formula as the worker's minOutWithSlippage.
        const minOut = (expect6 * BigInt(10_000 - cfg.slippageBps)) / 10_000n;
        if (expect6 > 0n && minOut > 0n) {
          quote = {
            expectedOut: expect6.toString(),
            minOut: minOut.toString(),
            fee: price.fee,
            source: "twap",
            divergenceBps: price.divergenceBps,
          };
        } else {
          quoteReason = "dust";
        }
      }
    }
  }

  return NextResponse.json({
    ok: true,
    smartAccount,
    deployed,
    grantReady: grantHasNativeSwap(grant),
    ethWei: ethWei.toString(),
    usdgRaw: usdgRaw.toString(),
    reserveWei: reserve.toString(),
    surplusWei: surplus.toString(),
    requestedWei: requestedWei.toString(),
    amountWei: amount.toString(),
    capped: requestedWei > surplus,
    quote,
    quoteReason,
    slippageBps: cfg.slippageBps,
    autoConvertEnabled: cfg.autoConvertEnabled,
  });
}
