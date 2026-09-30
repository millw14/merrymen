/**
 * COMMANDS REACH A WORKER AS FILES IN ITS OWN HOME.
 *
 * The first version of this put the command in a table and had the worker poll
 * it, on the reasoning that "everything the dashboard has ever told the worker
 * goes through a store the other side polls". That reasoning was wrong, and an
 * adversarial review caught it before it shipped.
 *
 * What actually exists: the orchestrator MATERIALISES state into each child's
 * private home — `writeGrantForChild`, `writeSettingsForChild` — and the ledger
 * mirror runs strictly child → shared, one direction. There is no shared → child
 * path in this repo at all. Children have DATABASE_URL stripped
 * (CHILD_SECRET_STRIP) precisely so they cannot reach the shared database, which
 * is a custody decision, not an oversight. So a hosted command written to
 * Postgres and polled from a child's private sqlite is two different databases,
 * and nothing would ever have been claimed.
 *
 * This is the existing pattern instead:
 *
 *   web ──(shared table, hosted only)──▶ orchestrator ──(file)──▶ child
 *   child ──(result file)──▶ orchestrator ──(shared table)──▶ web
 *
 * Self-hosted there is no orchestrator and no shared table: the web process and
 * the worker share one MERRYMEN_HOME, so the web writes the file directly and
 * the middle two hops vanish. One drain path, two ways in.
 *
 * THE CLAIM IS AN UNLINK. `rm` on a file is atomic on every filesystem this
 * runs on, so the worker that successfully deletes the command owns it and any
 * other reader gets ENOENT. That is a stronger guarantee than the SELECT-then-
 * UPDATE it replaces, and it needs no transaction — which matters, because the
 * thing being guarded spends gas and at-most-once is the only acceptable
 * semantics.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { OrderReceipt } from "./order-receipt";

/** One instruction, as it sits on disk. */
export interface FileCommand {
  id: string;
  kind: string;
  /** Milliseconds. Seconds would make two commands in one second unordered. */
  at: number;
  /**
   * What the instruction is ABOUT — side, symbol, size. Flat scalars only.
   *
   * TRANSPORT, NOT MEANING. Nothing on this path interprets it: the writer
   * serialises it, the claim hands it back, and the dispatch is where an order
   * is proved legal — twice over, because the route proved it once before the
   * row was written. This file must never grow a rule about what a good `args`
   * looks like, or the channel stops being dumb and starts being a second,
   * weaker wall.
   */
  args?: Record<string, string | number | boolean>;
  /**
   * Milliseconds after which this command must NOT run. Optional; absent means
   * it never goes stale.
   *
   * A SETTINGS WRITE IS TIMELESS AND AN ORDER IS NOT. A probe can wait an hour
   * and mean the same thing. A buy cannot: the child returns early from its
   * drain when it is unarmed, restarting, behind on ticks, or when the market
   * was unreadable — and the command file survives a restart, so a re-arm would
   * execute a stale order as its first act. The owner clicked during a wobble,
   * closed the tab, and the fill lands hours later at a price they never saw,
   * into a book they never looked at.
   *
   * Enforced at the CLAIM rather than at delivery, because the wait that
   * matters is the one after the file lands.
   */
  expiresAt?: number;
}

/**
 * A command id, as a filename.
 *
 * THIS IS THE BOUNDARY WHERE AN ID BECOMES A PATH. `writeCommand` interpolates
 * the id straight into a path under a child's home, and it runs in the
 * ORCHESTRATOR — the one process that can see every tenant's home. An id of
 * `../<other-tenant>/commands/x` is cross-tenant order injection past every
 * per-tenant check there is.
 *
 * The web route generates ids server-side and its comment gives the reason as
 * collision ("an id a client chooses is an id a client can collide with
 * somebody else's"), which reads as a uniqueness concern and would not stop
 * anyone adding a client-supplied idempotency key — a reasonable thing to want,
 * and the exact change that opens this. So the guard lives HERE, where the join
 * happens, rather than in whichever caller is trusted this week. Any
 * deterministic key must be a hash, never a concatenation of user-supplied
 * fields.
 */
const ID_OK = /^[A-Za-z0-9_-]{1,64}$/;

/** What the worker decided, on its way back. */
export interface FileCommandResult {
  id: string;
  ok: boolean;
  line: string;
  at: number;
  /**
   * An ORDER's verdict as ledger facts, beside the sentence and never instead
   * of it. Absent for anything that is not an order, for a result written
   * before receipts existed, and for the two order states the contract has no
   * honest status for (see order-receipt.ts). Every reader renders `line` when
   * this is missing, so an old result and a new one both still say something.
   */
  receipt?: OrderReceipt;
}

const DIR = "commands";

/** Where a home keeps its pending instructions. */
export function commandDir(home: string): string {
  return path.join(home, DIR);
}

/** Drop a command into a home. Called by the orchestrator, or by a self-hosted web. */
export function writeCommand(home: string, cmd: FileCommand): void {
  // See ID_OK. Refused rather than sanitised: an id we had to repair is an id
  // whose owner thinks it is something else, and the result row is keyed on it.
  if (!ID_OK.test(cmd.id)) throw new Error(`refusing to write a command whose id is not a plain id: ${cmd.id}`);
  const dir = commandDir(home);
  mkdirSync(dir, { recursive: true });
  // Written to a temp name and renamed, so a reader can never observe a
  // half-written command — rename is atomic within a filesystem, write is not.
  const tmp = path.join(dir, `.${cmd.id}.tmp`);
  writeFileSync(tmp, JSON.stringify(cmd), "utf8");
  renameSync(tmp, path.join(dir, `${cmd.id}.json`));
}

/**
 * Take the oldest pending command, or null.
 *
 * THE UNLINK IS THE CLAIM. Reading then deleting means a crash between the two
 * replays the command; deleting then acting means a crash loses it. Losing a
 * probe is a button the owner presses again; replaying one spends gas nobody
 * asked to spend twice. So: delete first, and only then act.
 */
export function claimCommandFile(home: string): FileCommand | null {
  const dir = commandDir(home);
  for (const { n, cmd } of pendingCommands(dir)) {
    if (!claimFile(dir, n)) continue;
    // WE DELETED IT, SO IT IS OURS — and an expired one is ours to DROP.
    // Returned as an expiry rather than swallowed: a silently-vanished order
    // and a never-delivered one must not look the same to the person who
    // clicked, so the caller writes a result saying which.
    return cmd;
  }
  return null;
}

/**
 * The unlink that is the claim. False when somebody else got there first —
 * the caller tries the next one rather than giving up, because "the queue is
 * empty" and "one entry was taken" are different.
 */
function claimFile(dir: string, n: string): boolean {
  try {
    unlinkSync(path.join(dir, n));
    return true;
  } catch {
    return false;
  }
}

/** Every pending command in a queue directory, oldest first, with the filename it was read from. */
function pendingCommands(dir: string): { n: string; cmd: FileCommand }[] {
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json") && !n.endsWith(".done.json"));
  } catch {
    return [];
  }
  if (names.length === 0) return [];

  // Oldest first, by the timestamp inside rather than by mtime: a file copied
  // between homes keeps its meaning, and mtime does not survive that.
  // THE FILENAME IS CARRIED ALONGSIDE, AND IT IS WHAT GETS UNLINKED.
  //
  // This used to delete `${cmd.id}.json` — the id from INSIDE the file — and
  // discard the name it had actually read. While `writeCommand` was the only
  // writer the two always agreed, so it worked; but "filename == id" was a
  // load-bearing invariant that nothing stated and nothing checked. A file
  // whose name did not match its id was never removed, so it was re-claimed and
  // re-executed on EVERY scan — unbounded replay — and it deleted a different
  // pending command's file on the way past. Adding args is exactly the change
  // that invites a second writer (an order route, a CLI, a rehearsal fixture).
  const parsed = names
    .map((n) => {
      try {
        return { n, cmd: JSON.parse(readFileSync(path.join(dir, n), "utf8")) as FileCommand };
      } catch {
        // Unreadable command: remove it rather than blocking the queue behind
        // something no worker will ever be able to run.
        try {
          unlinkSync(path.join(dir, n));
        } catch {
          /* already gone */
        }
        return null;
      }
    })
    .filter((e): e is { n: string; cmd: FileCommand } => {
      if (!e) return false;
      if (typeof e.cmd.id === "string" && typeof e.cmd.kind === "string") return true;
      // UNLINKED TOO. This branch used to filter and walk away, so a file that
      // parsed but was the wrong shape stayed in the directory and was
      // re-parsed forever — the unreadable branch above already knew better.
      try {
        unlinkSync(path.join(dir, e.n));
      } catch {
        /* already gone */
      }
      return false;
    });
  // (time, id) — never time alone. Two commands really do land in the same
  // millisecond; store.ts argues this at length for the queue nothing calls,
  // and it matters more here, because for two ORDERS "which one first" is a
  // question about somebody's money.
  return parsed.sort((a, b) => (a.cmd.at ?? 0) - (b.cmd.at ?? 0) || a.n.localeCompare(b.n));
}

/** What running one command came to, as the receipt and the owner's event feed say it. */
export interface CommandOutcome {
  ok: boolean;
  line: string;
  /** Carried into the result file untouched. See FileCommandResult.receipt. */
  receipt?: OrderReceipt;
}

/**
 * THIS TICK'S COMMAND: every expired one on the way is answered, and at most
 * one live one is run.
 *
 * AN EXPIRED COMMAND USED TO COST A WHOLE TICK. The worker claimed one command
 * per tick and wrote the expiry for it, so stale files were paid off one tick
 * at a time, oldest first — and they pile up in exactly the two cases nobody is
 * watching: an owner queueing every seven minutes while the worker is unarmed,
 * and a hosted down-leg delivering rows after an orchestrator outage. With five
 * of them ahead of it, a fresh order expired before it was reached; the owner
 * was told the truth about an order that was lost for no reason of its own.
 *
 * So the drain claims on through the expired ones, writing each one's receipt
 * as it goes. Nothing about the live half changes: the claim is still the
 * unlink, a file somebody else took is skipped rather than run here too, and
 * the FIRST live command ends the drain — run, answered, and nothing claimed
 * after it, so a tick still runs at most one. An expired command is never
 * handed to `run`; its receipt is written here, from the same deadline the
 * claim judged, so no later reading of the clock can turn it back into an order.
 *
 * `told` is the owner's event feed. A failure there stops the drain with the
 * receipt already on disk, and the next tick carries on from the next file.
 */
export async function runTickCommand(
  home: string,
  deps: {
    now: () => number;
    run: (cmd: FileCommand) => Promise<CommandOutcome>;
    told: (cmd: FileCommand, outcome: CommandOutcome) => Promise<void>;
    /**
     * The receipt for a command answered here as expired, when it has one.
     *
     * A HOOK, because this file must not learn what an order's arguments mean
     * (see FileCommand.args): the worker knows an order from a probe and builds
     * the facts; the drain only carries them. Absent, an expiry is answered
     * with its sentence alone, exactly as before receipts existed.
     */
    expiredReceipt?: (cmd: FileCommand) => OrderReceipt | undefined;
  },
): Promise<void> {
  const dir = commandDir(home);
  for (const { n, cmd } of pendingCommands(dir)) {
    if (!claimFile(dir, n)) continue;
    const now = deps.now();
    if (isExpired(cmd, now)) {
      const receipt = deps.expiredReceipt?.(cmd);
      const dead: CommandOutcome = {
        ok: false,
        line: expiredLine(cmd.expiresAt as number, now, "claim"),
        ...(receipt ? { receipt } : {}),
      };
      writeCommandResult(home, resultOf(cmd.id, dead, now));
      await deps.told(cmd, dead);
      continue;
    }
    // CLAIMED IS NOT THE SAME AS ANSWERED, and self-hosted the queue file is
    // gone from here until the receipt lands. Without this marker an owner
    // who asked again mid-trade got a second fill.
    markRunning(home, cmd.id);
    const outcome = await deps.run(cmd);
    writeCommandResult(home, resultOf(cmd.id, outcome, deps.now()));
    await deps.told(cmd, outcome);
    return;
  }
}

/** An outcome as it is written down — the receipt only when there is one, so an old reader sees the old shape. */
function resultOf(id: string, o: CommandOutcome, at: number): FileCommandResult {
  return { id, ok: o.ok, line: o.line, at, ...(o.receipt ? { receipt: o.receipt } : {}) };
}

/** An order the intent queue reached after its own deadline, and did not run. Not a ledger status: no row exists. */
export interface LateOrder {
  status: "late";
  line: string;
}

/**
 * Run an order's step only if the queue reached it by its deadline.
 *
 * THE CLAIM IS NOT THE LAST WAIT. After it, an order waits on a curve lookup
 * and a decision row, then joins the intent queue behind whatever the tick has
 * already put there — and each of those can wait minutes on a receipt. Nothing
 * re-read the deadline in there, so an order could START after it, filling
 * into exactly the market the expiry exists to refuse, and still be trading
 * after the sweep had let the owner place another.
 *
 * So the queue's step asks here, with the clock read at the moment the queue
 * reaches the order — never when it joined. Late, `body` is not called at all:
 * nothing is built, signed or sent, and the answer is a sentence that says so.
 * At the deadline itself it still runs, the edge `isExpired` draws at the
 * claim. No deadline (Telegram, the Brain, a legacy command) is never late.
 */
export async function unlessLate<T>(
  notAfterMs: number | undefined,
  now: () => number,
  body: () => Promise<T>,
): Promise<T | LateOrder> {
  if (typeof notAfterMs === "number" && Number.isFinite(notAfterMs)) {
    const t = now();
    if (t > notAfterMs) return { status: "late", line: expiredLine(notAfterMs, t, "queue") };
  }
  return body();
}

/** A lateness as an owner reads it: seconds while it is short, then minutes, then hours. */
function howLate(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 120) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 120) return `${m} min`;
  return `${Math.round(m / 60)} h`;
}

/**
 * The receipt for an order that is refused because its own window closed.
 *
 * "claim": the worker picked it up too late. "queue": it was picked up in
 * time, then waited behind other trades and reached the front of the queue
 * too late. Either way nothing went to the chain, and the sentence says so —
 * and says WHEN, rather than implying the order itself is that old.
 */
export function expiredLine(expiresAt: number, nowMs: number, where: "claim" | "queue"): string {
  const late = howLate(nowMs - expiresAt);
  const when =
    where === "claim"
      ? `I picked this order up ${late} after its window closed`
      : `this order reached the front of my trade queue ${late} after its window closed`;
  return `expired — ${when}, and I will not fill it into a different market than the one it was placed for. Nothing was sent. Ask again if you still want it.`;
}

/**
 * Has this command sat too long to be acted on?
 *
 * Separate from the claim so the CLAIM still consumes it — an expired command
 * must leave the queue and leave a receipt, not be skipped and re-read forever.
 */
export function isExpired(cmd: FileCommand, nowMs: number): boolean {
  return typeof cmd.expiresAt === "number" && Number.isFinite(cmd.expiresAt) && nowMs > cmd.expiresAt;
}

/**
 * Where a command's outcome sits, WITHOUT consuming it.
 *
 * `drainCommandResults` is the orchestrator's read and it deletes as it goes,
 * which is right for a ferry and wrong for a person refreshing a page. Three
 * answers, and they are genuinely three:
 *
 *   "done"    — it ran, and here is what happened
 *   "queued"  — the file is still sitting there unclaimed
 *   "running" — neither; claimed and not yet answered
 *
 * SELF-HOSTED HAS NO OTHER ANSWER. There is no orchestrator to ferry results
 * into a table there, so the route used to report `{state:"none"}` — the same
 * body it returns for a command that was never queued. "Never ran" and "ran,
 * and here is the fill" rendered identically, which is the one conflation this
 * codebase does not permit anywhere near somebody's money.
 */
export function readCommandState(
  home: string,
  id: string,
): { state: "queued" | "running" | "done"; result?: FileCommandResult; expiresAt?: number | null } | null {
  if (!ID_OK.test(id)) return null;
  const dir = commandDir(home);
  try {
    const done = readFileSync(path.join(dir, `${id}.done.json`), "utf8");
    return { state: "done", result: JSON.parse(done) as FileCommandResult };
  } catch {
    /* not finished — or not ours */
  }
  // A file still in the queue carries its own deadline, read in the SAME read
  // that says it is queued. Two reads — "does it exist", then "what does it
  // say" — let a claim land between them, and the route then had to guess.
  let raw: string;
  try {
    raw = readFileSync(path.join(dir, `${id}.json`), "utf8");
  } catch {
    return { state: "running" };
  }
  return { state: "queued", expiresAt: deadlineIn(raw) };
}

/**
 * The deadline a queued file was written with, or null when it carries none.
 * Null is NOT "already expired": `isExpired` runs a deadline-less command, so
 * nothing may tell the owner it will not.
 */
function deadlineIn(raw: string): number | null {
  try {
    const v = (JSON.parse(raw) as { expiresAt?: unknown })?.expiresAt;
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * The ids waiting in this home's queue — a LISTING, and nothing more.
 *
 * For the child's between-ticks watcher, which asks every couple of seconds
 * whether anything has arrived. So nothing here parses, claims or marks: the
 * claim is still the unlink inside the tick's drain, and a watcher that could
 * take a command would be a second drain beside the one that enforces
 * one-at-a-time. A half-written file is a dotfile ending `.tmp` and never
 * matches; an unreadable directory is an empty list, because the worst a
 * missed look costs is the next look two seconds later.
 */
export function queuedCommandIds(home: string): string[] {
  try {
    return readdirSync(commandDir(home))
      .filter((n) => n.endsWith(".json") && !n.endsWith(".done.json") && !n.startsWith("."))
      .map((n) => n.slice(0, -".json".length));
  } catch {
    return [];
  }
}

/** One unanswered command in a self-hosted home, as the one-at-a-time rule reads it. */
export interface OpenCommand {
  id: string;
  /** "queued": the file is still waiting. "running": claimed, marker down, no answer yet. */
  state: "queued" | "running";
  /** The queued file's own deadline; null for a marker, which carries none. */
  expiresAt: number | null;
  /** When it was placed (queued) or claimed (running), in milliseconds. */
  at: number;
}

/**
 * Every order in this home that has not been ANSWERED yet, with what the
 * one-at-a-time rule needs to judge it.
 *
 * QUEUED *OR* RUNNING, and the second half is the whole point. The claim is an
 * unlink, and the receipt is written only after the trade finishes — so between
 * those two moments the queue directory is empty and the old check returned
 * false while an order was mid-flight. Self-hosted that is the one-at-a-time
 * rule AND the idempotency key both going soft at once: an owner who saw
 * nothing on the tape after 25 seconds and asked again got a second file, a
 * second fill, and two positions at two prices for what they experienced as one
 * order.
 *
 * A LIST WITH DEADLINES, NOT A YES/NO. This used to be `hasPendingCommand`, a
 * boolean over filenames, so a queued file past its own deadline held the slot
 * for ever — the worker drains only while armed — while GET, reading the same
 * file's deadline, told the owner it had expired and to ask again, and asking
 * again was refused. The rule that decides lives beside that answer, in the
 * web tier's order-state.ts; this only reports what is on disk.
 *
 * THROWS when the directory cannot be listed, rather than answering "nothing
 * waiting": a read that failed is not an empty queue, and on this path the
 * difference is a second order.
 */
export function openCommands(home: string): OpenCommand[] {
  const dir = commandDir(home);
  if (!existsSync(dir)) return [];
  const out: OpenCommand[] = [];
  for (const n of readdirSync(dir)) {
    const f = path.join(dir, n);
    if (n.endsWith(".json") && !n.endsWith(".done.json")) {
      let raw = "";
      try {
        raw = readFileSync(f, "utf8");
      } catch {
        continue; // claimed between the listing and the read — the marker says so next
      }
      let at: unknown;
      try {
        at = (JSON.parse(raw) as { at?: unknown })?.at;
      } catch {
        /* unreadable: the worker drops it at the claim; until then its age is the file's */
      }
      out.push({
        id: n.slice(0, -".json".length),
        state: "queued",
        expiresAt: deadlineIn(raw),
        at: typeof at === "number" && Number.isFinite(at) ? at : mtimeOf(f),
      });
    } else if (n.endsWith(RUNNING)) {
      out.push({ id: n.slice(0, -RUNNING.length), state: "running", expiresAt: null, at: mtimeOf(f) });
    }
  }
  return out;
}

/** A file's age, or now when it vanished under us — the reading that holds a slot longer, never shorter. */
function mtimeOf(f: string): number {
  try {
    return statSync(f).mtimeMs;
  } catch {
    return Date.now();
  }
}

/**
 * Where one command is in a child's home, for the orchestrator's stale sweep.
 *
 *   "answered" — a result is waiting for the up-leg
 *   "queued"   — the file is still there: the child has NOT taken it
 *   "running"  — the child took it and put its marker down
 *   "gone"     — taken, with no marker and no answer (a crash between the
 *                claim's unlink and the marker, or a marker that failed)
 *
 * THE SWEEP CANNOT TELL THE LAST TWO FROM A FILL IN PROGRESS, and that is why
 * this exists. It used to write "never ran" onto any unanswered row past its
 * deadline, including rows a child had claimed and might be filling that
 * minute. Only "queued" lets anybody say nothing went out. Null for an id that
 * is not a plain id, which never becomes a path.
 */
export type CommandWhereabouts = "answered" | "queued" | "running" | "gone";

export function commandWhereabouts(home: string, id: string): CommandWhereabouts | null {
  if (!ID_OK.test(id)) return null;
  const dir = commandDir(home);
  // An answer outranks anything else on disk about the same id. A result that
  // lands between these reads is seen as "gone" — the direction that waits
  // rather than the one that speaks.
  if (existsSync(path.join(dir, `${id}.done.json`))) return "answered";
  if (existsSync(path.join(dir, `${id}.json`))) return "queued";
  if (existsSync(path.join(dir, `${id}${RUNNING}`))) return "running";
  return "gone";
}

/**
 * How long past its own deadline and grace a CLAIMED order may still be
 * trading, as far as the worker's own pipeline goes.
 *
 * The deadline bounds when an order STARTS, not only when it is claimed: a
 * later claim is refused as expired (isExpired), and so is an order the intent
 * queue reaches after it (unlessLate). So all this has to cover is the order's
 * own run once the queue has reached it — the reads, the quote and the
 * signature, then up to three receipt reads of two minutes each (executor.ts
 * RECEIPT_ATTEMPTS, viem's default timeout). Ten minutes covers that with room.
 * Until it has passed, nothing may say the order did not go out, and nothing
 * may free the owner's one-at-a-time slot for a second one.
 *
 * It was described as this bound while it was not one. The wait in the queue,
 * behind the tick's own intents, each able to spend the same six minutes on a
 * receipt, sat outside it — so an order could start after its deadline and
 * still be running once the sweep had freed the slot.
 *
 * Read by the orchestrator's stale sweep. The web route's slot reads the same
 * figure from web/src/lib/order-state.ts — the two processes share no module
 * the browser can load — and a test holds them equal.
 */
export const ORDER_IN_FLIGHT_MS = 10 * 60_000;

/** Suffix of the marker that says "claimed, not yet answered". */
const RUNNING = ".running";

/**
 * Mark a claimed command as RUNNING.
 *
 * Written after the unlink — which stays the claim — and removed when the
 * result is written. It exists so that "unanswered" is observable during the
 * seconds an order is actually being decided, which is exactly the window a
 * worried owner asks again in.
 */
export function markRunning(home: string, id: string): void {
  if (!ID_OK.test(id)) return;
  try {
    mkdirSync(commandDir(home), { recursive: true });
    writeFileSync(path.join(commandDir(home), `${id}${RUNNING}`), String(Date.now()), "utf8");
  } catch {
    /* a missing marker costs a duplicate-order guard, never a trade */
  }
}

/** Leave the outcome where the orchestrator will find it. */
export function writeCommandResult(home: string, r: FileCommandResult): void {
  const dir = commandDir(home);
  mkdirSync(dir, { recursive: true });
  // The answer supersedes the marker. Removed FIRST so a crash between the two
  // leaves the order looking unanswered rather than answered — the direction
  // that refuses a duplicate instead of admitting one.
  try {
    unlinkSync(path.join(dir, `${r.id}${RUNNING}`));
  } catch {
    /* never marked, or already swept */
  }
  // SWEEP THE OLD ONES. Self-hosted nothing drains these — the orchestrator is
  // the only caller of drainCommandResults and self-hosted never runs it — so
  // without this they accumulate in a home directory forever. A day is far
  // longer than any page will poll and short enough to stay tidy.
  try {
    const cutoff = Date.now() - 86_400_000;
    for (const n of readdirSync(dir)) {
      if (!n.endsWith(".done.json") || n === `${r.id}.done.json`) continue;
      const f = path.join(dir, n);
      try {
        const old = JSON.parse(readFileSync(f, "utf8")) as FileCommandResult;
        if (typeof old.at === "number" && old.at < cutoff) unlinkSync(f);
      } catch {
        unlinkSync(f);
      }
    }
  } catch {
    /* tidying is never worth losing a receipt over */
  }
  const tmp = path.join(dir, `.${r.id}.done.tmp`);
  writeFileSync(tmp, JSON.stringify(r), "utf8");
  renameSync(tmp, path.join(dir, `${r.id}.done.json`));
}

/**
 * Collect finished results. Called by the orchestrator.
 *
 * THE FILE IS NOT DELETED HERE ANY MORE, and that is the fix rather than an
 * oversight. It used to unlink every `.done.json` as it read it, before the
 * caller had written a single row — so one thrown UPDATE (the loop shares a
 * try) abandoned that result AND every remaining one, with the files already
 * gone and no way to recover them. For a probe that loses a diagnostic. For an
 * ORDER it loses the receipt for a trade that really happened, and `done_at`
 * staying NULL is now what refuses the owner their next order.
 *
 * The caller deletes each one with `dropCommandResult` after its row is safely
 * written. Unreadable files are still removed here, because nothing downstream
 * can ever do anything with them.
 */
export function drainCommandResults(home: string): FileCommandResult[] {
  const dir = commandDir(home);
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".done.json"));
  } catch {
    return [];
  }
  const out: FileCommandResult[] = [];
  for (const n of names) {
    const f = path.join(dir, n);
    try {
      const r = JSON.parse(readFileSync(f, "utf8")) as FileCommandResult;
      if (typeof r.id === "string") {
        out.push(r);
        continue;
      }
    } catch {
      /* unreadable — falls through to the unlink below */
    }
    try {
      unlinkSync(f);
    } catch {
      /* already gone */
    }
  }
  return out;
}

/** Forget a result, once its row is written. See drainCommandResults. */
export function dropCommandResult(home: string, id: string): void {
  if (!ID_OK.test(id)) return;
  try {
    unlinkSync(path.join(commandDir(home), `${id}.done.json`));
  } catch {
    /* already gone */
  }
}
