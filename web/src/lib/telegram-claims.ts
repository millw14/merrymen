/**
 * ONE BOT, ONE TENANT — the web's half: the claim is made when a token is
 * saved, so a second login is told the bot is taken instead of saving a token
 * nobody will poll for it.
 *
 * The rule and the table are worker/src/telegram-claims.ts. The orchestrator
 * enforces them (a child is handed a token only when the claim names its
 * tenant); this is where an owner finds out, and where they can move the bot.
 *
 * WHAT THE OWNER IS TOLD, AND WHAT THEY ARE NOT. That the bot is connected to
 * another Merrymen agent, and that moving it stops it answering there. NOT
 * which agent or which account, and not "your other login": the account
 * holding it may be somebody else's, and holding a token for a bot is no
 * reason to learn whose agent it was.
 *
 * A CLAIM, AND A MOVE, NEED THE BOT TO ANSWER FOR THE TOKEN (getMe), because
 * a live token is proof of control of the bot and nothing else here is: the
 * bot id before the ':' is public. And a move carries nothing with it: not the
 * other account's allowlist, not its owner. This account's own settings are
 * saved as they are, and its owner links the bot with this agent's own code.
 */
import type { MerrymenSettings } from "@merrymen/core";
import { makePgDb, type Db } from "../../../worker/src/db";
import {
  botIdOf,
  claimBot,
  ensureBotClaims,
  moveBotClaim,
  releaseBotClaims,
  undoBotClaim,
} from "../../../worker/src/telegram-claims";

/** The owner-facing refusal. Says nothing about whose agent holds the bot. */
export const BOT_CLAIMED_TEXT =
  "This bot is already connected to another Merrymen agent. Move it here? It will stop answering there and you'll need to /link again here.";

/** A move Telegram would not vouch for. */
export const BOT_UNCONFIRMED_TEXT =
  "Telegram didn't confirm that token, so the bot was not moved. Check the token (from @BotFather) and try again.";

/** The claims could not be checked, so a new bot was not saved. */
export const BOT_CLAIMS_UNAVAILABLE_TEXT =
  "Couldn't check whether this bot is free just now, so the token was not saved. Please try again in a moment.";

export type BotClaimDecision =
  | {
      ok: true;
      /** True when the bot was taken from another account by this save. */
      moved: boolean;
      /** The save did not land: take back what this claim changed. */
      undo(): Promise<void>;
      /** The save landed: let go of any bot this account no longer uses. */
      settle(): Promise<void>;
    }
  | { ok: false; status: number; body: { error: string; errors: string[] } };

const nothing = async () => {};

/**
 * WHAT A SAVE CARRYING `telegramBotToken` DOES TO THE BOT CLAIMS, decided and
 * made before the settings are written, so a refusal writes nothing.
 *
 * - Cleared: nothing to claim. Once saved, every claim this account holds is
 *   let go (WHERE tenant = this account: never anybody else's).
 * - A token Telegram confirms (getMe) for a bot this account holds, or nobody
 *   does: claimed (first one wins), and taken back if the save then fails.
 * - A token Telegram confirms for a bot another account holds: refused with
 *   409 `bot_claimed`, unless `moveBot` — and then the claim moves here, and
 *   is put back if the save fails.
 * - A token Telegram does not confirm (mistyped, revoked, or Telegram out of
 *   reach): no claim is made or moved, and the answer does not depend on
 *   whether anybody holds the bot. It is saved as typed, as it always was, and
 *   the orchestrator claims it once Telegram answers for it. Only a `moveBot`
 *   is refused (409 `bot_unconfirmed`), whatever the claims say: the owner
 *   asked for a move, and none was made.
 *
 * WHY getMe COMES FIRST. A bot id is public — anyone the bot messages sees it
 * — so a 409 given for `<id>:anything` would tell any signed-in stranger which
 * bots are Merrymen agents', and a claim made for it would keep the real
 * owner's agent off their own bot. A live token is proof of control of the
 * bot; the claim store refuses anything less (claimBot).
 *
 * Asked whenever the body carries a token, not only when its bot changes: an
 * owner whose child was refused the bot re-enters the token to get it back,
 * and a save that said "saved" while the bot stayed with the other account
 * would be the silence this exists to end. A save that does not carry the
 * token (every other field on the page) asks nothing.
 */
export async function decideBotClaim(args: {
  db: Db;
  tenant: `0x${string}`;
  /** The token this save stores; undefined when it clears it. */
  token: string | undefined;
  moveBot: boolean;
  /** The bot id getMe answers for `token`, or null when Telegram does not confirm it. */
  confirmBot: (token: string) => Promise<string | null>;
  now?: number;
}): Promise<BotClaimDecision> {
  const { db, tenant, token, moveBot } = args;
  const now = args.now ?? Date.now();
  await ensureBotClaims(db);
  const bot = token ? botIdOf(token) : null;
  // No bot to hold: a cleared token, or one that is not `<digits>:<secret>`,
  // which Telegram refuses and so polls nothing. The PUT refuses such a token
  // before this (400); here it is still never confirmed, claimed or moved, and
  // gets no 409 that would say whether its bot id is held.
  const releaseAll = async () => void (await releaseBotClaims(db, tenant));
  const leftBehind = async () => void (await releaseBotClaims(db, tenant, bot));
  if (!token || !bot) {
    if (token && moveBot) return unconfirmed;
    return { ok: true, moved: false, undo: nothing, settle: releaseAll };
  }
  const confirmed = await args.confirmBot(token);
  const claim = await claimBot(db, bot, tenant, confirmed, now);
  if (!claim) {
    if (moveBot) return unconfirmed;
    return { ok: true, moved: false, undo: nothing, settle: leftBehind };
  }
  if (claim.holder === tenant.toLowerCase()) {
    return {
      ok: true,
      moved: false,
      undo: claim.fresh ? () => undoBotClaim(db, bot, tenant, claim.stamp, null) : nothing,
      settle: leftBehind,
    };
  }
  if (!moveBot) {
    return { ok: false, status: 409, body: { error: "bot_claimed", errors: [BOT_CLAIMED_TEXT] } };
  }
  const move = await moveBotClaim(db, bot, tenant, confirmed, now);
  if (!move.moved) return unconfirmed;
  return {
    ok: true,
    moved: true,
    undo: () => undoBotClaim(db, bot, tenant, move.stamp, move.from),
    settle: leftBehind,
  };
}

const unconfirmed: BotClaimDecision = {
  ok: false,
  status: 409,
  body: { error: "bot_unconfirmed", errors: [BOT_UNCONFIRMED_TEXT] },
};

/** A malformed token, refused at save: the owner is told what a token looks like. */
export const NOT_A_BOT_TOKEN_TEXT =
  "that isn't a Telegram bot token. Copy the whole token @BotFather gave you: digits, a colon, then letters, digits, '-' and '_' (like 123456789:AAH…).";

/**
 * Is this Telegram's shape of token, `<digits>:<secret>` with a base64url
 * secret? Only such a token is ever sent to Telegram, saved, or asked about
 * the claims. The one rule is botIdOf's, beside the claims it keys, and it
 * says why the secret's alphabet matters.
 */
export function isBotToken(token: string): boolean {
  return botIdOf(token) !== null;
}

/**
 * getMe: the id of the bot `token` belongs to, as Telegram says it, or null
 * (refused, revoked, unreachable). Bounded: a third party on the save path.
 *
 * THIS ANSWER AUTHORISES EVERY CLAIM AND EVERY MOVE, so nothing else may pass
 * for it. A token not of Telegram's shape is never sent: it goes into the
 * URL's path, and `111:x/../../bot<own>/getChat?chat_id=111&z=` is resolved
 * by the URL parser into a call on the sender's own bot whose answer carries
 * id 111. And only an answer that says it is a bot counts: a chat's or a
 * user's carries an id too.
 */
export async function telegramBotIdOf(token: string): Promise<string | null> {
  if (!isBotToken(token)) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(8_000) });
    const body = (await res.json()) as { ok?: boolean; result?: { id?: unknown; is_bot?: unknown } };
    const me = body.ok === true ? body.result : undefined;
    if (!me || me.is_bot !== true) return null;
    return typeof me.id === "number" || typeof me.id === "string" ? String(me.id) : null;
  } catch {
    return null;
  }
}

/** Test seam: the database the claims are kept in, in place of DATABASE_URL's. */
let dbForTest: Db | null = null;
export function useBotClaimsDbForTest(db: Db | null): void {
  dbForTest = db;
}

/**
 * The settings PUT's whole use of the claims: null when this save touches no
 * bot claim (self-hosted, or a body without the token), else the decision.
 *
 * With no shared database there is no claim to make: one operator, one bot,
 * no orchestrator. With one that will not answer, a NEW token is refused
 * (503) rather than saved unclaimed, because the orchestrator would then give
 * the bot to the first account it met with a live token for it, which need not
 * be this one, and nobody would have been asked; clearing a token still
 * saves, and the claim it leaves is one a move resolves.
 */
export async function botClaimForSave(args: {
  tenant: `0x${string}` | null;
  touched: boolean;
  next: MerrymenSettings;
  moveBot: boolean;
}): Promise<BotClaimDecision | null> {
  if (!args.tenant || !args.touched) return null;
  const token = typeof args.next.telegramBotToken === "string" ? args.next.telegramBotToken : undefined;
  try {
    const url = process.env.DATABASE_URL;
    const db = dbForTest ?? (url ? await makePgDb(url) : null);
    if (!db) return null;
    return await decideBotClaim({ db, tenant: args.tenant, token, moveBot: args.moveBot, confirmBot: telegramBotIdOf });
  } catch (e) {
    console.warn(`[settings] telegram bot claims unavailable: ${e instanceof Error ? e.message : String(e)}`);
    if (!token) return null;
    return { ok: false, status: 503, body: { error: "bot_claims_unavailable", errors: [BOT_CLAIMS_UNAVAILABLE_TEXT] } };
  }
}
