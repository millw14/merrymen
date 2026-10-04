/**
 * Settings resolution for the worker: settings file > env var > default.
 * The file is re-read every tick (cheap; it's tiny) so changes made in the
 * web UI apply without a restart. `configKey()` fingerprints the connection
 * fields — when it changes, the runner drops the armed agent and re-arms with
 * the new bundler/RPC; trading fields rebuild the strategy in place.
 */

import { readFileSync } from "node:fs";
import {
  HOUSE_KEY_FIELDS,
  SETTINGS_DEFAULTS,
  SLIPPAGE_BPS_MAX,
  STOCK_TOKENS,
  TELEGRAM_GROUPS_CHATTINESS,
  isHostedMode,
  isValidCustomToken,
  type CustomToken,
  type MerrymenSettings,
  type TelegramGroupsChattiness,
} from "../../packages/core/src/index";
import { ensureHome, homePaths } from "./home";
import { writeFileAtomicSync } from "./atomic-write";
import { MAX_DECISION_INTERVAL_SEC } from "./decision-cadence";
import { energyModeOf, type EnergyMode } from "./energy";

/**
 * A tenant settings file with every house-key field removed (hosted mode). The
 * field list is HOUSE_KEY_FIELDS in core, shared with the settings API so the
 * worker's "strip before merge" and the API's "refuse to write" can't drift.
 */
export function stripHouseKeys(file: MerrymenSettings): MerrymenSettings {
  const copy = { ...file } as Record<string, unknown>;
  for (const k of HOUSE_KEY_FIELDS) delete copy[k];
  return copy as MerrymenSettings;
}

export interface ResolvedConfig {
  bundlerApiKey: string | undefined;
  bundlerUrl: string | undefined;
  rpcMainnet: string | undefined;
  rpcTestnet: string | undefined;
  groqApiKey: string | undefined;
  groqModel: string;
  anthropicApiKey: string | undefined;
  /** Selected AI provider id (LLM_PROVIDERS) or "custom"; undefined = legacy auto. */
  llmProvider: string | undefined;
  /** Key for the selected provider (groq/anthropic fall back to their classic keys). */
  llmApiKey: string | undefined;
  /** Base URL for provider "custom". */
  llmBaseUrl: string | undefined;
  /** Model override for the selected provider; undefined = provider default. */
  llmProviderModel: string | undefined;
  rialtoApiKey: string | undefined;
  rialtoApiKeyHeader: string;
  breakerAddress: `0x${string}` | undefined;
  agentName: string | undefined;
  xHandle: string | undefined;
  /**
   * Proof that xHandle is theirs, written only by /api/x-proof.
   *
   * Carried through so the worker can stamp `agents.x_verified` — the flag a
   * public surface needs before it may turn a handle into a link. Read from
   * the file only: unlike the handle beside it there is no env override,
   * because a proof somebody can set from a shell is not a proof.
   */
  xProof: { handle: string; at: number } | undefined;
  v4AdapterAddress: `0x${string}` | undefined;
  ponsAdapterAddress: `0x${string}` | undefined;
  /** The PonsClassVaultFactory. A HINT for signing; the grant is the authority. */
  ponsClassVaultFactory: `0x${string}` | undefined;
  /** Which kinds of thing may be BOUGHT. Never filters the watch set. */
  assetMode: "all" | "stocks" | "crypto";
  autoConvertEnabled: boolean;
  autoConvertReservePct: number;
  /** Manual one-shot swap handoff from the /swap page (wei string + id).
   * Consumed and cleared by the worker tick once execution lands; validated
   * again at consume time. Tenant-writable by design. */
  manualSwapWei: string | undefined;
  manualSwapId: string | undefined;
  paperTradingEnabled: boolean;
  /** The owner's explicit consent to put real orders on chain. Default false. */
  liveTradingEnabled: boolean;
  /**
   * Is the consent gate in force yet? False ONLY while the one-time migration
   * that populates `liveTradingEnabled` is still in report mode — see
   * `ExecInputs.enforceLiveIntent` for why a gate with a safe default is an
   * outage until somebody has written the field for the people mid-trade.
   */
  enforceLiveIntent: boolean;
  /**
   * The energy gate (core energy.ts, worker/src/energy.ts): off, observe or
   * enforce. OPERATOR ENV ONLY — MERRYMEN_ENERGY_GATE, never a settings-file
   * key, never a house key a tenant could strip or set — and HOSTED ONLY:
   * self-hosted is always 'off' whatever the env says. On their own machine the
   * owner pays their own model and runs open code; a throttle there would be
   * both unenforceable and against the token's stance.
   */
  energyGate: EnergyMode;
  paperStartUsdg: number;
  /** Builtin name, or a user strategy filename (strategies/<name>.ts). */
  strategy: string;
  swapVenue: "uniswap" | "rialto";
  slippageBps: number;
  maxImpactBps: number;
  perfFeeBps: number;
  /** Per-trade fee on turnover, bps. Accrual-only — see fees.ts. */
  tradeFeeBps: number;
  /** Where a collected trade fee would go. Nothing collects yet. */
  tradeFeeAddress?: string;
  tickSeconds: number;
  basketSymbols: string[];
  /** Owner-added ERC-20s (memecoins). Shape-checked; still gated by the grant. */
  customTokens: CustomToken[];
  /** USD depth below which a token is refused a price (manipulation guard). */
  memecoinMinFdvUsd: number;
  minPoolLiquidityUsdg: number;
  /** Spot-vs-TWAP band, bps, above which a price is refused. */
  maxPriceDivergenceBps: number;
  /** Poll Bitquery for new pairs and report them. Never trades. */
  discoveryEnabled: boolean;
  discoveryIntervalMin: number;
  /** Scout mode: may the agent buy tokens it cannot price? Off by default. */
  trencherLiveEnabled: boolean;
  trencherFastEnabled: boolean;
  sponsorGasEnabled: boolean;
  sponsorshipPolicyId?: string;
  /** Read flows from USDG Transfer logs rather than inferring them. */
  depositScanEnabled: boolean;
  /** Let the strategist research before deciding. */
  deskEnabled: boolean;
  deskMaxSteps: number;
  browserUrl: string | undefined;
  browserToken: string | undefined;
  /** The shared Brain service. Absent = shadow Brain does not run, ever. */
  brainUrl: string | undefined;
  brainToken: string | undefined;
  scoutEnabled: boolean;
  /** Max USDG of COST that may sit in unpriceable positions at once. */
  scoutBudgetUsdg: number;
  /** Max USDG into any single unpriceable token. */
  scoutPerTokenUsdg: number;
  /** The class route. See MerrymenSettings.classSnipeEnabled — OFF by default. */
  classSnipeEnabled: boolean;
  classPerEntryUsdg: number;
  classMaxPositions: number;
  classMinDepthUsdg: number;
  /** The class EXIT. See MerrymenSettings.classMaxHoldSec — a clock, not a price. */
  classMaxHoldSec: number;
  classExitAtGraduationPct: number;
  /**
   * The platform's official coins. See MerrymenSettings.officialCoinsEnabled —
   * ON by default, and the only member of this block that is.
   */
  officialCoinsEnabled: boolean;
  strategistStopLossBps: number;
  takeProfitBps: number;
  buyPerTickUsdg: number;
  idleFloorUsdg: number;
  gapEnterBudgetUsdg: number;
  llmModel: string;
  llmIntervalMin: number;
  llmMaxActionUsdg: number;
  /** Wallet holding $MERRYMEN — sets the Merry Circle tier / fee discount. */
  holderAddress: `0x${string}` | undefined;
  /** Virtuals API key (secret) — streams agent activity to its Virtuals page. */
  virtualsApiKey: string | undefined;
  bitqueryApiKey: string | undefined;
  /** Merry Circle gateway token — opens the gateway brain AND its Bitquery route. */
  merrymenToken: string | undefined;
  /** Master switch for Virtuals Terminal streaming (off by default). */
  virtualsEnabled: boolean;
  telegramBotToken: string | undefined;
  telegramEnabled: boolean;
  telegramControlEnabled: boolean;
  telegramAllowlist: number[];
  telegramMaxActionUsdg: number;
  telegramTransferEnabled: boolean;
  telegramTransferDailyUsdg: number;
  telegramNotifyEnabled: boolean;
  telegramNotifyEveryMin: number;
  telegramDigestHour: number;
  /**
   * Telegram groups (docs/tg-groups.md "Settings"). Read live on every poll
   * like the rest of the Telegram block, so a dashboard change applies without
   * a restart. Off = silent in every group, while membership changes are
   * still recorded so turning it back on works.
   */
  telegramGroupsEnabled: boolean;
  /** Look at coins posted in a group (trencher mode only; a nomination, never an order). */
  telegramGroupCoinsEnabled: boolean;
  /** How often it joins a group conversation unprompted. */
  telegramGroupsChattiness: TelegramGroupsChattiness;
  telegramPcControlEnabled: boolean;
  telegramCapabilities: string[];
  telegramFilesRoot: string | undefined;
  telegramShellAllowlist: string[];
  telegramAppAllowlist: string[];
  telegramTranscribeKey: string | undefined;
  telegramTranscribeBase: string;
  /** /agent master switch (default off) — multi-step AI tasks on this PC. */
  telegramAgentEnabled: boolean;
  /** /agent may run non-allowlisted, non-destructive shell without confirm. */
  telegramAgentAutoShell: boolean;
  /** Model↔tool step budget per /agent task. */
  telegramAgentMaxSteps: number;
}

const KNOWN_SYMBOLS = new Set(STOCK_TOKENS.map((t) => t.symbol));

function str(file: unknown, env: string | undefined, fallback?: string): string | undefined {
  if (typeof file === "string" && file.trim() !== "") return file.trim();
  if (env !== undefined && env.trim() !== "") return env.trim();
  return fallback;
}

function num(file: unknown, env: string | undefined, fallback: number, min: number, max: number): number {
  const candidates = [typeof file === "number" ? file : undefined, env !== undefined ? Number(env) : undefined];
  for (const c of candidates) {
    if (c !== undefined && Number.isFinite(c) && c >= min && c <= max) return c;
  }
  return fallback;
}

function oneOf<T extends string>(
  file: unknown,
  env: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  if (typeof file === "string" && (allowed as readonly string[]).includes(file)) return file as T;
  if (env !== undefined && (allowed as readonly string[]).includes(env)) return env as T;
  return fallback;
}

/** file boolean > env ("1"/"true") > default. */
function bool(file: unknown, env: string | undefined, fallback: boolean): boolean {
  if (typeof file === "boolean") return file;
  if (env !== undefined) return env === "1" || env.toLowerCase() === "true";
  return fallback;
}

/** Numeric chat-ID allowlist; file array wins, else comma-separated env, else default. */
function numArray(file: unknown, env: string | undefined, fallback: number[]): number[] {
  if (Array.isArray(file)) {
    const ids = file.filter((n): n is number => typeof n === "number" && Number.isFinite(n));
    return ids;
  }
  if (env !== undefined && env.trim() !== "") {
    return env
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n));
  }
  return fallback;
}

/** String allowlist (capabilities, shell/app allowlists); file array wins, else
 * comma-separated env, else default. Non-empty trimmed strings only. */
export function strArray(file: unknown, env: string | undefined, fallback: string[]): string[] {
  if (Array.isArray(file)) {
    return file.filter((s): s is string => typeof s === "string" && s.trim() !== "").map((s) => s.trim());
  }
  if (env !== undefined && env.trim() !== "") {
    return env
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "");
  }
  return fallback;
}

/** Pure merge — exported for tests. `env` defaults to process.env at the call site. */
export function mergeSettings(
  file: MerrymenSettings,
  env: Record<string, string | undefined>,
): ResolvedConfig {
  const d = SETTINGS_DEFAULTS;
  const hosted = isHostedMode();

  // HOSTED: the house owns the connection/credential/endpoint fields. Drop them
  // from the tenant file so every `str(file.X, env.X)` below falls through to the
  // server env. Self-hosted (the default) is untouched — the file still wins.
  // The remote-execution flags are forced off further down (they are not house
  // keys, but a shell on our server is never a tenant's to enable).
  if (hosted) file = stripHouseKeys(file);

  const rawBreaker = str(file.breakerAddress, env.MERRYMEN_BREAKER_ADDRESS);
  const breakerAddress =
    rawBreaker && /^0x[0-9a-fA-F]{40}$/.test(rawBreaker) ? (rawBreaker as `0x${string}`) : undefined;

  const agentName = str(file.agentName, env.MERRYMEN_AGENT_NAME);
  const xHandle = str(file.xHandle, env.MERRYMEN_X_HANDLE);
  // Shape-checked before use, because a settings blob is data: a malformed
  // proof falls back to "unproven" rather than reaching the column as whatever
  // it happens to be. Same treatment holderProof gets in the orchestrator.
  const rawProof = file.xProof;
  const xProof =
    rawProof &&
    typeof rawProof === "object" &&
    typeof rawProof.handle === "string" &&
    /^[A-Za-z0-9_]{1,15}$/.test(rawProof.handle) &&
    typeof rawProof.at === "number"
      ? { handle: rawProof.handle, at: rawProof.at }
      : undefined;

  const rawAdapter = str(file.v4AdapterAddress, env.MERRYMEN_V4_ADAPTER_ADDRESS);
  const v4AdapterAddress =
    rawAdapter && /^0x[0-9a-fA-F]{40}$/.test(rawAdapter) ? (rawAdapter as `0x${string}`) : undefined;

  const rawPons = str(file.ponsAdapterAddress, env.MERRYMEN_PONS_ADAPTER_ADDRESS);
  const rawClassFactory = str(file.ponsClassVaultFactory, env.MERRYMEN_CLASS_VAULT_FACTORY);
  const ponsClassVaultFactory =
    rawClassFactory && /^0x[0-9a-fA-F]{40}$/.test(rawClassFactory)
      ? (rawClassFactory as `0x${string}`)
      : undefined;
  const ponsAdapterAddress =
    rawPons && /^0x[0-9a-fA-F]{40}$/.test(rawPons) ? (rawPons as `0x${string}`) : undefined;

  const rawHolder = str(file.holderAddress, env.MERRYMEN_HOLDER_ADDRESS);
  const holderAddress =
    rawHolder && /^0x[0-9a-fA-F]{40}$/.test(rawHolder) ? (rawHolder as `0x${string}`) : undefined;

  // Owner-added tokens. Shape-validated here (address/symbol/decimals) — depth
  // and manipulation checks happen on-chain at price time, and the grant still
  // has to be re-signed before any of these can actually be traded. Duplicates
  // and anything malformed are dropped silently rather than poisoning the set.
  //
  // Resolved BEFORE the basket, because the basket is allowed to name them.
  const seenTokens = new Set<string>();
  const customTokens = (Array.isArray(file.customTokens) ? file.customTokens : [])
    .filter(isValidCustomToken)
    .filter((t) => {
      const key = t.address.toLowerCase();
      if (seenTokens.has(key)) return false;
      seenTokens.add(key);
      return true;
    })
    .slice(0, 50); // a sane ceiling; every entry costs RPC reads per tick

  // A selected symbol may be a registry stock OR one of the owner's own tokens.
  // Filtering against the registry alone silently dropped every memecoin from
  // the basket here — so the strategy never got it as a leg no matter what the
  // owner selected, and nothing said why. The drop is still right for a symbol
  // that resolves to nothing at all; it is wrong for one the owner defined.
  const selectable = new Set([...KNOWN_SYMBOLS, ...customTokens.map((t) => t.symbol)]);
  const fileSymbols = Array.isArray(file.basketSymbols)
    ? file.basketSymbols.filter((s): s is string => typeof s === "string" && selectable.has(s))
    : [];
  const basketSymbols = fileSymbols.length > 0 ? fileSymbols : d.basketSymbols;

  return {
    bundlerApiKey: str(file.bundlerApiKey, env.MERRYMEN_BUNDLER_API_KEY),
    bundlerUrl: str(file.bundlerUrl, env.MERRYMEN_BUNDLER_URL),
    rpcMainnet: str(file.rpcMainnet, env.MERRYMEN_RPC_MAINNET),
    rpcTestnet: str(file.rpcTestnet, env.MERRYMEN_RPC_TESTNET),
    groqApiKey: str(file.groqApiKey, env.GROQ_API_KEY),
    groqModel: str(file.groqModel, env.MERRYMEN_GROQ_MODEL, d.groqModel)!,
    anthropicApiKey: str(file.anthropicApiKey, env.ANTHROPIC_API_KEY),
    llmProvider: str(file.llmProvider, env.MERRYMEN_LLM_PROVIDER),
    llmApiKey: str(file.llmApiKey, env.MERRYMEN_LLM_API_KEY),
    llmBaseUrl: str(file.llmBaseUrl, env.MERRYMEN_LLM_BASE_URL),
    llmProviderModel: str(file.llmProviderModel, env.MERRYMEN_LLM_PROVIDER_MODEL),
    rialtoApiKey: str(file.rialtoApiKey, env.MERRYMEN_RIALTO_API_KEY),
    rialtoApiKeyHeader: str(file.rialtoApiKeyHeader, env.MERRYMEN_RIALTO_API_KEY_HEADER, d.rialtoApiKeyHeader)!,
    breakerAddress,
    agentName,
    xHandle,
    xProof,
    v4AdapterAddress,
    ponsAdapterAddress,
    ponsClassVaultFactory,
    assetMode: oneOf(file.assetMode, env.MERRYMEN_ASSET_MODE, ["all", "stocks", "crypto"] as const, d.assetMode),
    autoConvertEnabled: bool(file.autoConvertEnabled, env.MERRYMEN_AUTO_CONVERT, d.autoConvertEnabled),
    autoConvertReservePct: num(file.autoConvertReservePct, env.MERRYMEN_AUTO_CONVERT_RESERVE_PCT, d.autoConvertReservePct, 1, 50),
    // Handoff fields: file only, no env (an env var that spends gas on every
    // boot is a footgun), no default (absent = no request). Shape-checked at
    // consume time, not here.
    manualSwapWei: str(file.manualSwapWei, undefined),
    manualSwapId: str(file.manualSwapId, undefined),
    paperTradingEnabled: bool(file.paperTradingEnabled, env.MERRYMEN_PAPER_TRADING, d.paperTradingEnabled),
    // NO ENVIRONMENT OVERRIDE, and the omission is the point.
    //
    // Every sibling here takes `env.MERRYMEN_*` as a middle term, which is right
    // for operational knobs: the house may set a bundler, a tick rate, a fee. It
    // is wrong for this one. `MERRYMEN_LIVE_TRADING=true` on the orchestrator
    // would be the house granting consent to spend real money on behalf of every
    // owner in the fleet simultaneously — the exact implicit promotion this
    // field was added to prevent, available as a single deploy variable.
    //
    // So consent is read from the tenant's OWN settings or not at all. `bool`
    // is still the reader, with `undefined` for the env slot, so an absent
    // field falls to the default (false) rather than to anything ambient.
    liveTradingEnabled: bool(file.liveTradingEnabled, undefined, d.liveTradingEnabled),
    // NOT a tenant setting and not in the file: this is an operator-controlled
    // migration state.
    //
    // IT USED TO READ `MERRYMEN_BACKFILL_LIVE_INTENT !== "report"`, so that
    // asking the migration to REPORT also switched the gate off. That was right
    // exactly once — before the migration had run, when the field was absent
    // fleet-wide and enforcing it would have moved every live agent to paper.
    //
    // After the migration it inverts into a hazard: the fleet now has 46 grant
    // tenants whose consent IS recorded, and re-running the report to check a
    // detail would quietly un-gate every one of them for the length of the run
    // — reopening the original bug (funding implying consent) as a side effect
    // of asking a read-only question. A dry run must not change behaviour; that
    // is the entire meaning of the word.
    //
    // So standing down is now its own deliberate act, on its own variable, and
    // `=report` is inert. Set this ONLY on a deployment whose owners have no
    // `liveTradingEnabled` recorded yet — a fresh self-hosted upgrade — and
    // remove it in the same session, as docs/live-trading-consent.md sets out.
    enforceLiveIntent: (env.MERRYMEN_LIVE_INTENT_STAND_DOWN ?? "").trim() !== "1",
    // THE ENERGY GATE, from the operator's environment and nowhere else — the
    // same shape as the line above. `file` is never consulted: a tenant must
    // not be able to switch off the throttle they are under, and a key in the
    // file would be exactly that. Off unless the operator says otherwise, and
    // off self-hosted whatever they say. Reaches hosted children through
    // childEnv; it is not a secret, so CHILD_SECRET_STRIP leaves it alone.
    energyGate: hosted ? energyModeOf(env.MERRYMEN_ENERGY_GATE) : "off",
    paperStartUsdg: num(file.paperStartUsdg, env.MERRYMEN_PAPER_START_USDG, d.paperStartUsdg, 1, 10_000_000),
    // Any sane token is a valid strategy name — builtins resolve directly,
    // everything else resolves to strategies/<name>.* (missing file = honest
    // no-trades with the reason in the event feed, decided at tick time).
    strategy: (() => {
      const v = str(file.strategy, env.MERRYMEN_STRATEGY);
      return v && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : d.strategy;
    })(),
    swapVenue: oneOf(file.swapVenue, env.MERRYMEN_SWAP_VENUE, ["uniswap", "rialto"], d.swapVenue),
    slippageBps: num(file.slippageBps, env.MERRYMEN_SLIPPAGE_BPS, d.slippageBps, 1, SLIPPAGE_BPS_MAX),
    // Floor of 0 is meaningful here: it turns the guard off. Ceiling of 10_000
    // is 100% impact, past which the number stops meaning anything.
    maxImpactBps: num(file.maxImpactBps, env.MERRYMEN_MAX_IMPACT_BPS, d.maxImpactBps, 0, 10_000),
    perfFeeBps: num(file.perfFeeBps, env.MERRYMEN_PERF_FEE_BPS, d.perfFeeBps, 0, 5_000),
    // Bounded well below the performance fee ceiling: this is charged on every
    // trade regardless of outcome, so the same number means something much
    // larger here. 500 bps of turnover would eat an account in a fortnight.
    tradeFeeBps: num(file.tradeFeeBps, env.MERRYMEN_TRADE_FEE_BPS, d.tradeFeeBps ?? 50, 0, 500),
    tradeFeeAddress: str(file.tradeFeeAddress, env.MERRYMEN_TRADE_FEE_ADDRESS),
    tickSeconds: num(file.tickSeconds, env.MERRYMEN_TICK_SECONDS, d.tickSeconds, 15, MAX_DECISION_INTERVAL_SEC),
    basketSymbols,
    customTokens,
    memecoinMinFdvUsd: num(file.memecoinMinFdvUsd, env.MERRYMEN_MEMECOIN_MIN_FDV_USD, d.memecoinMinFdvUsd ?? 0, 0, 1_000_000_000_000),
    minPoolLiquidityUsdg: num(file.minPoolLiquidityUsdg, env.MERRYMEN_MIN_POOL_LIQUIDITY_USDG, d.minPoolLiquidityUsdg, 0, 100_000_000),
    maxPriceDivergenceBps: num(file.maxPriceDivergenceBps, env.MERRYMEN_MAX_PRICE_DIVERGENCE_BPS, d.maxPriceDivergenceBps, 10, 10_000),
    discoveryEnabled: bool(file.discoveryEnabled, env.MERRYMEN_DISCOVERY_ENABLED, d.discoveryEnabled),
    discoveryIntervalMin: num(file.discoveryIntervalMin, env.MERRYMEN_DISCOVERY_INTERVAL_MIN, d.discoveryIntervalMin, 1, 1440),
    trencherLiveEnabled: bool(file.trencherLiveEnabled, env.MERRYMEN_TRENCHER_LIVE, d.trencherLiveEnabled),
    trencherFastEnabled: bool(file.trencherFastEnabled, env.MERRYMEN_TRENCHER_FAST, d.trencherFastEnabled),
    sponsorGasEnabled: bool(file.sponsorGasEnabled, env.MERRYMEN_SPONSOR_GAS, d.sponsorGasEnabled),
    sponsorshipPolicyId: str(file.sponsorshipPolicyId, env.MERRYMEN_SPONSORSHIP_POLICY_ID),
    depositScanEnabled: bool(file.depositScanEnabled, env.MERRYMEN_DEPOSIT_SCAN, d.depositScanEnabled),
    deskEnabled: bool(file.deskEnabled, env.MERRYMEN_DESK, d.deskEnabled),
    deskMaxSteps: num(file.deskMaxSteps, env.MERRYMEN_DESK_MAX_STEPS, d.deskMaxSteps, 1, 12),
    browserUrl: str(file.browserUrl, env.MERRYMEN_BROWSER_URL),
    browserToken: str(file.browserToken, env.MERRYMEN_BROWSER_TOKEN),
    brainUrl: str(file.brainUrl, env.MERRYMEN_BRAIN_URL),
    brainToken: str(file.brainToken, env.MERRYMEN_BRAIN_TOKEN),
    scoutEnabled: bool(file.scoutEnabled, env.MERRYMEN_SCOUT_ENABLED, d.scoutEnabled),
    scoutBudgetUsdg: num(file.scoutBudgetUsdg, env.MERRYMEN_SCOUT_BUDGET_USDG, d.scoutBudgetUsdg, 0, 1_000_000),
    scoutPerTokenUsdg: num(file.scoutPerTokenUsdg, env.MERRYMEN_SCOUT_PER_TOKEN_USDG, d.scoutPerTokenUsdg, 0, 1_000_000),
    classSnipeEnabled: bool(file.classSnipeEnabled, env.MERRYMEN_CLASS_SNIPE, d.classSnipeEnabled),
    classPerEntryUsdg: num(file.classPerEntryUsdg, env.MERRYMEN_CLASS_PER_ENTRY_USDG, d.classPerEntryUsdg, 0, 1_000_000),
    classMaxPositions: num(file.classMaxPositions, env.MERRYMEN_CLASS_MAX_POSITIONS, d.classMaxPositions, 0, 1_000),
    classMinDepthUsdg: num(file.classMinDepthUsdg, env.MERRYMEN_CLASS_MIN_DEPTH_USDG, d.classMinDepthUsdg, 0, 10_000_000),
    // FLOOR OF 60s, not 0. A zero hold window would sell every position on the
    // tick after it opened, turning the route into a fee pump; the exit exists
    // to bound a hold, not to forbid one.
    classMaxHoldSec: num(file.classMaxHoldSec, env.MERRYMEN_CLASS_MAX_HOLD_SEC, d.classMaxHoldSec, 60, 30 * 86_400),
    classExitAtGraduationPct: num(file.classExitAtGraduationPct, env.MERRYMEN_CLASS_EXIT_GRAD_PCT, d.classExitAtGraduationPct, 1, 100),
    officialCoinsEnabled: bool(file.officialCoinsEnabled, env.MERRYMEN_OFFICIAL_COINS, d.officialCoinsEnabled),
    // 0 disables it; the ceiling is 100x, past which it is not a take-profit
    // rule, it is a number nobody will ever hit.
    strategistStopLossBps: num(file.strategistStopLossBps, env.MERRYMEN_STRATEGIST_STOP_LOSS_BPS, d.strategistStopLossBps ?? 0, 0, 10_000),
    takeProfitBps: num(file.takeProfitBps, env.MERRYMEN_TAKE_PROFIT_BPS, d.takeProfitBps ?? 0, 0, 1_000_000),
    buyPerTickUsdg: num(file.buyPerTickUsdg, env.MERRYMEN_BUY_PER_TICK_USDG, d.buyPerTickUsdg, 1, 100_000),
    idleFloorUsdg: num(file.idleFloorUsdg, env.MERRYMEN_IDLE_FLOOR_USDG, d.idleFloorUsdg, 0, 1_000_000),
    gapEnterBudgetUsdg: num(file.gapEnterBudgetUsdg, env.MERRYMEN_GAP_BUDGET_USDG, d.gapEnterBudgetUsdg, 1, 1_000_000),
    llmModel: str(file.llmModel, env.MERRYMEN_LLM_MODEL, d.llmModel)!,
    llmIntervalMin: num(file.llmIntervalMin, env.MERRYMEN_LLM_INTERVAL_MIN, d.llmIntervalMin, 1, 1_440),
    llmMaxActionUsdg: num(file.llmMaxActionUsdg, env.MERRYMEN_LLM_MAX_ACTION_USDG, d.llmMaxActionUsdg, 1, 100_000),
    holderAddress,
    virtualsApiKey: str(file.virtualsApiKey, env.MERRYMEN_VIRTUALS_API_KEY),
    bitqueryApiKey: str(file.bitqueryApiKey, env.BITQUERY_API_KEY),
    merrymenToken: str(file.merrymenToken, env.MERRYMEN_TOKEN),
    virtualsEnabled: bool(file.virtualsEnabled, env.MERRYMEN_VIRTUALS_ENABLED, d.virtualsEnabled),
    telegramBotToken: str(file.telegramBotToken, env.MERRYMEN_TELEGRAM_BOT_TOKEN),
    telegramEnabled: bool(file.telegramEnabled, env.MERRYMEN_TELEGRAM_ENABLED, d.telegramEnabled),
    telegramControlEnabled: bool(file.telegramControlEnabled, env.MERRYMEN_TELEGRAM_CONTROL, d.telegramControlEnabled),
    telegramAllowlist: numArray(file.telegramAllowlist, env.MERRYMEN_TELEGRAM_ALLOWLIST, d.telegramAllowlist),
    telegramMaxActionUsdg: num(file.telegramMaxActionUsdg, env.MERRYMEN_TELEGRAM_MAX_ACTION_USDG, d.telegramMaxActionUsdg, 1, 100_000),
    telegramTransferEnabled: bool(file.telegramTransferEnabled, env.MERRYMEN_TELEGRAM_TRANSFER, d.telegramTransferEnabled),
    telegramTransferDailyUsdg: num(file.telegramTransferDailyUsdg, env.MERRYMEN_TELEGRAM_TRANSFER_DAILY_USDG, d.telegramTransferDailyUsdg, 1, 1_000_000),
    telegramNotifyEnabled: bool(file.telegramNotifyEnabled, env.MERRYMEN_TELEGRAM_NOTIFY, d.telegramNotifyEnabled),
    telegramNotifyEveryMin: num(file.telegramNotifyEveryMin, env.MERRYMEN_TELEGRAM_NOTIFY_EVERY_MIN, d.telegramNotifyEveryMin, 0, 1440),
    telegramDigestHour: num(file.telegramDigestHour, env.MERRYMEN_TELEGRAM_DIGEST_HOUR, d.telegramDigestHour, 0, 23),
    // Telegram groups. NOT forced off hosted, unlike the remote-execution block
    // below: talking in a group runs no shell and moves no money (its model
    // calls have their own daily allowance, docs/tg-groups.md rule 7), and a
    // coin posted there is a nomination the Brain and every trencher limit
    // still judge. A chattiness the resolver does not know (a typo, a level from
    // a newer build) falls back to "normal" rather than to anything louder.
    telegramGroupsEnabled: bool(file.telegramGroupsEnabled, env.MERRYMEN_TELEGRAM_GROUPS, d.telegramGroupsEnabled),
    telegramGroupCoinsEnabled: bool(file.telegramGroupCoinsEnabled, env.MERRYMEN_TELEGRAM_GROUP_COINS, d.telegramGroupCoinsEnabled),
    telegramGroupsChattiness: oneOf(file.telegramGroupsChattiness, env.MERRYMEN_TELEGRAM_GROUPS_CHATTINESS, TELEGRAM_GROUPS_CHATTINESS, d.telegramGroupsChattiness),
    // Remote-execution surface — FORCED OFF hosted, regardless of file or env.
    // Self-hosted these mean "a shell / PC control on the owner's own machine";
    // hosted they would mean "a shell on OUR server", with an allowlist the
    // attacker picked. The settings route also refuses to write them, and the
    // agent gate refuses to run them — this is the config-resolution boundary of
    // the same defence, the one that wins even for a value already on disk.
    telegramPcControlEnabled: hosted ? false : bool(file.telegramPcControlEnabled, env.MERRYMEN_TELEGRAM_PC_CONTROL, d.telegramPcControlEnabled),
    telegramCapabilities: hosted ? [] : strArray(file.telegramCapabilities, env.MERRYMEN_TELEGRAM_CAPABILITIES, d.telegramCapabilities),
    telegramFilesRoot: hosted ? undefined : str(file.telegramFilesRoot, env.MERRYMEN_TELEGRAM_FILES_ROOT),
    telegramShellAllowlist: hosted ? [] : strArray(file.telegramShellAllowlist, env.MERRYMEN_TELEGRAM_SHELL_ALLOWLIST, d.telegramShellAllowlist),
    telegramAppAllowlist: hosted ? [] : strArray(file.telegramAppAllowlist, env.MERRYMEN_TELEGRAM_APP_ALLOWLIST, d.telegramAppAllowlist),
    telegramTranscribeKey: str(file.telegramTranscribeKey, env.MERRYMEN_TELEGRAM_TRANSCRIBE_KEY),
    telegramTranscribeBase: str(file.telegramTranscribeBase, env.MERRYMEN_TELEGRAM_TRANSCRIBE_BASE, d.telegramTranscribeBase)!,
    telegramAgentEnabled: hosted ? false : bool(file.telegramAgentEnabled, env.MERRYMEN_TELEGRAM_AGENT, d.telegramAgentEnabled),
    telegramAgentAutoShell: hosted ? false : bool(file.telegramAgentAutoShell, env.MERRYMEN_TELEGRAM_AGENT_AUTOSHELL, d.telegramAgentAutoShell),
    telegramAgentMaxSteps: num(file.telegramAgentMaxSteps, env.MERRYMEN_TELEGRAM_AGENT_MAX_STEPS, d.telegramAgentMaxSteps, 1, 60),
  };
}

/** What one read of settings.json found. */
export type SettingsFileRead =
  | { kind: "parsed"; settings: MerrymenSettings }
  | { kind: "absent" }
  | { kind: "unusable"; why: string };

/**
 * WHERE a JSON.parse failed, and nothing else. V8 quotes the input in some of
 * these messages — `Unexpected token 'x', "{"telegramBotToken":"…" is not
 * valid JSON` — and settings.json holds plaintext keys, while `why` goes to the
 * console and the agent's event feed.
 *
 * Line and column are counted here from V8's "at position N" and the text that
 * was parsed, not read off the "(line N column M)" V8 appends on some Node
 * versions: CI runs 22, and the wording is V8's to change.
 */
function whereParseFailed(e: unknown, text: string): string {
  const msg = e instanceof Error ? e.message : "";
  const at = /\bat position (\d+)\b/.exec(msg);
  if (at) {
    const pos = Math.min(Number(at[1]), text.length);
    const before = text.slice(0, pos);
    return ` (line ${before.split("\n").length}, column ${pos - before.lastIndexOf("\n")})`;
  }
  if (/Unexpected end of JSON input/.test(msg)) return " (it ends early: empty, or cut short)";
  return "";
}

/** Read settings.json and say what is there. Remembers nothing — see settingsSource. */
export function readSettingsFileAt(file: string): SettingsFileRead {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "absent" };
    return { kind: "unusable", why: `settings.json could not be read (${code ?? "unknown error"})` };
  }
  let parsed: unknown;
  // BOM-strip: editors and PowerShell write UTF-8 BOMs that break JSON.parse.
  const text = raw.replace(/^\ufeff/, "");
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { kind: "unusable", why: `settings.json is not valid JSON${whereParseFailed(e, text)}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "unusable", why: "settings.json is not a JSON object" };
  }
  return { kind: "parsed", settings: parsed as MerrymenSettings };
}

/** A settings.json this process could not use, and what it runs on instead. */
export interface SettingsProblem {
  /** Why, as of the latest read. Never quotes the file (whereParseFailed). */
  why: string;
  /** When this run of unusable reads began (ms): one run, one notice. */
  since: number;
  /**
   * TRUE: an earlier read in this process was usable, and those settings stay
   * in force. FALSE: none has been — what is in force is env + defaults, which
   * nobody chose, and a worker does not arm on them (settingsArmRefusal).
   */
  holding: boolean;
}

export interface SettingsSource {
  /** The settings in force: this read's, or the last usable read's when this one is not. */
  read(): MerrymenSettings;
  problem(): SettingsProblem | null;
}

/**
 * ONE settings.json, remembered across reads.
 *
 * A MISSING FILE IS NOT A BROKEN ONE. Missing means "no overrides", as it
 * always has — an owner who deletes the file is choosing the defaults, and a
 * fresh install has none yet. A file that is there but cannot be used used to
 * mean exactly the same thing: `resolveConfig` caught everything and the tick
 * ran on env + defaults — paper, steady-basket, an empty Telegram allowlist.
 * Hosted, the orchestrator's atomic write leaves nothing to trip on; self-hosted
 * a stray comma in a hand edit did it, silently, with the owner believing their
 * settings were in force. So an unusable read now keeps the last usable one and
 * says so once; and a process that has never had a usable read says it is
 * running on nobody's settings, and the worker declines to arm on them.
 */
export function settingsSource(
  file: string,
  now: () => number = Date.now,
  warn: (line: string) => void = (line) => console.warn(line),
): SettingsSource {
  let lastGood: MerrymenSettings | null = null;
  let problem: SettingsProblem | null = null;
  return {
    read() {
      const r = readSettingsFileAt(file);
      if (r.kind !== "unusable") {
        if (problem) warn("[settings] settings.json is usable again — applied");
        problem = null;
        lastGood = r.kind === "parsed" ? r.settings : {};
        return lastGood;
      }
      if (problem) {
        problem = { ...problem, why: r.why };
      } else {
        problem = { why: r.why, since: now(), holding: lastGood !== null };
        warn(
          problem.holding
            ? `[settings] ${r.why} — keeping the settings last read from it`
            : `[settings] ${r.why} — nothing usable has been read from it since this process started: ` +
                `running on env + defaults, and a worker will not arm on them`,
        );
      }
      return lastGood ?? {};
    },
    problem: () => problem,
  };
}

/**
 * Keyed by path. MERRYMEN_SETTINGS_FILE is read on every call, and one process
 * can be pointed at more than one file (tests do it constantly) — a last good
 * parse of one file must never stand in for another.
 */
const sources = new Map<string, SettingsSource>();
function currentSource(): SettingsSource {
  const file = process.env.MERRYMEN_SETTINGS_FILE ?? homePaths.settings();
  let source = sources.get(file);
  if (!source) {
    source = settingsSource(file);
    sources.set(file, source);
  }
  return source;
}

/**
 * Read + merge. A missing file is "no overrides"; a file that is there but
 * unusable keeps the last usable read (settingsSource), and settingsProblem()
 * says so.
 */
export function resolveConfig(): ResolvedConfig {
  return mergeSettings(currentSource().read(), process.env);
}

/** What is wrong with the settings file resolveConfig reads, or null. */
export function settingsProblem(): SettingsProblem | null {
  return currentSource().problem();
}

/**
 * Why a worker will not arm, in the owner's words — or null when it may.
 *
 * Only when NOTHING usable has been read since the process started. With a
 * last good read in force the agent carries on with it (settingsHoldNotice):
 * stopping a running agent over a typo would turn an edit into an outage.
 */
export function settingsArmRefusal(p: SettingsProblem | null, hosted = isHostedMode()): string | null {
  if (!p || p.holding) return null;
  return (
    `this agent is NOT TRADING: ${p.why}, and nothing usable has been read from it since this worker started. ` +
    `Rather than trade on settings nobody chose (paper, the default strategy, an empty Telegram allowlist), it will not start. ` +
    (hosted
      ? "The file is ours, not yours: it is rewritten from your saved settings within a minute, and the agent starts on the tick after."
      : "Fix the file, or remove it to run on the defaults on purpose; the agent starts on the first tick after that.")
  );
}

/**
 * What to tell the owner while a last good read is in force — once per run of
 * unusable reads, and once more when the file is usable again. `told` is the
 * `since` of the run already announced, or null.
 */
export function settingsHoldNotice(
  p: SettingsProblem | null,
  told: number | null,
  hosted = isHostedMode(),
): { told: number | null; event: { level: "warn" | "ok"; message: string } | null } {
  if (p?.holding) {
    if (told === p.since) return { told, event: null };
    return {
      told: p.since,
      event: {
        level: "warn",
        message:
          `${p.why}. This agent keeps running on the settings it last read from it, so nothing changed in the file since then has taken effect. ` +
          (hosted
            ? "The file is ours, not yours: it is rewritten from your saved settings within a minute."
            : "Fix the file; the first tick after it parses applies it."),
      },
    };
  }
  if (!p && told !== null) {
    return { told: null, event: { level: "ok", message: "settings.json is usable again — its settings are in force" } };
  }
  return { told, event: null };
}

/**
 * Merge a patch into settings.json and write it back — used by the Telegram
 * control commands to change strategy/cap/allowlist. The worker re-reads the
 * file on its next tick, so the change applies without a restart. Returns the
 * merged object.
 *
 * A FILE THAT IS THERE BUT DOES NOT PARSE IS REFUSED, NOT REPLACED. The merge
 * used to read that file as `{}` (as resolveConfig did) — so the write-back
 * held the patch and nothing else, and every other key (strategy, keys, the
 * holder wallet) was gone. A torn read of a concurrent write did exactly that,
 * and self-hosted so does a hand edit with a stray comma; there it is the only
 * copy. Throws instead, and the Telegram command says it failed.
 */
export function patchSettingsFile(patch: Partial<MerrymenSettings>): MerrymenSettings {
  const file = process.env.MERRYMEN_SETTINGS_FILE ?? homePaths.settings();
  const read = readSettingsFileAt(file);
  if (read.kind === "unusable") throw new Error(`${read.why} — not overwriting it; fix or remove it first`);
  const current = read.kind === "parsed" ? read.settings : {};
  const next = { ...current, ...patch };
  ensureHome();
  // settings.json holds plaintext API keys — owner-only perms (0600), set on the
  // temp file before it is renamed into place. Atomic: the worker re-reads this
  // file every tick, and a truncate-then-write would hand it the defaults.
  writeFileAtomicSync(file, JSON.stringify(next, null, 2), 0o600);
  return next;
}

/** Fingerprint of fields that require re-arming the executor when changed. */
export function connectionKey(cfg: ResolvedConfig): string {
  // SPONSORSHIP BELONGS IN THE FINGERPRINT. The paymaster attaches inside
  // createAgentExecutor, which is rebuilt only when this changes — so without
  // these two the toggle saves, reports ok, and does nothing until a restart.
  return [
    cfg.bundlerApiKey,
    cfg.bundlerUrl,
    cfg.rpcMainnet,
    cfg.rpcTestnet,
    String(cfg.sponsorGasEnabled),
    cfg.sponsorshipPolicyId ?? "",
  ].join("|");
}

/**
 * Bundler URLs from Pimlico/Alchemy embed the chain id in the path (…/v2/46630/rpc)
 * or a query param. If the URL names a Robinhood chain id that ISN'T the grant's,
 * every UserOp will fail with opaque errors — warn loudly at arm time.
 * Heuristic and advisory only: returns the mismatched id found in the URL, or
 * null when the URL is absent, matches, or names no known chain id.
 */
export function bundlerChainMismatch(bundlerUrl: string | undefined, grantChainId: number): number | null {
  if (!bundlerUrl) return null;
  const ids = [...bundlerUrl.matchAll(/(?:\/|=)(4663|46630)(?:\/|$|&|\?)/g)].map((m) => Number(m[1]));
  if (ids.length === 0) return null;
  // 4663 is a substring of 46630 — the regex boundaries prevent that collision.
  return ids.every((id) => id === grantChainId) ? null : ids.find((id) => id !== grantChainId)!;
}

/** Fingerprint of Telegram fields — the poller restarts when this changes. */
export function telegramKey(cfg: ResolvedConfig): string {
  return [
    cfg.telegramBotToken ?? "",
    cfg.telegramEnabled ? "on" : "off",
    cfg.telegramControlEnabled ? "control" : "readonly",
    cfg.telegramAllowlist.join(","),
    cfg.telegramMaxActionUsdg,
    cfg.telegramTransferEnabled ? "transfer" : "notransfer",
    cfg.telegramNotifyEnabled ? "notify" : "quiet",
    cfg.telegramDigestHour,
    cfg.telegramAgentEnabled ? "agent" : "",
    cfg.telegramAgentAutoShell ? "autoshell" : "",
    // brain fingerprint: provider selection + any key presence flips the poller
    cfg.llmProvider ?? "",
    cfg.llmApiKey ? "k" : "",
    cfg.anthropicApiKey ? "llm" : cfg.groqApiKey ? "groq" : "nollm",
  ].join("|");
}

/** Fingerprint of fields that require rebuilding the strategy when changed. */
export function strategyKey(cfg: ResolvedConfig): string {
  return [
    cfg.strategy,
    cfg.swapVenue,
    cfg.basketSymbols.join(","),
    // Owner-added tokens are part of the watch set, so a change here has to
    // rebuild it — otherwise a token added mid-run is never read or priced until
    // the next restart, and the owner sees nothing happen.
    cfg.customTokens.map((t) => `${t.symbol}:${t.address.toLowerCase()}:${t.decimals}`).join(","),
    // WITHOUT THIS THE SETTING IS INERT. `watchTokens` and the strategy are only
    // rebuilt when this key changes, so a mode the owner flips would do nothing
    // until some other strategy field happened to move.
    cfg.assetMode,
    // AND `officialCoinsEnabled` WAS ALREADY IN THAT STATE — a pre-existing bug
    // found while adding the line above. Its own doc promises that turning it
    // off "removes the listings from the watch set entirely", and the rebuild
    // that would do so sits behind this key. Masked only because
    // OFFICIAL_COINS[4663] is empty, so there has been nothing to remove.
    cfg.officialCoinsEnabled,
    cfg.buyPerTickUsdg,
    cfg.idleFloorUsdg,
    cfg.gapEnterBudgetUsdg,
    // key/provider text included: rotating a key or switching brains rebuilds the driver
    cfg.llmProvider ?? "",
    cfg.llmApiKey ?? "",
    cfg.llmBaseUrl ?? "",
    cfg.llmProviderModel ?? "",
    cfg.anthropicApiKey ?? "",
    cfg.groqApiKey ?? "",
    cfg.groqModel,
    cfg.llmModel,
    cfg.llmIntervalMin,
    cfg.trencherFastEnabled,
    cfg.llmMaxActionUsdg,
    // BAKED INTO THE STRATEGY WHEN IT IS BUILT (makeStrategy), so without them
    // here a change looked saved and did nothing until a restart. Chat can now
    // change the first two, which is how it was noticed.
    cfg.takeProfitBps,
    cfg.strategistStopLossBps,
    cfg.deskEnabled,
    cfg.deskMaxSteps,
  ].join("|");
}
