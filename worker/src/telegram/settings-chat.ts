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
  validStoredSetting,
  type SettingSpec,
} from "./setting-spec";
import {
  AGENT_NAME_RE,
  buildProposal,
  catalogEntry,
  encodeProposalLink,
  normalizeAgentName,
  proposalRoute,
  riskWarning,
  understandSettingsText,
  type ProposalRow,
} from "../../../packages/core/src/index";

/** What the owner is shown. `button` names the keyboard the service attaches. */
export type SettingProposal =
  | { kind: "ask"; key: string; value: unknown; text: string }
  /** `awaitKey`: the reply asked for a value — the next short message answers it. */
  | { kind: "reply"; text: string; button?: "sign" | "dashboard"; anchor?: string; awaitKey?: string };

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
  // Launchpad buying is dashboard-only (DASHBOARD_ONLY.launchSniping). The
  // agent calls it "launchpad buying" and the web page called it "class
  // route", so an owner may use either, or what the iOS app called it.
  launchSniping: ["launchpad buying", "launchpad sniping", "launch buying", "launch sniping", "launchpad", "class route", "class sniping", "classSnipeEnabled"],
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

/**
 * Where on /settings the "Open Settings" button lands, for the dashboard-only
 * asks whose control has an id there (web Settings.tsx opens the closed group a
 * link points into). One missing here still gets the button, to the page top.
 */
const DASHBOARD_ANCHORS: Readonly<Record<string, string>> = Object.freeze({
  launchSniping: "launchpad-buying",
  memecoinLive: "trencher-mode",
  telegram: "telegram",
  telegramGroups: "telegram-groups",
  xPosting: "x-posting",
});

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
    // Sent as Telegram HTML, and the text names "Custom tokens & discovery".
    const anchor = DASHBOARD_ANCHORS[key];
    return { kind: "reply", text: esc(DASHBOARD_ONLY[key]!), button: "dashboard", ...(anchor ? { anchor } : {}) };
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
    "You can ask for several at once, or just describe how I should work (“be more careful”, “only trade stocks”, “message me less”) — I'll show you the changes to approve. Anything only the dashboard changes comes with a button that opens it ready to approve.",
    "",
    "Your per-trade and daily limits are part of the permission you signed — ask me and I'll send you the button to change them.",
  ].join("\n");
}

function capitalise(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}


// ── SEVERAL CHANGES, ONE APPROVAL ────────────────────────────────────────────
//
// "Be more careful and only buy stocks." An owner describes how the agent
// should work; that is several settings, and asking for each one separately is
// what made the chat feel like a form. The catalog (packages/core
// settings-catalog.ts) reads the request; this decides who approves it:
//
//   every change is one the chat may make  -> one ✅ here, applied together
//   any change is dashboard-only           -> ONE "Review & approve" button
//                                             that opens Settings with all of
//                                             them filled in; nothing changes
//                                             until the owner taps Approve there
//
// The chat's own allowlist does not move. A chat-route change whose value the
// chat's stricter spec refuses (a max-coins of 0, say: "no limit" is a
// dashboard act, setting-spec.ts) is sent to the dashboard rather than dropped.

export interface RequestedChange {
  key: string;
  raw?: string;
  value?: unknown;
}

/**
 * Everything the owner asked to change in one message: the classifier's
 * `setting`/`value` when it names a real setting, plus every `key=value` in
 * `changes`. Pseudo-keys (liveTrading, xPosting…) are left to the single path,
 * whose replies are written for them.
 */
export function requestedChanges(setting: string, value: string, changes?: string): RequestedChange[] {
  const out: RequestedChange[] = [];
  if (setting && setting !== "unknown" && catalogEntry(setting) && value.trim()) out.push({ key: setting, raw: value });
  if (changes && changes.trim()) {
    for (const c of understandSettingsText(changes.slice(0, 600))) if (!out.some((o) => o.key === c.key)) out.push(c);
  }
  return out;
}

/**
 * Use the several-at-once path: more than one change, a dashboard setting
 * named by its real key, or the agent's name — the single path has no spec for
 * it (the /name command is its other way in).
 */
export function wantsManyPath(requested: readonly RequestedChange[]): boolean {
  if (requested.length > 1) return true;
  const only = requested[0];
  return !!only && (only.key === "agentName" || catalogEntry(only.key)?.route === "dashboard");
}

/**
 * May the chat apply this value itself? The chat's own spec decides, exactly
 * as for a single change; the name has no spec and is held to the rule /name
 * already applies (soul.ts setName). Checked when the change is proposed and
 * again when it is applied.
 */
export function chatMayApply(key: string, value: unknown): boolean {
  if (key === "agentName") return typeof value === "string" && AGENT_NAME_RE.test(normalizeAgentName(value));
  return validStoredSetting(key, value);
}

/**
 * The one change to ask about on the ordinary path. When the classifier put a
 * single change only in `changes` and left `setting` "unknown", that change is
 * the one — not the generic "here's what I can change" list.
 */
export function singleChange(setting: string, value: string, requested: readonly RequestedChange[]): { setting: string; value: string } {
  if (setting !== "unknown" || requested.length !== 1) return { setting, value };
  const only = requested[0]!;
  return { setting: only.key, value: only.raw ?? (Array.isArray(only.value) ? only.value.join(" ") : String(only.value ?? "")) };
}

export type ManyProposal =
  | { kind: "ask-many"; changes: { key: string; value: unknown }[]; text: string }
  /** `approve`: the encoded proposal for the dashboard link. `sign`: a sealed limit was asked for. */
  | { kind: "reply"; text: string; approve?: string; sign?: boolean };

function rowLine(r: ProposalRow): string {
  const warn = riskWarning(r.risk, r.after);
  return `• <b>${esc(r.label)}</b>: ${esc(r.beforeText)} → <b>${esc(r.afterText)}</b>${warn ? `\n  ⚠️ ${esc(warn)}` : ""}`;
}

export function proposeManyChanges(requested: readonly RequestedChange[], ctx: ProposalContext): ManyProposal {
  const p = buildProposal(requested, ctx.current, { symbols: ctx.allowedSymbols, hosted: ctx.hosted });
  const rows: ProposalRow[] = p.rows.map((r) => {
    if (r.route !== "chat") return r;
    if (r.key === "strategy" && ctx.hosted && !ctx.strategies.includes(String(r.after))) return { ...r, route: "dashboard" };
    return chatMayApply(r.key, r.after) ? r : { ...r, route: "dashboard" };
  });
  const notes = p.refused.map((r) => `• ${esc(r.phrase)} — ${esc(r.reason)}`);
  const sign = p.refused.some((r) => r.route === "sealed");
  const route = proposalRoute(rows);

  if (!route) {
    if (!notes.length) {
      return { kind: "reply", text: "I couldn't find a setting to change in that. Try something like “each buy $20, stop loss 8%” — or send /settings to see them all." };
    }
    return { kind: "reply", text: ["I can't change that from here:", ...notes].join("\n"), ...(sign ? { sign } : {}) };
  }

  const head = rows.length === 1 ? "Here's the change:" : `Here are the ${rows.length} changes:`;
  const body = [head, ...rows.map(rowLine)];
  if (notes.length) body.push("", "Not included:", ...notes);
  const perTrade = rows.find((r) => (r.key === "buyPerTickUsdg" || r.key === "telegramMaxActionUsdg") && typeof r.after === "number");
  if (perTrade && ctx.signedPerTradeUsdg !== undefined && (perTrade.after as number) > ctx.signedPerTradeUsdg) {
    body.push("", `Your signed per-trade limit is $${ctx.signedPerTradeUsdg.toFixed(2)}, so each trade still stops there.`);
  }

  if (route === "chat") {
    body.push("", "Apply these? Nothing changes until you tap ✅.");
    return { kind: "ask-many", changes: rows.map((r) => ({ key: r.key, value: r.after })), text: body.join("\n") };
  }
  body.push(
    "",
    rows.some((r) => r.route === "dashboard")
      ? "Some of these are only changed on the dashboard, so the approval is there: the button opens Settings with them filled in, and nothing changes until you tap Approve."
      : "Approve them on the dashboard: the button opens Settings with them filled in.",
  );
  return { kind: "reply", text: body.join("\n"), approve: encodeProposalLink(rows), ...(sign ? { sign } : {}) };
}

/** The done message for several changes. */
export function appliedManyText(changes: readonly { key: string; value: unknown }[], hosted: boolean): string {
  const lines = changes.map(({ key, value }) => {
    const spec = specFor(key);
    const label = spec ? spec.label : (catalogEntry(key)?.label ?? key);
    return `• ${esc(label)}: <b>${esc(spec ? formatSettingValue(spec, value) : String(value))}</b>`;
  });
  const when = hosted ? "They take effect within a minute." : "They take effect on my next check.";
  return [`✅ Done — ${changes.length === 1 ? "1 setting" : `${changes.length} settings`} changed:`, ...lines, when].join("\n");
}
