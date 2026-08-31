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

import { DEFAULT_BASKET_SYMBOLS } from "./tokens";

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
  /** Groq model id (default qwen/qwen3.8-27b). */
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
  /**
   * The research browser service — private-network URL and shared token.
   *
   * HOUSE keys, not tenant settings: this is one shared Chromium reached over
   * Railway private networking, the same shape as the bundler. A tenant must not
   * be able to repoint it, because whatever it points at gets fetched by a real
   * browser sitting inside our network.
   */
  browserUrl?: string;
  browserToken?: string;
  /** Rialto integrator key — enables the full quote→swap leg. */
  rialtoApiKey?: string;
  /** Header name the Rialto API expects the key in (their docs say). */
  rialtoApiKeyHeader?: string;

  // ── contracts ──────────────────────────────────────────────────────────
  /** Deployed BreakerRegistry; a tripped breaker halts all intents. */
  breakerAddress?: string;
  /**
   * Deployed V4SelfSwap adapter — the contract that makes Uniswap v4
   * constrainable by the wall. Per-chain (testnet and mainnet deploys have
   * different addresses), and SETTING IT DOES NOTHING BY ITSELF: the address
   * is sealed into the grant at signing time, so it only takes effect after a
   * re-sign. The worker executes against the grant-sealed address, never this.
   */
  /**
   * What the owner calls their agent.
   *
   * Lives HERE rather than on the grant or the agents row for three reasons:
   * settings are per-tenant and sealed in hosted mode, they survive a redeploy
   * where a container filesystem does not, and they can be written before a
   * grant or an agents row exists. The soul file stays the RUNTIME seat -- this
   * is the durable seed the worker reconciles from at arm time, so every
   * existing reader keeps working unchanged.
   *
   * Deliberately NOT a house key: a tenant must be able to name their own agent.
   */
  agentName?: string;
  v4AdapterAddress?: string;
  /**
   * The deployed PonsSelfTrade adapter for this chain, or absent.
   *
   * A HINT, never the authority. The worker calls whatever address the grant
   * was SEALED against (grantPonsAdapter); this field only lets the dashboard
   * offer it at signing time and lets the worker warn when the two have
   * drifted. Reading it at tick time would let a setting redirect trades at a
   * contract the signature never covered.
   */
  ponsAdapterAddress?: string;

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
  /**
   * Refuse a BUY whose own size would move the pool more than this, in bps.
   *
   * Distinct from slippageBps, which bounds the price MOVING between the quote
   * and the fill. This bounds what the quote itself already costs you: a large
   * order into a thin pool is quoted, sized and executed at whatever the pool
   * gives, and minOut is derived from that same bad quote so it never objects.
   *
   * Exits are never refused on it — getting out is not discretionary — though a
   * costly one is reported. 0 disables the guard.
   */
  maxImpactBps?: number;
  /** Performance fee on profit above HWM, bps (accrual-only). */
  perfFeeBps?: number;
  /** Worker tick cadence, seconds. */
  tickSeconds?: number;
  /** Basket universe — symbols from the official token registry, equal-weighted. */
  basketSymbols?: string[];
  /**
   * Tokens the owner added themselves — memecoins and anything else outside the
   * curated stock registry. Kept in the owner's config rather than the shipped
   * registry because it is their choice and their risk.
   *
   * Adding one does NOT by itself let the agent trade it: the tradable set is
   * baked into the signed session key, so a new token needs the grant re-signed.
   * That is the wall working as designed — it cannot widen without a signature.
   */
  customTokens?: { symbol: string; address: string; decimals: number }[];
  /** Refuse to value a token whose deepest route is shallower than this (USD).
   * A thin pool can be pushed for pocket change, and that price would feed
   * equity, P&L and the drawdown breaker. */
  minPoolLiquidityUsdg?: number;
  /** Refuse when spot has run this far from the TWAP (bps) — the signature of a
   * pool being manipulated right now. */
  maxPriceDivergenceBps?: number;
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
  /**
   * Bitquery API key (secret). Bitquery indexes Robinhood Chain from genesis —
   * decoded events, DEX trades and, crucially, Uniswap **v4** pool activity that
   * merrymen's own v3 reads cannot see. It is a DISCOVERY source: it can tell
   * the agent a pair exists, never authorise a trade in it.
   *
   * Read-only and off the hot path by construction. Nothing Bitquery returns
   * may widen a cap, and a token it surfaces still has to clear the same depth,
   * TWAP and divergence guards as anything else before it can be valued.
   */
  bitqueryApiKey?: string;
  /**
   * A Merry Circle gateway token (secret), claimed by signing at the gateway's
   * /claim page with a wallet holding $MERRYMEN.
   *
   * STANDALONE ON PURPOSE. The same token opens both the gateway's brain and its
   * Bitquery route, but the two choices are independent: an owner may well want
   * Claude or Groq thinking while still using the Circle's Bitquery quota. It
   * was originally read off the LLM key, which silently made gateway discovery
   * impossible for anyone not also using the gateway's model.
   *
   * Your OWN bitqueryApiKey always wins over this — your quota, your limits, no
   * third party in the path.
   */
  merrymenToken?: string;
  /**
   * Discovery: poll Bitquery for newly launched pairs and TELL the owner.
   * Defaults ON, because it only runs when a Bitquery key or a holder token is
   * configured — supplying one is the opt-in. It can never trade: a surfaced
   * pair still needs adding in /settings and a re-signed grant.
   */
  discoveryEnabled?: boolean;
  /** Minutes between discovery polls. The gateway allows only a few a minute. */
  discoveryIntervalMin?: number;
  /**
   * SCOUT MODE — buying tokens too new or too thin to price.
   *
   * A freshly launched pool has no TWAP history and almost no depth, which is
   * exactly the shape a price anyone can push takes. merrymen refuses to VALUE
   * such a token, and that refusal is load-bearing: equity, P&L and the drawdown
   * breaker all read those numbers.
   *
   * Scout mode doesn't weaken that. It quarantines instead: a scout position is
   * carried at what it COST — a historical fact nobody can move — never at a
   * pool reading, and the total that may sit in that state is hard-capped.
   *
   * The honest limit, stated plainly: the drawdown breaker cannot protect this
   * money, because protecting it would mean trusting the price it can't verify.
   * `scoutBudgetUsdg` IS the risk control for scout capital. Treat it as money
   * you have decided you can lose.
   */
  /**
   * Let trencher trade LIVE, not only on paper.
   *
   * The rail it replaces was `if (!paperActive()) return []` — and paperActive
   * is defined as the ABSENCE of an executor, so arming one turned the candidate
   * feed off entirely. That is a safe default and an odd one to discover: the
   * strategy silently stopped seeing anything the moment it could act.
   *
   * Off by default. Turning it on is the owner saying the memecoin strategy may
   * spend real money, and it composes with — never replaces — the scout budget,
   * the per-trade cap and the wall.
   */
  trencherLiveEnabled?: boolean;
  /**
   * Pay this agent's gas from a sponsor, so the owner funds USDG only.
   *
   * HOUSE-OWNED (see HOUSE_KEY_FIELDS) because hosted it spends OUR money, not
   * the tenant's — a third category from the key/URL split that file draws.
   * A tenant who could set this would be writing a cheque on the house.
   */
  sponsorGasEnabled?: boolean;
  /** Pimlico sponsorship policy id (`sp_…`), which is where the real spend limits live. */
  sponsorshipPolicyId?: string;
  scoutEnabled?: boolean;
  /** Max USDG of COST that may sit in unpriceable positions at once. 0 = off. */
  scoutBudgetUsdg?: number;
  /** Max USDG into any single unpriceable token. */
  scoutPerTokenUsdg?: number;
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
  /** How often to send routine trade pings. 0 = one message per trade (default);
   * >0 = batch them into a single summary every N minutes (quiet mode). Warnings,
   * price alerts, reminders and the daily report always come through immediately. */
  telegramNotifyEveryMin?: number;
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

  // ── agent mode · /agent <task> (OpenClaw-style multi-step tasks) ────────
  /** Master switch for /agent — the AI works your PC in a tool loop (shell,
   * files, screen, vision), streaming progress to the chat. Requires PC control
   * on; each tool is still gated by its capability group. OFF by default. */
  telegramAgentEnabled?: boolean;
  /** Let /agent run shell commands BEYOND the allowlist without per-command
   * confirmation (destructive commands are always refused). This is what makes
   * "clone it, install deps, build, fix the errors" possible — and it is remote
   * code execution by design. OFF by default. */
  telegramAgentAutoShell?: boolean;
  /** Max model↔tool steps per /agent task (runaway brake). */
  telegramAgentMaxSteps?: number;
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
  "bitqueryApiKey",
  "merrymenToken",
] as const;
export type SecretSettingKey = (typeof SECRET_SETTING_KEYS)[number];

/**
 * Connection / credential / endpoint fields the HOSTED server owns — "house
 * keys". A tenant must never set them: `bundler*` spends our bundler budget or
 * points us at their key; `rpc*` / `llmBaseUrl` are SSRF from our egress; the
 * LLM keys are ours to pay for. Self-hosted, these are the owner's own and the
 * settings file wins as always. Shared by the worker (strips them from the
 * tenant file before merge, so env wins) and the settings API (refuses to write
 * them hosted).
 */
export const HOUSE_KEY_FIELDS = [
  "bundlerApiKey",
  "bundlerUrl",
  "rpcMainnet",
  "rpcTestnet",
  // THE LLM KEYS ARE NOT HERE ANY MORE — a tenant may bring their own.
  //
  // They were house-owned because the house pays for inference. That reasoning
  // held right up until the house budget ran out: on 2026-08-31 the shared Groq
  // key hit its daily limit and a user's CHAT stopped working, on a plan he had
  // no way to top up, because the field was stripped before it reached the store.
  //
  // Now the house key is the DEFAULT and a tenant's own key OVERRIDES it — which
  // falls out of `str(file, env)` for free: the settings file wins, env is the
  // fallback. Bring a key and you get your own quota and your own choice of model;
  // bring nothing and you get ours.
  //
  // Storing it is safe by the same mechanism that already holds a tenant's
  // Telegram bot token: the settings blob is sealed at rest under a DEK held by
  // the web and the orchestrator and never by a child (settings-store.ts).
  //
  // `llmBaseUrl` DOES stay house-owned, and the distinction is the whole point:
  // a key is a credential the tenant pays with, a base URL is an address OUR
  // egress would connect to. One is their money, the other is our SSRF.
  "llmBaseUrl",
  // SPONSORSHIP IS THE HOUSE'S MONEY — a third category.
  //
  // The distinction above is a tenant's credential versus our egress. This is
  // neither: it decides whether WE pay for a tenant's gas. Leaving it out would
  // let a hosted tenant enable it in their own settings, which is a cheque
  // written on the house account, stored and honoured.
  "sponsorGasEnabled",
  "sponsorshipPolicyId",
  "rialtoApiKey",
  "rialtoApiKeyHeader",
  "bitqueryApiKey",
  "merrymenToken",
  "virtualsApiKey",
  "telegramTranscribeKey",
  "telegramTranscribeBase",
  "browserUrl",
  "browserToken",
] as const;

/**
 * The remote-execution settings — turning these on means "run a shell / drive a
 * PC". Self-hosted that is the owner's own machine; hosted it would be a shell on
 * OUR server with an allowlist the attacker chose, so a tenant must never set
 * them. The worker also refuses to act on them hosted (defence in depth), but a
 * value the tenant cannot even write is one fewer thing to get wrong.
 */
export const RCE_SETTING_FIELDS = [
  "telegramPcControlEnabled",
  "telegramAgentEnabled",
  "telegramAgentAutoShell",
  "telegramShellAllowlist",
  "telegramAppAllowlist",
  "telegramFilesRoot",
  "telegramCapabilities",
] as const;

/** Every settings field a HOSTED tenant is forbidden from writing. */
export const HOSTED_FORBIDDEN_SETTING_FIELDS = [
  ...HOUSE_KEY_FIELDS,
  ...RCE_SETTING_FIELDS,
] as const;

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

/**
 * The highest slippage a grant may ever be configured with, in bps.
 *
 * This was 5,000 — a minOut of HALF the quote — and it lived in a web
 * route's validation table rather than anywhere a policy belongs, duplicated
 * in the worker where an out-of-range value silently fell back to the default
 * instead of being refused. The worker-side sanity check in
 * `minOutWithSlippage` is looser still (`>= 10_000`), because its job is only
 * to stop a negative minOut, not to express a bound.
 *
 * 1,000 bps, and it is a PRODUCT POLICY rather than a preference: there is no
 * env var and no settings field that raises it, because a ceiling a running
 * agent can lift for itself is not a ceiling. Vex pins the same number for
 * the same reason, and names 5,000 as the range where a provider will accept
 * a fill that is a total loss.
 *
 * Above ~1,000 bps on this chain the number stops describing slippage. The v4
 * fee survey found a median LP fee of 86.33%, so a fill 10% below quote is
 * not a market moving — it is a pool set up to keep the difference.
 */
export const SLIPPAGE_BPS_MAX = 1_000;

export const SETTINGS_DEFAULTS = {
  paperTradingEnabled: true,
  paperStartUsdg: 1000,
  rialtoApiKeyHeader: "x-api-key",
  strategy: "steady-basket" as const,
  swapVenue: "uniswap" as const,
  slippageBps: 100,
  // 3%. Comfortably above what a healthy pool charges for a normal ticket, and
  // well below the point where a fill is being eaten. An owner who wants "any
  // amount" raises this or sets it to 0; the honest default refuses the trade
  // that would quietly cost more than the strategy could ever make back.
  maxImpactBps: 300,
  perfFeeBps: 1000,
  tickSeconds: 60,
  // A handful of the deepest names, NOT the whole tradable set — spreading a
  // first deposit across fourteen legs is worse, not more diversified. See
  // DEFAULT_BASKET_SYMBOLS in tokens.ts.
  basketSymbols: [...DEFAULT_BASKET_SYMBOLS] as string[],
  customTokens: [] as { symbol: string; address: string; decimals: number }[],
  // $25k of depth and a 5% spot/TWAP band. Deliberately strict: live pools on
  // this chain run from ~$3k (trivially pushed) to ~$1.2M, so this admits the
  // deep end and refuses the rest until the owner explicitly loosens it.
  minPoolLiquidityUsdg: 25_000,
  maxPriceDivergenceBps: 500,
  // Scout mode is OFF and ZERO by default. Buying what you cannot price is a
  // real decision with a real downside, so it is never the default and never
  // inherits the main budget — the owner has to name a number themselves.
  discoveryEnabled: true,
  discoveryIntervalMin: 10,
  trencherLiveEnabled: false,
  // Off by default like every other switch that spends money.
  sponsorGasEnabled: false,
  scoutEnabled: false,
  scoutBudgetUsdg: 0,
  scoutPerTokenUsdg: 25,
  buyPerTickUsdg: 25,
  idleFloorUsdg: 50,
  gapEnterBudgetUsdg: 75,
  // Groq retired the whole Llama 3.x chat line; llama-3.3-70b-versatile now
  // answers 404 model_not_found, which is why the chat could not think.
  // See llm-providers.ts for why this model and not the bigger one.
  groqModel: "qwen/qwen3.8-27b",
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
  telegramNotifyEveryMin: 0,
  telegramDigestHour: 18,
  telegramPcControlEnabled: false,
  telegramCapabilities: [] as string[],
  telegramFilesRoot: "",
  telegramShellAllowlist: [] as string[],
  telegramAppAllowlist: [] as string[],
  telegramTranscribeBase: "https://api.openai.com/v1",
  telegramAgentEnabled: false,
  telegramAgentAutoShell: false,
  telegramAgentMaxSteps: 20,
  virtualsEnabled: false,
};
