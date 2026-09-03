import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import type { Hex } from "viem";
import {
  compareEventSets,
  keyOf,
  runShadowComparison,
  shadowEnabledFor,
  shadowLine,
} from "./reconcile-shadow";
import { addressTopic, type RawLog, type ReconcileChain } from "./inflight-reconcile";

const TOPIC0 = "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f" as Hex;
const ACC = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`;
const OTHER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as `0x${string}`;
const h = (n: number) => (`0x${n.toString(16).padStart(64, "0")}`) as Hex;

function logFor(sender: `0x${string}`, n: number, block = 100n): RawLog {
  return {
    topics: [TOPIC0, h(n), addressTopic(sender), addressTopic(sender)],
    data: "0x",
    transactionHash: (`0x${n.toString(16).padStart(64, "0")}`) as Hex,
    blockNumber: (`0x${block.toString(16)}`) as Hex,
    logIndex: "0x0",
  };
}

function chainOf(logs: RawLog[]): ReconcileChain {
  return {
    async getBlockNumber() {
      return 1000n;
    },
    async getLogs(args) {
      const t2 = args.topics[2];
      return logs.filter((l) => {
        const b = BigInt(l.blockNumber ?? "0x0");
        if (b < args.fromBlock || b > args.toBlock) return false;
        if (!t2) return true;
        const want = Array.isArray(t2) ? t2 : [t2];
        return want.includes(l.topics[2] as Hex);
      });
    },
    async getReceiptLogs() {
      return null;
    },
  };
}

// ── the canary switch ───────────────────────────────────────────────────────

test("SHADOW IS OFF UNLESS ASKED FOR — an unset variable costs nobody a scan", () => {
  assert.equal(shadowEnabledFor(ACC, {} as NodeJS.ProcessEnv), false);
  assert.equal(shadowEnabledFor(ACC, { MERRYMEN_RECONCILE_SHADOW: "" } as NodeJS.ProcessEnv), false);
  assert.equal(shadowEnabledFor(ACC, { MERRYMEN_RECONCILE_SHADOW: "   " } as NodeJS.ProcessEnv), false);
});

test("the canary set is a prefix list, so an operator can paste either address", () => {
  const on = (v: string, id = ACC) => shadowEnabledFor(id, { MERRYMEN_RECONCILE_SHADOW: v } as NodeJS.ProcessEnv);
  assert.equal(on("all"), true);
  assert.equal(on("0xaaaaaaaa"), true, "a prefix matches");
  assert.equal(on("0xAAAAAAAA"), true, "case-insensitively");
  assert.equal(on("0xbbbbbbbb"), false, "and does not match somebody else");
  assert.equal(on("0xbbbbbbbb,0xaaaaaaaa"), true, "a list matches any entry");
  assert.equal(on(" 0xaaaaaaaa , 0xcccc "), true, "whitespace is forgiven");
  assert.equal(on("0xaaaaaaaa", OTHER), false, "a small canary stays small");
});

// ── what equivalence means ─────────────────────────────────────────────────

test("identical fetches over the same covered range are equivalent", () => {
  const logs = [logFor(ACC, 1), logFor(ACC, 2)];
  const v = compareEventSets({
    oldLogs: logs,
    newLogs: [...logs].reverse(), // order is not identity
    oldComplete: true,
    newComplete: true,
    oldScannedTo: 1000n,
    newScannedTo: 1000n,
  });
  assert.equal(v.equivalent, true);
  assert.equal(v.informative, true);
  assert.equal(v.inBoth, 2);
  assert.match(v.detail, /identical on both sides/);
});

test("AN EMPTY COMPARISON IS NOT EVIDENCE OF EQUIVALENCE", () => {
  // The measurement that forces this: over 9.066 hours the fleet had ZERO
  // outstanding operations and the arm sweep found NOTHING on all 22 children.
  // A canary that counted these would promote on nothing at all.
  const v = compareEventSets({
    oldLogs: [],
    newLogs: [],
    oldComplete: true,
    newComplete: true,
    oldScannedTo: 1000n,
    newScannedTo: 1000n,
  });
  assert.equal(v.equivalent, true, "the two fetches did agree");
  assert.equal(v.informative, false, "but they agreed about an absence");
  assert.match(v.detail, /agreement about an absence, not evidence/);
  assert.match(shadowLine(ACC, v, 1, 0), /EMPTY/, "and the log line says so at a glance");
});

test("a missing or extra event is a MISMATCH, and names which side", () => {
  const both = logFor(ACC, 1);
  const onlyOld = logFor(ACC, 2);
  const onlyNew = logFor(ACC, 3);
  const v = compareEventSets({
    oldLogs: [both, onlyOld],
    newLogs: [both, onlyNew],
    oldComplete: true,
    newComplete: true,
    oldScannedTo: 1000n,
    newScannedTo: 1000n,
  });
  assert.equal(v.equivalent, false);
  assert.equal(v.inBoth, 1);
  assert.deepEqual(v.onlyInOld.map((k) => k.userOpHash), [h(2)]);
  assert.deepEqual(v.onlyInNew.map((k) => k.userOpHash), [h(3)]);
  const line = shadowLine(ACC, v, 1, 2);
  assert.match(line, /MISMATCH/);
  assert.match(line, /only-old/);
  assert.match(line, /only-new/);
});

test("EQUAL SETS OVER UNEQUAL RANGES ARE NOT EQUIVALENT", () => {
  // The trap the proposal named: a shorter scan simply had fewer chances to
  // differ. Agreement has to be about the same blocks.
  const logs = [logFor(ACC, 1)];
  const shortNew = compareEventSets({
    oldLogs: logs,
    newLogs: logs,
    oldComplete: true,
    newComplete: false,
    oldScannedTo: 1000n,
    newScannedTo: 800n,
  });
  assert.equal(shortNew.equivalent, false, "identical events, different coverage");
  assert.equal(shortNew.coverageMatches, false);
  assert.match(shortNew.detail, /Equal event sets over unequal ranges prove nothing/);

  // And the reverse: the OLD path falling short does not excuse the new one.
  const shortOld = compareEventSets({
    oldLogs: logs,
    newLogs: logs,
    oldComplete: false,
    newComplete: true,
    oldScannedTo: 700n,
    newScannedTo: 1000n,
  });
  assert.equal(shortOld.equivalent, false);
});

// ── the runner ─────────────────────────────────────────────────────────────

test("the runner compares the NEW fetch against the authoritative logs", async () => {
  const mine = [logFor(ACC, 1, 50n), logFor(ACC, 2, 60n)];
  const theirs = [logFor(OTHER, 9, 55n)];
  const chain = chainOf([...mine, ...theirs]);

  const { verdict, newRequests } = await runShadowComparison({
    chain,
    smartAccount: ACC,
    fromBlock: 0n,
    toBlock: 1000n,
    oldLogs: mine,
    oldComplete: true,
    oldScannedTo: 1000n,
  });
  assert.equal(verdict.equivalent, true);
  assert.equal(verdict.inBoth, 2);
  assert.equal(newRequests, 1, "one shared fetch");
  // Another tenant's event never enters the comparison, so it can never be
  // mistaken for a difference between the two fetches.
  assert.equal(verdict.onlyInNew.length, 0);
});

test("a real fetch difference IS caught by the runner", async () => {
  // The new fetch sees an event the authoritative scan did not — exactly the
  // shape of defect shadow mode exists to find before promotion.
  const chain = chainOf([logFor(ACC, 1, 50n), logFor(ACC, 2, 60n)]);
  const { verdict } = await runShadowComparison({
    chain,
    smartAccount: ACC,
    fromBlock: 0n,
    toBlock: 1000n,
    oldLogs: [logFor(ACC, 1, 50n)],
    oldComplete: true,
    oldScannedTo: 1000n,
  });
  assert.equal(verdict.equivalent, false);
  assert.deepEqual(verdict.onlyInNew.map((k) => k.userOpHash), [h(2)]);
});

// ── the invariant ──────────────────────────────────────────────────────────

test("SHADOW MODE CANNOT MUTATE ANYTHING — there is no store in scope to write to", () => {
  // Checked against CODE, not prose. The header legitimately NAMES addTrade to
  // explain what shadow mode is not comparing, and naming a thing is not calling it.
  const src = readFileSync(new URL("./reconcile-shadow.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  for (const forbidden of ["addTrade", "refreshBudget", "getDb", "initStore", "setAgentStatus", "INSERT", "UPDATE"]) {
    assert.doesNotMatch(src, new RegExp(forbidden), `shadow mode must not reference ${forbidden}`);
  }
  // It imports the fetcher and the log shapes, and nothing that writes.
  assert.match(src, /from "\.\/reconcile-modes"/);
  assert.doesNotMatch(src, /from "\.\/store"/, "no ledger handle may be imported here");
});

test("THE CALL SITE IS OBSERVATIONAL: it runs after the decision and cannot fail an arm", () => {
  const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const orphansAt = src.indexOf("const orphans = await findOrphanOps({");
  const shadowAt = src.indexOf("shadowEnabledFor(smartAccount)");
  assert.ok(orphansAt > 0 && shadowAt > orphansAt, "the shadow runs after the authoritative sweep");

  // Wrapped, because a defect in an observer must never stop the sweep that
  // keeps the day's spend from being under-counted.
  // Bounded to the guarded block itself. A fixed character count runs past it
  // into unrelated code and then tests that code instead.
  const end = src.indexOf("reconciliation unaffected", shadowAt);
  assert.ok(end > shadowAt, "the guard is where we think it is");
  const block = src.slice(shadowAt, end + 60);
  // `catch`, specifically — not merely `try`. A `try/finally` also contains a
  // `try {` and still lets the throw propagate and fail the arm, which is the
  // exact defect this pin exists to prevent. Asserting the weaker pattern let
  // that mutation through when it was tested.
  assert.match(block, /\}\s*catch\s*\(/, "the comparison must be CAUGHT, not merely wrapped");
  assert.match(block, /reconciliation unaffected/, "and says so when it fails");
  // And it writes nothing.
  assert.doesNotMatch(block, /addTrade|refreshBudget|await set/, "the shadow must not write");

  // findOrphanOps' hook is observational by contract, not just by use.
  const rec = readFileSync(new URL("./inflight-reconcile.ts", import.meta.url), "utf8");
  assert.match(rec, /PURELY OBSERVATIONAL/, "the hook says what it is");
  assert.match(rec, /opts\.onLogs\?\.\(logs\.logs, logs\.complete, logs\.scannedTo\)/);
});

test("keyOf reduces an event to the identity two fetches must agree on", () => {
  const k = keyOf(logFor(ACC, 7, 42n));
  assert.equal(k.userOpHash, h(7));
  assert.equal(k.blockNumber, "0x2a");
  // Lowercased, so a provider that varies case cannot manufacture a mismatch.
  const upper: RawLog = { ...logFor(ACC, 7, 42n), transactionHash: (`0x${"A".repeat(64)}`) as Hex };
  assert.equal(keyOf(upper).txHash, `0x${"a".repeat(64)}`);
});
