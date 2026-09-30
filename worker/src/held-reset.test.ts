/**
 * A PRACTICE RESET HONOURED WHILE THE BOOK IS HELD (plan §3.4): the decision,
 * and the claim and reset as one transaction.
 *
 * decideHeldReset is pure and is driven directly. applyHeldReset is driven over
 * sqlite through wrapSqlite with the real ledger schema; the Postgres side runs
 * the same statements, and deliverCommand's claim is the same statement too.
 * resetBlockedPaperBook's own rules are in paper-checkpoint.test.ts;
 * restore-hold.integration.test.ts drives all of it through reconcile().
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import { commandDir } from "./command-files";
import { wrapSqlite, type Db } from "./db";
import {
  HELD_RESET_DONE,
  HELD_RESET_EXPIRED,
  HELD_RESET_MAX_AGE_MS,
  HELD_RESET_SUPERSEDED,
  applyHeldReset,
  decideHeldReset,
  heldResetEvent,
  resetsAsked,
  settingsRefuseHeldReset,
  type HeldResetEvidence,
} from "./held-reset";
import { PAPER_CHECKPOINT_SCHEMA, restorePaperCheckpoint } from "./paper-checkpoint";
import { ferryForChild } from "./orchestrator";
import { applyLedgerSchema } from "./store";

const NOW = Date.parse("2026-09-28T12:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** The smart account the web enqueues under and the ledger is keyed on. */
const ACCOUNT = "0x2222222222222222222222222222222222222222";
/** The tenant, deliberately not the account (ferry-commands.test.ts says why). */
const TENANT = "0x1111111111111111111111111111111111111111";

describe("decideHeldReset", () => {
  const base: HeldResetEvidence = {
    ask: { id: "r1", created_at: NOW - HOUR, claimed_at: null },
    now: NOW,
    settings: { paperTradingEnabled: true },
    consentEnforced: true,
    agent: { epoch: 3, mode: "paper" },
    latestMarkMode: "paper",
  };
  const no = (e: Partial<HeldResetEvidence>, why: RegExp) => {
    const d = decideHeldReset({ ...base, ...e });
    assert.ok(!d.reset && why.test(d.why), JSON.stringify(d));
  };

  it("A FRESH RESET FOR A PRACTICE BOOK IS HONOURED, AT THE EPOCH IT WAS DECIDED ON", () => {
    assert.deepEqual(decideHeldReset(base), { reset: true, id: "r1", epoch: 3 });
    // Seven days is the bound, inclusive.
    assert.equal(decideHeldReset({ ...base, ask: { ...base.ask!, created_at: NOW - HELD_RESET_MAX_AGE_MS } }).reset, true);
  });

  it("A ROW OLDER THAN SEVEN DAYS IS IGNORED: consent to a reset now is not consent to one whenever", () => {
    no({ ask: { id: "r1", created_at: NOW - HELD_RESET_MAX_AGE_MS - 1, claimed_at: null } }, /more than seven days ago/);
    no({ ask: { id: "r1", created_at: NOW - 7 * DAY - 60_000, claimed_at: null } }, /ask again/);
  });

  it("A CLAIMED ROW IS SKIPPED, AND NO ROW IS NOTHING TO DO", () => {
    no({ ask: { id: "r1", created_at: NOW - HOUR, claimed_at: NOW - 60_000 } }, /already claimed/);
    no({ ask: null }, /no practice reset is waiting/);
  });

  it("A LIVE ACCOUNT IS REFUSED, WHICHEVER SIDE SAYS SO", () => {
    no({ settings: { paperTradingEnabled: true, liveTradingEnabled: true } }, /live trading is switched on/);
    no({ agent: { epoch: 3, mode: "live" } }, /live rail/);
    no({ latestMarkMode: "live" }, /not a paper one/);
    no({ latestMarkMode: null }, /no valuation/);
    // Consent stood down: a setting that does not switch live on proves nothing.
    no({ consentEnforced: false }, /stood down/);
  });

  it("THE SETTINGS' HALF IS ONE FUNCTION, WHICH THE ORCHESTRATOR ASKS BEFORE IT OFFERS THE RESET AT ALL", () => {
    assert.equal(settingsRefuseHeldReset({ paperTradingEnabled: true }, true), null);
    for (const [settings, consent] of [
      [{ paperTradingEnabled: true, liveTradingEnabled: true }, true],
      [{ paperTradingEnabled: true }, false],
      [{ paperTradingEnabled: false }, true],
      [null, true],
      ["unreadable", true],
    ] as const) {
      const why = settingsRefuseHeldReset(settings, consent);
      assert.ok(why, JSON.stringify(settings));
      const d = decideHeldReset({ ...base, settings, consentEnforced: consent });
      assert.ok(!d.reset && d.why === why, "the decision says the same no");
    }
  });

  it("ONLY A READ THAT FAILED IS TRANSIENT; ONLY AN OLD ROW IS STALE", () => {
    const d = decideHeldReset({ ...base, settings: "unreadable" });
    assert.ok(!d.reset && d.transient === true && !d.stale);
    const live = decideHeldReset({ ...base, settings: { paperTradingEnabled: true, liveTradingEnabled: true } });
    assert.ok(!live.reset && !live.transient && !live.stale, "the owner's own settings saying no is an answer");
    const old = decideHeldReset({ ...base, ask: { id: "r1", created_at: NOW - 8 * DAY, claimed_at: null } });
    assert.ok(!old.reset && old.stale === true && !old.transient);
  });

  it("AND ANYTHING IT CANNOT READ IS A NO", () => {
    no({ settings: "unreadable" }, /could not be read/);
    no({ settings: null }, /practice mode is not on/);
    no({ settings: { paperTradingEnabled: false } }, /practice mode is not on/);
    no({ agent: null }, /no agent row/);
    no({ agent: { epoch: Number.NaN, mode: "paper" } }, /epoch is unreadable/);
  });
});

/** A shared ledger holding a practice book the restore refuses, and the owner's queued resets. */
async function heldLedger(): Promise<{ raw: DatabaseSync; db: Db }> {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  await applyLedgerSchema(db);
  await db.exec(PAPER_CHECKPOINT_SCHEMA);
  await db.prepare(`INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, epoch, mode)
    VALUES (?, '0xowner', '0xsession', 4663, '{}', 1, 2, 1, 'paper')`).run(ACCOUNT);
  await db.prepare(`INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, epoch, mode, at)
    VALUES (?, '0', 900, 0, 110, 1010, 1, 'paper', 10)`).run(ACCOUNT);
  await db.prepare(`INSERT INTO trades (agent_id, kind, target, amount_usdg, status, epoch, created_at)
    VALUES (?, 'swap', 'NVDA', 100, 'paper', 1, 11)`).run(ACCOUNT);
  await db.prepare(`INSERT INTO positions (agent_id, symbol, token, raw_balance, ui_multiplier, price_usd, value_usdg)
    VALUES (?, 'NVDA', ?, '2000000000000000000', '1000000000000000000', 55, 110)`).run(ACCOUNT, "0x" + "4".repeat(40));
  await db.prepare(`INSERT INTO cost_basis (agent_id, mode, symbol, qty_raw, cost_usdg) VALUES (?, 'paper', 'NVDA', '2000000000000000000', '100000000')`).run(ACCOUNT);
  return { raw, db };
}

const ask = (db: Db, id: string, created_at: number, agent_id = ACCOUNT) =>
  db.prepare("INSERT INTO agent_commands (id, agent_id, kind, created_at) VALUES (?, ?, 'paper-reset', ?)").run(id, agent_id, created_at);
const row = async (db: Db, id: string) =>
  ({ ...((await db.prepare("SELECT claimed_at, done_at, result FROM agent_commands WHERE id = ?").get(id)) as object) }) as {
    claimed_at: number | null;
    done_at: number | null;
    result: string | null;
  };
const epochOf = async (db: Db) => Number(((await db.prepare("SELECT epoch FROM agents").get()) as { epoch: number }).epoch);
const opts = (over: Partial<Parameters<typeof applyHeldReset>[2]> = {}): Parameters<typeof applyHeldReset>[2] => ({
  now: NOW,
  readSettings: async () => ({ paperTradingEnabled: true }),
  consentEnforced: true,
  mayWrite: () => null,
  ...over,
});

const homes: string[] = [];
after(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

describe("applyHeldReset: the claim and the reset are one transaction", () => {
  it("TWO AT ONCE: EXACTLY ONE WINS, THE ROW ENDS CLAIMED AND ANSWERED, AND IT IS NEVER FERRIED AGAIN", async () => {
    const { raw, db } = await heldLedger();
    try {
      await ask(db, "r1", NOW - HOUR);
      const both = await Promise.all([applyHeldReset(db, ACCOUNT, opts()), applyHeldReset(db, ACCOUNT, opts())]);
      const won = both.filter((o) => o.applied);
      assert.equal(won.length, 1, JSON.stringify(both));
      const lost = both.find((o) => !o.applied)!;
      assert.ok(!lost.applied && /claimed the reset/.test(lost.why), JSON.stringify(lost));
      assert.deepEqual(won[0], { applied: true, id: "r1", from: 1, epoch: 2 });
      assert.equal(await epochOf(db), 2, "the book was started over once, not twice");
      // And the agent's feed says so, once, as the worker's own reset would.
      const said = (await db.prepare("SELECT agent_id, level, message FROM events").all()) as { agent_id: string; level: string; message: string }[];
      assert.deepEqual(
        said.map((e) => ({ ...e })),
        [{ agent_id: ACCOUNT, level: "ok", message: heldResetEvent(1) }],
      );
      assert.doesNotMatch(heldResetEvent(1), /USDG|\$/, "no figure it does not know");
      const r = await row(db, "r1");
      assert.equal(r.claimed_at, NOW);
      assert.equal(r.done_at, NOW);
      assert.equal(r.result, HELD_RESET_DONE);
      // The ferry's own pass, for the worker that comes after the hold.
      const home = mkdtempSync(path.join(tmpdir(), "merry-held-reset-"));
      homes.push(home);
      await ferryForChild(db, { home, smartAccount: ACCOUNT, tag: TENANT });
      let files: string[] = [];
      try {
        files = readdirSync(commandDir(home));
      } catch {
        /* no directory: nothing delivered */
      }
      assert.deepEqual(files, [], "a reset honoured while held is not handed to the worker to run again");
      // And what it left is a book with nothing to restore.
      const local = wrapSqlite(new DatabaseSync(":memory:"));
      await applyLedgerSchema(local);
      assert.equal(await restorePaperCheckpoint(local, db, ACCOUNT), "no durable checkpoint");
    } finally {
      raw.close();
    }
  });

  it("ONLY THE NEWEST IS HONOURED, AND THE OLDER ONES ARE CLOSED WITH IT, NOT LEFT FOR A WORKER TO RUN", async () => {
    const { raw, db } = await heldLedger();
    try {
      await ask(db, "old", NOW - 8 * DAY); // past the bound, but still the same wish
      await ask(db, "mid", NOW - DAY);
      await ask(db, "new", NOW - HOUR);
      await ask(db, "theirs", NOW - HOUR, "0x3333333333333333333333333333333333333333");
      const out = await applyHeldReset(db, ACCOUNT, opts());
      assert.ok(out.applied && out.id === "new");
      assert.equal((await row(db, "new")).result, HELD_RESET_DONE);
      for (const id of ["old", "mid"]) {
        const r = await row(db, id);
        assert.ok(r.claimed_at && r.done_at, `${id} is closed`);
        assert.equal(r.result, HELD_RESET_SUPERSEDED);
      }
      assert.deepEqual(await row(db, "theirs"), { claimed_at: null, done_at: null, result: null }, "another account's row is not touched");
    } finally {
      raw.close();
    }
  });

  it("A NEWEST ROW PAST SEVEN DAYS IS NOT RUN, AND IS CLOSED SO NO WORKER RUNS IT LATER EITHER", async () => {
    const { raw, db } = await heldLedger();
    try {
      await ask(db, "older", NOW - 9 * DAY);
      await ask(db, "r1", NOW - 8 * DAY);
      const out = await applyHeldReset(db, ACCOUNT, opts());
      assert.ok(!out.applied && out.id === "r1" && /seven days.*closed/.test(out.why) && !out.transient, JSON.stringify(out));
      assert.equal(await epochOf(db), 1, "the book is not touched");
      for (const id of ["r1", "older"]) {
        assert.deepEqual(await row(db, id), { claimed_at: NOW, done_at: NOW, result: HELD_RESET_EXPIRED }, id);
      }
      assert.equal(Number(((await db.prepare("SELECT COUNT(*) AS n FROM events").get()) as { n: number }).n), 0);
      // The restore takes on its own later, say, and a worker is handed the
      // tenant: the ferry has nothing to give it, so the book it just got back
      // is not started over on a request this turned down.
      const home = mkdtempSync(path.join(tmpdir(), "merry-held-reset-"));
      homes.push(home);
      await ferryForChild(db, { home, smartAccount: ACCOUNT, tag: TENANT });
      let files: string[] = [];
      try {
        files = readdirSync(commandDir(home));
      } catch {
        /* no directory: nothing delivered */
      }
      assert.deepEqual(files, []);
    } finally {
      raw.close();
    }
  });

  it("CLOSING A STALE ROW IS A WRITE: NOT WITHOUT THE LEASE, AND NEVER A ROW ASKED FOR SINCE", async () => {
    const { raw, db } = await heldLedger();
    try {
      await ask(db, "r1", NOW - 8 * DAY);
      const refused = await applyHeldReset(db, ACCOUNT, opts({ mayWrite: () => "its lease was lost" }));
      assert.deepEqual(refused, { applied: false, id: "r1", why: "its lease was lost", transient: true });
      assert.equal((await row(db, "r1")).claimed_at, null);
      // A press that lands between the read and the write (mayWrite runs in
      // that window) is fresh consent, and is left for the next attempt.
      const out = await applyHeldReset(db, ACCOUNT, opts({ mayWrite: () => (raw.exec(`INSERT INTO agent_commands (id, agent_id, kind, created_at) VALUES ('fresh', '${ACCOUNT}', 'paper-reset', ${NOW})`), null) }));
      assert.ok(!out.applied && out.id === "r1");
      assert.equal((await row(db, "r1")).result, HELD_RESET_EXPIRED);
      assert.deepEqual(await row(db, "fresh"), { claimed_at: null, done_at: null, result: null });
      assert.ok((await applyHeldReset(db, ACCOUNT, opts())).applied, "and the next attempt honours it");
    } finally {
      raw.close();
    }
  });

  it("A LIVE OWNER, OR SETTINGS THAT WILL NOT READ: NOTHING CLAIMED, NOTHING RESET", async () => {
    for (const readSettings of [async () => ({ paperTradingEnabled: true, liveTradingEnabled: true }), async () => Promise.reject(new Error("sealed store down"))]) {
      const { raw, db } = await heldLedger();
      try {
        await ask(db, "r1", NOW - HOUR);
        const out = await applyHeldReset(db, ACCOUNT, opts({ readSettings }));
        assert.ok(!out.applied, JSON.stringify(out));
        // A live owner is an answer; a store that will not read is not yet one.
        assert.equal(out.transient, /could not be read/.test(out.why), JSON.stringify(out));
        assert.equal(await epochOf(db), 1);
        assert.equal((await row(db, "r1")).claimed_at, null);
      } finally {
        raw.close();
      }
    }
  });

  it("NOT WITHOUT THE LEASE: asked after the reads and before the write", async () => {
    const { raw, db } = await heldLedger();
    try {
      await ask(db, "r1", NOW - HOUR);
      const out = await applyHeldReset(db, ACCOUNT, opts({ mayWrite: () => "its lease was lost" }));
      assert.deepEqual(out, { applied: false, id: "r1", why: "its lease was lost", transient: true });
      assert.equal(await epochOf(db), 1);
      assert.equal((await row(db, "r1")).claimed_at, null);
    } finally {
      raw.close();
    }
  });

  it("THE EPOCH MOVES BETWEEN THE DECISION AND THE WRITE: THE CLAIM ROLLS BACK WITH THE RESET", async () => {
    const { raw, db } = await heldLedger();
    try {
      await ask(db, "r1", NOW - HOUR);
      // mayWrite runs after every read and just before the transaction, so a
      // synchronous write here lands exactly in that window.
      const out = await applyHeldReset(db, ACCOUNT, opts({ mayWrite: () => (raw.exec("UPDATE agents SET epoch = 5"), null) }));
      assert.ok(!out.applied && /epoch moved/.test(out.why) && out.transient, JSON.stringify(out));
      assert.equal(await epochOf(db), 5, "left where the other writer put it");
      assert.equal((await row(db, "r1")).claimed_at, null, "unclaimed again: the next attempt decides afresh");
      assert.equal(Number(((await db.prepare("SELECT COUNT(*) AS n FROM positions").get()) as { n: number }).n), 1, "and nothing deleted");
    } finally {
      raw.close();
    }
  });

  it("NOTHING QUEUED IS THE ORDINARY CASE, AND ANSWERS WITH NO ROW", async () => {
    const { raw, db } = await heldLedger();
    try {
      assert.deepEqual(await applyHeldReset(db, ACCOUNT, opts()), { applied: false, id: null, why: "no practice reset is waiting", transient: false });
    } finally {
      raw.close();
    }
  });
});

describe("resetsAsked", () => {
  it("THE NEWEST UNCLAIMED RESET OF THE LAST SEVEN DAYS, PER ACCOUNT ASKED ABOUT, AND NOTHING ELSE", async () => {
    const { raw, db } = await heldLedger();
    try {
      const OTHER = "0x3333333333333333333333333333333333333333";
      const STALE = "0x4444444444444444444444444444444444444444";
      await ask(db, "a-old", NOW - DAY);
      await ask(db, "a-new", NOW - HOUR);
      await ask(db, "o-claimed", NOW - HOUR, OTHER);
      await db.prepare("UPDATE agent_commands SET claimed_at = ? WHERE id = 'o-claimed'").run(NOW);
      await ask(db, "s-stale", NOW - 8 * DAY, STALE);
      await ask(db, "x-unasked", NOW - HOUR, "0x5555555555555555555555555555555555555555");
      await db.prepare("INSERT INTO agent_commands (id, agent_id, kind, created_at) VALUES ('a-trade', ?, 'trade', ?)").run(ACCOUNT, NOW);
      const got = await resetsAsked(db, [ACCOUNT, OTHER, STALE], NOW);
      assert.deepEqual([...got], [[ACCOUNT, "a-new"]]);
      assert.deepEqual([...(await resetsAsked(db, [], NOW))], []);
    } finally {
      raw.close();
    }
  });
});
