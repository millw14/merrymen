/**
 * EACH CAPITAL FLOW ONCE, AND NONE WHEN THE ROWS DISAGREE.
 *
 * Net contributions are what every return is divided by, and `flows` has no
 * key that can stop a movement being written twice. The identity index
 * (`flows_chain_identity`) treats a NULL chain as distinct, so a row written
 * before the chain was stamped sits beside its stamped copy. Rows with no tx
 * have no identity at all: the mirror rewound its cursor onto a rebuilt child
 * and copied them up again (the canary's 10 USDG opening balance sat in
 * Postgres three times). And one transfer home can be booked more than once
 * by bookers that cannot see each other: the executor writes 'transfer-intent'
 * with its tx and no log index; the resolver, which asks only its own child
 * ledger under one spelling whether the tx is booked (hasFlowForTx), books it
 * again from its receipt as 'transfer-intent' WITH the log index; and a
 * deposit scan that no longer has the trade row to skip books it as
 * 'chain-log', from its log.
 *
 * Summing those rows publishes the owner's own money as a loss or a gain. So
 * every web reader that turns rows into a contribution figure collapses them
 * here first, by what makes two rows the same movement:
 *
 *   CHAIN LOGS — a tx and a log index, carry excepted — are one movement per
 *   (chain, tx, log index). The chain is the row's own, or the account's
 *   registered chain when the row has none: that is how a NULL-chain twin
 *   meets its stamped copy, and it is the same rule the migration that
 *   stamps old rows uses. A tx hash is unique only within a chain, so the
 *   same tx#log on chain 1 and on 4663 stays two. Copies of one log must
 *   agree on direction and amount.
 *
 *   EPOCH CARRIES are one per (epoch, direction, amount). An epoch opens once
 *   and carries one balance, so two carries that DIFFER cannot both be true.
 *
 *   THE EXECUTOR'S INTENTS — 'transfer-intent' with a tx and no log index —
 *   are one movement per (chain, tx, direction): the executor books one per
 *   transfer it signed, so two are copies, whatever account spelling or chain
 *   stamp each was filed under. The chain is placed as a log's is, and copies
 *   of one intent must agree on amount.
 *
 *   EVERYTHING ELSE — inferred rows, legacy rows — has nothing that names it.
 *   Two such rows collapse only when they are byte-identical copies (every
 *   column but the row id): the mirror carries every column, so its copies are
 *   exact, and two deposits of the same amount in different transactions are
 *   two deposits.
 *
 * AND THEN IT REFUSES, rather than picking one. Rows that cannot all be true
 * make the figure UNAVAILABLE:
 *
 *   - two different carries in one epoch, copies of one log or of one intent
 *     that disagree, or a chain log whose chain cannot be named: "Unread
 *     capital accounting";
 *   - two movements on one tx and direction, either of them a transfer intent
 *     or a row with no log index of its own. Only distinct logs of one tx —
 *     two legs, each named by its own log index — are two movements on their
 *     own say-so. Anything else is one transfer booked two ways: the intent is
 *     what was ASKED for and the log is what moved, or a legacy row with no
 *     log index sits beside the log it was. Nothing here can say which is
 *     right, so they are never summed and never collapsed: "Contributions under
 *     review". Judged over EVERY copy of each movement, not only the one that
 *     speaks for it, so the verdict cannot turn on which booker wrote first.
 *
 * Every contradiction is judged over the whole run, before any valuation
 * cutoff, because a copy can be booked later than its original and a cutoff
 * between them would hide the pair.
 *
 * READ ONLY. Nothing here writes or repairs: the rows stay as they are, and
 * the readers stop publishing them. `flowDuplicateReport` is the same read as a
 * count, for an operator or an admission gate that must refuse while any copy
 * is on record — the worker's own sums (getNetContributionsUsdg, the bootstrap
 * anchor) still add rows and do not read through this.
 *
 * In TypeScript rather than SQL, over one indexed read of one account's run:
 * the rules are group comparisons ("two carries that differ", "an intent beside
 * a log"), a run holds a handful of rows, and the same plain SELECT runs on both
 * backends.
 */
import type { Db } from "./db";

/** One `flows` row as read. */
export interface FlowRecord {
  id: number;
  agentId: string;
  direction: "in" | "out";
  amountUsdg: number;
  txHash: string | null;
  blockNumber: number | null;
  logIndex: number | null;
  source: string;
  chainId: number | null;
  at: number;
}

/** What the collapse found, in rows. Counts only: no amount, no hash. */
export interface FlowDuplicates {
  /** Rows on record for the run. */
  rows: number;
  /** Movements left once copies are collapsed. */
  distinct: number;
  /** Rows collapsed into another as a copy of the same movement, by why. */
  copies: {
    /** The same chain log, each copy stamped with the same chain. */
    log: number;
    /** The same chain log, one copy with no chain stamp (read as the account's chain). */
    nullChain: number;
    /** The same carry: same direction and amount in the epoch. */
    carry: number;
    /**
     * The same executor intent (one tx and direction, no log index), filed
     * under another spelling of the account or another chain stamp.
     */
    intent: number;
    /** A byte-identical copy of a row with no log identity (inferred, legacy). */
    identical: number;
  };
  /** Rows that cannot all be true. Any of these withholds the figure. */
  conflicts: {
    /** Carries beyond the first that differ from it in direction or amount. */
    carries: number;
    /** Copies of one chain log that disagree with it on direction or amount. */
    logs: number;
    /** Chain logs with no chain stamp, on an account whose chain cannot be read. */
    unresolvedChain: number;
    /** Copies of one executor intent that disagree with it on amount. */
    intents: number;
    /**
     * Movements beyond the first on one tx and direction, where any copy of
     * any of them is a transfer intent or has no log index of its own: one
     * transfer booked two ways. Two distinct logs of one tx are not counted.
     */
    txTwins: number;
  };
}

/** Why a run's flows are withheld: unread, or a booking that needs review. */
export type FlowVerdict = "ok" | "unread" | "review";

export interface CollapsedFlows {
  /** One row per movement — the earliest copy, oldest first. */
  flows: FlowRecord[];
  duplicates: FlowDuplicates;
  verdict: FlowVerdict;
}

/**
 * THROWN BY readDistinctFlows when the run's flows cannot be summed.
 *
 * Its own class so a reader can say which: "unread" is a figure nobody can
 * read, "review" is a figure that would be one of two bookings and is withheld
 * until somebody says which. Either way the figure is UNAVAILABLE — never zero,
 * never one of the two.
 */
export class CapitalFlowsWithheld extends Error {
  constructor(readonly verdict: "unread" | "review") {
    super(verdict === "review" ? "Contributions under review" : "Unread capital accounting");
    this.name = "CapitalFlowsWithheld";
  }
}

const unread = () => new CapitalFlowsWithheld("unread");

function optionalInt(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw unread();
  return n;
}

/**
 * A row that does not read as a flow is not a flow of zero: the run is unread.
 * A COLUMN that is not there is a row without that fact — an older ledger has
 * no identity columns — so it reads as null, never as unread. `position`
 * stands in for an id only where the table has none.
 */
function recordOf(r: Record<string, unknown>, position: number): FlowRecord {
  const id = r.id === undefined ? position : Number(r.id);
  const amountUsdg = Number(r.amount_usdg);
  const at = Number(r.at);
  const direction = r.direction;
  if (!Number.isSafeInteger(id) || !Number.isFinite(amountUsdg) || !Number.isFinite(at)) throw unread();
  if (direction !== "in" && direction !== "out") throw unread();
  return {
    id,
    agentId: String(r.agent_id ?? ""),
    direction,
    amountUsdg,
    txHash: typeof r.tx_hash === "string" ? r.tx_hash : null,
    blockNumber: optionalInt(r.block_number),
    logIndex: optionalInt(r.log_index),
    source: String(r.source ?? ""),
    chainId: optionalInt(r.chain_id),
    at,
  };
}

/** The tx a row names, lowercased; an empty hash is no hash, as everywhere else. */
const txOf = (f: FlowRecord) => (f.txHash ? f.txHash.toLowerCase() : null);

/** A chain log: a tx and a log index. A carry never is one, whatever it carries. */
const isLog = (f: FlowRecord) => f.source !== "epoch-carry" && txOf(f) !== null && f.logIndex !== null;

/**
 * The executor's own booking of a transfer it signed: its tx, no log index
 * (index.ts). One per transfer, so the tx names it. The resolver's booking of
 * the same transfer carries the log index and is a chain log (isLog).
 */
const isBareIntent = (f: FlowRecord) => f.source === "transfer-intent" && txOf(f) !== null && f.logIndex === null;

/**
 * Collapse one run's rows into movements, and say whether they may be summed.
 *
 * PURE: `agentChain` is the account's registered chain, read by the caller —
 * null when it has none or more than one, and then a chain log with no stamp of
 * its own cannot be placed (nor can an intent, which then stands apart from a
 * stamped copy). Rows are taken earliest first (at, then id), so the
 * copy that speaks for a movement is the one booked first, which is the time a
 * valuation cutoff places it by. Nothing ELSE turns on that order: every
 * verdict is a fact about all the copies of a movement, so the same rows read
 * the same way whichever booker wrote first.
 */
export function collapseFlows(rows: readonly FlowRecord[], agentChain: number | null): CollapsedFlows {
  const ordered = [...rows].sort((a, b) => a.at - b.at || a.id - b.id);
  const duplicates: FlowDuplicates = {
    rows: ordered.length,
    distinct: 0,
    copies: { log: 0, nullChain: 0, carry: 0, intent: 0, identical: 0 },
    conflicts: { carries: 0, logs: 0, unresolvedChain: 0, intents: 0, txTwins: 0 },
  };
  const firstOf = new Map<string, FlowRecord>();
  /** Movements any copy of which is a transfer intent, by key. */
  const intended = new Set<string>();
  const flows: FlowRecord[] = [];
  let carries = 0;
  for (const f of ordered) {
    let key: string;
    if (f.source === "epoch-carry") {
      key = `carry|${f.direction}|${f.amountUsdg}`;
    } else if (isLog(f)) {
      const chain = f.chainId ?? agentChain;
      if (chain === null) {
        // No chain on the row and none on the account: this log cannot be
        // placed, so neither can whatever it may be a copy of.
        duplicates.conflicts.unresolvedChain += 1;
        key = `row|${f.id}`;
      } else {
        key = `log|${chain}|${txOf(f)}|${f.logIndex}`;
      }
    } else if (isBareIntent(f)) {
      // Placed on a chain as a log is. One the account cannot name stays
      // apart from a stamped copy rather than be guessed into it — and then
      // it is a second movement on the same tx, which is refused below.
      key = `intent|${f.chainId ?? agentChain ?? "?"}|${txOf(f)}|${f.direction}`;
    } else {
      // Every column but the row id, as written. A case or a NULL that differs
      // is a different row: only the mirror's exact copies are copies here.
      key = `same|${JSON.stringify([f.agentId, f.direction, f.amountUsdg, f.txHash, f.blockNumber, f.logIndex, f.source, f.chainId, f.at])}`;
    }
    if (f.source === "transfer-intent") intended.add(key);
    const first = firstOf.get(key);
    if (!first) {
      firstOf.set(key, f);
      flows.push(f);
      if (key.startsWith("carry|")) carries += 1;
      continue;
    }
    if (key.startsWith("carry|")) duplicates.copies.carry += 1;
    else if (key.startsWith("same|")) duplicates.copies.identical += 1;
    else if (first.direction !== f.direction || first.amountUsdg !== f.amountUsdg) {
      // Copies of one log, or of one intent, that cannot both be it.
      if (key.startsWith("intent|")) duplicates.conflicts.intents += 1;
      else duplicates.conflicts.logs += 1;
    } else if (key.startsWith("intent|")) duplicates.copies.intent += 1;
    else if ((first.chainId === null) !== (f.chainId === null)) duplicates.copies.nullChain += 1;
    else duplicates.copies.log += 1;
  }
  if (carries > 1) duplicates.conflicts.carries = carries - 1;
  // ONE TX, ONE DIRECTION, MORE THAN ONE MOVEMENT — judged after copies have
  // collapsed, so an intent and a log that ARE one log (the resolver books the
  // intent with its log index) are a copy, not a twin. What is left is two
  // legs only when every movement in the group is a log named by its own log
  // index and no copy of any of them is an intent. A movement with no log
  // index (the executor's intent, a legacy row) cannot say it is not the log
  // beside it; an intent among the copies is what was asked for, not what
  // moved. Either way the group is one transfer booked two ways. Over every
  // copy (`intended`), not the copy that speaks for the movement, so the
  // verdict does not depend on which booker wrote first. Carries are judged
  // on their own above.
  const onTx = new Map<string, { n: number; ambiguous: boolean }>();
  for (const [key, f] of firstOf) {
    const tx = txOf(f);
    if (key.startsWith("carry|") || tx === null) continue;
    const group = onTx.get(`${tx}|${f.direction}`) ?? { n: 0, ambiguous: false };
    group.n += 1;
    group.ambiguous ||= f.logIndex === null || intended.has(key);
    onTx.set(`${tx}|${f.direction}`, group);
  }
  for (const group of onTx.values()) if (group.n > 1 && group.ambiguous) duplicates.conflicts.txTwins += group.n - 1;
  duplicates.distinct = flows.length;
  const c = duplicates.conflicts;
  const verdict: FlowVerdict = c.carries > 0 || c.logs > 0 || c.unresolvedChain > 0 || c.intents > 0 ? "unread"
    : c.txTwins > 0 ? "review" : "ok";
  return { flows, duplicates, verdict };
}

/**
 * Every row of one account's run. Case-insensitive on the account, like every
 * financial reader: an account has been written under more than one spelling.
 * `epoch` null only for a ledger older than epochs, where every row is the one
 * run there is.
 *
 * `SELECT *`, NOT A COLUMN LIST: a ledger an older worker wrote has no
 * `log_index` or `chain_id`, and then no row is a chain log — every row
 * collapses only as an exact copy. Naming a column it lacks would throw, and
 * a run with no identity columns is a run read, not an unread one. The scope
 * is the normalized account/run index either way.
 */
async function readFlowRows(db: Db, account: string, epoch: number | null): Promise<FlowRecord[]> {
  const rows = (await db
    .prepare(`SELECT * FROM flows WHERE LOWER(agent_id) = ?${epoch === null ? "" : " AND epoch = ?"} ORDER BY at ASC`)
    .all(account.toLowerCase(), ...(epoch === null ? [] : [epoch]))) as Record<string, unknown>[];
  return rows.map(recordOf);
}

/**
 * The account's registered chain, across its spellings: the chain a row with
 * no stamp was booked on. Null when there is none, or more than one — then it
 * names no chain, and collapseFlows refuses to place an unstamped log.
 */
async function agentChainOf(db: Db, account: string): Promise<number | null> {
  const rows = (await db
    .prepare("SELECT DISTINCT chain_id FROM agents WHERE LOWER(smart_account) = ?")
    .all(account.toLowerCase())) as Record<string, unknown>[];
  const chains = rows.map((r) => r.chain_id).filter((c) => c !== null && c !== undefined).map(Number);
  return chains.length === 1 && Number.isSafeInteger(chains[0]) ? chains[0]! : null;
}

async function readRun(db: Db, account: string, epoch: number | null): Promise<CollapsedFlows> {
  const rows = await readFlowRows(db, account, epoch);
  // The registration is asked only when a row needs it: most runs have none.
  const unstamped = rows.some((f) => f.chainId === null && (isLog(f) || isBareIntent(f)));
  return collapseFlows(rows, unstamped ? await agentChainOf(db, account) : null);
}

/**
 * One account's run, one row per movement, oldest first.
 *
 * THROWS CapitalFlowsWithheld when the rows contradict each other, and lets a
 * failed read throw as itself: a reader must say the figure is unavailable,
 * never sum what it has. An empty array is a run with no flow on record.
 */
export async function readDistinctFlows(db: Db, account: string, epoch: number | null): Promise<FlowRecord[]> {
  const run = await readRun(db, account, epoch);
  if (run.verdict !== "ok") throw new CapitalFlowsWithheld(run.verdict);
  return run.flows;
}

/**
 * Net contributions over movements: in less out, and how many were counted.
 * `at` keeps only those booked at or before it — the valuation a return is
 * measured at. The cutoff applies AFTER the collapse, so a late copy cannot
 * stand alone inside it or fall outside it in place of its original.
 */
export function netFlows(flows: readonly FlowRecord[], at?: number): { n: number; net: number } {
  let n = 0;
  let net = 0;
  for (const f of flows) {
    if (at !== undefined && f.at > at) continue;
    n += 1;
    net += f.direction === "in" ? f.amountUsdg : -f.amountUsdg;
  }
  return { n, net };
}

export interface FlowDuplicateReport extends FlowDuplicates {
  /** Lowercased, as read. */
  account: string;
  epoch: number;
  verdict: FlowVerdict;
  /** No copy and no conflict: every row on record is one movement. */
  clean: boolean;
}

/**
 * THE SAME READ, AS A COUNT. Read only.
 *
 * Copies count against `clean` as well as conflicts, though the web readers
 * collapse them: the worker's own sums still add rows, so a run with any copy
 * on record is not one that may be admitted on the strength of those sums.
 *
 * `epoch` defaults to the account's current run — the highest epoch any of its
 * spellings is registered at. Closed epochs are kept for forensics and are in
 * no figure. An account with no registration THROWS: no run can be named, and
 * a gate must not read that as clean.
 */
export async function flowDuplicateReport(db: Db, account: string, epoch?: number): Promise<FlowDuplicateReport> {
  let run = epoch ?? null;
  if (run === null) {
    const row = (await db
      .prepare("SELECT MAX(COALESCE(epoch, 1)) AS epoch FROM agents WHERE LOWER(smart_account) = ?")
      .get(account.toLowerCase())) as Record<string, unknown> | undefined;
    const current = row?.epoch;
    run = current === null || current === undefined ? null : Number(current);
    if (run === null || !Number.isSafeInteger(run)) throw new Error(`no registration for ${account.toLowerCase()}: its current run cannot be named`);
  }
  const { duplicates, verdict } = await readRun(db, account, run);
  const copies = Object.values(duplicates.copies).reduce((s, n) => s + n, 0);
  const conflicts = Object.values(duplicates.conflicts).reduce((s, n) => s + n, 0);
  return { account: account.toLowerCase(), epoch: run, ...duplicates, verdict, clean: copies === 0 && conflicts === 0 };
}
