/**
 * THE ETH LEG HAS TO BE ON THE SCREEN, BECAUSE IT MOVES.
 *
 * `recoverFunds` appends a bare value call to the destination on every recovery
 * (`recover.ts`, the `nativeSweptWei > 0n` branch). The confirmation listed the
 * class vault and the account's tokens — and native ETH is in NEITHER list, so
 * it was the one thing that left without being named.
 *
 * Measured live 2026-09-13 on a funded account: the panel disclosed
 * 1,063,408.141815 DOGGOS and 20 USDG and said nothing whatever about ETH,
 * while 0.000828856 of 0.001 would have gone with it.
 *
 * THE NUMBER IS NOT WRITTEN DOWN ANYWHERE. It is `nativeSweep(held, gasPrice)`,
 * the same function the sweep itself calls, so the figure shown and the figure
 * sent come from one rule rather than two that can drift. These tests pin the
 * arithmetic rather than a constant, which is why they keep working when the
 * gas price moves.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { nativeSweep } from "./recover";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PANEL = readFileSync(
  path.join(__dirname, "..", "..", "web", "src", "components", "RecoverPanel.tsx"),
  "utf8",
);
const RECOVER = readFileSync(path.join(__dirname, "recover.ts"), "utf8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

/** Shogun's real state at the moment this was written. */
const HELD = 1_000_000_000_000_000n; // 0.001 ETH
const GAS_PRICE = 95_100_000n; // 0.0951 gwei

describe("balance minus reserve is what the disclosure says", () => {
  it("held - reserve = recoverable, exactly", () => {
    const { sweep, reserve } = nativeSweep(HELD, GAS_PRICE);
    // The identity the operator checks by eye. If these three ever stop adding
    // up, the screen is lying about one of them.
    assert.equal(sweep + reserve, HELD, "nothing may appear or vanish between the two");
    assert.equal(sweep, HELD - reserve);
    // And the reserve is the engine's own rule, not a number chosen here.
    assert.equal(reserve, GAS_PRICE * 900_000n * 2n);
    // Sanity against the figures measured live, to the wei.
    assert.equal(reserve, 171_180_000_000_000n);
    assert.equal(sweep, 828_820_000_000_000n);
  });

  it("a balance that cannot clear the reserve discloses nothing recoverable", () => {
    // The dust case, and the honest answer is zero rather than a negative or a
    // promise the sweep cannot keep.
    const { sweep, reserve } = nativeSweep(100n, GAS_PRICE);
    assert.equal(sweep, 0n);
    assert.equal(reserve, 100n, "the whole balance stays");
    assert.equal(sweep + reserve, 100n);
  });

  it("the PLAN forecasts it with the same function the SWEEP uses", () => {
    // Two call sites, one rule. If the plan ever computed its own version, the
    // number shown and the number sent could differ with nothing to catch it.
    const plan = code(RECOVER).slice(
      code(RECOVER).indexOf("export async function planRecovery"),
      code(RECOVER).indexOf("export async function recoverFunds"),
    );
    assert.match(plan, /nativeSweep\(/, "the planner must forecast through nativeSweep");
    assert.match(plan, /nativeRecoverableWei/);
    assert.match(plan, /getGasPrice\(\)/, "priced from the live chain, not assumed");
    // And a failed gas read must forecast ZERO, never the whole balance.
    assert.match(plan, /let nativeRecoverableWei = 0n;/);
    assert.match(plan, /unreadable\.push\("gas price"\)/);
  });
});

describe("the confirmation names everything that will move", () => {
  const dialog = (() => {
    const c = code(PANEL);
    const start = c.indexOf("const lines: string[] = []");
    return c.slice(start, c.indexOf("window.confirm", start));
  })();

  it("class vault, smart account, native ETH, and destination — all four", () => {
    assert.match(dialog, /"CLASS VAULT"/, "the vault");
    assert.match(dialog, /SMART ACCOUNT \$\{smartAccount/, "the account");
    assert.match(dialog, /"NATIVE ETH"/, "the ETH leg that used to be omitted");
    assert.match(dialog, /"DESTINATION"/, "and where it all goes");
  });

  it("the ETH figure comes from the plan, not from the UI's own arithmetic", () => {
    // `ethLeg` reads nativeRecoverableWei off the plan. A UI that recomputed the
    // reserve would be a second implementation of the engine's rule.
    assert.match(dialog, /ethLeg\.recoverable/);
    assert.match(dialog, /ethLeg\.reserve/, "and says what stays behind, not just what leaves");
    const leg = code(PANEL).slice(code(PANEL).indexOf("const ethLeg = "));
    assert.match(leg.slice(0, 600), /plan\?\.nativeRecoverableWei/);
    assert.doesNotMatch(leg.slice(0, 600), /900_?000|gasPrice|getGasPrice/, "the UI must not re-derive the reserve");
  });

  it("says 'approximately', because the gas price is read again at execution", () => {
    assert.match(dialog, /approximately/);
  });

  it("omits the ETH section entirely rather than promising an unpriceable amount", () => {
    // Zero recoverable and an unreadable gas price are the same answer here:
    // say nothing about ETH. `unreadable` already records which it was.
    const leg = code(PANEL).slice(code(PANEL).indexOf("const ethLeg = "));
    assert.match(leg.slice(0, 600), /if \(raw === undefined\) return null/);
    assert.match(leg.slice(0, 600), /if \(wei <= 0n\) return null/);
    assert.match(dialog, /if \(ethLeg\)/, "the section is conditional on having a real figure");
  });

  it("the plan carries the forecast through to the panel, unrounded", () => {
    // The class fields were dropped exactly here once already. Carried as a
    // STRING because a bigint does not survive the round trip through state.
    assert.match(code(PANEL), /nativeRecoverableWei: String\(b\.nativeRecoverableWei\)/);
    assert.match(code(PANEL), /nativeReserveWei: String\(b\.nativeReserveWei\)/);
  });
});
