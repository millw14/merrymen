/**
 * THE FERRY MAY NOT CLOSE AN ORDER THE CHILD CAN STILL FILL.
 *
 * The ferry closed any unanswered trade row older than a fixed seven minutes,
 * writing "never ran" into it. The order's own window is max(5 min, 2 ticks +
 * 15 s) — 8m15s at the hosted 240 s tick — and the child enforces THAT at the
 * claim. So at the hosted cadence a row could be closed as "never ran" while
 * the child was still entitled to fill it, and the owner's card, reading
 * `done`, repeated the claim.
 *
 * Closing the row also freed the one-at-a-time slot early, so a second order
 * could be accepted while the first was still live — two in flight for what
 * the route promises is one.
 *
 * THEN THE SAME SENTENCE, ONE DEADLINE LATER. Reading the order's own window
 * moved the false "never ran" to deadline + grace, but still wrote it onto rows
 * the child had already CLAIMED — and a claimed order can still be waiting on
 * its receipt (three reads of up to two minutes each, executor.ts) when the
 * grace runs out. So the sweep now looks in the child's home before it says
 * anything: a file still queued is an order nobody took, and the child refuses
 * it at the claim from here on; a `.running` marker, or the file gone with no
 * answer, is an order somebody did take, and nothing here knows how it went.
 *
 * Driven against a real sqlite table and a real home through `ferryForChild`,
 * the function the orchestrator actually runs. Times are relative to the real
 * clock, which is the one the sweep reads.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";

import { ORDER_IN_FLIGHT_MS as SWEEP_IN_FLIGHT_MS, markRunning, writeCommand, writeCommandResult } from "./command-files";
import { wrapSqlite } from "./db";
import { COMMAND_RECEIPT_DDL, ferryForChild, missingReceiptColumn } from "./orchestrator";
import { ORDER_IN_FLIGHT_MS, ORDER_STALE_GRACE_MS, placeHostedOrder } from "../../web/src/lib/order-state";

const TENANT = "0x1111111111111111111111111111111111111111";
const ACCOUNT = "0x2222222222222222222222222222222222222222";
const MIN = 60_000;
/** The hosted window: two 240 s ticks and a ferry pass. */
const WINDOW_MS = (2 * 240 + 15) * 1000;
const GRACE_MS = 2 * MIN;

const homes: string[] = [];
after(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** The table as production had it before receipts; `withReceipt` adds the column the orchestrator grows. */
function setup(withReceipt = false) {
  const raw = new DatabaseSync(":memory:");
  raw.exec(`CREATE TABLE agent_commands (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, kind TEXT NOT NULL, args TEXT,
    created_at INTEGER NOT NULL, claimed_at INTEGER, done_at INTEGER, result TEXT)`);
  if (withReceipt) raw.exec(COMMAND_RECEIPT_DDL);
  const home = mkdtempSync(path.join(tmpdir(), "merry-window-"));
  homes.push(home);
  return { raw, db: wrapSqlite(raw), home };
}

const ORDER = { side: "buy", symbol: "TSLA", usdgAmount: 25 } as const;

/**
 * A trade row the ferry has already DELIVERED (claimed_at set), placed `ageMs`
 * ago. Where it is in the child's home is the test's to say — see below.
 */
function delivered(raw: DatabaseSync, id: string, ageMs: number, args?: Record<string, unknown> | null) {
  const created = Date.now() - ageMs;
  const body = args === null ? null : JSON.stringify(args ?? { ...ORDER, expiresAt: created + WINDOW_MS });
  raw
    .prepare("INSERT INTO agent_commands (id, agent_id, kind, args, created_at, claimed_at) VALUES (?, ?, 'trade', ?, ?, ?)")
    .run(id, ACCOUNT, body, created, created + 5_000);
  return created;
}

/** ...and still sitting in the child's queue: nobody has taken it. */
function stillQueued(raw: DatabaseSync, home: string, id: string, ageMs: number) {
  const created = delivered(raw, id, ageMs);
  writeCommand(home, { id, kind: "trade", at: created, args: { ...ORDER }, expiresAt: created + WINDOW_MS });
  return created;
}

/** ...and TAKEN by the child, which is filling it now: the claim unlinked the file and left a marker. */
function takenAndRunning(raw: DatabaseSync, home: string, id: string, ageMs: number) {
  const created = delivered(raw, id, ageMs);
  markRunning(home, id);
  return created;
}

const state = (raw: DatabaseSync, id: string) =>
  raw.prepare("SELECT claimed_at, done_at, result FROM agent_commands WHERE id = ?").get(id) as {
    claimed_at: number | null;
    done_at: number | null;
    result: string | null;
  };

const pass = (db: ReturnType<typeof wrapSqlite>, home: string) =>
  ferryForChild(db, { home, smartAccount: ACCOUNT, tag: TENANT });

/** A sentence that claims to know the order did not go out. */
const CLAIMS_NOTHING_WENT = /never ran|will not fill|nothing was sent|did not/i;

describe("the stale sweep reads the order's own window", () => {
  it("AN ORDER EIGHT MINUTES OLD, INSIDE ITS 8m15s WINDOW, IS LEFT OPEN", async () => {
    const { raw, db, home } = setup();
    stillQueued(raw, home, "live-order", 8 * MIN);
    await pass(db, home);
    assert.equal(state(raw, "live-order").done_at, null, "the child may still fill it, so nothing may say it never ran");
  });

  it("and stays open through the grace after its deadline — the slot's own grace", async () => {
    const { raw, db, home } = setup();
    stillQueued(raw, home, "in-grace", WINDOW_MS + 90_000);
    await pass(db, home);
    assert.equal(state(raw, "in-grace").done_at, null);
  });

  it("A FILE STILL QUEUED PAST ITS DEADLINE AND GRACE IS CLOSED AS NEVER RAN — nobody took it, and nobody now can", async () => {
    // The child checks `expiresAt` at the claim (command-files isExpired), so a
    // file still sitting in its queue this late can only ever be refused.
    const { raw, db, home } = setup();
    stillQueued(raw, home, "dead-order", WINDOW_MS + 2 * MIN + 30_000);
    await pass(db, home);
    const s = state(raw, "dead-order");
    assert.ok(s.done_at, "a row nothing will answer must stop holding the slot");
    assert.match(s.result ?? "", /never ran/);
    assert.doesNotMatch(s.result ?? "", /five-minute/, "the window is the order's own, not a constant");
  });

  it("an order that was never even delivered is closed as never ran, AND claimed so it never can be", async () => {
    // The down-leg hands over any row with claimed_at NULL and does not look
    // at done_at, so a row closed without being claimed would still be
    // delivered afterwards — and a deadline-less one would then run.
    const { raw, db, home } = setup();
    const created = Date.now() - 7 * MIN - 30_000;
    raw
      .prepare("INSERT INTO agent_commands (id, agent_id, kind, args, created_at) VALUES (?, ?, 'trade', ?, ?)")
      .run("undelivered", ACCOUNT, JSON.stringify(ORDER), created);
    // The down-leg of this same pass delivers it — so to reach the sweep
    // undelivered it has to be stuck behind five older ones, as it would be.
    for (let i = 0; i < 5; i += 1) {
      raw
        .prepare("INSERT INTO agent_commands (id, agent_id, kind, args, created_at) VALUES (?, ?, 'selftest', NULL, ?)")
        .run(`probe-${i}`, ACCOUNT, created - 1_000 - i);
    }
    await pass(db, home);
    const s = state(raw, "undelivered");
    assert.ok(s.done_at);
    assert.match(s.result ?? "", /never ran/);
    assert.ok(s.claimed_at, "claimed by the sweep, so the down-leg can never hand it over");
  });

  it("a real answer that arrives later still replaces the sweep's sentence", async () => {
    // Unchanged, and pinned because it is what keeps a late answer honest if a
    // child is slower than any window we can pick.
    const { raw, db, home } = setup();
    takenAndRunning(raw, home, "slow", WINDOW_MS + GRACE_MS + ORDER_IN_FLIGHT_MS + MIN);
    await pass(db, home);
    assert.ok(state(raw, "slow").done_at);
    writeCommandResult(home, { id: "slow", ok: true, line: "bought 25.00 USDG of TSLA", at: Date.now() });
    await pass(db, home);
    assert.equal(state(raw, "slow").result, "bought 25.00 USDG of TSLA");
  });
});

describe("AN ORDER THE CHILD HAS TAKEN IS NEVER CALLED 'NEVER RAN'", () => {
  it("A .running MARKER PAST DEADLINE AND GRACE LEAVES THE ROW OPEN — it may be filling right now", async () => {
    // The reviewer's case: delivered, claimed by the child (markRunning), the
    // clock past expiresAt + 2 min. The sweep wrote "never ran … Ask again".
    const { raw, db, home } = setup();
    takenAndRunning(raw, home, "inflight", WINDOW_MS + GRACE_MS + 30_000);
    await pass(db, home);
    const s = state(raw, "inflight");
    assert.equal(s.done_at, null, "left open, so the card reads 'running' and the slot stays held");
    assert.equal(s.result, null);
  });

  it("THE FILE GONE WITH NO MARKER AND NO ANSWER IS THE SAME — the child took it", async () => {
    // A crash between the claim's unlink and the marker, or a marker that could
    // not be written: the order may have gone out either way.
    const { raw, db, home } = setup();
    delivered(raw, "gone", WINDOW_MS + GRACE_MS + 30_000);
    await pass(db, home);
    assert.equal(state(raw, "gone").done_at, null);
  });

  it("past the in-flight bound it is closed with a sentence that DOES NOT CLAIM TO KNOW", async () => {
    // A child SIGKILLed mid-trade never answers, and a row nothing answers
    // must stop holding the slot eventually. What it may not do is say the
    // order did not go out.
    const { raw, db, home } = setup();
    takenAndRunning(raw, home, "marker-late", WINDOW_MS + GRACE_MS + ORDER_IN_FLIGHT_MS + 30_000);
    delivered(raw, "gone-late", WINDOW_MS + GRACE_MS + ORDER_IN_FLIGHT_MS + 30_000);
    await pass(db, home);
    for (const id of ["marker-late", "gone-late"]) {
      const s = state(raw, id);
      assert.ok(s.done_at, `${id}: closed at last`);
      assert.doesNotMatch(s.result ?? "", CLAIMS_NOTHING_WENT, `${id}: ${s.result}`);
      assert.match(s.result ?? "", /may have filled|whether it filled/);
      assert.match(s.result ?? "", /trades/, "it points the owner at where the answer is");
    }
  });

  it("AN ANSWER WAITING ON DISK IS NEVER TALKED OVER, even when its row could not be written this pass", async () => {
    // The up-leg leaves a result on disk when its UPDATE fails and retries next
    // pass. The sweep runs in between, and must not put its own sentence in
    // front of the worker's real one — the card repeats whatever `done` says.
    const { raw, db, home } = setup();
    takenAndRunning(raw, home, "answered", WINDOW_MS + GRACE_MS + ORDER_IN_FLIGHT_MS + MIN);
    writeCommandResult(home, { id: "answered", ok: true, line: "bought 25.00 USDG of TSLA", at: Date.now() });
    raw.exec(`CREATE TRIGGER blip BEFORE UPDATE ON agent_commands WHEN NEW.result = 'bought 25.00 USDG of TSLA'
      BEGIN SELECT RAISE(ABORT, 'connection terminated'); END`);
    await pass(db, home);
    assert.equal(state(raw, "answered").done_at, null, "the answer is the up-leg's to land");
    raw.exec("DROP TRIGGER blip");
    await pass(db, home);
    assert.equal(state(raw, "answered").result, "bought 25.00 USDG of TSLA");
  });

  it("the in-flight bound is ONE figure, read by the sweep and the route's slot alike", () => {
    assert.equal(SWEEP_IN_FLIGHT_MS, ORDER_IN_FLIGHT_MS);
    assert.equal(GRACE_MS, ORDER_STALE_GRACE_MS);
  });
});

/**
 * "NEVER RAN" IS C3's `expired`, WHICHEVER PROCESS NOTICED IT.
 *
 * An order that expires in the child's queue is answered with an `expired`
 * receipt (runTickCommand's hook). The same fact noticed by this sweep first —
 * a row never delivered, or a file still queued past its deadline — was closed
 * with the sentence alone, so the chat rendered one fact two ways depending on
 * which process got there first.
 */
describe("the sweep's 'never ran' carries the same receipt the child writes", () => {
  const receiptOf = (raw: DatabaseSync, id: string) => {
    const r = raw.prepare("SELECT receipt FROM agent_commands WHERE id = ?").get(id) as { receipt: string | null };
    return r.receipt === null ? null : JSON.parse(r.receipt);
  };
  /** Nothing was built or sent: every ledger field is null, and side and symbol are the order's own. */
  const EXPIRED = { status: "expired", side: "buy", symbol: "TSLA", token: null, usdgActual: null, txHash: null, rejectRule: null };

  it("A FILE STILL QUEUED PAST ITS DEADLINE AND GRACE IS CLOSED WITH AN `expired` RECEIPT", async () => {
    const { raw, db, home } = setup(true);
    stillQueued(raw, home, "dead-order", WINDOW_MS + 2 * MIN + 30_000);
    await pass(db, home);
    assert.match(state(raw, "dead-order").result ?? "", /never ran/);
    assert.deepEqual(receiptOf(raw, "dead-order"), EXPIRED);
  });

  it("AN ORDER NEVER DELIVERED IS CLOSED WITH ONE TOO", async () => {
    const { raw, db, home } = setup(true);
    const created = Date.now() - 7 * MIN - 30_000;
    raw
      .prepare("INSERT INTO agent_commands (id, agent_id, kind, args, created_at) VALUES (?, ?, 'trade', ?, ?)")
      .run("undelivered", ACCOUNT, JSON.stringify({ ...ORDER, symbol: "nvda" }), created);
    for (let i = 0; i < 5; i += 1) {
      raw
        .prepare("INSERT INTO agent_commands (id, agent_id, kind, args, created_at) VALUES (?, ?, 'selftest', NULL, ?)")
        .run(`probe-${i}`, ACCOUNT, created - 1_000 - i);
    }
    await pass(db, home);
    assert.match(state(raw, "undelivered").result ?? "", /never ran/);
    assert.deepEqual(receiptOf(raw, "undelivered"), { ...EXPIRED, symbol: "NVDA" });
  });

  it("an order whose arguments name no valid side or symbol gets an `expired` receipt that prints neither", async () => {
    const { raw, db, home } = setup(true);
    const created = delivered(raw, "odd", WINDOW_MS + 2 * MIN + 30_000, { side: "yolo", symbol: "../x", usdgAmount: 5, expiresAt: Date.now() - 3 * MIN });
    writeCommand(home, { id: "odd", kind: "trade", at: created, args: { side: "yolo", symbol: "../x" }, expiresAt: Date.now() - 3 * MIN });
    await pass(db, home);
    assert.deepEqual(receiptOf(raw, "odd"), { ...EXPIRED, side: null, symbol: null });
  });

  it("BUT 'MAY HAVE FILLED' CARRIES NO RECEIPT — nothing is known, so nothing is templated", async () => {
    const { raw, db, home } = setup(true);
    takenAndRunning(raw, home, "marker-late", WINDOW_MS + GRACE_MS + ORDER_IN_FLIGHT_MS + 30_000);
    await pass(db, home);
    assert.match(state(raw, "marker-late").result ?? "", /may have/);
    assert.equal(receiptOf(raw, "marker-late"), null);
  });

  it("A TABLE THAT HAS NOT GROWN THE COLUMN YET STILL HAS THE ROW CLOSED — the receipt waits, the answer does not", async () => {
    const { raw, db, home } = setup(false);
    stillQueued(raw, home, "dead-order", WINDOW_MS + 2 * MIN + 30_000);
    await pass(db, home);
    const s = state(raw, "dead-order");
    assert.ok(s.done_at);
    assert.match(s.result ?? "", /never ran/);
  });

  it("THE FALLBACK KEEPS THE ROW'S OWN GUARD — a real answer that landed in between is never talked over", async () => {
    // Two writes where there used to be one, so there is a gap between them.
    // The up-leg can land the worker's real answer in it; the second write
    // must hold the same `done_at IS NULL` the first one did.
    const { raw, db, home } = setup(false);
    stillQueued(raw, home, "raced", WINDOW_MS + 2 * MIN + 30_000);
    const racing = {
      ...db,
      prepare: (sql: string) => {
        if (/^UPDATE/.test(sql) && /receipt = \?/.test(sql)) {
          raw.prepare("UPDATE agent_commands SET done_at = ?, result = ? WHERE id = ?").run(Date.now(), "bought 25.00 USDG of TSLA", "raced");
        }
        return db.prepare(sql);
      },
    };
    await pass(racing, home);
    assert.equal(state(raw, "raced").result, "bought 25.00 USDG of TSLA");
  });
});

describe("the sweep and the one-at-a-time slot agree, row by row", () => {
  // THE SLOT IS WHAT LETS A SECOND ORDER IN. So wherever the sweep leaves a row
  // open because it may still trade, the route must still refuse the next one;
  // and wherever the sweep has closed it, the route must not go on refusing.
  const cases: { name: string; place: (raw: DatabaseSync, home: string) => void }[] = [
    { name: "queued, inside the window", place: (raw, home) => stillQueued(raw, home, "o", 6 * MIN) },
    { name: "queued, in the grace", place: (raw, home) => stillQueued(raw, home, "o", WINDOW_MS + 90_000) },
    { name: "queued, past deadline and grace", place: (raw, home) => stillQueued(raw, home, "o", WINDOW_MS + GRACE_MS + MIN) },
    { name: "running, past deadline and grace", place: (raw, home) => takenAndRunning(raw, home, "o", WINDOW_MS + GRACE_MS + MIN) },
    { name: "gone, past deadline and grace", place: (raw) => void delivered(raw, "o", WINDOW_MS + GRACE_MS + MIN) },
    {
      name: "running, past the in-flight bound",
      place: (raw, home) => takenAndRunning(raw, home, "o", WINDOW_MS + GRACE_MS + ORDER_IN_FLIGHT_MS + MIN),
    },
    {
      // A legacy row the ferry delivered: the child would still run it.
      name: "no deadline, delivered and still queued, past the old seven minutes",
      place: (raw, home) => {
        const created = delivered(raw, "o", 8 * MIN, { ...ORDER });
        writeCommand(home, { id: "o", kind: "trade", at: created, args: { ...ORDER } });
      },
    },
    {
      // Stuck behind five older commands, so this pass cannot deliver it and
      // closes it instead.
      name: "no deadline, never delivered, past the old seven minutes",
      place: (raw) => {
        const created = Date.now() - 8 * MIN;
        raw
          .prepare("INSERT INTO agent_commands (id, agent_id, kind, args, created_at) VALUES (?, ?, 'trade', ?, ?)")
          .run("o", ACCOUNT, JSON.stringify(ORDER), created);
        for (let i = 0; i < 5; i += 1) {
          raw
            .prepare("INSERT INTO agent_commands (id, agent_id, kind, args, created_at) VALUES (?, ?, 'selftest', NULL, ?)")
            .run(`probe-${i}`, ACCOUNT, created - 1_000 - i);
        }
      },
    },
  ];
  for (const c of cases) {
    it(`${c.name}: open ⇔ a second order is refused`, async () => {
      const { raw, db, home } = setup();
      c.place(raw, home);
      await pass(db, home);
      const open = state(raw, "o").done_at === null;
      const now = Date.now();
      const second = await placeHostedOrder(db, {
        agent: ACCOUNT,
        id: "second",
        args: { ...ORDER },
        expiresAt: now + WINDOW_MS,
        now,
      });
      assert.equal(second.ok, !open, open ? "the first may still trade, so the second must wait" : "closed, so the owner may ask again");
    });
  }

  it("A ROW WITH NO DEADLINE THAT NOTHING HAS DELIVERED STILL HOLDS THE SLOT — until the ferry delivers or closes it", async () => {
    // The slot used to let go of it at seven minutes, and the down-leg — which
    // runs before the sweep, and does not look at age — then handed it to a
    // child that runs a deadline-less order whenever it claims one. Two orders
    // in flight for what the route promises is one.
    const { raw, db, home } = setup();
    raw
      .prepare("INSERT INTO agent_commands (id, agent_id, kind, args, created_at) VALUES (?, ?, 'trade', ?, ?)")
      .run("legacy", ACCOUNT, JSON.stringify(ORDER), Date.now() - 8 * MIN);
    const ask = (id: string) => {
      const now = Date.now();
      return placeHostedOrder(db, { agent: ACCOUNT, id, args: { ...ORDER }, expiresAt: now + WINDOW_MS, now });
    };
    assert.deepEqual(await ask("second"), { ok: false, why: "in-flight" }, "before any pass");
    await pass(db, home);
    assert.ok(state(raw, "legacy").claimed_at, "the down-leg delivered it");
    assert.equal(state(raw, "legacy").done_at, null, "and the child would still run it");
    assert.deepEqual(await ask("third"), { ok: false, why: "in-flight" }, "delivered, it is held like any claimed order");
  });
});

/**
 * THE RECEIPT-LESS FALLBACK MAY ONLY ANSWER THE QUESTION IT EXISTS FOR.
 *
 * Both writers try the UPDATE with the receipt first and fall back to the old
 * UPDATE on a table that has not grown the column. They fell back on ANY error.
 * So a blip on a table that HAS the column closed the row with its sentence and
 * a NULL receipt — and a closed row is never revisited (done_at is set, and the
 * up-leg drops the result file), so it stayed that way: the child's `expired`
 * receipt and a NULL one, two renderings of one fact. Anything but the missing
 * column is a failed write, left for the next pass to retry whole.
 */
describe("a failed receipt write is retried, never closed without it", () => {
  const receiptOf = (raw: DatabaseSync, id: string) => {
    const r = raw.prepare("SELECT receipt FROM agent_commands WHERE id = ?").get(id) as { receipt: string | null };
    return r.receipt === null ? null : JSON.parse(r.receipt);
  };
  const EXPIRED = { status: "expired", side: "buy", symbol: "TSLA", token: null, usdgActual: null, txHash: null, rejectRule: null };
  /** A blip on exactly the write that carries the receipt: the table has the column, the connection does not answer. */
  const blipOnReceipt = (raw: DatabaseSync, when = "1") =>
    raw.exec(`CREATE TRIGGER blip BEFORE UPDATE OF receipt ON agent_commands WHEN ${when}
      BEGIN SELECT RAISE(ABORT, 'Connection terminated unexpectedly'); END`);

  it("A BLIP ON THE SWEEP'S RECEIPT WRITE LEAVES THE ROW OPEN, and the next pass closes it WITH the receipt", async () => {
    // The reviewer's probe: pass 1 used to leave {done: true, receipt: null}.
    const { raw, db, home } = setup(true);
    stillQueued(raw, home, "dead-order", WINDOW_MS + 2 * MIN + 30_000);
    blipOnReceipt(raw);
    await pass(db, home);
    assert.equal(state(raw, "dead-order").done_at, null, "not closed as 'never ran' without its receipt");
    raw.exec("DROP TRIGGER blip");
    await pass(db, home);
    assert.match(state(raw, "dead-order").result ?? "", /never ran/);
    assert.deepEqual(receiptOf(raw, "dead-order"), EXPIRED);
  });

  it("an undelivered order is the same: left open, then closed with its receipt by the next pass", async () => {
    // Stuck behind five older commands, so pass 1 cannot deliver it and tries
    // to close it. Pass 2 delivers it — past its deadline, which the child
    // refuses at the claim — and closes it with the receipt.
    const { raw, db, home } = setup(true);
    const created = Date.now() - WINDOW_MS - GRACE_MS - 30_000;
    raw
      .prepare("INSERT INTO agent_commands (id, agent_id, kind, args, created_at) VALUES (?, ?, 'trade', ?, ?)")
      .run("undelivered", ACCOUNT, JSON.stringify({ ...ORDER, expiresAt: created + WINDOW_MS }), created);
    for (let i = 0; i < 5; i += 1) {
      raw
        .prepare("INSERT INTO agent_commands (id, agent_id, kind, args, created_at) VALUES (?, ?, 'selftest', NULL, ?)")
        .run(`probe-${i}`, ACCOUNT, created - 1_000 - i);
    }
    blipOnReceipt(raw);
    await pass(db, home);
    assert.deepEqual(
      { claimed: state(raw, "undelivered").claimed_at, done: state(raw, "undelivered").done_at },
      { claimed: null, done: null },
      "not closed without its receipt",
    );
    raw.exec("DROP TRIGGER blip");
    await pass(db, home);
    assert.match(state(raw, "undelivered").result ?? "", /never ran/);
    assert.deepEqual(receiptOf(raw, "undelivered"), EXPIRED);
  });

  it("ONE ROW'S FAILED WRITE DOES NOT SKIP THE REST OF THE PASS", async () => {
    const { raw, db, home } = setup(true);
    stillQueued(raw, home, "blips", WINDOW_MS + 2 * MIN + 40_000);
    stillQueued(raw, home, "fine", WINDOW_MS + 2 * MIN + 30_000);
    blipOnReceipt(raw, "OLD.id = 'blips'");
    await pass(db, home);
    assert.equal(state(raw, "blips").done_at, null);
    assert.match(state(raw, "fine").result ?? "", /never ran/, "the next row is still closed this pass");
    assert.deepEqual(receiptOf(raw, "fine"), EXPIRED);
  });

  it("A BLIP ON THE UP-LEG'S RECEIPT WRITE KEEPS THE ANSWER ON DISK, and the next pass lands it WITH the receipt", async () => {
    const { raw, db, home } = setup(true);
    takenAndRunning(raw, home, "filled", 60_000);
    const receipt = { status: "landed", side: "buy", symbol: "TSLA", token: null, usdgActual: 25, txHash: null, rejectRule: null };
    writeCommandResult(home, { id: "filled", ok: true, line: "bought 25.00 USDG of TSLA", at: Date.now(), receipt } as never);
    blipOnReceipt(raw);
    await pass(db, home);
    assert.equal(state(raw, "filled").done_at, null, "not answered without its receipt");
    raw.exec("DROP TRIGGER blip");
    await pass(db, home);
    assert.equal(state(raw, "filled").result, "bought 25.00 USDG of TSLA");
    assert.deepEqual(receiptOf(raw, "filled"), receipt);
  });

  it("a table WITHOUT the column still gets the up-leg's answer — the receipt waits, the answer does not", async () => {
    const { raw, db, home } = setup(false);
    takenAndRunning(raw, home, "filled", 60_000);
    writeCommandResult(home, { id: "filled", ok: true, line: "bought 25.00 USDG of TSLA", at: Date.now() });
    await pass(db, home);
    assert.equal(state(raw, "filled").result, "bought 25.00 USDG of TSLA");
  });

  it("THE MISSING COLUMN IS NAMED, on either backend — nothing else counts as it", () => {
    // SQLite, and Postgres's undefined_column as the pg driver raises it.
    assert.equal(missingReceiptColumn(new Error("no such column: receipt")), true);
    const pg = Object.assign(new Error('column "receipt" of relation "agent_commands" does not exist'), { code: "42703" });
    assert.equal(missingReceiptColumn(pg), true);
    // A blip, a lock, another column, a non-error: all failed writes.
    assert.equal(missingReceiptColumn(new Error("Connection terminated unexpectedly")), false);
    assert.equal(missingReceiptColumn(new Error("database is locked")), false);
    assert.equal(missingReceiptColumn(new Error("no such column: result")), false);
    assert.equal(
      missingReceiptColumn(Object.assign(new Error('column "done_at" of relation "agent_commands" does not exist'), { code: "42703" })),
      false,
    );
    assert.equal(missingReceiptColumn(Object.assign(new Error("timeout"), { code: "57014" })), false);
    assert.equal(missingReceiptColumn("no such column: receipt"), false);
  });
});
