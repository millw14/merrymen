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
  CIRCLE_TIERS,
  MORPHO,
  RIALTO,
  STOCK_TOKENS,
  UNISWAP,
  USDG_DECIMALS,
  chainForId,
  effectivePerfFeeBps,
  pimlicoBundlerUrl,
  robinhoodTestnet,
  grantHasV4,
  tokenCoverage,
  uncoveredBasketSymbols,
  type CircleTier,
  type PriceQuote,
  type StoredGrant,
} from "../../packages/core/src/index";
import { fetchRialtoQuote, resolveRialtoRouter } from "./venues/rialto";
import { bestRoute, buildTradeCalls, minOutWithSlippage } from "./venues/uniswap";
import { createAgentExecutor, type AgentExecutor } from "./executor";
import { createPaperOrderExecutor, type OrderExecutor } from "./executor-order";
import { readHolderStatus } from "./circle";
import { accrueAboveHwm } from "./fees";
import { loadGrantFile } from "./grant";
import { limitsFromGrant } from "./limits";
import { ensureHome, homePaths } from "./home";
import { resolveLlm } from "./llm";
import { applyPaperIntent, type PaperPosition } from "./paper";
import { checkPolicy, type AgentLimits, type AgentState, type ScoutContext, type TradeIntent } from "./policy";
import {
  bundlerChainMismatch,
  connectionKey,
  resolveConfig,
  strategyKey,
  type ResolvedConfig,
} from "./settings";
import { BUILTIN_STRATEGIES, buildStrategy, isCircleStrategy, watchTokensFor } from "./strategies/registry";
import { TRENCHER_DEFAULTS, type Candidate, type OpenPosition } from "./strategies/trencher";
import { createPoolPriceReader } from "./venues/pool-prices";
import { customStrategiesDir, resolveStrategyFile } from "./strategies/custom";
import type { Holding, Snapshot, Strategy } from "./strategies/types";
import { isPaused, startTelegram } from "./telegram/service";
import { startNotifier } from "./telegram/notifier";
import { startVirtualsStreamer } from "./virtuals-streamer";
import { createStateRef, ensureLinkCode } from "./telegram/state";
import { readPositionRaw } from "./telegram/reads";
import { formatDepth, formatNoDepth } from "./telegram/depth-format";
import { bestCashPool } from "./venues/pool-price";
import { readPoolDepth } from "./venues/depth";
import { createDepthReader } from "./venues/depth-cache";
import { ensureSoul, getName } from "./soul";
import { positionValueUsdg, readMultipliers, readPositions, type Position } from "./positions";
import { quarantineOf } from "./quarantine";
import { describeDiscovery, discoverPools, resolveBitquery } from "./discovery";
import { mainnetClient, readAccountBalances, readMarketSafety, setMainnetRpc } from "./snapshot";
import { applyFill } from "./basis";
import {
  addDecision,
  addEquity,
  addEvent,
  addFeeAccrual,
  addTrade,
  basisSymbols,
  getBasis,
  setBasis,
  newDecisionId,
  ensureAgent,
  type BasisMode,
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
  clearTrenchEntry,
  getTrenchEntry,
  markPoolSeen,
  recentCandidates,
  recordCandidate,
  seenPools,
  setTrenchEntry,
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
  /**
   * The brokerage rail's executor — a SIBLING of `executor`, never a widening
   * of it (DESIGN.md §4): an equity order has no calldata and no tx hash, so
   * the two rails share no type. Null today everywhere: the live implementation
   * is step 6, gated on a funded Agentic account and tools/list read on the
   * wire. Equity-order intents fall back to the paper order executor, which is
   * exactly the posture the plan wants until then — and note the fork is on the
   * INTENT KIND, not on this field's presence, unlike the EVM rail's
   * "grant but no signer = paper" convention (paperActive, above).
   */
  orderExecutor: OrderExecutor | null;
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
  let watchTokens = watchTokensFor(cfg.basketSymbols, cfg.customTokens);

  // ── paper trading plumbing ────────────────────────────────────────────
  // Paper mode = a grant but no signer: fills simulate at live oracle prices.
  let lastPrices: Map<string, PriceQuote> = new Map();
  const paperActive = () => !!active && !active.executor && cfg.paperTradingEnabled;
  function paperPriceOf(
    token: `0x${string}`,
  ): { priceUsd: number; stale: boolean; source: PriceQuote["source"] } | null {
    const t = watchTokens.find((w) => w.address.toLowerCase() === token.toLowerCase());
    const p = t ? lastPrices.get(t.symbol) : undefined;
    return p ? { priceUsd: Number(p.price8) / 1e8, stale: p.stale, source: p.source } : null;
  }
  const paperSymbolOf = (token: `0x${string}`) =>
    watchTokens.find((w) => w.address.toLowerCase() === token.toLowerCase())?.symbol ?? null;
  /**
   * Live ERC-8056 multipliers, refreshed each paper tick.
   *
   * Paper mode never reads balances, so it never went through readPositions and
   * never saw a multiplier — which meant a stock split halved the paper book and
   * could retire an agent over a corporate action that cost nothing. Returning
   * null (not 1.0) for an unread token is deliberate: the fill path refuses
   * rather than guessing a share count it would then hold onto.
   */
  let lastMultipliers: Map<string, bigint> = new Map();
  const paperMultiplierOf = (token: `0x${string}`): number | null => {
    const t = watchTokens.find((w) => w.address.toLowerCase() === token.toLowerCase());
    if (!t) return null;
    const m = lastMultipliers.get(t.symbol);
    return m === undefined ? null : Number(m) / 1e18;
  };
  const paperPositionsOf = (shares: Record<string, { token: `0x${string}`; shares: number }>): PaperPosition[] =>
    Object.entries(shares).map(([symbol, v]) => ({ symbol, token: v.token, shares: v.shares }));

  function makeStrategy(c: ResolvedConfig): Strategy {
    return buildStrategy(c.strategy, {
      swapRouter: swapRouterFor(c),
      // Resolve legs against the full watch set, so a selected memecoin is a
      // leg a strategy can actually trade rather than a balance it can only see.
      universe: watchTokensFor(c.basketSymbols, c.customTokens),
      trench: {
        usdgToken: CASH.USDG as `0x${string}`,
        candidates: trenchCandidates,
        open: trenchOpen,
        liquidityOf: (token) => lastLiquidityUsd.get(token.toLowerCase()) ?? null,
      },
      usdg6: usdg,
      basketSymbols: c.basketSymbols,
      buyPerTickUsdg: c.buyPerTickUsdg,
      idleFloorUsdg: c.idleFloorUsdg,
      gapEnterBudgetUsdg: c.gapEnterBudgetUsdg,
      llm: {
        creds: resolveLlm(c),
        intervalMin: c.llmIntervalMin,
        maxActionUsdg: c.llmMaxActionUsdg,
        // Persist every strategist decision (survivor + drop) against the CURRENT
        // agent — the strategist stamps each survivor's intent with the id it wrote.
        onDecision: (d) => {
          if (active) return addDecision({ ...d, agent_id: active.agentId });
        },
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
      // Cached routes were read through the OLD endpoint. Keeping them would
      // serve one chain's prices while pointed at another.
      poolPrices.reset();
      if (active) {
        await addEvent(active.agentId, "ok", "connection settings changed — re-arming executor");
        active = null; // syncGrant re-arms with the new bundler/RPC this tick
      }
      connKey = nextConn;
    }
    if (nextStrat !== stratKey) {
      cfg = next; // makeStrategy reads the new values
      strategy = makeStrategy(next);
      watchTokens = watchTokensFor(next.basketSymbols, next.customTokens);
      console.log(`[settings] strategy settings applied — ${strategy.name}, venue ${next.swapVenue}`);
      if (active) {
        active.limits = limitsFromGrant(active.grant, watchTokens);
        await addEvent(active.agentId, "ok", `settings applied — strategy ${strategy.name}, venue ${next.swapVenue}`);
      }
      stratKey = nextStrat;
    }
    cfg = next;
    // Adding a token in /settings is the common way this drifts — say so on the
    // next tick rather than at the next re-arm, which might never come.
    if (active) await noteTokenCoverage(active.agentId);
  }

  let spentTodayUsdg = 0n;
  let opsToday = 0;
  let highWaterMarkUsdg = 0n;
  // Merry Circle — the holder's $MERRYMEN tier, refreshed each tick; drives the
  // performance-fee discount. Starts as the outsider (no discount) until read.
  let holderTier: CircleTier = CIRCLE_TIERS[0]!;
  let lastTierId = holderTier.id;
  let circleBlockedNoted = false; // so the "hold to unlock" note isn't spammed each tick
  let lastSequencerUp = true;
  // A feedless holding never resolves, so warn ONCE while it's held rather than
  // every tick forever. Resets when the book is valuable again.
  let notedUnpriced = false;
  let lastEquityUsdg = 0n; // updated each tick; used by chat-triggered trades
  // What the tick could NOT price this cycle (lowercased addresses), and the
  // total cost already sitting in such positions. Written from the real price
  // map each tick and read by the scout ceiling — deliberately NOT reachable
  // from an intent, so a strategy can't declare its own target priceable.
  let lastUnpriceable: Set<string> = new Set();
  let lastQuarantinedUsdg = 0n;
  // Whether that figure is the WHOLE book. False while a held asset can't be
  // valued — the total is then a partial sum, and judging a drawdown on it would
  // read the missing asset as a loss and refuse the very sell that clears it.
  let lastEquityKnown = true;
  let lastGasWei = 0n; // updated each tick; feeds the low-gas Telegram alert
  let notifierHandle: ReturnType<typeof startNotifier> | null = null;

  // Uniswap TWAPs for tokens with no Chainlink feed. Cached across ticks — the
  // window is 15 minutes, so re-reading three pools every 15 seconds buys
  // nothing and costs a great deal of RPC.
  const poolPrices = createPoolPriceReader();
  // Liquidity depth, on the same "cache the read, never the verdict" discipline
  // but a longer TTL: a price is what the next trade executes at, depth is the
  // shape behind it, and capital people have parked moves slower than a quote.
  // watchTokens is read through a closure because the owner can change the watch
  // set mid-run — capturing the array once would freeze the universe.
  const depthReader = createDepthReader({
    client: mainnetClient(),
    tokens: () => watchTokens,
    cash: CASH.USDG as `0x${string}`,
    cashDecimals: USDG_DECIMALS,
  });
  // Feedless tokens the guard REFUSED, symbol → reason. Reported when the set
  // changes rather than every tick, and reused to explain why the book can't be
  // valued instead of the useless "has no price feed".
  let poolRefusals = new Map<string, string>();
  let lastRefusalKey: string | null = null;

  /**
   * Price the feedless part of the watch set from Uniswap and merge it into the
   * tick's price map.
   *
   * This is what makes a memecoin a real holding rather than a hole in the book,
   * and it is deliberately the ONLY place a non-Chainlink price enters the
   * system. Every quote it returns has already passed the depth floor and the
   * spot-vs-TWAP divergence band; anything that didn't comes back as a refusal
   * with a reason, and stays unpriced. Refusing is the safe outcome — equity and
   * the drawdown breaker read these numbers.
   */
  async function mergePoolPrices(prices: Map<string, PriceQuote>, agentId: string): Promise<void> {
    // Memecoins only, not merely "feedless". A Stock Token whose feed hasn't
    // been published yet (BE today) is still ERC-8056: its value scales with
    // uiMultiplier, while a pool quotes the whole-token price that already
    // includes any split. Pricing one from a pool would need that difference
    // handled everywhere it flows, so it simply isn't offered — such a token
    // stays honestly unvalued until Chainlink lists it.
    const feedless = watchTokens.filter((t) => t.chainlinkFeed === null && t.kind === "memecoin");
    if (!feedless.length) {
      poolRefusals = new Map();
      lastRefusalKey = null;
      return;
    }
    const { quotes, refused } = await poolPrices.read({
      // Pools live on MAINNET, like the feeds — a testnet grant still values its
      // book against the real market rather than against nothing.
      client: mainnetClient(),
      tokens: feedless,
      guard: {
        minLiquidityUsdg: usdg(cfg.minPoolLiquidityUsdg),
        maxDivergenceBps: cfg.maxPriceDivergenceBps,
      },
      nowSec: Math.floor(Date.now() / 1000),
    });
    // Chainlink is never overwritten: a feedless token is one with no feed, so
    // these keys can't collide — but merging in this direction makes that
    // explicit rather than incidental.
    for (const [symbol, quote] of quotes) if (!prices.has(symbol)) prices.set(symbol, quote);
    // Depth per token, so a trench exit can tell a drain from a price move.
    for (const t of feedless) {
      const q = quotes.get(t.symbol);
      if (!q?.detail) continue;
      const m = /\$([\d,]+)\s+deep/.exec(q.detail);
      if (m) lastLiquidityUsd.set(t.address.toLowerCase(), Number(m[1]!.replace(/,/g, "")));
    }

    poolRefusals = new Map(refused.map((r) => [r.symbol, r.reason]));
    // Key on the refusal KIND, never the prose. The reasons embed a live pool
    // balance and a divergence percentage, so a key built from them changes
    // every time anyone trades — and "tell the owner when this changes" would
    // become a warn row every tick, forever, burying the warnings that matter.
    const key = refused
      .map((r) => `${r.symbol}:${r.kind}`)
      .sort()
      .join("|");
    if (key === lastRefusalKey) return;
    lastRefusalKey = key;
    if (!refused.length) return;
    const lines = refused.map((r) => `${r.symbol} (${r.reason})`).join("; ");
    console.log(`[price] refusing to value ${lines}`);
    await addEvent(
      agentId,
      "warn",
      `won't put a price on ${lines}. A price off a pool that shallow can be moved by ` +
        `whoever wants to move it, and it would feed your equity and drawdown breaker — ` +
        `so it stays unpriced rather than wrong.`,
    );
  }

  /**
   * Tokens the owner listed in settings that the CURRENT signature can't
   * approve. Adding a token to settings can't widen an already-signed session
   * key — that's the whole point of the wall — so the two lists can legitimately
   * disagree, and the owner has to be told which side is short. Otherwise the
   * first they'd hear of it is a sell reverting at the wall, holding a memecoin
   * they can't exit.
   *
   * Emitted when the set CHANGES (token added, or grant re-signed to cover it),
   * not every tick: the fact is static until one side moves.
   */
  /**
   * Discovery — a slow, separate poll that only ever produces a MESSAGE.
   *
   * Deliberately not on the trading tick. The holder gateway allows a handful of
   * calls a minute across everything a wallet does, so polling at tick cadence
   * would spend the allowance the owner's brain also draws on — trading one
   * feature for another they're more likely to be relying on.
   *
   * Nothing here can trade. A surfaced pair still costs the owner the same two
   * deliberate steps as one they found themselves: add it in /settings, re-sign
   * at /grant. That is the point, not a limitation.
   */
  /** Depth per token from the last pool read — what an exit judges a drain against. */
  const lastLiquidityUsd = new Map<string, number>();

  /**
   * Candidates the trencher may enter.
   *
   * GATED TO PAPER MODE, deliberately. In live mode a token must be added in
   * /settings and covered by a re-signed grant before anything can touch it —
   * that is the wall, and discovery must not become a way around it. Paper mode
   * has no signing and no grant, so there is nothing to route around: it is the
   * one place a discovery feed can drive entries without weakening anything.
   *
   * Live trenching is reachable, it just costs the owner the same two deliberate
   * steps as any other token. That is the feature, not a limitation.
   */
  function trenchCandidates(): Candidate[] {
    if (!paperActive()) return [];
    const nowSec = Math.floor(Date.now() / 1000);
    const out: Candidate[] = [];
    for (const c of recentCandidates(TRENCHER_DEFAULTS.maxAgeSec, 25)) {
      const quote = lastPrices.get(c.symbol);
      out.push({
        symbol: c.symbol,
        token: c.address as `0x${string}`,
        decimals: c.decimals,
        // Priceable means THIS tick could price it, not that discovery once
        // could — a pool that has since thinned must not still read as fine.
        priceable: !!quote && quote.price8 > 0n,
        liquidityUsd: lastLiquidityUsd.get(c.address.toLowerCase()) ?? c.liquidityUsd,
        fdvUsd: c.fdvUsd,
        ageSec: Math.max(0, nowSec - c.firstSeen),
        price8: quote?.price8 ?? 0n,
      });
    }
    return out;
  }

  /**
   * Open trench positions, with the baseline their exits are judged against.
   *
   * Entry PRICE comes from the cost-basis ledger rather than a stored copy: that
   * ledger already tracks exactly what was paid per raw unit and survives
   * partial fills, so a second copy could only ever disagree with it.
   */
  function trenchOpen(): OpenPosition[] {
    if (!active) return [];
    const mode: BasisMode = paperActive() ? "paper" : "live";
    const out: OpenPosition[] = [];
    for (const t of watchTokens) {
      const basis = getBasis(active.agentId, mode, t.symbol);
      if (basis.qtyRaw <= 0n || basis.costUsdg <= 0n) continue;
      const entry = getTrenchEntry(active.agentId, mode, t.symbol);
      if (!entry) continue; // not a trench entry — another strategy's position
      // costUsdg(6dp) / qty(10^dec) → USD per whole token at 8dp.
      const entryPrice8 =
        (basis.costUsdg * 10n ** BigInt(t.decimals ?? 18) * 100n) / basis.qtyRaw;
      out.push({
        symbol: t.symbol,
        token: t.address,
        entryPrice8,
        entryLiquidityUsd: entry.liquidityUsd,
        entrySec: entry.entrySec,
        costUsdg: basis.costUsdg,
      });
    }
    return out;
  }

  let lastDiscoveryAt = 0;
  async function runDiscovery(agentId: string): Promise<void> {
    if (!cfg.discoveryEnabled) return;
    const creds = resolveBitquery({
      bitqueryApiKey: cfg.bitqueryApiKey,
      // The holder token doubles as the gateway credential — the same one the
      // brain claims. No Bitquery account needed for Circle members.
      // The standalone token first, then the LLM key when the brain IS the
      // gateway — one claimed token opens both, but choosing the gateway for
      // discovery must not force choosing it for thinking as well.
      merrymenToken: cfg.merrymenToken ?? (cfg.llmProvider === "merrymen" ? cfg.llmApiKey : undefined),
    });
    if (!creds) return; // no key, no discovery — honest silence, not an error
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec - lastDiscoveryAt < cfg.discoveryIntervalMin * 60) return;
    lastDiscoveryAt = nowSec;

    const found = await discoverPools({
      client: mainnetClient(),
      creds,
      guard: {
        minLiquidityUsdg: usdg(cfg.minPoolLiquidityUsdg),
        maxDivergenceBps: cfg.maxPriceDivergenceBps,
      },
      seen: seenPools(),
      known: watchTokens,
      sinceMinutes: Math.max(60, cfg.discoveryIntervalMin * 2),
    });

    for (const d of found) {
      // Persist BEFORE announcing. If the notification fails we'd rather stay
      // quiet than repeat ourselves every poll — a feed that duplicates stops
      // being read, and the owner can always look the token up.
      markPoolSeen(d.token, d.symbol);
      // Record the NUMBERS too, not just that we saw it. Without them a
      // strategy asking "is this worth entering" would have to re-derive
      // everything, and the figures it re-derived would be from a later moment
      // than the one the owner was told about.
      recordCandidate({
        address: d.token,
        symbol: d.symbol,
        decimals: d.decimals,
        liquidityUsd: d.liquidityUsdg === null ? 0 : Number(d.liquidityUsdg) / 1e6,
        fdvUsd: d.fdvUsd ?? 0,
        firstSeen: 0, // the store stamps this itself
      });
      const line = describeDiscovery(d);
      console.log(`[discovery] ${line}`);
      await addEvent(
        agentId,
        "ok",
        `${line} — I can't trade it until you add it in /settings and re-sign at /grant.`,
      );
    }
  }

  let lastCoverageKey: string | null = null;
  async function noteTokenCoverage(agentId: string): Promise<void> {
    const grant = active?.grant ?? null;
    const { uncovered } = tokenCoverage(cfg.customTokens, grant);
    // Registry symbols matter just as much, and used to matter MORE: /settings
    // offers every one of them, so an owner could select a stock the signature
    // couldn't sell without ever touching the custom-token flow.
    const uncoveredStocks = uncoveredBasketSymbols(cfg.basketSymbols, grant);
    const names = [...uncoveredStocks, ...uncovered.map((t) => t.symbol)];
    const key = names.slice().sort().join(",");
    if (key === lastCoverageKey) return;
    lastCoverageKey = key;
    if (!names.length) return;
    const list = names.join(", ");
    console.log(`[worker] grant does not cover ${list} — re-sign at /grant to trade them`);
    await addEvent(
      agentId,
      "warn",
      `your key can't sell ${list}, so buys of ${names.length === 1 ? "it are" : "them are"} refused — ` +
        `entering a position you can't exit is the one thing no cap protects you from. ` +
        `The tradable list is sealed into the signature; re-sign at /grant (free, same wallet, same funds).`,
    );
  }

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
      // Live brokerage execution is step 6 of the adapter plan; until the
      // Agentic account exists and tools/list has been read, equity orders can
      // only paper-fill.
      orderExecutor: null,
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
    // A fresh grant may have widened (or narrowed) what it covers — re-evaluate
    // against the current settings rather than carrying the old verdict forward.
    lastCoverageKey = null;
    await noteTokenCoverage(agentId);
    return true;
  }

  // Best-effort token → symbol for decision labels (unknown tokens → undefined).
  const symbolOfToken = (addr?: string): string | undefined => {
    if (!addr) return undefined;
    const lc = addr.toLowerCase();
    return (
      watchTokens.find((t) => t.address.toLowerCase() === lc)?.symbol ??
      STOCK_TOKENS.find((t) => t.address.toLowerCase() === lc)?.symbol
    );
  };

  /** Derive a decision's {action, symbol, size} from a typed intent — no model
   * text, just the structure, so deterministic strategies + chat are attributable. */
  function describeIntent(intent: TradeIntent): { action: string; symbol?: string; sizeUsdg: number } {
    if (intent.kind === "swap") {
      const buyingStock = intent.buyToken.toLowerCase() !== (CASH.USDG as string).toLowerCase();
      return {
        action: buyingStock ? "buy" : "sell",
        symbol: symbolOfToken(buyingStock ? intent.buyToken : intent.sellToken),
        sizeUsdg: usdgNum(intent.notionalUsdg),
      };
    }
    if (intent.kind === "transfer") return { action: "transfer", sizeUsdg: usdgNum(intent.amountUsdg) };
    if (intent.kind === "equity-order") {
      return { action: intent.side, symbol: intent.ticker, sizeUsdg: usdgNum(intent.notionalUsdg) };
    }
    return { action: intent.kind, sizeUsdg: usdgNum(intent.amountUsdg) };
  }

  /** Guarantee the intent carries a decisionId + a persisted decision row before it
   * hits the wall. No-op when already stamped — the strategist journals its own
   * survivors (with the model's reason); this covers deterministic strategies,
   * chat, and selftest so EVERY trade is attributable to a decision. */
  async function ensureDecision(intent: TradeIntent, source: string, reason?: string): Promise<void> {
    if (intent.decisionId || !active) return;
    const id = newDecisionId();
    intent.decisionId = id;
    const d = describeIntent(intent);
    await addDecision({ id, agent_id: active.agentId, source, symbol: d.symbol, action: d.action, size_usdg: d.sizeUsdg, reason });
  }

  /**
   * Book one stock fill against the running weighted-average cost basis and
   * return the columns that describe it. This is what makes "did that trade make
   * money" a number: a buy adds cost, a sell books realized P&L against the
   * average and shrinks the basis pro-rata (see basis.ts for the exact identity).
   */
  function bookFill(
    agentId: string,
    mode: BasisMode,
    f: { side: "buy" | "sell"; symbol: string; qtyRaw: bigint; cashUsdg: bigint; priceUsd: number },
    source: "paper" | "quote",
  ): Pick<TradeRow, "fill_side" | "fill_qty_raw" | "fill_price_usd" | "realized_pnl_usdg" | "basis_source"> {
    const prev = getBasis(agentId, mode, f.symbol);
    const r = applyFill(prev, { side: f.side, qtyRaw: f.qtyRaw, cashUsdg: f.cashUsdg });
    setBasis(agentId, mode, f.symbol, r.basis);

    // Trench bookkeeping. The baseline is stamped on the FIRST buy only (the
    // insert is ON CONFLICT DO NOTHING), so topping up doesn't quietly reset the
    // stop-loss reference to a worse price — which would turn averaging down
    // into a way of never stopping out.
    if (cfg.strategy === "trencher") {
      const tok = watchTokens.find((t) => t.symbol === f.symbol);
      if (f.side === "buy" && tok) {
        setTrenchEntry(agentId, mode, f.symbol, lastLiquidityUsd.get(tok.address.toLowerCase()) ?? 0);
      }
      // Flat again: forget the baseline so a later re-entry starts fresh rather
      // than being judged against a position that closed hours ago.
      if (f.side === "sell" && r.basis.qtyRaw <= 0n) clearTrenchEntry(agentId, mode, f.symbol);
    }
    if (r.basisUnknown) {
      // A holding with no tracked cost (opened before basis existed, or drifted).
      // Say so rather than reporting a number we can't stand behind.
      void addEvent(
        agentId,
        "warn",
        `sold ${f.symbol} with no cost basis on record — P&L for that trade isn't attributable (position predates basis tracking)`,
      );
    }
    return {
      fill_side: f.side,
      fill_qty_raw: f.qtyRaw.toString(),
      fill_price_usd: f.priceUsd,
      // Left NULL for buys (nothing realized) AND for unbacked sells (cost
      // unknown), so the realized sum only ever contains figures we can defend.
      realized_pnl_usdg: f.side === "sell" && !r.basisUnknown ? usdgNum(r.realizedUsdg) : undefined,
      basis_source: source,
    };
  }

  /**
   * What the scout ceiling needs to judge THIS intent — built from what the tick
   * actually managed to price, never from anything the intent claims.
   *
   * `lastUnpriceable` is written by the tick each cycle from readPositions +
   * mergePoolPrices. A strategy cannot reach it, which is the whole point: the
   * budget on unpriceable positions must not be bypassable by the code it bounds.
   *
   * Returns undefined for non-swaps, so vault moves and transfers are untouched.
   */
  function scoutContextFor(intent: TradeIntent): ScoutContext | undefined {
    if (intent.kind !== "swap" || !active) return undefined;
    const symbol = symbolOfToken(intent.buyToken);
    const buyUnpriceable = lastUnpriceable.has(intent.buyToken.toLowerCase());
    return {
      limits: {
        enabled: cfg.scoutEnabled,
        budgetUsdg: usdg(cfg.scoutBudgetUsdg),
        perTokenUsdg: usdg(cfg.scoutPerTokenUsdg),
      },
      buyUnpriceable,
      existingCostUsdg:
        symbol !== undefined
          ? getBasis(active.agentId, paperActive() ? "paper" : "live", symbol).costUsdg
          : 0n,
      quarantinedUsdg: lastQuarantinedUsdg,
    };
  }

  async function processIntent(
    intent: TradeIntent,
    equityUsdg: bigint,
    equityKnown = true,
  ): Promise<void> {
    if (!active) return;
    const { agentId, limits, executor } = active;
    const decision_id = intent.decisionId;
    // Every trade this intent writes — approved, rejected, paper, landed, reverted —
    // carries the same decision link, so the ledger is joinable to the reasoning.
    const recordTrade = (row: TradeRow) => addTrade({ ...row, decision_id });
    const state: AgentState = {
      spentTodayUsdg,
      opsToday,
      highWaterMarkUsdg,
      equityUsdg,
      equityKnown,
      nowSec: Math.floor(Date.now() / 1000),
    };
    const verdict = checkPolicy(intent, limits, state, scoutContextFor(intent));
    const notional =
      intent.kind === "swap" || intent.kind === "equity-order" ? intent.notionalUsdg : intent.amountUsdg;
    // trades.target is NOT NULL and EVM-shaped; the ticker is the honest analog
    // on the broker rail. Step 5's schema work gives broker rows their own
    // columns — until then the ticker in `target` keeps the tape readable.
    const tradeTarget = intent.kind === "equity-order" ? intent.ticker : intent.target;

    if (!verdict.ok) {
      console.log(`[policy] REJECTED ${intent.kind}: ${verdict.rule} — ${verdict.detail}`);
      await addEvent(agentId, "warn", `policy rejected ${intent.kind}: ${verdict.rule} — ${verdict.detail}`);
      await recordTrade({
        agent_id: agentId,
        kind: intent.kind,
        target: tradeTarget,
        amount_usdg: usdgNum(notional),
        status: "rejected",
        reject_rule: verdict.rule,
      });
      return;
    }

    if (intent.kind === "equity-order") {
      // ── THE BROKER LANE — paper-only until step 6 ─────────────────────────
      // Two-stage policy on this rail, and the second stage is the one that
      // counts: there is no account contract re-checking amounts behind us
      // (DESIGN.md §5), so checkPolicy runs once on the proposed notional
      // (above, shared with every rail) and AGAIN on the terms review()
      // returns — fees and slippage included. place() is unreachable except
      // downstream of a review that passed both.
      const orderExec =
        active.orderExecutor ??
        createPaperOrderExecutor({
          priceUsd8Of: (ticker) => lastPrices.get(ticker)?.price8 ?? null,
          slippageBps: cfg.slippageBps,
        });
      const order = { ticker: intent.ticker, side: intent.side, notionalUsdg: intent.notionalUsdg };
      let review;
      try {
        review = await orderExec.review(order);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        console.log(`[order] review refused ${intent.ticker}: ${reason}`);
        await addEvent(agentId, "warn", `order review refused: ${reason}`);
        await recordTrade({
          agent_id: agentId,
          kind: intent.kind,
          target: tradeTarget,
          amount_usdg: usdgNum(notional),
          status: "rejected",
          reject_rule: `review: ${reason}`,
        });
        return;
      }

      const reviewed = checkPolicy({ ...intent, notionalUsdg: review.notionalUsdg }, limits, state);
      if (!reviewed.ok) {
        console.log(`[policy] REJECTED reviewed terms for ${intent.ticker}: ${reviewed.rule}`);
        await addEvent(
          agentId,
          "warn",
          `reviewed order terms exceed the wall: ${reviewed.rule} — ${reviewed.detail}`,
        );
        await recordTrade({
          agent_id: agentId,
          kind: intent.kind,
          target: tradeTarget,
          amount_usdg: usdgNum(review.notionalUsdg),
          status: "rejected",
          reject_rule: reviewed.rule,
        });
        return;
      }

      const placed = await orderExec.place(order, review);
      // Counters move on the REVIEWED notional — the amount the wall approved.
      spentTodayUsdg += review.notionalUsdg;
      opsToday += 1;
      console.log(`[order] ${review.detail} (${placed.status}, ${placed.orderId})`);
      await addEvent(agentId, "ok", `📜 ${review.detail} — inside the wall, nothing signed`);
      // Paper fills are exact, so basis and realized P&L are the real thing —
      // same 'paper' mode and 1e18-per-share convention as the EVM paper path.
      // The 'brokerage' BasisMode (and the brokerage cash ledger) arrive with
      // step 5; until then paper equities are basis-tracked, not cash-tracked.
      const booked = placed.fill
        ? bookFill(
            agentId,
            "paper",
            {
              side: placed.fill.side,
              symbol: placed.fill.symbol,
              qtyRaw: placed.fill.qtyRaw1e18,
              cashUsdg: placed.fill.cashUsdg,
              priceUsd: placed.fill.priceUsd,
            },
            "paper",
          )
        : null;
      await recordTrade({
        agent_id: agentId,
        kind: intent.kind,
        target: tradeTarget,
        amount_usdg: usdgNum(review.notionalUsdg),
        status: "paper",
        sim_quote_out: review.detail,
        ...(booked ?? {}),
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
          multiplierOf: paperMultiplierOf,
          usdgAddress: CASH.USDG as `0x${string}`,
          slippageBps: cfg.slippageBps,
          notionalUsdg: usdgNum(notional),
        },
      );
      if (!fill.ok) {
        console.log(`[paper] refused ${intent.kind}: ${fill.reason}`);
        await addEvent(agentId, "warn", `paper fill refused: ${fill.reason}`);
        await recordTrade({
          agent_id: agentId,
          kind: intent.kind,
          target: intent.target,
          amount_usdg: usdgNum(notional),
          status: "rejected",
          reject_rule: `paper: ${fill.reason}`,
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
      // Book the fill against the running cost basis. Paper fills are EXACT (we
      // know the shares and the cash), so realized P&L here is the real thing.
      const booked = fill.fill
        ? bookFill(
            agentId,
            "paper",
            {
              side: fill.fill.side,
              symbol: fill.fill.symbol,
              // Paper carries no ERC-8056 multiplier (1 share = 1e18 raw), the same
              // convention the tick uses when it values the paper book.
              qtyRaw: BigInt(Math.round(fill.fill.shares * 1e18)),
              cashUsdg: usdg(fill.fill.cashUsdg),
              priceUsd: fill.fill.priceUsd,
            },
            "paper",
          )
        : null;
      // The paper book rounds share counts to 6dp while basis tracks exact raw
      // units, so a fully-closed position can leave sub-dust basis behind. The
      // book is the source of truth for what's held: if the symbol is gone from
      // it, the basis is flat too — otherwise stale dust would silently become
      // the cost of the NEXT position in that symbol.
      if (fill.fill && !fill.positions.some((p) => p.symbol === fill.fill!.symbol)) {
        setBasis(agentId, "paper", fill.fill.symbol, { qtyRaw: 0n, costUsdg: 0n });
      }
      await recordTrade({
        agent_id: agentId,
        kind: intent.kind,
        target: intent.target,
        sell_token: intent.kind === "swap" ? intent.sellToken : undefined,
        buy_token: intent.kind === "swap" ? intent.buyToken : undefined,
        amount_usdg: usdgNum(notional),
        status: "paper",
        sim_quote_out: fill.receipt,
        ...(booked ?? {}),
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
      // Fill economics for cost basis, taken from the pre-trade quote (we don't
      // parse receipts yet) — recorded as basis_source 'quote' so analysis never
      // mistakes an estimate for a settled figure.
      let liveFill: { side: "buy" | "sell"; symbol: string; qtyRaw: bigint; cashUsdg: bigint; priceUsd: number } | null = null;
      // Same-token "swaps" (the selftest no-op) skip the quote path — they are
      // approval-leg pipeline probes, not trades.
      if (intent.kind === "swap" && cfg.swapVenue === "uniswap" && intent.sellToken !== intent.buyToken) {
        // Full leg: QuoterV2 simulation (reverts where the swap would) →
        // slippage-bounded minOut → approve + exactInputSingle in one UserOp.
        const quote = await bestRoute(active.client, {
          tokenIn: intent.sellToken,
          tokenOut: intent.buyToken,
          amountIn: intent.sellAmountRaw,
          // Most of this chain's memecoins have no direct USDG pool at all, so
          // direct-only quoting left them permanently untradable. The router
          // holds the intermediate leg, so this needs no extra approval.
          via: CASH.WETH as `0x${string}`,
          // Only consider v4 if THIS signature can actually reach it. Quoting a
          // venue the key can't touch would pick a route that reverts at the
          // wall — worse than never having considered it.
          v4: grantHasV4(active.grant),
        });
        if (!quote) {
          console.log(`[quote] no executable Uniswap route for ${intent.buyToken} — skipped`);
          await addEvent(agentId, "warn", `no Uniswap route for ${intent.buyToken} — swap skipped`);
          await recordTrade({
            agent_id: agentId,
            kind: intent.kind,
            target: intent.target,
            sell_token: intent.sellToken,
            buy_token: intent.buyToken,
            amount_usdg: usdgNum(notional),
            status: "rejected",
            reject_rule: "no-route",
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
        // Which leg is the stock? USDG in = we're buying it; USDG out = selling.
        // The accounting assumes EXACTLY ONE leg is 6dp USDG cash; a stock→stock
        // swap has none, and feeding an 18dp token amount into the cash field
        // would be a 10^12 error. Book nothing rather than book nonsense.
        {
          const usdgAddr = (CASH.USDG as string).toLowerCase();
          const sellIsUsdg = intent.sellToken.toLowerCase() === usdgAddr;
          const buyIsUsdg = intent.buyToken.toLowerCase() === usdgAddr;
          if (sellIsUsdg !== buyIsUsdg) {
            const stockToken = sellIsUsdg ? intent.buyToken : intent.sellToken;
            const symbol = symbolOfToken(stockToken);
            // Quantity is always the STOCK side (18dp); cash always the USDG side (6dp).
            // The RECEIVED side uses minOut, not the quote: the fill can come in
            // worse than quoted but never better, so this is the conservative
            // figure. Erring optimistic here would understate every loss.
            const qtyRaw = sellIsUsdg ? minOut : intent.sellAmountRaw;
            const cashUsdg = sellIsUsdg ? intent.sellAmountRaw : minOut;
            if (symbol && qtyRaw > 0n) {
              liveFill = {
                side: sellIsUsdg ? "buy" : "sell",
                symbol,
                qtyRaw,
                cashUsdg,
                priceUsd: Number(cashUsdg) / 1e6 / (Number(qtyRaw) / 1e18),
              };
            }
          } else {
            await addEvent(agentId, "warn", `swap has no USDG leg — cost basis not booked for this fill`);
          }
        }
        // One builder, driven by the quote — so the route that was PRICED is
        // necessarily the route that RUNS. v3 approves the router directly; v4
        // approves Permit2, which grants the router a bounded expiring
        // allowance. Building these by hand at the call site is how you approve
        // one router and swap through another.
        const calls = buildTradeCalls({
          quote,
          tokenIn: intent.sellToken,
          tokenOut: intent.buyToken,
          recipient: executor.address,
          amountIn: intent.sellAmountRaw,
          minAmountOut: minOut,
          deadline: Math.floor(Date.now() / 1000) + 300,
        });
        txHash = await executor.execute(calls);
        const venue = quote.v4 ? "v4" : quote.path ? "v3 via WETH" : "v3 direct";
        await addEvent(
          agentId,
          "ok",
          `simulated ✓ ${venue} quote ${quote.amountOut} min ${minOut} @ fee ${quote.fee / 10_000}% · gas ~${quote.gasEstimate}`,
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
          await recordTrade({
            agent_id: agentId,
            kind: intent.kind,
            target: intent.target,
            sell_token: intent.sellToken,
            buy_token: intent.buyToken,
            amount_usdg: usdgNum(notional),
            status: "rejected",
            reject_rule: "no-quote",
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
      // Only a LANDED swap moves the basis — a revert must never book P&L.
      const booked = liveFill ? bookFill(agentId, "live", liveFill, "quote") : null;
      await recordTrade({
        agent_id: agentId,
        kind: intent.kind,
        target: intent.target,
        sell_token: intent.kind === "swap" ? intent.sellToken : undefined,
        buy_token: intent.kind === "swap" ? intent.buyToken : undefined,
        amount_usdg: usdgNum(notional),
        tx_hash: txHash,
        status: "landed",
        ...sim,
        ...(booked ?? {}),
      });
    } catch (e) {
      // Roll back the optimistic reservation — the money didn't move.
      if (countsSpend) spentTodayUsdg -= notional;
      opsToday -= 1;
      const msg = e instanceof Error ? e.message : String(e);
      // Distinguish a genuine on-chain revert (executor threw "reverted on-chain…")
      // from a failure BEFORE submission (bundler/RPC/gas error), so the user isn't
      // told "reverted on-chain" for something that never reached the chain. The
      // short reason rides on reject_rule (the notifier + dashboard already read it).
      const onChain = /reverted on-chain/i.test(msg);
      const reason = onChain
        ? msg.replace(/\s*\(0x[0-9a-fA-F]+\)\s*$/, "").slice(0, 90)
        : `couldn't submit: ${msg.replace(/\s+/g, " ").slice(0, 80)}`;
      console.error(`[execute] ${intent.kind} failed:`, msg);
      await addEvent(agentId, "err", `${intent.kind} ${onChain ? "reverted on-chain" : "failed before submit"}: ${msg.slice(0, 200)}`);
      await recordTrade({
        agent_id: agentId,
        kind: intent.kind,
        target: intent.target,
        amount_usdg: usdgNum(notional),
        status: "reverted",
        reject_rule: reason,
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

    // Pool TWAPs for the feedless tokens land BEFORE anything reads a price, so
    // positions, equity, paper fills and the strategy all see the same map.
    await mergePoolPrices(market.prices, agentId);

    // Feed prices land BEFORE the book read so paper valuation uses this tick's px.
    lastPrices = market.prices;

    const paper = paperActive();
    let balances: { ethWei: bigint; cashUsdg: bigint; vaultUsdg: bigint };
    let positions: Position[];
    // Symbols the account HOLDS but couldn't be valued this tick (feed/multiplier
    // read failed). Valuing them at 0 would crater equity and can trip the drawdown
    // breaker on a transient hiccup — so a non-empty list means "hold this tick".
    let missingPrice: string[] = [];
    // Held assets with no feed AT ALL (every memecoin). Separate from the above
    // because this never resolves — see the structural-gap branch below.
    let unpricedByDesign: string[] = [];
    if (paper) {
      // The book IS the paper ledger, marked to market at the live oracle px.
      const bookRow = await getPaperBook(agentId, cfg.paperStartUsdg);
      balances = { ethWei: 0n, cashUsdg: usdg(bookRow.cashUsdg), vaultUsdg: usdg(bookRow.vaultUsdg) };
      positions = [];
      // Multipliers are a property of the token, not of a holding, so they matter
      // just as much to a simulated position as a funded one. An unreadable one
      // goes to missingPrice, which holds the tick — the same fail-closed rule
      // readPositions uses, and for the same reason: valuing a post-split
      // position at the pre-split multiplier books a drawdown that never happened.
      const mults = await readMultipliers(client, watchTokens);
      lastMultipliers = mults.multipliers;
      for (const p of paperPositionsOf(bookRow.shares)) {
        if (p.shares <= 0) continue;
        const px = paperPriceOf(p.token);
        const mul = mults.multipliers.get(p.symbol);
        if (!px || mul === undefined) {
          missingPrice.push(p.symbol);
          continue;
        }
        // `shares` is split-invariant, so it IS the raw balance in 18dp terms and
        // the real multiplier applies on top — exactly the on-chain arithmetic.
        const rawBalance = BigInt(Math.round(p.shares * 1e18));
        const price8 = BigInt(Math.round(px.priceUsd * 1e8));
        positions.push({
          symbol: p.symbol,
          token: p.token,
          rawBalance,
          uiMultiplier: mul,
          // The paper book normalises to 18dp regardless of the real token's
          // decimals. This labels the number that's actually here, not the
          // on-chain convention.
          decimals: 18,
          price8,
          priceStale: px.stale,
          priceSource: px.source,
          // Same helper the funded path uses, so paper and live can't drift into
          // two different definitions of what a position is worth.
          valueUsdg: positionValueUsdg({ rawBalance, uiMultiplier: mul, price8, decimals: 18 }),
        });
      }
    } else {
      const [bal, posRead] = await Promise.all([
        readAccountBalances(client, grant.smartAccount),
        readPositions(client, grant.smartAccount, watchTokens, market.prices),
      ]);
      balances = bal;
      positions = posRead.positions;
      missingPrice = posRead.missingPrice;
      unpricedByDesign = posRead.unpricedByDesign;
    }

    // TRANSIENT gap: a feed exists but didn't read this tick. A held position we
    // can't price is NOT worth zero — recording it as such books a phantom
    // drawdown that trips the breaker. Hold and retry; the next full-coverage
    // tick resumes on its own.
    if (missingPrice.length) {
      console.log(`[tick] incomplete market coverage — no price for held ${missingPrice.join(",")}; holding (equity + breaker skipped, not a real drawdown)`);
      await addEvent(agentId, "warn", `held ${missingPrice.join(", ")} couldn't be priced this tick — trading + equity paused (fail-closed); this is a data gap, not a loss`);
      return;
    }

    // STRUCTURAL gap: the asset has no feed at all, so waiting changes nothing.
    // Treating this like the transient case froze the tick FOREVER — no equity,
    // no breaker, and no strategy run, which meant no way to sell out of the
    // position. Unvaluable must mean "don't judge", never "don't act".
    //
    // So: value what we can and keep trading, but do NOT pretend to know equity.
    // The book is genuinely unknown, not lower — publishing a partial total would
    // understate it and trip the drawdown breaker on arithmetic rather than loss.
    // Equity, the HWM, the performance fee and the breaker are all skipped for
    // this tick; strategies still run, so the owner can always get out.
    // QUARANTINE. An unpriceable holding is carried at what it COST — a
    // historical fact nobody can push — instead of blinding the whole book.
    //
    // This used to pause equity, the high-water mark, the fee accrual and the
    // drawdown breaker outright, for every position the owner held, the moment
    // ONE dust token became unpriceable. The deep, Chainlink-priced majority of
    // the book lost its safety net over an asset worth pennies.
    //
    // Carrying at cost is NOT a valuation and is labelled as such everywhere it
    // surfaces. It keeps the arithmetic sound so the breaker can go on judging
    // the part of the book it can actually protect. What it cannot do is notice
    // a quarantined token going to zero — which is why the scout BUDGET, not the
    // breaker, is the risk control for this money.
    const quarantine = quarantineOf(
      unpricedByDesign,
      (symbol) => getBasis(agentId, paper ? "paper" : "live", symbol).costUsdg,
      (symbol) => poolRefusals.get(symbol),
    );
    // The book is only genuinely UNKNOWN when a quarantined holding has no
    // recorded cost either — then we know neither what it's worth nor what was
    // paid, and there is no honest number to put in. When the agent bought it,
    // the basis is on record and cost carries the arithmetic just fine.
    // Publish what the scout ceiling judges against. A token is unpriceable if
    // this tick produced no price for it — which covers both a held position we
    // couldn't value AND a watched token we've never bought, since neither has
    // an entry in the price map. That second case is the one that matters: it's
    // the fresh launch the owner is deciding whether to scout into.
    lastUnpriceable = new Set(
      watchTokens
        .filter((t) => !market.prices.has(t.symbol))
        .map((t) => t.address.toLowerCase()),
    );
    lastQuarantinedUsdg = quarantine.totalCostUsdg;

    const unknownCost = quarantine.holdings.filter((h) => h.costUsdg === 0n).map((h) => h.symbol);
    const bookIncomplete = unknownCost.length > 0;
    if (unpricedByDesign.length > 0 && !notedUnpriced) {
      notedUnpriced = true; // once per run, not once per tick — this never clears
      // Say WHY. "No price feed" was true but useless once pool pricing exists:
      // the owner needs to know whether the pool is too thin, being pushed right
      // now, or simply absent — those have different answers.
      const why = unpricedByDesign
        .map((s) => `${s} (${poolRefusals.get(s) ?? "no Chainlink feed and no usable pool"})`)
        .join(", ");
      console.log(`[tick] held ${why} — trading continues, equity/breaker paused while held`);
      await addEvent(
        agentId,
        "warn",
        `held ${why} — can't be valued, so the book can't be totalled. Trading stays OPEN (you can still sell), but equity, P&L and the drawdown breaker are paused until it's out of the book`,
      );
    }
    if (unpricedByDesign.length === 0) notedUnpriced = false;

    const positionsUsdg = positions.reduce((sum, p) => sum + p.valueUsdg, 0n);
    // Equity is the whole book — cash, vault, multiplier-aware stock value, and
    // quarantined holdings at cost. The cost term is what stops a scout buy from
    // reading as an instant loss: cash left the wallet, so without it equity
    // would drop by the full spend and book a drawdown that never happened.
    const equityUsdg =
      balances.cashUsdg + balances.vaultUsdg + positionsUsdg + quarantine.totalCostUsdg;

    // Reconcile LIVE cost basis against the chain. Live fills are booked from the
    // pre-trade quote (we don't parse receipts yet), so the tracked quantity can
    // drift from what actually settled — and a drifted remainder would otherwise
    // sit forever as a phantom position whose cost never comes out. The chain is
    // the truth: a symbol we no longer hold has no basis, full stop.
    if (!paper) {
      // A held-but-unpriceable symbol is absent from `positions` yet very much
      // still owned — closing its basis here would discard the cost of a real
      // position and later report its whole sale proceeds as profit.
      const heldNow = new Set([...positions.map((p) => p.symbol), ...unpricedByDesign, ...missingPrice]);
      for (const symbol of basisSymbols(agentId, "live")) {
        if (heldNow.has(symbol)) continue;
        const stranded = getBasis(agentId, "live", symbol);
        if (stranded.qtyRaw <= 0n) continue;
        setBasis(agentId, "live", symbol, { qtyRaw: 0n, costUsdg: 0n });
        console.log(`[basis] ${symbol} no longer held on-chain — closing stranded basis (${fmt(stranded.costUsdg)} USDG cost)`);
        await addEvent(agentId, "warn", `closed leftover ${symbol} cost basis (${fmt(stranded.costUsdg)} USDG) — position is flat on-chain`);
      }
    }

    // Merry Circle — refresh the holder's tier ($MERRYMEN on mainnet, read-only)
    // and note tier changes. The tier discounts the performance fee below.
    holderTier = (await readHolderStatus(cfg.rpcMainnet, cfg.holderAddress)).tier;
    if (holderTier.id !== lastTierId) {
      lastTierId = holderTier.id;
      await addEvent(
        agentId,
        "ok",
        holderTier.id === "outsider"
          ? "Merry Circle — no $MERRYMEN at your holder wallet; standard platform fee applies"
          : `Merry Circle — ${holderTier.emoji} ${holderTier.name}: ${holderTier.feeDiscountBps / 100}% off the platform fee`,
      );
    }
    const effFeeBps = effectivePerfFeeBps(cfg.perfFeeBps, holderTier);

    // With an unvaluable holding on the books, equity is UNKNOWN — not lower.
    // Ratcheting the HWM, accruing a performance fee or judging drawdown off a
    // partial total would all be arithmetic pretending to be information, and
    // the drawdown one would trip the breaker on a token we simply can't price.
    // Skipped entirely; strategies below still run, so the position can be sold.
    if (bookIncomplete) {
      console.log(`[account] book incomplete (${unknownCost.join(",")} unpriced AND no cost on record) — equity, HWM, fee and breaker skipped this tick`);
    } else if (paper) {
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
      // The first funded observation is COST BASIS, not profit. Seed the HWM to
      // it so the performance fee only ever accrues on gains ABOVE what was put
      // in — otherwise a fresh agent (HWM 0) books its entire initial deposit as
      // "profit" and accrues a fee on the user's own money (e.g. 15.49 on a 154.87
      // deposit at 10%). Persist it so a restart doesn't re-seed from 0.
      if (highWaterMarkUsdg === 0n && equityUsdg > 0n) {
        highWaterMarkUsdg = equityUsdg;
        await setAgentHwm(agentId, usdgNum(equityUsdg));
      }
      // The Merry Circle discount is applied to the REAL fee here, so holders
      // actually accrue less — the perk is in the ledger, not just the marketing.
      const accrual = accrueAboveHwm(equityUsdg, highWaterMarkUsdg, effFeeBps);
      if (accrual.profitUsdg > 0n) {
        await addFeeAccrual(agentId, {
          profitUsdg: usdgNum(accrual.profitUsdg),
          feeUsdg: usdgNum(accrual.feeUsdg),
          hwmBeforeUsdg: usdgNum(highWaterMarkUsdg),
          hwmAfterUsdg: usdgNum(accrual.newHwmUsdg),
        });
        await setAgentHwm(agentId, usdgNum(accrual.newHwmUsdg));
        if (accrual.feeUsdg > 0n) {
          const circle =
            holderTier.feeDiscountBps > 0
              ? ` — ${holderTier.emoji} ${holderTier.name} rate ${effFeeBps / 100}% (${holderTier.feeDiscountBps / 100}% off)`
              : "";
          await addEvent(
            agentId,
            "ok",
            `new high-water mark ${fmt(accrual.newHwmUsdg)} USDG — fee accrued ${fmt(accrual.feeUsdg)} (${effFeeBps / 100}% of ${fmt(accrual.profitUsdg)} profit)${circle}`,
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

    // No equity row while the book is unvaluable: a partial total would read as
    // a real drop on the equity curve and in P&L. A gap is honest; a wrong
    // number is not.
    if (!bookIncomplete) {
      await addEquity(agentId, {
        ethWei: balances.ethWei,
        cashUsdg: usdgNum(balances.cashUsdg),
        vaultUsdg: usdgNum(balances.vaultUsdg),
        positionsUsdg: usdgNum(positionsUsdg),
      });
    }
    await setPositions(
      agentId,
      positions.map((p) => ({
        symbol: p.symbol,
        token: p.token,
        rawBalance: p.rawBalance,
        uiMultiplier: p.uiMultiplier,
        priceUsd: Number(p.price8) / 1e8,
        priceStale: p.priceStale,
        priceSource: p.priceSource,
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
      // What the wall will still accept today, so strategies size to reality
      // instead of re-proposing oversized intents every tick.
      spendHeadroomUsdg:
        active.limits.dailyUsdg > spentTodayUsdg ? active.limits.dailyUsdg - spentTodayUsdg : 0n,
      perTradeCapUsdg: active.limits.perTradeUsdg,
      // Liquidity context, best-effort. Bounded and cached (venues/depth-cache),
      // so this costs a few RPC on the ticks where something has gone stale and
      // nothing on the rest. Absent is a normal state — a cold cache, a pool
      // that could not be read — and nothing downstream may require it.
      depth: await depthReader.read(watchTokens.map((t) => t.symbol)),
    };

    lastEquityUsdg = equityUsdg; // for chat-triggered trades between ticks
    lastEquityKnown = !bookIncomplete;
    lastGasWei = balances.ethWei;
    // Fresh feed prices → the notifier's price alerts (evaluated off-tick).
    notifierHandle?.publishPrices(market.prices);

    // Discovery rides the tick as a trigger but keeps its OWN interval, so its
    // cadence is independent of how fast the owner trades. Never awaited into
    // the trading path in a way that could stall it — a data provider having a
    // bad minute must not delay a sell.
    void runDiscovery(agentId).catch(() => {});

    // Pause marker (toggled from Telegram/dashboard): keep reading state, but
    // the strategy stops proposing trades until resumed.
    if (isPaused()) return;

    // Merry Circle strategies run only for holders (Merry Man+). A non-holder may
    // select one, but it stays idle with a one-time note until they hold $MERRYMEN.
    if (isCircleStrategy(strategy.name) && !holderTier.bonusStrategies) {
      if (!circleBlockedNoted) {
        circleBlockedNoted = true;
        await addEvent(
          agentId,
          "warn",
          `${strategy.name} is a Merry Circle strategy — hold $MERRYMEN (Merry Man tier) to run it; idle until then`,
        );
      }
      return;
    }
    circleBlockedNoted = false;

    for (const intent of await strategy.tick(snap)) {
      // The LLM strategist already journaled + stamped its survivors; this covers
      // deterministic strategies so every trade still links to a decision.
      await ensureDecision(intent, `strategy:${strategy.name}`);
      // equityUsdg excludes anything we couldn't value, so when the book is
      // incomplete it is a partial sum — say so, or the drawdown rule reads the
      // gap as a loss and rejects every intent including the exit.
      await processIntent(intent, equityUsdg, !bookIncomplete);
    }
  }

  if (selftest) {
    const armed = await syncGrant();
    if (!armed || !active || !(active as ActiveAgent).executor) {
      console.error("[selftest] needs a grant AND a bundler key (a Pimlico key in /settings, or MERRYMEN_BUNDLER_API_KEY / MERRYMEN_BUNDLER_URL)");
      process.exit(1);
    }
    console.log("[selftest] sending policy-legal no-op through the full pipeline…");
    const probe = selfTestIntent();
    await ensureDecision(probe, "selftest", "pipeline probe (approve dust) — not a market view");
    await processIntent(probe, 0n);
    console.log("[selftest] done");
    process.exit(0);
  }

  // ── Telegram bridge — independent long-poll loop, never blocks the tick ──
  /**
   * Liquidity depth for one ticker, read live from the chain.
   *
   * On demand rather than per tick: this is answered when someone asks, so it
   * costs nothing in the loop. Three multicall round trips, against the 28 the
   * routed price read already spends every tick on a feedless token.
   *
   * Resolved against watchTokens for the same reason submitChatTrade is — a
   * memecoin the owner added is one they can ask about, and answering "unknown
   * symbol" for a token the agent is actively holding reads as a bug.
   */
  async function readDepthFor(symbol: string): Promise<string> {
    const token = watchTokens.find((t) => t.symbol === symbol);
    if (!token) {
      const known = watchTokens.map((t) => t.symbol).join(", ");
      return `I don't know ${symbol}. I'm watching: ${known || "nothing yet"}.`;
    }
    try {
      const client = mainnetClient();
      const cash = CASH.USDG as `0x${string}`;
      // The SAME pool the price read would pick — see bestCashPool's comment on
      // why two answers to "which pool counts" must not exist.
      const best = await bestCashPool(client, { token: token.address as `0x${string}`, cash });
      if (!best) return formatNoDepth(symbol);

      const depth = await readPoolDepth(client, {
        pool: best.pool,
        token: token.address as `0x${string}`,
        tokenDecimals: token.decimals ?? 18,
        cashDecimals: USDG_DECIMALS,
      });
      if (!depth) return formatNoDepth(symbol);

      // Robinhood's own published quote, as an independent cross-check. Strictly
      // best-effort: it is a nicety, and a depth map is worth reading whether or
      // not a third party's API answered in time.
      let nbboMid: number | null = null;
      try {
        const res = await fetch(`https://api.robinhood.com/rhj/prices/${encodeURIComponent(symbol)}`, {
          signal: AbortSignal.timeout(2500),
        });
        if (res.ok) {
          const body = (await res.json()) as { quotes?: { bid?: string; ask?: string }[] };
          const q = body.quotes?.[0];
          const bid = Number(q?.bid);
          const ask = Number(q?.ask);
          if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) nbboMid = (bid + ask) / 2;
        }
      } catch {
        /* no quote — the on-chain map stands on its own */
      }

      return formatDepth({ symbol, depth, nbboMid, fee: best.fee });
    } catch (e) {
      console.log(`[depth] ${symbol} failed: ${e instanceof Error ? e.message : String(e)}`);
      return `couldn't read the ${symbol} pool just now — try again in a moment.`;
    }
  }

  async function submitChatTrade(side: "buy" | "sell", symbol: string, usdgAmount: number): Promise<string> {
    if (!active) return "no agent armed — sign a grant in the dashboard first.";
    // Before the first tick completes, equity is unknown (0n) and the drawdown
    // check would judge garbage — hold chat trades until the book is read.
    if (lastEquityUsdg === 0n) return "🐎 the band is still saddling up (first tick pending) — try again in a minute.";
    // Resolve against the watch set, not the shipped registry — otherwise a
    // memecoin the owner added, covered by their grant and priced from its pool
    // still came back "unknown symbol" when they asked for it by name.
    const token = watchTokens.find((t) => t.symbol === symbol)?.address;
    if (!token) {
      const known = watchTokens.map((t) => t.symbol).join(", ");
      return `I don't know ${symbol}. I'm watching: ${known || "nothing yet"}. Add it in /settings and re-sign at /grant if you want me trading it.`;
    }
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
    await ensureDecision(intent, "chat", `owner asked to ${side} ${usdgAmount} USDG ${symbol} in chat`);
    await processIntent(intent, lastEquityUsdg, lastEquityKnown);
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
    await ensureDecision(intent, "chat", `owner asked to transfer ${usdgAmount} USDG to ${to} in chat`);
    await processIntent(intent, lastEquityUsdg, lastEquityKnown);
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
    paperStartUsdg: cfg.paperStartUsdg,
  });

  // One shared persisted-state handle — the poll service and the notifier both
  // write telegram.json; separate copies would lose each other's writes.
  const tgState = createStateRef();

  // Mint the /link code as soon as the worker starts, if a bot token is set —
  // deliberately NOT gated on telegramEnabled. The poll loop used to be the only
  // minter and it returns early when Telegram is switched off, so the dashboard
  // could show a token as "connected" while the code stayed empty, with nothing
  // the user could do about it. Now the code exists the moment merrymen runs, and
  // it's waiting the instant they flip the toggle on.
  //
  // The WORKER stays the single writer of telegram.json (state.ts documents that
  // invariant): the dashboard only ever reads it. Minting from the web app would
  // add a second cross-process writer and could clobber ownerId — the ownership
  // claim itself. Reported by @Victory-byte (PR #3); fixed on the worker side.
  if (cfg.telegramBotToken) {
    const before = tgState.get().linkCode;
    tgState.set(ensureLinkCode(tgState.get(), cfg.telegramBotToken));
    if (!before && tgState.get().linkCode) {
      console.log(`[telegram] link code ready — send "/link ${tgState.get().linkCode}" to your bot to claim it`);
    }
  }

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
    readDepth: readDepthFor,
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

  // Stream the band's activity to its Virtuals Terminal page — landed/paper
  // fills + the daily report. Independent loop, opt-in (virtualsEnabled), OUTBOUND
  // + public, decoupled from Telegram. Reads the ledger read-only; can only post.
  startVirtualsStreamer({
    getCfg: () => resolveConfig(),
    note: strategyNote,
    buildStatusContext,
    getChainId: () => active?.grant.chainId ?? null,
    getAgentName: () => getName(),
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
