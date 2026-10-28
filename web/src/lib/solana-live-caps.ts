/**
 * THE SOLANA LIVE ROLLOUT, IN THE OWNER'S WORDS: the platform's caps on live
 * limits and what the page and the app runtime say about them and about the
 * live list. Pure and client-safe, so the page and the runtime share one text.
 * The settings themselves (MERRYMEN_SOLANA_LIVE_TENANTS and the
 * MERRYMEN_SOLANA_LIVE_MAX_* caps) are read on the server only, by
 * worker/src/solana-live-rollout.ts; the page learns the caps in force from
 * status (liveAccess), never the list.
 */
import { displaySolanaAmount } from "./solana-amounts";

export type SolanaLiveCapField = "perTradeUsdg" | "dailyUsdg" | "perTradeWsol" | "dailyWsol";
/** Raw amounts: micro-USDG for the USDG caps, lamports for the SOL caps. */
export type SolanaLiveCaps = Record<SolanaLiveCapField, string>;
export const SOLANA_LIVE_CAP_FIELDS: readonly SolanaLiveCapField[] = ["perTradeUsdg", "dailyUsdg", "perTradeWsol", "dailyWsol"];
/** 10 USDG per trade, 25 USDG a day (the Robinhood vault's daily cap), 0.1 SOL sold per trade, 0.25 SOL sold a day. */
export const SOLANA_LIVE_CAP_DEFAULTS: Readonly<SolanaLiveCaps> = { perTradeUsdg: "10000000", dailyUsdg: "25000000", perTradeWsol: "100000000", dailyWsol: "250000000" };
export const SOLANA_LIVE_CAP_DECIMALS: Readonly<Record<SolanaLiveCapField, number>> = { perTradeUsdg: 6, dailyUsdg: 6, perTradeWsol: 9, dailyWsol: 9 };
/** What the owner calls each limit: the page's own field labels. */
const LABELS: Readonly<Record<SolanaLiveCapField, string>> = { perTradeUsdg: "USDG per trade", dailyUsdg: "USDG per 24 hours",
  perTradeWsol: "SOL sold per trade", dailyWsol: "SOL sold per 24 hours" };

/**
 * What status and the refusals say about the live list (app runtime). It only
 * ever stops new live permissions and buys; exits, revoke and withdraw never
 * read it.
 * - SOLANA_LIVE_NOT_OPEN: a tenant the list does not name, whose account never
 *   went live: it cannot save live mode, register a permission or buy.
 * - SOLANA_LIVE_PAUSED: one that went live (a registered permission or a live
 *   book) and is off the list now: exits-only. Status says it as a blocker that
 *   leaves exits open; its buys and new permissions are refused with it.
 * - SOLANA_LIVE_ROLLOUT_MISCONFIGURED: the list or a cap cannot be read: new
 *   permissions and buys are refused for everyone, as configuration; exits
 *   continue.
 * - The _NO_PERMISSION variants, in status only, for an account that went live
 *   whose permission expired or was replaced on Solana: nothing can be sold
 *   without a current permission, and a new one cannot be registered meanwhile,
 *   so they never say exits still work. Revoke and withdraw always do.
 */
export const SOLANA_LIVE_NOT_OPEN = "Live trading is not open for this account yet. Paper trading is available.";
export const SOLANA_LIVE_PAUSED = "Live trading is paused for this account: exits, revoke and withdraw still work.";
export const SOLANA_LIVE_PAUSED_NO_PERMISSION = "Live trading is paused for this account: revoke and withdraw still work. Selling needs a current trading permission, "
  + "and a new one cannot be registered while live trading is paused.";
export const SOLANA_LIVE_ROLLOUT_MISCONFIGURED = "The live trading access settings are misconfigured: new live permissions and buys are refused until an operator fixes them. Exits, revoke and withdraw still work.";
/**
 * Status and the refusal of a buy (and of its preview) while the web and the Solana worker run different live rollout settings,
 * as during a deploy that changes them (SETTINGS THAT MUST MATCH, CHECKED, in the app runtime): buying only waits.
 */
export const SOLANA_LIVE_ROLLOUT_DIFFERS = "The live trading access settings differ between this platform's services, as while an update is deployed: "
  + "buying is paused until they match. Exits, revoke and withdraw still work.";
export const SOLANA_LIVE_ROLLOUT_MISCONFIGURED_NO_PERMISSION = "The live trading access settings are misconfigured: new live permissions and buys are refused until an operator fixes them. "
  + "Revoke and withdraw still work. Selling needs a current trading permission, and a new one cannot be registered until then.";

/** The limits a live permission carries (or would), as raw amounts. Missing SOL limits are not compared. */
export type SolanaLiveCappedLimits = { perTradeUsdg: string | bigint; dailyUsdg: string | bigint; perTradeWsol?: string | bigint; dailyWsol?: string | bigint };
/** Which of `limits` are above `caps`, in the page's order. */
export function solanaLiveCapsExceeded(limits: SolanaLiveCappedLimits, caps: SolanaLiveCaps): SolanaLiveCapField[] {
  return SOLANA_LIVE_CAP_FIELDS.filter(field => limits[field] !== undefined && BigInt(limits[field]) > BigInt(caps[field]));
}
function amount(caps: SolanaLiveCaps, field: SolanaLiveCapField): string {
  return `${displaySolanaAmount(caps[field], SOLANA_LIVE_CAP_DECIMALS[field])} ${field.endsWith("Usdg") ? "USDG" : "SOL"}`;
}
/** The caps, in the owner's words: "at most 10 USDG per trade, 25 USDG per 24 hours, 0.1 SOL sold per trade and 0.25 SOL sold per 24 hours". */
export function solanaLiveCapsText(caps: SolanaLiveCaps): string {
  const parts = SOLANA_LIVE_CAP_FIELDS.map(field => `${amount(caps, field)}${LABELS[field].replace(/^(USDG|SOL)/, "")}`);
  return `at most ${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}
/**
 * The owner-facing refusal of live limits above the caps, naming each cap
 * exceeded and all of them, or null when none is. `when`: where it was refused,
 * which says what was not done: saving, preparing a permission, or sending one
 * prepared before the caps were lowered.
 */
export function solanaLiveCapRefusal(limits: SolanaLiveCappedLimits, caps: SolanaLiveCaps, when: "save" | "register" | "submit"): string | null {
  const over = solanaLiveCapsExceeded(limits, caps);
  if (!over.length) return null;
  const named = over.map(field => `${LABELS[field]} is above this platform's live cap of ${amount(caps, field)}`).join("; ");
  return `${named.charAt(0).toUpperCase()}${named.slice(1)}. Live limits here are ${solanaLiveCapsText(caps)}. `
    + (when === "save" ? "Lower them and save again. Nothing was saved." : when === "register" ? "Save live limits within them, then register. Nothing was prepared."
      : "Save live limits within them and register again. Nothing was sent.");
}
/**
 * The refusal of live limits above `ceiling`: for each limit the larger of the cap and what the permission the account
 * registered allows (whichever of them is known). Its live limits are how its exits are sold, so they may reach that
 * permission's own, never beyond it or the caps. Null within it. `why`: "paused" off the live list (exits-only), or while a
 * rollout setting cannot be read; "above-caps" on the list, while the permission it registered allows more than the caps
 * (registered before they were lowered), whose buys are refused until a new one within them is registered.
 */
export function solanaLiveExitLimitsRefusal(limits: SolanaLiveCappedLimits, ceiling: SolanaLiveCaps, why: "paused" | "above-caps" = "paused"): string | null {
  if (!solanaLiveCapsExceeded(limits, ceiling).length) return null;
  if (why === "above-caps") {
    return `Your registered live permission allows more than this platform's live caps, so your live limits may be at most the caps or, where it allows more, `
      + `that permission: ${solanaLiveCapsText(ceiling)}. Lower them and save again. Nothing was saved.`;
  }
  return `While live trading is paused for this account, its live limits may be at most this platform's live caps or, where it allows more, the permission `
    + `you registered: ${solanaLiveCapsText(ceiling)}. Lower them and save again. Nothing was saved.`;
}
/** The status blocker, and a buy's refusal, while the registered permission allows more than the caps. */
export function solanaLiveSessionAboveCaps(caps: SolanaLiveCaps): string {
  return `Your registered live permission allows more than this platform's live caps (${solanaLiveCapsText(caps)}). Buying is paused until you register a new `
    + "permission within them; exits, revoke and withdraw still work.";
}
/** The status warning, and why the page will not register, while the saved live limits are above the caps. */
export function solanaLiveSavedAboveCaps(caps: SolanaLiveCaps): string {
  return `Your saved live limits are above this platform's live caps (${solanaLiveCapsText(caps)}): save limits within them before registering a new permission.`;
}
