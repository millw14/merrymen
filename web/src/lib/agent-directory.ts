/** Public agent identities and lifecycle only; no book, trade or settings reads. */
import type { Db } from "../../../worker/src/db";
import { readPerpsWallets } from "../../../worker/src/perps-wallets";
import { getIdentityStore } from "@merrymen/identity-store";
import { withReadDb } from "./ledger";
import { inIncidentWindow, isRetired, notRunning as heldNotRunning, type AgentLifecycle } from "./retired-agent";
import { discoveryTiming, type DiscoveryMeasure, type DiscoveryTiming } from "./discovery-timing";

/** Shared with the full ranking so re-grants, recovery holds and retirement cannot drift. */
export async function readDirectorySelection(
  db: Db,
  identities = () => getIdentityStore().all(),
  nowSec = () => Math.floor(Date.now() / 1000),
  measure: DiscoveryMeasure = (_stage, read) => read(),
) {
  const slugFor = new Map<string, string>();
  const tenantFor = new Map<string, `0x${string}`>();
  // Whether the slugs were READ. Without them every row looks unlinked, and
  // the fold below retires an unlinked row that has not beaten in a day — so
  // a named agent with a good key would leave the board through a quiet
  // worker, and the count of it would be built from data nobody read.
  let slugsRead = false;
  try {
    for (const id of await measure("identities", identities)) {
      for (const a of id.accounts) {
        slugFor.set(a.toLowerCase(), id.slug);
        tenantFor.set(a.toLowerCase(), id.tenant);
      }
    }
    slugsRead = true;
  } catch {
    /* rows render unlinked, and nothing is folded — see below */
  }

  let rows: {
    smart_account: string;
    name: string;
    x_handle: string | null;
    x_verified: number | null;
    epoch: number;
    mode: string;
  }[] = [];
  try {
    // Aliases of one address describe one account, whose epoch and heartbeat
    // identify the current run. Only after choosing that run may registration
    // time choose among an identity's different accounts after a re-grant.
    let beat = "COALESCE(NULL, 0)";
    try {
      await measure("heartbeat", () => db.prepare("SELECT beat_at FROM agents WHERE 1 = 0").all());
      beat = "COALESCE(beat_at, 0)";
    } catch { /* older ledgers have no heartbeat column */ }
    rows = (await measure("registrations", () => db
      .prepare(
        `WITH registrations AS (
           SELECT smart_account, name, x_handle, COALESCE(x_verified, 0) AS x_verified,
                  COALESCE(epoch, 1) AS epoch, COALESCE(mode, 'idle') AS mode, created_at,
                  ROW_NUMBER() OVER (
                    PARTITION BY LOWER(smart_account)
                    ORDER BY COALESCE(epoch, 1) DESC, ${beat} DESC, created_at DESC, smart_account ASC
                  ) AS alias_rank
             FROM agents WHERE smart_account NOT LIKE 'rh:%'
         )
         SELECT smart_account, name, x_handle, x_verified, epoch, mode
           FROM registrations WHERE alias_rank = 1
          ORDER BY created_at DESC, LOWER(smart_account) ASC`,
      )
      .all())) as typeof rows;
  } catch {
    // A failed selection is unread, including an older schema. It must not
    // become a successful empty directory or claim that nobody is here.
    return null;
  }

  // NEVER A PERPS WALLET'S AGENT (docs/perps.md rule 17; perps-wallets.ts):
  // the orchestrator records every Perps wallet before its worker first runs,
  // and its agents row is left off the board, the directory and every count
  // made from them. A record that cannot be read leaves the board unread
  // rather than risk listing one.
  try {
    const perps = await measure("perps-wallets", () => readPerpsWallets(db));
    if (perps.size) rows = rows.filter((r) => !perps.has(r.smart_account.toLowerCase()));
  } catch {
    return null;
  }

  // One row per public identity after a re-grant; the newest account wins.
  const seen = new Set<string>();
  rows = rows.filter(r => { const key = slugFor.get(r.smart_account.toLowerCase()) ?? r.smart_account.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; });

  // RETIRED ACCOUNTS BECOME A COUNT, NOT A ROW EACH. Applied AFTER the slug
  // dedupe, so an identity's older key is one agent re-granted, not a second
  // retired one — for the keys the identity store holds. A key from before
  // the store existed is linked to no slug, so it is folded and counted
  // beside the agent it belonged to, which is why the figure is accounts.
  //
  // Read separately and defensively, for the reason `contributions_known`
  // below is: folding these columns into the SELECT above would turn a ledger
  // that lacks one into an EMPTY BOARD. Here a failed read lists everyone, as
  // before, and reports the count as unknown rather than as zero.
  //
  // AND ONLY WITH THE SLUGS IN HAND. An unread identity store lists everyone
  // the same way. Killed and expired rows could be folded without a slug but
  // not counted: the dedupe above could not collapse an identity's keys
  // either, so its old ones would be counted as agents of their own. And a
  // fold with no count is rows leaving the board without a word.
  let retired: number | null = null;
  let folded: typeof rows = [];
  // Rows the recovery hold kept on the board that nothing is running.
  const notRunning = new Set<string>();
  if (slugsRead) try {
    type Lifecycle = { mode: string | null; status: string | null; beat_at: number | null; expires_at: number | null };
    const life = new Map<string, Lifecycle>();
    // beat_at IN SECONDS, normalised on its own row: the ledger holds both
    // units, and the incident window is judged against each account's own
    // beat. Never against a MAX over the fleet — one millisecond stamp in it
    // would move every other agent's verdict.
    for (const l of (await measure("lifecycle", () => db
      .prepare(
        `SELECT smart_account, mode, status,
                CASE WHEN beat_at > 1e12 THEN beat_at / 1000 ELSE beat_at END AS beat_at,
                expires_at
           FROM agents WHERE smart_account NOT LIKE 'rh:%'`,
      )
      .all())) as (Lifecycle & { smart_account: string })[]) {
      life.set(l.smart_account, l);
    }
    // THE ACCOUNT'S OWN HOLD ROW, keyed by the tenant that owns it as well
    // as the account, so one tenant's row never speaks for another's agent.
    // Read on its own and defensively: a self-hosted or older ledger has no
    // such table, and a read that fails for any reason is no hold rather
    // than no board — the beat window below still speaks for each account.
    // And only a hold recorded inside the incident window: a later one is
    // the owner's report, not the board's — see inIncidentWindow.
    const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    const held = new Set<string>();
    try {
      for (const h of (await measure("holds", () => db
        .prepare(`SELECT tenant, smart_account, since_at FROM fleet_recovery_health WHERE held = 1`)
        .all())) as { tenant: unknown; smart_account: unknown; since_at: unknown }[]) {
        if (!inIncidentWindow(num(h.since_at))) continue;
        held.add(`${String(h.tenant).toLowerCase()} ${String(h.smart_account).toLowerCase()}`);
      }
    } catch {
      /* no recovery table: nothing is held */
    }
    const now = nowSec();
    const before = rows.length;
    rows = rows.filter((r) => {
      const l = life.get(r.smart_account);
      const account = r.smart_account.toLowerCase();
      const tenant = tenantFor.get(account);
      const lifecycle: AgentLifecycle = {
        slug: slugFor.get(account) ?? null,
        // RAW, not the COALESCEd `r.mode` above: that reads a newborn that
        // has never beaten as idle, and would retire it before its first tick.
        mode: l?.mode ?? null,
        status: l?.status ?? null,
        beatAt: num(l?.beat_at),
        expiresAt: num(l?.expires_at),
        held: tenant !== undefined && held.has(`${tenant.toLowerCase()} ${account}`),
      };
      if (isRetired(lifecycle, now)) { folded.push(r); return false; }
      if (heldNotRunning(lifecycle, now)) notRunning.add(r.smart_account);
      return true;
    });
    retired = before - rows.length;
  } catch {
    /* lifecycle columns arrive with worker migrations; unknown until they do */
    folded = [];
  }

  return { rows, slugFor, tenantFor, retired, folded, notRunning };
}

export interface AgentDirectoryRow {
  slug: string | null;
  name: string;
  handle: string | null;
  handleVerified: boolean;
  mode: string;
  notRunning: boolean;
  pnlBps: null;
  paperPnlBps: null;
  maxDdBps: null;
  landed: null;
  filledPaper: null;
  refused: null;
  unrankedWhy: "not-read";
}
export interface AgentDirectory {
  source: "sqlite" | "none";
  directory: true;
  /** Epoch milliseconds when this selection completed, not a valuation time. */
  fetchedAt: number;
  agents: AgentDirectoryRow[];
  retired: number | null;
}

/** The directory does not await historical performance just to make an agent findable. */
export async function readAgentDirectory(
  readDb = withReadDb,
  identities = () => getIdentityStore().all(),
  nowSec = () => Math.floor(Date.now() / 1000),
  timing: DiscoveryTiming = discoveryTiming,
): Promise<AgentDirectory> {
  // Stop acquisition timing at callback entry, before any directory query.
  // A pending-stage log also survives an HTTP caller giving up before the read does.
  const opened = timing.start("read-db");
  try {
    return await readDb(async (db) => {
      opened("ok");
      const selected = db ? await readDirectorySelection(db, identities, nowSec, timing.measure) : null;
      return {
        source: selected ? "sqlite" : "none",
        directory: true,
        fetchedAt: nowSec() * 1000,
        retired: selected?.retired ?? null,
        agents: selected ? selected.rows.map((r) => ({
          slug: selected.slugFor.get(r.smart_account.toLowerCase()) ?? null,
          name: String(r.name ?? "Agent"),
          handle: (r.x_handle ?? "").trim() || null,
          handleVerified: Number(r.x_verified ?? 0) !== 0,
          mode: r.mode,
          notRunning: selected.notRunning.has(r.smart_account),
          pnlBps: null, paperPnlBps: null, maxDdBps: null,
          landed: null, filledPaper: null, refused: null,
          unrankedWhy: "not-read",
        })) : [],
      };
    });
  } catch (error) {
    opened("error");
    throw error;
  }
}
