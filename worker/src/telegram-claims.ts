/**
 * ONE BOT, ONE TENANT — a durable claim on the bot, keyed on the bot's id.
 *
 * A Telegram bot has exactly one getUpdates stream. Two processes polling it
 * steal each other's updates, and in the incident this came from that is how
 * an owner lost their bot: a second X login saved the same token, its child
 * drained the backlog with the owner's chat not on its allowlist, answered
 * every message "not authorized", and counted five stale `/link` codes as
 * five wrong guesses, which locked the owner's chat out.
 *
 * The guard before this was `dedupeBotToken`: a Set of raw token strings,
 * rebuilt every reconcile pass. It had three holes.
 *
 * - IT FORGOT. The winner was whoever the pass met first, every pass, so the
 *   answer could change with nothing about either tenant changing.
 * - IT COMPARED STRINGS. `111:AAA` and `111:BBB` are the same bot after the
 *   owner revokes and re-issues its token in @BotFather, and it saw two.
 * - IT WAS NOT ASKED AT SPAWN. A second login's child started with the token
 *   and polled until the next refresh stripped it: long enough to eat a
 *   backlog.
 *
 * So the claim is a row, `telegram_bot_claims`, one per BOT ID — the number
 * before the ':' — and the primary key is the rule. The web claims the bot
 * when a token is saved, and tells a second login so, rather than letting it
 * save a token that will never be polled (409 `bot_claimed`, with a way to
 * move it). The orchestrator reads the claims once a pass, and before a spawn,
 * and hands a token only to the tenant the claim names (claimGate). A bot
 * nobody has claimed yet — every token saved before this existed — is claimed
 * by the first tenant that polls it, and stays theirs; at a spawn, only by a
 * tenant whose owner has linked a chat (ownerLinked, and gateBot in the
 * orchestrator says why).
 *
 * EVERY CLAIM AND EVERY MOVE NEEDS A TOKEN TELEGRAM HAS JUST CONFIRMED (getMe)
 * for that bot. The bot id is public, so the id alone proves nothing; the
 * store refuses a claim without the confirmation rather than trust each
 * caller to have asked. And only a token of Telegram's own shape has a bot at
 * all (botIdOf), so nothing that could steer the getMe URL elsewhere is ever
 * sent to be confirmed.
 *
 * THE TOKEN IS NEVER STORED HERE. It is a bearer credential for the bot and it
 * already lives in one place, the sealed settings blob. The bot id is public:
 * Telegram hands it to anyone the bot messages.
 *
 * Every statement here is written once, in the sqlite spelling db.ts speaks,
 * so the tests run the SQL production runs.
 */
import { SETTINGS_DEFAULTS, type MerrymenSettings } from "../../packages/core/src/index";
import { rootDb, type Db } from "./db";
import { botIdOf, tokenTagOf } from "./telegram/state";

export { botIdOf };

/**
 * One row per bot. `claimed_at` is epoch milliseconds, and doubles as the
 * stamp an undo is conditional on (undoBotClaim), so an undo can only take
 * back the claim it made.
 */
export const TELEGRAM_BOT_CLAIMS_DDL = `
  CREATE TABLE IF NOT EXISTS telegram_bot_claims (
    bot_id TEXT PRIMARY KEY,
    tenant TEXT NOT NULL,
    claimed_at INTEGER NOT NULL
  );
`;

const ensured = new WeakMap<Db, Promise<void>>();

/**
 * CREATE TABLE IF NOT EXISTS, ONCE PER CONNECTION, AND SAFE AGAINST THE OTHER
 * SERVICE DOING THE SAME. Web and the orchestrator both create this table, and
 * after the deploy that adds it both do so at once. Postgres's IF NOT EXISTS is
 * not atomic against that: the loser can fail on the catalog's own unique
 * index (23505), see the table appear mid-statement (42P07) or find its row
 * type already made (42710). Each means the table now exists, which is all
 * this wanted (settings-store.ts createIfAbsent says the same). A failure that
 * is not one of those is forgotten, so the next call tries again. Once per
 * DATABASE, not per connection pinned from it (rootDb): a settings save runs
 * on a connection of its own, and the table is not made again for each one.
 */
export function ensureBotClaims(db: Db): Promise<void> {
  const root = rootDb(db);
  let done = ensured.get(root);
  if (!done) {
    done = db.exec(TELEGRAM_BOT_CLAIMS_DDL).catch((e: unknown) => {
      const code = (e as { code?: unknown }).code;
      if (code === "23505" || code === "42P07" || code === "42710") return;
      ensured.delete(root);
      throw e;
    });
    ensured.set(root, done);
  }
  return done;
}

const lc = (tenant: string) => tenant.toLowerCase();

/** Every claim: bot id → the account holding it. Read once per pass, not once per tenant. */
export async function readBotClaims(db: Db): Promise<Map<string, string>> {
  const rows = (await db.prepare("SELECT bot_id, tenant FROM telegram_bot_claims").all()) as { bot_id: string; tenant: string }[];
  return new Map(rows.map((r) => [String(r.bot_id), lc(String(r.tenant))]));
}

/** Who held a claim, and since when: what an undo of a move puts back. */
export interface BotClaimHolder {
  tenant: string;
  claimedAt: number;
}

export interface BotClaimResult {
  /** The account the claim names now: this tenant, or the one that got there first. */
  holder: string;
  /** True when this call made the claim; an undo takes back only a fresh one. */
  fresh: boolean;
  /** The claim's `claimed_at`: the stamp an undo of this claim is conditional on. */
  stamp: number;
}

/**
 * CLAIM THE BOT, FIRST ONE WINS — ONLY FOR A TOKEN TELEGRAM HAS JUST CONFIRMED
 * BELONGS TO IT. Null, and nothing written, otherwise.
 *
 * `confirmedBotId` is the id getMe answered for the token. A bot id is public
 * (anyone the bot messages sees it), so a claim made on the id alone could be
 * made by anybody, with `<id>:anything`, and would keep the real owner's
 * process off their own bot: the silence this table exists to end, handed to
 * a stranger. A live token is proof of control of the bot, and nothing short
 * of it makes or moves a claim.
 *
 * INSERT … ON CONFLICT DO NOTHING is the atomic part; the row is then read
 * back, in a separate statement, because under READ COMMITTED a row a racing
 * claim committed after this statement's snapshot conflicts yet stays
 * invisible inside it. No row either way means a claim raced in and was
 * released between the two: ask again.
 */
export async function claimBot(
  db: Db,
  botId: string,
  tenant: string,
  confirmedBotId: string | null,
  now: number,
): Promise<BotClaimResult | null> {
  if (confirmedBotId === null || confirmedBotId !== botId) return null;
  const t = lc(tenant);
  for (let attempt = 0; attempt < 3; attempt++) {
    const ins = await db
      .prepare("INSERT INTO telegram_bot_claims (bot_id, tenant, claimed_at) VALUES (?, ?, ?) ON CONFLICT(bot_id) DO NOTHING")
      .run(botId, t, now);
    if (ins.changes === 1) return { holder: t, fresh: true, stamp: now };
    const row = (await db.prepare("SELECT tenant, claimed_at FROM telegram_bot_claims WHERE bot_id = ?").get(botId)) as
      | { tenant: string; claimed_at: number }
      | undefined;
    if (row) return { holder: lc(String(row.tenant)), fresh: false, stamp: Number(row.claimed_at) };
  }
  throw new Error("telegram bot claim: the claim kept changing — try again");
}

export type BotMoveResult =
  | { moved: true; from: BotClaimHolder | null; stamp: number }
  | { moved: false; why: "unconfirmed" };

/**
 * MOVE THE BOT TO `tenant`, from whoever holds it — ONLY FOR A TOKEN TELEGRAM
 * HAS JUST CONFIRMED BELONGS TO THIS BOT.
 *
 * `confirmedBotId` is the id getMe answered for the token being saved. Holding
 * a live token proves control of the bot, which is the only thing a move can
 * ask for: the tenant it takes the bot from is somebody this owner must not be
 * told about. A token Telegram refused, or one whose prefix names a different
 * bot than the one answering, moves nothing.
 *
 * The UPDATE names the holder and stamp it read, so it changes the row only if
 * nothing moved or released it since; changed under it, it looks again. What it
 * replaced is returned for undoBotClaim.
 */
export async function moveBotClaim(
  db: Db,
  botId: string,
  tenant: string,
  confirmedBotId: string | null,
  now: number,
): Promise<BotMoveResult> {
  if (confirmedBotId === null || confirmedBotId !== botId) return { moved: false, why: "unconfirmed" };
  const t = lc(tenant);
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = (await db.prepare("SELECT tenant, claimed_at FROM telegram_bot_claims WHERE bot_id = ?").get(botId)) as
      | { tenant: string; claimed_at: number }
      | undefined;
    if (!row) {
      const ins = await db
        .prepare("INSERT INTO telegram_bot_claims (bot_id, tenant, claimed_at) VALUES (?, ?, ?) ON CONFLICT(bot_id) DO NOTHING")
        .run(botId, t, now);
      if (ins.changes === 1) return { moved: true, from: null, stamp: now };
      continue;
    }
    const was: BotClaimHolder = { tenant: lc(String(row.tenant)), claimedAt: Number(row.claimed_at) };
    if (was.tenant === t) return { moved: true, from: was, stamp: was.claimedAt };
    const upd = await db
      .prepare("UPDATE telegram_bot_claims SET tenant = ?, claimed_at = ? WHERE bot_id = ? AND tenant = ? AND claimed_at = ?")
      .run(t, now, botId, was.tenant, was.claimedAt);
    if (upd.changes === 1) return { moved: true, from: was, stamp: now };
  }
  throw new Error("telegram bot claim: the claim kept changing — try again");
}

/**
 * TAKE BACK A CLAIM THIS SAVE MADE, because the save it was for did not land:
 * a claim for a token that was never stored would leave the bot claimed by an
 * account that does not have it. Conditional on the row still being exactly
 * what the claim wrote (this tenant, this stamp), so it never takes back a
 * claim somebody made since. A move is put back to the holder it replaced; a
 * fresh claim is deleted.
 */
export async function undoBotClaim(
  db: Db,
  botId: string,
  tenant: string,
  stamp: number,
  from: BotClaimHolder | null,
): Promise<void> {
  if (from === null) {
    await db.prepare("DELETE FROM telegram_bot_claims WHERE bot_id = ? AND tenant = ? AND claimed_at = ?").run(botId, lc(tenant), stamp);
    return;
  }
  if (from.tenant === lc(tenant) && from.claimedAt === stamp) return; // it was ours already: nothing was changed
  await db
    .prepare("UPDATE telegram_bot_claims SET tenant = ?, claimed_at = ? WHERE bot_id = ? AND tenant = ? AND claimed_at = ?")
    .run(from.tenant, from.claimedAt, botId, lc(tenant), stamp);
}

/**
 * LET GO OF EVERY BOT THIS TENANT HOLDS, except `keep` — and only this
 * tenant's: the WHERE names the tenant, so no account can release a claim
 * that is not its own. Run when an owner clears their token, or saves one for
 * a different bot, so the bot they left is free for whoever takes it next.
 *
 * NOT run when a grant is deleted. Discarding an agent and re-granting is an
 * everyday flow and must not hand the bot to another login in between; a claim
 * left behind by an account that is gone is what a move resolves.
 */
export async function releaseBotClaims(db: Db, tenant: string, keep?: string | null): Promise<number> {
  const r = keep
    ? await db.prepare("DELETE FROM telegram_bot_claims WHERE tenant = ? AND bot_id <> ?").run(lc(tenant), keep)
    : await db.prepare("DELETE FROM telegram_bot_claims WHERE tenant = ?").run(lc(tenant));
  return r.changes;
}

/** The bot the token in these settings belongs to, judged as the child reads it (botTokenOf), or null. */
export function storedBotOf(settings: MerrymenSettings | null): string | null {
  const token = botTokenOf(settings);
  return token === null ? null : botIdOf(token);
}

/**
 * AFTER A SAVE LANDS: MAKE THIS TENANT'S CLAIMS MATCH WHAT IS STORED NOW, not
 * what this save wrote. `storedBot` reads the tenant's settings fresh and names
 * their token's bot (storedBotOf), or null. Every claim the tenant holds on any
 * other bot is let go, and the stored bot is claimed if `confirmedBot` — the
 * bot THIS save's token was confirmed for (getMe) — is that bot.
 *
 * WHY NOT SIMPLY "EVERY BOT BUT THE ONE THIS SAVE WROTE". Two saves for one
 * account at once, for bots B and then C, both claim before either writes; the
 * writes land in either order, and so do the settles after them. Settled on
 * its own bot, the save for B let go of C's claim while C was what got stored
 * (or C's let go of B's when B was), and the account was left storing a token
 * for a bot it held no claim on: the orchestrator's to strip, or to hand to the
 * next account that claimed it.
 *
 * THE SETTINGS PUT RUNS ONE SAVE AT A TIME PER ACCOUNT (web
 * lib/telegram-claims.ts withSettingsSaveLock), so among its saves the stored
 * token cannot change between a save's write and its settle, and this is, in
 * effect, "every bot but the one this save stored". What reading back still
 * buys is what the lock does not cover.
 *
 * - WRITERS THAT DO NOT SETTLE. The orchestrator's promotions (the allowlist,
 *   chat settings), holder, x-proof, the grant's first name, partner
 *   enrollment: each reads the whole settings blob and writes it back, without
 *   the lock and without settling, so one that read before a token save wrote
 *   can put the OLD token back after that save settled. The owner's token change is then lost
 *   (a lost update in the settings store, not in the claims; the fix for that
 *   is a compare-and-swap, or this lock, on every writer), and the claims name
 *   the bot the save stored while the old one is what is stored: the old bot
 *   unclaimed, for the first tenant that polls it. A settle running beside
 *   such a write ends on what it last read; the next PUT's settle, token or
 *   not, lets go of the bot nothing stores.
 * - CALLERS WITHOUT THE LOCK: this function's own tests, and a web process
 *   that could not take it. Two saves for one account can then decide before
 *   either writes, and their writes and settles land in any order. Every
 *   settle runs after its own save's write, so the settle of the LAST write
 *   reads the final stored bot, lets go of every other, and claims that one
 *   (the bot it confirmed). An earlier settle that read before the last write
 *   can let go after the last settle is done, taking the final bot's claim
 *   with the rest; so every settle reads the stored bot again after letting
 *   go, and when it has changed underneath, puts back what it let go of for
 *   the bot stored now (the same row, stamp and all) and settles again on
 *   that. Between that stale release and the put-back another account can
 *   take the bot, with a token Telegram confirms for it; and an undo of a
 *   failed save can take back what a save that decided on its claim stands on
 *   (undoBotClaimUnlessSaved says when). Serialized saves have neither.
 *
 * BOUNDED: four rounds. Settings still changing after that end with one last
 * release on the last bot read, so this tenant holds at most that one; a later
 * save's settle corrects it if it was not the last.
 *
 * WHEN THE SETTINGS CANNOT BE READ BACK, it falls back to the rule from before
 * it read them: every bot but `wrote`, the one this save stored (null for a
 * clear, or a save with no token). Only a lost update, which the lock leaves
 * to other writers, makes that the wrong bot. Then it throws, for the caller
 * to say so.
 *
 * ONLY A BOT THIS SAVE CONFIRMED IS CLAIMED, never merely the stored one. A
 * stored token may be one Telegram refused (saved as typed, claiming nothing),
 * and a claim made for it would let `<public id>:guess` take a free bot. The
 * save that stored a confirmed token claims it in its own settle, and a claim
 * put back is one this tenant already held. INSERT … ON CONFLICT DO NOTHING
 * either way: a bot another account holds is never taken here.
 *
 * Only this tenant's rows are ever deleted or written, as releaseBotClaims.
 */
export async function settleBotClaims(
  db: Db,
  tenant: string,
  storedBot: () => Promise<string | null>,
  confirmedBot: string | null,
  now: number,
  wrote?: string | null,
): Promise<void> {
  const t = lc(tenant);
  const claim = (bot: string, stamp: number) =>
    db.prepare("INSERT INTO telegram_bot_claims (bot_id, tenant, claimed_at) VALUES (?, ?, ?) ON CONFLICT(bot_id) DO NOTHING").run(bot, t, stamp);
  /** Let go of every bot but `keep`: what was let go of, bot → claimed_at. */
  const release = async (keep: string | null) =>
    (keep === null
      ? await db.prepare("DELETE FROM telegram_bot_claims WHERE tenant = ? RETURNING bot_id, claimed_at").all(t)
      : await db.prepare("DELETE FROM telegram_bot_claims WHERE tenant = ? AND bot_id <> ? RETURNING bot_id, claimed_at").all(t, keep)) as {
      bot_id: string;
      claimed_at: number;
    }[];
  /** Every claim this settle let go of, bot → claimed_at: what it puts back if the bot it let go of turns out to be the stored one. */
  const released = new Map<string, number>();
  let bot: string | null;
  try {
    bot = await storedBot();
  } catch (e) {
    if (wrote === undefined) throw e;
    await release(wrote);
    const why = e instanceof Error ? e.message : String(e);
    throw new Error(`settings unreadable after the save (${why}): the claims were settled on the token this save wrote`, { cause: e });
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    for (const r of await release(bot)) released.set(String(r.bot_id), Number(r.claimed_at));
    if (bot !== null && bot === confirmedBot) await claim(bot, now);
    const after = await storedBot();
    if (after === bot) return;
    const stamp = after === null ? undefined : released.get(after);
    if (stamp !== undefined) await claim(after!, stamp);
    bot = after;
  }
  await release(bot);
  if (bot !== null && bot === confirmedBot) await claim(bot, now);
}

/**
 * THE SAVE DID NOT LAND: TAKE BACK ITS CLAIM (undoBotClaim), UNLESS A SAVE FOR
 * THAT BOT HAS LANDED SINCE. `landed` says whether one has: the tenant's
 * settings, read fresh, hold a token for this bot that is not the one stored
 * when this save began — this save's own write after all (an error after the
 * write), or another save for the same bot that decided while this claim stood
 * and so made none of its own. Taken back under it, that save would be left
 * storing a bot it holds no claim on. Asked again after taking it back, because
 * such a save can land in between, and its settle find this claim still there
 * and change nothing: then the claim is put back as this save left it.
 *
 * A token stored before this save began, even for the same bot, is no reason
 * to keep it: the claim a failed save made or moved must not outlive it (a
 * failed move keeps the bot from the account it was taken from). And when the
 * settings cannot be read, it is taken back, as before.
 *
 * With the settings PUT one save at a time per account (settleBotClaims), the
 * save that "landed" is this one: a write that went through and then failed
 * to say so. TRUE WHEN THE CLAIM WAS KEPT: the caller then settles, as the
 * landed write's own settle would have, so the bot the account left is let go.
 */
export async function undoBotClaimUnlessSaved(
  db: Db,
  botId: string,
  tenant: string,
  stamp: number,
  from: BotClaimHolder | null,
  landed: () => Promise<boolean>,
): Promise<boolean> {
  const saved = () => landed().catch(() => false);
  if (await saved()) return true;
  await undoBotClaim(db, botId, tenant, stamp, from);
  if (!(await saved())) return false;
  const t = lc(tenant);
  if (from === null) {
    await db.prepare("INSERT INTO telegram_bot_claims (bot_id, tenant, claimed_at) VALUES (?, ?, ?) ON CONFLICT(bot_id) DO NOTHING").run(botId, t, stamp);
  } else if (!(from.tenant === t && from.claimedAt === stamp)) {
    await db
      .prepare("UPDATE telegram_bot_claims SET tenant = ?, claimed_at = ? WHERE bot_id = ? AND tenant = ? AND claimed_at = ?")
      .run(t, stamp, botId, from.tenant, from.claimedAt);
  }
  return true;
}

/**
 * The token the process these settings are written for will use: trimmed, as
 * settings.ts `str()` trims it, or null. Judged as the child will read it, so
 * a stored ` 111:x` is bot 111 here as it is there, and not a token with no
 * bot that the gate lets through untouched.
 */
export function botTokenOf(settings: MerrymenSettings | null): string | null {
  const token = settings?.telegramBotToken;
  return typeof token === "string" && token.trim() !== "" ? token.trim() : null;
}

/** The settings without the bot token: what a process that may not poll the bot is handed. Never mutates its input. */
export function withoutBotToken(settings: MerrymenSettings): MerrymenSettings {
  const { telegramBotToken: _taken, ...rest } = settings;
  return rest;
}

/**
 * HAS THIS TENANT'S OWNER LINKED A CHAT? A positive id on the stored
 * allowlist, which is a person's own DM (Telegram gives groups negative ids),
 * put there by a /link the child reported (publishChildTelegram). The same
 * reading writeTelegramForChild recovers an owner by, and for the same reason:
 * the allowlist is in the sealed settings and survives a redeploy, where the
 * mirrored owner_id mostly does not.
 */
export function ownerLinked(settings: MerrymenSettings): boolean {
  const list = settings.telegramAllowlist;
  return Array.isArray(list) && list.some((c) => typeof c === "number" && c > 0);
}

/**
 * What the orchestrator's getMe gives for a token Telegram said nothing about
 * (telegramDidNotAnswer): neither a bot's id, which a claim rests on, nor null,
 * which is a refusal.
 */
export const NO_ANSWER = "no-answer";

/**
 * DID getMe GET NO ANSWER ABOUT THE TOKEN, rather than a refusal? The request
 * failed or timed out ("request failed: …", with no code: telegram/api.ts
 * call()), or Telegram was down (5xx) or throttling (429). None of those says
 * the token is not the bot's, so none may cost a tenant its claim.
 *
 * Only an answer about the token is a refusal: 401 or 404, as the poll loop
 * reads them too (poll-rules.ts pollFailure), or an answer that is not a
 * bot's. Anything else Telegram answered stays a refusal, as it always was.
 */
export function telegramDidNotAnswer(r: { reason?: string; errorCode?: number }): boolean {
  if (r.errorCode === undefined) return /^request failed/.test(r.reason ?? "");
  return r.errorCode === 429 || r.errorCode >= 500;
}

/**
 * WHAT THE PASS'S OWN RECORD IS KEYED ON: the token's fingerprint, taken from
 * its bot's id as a number and its secret, so ` 0111:x` and `111:x` are the
 * same poller. Null for a token with no bot. See claimGate for why the secret
 * and not the bot.
 */
export function pollerKeyOf(token: string): string | null {
  const t = token.trim();
  const bot = botIdOf(t);
  return bot === null ? null : tokenTagOf(`${bot}:${t.slice(t.indexOf(":") + 1)}`);
}

/**
 * WILL THE PROCESS THESE SETTINGS ARE WRITTEN FOR POLL THE BOT? The child and
 * the hold process each resolve it as settings.ts does: the file's own
 * `telegramEnabled`, else MERRYMEN_TELEGRAM_ENABLED from the env they inherit
 * from the orchestrator (childEnv does not strip it), else the default, which
 * is off; and neither polls without a token.
 */
export function botWillPoll(settings: MerrymenSettings | null): boolean {
  if (!settings || botTokenOf(settings) === null) return false;
  if (typeof settings.telegramEnabled === "boolean") return settings.telegramEnabled;
  const env = process.env.MERRYMEN_TELEGRAM_ENABLED;
  if (env !== undefined) return env === "1" || env.toLowerCase() === "true";
  return SETTINGS_DEFAULTS.telegramEnabled;
}

export type ClaimGateVerdict =
  /**
   * Nothing to poll: no token, Telegram off, or a token that is not
   * `<digits>:<secret>` (botIdOf), which Telegram will refuse, or which
   * telegram/api.ts will not even send when it could steer the URL. Claims
   * nothing, and the file keeps what the owner saved.
   */
  | { kind: "idle" }
  /**
   * This tenant polls the bot: the claim names it, or no claim names anybody
   * (none made yet, or the claims could not be read) and nobody else polls it
   * with the same token this pass.
   */
  | { kind: "keep"; bot: string }
  /** Another tenant holds the claim, or, with no claim to go by, already polls the same token this pass. */
  | { kind: "strip"; bot: string; by: "claim" | "pass" };

/**
 * The bot this tenant would poll that no claim names yet, or null: the one a
 * caller claims (first one wins, and only for a token Telegram confirms)
 * BEFORE asking claimGate, so the answer claimGate gives is judged against it.
 * Null when the claims could not be read: there is nothing to add to.
 */
export function unclaimedBot(settings: MerrymenSettings, claims: ReadonlyMap<string, string> | null): string | null {
  const token = botTokenOf(settings);
  const bot = token === null ? null : botIdOf(token);
  return claims !== null && bot !== null && botWillPoll(settings) && !claims.has(bot) ? bot : null;
}

/**
 * WHO MAY POLL THIS BOT — pure, over claims read once for the whole pass.
 *
 * `claims` is bot id → holder, or null when it could not be read. `seen` is the
 * pass's own record of who polls each token (pollerKeyOf → tenant).
 *
 * THE CLAIM DECIDES, WHEN THERE IS ONE. Only a token Telegram confirmed makes a
 * claim, so a claim is proof its holder has the bot; the pass's record is not
 * (it holds whoever the pass met first, confirmed or not). Asked the other way
 * round, a token nobody can poll with, saved under a bot id anyone can read,
 * would keep the real owner off their own bot whenever the pass met it first.
 *
 * THE PASS'S RECORD IS THE SECOND GUARD, for a bot no claim names: at most one
 * poller per token per pass. It is the only guard while the claims cannot be
 * read (and a spawn has no pass, and passes none).
 *
 * KEYED ON THE SECRET, NOT ON THE BOT, because here nothing has vouched for
 * either token. Telegram keeps one secret live per bot (a re-issue revokes the
 * last), so two tenants with different secrets for one bot are never two
 * pollers: at most one of them gets past getUpdates. Keyed on the bot, the
 * first one met took it from the other, and the first could be a stranger's
 * `<id>:guess` or the secret the owner revoked last week, leaving the bot to
 * nobody for as long as the claims could not say otherwise. The same secret
 * under two logins, the incident's shape, is still one poller.
 *
 * ONLY A TENANT THAT WILL POLL CLAIMS. A token saved with Telegram switched off
 * is a token nobody reads updates for; it used to take the bot all the same,
 * so a login with the bot off could strip it from the login that had it on,
 * and nobody answered it. A tenant that does not poll keeps its token in its
 * file, claims nothing, and is judged like any other the pass its owner
 * switches Telegram on.
 *
 * UNREADABLE CLAIMS STRIP NOTHING BUT A SECOND POLLER IN THE SAME PASS. The
 * other direction — strip every token until the claims answer — is the silence
 * this whole branch exists to end, and a claims table that cannot be read
 * while the settings beside it can is a narrow fault. It is what the pass did
 * before claims existed.
 *
 * Returns the settings the process should be handed: the same object when the
 * token stays, a copy without it when it does not. Never mutates its input.
 */
export function claimGate(
  settings: MerrymenSettings,
  tenant: string,
  claims: ReadonlyMap<string, string> | null,
  seen?: ReadonlyMap<string, string>,
): { settings: MerrymenSettings; verdict: ClaimGateVerdict } {
  const token = botTokenOf(settings);
  const bot = token === null ? null : botIdOf(token);
  if (!botWillPoll(settings) || !token || !bot) return { settings, verdict: { kind: "idle" } };
  const t = lc(tenant);
  const strip = (by: "claim" | "pass") => ({ settings: withoutBotToken(settings), verdict: { kind: "strip", bot, by } as const });
  const holder = claims?.get(bot);
  if (holder !== undefined) return holder === t ? { settings, verdict: { kind: "keep", bot } } : strip("claim");
  const polling = seen?.get(pollerKeyOf(token)!);
  if (polling !== undefined && polling !== t) return strip("pass");
  return { settings, verdict: { kind: "keep", bot } };
}
