/**
 * THE FUNNEL SAYS WHICH RAIL, WHICH STAGE, AND WHICH HOLDS WERE DECISIONS.
 *
 * Each case below is a way the one-line funnel misread a real hour: a stale
 * row counted as trading for real, the executor's own refusals blamed on the
 * owner's wall, paper fills read as an execution drop-off, an unknown receipt
 * read as a refusal, and every quiet review filed as an unreported hold.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  AUTONOMY_HOLDS_SQL,
  RAIL_NO_WORKER,
  RAIL_RESPAWNING,
  autonomyHolds,
  autonomyLines,
  beatSec,
  fleetRails,
  foldFunnel,
  policyPassed,
  railOf,
  railOfTrade,
  railsLine,
  stageOf,
  type RefusalStage,
} from "./autonomy-funnel";
import { PRIVATE_REVIEW_SOURCE, RESEARCH_UNAVAILABLE_SOURCE, REVIEW_SOURCE } from "./market-review";

describe("stageOf: the owner's wall, the market, or the house's own execution", () => {
  it("every gas and key-install refusal is execution, prefund included", () => {
    for (const rule of [
      "gas-absurd", "gas-unstable", "gas-unreadable", "gas-paymaster-unexpected",
      "enable-too-wide", "enable-replayed", "enable-redundant", "enable-unverified",
      "nonce-changed", "prefund-short", "prefund-unverified",
    ]) {
      assert.equal(stageOf(rule), "exec", rule);
    }
  });

  it("the sponsor declining and the ledger refusing the pre-broadcast row are execution", () => {
    for (const rule of ["sponsor-refused", "sponsor-unreachable", "sponsor-absurd", "not-recorded"]) {
      assert.equal(stageOf(rule), "exec", rule);
    }
  });

  it("no ETH, no signer, a venue it cannot build for, and every failure before submit are execution", () => {
    for (const rule of [
      "no-gas", "no-executor", "router-migrated", "no-rialto-key", "no-curve-adapter",
      // index.ts writes exactly this: the words, then up to 80 of the error's.
      "couldn't submit: bundler: AA21 didn't pay prefund",
      "couldn't submit: HTTP request failed. Status: 502",
      "fence-recipient", "paper: paper cash short of the buy", "review: no price for NVDA",
    ]) {
      assert.equal(stageOf(rule), "exec", rule);
    }
  });

  it("the market's refusals are the market's: after the wall said yes, never the wall", () => {
    for (const rule of [
      "no-route", "no-quote", "no-liquidity", "slippage", "curve-graduated", "insufficient-balance",
      "impact-cap", "impact-unknown", "energy-no-quote", "energy-tax", "energy-tax-unreadable",
    ]) {
      assert.equal(stageOf(rule), "market", rule);
    }
  });

  it("the wall's own refusals, on-chain ones and the rail's included, are the wall", () => {
    for (const rule of [
      "no-exit", "grant-too-wide", "daily-cap", "per-trade-cap", "scout-budget",
      "wall-refused", "spend-cap", "quote-not-approved", "no-cash", "live-not-enabled", "",
    ]) {
      assert.equal(stageOf(rule), "wall", rule);
    }
  });
});

/**
 * EVERY REFUSAL ITS PRODUCERS CAN WRITE IS PLACED ON PURPOSE.
 *
 * Read from the producers' source, not restated, so the one way this can go
 * wrong — the executor learning a new refusal that then falls silently onto
 * the owner's wall — fails here the day it is written. Placing it is a
 * one-line decision in autonomy-funnel.ts and one line below.
 */
describe("stageOf: every refusal its producers write is placed on purpose", () => {
  const SRC = path.dirname(fileURLToPath(import.meta.url));
  const read = (rel: string) => readFileSync(path.join(SRC, rel), "utf8");
  const quoted = (s: string) => [...s.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  /** The string literals of a union type, read off the AST: its members carry comments with `;` and `|` in them. */
  const unionOf = (src: string, name: string) => {
    const file = ts.createSourceFile(`${name}.ts`, src, ts.ScriptTarget.Latest, true);
    const alias = file.statements.find((s): s is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(s) && s.name.text === name);
    assert.ok(alias && ts.isUnionTypeNode(alias.type), `${name} is still a union of literals`);
    return alias.type.types
      .filter((t): t is ts.LiteralTypeNode => ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal))
      .map((t) => (t.literal as ts.StringLiteral).text);
  };
  const placed = (where: string, rules: Iterable<string>, expect: (rule: string) => RefusalStage) => {
    const all = [...rules];
    assert.ok(all.length > 0, `${where}: the producer was found and read`);
    for (const rule of all) assert.equal(stageOf(rule), expect(rule), `${where} writes "${rule}"`);
  };

  // Booked on rows that WENT OUT (status reverted or dropped), which the funnel
  // counts as sent: never asked for a stage.
  const SENT_ROW_RULES = new Set(["reverted on-chain (resolved)", "dropped: a later op used its nonce (resolved)"]);

  it("index.ts: every literal it books as reject_rule, and every class-vault refusal", () => {
    const index = read("index.ts");
    const literals = new Set<string>();
    for (const m of index.matchAll(/reject_rule:([^,\n]*)/g)) for (const q of quoted(m[1]!)) literals.add(q);
    for (const m of index.matchAll(/\brefuse\(\s*"([a-z][a-z0-9-]*)",/g)) literals.add(m[1]!);
    const PLACED: Record<string, RefusalStage> = {
      "transfer-daily-cap": "wall",
      "energy-needs-live": "wall",
      "energy-not-granted": "wall",
      "no-executor": "exec",
      "no-gas": "exec",
      "not-recorded": "exec",
      "router-migrated": "exec",
      "no-rialto-key": "exec",
      "no-curve-adapter": "exec",
      "class-side-ambiguous": "exec",
      "class-legs-unconfirmed": "exec",
      "class-vault-unreadable": "exec",
      "class-sell-needs-vault": "exec",
      "no-class-vault": "exec",
      "no-route": "market",
      "no-quote": "market",
      "impact-unknown": "market",
      "energy-no-quote": "market",
      "energy-tax": "market",
      "energy-tax-unreadable": "market",
    };
    const refusals = [...literals].filter((r) => !SENT_ROW_RULES.has(r));
    for (const rule of refusals) {
      assert.ok(rule in PLACED, `index.ts books "${rule}" as a refusal and nobody has placed it: add it to stageOf's vocabulary (or leave it on the wall) on purpose`);
    }
    placed("index.ts", refusals, (rule) => PLACED[rule]!);
  });

  it("index.ts: its free-text refusals start with words stageOf knows", () => {
    const index = read("index.ts");
    const prefixes = new Set([...index.matchAll(/reject_rule:\s*`([^`$]*)\$\{/g)].map((m) => m[1]!));
    assert.deepEqual([...prefixes].sort(), ["fence-", "paper: ", "review: "]);
    assert.match(index, /`couldn't submit: \$\{/, "every failure before submit is booked under these words");
    for (const p of [...prefixes, "couldn't submit: "]) assert.equal(stageOf(`${p}anything`), "exec", p);
  });

  it("policy.ts: every rule the wall writes is the wall", () => {
    const policy = read("policy.ts");
    const rules = new Set<string>();
    for (const m of policy.matchAll(/\brule\s*:([^,\n}]*)/g)) for (const q of quoted(m[1]!)) rules.add(q);
    placed("policy.ts", rules, () => "wall");
  });

  it("the rail's refusals: the owner's setup is the wall, a live leg with nothing to send through is execution", () => {
    const rules = unionOf(read("../../packages/core/src/autonomy.ts"), "RefuseRule");
    placed("RefuseRule", rules, (rule) => (rule === "no-gas" || rule === "no-executor" ? "exec" : "wall"));
  });

  it("the gas checks and the sponsor are execution, wherever they are written", () => {
    const gas = read("gas-limits.ts");
    const gasRules = new Set<string>();
    for (const m of gas.matchAll(/\brule\s*:([^,\n};]*)/g)) for (const q of quoted(m[1]!)) gasRules.add(q);
    placed("gas-limits.ts", gasRules, () => "exec");
    placed("executor.ts", new Set([...read("executor.ts").matchAll(/new GasRefused\(\s*"([^"]+)"/g)].map((m) => m[1]!)), () => "exec");
    placed("paymaster.ts", new Set([...read("paymaster.ts").matchAll(/"(sponsor-[a-z-]+)"/g)].map((m) => m[1]!)), () => "exec");
  });

  it("every revert class, since an estimate or a suppression can book any of them as a refusal", () => {
    const PLACED: Record<string, RefusalStage> = {
      slippage: "market",
      "insufficient-balance": "market",
      "no-liquidity": "market",
      "curve-graduated": "market",
      // The session key's own policy, and the vault's sealed caps: the wall, on chain.
      "wall-refused": "wall",
      "spend-cap": "wall",
      "quote-not-approved": "wall",
      allowance: "exec",
      prefund: "exec",
      deadline: "exec",
      "curve-unsupported": "exec",
      unclassified: "exec",
    };
    const classes = unionOf(read("revert.ts"), "RevertClass");
    for (const rule of classes) assert.ok(rule in PLACED, `revert.ts gained the class "${rule}": place it`);
    placed("revert.ts", classes, (rule) => PLACED[rule]!);
  });
});

describe("railOfTrade: the row says its rail wherever it can", () => {
  it("paper is paper, and anything sent is live, whatever the agent's row says now", () => {
    assert.equal(railOfTrade("paper", "", "live"), "paper");
    for (const status of ["submitted", "landed", "reverted", "dropped"]) assert.equal(railOfTrade(status, "", "paper"), "live");
  });

  it("an execution or market refusal is live: only the live rail builds an operation or asks a venue", () => {
    assert.equal(railOfTrade("rejected", "gas-absurd", "paper"), "live");
    assert.equal(railOfTrade("rejected", "sponsor-refused", null), "live");
    assert.equal(railOfTrade("rejected", "couldn't submit: bundler down", "live"), "live");
    assert.equal(railOfTrade("rejected", "no-route", "live"), "live");
    // An agent out of ETH publishes `idle` (exec-mode.ts) — it asked for the
    // live rail and its live leg is the one that failed.
    assert.equal(railOfTrade("rejected", "no-gas", "idle"), "live");
  });

  it("the simulator refusing a fill is the paper rail's, and the broker's review follows the agent", () => {
    assert.equal(railOfTrade("rejected", "paper: paper cash short of the buy", "paper"), "paper");
    assert.equal(railOfTrade("rejected", "paper: paper cash short of the buy", "live"), "paper");
    assert.equal(railOfTrade("rejected", "review: no price for NVDA", "paper"), "paper");
    assert.equal(railOfTrade("rejected", "review: no price for NVDA", "live"), "live");
  });

  it("a wall refusal follows the agent, and an unknown agent is not counted live", () => {
    assert.equal(railOfTrade("rejected", "no-exit", "live"), "live");
    assert.equal(railOfTrade("rejected", "no-exit", "paper"), "paper");
    assert.equal(railOfTrade("rejected", "no-exit", "idle"), "paper");
    assert.equal(railOfTrade("rejected", "no-exit", null), "paper");
  });
});

describe("foldFunnel: one funnel per rail", () => {
  const LIVE = "0x00000000000000000000000000000000000000a1";
  const PAPER = "0x00000000000000000000000000000000000000b2";
  const mode = (id: string) => (id.toLowerCase() === LIVE ? "live" : id.toLowerCase() === PAPER ? "paper" : null);

  it("the incident hour: paper fills and paper no-exits are the paper rail, not an execution drop-off", () => {
    const f = foldFunnel(
      [
        { agent_id: PAPER, status: "rejected", rule: "no-exit", n: 185 },
        { agent_id: PAPER, status: "paper", rule: "", n: "9" },
        { agent_id: LIVE, status: "rejected", rule: "enable-too-wide", n: 44 },
        { agent_id: LIVE, status: "rejected", rule: "gas-absurd", n: 45 },
        { agent_id: LIVE, status: "landed", rule: "", n: 2 },
        { agent_id: LIVE, status: "reverted", rule: "", n: 1 },
      ],
      mode,
    );
    assert.deepEqual(f.paper, { proposals: 194, wallRefused: 185, marketRefused: 0, execRefused: 0, userops: 0, landed: 0, failed: 0, paperFills: 9 });
    assert.deepEqual(f.live, { proposals: 92, wallRefused: 0, marketRefused: 0, execRefused: 89, userops: 3, landed: 2, failed: 1, paperFills: 0 });
    // The gas ceiling saying no is a PASS of policy and a failure of execution.
    assert.equal(policyPassed(f), 194 + 92 - 185);
    assert.deepEqual(f.refusals.map((r) => [r.rule, r.n, r.stage]), [
      ["no-exit", 185, "wall"],
      ["gas-absurd", 45, "exec"],
      ["enable-too-wide", 44, "exec"],
    ]);
  });

  it("an execution outage reads as one: no ETH and a failing bundler are exec-refused, never the wall", () => {
    // What live agents out of ETH, beside a bundler that has started failing,
    // book in an hour. Read as wall refusals, this was "the owner's policy
    // refused everything" with exec-refused 0 published throughout.
    const f = foldFunnel(
      [
        { agent_id: LIVE, status: "rejected", rule: "no-gas", n: 40 },
        { agent_id: "0x00000000000000000000000000000000000000c3", status: "rejected", rule: "no-gas", n: 5 },
        { agent_id: LIVE, status: "rejected", rule: "couldn't submit: bundler: AA21 didn't pay prefund", n: 25 },
        { agent_id: LIVE, status: "rejected", rule: "no-route", n: 3 },
      ],
      (id) => (id.toLowerCase() === LIVE ? "live" : "idle"),
    );
    assert.deepEqual(
      [f.live.proposals, f.live.wallRefused, f.live.marketRefused, f.live.execRefused, f.live.userops],
      [73, 0, 3, 70, 0],
    );
    assert.equal(f.paper.proposals, 0, "an agent that asked for the live rail and has no ETH is not paper");
    assert.equal(policyPassed(f), 73, "the wall said yes to every one of them");
    assert.deepEqual(f.refusals.map((r) => [r.n, r.stage]), [[45, "exec"], [25, "exec"], [3, "market"]]);
  });

  it("the simulator refusing a fill is the paper rail's own execution, not its wall", () => {
    const f = foldFunnel(
      [
        { agent_id: PAPER, status: "rejected", rule: "paper: paper cash short of the buy", n: 4 },
        { agent_id: PAPER, status: "paper", rule: "", n: 6 },
      ],
      mode,
    );
    assert.deepEqual([f.paper.proposals, f.paper.wallRefused, f.paper.execRefused, f.paper.paperFills], [10, 0, 4, 6]);
    assert.equal(f.live.proposals, 0);
    assert.equal(policyPassed(f), 10);
  });

  it("receipt-unresolved is sent with no receipt yet: a userop, never a refusal", () => {
    const f = foldFunnel(
      [
        { agent_id: LIVE, status: "submitted", rule: "receipt-unresolved", n: 2 },
        // Were it ever written beside `rejected`, it would still have gone out.
        { agent_id: PAPER, status: "rejected", rule: "receipt-unresolved", n: 1 },
      ],
      mode,
    );
    assert.equal(f.live.userops, 3);
    for (const rail of [f.live, f.paper]) assert.equal(rail.wallRefused + rail.marketRefused + rail.execRefused, 0);
    assert.equal(f.refusals.length, 0);
  });

  it("the operator's admission gate is apart from the funnel, so an observed cohort reads as held, not as refused", () => {
    const f = foldFunnel(
      [
        { agent_id: LIVE, status: "rejected", rule: "rollout-hold", n: 50 },
        { agent_id: LIVE, status: "rejected", rule: "draining", n: 2 },
        { agent_id: LIVE, status: "rejected", rule: "grant-too-wide", n: 1 },
      ],
      mode,
    );
    assert.equal(f.admissionHeld, 52);
    assert.equal(f.live.proposals, 1);
    assert.equal(f.grantTooWide, 1);
    assert.equal(policyPassed(f), 0);
    assert.ok(!f.refusals.some((r) => r.rule === "rollout-hold"));
  });
});

describe("rails: live only if the row says so AND was written by the worker running now", () => {
  const SPAWN_MS = 1_800_000_000_000;
  const at = Math.floor(SPAWN_MS / 1000);
  const row = (mode: string | null, beat: number | null, blocker: string | null = null) => ({
    smart_account: "0x00000000000000000000000000000000000000a1",
    mode,
    live_blocker: blocker,
    beat_at: beat,
  });

  it("a live row beaten since the spawn is live", () => {
    assert.equal(railOf(row("live", at + 30), SPAWN_MS), "live");
  });

  it("a live row from BEFORE the spawn is the predecessor's: unknown (respawning)", () => {
    // The mirror keeps the last mode and beat across a respawn and copies the
    // blocker over as NULL, so this is exactly what a redeploy leaves behind.
    assert.equal(railOf(row("live", at - 60), SPAWN_MS), RAIL_RESPAWNING);
    assert.equal(railOf(row("live", null), SPAWN_MS), RAIL_RESPAWNING);
  });

  it("live with a blocker is never live", () => {
    assert.equal(railOf(row("live", at + 30, "no-cash"), SPAWN_MS), RAIL_RESPAWNING);
  });

  it("freshness applies to every mode: a stale paper row is no more current than a stale live one", () => {
    assert.equal(railOf(row("paper", at + 30, "live-not-enabled"), SPAWN_MS), "paper");
    assert.equal(railOf(row("paper", at - 60), SPAWN_MS), RAIL_RESPAWNING);
  });

  it("no worker in this replica: nothing here is trading for it, whatever its row last said", () => {
    assert.equal(railOf(row("live", at + 30), undefined), RAIL_NO_WORKER);
  });

  it("a beat in milliseconds is the same beat", () => {
    assert.equal(beatSec((at + 30) * 1000), at + 30);
    assert.equal(railOf(row("live", (at + 30) * 1000), SPAWN_MS), "live");
    assert.equal(railOf(row("live", (at - 60) * 1000), SPAWN_MS), RAIL_RESPAWNING);
  });

  it("the fleet's rails count every agent once, keyed case-blind, and only fresh live rows are live", () => {
    const rails = fleetRails(
      [
        { ...row("live", at + 30), smart_account: "0x00000000000000000000000000000000000000A1" },
        { ...row("live", at - 60), smart_account: "0x00000000000000000000000000000000000000b2" },
        { ...row("paper", at + 30), smart_account: "0x00000000000000000000000000000000000000c3" },
        { ...row("live", at + 30), smart_account: "0x00000000000000000000000000000000000000d4" },
      ],
      new Map([
        ["0x00000000000000000000000000000000000000a1", SPAWN_MS],
        ["0x00000000000000000000000000000000000000b2", SPAWN_MS],
        ["0x00000000000000000000000000000000000000c3", SPAWN_MS],
      ]),
    );
    assert.equal(rails.live, 1);
    assert.deepEqual(rails.counts, { live: 1, paper: 1, [RAIL_RESPAWNING]: 1, [RAIL_NO_WORKER]: 1 });
    assert.equal(railsLine(rails), "fleet| rails — live 1, paper 1, unknown (respawning) 1, no worker here 1");
  });
});

describe("the autonomy lines keep their prefixes", () => {
  const empty = foldFunnel([], () => null);

  it("silent only when nobody is live and nothing happened", () => {
    assert.deepEqual(autonomyLines(0, empty, []), []);
    assert.deepEqual(autonomyLines(null, empty, []), []);
    assert.ok(autonomyLines(2, empty, []).length > 0, "live agents proposing nothing is the alarming hour, never a silent one");
  });

  it("the first line is still `autonomy| 1h — `, then one line per rail, then the refusals tagged by stage", () => {
    const f = foldFunnel(
      [
        { agent_id: "a", status: "rejected", rule: "no-exit", n: 3 },
        { agent_id: "b", status: "rejected", rule: "gas-absurd", n: 1 },
        { agent_id: "b", status: "rejected", rule: "no-quote", n: 1 },
        { agent_id: "b", status: "landed", rule: "", n: 1 },
      ],
      (id) => (id === "b" ? "live" : "paper"),
    );
    const lines = autonomyLines(1, f, [{ kind: "MODEL_HOLD", n: 1 }]);
    assert.match(lines[0]!, /^autonomy\| 1h — 1 live · proposals 6 · policy-passed 3 · userops 1 · LANDED 1 · failed 0 · grant-too-wide 0 · holds /);
    assert.match(lines[1]!, /^autonomy\| 1h live-rail — proposals 3 · wall-refused 0 · market-refused 1 · exec-refused 1 · userops 1 · LANDED 1 · failed 0$/);
    assert.match(lines[2]!, /^autonomy\| 1h paper-rail — proposals 3 · wall-refused 3 · exec-refused 0 · paper-fills 0$/);
    assert.equal(lines[3], "autonomy| 1h refusals — no-exit 3 [wall] · gas-absurd 1 [exec] · no-quote 1 [market]");
  });
});

describe("quiet reviews are a bucket of their own", () => {
  it("the holds query files every quiet-review source under QUIET_REVIEW, and only rows with no kind", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`CREATE TABLE decisions (source TEXT NOT NULL, action TEXT, hold_kind TEXT, at INTEGER NOT NULL)`);
      const add = db.prepare("INSERT INTO decisions (source, action, hold_kind, at) VALUES (?, ?, ?, ?)");
      add.run(REVIEW_SOURCE, "hold", null, 2000);
      add.run(PRIVATE_REVIEW_SOURCE, "hold", null, 2000);
      add.run(RESEARCH_UNAVAILABLE_SOURCE, "hold", null, 2000);
      add.run("strategy:steady-basket", "hold", null, 2000);
      add.run("brain", "hold", "MODEL_HOLD", 2000);
      // A kind the writer stamped is the kind counted, whatever the source.
      add.run(REVIEW_SOURCE, "hold", "STALE_MARK_HOLD", 2000);
      add.run(REVIEW_SOURCE, "hold", null, 1000); // outside the hour
      add.run(REVIEW_SOURCE, "buy", null, 2000); // not a hold
      const rows = db.prepare(AUTONOMY_HOLDS_SQL).all(1500) as { kind: string; n: number }[];
      const by = Object.fromEntries(rows.map((r) => [r.kind, Number(r.n)]));
      assert.deepEqual(by, { QUIET_REVIEW: 3, unreported: 1, MODEL_HOLD: 1, STALE_MARK_HOLD: 1 });
      const line = autonomyHolds(rows);
      assert.match(line, /\b3 quiet-review\b/);
      assert.match(line, /\b1 unreported\b/);
    } finally {
      db.close();
    }
  });
});
