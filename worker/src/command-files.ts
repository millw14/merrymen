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

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

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
  if (!existsSync(dir)) return null;
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json") && !n.endsWith(".done.json"));
  } catch {
    return null;
  }
  if (names.length === 0) return null;

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
  if (parsed.length === 0) return null;
  // (time, id) — never time alone. Two commands really do land in the same
  // millisecond; store.ts argues this at length for the queue nothing calls,
  // and it matters more here, because for two ORDERS "which one first" is a
  // question about somebody's money.
  parsed.sort((a, b) => (a.cmd.at ?? 0) - (b.cmd.at ?? 0) || a.n.localeCompare(b.n));

  for (const { n, cmd } of parsed) {
    try {
      unlinkSync(path.join(dir, n));
    } catch {
      // Somebody else got there first — try the next one rather than giving up,
      // because "the queue is empty" and "one entry was taken" are different.
      continue;
    }
    // WE DELETED IT, SO IT IS OURS — and an expired one is ours to DROP.
    // Returned as an expiry rather than swallowed: a silently-vanished order
    // and a never-delivered one must not look the same to the person who
    // clicked, so the caller writes a result saying which.
    return cmd;
  }
  return null;
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
): { state: "queued" | "running" | "done"; result?: FileCommandResult } | null {
  if (!ID_OK.test(id)) return null;
  const dir = commandDir(home);
  try {
    const done = readFileSync(path.join(dir, `${id}.done.json`), "utf8");
    return { state: "done", result: JSON.parse(done) as FileCommandResult };
  } catch {
    /* not finished — or not ours */
  }
  return existsSync(path.join(dir, `${id}.json`)) ? { state: "queued" } : { state: "running" };
}

/** Is there an order for this home that has not been answered yet? */
export function hasPendingCommand(home: string): boolean {
  const dir = commandDir(home);
  if (!existsSync(dir)) return false;
  try {
    return readdirSync(dir).some((n) => n.endsWith(".json") && !n.endsWith(".done.json"));
  } catch {
    return false;
  }
}

/** Leave the outcome where the orchestrator will find it. */
export function writeCommandResult(home: string, r: FileCommandResult): void {
  const dir = commandDir(home);
  mkdirSync(dir, { recursive: true });
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

/** Collect and remove finished results. Called by the orchestrator. */
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
      if (typeof r.id === "string") out.push(r);
    } catch {
      /* unreadable result — dropped with the file below */
    }
    try {
      unlinkSync(f);
    } catch {
      /* already gone */
    }
  }
  return out;
}
