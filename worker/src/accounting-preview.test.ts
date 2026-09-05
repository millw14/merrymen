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
  previewRequested,
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
    const previews = runPreview(plans, { accounts: [] });
    const total = rosterLines(previews).find((l) => l.startsWith("ROSTER TOTAL"))!;
    assert.match(total, /4 account\(s\)/);
    assert.match(total, /NO-CHAIN-HISTORY 2/);
    assert.match(total, /EVIDENCE-BACKED-REPAIR 1/);
    assert.match(total, /BLOCKED-AMBIGUOUS 1/);
    assert.equal(previews.length, plans.length, "no account is dropped from the roster");
  });

  it("keeps an account --account did not select on the roster, rather than omitting it", () => {
    // "Not in the mutation list" must never be readable as "safe" — but it must
    // not be readable as "broken" either. An unselected account is NOT-EXAMINED:
    // present, counted, and honest about the fact that nobody looked at it.
    const previews = runPreview([canaryPlan(), plan({ smartAccount: PAPER, isPaper: true })], {
      accounts: [CANARY.toLowerCase()],
    });
    assert.equal(previews.length, 2);
    assert.equal(previews[1]!.selected, false);
    assert.equal(previews[1]!.outcome, "NOT-EXAMINED");
  });
});

// ── THE CANARY'S NUMBERS ───────────────────────────────────────────────────

describe("the canary preview", () => {
  const p = previewAccount(canaryPlan(), [CANARY.toLowerCase()]);

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
      [],
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

// The run-id pin moved to accounting-repair.test.ts with the function it
// guards: this build hands mode parsing to `parseRepairOptions`, so a test
// asserting the orchestrator passes a clock to `parsePreviewRequest` would be
// pinning a call site that no longer exists.

describe("the report has to fit in the window you can read it in", () => {
  it("knows a preview was asked for before deciding how much else to print", () => {
    // `railway logs` is a 503-line snapshot, not a stream, and the ledger mirror
    // alone writes ~200 lines a minute. The per-account dump was ~12 lines each —
    // 288 for a 24-tenant fleet — and the preview then added its own on top, so
    // the combined burst pushed itself out of the window and neither could be
    // read. This is what lets the caller print one report instead of two.
    assert.equal(previewRequested({}), false);
    assert.equal(previewRequested({ MERRYMEN_REPAIR: "" }), false);
    assert.equal(previewRequested({ MERRYMEN_REPAIR: "   " }), false);
    assert.equal(previewRequested({ MERRYMEN_REPAIR: "dry-run" }), true);
    // A REFUSED request still counts as asked, so the refusal is not buried
    // under three hundred lines of something nobody wanted.
    assert.equal(previewRequested({ MERRYMEN_REPAIR: "commit" }), true);
  });

  it("bounds the fleet report to one line per tenant plus one block", () => {
    // The roster is the fleet answer; the four-part block is the account answer.
    // 24 tenants scoped to one account is 24 + 1 + ~20 lines, which fits.
    const plans = Array.from({ length: 24 }, (_, i) =>
      i === 0 ? canaryPlan() : plan({ smartAccount: `0x${i.toString(16).padStart(40, "0")}` }),
    );
    const previews = runPreview(plans, { accounts: [CANARY.toLowerCase()] });
    const roster = rosterLines(previews);
    const blocks = previews.filter((p) => p.selected).flatMap((p) => {
      const pl = plans.find((x) => x.smartAccount === p.account)!;
      return accountPreviewLines(pl, p);
    });
    assert.equal(roster.length, 25, "one line per tenant, plus the total");
    assert.equal(previews.filter((p) => p.selected).length, 1, "only the named account gets a block");
    assert.ok(roster.length + blocks.length < 100, `report is ${roster.length + blocks.length} lines, well inside 503`);
  });
});

describe("an account nobody looked at is not an account with a problem", () => {
  it("reports NOT-EXAMINED rather than BLOCKED-AMBIGUOUS", () => {
    // A scoped repair scans only what it repairs, so every other account has no
    // chain result and the planner marks it blocked. Reporting that as BLOCKED
    // reads as "this account is in trouble" when the truth is "nobody asked".
    const outside = plan({
      smartAccount: PAPER,
      blocked: "no chain scan result for this account",
      existingTotalUsdg: 10,
      contributionsKnownBefore: true,
      contributionsAfterUsdg: 0,
      contributionsKnownAfter: false,
    });
    const p = previewAccount(outside, [CANARY.toLowerCase()]);
    assert.equal(p.selected, false);
    assert.equal(p.outcome, "NOT-EXAMINED");
    assert.equal(p.blocked, null, "it is not blocked, it is unread");
  });

  it("does not invent an 'after' from a scan that never ran", () => {
    // The line that made this urgent: the already-repaired canary appeared as
    // `contributions 10.000000 -> 0.000000 · known false -> false`, derived
    // entirely from evidence nobody gathered. An operator reading that would
    // conclude the repair had undone itself.
    const repaired = plan({
      smartAccount: CANARY,
      blocked: "no chain scan result for this account",
      existingTotalUsdg: 10,
      contributionsKnownBefore: true,
      contributionsAfterUsdg: 0,
      contributionsKnownAfter: false,
    });
    const p = previewAccount(repaired, ["0xsomeoneelse"]);
    assert.equal(p.contributionsAfterUsdg, 10, "unchanged, because nothing was examined");
    assert.equal(p.contributionsKnownAfter, true, "and its known-state is not downgraded either");
  });

  it("still counts every tenant, which was always the point", () => {
    const plans = [
      canaryPlan(),
      plan({ smartAccount: PAPER, blocked: "no chain scan result for this account" }),
      plan({ smartAccount: "0xccc", blocked: "no chain scan result for this account" }),
    ];
    const previews = runPreview(plans, { accounts: [CANARY.toLowerCase()] });
    const total = rosterLines(previews).find((l) => l.startsWith("ROSTER TOTAL"))!;
    assert.match(total, /3 account\(s\)/);
    assert.match(total, /EVIDENCE-BACKED-REPAIR 1/);
    assert.match(total, /NOT-EXAMINED 2/);
    assert.match(total, /BLOCKED-AMBIGUOUS 0/, "not looked at is not blocked");
  });
});
