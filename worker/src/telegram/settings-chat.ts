/**
 * "CHANGE MY SETTINGS BY TEXTING" — FROM WORDS TO A QUESTION WITH TWO BUTTONS.
 *
 * The owner writes "make each buy $20"; the classifier names the setting and
 * copies their value; this module decides what to say back. It never applies
 * anything: the answer is either a question the owner confirms with a button
 * (the service parks it), or a plain reply saying why it can't be done here
 * and where it can.
 *
 * Pure — no files, no network, no model — so every sentence an owner can read
 * here is covered by a test.
 */

import {
  DASHBOARD_ONLY,
  SEALED_ASKS,
  SETTING_SPECS,
  formatSettingValue,
  parseSettingValue,
  specFor,
  type SettingSpec,
} from "./setting-spec";

/** What the owner is shown. `button` names the keyboard the service attaches. */
export type SettingProposal =
  | { kind: "ask"; key: string; value: unknown; text: string }
  /** `awaitKey`: the reply asked for a value — the next short message answers it. */
  | { kind: "reply"; text: string; button?: "sign" | "dashboard"; awaitKey?: string };

export interface ProposalContext {
  /** Current resolved settings (ResolvedConfig), read by key. */
  current: Record<string, unknown>;
  /** Tickers a basket may hold: stock tokens + this owner's added tokens. */
  allowedSymbols: readonly string[];
  /** Strategy names this deployment can run. */
  strategies: readonly string[];
  /** Hosted builds run built-in strategies only. */
  hosted: boolean;
  /** The per-trade limit sealed in the signed permission, if any. */
  signedPerTradeUsdg?: number;
  agentName: string;
}

/**
 * Other words owners use for a setting, for /set and for a classifier that
 * returned a label instead of a key. Keys and labels already match on their own.
 */
const ALIASES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  buyPerTickUsdg: ["buy size", "buy amount", "per buy", "each buy", "trade size"],
  llmMaxActionUsdg: ["ai size", "ai trade size", "max ai trade"],
  telegramMaxActionUsdg: ["cap", "chat cap", "chat limit", "chat trade limit"],
  classPerEntryUsdg: ["launch size", "memecoin size", "per coin", "entry size"],
  idleFloorUsdg: ["idle floor", "reserve", "cash reserve", "keep aside"],
  takeProfitBps: ["take profit", "tp", "profit target"],
  strategistStopLossBps: ["stop loss", "sl", "stoploss"],
  slippageBps: ["slippage"],
  llmIntervalMin: ["ai interval", "decision interval"],
  memecoinMinFdvUsd: ["min fdv", "minimum fdv", "min market cap"],
  assetMode: ["asset mode", "what to buy"],
  basketSymbols: ["basket", "stocks list"],
  // "Turn off notifications" is Telegram's own master switch — it silences the
  // Sign-now prompt and the loss warnings too — so it answers with the
  // dashboard button (DASHBOARD_ONLY.telegram). Fewer TRADE messages is the
  // batching setting, which leaves every warning coming through.
  telegram: ["notifications", "all notifications", "alerts off"],
  telegramNotifyEveryMin: ["batching", "summary interval", "quiet mode", "trade pings", "trade messages", "pings", "messages"],
  telegramDigestHour: ["report hour", "digest hour", "daily report"],
  discoveryEnabled: ["discovery", "scanning", "new coin scanning"],
  classMaxHoldSec: ["max hold", "hold time"],
  classMaxPositions: ["max positions", "max coins"],
  classExitAtGraduationPct: ["graduation exit", "exit at graduation"],
  strategy: ["playbook"],
  // Posting on X is dashboard-only (DASHBOARD_ONLY.xPosting): these words
  // reach the refusal and its Settings button, never a change.
  xPosting: ["post on x", "posting on x", "x posting", "posts on x", "post on twitter", "twitter", "tweets", "tweeting", "x account", "x settings"],
  // Telegram groups are dashboard-only (DASHBOARD_ONLY.telegramGroups). "group
  // chats" is how owners say it even though the product never does — the
  // public web room owns that name — so it has to reach the refusal too. The
  // three real keys are listed as well, so `/set telegramGroupsChattiness
  // chatty` gets the Settings button rather than the generic "I can change
  // these" list, which would read as though the key simply did not exist.
  telegramGroups: [
    "group chats",
    "group chat",
    "groups",
    "gc",
    "telegram groups",
    "telegram group",
    "chattiness",
    "group coins",
    "telegramGroupsEnabled",
    "telegramGroupCoinsEnabled",
    "telegramGroupsChattiness",
  ],
});

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * The setting a phrase names: a key, a pseudo-key (sealed / dashboard-only),
 * a label or an alias. Null when nothing matches — the caller then lists what
 * can change rather than guessing.
 */
export function resolveSettingName(phrase: string): string | null {
  const p = norm(phrase);
  if (!p) return null;
  for (const k of [...SETTING_SPECS.map((s) => s.key), ...Object.keys(SEALED_ASKS), ...Object.keys(DASHBOARD_ONLY)]) {
    if (norm(k) === p) return k;
  }
  for (const s of SETTING_SPECS) if (norm(s.label) === p) return s.key;
  for (const [k, words] of Object.entries(ALIASES)) if (words.some((w) => norm(w) === p)) return k;
  return null;
}

/** Keys of the sealed limits the old /cap path also clamps against. */
const SEALED_SENTENCE =
  "That limit is part of the trading permission you signed, so only a new signature can change it. " +
  "Renewal first revokes old permissions on-chain and requires network fees. Tap below to review the limits and fees before signing.";

/** What can change, in one short list — the answer to "unknown". */
export function whatCanChange(): string {
  const names = SETTING_SPECS.map((s) => s.label);
  return `I can change these for you by text: ${names.join(", ")}. Tell me which one and the new value, or send /settings to see them all with what they're set to now.`;
}

function esc(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** The note under a question, when there is more to know than the change itself. */
function extraNote(spec: SettingSpec, value: unknown, ctx: ProposalContext): string {
  if (spec.key === "telegramMaxActionUsdg" && ctx.signedPerTradeUsdg !== undefined && typeof value === "number" && value > ctx.signedPerTradeUsdg) {
    return `\nNote: your signed per-trade limit is $${ctx.signedPerTradeUsdg.toFixed(2)}, so a chat trade still won't go above that.`;
  }
  if ((spec.key === "buyPerTickUsdg" || spec.key === "llmMaxActionUsdg" || spec.key === "classPerEntryUsdg") &&
      ctx.signedPerTradeUsdg !== undefined && typeof value === "number" && value > ctx.signedPerTradeUsdg) {
    return `\nNote: your signed per-trade limit is $${ctx.signedPerTradeUsdg.toFixed(2)}, so trades will still stop there until you sign a higher one.`;
  }
  if (spec.key === "strategistStopLossBps" && value === 0) return "\nThat turns the stop loss off.";
  if (spec.key === "takeProfitBps" && value === 0) return "\nThat turns take-profit off.";
  return "";
}

/**
 * Words in, what to say out. `setting` is what the classifier (or /set)
 * produced; `value` is the owner's own text.
 */
export function proposeSettingChange(setting: string, value: string, ctx: ProposalContext): SettingProposal {
  const key = setting === "unknown" ? null : specFor(setting) || SEALED_ASKS[setting] || DASHBOARD_ONLY[setting] ? setting : resolveSettingName(setting);
  if (!key) return { kind: "reply", text: whatCanChange() };

  if (SEALED_ASKS[key]) {
    return { kind: "reply", text: `Your ${SEALED_ASKS[key]} can't be changed by text. ${SEALED_SENTENCE}`, button: "sign" };
  }
  if (DASHBOARD_ONLY[key]) {
    return { kind: "reply", text: DASHBOARD_ONLY[key]!, button: "dashboard" };
  }

  const spec = specFor(key)!;
  if (!value.trim()) {
    return {
      kind: "reply",
      text: `${capitalise(spec.label)} is ${esc(formatSettingValue(spec, ctx.current[key]))} right now. What should it be?`,
      awaitKey: key,
    };
  }
  const parsed = parseSettingValue(spec, value, ctx.allowedSymbols);
  if (!parsed.ok) return { kind: "reply", text: `I can't set that: ${esc(parsed.reason)}.` };

  if (spec.kind === "strategy") {
    const name = parsed.value as string;
    if (!ctx.strategies.includes(name) && ctx.hosted) {
      return { kind: "reply", text: `There's no strategy called ${esc(name)}. You can pick: ${ctx.strategies.join(", ")}.` };
    }
  }

  const before = ctx.current[key];
  if (JSON.stringify(before) === JSON.stringify(parsed.value)) {
    return { kind: "reply", text: `${capitalise(spec.label)} is already ${esc(formatSettingValue(spec, before))}. Nothing to change.` };
  }

  return {
    kind: "ask",
    key,
    value: parsed.value,
    text:
      `Change <b>${esc(spec.label)}</b> from <b>${esc(formatSettingValue(spec, before))}</b> to <b>${esc(formatSettingValue(spec, parsed.value))}</b>?` +
      `\n<i>${esc(spec.help)}.</i>${esc(extraNote(spec, parsed.value, ctx))}`,
  };
}

/** The done message, once the owner confirmed and it was saved. */
export function appliedText(key: string, value: unknown, hosted: boolean): string {
  const spec = specFor(key);
  const label = spec ? spec.label : key;
  const shown = spec ? formatSettingValue(spec, value) : String(value);
  const when = hosted ? "It takes effect within a minute." : "It takes effect on my next check.";
  return `✅ Done — ${esc(label)} is now ${esc(shown)}. ${when}`;
}

/** `/settings`: every changeable setting with its current value. */
export function settingsListText(current: Record<string, unknown>): string {
  const rows = SETTING_SPECS.map((s) => `• ${esc(s.label)}: <b>${esc(formatSettingValue(s, current[s.key]))}</b>`);
  return [
    "⚙️ <b>your settings</b> — tell me any of these in plain words to change it (e.g. “make each buy $20”):",
    ...rows,
    "",
    "Your per-trade and daily limits are part of the permission you signed — ask me and I'll send you the button to change them.",
  ].join("\n");
}

function capitalise(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}
