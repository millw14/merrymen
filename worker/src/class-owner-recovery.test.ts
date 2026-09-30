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
    // ACROSS EVERY VAULT, now that an account can have two. Counting only the
    // primary one would print "this account is empty" over a full second vault
    // — the same defect this test was written for, with a different cause.
    assert.ok(
      CLI.includes("plan.classVaults.reduce((n, v) => n + v.holdings.length, 0)"),
      "the CLI must count holdings across every vault before claiming nothing",
    );
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
    // run against an archived grant. The factory constants are what make the
    // vault derivable from the owner key alone — which is exactly why they are a
    // deploy fact rather than a setting anyone can edit.
    const call = RECOVER.slice(RECOVER.indexOf("findClassVaults({"));
    assert.ok(call.length > 0, "recovery must enumerate vaults, not pick one");
    assert.match(call.slice(0, 600), /grant: null/, "recovery derives rather than reads a grant");
    assert.ok(PONS_CLASS_VAULT_FACTORY[4663], "and a deployed factory makes that possible on mainnet");
  });

  it("ASKS BOTH FACTORIES, because after v2 one address is a guess", () => {
    // The timing is what makes this urgent rather than tidy. When an owner
    // re-signs onto a v2 factory, their v1 vault stops being reachable by the
    // session key — recovery becomes the only way left to whatever is still
    // sitting in it. A recovery that looks in one place reports "nothing found"
    // over a real balance, and that false negative is the failure this module
    // exists to prevent.
    const src = readFileSync(
      path.join(__dirname, "class-recovery.ts"),
      "utf8",
    );
    assert.ok(src.includes("PONS_CLASS_VAULT_FACTORY_V2[args.chainId]"), "v2 must be asked");
    assert.ok(src.includes("PONS_CLASS_VAULT_FACTORY[args.chainId]"), "and v1 must still be asked");
    // Per factory, never for the lookup: one refusing a read says nothing about
    // the other, and collapsing them turns a partial answer into no answer.
    assert.ok(src.includes("unreadable.push({ factory"), "a failed read is named, not collapsed");
  });
  it("ONE OPERATION PER VAULT, because the batch is atomic", () => {
    // sweep(token) is a call ON a vault, so the target travels with the holding.
    // Two vaults in one operation means a dead one takes the live one down and
    // `skipped` cannot say which failed.
    assert.ok(
      RECOVER.includes("for (const target of vaultsToSweep)"),
      "the sweep loops over vaults rather than naming one",
    );
    assert.ok(
      RECOVER.includes("async function sweepOneVault("),
      "and each vault gets its own operation rather than sharing a batch",
    );
    // The refusal names the address, because with two vaults "the class vault
    // sweep failed" is a question the owner cannot answer.
    assert.ok(
      RECOVER.includes("class vault ${classVault}"),
      "a skipped sweep names which vault still holds the tokens",
    );
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

  /**
   * The class-sweep section of recover.ts, bounded by its own STRUCTURE.
   *
   * These assertions used to slice a fixed 9,000 characters after the "OP 1"
   * marker, and that number is a proxy for "the class sweep section" that stops
   * being true the moment the section grows. It did: going one-operation-per-vault
   * pushed `skipped.push` to 9,045 characters past the marker.
   *
   * WORSE, IT FAILED ONLY ON SOME CHECKOUTS. CRLF costs one byte a line, so a
   * Windows working tree crossed the boundary while Linux CI stayed 250 bytes
   * inside it and reported green. A test that depends on line endings is a test
   * that tells different people different things about the same commit.
   *
   * The account sweep begins at `const movable`, which is a real boundary and
   * cannot drift.
   */
  const CLASS_ARM = (() => {
    const from = RECOVER.indexOf("OP 1: EMPTY THE CLASS VAULT");
    const to = RECOVER.indexOf("const movable: TokenBalance[]", from);
    assert.ok(from > -1, "the class sweep section must be findable by its own heading");
    assert.ok(to > from, "and it must end where the account sweep begins");
    return RECOVER.slice(from, to);
  })();

  it("re-reads the account balance after the sweep rather than predicting it", () => {
    // A Kernel batch cannot thread call N's return into call N+1's arguments,
    // and a curve token is exactly the asset that moves between a pre-read and
    // a send. An oversized transfer reverts, and the batch is atomic — it would
    // take the USDG and the ETH with it.
    assert.match(CLASS_ARM, /functionName: "balanceOf"/, "op 2 must size from a fresh read");
  });

  it("a failed vault sweep does not stop the rest of the recovery — WHEN IT WAS NOT APPROVED", () => {
    // Best-effort is the DEFAULT branch only. When a browser confirmation
    // disclosed the class sweep, the opposite is required and the failure is
    // fatal — see recovery-approved-class.test.ts. Best-effort is right for a
    // caller who approved no class leg, and wrong for one who did.
    // A vault that will not give up its tokens must not strand the USDG and ETH
    // an owner can see. Reported in `skipped`, never silent.
    assert.match(CLASS_ARM, /skipped\.push/, "the failure is reported and survived");
    assert.match(CLASS_ARM, /still in (the|that) vault/, "and the owner is told what to do");
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
    // BOTH VERSIONS. v1 is deployed and may hold a position; v2 is what new
    // grants will point at. A property asserted of one and not the other is a
    // property that silently stops holding the day the fleet moves.
    for (const name of ["PonsClassVault.sol", "PonsClassVaultV2.sol"]) {
      const sol = readFileSync(
        path.join(__dirname, "..", "..", "contracts", "contracts", name),
        "utf8",
      );
      assert.match(sol, /revert CurveGraduated\(\)/, `${name} refuses a graduated curve outright`);
      assert.match(sol, /function sweep\(address token\) external only/, `${name} keeps sweep available`);
    }
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
    // THE GUARD, NOT ITS OLD ONE-LINER. It used to be a bare `continue`, which
    // also meant a position whose curve would not yield a floor was dropped in
    // silence every tick, forever — indistinguishable from one that had simply
    // not aged. It now warns the owner before continuing, so the assertion is
    // on the refusal rather than on the statement that used to express it.
    assert.match(EXIT, /if \(floor === null \|\| floor <= 0n\) \{/, "a sell with no floor must be refused");
    assert.match(
      EXIT,
      /if \(floor === null \|\| floor <= 0n\) \{[\s\S]{0,400}?continue;/,
      "and refusing must mean not selling",
    );
    assert.ok(!/maxImpactBps/.test(EXIT), "and no impact ceiling that could trap it");
  });
});
