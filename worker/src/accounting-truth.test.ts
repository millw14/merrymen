import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  accountingLicence,
  anchorLine,
  BOOTSTRAP_MAX_AGE_SEC,
  BOOTSTRAP_SCHEMA_VERSION,
  classifyAnchor,
  doubt,
  foldLicence,
  INITIAL_CONTRIBUTION_TRUTH,
  planFirstObservation,
  type AnchorVerdict,
  type BootstrapAccounting,
} from "./bootstrap-state";
import { usdgRealToMicro } from "./bootstrap-source";
import { ARITHMETIC_TOLERANCE_USDG, reconcile, type ReconstructedBook } from "./audit";
import { guaranteeLines, pnlPublishable, UNKNOWN_QUALITY } from "./portfolio-quality";

/**
 * THE REDEPLOY THAT KEPT BEING BOOKED AS A DEPOSIT, PINNED.
 *
 * The canary held 10 USDG and never received another cent. Three deploys later
 * its ledger said 30 USDG had been contributed, because a hosted child's SQLite
 * lives in an ephemeral container directory and the accounting code read an
 * empty database as "this money just arrived".
 *
 * Everything below drives the REAL decision functions — `accountingLicence` and
 * `planFirstObservation` are what `index.ts` calls — rather than asserting on
 * the shape of the code around them.
 */

const TENANT = "0xa233a3000000000000000000000000000000beef";
const U = (n: number) => BigInt(Math.round(n * 1e6));
const MATERIAL = 10_000n;
const NOW = 1_760_000_000;

const anchorFile = (accounting: BootstrapAccounting, over: Record<string, unknown> = {}) =>
  JSON.stringify({
    schemaVersion: BOOTSTRAP_SCHEMA_VERSION,
    tenantId: TENANT,
    generatedAt: NOW,
    accounting,
    ...over,
  });

/**
 * A PROVEN anchor by default: the receipts-only total equals the all-rows
 * total and no flow lacks a transaction. Tests that care about the
 * contaminated case say so explicitly, so the default cannot quietly become
 * the weaker claim.
 */
const established = (over: Partial<Extract<BootstrapAccounting, { kind: "established" }>> = {}) =>
  ({
    kind: "established",
    highWaterMarkUsdg: "10000000",
    netContributionsUsdg: "10000000",
    anchoredContributionsUsdg: "10000000",
    unanchoredFlowCount: 0,
    lastObservedCashUsdg: "10000000",
    accountingEpoch: 2,
    observedAt: NOW - 60,
    ...over,
  }) as BootstrapAccounting;

/**
 * Source with comments removed.
 *
 * Every pin below that counts occurrences uses it, because the code being
 * pinned QUOTES the old buggy expression in the block explaining why it went —
 * and a pin that counts its own documentation breaks when someone improves the
 * wording.
 */
const strip = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");

const read = (raw: string | null, nowSec = NOW): AnchorVerdict =>
  classifyAnchor(raw, { tenantId: TENANT, nowSec });

/** Run one hosted arm and return what it would have booked. */
function armHosted(raw: string | null, world: { equityUsdg: bigint; cashUsdg: bigint }, nowSec = NOW) {
  const licence = accountingLicence(read(raw, nowSec), { hosted: true });
  const plan = planFirstObservation({
    licence: licence.licence,
    equityUsdg: world.equityUsdg,
    cashUsdg: world.cashUsdg,
    anchorCashUsdg: licence.lastObservedCashUsdg,
    materialDriftUsdg: MATERIAL,
    why: licence.why,
  });
  const booked = plan.action === "book-opening-balance" ? plan.amountUsdg : 0n;
  const contributionsKnown =
    plan.action === "resume-with-drift" || plan.action === "stand-down" ? false : licence.contributionsKnown;
  return { licence, plan, booked, contributionsKnown };
}

describe("P1 — THE EXACT FAILURE: 10 USDG, three restarts, still 10 USDG", () => {
  it("books the opening balance once and never again", () => {
    // The orchestrator derives the anchor from durable Postgres, so the ledger
    // it reports is the one that survived the container. Modelled here as a
    // single number the restarts share.
    let durableContributionsUsdg = 0n;
    let durableHwmUsdg = 0n;
    const equity = U(10);

    // Deploy 0: a genuinely new account. Postgres answered and found nothing.
    const first = armHosted(anchorFile({ kind: "no-prior-accounting", observedAt: NOW }), {
      equityUsdg: equity,
      cashUsdg: equity,
    });
    assert.equal(first.plan.action, "book-opening-balance");
    durableContributionsUsdg += first.booked;
    durableHwmUsdg += first.booked; // record() raises the HWM with the flow
    assert.equal(durableContributionsUsdg, U(10));

    // Deploys 1, 2, 3: same account, same money, empty child database each time.
    for (const deploy of [1, 2, 3]) {
      const r = armHosted(
        anchorFile(
          established({
            highWaterMarkUsdg: durableHwmUsdg.toString(),
            netContributionsUsdg: durableContributionsUsdg.toString(),
            anchoredContributionsUsdg: durableContributionsUsdg.toString(),
            unanchoredFlowCount: 0,
            lastObservedCashUsdg: equity.toString(),
          }),
        ),
        { equityUsdg: equity, cashUsdg: equity },
      );
      assert.equal(r.plan.action, "resume-clean", `deploy ${deploy} must resume, not re-open`);
      assert.equal(r.booked, 0n, `deploy ${deploy} booked ${r.booked} micro-USDG out of nowhere`);
      assert.equal(r.contributionsKnown, true, "a clean resume still knows what was contributed");
      durableContributionsUsdg += r.booked;
    }

    // THE NUMBER THE BUG PRODUCED WAS 40. It is 10.
    assert.equal(durableContributionsUsdg, U(10), "contributions must not grow by redeploying");
    assert.notEqual(durableContributionsUsdg, U(20));
    assert.notEqual(durableContributionsUsdg, U(30));
    assert.notEqual(durableContributionsUsdg, U(40));
  });

  it("RESTORES THE HIGH-WATER MARK, so deleting the phantom contribution cannot start charging fees", () => {
    // The two errors used to cancel: the phantom contribution raised the HWM by
    // the same amount, so no fee was wrongly charged. Removing one without the
    // other would hand the whole principal to accrueAboveHwm as profit.
    const l = accountingLicence(read(anchorFile(established({ highWaterMarkUsdg: "10000000" }))), { hosted: true });
    assert.equal(l.highWaterMarkUsdg, U(10), "the peak must come back with the contributions");
    assert.equal(l.netContributionsUsdg, U(10));
  });
});

describe("P2 — the anchor licenses an opening balance; nothing else does", () => {
  it("a genuinely new funded agent books its opening balance", () => {
    const r = armHosted(anchorFile({ kind: "no-prior-accounting", observedAt: NOW }), {
      equityUsdg: U(250),
      cashUsdg: U(250),
    });
    assert.equal(r.plan.action, "book-opening-balance");
    assert.equal(r.booked, U(250));
    assert.equal(r.contributionsKnown, true);
  });

  it("a MISSING anchor books nothing and marks contributions unknown", () => {
    const r = armHosted(null, { equityUsdg: U(10), cashUsdg: U(10) });
    assert.equal(r.plan.action, "stand-down");
    assert.equal(r.booked, 0n);
    assert.equal(r.contributionsKnown, false);
  });

  it("a MALFORMED anchor books nothing", () => {
    for (const bad of [
      "{not json",
      JSON.stringify({ schemaVersion: BOOTSTRAP_SCHEMA_VERSION, tenantId: TENANT, generatedAt: NOW }),
      anchorFile(established({ netContributionsUsdg: "1.5" as never })),
      anchorFile(established({ highWaterMarkUsdg: "abc" as never })),
    ]) {
      const r = armHosted(bad, { equityUsdg: U(10), cashUsdg: U(10) });
      assert.equal(r.plan.action, "stand-down", `${bad.slice(0, 40)} must not license anything`);
      assert.equal(r.booked, 0n);
      assert.equal(r.contributionsKnown, false);
    }
  });

  it("AN ANCHOR FOR ANOTHER TENANT IS MALFORMED, not merely ignored", () => {
    // Applying a different account's high-water mark is the worst thing this
    // file could do, so it is checked rather than left to the caller.
    const other = anchorFile(established(), { tenantId: "0xdeadbeef00000000000000000000000000000000" });
    const v = read(other);
    assert.equal(v.kind, "malformed");
    assert.equal(armHosted(other, { equityUsdg: U(10), cashUsdg: U(10) }).booked, 0n);
  });

  it("a STALE anchor books nothing", () => {
    const raw = anchorFile(established());
    assert.equal(read(raw, NOW).kind, "valid");
    const late = NOW + BOOTSTRAP_MAX_AGE_SEC + 1;
    assert.equal(read(raw, late).kind, "stale");
    const r = armHosted(raw, { equityUsdg: U(10), cashUsdg: U(10) }, late);
    assert.equal(r.plan.action, "stand-down");
    assert.equal(r.contributionsKnown, false);
  });

  it("an UNSUPPORTED SCHEMA VERSION is refused rather than partially read", () => {
    const future = anchorFile(established(), { schemaVersion: BOOTSTRAP_SCHEMA_VERSION + 1 });
    const v = read(future);
    assert.equal(v.kind, "unsupported-version");
    assert.equal(armHosted(future, { equityUsdg: U(10), cashUsdg: U(10) }).booked, 0n);
  });

  it("POSTGRES UNAVAILABLE AT SPAWN is its own arm, and it is not 'empty'", () => {
    // The whole bug in one line: a database that threw must never look like a
    // database that answered "nothing here".
    const raw = anchorFile({ kind: "unknown", why: "connection refused", observedAt: NOW });
    const v = read(raw);
    assert.equal(v.kind, "valid", "the FILE is well-formed — it is the CONTENT that says unknown");
    const r = armHosted(raw, { equityUsdg: U(10), cashUsdg: U(10) });
    assert.equal(r.plan.action, "stand-down");
    assert.equal(r.booked, 0n, "an unreachable database must not license an opening balance");
    assert.equal(r.contributionsKnown, false);
  });

  it("AN ANCHOR WRITE FAILURE looks exactly like a missing anchor, and fails closed", () => {
    // The orchestrator's write is best-effort; when it fails there is simply no
    // file, which is the `absent` arm, which stands down.
    assert.equal(read(null).kind, "absent");
    assert.equal(armHosted(null, { equityUsdg: U(999), cashUsdg: U(999) }).contributionsKnown, false);
  });
});

describe("P3 — a balance that moved while the worker was down is never guessed at", () => {
  it("cash changed by a legitimate deposit is NOT booked from the delta", () => {
    // A deposit is real money and it still must not be inferred here: the chain
    // scan books it with a transaction hash, or the book says it does not know.
    const r = armHosted(anchorFile(established({ lastObservedCashUsdg: "10000000" })), {
      equityUsdg: U(15),
      cashUsdg: U(15),
    });
    assert.equal(r.plan.action, "resume-with-drift");
    assert.equal(r.plan.action === "resume-with-drift" && r.plan.driftUsdg, U(5));
    assert.equal(r.booked, 0n, "an inferred deposit is not an actual capital-flow event");
    assert.equal(r.contributionsKnown, false, "and the book must say the total is no longer complete");
  });

  it("cash changed by a TRADE is not booked as a withdrawal", () => {
    // The case that makes inference indefensible: an in-flight UserOperation
    // that landed during downtime lowers cash, inflight-reconcile books the
    // trade, and inferring the delta here would double-count it with the wrong
    // sign.
    const r = armHosted(anchorFile(established({ lastObservedCashUsdg: "10000000" })), {
      equityUsdg: U(10),
      cashUsdg: U(8.33),
    });
    assert.equal(r.plan.action, "resume-with-drift");
    assert.equal(r.booked, 0n);
    assert.equal(r.contributionsKnown, false);
  });

  it("noise below the materiality bound is not drift", () => {
    // The durable columns are REAL, so a round trip can shift the last decimal.
    const r = armHosted(anchorFile(established({ lastObservedCashUsdg: "10000000" })), {
      equityUsdg: U(10),
      cashUsdg: U(10) + 1n,
    });
    assert.equal(r.plan.action, "resume-clean");
    assert.equal(r.contributionsKnown, true);
  });

  it("no cash reading on record is not the same as a zero balance", () => {
    const r = armHosted(anchorFile(established({ lastObservedCashUsdg: null })), {
      equityUsdg: U(10),
      cashUsdg: U(10),
    });
    assert.equal(r.plan.action, "resume-clean", "an absent baseline yields no drift claim");
    assert.equal(r.booked, 0n);
  });
});

describe("P3b — a contribution total built on inference is resumed from but not believed", () => {
  /**
   * THE SECOND INFLATION MECHANISM, which lives in the mirror rather than in
   * the worker. When a hosted child's SQLite is rebuilt, the mirror finds its
   * watermark row gone, rewinds the cursor to zero and re-copies rows 1..N from
   * the reborn child. The INSERT has no ON CONFLICT and `flows` has no unique
   * key, so the shared table accumulates the OLD rows plus whatever the new
   * incarnation wrote — including a fresh phantom opening balance.
   *
   * Stopping the worker from writing new phantoms does not un-write the ones
   * already in Postgres, so an anchor summing every row inherits the
   * corruption. The rows are distinguishable, though: a flow read off a USDG
   * Transfer log carries a tx hash, an inferred one does not.
   */
  it("RESUMES (so the peak comes back) but marks contributions UNKNOWN", () => {
    const contaminated = anchorFile(
      established({
        netContributionsUsdg: "30000000", // three phantom openings
        anchoredContributionsUsdg: "0", // none of them names a transaction
        unanchoredFlowCount: 3,
      }),
    );
    const l = accountingLicence(read(contaminated), { hosted: true });
    assert.equal(l.licence, "resume", "it must still resume — an unrestored peak charges fees on principal");
    assert.equal(l.highWaterMarkUsdg, U(10), "the peak comes back regardless");
    assert.equal(l.contributionsKnown, false, "but a total made of inference is not evidence");
    assert.match(l.why, /rests on inference/);

    const r = armHosted(contaminated, { equityUsdg: U(10), cashUsdg: U(10) });
    assert.equal(r.plan.action, "resume-clean");
    assert.equal(r.booked, 0n, "and nothing new is booked on top of it");
  });

  it("one unanchored flow among many is enough to make the total unproven", () => {
    const l = accountingLicence(
      read(anchorFile(established({ netContributionsUsdg: "10000000", anchoredContributionsUsdg: "9000000", unanchoredFlowCount: 1 }))),
      { hosted: true },
    );
    assert.equal(l.contributionsKnown, false);
  });

  it("an anchor predating the receipts-only fields is unproven, not assumed sound", () => {
    // Absent evidence is not evidence of soundness — the field being missing
    // means nobody computed it, which is the same epistemic position as a
    // mismatch and gets the same answer.
    const old = anchorFile(
      established({ anchoredContributionsUsdg: undefined, unanchoredFlowCount: undefined } as never),
    );
    const l = accountingLicence(read(old), { hosted: true });
    assert.equal(l.licence, "resume");
    assert.equal(l.contributionsKnown, false);
    assert.match(l.why, /unproven/);
  });

  it("agreement between the two totals is what proves it, not either one alone", () => {
    // A receipts total that happens to equal a WRONG all-rows total must not
    // pass: the check is agreement AND zero unanchored rows.
    for (const bad of [
      { netContributionsUsdg: "10000000", anchoredContributionsUsdg: "10000000", unanchoredFlowCount: 2 },
      { netContributionsUsdg: "20000000", anchoredContributionsUsdg: "10000000", unanchoredFlowCount: 0 },
    ]) {
      assert.equal(
        accountingLicence(read(anchorFile(established(bad as never))), { hosted: true }).contributionsKnown,
        false,
        JSON.stringify(bad),
      );
    }
    assert.equal(
      accountingLicence(read(anchorFile(established())), { hosted: true }).contributionsKnown,
      true,
      "matched totals with zero unanchored rows is the one case that proves it",
    );
  });

  it("a malformed receipts field makes the whole anchor malformed", () => {
    const v = read(anchorFile(established({ anchoredContributionsUsdg: "1.5" } as never)));
    assert.equal(v.kind, "malformed");
  });
});

describe("P3c — a doubt raised by watching the account is never lifted by a file", () => {
  /**
   * `applyAccountingAnchor` runs inside `syncGrant`, which the tick re-enters on
   * any re-arm — and a transient executor failure nulls `active` and causes one.
   * The two places that CLEAR contributionsKnown sit behind a first-observation
   * guard and fire at most once per process. One-way false against two-way true
   * means the doubt always loses, and contributionsKnown is the sole gate on the
   * performance fee.
   *
   * This was written after a mutation that deleted the guard entirely passed all
   * 44 tests.
   */
  const resumeLicence = () => accountingLicence(read(anchorFile(established())), { hosted: true });

  it("a clean anchor establishes the truth", () => {
    const t = foldLicence(INITIAL_CONTRIBUTION_TRUTH, resumeLicence());
    assert.equal(t.known, true);
    assert.equal(t.doubted, false);
  });

  it("A RE-ARM CANNOT RESURRECT contributionsKnown AFTER A DOUBT", () => {
    let t = foldLicence(INITIAL_CONTRIBUTION_TRUTH, resumeLicence());
    assert.equal(t.known, true);

    // Tick 1 observes drift across the downtime window.
    t = doubt("cash moved across the downtime window and nothing could price it");
    assert.equal(t.known, false);

    // Hour 2: an executor failure nulls `active`; syncGrant re-runs and folds
    // the SAME still-valid licence back in. Ten times, for good measure.
    for (let i = 0; i < 10; i++) t = foldLicence(t, resumeLicence());
    assert.equal(t.known, false, "the fee gate must not reopen on a book already declared unknowable");
    assert.equal(t.doubted, true);
    assert.match(t.why, /downtime window/, "and the original reason must survive, not be overwritten");
  });

  it("a stand-down doubt is equally permanent", () => {
    let t = doubt("anchor absent: no bootstrap.json in the child's home");
    // Even if a VALID anchor appears later — an operator drops the file in —
    // this process does not change its mind. It restarts and re-derives.
    for (let i = 0; i < 3; i++) t = foldLicence(t, resumeLicence());
    assert.equal(t.known, false);
  });

  it("the initial state is unknown, not known", () => {
    assert.equal(INITIAL_CONTRIBUTION_TRUTH.known, false);
    assert.equal(INITIAL_CONTRIBUTION_TRUTH.doubted, false, "unknown but not yet doubted — a licence may still establish it");
  });

  it("index.ts routes BOTH clearing sites through the sticky helper", () => {
    // A future edit that assigns the field directly would silently restore the
    // asymmetry, so the call sites are pinned as well as the reducer.
    const src = strip(readFileSync(new URL("./index.ts", import.meta.url), "utf8"));
    assert.match(src, /setTruth\(foldLicence\(truth, l\)\);/);
    assert.equal((src.match(/doubtContributions\(/g) ?? []).length, 3, "one definition, two call sites");
    // And nothing writes contributionsKnown outside setTruth.
    const writes = src.match(/accounting\.contributionsKnown\s*=/g) ?? [];
    assert.equal(writes.length, 1, `contributionsKnown must have exactly one writer, found ${writes.length}`);
  });
});

describe("P3d — the operator line shows the EVIDENCED total, not just the claimed one", () => {
  it("prints both totals and the unevidenced row count", () => {
    // Fail-closed is the most important property this file has, and in
    // production the only other place it surfaced was a fee-suppression event
    // that needs a clean tick to fire. On a rate-limited fleet that can be hours
    // away, so the line said "contributions 30000000" and stopped — the number
    // the phantom bookings produced, with no hint that only a third of it is a
    // receipt.
    const line = anchorLine(
      TENANT,
      read(
        anchorFile(
          established({
            netContributionsUsdg: "30000000",
            anchoredContributionsUsdg: "10000000",
            unanchoredFlowCount: 2,
          }),
        ),
      ),
    );
    assert.match(line, /contributions 30000000/);
    assert.match(line, /evidenced 10000000/, "the receipts-only total must be on the line");
    assert.match(line, /unevidenced-rows 2/, "and how many rows are not receipts");
  });

  it("says so when the totals were never computed, rather than implying agreement", () => {
    const line = anchorLine(
      TENANT,
      read(anchorFile(established({ anchoredContributionsUsdg: undefined, unanchoredFlowCount: undefined } as never))),
    );
    assert.match(line, /evidenced not-computed/);
  });

  it("carries a rejected epoch bridge onto the line", () => {
    const line = anchorLine(TENANT, read(anchorFile(established({ carryNote: "opening balance does not match" } as never))));
    assert.match(line, /epoch carry rejected: opening balance does not match/);
  });
});
describe("P4 — self-hosted keeps the behaviour whose premise is true there", () => {
  it("a self-hosted worker takes the legacy local path, anchor or no anchor", () => {
    for (const raw of [null, anchorFile(established())]) {
      const l = accountingLicence(read(raw), { hosted: false });
      assert.equal(l.licence, "self-hosted-local");
      assert.equal(l.contributionsKnown, true, "the local ledger is durable on a real disk");
      const plan = planFirstObservation({
        licence: l.licence,
        equityUsdg: U(10),
        cashUsdg: U(10),
        anchorCashUsdg: null,
        materialDriftUsdg: MATERIAL,
      });
      assert.equal(plan.action, "legacy-local");
    }
  });

  it("a child SQLite emptied by a redeploy is only meaningful when HOSTED", () => {
    // Same empty database, two opposite correct answers. The flag is the hinge.
    const empty = anchorFile(established());
    assert.equal(accountingLicence(read(empty), { hosted: true }).licence, "resume");
    assert.equal(accountingLicence(read(empty), { hosted: false }).licence, "self-hosted-local");
  });
});

describe("P5 — no path converts uncertainty into a P&L figure", () => {
  it("every arm that cannot establish contributions refuses to publish P&L", () => {
    const cannot = [
      null,
      "{not json",
      anchorFile(established(), { schemaVersion: 99 }),
      anchorFile({ kind: "unknown", why: "db down", observedAt: NOW }),
    ];
    for (const raw of cannot) {
      const r = armHosted(raw, { equityUsdg: U(10), cashUsdg: U(10) });
      assert.equal(r.booked, 0n);
      assert.equal(r.contributionsKnown, false);
      assert.equal(
        pnlPublishable({ ...UNKNOWN_QUALITY, arithmetic: "verified", contributionsKnown: r.contributionsKnown }),
        false,
        "unknown contributions must make P&L unavailable, not approximate",
      );
    }
  });

  it("THE FEE IS SUPPRESSED WHEN CONTRIBUTIONS ARE UNKNOWN, but the peak still ratchets", () => {
    // Freezing the high-water mark would make the drawdown breaker LESS likely
    // to halt a falling book, so the suppression is applied to the fee rate and
    // not to the accrual call.
    const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    assert.match(src, /const feeBpsThisTick = accounting\.contributionsKnown \? effFeeBps : 0;/);
    assert.match(src, /accrueAboveHwm\(equityUsdg, highWaterMarkUsdg, feeBpsThisTick\)/);
  });

  it("the old inference is gone from the hosted path", () => {
    // Comments stripped first: the block explaining the bug quotes the old
    // test verbatim, and a pin that counts its own documentation is a pin that
    // breaks when someone improves the wording.
    const src = strip(readFileSync(new URL("./index.ts", import.meta.url), "utf8"));
    // It survives EXACTLY ONCE, inside the self-hosted arm where its premise
    // holds. Two occurrences would mean the hosted path grew one back.
    const hits = src.match(/equityUsdg > 0n && highWaterMarkUsdg === 0n/g) ?? [];
    assert.equal(hits.length, 1, "the HWM==0 inference must exist only in the legacy-local arm");
    assert.match(src, /if \(plan\.action === "legacy-local"\) \{/);
  });
});

describe("P6 — the audit gate can actually fail on arithmetic", () => {
  const book = (over: Partial<ReconstructedBook> = {}): ReconstructedBook => ({
    netContributionsUsdg: 10,
    realizedPnlUsdg: 0,
    gasWei: 0n,
    gasUsdg: 0,
    gasUnpricedFills: 0,
    publishedEquityUsdg: 10,
    publishedCashUsdg: 3.33,
    publishedPositionsUsdg: 6.67,
    publishedVaultUsdg: 0,
    publishedQuarantinedCostUsdg: 0,
    // One flow on record and real purchases visible — the two preconditions the
    // envelope needs. Tests for the cases where they are ABSENT set them to 0
    // explicitly, so the default cannot silently become the weaker claim.
    flowCount: 1,
    markCount: 1,
    grossBuyNotionalUsdg: 6.67,
    chainRefs: [],
    unanchored: [],
    ...over,
  });

  it("a sound book produces no arithmetic finding", () => {
    assert.equal(reconcile(book()).findings.length, 0);
  });

  it("THE CANARY'S BOOK FAILS: contributions booked three times cannot be explained", () => {
    // 30 contributed against 10 of equity implies a 20 USDG unrealized loss on
    // positions that only ever cost 6.67. You cannot lose more on a position
    // than it cost.
    const r = reconcile(book({ netContributionsUsdg: 30 }));
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0]!.check, "arithmetic");
    assert.match(r.findings[0]!.detail, /contributions exceed what the record can support/);
    assert.match(r.findings[0]!.detail, /more than once/);
  });

  it("equity that exceeds the whole value of what is held is money from nowhere", () => {
    // Components kept consistent so the COMPOSITION check stays quiet and the
    // envelope is the only thing under test.
    const r = reconcile(
      book({ netContributionsUsdg: 0, publishedEquityUsdg: 10, publishedCashUsdg: 9, publishedPositionsUsdg: 1 }),
    );
    assert.equal(r.findings.length, 1);
    assert.match(r.findings[0]!.detail, /exceeds what the record can explain/);
  });

  it("the published equity must equal the components published beside it", () => {
    const r = reconcile(book({ publishedCashUsdg: 1 }));
    assert.ok(r.findings.some((f) => /does not equal the components/.test(f.detail)));
  });

  it("an ordinary open position is NOT a finding — the residual is expected to be non-zero", () => {
    // The objection this check had to survive: a mark-to-market difference is
    // not an error, so the bound is what makes the test meaningful.
    for (const equity of [10, 12, 8, 4.5]) {
      // Cash moves with equity so only the residual is varying.
      const r = reconcile(book({ publishedEquityUsdg: equity, publishedCashUsdg: equity - 6.67 }));
      assert.equal(r.findings.length, 0, `equity ${equity}: ${r.findings.map((f) => f.detail).join(" ")}`);
    }
  });

  it("tolerance absorbs REAL-storage noise and nothing larger", () => {
    assert.equal(reconcile(book({ publishedCashUsdg: 3.33 + ARITHMETIC_TOLERANCE_USDG / 2 })).findings.length, 0);
    assert.ok(reconcile(book({ publishedCashUsdg: 3.33 + ARITHMETIC_TOLERANCE_USDG * 20 })).findings.length > 0);
  });

  it("A QUARANTINED POSITION IS NOT A DISCREPANCY", () => {
    // The false positive this check shipped with. `composeEquityUsdg` is
    // cash + vault + positions + quarantinedCost (equity.ts:46), but the mark
    // payload carried only the first three beside the total — so any agent
    // holding a scout position at cost would have had the quarantined amount
    // reported as a book that does not add up.
    //
    // This codebase has already been bitten once by a re-derivation that
    // dropped this exact term: addEquity used to compute cash + vault +
    // positions while the fee ratcheted on a figure that included quarantine,
    // so the published curve sat below the fee basis, permanently.
    const held = book({
      publishedCashUsdg: 1,
      publishedPositionsUsdg: 6.539005,
      publishedQuarantinedCostUsdg: 2.333995,
      publishedEquityUsdg: 9.873,
      netContributionsUsdg: 10,
      grossBuyNotionalUsdg: 9,
    });
    const r = reconcile(held);
    assert.equal(r.checked, true, "with every term present the identity can be closed");
    assert.deepEqual(r.findings, [], "a quarantined holding is part of equity, not a hole in it");
  });

  it("a mark that predates the quarantine term is UNCHECKABLE, not wrong", () => {
    // Absent must not be read as zero — reading it as zero is what made the
    // missing term invisible in the first place.
    const legacy = book({ publishedQuarantinedCostUsdg: null });
    const r = reconcile(legacy);
    assert.equal(r.checked, false, "the identity cannot be closed without every term");
    assert.deepEqual(r.findings, [], "and an unclosable identity is not a failed one");
  });

  it("a book with no marks is not verified — it has not taken the check", () => {
    const r = reconcile(book({ publishedEquityUsdg: null }));
    assert.equal(r.residualUsdg, null);
    assert.equal(r.findings.length, 0, "nothing was published, so nothing is wrong");
    // And the quality field is what stops that being read as a pass.
    assert.equal(UNKNOWN_QUALITY.arithmetic, "unknown");
  });
});

describe("P7 — the gate reports three guarantees and never passes for work it skipped", () => {
  it("NO RPC IS UNKNOWN, NOT CLEAN", () => {
    const src = readFileSync(new URL("./audit-cli.ts", import.meta.url), "utf8");
    // Exit 0 is reachable only after the indeterminate check has been made.
    const soundAt = src.indexOf("CHECKED AND SOUND — all three guarantees held");
    const indetAt = src.indexOf("const indeterminate =");
    assert.ok(indetAt > 0 && soundAt > indetAt, "the sound verdict must come after the indeterminate test");
    assert.match(src, /onchain: !rpcUrl \|\| onchainChecked === 0/);
    assert.match(src, /not checked — no --rpc was given/);
    // Three exit codes, so "wrong" and "unknown" cannot be confused.
    assert.match(src, /process\.exit\(2\)/);
  });

  it("NOT CHECKED RENDERS AS UNKNOWN, NEVER AS FAILED", () => {
    // The same defect as "no RPC means clean", pointed the other way, and it
    // shipped: `onchain` was a boolean with the unknown-ness pushed into the
    // adjacent detail string, and the renderer recovered it by comparing that
    // string to the literal "not checked". The CLI writes "not checked — no
    // --rpc was given, so nothing was refetched", the comparison missed, and an
    // audit that never opened a socket announced that the chain contradicted
    // the ledger.
    //
    // Driven through the REAL detail string the CLI emits, so a future edit to
    // that wording cannot quietly resurrect it.
    const realDetail = "not checked — no --rpc was given, so nothing was refetched";
    const line = guaranteeLines({ ...UNKNOWN_QUALITY, onchainDetail: realDetail })[1]!;
    assert.match(line, /UNKNOWN/);
    assert.doesNotMatch(line, /FAILED/, "an unasked question is not a failed answer");

    // And the three states are distinguishable, which is the property the
    // boolean did not have.
    const of = (onchain: "verified" | "failed" | "unknown") =>
      guaranteeLines({ ...UNKNOWN_QUALITY, onchain, onchainDetail: "x" })[1]!;
    assert.match(of("verified"), /HELD/);
    assert.match(of("failed"), /FAILED/);
    assert.match(of("unknown"), /UNKNOWN/);
  });

  it("the three guarantees are printed separately", () => {
    const lines = guaranteeLines({
      ...UNKNOWN_QUALITY,
      arithmetic: "verified",
      contributionsKnown: true,
      onchainDetail: "not checked",
      journalContinuity: "unrecoverable",
      journalDetail: "the child journal was destroyed by a redeploy",
    });
    assert.equal(lines.length, 3);
    assert.match(lines[0]!, /portfolio arithmetic truth\s+HELD/);
    assert.match(lines[1]!, /on-chain verification\s+UNKNOWN/);
    assert.match(lines[2]!, /journal-chain continuity\s+UNRECOVERABLE/);
  });

  it("an unknown never renders as good news", () => {
    for (const line of guaranteeLines(UNKNOWN_QUALITY)) {
      assert.doesNotMatch(line, /\bSOUND\b|✓/);
    }
  });

  it("THE JOURNAL IS NOT ADDED TO THE MIRROR'S LOG_TABLES", () => {
    // Journal continuity is a separate problem from carrying rows up. The
    // journal is keyed on `seq`, the mirror addresses every table by `id`, and
    // bolting it onto this list would copy rows under a key it does not have.
    const src = readFileSync(new URL("./ledger-mirror.ts", import.meta.url), "utf8");
    const list = src.slice(src.indexOf("const LOG_TABLES"), src.indexOf("] as const;"));
    assert.doesNotMatch(list, /table: "journal"/);
  });
});

describe("P8 — the bootstrap contract is versioned and its reserved field stays reserved", () => {
  it("carries money as exact integer strings, never floats", () => {
    const raw = anchorFile(established({ netContributionsUsdg: "154870000" }));
    const v = read(raw);
    assert.equal(v.kind, "valid");
    assert.equal(
      accountingLicence(v, { hosted: true }).netContributionsUsdg,
      154_870_000n,
      "154.87 USDG must survive the boundary exactly",
    );
    assert.doesNotMatch(raw, /"netContributionsUsdg":\s*\d+\.\d/);
  });

  it("REAL columns convert to micro-USDG without drifting", () => {
    assert.equal(usdgRealToMicro(154.87), 154_870_000n);
    assert.equal(usdgRealToMicro(0), 0n);
    assert.equal(usdgRealToMicro(-3.33), -3_330_000n);
    assert.equal(usdgRealToMicro(Number.NaN), 0n);
  });

  it("outstandingOps is DECLARED but nothing reads it", () => {
    // Reserved so adding the orchestrator-to-child hash push later is not a
    // schema break. An accounting change is not the place to also alter which
    // blocks get scanned.
    const state = readFileSync(new URL("./bootstrap-state.ts", import.meta.url), "utf8");
    assert.match(state, /outstandingOps\?: readonly string\[\];/);
    for (const file of ["./index.ts", "./orchestrator.ts", "./inflight-reconcile.ts"]) {
      const src = readFileSync(new URL(file, import.meta.url), "utf8");
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter((l) => !l.trim().startsWith("//"))
        .join("\n");
      assert.doesNotMatch(code, /outstandingOps/, `${file} must not consume the reserved field yet`);
    }
  });

  it("a future anchor from a skewed clock is refused, not treated as fresh", () => {
    const raw = anchorFile(established(), { generatedAt: NOW + BOOTSTRAP_MAX_AGE_SEC * 2 });
    assert.equal(read(raw).kind, "malformed");
  });

  it("THE CHILD IS NEVER GIVEN DATABASE_URL, which is why this file exists at all", () => {
    const src = readFileSync(new URL("./orchestrator.ts", import.meta.url), "utf8");
    assert.match(src, /const CHILD_SECRET_STRIP = \[[^\]]*"DATABASE_URL"/s);
    // And the anchor is written before the child is spawned, not after.
    const writeAt = src.indexOf("await writeBootstrapForChild(tenant, smartAccount);");
    const spawnAt = src.indexOf("const tickSeconds =", writeAt);
    assert.ok(writeAt > 0 && spawnAt > writeAt, "the anchor must land before the child arms");
  });

  it("THE ANCHOR IS KEYED ON THE SMART ACCOUNT, NOT THE TENANT", () => {
    // The worst defect this change ever had, and it was silent in both
    // directions. `tenant` is the OWNER address that signed the grant; the smart
    // account is the ERC-4337 wallet, and every ledger table keys on the latter
    // (`agents.smart_account`, `flows.agent_id`). The orchestrator holds both
    // and passes them side by side to the identity store, which is what makes
    // reaching for the wrong one so easy.
    //
    // Querying durable state by the owner address finds no rows FOR A FUNDED
    // ACCOUNT — and "the query succeeded and found no history" is the single arm
    // that LICENSES booking the whole balance as an opening contribution. It
    // would have manufactured a contribution on every deploy with the parent's
    // explicit blessing: strictly worse than the bug being fixed.
    //
    // It was masked only by a second mismatch — the parent stamped the tenant
    // while the child compared its smart account — which made every anchor read
    // as `malformed` and the whole mechanism inert. Two bugs cancelling is not a
    // safety property, so both are pinned here.
    const orch = strip(readFileSync(new URL("./orchestrator.ts", import.meta.url), "utf8"));
    assert.match(orch, /deriveBootstrapAccounting\([\s\S]*?smartAccount, now\)/, "the derive must take the smart account");
    assert.doesNotMatch(orch, /deriveBootstrapAccounting\([\s\S]*?[( ]tenant, now\)/, "never the tenant");
    assert.match(orch, /tenantId: smartAccount\.toLowerCase\(\)/, "and the file must be stamped with it");

    const src2 = strip(readFileSync(new URL("./bootstrap-source.ts", import.meta.url), "utf8"));
    assert.match(src2, /const agentId = smartAccount\.toLowerCase\(\);/);

    // The child validates against `agentId`, which IS its smart account.
    const child = strip(readFileSync(new URL("./index.ts", import.meta.url), "utf8"));
    assert.match(child, /readAnchor\(merrymenHome\(\), \{ tenantId: agentId \}\)/);
    assert.match(child, /getAgentFinancials/, "agentId is the smart_account key the store reads on");
  });
});
