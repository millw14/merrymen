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
 * by the first tenant that polls it, and stays theirs.
 *
 * EVERY CLAIM AND EVERY MOVE NEEDS A TOKEN TELEGRAM HAS JUST CONFIRMED (getMe)
 * for that bot. The bot id is public, so the id alone proves nothing; the
 * store refuses a claim without the confirmation rather than trust each
 * caller to have asked.
 *
 * THE TOKEN IS NEVER STORED HERE. It is a bearer credential for the bot and it
 * already lives in one place, the sealed settings blob. The bot id is public:
 * Telegram hands it to anyone the bot messages.
 *
 * Every statement here is written once, in the sqlite spelling db.ts speaks,
 * so the tests run the SQL production runs.
 */
import { SETTINGS_DEFAULTS, type MerrymenSettings } from "../../packages/core/src/index";
import type { Db } from "./db";
import { botIdOf } from "./telegram/state";

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
 * is not one of those is forgotten, so the next call tries again.
 */
export function ensureBotClaims(db: Db): Promise<void> {
  let done = ensured.get(db);
  if (!done) {
    done = db.exec(TELEGRAM_BOT_CLAIMS_DDL).catch((e: unknown) => {
      const code = (e as { code?: unknown }).code;
      if (code === "23505" || code === "42P07" || code === "42710") return;
      ensured.delete(db);
      throw e;
    });
    ensured.set(db, done);
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

/**
 * WILL THE PROCESS THESE SETTINGS ARE WRITTEN FOR POLL THE BOT? The child and
 * the hold process each resolve it as settings.ts does: the file's own
 * `telegramEnabled`, else MERRYMEN_TELEGRAM_ENABLED from the env they inherit
 * from the orchestrator (childEnv does not strip it), else the default, which
 * is off; and neither polls without a token.
 */
export function botWillPoll(settings: MerrymenSettings | null): boolean {
  const token = settings?.telegramBotToken;
  if (!settings || typeof token !== "string" || token.trim() === "") return false;
  if (typeof settings.telegramEnabled === "boolean") return settings.telegramEnabled;
  const env = process.env.MERRYMEN_TELEGRAM_ENABLED;
  if (env !== undefined) return env === "1" || env.toLowerCase() === "true";
  return SETTINGS_DEFAULTS.telegramEnabled;
}

export type ClaimGateVerdict =
  /**
   * Nothing to poll: no token, Telegram off, or a token that is not
   * `<digits>:<secret>` and which Telegram will refuse. Claims nothing, and the
   * file keeps what the owner saved.
   */
  | { kind: "idle" }
  /**
   * This tenant polls the bot: the claim names it, or no claim names anybody
   * (none made yet, or the claims could not be read) and nobody else polls it
   * this pass.
   */
  | { kind: "keep"; bot: string }
  /** Another tenant holds the claim, or, with no claim to go by, already polls the bot this pass. */
  | { kind: "strip"; bot: string; by: "claim" | "pass" };

/**
 * The bot this tenant would poll that no claim names yet, or null: the one a
 * caller claims (first one wins, and only for a token Telegram confirms)
 * BEFORE asking claimGate, so the answer claimGate gives is judged against it.
 * Null when the claims could not be read: there is nothing to add to.
 */
export function unclaimedBot(settings: MerrymenSettings, claims: ReadonlyMap<string, string> | null): string | null {
  const token = settings.telegramBotToken;
  const bot = typeof token === "string" ? botIdOf(token) : null;
  return claims !== null && bot !== null && botWillPoll(settings) && !claims.has(bot) ? bot : null;
}

/**
 * WHO MAY POLL THIS BOT — pure, over claims read once for the whole pass.
 *
 * `claims` is bot id → holder, or null when it could not be read. `seen` is the
 * pass's own record of who polls each bot (bot id → tenant).
 *
 * THE CLAIM DECIDES, WHEN THERE IS ONE. Only a token Telegram confirmed makes a
 * claim, so a claim is proof its holder has the bot; the pass's record is not
 * (it holds whoever the pass met first, confirmed or not). Asked the other way
 * round, a token nobody can poll with, saved under a bot id anyone can read,
 * would keep the real owner off their own bot whenever the pass met it first.
 *
 * THE PASS'S RECORD IS THE SECOND GUARD, for a bot no claim names: at most one
 * poller for it per pass. It is the only guard while the claims cannot be read
 * (and a spawn has no pass, and passes none).
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
  const token = settings.telegramBotToken;
  const bot = typeof token === "string" ? botIdOf(token) : null;
  if (!botWillPoll(settings) || !bot) return { settings, verdict: { kind: "idle" } };
  const t = lc(tenant);
  const strip = (by: "claim" | "pass") => {
    const { telegramBotToken: _taken, ...rest } = settings;
    return { settings: rest, verdict: { kind: "strip", bot, by } as const };
  };
  const holder = claims?.get(bot);
  if (holder !== undefined) return holder === t ? { settings, verdict: { kind: "keep", bot } } : strip("claim");
  const polling = seen?.get(bot);
  if (polling !== undefined && polling !== t) return strip("pass");
  return { settings, verdict: { kind: "keep", bot } };
}
