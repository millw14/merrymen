/**
 * THE HOSTED HALF OF THE COMMAND CHANNEL, WHICH HAD NO TEST AT ALL.
 *
 * `agent-commands.integration.test.ts` covers the queue helpers in store.ts at
 * length — ordering, tie-breaks, at-most-once — and those helpers have NO
 * production caller. The path the fleet actually uses is three hand-written
 * statements split across the web tier's route handlers and this file, and
 * nothing crossed it.
 *
 * That is how the defect below survived to production: the tested code used ONE
 * constant for both sides of a join whose entire difficulty is that the two
 * sides are different addresses. The web enqueues under the ERC-4337 SMART
 * ACCOUNT (`agent_id` means that everywhere in this schema); the ferry used to
 * bind the SIWE WALLET, because that is what `children` is keyed by.
 * grant-store.ts says the two "can never be equal" — the owner key is generated
 * in the browser — and agent-for.ts exists because a route that compared them
 * "matched zero rows for every hosted user" and failed closed.
 *
 * So every test here uses a tenant and an account that DO NOT MATCH. A test
 * that passes the same address twice proves nothing about this function.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";

import { commandDir, writeCommandResult } from "./command-files";
import { ferryForChild } from "./orchestrator";
import { wrapSqlite } from "./db";

/** A tenant and its account. Deliberately, obviously, different addresses. */
const TENANT = "0x1111111111111111111111111111111111111111";
const ACCOUNT = "0x2222222222222222222222222222222222222222";

const homes: string[] = [];
const newHome = () => {
  const h = mkdtempSync(path.join(tmpdir(), "merry-ferry-"));
  homes.push(h);
  return h;
};

function newDb() {
  const raw = new DatabaseSync(":memory:");
  raw.exec(`CREATE TABLE agent_commands (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, kind TEXT NOT NULL, args TEXT,
    created_at INTEGER NOT NULL, claimed_at INTEGER, done_at INTEGER, result TEXT)`);
  return { raw, db: wrapSqlite(raw) };
}

const insert = (
  raw: DatabaseSync,
  r: { id: string; agent_id?: string; kind?: string; args?: string | null; created_at?: number },
) =>
  raw
    .prepare("INSERT INTO agent_commands (id, agent_id, kind, args, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(r.id, r.agent_id ?? ACCOUNT, r.kind ?? "trade", r.args ?? null, r.created_at ?? 1_000);

const files = (home: string) => {
  try {
    return readdirSync(commandDir(home)).sort();
  } catch {
    return [];
  }
};

const opts = (home: string) => ({ home, smartAccount: ACCOUNT, tag: TENANT });

after(() => {
  for (const h of homes) {
    try {
      rmSync(h, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

describe("the identity the ferry joins on", () => {
  it("DELIVERS A COMMAND ENQUEUED UNDER THE SMART ACCOUNT", async () => {
    // The bug, stated as a passing test. This is what the web writes.
    const { raw, db } = newDb();
    const home = newHome();
    insert(raw, { id: "cmd-a" });
    await ferryForChild(db, opts(home));
    assert.deepEqual(files(home), ["cmd-a.json"], "a queued order must reach the child that was asked");
  });

  it("and NEVER one enqueued under the tenant wallet", async () => {
    // The other direction, which is what stops somebody "fixing" this by
    // making the web write the tenant instead: the two ends would then agree
    // with each other and disagree with every other table in the schema.
    const { raw, db } = newDb();
    const home = newHome();
    insert(raw, { id: "cmd-b", agent_id: TENANT });
    await ferryForChild(db, opts(home));
    assert.deepEqual(files(home), [], "agent_id is the smart account everywhere in this schema");
  });

  it("and one tenant's command never reaches another tenant's home", async () => {
    const { raw, db } = newDb();
    const home = newHome();
    insert(raw, { id: "cmd-c", agent_id: "0x3333333333333333333333333333333333333333" });
    await ferryForChild(db, opts(home));
    assert.deepEqual(files(home), []);
  });
});

describe("at most once, and in the direction that matters", () => {
  it("A ROW IS CLAIMED BEFORE ITS FILE IS WRITTEN", async () => {
    // Two writes to two systems with no transaction across them, so one order
    // has to be chosen. Writing first meant a crash — or a thrown UPDATE, whose
    // catch is a comment — re-delivered `<id>.json` into a home that had
    // already claimed, run and answered it. For a probe that is a second dust
    // approve; for a BUY it is a second position at a second price with a
    // second gas bill, and a ledger showing two fills for one instruction.
    const { raw, db } = newDb();
    const home = newHome();
    insert(raw, { id: "cmd-d" });
    await ferryForChild(db, opts(home));
    const claimed = raw.prepare("SELECT claimed_at FROM agent_commands WHERE id = ?").get("cmd-d") as {
      claimed_at: number | null;
    };
    assert.ok(claimed.claimed_at, "delivered means claimed");

    // The child takes it, as it would. A second pass must not put it back.
    unlinkSync(path.join(commandDir(home), "cmd-d.json"));
    await ferryForChild(db, opts(home));
    assert.deepEqual(files(home), [], "a delivered command must never be delivered twice");
  });

  it("and a row another replica already claimed is not written at all", async () => {
    const { raw, db } = newDb();
    const home = newHome();
    insert(raw, { id: "cmd-e" });
    raw.prepare("UPDATE agent_commands SET claimed_at = 5 WHERE id = ?").run("cmd-e");
    await ferryForChild(db, opts(home));
    assert.deepEqual(files(home), []);
  });
});

describe("what an order carries with it", () => {
  it("THE ARGUMENTS SURVIVE THE CROSSING", async () => {
    const { raw, db } = newDb();
    const home = newHome();
    insert(raw, { id: "cmd-f", args: JSON.stringify({ side: "buy", symbol: "TSLA", usdgAmount: 25 }) });
    await ferryForChild(db, opts(home));
    const cmd = JSON.parse(readFileSync(path.join(commandDir(home), "cmd-f.json"), "utf8"));
    assert.deepEqual(cmd.args, { side: "buy", symbol: "TSLA", usdgAmount: 25 });
  });

  it("and the EXPIRY is lifted out of them, because it is not part of the order", async () => {
    // An order that waited too long is not the order that was placed. The
    // worker checks this before it looks at a single argument.
    const { raw, db } = newDb();
    const home = newHome();
    insert(raw, { id: "cmd-g", args: JSON.stringify({ side: "sell", symbol: "GME", usdgAmount: 5, expiresAt: 99 }) });
    await ferryForChild(db, opts(home));
    const cmd = JSON.parse(readFileSync(path.join(commandDir(home), "cmd-g.json"), "utf8"));
    assert.equal(cmd.expiresAt, 99);
    assert.deepEqual(cmd.args, { side: "sell", symbol: "GME", usdgAmount: 5 });
  });

  it("a nested or non-scalar argument is dropped rather than forwarded", async () => {
    // The orchestrator is the one process that can see every tenant's home, so
    // the less it believes about a payload the better. It is not the validator
    // and must not become one — but it must not widen the shape either.
    const { raw, db } = newDb();
    const home = newHome();
    insert(raw, { id: "cmd-h", args: JSON.stringify({ side: "buy", evil: { a: 1 }, list: [1, 2] }) });
    await ferryForChild(db, opts(home));
    const cmd = JSON.parse(readFileSync(path.join(commandDir(home), "cmd-h.json"), "utf8"));
    assert.deepEqual(cmd.args, { side: "buy" });
  });

  it("and MALFORMED args become an empty bag, never a stalled ferry", async () => {
    // A refusal by name at the dispatch is a sentence somebody can read. A
    // throw here would stop the pass for every tenant behind it.
    const { raw, db } = newDb();
    const home = newHome();
    insert(raw, { id: "cmd-i", args: "{not json" });
    await ferryForChild(db, opts(home));
    assert.deepEqual(files(home), ["cmd-i.json"]);
    const cmd = JSON.parse(readFileSync(path.join(commandDir(home), "cmd-i.json"), "utf8"));
    assert.equal(cmd.args, undefined);
  });
});

describe("the way back", () => {
  it("A RESULT BECOMES A ROW, and the row is what the dashboard reads", async () => {
    const { raw, db } = newDb();
    const home = newHome();
    insert(raw, { id: "cmd-j" });
    await ferryForChild(db, opts(home));
    writeCommandResult(home, { id: "cmd-j", ok: true, line: "bought 25.00 USDG of TSLA", at: 7 });
    await ferryForChild(db, opts(home));
    const row = raw.prepare("SELECT done_at, result FROM agent_commands WHERE id = ?").get("cmd-j") as {
      done_at: number | null;
      result: string | null;
    };
    assert.ok(row.done_at, "a finished order must not still read as running");
    assert.equal(row.result, "bought 25.00 USDG of TSLA");
  });

  it("and the result is bounded, the way every status column here is", async () => {
    const { raw, db } = newDb();
    const home = newHome();
    insert(raw, { id: "cmd-k" });
    await ferryForChild(db, opts(home));
    writeCommandResult(home, { id: "cmd-k", ok: false, line: "x".repeat(5_000), at: 7 });
    await ferryForChild(db, opts(home));
    const row = raw.prepare("SELECT result FROM agent_commands WHERE id = ?").get("cmd-k") as { result: string };
    assert.ok(row.result.length <= 500, "an unbounded string in a status column is how cardinality explodes");
  });
});

describe("what cannot become a path", () => {
  it("AN ID THAT IS NOT A PLAIN ID IS REFUSED, NOT SANITISED", async () => {
    // The id becomes a FILENAME under a child's home, in the ORCHESTRATOR —
    // the one process that can see every tenant's home. `../<other>/commands/x`
    // is cross-tenant order injection past every per-tenant check there is.
    // The web generates ids server-side today, and its comment gives the reason
    // as collision, which would not stop anyone adding an idempotency key.
    const { raw, db } = newDb();
    const home = newHome();
    insert(raw, { id: "../escape" });
    insert(raw, { id: "cmd-l", created_at: 2_000 });
    await ferryForChild(db, opts(home));
    // The bad one throws inside the pass; the point is that nothing was written
    // outside the commands directory of this home.
    assert.ok(!files(home).some((n) => n.includes("escape")));
    assert.ok(!readdirSync(home).includes("escape"));
  });
});

describe("the shape of the queue itself", () => {
  it("OLDEST FIRST, AND TIES BROKEN THE SAME WAY EVERY TIME", async () => {
    // Two commands really do land in the same millisecond — CI found that on a
    // faster machine than the one that wrote the queue. Neither backend has a
    // portable insertion-order tiebreak, so the id breaks it: arbitrary, but
    // CONSISTENT. For two ORDERS, "which one first" is a question about
    // somebody's money.
    const { raw, db } = newDb();
    const home = newHome();
    for (const id of ["tie-c", "tie-a", "tie-b"]) insert(raw, { id, created_at: 1_800_000_000_000 });
    insert(raw, { id: "earlier", created_at: 1 });
    await ferryForChild(db, opts(home));
    const written = files(home).map((n) => n.replace(".json", ""));
    assert.deepEqual(written.sort(), ["earlier", "tie-a", "tie-b", "tie-c"]);
    const order = raw
      .prepare("SELECT id FROM agent_commands ORDER BY claimed_at ASC, id ASC")
      .all() as { id: string }[];
    assert.equal(order[0]!.id, "earlier", "the oldest is claimed first");
  });

  it("and no more than five cross in one pass", async () => {
    // The child runs one per tick. A pass that emptied an unbounded queue into
    // a home would just move the backlog somewhere with no view of it.
    const { raw, db } = newDb();
    const home = newHome();
    for (let i = 0; i < 9; i += 1) insert(raw, { id: `many-${i}`, created_at: 1_000 + i });
    await ferryForChild(db, opts(home));
    assert.equal(files(home).length, 5);
  });
});
