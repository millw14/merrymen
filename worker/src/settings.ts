/**
 * Settings resolution for the worker: settings file > env var > default.
 * The file is re-read every tick (cheap; it's tiny) so changes made in the
 * web UI apply without a restart. `configKey()` fingerprints the connection
 * fields — when it changes, the runner drops the armed agent and re-arms with
 * the new bundler/RPC; trading fields rebuild the strategy in place.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  SETTINGS_DEFAULTS,
  STOCK_TOKENS,
  type MerrymenSettings,
} from "@merrymen/core";

export interface ResolvedConfig {
  bundlerUrl: string | undefined;
  rpcMainnet: string | undefined;
  rpcTestnet: string | undefined;
  anthropicApiKey: string | undefined;
  rialtoApiKey: string | undefined;
  rialtoApiKeyHeader: string;
  breakerAddress: `0x${string}` | undefined;
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

/** Pure merge — exported for tests. `env` defaults to process.env at the call site. */
export function mergeSettings(
  file: MerrymenSettings,
  env: Record<string, string | undefined>,
): ResolvedConfig {
  const d = SETTINGS_DEFAULTS;

  const rawBreaker = str(file.breakerAddress, env.MERRYMEN_BREAKER_ADDRESS);
  const breakerAddress =
    rawBreaker && /^0x[0-9a-fA-F]{40}$/.test(rawBreaker) ? (rawBreaker as `0x${string}`) : undefined;

  const fileSymbols = Array.isArray(file.basketSymbols)
    ? file.basketSymbols.filter((s): s is string => typeof s === "string" && KNOWN_SYMBOLS.has(s))
    : [];
  const basketSymbols = fileSymbols.length > 0 ? fileSymbols : d.basketSymbols;

  return {
    bundlerUrl: str(file.bundlerUrl, env.MERRYMEN_BUNDLER_URL),
    rpcMainnet: str(file.rpcMainnet, env.MERRYMEN_RPC_MAINNET),
    rpcTestnet: str(file.rpcTestnet, env.MERRYMEN_RPC_TESTNET),
    anthropicApiKey: str(file.anthropicApiKey, env.ANTHROPIC_API_KEY),
    rialtoApiKey: str(file.rialtoApiKey, env.MERRYMEN_RIALTO_API_KEY),
    rialtoApiKeyHeader: str(file.rialtoApiKeyHeader, env.MERRYMEN_RIALTO_API_KEY_HEADER, d.rialtoApiKeyHeader)!,
    breakerAddress,
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
  };
}

const SETTINGS_FILE =
  process.env.MERRYMEN_SETTINGS_FILE ?? path.join(process.cwd(), "..", ".data", "settings.json");

/** Read + merge. A missing or corrupt file is just "no overrides". */
export function resolveConfig(): ResolvedConfig {
  let file: MerrymenSettings = {};
  try {
    // BOM-strip: editors and PowerShell write UTF-8 BOMs that break JSON.parse.
    file = JSON.parse(readFileSync(SETTINGS_FILE, "utf8").replace(/^﻿/, "")) as MerrymenSettings;
  } catch {
    // no settings file yet — env + defaults
  }
  return mergeSettings(file ?? {}, process.env);
}

/** Fingerprint of fields that require re-arming the executor when changed. */
export function connectionKey(cfg: ResolvedConfig): string {
  return [cfg.bundlerUrl, cfg.rpcMainnet, cfg.rpcTestnet].join("|");
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
    cfg.anthropicApiKey ?? "", // key text included: rotating the key rebuilds the driver

    cfg.llmModel,
    cfg.llmIntervalMin,
    cfg.llmMaxActionUsdg,
  ].join("|");
}
