/**
 * merrymen worker — the 24/7 loop.
 *
 * tick: snapshot → strategy intents → policy check → simulate (bundler gas
 * estimation rejects reverting ops) → execute via session key → record
 *
 * Config:
 *   MERRYMEN_GRANT_FILE    grant JSON (default ../.data/grant.json via web /grant)
 *   MERRYMEN_BUNDLER_URL   4337 bundler RPC; without it, execution stays stubbed
 *
 * `--selftest` sends one policy-legal no-op UserOp (approve 0.000001 USDG to the
 * Rialto router) through the FULL pipeline to prove grant → policy → bundler →
 * on-chain policy enforcement, end to end.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createPublicClient, encodeFunctionData, erc20Abi, formatUnits, http } from "viem";
import {
  CASH,
  MORPHO,
  RIALTO,
  STOCK_TOKENS,
  USDG_DECIMALS,
  robinhoodChain,
  robinhoodTestnet,
  type StoredGrant,
} from "@merrymen/core";
import { createAgentExecutor, type AgentExecutor } from "./executor";
import { loadGrantFile } from "./grant";
import { checkPolicy, type AgentLimits, type AgentState, type TradeIntent } from "./policy";
import { steadyBasketTick, type SteadyBasketConfig, type Snapshot } from "./strategies/steady-basket";
import { readAccountBalances, readMarketSafety } from "./snapshot";

const TICK_MS = 60_000;
const usdg = (v: number) => BigInt(Math.round(v * 10 ** USDG_DECIMALS));
const fmt = (v: bigint) => formatUnits(v, USDG_DECIMALS);

function limitsFromGrant(grant: StoredGrant): AgentLimits {
  return {
    perTradeUsdg: usdg(grant.caps.perTradeUsdg),
    dailyUsdg: usdg(grant.caps.dailyUsdg),
    allowedTargets: [
      RIALTO.routerSnapshot as `0x${string}`,
      MORPHO.steakhouseUsdgVault as `0x${string}`,
      CASH.USDG as `0x${string}`,
    ],
    allowedAssets: [
      CASH.USDG as `0x${string}`,
      ...STOCK_TOKENS.filter((t) => ["AAPL", "MSFT", "QQQ"].includes(t.symbol)).map((t) => t.address),
    ],
    maxDrawdownBps: grant.caps.maxDrawdownPct * 100,
    expiresAt: grant.expiresAt,
  };
}

const basket: SteadyBasketConfig = {
  legs: STOCK_TOKENS.filter((t) => ["AAPL", "MSFT", "QQQ"].includes(t.symbol)).map((t, _, arr) => ({
    symbol: t.symbol,
    token: t.address,
    weightBps: Math.floor(10_000 / arr.length),
  })),
  buyPerTickUsdg: usdg(25),
  idleFloorUsdg: usdg(50),
  rialtoRouter: RIALTO.routerSnapshot as `0x${string}`,
  vault: MORPHO.steakhouseUsdgVault as `0x${string}`,
  usdg: CASH.USDG as `0x${string}`,
};

/** A policy-legal no-op: approve a dust allowance to the allowlisted router. */
function selfTestIntent(): TradeIntent {
  return {
    kind: "swap",
    target: CASH.USDG as `0x${string}`,
    sellToken: CASH.USDG as `0x${string}`,
    buyToken: CASH.USDG as `0x${string}`,
    sellAmountUsdg: 1n, // 0.000001 USDG
  };
}

async function main() {
  const grant = loadGrantFile();
  const bundlerUrl = process.env.MERRYMEN_BUNDLER_URL;
  const selftest = process.argv.includes("--selftest");

  if (!grant) {
    console.log("[worker] no grant found — sign one at http://localhost:3100/grant");
  }

  const grantChain = grant?.chainId === robinhoodTestnet.id ? robinhoodTestnet : robinhoodChain;
  const grantClient = grant
    ? createPublicClient({ chain: grantChain, transport: http() })
    : null;

  let executor: AgentExecutor | null = null;
  if (grant && bundlerUrl) {
    executor = await createAgentExecutor({
      chain: grantChain,
      serializedGrant: grant.serialized,
      bundlerUrl,
    });
    console.log(`[worker] executor live — smart account ${executor.address} on chain ${grantChain.id}`);
  } else if (grant) {
    console.log("[worker] no MERRYMEN_BUNDLER_URL — execution stubbed (policy/simulation still run)");
  }

  const limits = grant ? limitsFromGrant(grant) : null;
  let spentTodayUsdg = 0n; // Supabase-persisted once persistence lands
  let highWaterMarkUsdg = 0n;

  async function processIntent(intent: TradeIntent, equityUsdg: bigint): Promise<void> {
    if (!limits) return;
    const state: AgentState = {
      spentTodayUsdg,
      highWaterMarkUsdg,
      equityUsdg,
      nowSec: Math.floor(Date.now() / 1000),
    };
    const verdict = checkPolicy(intent, limits, state);
    if (!verdict.ok) {
      console.log(`[policy] REJECTED ${intent.kind}: ${verdict.rule} — ${verdict.detail}`);
      return;
    }
    if (!executor) {
      console.log(`[policy] approved ${intent.kind} — execution stubbed (no bundler)`);
      return;
    }

    // The only call we can construct without the Rialto API key is the approval
    // leg; swap calldata comes from their quote API once onboarded.
    if (intent.kind === "swap") {
      const data = encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [RIALTO.routerSnapshot as `0x${string}`, intent.sellAmountUsdg],
      });
      // Bundler gas estimation simulates the op and rejects reverts — the
      // "simulate before sign" step until Tenderly lands.
      const txHash = await executor.execute([
        { to: CASH.USDG as `0x${string}`, value: 0n, data },
      ]);
      spentTodayUsdg += intent.sellAmountUsdg;
      console.log(`[execute] approval leg landed: ${txHash}`);
    } else {
      console.log(`[execute] ${intent.kind} pending vault calldata wiring`);
    }
  }

  const dataDir = path.join(process.cwd(), "..", ".data");
  function heartbeat(blockNumber: bigint) {
    try {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(
        path.join(dataDir, "heartbeat.json"),
        JSON.stringify({ at: Math.floor(Date.now() / 1000), block: blockNumber.toString() }),
        "utf8",
      );
    } catch {
      // heartbeat is best-effort telemetry — never let it kill the loop
    }
  }

  async function tick() {
    const market = await readMarketSafety();
    heartbeat(market.blockNumber);
    console.log(
      `[tick] mainnet block ${market.blockNumber} · sequencer ${market.sequencerUp ? "up" : "DOWN"} · ` +
        `${market.pausedTokens.size} paused · ${market.staleFeeds.size} stale feeds` +
        (market.staleFeeds.size ? ` (${[...market.staleFeeds].slice(0, 5).join(", ")}…)` : ""),
    );

    if (!grant || !grantClient) return;

    const balances = await readAccountBalances(grantClient, grant.smartAccount);
    const equityUsdg = balances.cashUsdg + balances.vaultUsdg;
    highWaterMarkUsdg = equityUsdg > highWaterMarkUsdg ? equityUsdg : highWaterMarkUsdg;
    console.log(
      `[account] ${grant.smartAccount} · eth ${formatUnits(balances.ethWei, 18)} · ` +
        `cash ${fmt(balances.cashUsdg)} USDG · vault ${fmt(balances.vaultUsdg)} USDG`,
    );

    const snap: Snapshot = {
      cashUsdg: balances.cashUsdg,
      vaultUsdg: balances.vaultUsdg,
      pausedTokens: market.pausedTokens,
      staleFeeds: market.staleFeeds,
      sequencerUp: market.sequencerUp,
    };

    for (const intent of steadyBasketTick(basket, snap)) {
      await processIntent(intent, equityUsdg);
    }
  }

  if (selftest) {
    if (!grant || !executor) {
      console.error("[selftest] needs a grant AND MERRYMEN_BUNDLER_URL");
      process.exit(1);
    }
    console.log("[selftest] sending policy-legal no-op through the full pipeline…");
    await processIntent(selfTestIntent(), 0n);
    console.log("[selftest] done");
    process.exit(0);
  }

  console.log(`merrymen worker starting — grant chain ${grantChain.id}, safety reads from ${robinhoodChain.id}`);
  await tick();
  setInterval(() => tick().catch((e) => console.error("[tick]", e)), TICK_MS);
}

main().catch((e) => {
  console.error("[worker] fatal:", e);
  process.exit(1);
});
