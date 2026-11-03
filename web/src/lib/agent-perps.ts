/**
 * THE PERPS WALLET'S BOOK, AS ITS WORKER REPORTED IT — read, never computed
 * (docs/perps.md "Surfaces": `agents.perps` is the worker's status report the
 * web only reads).
 *
 * The Perps wallet's worker is the one process that runs its book (on paper in
 * this build), so it is the only one that knows what is open, at what mark,
 * how far from liquidation and whether it could look at all. It writes that to
 * `agents.perps` on its own account's row (a JSON string of core PerpsReport;
 * store.ts setAgentPerps) and, hosted, the ledger mirror carries it up. This
 * reads it back for GET /api/grants?wallet=perps.
 *
 * A SECOND ANSWER COMPUTED HERE WOULD EVENTUALLY DISAGREE WITH THE FIRST — the
 * agent-energy.ts reasoning, and more so: the web never reads an account's
 * positions itself.
 *
 * NULL IS "NOT SAID", NEVER "NOTHING" (rule 11). No row, no column, a value
 * that is not exactly the v1 shape, a read that throws — all of them are null
 * from readAgentPerps, and every surface renders null as "the book could not
 * be read", never as an empty book. parsePerpsReport is the whitelist: a
 * report with one malformed position is refused whole, because a book with a
 * leveraged position quietly missing is the "No positions" the mobile banner
 * exists to prevent, and every field the v1 shape does not name is dropped, so
 * no key of any kind can ride a report out. readAgentPerpsRead keeps the finer
 * answer — not said vs unreadable — for the desk, which draws the two
 * differently.
 *
 * THE PERPS WALLET'S LEDGER, ALWAYS. Hosted both wallets' rows sit in the one
 * shared Postgres, told apart by the account; self-hosted the Perps worker
 * writes its own home's merrymen.db (ledger.ts withReadDb), and a Perps read
 * never opens the Spot one. Ported from the perps branch (112dbeb6) with its
 * live readers left out: there is no venue key, stand-down or recovery notice
 * in this build.
 *
 * Server-only: it opens the ledger.
 */
import { parsePerpsReport, type GrantPurpose, type PerpsReport } from "@merrymen/core";
import type { Db } from "../../../worker/src/db";
import { withReadDb } from "./ledger";

/** The ledger seam, so a test can hand it a stub database. Whose ledger is named, as withReadDb takes it. */
export type ReadDb = <T>(fn: (db: Db | null) => Promise<T>, wallet: GrantPurpose) => Promise<T>;

/**
 * What a read of `agents.perps` found:
 *   not-said    no ledger, no row, no column, or a NULL column: the worker has
 *               not reported
 *   unreadable  a value that is not the v1 shape, or a read that failed
 *   ok          parsed by core's whitelist parser
 */
export type PerpsReportRead =
  | { state: "not-said" }
  | { state: "unreadable" }
  | {
      state: "ok";
      report: PerpsReport;
      /**
       * The account's own book, from the same agents row: `agents.mode`, the
       * worker's heartbeat ("paper" | "live" | "idle"), or null when it cannot
       * be read. The report's `mode` is the perps RAIL and says "off" while a
       * practice position is still held; this is what says it is practice.
       */
      accountMode: string | null;
    };

/**
 * A ledger written before the column existed answers "no such column" (sqlite)
 * or "column … does not exist" (Postgres). That ledger's worker has never said
 * anything about perps, which is not the same as having said something we
 * cannot read.
 */
const MISSING_COLUMN_RE = /no such column|column .* does not exist/i;

/** The report, from a database the caller already holds open. */
export async function readAgentPerpsFrom(db: Db | null, account: string | null | undefined): Promise<PerpsReportRead> {
  if (!account || !db) return { state: "not-said" };
  let row: { perps?: unknown } | undefined;
  try {
    row = (await db.prepare("SELECT perps FROM agents WHERE smart_account = ?").get(account)) as
      | { perps?: unknown }
      | undefined;
  } catch (e) {
    return MISSING_COLUMN_RE.test(e instanceof Error ? e.message : String(e)) ? { state: "not-said" } : { state: "unreadable" };
  }
  // Absent row and NULL column are the same answer: the worker has not said.
  const raw = row?.perps;
  if (raw === undefined || raw === null) return { state: "not-said" };
  // The column is TEXT; a driver that hands JSON back already parsed is taken as it is.
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      return { state: "unreadable" };
    }
  }
  const report = parsePerpsReport(value);
  if (report === null) return { state: "unreadable" };
  return { state: "ok", report, accountMode: await readAccountMode(db, account) };
}

/**
 * THE ACCOUNT'S OWN BOOK — `agents.mode` — from the same row, in its own
 * query, so a ledger without the column (or a driver that refuses it) costs
 * only this answer — null, "not said", which no reader turns into "real" —
 * never the report beside it.
 */
async function readAccountMode(db: Db, account: string): Promise<string | null> {
  try {
    const row = (await db.prepare("SELECT mode FROM agents WHERE smart_account = ?").get(account)) as
      | { mode?: unknown }
      | undefined;
    return typeof row?.mode === "string" ? row.mode : null;
  } catch {
    return null;
  }
}

/** The same, opening the Perps wallet's ledger through the read seam. Never throws. */
export async function readAgentPerpsRead(
  account: string | null | undefined,
  readDb: ReadDb = withReadDb,
): Promise<PerpsReportRead> {
  if (!account) return { state: "not-said" };
  try {
    return await readDb((db) => readAgentPerpsFrom(db, account), "perps");
  } catch {
    // An unreadable ledger is "we cannot see it" — never a guess, never empty.
    return { state: "unreadable" };
  }
}

/**
 * The report, or null (= not said or unreadable) — the shape GET
 * /api/grants?wallet=perps carries, the agent-energy.ts precedent.
 */
export async function readAgentPerps(
  account: string | null | undefined,
  readDb: ReadDb = withReadDb,
): Promise<PerpsReport | null> {
  const read = await readAgentPerpsRead(account, readDb);
  return read.state === "ok" ? read.report : null;
}
