/**
 * THE PREVIEW, AND THE PROOF THAT IT IS ONLY A PREVIEW.
 *
 * Two things are pinned here. The first is arithmetic: the canary's numbers, in
 * the four-part shape the report is read in. The second is structural, and it is
 * the one that matters before a production run — this module cannot write,
 * because it has no way to. The last test reads the file and says so.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import {
  accountPreviewLines,
  parsePreviewRequest,
  previewAccount,
  rosterLines,
  rosterOutcome,
  runPreview,
} from "./accounting-preview";
import type { AccountPlan } from "./accounting-reconstruction";

const CANARY = "0x3E34E58e1E1b52A6cbE2Bd7C6e0C1B1e1e1e1e1e";
const PAPER = "0x00000000000000000000000000000000000000a1";
const TX = "0xfund000000000000000000000000000000000000000000000000000000000000";

const plan = (over: Partial<AccountPlan> & { smartAccount: string }): AccountPlan => ({
  ownerAddress: null,
  tenant: null,
  mode: "live",
  isPaper: false,
  epoch: 1,
  onchainCashUsdg: null,
  navUsdg: null,
  chainGrossInUsdg: 0,
  chainGrossOutUsdg: 0,
  chainNetUsdg: 0,
  chainTradeLegs: 0,
  chainAmbiguous: 0,
  chainComplete: true,
  existingInferredRows: 0,
  existingInferredUsdg: 0,
  existingTotalUsdg: 0,
  insert: [],
  quarantine: [],
  contributionsKnownBefore: false,
  contributionsAfterUsdg: 0,
  contributionsKnownAfter: false,
  pnlPublishableAfter: false,
  blocked: null,
  ...over,
});

/** The canary exactly as the ledger and the chain have it. */
const canaryPlan = () =>
  plan({
    smartAccount: CANARY,
    tenant: "0xa233a3",
    onchainCashUsdg: 3.334,
    navUsdg: 9.884,
    chainGrossInUsdg: 10,
    chainGrossOutUsdg: 0,
    chainNetUsdg: 10,
    chainTradeLegs: 4,
    chainAmbiguous: 0,
    chainComplete: true,
    existingInferredRows: 3,
    existingInferredUsdg: 30,
    existingTotalUsdg: 30,
    contributionsKnownBefore: false,
    insert: [
      {
        agentId: CANARY,
        epoch: 1,
        direction: "in",
        amountUsdg: 10,
        amountRaw: "10000000",
        source: "chain-log",
        txHash: TX,
        blockNumber: 4_100_000,
        logIndex: 0,
      },
    ],
    quarantine: [1, 2, 3].map((id) => ({
      id,
      direction: "in",
      amountUsdg: 10,
      source: "inferred",
      reason: "inferred from a balance change",
    })),
    contributionsAfterUsdg: 10,
    contributionsKnownAfter: true,
    pnlPublishableAfter: true,
  });

// ── THE MODE ───────────────────────────────────────────────────────────────

describe("what this build will accept", () => {
  it("does nothing at all unless asked", () => {
    assert.equal(parsePreviewRequest({}), null);
    assert.equal(parsePreviewRequest({ MERRYMEN_REPAIR: "" }), null);
  });

  it("previews on dry-run", () => {
    const r = parsePreviewRequest({ MERRYMEN_REPAIR: "dry-run" })!;
    assert.equal(r.kind, "preview");
  });

  it("REFUSES a mutation rather than quietly downgrading it", () => {
    // Silently turning commit into a dry run would leave an operator reading a
    // preview while believing they had repaired production.
    for (const mode of ["commit", "verify-only", "1", "true", "COMMIT"]) {
      const r = parsePreviewRequest({ MERRYMEN_REPAIR: mode })!;
      assert.equal(r.kind, "refused", `${mode} must be refused, not reinterpreted`);
      assert.match(r.kind === "refused" ? r.why : "", /no mutation path/);
    }
  });

  it("carries the selected account and a timestamped run id", () => {
    const r = parsePreviewRequest(
      { MERRYMEN_REPAIR: "dry-run", MERRYMEN_REPAIR_ACCOUNT: ` ${CANARY} ` },
      0,
    )!;
    assert.equal(r.kind === "preview" ? r.account : null, CANARY);
    assert.match(r.kind === "preview" ? r.runId : "", /^run-1970-01-01/);
  });
});

// ── THE THREE OUTCOMES, TOTAL OVER EVERY ACCOUNT ───────────────────────────

describe("every tenant is classified", () => {
  it("puts an evidence-backed account in EVIDENCE-BACKED-REPAIR", () => {
    assert.equal(rosterOutcome(canaryPlan()), "EVIDENCE-BACKED-REPAIR");
  });

  it("puts an account with no chain history in NO-CHAIN-HISTORY", () => {
    assert.equal(rosterOutcome(plan({ smartAccount: PAPER, isPaper: true })), "NO-CHAIN-HISTORY");
    // Including one whose simulated rows are being removed — there is still no
    // chain history behind it, which is the fact the label names.
    assert.equal(
      rosterOutcome(
        plan({
          smartAccount: PAPER,
          isPaper: true,
          quarantine: [{ id: 9, direction: "out", amountUsdg: 59_000, source: "inferred", reason: "paper" }],
        }),
      ),
      "NO-CHAIN-HISTORY",
    );
  });

  it("puts an unresolvable account in BLOCKED-AMBIGUOUS, even when it has evidence to insert", () => {
    // Blocked is checked FIRST. An account the classifier could not resolve must
    // not read as a repair merely because it also has rows to insert.
    const p = canaryPlan();
    p.blocked = "2 movement(s) could not be classified as capital or trade";
    assert.equal(rosterOutcome(p), "BLOCKED-AMBIGUOUS");
  });

  it("tallies the whole fleet, and the tally adds up", () => {
    const plans = [
      canaryPlan(),
      plan({ smartAccount: PAPER, isPaper: true }),
      plan({ smartAccount: "0xbbb", blocked: "ambiguous" }),
      plan({ smartAccount: "0xccc" }),
    ];
    const previews = runPreview(plans, { account: null });
    const total = rosterLines(previews).find((l) => l.startsWith("ROSTER TOTAL"))!;
    assert.match(total, /4 account\(s\)/);
    assert.match(total, /NO-CHAIN-HISTORY 2/);
    assert.match(total, /EVIDENCE-BACKED-REPAIR 1/);
    assert.match(total, /BLOCKED-AMBIGUOUS 1/);
    assert.equal(previews.length, plans.length, "no account is dropped from the roster");
  });

  it("classifies an account --account did not select, rather than omitting it", () => {
    // "Not in the mutation list" must never be readable as "safe".
    const previews = runPreview([canaryPlan(), plan({ smartAccount: PAPER, isPaper: true })], {
      account: CANARY,
    });
    assert.equal(previews.length, 2);
    assert.equal(previews[1]!.selected, false);
    assert.equal(previews[1]!.outcome, "NO-CHAIN-HISTORY");
  });
});

// ── THE CANARY'S NUMBERS ───────────────────────────────────────────────────

describe("the canary preview", () => {
  const p = previewAccount(canaryPlan(), CANARY);

  it("reports the ledger's 30 USDG as what is there now, unevidenced", () => {
    assert.equal(p.contributionsBeforeUsdg, 30);
    assert.equal(p.contributionsKnownBefore, false);
    assert.equal(p.quarantines, 3);
  });

  it("reports the chain's 10 USDG as what would be left, evidenced", () => {
    assert.equal(p.inserts, 1);
    assert.equal(p.grossContributionsAfterUsdg, 10);
    assert.equal(p.grossWithdrawalsAfterUsdg, 0);
    assert.equal(p.contributionsAfterUsdg, 10);
    assert.equal(p.contributionsKnownAfter, true);
  });

  it("does NOT count the four router legs as withdrawals", () => {
    // The whole reason the classifier exists. Direction-only netting gives
    // 3.334 — the cash balance — and calls it contributed capital.
    assert.notEqual(p.contributionsAfterUsdg, 3.334);
    assert.equal(p.grossWithdrawalsAfterUsdg, 0);
  });

  it("renders the four parts, each line carrying the account", () => {
    const lines = accountPreviewLines(canaryPlan(), p);
    const body = lines.join("\n");
    assert.ok(
      lines.every((l) => l.startsWith(CANARY.slice(0, 10))),
      "Railway reorders lines from a busy service, so each must stand alone",
    );
    for (const heading of ["BEFORE", "CHAIN EVIDENCE", "PROPOSED", "AFTER"]) {
      assert.ok(body.includes(` ${heading}`), `missing ${heading}`);
    }
    assert.match(body, /3 inferred inbound row\(s\) × 10\.000000 USDG/);
    assert.match(body, /contribution total = 30\.000000 USDG/);
    assert.match(body, /contributionsKnown = false/);
    assert.match(body, /1 external inbound = 10\.000000 USDG/);
    assert.match(body, /4 router\/trade leg\(s\) excluded from capital flows/);
    assert.match(body, /ambiguous = 0/);
    assert.match(body, /insert 1 chain-log contribution row\(s\)/);
    assert.match(body, /quarantine 3 legacy row\(s\) — moved, never deleted/);
    assert.match(body, /gross contributions = 10\.000000/);
    assert.match(body, /gross withdrawals = 0\.000000/);
    assert.match(body, /net contributions = 10\.000000/);
    assert.match(body, /contributionsKnown = true/);
  });
});

describe("a funded-then-withdrawn account", () => {
  it("keeps gross apart from net, because net zero is not 'never funded'", () => {
    const p = previewAccount(
      plan({
        smartAccount: "0xddd",
        insert: [
          { agentId: "0xddd", epoch: 1, direction: "in", amountUsdg: 1010, amountRaw: "1010000000", source: "chain-log", txHash: "0x1", blockNumber: 1, logIndex: 0 },
          { agentId: "0xddd", epoch: 1, direction: "out", amountUsdg: 1010, amountRaw: "1010000000", source: "chain-log", txHash: "0x2", blockNumber: 2, logIndex: 0 },
        ],
        contributionsAfterUsdg: 0,
        contributionsKnownAfter: true,
      }),
      null,
    );
    assert.equal(p.grossContributionsAfterUsdg, 1010);
    assert.equal(p.grossWithdrawalsAfterUsdg, 1010);
    assert.equal(p.contributionsAfterUsdg, 0);
    assert.equal(p.outcome, "EVIDENCE-BACKED-REPAIR");
  });
});

// ── THE STRUCTURAL GUARANTEE ───────────────────────────────────────────────

describe("read-only by construction", () => {
  // COMMENTS STRIPPED FIRST. The module's own header explains what it will not
  // do, and matching on prose would make the check fail for saying so — a test
  // that punishes documentation. What is under review is the CODE.
  const src = readFileSync(new URL("./accounting-preview.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");

  it("has no write SQL anywhere in it", () => {
    // The claim under review is "MERRYMEN_REPAIR=dry-run is genuinely read-only".
    // A gated mutation path would need a reviewer to trust the gate. An absent
    // one needs nothing, and this is what makes the absence checkable.
    for (const verb of [/\bINSERT\s+INTO\b/i, /\bUPDATE\s+\w+\s+SET\b/i, /\bDELETE\s+FROM\b/i, /\bDROP\s+/i, /\bALTER\s+TABLE\b/i]) {
      assert.doesNotMatch(src, verb, `found write SQL matching ${verb}`);
    }
  });

  it("is never handed a database", () => {
    // Stronger than "does not write": it has nothing to write TO. No Db import,
    // no prepare/run/exec call, no parameter that could carry a connection.
    assert.doesNotMatch(src, /from "\.\/db"/, "imports the database seam");
    assert.doesNotMatch(src, /\bDb\b/, "mentions the Db type");
    assert.doesNotMatch(src, /\.prepare\(/, "prepares a statement");
    assert.doesNotMatch(src, /\.exec\(/, "executes SQL");
    assert.doesNotMatch(src, /\.tx\(/, "opens a transaction");
  });
});

describe("the run id is a real timestamp in production", () => {
  it("is not left at the pure-function default", () => {
    // `parsePreviewRequest` may not read a clock, so its `now` defaults to 0 for
    // the tests above. Leaving that default in place at the call site stamped
    // every production run `run-1970-01-01T00-00-00-000Z` — the one property the
    // id exists to provide, absent exactly where it was needed. The unit tests
    // could not catch it because they pass `now` explicitly, so the pin is on
    // the CALL SITE.
    const src = readFileSync(new URL("./orchestrator.ts", import.meta.url), "utf8");
    const call = src.match(/parsePreviewRequest\([^)]*\)/);
    assert.ok(call, "the orchestrator still calls parsePreviewRequest");
    assert.match(call[0], /Date\.now\(\)/, "and hands it a clock");
  });
});
