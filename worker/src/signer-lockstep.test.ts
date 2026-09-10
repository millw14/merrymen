import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * TWO SIGNERS, ONE WALL — pinned as source, because signer orchestration has
 * no seams to test through.
 *
 * The failure family this guards is the repo's oldest scar, three times over:
 * a marker minted without its permission (the transfer saga — 24 days of
 * grants claiming a capability the wall never emitted), a permission granted
 * without its marker (the exactInput reverts — routes quoted, submitted, and
 * refused on-chain every tick), and two signers drifting until the phone and
 * the dashboard sealed different walls under the same name.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const WEB = readFileSync(`${HERE}../../web/src/lib/session.ts`, "utf8");
const MOBILE = readFileSync(`${HERE}../../mobile/src/crypto/signGrant.ts`, "utf8");

test("both signers thread the adapter address and mint its marker together", () => {
  for (const [name, src] of [
    ["web/src/lib/session.ts", WEB],
    ["mobile/src/crypto/signGrant.ts", MOBILE],
  ] as const) {
    assert.ok(src.includes("GRANT_V4_ADAPTER"), `${name} must mint the marker`);
    assert.ok(src.includes("v4AdapterAddress"), `${name} must thread the sealed address`);
    // The marker must be CONDITIONAL on the address — minted by the
    // permission, never ahead of it. An unconditional mint is exactly the
    // transfer saga again.
    assert.match(
      src,
      /v4AdapterAddress\s*\?\s*\[GRANT_V4_ADAPTER\]\s*:\s*\[\]/,
      `${name} must mint GRANT_V4_ADAPTER only when the permission was sealed`,
    );
  }
});

test("the legacy v4 route stays never-minted, in both signers", () => {
  // allowUniswapV4 opens Permit2 + UniversalRouter, whose execute() the policy
  // cannot read — "the whole non-USDG book to any address, in one UserOp". The
  // adapter exists precisely so this flag never has to flip. If someone turns
  // it on, this fails and demands they read wall.ts:148-176 first.
  for (const [name, src] of [
    ["web/src/lib/session.ts", WEB],
    ["mobile/src/crypto/signGrant.ts", MOBILE],
  ] as const) {
    assert.ok(
      src.includes("const allowUniswapV4: boolean = false"),
      `${name} must keep the legacy v4 route off — the adapter is the v4 route now`,
    );
  }
});

test("both signers persist the sealed address alongside the marker", () => {
  // The marker alone is a claim. The worker calls grantV4Adapter, which
  // demands the address the permission was actually sealed against — so a
  // signer that mints the marker but drops the field produces a grant the
  // worker correctly treats as adapter-less, and v4 silently never routes.
  for (const [name, src] of [
    ["web/src/lib/session.ts", WEB],
    ["mobile/src/crypto/signGrant.ts", MOBILE],
  ] as const) {
    assert.match(
      src,
      /v4AdapterAddress[^\n]*toLowerCase\(\)/,
      `${name} must write the sealed address (lowercased) onto the grant`,
    );
  }
});

test("both signers mint the PONS adapter marker only when the permission was sealed", () => {
  // Same lockstep rule as GRANT_V4_ADAPTER, and it has to be re-pinned rather
  // than assumed: the two adapters are separate opt-ins, so a signer could
  // thread one and forget the other and nothing else would notice. The failure
  // is the transfer saga again — a marker the wall does not back means the
  // worker builds a UserOp the account contract refuses.
  for (const [name, src] of [
    ["web/src/lib/session.ts", WEB],
    ["mobile/src/crypto/signGrant.ts", MOBILE],
  ] as const) {
    assert.ok(src.includes("GRANT_PONS_ADAPTER"), `${name} must mint the marker`);
    assert.ok(src.includes("ponsAdapterAddress"), `${name} must thread the sealed address`);
    assert.match(
      src,
      /ponsAdapterAddress\s*\?\s*\[GRANT_PONS_ADAPTER\]\s*:\s*\[\]/,
      `${name} must mint GRANT_PONS_ADAPTER only when the permission was sealed`,
    );
    assert.match(
      src,
      /ponsAdapterAddress:\s*(args\.)?ponsAdapterAddress\.toLowerCase\(\)/,
      `${name} must persist the sealed address — the marker alone is a claim`,
    );
  }
});

test("both signers mint the CLASS marker off the resolved vault, not the factory", () => {
  // The same lockstep rule a third time, with one twist that is easy to get
  // wrong and impossible to see afterwards.
  //
  // The class opt-in is a FACTORY address; what the wall pins is the per-account
  // VAULT the factory names. Minting GRANT_PONS_CLASS off the factory would mint
  // it off the REQUEST rather than the result — a grant claiming a class route
  // whose target the wall may never have pinned. resolveClassVault throws rather
  // than returning undefined precisely so the two can never disagree, and this
  // pins the conditional to the resolved value so a later edit cannot quietly
  // swap in the factory.
  for (const [name, src] of [
    ["web/src/lib/session.ts", WEB],
    ["mobile/src/crypto/signGrant.ts", MOBILE],
  ] as const) {
    assert.ok(src.includes("GRANT_PONS_CLASS"), `${name} must mint the marker`);
    assert.ok(src.includes("resolveClassVault"), `${name} must resolve the vault from core`);
    assert.match(
      src,
      /ponsClassVaultAddress\s*\?\s*\[GRANT_PONS_CLASS\]\s*:\s*\[\]/,
      `${name} must mint GRANT_PONS_CLASS only when a vault was actually resolved`,
    );
    assert.ok(
      !/ponsClassVaultFactory\s*\?\s*\[GRANT_PONS_CLASS\]/.test(src),
      `${name} must not mint the class marker off the factory — that is the request, not the pin`,
    );
    assert.match(
      src,
      /ponsClassVaultAddress:\s*ponsClassVaultAddress\.toLowerCase\(\)/,
      `${name} must persist the sealed vault — the marker alone is a claim`,
    );
  }
});

test("a class route is never implied by another venue's opt-in", () => {
  // THREE venues, three decisions. Class is the one that most invites being
  // folded into Pons — it trades the same curves — and folding it in would give
  // every bonding-curve grant a custodial contract holding its positions,
  // without the owner ever choosing that.
  for (const [name, src] of [
    ["web/src/lib/session.ts", WEB],
    ["mobile/src/crypto/signGrant.ts", MOBILE],
  ] as const) {
    assert.ok(
      !/ponsAdapterAddress\s*\?\s*\[[^\]]*GRANT_PONS_CLASS/.test(src),
      `${name} must not mint the class marker off the Pons adapter address`,
    );
    assert.ok(
      !/ponsClassVaultAddress\s*\?\s*\[[^\]]*GRANT_PONS_ADAPTER/.test(src),
      `${name} must not mint the Pons adapter marker off the class vault`,
    );
  }
});

test("the two adapter opt-ins stay INDEPENDENT in both signers", () => {
  // One venue must never imply the other. If a future edit collapses them into
  // a single flag, this fails and demands the author read the wall's note on
  // why the owner's choice is not all-or-nothing.
  for (const [name, src] of [
    ["web/src/lib/session.ts", WEB],
    ["mobile/src/crypto/signGrant.ts", MOBILE],
  ] as const) {
    assert.ok(
      !/v4AdapterAddress\s*\?\s*\[GRANT_V4_ADAPTER,\s*GRANT_PONS_ADAPTER\]/.test(src),
      `${name} must not mint the Pons marker off the v4 address`,
    );
    assert.ok(
      !/ponsAdapterAddress\s*\?\s*\[GRANT_PONS_ADAPTER,\s*GRANT_V4_ADAPTER\]/.test(src),
      `${name} must not mint the v4 marker off the Pons address`,
    );
  }
});
