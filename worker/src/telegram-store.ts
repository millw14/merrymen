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
