import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { planClaims, socialIdentityProblem, type AccountClaim } from "./account-claim";

const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000b2";
const T1 = "0x0000000000000000000000000000000000000001";
const T2 = "0x0000000000000000000000000000000000000002";

const hist = (account: string, tenant: string): AccountClaim => ({
  account,
  tenant,
  source: "identity-history",
});
const grant = (account: string, tenant: string): AccountClaim => ({
  account,
  tenant,
  source: "installed-grant",
});
const held = (account: string, tenant: string): AccountClaim => ({
  account,
  tenant,
  source: "existing-claim",
});

describe("the backfill is idempotent", () => {
  it("a fresh table takes every observed account exactly once", () => {
    const p = planClaims([hist(A, T1), grant(A, T1), hist(B, T2)], []);
    assert.equal(p.ok, true);
    assert.deepEqual(p.ok && p.insert, [
      { account: A, tenant: T1 },
      { account: B, tenant: T2 },
    ]);
  });

  it("THE SAME ACCOUNT FROM TWO SOURCES IS ONE CLAIM, not a conflict", () => {
    // An installed grant's account is also in its identity's history. That is
    // the normal case, and reading it as a dispute would fail every fleet.
    const p = planClaims([hist(A, T1), grant(A, T1)], []);
    assert.equal(p.ok, true);
    assert.equal(p.ok && p.insert.length, 1);
  });

  it("re-running against a table it already wrote inserts nothing", () => {
    const observed = [hist(A, T1), grant(A, T1), hist(B, T2)];
    const first = planClaims(observed, []);
    assert.equal(first.ok, true);
    const existing = first.ok ? first.insert.map((r) => held(r.account, r.tenant)) : [];
    const second = planClaims(observed, existing);
    assert.equal(second.ok, true);
    assert.deepEqual(second.ok && second.insert, []);
    assert.equal(second.ok && second.alreadyHeld, 2);
  });

  it("case and whitespace do not manufacture a second claim", () => {
    const p = planClaims([hist(A.toUpperCase().replace("0X", "0x"), T1), hist(` ${A} `, T1)], []);
    assert.equal(p.ok, true);
    assert.equal(p.ok && p.insert.length, 1);
    assert.equal(p.ok && p.insert[0]!.account, A);
  });

  it("insert order is deterministic, so a replay writes the same rows in the same sequence", () => {
    const one = planClaims([hist(B, T2), hist(A, T1)], []);
    const two = planClaims([hist(A, T1), hist(B, T2)], []);
    assert.deepEqual(one.ok && one.insert, two.ok && two.insert);
  });
});

describe("a disputed account fails closed and never reassigns", () => {
  it("two tenants claiming one account refuses the whole backfill", () => {
    const p = planClaims([hist(A, T1), hist(A, T2), hist(B, T1)], []);
    assert.equal(p.ok, false);
    assert.equal(p.ok === false && p.conflicts.length, 1);
    assert.deepEqual(p.ok === false && p.conflicts[0]!.tenants, [T1, T2].sort());
  });

  it("NOTHING IS WRITTEN when any account is disputed — not even the clean ones", () => {
    // A partial backfill leaves the table looking complete while some
    // addresses are still unclaimed, which is the state a later `ensure` would
    // silently fill in with whoever asked first.
    const p = planClaims([hist(A, T1), hist(A, T2), hist(B, T1)], []);
    assert.equal(p.ok, false);
    assert.ok(!("insert" in p));
  });

  it("a new observation that contradicts an existing claim is a conflict, not an update", () => {
    const p = planClaims([hist(A, T2)], [held(A, T1)]);
    assert.equal(p.ok, false);
    assert.match(p.ok === false ? p.why : "", /not a question a migration may answer/);
  });

  it("the conflict names the account, both tenants, and where each was seen", () => {
    const p = planClaims([hist(A, T1), grant(A, T2)], []);
    assert.equal(p.ok, false);
    const c = p.ok === false ? p.conflicts[0]! : null;
    assert.equal(c?.account, A);
    assert.deepEqual(c?.tenants, [T1, T2].sort());
    assert.deepEqual(c?.sources, ["identity-history", "installed-grant"]);
  });

  it("an empty account or tenant is skipped, not treated as a dispute on the empty string", () => {
    // The shape a half-written row leaves behind. Two of them are not two
    // people arguing over an agent.
    const p = planClaims([hist("", T1), hist("", T2), hist(A, T1)], []);
    assert.equal(p.ok, true);
    assert.deepEqual(p.ok && p.insert, [{ account: A, tenant: T1 }]);
  });
});

describe("a social identity is validated at the boundary", () => {
  const ok = { did: "did:privy:cabc", provider: "twitter", subject: "1552123" };

  it("a well-formed identity has no problem", () => {
    assert.equal(socialIdentityProblem(ok), null);
  });

  it("EMPTY IS NOT MISSING — each field is refused by name", () => {
    // A partial index `WHERE provider IS NOT NULL` does not exclude '', so two
    // rows carrying it collide under a constraint that looks tolerant.
    assert.match(socialIdentityProblem({ ...ok, did: "" })!, /no DID/);
    assert.match(socialIdentityProblem({ ...ok, did: "   " })!, /no DID/);
    assert.match(socialIdentityProblem({ ...ok, provider: "" })!, /no provider/);
    assert.match(socialIdentityProblem({ ...ok, subject: "" })!, /no provider user id/);
    assert.match(socialIdentityProblem({ ...ok, subject: "\t\n" })!, /no provider user id/);
  });

  it("CASE IS NEVER FOLDED — a DID and a subject are opaque to us", () => {
    // Neither Privy nor X documents these as case-insensitive, and merging two
    // distinct identities is the one direction that cannot be undone. Addresses
    // are different, and are lowercased everywhere, because the chain says so.
    const mixed = { did: "did:privy:AbCdEf", provider: "twitter", subject: "AbC123" };
    assert.equal(socialIdentityProblem(mixed), null);
    // The validator must not be the place that quietly normalises them either:
    // it reports a problem or it does not, and it returns nothing else.
    assert.equal(typeof socialIdentityProblem(mixed), "object");
  });
});
