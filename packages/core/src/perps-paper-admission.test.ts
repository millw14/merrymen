import assert from "node:assert/strict";
import { it } from "node:test";
import { perpsPaperTenantAllowed } from "./perps-paper-admission";

it("the internal paper pilot accepts only an explicit owner in a fully valid list", () => {
  const a = `0x${"ab".repeat(20)}`, b = `0x${"cd".repeat(20)}`;
  assert.equal(perpsPaperTenantAllowed(a, {}), false);
  for (const value of ["all", "*", `${a},`, `${a},typo`, `${a}:perps`]) {
    assert.equal(perpsPaperTenantAllowed(a, { MERRYMEN_PERPS_PAPER_TENANTS: value }), false);
  }
  assert.equal(perpsPaperTenantAllowed(a, { MERRYMEN_PERPS_PAPER_TENANTS: ` ${a.toUpperCase()} , ${b}` }), true);
  assert.equal(perpsPaperTenantAllowed(b, { MERRYMEN_PERPS_PAPER_TENANTS: a }), false);
});
