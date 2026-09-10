/**
 * ASSETS THAT ARE OWNED BUT NOT HELD.
 *
 * Every accounting surface here was written when "owned" and "held by the smart
 * account" were the same fact. `PonsClassVault` separates them on purpose, and
 * the two rules below are where that separation is destructive if nobody
 * notices: one DELETES a cost basis, the other REFUSES an exit.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bookAddresses,
  custodyAddressesOf,
  exitTargetFor,
  provenanceCurves,
  strandedBasisSymbols,
  type Custody,
} from "./custody";

const ACCOUNT = "0x00000000000000000000000000000000000000a1";
const VAULT = "0x00000000000000000000000000000000000000c0";
const CURVE_A = "0x00000000000000000000000000000000000000e1";
const CURVE_B = "0x00000000000000000000000000000000000000e2";

const classGrant = { grantFeatures: ["pons-class"], ponsClassVaultAddress: VAULT };
const plainGrant = { grantFeatures: ["tradeable-v2"] };

describe("who counts as `we`", () => {
  it("a grant with no class marker has exactly one holder", () => {
    assert.deepEqual(custodyAddressesOf(plainGrant), []);
    assert.deepEqual(bookAddresses(plainGrant, ACCOUNT), [ACCOUNT]);
  });

  it("the marker ALONE is not enough — an address must be sealed with it", () => {
    // grantPonsClassVault's rule, inherited rather than re-implemented: a marker
    // is a claim, and reading a book from a claim would read someone else's.
    assert.deepEqual(custodyAddressesOf({ grantFeatures: ["pons-class"] }), []);
  });

  it("a sealed vault joins the book, account first", () => {
    assert.deepEqual(bookAddresses(classGrant, ACCOUNT), [ACCOUNT, VAULT]);
  });

  it("a checksummed address comes back lowercased, so a key built from it is stable", () => {
    // Mixed case in the BODY is EIP-55, which is what a signer actually writes.
    // The `0x` prefix stays lowercase — `0X` is not an address, and the
    // accessor's regex is right to refuse it (grantPonsAdapter refuses it too).
    const mixed = { ...classGrant, ponsClassVaultAddress: `0x${VAULT.slice(2).toUpperCase()}` };
    assert.deepEqual(bookAddresses(mixed, `0x${ACCOUNT.slice(2).toUpperCase()}`), [ACCOUNT, VAULT]);
  });

  it("every custody names how to exit it", () => {
    // The question custody actually changes. An exhaustive switch means a third
    // custody cannot be added without answering it.
    for (const c of ["account", "class-vault"] as Custody[]) {
      assert.ok(exitTargetFor(c).length > 0);
    }
    assert.notEqual(exitTargetFor("account"), exitTargetFor("class-vault"));
  });
});

describe("closing a stranded basis must not close a live one", () => {
  const base = {
    basisSymbols: ["PEPE"],
    positions: [] as string[],
    unpricedByDesign: [] as string[],
    missingPrice: [] as string[],
    classHeld: [] as string[],
  };

  it("THE BUG: a vault-held position looks flat to an account-scoped read", () => {
    // Without classHeld, `PEPE` is in none of the three sets the tick unions, so
    // its basis is closed on the first tick after the buy — and store.ts deletes
    // the position_floors row in the same call, so both mechanical exits go
    // blind on a position that is very much still open.
    assert.deepEqual(strandedBasisSymbols(base), ["PEPE"]);
  });

  it("THE FIX: a vault-held symbol is held", () => {
    assert.deepEqual(strandedBasisSymbols({ ...base, classHeld: ["PEPE"] }), []);
  });

  it("A FAILED CUSTODY READ CLOSES NOTHING AT ALL", () => {
    // The more important half. Everywhere else an unreadable input means "this
    // rule cannot run"; here the rule's output is an irreversible deletion, so a
    // read that did not happen must not be able to spend it. Note this holds
    // even for a symbol that IS genuinely stranded — the sweep waits a tick
    // rather than guessing.
    assert.deepEqual(
      strandedBasisSymbols({ ...base, basisSymbols: ["PEPE", "GONE"], classReadOk: false }),
      [],
    );
  });

  it("absent classReadOk keeps today's behaviour — only a caller who KNOWS passes false", () => {
    assert.deepEqual(strandedBasisSymbols({ ...base, classHeld: ["PEPE"] }), []);
  });

  it("still closes a genuinely flat position, which is the rule's whole job", () => {
    // A recorded class row with a zero on-chain balance is not in classHeld, so
    // a fully-sold or swept position still gets its basis closed.
    assert.deepEqual(
      strandedBasisSymbols({ ...base, basisSymbols: ["SOLD"], classHeld: ["PEPE"] }),
      ["SOLD"],
    );
  });

  it("the account's own three sources still count", () => {
    for (const key of ["positions", "unpricedByDesign", "missingPrice"] as const) {
      assert.deepEqual(strandedBasisSymbols({ ...base, [key]: ["PEPE"] }), [], key);
    }
  });
});

describe("a position cannot be evicted out of its own exit", () => {
  it("its own curve is in the provenance set even after the launch feed forgot it", () => {
    // discovered_pools is pruned to the 5,000 newest and the launchpad turns
    // that over in about 21 days, against a 14-day grant. For a class position
    // the curve is the ONLY thing vouching for the token, so losing the row
    // means the mirror refuses the sell that would close it.
    const set = provenanceCurves([CURVE_A], [CURVE_B]);
    assert.ok(set?.includes(CURVE_B), "the agent is holding it; that is the vouching");
    assert.ok(set?.includes(CURVE_A));
  });

  it("deduplicates and lowercases, so the policy's own lowercased compare matches", () => {
    assert.deepEqual(provenanceCurves([CURVE_A.toUpperCase()], [CURVE_A]), [CURVE_A]);
  });

  it("EITHER source failing yields undefined, never a partial list", () => {
    // A partial list is worse than none: a class trade is refused when its curve
    // is absent, so a short list is a SILENT refusal of exactly the positions
    // that were dropped — indistinguishable from a curve nobody ever saw.
    assert.equal(provenanceCurves(null, [CURVE_B]), undefined);
    assert.equal(provenanceCurves([CURVE_A], null), undefined);
    assert.equal(provenanceCurves(null, null), undefined);
  });

  it("two empty lists are an empty set, not undefined", () => {
    // Nothing known is a readable fact and must stay distinguishable from
    // "could not ask" — policy.ts treats them oppositely.
    assert.deepEqual(provenanceCurves([], []), []);
  });
});
