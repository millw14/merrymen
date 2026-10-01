import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ACCOUNTING_HOLD_ENV, accountingCommitRefusal, accountingHoldTenants, accountingTenantHeld, runAccountingReconstructionAtStartup } from "./accounting-maintenance";

const TENANT = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const ACCOUNT = "0xa96Bf429888e1aAb4255762d17d29C53f6a0370d";
const fresh = () => ({ processPresent: false, localHomePresent: false });
const valid = () => ({
  mode: "commit", accounts: [ACCOUNT.toLowerCase()], plans: [{ smartAccount: ACCOUNT, tenant: TENANT }],
  env: { [ACCOUNTING_HOLD_ENV]: TENANT }, localState: fresh,
});

describe("operator accounting maintenance scope", () => {
  it("holds only complete named tenants and accepts address case/whitespace", () => {
    const mixed = "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD";
    const env = { [ACCOUNTING_HOLD_ENV]: ` ${TENANT}, ${mixed} ,${TENANT}` };
    assert.equal(accountingHoldTenants(env).size, 2);
    assert.equal(accountingTenantHeld(TENANT, env), true);
    assert.equal(accountingTenantHeld(mixed.toLowerCase(), env), true);
    assert.equal(accountingTenantHeld(OTHER, env), false);
    assert.equal(accountingHoldTenants({}).size, 0);
  });
  for (const invalid of ["*", "0x123", `${TENANT},`, `${TENANT},garbage`, `${TENANT};${OTHER}`]) {
    it(`rejects malformed configuration rather than applying a partial hold (${invalid.slice(-12)})`, () => {
      assert.throws(() => accountingHoldTenants({ [ACCOUNTING_HOLD_ENV]: invalid }), /refusing a partial hold/);
    });
  }
  it("refuses commit until the exact resolved tenant is explicitly held", () => {
    assert.match(accountingCommitRefusal({ ...valid(), env: {} })!, /must be explicitly held/);
    assert.match(accountingCommitRefusal({ ...valid(), env: { [ACCOUNTING_HOLD_ENV]: OTHER } })!, /must be explicitly held/);
    assert.equal(accountingCommitRefusal(valid()), null);
  });
  it("refuses empty, malformed, missing and ambiguously resolved account scope", () => {
    assert.match(accountingCommitRefusal({ ...valid(), accounts: [] })!, /explicitly selected/);
    assert.match(accountingCommitRefusal({ ...valid(), accounts: ["0xa96"] })!, /complete/);
    assert.match(accountingCommitRefusal({ ...valid(), plans: [] })!, /exactly one tenant/);
    assert.match(accountingCommitRefusal({ ...valid(), plans: [{ smartAccount: ACCOUNT, tenant: null }] })!, /exactly one tenant/);
    assert.match(accountingCommitRefusal({ ...valid(), plans: [...valid().plans, ...valid().plans] })!, /exactly one tenant/);
  });
  it("requires every selected account to be held, not merely the first", () => {
    assert.match(accountingCommitRefusal({ ...valid(), accounts: [ACCOUNT, OTHER], plans: [...valid().plans, { smartAccount: OTHER, tenant: OTHER }] })!, /must be explicitly held/);
  });
  it("refuses live/preparing/exiting processes and retained tenant state", () => {
    assert.match(accountingCommitRefusal({ ...valid(), localState: () => ({ processPresent: true, localHomePresent: false }) })!, /local process/);
    assert.match(accountingCommitRefusal({ ...valid(), localState: () => ({ processPresent: false, localHomePresent: true }) })!, /fresh container/);
  });
  it("leaves dry-run and verification read-only paths independent of maintenance holds", () => {
    const localState = () => { throw new Error("must not inspect a process for a read-only run"); };
    for (const mode of ["dry-run", "verify-only"]) assert.equal(accountingCommitRefusal({ ...valid(), mode, env: {}, localState }), null);
  });
  it("keeps the unheld startup ordering and handles a background scan rejection", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    let completed = false;
    const startup = runAccountingReconstructionAtStartup({ heldTenants: new Set(), reconstruct: () => pending, onError: () => assert.fail("unheld failure is awaited") }).then(() => { completed = true; });
    await Promise.resolve();
    assert.equal(completed, false);
    finish();
    await startup;
    assert.equal(completed, true);
    const errors: unknown[] = [];
    const failure = new Error("scan unavailable");
    await runAccountingReconstructionAtStartup({ heldTenants: new Set([TENANT]), reconstruct: async () => { throw failure; }, onError: (error) => errors.push(error) });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(errors, [failure]);
  });
});
