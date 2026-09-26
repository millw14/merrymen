/**
 * WHAT A KILLED CHILD LEAVES BEHIND, CARRIED UP BEFORE ITS HOME IS DELETED.
 *
 * reconcile()'s kill-switch branch stands a child down and deletes its home.
 * The home holds the child's private sqlite ledger, which reaches the shared
 * database only through mirrorLedgers(). That runs AFTER reconcile() on every
 * pass. So anything the child wrote since the previous pass's mirror was
 * deleted without being copied: up to one pass of trades, decisions and
 * events. For a hosted Telegram /kill that includes the child's own record of
 * the kill ("Telegram: KILL by chat …", "KILL SWITCH — …").
 *
 * A kill from the web (DELETE /api/grants) is not recorded by the child at
 * all. The worker writes its KILL SWITCH event and the 'killed' status when a
 * tick finds grant.json gone (index.ts syncGrant). The orchestrator stands it
 * down on the pass after the store row goes, before any tick can see that.
 * Only the orchestrator knows it happened.
 *
 * The result: the web tier's inactivity diagnosis found no kill event and no
 * 'killed' row, and told the owner "No trading permission has been signed
 * yet" about an agent they had just switched off.
 *
 * So before the home goes, the stand-down does three things:
 *   1. one last mirror, through the same mirrorTenant the mirror pass uses;
 *   2. the agents row set to 'killed', as the worker's own kill path sets it;
 *   3. a KILL SWITCH event, unless the child already wrote one since it was
 *      spawned. The mirror runs first, so a kill event the child wrote is
 *      already in the shared table when that is checked.
 *
 * Each step is independent and none throws. The stand-down itself (SIGTERM,
 * the home deleted, the lease released) never waits on any of them succeeding.
 *
 * A tenant can also be killed while NO child is running: between a crash and
 * its restart, or in the give-up cool-off. Its home is still on disk. The same
 * three steps apply, with the account read from the home (lastRunOnDisk).
 */
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { getAddress, isAddress } from "viem";
import type { Db } from "./db";
import { readKillRequest } from "./kill-request";
import { mirrorTenant, openChildLedger, type MirrorReport } from "./ledger-mirror";

/**
 * The event the orchestrator writes for a kill the child never recorded.
 *
 * It starts with "KILL SWITCH" because that prefix is what the readers match:
 * the inactivity diagnosis (web/src/lib/services/inactivity.ts) and the
 * risk_halt alert (worker/src/mcp/notify.ts).
 */
export const STAND_DOWN_EVENT =
  "KILL SWITCH — grant removed; the hosted worker was stood down and its session key discarded";

export interface StandDownRecord {
  /** The last mirror's report. Null when the child's ledger could not be opened. */
  mirror: MirrorReport | null;
  /** Set when the last mirror threw. mirrorTenant is written not to. */
  mirrorError?: string;
  /** Rows the 'killed' update changed. 0 when the account has no shared agents row yet. */
  marked: number;
  /**
   * `written`: this call wrote the KILL SWITCH event. `already`: the child's
   * own event for this run is in the shared table. `failed`: the status and
   * event write rolled back; see `recordError`.
   */
  event: "written" | "already" | "failed";
  recordError?: string;
}

/**
 * The account as written, lowercased and EIP-55 checksummed.
 *
 * Neither `agents.smart_account` nor `events.agent_id` has one agreed spelling
 * (the mirror's duplicate probe asks for all three for the same reason). An IN
 * list over the plain column keeps both lookups on their indexes.
 */
function spellings(account: string): [string, string, string] {
  const lower = account.toLowerCase();
  return [account, lower, isAddress(lower, { strict: false }) ? getAddress(lower) : lower];
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * WHOSE RUN A HOME HOLDS, AND SINCE WHEN, for a killed tenant with no child
 * running. There is no Child to ask, so the home is read.
 *
 * grant.json first. The orchestrator writes it on every spawn and every
 * re-sign. A child writes its own KILL SWITCH only once it has no armable
 * grant (index.ts syncGrant), and while a kill is pending nothing writes the
 * file back. So the file is no newer than a kill event this grant's run
 * wrote, and newer than any an earlier grant's run wrote. Its mtime is the
 * `since` a running child's `startedAt` would have given.
 *
 * Then a pending Telegram kill request. The child deleted grant.json when it
 * left the request, and the request names the account. The child's own KILL
 * SWITCH comes after it.
 *
 * Neither: nothing on disk names the account, and the kill cannot be recorded.
 */
export function lastRunOnDisk(home: string, nowSec: number): { smartAccount: string | null; since: number } {
  const file = path.join(home, "grant.json");
  try {
    const grant = JSON.parse(readFileSync(file, "utf8")) as { smartAccount?: unknown };
    if (typeof grant.smartAccount === "string" && ADDRESS.test(grant.smartAccount)) {
      return { smartAccount: grant.smartAccount, since: Math.floor(statSync(file).mtimeMs / 1000) };
    }
  } catch {
    // No grant.json, or not a grant: a Telegram kill may name the account instead.
  }
  const request = readKillRequest(home, nowSec);
  if (request && request !== "unreadable" && request.smartAccount && ADDRESS.test(request.smartAccount)) {
    return { smartAccount: request.smartAccount, since: request.killedAt };
  }
  return { smartAccount: null, since: nowSec };
}

export async function recordStandDown(args: {
  tenant: string;
  /** The child's home, which the caller deletes once this returns. */
  home: string;
  /**
   * The smart account the child was trading from (agent_id in every ledger
   * table). Null when nothing names it: the last mirror still runs, and the
   * kill is reported as not recorded.
   */
  smartAccount: string | null;
  /** When this child was spawned, unix seconds. A kill event at or after it is this run's. */
  since: number;
  shared: Db;
  /**
   * False skips the last mirror. The caller passes it for a home this replica
   * did not hold the lease over while its child ran. Another replica may have
   * run the tenant since, and `positions` and `cost_basis` mirror as
   * delete-then-insert snapshots, so a stale copy would overwrite live rows.
   */
  lastMirror?: boolean;
  nowSec?: number;
}): Promise<StandDownRecord> {
  const nowSec = args.nowSec ?? Math.floor(Date.now() / 1000);
  const out: StandDownRecord = { mirror: null, marked: 0, event: "failed" };

  // 1. THE LAST MIRROR. The child has been signalled already, so this reads
  // its ledger as it finally stood.
  const handle = args.lastMirror === false ? null : openChildLedger(args.home);
  if (handle) {
    try {
      out.mirror = await mirrorTenant({ tenant: args.tenant, child: handle.db, shared: args.shared });
    } catch (e) {
      out.mirrorError = message(e);
    } finally {
      handle.close();
    }
  }

  if (!args.smartAccount) {
    out.recordError = "nothing in the home names the smart account (no grant.json, no kill request)";
    return out;
  }
  const smartAccount = args.smartAccount;

  // 2 + 3. THE KILL ITSELF, in one transaction: a 'killed' row without its
  // event, or the event without the row, would each tell half the story.
  const ids = spellings(smartAccount);
  try {
    await args.shared.tx(async (db) => {
      const r = await db
        .prepare(`UPDATE agents SET status = 'killed' WHERE smart_account IN (?, ?, ?)`)
        .run(...ids);
      out.marked = Number(r.changes ?? 0);
      const had = await db
        .prepare(
          `SELECT 1 AS ok FROM events
            WHERE agent_id IN (?, ?, ?) AND created_at >= ? AND message LIKE 'KILL SWITCH%'
            LIMIT 1`,
        )
        .get(...ids, args.since);
      if (had) {
        out.event = "already";
        return;
      }
      // One event per kill: the risk_halt alert fires once per KILL SWITCH row.
      await db
        .prepare(`INSERT INTO events (agent_id, level, message, created_at) VALUES (?, 'warn', ?, ?)`)
        .run(smartAccount, STAND_DOWN_EVENT, nowSec);
      out.event = "written";
    });
  } catch (e) {
    out.marked = 0;
    out.event = "failed";
    out.recordError = message(e);
  }
  return out;
}
