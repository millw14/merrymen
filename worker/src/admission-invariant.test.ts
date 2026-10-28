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

  it("AND NO UNGATED WORKER MODULE SENDS: RH uses this funnel and the Solana sibling uses its durable tenant gate", () => {
    // key-install-accounting.ts's installKeyRecorded is the booking around
    // executor.installKey; it is called from installKeyAlone alone (above).
    // Solana has a separate owner namespace and on-chain authority. Its one
    // application caller is pinned below; it must never enter the EVM funnel.
    // Behavioral tests in solana-app-runtime/trading-store also exercise lost
    // responses, mode/strategy races and committed-before-broadcast ordering.
    const ALLOWED = new Set(["executor.ts", "key-install-accounting.ts", "index.ts", "solana-app-runtime.ts"]);
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

  it("the Solana sibling cannot borrow RH execution or broadcast before its own durable gate", () => {
    const app = codeOf(readFileSync(path.join(HERE, "solana-app-runtime.ts"), "utf8"));
    const executor = codeOf(readFileSync(path.join(HERE, "solana-executor.ts"), "utf8"));
    const agent = codeOf(readFileSync(path.join(HERE, "solana-agent.ts"), "utf8"));
    assert.doesNotMatch(app, /createAgentExecutor|installKeyRecorded|installKey/);
    assert.equal((app.match(/createSolanaExecutor\(/g) ?? []).length, 1);
    assert.equal((app.match(/\.execute\(/g) ?? []).length, 1);
    // The executor's durable gate is the tenant-scoped store `s`: every journal
    // method delegates to it, and recordSigned adds only the configured
    // expired-attempt allowance and reference tolerance (numbers, never another store or a bypass).
    assert.equal((app.match(/const journal\b/g) ?? []).length, 1);
    assert.match(app, /const journal: SolanaLiveJournal = \{ get: \(owner, requestId\) => s\.get\(owner, requestId\), settle: \(\.\.\.args\) => s\.settle\(\.\.\.args\),\s*recordSigned: submission => s\.recordSigned\(submission, \{ expiredAttemptAllowance: expiredAllowance, referenceToleranceBps: toleranceBps \}\) \};/);
    assert.match(app, /const expiredAllowance = expiredAttemptAllowance\(\);/);
    assert.match(app, /const toleranceBps = referenceToleranceBps\(\);/);
    const executorOptions = app.slice(app.indexOf("createSolanaExecutor("), app.indexOf("assessRisk:", app.indexOf("createSolanaExecutor(")));
    assert.match(executorOptions, /\bjournal, maxFeeLamports\b/);
    assert.doesNotMatch(executorOptions, /journal:/);
    assert.match(app, /const s = await store\(scope, input\.autonomousRevision, input\.signal\)/);
    const admission = executor.indexOf("await options.journal.recordSigned(submission)");
    const send = executor.indexOf("await options.rpc.send(");
    assert.ok(admission > 0 && send > admission);
    assert.equal((executor.match(/options\.rpc\.send\(/g) ?? []).length, 1);
    assert.match(executor.slice(admission, send), /return fail\("conflict"\)/);
    const savedOwner = app.indexOf("const first = await s.saveSetup(signed)");
    const ownerSend = app.indexOf("await rpc().send(");
    assert.ok(savedOwner > 0 && ownerSend > savedOwner);
    assert.match(app.slice(savedOwner, ownerSend), /if \(first\)/);
    assert.equal((app.match(/rpc\(\)\.send\(/g) ?? []).length, 1);
    assert.doesNotMatch(agent, /createSolanaExecutor|signTransaction|\.send\(/);
    assert.match(agent, /runtime\.trade\(scope, \{ mode: row\.requested_mode, intent, autonomousRevision: Number\(row\.revision\), signal: options\.signal \}\)/);
  });

  /**
   * The body of a function declared at `indent` in `code`, from its declaration
   * to the first closing brace at that indent.
   */
  const body = (code: string, declaration: string, indent = "") => {
    const at = code.indexOf(declaration);
    assert.ok(at >= 0, `${declaration.trim()} must exist for this pin to mean anything`);
    const end = code.indexOf(`\n${indent}}\n`, at);
    assert.ok(end > at, `${declaration.trim()} has no closing brace`);
    return code.slice(at, end);
  };
  /** Solana sends go through SolanaLiveRpc.send; these are every module allowed to call it, and how often. */
  const SOLANA_SENDERS: Record<string, number | "owner-run"> = {
    // execute (after recordSigned) and reconcileSolanaSubmission's rebroadcast of the saved bytes.
    "solana-executor.ts": 2,
    // submitOwner (after saveSetup) and ownerStatus's rebroadcast of the saved bytes.
    "solana-app-runtime.ts": 2,
    // The owner-run recovery tool: the owner's own key, the owner's chosen RPC, no
    // server state. Its sends are its own track's to pin; here it must stay unreachable
    // from the server (below).
    "solana-recover.ts": "owner-run",
  };

  it("EVERY SOLANA SEND SITE IS ONE OF THE PINNED ONES: no other worker module broadcasts a Solana transaction", () => {
    const offenders: string[] = [];
    const counts: Record<string, number> = {};
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== "node_modules") walk(p); continue; }
        if (!e.name.endsWith(".ts") || e.name.endsWith(".test.ts")) continue;
        const rel = path.relative(HERE, p), code = codeOf(readFileSync(p, "utf8"));
        // The raw RPC method exists only in the transport, which sends nothing on its own.
        if (rel !== "solana-live-rpc.ts" && /["'`]sendTransaction["'`]/.test(code)) offenders.push(`${rel} (raw sendTransaction)`);
        if (!/solana-live-rpc|SolanaLiveRpc/.test(code)) continue;
        const sends = (code.match(/\.send\(/g) ?? []).length;
        if (!sends) continue;
        counts[rel] = sends;
        if (!Object.hasOwn(SOLANA_SENDERS, rel)) offenders.push(rel);
      }
    };
    walk(HERE);
    assert.deepEqual(offenders, [], `these modules can broadcast a Solana transaction outside the pinned sites: ${offenders.join(", ")}`);
    for (const [file, expected] of Object.entries(SOLANA_SENDERS)) {
      if (expected === "owner-run") continue;
      assert.equal(counts[file], expected, `${file}: every send is pinned below; a new one needs its own durable-record pin`);
    }
    // The transport's read path cannot send: sendTransaction is not a read method.
    const transport = codeOf(readFileSync(path.join(HERE, "solana-live-rpc.ts"), "utf8"));
    const reads = transport.slice(transport.indexOf("const READ_METHODS"), transport.indexOf("] as const"));
    assert.ok(reads.includes("getAccountInfo") && !reads.includes("sendTransaction"));
  });

  it("the owner-run recovery tool is unreachable from the server, and no browser module sends", () => {
    const importers: string[] = [];
    const walk = (dir: string, root: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== "node_modules") walk(p, root); continue; }
        if (!/\.(ts|tsx)$/.test(e.name) || /\.test\.tsx?$/.test(e.name)) continue;
        const code = codeOf(readFileSync(p, "utf8"));
        if (/from\s+["'][^"']*solana-recover["']/.test(code)) importers.push(path.relative(root, p));
        if (root !== HERE && /\bsignAndSendTransaction\b|["'`]sendTransaction["'`]/.test(code)) importers.push(`${path.relative(root, p)} (browser send)`);
      }
    };
    walk(HERE, HERE);
    walk(path.join(HERE, "..", "..", "web", "src"), path.join(HERE, "..", "..", "web", "src"));
    // Only its own command and entry point use it; the CLI runs them as a separate process.
    assert.deepEqual(importers.sort(), ["solana-recover-cli.ts", "solana-recover-command.ts"], `unexpected importers: ${importers.join(", ")}`);
  });

  it("each Solana send broadcasts only bytes already in a durable record, after that record", () => {
    const app = codeOf(readFileSync(path.join(HERE, "solana-app-runtime.ts"), "utf8"));
    const executor = codeOf(readFileSync(path.join(HERE, "solana-executor.ts"), "utf8"));
    // Neither module can sign for the owner: the owner signs in the browser or the recovery tool.
    assert.doesNotMatch(app, /\bsignTransaction\b|partiallySignTransaction/);

    // 1. execute: recordSigned commits the exact bytes, a conflict returns before any send.
    const execute = executor.slice(executor.indexOf("await options.journal.recordSigned(submission)"));
    const executeSend = execute.indexOf("await options.rpc.send(");
    assert.ok(executeSend > 0);
    assert.match(execute.slice(0, executeSend), /return fail\("conflict"\)/);
    assert.match(execute.slice(executeSend, executeSend + 120), /options\.rpc\.send\(submission\.signedTransactionBase64, submission\.minContextSlot/);

    // 2. reconcileSolanaSubmission: rebroadcasts the journal's own pending record, never new bytes,
    //    and only after both providers were asked and neither has seen it.
    const reconcile = body(executor, "export async function reconcileSolanaSubmission(");
    const loaded = reconcile.indexOf("const record = await journal.get(owner, requestId)");
    const notPending = reconcile.indexOf(`if (!record || record.status !== "pending") return record`);
    const fromRecord = reconcile.indexOf("const submission = record.submission");
    const quorum = reconcile.indexOf("await readSolanaQuorum(rpc,");
    const unseen = reconcile.indexOf("if (quorum.values.every(item => !item.seen && !item.settlement)");
    const rebroadcast = reconcile.indexOf("await rpc.send(submission.signedTransactionBase64, submission.minContextSlot");
    assert.ok(loaded > 0 && notPending > loaded && fromRecord > notPending && quorum > fromRecord && unseen > quorum && rebroadcast > unseen,
      "reconcileSolanaSubmission: load the durable record, stop unless pending, ask both providers, then resend only unseen saved bytes");
    assert.match(reconcile.slice(unseen, rebroadcast), /nowMs < signedDeadlineMs\(submission\)/, "never after the signed deadline");
    assert.equal((reconcile.match(/\.send\(/g) ?? []).length, 1);
    assert.doesNotMatch(reconcile, /sign(?:Transaction|Bytes)?\(|KeyPair/);

    // 3. submitOwner: the signed bytes are saved first; only the first save sends.
    const submit = body(app, "  async function submitOwner(", "  ");
    const saved = submit.indexOf("const first = await s.saveSetup(signed)");
    const ownerSend = submit.indexOf("await rpc().send(input.signedTransactionBase64, 1)");
    assert.ok(saved > 0 && ownerSend > saved);
    assert.match(submit.slice(saved, ownerSend), /if \(first\)/);
    assert.match(submit.slice(0, saved), /signedTransactionBase64: input\.signedTransactionBase64, status: "pending"/);
    assert.equal((submit.match(/\.send\(/g) ?? []).length, 1);

    // 4. ownerStatus: rebroadcasts the saved setup's own signed bytes, only while
    //    every provider has not seen them and their blockhash can still land.
    const status = body(app, "  async function ownerStatus(", "  ");
    const savedBytes = status.indexOf("signed = setup.signedTransactionBase64");
    const finished = status.indexOf(`if (setup.status === "finalized" || setup.status === "failed") return`);
    const asked = status.indexOf("await readSolanaQuorum(live,");
    const canLand = status.indexOf(`if (quorum.values.every(view => view.outcome === "pending" && !view.seen && view.canLand))`);
    const resend = status.indexOf("await live.send(signed, 1,");
    assert.ok(savedBytes > 0 && finished > savedBytes && asked > finished && canLand > asked && resend > canLand,
      "ownerStatus: saved bytes, finished outcomes return, both providers asked, then resend only unseen bytes that can land");
    assert.equal((status.match(/\.send\(/g) ?? []).length, 1);
    // ownerStatus is handed only setups just read back from the store: the main slot
    // (s.setup()) or the revocation beside it (s.revokeSetup()), chosen by a condition at most.
    const calls = [...app.matchAll(/ownerStatus\(s, (\w+)\)/g)];
    assert.ok(calls.length >= 3, "status, activateLive and submitOwner each ask");
    const storeRead = /\bsetup = (?:[\w ="]+ \? )?await s\.(?:setup|revokeSetup)\(\)(?: : await s\.(?:setup|revokeSetup)\(\))?[;,]/g;
    for (const call of calls) {
      assert.equal(call[1], "setup");
      const reads = [...app.slice(0, call.index).matchAll(storeRead)], read = reads.at(-1);
      assert.ok(read, `ownerStatus at offset ${call.index} is not handed a stored setup`);
      assert.doesNotMatch(app.slice(read.index! + read[0].length, call.index), /\bsetup\s*=(?!=)/, "nor one changed after reading it");
    }
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
    // NOT the perp lane's execute: in this build it books paper only and sends
    // nothing (perps/lane.ts; a live account is refused perp-live-not-yet), and
    // a draining worker refused the perp intent at admission. The live lane
    // must take its own last-moment check when it lands.
    const sends = [...BODY.matchAll(/(?<!perpLane)\.execute\(([^)]*)\)/g)].map((m) => m[1] ?? "");
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
      // And the perps protective loop, whose exits no drain refusal reaches:
      // stopped before the wait, and waited for before the ledger closes.
      "const protectStopped = perpLane.stopProtect()",
      "drainIntentChain({",
      "tail: () => intentChain,",
      // And the tick that put the trade there: its work after the chain empties.
      "tick: () => tickClock.settled(),",
      "budgetMs: DRAIN_INTENT_CHAIN_MS,",
      "const left = Math.max(0, drainStartedAt + DRAIN_INTENT_CHAIN_MS - Date.now());",
      "protectStopped.then(() => true),",
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
