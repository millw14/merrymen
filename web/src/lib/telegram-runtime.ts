/**
 * WHAT GET /api/telegram READS OF A HOSTED TENANT'S BOT: the row the
 * orchestrator publishes (worker telegram-store.ts publishTelegramRuntime),
 * and whether another tenant has claimed the bot Telegram confirms for the
 * saved token. The decision about
 * what the screen may say from it is lib/telegram-listening.ts.
 *
 * Here, not in the route, so a test can run the worker's publish and this
 * read against one table (telegram-runtime.db.test.ts). The two sides are
 * tied by column names alone. If one were renamed on one side, the full read
 * would fail, the legacy read below would answer, and every tenant's code
 * would be back on screen with no check of which bot it was minted for: the
 * frozen code for another bot that locked an owner out, and nothing would
 * say so.
 *
 * THE CODE IS A BEARER CREDENTIAL. Every read of the row is keyed on the
 * tenant the caller authenticated as. The one read keyed on something else,
 * the claim, is asked only about a bot Telegram has just confirmed this
 * caller holds a live token for, and gives back only whether its holder is
 * this tenant.
 */
import type { Db } from "../../../worker/src/db";
import type { TelegramRuntime } from "./telegram-listening";

/** The full read: the code and owner, and the liveness columns beside them. */
export const TELEGRAM_RUNTIME_SQL =
  "SELECT link_code, owner_id, bot_id, poll_ok_at, poll_err, poll_err_at, child_state FROM tenant_telegram WHERE tenant = ?";

/** The read for a deployment whose orchestrator does not add the liveness columns yet. */
export const TELEGRAM_RUNTIME_LEGACY_SQL = "SELECT link_code, owner_id FROM tenant_telegram WHERE tenant = ?";

/** Who holds the confirmed bot (worker telegram-claims.ts). The tenant is compared, never returned. */
export const TELEGRAM_BOT_CLAIM_SQL = "SELECT tenant FROM telegram_bot_claims WHERE bot_id = ?";

/** A row either read gives. */
export interface TelegramRuntimeRow {
  link_code?: string | null;
  owner_id?: number | null;
  bot_id?: string | null;
  poll_ok_at?: number | string | null;
  poll_err?: string | null;
  poll_err_at?: number | string | null;
  child_state?: string | null;
}

const sec = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * A row as the decision reads it. A column the read did not ask for stays
 * undefined ("not published here yet"), which is not the same as one that
 * came back null ("published: nothing").
 */
export function runtimeFromRow(row: TelegramRuntimeRow, full: boolean): TelegramRuntime {
  const base: TelegramRuntime = {
    linkCode: typeof row.link_code === "string" && row.link_code ? row.link_code : null,
    ownerId: typeof row.owner_id === "number" ? row.owner_id : null,
  };
  if (!full) return base;
  return {
    ...base,
    botId: typeof row.bot_id === "string" && row.bot_id ? row.bot_id : null,
    pollOkAt: sec(row.poll_ok_at),
    pollErr: typeof row.poll_err === "string" ? row.poll_err : null,
    pollErrAt: sec(row.poll_err_at),
    childState: typeof row.child_state === "string" ? row.child_state : null,
  };
}

/**
 * ONE TENANT'S ROW, and whether the bot Telegram has just confirmed for this
 * caller's saved token (`confirmedBot`, its id, or null) is claimed by
 * another tenant. Null when there is no row and nothing to say about the bot.
 *
 * ONLY A CONFIRMED BOT IS ASKED ABOUT, for decideBotClaim's reason
 * (lib/telegram-claims.ts). A saved token is stored as typed when getMe does
 * not confirm it, and a bot id is public, so asking the claims about the
 * saved token's id told any signed-in account, for any bot it named with
 * `<id>:anything`, whether a Merrymen agent held it: silently, while that
 * agent was offline, and without the bot or its owner ever seeing the
 * question. The route passes the id getMe answered with for the token, or
 * null; an owner whose bot was moved to another agent still holds a live
 * token for it, so they are still told where it went.
 */
export async function readTelegramRuntime(
  db: Db,
  tenant: `0x${string}`,
  confirmedBot: string | null,
): Promise<TelegramRuntime | null> {
  let runtime: TelegramRuntime | null = null;
  let noRow = false;
  try {
    const row = (await db.prepare(TELEGRAM_RUNTIME_SQL).get(tenant.toLowerCase())) as TelegramRuntimeRow | undefined;
    if (row) runtime = runtimeFromRow(row, true);
    else noRow = true;
  } catch {
    // The liveness columns are added by the orchestrator on its own clock
    // (telegram-store.ts), and the web can be deployed first. Read what was
    // always there; the rest stays undefined, which the decision reads as
    // "not published here yet" rather than as "nothing heard".
  }
  if (noRow) {
    // NO ROW, AND THE BOT IS ANOTHER TENANT'S. A tenant the orchestrator
    // never hands the bot's token (its claim names someone else) never
    // writes a telegram.json, so it never gets a row: no code is minted
    // without a token. Answered as "no row", its screen said "your agent
    // mints a code on its next pass" for ever, and hid the one thing that
    // would unstick it, that the bot is connected elsewhere and can be moved
    // here. Only that verdict makes a row: anything else about a saved bot
    // with no row is still unknown, not "pending".
    return (await claimedElsewhere(db, tenant, confirmedBot)) === true
      ? { linkCode: null, ownerId: null, botId: null, botElsewhere: true }
      : null;
  }
  if (!runtime) {
    try {
      const row = (await db.prepare(TELEGRAM_RUNTIME_LEGACY_SQL).get(tenant.toLowerCase())) as TelegramRuntimeRow | undefined;
      return runtimeFromRow(row ?? {}, false);
    } catch {
      // The table is created by the orchestrator on its own clock, so a brand
      // new deployment can be asked before it exists. Unknown, not empty.
      return { linkCode: null, ownerId: null };
    }
  }
  // WHETHER ANOTHER TENANT HOLDS THE SAVED BOT. The owner's saved token
  // outlives a move of its bot to another agent (the claim moves, the old
  // tenant's settings keep the token), and this agent will never pick it up
  // again.
  const elsewhere = await claimedElsewhere(db, tenant, confirmedBot);
  if (elsewhere !== undefined) runtime.botElsewhere = elsewhere;
  return runtime;
}

/**
 * Whether the claim on `confirmedBot` names another tenant: undefined when
 * there is no bot to ask about, no claim, or no claims table yet. Only
 * whether the holder is this tenant is used; who it is never leaves here.
 */
async function claimedElsewhere(db: Db, tenant: `0x${string}`, confirmedBot: string | null): Promise<boolean | undefined> {
  if (confirmedBot === null) return undefined;
  try {
    const claim = (await db.prepare(TELEGRAM_BOT_CLAIM_SQL).get(confirmedBot)) as { tenant?: unknown } | undefined;
    return typeof claim?.tenant === "string" ? claim.tenant.toLowerCase() !== tenant.toLowerCase() : undefined;
  } catch {
    // No claims table yet: nobody has claimed anything.
    return undefined;
  }
}
