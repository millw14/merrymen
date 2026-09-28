/**
 * A PRACTICE RESET THE OWNER ASKED FOR WHILE THEIR BOOK WOULD NOT RESTORE.
 *
 * A paper-reset is an agent_commands row, and until now only a worker could
 * act on one: the ferry hands rows to running children, and the child runs
 * runPaperReset against its own book (index.ts). A tenant whose practice book
 * will not restore has no worker (orchestrator.ts spawnHolder), so the reset
 * waited, unclaimed, for a worker that could not start: the one way out of a
 * broken practice book was the one thing that could not happen while it was
 * broken. This is how the orchestrator honours it without one, as plan §3.4
 * sets out.
 *
 * WHEN, and every condition is asked where it is decided:
 * - only after the restore has failed, only for a tenant the gate would hold
 *   (practice on), and only under the tenant's lease (orchestrator.ts);
 * - only the NEWEST unclaimed paper-reset row for the account, and only one
 *   queued in the last seven days. Consent is to a reset now, not whenever the
 *   book next breaks: an older row is not acted on, and the owner is asked to
 *   press it again. It is CLOSED, not left: a row this has judged to be no
 *   longer consent must not be run by the worker a later restore hands the
 *   tenant to (the ferry delivers whatever is unclaimed), which would start
 *   over a book that had just been got back, on a request already turned down;
 * - only a PRACTICE book: the owner's stored settings must not switch live
 *   trading on, and the ledger must say paper (the newest valuation is a paper
 *   one, and the agent did not last report the live rail). The ledger half is
 *   asked again inside the transaction (paper-checkpoint.ts
 *   resetBlockedPaperBookIn), so neither gate relies on the other.
 *
 * AT MOST ONCE, and here in fact exactly once. The row is claimed with the
 * statement deliverCommand uses — `SET claimed_at WHERE claimed_at IS NULL`,
 * which only one caller can win — but inside the SAME transaction as the reset
 * and the answer. A crash before COMMIT leaves nothing: the row unclaimed and
 * the book as it was, so the next attempt is the first. A crash after it
 * leaves the row claimed and answered, so no ferry, pass or replica ever runs
 * it again. The two orders deliverCommand has to choose between (it writes to
 * two systems) do not arise here: everything is in one database.
 *
 * Older unclaimed resets for the same account are closed in the same
 * transaction, answered as done by this one. Left open, the first worker after
 * the hold would be ferried one and would start the new book over again.
 *
 * NO CAPITAL FLOW IS BOOKED, and nothing is deleted that is history: see
 * resetBlockedPaperBook for what moves. What IS added is the line the worker's
 * own reset writes to the agent's event feed (index.ts runPaperReset), in the
 * same transaction, so the dashboard's activity says the book was started over
 * whichever process did it.
 */
import type { Db } from "./db";
import { PAPER_CHECKPOINT_SCHEMA, resetBlockedPaperBookIn } from "./paper-checkpoint";

/** How recent a reset must be for a held tenant's book to be started over on it. */
export const HELD_RESET_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

/** A queued paper-reset, as agent_commands holds it. Times are milliseconds. */
export interface ResetAsk {
  id: string;
  created_at: number;
  claimed_at: number | null;
}

/** Everything the decision reads, gathered by applyHeldReset. */
export interface HeldResetEvidence {
  /** The newest unclaimed paper-reset for the account, or null. */
  ask: ResetAsk | null;
  now: number;
  /** The owner's stored settings; `unreadable` when the store would not answer. */
  settings: { paperTradingEnabled?: boolean; liveTradingEnabled?: boolean } | null | "unreadable";
  /**
   * Whether the owner's live-trading consent is enforced on this deployment.
   * With it stood down (MERRYMEN_LIVE_INTENT_STAND_DOWN, settings.ts), a
   * setting that does not switch live trading on proves nothing.
   */
  consentEnforced: boolean;
  /** The shared agents row: its epoch and the rail it last reported. Null when there is none. */
  agent: { epoch: number; mode: string | null } | null;
  /** The mode of the account's newest valuation, or null when it has none. */
  latestMarkMode: string | null;
}

/**
 * `stale`: the newest ask is past the seven days, and is closed rather than
 * left (applyHeldReset). `transient`: nothing about the book or the owner's
 * wish said no, only a read that failed, so asking again soon may say yes.
 */
export type HeldResetDecision =
  | { reset: true; id: string; epoch: number }
  | { reset: false; why: string; stale?: true; transient?: true };

/**
 * THE HALF OF THE DECISION THE OWNER'S SETTINGS DECIDE: why they rule a held
 * reset out, or null when they allow one. Its own function because the
 * orchestrator asks it before it offers the reset at all (the hold's replies
 * and notice, restore-block.ts): an owner whose reset would always be refused
 * here is not told to press it, and so not sent to discard a signed grant on
 * the web for nothing.
 */
export function settingsRefuseHeldReset(
  settings: HeldResetEvidence["settings"],
  consentEnforced: boolean,
): string | null {
  if (settings === "unreadable") return "the owner's settings could not be read";
  if (settings?.paperTradingEnabled !== true) return "practice mode is not on";
  if (settings.liveTradingEnabled === true) return "live trading is switched on";
  if (!consentEnforced) return "live-trading consent is stood down on this deployment";
  return null;
}

/**
 * MAY THIS HELD TENANT'S BOOK BE STARTED OVER NOW? Pure.
 *
 * Every answer but one is a no, and each no says which condition failed, for
 * the operator's log. Nothing here reads the lease: that is the caller's, and
 * it is asked last, just before the write.
 */
export function decideHeldReset(e: HeldResetEvidence): HeldResetDecision {
  if (!e.ask) return { reset: false, why: "no practice reset is waiting" };
  if (e.ask.claimed_at !== null && e.ask.claimed_at !== undefined) return { reset: false, why: "the reset was already claimed" };
  const age = e.now - Number(e.ask.created_at);
  if (!Number.isFinite(age) || age > HELD_RESET_MAX_AGE_MS) {
    return { reset: false, why: "the reset was asked for more than seven days ago; the owner must ask again", stale: true };
  }
  const settingsSay = settingsRefuseHeldReset(e.settings, e.consentEnforced);
  if (settingsSay) return e.settings === "unreadable" ? { reset: false, why: settingsSay, transient: true } : { reset: false, why: settingsSay };
  if (!e.agent) return { reset: false, why: "the account has no agent row" };
  if (e.agent.mode === "live") return { reset: false, why: "the agent last reported the live rail" };
  if (e.latestMarkMode !== "paper") {
    return { reset: false, why: e.latestMarkMode === null ? "there is no valuation to show the book is a paper one" : "the newest valuation is not a paper one" };
  }
  const epoch = Number(e.agent.epoch);
  if (!Number.isSafeInteger(epoch) || epoch < 1) return { reset: false, why: "the account's epoch is unreadable" };
  return { reset: true, id: e.ask.id, epoch };
}

/**
 * The newest unclaimed paper-reset for this account.
 *
 * BOUND TO `agent_id = ?` EXACTLY, the ferry's own predicate (orchestrator.ts
 * ferryForChild): only a row the ferry would have handed this account's worker
 * is ever claimed here, and never one enqueued under another spelling.
 */
export async function newestResetAsk(shared: Db, account: string): Promise<ResetAsk | null> {
  const row = (await shared
    .prepare(
      `SELECT id, created_at, claimed_at FROM agent_commands
        WHERE agent_id = ? AND kind = 'paper-reset' AND claimed_at IS NULL
        ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(account)) as { id: string; created_at: number | string; claimed_at: number | string | null } | undefined;
  if (!row) return null;
  return {
    id: String(row.id),
    created_at: Number(row.created_at),
    claimed_at: row.claimed_at === null || row.claimed_at === undefined ? null : Number(row.claimed_at),
  };
}

/**
 * The accounts, of those given, with a paper-reset queued in the last seven
 * days that nobody has claimed, and the newest such row's id for each. One
 * query for every held tenant, so reconcile can try a held tenant's restore as
 * soon as its owner asks rather than at the end of a thirty-minute backoff.
 */
export async function resetsAsked(shared: Db, accounts: readonly string[], now: number): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (accounts.length === 0) return out;
  const rows = (await shared
    .prepare(
      `SELECT agent_id, id FROM agent_commands
        WHERE kind = 'paper-reset' AND claimed_at IS NULL AND created_at >= ?
          AND agent_id IN (${accounts.map(() => "?").join(", ")})
        ORDER BY created_at DESC, id DESC`,
    )
    .all(now - HELD_RESET_MAX_AGE_MS, ...accounts)) as { agent_id: string; id: string }[];
  for (const r of rows) if (!out.has(String(r.agent_id))) out.set(String(r.agent_id), String(r.id));
  return out;
}

/**
 * What honouring a held tenant's reset came to. `id` is the row it was about,
 * when there was one. `transient` when the answer was no only because
 * something could not be read or written just then (the settings, the lease,
 * the epoch moving under the decision): the orchestrator then asks again soon
 * rather than at the end of the hold's backoff.
 */
export type HeldResetOutcome =
  | { applied: true; id: string; from: number; epoch: number }
  | { applied: false; id: string | null; why: string; transient: boolean };

/** What the owner's command row is answered with. No figure: the worker's starting stake is not known here. */
export const HELD_RESET_DONE =
  "practice book started over: positions cleared, and earlier practice trades kept on file but no longer counted. " +
  "It restarts at the practice starting cash when the agent comes back.";
/** What an older reset closed by this one is answered with. */
export const HELD_RESET_SUPERSEDED = "practice book started over by a later request";
/** What a reset closed for its age is answered with. */
export const HELD_RESET_EXPIRED =
  "not done: this practice reset was asked for more than seven days ago, and a practice book is only started over " +
  "on a recent request. Ask again if you still want it.";
/**
 * The line the agent's event feed gets, as runPaperReset's does, less the
 * figure: the starting stake is the worker's to know.
 */
export const heldResetEvent = (closed: number): string =>
  `paper book restarted — positions cleared, and earlier paper trades closed into epoch ${closed} ` +
  "(kept, but no longer counted). Cash goes back to the practice starting stake when the agent comes back.";

/** Thrown inside the transaction to roll it back, claim and all, with the reason. */
class NotApplied extends Error {
  constructor(
    why: string,
    readonly transient = false,
  ) {
    super(why);
  }
}

/**
 * HONOUR THE NEWEST PRACTICE RESET FOR A HELD ACCOUNT, if every condition holds.
 *
 * `readSettings` is the owner's stored settings (null when none are stored; a
 * throw is unreadable). `mayWrite` is asked after every read and before any
 * write, and names why the write must not happen (the lease is gone), or
 * returns null. Reads that fail throw; the caller logs them and the next
 * attempt asks again.
 *
 * A newest ask past the seven days is not honoured, and is closed, with every
 * older one, under the same `mayWrite` and with HELD_RESET_EXPIRED for an
 * answer. Only rows past the bound: one queued a moment ago, after the read
 * above, is left for the next attempt to honour.
 */
export async function applyHeldReset(
  shared: Db,
  account: string,
  opts: {
    now: number;
    readSettings: () => Promise<{ paperTradingEnabled?: boolean; liveTradingEnabled?: boolean } | null>;
    consentEnforced: boolean;
    mayWrite: () => string | null;
  },
): Promise<HeldResetOutcome> {
  const ask = await newestResetAsk(shared, account);
  // The common case, and it costs one indexed read: nothing was asked.
  if (!ask) return { applied: false, id: null, why: "no practice reset is waiting", transient: false };
  let settings: HeldResetEvidence["settings"];
  try {
    settings = await opts.readSettings();
  } catch {
    settings = "unreadable";
  }
  const agentRow = (await shared
    .prepare(`SELECT epoch, mode FROM agents WHERE LOWER(smart_account)=LOWER(?)`)
    .get(account)) as { epoch: number | string; mode: string | null } | undefined;
  const mark = (await shared
    .prepare(`SELECT mode FROM equity WHERE LOWER(agent_id)=LOWER(?) ORDER BY at DESC, id DESC LIMIT 1`)
    .get(account)) as { mode: string | null } | undefined;
  const decision = decideHeldReset({
    ask,
    now: opts.now,
    settings,
    consentEnforced: opts.consentEnforced,
    agent: agentRow ? { epoch: Number(agentRow.epoch), mode: agentRow.mode ?? null } : null,
    latestMarkMode: mark ? (mark.mode ?? null) : null,
  });
  if (!decision.reset && !decision.stale) {
    return { applied: false, id: ask.id, why: decision.why, transient: decision.transient === true };
  }
  const refused = opts.mayWrite();
  if (refused) return { applied: false, id: ask.id, why: refused, transient: true };
  if (!decision.reset) {
    const closed = await shared
      .prepare(
        `UPDATE agent_commands SET claimed_at = ?, done_at = ?, result = ?
          WHERE agent_id = ? AND kind = 'paper-reset' AND claimed_at IS NULL AND created_at < ?`,
      )
      .run(opts.now, opts.now, HELD_RESET_EXPIRED, account, opts.now - HELD_RESET_MAX_AGE_MS);
    const why =
      Number(closed.changes) > 0
        ? "the reset was asked for more than seven days ago, so it was closed unrun; the owner must ask again"
        : decision.why;
    return { applied: false, id: ask.id, why, transient: false };
  }
  await shared.exec(PAPER_CHECKPOINT_SCHEMA);
  try {
    const epoch = await shared.tx(async (db) => {
      // deliverCommand's claim, word for word: one caller wins it.
      const claim = await db
        .prepare("UPDATE agent_commands SET claimed_at = ? WHERE id = ? AND claimed_at IS NULL")
        .run(opts.now, decision.id);
      if (Number(claim.changes) === 0) throw new NotApplied("another pass or replica claimed the reset");
      const reset = await resetBlockedPaperBookIn(db, account, decision.epoch);
      if (!reset.ok) throw new NotApplied(reset.why, reset.moved === true);
      await db.prepare("UPDATE agent_commands SET done_at = ?, result = ? WHERE id = ?").run(opts.now, HELD_RESET_DONE, decision.id);
      await db
        .prepare(
          `UPDATE agent_commands SET claimed_at = ?, done_at = ?, result = ?
            WHERE agent_id = ? AND kind = 'paper-reset' AND claimed_at IS NULL AND id <> ? AND created_at <= ?`,
        )
        .run(opts.now, opts.now, HELD_RESET_SUPERSEDED, account, decision.id, ask.created_at);
      await db.prepare("INSERT INTO events (agent_id, level, message) VALUES (?, 'ok', ?)").run(account, heldResetEvent(decision.epoch));
      return reset.epoch;
    });
    return { applied: true, id: decision.id, from: decision.epoch, epoch };
  } catch (e) {
    if (e instanceof NotApplied) return { applied: false, id: decision.id, why: e.message, transient: e.transient };
    throw e;
  }
}
