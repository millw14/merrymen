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
import { createHash } from "node:crypto";
import type { MerrymenSettings } from "@merrymen/core";
import { LockBusyError, makePgDb, withAdvisoryLock, type Db } from "../../../worker/src/db";
import {
  botIdOf,
  botTokenOf,
  claimBot,
  ensureBotClaims,
  moveBotClaim,
  settleBotClaims,
  storedBotOf,
  undoBotClaimUnlessSaved,
  type BotClaimHolder,
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
      /**
       * The write failed: take back what this claim changed, unless the write
       * landed after all (or, without the save lock, another save for its bot
       * did), and then settle as that write would have.
       */
      undo(): Promise<void>;
      /** The save landed: make this account's claims match the token stored now (settleBotClaims). */
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
 *
 * TWO SAVES FOR ONE ACCOUNT DO NOT OVERLAP: the settings PUT decides, writes
 * and settles under withSettingsSaveLock (two tabs, a double click, the phone
 * and the desktop take turns). Settle and undo still read `settings.read`
 * afresh after the write, and match the claims to what is stored rather than
 * to what this save wrote, for the writers the lock does not cover;
 * settleBotClaims says which, and what reading back does and does not fix.
 */
export async function decideBotClaim(args: {
  db: Db;
  tenant: `0x${string}`;
  /** The token this save stores; undefined when it clears it. */
  token: string | undefined;
  moveBot: boolean;
  /** The bot id getMe answers for `token`, or null when Telegram does not confirm it. */
  confirmBot: (token: string) => Promise<string | null>;
  /**
   * This account's settings: `before`, as this save read them before changing
   * anything, and `read`, the store read afresh, which settle and undo call
   * after the write (or the failed write) to see what was stored in the end.
   */
  settings: { before: MerrymenSettings | null; read: (tenant: `0x${string}`) => Promise<MerrymenSettings | null> };
  now?: number;
}): Promise<BotClaimDecision> {
  const { db, tenant, token, moveBot } = args;
  const now = args.now ?? Date.now();
  await ensureBotClaims(db);
  const bot = token ? botIdOf(token) : null;
  const storedBot = async () => storedBotOf(await args.settings.read(tenant));
  /**
   * Let go of every bot but the one stored now, and claim that one if this
   * save confirmed it. Settings that cannot be read back: every bot but this
   * save's own, the rule from before settle read them.
   */
  const settle = (confirmedBot: string | null) => () => settleBotClaims(db, tenant, storedBot, confirmedBot, now, bot);
  /**
   * Has a write storing this save's bot (or, for a clear, no token) landed
   * since this save read the settings? With saves one at a time per account,
   * that is this save's own write, gone through before the store failed to
   * say so; then its claim stays, and what it left behind is let go.
   */
  const before = botTokenOf(args.settings.before);
  const landed = async () => {
    const stored = botTokenOf(await args.settings.read(tenant));
    if (stored === before) return false;
    return bot === null ? stored === null : stored !== null && botIdOf(stored) === bot;
  };
  /** No claim of this save's own to take back: settle if the write went through all the same. */
  const settleIfLanded = (confirmedBot: string | null) => async () => {
    if (await landed().catch(() => false)) await settle(confirmedBot)();
  };
  // No bot to hold: a cleared token, or one that is not `<digits>:<secret>`,
  // which Telegram refuses and so polls nothing. The PUT refuses such a token
  // before this (400); here it is still never confirmed, claimed or moved, and
  // gets no 409 that would say whether its bot id is held.
  if (!token || !bot) {
    if (token && moveBot) return unconfirmed;
    return { ok: true, moved: false, undo: settleIfLanded(null), settle: settle(null) };
  }
  const undo = (stamp: number, from: BotClaimHolder | null) => async () => {
    if (await undoBotClaimUnlessSaved(db, bot, tenant, stamp, from, landed)) await settle(bot)();
  };
  const confirmed = await args.confirmBot(token);
  const claim = await claimBot(db, bot, tenant, confirmed, now);
  if (!claim) {
    if (moveBot) return unconfirmed;
    return { ok: true, moved: false, undo: settleIfLanded(null), settle: settle(null) };
  }
  if (claim.holder === tenant.toLowerCase()) {
    return {
      ok: true,
      moved: false,
      undo: claim.fresh ? undo(claim.stamp, null) : settleIfLanded(bot),
      settle: settle(bot),
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
    undo: undo(move.stamp, move.from),
    settle: settle(bot),
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

/**
 * A HOSTED SAVE THAT DOES NOT CARRY THE TOKEN asks Telegram nothing and claims
 * nothing, but once it lands it still lets go of every bot this account holds
 * that it does not store (settleBotClaims, with no bot confirmed). A writer
 * that does not settle (settleBotClaims names them) can have put an old token
 * back after a token save; the claim it left on the bot no longer stored goes
 * here, rather than waiting for the owner's next token save.
 */
export async function settleWithoutToken(args: {
  db: Db;
  tenant: `0x${string}`;
  /** What this save writes: its token is the one read at the start, and kept should the store not read back. */
  next: MerrymenSettings;
  settings: { read: (tenant: `0x${string}`) => Promise<MerrymenSettings | null> };
  now?: number;
}): Promise<Extract<BotClaimDecision, { ok: true }>> {
  const { db, tenant } = args;
  const now = args.now ?? Date.now();
  await ensureBotClaims(db);
  const storedBot = async () => storedBotOf(await args.settings.read(tenant));
  return { ok: true, moved: false, undo: nothing, settle: () => settleBotClaims(db, tenant, storedBot, null, now, storedBotOf(args.next)) };
}

/** Test seam: the database the claims are kept in, in place of DATABASE_URL's. */
let dbForTest: Db | null = null;
export function useBotClaimsDbForTest(db: Db | null): void {
  dbForTest = db;
}

/** The claims database: the test seam's, DATABASE_URL's, or null (no shared database). Throws when one is named and will not open. */
async function claimsDb(): Promise<Db | null> {
  const url = process.env.DATABASE_URL;
  return dbForTest ?? (url ? await makePgDb(url) : null);
}

/**
 * The claims database as a hosted save has it: the connection its account's
 * save lock is held on, none (no shared database: nothing to claim), or one
 * that would not open or lock (`error`).
 */
export type SaveClaims = { db: Db | null } | { db: null; error: unknown };

/** The advisory lock class of an account's settings saves. Distinct from every other key in the repo (tg-groups-ferry.ts lists them), and the two-int form keeps it apart from the single-key ones. */
export const SETTINGS_SAVE_LOCK = 1_297_692_130;
/** The account's key within SETTINGS_SAVE_LOCK. A collision only makes two accounts take turns. */
export function settingsSaveLockKey(tenant: string): number {
  return createHash("sha256").update(tenant.toLowerCase()).digest().readInt32BE(0);
}

/** Another save for this account held the lock for the whole wait. */
export const SAVE_BUSY: unique symbol = Symbol("settings save busy");
export const SETTINGS_BUSY_TEXT = "Another save for this agent is still going through, so this one was not saved. Please try again in a moment.";

/**
 * ONE SETTINGS SAVE AT A TIME PER HOSTED ACCOUNT, from the read the save is
 * built on to the claims settled after its write (or put back after it
 * failed): withAdvisoryLock on the shared database, so it holds across web
 * processes, and `fn` is handed the connection it is held on for the claims.
 *
 * WHY. Each save reads the whole settings blob, changes its own fields, and
 * writes the whole blob back. Two at once for one account (two tabs, a double
 * click, the phone and the desktop) each wrote back what the other had not
 * seen: a save of the allowlist that read before a token save wrote put the
 * old token back, so the owner's new bot was lost, and the claims named a bot
 * nothing stored. And the bot claims, made before the write and settled or
 * taken back after it, had interleavings no reading back could fix: a
 * double-clicked "Move it here" whose first write failed could hand the bot
 * back to the other account after the second click's save had landed and
 * said "saved". Taking turns, each save reads what the one before it wrote,
 * and decides its claim on what that one left.
 *
 * WHAT IT DOES NOT COVER: writers other than this PUT (settleBotClaims names
 * them) read and write the same blob without it.
 *
 * NO SHARED DATABASE: no lock, and nothing to claim (self-hosted is one
 * process with one file). ONE THAT WILL NOT OPEN OR LOCK: the save runs
 * without the lock, as it did before there was one, and botClaimForSave
 * refuses a token it cannot claim (503). THE LOCK HELD FOR THE WHOLE WAIT by
 * another save (`waitMs`, past a getMe and a write): SAVE_BUSY, and nothing is
 * read or written; the caller tells the owner to try again.
 */
export async function withSettingsSaveLock<T>(
  tenant: `0x${string}`,
  fn: (claims: SaveClaims) => Promise<T>,
  waitMs?: number,
): Promise<T | typeof SAVE_BUSY> {
  let db: Db | null;
  try {
    db = await claimsDb();
  } catch (error) {
    return fn({ db: null, error });
  }
  if (!db) return fn({ db: null });
  let entered = false;
  try {
    return await withAdvisoryLock(
      db,
      SETTINGS_SAVE_LOCK,
      settingsSaveLockKey(tenant),
      (locked) => {
        entered = true;
        return fn({ db: locked });
      },
      waitMs,
    );
  } catch (e) {
    if (entered) throw e;
    if (e instanceof LockBusyError) return SAVE_BUSY;
    console.warn(`[settings] save lock unavailable, saving without it: ${e instanceof Error ? e.message : String(e)}`);
    return fn({ db: null, error: e });
  }
}

/**
 * The settings PUT's whole use of the claims: null when this save touches no
 * bot claim (self-hosted, or no claims database), else the decision: for a
 * body carrying the token, decideBotClaim's; for one that does not,
 * settleWithoutToken's, which asks nothing and only settles.
 *
 * With no shared database there is no claim to make: one operator, one bot,
 * no orchestrator. With one that will not answer, a NEW token is refused
 * (503) rather than saved unclaimed, because the orchestrator would then give
 * the bot to the first account it met with a live token for it, which need not
 * be this one, and nobody would have been asked; clearing a token, or a save
 * without one, still saves, and the claim it leaves is one a later save lets
 * go of or a move resolves.
 */
export async function botClaimForSave(args: {
  tenant: `0x${string}` | null;
  touched: boolean;
  next: MerrymenSettings;
  moveBot: boolean;
  /** The account's settings as this save read them, and the store to read them afresh from (decideBotClaim). */
  settings: { before: MerrymenSettings | null; read: (tenant: `0x${string}`) => Promise<MerrymenSettings | null> };
  /** The claims database under this account's save lock (withSettingsSaveLock). Omitted: opened here, with no lock. */
  claims?: SaveClaims;
}): Promise<BotClaimDecision | null> {
  const tenant = args.tenant;
  if (!tenant) return null;
  const token = args.touched && typeof args.next.telegramBotToken === "string" ? args.next.telegramBotToken : undefined;
  try {
    const claims = args.claims ?? { db: await claimsDb() };
    if ("error" in claims) throw claims.error;
    const db = claims.db;
    if (!db) return null;
    if (!args.touched) return await settleWithoutToken({ db, tenant, next: args.next, settings: args.settings });
    return await decideBotClaim({ db, tenant, token, moveBot: args.moveBot, confirmBot: telegramBotIdOf, settings: args.settings });
  } catch (e) {
    console.warn(`[settings] telegram bot claims unavailable: ${e instanceof Error ? e.message : String(e)}`);
    if (!token) return null;
    return { ok: false, status: 503, body: { error: "bot_claims_unavailable", errors: [BOT_CLAIMS_UNAVAILABLE_TEXT] } };
  }
}
