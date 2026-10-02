/**
 * EVERY OWNER SETTING, IN THE OWNER'S WORDS — AND HOW A CHANGE TO IT IS APPROVED.
 *
 * An owner asked for this directly: "a user should be able to tell their agent
 * how they want it to work and it converts that into settings then just asks
 * for a button's approval, even from telegram … it should work for EVERY
 * setting". Before this file the product knew how to do that for 22 keys
 * (worker/src/telegram/setting-spec.ts) and answered every other request with
 * "that's on the dashboard" and a button to the top of a 2,000-line page.
 *
 * ONE TABLE, FOUR WAYS TO APPROVE. Understanding a request is the same problem
 * for every setting; what differs is who may approve it, and from where:
 *
 *   chat       — the owner taps ✅ in Telegram. Exactly the keys the chat
 *                could already change (CHAT_ROUTE_KEYS, pinned against
 *                SETTING_SPECS by worker/src/telegram/settings-catalog.test.ts).
 *                That list is a security boundary — a linked chat is reached
 *                by a bearer link code — and this file does not widen it.
 *   dashboard  — the agent prepares the exact change and hands the owner a
 *                "Review & approve" button that opens Settings with the change
 *                filled in. Approval happens there, in the owner's own signed-in
 *                session, with the page's own warnings. Real money, safety
 *                floors, Telegram's and X's own switches all live here.
 *   sealed     — limits signed on chain. Only a new signature changes them.
 *   secret     — keys and tokens. Never taken from a chat or carried in a
 *                link; the owner is sent to the field.
 *
 * PURE. No I/O and no imports beyond core, so the worker, the web route and
 * the Settings page all read the same names, ranges and parsers.
 */
import { AGENT_NAME_RE, normalizeAgentName } from "./agent-name";
import { RISK_PROFILES, type RiskLevel } from "./risk-level";

export type SettingRoute = "chat" | "dashboard" | "sealed" | "secret";

export type CatalogKind =
  | "usd" // dollars, stored as a USDG number
  | "pct" // shown %, stored basis points
  | "int" // a whole number
  | "minutes" // shown and stored as whole minutes
  | "seconds" // shown and stored as whole seconds
  | "hoursAsSec" // shown hours, stored seconds
  | "hour" // an hour of the day, 0-23
  | "bool"
  | "enum"
  | "symbols" // a list of tickers
  | "text"
  /** Not changeable from a sentence: a list of addresses, chat ids, capabilities. */
  | "special";

/** What a change can do, said once so every surface warns the same way. */
export type SettingRisk = "real-money" | "safety-floor" | "silences-warnings" | "remote-control";

export interface CatalogEntry {
  key: string;
  /** What the owner reads. Lowercase, no jargon. */
  label: string;
  /** Other ways owners say it. Matched whole, case-insensitively. */
  words: readonly string[];
  /** Where it is on the Settings page, as the page names it. */
  where: string;
  kind: CatalogKind;
  /** Inclusive, in the STORED unit — the bounds PUT /api/settings enforces. */
  min?: number;
  max?: number;
  values?: readonly string[];
  /** Value synonyms for an enum: owner word -> stored value. */
  synonyms?: Readonly<Record<string, string>>;
  /** What a stored 0 means, when it is not "none". */
  zero?: string;
  route: SettingRoute;
  risk?: SettingRisk;
  /** Self-hosted only; the hosted route drops it. */
  hostedForbidden?: boolean;
  /** One line on what it does. */
  help: string;
}

const STRATEGIES = ["steady-basket", "weekend-gap", "llm-strategist", "trencher", "even-keel", "dip-hunter"] as const;

const W = {
  TRADING_MODE: "Settings → Trading mode",
  WHAT_IT_TRADES: "Settings → What it trades",
  AGENT: "Settings → Agent settings",
  BASKET: "Settings → Trading basket",
  DISCOVERY: "Settings → Custom tokens & discovery",
  TELEGRAM: "Settings → Telegram",
  TELEGRAM_CONTROLS: "Settings → Advanced settings → Telegram controls",
  COMPUTER: "Settings → Advanced settings → Computer access",
  CONNECTIONS: "Settings → Advanced settings → Connections",
  VIRTUALS: "Settings → Advanced settings → Virtuals",
  PREFS: "Settings → Advanced settings → Trading preferences",
  X: "Settings → Posting on X",
  PROFILE: "Profile → public book",
} as const;

const e = (x: CatalogEntry): CatalogEntry => Object.freeze({ ...x, words: Object.freeze([...x.words]) });

/** The table. Order is the order a proposal lists changes in. */
export const SETTINGS_CATALOG: readonly CatalogEntry[] = Object.freeze([
  // ── trading mode ───────────────────────────────────────────────────────────
  e({ key: "liveTradingEnabled", label: "live trading (real money)", words: ["live trading", "real money", "live mode", "trade for real", "go live"], where: W.TRADING_MODE, kind: "bool", route: "dashboard", risk: "real-money", help: "trade with the account's real funds instead of practising" }),
  e({ key: "paperTradingEnabled", label: "practice mode", words: ["practice", "practice mode", "paper", "paper trading", "paper mode", "simulate", "simulation"], where: W.TRADING_MODE, kind: "bool", route: "dashboard", help: "simulate trades at live prices when real trading is unavailable" }),

  // ── what it trades ─────────────────────────────────────────────────────────
  e({ key: "strategy", label: "trading strategy", words: ["strategy", "playbook", "trading style"], where: W.AGENT, kind: "enum", values: STRATEGIES, synonyms: { basket: "steady-basket", steady: "steady-basket", "steady basket": "steady-basket", gap: "weekend-gap", "weekend gap": "weekend-gap", ai: "llm-strategist", "ai strategist": "llm-strategist", strategist: "llm-strategist", memecoins: "trencher", memecoin: "trencher", trench: "trencher", trenching: "trencher", "even keel": "even-keel", dip: "dip-hunter", "dip hunter": "dip-hunter", dips: "dip-hunter", "buy the dip": "dip-hunter" }, route: "chat", help: "which playbook the agent trades with" }),
  e({ key: "assetMode", label: "what I may buy", words: ["asset mode", "what to buy", "what i may buy", "what it buys", "what you buy"], where: W.WHAT_IT_TRADES, kind: "enum", values: ["all", "stocks", "crypto"], synonyms: { stock: "stocks", equities: "stocks", shares: "stocks", "stocks only": "stocks", "only stocks": "stocks", coins: "crypto", coin: "crypto", tokens: "crypto", memecoins: "crypto", "crypto only": "crypto", "only crypto": "crypto", everything: "all", both: "all", "all assets": "all", anything: "all" }, route: "chat", help: "all assets, stocks only, or crypto only" }),
  e({ key: "trencherLiveEnabled", label: "let trencher trade for real", words: ["trencher live", "trencher real money", "memecoin real money", "memecoins with real money", "let trencher trade for real"], where: `${W.WHAT_IT_TRADES} → Trencher mode`, kind: "bool", route: "dashboard", risk: "real-money", help: "let the memecoin strategy use real money" }),
  e({ key: "trencherFastEnabled", label: "fast trencher review", words: ["fast trencher", "trencher fast", "fast exits", "fast trencher review"], where: `${W.WHAT_IT_TRADES} → Trencher mode`, kind: "bool", route: "dashboard", help: "review memecoins on a fast clock with automatic exits" }),
  e({ key: "basketSymbols", label: "basket", words: ["basket", "stocks list", "which stocks", "stock basket", "my stocks"], where: W.BASKET, kind: "symbols", route: "chat", help: "the stock tokens the basket strategy buys" }),
  e({ key: "officialCoinsEnabled", label: "official coins", words: ["official coins", "chain coins"], where: W.DISCOVERY, kind: "bool", route: "chat", help: "trade the chain's official coins" }),

  // ── how much ───────────────────────────────────────────────────────────────
  e({ key: "buyPerTickUsdg", label: "amount per buy", words: ["buy size", "buy amount", "per buy", "each buy", "trade size", "position size", "amount per buy", "how much per trade", "bet size"], where: W.PREFS, kind: "usd", min: 1, max: 100_000, route: "chat", help: "how much goes into each buy" }),
  e({ key: "llmMaxActionUsdg", label: "max per AI trade", words: ["ai trade size", "max ai trade", "ai size", "max per ai trade", "ai limit"], where: W.PREFS, kind: "usd", min: 1, max: 100_000, route: "chat", help: "the most one AI-chosen trade can use" }),
  e({ key: "telegramMaxActionUsdg", label: "max per chat trade", words: ["chat cap", "chat limit", "chat trade limit", "max per chat trade", "telegram trade limit"], where: W.TELEGRAM_CONTROLS, kind: "usd", min: 1, max: 100_000, route: "chat", help: "the most one /buy or /sell from Telegram can use" }),
  e({ key: "idleFloorUsdg", label: "cash kept aside", words: ["idle floor", "reserve", "cash reserve", "keep aside", "cash kept aside", "keep in cash", "cash floor"], where: W.PREFS, kind: "usd", min: 0, max: 1_000_000, route: "chat", help: "cash the agent never trades with" }),
  e({ key: "gapEnterBudgetUsdg", label: "weekend-gap budget", words: ["gap budget", "weekend gap budget", "weekend budget"], where: W.PREFS, kind: "usd", min: 1, max: 1_000_000, route: "chat", help: "what the weekend-gap strategy may use" }),
  e({ key: "takeProfitBps", label: "take profit at", words: ["take profit", "tp", "profit target", "sell at profit", "take profits"], where: W.PREFS, kind: "pct", min: 0, max: 1_000_000, zero: "off", route: "chat", help: "sell a holding once it is up this much" }),
  e({ key: "strategistStopLossBps", label: "stop loss at", words: ["stop loss", "stoploss", "sl", "cut losses", "cut losses at", "max loss per trade"], where: W.PREFS, kind: "pct", min: 0, max: 10_000, zero: "off", route: "chat", help: "sell a holding once it is down this much" }),
  e({ key: "slippageBps", label: "max slippage", words: ["slippage", "max slippage"], where: W.PREFS, kind: "pct", min: 1, max: 1_000, route: "chat", help: "the worst price move accepted while a trade fills" }),
  e({ key: "maxImpactBps", label: "max price impact", words: ["price impact", "max impact", "impact"], where: W.PREFS, kind: "pct", min: 0, max: 10_000, zero: "off (no impact guard)", route: "dashboard", risk: "safety-floor", help: "refuse a trade that would move the price more than this" }),
  e({ key: "memecoinMinFdvUsd", label: "smallest coin size I'll buy", words: ["min fdv", "minimum fdv", "min market cap", "minimum market cap", "smallest coin"], where: W.DISCOVERY, kind: "usd", min: 0, max: 1_000_000_000_000, zero: "no limit", route: "chat", help: "skip coins worth less than this in total" }),
  e({ key: "perfFeeBps", label: "performance fee", words: ["performance fee", "perf fee"], where: W.PREFS, kind: "pct", min: 0, max: 5_000, route: "dashboard", help: "the share of profit charged as a fee" }),
  e({ key: "paperStartUsdg", label: "practice starting balance", words: ["paper balance", "practice balance", "starting balance", "practice money"], where: W.TRADING_MODE, kind: "usd", min: 1, max: 10_000_000, route: "dashboard", help: "the simulated cash a practice book starts with" }),

  // ── how often ──────────────────────────────────────────────────────────────
  e({ key: "tickSeconds", label: "how often it checks the market (seconds)", words: ["tick", "tick seconds", "check interval", "market check", "how often it checks", "decision interval seconds"], where: W.PREFS, kind: "seconds", min: 15, max: 3_600, route: "dashboard", help: "seconds between market checks" }),
  e({ key: "llmIntervalMin", label: "minutes between AI decisions", words: ["ai interval", "decision interval", "ai decisions", "think every"], where: W.PREFS, kind: "minutes", min: 1, max: 1_440, route: "chat", help: "how often the AI looks for a trade" }),
  e({ key: "swapVenue", label: "trading venue", words: ["venue", "swap venue", "trading venue"], where: W.PREFS, kind: "enum", values: ["uniswap", "rialto"], route: "dashboard", help: "where stock-token swaps are routed" }),

  // ── safety floors ──────────────────────────────────────────────────────────
  e({ key: "minPoolLiquidityUsdg", label: "minimum pool depth", words: ["pool depth", "min liquidity", "minimum liquidity", "liquidity floor", "minimum pool depth"], where: W.DISCOVERY, kind: "usd", min: 0, max: 100_000_000, zero: "no floor", route: "dashboard", risk: "safety-floor", help: "refuse to value a pool shallower than this" }),
  e({ key: "maxPriceDivergenceBps", label: "max price jump vs average", words: ["price jump", "divergence", "max divergence", "price divergence"], where: W.DISCOVERY, kind: "pct", min: 10, max: 10_000, route: "dashboard", risk: "safety-floor", help: "refuse a price this far from its recent average" }),
  e({ key: "classMinDepthUsdg", label: "minimum launchpad depth", words: ["launch depth", "launchpad depth", "min launch depth"], where: `${W.DISCOVERY} → launchpad buying`, kind: "usd", min: 0, max: 10_000_000, route: "dashboard", risk: "safety-floor", help: "real depth a launchpad coin needs before a buy" }),

  // ── discovery, scout, launchpad ───────────────────────────────────────────
  e({ key: "discoveryEnabled", label: "new-coin scanning", words: ["discovery", "scanning", "new coin scanning", "watch for new pairs", "find new coins", "look for new coins"], where: W.DISCOVERY, kind: "bool", route: "chat", help: "look for newly launched coins" }),
  e({ key: "discoveryIntervalMin", label: "minutes between new-coin scans", words: ["scan interval", "discovery interval", "scan every"], where: W.DISCOVERY, kind: "minutes", min: 1, max: 1_440, route: "chat", help: "how often to scan for new coins" }),
  e({ key: "deskEnabled", label: "research before deciding", words: ["research before deciding", "desk", "research mode", "think harder"], where: W.DISCOVERY, kind: "bool", route: "dashboard", help: "let the AI research before each decision (more model calls)" }),
  e({ key: "deskMaxSteps", label: "research steps per decision", words: ["research steps", "desk steps"], where: W.DISCOVERY, kind: "int", min: 1, max: 12, route: "dashboard", help: "how many research calls one decision may make" }),
  e({ key: "scoutEnabled", label: "scout mode", words: ["scout", "scout mode", "unpriced coins", "buy unpriced coins"], where: W.DISCOVERY, kind: "bool", route: "dashboard", risk: "real-money", help: "buy tokens with no reliable price, within the scout budget" }),
  e({ key: "scoutBudgetUsdg", label: "scout budget", words: ["scout budget"], where: W.DISCOVERY, kind: "usd", min: 0, max: 1_000_000, route: "dashboard", risk: "real-money", help: "the most held at once in tokens with no reliable price" }),
  e({ key: "scoutPerTokenUsdg", label: "scout max per token", words: ["scout per token", "max per token", "scout max per token"], where: W.DISCOVERY, kind: "usd", min: 0, max: 1_000_000, route: "dashboard", risk: "real-money", help: "the most in any one token with no reliable price" }),
  e({ key: "classSnipeEnabled", label: "launchpad buying", words: ["launchpad buying", "launchpad", "launch buying", "launchpad sniping", "class route", "class sniping", "sniping"], where: `${W.DISCOVERY} → launchpad buying`, kind: "bool", route: "dashboard", risk: "real-money", help: "buy coins straight off a launchpad bonding curve" }),
  e({ key: "classPerEntryUsdg", label: "amount per launch coin", words: ["launch size", "per launch coin", "launch buy size", "per entry", "amount per launch coin"], where: `${W.DISCOVERY} → launchpad buying`, kind: "usd", min: 0, max: 1_000_000, zero: "$0.00 (launchpad buying buys nothing)", route: "chat", help: "how much goes into each launchpad coin" }),
  e({ key: "classMaxPositions", label: "max launch coins held", words: ["max positions", "max coins", "max launch coins", "launch coins held", "max open positions"], where: `${W.DISCOVERY} → launchpad buying`, kind: "int", min: 0, max: 1_000, zero: "no limit", route: "chat", help: "how many launchpad coins are held at once" }),
  e({ key: "classMaxHoldSec", label: "longest launch-coin hold", words: ["max hold", "hold time", "longest hold", "hold launch coins for"], where: `${W.DISCOVERY} → launchpad buying`, kind: "hoursAsSec", min: 60, max: 30 * 86_400, route: "chat", help: "sell a launchpad coin after this long" }),
  e({ key: "classExitAtGraduationPct", label: "sell launch coins at % to graduation", words: ["graduation exit", "exit at graduation", "sell at graduation"], where: `${W.DISCOVERY} → launchpad buying`, kind: "int", min: 1, max: 100, route: "chat", help: "sell before the coin leaves the launchpad" }),
  e({ key: "customTokens", label: "custom tokens", words: ["custom token", "custom tokens", "add a token", "add token"], where: W.DISCOVERY, kind: "special", route: "dashboard", help: "tokens added by contract address" }),

  // ── telegram ───────────────────────────────────────────────────────────────
  e({ key: "telegramEnabled", label: "Telegram", words: ["telegram", "telegram bot"], where: W.TELEGRAM, kind: "bool", route: "dashboard", help: "the Telegram bot on or off" }),
  e({ key: "telegramNotifyEnabled", label: "all Telegram messages", words: ["notifications", "all notifications", "alerts", "all messages"], where: W.TELEGRAM_CONTROLS, kind: "bool", route: "dashboard", risk: "silences-warnings", help: "every message, including the warnings about your money" }),
  e({ key: "telegramNotifyEveryMin", label: "trade message batching (minutes)", words: ["batching", "trade messages", "trade pings", "pings", "summary interval", "message me every"], where: W.TELEGRAM_CONTROLS, kind: "minutes", min: 0, max: 1_440, zero: "off (a message per trade)", route: "chat", help: "0 sends a message per trade; otherwise one summary every N minutes" }),
  e({ key: "telegramDigestHour", label: "daily report hour (UTC)", words: ["report hour", "digest hour", "daily report", "daily summary"], where: W.TELEGRAM_CONTROLS, kind: "hour", min: 0, max: 23, route: "chat", help: "when the daily report arrives" }),
  e({ key: "telegramControlEnabled", label: "control from Telegram", words: ["telegram control", "chat control", "control from telegram"], where: W.TELEGRAM_CONTROLS, kind: "bool", route: "dashboard", help: "let the chat pause, trade and change settings" }),
  e({ key: "telegramTransferEnabled", label: "Telegram transfers", words: ["transfers", "telegram transfers", "send from telegram"], where: W.TELEGRAM_CONTROLS, kind: "bool", route: "dashboard", risk: "real-money", help: "allow sending USDG out from the chat, within the daily budget" }),
  e({ key: "telegramTransferDailyUsdg", label: "daily transfer budget", words: ["transfer budget", "daily transfer"], where: W.TELEGRAM_CONTROLS, kind: "usd", min: 1, max: 1_000_000, route: "dashboard", risk: "real-money", help: "the most the chat may send out in a day" }),
  e({ key: "telegramAllowlist", label: "who may control the bot", words: ["allowlist", "who can control", "allowed chats"], where: W.TELEGRAM_CONTROLS, kind: "special", route: "dashboard", help: "the chats allowed to command the bot" }),
  e({ key: "telegramGroupsEnabled", label: "hang out in Telegram groups", words: ["groups", "telegram groups", "group chats", "group chat"], where: `${W.TELEGRAM} → Telegram groups`, kind: "bool", route: "dashboard", help: "join in Telegram groups it is added to" }),
  e({ key: "telegramGroupCoinsEnabled", label: "look at coins people post", words: ["group coins", "coins people post"], where: `${W.TELEGRAM} → Telegram groups`, kind: "bool", route: "dashboard", help: "look at coins posted in groups" }),
  e({ key: "telegramGroupsChattiness", label: "how chatty in groups", words: ["chattiness", "how chatty", "group chattiness"], where: `${W.TELEGRAM} → Telegram groups`, kind: "enum", values: ["quiet", "normal", "chatty"], synonyms: { quieter: "quiet", silent: "quiet", less: "quiet", more: "chatty", louder: "chatty", talkative: "chatty", default: "normal" }, route: "dashboard", help: "how often it joins in unprompted" }),

  // ── computer access (self-hosted only) ─────────────────────────────────────
  e({ key: "telegramPcControlEnabled", label: "computer control from Telegram", words: ["pc control", "computer control", "control my computer"], where: W.COMPUTER, kind: "bool", route: "dashboard", risk: "remote-control", hostedForbidden: true, help: "let the chat act on this computer" }),
  e({ key: "telegramAgentEnabled", label: "agent mode", words: ["agent mode", "computer agent"], where: W.COMPUTER, kind: "bool", route: "dashboard", risk: "remote-control", hostedForbidden: true, help: "let the chat run multi-step tasks on this computer" }),
  e({ key: "telegramAgentAutoShell", label: "free-form shell", words: ["auto shell", "free form shell", "shell without asking"], where: W.COMPUTER, kind: "bool", route: "dashboard", risk: "remote-control", hostedForbidden: true, help: "run shell commands without confirming each" }),
  e({ key: "telegramAgentMaxSteps", label: "agent step budget", words: ["agent steps", "step budget"], where: W.COMPUTER, kind: "int", min: 1, max: 60, route: "dashboard", hostedForbidden: true, help: "how many steps one agent task may take" }),

  // ── agent ──────────────────────────────────────────────────────────────────
  e({ key: "agentName", label: "agent name", words: ["name", "agent name", "your name", "call you"], where: W.AGENT, kind: "text", route: "chat", help: "what the agent is called" }),
  e({ key: "virtualsEnabled", label: "publish to Virtuals", words: ["virtuals"], where: W.VIRTUALS, kind: "bool", route: "dashboard", help: "publish landed trades and activity to Virtuals" }),
  e({ key: "publicBook", label: "public book", words: ["public book", "publish holdings", "show my trades publicly"], where: W.PROFILE, kind: "bool", route: "dashboard", help: "publish holdings, sizes and dollar P&L" }),
  e({ key: "xPosting", label: "posting on X", words: ["post on x", "posting on x", "x posting", "tweets", "tweeting", "twitter"], where: W.X, kind: "special", route: "dashboard", help: "posts to the owner's X account" }),

  // ── sealed in the signature ───────────────────────────────────────────────
  e({ key: "perTradeCap", label: "per-trade limit", words: ["per trade limit", "per-trade limit", "max per trade", "trade cap"], where: "the trading permission (/grant)", kind: "special", route: "sealed", help: "the most one trade may use, signed on chain" }),
  e({ key: "dailyCap", label: "daily limit", words: ["daily limit", "daily cap", "max per day", "spend per day"], where: "the trading permission (/grant)", kind: "special", route: "sealed", help: "the most spent in a day, signed on chain" }),
  e({ key: "drawdownBreaker", label: "loss breaker", words: ["loss breaker", "drawdown", "drawdown breaker", "circuit breaker"], where: "the trading permission (/grant)", kind: "special", route: "sealed", help: "stops trading after this much loss, signed on chain" }),
  e({ key: "expiry", label: "how long the permission lasts", words: ["expiry", "permission length", "how long the key lasts"], where: "the trading permission (/grant)", kind: "special", route: "sealed", help: "when the signed permission runs out" }),

  // ── secrets ────────────────────────────────────────────────────────────────
  e({ key: "anthropicApiKey", label: "Anthropic key", words: ["anthropic key", "claude key"], where: W.AGENT, kind: "special", route: "secret", help: "an AI provider key" }),
  e({ key: "groqApiKey", label: "Groq key", words: ["groq key"], where: W.AGENT, kind: "special", route: "secret", help: "an AI provider key" }),
  e({ key: "llmApiKey", label: "AI provider key", words: ["api key", "ai key", "provider key", "openai key"], where: W.AGENT, kind: "special", route: "secret", help: "an AI provider key" }),
  e({ key: "telegramBotToken", label: "Telegram bot token", words: ["bot token", "telegram token"], where: W.TELEGRAM, kind: "special", route: "secret", help: "the token that connects your bot" }),
] as CatalogEntry[]);

/** The keys a linked chat may change on a ✅ button — exactly SETTING_SPECS plus the name. */
export const CHAT_ROUTE_KEYS: readonly string[] = Object.freeze(
  SETTINGS_CATALOG.filter((s) => s.route === "chat").map((s) => s.key),
);

const BY_KEY: ReadonlyMap<string, CatalogEntry> = new Map(SETTINGS_CATALOG.map((s) => [s.key, s]));

export function catalogEntry(key: string): CatalogEntry | undefined {
  return BY_KEY.get(key);
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9%$.]+/g, " ").trim();

/** The entry a phrase names: a key, a label, or one of its words. Null when nothing matches. */
export function catalogEntryFor(phrase: string): CatalogEntry | null {
  const raw = phrase.trim();
  const byKey = BY_KEY.get(raw);
  if (byKey) return byKey;
  const p = norm(raw);
  if (!p) return null;
  for (const s of SETTINGS_CATALOG) {
    if (norm(s.key) === p || norm(s.label) === p || s.words.some((w) => norm(w) === p)) return s;
  }
  return null;
}

// ── values ───────────────────────────────────────────────────────────────────

export type ValueParse = { ok: true; value: unknown } | { ok: false; reason: string };

const OFF_WORDS = /^(off|none|no|disable|disabled|zero|nothing|never|stop|false|0)$/i;
const ON_WORDS = /^(on|yes|enable|enabled|true|start|allow|allowed|1)$/i;

/** "$1,500", "1.5k", "20 usdg", "20 dollars" -> 1500 / 20. */
function parseAmount(text: string): number | null {
  const t = text.toLowerCase().replace(/[$,]/g, "").replace(/\b(usdg|usd|dollars?|bucks)\b/g, "").trim();
  const m = /^(\d+(?:\.\d+)?)\s*(k|m|thousand|million)?$/.exec(t);
  if (!m) return null;
  const mult = m[2] === "k" || m[2] === "thousand" ? 1_000 : m[2] === "m" || m[2] === "million" ? 1_000_000 : 1;
  return Number(m[1]) * mult;
}

function range(entry: CatalogEntry, stored: number, shown: string): ValueParse {
  if (!Number.isFinite(stored)) return { ok: false, reason: `"${shown}" is not a number` };
  if (entry.min !== undefined && stored < entry.min) return { ok: false, reason: `${entry.label} can't go below ${formatCatalogValue({ ...entry, zero: undefined }, entry.min)}` };
  if (entry.max !== undefined && stored > entry.max) return { ok: false, reason: `${entry.label} can't go above ${formatCatalogValue({ ...entry, zero: undefined }, entry.max)}` };
  return { ok: true, value: stored };
}

/**
 * The owner's words for one setting, as the value PUT /api/settings stores.
 * Refuses rather than clamps: a clamped number is one the owner did not ask for.
 */
export function parseCatalogValue(entry: CatalogEntry, raw: string, ctx: { symbols?: readonly string[] } = {}): ValueParse {
  const text = raw.trim();
  if (!text) return { ok: false, reason: `no value given for ${entry.label}` };
  if (entry.route === "secret") return { ok: false, reason: `${entry.label} is never taken from a message — paste it into ${entry.where}` };
  switch (entry.kind) {
    case "special":
      return { ok: false, reason: `${entry.label} is changed in ${entry.where}` };
    case "bool":
      if (ON_WORDS.test(text)) return { ok: true, value: true };
      if (OFF_WORDS.test(text)) return { ok: true, value: false };
      return { ok: false, reason: `say on or off for ${entry.label}` };
    case "enum": {
      const t = text.toLowerCase();
      const hit = entry.values!.find((v) => v === t) ?? entry.synonyms?.[t];
      return hit ? { ok: true, value: hit } : { ok: false, reason: `${entry.label} can be ${entry.values!.join(", ")}` };
    }
    case "text": {
      // The only text setting is the agent's name, held to the rule /name and
      // the web route already apply (agent-name.ts): up to 24 characters, at
      // least one letter, normalised the same way.
      const t = normalizeAgentName(text);
      return AGENT_NAME_RE.test(t) ? { ok: true, value: t } : { ok: false, reason: `that isn't a usable ${entry.label} — up to 24 letters, numbers, spaces, ' . or -, with at least one letter` };
    }
    case "symbols": {
      const list = text.toUpperCase().split(/[\s,;+&]+|\band\b/i).map((s) => s.trim()).filter(Boolean);
      if (!list.length || list.length > 10) return { ok: false, reason: "a basket is 1 to 10 tickers" };
      const allowed = ctx.symbols ? new Set(ctx.symbols.map((s) => s.toUpperCase())) : null;
      const bad = allowed ? list.filter((s) => !allowed.has(s)) : list.filter((s) => !/^[A-Z0-9.]{1,12}$/.test(s));
      return bad.length ? { ok: false, reason: `not a known ticker: ${bad.join(", ")}` } : { ok: true, value: [...new Set(list)] };
    }
    case "pct": {
      if (entry.zero && OFF_WORDS.test(text)) return range(entry, 0, text);
      const m = /^(\d+(?:\.\d+)?)\s*(%|percent|pct)?$/i.exec(text.replace(/\s+/g, " "));
      if (!m) return { ok: false, reason: `give ${entry.label} as a percentage, like 8%` };
      return range(entry, Math.round(Number(m[1]) * 100), text);
    }
    case "usd": {
      if (entry.zero && OFF_WORDS.test(text)) return range(entry, 0, text);
      const n = parseAmount(text);
      return n === null ? { ok: false, reason: `give ${entry.label} in dollars, like $20` } : range(entry, n, text);
    }
    case "int": {
      if (entry.zero && /^(no limit|unlimited|none|off)$/i.test(text)) return range(entry, 0, text);
      const m = /^(\d+)$/.exec(text.replace(/,/g, ""));
      return m ? range(entry, Number(m[1]), text) : { ok: false, reason: `give ${entry.label} as a whole number` };
    }
    case "minutes":
    case "seconds":
    case "hoursAsSec": {
      if (entry.zero && /^(every trade|each trade|per trade|instantly|immediately|off|none|never|0)$/i.test(text)) return range(entry, 0, text);
      // "once an hour", "hourly", "every hour", "daily", "twice an hour".
      const spoken = text.toLowerCase().replace(/^(once\s+(an?|per)|every|each|per)\s+/, "").trim();
      const named = /^(an?\s+)?(hour|hourly)$/.test(spoken) ? "1h" : /^(day|daily)$/.test(spoken) ? "1d" : /^(minute)$/.test(spoken) ? "1m" : spoken;
      const m = /^(\d+(?:\.\d+)?)\s*(s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?)?$/i.exec(named);
      if (!m) return { ok: false, reason: `give ${entry.label} as a time, like 30m or 2h` };
      const unit = (m[2] ?? (entry.kind === "seconds" ? "s" : entry.kind === "minutes" ? "m" : "h")).toLowerCase();
      const secs = Number(m[1]) * (unit.startsWith("s") ? 1 : unit.startsWith("m") ? 60 : unit.startsWith("h") ? 3_600 : 86_400);
      const stored = entry.kind === "minutes" ? secs / 60 : secs;
      if (!Number.isInteger(stored)) return { ok: false, reason: `${entry.label} is in whole ${entry.kind === "minutes" ? "minutes" : "seconds"}` };
      return range(entry, stored, text);
    }
    case "hour": {
      const m = /^(\d{1,2})(?::00)?\s*(am|pm)?(?:\s*utc)?$/i.exec(text.trim());
      if (!m) return { ok: false, reason: "give an hour, like 8am or 20" };
      let h = Number(m[1]);
      const ap = m[2]?.toLowerCase();
      if (ap === "pm" && h < 12) h += 12;
      if (ap === "am" && h === 12) h = 0;
      return range(entry, h, text);
    }
  }
}

/** Is this STORED value one the dashboard would save for this key? */
export function validCatalogValue(key: string, v: unknown): boolean {
  const s = BY_KEY.get(key);
  if (!s || s.route === "secret" || s.route === "sealed" || s.kind === "special") return false;
  switch (s.kind) {
    case "bool":
      return typeof v === "boolean";
    case "enum":
      return typeof v === "string" && s.values!.includes(v);
    case "text":
      return typeof v === "string" && AGENT_NAME_RE.test(normalizeAgentName(v));
    case "symbols":
      return Array.isArray(v) && v.length >= 1 && v.length <= 10 && v.every((x) => typeof x === "string" && /^[A-Z0-9.]{1,12}$/.test(x));
    default:
      return typeof v === "number" && Number.isFinite(v) && (s.min === undefined || v >= s.min) && (s.max === undefined || v <= s.max) &&
        (s.kind === "usd" || Number.isInteger(v));
  }
}

/** A stored value, in the owner's words. */
export function formatCatalogValue(entry: Pick<CatalogEntry, "kind" | "zero">, v: unknown): string {
  if (v === undefined || v === null) return "not set";
  if (v === 0 && entry.zero) return entry.zero;
  switch (entry.kind) {
    case "bool":
      return v ? "on" : "off";
    case "usd":
      return typeof v === "number" ? `$${v.toFixed(2)}` : String(v);
    case "pct":
      return typeof v === "number" ? `${+(v / 100).toFixed(2)}%` : String(v);
    case "hoursAsSec":
      return typeof v === "number" ? (v % 3_600 === 0 ? `${v / 3_600}h` : `${Math.round(v / 60)}m`) : String(v);
    case "minutes":
      return typeof v === "number" ? `${v} min` : String(v);
    case "seconds":
      return typeof v === "number" ? `${v}s` : String(v);
    case "hour":
      return typeof v === "number" ? `${String(v).padStart(2, "0")}:00 UTC` : String(v);
    case "symbols":
      return Array.isArray(v) ? v.join(", ") : String(v);
    default:
      return String(v);
  }
}

// ── proposals ────────────────────────────────────────────────────────────────

export interface ProposalRow {
  key: string;
  label: string;
  where: string;
  route: SettingRoute;
  risk?: SettingRisk;
  before: unknown;
  after: unknown;
  beforeText: string;
  afterText: string;
}

export interface Proposal {
  rows: ProposalRow[];
  /** Things asked for that cannot be changed this way, each with why and where. */
  refused: { phrase: string; reason: string; key?: string; route?: SettingRoute }[];
}

/**
 * Turn requested changes into rows with before and after, refusing — never
 * guessing — anything it cannot parse. A change to what it already is is
 * dropped silently: it is not a change.
 */
export function buildProposal(
  changes: readonly { key: string; raw?: string; value?: unknown }[],
  current: Readonly<Record<string, unknown>>,
  ctx: { symbols?: readonly string[]; hosted?: boolean } = {},
): Proposal {
  const rows: ProposalRow[] = [];
  const refused: Proposal["refused"] = [];
  const seen = new Set<string>();
  for (const c of changes) {
    const entry = BY_KEY.get(c.key) ?? catalogEntryFor(c.key);
    if (!entry) {
      refused.push({ phrase: c.key, reason: `I don't have a setting called "${c.key}"` });
      continue;
    }
    if (seen.has(entry.key)) continue;
    seen.add(entry.key);
    if (entry.route === "sealed") {
      refused.push({ phrase: entry.label, key: entry.key, route: "sealed", reason: `${entry.label} is part of the permission you signed — only a new signature changes it` });
      continue;
    }
    if (entry.route === "secret") {
      refused.push({ phrase: entry.label, key: entry.key, route: "secret", reason: `never send ${entry.label} in a message — paste it into ${entry.where}` });
      continue;
    }
    if (entry.kind === "special") {
      refused.push({ phrase: entry.label, key: entry.key, route: entry.route, reason: `${entry.label} is changed in ${entry.where}` });
      continue;
    }
    if (ctx.hosted && entry.hostedForbidden) {
      refused.push({ phrase: entry.label, key: entry.key, route: entry.route, reason: `${entry.label} only exists on a self-hosted agent` });
      continue;
    }
    let after: unknown;
    if (c.value !== undefined) {
      if (!validCatalogValue(entry.key, c.value)) {
        refused.push({ phrase: entry.label, key: entry.key, reason: `that isn't a value ${entry.label} can take` });
        continue;
      }
      after = c.value;
    } else {
      const parsed = parseCatalogValue(entry, c.raw ?? "", ctx);
      if (!parsed.ok) {
        refused.push({ phrase: entry.label, key: entry.key, reason: parsed.reason });
        continue;
      }
      after = parsed.value;
    }
    const before = current[entry.key];
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    rows.push({
      key: entry.key,
      label: entry.label,
      where: entry.where,
      route: entry.route,
      ...(entry.risk ? { risk: entry.risk } : {}),
      before,
      after,
      beforeText: formatCatalogValue(entry, before),
      afterText: formatCatalogValue(entry, after),
    });
  }
  return { rows, refused };
}

/** The route one approval must take: the strictest of the rows'. */
export function proposalRoute(rows: readonly ProposalRow[]): "chat" | "dashboard" | null {
  if (!rows.length) return null;
  return rows.every((r) => r.route === "chat") ? "chat" : "dashboard";
}

/** What a risky change needs said before it is approved. */
export function riskWarning(risk: SettingRisk | undefined, after: unknown): string | null {
  if (risk === "real-money" && after !== false && after !== 0) return "This lets the agent spend real money.";
  if (risk === "safety-floor") return "This changes a check that stops buys at a manipulated price.";
  if (risk === "silences-warnings" && after === false) return "This also silences the warnings about your money.";
  if (risk === "remote-control" && after !== false) return "This lets the chat act on this computer.";
  return null;
}

// ── the dashboard approval link ─────────────────────────────────────────────

/**
 * A proposal, carried in a link to the Settings page.
 *
 * AN UNSIGNED SUGGESTION, AND THE PAGE TREATS IT AS ONE. A worker process holds
 * no secret the web shares (the orchestrator strips the session secret from
 * children on purpose), so this cannot be signed — anyone could write such a
 * link. That is why approval happens on the page, signed in, with the diff and
 * the page's warnings in front of the owner, and why secrets are never carried.
 */
export interface LinkProposal {
  v: 1;
  changes: [string, unknown][];
}

const b64url = (s: string) =>
  (typeof Buffer !== "undefined" ? Buffer.from(s, "utf8").toString("base64") : btoa(unescape(encodeURIComponent(s))))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => {
  const b = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return typeof Buffer !== "undefined" ? Buffer.from(b, "base64").toString("utf8") : decodeURIComponent(escape(atob(b)));
};

export const PROPOSAL_PARAM = "propose";
/** A link is a suggestion of a handful of changes, never a settings dump. */
export const PROPOSAL_MAX_CHANGES = 12;

export function encodeProposalLink(rows: readonly Pick<ProposalRow, "key" | "after">[]): string {
  const changes = rows
    .filter((r) => validCatalogValue(r.key, r.after))
    .slice(0, PROPOSAL_MAX_CHANGES)
    .map((r) => [r.key, r.after] as [string, unknown]);
  return b64url(JSON.stringify({ v: 1, changes } satisfies LinkProposal));
}

/** The changes a link carries, each re-validated. Anything malformed is dropped. */
export function decodeProposalLink(param: string | null | undefined): { key: string; value: unknown }[] {
  if (!param || param.length > 4_000) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(unb64url(param));
  } catch {
    return [];
  }
  const p = parsed as Partial<LinkProposal> | null;
  if (!p || p.v !== 1 || !Array.isArray(p.changes)) return [];
  const out: { key: string; value: unknown }[] = [];
  const seen = new Set<string>();
  for (const c of p.changes.slice(0, PROPOSAL_MAX_CHANGES)) {
    if (!Array.isArray(c) || c.length !== 2 || typeof c[0] !== "string" || seen.has(c[0])) continue;
    if (!validCatalogValue(c[0], c[1])) continue;
    seen.add(c[0]);
    out.push({ key: c[0], value: c[1] });
  }
  return out;
}

// ── understanding a sentence without a model ───────────────────────────────

/**
 * Bundles an owner asks for by intent rather than by setting. Each is a set of
 * ordinary changes that then go through buildProposal like any other.
 */
export function presetChanges(level: RiskLevel): { key: string; value: unknown }[] {
  return Object.entries(RISK_PROFILES[level].settings).map(([key, value]) => ({ key, value }));
}

const INTENTS: readonly { re: RegExp; changes: () => { key: string; value?: unknown; raw?: string }[] }[] = [
  { re: /\b(more careful|be careful|careful|cautious|conservative|safer|play it safe|less risk|lower risk|less risky|risk[- ]averse)\b/, changes: () => presetChanges("careful") },
  { re: /\b(bolder|be bold|aggressive|more aggressive|riskier|more risk|higher risk|degen|yolo)\b/, changes: () => presetChanges("bold") },
  { re: /\b(balanced|moderate|middle of the road|normal risk|default risk)\b/, changes: () => presetChanges("balanced") },
  { re: /\bonly (?:buy |trade )?(?:stocks?|equities|shares)\b|\bstocks only\b/, changes: () => [{ key: "assetMode", value: "stocks" }] },
  { re: /\bonly (?:buy |trade )?(?:crypto|coins?|memecoins?|tokens)\b|\bcrypto only\b/, changes: () => [{ key: "assetMode", value: "crypto" }] },
  { re: /\b(?:stocks and crypto|crypto and stocks|all assets|trade everything|buy everything)\b/, changes: () => [{ key: "assetMode", value: "all" }] },
  { re: /\b(?:go live|use real money|trade for real|start (?:live|real) trading)\b/, changes: () => [{ key: "liveTradingEnabled", value: true }] },
  { re: /\b(?:stop (?:using )?real money|go back to practice|practice only|paper only|stop live trading)\b/, changes: () => [{ key: "liveTradingEnabled", value: false }, { key: "paperTradingEnabled", value: true }] },
  { re: /\b(?:message me less|fewer (?:messages|pings)|less (?:messages|pings)|stop spamming|too many messages)\b/, changes: () => [{ key: "telegramNotifyEveryMin", value: 60 }] },
  { re: /\b(?:message me every trade|tell me every trade|a message per trade)\b/, changes: () => [{ key: "telegramNotifyEveryMin", value: 0 }] },
  { re: /\b(?:hunt (?:for )?(?:memecoins|gems)|trade memecoins|memecoin mode|trencher mode)\b/, changes: () => [{ key: "strategy", value: "trencher" }, { key: "assetMode", value: "crypto" }, { key: "discoveryEnabled", value: true }] },
];

/** Value-shaped text at the end of a clause: "$20", "8%", "2h", "on", "8pm", "stocks". */
const VALUE_RE = /(?:\bto\b|\bat\b|=|:|\bis\b|\bof\b)?\s*(\$?\d[\d,]*(?:\.\d+)?\s*(?:k|m|%|percent|usdg|usd|dollars?|s|secs?|seconds?|mins?|minutes?|h|hrs?|hours?|d|days?|am|pm)?|\bon\b|\boff\b|\byes\b|\bno\b|\bnone\b|\bno limit\b|\bunlimited\b|[a-z][a-z -]{0,24})\s*$/i;

/**
 * Changes named in a sentence, with no model: "make each buy $20 and stop loss
 * at 8%", "be more careful", "only stocks". Best-effort and conservative — a
 * clause it cannot read is skipped, never guessed at. The model path asks for
 * the same `key=value` shape and lands in the same buildProposal.
 */
export function understandSettingsText(text: string): { key: string; raw?: string; value?: unknown }[] {
  const out: { key: string; raw?: string; value?: unknown }[] = [];
  const lower = ` ${text.toLowerCase().replace(/\s+/g, " ")} `;

  // Explicit `key=value` pairs, the shape the model is asked for.
  for (const m of text.matchAll(/([A-Za-z][A-Za-z0-9]+)\s*=\s*([^;,\n]+)/g)) {
    const entry = BY_KEY.get(m[1]!);
    if (entry) out.push({ key: entry.key, raw: m[2]!.trim() });
  }

  // Clauses: "make each buy $20, stop loss at 8% and take profit 25%".
  const words = [...SETTINGS_CATALOG.flatMap((s) => [s.label, ...s.words].map((w) => ({ w: norm(w), s })))]
    .filter((x) => x.w.length >= 2)
    .sort((a, b) => b.w.length - a.w.length);
  for (const clause of lower.split(/[;,\n]|\band\b|\bthen\b|\balso\b/)) {
    const c = ` ${norm(clause)} `;
    const hit = words.find((x) => c.includes(` ${x.w} `));
    if (!hit || out.some((o) => o.key === hit.s.key)) continue;
    const tail = c.slice(c.indexOf(` ${hit.w} `) + hit.w.length + 1).trim();
    const v = VALUE_RE.exec(tail);
    const raw = v?.[1]?.trim();
    if (!raw) continue;
    if (parseCatalogValue(hit.s, raw).ok) out.push({ key: hit.s.key, raw });
  }

  // Intents LAST: buildProposal keeps the first change per key, so a number the
  // owner named ("be careful, but each buy $15") beats the bundle's own.
  for (const intent of INTENTS) if (intent.re.test(lower)) out.push(...intent.changes());
  return out;
}

/**
 * The catalog as a model is shown it: key, what it means, and how a value is
 * written. `compact` drops the help line and `except` the keys a prompt already
 * lists — the Telegram classifier runs on every message, on a shared key whose
 * daily allowance has run out before, so its list is as short as it can be.
 */
export function catalogForPrompt(opts: { compact?: boolean; except?: readonly string[] } = {}): string {
  const skip = new Set(opts.except ?? []);
  const unit = (s: CatalogEntry) =>
    s.kind === "usd" ? "dollars" : s.kind === "pct" ? "percent" : s.kind === "bool" ? "on/off" : s.kind === "enum" ? s.values!.join("|") :
    s.kind === "minutes" ? "minutes" : s.kind === "seconds" ? "seconds" : s.kind === "hoursAsSec" ? "hours" : s.kind === "hour" ? "hour of day" :
    s.kind === "symbols" ? "tickers" : s.kind === "int" ? "whole number" : s.kind === "text" ? "text" : "not by message";
  return SETTINGS_CATALOG.filter((s) => !skip.has(s.key) && s.kind !== "special")
    .map((s) => (opts.compact ? `  ${s.key} — ${s.label} (${unit(s)})` : `  ${s.key} — ${s.label} (${unit(s)}): ${s.help}`))
    .join("\n");
}
