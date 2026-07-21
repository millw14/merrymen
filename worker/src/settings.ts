/**
 * Settings resolution for the worker: settings file > env var > default.
 * The file is re-read every tick (cheap; it's tiny) so changes made in the
 * web UI apply without a restart. `configKey()` fingerprints the connection
 * fields — when it changes, the runner drops the armed agent and re-arms with
 * the new bundler/RPC; trading fields rebuild the strategy in place.
 */

import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import {
  SETTINGS_DEFAULTS,
  STOCK_TOKENS,
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
  perfFeeBps: number;
  tickSeconds: number;
  basketSymbols: string[];
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

  const fileSymbols = Array.isArray(file.basketSymbols)
    ? file.basketSymbols.filter((s): s is string => typeof s === "string" && KNOWN_SYMBOLS.has(s))
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
    perfFeeBps: num(file.perfFeeBps, env.MERRYMEN_PERF_FEE_BPS, d.perfFeeBps, 0, 5_000),
    tickSeconds: num(file.tickSeconds, env.MERRYMEN_TICK_SECONDS, d.tickSeconds, 15, 3_600),
    basketSymbols,
    buyPerTickUsdg: num(file.buyPerTickUsdg, env.MERRYMEN_BUY_PER_TICK_USDG, d.buyPerTickUsdg, 1, 100_000),
    idleFloorUsdg: num(file.idleFloorUsdg, env.MERRYMEN_IDLE_FLOOR_USDG, d.idleFloorUsdg, 0, 1_000_000),
    gapEnterBudgetUsdg: num(file.gapEnterBudgetUsdg, env.MERRYMEN_GAP_BUDGET_USDG, d.gapEnterBudgetUsdg, 1, 1_000_000),
    llmModel: str(file.llmModel, env.MERRYMEN_LLM_MODEL, d.llmModel)!,
    llmIntervalMin: num(file.llmIntervalMin, env.MERRYMEN_LLM_INTERVAL_MIN, d.llmIntervalMin, 1, 1_440),
    llmMaxActionUsdg: num(file.llmMaxActionUsdg, env.MERRYMEN_LLM_MAX_ACTION_USDG, d.llmMaxActionUsdg, 1, 100_000),
    holderAddress,
    virtualsApiKey: str(file.virtualsApiKey, env.MERRYMEN_VIRTUALS_API_KEY),
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
