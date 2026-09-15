/**
 * WHAT THE OWNER APPROVES IS WHAT EXECUTION ATTEMPTS.
 *
 * `sweepFromBrowser` calls `recoverFunds`, which calls `planRecovery` AGAIN.
 * So the text on the confirmation and the operation that runs were built from
 * two separate 6,000,000-block log scans, and nothing required them to agree.
 *
 * MEASURED 2026-09-13, on real money. An owner approved a confirmation naming
 * 1,063,408.141815 DOGGOS, 20 USDG and the ETH leg. The re-plan enumerated no
 * class holdings. The vault sweep was never attempted, the account sweep went
 * ahead, and tx 0x06ab9816… moved the USDG and the ETH and reported success —
 * with the DOGGOS still in the vault.
 *
 * The engine's best-effort rule is right on its own terms ("a vault that will
 * not give up its tokens must not stop an owner recovering the USDG and ETH
 * they can see") and exactly wrong once a class sweep has been DISCLOSED: then
 * skipping it silently is not resilience, it is delivering a different
 * operation than the one that was agreed to.
 *
 * So the browser path pins its approved class leg and sets
 * `requireApprovedClassSweep`. Identity is pinned; the AMOUNT is never taken
 * from the UI — it is re-read from the vault immediately before signing.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RECOVER = readFileSync(path.join(__dirname, "recover.ts"), "utf8");
const CLIENT = readFileSync(
  path.join(__dirname, "..", "..", "web", "src", "lib", "recover-client.ts"),
  "utf8",
);
const PANEL = readFileSync(
  path.join(__dirname, "..", "..", "web", "src", "components", "RecoverPanel.tsx"),
  "utf8",
);
/** Comments stripped — each file explains the defect by quoting it. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
const R = code(RECOVER);
const sweepFn = R.slice(R.indexOf("export async function recoverFunds"));

describe("the approved class leg reaches the engine", () => {
  it("recoverFunds accepts the approved intent and the fatal flag", () => {
    assert.match(sweepFn, /approvedClass\?: \{/);
    assert.match(sweepFn, /requireApprovedClassSweep\?: boolean/);
  });

  it("the browser passes what it disclosed, and demands it", () => {
    assert.match(code(CLIENT), /approvedClass: \{ \.\.\.approvedClass, destination: to \}/);
    assert.match(code(CLIENT), /requireApprovedClassSweep: true/);
    // And the panel sources it from the plan the owner actually saw.
    assert.match(code(PANEL), /const approvedClass =/);
    assert.match(code(PANEL), /vault: classVault as/);
    assert.match(code(PANEL), /tokens: classHoldings\.map/);
  });

  it("the CLI is untouched — no approved leg means the old best-effort rule", () => {
    // `requireClass` is false unless BOTH the flag and an approved intent are
    // present, so every existing caller keeps the behaviour it had.
    assert.match(
      sweepFn,
      /const requireClass = opts\.requireApprovedClassSweep === true && approved !== null/,
    );
  });
});

describe("identity is pinned; the amount is re-read", () => {
  it("every approved identity is revalidated from chain before signing", () => {
    // destination, derived vault, and the vault's owner — each one says the
    // operation about to be signed is not the one that was shown.
    assert.match(sweepFn, /approved\.destination\.toLowerCase\(\) !== opts\.to\.toLowerCase\(\)/);
    assert.match(sweepFn, /plan\.classVault\.toLowerCase\(\) !== approved\.vault\.toLowerCase\(\)/);
    assert.match(sweepFn, /functionName: "owner"/, "the vault must be asked who owns it");
    assert.match(sweepFn, /vaultOwner!\.toLowerCase\(\) !== account\.address\.toLowerCase\(\)/);
  });

  it("the sweep amount comes from a fresh balanceOf(vault), never from the plan", () => {
    // The approved intent carries TOKENS, not quantities. A stale UI figure
    // must not be able to become a transfer amount.
    const block = sweepFn.slice(sweepFn.indexOf("const wanted = approved"));
    assert.match(block.slice(0, 900), /functionName: "balanceOf"/);
    assert.match(block.slice(0, 900), /args: \[classVault\]/, "read at the VAULT, not the account");
    assert.match(sweepFn, /tokens: readonly Address\[\]/, "the intent names tokens only");
  });

  it("an unreadable vault balance is fatal, not treated as zero", () => {
    // The empty-vs-unavailable rule, on the one path where being wrong strands
    // somebody's holding.
    assert.match(sweepFn, /could not read the class vault balance of/);
    assert.match(sweepFn, /That is not a zero balance/);
  });

  it("a vault that no longer holds the approved token is fatal", () => {
    assert.match(sweepFn, /the class vault holds no \$\{token\}, but the confirmation you approved said it did/);
  });
});

describe("a disclosed sweep that cannot run stops everything", () => {
  it("the failed sweep throws instead of being skipped, when it was approved", () => {
    const katch = sweepFn.slice(sweepFn.indexOf("} catch (e) {"));
    assert.match(katch.slice(0, 900), /if \(requireClass\) \{/);
    assert.match(katch.slice(0, 900), /refusing to continue/);
    assert.match(katch.slice(0, 900), /The account sweep has NOT been attempted/);
    // The best-effort branch survives for everyone else.
    assert.match(katch.slice(0, 1400), /skipped\.push\(/);
  });

  it("the refusal happens BEFORE the account sweep is built", () => {
    // Ordering is the whole property: throwing after the transfers were
    // assembled would still leave the disclosed holding behind.
    const refuseAt = sweepFn.indexOf("refusing to continue");
    const movableAt = sweepFn.indexOf("const movable: TokenBalance[] = []");
    assert.ok(refuseAt >= 0 && movableAt >= 0);
    assert.ok(refuseAt < movableAt, "the class refusal must precede the account sweep");
  });

  it("nothing is signed when it refuses — the message says so, because owners read it", () => {
    assert.match(sweepFn, /Nothing has been signed/);
    assert.match(sweepFn, /your funds are where they were|Your tokens are still in the vault/);
  });
});
