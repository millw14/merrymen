/**
 * THE TELEGRAM LINK CODE, PUBLISHED PER TENANT SO THE DASHBOARD CAN SHOW IT.
 *
 * Two beta testers were blocked at the same step: bot token saved, "test
 * connection ✓ connected as @merrymen_hosted_…_bot", "the bot is listening"
 * ticked — and no link code anywhere, so `/link` could never be sent. One
 * wrote, exactly: "I'm stuck at this point, no code from /link".
 *
 * The code was never missing. It was in the wrong container. The CHILD mints it
 * on boot and writes it to `<childHome>/telegram.json`, which lives on the
 * ORCHESTRATOR's disk; `/api/telegram` read `merrymenHome()/telegram.json` on
 * the WEB container, where nothing has ever written one. So the route returned
 * `linkCode: null` to every hosted tenant, always, and rendered a placeholder.
 * The same shape as the feed's identity bug and /api/grants' "different
 * directories, different containers" note — the third time this repo has paid
 * for it.
 *
 * WHY A TABLE OF ITS OWN, AND NOT ONE OF THE THREE THAT ALREADY EXIST:
 *
 *   `agents` is keyed on the SMART ACCOUNT, so a re-grant mints a fresh row and
 *   the code would read null exactly when somebody is setting their agent up.
 *   It is also the table the public leaderboard, scoreboard and search read;
 *   a Telegram user id does not belong in the public roster.
 *
 *   `tenant_settings` is the sealed settings blob, and `put` REPLACES it. The
 *   web is its only writer today. A 15-second orchestrator loop writing that
 *   row would silently discard a tenant's save while they were typing.
 *
 *   `agent_identity` is the public record `/a/<slug>` resolves through. A
 *   one-time bearer credential does not belong beside a display name.
 *
 * So: tenant-keyed (survives a re-grant), written ONLY by the orchestrator,
 * read ONLY by the web route, and holding nothing that is public.
 *
 * THE CHILD IS NOT THE WRITER, and cannot be: `CHILD_SECRET_STRIP` removes
 * DATABASE_URL precisely so a child cannot reach the shared database. The
 * orchestrator is the one process that can see both a child's home and the
 * shared store, which is the same ferry the ledger mirror and the command
 * channel already use.
 *
 * THE CODE IS A BEARER CREDENTIAL. `/link <code>` is accepted from ANY chat,
 * first-come, and on success sets the owner and allowlists that chat — so
 * whoever holds it can send control commands to that agent. Every read of this
 * table must be scoped to an authenticated tenant. There is no "just render it
 * for debugging" use of this value.
 */

import type { Db } from "./db";
import type { PollHealth } from "./telegram/state";

export const TELEGRAM_STATE_DDL = `
  CREATE TABLE IF NOT EXISTS tenant_telegram (
    tenant TEXT PRIMARY KEY,
    link_code TEXT,
    owner_id INTEGER,
    linked_at INTEGER,
    updated_at INTEGER NOT NULL DEFAULT 0
  );
`;

export interface TenantTelegram {
  linkCode: string | null;
  ownerId: number | null;
  linkedAt: number | null;
}

/**
 * READ ONE TENANT'S PUBLISHED TELEGRAM STATE — the direction this table was
 * missing.
 *
 * The mirror was write-only. `publishTenantTelegram` copied a child's
 * `telegram.json` up to Postgres and nothing ever copied it back, which was
 * survivable only while a child's home outlived a deploy. It does not: the
 * orchestrator has no volume, so `childHome()` is wiped on every redeploy, and
 * `ownerId` — the single recipient every alert, ping and daily report is sent
 * to — lives nowhere else.
 *
 * So every redeploy silently unlinked every hosted tenant. The bot kept
 * answering commands, because a command replies to whoever sent it, but nothing
 * the agent initiated could reach anyone again, and the link code had rotated
 * so the owner's old one no longer worked either. Nobody was told; the notifier
 * simply returns at `state.ownerId === null`.
 *
 * Returns null when there is no row, which is honestly "never linked" — and is
 * NOT the same as a row whose owner_id is null, which is "linked once, then
 * unlinked". The caller must be able to tell those apart.
 */
export async function readTenantTelegram(db: Db, tenant: string): Promise<TenantTelegram | null> {
  const row = (await db
    .prepare("SELECT link_code, owner_id, linked_at FROM tenant_telegram WHERE tenant = ?")
    .get(tenant.toLowerCase())) as
    | { link_code: string | null; owner_id: number | null; linked_at: number | null }
    | undefined;
  if (!row) return null;
  // A ROW THAT SAYS NOTHING ABOUT A LINK IS NO LINK. publishTenantChildState
  // makes one for a held tenant with no bot, only so its dashboard can say
  // trading is held; read as a link it would be "linked once, then unlinked"
  // (the MCP notifications tool says exactly that) for an owner who never
  // linked anything. A child that has run its bot always has a code here.
  if (row.link_code == null && row.owner_id == null && row.linked_at == null) return null;
  return {
    linkCode: row.link_code ?? null,
    ownerId: row.owner_id === null || row.owner_id === undefined ? null : Number(row.owner_id),
    linkedAt: row.linked_at === null || row.linked_at === undefined ? null : Number(row.linked_at),
  };
}

/**
 * Publish one tenant's telegram runtime state.
 *
 * Unconditional overwrite, never a ratchet. The code ROTATES on every
 * successful link, so a monotonic rule here would pin the dashboard to a code
 * the worker has already retired — the reader would show a string that no
 * longer works and no error anywhere. `ownerId` is a current fact for the same
 * reason.
 */
export async function publishTenantTelegram(
  db: Db,
  tenant: string,
  state: TenantTelegram,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO tenant_telegram (tenant, link_code, owner_id, linked_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (tenant) DO UPDATE SET
         link_code = excluded.link_code,
         owner_id = excluded.owner_id,
         linked_at = excluded.linked_at,
         updated_at = excluded.updated_at`,
    )
    .run(
      tenant.toLowerCase(),
      state.linkCode,
      state.ownerId,
      state.linkedAt,
      Math.floor(Date.now() / 1000),
    );
}

/**
 * WHICH HOLDS THE OWNER HAS ALREADY BEEN TOLD ABOUT: every reason class a
 * "your agent has stopped trading" notice has named since the book last
 * restored, as a JSON array, or null.
 *
 * Durable because the memory of it is not: a hold outlives the process that
 * noticed it, and every redeploy (they come in bursts while something is being
 * fixed) would otherwise tell the owner the same thing again. Keyed on the
 * class, so a hold whose cause changes is a new thing to say; a SET of them,
 * not the last one, so a hold whose retries alternate between two causes says
 * each once rather than on every flip; and cleared when the book restores
 * (clearHoldNotified), so the next incident is told too.
 *
 * On this table because it is about the owner's chat and nothing else, and
 * like the rest of it, written only by the orchestrator, by the replica
 * holding the tenant's lease (so the read-then-write below has one writer).
 * Added with an ALTER, as mirror_state's columns are: CREATE TABLE IF NOT
 * EXISTS adds nothing to a table every deployment already has. The ALTER
 * throws once the column is there, which the caller swallows.
 */
export const TELEGRAM_HOLD_NOTIFIED_DDL = "ALTER TABLE tenant_telegram ADD COLUMN hold_notified TEXT";

/** The classes this tenant's owner has been told about, in the order they were told. */
export async function holdNotifiedClasses(db: Db, tenant: string): Promise<string[]> {
  const row = (await db.prepare("SELECT hold_notified FROM tenant_telegram WHERE tenant = ?").get(tenant.toLowerCase())) as
    | { hold_notified: string | null }
    | undefined;
  const raw = row?.hold_notified;
  if (typeof raw !== "string" || raw === "") return [];
  try {
    const list = JSON.parse(raw) as unknown;
    if (Array.isArray(list)) return list.filter((c): c is string => typeof c === "string");
  } catch {
    /* not a list: a bare class */
  }
  return [raw];
}

/** Record that the owner was told about a hold of class `cls`. Needs the tenant's row, which a recipient implies. */
export async function recordHoldNotified(db: Db, tenant: string, cls: string): Promise<void> {
  const told = await holdNotifiedClasses(db, tenant);
  if (told.includes(cls)) return;
  await db
    .prepare("UPDATE tenant_telegram SET hold_notified = ? WHERE tenant = ?")
    .run(JSON.stringify([...told, cls]), tenant.toLowerCase());
}

/** The book restored: the next hold, whatever its class, is news again. */
export async function clearHoldNotified(db: Db, tenant: string): Promise<void> {
  await db
    .prepare("UPDATE tenant_telegram SET hold_notified = NULL WHERE tenant = ? AND hold_notified IS NOT NULL")
    .run(tenant.toLowerCase());
}

/**
 * WHETHER ANYTHING IS HEARING THE TENANT'S BOT, AND WHETHER IT TRADES: the
 * dashboard's half of plan §3.1, published beside the code on the same clock
 * by the same writer (orchestrator.ts publishChildTelegram).
 *
 * The dashboard used to say "connected" whenever getMe accepted the token,
 * and show whatever code this table last held. In the incident behind these
 * columns nothing had polled the bot for days: its worker was held back by a
 * practice book that would not restore, then a second login took the bot. The
 * page showed "connected" and a frozen code throughout, and the owner kept
 * sending that code into a bot nobody was reading.
 *
 * - `bot_id`: the bot the code in `link_code` was minted for (the numeric id
 *   before the ':' in its token, never the token), while the tenant's process
 *   is still handed that bot's token (livenessFor). The web shows the code
 *   only when this matches the token the owner has saved; a code for the old
 *   bot would not link the new one.
 * - `poll_ok_at`, `poll_err`, `poll_err_at`: when a getUpdates last worked,
 *   and the last one that failed and why (telegram/state.ts PollHealth). Null
 *   when they are about another bot, or nothing has polled yet.
 * - `child_state`: `trading`, or `held:<class>` while the tenant's practice
 *   book will not restore (restore-block.ts). The class is the figure-free
 *   phrase an owner is told anyway; never the restore's own reason. Published
 *   for a held tenant with no bot too (publishTenantChildState): the
 *   dashboard is the only place such an owner can be told.
 *
 * Added with ALTERs, like hold_notified, because every deployment already has
 * the table. On Postgres, Db.exec runs them through translateSchema (db.ts),
 * so they are `ADD COLUMN IF NOT EXISTS` and the times are BIGINT, like the
 * table's own. `poll_err_at` is one more than the plan named: without it, the
 * last failure could not be told from the current one, and a single 409 at a
 * redeploy handover would read as another program on the bot for ever.
 */
export const TELEGRAM_LIVENESS_DDL: readonly string[] = [
  "ALTER TABLE tenant_telegram ADD COLUMN bot_id TEXT",
  "ALTER TABLE tenant_telegram ADD COLUMN poll_ok_at INTEGER",
  "ALTER TABLE tenant_telegram ADD COLUMN poll_err TEXT",
  "ALTER TABLE tenant_telegram ADD COLUMN poll_err_at INTEGER",
  "ALTER TABLE tenant_telegram ADD COLUMN child_state TEXT",
];

/**
 * EVERYTHING THE ORCHESTRATOR NEEDS OF tenant_telegram, IN ONE PLACE: the
 * table, then hold_notified, then the liveness columns. The mirror pass runs
 * it on its own clock and sendHoldNotice runs it before a notice
 * (orchestrator.ts), and telegram-fix.postgres.test.ts races it, so the
 * sequence a boot issues is the sequence that is tested.
 *
 * The CREATE throws, as it always has: without the table nothing here works.
 * Each ALTER is tried on its own, and one that fails is returned, not thrown.
 * On sqlite ADD COLUMN has no IF NOT EXISTS, so every run after the first
 * fails on every ALTER, which is expected. On Postgres, Db.exec makes each one
 * `ADD COLUMN IF NOT EXISTS`, so a failure there is a real one, and a caller
 * that can say so (the Postgres suite) checks that there were none.
 */
export async function ensureTelegramSchema(db: Db): Promise<unknown[]> {
  await db.exec(TELEGRAM_STATE_DDL);
  const failed: unknown[] = [];
  for (const ddl of [TELEGRAM_HOLD_NOTIFIED_DDL, ...TELEGRAM_LIVENESS_DDL]) {
    try {
      await db.exec(ddl);
    } catch (e) {
      failed.push(e);
    }
  }
  return failed;
}

export interface TenantTelegramLiveness {
  botId: string | null;
  pollOkAt: number | null;
  pollErr: string | null;
  pollErrAt: number | null;
  childState: string | null;
}

/**
 * WHAT THE LIVENESS COLUMNS SAY FOR ONE TENANT: from its telegram.json (`tg`,
 * as orchestrator.ts readChildTelegram parsed it), the bot of the token in the
 * settings its process was handed (`handedBot`, null when it was handed
 * none), and whether it trades.
 *
 * `bot_id` ONLY WHILE THE PROCESS STILL HAS THAT BOT'S TOKEN. telegram.json,
 * and the code in it, outlive the token. A tenant whose bot was moved to
 * another tenant's claim (claimGate strips the token from what its process is
 * handed; the owner's stored copy stays) keeps a file that names the bot and
 * a code for it, and published with its bot the dashboard would show that
 * code as the bot's: live for three minutes, then "works once your bot is
 * heard again", which it never will. The bot answers to the other tenant's
 * code by then, and five sends of this one lock the owner's chat out there.
 * That is how the incident behind these columns ended. Null instead, and the
 * web shows no code.
 *
 * The poll record only when it is about that same bot: a record about the
 * bot before a change says nothing about this one, and the dashboard must not
 * call a new bot live on the strength of the old one's polls.
 */
export function livenessFor(
  tg: { botId: string | null; poll: PollHealth | null },
  handedBot: string | null,
  childState: string,
): TenantTelegramLiveness {
  const botId = tg.botId !== null && tg.botId === handedBot ? tg.botId : null;
  const poll = botId !== null && tg.poll !== null && tg.poll.botId === botId ? tg.poll : null;
  return {
    botId,
    pollOkAt: poll?.okAt ?? null,
    pollErr: poll?.err ?? null,
    pollErrAt: poll?.errAt ?? null,
    childState,
  };
}

/**
 * Publish the liveness columns for a tenant whose row publishTenantTelegram
 * has just written. See publishTelegramRuntime for why it is a statement of
 * its own.
 */
export async function publishTelegramLiveness(db: Db, tenant: string, l: TenantTelegramLiveness): Promise<void> {
  await db
    .prepare(
      `UPDATE tenant_telegram SET bot_id = ?, poll_ok_at = ?, poll_err = ?, poll_err_at = ?, child_state = ?
       WHERE tenant = ?`,
    )
    .run(l.botId, l.pollOkAt, l.pollErr, l.pollErrAt, l.childState, tenant.toLowerCase());
}

/**
 * PUBLISH ONE TENANT'S ROW: the code and the owner, then the liveness
 * columns, in two statements.
 *
 * The first throws as it always did. The second's failure is RETURNED, not
 * thrown: if these columns are missing (an ALTER that could not run), the
 * code and the owner must still be published, and they would not be if one
 * statement carried both. The web reads a row without them the old way
 * (web lib/telegram-runtime.ts TELEGRAM_RUNTIME_LEGACY_SQL).
 */
export async function publishTelegramRuntime(
  db: Db,
  tenant: string,
  state: TenantTelegram,
  liveness: TenantTelegramLiveness,
): Promise<Error | null> {
  await publishTenantTelegram(db, tenant, state);
  try {
    await publishTelegramLiveness(db, tenant, liveness);
    return null;
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
}

/**
 * WHETHER THE TENANT TRADES, FOR ONE WITH NO BOT FILE TO PUBLISH: no bot
 * saved, or none its process has written a telegram.json for.
 *
 * A held tenant is the one this is for. Its owner gets no hold reply and no
 * direct message, both of which go over the bot, so the dashboard is the only
 * place they can learn that nothing trades. So a hold makes the row if there
 * is none, with no code and no owner in it. Such a row is no link to anyone
 * who reads links: readTenantTelegram gives null for it, as for no row, so it
 * restores nothing, names no recipient, and the MCP tool does not call its
 * owner "linked once, then unlinked". Trading only puts back a hold this
 * wrote, so a tenant that never had a bot or a hold gets no row.
 */
export async function publishTenantChildState(db: Db, tenant: string, childState: string): Promise<void> {
  const lc = tenant.toLowerCase();
  if (childState.startsWith("held:")) {
    await db
      .prepare(
        `INSERT INTO tenant_telegram (tenant, child_state, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (tenant) DO UPDATE SET child_state = excluded.child_state`,
      )
      .run(lc, childState, Math.floor(Date.now() / 1000));
    return;
  }
  await db
    .prepare("UPDATE tenant_telegram SET child_state = ? WHERE tenant = ? AND child_state IS NOT NULL AND child_state <> ?")
    .run(childState, lc, childState);
}
