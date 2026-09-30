import assert from "node:assert/strict";
import test, { describe, it } from "node:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  claimCommandFile,
  commandDir,
  commandWhereabouts,
  drainCommandResults,
  dropCommandResult,
  expiredLine,
  isExpired,
  markRunning,
  openCommands,
  queuedCommandIds,
  readCommandState,
  runTickCommand,
  unlessLate,
  writeCommand,
  writeCommandResult,
} from "./command-files";

/**
 * THE SEAM THE FIRST VERSION NEVER CROSSED.
 *
 * v1 put commands in a table and had the worker poll it. Hosted, the dashboard
 * writes shared Postgres and a child reads its own sqlite — CHILD_SECRET_STRIP
 * removes DATABASE_URL on purpose — so the row and the query were in different
 * databases and nothing would ever have been claimed.
 *
 * Its test suite passed. It called enqueue and claim against ONE store handle
 * with ONE constant, which can never catch a caller using a different key or a
 * different database. These tests use real directories and a real unlink, which
 * is the actual mechanism.
 */

function tmpHome(): string {
  return mkdtempSync(path.join(os.tmpdir(), "merrymen-cmdfile-"));
}

/** What the one-at-a-time rule sees in a home, as `id:state`. */
const ids = (home: string) => openCommands(home).map((c) => `${c.id}:${c.state}`).sort();

test("a command written to a home is claimed from that home", () => {
  const home = tmpHome();
  try {
    writeCommand(home, { id: "a", kind: "selftest", at: 1 });
    const got = claimCommandFile(home);
    assert.equal(got?.id, "a");
    assert.equal(got?.kind, "selftest");
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("THE UNLINK IS THE CLAIM — a second reader gets nothing", () => {
  // This is the whole concurrency story, and it is stronger than the
  // SELECT-then-UPDATE it replaces: rm is atomic, so exactly one caller can
  // succeed, with no transaction and no shared connection.
  const home = tmpHome();
  try {
    writeCommand(home, { id: "a", kind: "selftest", at: 1 });
    assert.equal(claimCommandFile(home)?.id, "a");
    assert.equal(claimCommandFile(home), null, "a claimed command must never be handed out twice");
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("commands for one home are invisible to another", () => {
  // The tenant-isolation property, done by the filesystem rather than by a
  // WHERE clause somebody has to remember to write.
  const a = tmpHome();
  const b = tmpHome();
  try {
    writeCommand(a, { id: "mine", kind: "selftest", at: 1 });
    assert.equal(claimCommandFile(b), null);
    assert.equal(claimCommandFile(a)?.id, "mine");
  } finally {
    rmSync(a, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    rmSync(b, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("oldest first, by the timestamp INSIDE the file", () => {
  // Not by mtime: a command is copied from the shared database into a home by
  // the orchestrator, and mtime describes that copy rather than the request.
  const home = tmpHome();
  try {
    writeCommand(home, { id: "second", kind: "selftest", at: 2_000 });
    writeCommand(home, { id: "first", kind: "selftest", at: 1_000 });
    assert.equal(claimCommandFile(home)?.id, "first");
    assert.equal(claimCommandFile(home)?.id, "second");
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("an unreadable command is removed rather than blocking the queue", () => {
  // A corrupt file that stayed would wedge every later command behind it
  // forever, which is a worse failure than losing the one nobody can run.
  const home = tmpHome();
  try {
    writeCommand(home, { id: "good", kind: "selftest", at: 2 });
    writeFileSync(path.join(commandDir(home), "junk.json"), "{not json", "utf8");
    assert.equal(claimCommandFile(home)?.id, "good");
    assert.equal(
      readdirSync(commandDir(home)).some((n) => n === "junk.json"),
      false,
      "the unreadable file is gone, not skipped forever",
    );
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("results travel back and are drained exactly once", () => {
  const home = tmpHome();
  try {
    writeCommandResult(home, { id: "a", ok: true, line: "PASSED — it landed", at: 5 });
    const got = drainCommandResults(home);
    assert.equal(got.length, 1);
    assert.equal(got[0]!.id, "a");
    assert.equal(got[0]!.ok, true);
    assert.match(got[0]!.line, /PASSED/);
    // READING NO LONGER DELETES, and that is the fix rather than a regression.
    // The drain used to unlink every file as it read it, before the caller had
    // written a single row — so one thrown UPDATE (the ferry's loop shared a
    // try) abandoned that result AND every remaining one, with the files
    // already gone. For a probe that loses a diagnostic; for an ORDER it loses
    // the receipt for a trade that really happened, and an unanswered row is
    // what refuses the owner their next order.
    assert.equal(drainCommandResults(home).length, 1, "a receipt survives until its row is written");
    dropCommandResult(home, "a");
    assert.deepEqual(drainCommandResults(home), [], "and the caller drops it once the row lands");
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("a result is never mistaken for a command", () => {
  // Both live in the same directory, and `.done.json` also ends in `.json`.
  // Confusing the two would have the worker try to execute its own answer.
  const home = tmpHome();
  try {
    writeCommandResult(home, { id: "a", ok: true, line: "done", at: 5 });
    assert.equal(claimCommandFile(home), null, "a result is not a pending command");
    assert.equal(drainCommandResults(home).length, 1);
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("a half-written file is never observed — write then rename", () => {
  // The temp name is dotted and does not end in .json, so a reader scanning
  // mid-write sees nothing rather than a truncated command.
  const home = tmpHome();
  try {
    writeCommand(home, { id: "a", kind: "selftest", at: 1 });
    const names = readdirSync(commandDir(home));
    assert.deepEqual(names, ["a.json"], "no temp file left behind");
    assert.equal(names.some((n) => n.startsWith(".")), false);
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("an empty or missing home is empty, not an error", () => {
  const home = tmpHome();
  try {
    assert.equal(claimCommandFile(home), null);
    assert.deepEqual(drainCommandResults(home), []);
    assert.equal(claimCommandFile(path.join(home, "nope")), null);
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

/**
 * ── WHAT CHANGED WHEN ORDERS ARRIVED ────────────────────────────────────────
 *
 * Everything above was true for a probe. An ORDER makes three of the same
 * mechanisms load-bearing in a way a dust approve never did: a replay is a
 * second position rather than a second no-op, a stale command fills into a
 * market nobody was looking at, and the id — which is interpolated into a path
 * by the process that can see every tenant's home — becomes worth attacking.
 */

test("AN ID THAT IS NOT A PLAIN ID IS REFUSED, not sanitised", () => {
  const home = tmpHome();
  try {
    // The id becomes a FILENAME under a child's home, written by the
    // ORCHESTRATOR. `../<other-tenant>/commands/x` is cross-tenant order
    // injection past every per-tenant check there is. The web generates ids
    // server-side today and its comment gives the reason as collision — which
    // reads as a uniqueness concern and would not stop anyone adding a
    // client-supplied idempotency key.
    for (const bad of ["../escape", "a/b", "..", "x".repeat(65), "", "a.json", "nul\u0000"]) {
      assert.throws(() => writeCommand(home, { id: bad, kind: "trade", at: 1 }), /not a plain id/, `${bad} was written`);
    }
    // Refused, so nothing at all was created — not even the directory entry a
    // partially-sanitised id would have left.
    assert.deepEqual(openCommands(home), []);
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("an order carries its arguments and its expiry across the file", () => {
  const home = tmpHome();
  try {
    writeCommand(home, {
      id: "ord",
      kind: "trade",
      at: 1,
      args: { side: "buy", symbol: "TSLA", usdgAmount: 25 },
      expiresAt: 500,
    });
    const got = claimCommandFile(home);
    assert.deepEqual(got?.args, { side: "buy", symbol: "TSLA", usdgAmount: 25 });
    assert.equal(got?.expiresAt, 500);
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("AN EXPIRED ORDER IS STILL CLAIMED — it must leave a receipt, not vanish", () => {
  const home = tmpHome();
  try {
    writeCommand(home, { id: "old", kind: "trade", at: 1, expiresAt: 100 });
    const got = claimCommandFile(home);
    assert.ok(got, "an expired command must still be consumed, or it is re-read forever");
    assert.equal(isExpired(got!, 101), true);
    assert.equal(isExpired(got!, 99), false);
    // A command with no expiry never goes stale — that is the probe, and it is
    // the right answer for it.
    assert.equal(isExpired({ id: "x", kind: "selftest", at: 1 }, Date.now()), false);
    assert.equal(claimCommandFile(home), null, "and it left the queue");
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("THE FILE THAT WAS READ IS THE FILE THAT IS UNLINKED", () => {
  const home = tmpHome();
  try {
    // The claim used to delete `${cmd.id}.json` — the id from INSIDE the file —
    // and discard the name it had actually read. While writeCommand was the
    // only writer the two always agreed, so "filename == id" was a load-bearing
    // invariant that nothing stated and nothing checked. A mismatched file was
    // never removed, so it was re-claimed and re-executed on EVERY scan, and it
    // deleted a DIFFERENT pending command on the way past.
    writeCommand(home, { id: "real", kind: "selftest", at: 5 });
    writeFileSync(
      path.join(commandDir(home), "liar.json"),
      JSON.stringify({ id: "real", kind: "trade", at: 1 }),
      "utf8",
    );
    const first = claimCommandFile(home);
    assert.equal(first?.kind, "trade", "the older one is claimed first");
    assert.deepEqual(readdirSync(commandDir(home)), ["real.json"], "and the OTHER command is untouched");
    assert.equal(claimCommandFile(home)?.kind, "selftest");
    assert.deepEqual(readdirSync(commandDir(home)), []);
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("a file that parses but is the wrong shape is removed, not re-read forever", () => {
  const home = tmpHome();
  try {
    mkdirSync(commandDir(home), { recursive: true });
    writeFileSync(path.join(commandDir(home), "shape.json"), JSON.stringify({ nope: true }), "utf8");
    assert.equal(claimCommandFile(home), null);
    assert.deepEqual(readdirSync(commandDir(home)), [], "the unreadable branch already knew to unlink; this one did not");
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("SELF-HOSTED CAN TELL 'RAN' FROM 'NEVER RAN'", () => {
  const home = tmpHome();
  try {
    // There is no orchestrator self-hosted, so nothing ferries a result into a
    // table and the route answered {state:"none"} for an order that had already
    // filled — the same body it returns for one that was never queued. "Never
    // ran" and "ran, and here is the fill" rendered identically.
    assert.equal(readCommandState(home, "nope")?.state, "running", "claimed and unanswered is its own state");
    writeCommand(home, { id: "q", kind: "trade", at: 1 });
    assert.equal(readCommandState(home, "q")?.state, "queued");
    assert.deepEqual(ids(home), ["q:queued"]);
    claimCommandFile(home);
    assert.equal(readCommandState(home, "q")?.state, "running");
    assert.deepEqual(ids(home), [], "claimed and not yet marked: the window the marker exists to close");
    writeCommandResult(home, { id: "q", ok: true, line: "bought 25.00 USDG of TSLA", at: 9 });
    const done = readCommandState(home, "q");
    assert.equal(done?.state, "done");
    assert.equal(done?.result?.line, "bought 25.00 USDG of TSLA");
    // Read twice: a person refreshing a page must not consume their own receipt.
    assert.equal(readCommandState(home, "q")?.state, "done");
    // A result is not a pending command, so it never blocks the next order.
    assert.deepEqual(ids(home), []);
    // And an id that could be a path is not read either.
    assert.equal(readCommandState(home, "../secret"), null);
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("old receipts are swept, because self-hosted nothing drains them", () => {
  const home = tmpHome();
  try {
    writeCommandResult(home, { id: "ancient", ok: true, line: "done", at: Date.now() - 2 * 86_400_000 });
    writeCommandResult(home, { id: "fresh", ok: true, line: "done", at: Date.now() });
    const left = readdirSync(commandDir(home)).sort();
    assert.deepEqual(left, ["fresh.done.json"], "a home must not accumulate receipts forever");
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("CLAIMED IS NOT ANSWERED — a running order still reads as waiting", () => {
  const home = tmpHome();
  try {
    // Self-hosted, the claim is an unlink and the receipt lands only when the
    // trade finishes, so between them the queue directory was EMPTY and
    // the pending check said false while an order was mid-flight. That is the
    // one-at-a-time rule and the idempotency key both going soft at once: an
    // owner who saw nothing on the tape after 25 seconds and asked again got a
    // second file, a second fill, and two positions for one intention.
    writeCommand(home, { id: "ord", kind: "trade", at: 1 });
    assert.deepEqual(ids(home), ["ord:queued"]);
    const cmd = claimCommandFile(home);
    assert.equal(cmd?.id, "ord");
    assert.deepEqual(ids(home), [], "the file is gone — this is the window that was open");
    markRunning(home, "ord");
    assert.deepEqual(ids(home), ["ord:running"], "and now it reads as what it is: still unanswered");
    writeCommandResult(home, { id: "ord", ok: true, line: "bought", at: 9 });
    assert.deepEqual(ids(home), [], "answered, so the next order may go");
    // The marker is gone too — it must not outlive the thing it describes.
    assert.equal(readdirSync(commandDir(home)).some((n) => n.endsWith(".running")), false);
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("and a marker cannot be written for an id that is not a plain id", () => {
  // Same boundary as writeCommand: this one joins a path too.
  const home = tmpHome();
  try {
    markRunning(home, "../escape");
    assert.equal(readdirSync(home).includes("escape"), false);
    assert.deepEqual(openCommands(home), []);
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("THE ONE-AT-A-TIME RULE GETS DEADLINES, not a yes/no", () => {
  // The old check was a boolean over filenames, so a queued file past its own
  // deadline held the slot for as long as the worker stayed unarmed, while GET
  // read that same file's deadline and told the owner to ask again. The rule
  // that decides lives beside that answer (web/src/lib/order-state.ts); what
  // this owes it is the deadline and the age, read from disk.
  const home = tmpHome();
  try {
    writeCommand(home, { id: "q", kind: "trade", at: 1_000, args: { side: "buy" }, expiresAt: 5_000 });
    writeCommand(home, { id: "probe", kind: "selftest", at: 2_000 });
    markRunning(home, "r");
    const before = Date.now();
    const open = Object.fromEntries(openCommands(home).map((c) => [c.id, c]));
    assert.deepEqual(open.q, { id: "q", state: "queued", expiresAt: 5_000, at: 1_000 });
    assert.deepEqual(open.probe, { id: "probe", state: "queued", expiresAt: null, at: 2_000 }, "no deadline is null, never 0");
    assert.equal(open.r?.state, "running");
    assert.equal(open.r?.expiresAt, null, "a marker carries no deadline");
    assert.ok(Math.abs(open.r!.at - before) < 60_000, "its age is when it was claimed");
    // Receipts and temp files are not orders.
    writeCommandResult(home, { id: "done", ok: true, line: "bought", at: 9 });
    assert.deepEqual(ids(home), ["probe:queued", "q:queued", "r:running"]);
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("an unlistable queue THROWS — a read that failed is not an empty queue", () => {
  // The boolean answered false on any error, which on this path is a second
  // order admitted beside the first.
  const home = tmpHome();
  try {
    writeFileSync(path.join(home, "commands"), "not a directory", "utf8");
    assert.throws(() => openCommands(home));
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("a queued file's deadline comes back WITH its state, from one read", () => {
  const home = tmpHome();
  try {
    writeCommand(home, { id: "q", kind: "trade", at: 1, expiresAt: 777 });
    assert.deepEqual(readCommandState(home, "q"), { state: "queued", expiresAt: 777 });
    writeCommand(home, { id: "p", kind: "selftest", at: 1 });
    assert.deepEqual(readCommandState(home, "p"), { state: "queued", expiresAt: null });
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("WHERE AN ORDER IS, as the orchestrator's sweep must know it before it speaks", () => {
  // The sweep wrote "never ran" onto any unanswered row past its deadline,
  // including rows a child had claimed and might be filling that minute. Only
  // "queued" lets anybody say nothing went out.
  const home = tmpHome();
  try {
    assert.equal(commandWhereabouts(home, "o"), "gone", "nothing on disk at all");
    writeCommand(home, { id: "o", kind: "trade", at: 1, expiresAt: 5 });
    assert.equal(commandWhereabouts(home, "o"), "queued");
    claimCommandFile(home);
    assert.equal(commandWhereabouts(home, "o"), "gone", "claimed, and no marker yet: taken, not unsent");
    markRunning(home, "o");
    assert.equal(commandWhereabouts(home, "o"), "running");
    writeCommandResult(home, { id: "o", ok: true, line: "bought", at: 9 });
    assert.equal(commandWhereabouts(home, "o"), "answered");
    assert.equal(commandWhereabouts(home, "../o"), null, "an id that could be a path is never looked up");
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

/**
 * ONE TICK DRAINS THE DEAD AND RUNS AT MOST ONE LIVE ORDER.
 *
 * The worker took one command per tick and an expired one cost that tick, so a
 * queue of stale files — an owner queueing every seven minutes while unarmed,
 * or a hosted down-leg delivering rows after an orchestrator outage — was paid
 * off one tick at a time, oldest first. With five of them ahead of it a fresh
 * order expired before it was reached: a true message about a lost order.
 *
 * Driven through the drain the worker's tick calls, against a real home.
 */
describe("the tick's drain", () => {
  const NOW = 1_800_000_000_000;
  const order = (id: string, at: number, expiresAt: number) =>
    ({ id, kind: "trade", at, args: { side: "buy", symbol: "TSLA", usdgAmount: 25 }, expiresAt }) as const;
  const receipt = (home: string, id: string) => readCommandState(home, id);

  /** A tick: a fixed clock, and a record of everything run and told. */
  const tick = (home: string, over: { run?: (cmd: { id: string }) => Promise<{ ok: boolean; line: string }>; told?: (id: string) => void } = {}) => {
    const ran: string[] = [];
    const told: string[] = [];
    const done = runTickCommand(home, {
      now: () => NOW,
      run: async (cmd) => {
        ran.push(cmd.id);
        // The marker is down while the order is being decided, as before.
        assert.equal(commandWhereabouts(home, cmd.id), "running");
        return over.run ? over.run(cmd) : { ok: true, line: `bought 25.00 USDG of TSLA (${cmd.id})` };
      },
      told: async (cmd, outcome) => {
        told.push(`${cmd.id}:${outcome.ok ? "ok" : "err"}`);
        over.told?.(cmd.id);
      },
    });
    return { done, ran, told };
  };

  it("FIVE EXPIRED ORDERS AHEAD OF A FRESH ONE: the fresh one runs THIS tick, and each expired one is answered", async () => {
    const home = tmpHome();
    try {
      for (let i = 0; i < 5; i += 1) writeCommand(home, order(`stale${i}`, NOW - 60 * 60_000 + i, NOW - 50 * 60_000 + i));
      writeCommand(home, order("fresh", NOW - 1_000, NOW + 8 * 60_000));
      const t = tick(home);
      await t.done;
      assert.deepEqual(t.ran, ["fresh"], "the one live order ran, and nothing else did");
      for (let i = 0; i < 5; i += 1) {
        const r = receipt(home, `stale${i}`);
        assert.equal(r?.state, "done", `stale${i} has its receipt`);
        assert.equal(r?.result?.ok, false);
        assert.match(r?.result?.line ?? "", /^expired/);
        assert.match(r?.result?.line ?? "", /Nothing was sent/);
      }
      assert.equal(receipt(home, "fresh")?.result?.line, "bought 25.00 USDG of TSLA (fresh)");
      assert.deepEqual(t.told, ["stale0:err", "stale1:err", "stale2:err", "stale3:err", "stale4:err", "fresh:ok"], "the owner is told about every one, oldest first");
      assert.deepEqual(openCommands(home), [], "nothing is left waiting");
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("AT MOST ONE LIVE ORDER A TICK — the next one waits, queued, for the next tick", async () => {
    const home = tmpHome();
    try {
      writeCommand(home, order("dead", NOW - 20 * 60_000, NOW - 10 * 60_000));
      writeCommand(home, order("first", NOW - 2_000, NOW + 8 * 60_000));
      writeCommand(home, order("second", NOW - 1_000, NOW + 8 * 60_000));
      const a = tick(home);
      await a.done;
      assert.deepEqual(a.ran, ["first"]);
      assert.equal(receipt(home, "dead")?.state, "done");
      assert.equal(receipt(home, "second")?.state, "queued", "untouched: still the owner's, still claimable");
      const b = tick(home);
      await b.done;
      assert.deepEqual(b.ran, ["second"]);
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("an expired order is never handed to run, not even when it is the only one", async () => {
    const home = tmpHome();
    try {
      writeCommand(home, order("dead", NOW - 20 * 60_000, NOW - 1));
      const t = tick(home);
      await t.done;
      assert.deepEqual(t.ran, []);
      assert.match(receipt(home, "dead")?.result?.line ?? "", /Nothing was sent/);
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("A LIVE ORDER THAT COMES FIRST IS THE TICK'S — expired ones behind it wait rather than be claimed beside it", async () => {
    // Nothing after the live order is touched: the drain stops at it.
    const home = tmpHome();
    try {
      writeCommand(home, order("live", NOW - 5_000, NOW + 8 * 60_000));
      writeCommand(home, order("dead", NOW - 1_000, NOW - 1));
      const t = tick(home);
      await t.done;
      assert.deepEqual(t.ran, ["live"]);
      assert.equal(receipt(home, "dead")?.state, "queued");
      await tick(home).done;
      assert.equal(receipt(home, "dead")?.state, "done", "and it is answered on the next one");
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("THE CLAIM IS STILL THE UNLINK: an order another reader took mid-drain is not run here", async () => {
    // The drain lists once and claims as it goes, so a file can vanish between
    // the listing and its turn. It is somebody else's then, never ours too.
    const home = tmpHome();
    try {
      writeCommand(home, order("dead", NOW - 20 * 60_000, NOW - 1));
      writeCommand(home, order("live", NOW - 1_000, NOW + 8 * 60_000));
      const t = tick(home, {
        told: (id) => {
          if (id === "dead") assert.ok(claimCommandFile(home)?.id === "live", "the other reader takes it");
        },
      });
      await t.done;
      assert.deepEqual(t.ran, [], "taken elsewhere, so not run here as well");
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("a command with no deadline is live, however old — as isExpired has always said", async () => {
    const home = tmpHome();
    try {
      writeCommand(home, { id: "probe", kind: "selftest", at: 1 });
      const t = tick(home);
      await t.done;
      assert.deepEqual(t.ran, ["probe"]);
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("an empty or missing queue is a quiet tick", async () => {
    const home = tmpHome();
    try {
      const t = tick(home);
      await t.done;
      assert.deepEqual([t.ran, t.told], [[], []]);
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});

/**
 * THE DEADLINE BOUNDS WHEN AN ORDER STARTS, NOT ONLY WHEN IT IS CLAIMED.
 *
 * After the claim, an order waits on a curve lookup and a decision row and
 * then joins the intent queue behind the tick's own intents, each of which
 * can wait minutes on its receipt. Nothing re-read the deadline in there, so an
 * order could START after it — filling into the very market the expiry exists
 * to refuse — and still be trading after the sweep had freed the owner's slot.
 *
 * The gate the queue's step runs, driven through a queue of the same shape as
 * the worker's (a promise chain) with a clock the test moves.
 */
describe("the order's deadline, at the front of the queue", () => {
  const DEADLINE = 1_800_000_000_000;
  /** A serialising chain, as index.ts keeps its intent queue. */
  const queue = () => {
    let chain: Promise<unknown> = Promise.resolve();
    return <T>(step: () => Promise<T>): Promise<T> => {
      const run = chain.then(step, step);
      chain = run.then(
        () => {},
        () => {},
      );
      return run;
    };
  };

  it("AN ORDER THAT REACHES THE FRONT AFTER ITS DEADLINE IS NOT RUN, and the owner is told so", async () => {
    let clock = DEADLINE - 30_000; // claimed, and handed to the queue, in time
    const enqueue = queue();
    let sent = 0;
    // The tick's own intent is ahead of it and waits out the order's window.
    const ahead = enqueue(async () => {
      await Promise.resolve();
      clock = DEADLINE + 3 * 60_000;
    });
    const order = enqueue(() =>
      unlessLate(DEADLINE, () => clock, async () => {
        sent += 1;
        return { status: "landed" as const };
      }),
    );
    await ahead;
    const r = await order;
    assert.equal(sent, 0, "nothing was sent");
    assert.deepEqual(Object.keys(r).sort(), ["line", "status"]);
    assert.equal(r.status, "late");
    assert.match((r as { line: string }).line, /^expired — this order reached the front of my trade queue 3 min after its window closed/);
    assert.match((r as { line: string }).line, /Nothing was sent/);
  });

  it("reached in time, it runs, and its own verdict comes back untouched", async () => {
    let clock = DEADLINE - 30_000;
    const enqueue = queue();
    void enqueue(async () => {
      clock = DEADLINE - 1_000;
    });
    const r = await enqueue(() => unlessLate(DEADLINE, () => clock, async () => ({ status: "landed" as const })));
    assert.deepEqual(r, { status: "landed" });
  });

  it("AT the deadline it still runs — the same edge isExpired draws at the claim", async () => {
    let ran = false;
    await unlessLate(DEADLINE, () => DEADLINE, async () => {
      ran = true;
    });
    assert.equal(ran, true);
    assert.equal(isExpired({ id: "o", kind: "trade", at: 1, expiresAt: DEADLINE }, DEADLINE), false);
    const late = await unlessLate(DEADLINE, () => DEADLINE + 1, async () => "ran");
    assert.notEqual(late, "ran");
  });

  it("with no deadline — Telegram, the Brain, a legacy command — nothing is refused, however long it queued", async () => {
    const r = await unlessLate(undefined, () => DEADLINE + 24 * 3_600_000, async () => "ran");
    assert.equal(r, "ran");
  });

  it("the clock is read when the queue reaches the order, not when it joined", async () => {
    let reads = 0;
    let clock = DEADLINE - 1;
    const enqueue = queue();
    const ahead = enqueue(async () => {
      clock = DEADLINE + 1;
    });
    const r = enqueue(() =>
      unlessLate(DEADLINE, () => (reads += 1, clock), async () => "ran"),
    );
    await ahead;
    assert.notEqual(await r, "ran");
    assert.ok(reads >= 1);
  });
});

describe("the expiry sentence", () => {
  it("says when, and says nothing was sent", () => {
    const at = 1_800_000_000_000;
    assert.match(expiredLine(at, at + 45_000, "claim"), /^expired — I picked this order up 45s after its window closed/);
    assert.match(expiredLine(at, at + 50 * 60_000, "claim"), /50 min after/);
    assert.match(expiredLine(at, at + 5 * 3_600_000, "queue"), /reached the front of my trade queue 5 h after/);
    for (const where of ["claim", "queue"] as const) {
      assert.match(expiredLine(at, at + 1_000, where), /I will not fill it into a different market/);
      assert.match(expiredLine(at, at + 1_000, where), /Nothing was sent\. Ask again if you still want it\.$/);
    }
  });
});

/**
 * THE RECEIPT RIDES THE RESULT FILE, beside the sentence and never instead of it.
 *
 * `{ ok, line }` is what every reader already understands, and an old reader
 * must go on rendering `line` untouched. The receipt is the same verdict as
 * data, so the chat can template "[Buy] $5.00 CASHCAT · Filled" from ledger
 * fields instead of from prose — which is how `ok` once came to be read off an
 * emoji.
 */
describe("the receipt, on its way back", () => {
  const NOW = 1_800_000_000_000;
  const filled = {
    status: "filled" as const,
    side: "buy" as const,
    symbol: "TSLA",
    token: "0x00000000000000000000000000000000000075a1",
    usdgActual: 25,
    txHash: "0x" + "cd".repeat(32),
    rejectRule: null,
  };

  it("A RUN THAT RETURNS A RECEIPT LEAVES IT IN THE RESULT, beside the line it came with", async () => {
    const home = tmpHome();
    try {
      writeCommand(home, { id: "o1", kind: "trade", at: NOW - 1_000, args: { side: "buy", symbol: "TSLA", usdgAmount: 25 }, expiresAt: NOW + 60_000 });
      await runTickCommand(home, {
        now: () => NOW,
        run: async () => ({ ok: true, line: "✅ bought 25.00 USDG of TSLA. It is on your tape.", receipt: filled }),
        told: async () => {},
      });
      const st = readCommandState(home, "o1");
      assert.equal(st?.state, "done");
      assert.equal(st?.result?.line, "✅ bought 25.00 USDG of TSLA. It is on your tape.", "the sentence is untouched");
      assert.deepEqual(st?.result?.receipt, filled);
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("and a run with none leaves no receipt key at all — a probe is not an order", async () => {
    const home = tmpHome();
    try {
      writeCommand(home, { id: "p1", kind: "selftest", at: NOW - 1_000 });
      await runTickCommand(home, { now: () => NOW, run: async () => ({ ok: true, line: "PASSED" }), told: async () => {} });
      const st = readCommandState(home, "p1");
      assert.equal(st?.result?.line, "PASSED");
      assert.equal(Object.hasOwn(st?.result ?? {}, "receipt"), false);
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("AN ORDER EXPIRED AT THE CLAIM IS ANSWERED WITH THE RECEIPT ITS OWNER'S HOOK BUILDS, and is still never run", async () => {
    const home = tmpHome();
    try {
      writeCommand(home, { id: "late1", kind: "trade", at: NOW - 20 * 60_000, args: { side: "sell", symbol: "NVDA", usdgAmount: 5 }, expiresAt: NOW - 1 });
      const asked: string[] = [];
      let ran = 0;
      await runTickCommand(home, {
        now: () => NOW,
        run: async () => {
          ran += 1;
          return { ok: true, line: "ran" };
        },
        told: async () => {},
        expiredReceipt: (cmd) => {
          asked.push(`${cmd.id}:${String(cmd.args?.symbol)}`);
          return { status: "expired", side: "sell", symbol: "NVDA", token: null, usdgActual: null, txHash: null, rejectRule: null };
        },
      });
      assert.equal(ran, 0);
      assert.deepEqual(asked, ["late1:NVDA"], "the hook sees the command it is answering");
      const st = readCommandState(home, "late1");
      assert.match(st?.result?.line ?? "", /^expired/);
      assert.equal(st?.result?.receipt?.status, "expired");
      assert.equal(st?.result?.receipt?.symbol, "NVDA");
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("without a hook an expired command is answered exactly as before", async () => {
    const home = tmpHome();
    try {
      writeCommand(home, { id: "late2", kind: "trade", at: NOW - 20 * 60_000, expiresAt: NOW - 1 });
      await runTickCommand(home, { now: () => NOW, run: async () => ({ ok: true, line: "ran" }), told: async () => {} });
      const st = readCommandState(home, "late2");
      assert.match(st?.result?.line ?? "", /^expired/);
      assert.equal(Object.hasOwn(st?.result ?? {}, "receipt"), false);
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});

/**
 * WHAT IS WAITING, WITHOUT TAKING ANY OF IT.
 *
 * The child's between-ticks watcher asks this every few seconds, so it must be
 * a listing and nothing more: no parse, no claim, no marker. The claim stays
 * the unlink inside the tick's drain, where one-at-a-time is enforced.
 */
describe("the queue, as a watcher sees it", () => {
  it("LISTS THE QUEUED IDS and nothing that is answered, running or half-written", () => {
    const home = tmpHome();
    try {
      writeCommand(home, { id: "q1", kind: "trade", at: 1 });
      writeCommand(home, { id: "q2", kind: "selftest", at: 2 });
      writeCommand(home, { id: "r1", kind: "trade", at: 3 });
      markRunning(home, "r1");
      claimCommandFile(home); // takes q1 — oldest — which is gone from the queue now
      writeCommandResult(home, { id: "d1", ok: true, line: "done", at: 4 });
      writeFileSync(path.join(commandDir(home), ".q9.tmp"), "{", "utf8");
      assert.deepEqual(queuedCommandIds(home).sort(), ["q2", "r1"]);
      assert.equal(readCommandState(home, "q2")?.state, "queued", "and listing claimed nothing");
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("an empty or missing queue is an empty list, never a throw", () => {
    const home = tmpHome();
    try {
      assert.deepEqual(queuedCommandIds(home), []);
      mkdirSync(commandDir(home), { recursive: true });
      assert.deepEqual(queuedCommandIds(home), []);
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});
