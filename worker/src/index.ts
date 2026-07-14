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

import { rmSync, writeFileSync } from "node:fs";
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
  chainForId,
  pimlicoBundlerUrl,
  robinhoodTestnet,
  type StockToken,
  type StoredGrant,
} from "../../packages/core/src/index";
import { fetchRialtoQuote, resolveRialtoRouter } from "./venues/rialto";
import { bestQuote, buildSwapCall, minOutWithSlippage } from "./venues/uniswap";
import { createAgentExecutor, type AgentExecutor } from "./executor";
import { accrueAboveHwm } from "./fees";
import { loadGrantFile } from "./grant";
import { ensureHome, homePaths } from "./home";
import { resolveLlm } from "./llm";
import { applyPaperIntent, type PaperPosition } from "./paper";
import { checkPolicy, type AgentLimits, type AgentState, type TradeIntent } from "./policy";
import {
  bundlerChainMismatch,
  connectionKey,
  resolveConfig,
  strategyKey,
  type ResolvedConfig,
} from "./settings";
import { BUILTIN_STRATEGIES, buildStrategy, tokensForSymbols } from "./strategies/registry";
import { customStrategiesDir, resolveStrategyFile } from "./strategies/custom";
import type { Holding, Snapshot, Strategy } from "./strategies/types";
import { isPaused, startTelegram } from "./telegram/service";
import { startNotifier } from "./telegram/notifier";
import { createStateRef } from "./telegram/state";
import { readPositionRaw } from "./telegram/reads";
import { ensureSoul, getName } from "./soul";
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
  getPaperBook,
  getSpentTodayUsdg,
  getTransferredTodayUsdg,
  initStore,
  setPaperBook,
  setAgentName,
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
  /** True only when breakerAddress has CODE on the grant chain — otherwise the
   * on-chain read would silently fail open (.catch → "not tripped"). */
  breakerLive: boolean;
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

  // ── paper trading plumbing ────────────────────────────────────────────
  // Paper mode = a grant but no signer: fills simulate at live oracle prices.
  let lastPrices: Map<string, { price8: bigint; stale: boolean }> = new Map();
  const paperActive = () => !!active && !active.executor && cfg.paperTradingEnabled;
  function paperPriceOf(token: `0x${string}`): { priceUsd: number; stale: boolean } | null {
    const t = watchTokens.find((w) => w.address.toLowerCase() === token.toLowerCase());
    const p = t ? lastPrices.get(t.symbol) : undefined;
    return p ? { priceUsd: Number(p.price8) / 1e8, stale: p.stale } : null;
  }
  const paperSymbolOf = (token: `0x${string}`) =>
    watchTokens.find((w) => w.address.toLowerCase() === token.toLowerCase())?.symbol ?? null;
  const paperPositionsOf = (shares: Record<string, { token: `0x${string}`; shares: number }>): PaperPosition[] =>
    Object.entries(shares).map(([symbol, v]) => ({ symbol, token: v.token, shares: v.shares }));

  function makeStrategy(c: ResolvedConfig): Strategy {
    return buildStrategy(c.strategy, {
      swapRouter: swapRouterFor(c),
      usdg6: usdg,
      basketSymbols: c.basketSymbols,
      buyPerTickUsdg: c.buyPerTickUsdg,
      idleFloorUsdg: c.idleFloorUsdg,
      gapEnterBudgetUsdg: c.gapEnterBudgetUsdg,
      llm: {
        creds: resolveLlm(c),
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
  let lastEquityUsdg = 0n; // updated each tick; used by chat-triggered trades
  let lastGasWei = 0n; // updated each tick; feeds the low-gas Telegram alert
  let notifierHandle: ReturnType<typeof startNotifier> | null = null;

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

    const chain = chainForId(grant.chainId);
    const rpc = chain.id === robinhoodTestnet.id ? cfg.rpcTestnet : cfg.rpcMainnet;
    // Effective bundler: an explicit full URL wins (advanced/Alchemy/self-host);
    // otherwise build the Pimlico URL from just the API key + the grant's chain
    // id, so it is always pointed at the right chain.
    const bundlerUrl =
      cfg.bundlerUrl || (cfg.bundlerApiKey ? pimlicoBundlerUrl(grant.chainId, cfg.bundlerApiKey) : undefined);
    const agentId = await ensureAgent(grant);
    // The soul's name is the source of truth — mirror it onto the roster.
    ensureSoul();
    await setAgentName(agentId, getName());

    // Pimlico/Alchemy bundler URLs embed a chain id — a testnet bundler with a
    // mainnet grant (or vice versa) fails every op with opaque errors. Advisory
    // heuristic: warn loudly, never block.
    const mismatch = bundlerChainMismatch(cfg.bundlerUrl, grant.chainId);
    if (mismatch !== null) {
      console.log(`[worker] WARNING: bundler URL looks like chain ${mismatch} but the grant is chain ${grant.chainId}`);
      await addEvent(
        agentId,
        "warn",
        `bundler URL looks like chain ${mismatch} but the grant is chain ${grant.chainId} — every op will fail; fix the bundler URL in /settings`,
      );
    }

    let executor: AgentExecutor | null = null;
    if (bundlerUrl) {
      executor = await createAgentExecutor({
        chain,
        serializedGrant: grant.serialized,
        bundlerUrl,
        rpcUrl: rpc,
      });
      console.log(`[worker] executor live — smart account ${executor.address} on chain ${chain.id}`);
    } else {
      console.log(
        cfg.paperTradingEnabled
          ? "[worker] PAPER MODE — fills simulate at live oracle prices, nothing signs. Add a Pimlico key in /settings to trade live."
          : "[worker] practice mode — no bundler key (add a Pimlico key in /settings to trade live). Policy + simulation still run.",
      );
    }

    const client = createPublicClient({ chain, transport: http(rpc) });

    // The on-chain breaker is only trusted when its address has CODE on the
    // grant chain — otherwise the tick's read silently fails open ("not
    // tripped") while the user believes they're protected.
    let breakerLive = false;
    if (cfg.breakerAddress) {
      const code = await client.getCode({ address: cfg.breakerAddress }).catch(() => undefined);
      breakerLive = code !== undefined && code !== "0x";
      if (!breakerLive) {
        console.log(`[worker] breaker ${cfg.breakerAddress} has no code on chain ${chain.id} — worker-enforced drawdown only`);
        await addEvent(
          agentId,
          "warn",
          `breaker address has no code on chain ${chain.id} — on-chain drawdown protection is OFF (worker-enforced only)`,
        );
      }
    }

    active = {
      grant,
      agentId,
      client,
      executor,
      limits: limitsFromGrant(grant, watchTokens),
      breakerLive,
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
      if (!cfg.paperTradingEnabled) {
        console.log(`[policy] approved ${intent.kind} — execution stubbed (no bundler, paper trading off)`);
        return;
      }
      // ── PAPER FILL: same wall, simulated execution at the live oracle px ──
      const bookRow = await getPaperBook(agentId, cfg.paperStartUsdg);
      const fill = applyPaperIntent(
        intent,
        { cashUsdg: bookRow.cashUsdg, vaultUsdg: bookRow.vaultUsdg, hwmUsdg: bookRow.hwmUsdg },
        paperPositionsOf(bookRow.shares),
        {
          priceUsdOf: paperPriceOf,
          symbolOf: paperSymbolOf,
          usdgAddress: CASH.USDG as `0x${string}`,
          slippageBps: cfg.slippageBps,
          notionalUsdg: usdgNum(notional),
        },
      );
      if (!fill.ok) {
        console.log(`[paper] refused ${intent.kind}: ${fill.reason}`);
        await addEvent(agentId, "warn", `paper fill refused: ${fill.reason}`);
        await addTrade({
          agent_id: agentId,
          kind: intent.kind,
          target: intent.target,
          amount_usdg: usdgNum(notional),
          status: "rejected",
          reject_rule: `paper: ${fill.reason}`,
          created_at: new Date().toISOString(),
        });
        return;
      }
      await setPaperBook(agentId, {
        cashUsdg: fill.book.cashUsdg,
        vaultUsdg: fill.book.vaultUsdg,
        hwmUsdg: bookRow.hwmUsdg,
        shares: Object.fromEntries(fill.positions.map((p) => [p.symbol, { token: p.token, shares: p.shares }])),
      });
      if (intent.kind !== "vault-withdraw") spentTodayUsdg += notional;
      opsToday += 1;
      console.log(`[paper] ${fill.receipt}`);
      await addEvent(agentId, "ok", `📜 ${fill.receipt} — inside the wall, nothing signed`);
      await addTrade({
        agent_id: agentId,
        kind: intent.kind,
        target: intent.target,
        sell_token: intent.kind === "swap" ? intent.sellToken : undefined,
        buy_token: intent.kind === "swap" ? intent.buyToken : undefined,
        amount_usdg: usdgNum(notional),
        status: "paper",
        sim_quote_out: fill.receipt,
        created_at: new Date().toISOString(),
      });
      return;
    }

    // Reserve spend/ops BEFORE the await-heavy execution and roll back on
    // failure. Incrementing only after success opens a TOCTOU window: a chat
    // trade interleaved with a tick could both pass checkPolicy against the
    // same stale spentTodayUsdg and overshoot the daily cap by one action.
    const countsSpend = intent.kind !== "vault-withdraw";
    if (countsSpend) spentTodayUsdg += notional;
    opsToday += 1;

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
      } else if (intent.kind === "transfer") {
        // USDG leaving the wall — user-confirmed in chat, amount capped by the
        // grant's on-chain transfer permission AND the per-trade/daily caps
        // checkPolicy already applied above. One call, no approvals.
        const data = encodeFunctionData({
          abi: erc20Abi,
          functionName: "transfer",
          args: [intent.recipient, intent.amountUsdg],
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
      // Roll back the optimistic reservation — the money didn't move.
      if (countsSpend) spentTodayUsdg -= notional;
      opsToday -= 1;
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

  function heartbeat(blockNumber: bigint) {
    try {
      ensureHome();
      const mode = paperActive() ? "paper" : active?.executor ? "live" : "idle";
      writeFileSync(
        homePaths.heartbeat(),
        JSON.stringify({ at: Math.floor(Date.now() / 1000), block: blockNumber.toString(), mode }),
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

    // Feed prices land BEFORE the book read so paper valuation uses this tick's px.
    lastPrices = market.prices;

    const paper = paperActive();
    let balances: { ethWei: bigint; cashUsdg: bigint; vaultUsdg: bigint };
    let positions: Awaited<ReturnType<typeof readPositions>>;
    if (paper) {
      // The book IS the paper ledger, marked to market at the live oracle px.
      const bookRow = await getPaperBook(agentId, cfg.paperStartUsdg);
      balances = { ethWei: 0n, cashUsdg: usdg(bookRow.cashUsdg), vaultUsdg: usdg(bookRow.vaultUsdg) };
      positions = paperPositionsOf(bookRow.shares).flatMap((p) => {
        const px = paperPriceOf(p.token);
        if (!px) return [];
        return [{
          symbol: p.symbol,
          token: p.token,
          rawBalance: BigInt(Math.round(p.shares * 1e18)),
          uiMultiplier: 10n ** 18n,
          price8: BigInt(Math.round(px.priceUsd * 1e8)),
          priceStale: px.stale,
          valueUsdg: usdg(p.shares * px.priceUsd),
        }];
      });
    } else {
      [balances, positions] = await Promise.all([
        readAccountBalances(client, grant.smartAccount),
        readPositions(client, grant.smartAccount, watchTokens, market.prices),
      ]);
    }
    const positionsUsdg = positions.reduce((sum, p) => sum + p.valueUsdg, 0n);
    // Equity is the whole book — cash, vault, and multiplier-aware stock value —
    // so the drawdown breaker judges reality, not just the cash ledger.
    const equityUsdg = balances.cashUsdg + balances.vaultUsdg + positionsUsdg;

    if (paper) {
      // Paper profit accrues NO fees and never touches the persistent agent
      // HWM — mixing paper peaks into real accounting would trip the breaker
      // (or charge fees) against money that never existed. The paper book
      // keeps its own HWM so the drawdown breaker still works in practice.
      const bookRow = await getPaperBook(agentId, cfg.paperStartUsdg);
      if (usdgNum(equityUsdg) > bookRow.hwmUsdg) {
        bookRow.hwmUsdg = usdgNum(equityUsdg);
        await setPaperBook(agentId, bookRow);
      }
      highWaterMarkUsdg = usdg(bookRow.hwmUsdg);
    } else {
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
    }
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
    // Gated on breakerLive: an address with no code on the grant chain would
    // silently fail open here (.catch → "not tripped"), which is worse than
    // honestly reporting worker-enforced-only at arm time.
    if (cfg.breakerAddress && active.breakerLive) {
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

    lastEquityUsdg = equityUsdg; // for chat-triggered trades between ticks
    lastGasWei = balances.ethWei;
    // Fresh feed prices → the notifier's price alerts (evaluated off-tick).
    notifierHandle?.publishPrices(market.prices);

    // Pause marker (toggled from Telegram/dashboard): keep reading state, but
    // the strategy stops proposing trades until resumed.
    if (isPaused()) return;

    for (const intent of await strategy.tick(snap)) {
      await processIntent(intent, equityUsdg);
    }
  }

  if (selftest) {
    const armed = await syncGrant();
    if (!armed || !active || !(active as ActiveAgent).executor) {
      console.error("[selftest] needs a grant AND a bundler key (a Pimlico key in /settings, or MERRYMEN_BUNDLER_API_KEY / MERRYMEN_BUNDLER_URL)");
      process.exit(1);
    }
    console.log("[selftest] sending policy-legal no-op through the full pipeline…");
    await processIntent(selfTestIntent(), 0n);
    console.log("[selftest] done");
    process.exit(0);
  }

  // ── Telegram bridge — independent long-poll loop, never blocks the tick ──
  async function submitChatTrade(side: "buy" | "sell", symbol: string, usdgAmount: number): Promise<string> {
    if (!active) return "no agent armed — sign a grant in the dashboard first.";
    // Before the first tick completes, equity is unknown (0n) and the drawdown
    // check would judge garbage — hold chat trades until the book is read.
    if (lastEquityUsdg === 0n) return "🐎 the band is still saddling up (first tick pending) — try again in a minute.";
    const token = STOCK_TOKENS.find((t) => t.symbol === symbol)?.address;
    if (!token) return `unknown or unsupported symbol ${symbol}. I trade the basket tokens.`;
    const router = swapRouterFor(cfg);
    let intent: TradeIntent;
    if (side === "buy") {
      const raw = usdg(usdgAmount);
      intent = { kind: "swap", target: router, sellToken: CASH.USDG as `0x${string}`, buyToken: token, sellAmountRaw: raw, notionalUsdg: raw };
    } else {
      const pos = readPositionRaw(active.agentId, symbol, usdg);
      if (!pos) return `you don't hold any ${symbol}.`;
      const want = usdg(usdgAmount);
      const sellRaw = want < pos.valueUsdg ? (pos.rawBalance * want) / pos.valueUsdg : pos.rawBalance;
      const notional = want < pos.valueUsdg ? want : pos.valueUsdg;
      if (sellRaw === 0n) return `${symbol} amount rounds to zero shares.`;
      intent = { kind: "swap", target: router, sellToken: token, buyToken: CASH.USDG as `0x${string}`, sellAmountRaw: sellRaw, notionalUsdg: notional };
    }
    await processIntent(intent, lastEquityUsdg);
    return `🏹 submitted ${side} ${usdgAmount} USDG ${symbol} — watch /trades for the result (it still passes the policy wall).`;
  }

  async function submitChatTransfer(to: `0x${string}`, usdgAmount: number): Promise<string> {
    if (!active) return "no agent armed — sign a grant in the dashboard first.";
    if (lastEquityUsdg === 0n) return "🐎 the band is still saddling up (first tick pending) — try again in a minute.";
    // Worker-side daily transfer budget, on top of the grant's per-trade/daily
    // caps (checkPolicy) and the on-chain transfer amount cap.
    const transferredToday = await getTransferredTodayUsdg(active.agentId);
    if (transferredToday + usdgAmount > cfg.telegramTransferDailyUsdg) {
      return `🧢 that would blow the daily transfer budget (${cfg.telegramTransferDailyUsdg} USDG/day, ${transferredToday.toFixed(2)} already sent today). Raise it in the dashboard if you mean it.`;
    }
    const intent: TradeIntent = {
      kind: "transfer",
      target: CASH.USDG as `0x${string}`,
      recipient: to,
      amountUsdg: usdg(usdgAmount),
    };
    await processIntent(intent, lastEquityUsdg);
    return `📤 transfer submitted — ${usdgAmount} USDG to ${to.slice(0, 6)}…${to.slice(-4)}. Watch /trades for the result (it still passes the policy wall).`;
  }

  const buildStatusContext = () => ({
    name: getName(),
    strategy: strategy.name,
    venue: cfg.swapVenue,
    chainId: active ? active.grant.chainId : null,
    paper: paperActive(),
    paused: isPaused(),
    workerAliveSec: 0, // the worker itself is answering, so it's alive
    grant: active
      ? {
          perTradeUsdg: active.grant.caps.perTradeUsdg,
          dailyUsdg: active.grant.caps.dailyUsdg,
          maxDrawdownPct: active.grant.caps.maxDrawdownPct,
          expiresInDays: Math.max(0, Math.floor((active.grant.expiresAt - Math.floor(Date.now() / 1000)) / 86400)),
        }
      : null,
    telegramMaxActionUsdg: cfg.telegramMaxActionUsdg,
  });

  // One shared persisted-state handle — the poll service and the notifier both
  // write telegram.json; separate copies would lose each other's writes.
  const tgState = createStateRef();

  startTelegram({
    // Resolve FRESH on every read: /link writes the allowlist to settings.json
    // and the very next message must see it — the tick-refreshed `cfg` snapshot
    // lags up to tickSeconds, which reads as "linked, then not authorized".
    getCfg: () => resolveConfig(),
    stateRef: tgState,
    note: strategyNote,
    buildStatusContext,
    setStrategy: (name) => {
      if ((BUILTIN_STRATEGIES as readonly string[]).includes(name)) return { ok: true };
      if (resolveStrategyFile(name, customStrategiesDir())) return { ok: true };
      return { ok: false, reason: `no builtin and no strategies/${name} file` };
    },
    grantPerTradeUsdg: () => active?.grant.caps.perTradeUsdg,
    grantHasTransfer: () => active?.grant.grantFeatures?.includes("transfer") ?? false,
    submitTrade: submitChatTrade,
    submitTransfer: submitChatTransfer,
    onNameChange: (name) => {
      if (active) void setAgentName(active.agentId, name);
    },
    kill: () => {
      try {
        if (!loadGrantFile()) return { ok: false, reason: "no grant" };
        rmSync(homePaths.grant(), { force: true });
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
      }
    },
  });

  // The merryman speaks first: trade pings, warnings, price alerts, the daily
  // campfire report — pushed to the owner chat, gated by telegramNotifyEnabled.
  notifierHandle = startNotifier({
    getCfg: () => resolveConfig(), // fresh for the same reason as the poller
    note: strategyNote,
    stateRef: tgState,
    buildStatusContext,
    getAlertInputs: () => ({
      grantExpiresAt: active?.grant.expiresAt ?? null,
      drawdownBps:
        highWaterMarkUsdg > 0n && lastEquityUsdg > 0n
          ? Number(((highWaterMarkUsdg - lastEquityUsdg) * 10_000n) / highWaterMarkUsdg)
          : null,
      breakerBps: active ? active.limits.maxDrawdownBps : null,
      gasWei: lastGasWei > 0n ? lastGasWei : null,
    }),
    getChainId: () => active?.grant.chainId ?? null,
  });

  console.log(
    `merrymen worker starting — strategy ${strategy.name}, venue ${cfg.swapVenue}, ` +
      `tick ${cfg.tickSeconds}s, settings+grant re-synced every tick` +
      (cfg.telegramEnabled ? ", telegram ON" : ""),
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
