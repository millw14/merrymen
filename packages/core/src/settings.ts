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

export interface MerrymenSettings {
  // ── connections ────────────────────────────────────────────────────────
  /** 4337 bundler RPC (Pimlico/Alchemy). Without it execution is stubbed. */
  bundlerUrl?: string;
  /** Override the public mainnet RPC (rate limits bite at 1-minute ticks). */
  rpcMainnet?: string;
  /** Override the public testnet RPC. */
  rpcTestnet?: string;

  // ── API keys (secret — masked in every API response) ───────────────────
  /** Enables the LLM strategist's Claude driver. */
  anthropicApiKey?: string;
  /** Rialto integrator key — enables the full quote→swap leg. */
  rialtoApiKey?: string;
  /** Header name the Rialto API expects the key in (their docs say). */
  rialtoApiKeyHeader?: string;

  // ── contracts ──────────────────────────────────────────────────────────
  /** Deployed BreakerRegistry; a tripped breaker halts all intents. */
  breakerAddress?: string;

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
}

/** Keys whose values must never be echoed back to a browser. */
export const SECRET_SETTING_KEYS = ["anthropicApiKey", "rialtoApiKey", "telegramBotToken"] as const;
export type SecretSettingKey = (typeof SECRET_SETTING_KEYS)[number];

export const SETTINGS_DEFAULTS = {
  rialtoApiKeyHeader: "x-api-key",
  strategy: "steady-basket" as const,
  swapVenue: "uniswap" as const,
  slippageBps: 100,
  perfFeeBps: 1000,
  tickSeconds: 60,
  basketSymbols: ["AAPL", "MSFT", "QQQ"],
  buyPerTickUsdg: 25,
  idleFloorUsdg: 50,
  gapEnterBudgetUsdg: 75,
  llmModel: "claude-opus-4-8",
  llmIntervalMin: 30,
  llmMaxActionUsdg: 50,
  telegramEnabled: false,
  telegramControlEnabled: true,
  telegramAllowlist: [] as number[],
  telegramMaxActionUsdg: 25,
};
