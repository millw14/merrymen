import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";

import { wrapSqlite } from "./db";
import { publicationNarrowing, publishableThesis, rejectRuleLabel, rejectRuleRemedy, type ThesisRow } from "./thesis-policy";

/**
 * NOTHING SIGNS, FILLS OR SENDS EXCEPT PAST THE ADMISSION GATE.
 *
 * worker-admission.ts decides what a tenant brought back after a hold may
 * start, and refuses everything new once its worker is told to leave. It is
 * judged in ONE place: the top of processIntentLocked. That is only a gate if
 * two things stay true, and neither is something a type can say:
 *
 *   - every way this worker can move money runs inside processIntentLocked —
 *     the executor's send and its key install, the broker lane's place, the
 *     paper fill — and processIntentLocked is reached only through the
 *     serialising intent chain;
 *   - the gate is the first thing processIntentLocked asks, before a budget is
 *     reserved, a policy read or a quote taken, so a refusal holds nothing
 *     open and leaves nothing a restart could replay.
 *
 * A new caller of `executor.execute` written beside the funnel would typecheck,
 * pass every pure test, and trade for a tenant at `observe`. So, as
 * budget-reservation.invariant.test.ts and energy-wiring.test.ts already do
 * for this file, it is read as TEXT — index.ts is one main() with no exports,
 * and a structural test on unreachable code beats no test on load-bearing
 * code. Comments are stripped first: prose about execute() is not a call.
 *
 * And the way out: the SIGTERM handler raises `draining`, stops the clock,
 * waits a bounded time for the chain, closes the ledger and exits — in that
 * order, with nothing able to write between the close and the exit.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

const codeOf = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");

const CODE = codeOf(readFileSync(path.join(HERE, "index.ts"), "utf8"));

/** A function declared in main() — two-space indent — from its declaration to its closing brace. */
function span(declaration: string): [number, number] {
  const at = CODE.indexOf(declaration);
  assert.ok(at > 0, `${declaration.trim()} must exist for this pin to mean anything`);
  const end = CODE.indexOf("\n  }\n", at);
  assert.ok(end > at, `${declaration.trim()} has no closing brace at main()'s indent`);
  return [at, end];
}

const LOCKED = span("  async function processIntentLocked(");
const BODY = CODE.slice(LOCKED[0], LOCKED[1]);

/** Every index at which `re` matches in the code. */
function sites(re: RegExp): number[] {
  return [...CODE.matchAll(new RegExp(re.source, "g"))].map((m) => m.index!);
}

const inside = ([from, to]: [number, number], at: number) => at > from && at < to;
const lineOf = (at: number) => CODE.slice(0, at).split("\n").length;

describe("every way this worker moves money runs inside processIntentLocked", () => {
  // The calls that sign, send or fill. Each must exist, so the scan is not
  // vacuous, and each must sit inside the funnel's body.
  const MOVES: [string, RegExp][] = [
    // Any `.execute(` at all, not only `executor.execute(`: a send through a
    // renamed handle is still a send. index.ts has no other method by that name.
    ["the executor's send", /\.execute\(/],
    ["the key install on its own", /(?<!function )\binstallKeyAlone\(/],
    ["the broker lane's place", /\borderExec\.place\(/],
    ["the paper fill", /\bapplyPaperIntent\(/],
  ];
  for (const [what, re] of MOVES) {
    it(`${what} is only ever called inside it`, () => {
      const at = sites(re);
      assert.ok(at.length > 0, `found no ${what} at all — renamed? then this pin checks nothing`);
      for (const i of at) {
        assert.ok(
          inside(LOCKED, i),
          `worker/src/index.ts:${lineOf(i)} — ${what} outside processIntentLocked, where no admission gate stands. ` +
            "Route it through processIntent, or a tenant held at observe can trade.",
        );
      }
    });
  }

  it("nothing in index.ts installs a key straight off the executor — only through the booking below", () => {
    for (const i of sites(/\.installKey\(/)) {
      assert.ok(inside(LOCKED, i), `worker/src/index.ts:${lineOf(i)} installs a key outside processIntentLocked`);
    }
  });

  it("HOWEVER IT IS SPELLED: the words `execute` and `installKey` are never written outside it", () => {
    // `.execute(` is one spelling of a send. `ex["execute"](…)`, `const {
    // execute } = active.executor` and `.execute.call(…)` are others, and each
    // typechecks. index.ts has no other use for either word in code (comments
    // are stripped), so the word itself is the pin: found outside the funnel,
    // it is a send, or something one refactor away from being one.
    for (const word of [/\bexecute\b/, /\binstallKey\b/]) {
      for (const i of sites(word)) {
        assert.ok(
          inside(LOCKED, i),
          `worker/src/index.ts:${lineOf(i)} — \`${word.source.replace(/\\b/g, "")}\` outside processIntentLocked. ` +
            "If it sends, route it through processIntent; a tenant held at observe could otherwise trade.",
        );
      }
    }
  });

  it("the key install itself is reached only from installKeyAlone", () => {
    const owner = span("  async function installKeyAlone(");
    const at = sites(/\binstallKeyRecorded\(/);
    assert.ok(at.length > 0);
    for (const i of at) assert.ok(inside(owner, i), `worker/src/index.ts:${lineOf(i)} installs a key outside installKeyAlone`);
  });

  it("AND NO OTHER WORKER MODULE SENDS: the executor's own file and the key-install booking are the only others that call it", () => {
    // key-install-accounting.ts's installKeyRecorded is the booking around
    // executor.installKey; it is called from installKeyAlone alone (above).
    const ALLOWED = new Set(["executor.ts", "key-install-accounting.ts", "index.ts"]);
    // Every spelling of a send, not only the dotted call. Other modules use
    // the bare word `execute` in prose and in ABI strings, so here it is the
    // shapes of a call that are matched: a dotted member (`.execute(`,
    // `.execute.call(`), a bracketed one (`ex["execute"]`) and a destructured
    // one (`const { execute } = …`).
    const SENDS = [
      /\.(?:execute|installKey)\b/,
      /\[\s*["'`](?:execute|installKey)["'`]\s*\]/,
      /\{[^{}]*\b(?:execute|installKey)\b[^{}]*\}\s*=(?![=>])/,
      /\binstallKeyRecorded\(/,
      /\bcreateAgentExecutor\(/,
    ];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== "node_modules") walk(p);
          continue;
        }
        if (!e.name.endsWith(".ts") || e.name.endsWith(".test.ts")) continue;
        const rel = path.relative(HERE, p);
        if (ALLOWED.has(rel)) continue;
        const code = codeOf(readFileSync(p, "utf8"));
        if (SENDS.some((re) => re.test(code))) offenders.push(rel);
      }
    };
    walk(HERE);
    assert.deepEqual(offenders, [], `these modules can send without passing the admission gate: ${offenders.join(", ")}`);
  });

  it("and the executor is built in one place, which hands it to `active` — the funnel's own handle", () => {
    const at = sites(/\bcreateAgentExecutor\(/);
    assert.equal(at.length, 1, "one executor factory call in index.ts");
  });
});

describe("processIntentLocked is reached only through the intent chain", () => {
  it("EVERY CALL IS IN processIntent OR processIntentReporting, queued on intentChain", () => {
    const wrappers: [number, number] = [CODE.indexOf("  function processIntent("), LOCKED[0]];
    assert.ok(wrappers[0] > 0 && wrappers[0] < wrappers[1]);
    const calls = sites(/\bprocessIntentLocked\(/).filter((i) => i !== LOCKED[0] + "  async function ".length);
    assert.ok(calls.length >= 2, "both wrappers call it");
    for (const i of calls) {
      assert.ok(inside(wrappers, i), `worker/src/index.ts:${lineOf(i)} calls processIntentLocked off the chain`);
    }
    const region = CODE.slice(wrappers[0], wrappers[1]);
    assert.equal((region.match(/intentChain\.then\(/g) ?? []).length, 2, "each wrapper queues on the chain");
  });
});

describe("THE GATE IS THE FIRST THING THE FUNNEL ASKS", () => {
  const gate = BODY.indexOf("admissionRefusal(");

  it("it is asked with this process's level, its draining flag and the tick's held legs", () => {
    assert.ok(gate > 0, "processIntentLocked must call admissionRefusal");
    assert.match(
      BODY,
      /const admissionRule = admissionRefusal\(\{ level: admission\.level, draining \}, intent, limits, lastHeldLegs\);/,
    );
    assert.equal((BODY.match(/admissionRefusal\(/g) ?? []).length, 1, "asked once");
  });

  it("BEFORE a budget is reserved, a policy judged, a peak read or anything sent", () => {
    for (const later of [
      "reserveBudget(countsSpend",
      "checkPolicy(",
      "scoutContextFor(",
      "getRiskPeriodPeak(",
      "getAgentFinancials(",
      "getTransferredTodayUsdg(",
      "suppressedIntents.get(",
      "executor.execute(",
      "applyPaperIntent(",
    ]) {
      const at = BODY.indexOf(later);
      assert.ok(at > 0, `${later} must still be in processIntentLocked for this ordering to mean anything`);
      assert.ok(gate < at, `${later} runs before the admission gate`);
    }
  });

  it("A REFUSAL WRITES A REJECTED ROW NAMING ITS RULE, AND RETURNS — reserving nothing", () => {
    const at = BODY.indexOf("if (admissionRule) {");
    assert.ok(at > gate);
    const branch = BODY.slice(at, BODY.indexOf("\n    }\n", at));
    assert.match(branch, /await recordTrade\(\{[\s\S]*status: "rejected",[\s\S]*reject_rule: admissionRule,[\s\S]*\}\);\s*return;$/);
    assert.doesNotMatch(branch, /reserveBudget|executor|releaseBudget/);
    // recordTrade is what sets lastTradeOutcome, so an owner's order is told.
    assert.match(BODY.slice(0, gate), /const recordTrade = async \(row: TradeRow\) => \{[\s\S]*lastTradeOutcome = ledgerFactsOf\(row\);/);
  });

  it("the level is read once, failing closed on a hosted worker, and draining is only ever raised", () => {
    assert.match(CODE, /const admission = admissionFrom\(process\.env\[ADMISSION_LEVEL_ENV\], isHostedMode\(\)\);/);
    assert.equal(sites(/\badmissionFrom\(/).length, 1);
    assert.equal(sites(/\bdraining = true;/).length, 1, "raised in one place — the SIGTERM handler");
    assert.equal(sites(/(?<!let )\bdraining = false;/).length, 0, "and never lowered");
    assert.equal(sites(/let draining = false;/).length, 1);
  });

  it("the held legs it asks with are the tick's own, taken where the energy filter takes them", () => {
    const held = CODE.indexOf("const heldLegs = heldCurveLegs({");
    const cached = CODE.indexOf("lastHeldLegs = heldLegs;");
    const loop = CODE.indexOf("for (const [proposedAt, intent] of proposed.entries()) {");
    assert.ok(held > 0 && cached > held && loop > cached);
    assert.equal(sites(/\blastHeldLegs = /).length, 1, "nothing else writes it");
  });
});

describe("AND DRAINING IS ASKED AGAIN AT EACH BROADCAST — a signal can land mid-intent", () => {
  // The gate above judges an intent where it enters. Between there and the
  // send are the risk peak, the scout context, the transfer total, a quote, a
  // simulation and a signature — every one an await. An intent that passed
  // the gate a moment before SIGTERM must still be stopped before it goes out:
  // node used to die on the signal, so such an intent never did.

  it("the broker lane: asked after the review, immediately before place() — nothing but the refusal between", () => {
    const place = BODY.indexOf("const placed = await orderExec.place(");
    assert.ok(place > 0, "place() must still be in processIntentLocked for this pin to mean anything");
    const guard = BODY.lastIndexOf("if (draining) {", place);
    assert.ok(guard > BODY.indexOf("review = await orderExec.review("), "asked after the review's await");
    assert.match(
      BODY.slice(guard, place),
      /^if \(draining\) \{\s*await recordTrade\(\{[^}]*status: "rejected",[^}]*reject_rule: "draining",[^}]*\}\);\s*return;\s*\}\s*$/,
    );
  });

  it("the live rail: asked after every read the gate came before, and before the reservation", () => {
    const reserve = BODY.indexOf("reserveBudget(countsSpend ? notional : 0n);");
    assert.ok(reserve > 0);
    const guard = BODY.lastIndexOf("if (draining) {", reserve);
    for (const read of ["getRiskPeriodPeak(", "scoutContextFor(", "getTransferredTodayUsdg("]) {
      assert.ok(BODY.indexOf(read) < guard, `${read} comes after the live rail's draining check`);
    }
    const branch = BODY.slice(guard, BODY.indexOf("\n    }\n", guard));
    assert.match(branch, /await recordTrade\(\{[\s\S]*status: "rejected",[\s\S]*reject_rule: "draining",[\s\S]*\}\);\s*return;$/);
    assert.doesNotMatch(BODY.slice(guard, reserve), /reserveBudget\(|executor/);
  });

  it("THE EXECUTOR'S onSubmitted: the last moment, signed and not yet sent — it throws before the pre-broadcast row", () => {
    const hook = BODY.indexOf("onSubmitted: async (userOpHash, op) => {");
    assert.ok(hook > 0);
    const check = BODY.indexOf("if (draining) throw new DrainingRefused();", hook);
    const row = BODY.indexOf("const wrote = await addTrade({", hook);
    assert.ok(check > hook && row > check, "the draining check is the hook's first statement, before the submitted row");
    assert.doesNotMatch(BODY.slice(hook, check), /\bawait\b/);
    // Every send carries these hooks — the plain send and the vault deploy.
    const sends = [...BODY.matchAll(/\.execute\(([^)]*)\)/g)].map((m) => m[1] ?? "");
    assert.ok(sends.length >= 2);
    for (const args of sends) assert.match(args, /\bsubmitHooks\b/, `a send without the hook that refuses it: execute(${args})`);
  });

  it("and the refusal it throws is booked as one: rejected, `draining`, the reservation released, no submitted row", () => {
    const at = BODY.indexOf("if (e instanceof DrainingRefused) {");
    assert.ok(at > 0, "the live rail's catch must handle DrainingRefused");
    const branch = BODY.slice(at, BODY.indexOf("\n      }\n", at));
    assert.match(branch, /releaseBudget\(\);[\s\S]*await recordTrade\(\{[\s\S]*status: "rejected",[\s\S]*reject_rule: e\.rule,[\s\S]*\}\);\s*return;$/);
    // Before the branches that treat a thrown send as possibly out.
    assert.ok(at < BODY.indexOf("if (e instanceof UserOpUnresolved) {"));
  });

  it("THE KEY INSTALL: refused before it starts, and again at its own broadcast", () => {
    const [from, to] = span("  async function installKeyAlone(");
    const fn = CODE.slice(from, to);
    const first = fn.indexOf("{") + 1;
    assert.match(fn.slice(first), /^\s*if \(draining\) return;/, "installKeyAlone's first statement");
    assert.match(fn, /beforeBroadcast: \(\) => \{\s*if \(draining\) throw new DrainingRefused\(\);\s*\}/);
    const booking = codeOf(readFileSync(path.join(HERE, "key-install-accounting.ts"), "utf8"));
    const hook = booking.indexOf("executor.installKey({ onSubmitted: async (hash, op) => {");
    assert.ok(hook > 0);
    const asked = booking.indexOf("deps.beforeBroadcast?.();", hook);
    assert.ok(asked > hook && asked < booking.indexOf("recorded = await deps.addTrade(", hook), "asked before the install's pre-broadcast row");
  });
});

describe("SIGTERM: stop starting things, let the chain finish, leave", () => {
  const at = CODE.indexOf('process.on("SIGTERM", () => {');
  const handler = CODE.slice(at, CODE.indexOf("\n  });\n", at));

  it("is registered once, after the clock exists", () => {
    assert.ok(at > 0, "index.ts must register a SIGTERM handler");
    assert.equal(sites(/process\.(on|once)\("SIGTERM"/).length, 1);
    const clock = CODE.indexOf("const tickClock = createCommandClock(");
    assert.ok(clock > 0 && at > clock, "registered after tickClock, which it stops");
    const poll = CODE.indexOf("const telegramPoll = startTelegram({");
    assert.ok(poll > 0 && at > poll, "and after the Telegram poll, which it stops too");
  });

  it("IN THIS ORDER: raise draining, stop the clock, wait for the chain within its budget, close the ledger, exit 0", () => {
    const steps = [
      "if (draining) return;",
      "draining = true;",
      "tickClock.stop();",
      // And the Telegram poll: an owner's message that arrives now is left
      // unconsumed for the next process, not taken by one that is leaving.
      "telegramPoll.stop();",
      "drainIntentChain({",
      "tail: () => intentChain,",
      // And the tick that put the trade there: its work after the chain empties.
      "tick: () => tickClock.settled(),",
      "budgetMs: DRAIN_INTENT_CHAIN_MS,",
      "closeStore();",
      "process.exit(0);",
    ];
    let last = -1;
    for (const step of steps) {
      const i = handler.indexOf(step);
      assert.ok(i > last, `${step} is missing or out of order in the SIGTERM handler`);
      last = i;
    }
  });

  it("NOTHING CAN WRITE BETWEEN THE CLOSE AND THE EXIT — same callback, no await, no yield", () => {
    const close = handler.indexOf("closeStore();");
    const between = handler.slice(close, handler.indexOf("process.exit(0);"));
    assert.doesNotMatch(between, /\bawait\b|\.then\(|setTimeout|setImmediate/);
  });

  it("exits 0 and nothing else — a drained worker is a clean stop, not a crash", () => {
    assert.deepEqual(handler.match(/process\.exit\(\d+\)/g), ["process.exit(0)"]);
  });
});

describe("an owner refused at admission is told in words", () => {
  for (const rule of ["rollout-hold", "draining"]) {
    it(`${rule} has a sentence, not the slug echoed back, and no remedy to chase`, () => {
      const label = rejectRuleLabel(rule);
      assert.ok(label && label.length > 0, `${rule} would reach the owner as the bare slug`);
      assert.ok(!label.includes(rule));
      assert.ok(!/\bwall\b|permission|re-sign|\/grant/i.test(label), "it is the service holding back, not the owner's signature");
      assert.equal(rejectRuleRemedy(rule), null, "there is nothing for the owner to change");
    });
  }
});

describe("BUT THE PUBLIC FEED DOES NOT CARRY IT — the service's hold is not a view about the coin", () => {
  // A fleet coming back from a hold starts at observe, so every tick of every
  // tenant writes a rollout-hold refusal, from every producer — a Brain that
  // re-reviews every thirty seconds included. drawdown-halt.test.ts is the
  // same flood for the breaker; these are its rule list's newer members.
  const refused = (over: Partial<ThesisRow>): ThesisRow => ({
    agent_id: "0xabcabcabcabcabcabcabcabcabcabcabcabcabca",
    name: "Shogun",
    source: "brain",
    action: "buy",
    symbol: "T3139F043B88",
    display_name: "JUGGERNAUT",
    size_usdg: 5,
    reason: "Five-minute flow flipped to net buying on rising volume; small entry, invalidated if sellers return.",
    status: "rejected",
    reject_rule: "rollout-hold",
    said: 1,
    last_at: 1_800_000_000,
    first_at: 1_800_000_000,
    mode: "live",
    ...over,
  });

  for (const rule of ["rollout-hold", "draining"]) {
    it(`${rule}: dropped for every source, the model's included`, () => {
      for (const source of ["brain", "strategy:trencher", "strategy:steady-basket"]) {
        assert.equal(publishableThesis(refused({ source, reject_rule: rule })), null, `${source} refused on ${rule}`);
      }
    });
  }

  it("a model's refused view on any other account rule still publishes — that boundary is unchanged", () => {
    const post = publishableThesis(refused({ reject_rule: "ops-cap" }));
    assert.ok(post);
    assert.equal(post!.outcome, "refused");
  });

  it("and the SQL half drops them too, so a recovery's worth cannot fill a bounded scan", async () => {
    const raw = new DatabaseSync(":memory:");
    const db = wrapSqlite(raw);
    try {
      await db.exec(`CREATE TABLE decisions(id TEXT, source TEXT, action TEXT);
        CREATE TABLE trades(id INTEGER PRIMARY KEY AUTOINCREMENT, decision_id TEXT, status TEXT, reject_rule TEXT);`);
      const rows: [string, string, string, string | null][] = [
        ["held", "brain", "rejected", "rollout-hold"],
        ["held-strategy", "strategy:trencher", "rejected", "rollout-hold"],
        ["draining", "brain", "rejected", "draining"],
        ["capped", "brain", "rejected", "ops-cap"],
        ["landed", "brain", "landed", null],
      ];
      for (const [id, source, status, rule] of rows) {
        await db.prepare("INSERT INTO decisions VALUES (?, ?, 'buy')").run(id, source);
        await db.prepare("INSERT INTO trades (decision_id, status, reject_rule) VALUES (?, ?, ?)").run(id, status, rule);
      }
      const narrow = publicationNarrowing("d", "t");
      const kept = new Set(
        ((await db
          .prepare(`SELECT d.id AS id FROM decisions d LEFT JOIN trades t ON t.decision_id = d.id WHERE ${narrow.sql}`)
          .all(...narrow.args)) as { id: string }[]).map((r) => r.id),
      );
      assert.deepEqual([...kept].sort(), ["capped", "landed"]);
    } finally {
      raw.close();
    }
  });
});
