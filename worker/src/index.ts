/**
 * merrymen worker — the 24/7 loop.
 *
 * tick: sync grant → snapshot → strategy intents → policy check → simulate
 * (bundler gas estimation rejects reverting ops) → execute via session key → record
 *
 * The grant file is re-read EVERY tick: sign a grant in the web app and the
 * worker arms itself on the next tick; hit the kill switch (grant file deleted)
 * and trading halts on the next tick — no restarts. Hard expiry on-chain is the
 * backstop if this process dies with the file intact.
 *
 * Config:
 *   MERRYMEN_GRANT_FILE       grant JSON (default ../.data/grant.json via web /grant)
 *   MERRYMEN_BUNDLER_URL      4337 bundler RPC; without it, execution stays stubbed
 * Persistence: SQLite at .data/merrymen.db (node:sqlite) — no service, no keys.
 *
 * `--selftest` sends one policy-legal no-op UserOp (approve 0.000001 USDG to the
 * Rialto router) through the FULL pipeline to prove grant → policy → bundler →
 * on-chain policy enforcement, end to end.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  http,
  parseAbi,
  type PublicClient,
} from "viem";
import {
  CASH,
  MORPHO,
  RIALTO,
  STOCK_TOKENS,
  UNISWAP,
  USDG_DECIMALS,
  robinhoodChain,
  robinhoodTestnet,
  type StoredGrant,
} from "@merrymen/core";
import { bestQuote, buildSwapCall, minOutWithSlippage } from "./venues/uniswap";
import { createAgentExecutor, type AgentExecutor } from "./executor";
import { loadGrantFile } from "./grant";
import { checkPolicy, type AgentLimits, type AgentState, type TradeIntent } from "./policy";
import { steadyBasketTick, type SteadyBasketConfig, type Snapshot } from "./strategies/steady-basket";
import { readPositions } from "./positions";
import { readAccountBalances, readMarketSafety } from "./snapshot";
import {
  addEquity,
  addEvent,
  addTrade,
  ensureAgent,
  getOpsToday,
  getSpentTodayUsdg,
  initStore,
  setAgentStatus,
  setPositions,
  type TradeRow,
} from "./store";

const TICK_MS = 60_000;

/**
 * Swap venue: "uniswap" executes the full quote→swap leg permissionlessly;
 * "rialto" stays approval-only until their /quote API onboarding completes.
 */
const SWAP_VENUE = (process.env.MERRYMEN_SWAP_VENUE ?? "uniswap") as "uniswap" | "rialto";
const SLIPPAGE_BPS = Number(process.env.MERRYMEN_SLIPPAGE_BPS ?? 100);
const SWAP_ROUTER = (SWAP_VENUE === "uniswap" ? UNISWAP.swapRouter02 : RIALTO.routerSnapshot) as `0x${string}`;
const usdg = (v: number) => BigInt(Math.round(v * 10 ** USDG_DECIMALS));
const usdgNum = (v: bigint) => Number(formatUnits(v, USDG_DECIMALS));
const fmt = (v: bigint) => formatUnits(v, USDG_DECIMALS);

const VAULT_ABI = parseAbi([
  "function deposit(uint256 assets, address receiver) returns (uint256)",
  "function withdraw(uint256 assets, address receiver, address owner) returns (uint256)",
]);

function limitsFromGrant(grant: StoredGrant): AgentLimits {
  return {
    perTradeUsdg: usdg(grant.caps.perTradeUsdg),
    dailyUsdg: usdg(grant.caps.dailyUsdg),
    allowedTargets: [
      RIALTO.routerSnapshot as `0x${string}`,
      UNISWAP.swapRouter02 as `0x${string}`,
      MORPHO.steakhouseUsdgVault as `0x${string}`,
      CASH.USDG as `0x${string}`,
    ],
    allowedAssets: [
      CASH.USDG as `0x${string}`,
      ...STOCK_TOKENS.filter((t) => ["AAPL", "MSFT", "QQQ"].includes(t.symbol)).map((t) => t.address),
    ],
    maxDrawdownBps: grant.caps.maxDrawdownPct * 100,
    expiresAt: grant.expiresAt,
    maxOpsPerDay: grant.caps.maxOpsPerDay,
  };
}

const BASKET_SYMBOLS = ["AAPL", "MSFT", "QQQ"] as const;
const BASKET_TOKENS = STOCK_TOKENS.filter((t) =>
  (BASKET_SYMBOLS as readonly string[]).includes(t.symbol),
);

const basket: SteadyBasketConfig = {
  legs: STOCK_TOKENS.filter((t) => ["AAPL", "MSFT", "QQQ"].includes(t.symbol)).map((t, _, arr) => ({
    symbol: t.symbol,
    token: t.address,
    weightBps: Math.floor(10_000 / arr.length),
  })),
  buyPerTickUsdg: usdg(25),
  idleFloorUsdg: usdg(50),
  swapRouter: SWAP_ROUTER,
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

/** Everything tied to the currently armed grant — dies with the kill switch. */
interface ActiveAgent {
  grant: StoredGrant;
  agentId: string;
  client: PublicClient;
  executor: AgentExecutor | null;
  limits: AgentLimits;
}

async function main() {
  initStore();
  const bundlerUrl = process.env.MERRYMEN_BUNDLER_URL;
  const selftest = process.argv.includes("--selftest");

  let active: ActiveAgent | null = null;
  let spentTodayUsdg = 0n;
  let opsToday = 0;
  let highWaterMarkUsdg = 0n;
  let lastSequencerUp = true;

  /**
   * Reconcile in-memory state with the grant file. Returns true if an agent is
   * armed after the sync. Kill switch = grant file deleted by web's DELETE.
   */
  async function syncGrant(): Promise<boolean> {
    const grant = loadGrantFile();

    if (!grant) {
      if (active) {
        console.log("[kill] grant gone — session key destroyed client-side, trading halted");
        await setAgentStatus(active.agentId, "killed");
        await addEvent(
          active.agentId,
          "warn",
          "KILL SWITCH — grant discarded, session key destroyed; trading halted",
        );
        active = null;
      }
      return false;
    }

    const unchanged =
      active &&
      active.grant.smartAccount === grant.smartAccount &&
      active.grant.grantedAt === grant.grantedAt;
    if (unchanged) return true;

    const chain = grant.chainId === robinhoodTestnet.id ? robinhoodTestnet : robinhoodChain;
    const agentId = await ensureAgent(grant);

    let executor: AgentExecutor | null = null;
    if (bundlerUrl) {
      executor = await createAgentExecutor({
        chain,
        serializedGrant: grant.serialized,
        bundlerUrl,
      });
      console.log(`[worker] executor live — smart account ${executor.address} on chain ${chain.id}`);
    } else {
      console.log("[worker] no MERRYMEN_BUNDLER_URL — execution stubbed (policy/simulation still run)");
    }

    active = {
      grant,
      agentId,
      client: createPublicClient({ chain, transport: http() }),
      executor,
      limits: limitsFromGrant(grant),
    };
    spentTodayUsdg = usdg(await getSpentTodayUsdg(agentId));
    opsToday = await getOpsToday(agentId);
    highWaterMarkUsdg = 0n;
    await setAgentStatus(agentId, "armed");
    await addEvent(
      agentId,
      "ok",
      `grant armed — executor ${executor ? "live" : "stubbed"}, ` +
        `spent ${fmt(spentTodayUsdg)} USDG / ${opsToday} ops in trailing 24h`,
    );
    return true;
  }

  async function processIntent(intent: TradeIntent, equityUsdg: bigint): Promise<void> {
    if (!active) return;
    const { agentId, limits, executor } = active;
    const state: AgentState = {
      spentTodayUsdg,
      opsToday,
      highWaterMarkUsdg,
      equityUsdg,
      nowSec: Math.floor(Date.now() / 1000),
    };
    const verdict = checkPolicy(intent, limits, state);
    const notional = intent.kind === "swap" ? intent.sellAmountUsdg : intent.amountUsdg;

    if (!verdict.ok) {
      console.log(`[policy] REJECTED ${intent.kind}: ${verdict.rule} — ${verdict.detail}`);
      await addEvent(agentId, "warn", `policy rejected ${intent.kind}: ${verdict.rule} — ${verdict.detail}`);
      await addTrade({
        agent_id: agentId,
        kind: intent.kind,
        target: intent.target,
        amount_usdg: usdgNum(notional),
        status: "rejected",
        reject_rule: verdict.rule,
        created_at: new Date().toISOString(),
      });
      return;
    }
    if (!executor) {
      console.log(`[policy] approved ${intent.kind} — execution stubbed (no bundler)`);
      return;
    }

    try {
      let txHash: `0x${string}`;
      let sim: Pick<TradeRow, "sim_quote_out" | "sim_min_out" | "sim_fee_tier" | "sim_gas"> = {};
      // Same-token "swaps" (the selftest no-op) skip the quote path — they are
      // approval-leg pipeline probes, not trades.
      if (intent.kind === "swap" && SWAP_VENUE === "uniswap" && intent.sellToken !== intent.buyToken) {
        // Full leg: QuoterV2 simulation (reverts where the swap would) →
        // slippage-bounded minOut → approve + exactInputSingle in one UserOp.
        const quote = await bestQuote(active.client, {
          tokenIn: intent.sellToken,
          tokenOut: intent.buyToken,
          amountIn: intent.sellAmountUsdg,
        });
        if (!quote) {
          console.log(`[quote] no executable Uniswap route for ${intent.buyToken} — skipped`);
          await addEvent(agentId, "warn", `no Uniswap route for ${intent.buyToken} — swap skipped`);
          await addTrade({
            agent_id: agentId,
            kind: intent.kind,
            target: intent.target,
            sell_token: intent.sellToken,
            buy_token: intent.buyToken,
            amount_usdg: usdgNum(notional),
            status: "rejected",
            reject_rule: "no-route",
            created_at: new Date().toISOString(),
          });
          return;
        }
        const minOut = minOutWithSlippage(quote.amountOut, SLIPPAGE_BPS);
        sim = {
          sim_quote_out: quote.amountOut.toString(),
          sim_min_out: minOut.toString(),
          sim_fee_tier: quote.fee,
          sim_gas: quote.gasEstimate.toString(),
        };
        const approve = {
          to: CASH.USDG as `0x${string}`,
          value: 0n,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "approve",
            args: [UNISWAP.swapRouter02 as `0x${string}`, intent.sellAmountUsdg],
          }),
        };
        const swap = buildSwapCall({
          tokenIn: intent.sellToken,
          tokenOut: intent.buyToken,
          fee: quote.fee,
          recipient: executor.address,
          amountIn: intent.sellAmountUsdg,
          minAmountOut: minOut,
        });
        txHash = await executor.execute([approve, swap]);
        await addEvent(
          agentId,
          "ok",
          `simulated ✓ quote ${quote.amountOut} min ${minOut} @ fee ${quote.fee / 10_000}% · gas ~${quote.gasEstimate}`,
        );
      } else if (intent.kind === "swap") {
        // Rialto venue: approval leg only until their /quote API onboarding;
        // swap calldata comes from that API. Bundler estimation still simulates.
        const data = encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [RIALTO.routerSnapshot as `0x${string}`, intent.sellAmountUsdg],
        });
        txHash = await executor.execute([{ to: CASH.USDG as `0x${string}`, value: 0n, data }]);
      } else if (intent.kind === "vault-deposit") {
        const data = encodeFunctionData({
          abi: VAULT_ABI,
          functionName: "deposit",
          args: [intent.amountUsdg, executor.address],
        });
        txHash = await executor.execute([
          {
            to: CASH.USDG as `0x${string}`,
            value: 0n,
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: "approve",
              args: [MORPHO.steakhouseUsdgVault as `0x${string}`, intent.amountUsdg],
            }),
          },
          { to: MORPHO.steakhouseUsdgVault as `0x${string}`, value: 0n, data },
        ]);
      } else {
        const data = encodeFunctionData({
          abi: VAULT_ABI,
          functionName: "withdraw",
          args: [intent.amountUsdg, executor.address, executor.address],
        });
        txHash = await executor.execute([
          { to: MORPHO.steakhouseUsdgVault as `0x${string}`, value: 0n, data },
        ]);
      }

      if (intent.kind !== "vault-withdraw") spentTodayUsdg += notional;
      opsToday += 1;
      console.log(`[execute] ${intent.kind} landed: ${txHash}`);
      await addEvent(agentId, "ok", `${intent.kind} landed (${fmt(notional)} USDG): ${txHash}`);
      await addTrade({
        agent_id: agentId,
        kind: intent.kind,
        target: intent.target,
        sell_token: intent.kind === "swap" ? intent.sellToken : undefined,
        buy_token: intent.kind === "swap" ? intent.buyToken : undefined,
        amount_usdg: usdgNum(notional),
        tx_hash: txHash,
        status: "landed",
        created_at: new Date().toISOString(),
        ...sim,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[execute] ${intent.kind} failed:`, msg);
      await addEvent(agentId, "err", `${intent.kind} failed pre-flight or on-chain: ${msg.slice(0, 200)}`);
      await addTrade({
        agent_id: agentId,
        kind: intent.kind,
        target: intent.target,
        amount_usdg: usdgNum(notional),
        status: "reverted",
        created_at: new Date().toISOString(),
      });
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
    const armed = await syncGrant();

    const market = await readMarketSafety();
    heartbeat(market.blockNumber);
    console.log(
      `[tick] mainnet block ${market.blockNumber} · sequencer ${market.sequencerUp ? "up" : "DOWN"} · ` +
        `${market.pausedTokens.size} paused · ${market.staleFeeds.size} stale feeds`,
    );

    if (active && market.sequencerUp !== lastSequencerUp) {
      await addEvent(
        active.agentId,
        market.sequencerUp ? "ok" : "warn",
        market.sequencerUp ? "sequencer recovered — resuming" : "sequencer DOWN — all trading paused",
      );
    }
    lastSequencerUp = market.sequencerUp;

    if (!armed || !active) return;
    const { grant, agentId, client } = active;

    if (Math.floor(Date.now() / 1000) >= grant.expiresAt) {
      console.log("[expiry] session key expired — agent retired");
      await setAgentStatus(agentId, "expired");
      await addEvent(agentId, "warn", "session key expired — agent retired (grant a new key to redeploy)");
      active = null;
      return;
    }

    const [balances, positions] = await Promise.all([
      readAccountBalances(client, grant.smartAccount),
      readPositions(client, grant.smartAccount, BASKET_TOKENS, market.prices),
    ]);
    const positionsUsdg = positions.reduce((sum, p) => sum + p.valueUsdg, 0n);
    // Equity is the whole book — cash, vault, and multiplier-aware stock value —
    // so the drawdown breaker judges reality, not just the cash ledger.
    const equityUsdg = balances.cashUsdg + balances.vaultUsdg + positionsUsdg;
    highWaterMarkUsdg = equityUsdg > highWaterMarkUsdg ? equityUsdg : highWaterMarkUsdg;
    console.log(
      `[account] ${grant.smartAccount} · eth ${formatUnits(balances.ethWei, 18)} · ` +
        `cash ${fmt(balances.cashUsdg)} USDG · vault ${fmt(balances.vaultUsdg)} USDG · ` +
        `positions ${fmt(positionsUsdg)} USDG (${positions.map((p) => p.symbol).join(",") || "none"})`,
    );

    await addEquity(agentId, {
      ethWei: balances.ethWei,
      cashUsdg: usdgNum(balances.cashUsdg),
      vaultUsdg: usdgNum(balances.vaultUsdg),
      positionsUsdg: usdgNum(positionsUsdg),
    });
    await setPositions(
      agentId,
      positions.map((p) => ({
        symbol: p.symbol,
        token: p.token,
        rawBalance: p.rawBalance,
        uiMultiplier: p.uiMultiplier,
        priceUsd: Number(p.price8) / 1e8,
        priceStale: p.priceStale,
        valueUsdg: usdgNum(p.valueUsdg),
      })),
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
    const armed = await syncGrant();
    if (!armed || !active || !(active as ActiveAgent).executor) {
      console.error("[selftest] needs a grant AND MERRYMEN_BUNDLER_URL");
      process.exit(1);
    }
    console.log("[selftest] sending policy-legal no-op through the full pipeline…");
    await processIntent(selfTestIntent(), 0n);
    console.log("[selftest] done");
    process.exit(0);
  }

  console.log(`merrymen worker starting — safety reads from chain ${robinhoodChain.id}, grant re-synced every tick`);
  await tick();
  setInterval(() => tick().catch((e) => console.error("[tick]", e)), TICK_MS);
}

main().catch((e) => {
  console.error("[worker] fatal:", e);
  process.exit(1);
});
