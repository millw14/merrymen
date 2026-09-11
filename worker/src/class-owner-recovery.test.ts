/**
 * THE OWNER CAN GET THEIR COINS OUT WITH NOTHING OF OURS RUNNING.
 *
 * `PonsClassVault.sweep` existing at contract level was never the question. The
 * question was whether an ordinary owner has a supported way to CALL it, and
 * until now they did not: `merrymen recover` swept ERC-20 balances of the smart
 * account and had no notion of the vault at all. `class-recovery.ts` held
 * well-built primitives — `findClassVault`, `readClassHoldings`,
 * `planClassSweep` — with no production caller anywhere in the repo.
 *
 * So an owner whose whole book was class positions ran the one command that
 * exists to get money out and was told "this account is empty".
 *
 * The property these tests pin: worker dead, orchestrator dead, Brain
 * unavailable, database gone — an owner key and an RPC still recover the vault.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { planClassSweep } from "./class-recovery";
import { PONS_CLASS_VAULT_FACTORY } from "../../packages/core/src/index";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RECOVER = readFileSync(path.join(__dirname, "recover.ts"), "utf8");
const CLI = readFileSync(path.join(__dirname, "recover-cli.ts"), "utf8");

describe("recovery reaches the class vault at all", () => {
  it("planRecovery looks for a vault and reports its holdings", () => {
    assert.match(RECOVER, /findClassVault/, "the plan must find the vault");
    assert.match(RECOVER, /readClassHoldings/, "and read what it holds");
    assert.match(RECOVER, /classHoldings/, "and carry them to the caller");
  });

  it("recoverFunds actually sweeps it", () => {
    assert.match(RECOVER, /planClassSweep/, "the sweep must be planned");
    assert.match(RECOVER, /functionName: "sweep"/, "and the call must be built");
  });

  it("the CLI stops saying 'empty' over a full vault", () => {
    // The exact sentence an owner was shown while their coins sat in a vault.
    // Anchored on the `if (`, not on the expression: the comment above it
    // QUOTES the old expression to explain what was wrong, so a bare search
    // finds the prose and reads it as the code.
    assert.match(
      RECOVER,
      /if \(plan\.balances\.length === 0 && nativeSweptWei === 0n && plan\.classHoldings\.length === 0\)/,
      "the early return must consider the vault before claiming nothing to recover",
    );
    assert.match(CLI, /plan\.classHoldings\.length/, "and the CLI must say so too");
  });
});

describe("it depends on the owner key and an RPC, and nothing else", () => {
  it("enumerates the vault from CHAIN LOGS, not from the local database", () => {
    // `class_positions` lives in a child container's sqlite. This path exists
    // precisely for the case where that container, its database, and everything
    // around it are gone.
    assert.match(RECOVER, /readClassLog/, "candidates come from the vault's own events");
    assert.ok(
      !/classPositions\(/.test(RECOVER),
      "recovery must not read the worker's database — it may not exist",
    );
  });

  it("derives the vault with NO grant, because recovery may have none", () => {
    // `merrymen recover` accepts a pasted owner key with nothing else, and can
    // run against an archived grant. The factory constant is what makes the
    // vault derivable from the owner key alone — which is exactly why it is a
    // deploy fact rather than a setting anyone can edit.
    const call = RECOVER.slice(RECOVER.indexOf("findClassVault({"));
    assert.match(call.slice(0, 500), /grant: null/, "recovery derives rather than reads a grant");
    assert.ok(PONS_CLASS_VAULT_FACTORY[4663], "and a deployed factory makes that possible on mainnet");
  });

  it("uses the SUDO validator, never the session key", () => {
    // The session key is gone after a kill switch, and its wall does not carry
    // `sweep` anyway — deliberately, per wall.ts. Recovery signs with the owner.
    assert.match(RECOVER, /plugins: \{ sudo: ecdsaValidator \}/);
    assert.ok(
      !/sessionKey|toPermissionValidator/.test(RECOVER),
      "recovery must not depend on a session key",
    );
  });

  it("needs no operator or deployer key", () => {
    // The only secrets in this path are the owner's own key and a bundler URL.
    assert.ok(!/MERRYMEN_DEPLOYER_PRIVATE_KEY|operatorKey/.test(RECOVER));
  });
});

describe("a vault sweep is two operations, and fails safely", () => {
  it("filters zero balances BEFORE the batch, because sweep reverts on empty", () => {
    // `sweep` reverts ZeroAmount() on an empty balance and the batch is atomic,
    // so one empty token would revert the whole recovery.
    const kept = planClassSweep([
      { token: "0x1111111111111111111111111111111111111111", symbol: "A", raw: 5n },
      { token: "0x2222222222222222222222222222222222222222", symbol: "B", raw: 0n },
    ]);
    assert.equal(kept.length, 1);
    assert.equal(kept[0]!.symbol, "A");
  });

  it("re-reads the account balance after the sweep rather than predicting it", () => {
    // A Kernel batch cannot thread call N's return into call N+1's arguments,
    // and a curve token is exactly the asset that moves between a pre-read and
    // a send. An oversized transfer reverts, and the batch is atomic — it would
    // take the USDG and the ETH with it.
    const arm = RECOVER.slice(RECOVER.indexOf("OP 1: EMPTY THE CLASS VAULT"));
    assert.match(arm.slice(0, 3000), /functionName: "balanceOf"/, "op 2 must size from a fresh read");
  });

  it("a failed vault sweep does not stop the rest of the recovery", () => {
    // A vault that will not give up its tokens must not strand the USDG and ETH
    // an owner can see. Reported in `skipped`, never silent.
    const arm = RECOVER.slice(RECOVER.indexOf("OP 1: EMPTY THE CLASS VAULT"));
    assert.match(arm.slice(0, 3000), /skipped\.push/, "the failure is reported and survived");
    assert.match(arm.slice(0, 3000), /still in the vault/, "and the owner is told what to do");
  });

  it("an unreadable vault is NOT reported as an empty one", () => {
    // The same rule `classifyBalance` exists for, on the path where believing
    // it costs the most.
    assert.match(RECOVER, /unreadable\.push\("class vault"\)/);
  });

  it("an incomplete log scan says the list may be short", () => {
    assert.match(RECOVER, /may be short/, "a bounded scan must not imply completeness");
  });
});

describe("the exit and the recovery path meet at graduation", () => {
  const INDEX = readFileSync(path.join(__dirname, "index.ts"), "utf8");
  const EXIT = (() => {
    const at = INDEX.indexOf("async function proposeClassExits");
    return INDEX.slice(at, INDEX.indexOf("\n  function curveLegsNow", at));
  })();

  it("a curve near graduation is EXITED before any new entry", () => {
    // Both draw on the same budget. A tick that spends its allowance opening a
    // position cannot close one whose curve is about to become unsellable — and
    // only one of the two has a deadline.
    const exitAt = INDEX.indexOf("await proposeClassExits()");
    const entryAt = INDEX.indexOf("await proposeClassEntries()");
    assert.ok(exitAt > -1 && exitAt < entryAt, "the way out goes first");
    assert.match(EXIT, /progressPct >= exitAtPct/, "and nearness to graduation is what triggers it");
  });

  it("a GRADUATED curve is a state the vault cannot sell through", () => {
    // PonsClassVault._checkCurve reverts CurveGraduated by name, because
    // graduation resets the reserves. The exit does not get worse — it
    // disappears — which is why the cliff fires before it, not after.
    const sol = readFileSync(
      path.join(__dirname, "..", "..", "contracts", "contracts", "PonsClassVault.sol"),
      "utf8",
    );
    assert.match(sol, /revert CurveGraduated\(\)/, "the contract refuses a graduated curve outright");
    assert.match(sol, /function sweep\(address token\) external only/, "but sweep stays available");
  });

  it("and sweep is deliberately NOT granted to the session key", () => {
    // So the only thing that can empty a vault whose curve has graduated is the
    // owner's own key — which is why owner recovery had to exist before the
    // canary, not after it.
    const wall = readFileSync(
      path.join(__dirname, "..", "..", "packages", "core", "src", "wall.ts"),
      "utf8",
    );
    assert.match(wall, /`sweep` is deliberately NOT granted/);
  });

  it("keeps a slippage floor on every exit, so one cannot accept nothing", () => {
    // No impact ceiling — refusing an exit for being expensive locks in the
    // position that most needs to close. But a floor, always: an exit with no
    // floor into a curve nobody can read is how a position leaves for nothing.
    assert.match(EXIT, /curveMinOut\(quoted, cfg\.slippageBps\)/);
    assert.match(EXIT, /if \(floor === null \|\| floor <= 0n\) continue;/);
    assert.ok(!/maxImpactBps/.test(EXIT), "and no impact ceiling that could trap it");
  });
});
