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
 *   before the ':' in its token, never the token). The web shows the code only
 *   when this matches the token the owner has saved; a code for the old bot
 *   would not link the new one.
 * - `poll_ok_at`, `poll_err`, `poll_err_at`: when a getUpdates last worked,
 *   and the last one that failed and why (telegram/state.ts PollHealth). Null
 *   when they are about another bot, or nothing has polled yet.
 * - `child_state`: `trading`, or `held:<class>` while the tenant's practice
 *   book will not restore (restore-block.ts). The class is the figure-free
 *   phrase an owner is told anyway; never the restore's own reason.
 *
 * Added with ALTERs, like hold_notified, because every deployment already has
 * the table. `poll_err_at` is one more than the plan named: without it, the
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

export interface TenantTelegramLiveness {
  botId: string | null;
  pollOkAt: number | null;
  pollErr: string | null;
  pollErrAt: number | null;
  childState: string | null;
}

/**
 * Publish the liveness columns for a tenant whose row publishTenantTelegram
 * has just written. A separate statement on purpose: if these columns are
 * missing (the ALTERs could not run), the code and the owner above must still
 * be published, and they would not be if one INSERT carried both.
 */
export async function publishTelegramLiveness(db: Db, tenant: string, l: TenantTelegramLiveness): Promise<void> {
  await db
    .prepare(
      `UPDATE tenant_telegram SET bot_id = ?, poll_ok_at = ?, poll_err = ?, poll_err_at = ?, child_state = ?
       WHERE tenant = ?`,
    )
    .run(l.botId, l.pollOkAt, l.pollErr, l.pollErrAt, l.childState, tenant.toLowerCase());
}
