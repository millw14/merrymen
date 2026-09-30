/**
 * ONE DECISION, ONE IDENTITY, ONE CHAIN.
 *
 * ── THE BUG THIS IS THE PROOF AGAINST ────────────────────────────────────
 *
 *     BrainDecision A -> thesis row A
 *     submitChatTrade -> loses the id -> ensureDecision mints B
 *                     -> trade / fill attach to B
 *
 * Two rows, one belief. The thesis row said "no trade came of it" forever
 * while a duplicate row a second later said "landed", and no id could
 * reconstruct the chain because there were two of them.
 *
 * ── WHAT IS EXERCISED HERE, AND WHAT IS NOT ──────────────────────────────
 *
 * These cases import the production ownership predicate and lifecycle reader.
 * The web decision-lifecycle integration tests also execute the actual Brain
 * writer, trade writer and public route. The closure inside index.ts is still
 * checked for its call shape below; that check is not an execution test.
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { before, beforeEach, describe, it } from "node:test";
import { wrapSqlite } from "./db";
import { readDecisionLifecycle } from "./decision-lifecycle";
import { verifyDecisionOwner } from "./decision-identity";
import { PROVENANCE_KINDS, isProvenance, provenanceOf } from "./provenance";

const AGENT = "0xagent0000000000000000000000000000000001";
const OTHER = "0xagent0000000000000000000000000000000002";

type OwnerAnswer = string | null | undefined;

describe("a supplied decision id is verified, never trusted and never replaced", () => {
  it("reuses one this agent owns", () => {
    assert.deepEqual(verifyDecisionOwner(AGENT, AGENT), { ok: true });
  });

  it("is case-insensitive about the address, because the ledger is", () => {
    assert.deepEqual(verifyDecisionOwner(AGENT.toUpperCase(), AGENT), { ok: true });
  });

  it("REFUSES another agent's decision rather than repairing it", () => {
    // Not "mint a fresh one and carry on": a caller holding somebody else's
    // decision is wrong about something, and quietly repairing it would attach
    // real money to a row whose provenance we just disproved.
    const v = verifyDecisionOwner(OTHER, AGENT);
    assert.equal(v.ok, false);
    assert.match(v.ok === false ? v.why : "", /another agent/);
  });

  it("refuses an id that names nothing", () => {
    assert.equal(verifyDecisionOwner(null, AGENT).ok, false);
  });

  it("refuses when the database will not answer — an unknown is not permission", () => {
    // THE DIRECTION THAT MATTERS. Treating an unreadable database as "nobody
    // owns it" would let a read failure authorise a trade.
    assert.equal(verifyDecisionOwner(undefined, AGENT).ok, false);
  });

  it("never returns ok for anything but a match", () => {
    for (const owner of [null, undefined, OTHER, "", "0x"] as OwnerAnswer[]) {
      assert.equal(verifyDecisionOwner(owner, AGENT).ok, false, String(owner));
    }
  });
});

describe("provenance is recorded, and never claims more than it knows", () => {
  it("names a Brain decision as Brain, shadow included", () => {
    assert.equal(provenanceOf("brain"), "brain");
    assert.equal(provenanceOf("brain-shadow"), "brain");
  });

  it("does NOT let a deterministic trade claim Brain provenance", () => {
    for (const s of ["strategy:even-keel", "strategy:steady-basket", "class-route", "strategist"]) {
      assert.notEqual(provenanceOf(s), "brain", s);
      assert.equal(provenanceOf(s), "deterministic-strategy", s);
    }
  });

  it("does NOT let an owner's typed order claim autonomy", () => {
    assert.equal(provenanceOf("chat"), "owner-command");
    assert.notEqual(provenanceOf("chat"), "brain");
    assert.notEqual(provenanceOf("chat"), "deterministic-strategy");
  });

  it("separates a hard risk exit from the strategy that held the position", () => {
    // Same source, different kind — the distinction `source` cannot carry.
    assert.equal(provenanceOf("strategy:even-keel", "dca-leg"), "deterministic-strategy");
    assert.equal(provenanceOf("strategy:even-keel", "stop-floor"), "hard-risk-exit");
    assert.equal(provenanceOf("strategy:trencher", "trench-exit"), "hard-risk-exit");
    assert.equal(provenanceOf("class-route", "class-exit"), "hard-risk-exit");
    assert.equal(provenanceOf("class-route", "class-enter"), "deterministic-strategy");
  });

  it("a risk exit outranks the source, even on the Brain rail", () => {
    // If Brain ever proposes an exit the machine would have taken anyway, the
    // fact that it was forced is the more important one.
    assert.equal(provenanceOf("brain", "stop-floor"), "hard-risk-exit");
  });

  it("defaults to the SMALLEST claim for a source it does not recognise", () => {
    // A row that cannot prove a model chose it must not say one did.
    assert.equal(provenanceOf("something-new"), "deterministic-strategy");
    assert.equal(provenanceOf(""), "deterministic-strategy");
  });

  it("is a closed set that includes every kind the owner named", () => {
    assert.deepEqual([...PROVENANCE_KINDS], [
      "brain",
      "deterministic-strategy",
      "owner-command",
      "peer-triggered-research",
      "hard-risk-exit",
    ]);
    for (const k of PROVENANCE_KINDS) assert.ok(isProvenance(k), k);
    for (const bad of ["", "BRAIN", "model", null, undefined, 1]) assert.equal(isProvenance(bad), false, String(bad));
  });
});

/**
 * THE LIFECYCLE, driven against a real database.
 *
 * Each case writes the rows the tick would write and then asks the public
 * reader to reconstruct the chain from the decision id alone.
 */
describe("the whole life of one decision, from its id", () => {
  let db: ReturnType<typeof wrapSqlite>;

  const SCHEMA = [
    "CREATE TABLE decisions (id TEXT PRIMARY KEY, agent_id TEXT, source TEXT, strategy TEXT, provider TEXT, model TEXT, symbol TEXT, action TEXT, size_usdg REAL, reason TEXT, dropped_rule TEXT, signals_json TEXT, hold_kind TEXT, evidence_json TEXT, provenance TEXT, display_name TEXT, at INTEGER NOT NULL DEFAULT 0);",
    "CREATE TABLE trades (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, kind TEXT, target TEXT, sell_token TEXT, buy_token TEXT, amount_usdg REAL, user_op_hash TEXT, tx_hash TEXT, status TEXT, reject_rule TEXT, decision_id TEXT, fill_side TEXT, fill_qty_raw TEXT, fill_price_usd REAL, realized_pnl_usdg REAL, basis_source TEXT, fill_cash_usdg REAL, created_at INTEGER);",
    "CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, decision_id TEXT UNIQUE, body TEXT, created_at INTEGER);",
  ].join("\n");

  const lifecycle = (id: string) => readDecisionLifecycle(db, id);

  const decision = (id: string, over: Record<string, unknown> = {}) =>
    db
      .prepare(
        "INSERT INTO decisions (id, agent_id, source, symbol, action, size_usdg, reason, provenance, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, AGENT, over.source ?? "brain", "MOON", "buy", 5, "Buyers are sticking around.", over.provenance ?? "brain", 100);

  beforeEach(async () => {
    db = wrapSqlite(new DatabaseSync(":memory:"));
    await db.exec(SCHEMA);
  });

  it("A LANDED BRAIN TRADE: one decision row, and every stage under it", async () => {
    const X = "dec_0123456789abcdef";
    await decision(X);
    // submitted -> landed, with the economic fill and the realised result on the
    // same row the executor updates.
    await db
      .prepare(
        `INSERT INTO trades (agent_id, kind, target, amount_usdg, status, decision_id, user_op_hash, tx_hash,
                             fill_side, fill_qty_raw, fill_cash_usdg, fill_price_usd, realized_pnl_usdg, basis_source, created_at)
         VALUES (?, 'swap', '0xr', 5, 'landed', ?, '0xop', '0xtx', 'buy', '1000', 5, 0.005, NULL, 'receipt', 110)`,
      )
      .run(AGENT, X);
    await db.prepare("INSERT INTO posts (agent_id, decision_id, body, created_at) VALUES (?, ?, ?, ?)").run(AGENT, X, "Been watching this one.", 111);

    const rows = (await db.prepare("SELECT COUNT(*) AS n FROM decisions").get()) as { n: number };
    assert.equal(Number(rows.n), 1, "EXACTLY ONE DECISION ROW — the whole point");

    const l = (await lifecycle(X))!;
    assert.equal(l.decision.id, X);
    assert.equal(l.decision.provenance, "brain");
    assert.equal(l.trades.length, 1, "the trade attached to X, not to a second decision");
    assert.equal(l.trades[0]!.status, "landed");
    assert.equal(l.trades[0]!.fill_side, "buy", "the economic fill is under X");
    assert.equal(l.trades[0]!.basis_source, "receipt");
    assert.equal(l.post!.body, "Been watching this one.", "and what it said is under X too");
    // Realised result is genuinely not known on an opening buy. Absent, not zero.
    assert.equal(l.trades[0]!.realized_pnl_usdg, null);
  });

  it("A REFUSED TRADE: same X, and no fill invented", async () => {
    const X = "dec_refused00000";
    await decision(X);
    await db
      .prepare(
        `INSERT INTO trades (agent_id, kind, target, amount_usdg, status, reject_rule, decision_id, created_at)
         VALUES (?, 'swap', '0xr', 5, 'rejected', 'drawdown-breaker', ?, 110)`,
      )
      .run(AGENT, X);

    const l = (await lifecycle(X))!;
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM decisions").get() as { n: number }).n, 1);
    assert.equal(l.trades[0]!.status, "rejected");
    assert.equal(l.trades[0]!.reject_rule, "drawdown-breaker");
    // NOT A TRADE THAT HAPPENED. Every fill column stays null — a refusal must
    // never be reconstructable as a fill, and a reader keys on exactly these.
    for (const k of ["fill_side", "fill_qty_raw", "fill_cash_usdg", "fill_price_usd", "realized_pnl_usdg", "tx_hash"] as const) {
      assert.equal(l.trades[0]![k], null, `${k} must be absent on a refusal`);
    }
  });

  it("A REVERTED TRADE: same X, and the outcome says reverted", async () => {
    const X = "dec_reverted0000";
    await decision(X);
    await db
      .prepare(
        `INSERT INTO trades (agent_id, kind, target, amount_usdg, status, decision_id, user_op_hash, created_at)
         VALUES (?, 'swap', '0xr', 5, 'reverted', ?, '0xop', 110)`,
      )
      .run(AGENT, X);

    const l = (await lifecycle(X))!;
    assert.equal(l.trades[0]!.status, "reverted");
    assert.equal(l.trades[0]!.fill_side, null, "a revert filled nothing");
    assert.equal(l.trades[0]!.user_op_hash, "0xop", "but it was submitted, and that is part of the chain");
  });

  it("A DETERMINISTIC TRADE does not claim Brain provenance", async () => {
    const X = "dec_determinist0";
    await decision(X, { source: "strategy:even-keel", provenance: provenanceOf("strategy:even-keel", "dca-leg") });
    const l = (await lifecycle(X))!;
    assert.equal(l.decision.provenance, "deterministic-strategy");
    assert.notEqual(l.decision.provenance, "brain");
  });

  it("AN OWNER TRADE does not claim autonomy", async () => {
    const X = "dec_owner0000000";
    await decision(X, { source: "chat", provenance: provenanceOf("chat") });
    const l = (await lifecycle(X))!;
    assert.equal(l.decision.provenance, "owner-command");
    assert.notEqual(l.decision.provenance, "brain");
  });

  it("a landed fill does not create a second thesis", async () => {
    const X = "dec_onepost00000";
    await decision(X);
    await db.prepare("INSERT INTO posts (agent_id, decision_id, body, created_at) VALUES (?, ?, ?, ?)").run(AGENT, X, "first", 111);
    // `decision_id` is UNIQUE on posts, so a second attempt cannot land.
    await assert.rejects(
      db.prepare("INSERT INTO posts (agent_id, decision_id, body, created_at) VALUES (?, ?, ?, ?)").run(AGENT, X, "second", 112),
    );
    const posts = (await db.prepare("SELECT COUNT(*) AS n FROM posts WHERE decision_id = ?").get(X)) as { n: number };
    assert.equal(Number(posts.n), 1);
  });

  it("reports several trades against one decision rather than hiding the rest", async () => {
    // A retry writes a second row. A reader that assumed one would show the
    // first and silently drop the outcome that actually happened.
    const X = "dec_retry0000000";
    await decision(X);
    for (const [status, at] of [["rejected", 110], ["landed", 120]] as const) {
      await db
        .prepare(`INSERT INTO trades (agent_id, kind, target, amount_usdg, status, decision_id, created_at) VALUES (?, 'swap', '0xr', 5, ?, ?, ?)`)
        .run(AGENT, status, X, at);
    }
    const l = (await lifecycle(X))!;
    assert.equal(l.trades.length, 2);
    assert.deepEqual(l.trades.map((t) => t.status), ["rejected", "landed"], "oldest first");
  });

  it("an id that names nothing reconstructs nothing", async () => {
    assert.equal(await lifecycle("dec_nosuchrow000"), null);
  });

  it("a database read failure returns no lifecycle", async () => {
    await db.exec("DROP TABLE decisions");
    assert.equal(await lifecycle("dec_unreadable000"), null);
  });
});

/**
 * THE CALL SHAPE AT THE REAL SITE.
 *
 * `ensureDecision` is a closure inside `main()` and cannot be imported, so this
 * pins the two properties that make the chain hold, on the source that ships.
 */
describe("the tick wires the identity through", () => {
  let INDEX = "";
  before(() => {
    INDEX = readFileSync(new URL("./index.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  });

  it("Brain hands its own decision id to the executor", () => {
    // Without this the executor mints a second decision and the pre-trade
    // thesis is orphaned — the exact bug.
    assert.match(INDEX, /decisionId: d\.decision_id/, "the brain-live call must carry its decision id");
  });

  it("the chat path stamps a supplied id onto the intent BEFORE ensureDecision", () => {
    const stamp = INDEX.indexOf("if (asked.decisionId) intent.decisionId = asked.decisionId;");
    const ensure = INDEX.indexOf("const stamped = await ensureDecision(intent, asked.source, asked.reason");
    assert.ok(stamp > 0 && ensure > 0, "both sites must exist");
    assert.ok(stamp < ensure, "the id must be on the intent before it is verified");
  });

  it("a failed verification refuses the trade rather than continuing", () => {
    assert.match(INDEX, /if \(!stamped\.ok\) return no\(stamped\.why\);/);
  });

  it("ensureDecision uses the ownership predicate exercised above", () => {
    assert.match(INDEX, /verifyDecisionOwner\(owner, active\.agentId\)/);
    assert.match(INDEX, /if \(!verified\.ok\)/);
  });

  it("and asks them BECAUSE an id was supplied — the guard is reachable", () => {
    // THE MUTATION THIS CATCHES, and it slipped past the test above: change the
    // guard's condition to `if (false)` and all four questions are still in the
    // file, unreachable, while ensureDecision goes back to minting a second
    // decision over a supplied id. Asserting the four strings exist is not the
    // same as asserting they run.
    const guard = INDEX.indexOf("if (intent.decisionId) {");
    assert.ok(guard > 0, "the guard must key on the supplied id");
    const verify = INDEX.indexOf("const owner = await decisionAgent(intent.decisionId);", guard);
    assert.ok(verify > guard && verify - guard < 400, "the ownership read must sit inside that guard");
    // And the mint must come AFTER it, so a supplied id can never reach it.
    const mint = INDEX.indexOf("const id = newDecisionId();", guard);
    assert.ok(mint > verify, "a new id is only minted when none was supplied");
  });

  it("records provenance on every decision it mints — the row builder ensureDecision calls, executed", async () => {
    // Was a grep for the inline field in index.ts; the row is now built by
    // decision-row.ts (decision-name.integration.test.ts writes it through the
    // real store), so the rule is run rather than read.
    const { intentDecisionRow } = await import("./decision-row");
    const mint = (source: string, known?: { whyCode?: string; provenance?: (typeof PROVENANCE_KINDS)[number] }) =>
      intentDecisionRow({ id: "d", agentId: AGENT, source, described: { action: "sell", symbol: "NVDA", sizeUsdg: 1 }, known, name: async () => null });
    assert.equal((await mint("chat")).provenance, "owner-command");
    assert.equal((await mint("brain")).provenance, "brain");
    assert.equal((await mint("strategy:even-keel", { whyCode: "stop-floor" })).provenance, "hard-risk-exit");
    assert.equal((await mint("strategy:even-keel", { whyCode: "dca-leg" })).provenance, "deterministic-strategy");
    assert.equal((await mint("chat", { provenance: "brain" })).provenance, "brain", "what the producer recorded wins");
  });

  it("every execution caller consumes the decision verdict", () => {
    assert.doesNotMatch(INDEX, /^\s*await ensureDecision\(/m);
    assert.match(INDEX, /verifyDecisionOwner\(await decisionAgent\(id\), active\.agentId\)/);
  });
});
