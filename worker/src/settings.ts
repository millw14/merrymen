/**
 * Settings resolution for the worker: settings file > env var > default.
 * The file is re-read every tick (cheap; it's tiny) so changes made in the
 * web UI apply without a restart. `configKey()` fingerprints the connection
 * fields — when it changes, the runner drops the armed agent and re-arms with
 * the new bundler/RPC; trading fields rebuild the strategy in place.
 */

import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import {
  HOUSE_KEY_FIELDS,
  PERPS_DRIVERS,
  isPerpsStyle,
  type PerpsStyleId,
  PERPS_LIVE_CONSENT_VERSION,
  PERPS_MARKETS_MAX,
  SETTINGS_DEFAULTS,
  SLIPPAGE_BPS_MAX,
  STOCK_TOKENS,
  TELEGRAM_GROUPS_CHATTINESS,
  isHostedMode,
  isPerpKey,
  isValidCustomToken,
  perpsNumberOk,
  type CustomToken,
  type MerrymenSettings,
  type PerpKey,
  type PerpsDriver,
  type PerpsNumKey,
  type TelegramGroupsChattiness,
} from "../../packages/core/src/index";
import { ensureHome, homePaths } from "./home";
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

  // ── perpetuals (docs/perps.md "Settings", rule 1) ────────────────────────
  //
  // Every owner field below is read from the tenant's OWN settings file or not
  // at all — no env term. The last three are the operator's, from env only,
  // and can only ever take capability away. NONE of this decides whether EXITS
  // run: venue state does (rule 8a), whatever these say.
  //
  // UNITS AS STORED: USDG and percentages on a 0.01 grid, leverage, counts and
  // bps whole (core PERPS_NUM_BOUNDS). So `BigInt(Math.round(usdg * 100)) *
  // 10_000n` is exact micro-USDG and `Math.round(pct * 100)` exact bps — convert
  // that way and no cap has to pick a rounding direction.
  /** The owner's paper switch. */
  perpsEnabled: boolean;
  /**
   * The owner's REAL-MONEY consent, EFFECTIVE: true only when the stored switch
   * is on AND its consent is complete and current (version ===
   * PERPS_LIVE_CONSENT_VERSION, region attested, stamped). A switch left on
   * under an older consent text reads false here — see perpsLiveConsentStale.
   *
   * NOT the operator's word: it does not include the operator ceiling, which
   * depends on the smart account (perpsCeilingFor). Live perps need both.
   */
  perpsLiveEnabled: boolean;
  /**
   * The owner switched real perps on, but the consent on file is incomplete or
   * for an older text. The status says "re-confirm in Settings", never "off":
   * the owner did choose it, and must be told why it is not in force.
   */
  perpsLiveConsentStale: boolean;
  perpsLiveConsentVersion: number | null;
  /** Unix ms the consent was stamped by the settings PUT; null = none on file. */
  perpsLiveConsentAt: number | null;
  perpsRegionAttested: boolean;
  perpsDriver: PerpsDriver;
  perpsStyle: PerpsStyleId;
  /** Markets the agent may OPEN in. May be EMPTY (see the resolver) — never widened to a default. */
  perpsMarkets: PerpKey[];
  perpsMaxLeverage: number;
  perpsPerTradeUsdg: number;
  perpsMaxOpenNotionalUsdg: number;
  perpsMaxCollateralUsdg: number;
  perpsMaxOpensPerDay: number;
  perpsStopLossPct: number;
  perpsStopSlipBps: number;
  perpsTakeProfitPct: number;
  perpsLiqBufferPct: number;
  perpsMaxSlippageBps: number;
  /**
   * MERRYMEN_PERPS — the most this deployment allows before the tenant
   * allowlist is applied. Use perpsCeilingFor(cfg, smartAccount), never this
   * alone, to decide whether an account may open live.
   */
  perpsOperatorCeiling: PerpsCeiling;
  /**
   * MERRYMEN_PERPS_LIVE_TENANTS, lowercased smart accounts. HOSTED ONLY: an
   * array (empty = nobody live) hosted, null self-hosted, where the one owner
   * on the box needs nobody's list.
   */
  perpsLiveTenants: readonly `0x${string}`[] | null;
  /** MERRYMEN_HALT_PERP_ENTRIES — no opens anywhere; exits and protection keep running. */
  perpsEntriesHalted: boolean;
}

/**
 * How far the operator lets perps go, weakest first. An operator lever, so it
 * restricts and never grants: "live" here still needs the owner's own consent
 * and a perps grant; it only stops the deployment being what says no.
 */
export const PERPS_CEILINGS = ["off", "paper", "live"] as const;
export type PerpsCeiling = (typeof PERPS_CEILINGS)[number];

/**
 * MERRYMEN_PERPS, read restrict-only.
 *
 * Unset means the tier's default: PAPER hosted — the house does not operate
 * live Lighter orders for tenants until the decision in docs/perps.md
 * ("Decisions that need Milla") is written and MERRYMEN_PERPS_LIVE_TENANTS
 * names them — and LIVE self-hosted, where the owner is the operator and their
 * own consent is the gate. Anything it does not recognise is OFF: a typo in a
 * variable that exists to take capability away must not hand it back, and
 * "Live" mistyped as "lvie" meaning live would be exactly that.
 */
function perpsCeilingOf(raw: string | undefined, hosted: boolean): PerpsCeiling {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "") return hosted ? "paper" : "live";
  return (PERPS_CEILINGS as readonly string[]).includes(v) ? (v as PerpsCeiling) : "off";
}

/**
 * MERRYMEN_PERPS_LIVE_TENANTS, hosted only. An entry that is not an address
 * can never match an account, so dropping it removes nothing but itself.
 */
function perpsLiveTenantsOf(raw: string | undefined, hosted: boolean): readonly `0x${string}`[] | null {
  if (!hosted) return null;
  const out = new Set<`0x${string}`>();
  for (const part of (raw ?? "").split(",")) {
    const a = part.trim().toLowerCase();
    if (/^0x[0-9a-f]{40}$/.test(a)) out.add(a as `0x${string}`);
  }
  return [...out].sort();
}

/**
 * MERRYMEN_HALT_PERP_ENTRIES, read so that only an explicit "no" is no. Its
 * documented form is `=1`; an operator who writes `=yes` or `=halt` in an
 * incident means halt, and a restrict-only switch that failed open on spelling
 * would fail at the one moment it is reached for.
 */
function perpsEntriesHaltedOf(raw: string | undefined): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  return !(v === "" || v === "0" || v === "false" || v === "no" || v === "off");
}

/**
 * The most an account may do with perps, as far as the OPERATOR is concerned:
 * MERRYMEN_PERPS, then, hosted, the live allowlist. `smartAccount` is the
 * account the grant trades from (grant.smartAccount — never the SIWE tenant,
 * which is a different address). Unknown account hosted = not on the list.
 *
 * Opens only. It never stands between a live venue account and its exits.
 */
export function perpsCeilingFor(
  cfg: Pick<ResolvedConfig, "perpsOperatorCeiling" | "perpsLiveTenants">,
  smartAccount: string | null | undefined,
): PerpsCeiling {
  if (cfg.perpsOperatorCeiling !== "live") return cfg.perpsOperatorCeiling;
  if (cfg.perpsLiveTenants === null) return "live";
  const a = (smartAccount ?? "").trim().toLowerCase();
  return a !== "" && (cfg.perpsLiveTenants as readonly string[]).includes(a) ? "live" : "paper";
}

/**
 * A perps number from the FILE ONLY: the value when it is in bounds and on the
 * grid, else the default — the house's reading of a bad value (`num()` does
 * the same). Never the nearest bound: a leverage of 50 does not mean "as much
 * as allowed". The PUT refuses anything this would discard, so only a
 * hand-edited or older file ever reaches it.
 */
function perpsNum(file: MerrymenSettings, key: PerpsNumKey): number {
  const v = file[key];
  return perpsNumberOk(key, v) ? v : SETTINGS_DEFAULTS[key];
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

  // ── perpetuals ──────────────────────────────────────────────────────────
  // NO ENVIRONMENT TERM FOR ANY OWNER FIELD — `undefined` in every env slot,
  // the liveTradingEnabled reasoning above applied to a whole block. A
  // `MERRYMEN_PERPS_LIVE=1` on the orchestrator would be the house consenting
  // to leverage for every owner in the fleet at once; a `MERRYMEN_PERPS_MAX_
  // LEVERAGE` would be the house raising every owner's risk. settings.test.ts
  // sets such variables and asserts nothing moves.
  //
  // THE CONSENT IS A RECORD, NOT A SWITCH. The switch counts only with the
  // version the owner agreed to being the current one, the regional
  // attestation, and the stamp the PUT writes. Any part missing is no consent:
  // a partial record is how a client that sent only `perpsLiveEnabled: true`
  // — an old build, a scripted PUT — would otherwise have turned leverage on.
  const liveAsked = file.perpsLiveEnabled === true;
  const consentVersion =
    typeof file.perpsLiveConsentVersion === "number" && Number.isSafeInteger(file.perpsLiveConsentVersion) && file.perpsLiveConsentVersion >= 1
      ? file.perpsLiveConsentVersion
      : null;
  const consentAt =
    typeof file.perpsLiveConsentAt === "number" && Number.isSafeInteger(file.perpsLiveConsentAt) && file.perpsLiveConsentAt > 0
      ? file.perpsLiveConsentAt
      : null;
  const regionAttested = file.perpsRegionAttested === true;
  const perpsLiveEnabled = liveAsked && consentVersion === PERPS_LIVE_CONSENT_VERSION && regionAttested && consentAt !== null;

  // MARKETS FAIL CLOSED, NOT TO THE DEFAULT. The PUT refuses unknown keys, so
  // a bad entry here means a hand-edited or damaged file — and falling back to
  // BTC and ETH would open markets the owner never picked, which is the
  // opposite of what an owner who named ["SOL-PERP", "typo"] asked for. So:
  // unknown and duplicate keys are dropped, what the owner did name is kept in
  // their order up to the cap, and a list that names nothing valid resolves to
  // NO markets (no opens; exits never consult this). Only an ABSENT field takes
  // the default.
  let perpsMarkets: PerpKey[];
  if (Array.isArray(file.perpsMarkets)) {
    const seen = new Set<string>();
    perpsMarkets = [];
    for (const k of file.perpsMarkets) {
      if (!isPerpKey(k) || seen.has(k)) continue;
      seen.add(k);
      perpsMarkets.push(k);
    }
    perpsMarkets = perpsMarkets.slice(0, PERPS_MARKETS_MAX);
  } else {
    perpsMarkets = (d.perpsMarkets as string[]).filter(isPerpKey);
  }

  // A DRIVER THIS BUILD DOES NOT KNOW IS `manual`, NOT THE DEFAULT. Absent is
  // the contract's default (perp-trend). Present but unrecognised — a newer
  // build's value, a damaged file — must not become an autonomous producer the
  // owner never chose; `manual` produces nothing on its own.
  const perpsStyle = isPerpsStyle(file.perpsStyle) ? file.perpsStyle : d.perpsStyle;
  const invalidStyle = file.perpsStyle !== undefined && !isPerpsStyle(file.perpsStyle);
  const perpsDriver: PerpsDriver = invalidStyle ? "manual" :
    file.perpsDriver === undefined
      ? d.perpsDriver
      : (PERPS_DRIVERS as readonly string[]).includes(file.perpsDriver as string)
        ? (file.perpsDriver as PerpsDriver)
        : "manual";

  // THE PER-TRADE CAP NEVER EXCEEDS THE OPEN-NOTIONAL CAP. The PUT refuses the
  // inversion; a file that holds one anyway is read in the restrictive
  // direction — one open can never be larger than all opens together, so the
  // smaller number is the only one that could ever bind.
  const perpsMaxOpenNotionalUsdg = perpsNum(file, "perpsMaxOpenNotionalUsdg");
  const perpsPerTradeUsdg = Math.min(perpsNum(file, "perpsPerTradeUsdg"), perpsMaxOpenNotionalUsdg);

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
    perpsEnabled: bool(file.perpsEnabled, undefined, d.perpsEnabled),
    perpsLiveEnabled,
    perpsLiveConsentStale: liveAsked && !perpsLiveEnabled,
    perpsLiveConsentVersion: consentVersion,
    perpsLiveConsentAt: consentAt,
    perpsRegionAttested: regionAttested,
    perpsDriver,
    perpsStyle,
    perpsMarkets,
    perpsMaxLeverage: perpsNum(file, "perpsMaxLeverage"),
    perpsPerTradeUsdg,
    perpsMaxOpenNotionalUsdg,
    perpsMaxCollateralUsdg: perpsNum(file, "perpsMaxCollateralUsdg"),
    perpsMaxOpensPerDay: perpsNum(file, "perpsMaxOpensPerDay"),
    perpsStopLossPct: perpsNum(file, "perpsStopLossPct"),
    perpsStopSlipBps: perpsNum(file, "perpsStopSlipBps"),
    perpsTakeProfitPct: perpsNum(file, "perpsTakeProfitPct"),
    perpsLiqBufferPct: perpsNum(file, "perpsLiqBufferPct"),
    perpsMaxSlippageBps: perpsNum(file, "perpsMaxSlippageBps"),
    // THE OPERATOR'S THREE, from env ONLY and restrict-only — the energyGate
    // shape: `file` is never consulted, so a tenant can neither lift a ceiling
    // they are under nor halt someone else's entries. They reach hosted
    // children through childEnv like MERRYMEN_ENERGY_GATE (not secrets, so
    // CHILD_SECRET_STRIP leaves them alone).
    perpsOperatorCeiling: perpsCeilingOf(env.MERRYMEN_PERPS, hosted),
    perpsLiveTenants: perpsLiveTenantsOf(env.MERRYMEN_PERPS_LIVE_TENANTS, hosted),
    perpsEntriesHalted: perpsEntriesHaltedOf(env.MERRYMEN_HALT_PERP_ENTRIES),
  };
}

/** Read + merge. A missing or corrupt file is just "no overrides". */
export function resolveConfig(): ResolvedConfig {
  const SETTINGS_FILE = process.env.MERRYMEN_SETTINGS_FILE ?? homePaths.settings();
  let file: MerrymenSettings = {};
  try {
    // BOM-strip: editors and PowerShell write UTF-8 BOMs that break JSON.parse.
    file = JSON.parse(readFileSync(SETTINGS_FILE, "utf8").replace(/^﻿/, "")) as MerrymenSettings;
  } catch {
    // no settings file yet — env + defaults
  }
  return mergeSettings(file ?? {}, process.env);
}

/** Read the raw settings file (unresolved), tolerating BOM/missing. */
export function readSettingsFile(): MerrymenSettings {
  const file = process.env.MERRYMEN_SETTINGS_FILE ?? homePaths.settings();
  try {
    return JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")) as MerrymenSettings;
  } catch {
    return {};
  }
}

/**
 * Merge a patch into settings.json and write it back — used by the Telegram
 * control commands to change strategy/cap/allowlist. The worker re-reads the
 * file on its next tick, so the change applies without a restart. Returns the
 * merged object.
 */
export function patchSettingsFile(patch: Partial<MerrymenSettings>): MerrymenSettings {
  const file = process.env.MERRYMEN_SETTINGS_FILE ?? homePaths.settings();
  const next = { ...readSettingsFile(), ...patch };
  ensureHome();
  // settings.json holds plaintext API keys — owner-only perms (0600).
  writeFileSync(file, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* non-POSIX / already tight — best effort */
  }
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
    // WHAT THE STRATEGIST IS BUILT TO SAY ABOUT PERPS. Its perpActions schema
    // and prompt exist only while perps are on and it is the driver, and name
    // the owner's markets (docs/perps.md "The perps route") — all baked in when
    // the strategy is built, so without these a switch flipped on the dashboard
    // would leave the strategist blind to it, or still proposing after it was
    // turned off, until a restart. The rest of the perps block is perpsKey's.
    cfg.perpsEnabled,
    cfg.perpsDriver,
    cfg.perpsStyle,
    cfg.perpsMarkets.join(","),
  ].join("|");
}

/**
 * Fingerprint of EVERY perps field — the perp route rebuilds (and re-reads its
 * markets, caps and driver) when this changes.
 *
 * ALL OF THEM, including the ones a tick could read live, because the failure
 * this guards against is the one strategyKey's notes keep recording: a field
 * baked in somewhere, missing from the key, that "looked saved and did nothing
 * until a restart". For a cap that is not a nuisance, it is an owner lowering
 * their leverage and the agent opening at the old one. A rebuild on a field
 * that did not need one costs nothing; a missing one costs exactly that.
 *
 * The consent record and the operator's levers are in it too: turning live off
 * (or the operator restricting) must take effect at once, not at the next
 * unrelated change.
 */
export function perpsKey(cfg: ResolvedConfig): string {
  return [
    cfg.perpsEnabled,
    cfg.perpsLiveEnabled,
    cfg.perpsLiveConsentStale,
    cfg.perpsLiveConsentVersion ?? "",
    cfg.perpsLiveConsentAt ?? "",
    cfg.perpsRegionAttested,
    cfg.perpsDriver,
    cfg.perpsStyle,
    cfg.perpsMarkets.join(","),
    cfg.perpsMaxLeverage,
    cfg.perpsPerTradeUsdg,
    cfg.perpsMaxOpenNotionalUsdg,
    cfg.perpsMaxCollateralUsdg,
    cfg.perpsMaxOpensPerDay,
    cfg.perpsStopLossPct,
    cfg.perpsStopSlipBps,
    cfg.perpsTakeProfitPct,
    cfg.perpsLiqBufferPct,
    cfg.perpsMaxSlippageBps,
    cfg.perpsOperatorCeiling,
    cfg.perpsLiveTenants === null ? "self-hosted" : cfg.perpsLiveTenants.join(","),
    cfg.perpsEntriesHalted,
  ].join("|");
}
