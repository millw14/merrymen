/**
 * WHAT THE OWNER READS WHEN TODAY'S ENERGY RUNS OUT.
 *
 * One sentence-set, written by the worker and never by a model, sent once per
 * UTC day at the first new trade the limit actually withheld (index.ts, behind
 * a durable told_at claim). Pure, so every variant is executed by
 * energy-copy.test.ts rather than read.
 *
 * WHAT IT MUST ALWAYS SAY, whichever arm it takes:
 *   - its UTC DATE, first. A warn sits in the owner's notice slot (web desk,
 *     iOS, Android) until something newer displaces it, which can be after
 *     midnight — "today's energy is spent" would then be false, "Energy spent
 *     for 27 Sep (UTC)" stays true. It starts with ENERGY_NOTICE_PREFIX so the
 *     desk can recognise it beside the standing banner.
 *   - that nothing is broken: selling, stop-losses and the owner's own orders
 *     still run, and the allowance comes back at 00:00 UTC.
 *   - the network by name — Robinhood Chain — whenever it asks for tokens.
 *   - the agent's FULL address, written here from the grant, never by a model:
 *     one wrong character and whatever is sent there is gone. Except when the
 *     account is on another network, where tokens sent to it would not count
 *     and it is not printed at all.
 *
 * WHAT IT MUST NEVER SAY. Anything about the token's price, where it is going,
 * or returns (token.ts STANCE). $MERRYMEN is energy here, nothing more. The one
 * dollar figure allowed is what the shortfall would cost in USDG right now,
 * worker-computed, and only when it is known. An unread balance is never "you
 * hold 0": it is our read failing, not their wallet.
 */

import { ENERGY, ENERGY_NOTICE_PREFIX } from "../../packages/core/src/index";
import type { EnergyBuy, EnergyLevel } from "../../packages/core/src/index";

export interface EnergyNoticeFacts {
  /** The UTC day the entry was withheld, 'YYYY-MM-DD'. */
  day: string;
  /** The agent's smart account, in full. */
  account: string;
  /** The grant's chain. Only Robinhood Chain (4663) counts the account. */
  chainId: number;
  /** The owner's counted wallet, in full, or null when there is none. */
  holder: string | null;
  holderTokens: number | null;
  agentTokens: number | null;
  level: EnergyLevel;
  /** The worker's reading of whether it can buy its own energy; null when not said. */
  buy: EnergyBuy | null;
  /** USDG that would buy the shortfall now, fees and tax included; null when unknown. */
  estimateUsdg: number | null;
}

/**
 * How a channel dresses the fixed sentences. The web and apps render plain
 * text; Telegram wraps addresses in <code> and points "chat" at the app,
 * because the energy buy is never placed from Telegram.
 */
export interface EnergyNoticeStyle {
  address?: (a: string) => string;
  /** Where to ask for the buy. Default "in chat". */
  chatPlace?: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** '2026-09-27' → '27 Sep'. A malformed day is printed as given rather than guessed at. */
export function noticeDate(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return day;
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${Number(m[3])} ${month}` : day;
}

/** Thousands separators without depending on the process's locale data. */
export function count(n: number): string {
  const whole = Math.floor(Math.abs(n));
  return (n < 0 ? "-" : "") + String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** 37.12 → "$37.12"; 1234.5 → "$1,234.50". */
function usd(n: number): string {
  const [i, f] = n.toFixed(2).split(".");
  return `$${count(Number(i))}.${f}`;
}

const MAINNET = 4663;

export function energyNotice(f: EnergyNoticeFacts, style: EnergyNoticeStyle = {}): string {
  const addr = style.address ?? ((a: string) => a);
  const chat = style.chatPlace ?? "in chat";
  const full = count(ENERGY.fullTokens);
  const notMainnet = f.chainId !== MAINNET || f.buy === "not-mainnet";
  const unread = f.level === "unread";
  const where = notMainnet ? "in your own wallet on Robinhood Chain" : "between your wallet and my account";

  const parts: string[] = [];

  // ── what happened ──
  if (unread) {
    parts.push(
      `I couldn't read the $MERRYMEN balances, so I've been on the reduced allowance — about a tenth of my usual ` +
        `daily AI reviews and new trades — and today's is used up. That's our read failing, not your wallet: if you ` +
        `already hold ${full} ${where}, it lifts on the next good read.`,
    );
    parts.push("Selling, stop-losses and your own orders still run, and I pick up again at 00:00 UTC.");
  } else {
    parts.push(
      `without ${full} $MERRYMEN ${where} I get about a tenth of my usual daily AI reviews and new trades, ` +
        `and today's are used up.`,
    );
    parts.push("Nothing is broken — selling, stop-losses and your own orders still run, and I pick up again at 00:00 UTC.");
  }

  // ── where they stand, only when it is known ──
  if (!unread) {
    const holding = holdingsLine(f, notMainnet);
    if (holding) parts.push(holding);
  }

  // ── what would change it ──
  const opener = unread ? "If you don't, " : "For full strength, ";
  if (notMainnet) {
    parts.push(
      `${opener}keep ${full} $MERRYMEN on Robinhood Chain in your own wallet${f.holder ? ` ${addr(f.holder)}` : ""} — ` +
        `my account is on another network, so tokens sent to it would not count.`,
    );
  } else {
    const estimate =
      f.estimateUsdg !== null && Number.isFinite(f.estimateUsdg) && f.estimateUsdg > 0
        ? ` (about ${usd(f.estimateUsdg)} of USDG at the pool's current rate)`
        : "";
    let line =
      `${opener}send $MERRYMEN on Robinhood Chain to my account ${addr(f.account)}` +
      (f.holder ? ` (or keep it in your own wallet ${addr(f.holder)} — both count)` : "");
    if (f.buy === "ready") {
      line += `, or send USDG to my account and ask me ${chat} to get my $MERRYMEN — you confirm the amount first${estimate}.`;
    } else if (f.buy === "resign") {
      line +=
        `, or send USDG to my account, re-sign my permission (free — my current key can't buy it), then ask me ` +
        `${chat} to get my $MERRYMEN${estimate}.`;
    } else if (f.buy === "paper") {
      line += ". I'm in Paper mode, so I won't spend real USDG on it — send $MERRYMEN instead, or turn on Live trading first.";
    } else {
      line += ".";
    }
    parts.push(line);
  }
  parts.push("Or change nothing and I carry on at this pace.");

  const body = parts.join(" ");
  // "without …" continues the date clause; the unread arm is its own sentence.
  return `${ENERGY_NOTICE_PREFIX}${noticeDate(f.day)} (UTC): ${body}`;
}

/**
 * "You and I hold 12,345 between us (87,655 short)." — or nothing.
 *
 * Only figures that were READ. A count that is null is unknown, and a sentence
 * built on it would be a guess about somebody's wallet. A known zero is said
 * as "none", never as "hold 0".
 */
function holdingsLine(f: EnergyNoticeFacts, notMainnet: boolean): string | null {
  const need = ENERGY.fullTokens;
  const shortOf = (held: number) => `(${count(Math.max(0, need - held))} short)`;
  if (notMainnet) {
    if (f.holderTokens === null) return null;
    return f.holderTokens > 0
      ? `Your wallet holds ${count(f.holderTokens)} ${shortOf(f.holderTokens)}.`
      : `Your wallet holds none yet ${shortOf(0)}.`;
  }
  if (f.holderTokens !== null && f.agentTokens !== null) {
    const held = f.holderTokens + f.agentTokens;
    return held > 0
      ? `You and I hold ${count(held)} between us ${shortOf(held)}.`
      : `Neither your wallet nor my account holds any yet ${shortOf(0)}.`;
  }
  // No wallet linked at all is a knowable nothing; the account alone then is the whole figure.
  if (f.holder === null && f.agentTokens !== null) {
    return f.agentTokens > 0
      ? `My account holds ${count(f.agentTokens)} ${shortOf(f.agentTokens)}.`
      : `My account holds none yet ${shortOf(0)}.`;
  }
  return null;
}
