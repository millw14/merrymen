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
 * Five states, and the first one is the one the web UI gets wrong today.
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
  /** The bot is real and reachable, but nobody has claimed it yet. */
  | { kind: "unlinked"; linkCode: string | null; botUsername: string | null }
  | { kind: "linked"; botUsername: string | null; chats: number };

export function telegramRow(tg: TelegramStatus | null | undefined): TelegramRow {
  // UNREAD IS NOT AN ANSWER. Everything below this line is a measurement.
  if (!tg) return { kind: "unread" };
  if (!tg.hasToken) return { kind: "no-token" };
  // Ordered before `connected` deliberately: a switched-off bridge with a
  // perfectly good token is not "unverified", and telling somebody to check
  // their token when the real problem is a checkbox wastes their afternoon.
  if (!tg.enabled) return { kind: "off" };
  if (!tg.connected) return { kind: "unverified" };
  // `ownerId` is the only proof anybody has actually claimed the bot. An empty
  // allowlist with an owner is a linked bot with no extra chats, which is the
  // normal case, so the owner is what decides.
  if (tg.ownerId === null) {
    return { kind: "unlinked", linkCode: tg.linkCode, botUsername: tg.botUsername };
  }
  return { kind: "linked", botUsername: tg.botUsername, chats: tg.allowlist.length };
}

/**
 * The rail the worker last published — paper, live or idle — as /api/grants
 * carries it from the agent's heartbeat, and null when nobody has read it.
 *
 * NOT `LiveMine.mode`, which is the STRATEGY. Typed as the rail's own words so
 * passing that one here does not compile.
 */
export type AgentMode = "paper" | "live" | "idle" | null;

/**
 * WHAT TRENCHER IS DOING, AND WITH WHOSE MONEY.
 *
 * ── THE PERMISSION IS NOT THE RAIL ───────────────────────────────────────
 *
 * "Let trencher trade for real" (`trencherLiveEnabled`) says what trencher MAY
 * do once the agent is live. It does not say the agent is live. This row used
 * to read the permission alone, so a paper agent with the box ticked showed
 * "Trencher: on, trading real money" in green under its PAPER chip. The worker
 * decides on the rail first (worker/src/index.ts, trencher's candidate feed):
 *
 *   if (!paperActive() && !cfg.trencherLiveEnabled) → empty feed
 *
 * so on paper it trenches with practice money whatever the permission says,
 * and on the live rail WITHOUT the permission it sees no candidates and buys
 * nothing — which the old row called "practice money only". So "real money" is
 * said only for a live agent that is allowed it, and a rail nobody read (or an
 * idle one) gets what the permission allows, never a claim that it is trading.
 *
 * ── ONLY A STORED ANSWER IS KNOWN HERE ───────────────────────────────────
 *
 * The permission is read from the owner's SETTINGS, which is the truth for
 * every hosted tenant and can be incomplete for a self-hosted install
 * configured by environment variable: `GET /api/settings` returns stored values
 * only, and its `defaults` field is the static core table rather than anything
 * env-aware. A stored value wins over the environment (worker/src/settings.ts
 * `bool`), so a stored true or false is the answer on any install. A box never
 * saved on a SELF-HOSTED install is not: `MERRYMEN_TRENCHER_LIVE` decides it,
 * in a process this read cannot see. Read as "not allowed", a live agent on
 * that variable — buying with real money — was told it buys nothing. So there
 * the row says the install's environment decides, and claims neither.
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
  /** The agent is on paper: practice money, whatever the permission says. */
  | { kind: "paper" }
  /** Live, and allowed to trench for real. The only state that says real money. */
  | { kind: "live" }
  /** Live, but not allowed to trench for real: its candidate feed is empty, so it buys nothing. */
  | { kind: "live-not-allowed" }
  /** The rail is unread or idle: what the permission allows, and nothing about what it is doing. */
  | { kind: "allowed" }
  | { kind: "not-allowed" }
  /** Self-hosted, never saved: the install's environment decides, which this read cannot see. */
  | { kind: "env-decides" };

export function trencherRow(
  settings:
    | {
        strategy?: string | null;
        trencherLiveEnabled?: boolean | null;
        assetMode?: string | null;
        /** `/api/settings` named no tenant (`owner: null`): a self-hosted install. */
        selfHosted?: boolean;
      }
    | null
    | undefined,
  mode: AgentMode,
): TrencherRow {
  if (!settings) return { kind: "unread" };
  if (settings.strategy !== "trencher") return { kind: "off" };
  if (settings.assetMode === "stocks") return { kind: "no-crypto" };
  // Paper is practice money whatever the permission, stored or not.
  if (mode === "paper") return { kind: "paper" };
  if (settings.selfHosted === true && typeof settings.trencherLiveEnabled !== "boolean") return { kind: "env-decides" };
  // Fail closed: only a stored `true` is permission to spend.
  const allowed = settings.trencherLiveEnabled === true;
  if (mode === "live") return allowed ? { kind: "live" } : { kind: "live-not-allowed" };
  return allowed ? { kind: "allowed" } : { kind: "not-allowed" };
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
    case "unlinked": return "not linked yet";
    case "linked": return row.botUsername ? `✓ @${row.botUsername}` : "✓ connected";
  }
}
