/**
 * WHAT THE HOME SCREEN SAYS ABOUT TELEGRAM AND TRENCHER.
 *
 * ── WHY THESE TWO ARE ON THE HOME SCREEN AT ALL ──────────────────────────
 *
 * Both are buried, and both are buried in a way that produced real stuck
 * testers rather than mere inconvenience.
 *
 * Telegram is a closed `<details>` eight blocks down a 1854-line settings form
 * that is itself reachable only from one row at the bottom of the profile
 * screen. Worse, the instruction ("send /link CODE") and the code it needs are
 * in TWO DIFFERENT closed drawers — the instruction in the Telegram group, the
 * code further down inside "Advanced settings". Two beta testers stopped
 * exactly there, and the incident is written up at length in the API route.
 *
 * Trencher's explanation is near the top of the page, but the flag that
 * actually lets it trade — `trencherLiveEnabled` — is about 445 lines below it
 * inside a different collapsed drawer. Its own code comment names the cost:
 * "an owner who picked trencher and went live got a candidate feed that
 * returned nothing, forever, with nothing said."
 *
 * ── WHAT THIS MODULE IS, AND IS NOT ──────────────────────────────────────
 *
 * It is a READING, not a control. The home screen gets a sentence and a way to
 * reach the real setting; it does not grow a second place to change money
 * behaviour. This product has been bitten by duplicated controls before — the
 * whole "one signing control" rule exists because of it — and a toggle in two
 * places is two places to disagree.
 *
 * Every state below is derived from something actually measured. The states
 * exist because the code genuinely distinguishes them, and collapsing any of
 * them is how "not connected" starts covering for "we could not ask".
 */

import type { TelegramStatus } from "@/app/api/telegram/route";

/**
 * WHAT WE KNOW ABOUT THE TELEGRAM BRIDGE.
 *
 * Nine states, and the first one is the one the web UI gets wrong today.
 * `loadTelegram()` only calls `setTg` on a truthy response, so a failed or
 * non-ok `/api/telegram` leaves `tg === null` — and the settings screen's
 * ternary chain then falls through to the literal string "no token". That is a
 * measured absence printed for an unread state, which is the one thing this
 * repo's conventions forbid outright. The mobile client already gets it right
 * ("checking the bridge…"); this is that distinction, made reusable.
 */
export type TelegramRow =
  /** Not fetched yet, or the fetch failed. NOT "no token". */
  | { kind: "unread" }
  | { kind: "no-token" }
  /** A token is saved but the master switch is off, so nothing is listening. */
  | { kind: "off" }
  /** Token saved; `getMe` has not confirmed it. Could be a typo, could be Telegram. */
  | { kind: "unverified" }
  /**
   * TRADING IS HELD: the practice book would not restore after an update, so
   * no worker runs. A small process answers the bot meanwhile, and /link
   * works there, so the code (when there is one) stays. `reason` is the short
   * class the owner is told in chat too.
   */
  | { kind: "held"; reason: string | null; linked: boolean; linkCode: string | null; botUsername: string | null }
  /**
   * NOTHING IS HEARING THE BOT, as measured by the process meant to poll it:
   * not heard for minutes (`stale`), another program reading its messages
   * (`conflict`), or its token refused (`revoked`). A code for this bot stays
   * on screen with the warning beside it: it works once the bot is heard
   * again, and hiding it would send the owner looking for another.
   */
  | {
      kind: "not-listening";
      why: "stale" | "conflict" | "revoked";
      lastOkAt: number | null;
      linked: boolean;
      linkCode: string | null;
      botUsername: string | null;
    }
  /**
   * THE BOT IS CONNECTED TO ANOTHER MERRYMEN AGENT: its claim names another
   * account, so this agent is not handed its token and will never pick it
   * up. No code, and nothing about which agent. Saving the token again here
   * offers to move it (the settings save's 409).
   */
  | { kind: "elsewhere"; botUsername: string | null }
  /**
   * The bot is real and reachable, but nobody has claimed it yet.
   * `linkPending`: there is no code because the agent has not picked this bot
   * up yet, rather than because the next one is still being minted.
   */
  | { kind: "unlinked"; linkCode: string | null; linkPending: boolean; botUsername: string | null }
  | { kind: "linked"; botUsername: string | null; chats: number };

export function telegramRow(tg: TelegramStatus | null | undefined): TelegramRow {
  // UNREAD IS NOT AN ANSWER. Everything below this line is a measurement.
  if (!tg) return { kind: "unread" };
  if (!tg.hasToken) return { kind: "no-token" };
  // Ordered before `connected` deliberately: a switched-off bridge with a
  // perfectly good token is not "unverified", and telling somebody to check
  // their token when the real problem is a checkbox wastes their afternoon.
  if (!tg.enabled) return { kind: "off" };
  const l = tg.listening;
  const linked = tg.ownerId !== null;
  // A REFUSED TOKEN, BEFORE `connected`. getMe is refused for a revoked token
  // exactly as getUpdates is, so with `connected` first this row could only
  // ever say "not verified", and never the remedy: a new token from
  // @BotFather. And only when getMe refuses it too. When getMe takes the
  // saved token and the poller's last try was refused, the owner has just
  // pasted a new token for the same bot, and the agent has not been handed
  // it yet; "paste a new token" would be telling them to do what they did.
  if (l?.state === "revoked" && !tg.connected) {
    return { kind: "not-listening", why: "revoked", lastOkAt: l.lastOkAt, linked, linkCode: tg.linkCode, botUsername: tg.botUsername };
  }
  if (!tg.connected) return { kind: "unverified" };
  // Nothing below is about this agent's hearing of the bot: it no longer has it.
  if (tg.botElsewhere === true) return { kind: "elsewhere", botUsername: tg.botUsername };
  // BEFORE THE OWNER, because "linked" was the lie. A linked bot that nothing
  // polls read "✓ connected" for days in the incident behind these states,
  // and an unlinked one showed a code nobody would ever read. What the
  // polling process measured goes first; `unknown` is not a measurement, so
  // it falls through to what the screen always said, as does `revoked` here
  // (see above).
  if (l?.state === "held") {
    return { kind: "held", reason: l.reason, linked, linkCode: tg.linkCode, botUsername: tg.botUsername };
  }
  if (l && (l.state === "not-listening" || l.state === "conflict")) {
    return {
      kind: "not-listening",
      why: l.state === "conflict" ? "conflict" : "stale",
      lastOkAt: l.lastOkAt,
      linked,
      linkCode: tg.linkCode,
      botUsername: tg.botUsername,
    };
  }
  // `ownerId` is the only proof anybody has actually claimed the bot. An empty
  // allowlist with an owner is a linked bot with no extra chats, which is the
  // normal case, so the owner is what decides.
  if (tg.ownerId === null) {
    return { kind: "unlinked", linkCode: tg.linkCode, linkPending: tg.linkPending === true, botUsername: tg.botUsername };
  }
  return { kind: "linked", botUsername: tg.botUsername, chats: tg.allowlist.length };
}

/**
 * TRADING HELD, SAID APART FROM THE BOT: the hold's class when the tenant is
 * held and the Telegram row does not already say so; null otherwise.
 *
 * The Telegram row can say it only for an owner whose bot works. An owner
 * with no bot, one switched off or one getMe will not confirm gets no hold
 * reply and no direct message either, both of which go over the bot. Without
 * this the dashboard was silent for them too, and the only sign anywhere was
 * a practice return gone blank.
 */
export function heldNotice(tg: TelegramStatus | null | undefined, row: TelegramRow): string | null {
  if (!tg || typeof tg.tradingHeld !== "string" || tg.tradingHeld === "") return null;
  return row.kind === "held" ? null : tg.tradingHeld;
}

/**
 * WHAT THE TRENCHER RAIL IS SET TO DO.
 *
 * ── A CAVEAT WORTH WRITING DOWN ──────────────────────────────────────────
 *
 * This reads the owner's SETTINGS, which is the truth for every hosted tenant
 * and can be incomplete for a self-hosted install configured by environment
 * variable: `GET /api/settings` returns stored values only, and its `defaults`
 * field is the static core table rather than anything env-aware. So an install
 * running on `MERRYMEN_TRENCHER_LIVE=1` with nothing stored reads here as off.
 *
 * That is why the copy this feeds says what the SETTINGS say and links to them,
 * rather than claiming what the agent is doing. A row that promised "live" or
 * "off" as fact would be wrong for that cohort, and silently.
 */
export type TrencherRow =
  | { kind: "unread" }
  /** The strategy is something else entirely. Trencher is not in play. */
  | { kind: "off" }
  /**
   * Chosen, but asset mode is stocks — so the candidate feed is empty by
   * construction and no memecoin can ever be considered.
   *
   * SURFACED HERE BECAUSE NOTHING ELSE SURFACES IT. The worker announces this
   * refusal at event level "ok", and the agent screen's notice slot only shows
   * warn/err — so the one Trencher refusal reachable purely from a settings
   * dropdown is structurally invisible everywhere else in the product.
   */
  | { kind: "no-crypto" }
  /** Running, but not permitted to spend real money on it. */
  | { kind: "paper" }
  | { kind: "live" };

export function trencherRow(
  settings:
    | {
        strategy?: string | null;
        trencherLiveEnabled?: boolean | null;
        assetMode?: string | null;
      }
    | null
    | undefined,
): TrencherRow {
  if (!settings) return { kind: "unread" };
  if (settings.strategy !== "trencher") return { kind: "off" };
  if (settings.assetMode === "stocks") return { kind: "no-crypto" };
  return settings.trencherLiveEnabled ? { kind: "live" } : { kind: "paper" };
}

/**
 * The same reading, in the few words a settings field has room for.
 *
 * SHARED ON PURPOSE. The settings screen and the home strip describe one
 * bridge, and two hand-written ternary chains are two things to disagree —
 * which is how the settings screen ended up printing "no token" for a fetch
 * that simply failed. One function, one vocabulary, one place to fix.
 */
export function telegramLabel(row: TelegramRow): string {
  switch (row.kind) {
    // NOT "no token". The whole point.
    case "unread": return "checking…";
    case "no-token": return "no token";
    case "off": return "saved, switched off";
    case "unverified": return "not verified";
    case "held": return "⏸ trading held";
    case "not-listening":
      return row.why === "revoked" ? "token refused by Telegram" : row.why === "conflict" ? "another program has the bot" : "not listening";
    case "elsewhere": return "connected to another agent";
    case "unlinked": return "not linked yet";
    case "linked": return row.botUsername ? `✓ @${row.botUsername}` : "✓ connected";
  }
}
