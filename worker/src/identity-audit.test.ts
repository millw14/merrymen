import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { auditIdentity, type GrantClaimLite, type IdentityRowLite } from "./identity-audit";

const row = (o: Partial<IdentityRowLite> & { tenant: string }): IdentityRowLite => ({
  slug: "aaaaaaaaaaaaaaaa",
  accounts: [],
  privyDid: null,
  provider: null,
  subject: null,
  ...o,
});

const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000b2";
const T1 = "0x0000000000000000000000000000000000000001";
const T2 = "0x0000000000000000000000000000000000000002";

describe("the audit refuses to guess", () => {
  it("a clean table is safe to constrain, and says so", () => {
    const r = auditIdentity(
      [
        row({ tenant: T1, accounts: [A], privyDid: "did:privy:one", provider: "google", subject: "g1" }),
        row({ tenant: T2, accounts: [B], privyDid: "did:privy:two", provider: "google", subject: "g2" }),
      ],
      [
        { tenant: T1, smartAccount: A },
        { tenant: T2, smartAccount: B },
      ],
    );
    assert.equal(r.safeToConstrain, true);
    assert.ok(r.lines.some((l) => /VERDICT: every one-to-one relationship already holds/.test(l)));
    assert.ok(r.lines.every((l) => !/COLLISION/.test(l)));
  });

  it("two tenants holding one CURRENT account blocks the constraint and names both", () => {
    const r = auditIdentity(
      [row({ tenant: T1, accounts: [A] }), row({ tenant: T2, accounts: [A] })],
      [],
    );
    assert.equal(r.safeToConstrain, false);
    assert.ok(r.lines.some((l) => l.includes(A) && l.includes(T1) && l.includes(T2)));
    assert.ok(r.lines.some((l) => /DO NOT ADD THE CONSTRAINT/.test(l)));
  });

  it("NEVER RESOLVES A COLLISION — that is a question about who owns an agent", () => {
    const r = auditIdentity([row({ tenant: T1, accounts: [A] }), row({ tenant: T2, accounts: [A] })], []);
    const text = r.lines.join("\n");
    // It says out loud that it touched nothing...
    assert.match(text, /nothing was changed/);
    // ...it never claims to have acted...
    assert.doesNotMatch(text, /\b(deleted|merged|removed|deduplicated|resolved)\b/i);
    // ...and it hands the decision to a person rather than proposing a rule.
    assert.match(text, /by hand/);
    assert.match(text, /not a migration's call/);
  });

  it("HISTORY IS PRESERVED, not treated as a collision", () => {
    // A re-grant appends a new account and keeps the slug. One tenant listing
    // both of its own accounts is the schema working, not a violation.
    const r = auditIdentity([row({ tenant: T1, accounts: [B, A] })], [{ tenant: T1, smartAccount: B }]);
    assert.equal(r.safeToConstrain, true);
  });

  it("but one account appearing in TWO tenants' history is a disagreement", () => {
    const r = auditIdentity(
      [row({ tenant: T1, accounts: [B, A] }), row({ tenant: T2, accounts: [A] })],
      [],
    );
    assert.equal(r.safeToConstrain, false);
    assert.ok(r.lines.some((l) => /account history/.test(l) && /COLLISION/.test(l)));
  });

  it("one DID on two tenants is exactly the second-Merryman bug, and blocks", () => {
    const r = auditIdentity(
      [
        row({ tenant: T1, accounts: [A], privyDid: "did:privy:same" }),
        row({ tenant: T2, accounts: [B], privyDid: "did:privy:same" }),
      ],
      [],
    );
    assert.equal(r.safeToConstrain, false);
    assert.ok(r.lines.some((l) => /privy did/.test(l) && /COLLISION/.test(l)));
  });

  it("uniqueness is asked of provider+subject, never of the handle", () => {
    // A handle is reassignable; the provider's own id is not. Two rows may
    // share a handle without any violation at all.
    const r = auditIdentity(
      [
        row({ tenant: T1, accounts: [A], provider: "twitter", subject: "111" }),
        row({ tenant: T2, accounts: [B], provider: "twitter", subject: "222" }),
      ],
      [],
    );
    assert.equal(r.safeToConstrain, true);

    const clash = auditIdentity(
      [
        row({ tenant: T1, accounts: [A], provider: "twitter", subject: "111" }),
        row({ tenant: T2, accounts: [B], provider: "twitter", subject: "111" }),
      ],
      [],
    );
    assert.equal(clash.safeToConstrain, false);
  });

  it("two tenants with a grant on one smart account blocks — that is one ledger partition", () => {
    const r = auditIdentity(
      [row({ tenant: T1, accounts: [A] }), row({ tenant: T2, accounts: [B] })],
      [
        { tenant: T1, smartAccount: A },
        { tenant: T2, smartAccount: A },
      ],
    );
    assert.equal(r.safeToConstrain, false);
    assert.ok(r.lines.some((l) => /installed grants/.test(l) && /COLLISION/.test(l)));
  });

  it("a grant whose account the identity row does not list is reported as drift, not uniqueness", () => {
    const r = auditIdentity([row({ tenant: T1, accounts: [A] })], [{ tenant: T1, smartAccount: B }]);
    // Drift does not by itself block the constraint — it is a different fault
    // with a different remedy — but it must be visible.
    assert.equal(r.safeToConstrain, true);
    assert.ok(r.lines.some((l) => /DISAGREEMENT/.test(l)));
    assert.ok(r.lines.some((l) => l.includes(B) && /does not list/.test(l)));
  });

  it("a grant with no identity row at all is reported", () => {
    const r = auditIdentity([], [{ tenant: T1, smartAccount: A }]);
    assert.ok(r.lines.some((l) => /has a grant but no identity row/.test(l)));
  });

  it("case and whitespace never manufacture or hide a collision", () => {
    const r = auditIdentity(
      [row({ tenant: T1, accounts: [A.toUpperCase().replace("0X", "0x")] }), row({ tenant: T2, accounts: [` ${A} `] })],
      [],
    );
    assert.equal(r.safeToConstrain, false);
  });

  it("REPORTS RESIDUE: an account already sealed at the zero address", () => {
    // The guard this PR adds is mint-time. Whether the bug already happened is
    // a question about production, and the audit is the only thing that reads it.
    const ZERO = "0x0000000000000000000000000000000000000000";
    const r = auditIdentity([row({ tenant: T1, accounts: [ZERO] })], [{ tenant: T1, smartAccount: ZERO }]);
    assert.equal(r.zeroAddressResidue, 2, "the history entry and the installed grant are both residue");
    assert.ok(r.lines.some((l) => /INSTALLED GRANT on the zero address/.test(l)));
  });

  it("says so plainly when there is no zero residue", () => {
    const r = auditIdentity([row({ tenant: T1, accounts: [A] })], [{ tenant: T1, smartAccount: A }]);
    assert.equal(r.zeroAddressResidue, 0);
    assert.ok(r.lines.some((l) => /no account was ever sealed at 0x0/.test(l)));
  });

  it("COUNTS the users the new one-proof refusal would bar, rather than assuming there are none", () => {
    const r = auditIdentity(
      [row({ tenant: T1, accounts: [A] }), row({ tenant: T2, accounts: [B] })],
      [
        { tenant: T1, smartAccount: A, owner: T1 },
        { tenant: T2, smartAccount: B, owner: "0x00000000000000000000000000000000000000c3" },
      ],
    );
    assert.equal(r.sameKeyOwners, 1);
    assert.ok(r.lines.some((l) => /owns its account with its own login key/.test(l)));
  });

  it("distinguishes 'no same-key owners' from 'nobody exposed an owner'", () => {
    const known = auditIdentity([], [{ tenant: T1, smartAccount: A, owner: B }]);
    assert.equal(known.sameKeyOwners, 0);
    assert.ok(known.lines.some((l) => /every owner key is separate/.test(l)));

    const unknown = auditIdentity([], [{ tenant: T1, smartAccount: A }]);
    assert.ok(unknown.lines.some((l) => /not checked/.test(l)), "an unread column is not a clean result");
  });

  it("a DID is fingerprinted in the report, never printed", () => {
    const did = "did:privy:clx0secret0identifier";
    const r = auditIdentity(
      [row({ tenant: T1, accounts: [A], privyDid: did }), row({ tenant: T2, accounts: [B], privyDid: did })],
      [],
    );
    const text = r.lines.join(" | ");
    assert.ok(!text.includes(did), "a DID beside a tenant address joins a login to an on-chain identity");
    assert.match(text, /privy did\s+1 COLLISION/);
    assert.match(text, /#[0-9a-f]{8} held by/);
  });

  it("DIDs and subjects are compared case-SENSITIVELY, like the index that will enforce them", () => {
    const r = auditIdentity(
      [
        row({ tenant: T1, accounts: [A], privyDid: "did:privy:AbC" }),
        row({ tenant: T2, accounts: [B], privyDid: "did:privy:abc" }),
      ],
      [],
    );
    assert.equal(r.safeToConstrain, true, "folding case would block a constraint that applies cleanly");
  });

  it("an empty-string smart account is a VALUE, and collides", () => {
    // Postgres indexes lower('') like any other key; a truthiness filter would
    // drop these and bless a table the index rejects.
    const r = auditIdentity([], [
      { tenant: T1, smartAccount: "" },
      { tenant: T2, smartAccount: "" },
    ]);
    assert.equal(r.safeToConstrain, false);
  });

  it("a clean verdict still names store drift rather than reading as an all-clear", () => {
    const r = auditIdentity([row({ tenant: T1, accounts: [A] })], [{ tenant: T1, smartAccount: B }]);
    assert.equal(r.safeToConstrain, true);
    const verdict = r.lines.find((l) => l.startsWith("VERDICT:"))!;
    assert.match(verdict, /store disagreement\(s\) above would be frozen in place/);
  });

  it("an empty fleet is clean", () => {
    const r = auditIdentity([], []);
    assert.equal(r.safeToConstrain, true);
    assert.ok(r.lines[0]?.startsWith("0 identity row(s)"));
  });
});
