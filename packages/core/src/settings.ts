/**
 * User settings — everything configurable from the web UI, persisted at
 * .data/settings.json (gitignored, local machine only). The worker re-reads
 * the file every tick, so the UI is the source of truth; environment
 * variables remain a fallback for headless runs; hardcoded defaults are the
 * floor. Precedence: settings file > env var > default.
 *
 * Secrets (API keys) never travel back to the browser — the settings API
 * returns only { set, hint } for them.
 */

import { TRADEABLE_SYMBOLS } from "./tokens";

export interface MerrymenSettings {
  // ── connections ────────────────────────────────────────────────────────
  /** The easy path to live trading: a Pimlico API key (secret). The worker
   * builds the bundler URL for the grant's chain automatically, so it can
   * never point at the wrong chain. Blank = simulation only. */
  bundlerApiKey?: string;
  /** Advanced override: a full 4337 bundler RPC (Alchemy or self-hosted). Takes
   * precedence over bundlerApiKey. Without either, execution is stubbed. */
  bundlerUrl?: string;
  /** Override the public mainnet RPC (rate limits bite at 1-minute ticks). */
  rpcMainnet?: string;
  /** Override the public testnet RPC. */
  rpcTestnet?: string;

  // ── API keys (secret — masked in every API response) ───────────────────
  /** The free/default brain: a Groq key (console.groq.com) powers chat, the
   * strategist, and narration on Groq's fast OpenAI-compatible models. */
  groqApiKey?: string;
  /** Groq model id (default llama-3.3-70b-versatile). */
  groqModel?: string;
  /** The upgrade: an Anthropic key routes everything through Claude instead
   * (and unlocks screen vision). Takes precedence over Groq when both are set. */
  anthropicApiKey?: string;

  // ── AI provider (bring any key) ────────────────────────────────────────
  /** Which brain powers chat + the strategist: an id from LLM_PROVIDERS
   * (groq, openai, anthropic, google, xai, deepseek, mistral, openrouter,
   * together, perplexity, cerebras, fireworks, ollama) or "custom". Blank =
   * the legacy auto path (Anthropic key wins, else Groq key). */
  llmProvider?: string;
  /** API key for the selected provider (secret). For groq/anthropic the classic
   * groqApiKey/anthropicApiKey are used instead, so old setups keep working. */
  llmApiKey?: string;
  /** Only for provider "custom": the OpenAI-compatible base URL (…/v1). */
  llmBaseUrl?: string;
  /** Model id for the selected provider. Blank = the provider's default. Accepts
   * vendor ids with slashes/case (e.g. meta-llama/Llama-3.3-70B-Instruct-Turbo). */
  llmProviderModel?: string;
  /** Rialto integrator key — enables the full quote→swap leg. */
  rialtoApiKey?: string;
  /** Header name the Rialto API expects the key in (their docs say). */
  rialtoApiKeyHeader?: string;

  // ── contracts ──────────────────────────────────────────────────────────
  /** Deployed BreakerRegistry; a tripped breaker halts all intents. */
  breakerAddress?: string;

  // ── paper trading (the full loop with zero funds) ──────────────────────
  /** When the account can't sign (no bundler key), fill approved intents as
   * PAPER trades at live oracle prices instead of stubbing execution. The
   * whole loop — pings, P&L, journal, chat trades — works with no funding. */
  paperTradingEnabled?: boolean;
  /** Starting paper cash, USDG. */
  paperStartUsdg?: number;

  // ── trading ────────────────────────────────────────────────────────────
  /** Builtin ("steady-basket" | "weekend-gap" | "llm-strategist") or the
   * filename of a user-written strategy in strategies/. */
  strategy?: string;
  swapVenue?: "uniswap" | "rialto";
  /** Max slippage vs the pre-trade quote, bps. */
  slippageBps?: number;
  /** Performance fee on profit above HWM, bps (accrual-only). */
  perfFeeBps?: number;
  /** Worker tick cadence, seconds. */
  tickSeconds?: number;
  /** Basket universe — symbols from the official token registry, equal-weighted. */
  basketSymbols?: string[];
  /** Steady-basket: USDG bought per tick across the basket. */
  buyPerTickUsdg?: number;
  /** Steady-basket: cash floor kept liquid; the excess sweeps to the vault. */
  idleFloorUsdg?: number;
  /** Weekend-gap: total USDG deployed per gap window. */
  gapEnterBudgetUsdg?: number;
  /** LLM strategist knobs. */
  llmModel?: string;
  llmIntervalMin?: number;
  llmMaxActionUsdg?: number;

  // ── $MERRYMEN · the Merry Circle (holder perks) ────────────────────────
  /** The wallet you hold $MERRYMEN in. The worker reads its balance (read-only)
   * to set your Circle tier — which lowers your platform fee and unlocks perks.
   * Optional; blank = no tier. Purely a discount/perk lookup, never a spend key. */
  holderAddress?: string;

  // ── Virtuals Terminal (stream your agent's activity to its Virtuals page) ─
  /** Virtuals API key (secret). Get it from your agent's page on app.virtuals.io.
   * Enables streaming the merryman's live activity to its Virtuals Terminal. */
  virtualsApiKey?: string;
  /** Master switch — OFF by default. When on (and a key is set), landed/rejected
   * trades and the daily report are PUBLISHED to your agent's Virtuals page.
   * Outbound + public: nothing streams until you turn this on. */
  virtualsEnabled?: boolean;

  // ── telegram (chat with your merryman) ─────────────────────────────────
  /** Bot token from @BotFather (secret). Enables the Telegram bridge. */
  telegramBotToken?: string;
  /** Master switch — the poller only runs when this is true and a token is set. */
  telegramEnabled?: boolean;
  /** Allow state-changing commands (pause/strategy/cap/kill). Off = read + chat only. */
  telegramControlEnabled?: boolean;
  /** Obeyed Telegram chat IDs. First /link adds the owner; others rejected. */
  telegramAllowlist?: number[];
  /** Per-action USDG ceiling for chat-triggered trades — beneath the grant caps. */
  telegramMaxActionUsdg?: number;
  /** Allow /transfer from chat (still needs a transfer-capable grant + /confirm). OFF by default. */
  telegramTransferEnabled?: boolean;
  /** Daily USDG budget for chat transfers — beneath the grant daily cap. */
  telegramTransferDailyUsdg?: number;
  /** Proactive pings to the owner chat: trade results, warnings, price alerts, daily report. */
  telegramNotifyEnabled?: boolean;
  /** Local hour (0-23) after which the daily campfire report is sent. */
  telegramDigestHour?: number;

  // ── remote control · your PC (OpenClaw-style — all OFF by default) ──────
  /** MASTER switch for PC control. Off = no screenshot/app/file/shell command runs. */
  telegramPcControlEnabled?: boolean;
  /** Enabled capability groups: screen, vision, apps, system, files, clipboard,
   * shell, keyboard, voice, watchers. A command whose group isn't listed is refused. */
  telegramCapabilities?: string[];
  /** The ONE directory file operations (ls/getfile) are confined to. Empty = files off. */
  telegramFilesRoot?: string;
  /** Exact command prefixes /run may execute (e.g. "git status", "npm test"). Empty = none. */
  telegramShellAllowlist?: string[];
  /** App names /open may launch (e.g. "spotify", "code"). URLs need no allowlist. */
  telegramAppAllowlist?: string[];
  /** OpenAI-compatible transcription key for voice notes (secret). Blank = voice off. */
  telegramTranscribeKey?: string;
  /** Transcription API base (OpenAI-compatible /audio/transcriptions). Default OpenAI. */
  telegramTranscribeBase?: string;
}

/** Keys whose values must never be echoed back to a browser. */
export const SECRET_SETTING_KEYS = [
  "bundlerApiKey",
  "groqApiKey",
  "anthropicApiKey",
  "llmApiKey",
  "rialtoApiKey",
  "telegramBotToken",
  "telegramTranscribeKey",
  "virtualsApiKey",
] as const;
export type SecretSettingKey = (typeof SECRET_SETTING_KEYS)[number];

/** The PC-control capability groups a user can enable, in dashboard order. */
export const PC_CAPABILITIES = [
  "screen",
  "vision",
  "apps",
  "system",
  "files",
  "clipboard",
  "shell",
  "keyboard",
  "voice",
  "watchers",
] as const;
export type PcCapability = (typeof PC_CAPABILITIES)[number];

export const SETTINGS_DEFAULTS = {
  paperTradingEnabled: true,
  paperStartUsdg: 1000,
  rialtoApiKeyHeader: "x-api-key",
  strategy: "steady-basket" as const,
  swapVenue: "uniswap" as const,
  slippageBps: 100,
  perfFeeBps: 1000,
  tickSeconds: 60,
  // Only tokens with a live Uniswap v3 pool — otherwise a fresh agent's buys
  // all no-route. See TRADEABLE_SYMBOLS in tokens.ts.
  basketSymbols: [...TRADEABLE_SYMBOLS] as string[],
  buyPerTickUsdg: 25,
  idleFloorUsdg: 50,
  gapEnterBudgetUsdg: 75,
  groqModel: "llama-3.3-70b-versatile",
  llmModel: "claude-opus-4-8",
  llmIntervalMin: 30,
  llmMaxActionUsdg: 50,
  telegramEnabled: false,
  telegramControlEnabled: true,
  telegramAllowlist: [] as number[],
  telegramMaxActionUsdg: 25,
  telegramTransferEnabled: false,
  telegramTransferDailyUsdg: 100,
  telegramNotifyEnabled: true,
  telegramDigestHour: 18,
  telegramPcControlEnabled: false,
  telegramCapabilities: [] as string[],
  telegramFilesRoot: "",
  telegramShellAllowlist: [] as string[],
  telegramAppAllowlist: [] as string[],
  telegramTranscribeBase: "https://api.openai.com/v1",
  virtualsEnabled: false,
};
