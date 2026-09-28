/**
 * "TODAY'S ENERGY IS SPENT" — THE ONE TELEGRAM PUSH ENERGY GETS, ONCE A DAY.
 *
 * The agent has stopped starting new trades on its own until 00:00 UTC, and
 * the owner is in Telegram. So the worker says so there once per UTC day, in
 * the same words the owner's notice slot carries (energy-copy.ts), dressed for
 * Telegram: addresses in <code> so a long-press copies them whole, and the buy
 * pointed at the Merrymen app's chat — "not here".
 *
 * READ-ONLY, ON PURPOSE (design D6). There is no buy button, no parked action
 * and no /getenergy: buying $MERRYMEN spends real USDG, and the place that may
 * do it is the app's chat, where the owner sees the amount on a card and
 * confirms it. A bearer /link code is not that. The only button is a link to
 * the desk, and only when a phone can open it (isPublicHttpsUrl).
 *
 * ONCE PER DAY, NOT ONCE PER SIX HOURS. The notifier's fire() is an episode
 * cooldown: the same key re-fires after six hours. That is right for "gas is
 * low" and wrong here — a day stays spent until midnight, and saying so three
 * more times tells the owner nothing new. So the key is the UTC day, a SENT key
 * is never re-sent, and a send Telegram refused is retried after half an hour
 * (sign-prompt.ts's rule) rather than every pass or never.
 *
 * ONCE PER DAY ACROSS A REDEPLOY, BY RIDING THE NOTICE'S CLAIM. firedAlerts
 * lives in telegram.json, which a hosted redeploy does not restore (the
 * orchestrator puts back the link, never the alert keys), so on its own it
 * re-sent this on every deploy of a spent day. The owner's notice already has
 * a durable once-a-day claim — energy_days.told_at, carried up by the mirror
 * and seeded back into a rebuilt child before it arms — so the alert speaks
 * only for a day whose notice claim THIS PROCESS won (`energyToldDay`, set by
 * index.ts tellEnergySpent after the claim and never before). A rebuilt child
 * finds today's stamp already there, wins nothing, and says nothing again.
 * The same trade the notice makes: a crash between the claim and the send
 * loses the alert, never repeats it. firedAlerts still stops a second send
 * within the process, and the half-hour retry still covers a refused one.
 *
 * Pure — no network client, no clock, no state — so every rule is executed by
 * energy-alert.test.ts; notifier.ts only reads, sends and records.
 */

import type { EnergyStatus } from "../../../packages/core/src/index";
import { energyNotice } from "../energy-copy";
import type { InlineKeyboard } from "./api";
import { isPublicHttpsUrl } from "./sign-prompt";

/** What the tick hands the notifier about energy (AlertInputs' energy fields). */
export interface EnergyAlertInputs {
  /** The worker's own report this tick; null/absent until one exists. */
  energy?: EnergyStatus | null;
  /** The armed grant's smart account, in full — the one address the owner may send to. */
  energyAccount?: string | null;
  /** The armed grant's chain. Only Robinhood Chain counts the account. */
  energyChainId?: number | null;
  /** The owner's counted wallet (cfg.holderAddress), in full, or null. */
  energyHolder?: string | null;
  /**
   * The UTC day whose owner notice THIS PROCESS claimed (energy_days.told_at),
   * or null — energyToldDayOf. The alert speaks for that day and no other; see
   * the header for why a claim another process made is silence here.
   */
  energyToldDay?: string | null;
}

/** Which agent's notice this process claimed, and for which UTC day (index.ts tellEnergySpent). */
export interface EnergyToldHere {
  agentId: string;
  day: string;
}

/**
 * The day the alert may speak for: the notice claim this process won, and
 * only while the SAME agent is armed — a re-sign can arm another account in
 * this process, and one account's claim is not another's.
 */
export function energyToldDayOf(told: EnergyToldHere | null, agentId: string | null | undefined): string | null {
  return told && agentId && told.agentId === agentId ? told.day : null;
}

/** Every key this alert uses starts with this; see recordEnergyAlert. */
export const ENERGY_ALERT_KEY_PREFIX = "energy:";

/** How soon a send Telegram refused is tried again — sign-prompt's half hour. */
export const ENERGY_ALERT_RETRY_SEC = 30 * 60;

/** Where "ask me in chat" points on Telegram. */
export const ENERGY_CHAT_PLACE = "in the Merrymen app chat (not here)";

export interface EnergyAlert {
  /** `energy:<YYYY-MM-DD>` — the UTC day the report is for. */
  key: string;
  text: string;
  keyboard?: InlineKeyboard;
}

/**
 * The alert to send now, or null when there is nothing to say.
 *
 * Only a report that ENFORCES (gated) and says today's entries are used up
 * (spent). Not full — a full agent is never throttled. Not a report from a day
 * that has already reset, which would tell the owner yesterday's news as
 * today's. Not without an armed account: an unarmed agent starts nothing.
 * And not for a day whose notice claim this process did not win — after a
 * redeploy the seeded told_at says the owner was already told.
 */
export function energyAlert(i: EnergyAlertInputs, base: string, nowSec: number): EnergyAlert | null {
  const e = i.energy;
  if (!e || !e.gated || !e.spent || e.level === "full") return null;
  if (nowSec >= e.resetsAt) return null;
  if (!i.energyToldDay || i.energyToldDay !== e.day) return null;
  if (!i.energyAccount || i.energyChainId == null) return null;
  const body = energyNotice(
    {
      day: e.day,
      account: i.energyAccount,
      chainId: i.energyChainId,
      holder: i.energyHolder ?? null,
      holderTokens: e.holderTokens,
      agentTokens: e.agentTokens,
      level: e.level,
      buy: e.buy,
      estimateUsdg: e.estimateUsdg,
    },
    {
      // In full, escaped, and in <code>: Telegram copies a code span whole on
      // a long-press, and one wrong character sends tokens nowhere.
      address: (a) => `<code>${escHtml(a)}</code>`,
      chatPlace: ENERGY_CHAT_PLACE,
    },
  );
  const text = `⚡ <b>Energy spent for today.</b> ${body}`;
  const url = `${base.replace(/\/+$/, "")}/agent`;
  // A LINK, NEVER AN ACTION. Telegram refuses a URL button for localhost or a
  // bare IP (and the whole message with it), so self-hosted gets none.
  return isPublicHttpsUrl(url)
    ? { key: `${ENERGY_ALERT_KEY_PREFIX}${e.day}`, text, keyboard: [[{ text: "⚡ Open my desk", url }]] }
    : { key: `${ENERGY_ALERT_KEY_PREFIX}${e.day}`, text };
}

/**
 * Send it now? Never twice for one key once SENT; after a refused send, not
 * before the retry time.
 */
export function energyAlertDue(
  key: string,
  firedAlerts: Readonly<Record<string, number>>,
  retry: { key: string; at: number } | null,
  nowSec: number,
): boolean {
  if (firedAlerts[key] !== undefined) return false;
  return !(retry && retry.key === key && nowSec < retry.at);
}

/**
 * firedAlerts with this day's key recorded and every OTHER day's energy key
 * dropped — one key a day would otherwise grow telegram.json for ever, and a
 * past day's key can never fire again anyway (its report has reset).
 */
export function recordEnergyAlert(
  firedAlerts: Readonly<Record<string, number>>,
  key: string,
  atSec: number,
): Record<string, number> {
  const next: Record<string, number> = {};
  for (const [k, v] of Object.entries(firedAlerts)) {
    if (!k.startsWith(ENERGY_ALERT_KEY_PREFIX)) next[k] = v;
  }
  next[key] = atSec;
  return next;
}

/** Local HTML escape — this module must not import the network client. */
function escHtml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
