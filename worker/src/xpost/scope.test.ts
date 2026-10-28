/**
 * WHO THE OPERATOR NAMED: one parser for the web's reply warning and the
 * orchestrator's behaviour, so the two never disagree about who is active.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { activeTenantsOf, repliesAllowedFor, repliesScopeOf } from "./scope";

const A = `0x${"ab".repeat(20)}`;
const B = `0x${"cd".repeat(20)}`;

describe("the operator's active owners", () => {
  it("are tenant addresses, lowercased; anything else is reported by position, never by value", () => {
    const { tenants, badEntries } = activeTenantsOf(` ${A.toUpperCase().replace("0X", "0x")} , alan ,, ${B} , 0x1234 `);
    assert.deepEqual([...tenants], [A, B]);
    assert.deepEqual(badEntries, [2, 4]);
  });

  it("unset or blank is nobody", () => {
    for (const raw of [undefined, null, "", "  ", " , "]) {
      const { tenants, badEntries } = activeTenantsOf(raw);
      assert.equal(tenants.size, 0);
      assert.deepEqual(badEntries, []);
    }
  });
});

describe("who may reply at all", () => {
  it("1 is everyone, active is the active owners, unset or blank is nobody", () => {
    assert.deepEqual(repliesScopeOf("1"), { scope: "all", unreadable: false });
    assert.deepEqual(repliesScopeOf("active"), { scope: "active", unreadable: false });
    for (const raw of [undefined, null, "", "   "]) assert.deepEqual(repliesScopeOf(raw), { scope: "off", unreadable: false });
  });

  it("anything else is nobody, and unreadable so the caller can name the variable", () => {
    for (const raw of ["true", " 1 ", "Active", "yes", "0", "all"]) assert.deepEqual(repliesScopeOf(raw), { scope: "off", unreadable: true }, raw);
  });

  it("the scope decides per owner; an active scope needs the owner on the list", () => {
    const active = activeTenantsOf(A).tenants;
    assert.equal(repliesAllowedFor("all", new Set(), B), true);
    assert.equal(repliesAllowedFor("active", active, A.toUpperCase().replace("0X", "0x")), true);
    assert.equal(repliesAllowedFor("active", active, B), false);
    assert.equal(repliesAllowedFor("active", new Set(), A), false, "an active scope with nobody named is nobody");
    assert.equal(repliesAllowedFor("off", active, A), false);
  });
});
