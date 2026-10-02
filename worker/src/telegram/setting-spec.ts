/**
 * WHICH SETTINGS AN OWNER CAN CHANGE BY TEXTING, AND WHAT EACH ONE ACCEPTS.
 *
 * One table is the whole decision: it is the allowlist a chat change is
 * checked against (chat-settings.ts `CHAT_SETTABLE` is derived from it), the
 * validator a value must pass BEFORE the owner is asked to confirm and AGAIN
 * before the orchestrator stores it, and the plain-English label the owner
 * reads. Keeping those in one row means a key cannot be settable without also
 * being bounded and named.
 *
 * ── WHAT IS HERE, AND WHY THE LINE IS WHERE IT IS ────────────────────────
 *
 * A linked chat is reached through a BEARER link code, so this list is a
 * security boundary and not a convenience list. The owner asked to be able to
 * change their settings by text (2026-09-23), so it now covers the trading
 * preferences that work INSIDE the limits the owner signed on chain — sizes,
 * take-profit and stop-loss, strategy, basket, alerts — because the signed
 * per-trade and daily caps bound every one of them whatever value is chosen.
 *
 * It deliberately does NOT cover:
 *   - switches that start spending real money where none was being spent
 *     (`liveTradingEnabled`, `trencherLiveEnabled`, `scoutEnabled`,
 *     `classSnipeEnabled`) — the step from practice to real money stays a
 *     dashboard act, as chat-settings.test.ts has always pinned;
 *   - letting the agent post on the owner's X account, which needs a
 *     warning naming that account (DASHBOARD_ONLY.xPosting);
 *   - the floors that protect against manipulated prices
 *     (`minPoolLiquidityUsdg`, `maxPriceDivergenceBps`, `maxImpactBps`,
 *     `classMinDepthUsdg`) — lowering one is how a pushed price gets through;
 *   - anything remote-execution, secret, house-owned, the allowlist, transfers,
 *     or Telegram's own on/off switches;
 *   - how it behaves in Telegram groups (DASHBOARD_ONLY.telegramGroups), since
 *     a group is a chat anyone in it can type into.
 * Those answer with a button to the dashboard instead (DASHBOARD_ONLY).
 *
 * The limits SEALED in the signed permission — per-trade cap, daily cap,
 * expiry, drawdown breaker — are not settings at all. Asking to change one
 * gets the "Sign now" button, because a signature is the only thing that can.
 *
 * ── UNITS ─────────────────────────────────────────────────────────────────
 *
 * Every bound below is the SAME range `worker/src/settings.ts` `mergeSettings`
 * resolves with, and out-of-range input is REFUSED, never clamped: `num()`
 * there silently falls back to the default for a bad value, so storing one
 * would make "set it to 0" quietly mean "set it to 25".
 * Percentages are shown as % and stored as basis points; hold time is shown in
 * hours and stored in seconds.
 */

import { STOCK_TOKENS } from "../../../packages/core/src/index";

export type SettingKind =
  | "usd" // dollars, 2dp
  | "int" // whole number
  | "pct" // shown %, stored bps
  | "bool"
  | "enum"
  | "symbols" // a basket of tickers
  | "strategy"
  | "hoursAsSec"; // shown hours, stored seconds

export interface SettingSpec {
  key: string;
  /** What the owner reads. Lowercase, no jargon. */
  label: string;
  kind: SettingKind;
  /** Inclusive, in the STORED unit. */
  min?: number;
  max?: number;
  values?: readonly string[];
  /** One line on what it does, for the list and for the model. */
  help: string;
  /**
   * What a stored 0 means, when it is not "none": "no limit". Without it
   * /settings printed "max launch coins held: 0", and the agent reading that
   * list told an owner to raise it before launchpad buying could buy, when 0
   * is the one value that never blocks a buy.
   */
  zero?: string;
}

/** The chat-settable table. Order is the order the owner sees in /settings. */
export const SETTING_SPECS: readonly SettingSpec[] = Object.freeze([
  { key: "strategy", label: "trading strategy", kind: "strategy", help: "which playbook I trade with" },
  { key: "buyPerTickUsdg", label: "amount per buy", kind: "usd", min: 1, max: 100_000, help: "how much I put into each buy" },
  { key: "llmMaxActionUsdg", label: "max per AI trade", kind: "usd", min: 1, max: 100_000, help: "the most one AI-chosen trade can use" },
  { key: "telegramMaxActionUsdg", label: "max per chat trade", kind: "usd", min: 1, max: 100_000, help: "the most one /buy or /sell from this chat can use" },
  { key: "classPerEntryUsdg", label: "amount per launch coin", kind: "usd", min: 0, max: 1_000_000, help: "how much I put into each new launchpad coin", zero: "$0.00 (launchpad buying buys nothing)" },
  { key: "idleFloorUsdg", label: "cash kept aside", kind: "usd", min: 0, max: 1_000_000, help: "cash I never trade with" },
  { key: "gapEnterBudgetUsdg", label: "weekend-gap budget", kind: "usd", min: 1, max: 1_000_000, help: "what the weekend-gap strategy may use" },
  { key: "takeProfitBps", label: "take profit at", kind: "pct", min: 0, max: 1_000_000, help: "sell a holding once it is up this much (0 = off)" },
  { key: "strategistStopLossBps", label: "stop loss at", kind: "pct", min: 0, max: 10_000, help: "sell a holding once it is down this much (0 = off)" },
  { key: "slippageBps", label: "max slippage", kind: "pct", min: 1, max: 1_000, help: "the worst price move I accept while a trade fills" },
  { key: "llmIntervalMin", label: "minutes between AI decisions", kind: "int", min: 1, max: 1_440, help: "how often the AI looks for a trade" },
  { key: "memecoinMinFdvUsd", label: "smallest coin size I'll buy", kind: "usd", min: 0, max: 1_000_000_000_000, help: "skip coins worth less than this in total (0 = no limit)", zero: "no limit" },
  { key: "assetMode", label: "what I may buy", kind: "enum", values: ["all", "stocks", "crypto"], help: "all, stocks only, or crypto only" },
  { key: "basketSymbols", label: "basket", kind: "symbols", help: "the stock tokens the basket strategy buys" },
  { key: "officialCoinsEnabled", label: "official coins", kind: "bool", help: "trade the chain's official coins" },
  // min 1, not the resolver's 0: stored 0 means NO LIMIT, so a chat "0" meant
  // as "none" would have removed the ceiling. "No limit" stays a dashboard act.
  { key: "classMaxPositions", label: "max launch coins held", kind: "int", min: 1, max: 1_000, help: "how many launchpad coins I hold at once (0, set on the dashboard, means no limit)", zero: "no limit" },
  { key: "classMaxHoldSec", label: "longest launch-coin hold", kind: "hoursAsSec", min: 60, max: 30 * 86_400, help: "sell a launchpad coin after this long" },
  { key: "classExitAtGraduationPct", label: "sell launch coins at % to graduation", kind: "int", min: 1, max: 100, help: "sell before the coin leaves the launchpad" },
  { key: "discoveryEnabled", label: "new-coin scanning", kind: "bool", help: "look for newly launched coins" },
  { key: "discoveryIntervalMin", label: "minutes between new-coin scans", kind: "int", min: 1, max: 1_440, help: "how often I scan for new coins" },
  { key: "telegramNotifyEveryMin", label: "trade message batching (minutes)", kind: "int", min: 0, max: 1_440, help: "0 = a message per trade, otherwise one summary every N minutes", zero: "off (a message per trade)" },
  { key: "telegramDigestHour", label: "daily report hour (server clock, UTC)", kind: "int", min: 0, max: 23, help: "when the daily report arrives" },
] as SettingSpec[]);

/**
 * Asked about, but not changeable by text — with the reason the owner reads.
 * Keyed by the pseudo-key the classifier may emit.
 */
export const DASHBOARD_ONLY: Readonly<Record<string, string>> = Object.freeze({
  liveTrading: "Switching between practice and real money is only done in Settings on the dashboard, so nobody who gets into this chat can start spending your funds.",
  memecoinLive: "Letting the memecoin strategy use real money is only switched on in Settings on the dashboard.",
  scout: "Buying brand-new coins that have no price yet is only switched on in Settings on the dashboard.",
  /**
   * SAYS WHERE, AND WHAT ELSE IT NEEDS. "Only switched on in Settings" sent an
   * owner to a page where nothing was called launchpad anything: the switch sat
   * in a closed group under the name "class route", and the agent, asked where,
   * guessed "near the real money switch". The button under this reply opens
   * that group (settings-chat.ts DASHBOARD_ANCHORS). The rest is what keeps a
   * switched-on route from buying (chat-tools.ts launchpadStillNeeded checks
   * each one for this owner), so the owner is not sent back a second time.
   */
  launchSniping:
    "I can't switch launchpad buying on or off from chat. It's on the dashboard: Settings → Custom tokens & discovery → tick \"launchpad buying (class route)\". The button below opens it. " +
    "It only buys once these are set too: scout mode on (just above it), with a scout budget and a \"max per token\" each at least one launch buy; live trading on; and a \"Class vault factory contract\" under Advanced settings → Connections, then your key re-signed. " +
    "Ask me what's still missing and I'll check.",
  safetyFloors: "The safety checks that stop me buying at a manipulated price (pool depth, price jumps, price impact) are only changed in Settings on the dashboard.",
  customTokens: "Adding a token by its address is done in Settings on the dashboard.",
  aiProvider: "The AI provider and its key are set in Settings on the dashboard.",
  telegram: "Telegram's own switches (on/off, turning ALL my messages off — including the warnings about your money — who may control me, transfers) are only changed on the dashboard. To get fewer trade messages, ask me to batch them, e.g. \"trade messages once an hour\".",
  /**
   * POSTING ON X, never by text (docs/x-posting.md rule 1). Turning it on
   * means confirming a warning that names the X account the posts will come
   * from; a chat reached by a bearer link code cannot show that warning to the
   * owner, and anyone holding the code could otherwise make the agent post
   * under the owner's name.
   *
   * ONE REPLY FOR "ON" AND "OFF" ALIKE, SO IT SAYS BOTH. The owner most likely
   * to type "tweets off" is one whose Merryman just posted something they
   * did not like: the reply has to say the chat changed nothing and where
   * posting IS stopped — on the dashboard or in the app, which both have the
   * switch — and that a waiting post can be skipped there.
   */
  xPosting:
    "I can't turn posting on X on or off from chat. That's done only in Settings → Posting on X, on the dashboard or in the app, where you can also skip a post before it goes out. On the dashboard you can also choose what it posts there: the coins it buys, passing thoughts, and how many a day.",
  /**
   * TELEGRAM GROUPS, never by text (docs/tg-groups.md "Settings"): whether it
   * hangs out in groups at all (`telegramGroupsEnabled`), whether it looks at
   * coins people post there (`telegramGroupCoinsEnabled`) and how often it
   * joins in unprompted (`telegramGroupsChattiness`).
   *
   * A GROUP IS A CHAT ANYONE IN IT CAN TYPE INTO. Rule 4 of the contract is
   * that only the owner shapes the agent, and the settings that decide how it
   * behaves in those rooms are the last thing a room should be able to reach —
   * "look at coins people post" is the door a group's coin nominations come
   * through. So all three are one pseudo-key here, and none is in
   * SETTING_SPECS (chat-settings.test.ts pins them as forbidden).
   *
   * ONE REPLY FOR ON, OFF AND "LESS CHATTY" ALIKE, and it names all three, so
   * an owner asking to quieten it down learns where the dial is rather than
   * reading a refusal about a switch they did not mention.
   */
  telegramGroups:
    "Telegram groups are switched in Settings → Telegram on the dashboard (or Settings in the app): whether I hang out in groups, whether I look at coins people post there, and how chatty I am. Anyone in a group can talk to me, so none of that changes by text.",
});

/** Limits sealed in the signed permission — a signature is the only way to change them. */
export const SEALED_ASKS: Readonly<Record<string, string>> = Object.freeze({
  perTradeCap: "per-trade limit",
  dailyCap: "daily limit",
  expiry: "how long my permission lasts",
  drawdownBreaker: "loss breaker",
  tokens: "which tokens I'm allowed to trade",
});

export const CHAT_SETTING_KEYS: readonly string[] = SETTING_SPECS.map((s) => s.key);

export function specFor(key: string): SettingSpec | null {
  return SETTING_SPECS.find((s) => s.key === key) ?? null;
}

/** Strategy names the settings resolver accepts (settings.ts `strategy`). */
const STRATEGY_RE = /^[A-Za-z0-9_-]{1,64}$/;
/**
 * A ticker as the owner or a token's own settings spell it. Mixed case is
 * allowed: a custom token keeps the symbol it was added with ("wBTC"), and the
 * resolver matches the basket against that spelling exactly.
 */
const SYMBOL_RE = /^[A-Za-z0-9][A-Za-z0-9._$-]{0,15}$/;
const MAX_BASKET = 10;

export type Parsed = { ok: true; value: unknown } | { ok: false; reason: string };

/**
 * The WHOLE text must be the value — nothing left over. Taking "the first
 * number in it" turned "50 bps" into 50%, "0,5%" into 5% and "2x" into 2%:
 * a plausible reading, confirmed with a tap, and a different stored value.
 */
const USD_RE = /^\$?\s*((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*(?:usdg?|dollars?|bucks)?$/i;
const PCT_RE = /^(\d+(?:\.\d+)?)\s*(?:%|percent|pct)?$/i;
const INT_RE = /^(\d+)\s*(?:m|mins?|minutes?)?$/i;
const HOUR_RE = /^(\d{1,2})\s*(am|pm)?(?:\s*utc)?$/i;
const TIME_RE = /^(\d+(?:\.\d+)?)\s*(m|mins?|minutes?|h|hrs?|hours?|d|days?)?$/i;

function understood(text: string, spec: SettingSpec, example: string): Parsed {
  return { ok: false, reason: `I didn't understand "${text}" for ${spec.label} — try something like ${example}` };
}

function range(spec: SettingSpec, stored: number, shown: string): Parsed {
  // A bound is a number, not a meaning: "can't go below 0", never "below no limit".
  const bound = { ...spec, zero: undefined };
  if (spec.min !== undefined && stored < spec.min) return { ok: false, reason: `${spec.label} can't go below ${formatSettingValue(bound, spec.min)} (you asked for ${shown})` };
  if (spec.max !== undefined && stored > spec.max) return { ok: false, reason: `${spec.label} can't go above ${formatSettingValue(bound, spec.max)} (you asked for ${shown})` };
  return { ok: true, value: stored };
}

/**
 * Owner text → the STORED value, or a reason in plain words.
 *
 * `allowedSymbols` is what a basket may contain here: the stock tokens plus
 * this owner's own added tokens. Anything else is refused by name rather than
 * silently dropped — `mergeSettings` would drop it, and the owner would think
 * the basket they asked for is the one they have.
 */
export function parseSettingValue(spec: SettingSpec, raw: string, allowedSymbols?: readonly string[]): Parsed {
  const text = String(raw ?? "").trim();
  switch (spec.kind) {
    case "bool": {
      if (/^(on|yes|true|enable|enabled|start|1)$/i.test(text)) return { ok: true, value: true };
      if (/^(off|no|false|disable|disabled|stop|0)$/i.test(text)) return { ok: true, value: false };
      return { ok: false, reason: `say "on" or "off" for ${spec.label}` };
    }
    case "enum": {
      const v = text.toLowerCase();
      const hit = spec.values!.find((x) => x === v || (v.startsWith("stock") && x === "stocks") || (v === "everything" && x === "all"));
      return hit ? { ok: true, value: hit } : { ok: false, reason: `${spec.label} can be ${spec.values!.join(", ")}` };
    }
    case "strategy": {
      const v = text.toLowerCase().replace(/\s+/g, "-");
      return STRATEGY_RE.test(v) ? { ok: true, value: v } : { ok: false, reason: "that isn't a strategy name" };
    }
    case "symbols": {
      const list = [...new Set(text.split(/[\s,;+&]+|\band\b/i).map((s) => s.trim().replace(/^\$/, "")).filter(Boolean))];
      if (list.length === 0) return { ok: false, reason: "name at least one ticker for the basket" };
      if (list.length > MAX_BASKET) return { ok: false, reason: `the basket holds at most ${MAX_BASKET} tickers` };
      const bad = list.filter((s) => !SYMBOL_RE.test(s));
      if (bad.length) return { ok: false, reason: `${bad.join(", ")} isn't a ticker` };
      if (!allowedSymbols) return { ok: true, value: [...new Set(list.map((s) => s.toUpperCase()))] };
      // STORED IN THE SPELLING THE RESOLVER KNOWS. mergeSettings keeps a basket
      // entry only if it matches a stock or custom-token symbol exactly, so an
      // upper-cased "WBTC" for a token added as "wBTC" was silently dropped and
      // the agent traded the default basket instead.
      const canon = new Map(allowedSymbols.map((s) => [s.toUpperCase(), s]));
      const unknown = list.filter((s) => !canon.has(s.toUpperCase()));
      if (unknown.length) {
        return { ok: false, reason: `I can't put ${unknown.join(", ")} in the basket — it takes stock tokens, or a token you added in Settings` };
      }
      return { ok: true, value: [...new Set(list.map((s) => canon.get(s.toUpperCase())!))] };
    }
    case "usd": {
      const m = USD_RE.exec(text);
      if (!m) return understood(text, spec, "$20");
      return range(spec, Math.round(Number(m[1]!.replace(/,/g, "")) * 100) / 100, text);
    }
    case "int": {
      if (spec.key === "telegramDigestHour") {
        const h = HOUR_RE.exec(text);
        if (!h) return understood(text, spec, "18 or 6pm");
        let hour = Number(h[1]);
        const ampm = h[2]?.toLowerCase();
        if (ampm) {
          if (hour < 1 || hour > 12) return understood(text, spec, "6pm");
          hour = (hour % 12) + (ampm === "pm" ? 12 : 0);
        }
        return range(spec, hour, text);
      }
      // A setting counted in MINUTES takes the words people use for time.
      if (/Min$/.test(spec.key)) {
        const t = text.toLowerCase().replace(/^(every|once (an?|per)|each)\s+/, "").trim();
        if (/^(trade|every trade|each trade|instantly|immediately|now|off|never|none|0)$/.test(t) && spec.min === 0) return range(spec, 0, text);
        if (/^(hour|hourly|an hour)$/.test(t)) return range(spec, 60, text);
        if (/^(day|daily|a day)$/.test(t)) return range(spec, 1_440, text);
        const tm = TIME_RE.exec(text.replace(/^(every|once every)\s+/i, "").trim());
        if (!tm) return understood(text, spec, "30, 2h or once an hour");
        const unit = (tm[2] ?? "m").toLowerCase();
        const mins = Number(tm[1]) * (unit.startsWith("h") ? 60 : unit.startsWith("d") ? 1_440 : 1);
        if (!Number.isInteger(mins)) return understood(text, spec, "30 or 2h");
        return range(spec, mins, text);
      }
      const m = INT_RE.exec(text);
      if (!m) return understood(text, spec, "30");
      return range(spec, Number(m[1]), text);
    }
    case "pct": {
      const m = PCT_RE.exec(text);
      if (!m) return understood(text, spec, "5%");
      return range(spec, Math.round(Number(m[1]) * 100), text);
    }
    case "hoursAsSec": {
      const m = TIME_RE.exec(text);
      if (!m) return understood(text, spec, "6h or 30m");
      const unit = (m[2] ?? "h").toLowerCase();
      const per = unit.startsWith("m") ? 60 : unit.startsWith("d") ? 86_400 : 3_600;
      return range(spec, Math.round(Number(m[1]) * per), text);
    }
  }
}

/** A stored value, in the owner's words: "$20.00", "5%", "on", "6h", "no limit". */
export function formatSettingValue(spec: SettingSpec, v: unknown): string {
  if (v === undefined || v === null) return "not set";
  if (v === 0 && spec.zero) return spec.zero;
  switch (spec.kind) {
    case "bool":
      return v ? "on" : "off";
    case "usd":
      return typeof v === "number" ? `$${v.toFixed(2)}` : String(v);
    case "pct":
      return typeof v === "number" ? (v === 0 ? "off (0%)" : `${+(v / 100).toFixed(2)}%`) : String(v);
    case "hoursAsSec":
      return typeof v === "number" ? (v % 3_600 === 0 ? `${v / 3_600}h` : `${Math.round(v / 60)}m`) : String(v);
    case "symbols":
      return Array.isArray(v) ? (v.length ? v.join(", ") : "the default basket") : String(v);
    default:
      return String(v);
  }
}

/**
 * Is a STORED value one this build accepts? Run again at promotion time,
 * because nothing between the child and the sealed tenant store checks values
 * (settings-store.ts assumes its input is already clean).
 */
export function validStoredSetting(key: string, v: unknown): boolean {
  const spec = specFor(key);
  if (!spec) return false;
  switch (spec.kind) {
    case "bool":
      return typeof v === "boolean";
    case "enum":
      return typeof v === "string" && spec.values!.includes(v);
    case "strategy":
      return typeof v === "string" && STRATEGY_RE.test(v);
    case "symbols":
      return Array.isArray(v) && v.length >= 1 && v.length <= MAX_BASKET && v.every((s) => typeof s === "string" && SYMBOL_RE.test(s));
    default:
      return (
        typeof v === "number" &&
        Number.isFinite(v) &&
        (spec.kind !== "int" || Number.isInteger(v)) &&
        (spec.min === undefined || v >= spec.min) &&
        (spec.max === undefined || v <= spec.max)
      );
  }
}

/** Stock-token tickers, for the basket check. */
export function stockSymbols(): string[] {
  return STOCK_TOKENS.map((t) => t.symbol.toUpperCase());
}
