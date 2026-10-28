/**
 * SOLANA LIVE ROLLOUT: WHICH TENANTS MAY GO LIVE, AND THE PLATFORM'S CAPS ON
 * WHAT A LIVE PERMISSION MAY ALLOW.
 *
 * Robinhood Chain is rolled out a few tenants at a time (MERRYMEN_FLEET_ROLLOUT,
 * worker/src/fleet-rollout.ts) and its on-chain vault caps spending at 25 USDG
 * a day. Solana's own switch, MERRYMEN_SOLANA, is all or nothing: with it on,
 * any bound tenant could register a live permission with whatever limits it
 * signs (up to 96 operations a day and 168 hours). These settings add the same
 * kind of gate on top of it, read by the app runtime from its own env, so the
 * web and the Solana worker decide alike:
 *
 *   MERRYMEN_SOLANA_LIVE_TENANTS   0x<40 hex>[,0x<40 hex>...]: the tenants that
 *                                  may open new live permissions and buy. Unset
 *                                  or empty: nobody (paper stays open to all).
 *   MERRYMEN_SOLANA_LIVE_MAX_PER_TRADE_USDG   default 10 (USDG)
 *   MERRYMEN_SOLANA_LIVE_MAX_DAILY_USDG       default 25 (USDG, the RH vault's daily cap)
 *   MERRYMEN_SOLANA_LIVE_MAX_PER_TRADE_WSOL   default 0.1 (SOL)
 *   MERRYMEN_SOLANA_LIVE_MAX_DAILY_WSOL       default 0.25 (SOL)
 *
 * THE LIST ONLY EVER STOPS NEW LIVE PERMISSIONS AND BUYS. A tenant off it, or any
 * tenant while a setting cannot be read, cannot save live mode for the first
 * time, prepare or submit a permission, activate a first one, or buy. Its owner
 * can always sell back to USDG within the permission already registered (a
 * renewal submitted while listed is still activated once it lands), revoke,
 * withdraw, record outside withdrawals, use paper and read status: a tenant
 * taken off the list after going live is exits-only, as Robinhood's exits-only
 * level is.
 *
 * Sales count against the limits the caps bound: the vault program charges a
 * sale's USDG proceeds to the same per-trade and daily USDG limits as a buy, and
 * its SOL to the SOL sold limits. So buys keep room for exits: a buy is refused
 * once it would leave too little of the rolling 24-hour limits to sell the whole
 * position inside them (EXITS KEEP ROOM IN THE ROLLING LIMITS,
 * solana-trading-store.ts). The caps therefore stop buys, never exits; Withdraw
 * is never limited at all.
 *
 * Caps bound new permissions: live limits above one are refused where they are
 * saved, where the permission is prepared and where its signed bytes are
 * submitted, so none above the caps in force is ever sent to Solana. A session
 * registered (or sent) before a cap was lowered is activated as signed and keeps
 * its exits; its buys are refused before any quote (the limits kept in its
 * session record) and before signing (the limits every provider shows) until the owner
 * registers a new permission within the caps.
 *
 * MALFORMED REFUSES, IT NEVER GUESSES, as for MERRYMEN_FLEET_ROLLOUT: an entry
 * that does not parse is named by its position, never repeated (the value names
 * other tenants), and the runtime turns the refusal into a configuration
 * refusal of new permissions and buys, with an [alert] for the operator.
 */
import { createHash } from "node:crypto";
import { displaySolanaAmount, solanaUnits } from "../../web/src/lib/solana-amounts";
import { SOLANA_LIVE_CAP_DECIMALS, SOLANA_LIVE_CAP_DEFAULTS, SOLANA_LIVE_CAP_FIELDS, type SolanaLiveCapField, type SolanaLiveCaps } from "../../web/src/lib/solana-live-caps";
import { SOLANA_LIVE_MIN_TRADE_USDG_RAW } from "../../packages/core/src/solana";
// The caps' types, defaults and owner-facing text are shared with the page (web/src/lib/solana-live-caps.ts).
export { SOLANA_LIVE_CAP_DEFAULTS, solanaLiveCapRefusal, solanaLiveCapsExceeded, solanaLiveCapsText, solanaLiveExitLimitsRefusal, solanaLiveSavedAboveCaps, solanaLiveSessionAboveCaps,
  type SolanaLiveCapField, type SolanaLiveCappedLimits, type SolanaLiveCaps } from "../../web/src/lib/solana-live-caps";

export const SOLANA_LIVE_TENANTS_ENV = "MERRYMEN_SOLANA_LIVE_TENANTS";
/** The same bound as MERRYMEN_FLEET_ROLLOUT's: far beyond any cohort, small enough to review as a diff. */
export const SOLANA_LIVE_MAX_TENANTS = 512;
export const SOLANA_LIVE_CAP_ENV: Readonly<Record<SolanaLiveCapField, string>> = {
  perTradeUsdg: "MERRYMEN_SOLANA_LIVE_MAX_PER_TRADE_USDG", dailyUsdg: "MERRYMEN_SOLANA_LIVE_MAX_DAILY_USDG",
  perTradeWsol: "MERRYMEN_SOLANA_LIVE_MAX_PER_TRADE_WSOL", dailyWsol: "MERRYMEN_SOLANA_LIVE_MAX_DAILY_WSOL",
};

/** A setting this module cannot read. Its message names the setting and never its value. Operator-facing. */
export class SolanaLiveRolloutError extends Error {
  constructor(message: string) { super(message); this.name = "SolanaLiveRolloutError"; }
}
type Env = Readonly<Record<string, string | undefined>>;
const ENTRY = /^0x[0-9a-fA-F]{40}$/;

/**
 * The tenants MERRYMEN_SOLANA_LIVE_TENANTS names, lowercased. Unset, empty or
 * only spaces: none. Entries are separated by commas, with spaces around them
 * ignored; each must be a whole 0x tenant id (0x and 40 hex digits, either
 * case). An empty entry (a stray comma), anything else, or more than
 * SOLANA_LIVE_MAX_TENANTS entries throws SolanaLiveRolloutError naming the
 * entry's position. Naming a tenant twice is harmless and allowed.
 */
export function solanaLiveTenants(env: Env): ReadonlySet<string> {
  const raw = env[SOLANA_LIVE_TENANTS_ENV];
  if (raw === undefined || raw.trim() === "") return new Set();
  const entries = raw.split(",").map(entry => entry.trim());
  if (entries.length > SOLANA_LIVE_MAX_TENANTS) throw new SolanaLiveRolloutError(`${SOLANA_LIVE_TENANTS_ENV} names more than ${SOLANA_LIVE_MAX_TENANTS} tenants`);
  const tenants = new Set<string>();
  entries.forEach((entry, i) => {
    // The position, never the text: the value names other tenants, and an entry that does not parse is not repeated into a log.
    if (!ENTRY.test(entry)) throw new SolanaLiveRolloutError(`${SOLANA_LIVE_TENANTS_ENV} entry ${i + 1} is ${entry ? "not a tenant id (0x and 40 hex digits)" : "empty"}`);
    tenants.add(entry.toLowerCase());
  });
  return tenants;
}

/**
 * The live caps in force: each setting's decimal amount (USDG or SOL) as a raw
 * amount, parsed exactly by solanaUnits, or its default when unset or empty.
 * Throws SolanaLiveRolloutError for a value that is not a positive decimal with
 * at most 6 (USDG) or 9 (SOL) decimal places, one beyond what the program
 * stores (u64 base units), a per-trade cap above its daily cap (the program
 * refuses such limits), or a USDG per-trade cap below the 1 USDG live minimum
 * (no live limits could then be saved at all).
 */
export function solanaLiveCaps(env: Env): SolanaLiveCaps {
  const caps = { ...SOLANA_LIVE_CAP_DEFAULTS };
  for (const field of SOLANA_LIVE_CAP_FIELDS) {
    const name = SOLANA_LIVE_CAP_ENV[field], raw = env[name];
    if (raw === undefined || raw === "") continue;
    try { caps[field] = solanaUnits(raw, SOLANA_LIVE_CAP_DECIMALS[field]); }
    catch {
      throw new SolanaLiveRolloutError(`${name} must be a positive amount in ${field.endsWith("Usdg") ? "USDG with at most 6" : "SOL with at most 9"} decimal places `
        + `that fits the vault program (unset is ${displaySolanaAmount(SOLANA_LIVE_CAP_DEFAULTS[field], SOLANA_LIVE_CAP_DECIMALS[field])})`);
    }
  }
  if (BigInt(caps.perTradeUsdg) > BigInt(caps.dailyUsdg)) throw new SolanaLiveRolloutError(`${SOLANA_LIVE_CAP_ENV.perTradeUsdg} must not exceed ${SOLANA_LIVE_CAP_ENV.dailyUsdg}`);
  if (BigInt(caps.perTradeWsol) > BigInt(caps.dailyWsol)) throw new SolanaLiveRolloutError(`${SOLANA_LIVE_CAP_ENV.perTradeWsol} must not exceed ${SOLANA_LIVE_CAP_ENV.dailyWsol}`);
  if (BigInt(caps.perTradeUsdg) < SOLANA_LIVE_MIN_TRADE_USDG_RAW) throw new SolanaLiveRolloutError(`${SOLANA_LIVE_CAP_ENV.perTradeUsdg} must be at least the 1 USDG live minimum`);
  return caps;
}

/**
 * A process publishes the live rollout settings it runs at least this often: the web on a timer from its start (and at
 * once, at a Solana request, when the stored digest is not its own), the worker with every heartbeat.
 */
export const SOLANA_LIVE_ROLLOUT_PUBLISH_MS = 30_000;
/**
 * SETTINGS THAT MUST MATCH, CHECKED. The web and the Solana worker each read
 * these settings from their own env, and each service applies a change only
 * once it is redeployed. This is a digest of what one process runs: the list as
 * read (lowercased, sorted, each tenant once) and the caps in force, or
 * "unreadable" while either cannot be read. Two processes running the same
 * settings, however an operator spelled them, have the same digest. Each
 * publishes its own (the app runtime, solana_runtime_live_rollout_seen) and
 * holds live buys while the other service's differs. It names no tenant.
 */
export function solanaLiveRolloutFingerprint(env: Env): string {
  let settings: string;
  try {
    const caps = solanaLiveCaps(env);
    settings = JSON.stringify({ tenants: [...solanaLiveTenants(env)].sort(), caps: SOLANA_LIVE_CAP_FIELDS.map(field => caps[field]) });
  } catch (error) {
    if (!(error instanceof SolanaLiveRolloutError)) throw error;
    settings = "unreadable";
  }
  return createHash("sha256").update(`merrymen-solana-live-rollout/v1 ${settings}`).digest("hex");
}
