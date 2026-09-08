import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  claimCommandFile,
  commandDir,
  drainCommandResults,
  hasPendingCommand,
  isExpired,
  readCommandState,
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

test("a command written to a home is claimed from that home", () => {
  const home = tmpHome();
  try {
    writeCommand(home, { id: "a", kind: "selftest", at: 1 });
    const got = claimCommandFile(home);
    assert.equal(got?.id, "a");
    assert.equal(got?.kind, "selftest");
  } finally {
    rmSync(home, { recursive: true, force: true });
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
    rmSync(home, { recursive: true, force: true });
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
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
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
    rmSync(home, { recursive: true, force: true });
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
    rmSync(home, { recursive: true, force: true });
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
    assert.deepEqual(drainCommandResults(home), [], "draining removes them");
  } finally {
    rmSync(home, { recursive: true, force: true });
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
    rmSync(home, { recursive: true, force: true });
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
    rmSync(home, { recursive: true, force: true });
  }
});

test("an empty or missing home is empty, not an error", () => {
  const home = tmpHome();
  try {
    assert.equal(claimCommandFile(home), null);
    assert.deepEqual(drainCommandResults(home), []);
    assert.equal(claimCommandFile(path.join(home, "nope")), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
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
    assert.equal(hasPendingCommand(home), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
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
    rmSync(home, { recursive: true, force: true });
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
    rmSync(home, { recursive: true, force: true });
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
    rmSync(home, { recursive: true, force: true });
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
    rmSync(home, { recursive: true, force: true });
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
    assert.equal(hasPendingCommand(home), true);
    claimCommandFile(home);
    assert.equal(readCommandState(home, "q")?.state, "running");
    assert.equal(hasPendingCommand(home), false, "a claimed order is no longer waiting");
    writeCommandResult(home, { id: "q", ok: true, line: "bought 25.00 USDG of TSLA", at: 9 });
    const done = readCommandState(home, "q");
    assert.equal(done?.state, "done");
    assert.equal(done?.result?.line, "bought 25.00 USDG of TSLA");
    // Read twice: a person refreshing a page must not consume their own receipt.
    assert.equal(readCommandState(home, "q")?.state, "done");
    // A result is not a pending command, so it never blocks the next order.
    assert.equal(hasPendingCommand(home), false);
    // And an id that could be a path is not read either.
    assert.equal(readCommandState(home, "../secret"), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
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
    rmSync(home, { recursive: true, force: true });
  }
});
