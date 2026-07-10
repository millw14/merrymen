/**
 * merrymen worker — the 24/7 loop.
 *
 * tick: refresh settings → sync grant → snapshot → strategy intents → policy
 * check → simulate → execute via session key → record
 *
 * TWO files are re-read every tick, so the web UI drives the worker with no
 * restarts:
 *   .data/grant.json     — sign a grant and the worker arms next tick; kill
 *                          switch deletes it and trading halts next tick
 *   .data/settings.json  — API keys, bundler URL, strategy and every trading
 *                          knob (see /settings in the web app). Connection
 *                          changes re-arm the executor; strategy changes
 *                          rebuild the strategy in place. Env vars remain the
 *                          fallback; precedence is file > env > default.
 *
 * Persistence: SQLite at .data/merrymen.db (node:sqlite) — no service, no keys.
 *
 * `--selftest` sends one policy-legal no-op UserOp (approve 0.000001 USDG)
 * through the FULL pipeline to prove grant → policy → bundler → on-chain
 * policy enforcement, end to end.
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
  UNISWAP,
  USDG_DECIMALS,
  robinhoodChain,
  robinhoodTestnet,
  type StockToken,
  type StoredGrant,
} from "@merrymen/core";
import { fetchRialtoQuote, resolveRialtoRouter } from "./venues/rialto";
import { bestQuote, buildSwapCall, minOutWithSlippage } from "./venues/uniswap";
import { createAgentExecutor, type AgentExecutor } from "./executor";
import { accrueAboveHwm } from "./fees";
import { loadGrantFile } from "./grant";
import { checkPolicy, type AgentLimits, type AgentState, type TradeIntent } from "./policy";
import {
  connectionKey,
  resolveConfig,
  strategyKey,
  type ResolvedConfig,
} from "./settings";
import { buildStrategy, tokensForSymbols } from "./strategies/registry";
import type { Holding, Snapshot, Strategy } from "./strategies/types";
import { readPositions } from "./positions";
import { readAccountBalances, readMarketSafety, setMainnetRpc } from "./snapshot";
import {
  addEquity,
  addEvent,
  addFeeAccrual,
  addTrade,
  ensureAgent,
  getAgentFinancials,
  getOpsToday,
  getSpentTodayUsdg,
  initStore,
  setAgentHwm,
  setAgentStatus,
  setPositions,
  type TradeRow,
} from "./store";

const BREAKER_ABI = parseAbi(["function isTripped(address account) view returns (bool)"]);
const VAULT_ABI = parseAbi([
  "function deposit(uint256 assets, address receiver) returns (uint256)",
  "function withdraw(uint256 assets, address receiver, address owner) returns (uint256)",
]);

const usdg = (v: number) => BigInt(Math.round(v * 10 ** USDG_DECIMALS));
const usdgNum = (v: bigint) => Number(formatUnits(v, USDG_DECIMALS));
const fmt = (v: bigint) => formatUnits(v, USDG_DECIMALS);

function swapRouterFor(cfg: ResolvedConfig): `0x${string}` {
  return (cfg.swapVenue === "uniswap" ? UNISWAP.swapRouter02 : RIALTO.routerSnapshot) as `0x${string}`;
}

function limitsFromGrant(grant: StoredGrant, watchTokens: readonly StockToken[]): AgentLimits {
  return {
    perTradeUsdg: usdg(grant.caps.perTradeUsdg),
    dailyUsdg: usdg(grant.caps.dailyUsdg),
    allowedTargets: [
      RIALTO.routerSnapshot as `0x${string}`,
      UNISWAP.swapRouter02 as `0x${string}`,
      MORPHO.steakhouseUsdgVault as `0x${string}`,
      CASH.USDG as `0x${string}`,
    ],
    allowedAssets: [CASH.USDG as `0x${string}`, ...watchTokens.map((t) => t.address)],
    maxDrawdownBps: grant.caps.maxDrawdownPct * 100,
    expiresAt: grant.expiresAt,
    maxOpsPerDay: grant.caps.maxOpsPerDay,
  };
}

/** A policy-legal no-op: approve a dust allowance to the allowlisted router. */
function selfTestIntent(): TradeIntent {
  return {
    kind: "swap",
    target: CASH.USDG as `0x${string}`,
    sellToken: CASH.USDG as `0x${string}`,
    buyToken: CASH.USDG as `0x${string}`,
    sellAmountRaw: 1n, // 0.000001 USDG
    notionalUsdg: 1n,
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
  const selftest = process.argv.includes("--selftest");

  let active: ActiveAgent | null = null;

  /** Rebindable sink so the strategist can log into the armed agent's event feed. */
  const strategyNote = (level: "ok" | "warn", message: string) => {
    console.log(`[strategist:${level}] ${message}`);
    if (active) void addEvent(active.agentId, level, message);
  };

  let cfg = resolveConfig();
  setMainnetRpc(cfg.rpcMainnet);
  let connKey = connectionKey(cfg);
  let stratKey = strategyKey(cfg);
  let watchTokens = tokensForSymbols(cfg.basketSymbols);

  function makeStrategy(c: ResolvedConfig): Strategy {
    return buildStrategy(c.strategy, {
      swapRouter: swapRouterFor(c),
      usdg6: usdg,
      basketSymbols: c.basketSymbols,
      buyPerTickUsdg: c.buyPerTickUsdg,
      idleFloorUsdg: c.idleFloorUsdg,
      gapEnterBudgetUsdg: c.gapEnterBudgetUsdg,
      llm: {
        apiKey: c.anthropicApiKey,
        model: c.llmModel,
        intervalMin: c.llmIntervalMin,
        maxActionUsdg: c.llmMaxActionUsdg,
      },
      onNote: strategyNote,
    });
  }
  let strategy = makeStrategy(cfg);

  /** Re-read settings.json; apply what changed without a restart. */
  async function refreshConfig(): Promise<void> {
    const next = resolveConfig();
    const nextConn = connectionKey(next);
    const nextStrat = strategyKey(next);

    if (nextConn !== connKey) {
      console.log("[settings] connection settings changed — re-arming");
      setMainnetRpc(next.rpcMainnet);
      if (active) {
        await addEvent(active.agentId, "ok", "connection settings changed — re-arming executor");
        active = null; // syncGrant re-arms with the new bundler/RPC this tick
      }
      connKey = nextConn;
    }
    if (nextStrat !== stratKey) {
      cfg = next; // makeStrategy reads the new values
      strategy = makeStrategy(next);
      watchTokens = tokensForSymbols(next.basketSymbols);
      console.log(`[settings] strategy settings applied — ${strategy.name}, venue ${next.swapVenue}`);
      if (active) {
        active.limits = limitsFromGrant(active.grant, watchTokens);
        await addEvent(active.agentId, "ok", `settings applied — strategy ${strategy.name}, venue ${next.swapVenue}`);
      }
      stratKey = nextStrat;
    }
    cfg = next;
  }

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
    const rpc = chain.id === robinhoodTestnet.id ? cfg.rpcTestnet : cfg.rpcMainnet;
    const agentId = await ensureAgent(grant);

    let executor: AgentExecutor | null = null;
    if (cfg.bundlerUrl) {
      executor = await createAgentExecutor({
        chain,
        serializedGrant: grant.serialized,
        bundlerUrl: cfg.bundlerUrl,
      });
      console.log(`[worker] executor live — smart account ${executor.address} on chain ${chain.id}`);
    } else {
      console.log("[worker] no bundler URL (settings or env) — execution stubbed (policy/simulation still run)");
    }

    active = {
      grant,
      agentId,
      client: createPublicClient({ chain, transport: http(rpc) }),
      executor,
      limits: limitsFromGrant(grant, watchTokens),
    };
    spentTodayUsdg = usdg(await getSpentTodayUsdg(agentId));
    opsToday = await getOpsToday(agentId);
    // HWM is persistent — a restart must not forget the peak, or the breaker
    // re-arms low and the fee ledger double-charges old profit.
    highWaterMarkUsdg = usdg((await getAgentFinancials(agentId)).hwmUsdg);
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
    const notional = intent.kind === "swap" ? intent.notionalUsdg : intent.amountUsdg;

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
      if (intent.kind === "swap" && cfg.swapVenue === "uniswap" && intent.sellToken !== intent.buyToken) {
        // Full leg: QuoterV2 simulation (reverts where the swap would) →
        // slippage-bounded minOut → approve + exactInputSingle in one UserOp.
        const quote = await bestQuote(active.client, {
          tokenIn: intent.sellToken,
          tokenOut: intent.buyToken,
          amountIn: intent.sellAmountRaw,
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
        const minOut = minOutWithSlippage(quote.amountOut, cfg.slippageBps);
        sim = {
          sim_quote_out: quote.amountOut.toString(),
          sim_min_out: minOut.toString(),
          sim_fee_tier: quote.fee,
          sim_gas: quote.gasEstimate.toString(),
        };
        // Approve exactly what's sold — USDG on buys, the stock token on sells.
        const approve = {
          to: intent.sellToken,
          value: 0n,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "approve",
            args: [UNISWAP.swapRouter02 as `0x${string}`, intent.sellAmountRaw],
          }),
        };
        const swap = buildSwapCall({
          tokenIn: intent.sellToken,
          tokenOut: intent.buyToken,
          fee: quote.fee,
          recipient: executor.address,
          amountIn: intent.sellAmountRaw,
          minAmountOut: minOut,
        });
        txHash = await executor.execute([approve, swap]);
        await addEvent(
          agentId,
          "ok",
          `simulated ✓ quote ${quote.amountOut} min ${minOut} @ fee ${quote.fee / 10_000}% · gas ~${quote.gasEstimate}`,
        );
      } else if (intent.kind === "swap" && cfg.rialtoApiKey && intent.sellToken !== intent.buyToken) {
        // Rialto full leg: registry-resolved router only, API-supplied calldata
        // validated against it. A migrated router (≠ grant-time snapshot) means
        // the on-chain call policy would reject anyway — skip with the reason.
        const router = await resolveRialtoRouter(active.client);
        if (router.toLowerCase() !== (RIALTO.routerSnapshot as string).toLowerCase()) {
          await addEvent(
            agentId,
            "warn",
            `Rialto router migrated to ${router} — re-issue the grant to trade; swap skipped`,
          );
          return;
        }
        const { quote, reason } = await fetchRialtoQuote(
          { apiKey: cfg.rialtoApiKey, headerName: cfg.rialtoApiKeyHeader },
          {
            sellToken: intent.sellToken,
            buyToken: intent.buyToken,
            sellAmountRaw: intent.sellAmountRaw,
            taker: executor.address,
            expectedRouter: router,
          },
        );
        if (!quote) {
          console.log(`[rialto] no executable quote: ${reason}`);
          await addEvent(agentId, "warn", `Rialto quote refused: ${reason} — swap skipped`);
          await addTrade({
            agent_id: agentId,
            kind: intent.kind,
            target: intent.target,
            sell_token: intent.sellToken,
            buy_token: intent.buyToken,
            amount_usdg: usdgNum(notional),
            status: "rejected",
            reject_rule: "no-quote",
            created_at: new Date().toISOString(),
          });
          return;
        }
        sim = { sim_quote_out: quote.buyAmountRaw?.toString() };
        const approve = {
          to: intent.sellToken,
          value: 0n,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "approve",
            args: [router, intent.sellAmountRaw],
          }),
        };
        txHash = await executor.execute([approve, { to: quote.to, value: 0n, data: quote.data }]);
      } else if (intent.kind === "swap") {
        // Rialto venue without an API key: approval leg only until onboarding;
        // swap calldata comes from that API. Bundler estimation still simulates.
        const data = encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [RIALTO.routerSnapshot as `0x${string}`, intent.sellAmountRaw],
        });
        txHash = await executor.execute([{ to: intent.sellToken, value: 0n, data }]);
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
    await refreshConfig();
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
      readPositions(client, grant.smartAccount, watchTokens, market.prices),
    ]);
    const positionsUsdg = positions.reduce((sum, p) => sum + p.valueUsdg, 0n);
    // Equity is the whole book — cash, vault, and multiplier-aware stock value —
    // so the drawdown breaker judges reality, not just the cash ledger.
    const equityUsdg = balances.cashUsdg + balances.vaultUsdg + positionsUsdg;

    const accrual = accrueAboveHwm(equityUsdg, highWaterMarkUsdg, cfg.perfFeeBps);
    if (accrual.profitUsdg > 0n) {
      await addFeeAccrual(agentId, {
        profitUsdg: usdgNum(accrual.profitUsdg),
        feeUsdg: usdgNum(accrual.feeUsdg),
        hwmBeforeUsdg: usdgNum(highWaterMarkUsdg),
        hwmAfterUsdg: usdgNum(accrual.newHwmUsdg),
      });
      await setAgentHwm(agentId, usdgNum(accrual.newHwmUsdg));
      if (accrual.feeUsdg > 0n) {
        await addEvent(
          agentId,
          "ok",
          `new high-water mark ${fmt(accrual.newHwmUsdg)} USDG — fee accrued ${fmt(accrual.feeUsdg)} (${cfg.perfFeeBps / 100}% of ${fmt(accrual.profitUsdg)} profit)`,
        );
      }
    }
    highWaterMarkUsdg = accrual.newHwmUsdg;
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

    // On-chain breaker check — the contract is the authority once deployed;
    // this read stops the worker from wasting ops the chain would refuse.
    if (cfg.breakerAddress) {
      const tripped = await client
        .readContract({
          address: cfg.breakerAddress,
          abi: BREAKER_ABI,
          functionName: "isTripped",
          args: [grant.smartAccount],
        })
        .catch(() => false);
      if (tripped) {
        console.log("[breaker] ON-CHAIN BREAKER TRIPPED — no intents this tick");
        await addEvent(agentId, "err", "on-chain drawdown breaker TRIPPED — trading halted at the wall");
        return;
      }
    }

    const holdings = new Map<string, Holding>(
      positions.map((p) => [
        p.symbol,
        {
          token: p.token,
          rawBalance: p.rawBalance,
          valueUsdg: p.valueUsdg,
          priceStale: p.priceStale,
        },
      ]),
    );
    const snap: Snapshot = {
      cashUsdg: balances.cashUsdg,
      vaultUsdg: balances.vaultUsdg,
      holdings,
      prices: market.prices,
      pausedTokens: market.pausedTokens,
      staleFeeds: market.staleFeeds,
      sequencerUp: market.sequencerUp,
    };

    for (const intent of await strategy.tick(snap)) {
      await processIntent(intent, equityUsdg);
    }
  }

  if (selftest) {
    const armed = await syncGrant();
    if (!armed || !active || !(active as ActiveAgent).executor) {
      console.error("[selftest] needs a grant AND a bundler URL (settings or MERRYMEN_BUNDLER_URL)");
      process.exit(1);
    }
    console.log("[selftest] sending policy-legal no-op through the full pipeline…");
    await processIntent(selfTestIntent(), 0n);
    console.log("[selftest] done");
    process.exit(0);
  }

  console.log(
    `merrymen worker starting — strategy ${strategy.name}, venue ${cfg.swapVenue}, ` +
      `tick ${cfg.tickSeconds}s, settings+grant re-synced every tick`,
  );
  const runLoop = () => {
    tick()
      .catch((e) => console.error("[tick]", e))
      .finally(() => setTimeout(runLoop, cfg.tickSeconds * 1000));
  };
  runLoop();
}

main().catch((e) => {
  console.error("[worker] fatal:", e);
  process.exit(1);
});
