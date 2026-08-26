/**
 * Settings resolution for the worker: settings file > env var > default.
 * The file is re-read every tick (cheap; it's tiny) so changes made in the
 * web UI apply without a restart. `configKey()` fingerprints the connection
 * fields — when it changes, the runner drops the armed agent and re-arms with
 * the new bundler/RPC; trading fields rebuild the strategy in place.
 */

import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import {
  SETTINGS_DEFAULTS,
  STOCK_TOKENS,
  isValidCustomToken,
  type CustomToken,
  type MerrymenSettings,
} from "../../packages/core/src/index";
import { ensureHome, homePaths } from "./home";

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
  paperTradingEnabled: boolean;
  paperStartUsdg: number;
  /** Builtin name, or a user strategy filename (strategies/<name>.ts). */
  strategy: string;
  swapVenue: "uniswap" | "rialto";
  slippageBps: number;
  maxImpactBps: number;
  perfFeeBps: number;
  tickSeconds: number;
  basketSymbols: string[];
  /** Owner-added ERC-20s (memecoins). Shape-checked; still gated by the grant. */
  customTokens: CustomToken[];
  /** USD depth below which a token is refused a price (manipulation guard). */
  minPoolLiquidityUsdg: number;
  /** Spot-vs-TWAP band, bps, above which a price is refused. */
  maxPriceDivergenceBps: number;
  /** Poll Bitquery for new pairs and report them. Never trades. */
  discoveryEnabled: boolean;
  discoveryIntervalMin: number;
  /** Scout mode: may the agent buy tokens it cannot price? Off by default. */
  scoutEnabled: boolean;
  /** Max USDG of COST that may sit in unpriceable positions at once. */
  scoutBudgetUsdg: number;
  /** Max USDG into any single unpriceable token. */
  scoutPerTokenUsdg: number;
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

  const rawBreaker = str(file.breakerAddress, env.MERRYMEN_BREAKER_ADDRESS);
  const breakerAddress =
    rawBreaker && /^0x[0-9a-fA-F]{40}$/.test(rawBreaker) ? (rawBreaker as `0x${string}`) : undefined;

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
    paperTradingEnabled: bool(file.paperTradingEnabled, env.MERRYMEN_PAPER_TRADING, d.paperTradingEnabled),
    paperStartUsdg: num(file.paperStartUsdg, env.MERRYMEN_PAPER_START_USDG, d.paperStartUsdg, 1, 10_000_000),
    // Any sane token is a valid strategy name — builtins resolve directly,
    // everything else resolves to strategies/<name>.* (missing file = honest
    // no-trades with the reason in the event feed, decided at tick time).
    strategy: (() => {
      const v = str(file.strategy, env.MERRYMEN_STRATEGY);
      return v && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : d.strategy;
    })(),
    swapVenue: oneOf(file.swapVenue, env.MERRYMEN_SWAP_VENUE, ["uniswap", "rialto"], d.swapVenue),
    slippageBps: num(file.slippageBps, env.MERRYMEN_SLIPPAGE_BPS, d.slippageBps, 1, 5_000),
    // Floor of 0 is meaningful here: it turns the guard off. Ceiling of 10_000
    // is 100% impact, past which the number stops meaning anything.
    maxImpactBps: num(file.maxImpactBps, env.MERRYMEN_MAX_IMPACT_BPS, d.maxImpactBps, 0, 10_000),
    perfFeeBps: num(file.perfFeeBps, env.MERRYMEN_PERF_FEE_BPS, d.perfFeeBps, 0, 5_000),
    tickSeconds: num(file.tickSeconds, env.MERRYMEN_TICK_SECONDS, d.tickSeconds, 15, 3_600),
    basketSymbols,
    customTokens,
    minPoolLiquidityUsdg: num(file.minPoolLiquidityUsdg, env.MERRYMEN_MIN_POOL_LIQUIDITY_USDG, d.minPoolLiquidityUsdg, 0, 100_000_000),
    maxPriceDivergenceBps: num(file.maxPriceDivergenceBps, env.MERRYMEN_MAX_PRICE_DIVERGENCE_BPS, d.maxPriceDivergenceBps, 10, 10_000),
    discoveryEnabled: bool(file.discoveryEnabled, env.MERRYMEN_DISCOVERY_ENABLED, d.discoveryEnabled),
    discoveryIntervalMin: num(file.discoveryIntervalMin, env.MERRYMEN_DISCOVERY_INTERVAL_MIN, d.discoveryIntervalMin, 1, 1440),
    scoutEnabled: bool(file.scoutEnabled, env.MERRYMEN_SCOUT_ENABLED, d.scoutEnabled),
    scoutBudgetUsdg: num(file.scoutBudgetUsdg, env.MERRYMEN_SCOUT_BUDGET_USDG, d.scoutBudgetUsdg, 0, 1_000_000),
    scoutPerTokenUsdg: num(file.scoutPerTokenUsdg, env.MERRYMEN_SCOUT_PER_TOKEN_USDG, d.scoutPerTokenUsdg, 0, 1_000_000),
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
    telegramPcControlEnabled: bool(file.telegramPcControlEnabled, env.MERRYMEN_TELEGRAM_PC_CONTROL, d.telegramPcControlEnabled),
    telegramCapabilities: strArray(file.telegramCapabilities, env.MERRYMEN_TELEGRAM_CAPABILITIES, d.telegramCapabilities),
    telegramFilesRoot: str(file.telegramFilesRoot, env.MERRYMEN_TELEGRAM_FILES_ROOT),
    telegramShellAllowlist: strArray(file.telegramShellAllowlist, env.MERRYMEN_TELEGRAM_SHELL_ALLOWLIST, d.telegramShellAllowlist),
    telegramAppAllowlist: strArray(file.telegramAppAllowlist, env.MERRYMEN_TELEGRAM_APP_ALLOWLIST, d.telegramAppAllowlist),
    telegramTranscribeKey: str(file.telegramTranscribeKey, env.MERRYMEN_TELEGRAM_TRANSCRIBE_KEY),
    telegramTranscribeBase: str(file.telegramTranscribeBase, env.MERRYMEN_TELEGRAM_TRANSCRIBE_BASE, d.telegramTranscribeBase)!,
    telegramAgentEnabled: bool(file.telegramAgentEnabled, env.MERRYMEN_TELEGRAM_AGENT, d.telegramAgentEnabled),
    telegramAgentAutoShell: bool(file.telegramAgentAutoShell, env.MERRYMEN_TELEGRAM_AGENT_AUTOSHELL, d.telegramAgentAutoShell),
    telegramAgentMaxSteps: num(file.telegramAgentMaxSteps, env.MERRYMEN_TELEGRAM_AGENT_MAX_STEPS, d.telegramAgentMaxSteps, 1, 60),
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
  // settings.json holds plaintext API keys — owner-only perms (0600). Atomic
  // tmp+rename so a crash mid-write never leaves a truncated file.
  const tmp = `${file}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
  const data = JSON.stringify(next, null, 2);
  try {
    writeFileSync(tmp, data, { encoding: "utf8", mode: 0o600 });
    try { chmodSync(tmp, 0o600); } catch {}
    let lastErr: unknown = null;
    for (let i = 0; i < 5; i++) {
      try { renameSync(tmp, file); lastErr = null; break; }
      catch (e: unknown) {
        lastErr = e;
        const code = (e as { code?: string })?.code ?? "";
        if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") break;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (i + 1));
      }
    }
    if (lastErr) throw lastErr;
    try { chmodSync(file, 0o600); } catch {}
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
  return next;
}

/** Fingerprint of fields that require re-arming the executor when changed. */
export function connectionKey(cfg: ResolvedConfig): string {
  return [cfg.bundlerApiKey, cfg.bundlerUrl, cfg.rpcMainnet, cfg.rpcTestnet].join("|");
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
    cfg.llmMaxActionUsdg,
  ].join("|");
}
