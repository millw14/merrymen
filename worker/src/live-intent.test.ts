/**
 * FUNDING IS NOT CONSENT.
 *
 * A beta owner created an agent, chose "Paper trading · recommended" in the
 * wizard, and said so in as many words: "I know that I haven't given my
 * permission to execute real trades... When I decide to go mainnet, I will have
 * to give permissions and fund the agent."
 *
 * The product disagreed with him. `canTradeForReal` asked seven questions —
 * armed, executor, chain, cash, gas, policy, wall — and not one of them was
 * "did the owner ask for this". `paperTradingEnabled` was consulted only AFTER
 * that predicate had already answered, and `exec-mode.ts` says why in its own
 * words: "paper is PERMISSION TO SIMULATE, not a request to, and it never moves
 * a working agent". So paper was reachable only as a FALLBACK from a broken
 * rail, and the moment the rail healed the agent went live.
 *
 * MEASURED, by executing the real functions against his real inputs before this
 * change (gasSponsored true — MERRYMEN_SPONSOR_GAS and a bundler key are both
 * set on the orchestrator — and paperTradingEnabled true):
 *
 *     mainnet + owner wants paper + funded 500 USDG  ->  {"mode":"live"}
 *
 * That is the defect. Funding, or a chain move, silently promoted an owner from
 * PAPER to LIVE with no action by them and nothing on screen to say so.
 *
 * THE FIX IS A FOURTH THING, kept separate from the other three on purpose:
 *
 *     network selection   which chain the grant is for
 *     funding             whether there is money
 *     paperTradingEnabled permission to SIMULATE when real execution is off
 *     liveTradingEnabled  permission to EXECUTE REAL ORDERS   <- new, required
 *
 * `liveTradingEnabled` is a required TERM of `canTradeForReal`, not a fallback
 * consulted afterwards, because a term is the only shape that cannot be routed
 * around by the world changing underneath it.
 *
 * WHY THE TWO BOOLEANS ARE NOT REDUNDANT, and why this is not `!paper`: they
 * answer different questions. `liveTradingEnabled` asks "may real money move".
 * `paperTradingEnabled` asks "when it may not, should I simulate instead".
 * Collapsing them would mean an owner who turns off simulation has thereby
 * asked to trade for real, which is the same class of implicit promotion this
 * file exists to forbid.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { canTradeForReal, execModeOf, type ExecInputs } from "./exec-mode";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MAINNET = 4663;
const TESTNET = 46630;

/**
 * A healthy rail. Every safety condition satisfied, so the ONLY variable in the
 * cases below is the owner's intent — which is the whole point: if intent were
 * merely one more way to be broken, a test could pass by breaking something
 * else.
 *
 * `gasSponsored: true` mirrors production. It matters more than it looks: with
 * sponsorship on, a zero ETH balance stops being a blocker, so nothing in the
 * gas leg was left to accidentally hold a paper owner back.
 */
const healthy: ExecInputs = {
  armed: true,
  executor: true,
  chainId: MAINNET,
  cashUsdg: 500_000_000n, // 500 USDG, funded
  gasWei: 0n,
  gasSponsored: true,
  deadPolicy: false,
  wallTooWide: false,
  paperTradingEnabled: true,
  liveTradingEnabled: false,
};

describe("funding a paper agent does not transition it to live", () => {
  it("MAINNET + PAPER + FUNDED is simulation only", () => {
    // The exact case that executed as {"mode":"live"} before this change.
    const a = { ...healthy, liveTradingEnabled: false };
    assert.equal(canTradeForReal(a), false, "an owner who never asked for live must not get it");
    assert.equal(execModeOf(a).mode, "paper");
  });

  it("and ARRIVING money changes nothing — the promotion path is closed", () => {
    // Same agent, before and after a deposit. This is the transition the owner
    // reported as the thing he expected to control, so it is asserted as a
    // transition and not as two unrelated states.
    const unfunded = { ...healthy, liveTradingEnabled: false, cashUsdg: 0n };
    const funded = { ...unfunded, cashUsdg: 10_000_000_000n };
    assert.equal(execModeOf(unfunded).mode, "paper");
    assert.equal(execModeOf(funded).mode, "paper", "a deposit is not a signature");
  });

  it("MAINNET + PAPER + SPONSORED GAS is simulation only", () => {
    // Sponsorship is the term that made this urgent: it removes the no-gas leg
    // for the whole fleet at once, so before this change the house turning
    // sponsorship on was itself enough to move owners onto the live rail.
    const a = { ...healthy, liveTradingEnabled: false, gasWei: 0n, gasSponsored: true };
    assert.equal(canTradeForReal(a), false);
    assert.equal(execModeOf(a).mode, "paper");
  });

  it("MAINNET + PAPER + UNFUNDED is simulation only", () => {
    const a = { ...healthy, liveTradingEnabled: false, cashUsdg: 0n };
    assert.equal(execModeOf(a).mode, "paper");
  });

  it("and a never-read balance is not a loophole", () => {
    // NULL IS NOT ZERO is the rule everywhere else in this codebase, and it is
    // exactly how the reported agent slipped through: `readAsBroke` is false for
    // an unread balance, so on the paper rail — which never reads balances —
    // cash stayed null forever and could never block anything. Intent has to
    // hold on its own, without help from a number nobody has looked at.
    const a = { ...healthy, liveTradingEnabled: false, cashUsdg: null };
    assert.equal(canTradeForReal(a), false);
    assert.equal(execModeOf(a).mode, "paper");
  });
});

describe("explicit live intent is what turns real execution on", () => {
  it("MAINNET + LIVE + FUNDED trades for real", () => {
    // The other half. A consent gate that never opens is not a gate, it is an
    // outage, and this is the assertion that would catch one.
    const a = { ...healthy, liveTradingEnabled: true };
    assert.equal(canTradeForReal(a), true);
    assert.equal(execModeOf(a).mode, "live");
  });

  it("but it does not override any safety condition — LIVE + TESTNET is never live", () => {
    // Intent is ADDED to the safety conditions, never substituted for them.
    // A grant sealed for 46630 cannot reach a mainnet router whatever the owner
    // has ticked, so consent must not be able to talk the rail into trying.
    const a = { ...healthy, liveTradingEnabled: true, chainId: TESTNET };
    assert.equal(canTradeForReal(a), false, "testnet is never real trading");
    assert.notEqual(execModeOf(a).mode, "live");
  });

  it("nor over an empty account, a dead policy, or a wall that cannot install", () => {
    for (const [name, broken] of [
      ["read-as-broke", { cashUsdg: 0n }],
      ["dead policy", { deadPolicy: true }],
      ["wall too wide", { wallTooWide: true }],
      ["not armed", { armed: false }],
      ["no executor", { executor: false }],
    ] as const) {
      const a = { ...healthy, liveTradingEnabled: true, ...broken };
      assert.equal(canTradeForReal(a), false, `${name} must still block the live rail`);
    }
  });

  it("and an unsponsored account with no ETH still cannot trade, consent or not", () => {
    const a = { ...healthy, liveTradingEnabled: true, gasSponsored: false, gasWei: 0n };
    assert.equal(canTradeForReal(a), false);
  });
});

describe("the owner's two switches stay independent", () => {
  it("turning OFF simulation does not turn ON real trading", () => {
    // The collapse this guards against: `liveTradingEnabled = !paperTradingEnabled`
    // would make "stop showing me pretend fills" mean "start spending my money".
    const a = { ...healthy, paperTradingEnabled: false, liveTradingEnabled: false };
    assert.equal(canTradeForReal(a), false, "no simulation is not a request to trade for real");
    assert.equal(execModeOf(a).mode, "refuse", "it does nothing at all, and says so");
  });

  it("a live owner who also allows simulation still trades for real", () => {
    // paperTradingEnabled keeps its old meaning — a FALLBACK — so leaving it on
    // must not hold back an owner who has asked for live.
    const a = { ...healthy, paperTradingEnabled: true, liveTradingEnabled: true };
    assert.equal(execModeOf(a).mode, "live");
  });

  it("and a live owner whose rail breaks falls back to simulation, as before", () => {
    const a = { ...healthy, liveTradingEnabled: true, chainId: TESTNET, paperTradingEnabled: true };
    assert.equal(execModeOf(a).mode, "paper", "the fallback is unchanged for those who opted in");
  });
});

describe("the whole matrix, as the owner specified it", () => {
  /** network × intent × funding -> what may happen. The spec, executed. */
  const MATRIX: readonly {
    chainId: number;
    live: boolean;
    funded: boolean;
    expect: "live" | "paper";
  }[] = [
    { chainId: MAINNET, live: false, funded: true, expect: "paper" },
    { chainId: MAINNET, live: true, funded: true, expect: "live" },
    { chainId: MAINNET, live: false, funded: false, expect: "paper" },
    { chainId: TESTNET, live: false, funded: true, expect: "paper" },
    { chainId: TESTNET, live: true, funded: true, expect: "paper" },
    { chainId: TESTNET, live: true, funded: false, expect: "paper" },
  ];

  for (const row of MATRIX) {
    const net = row.chainId === MAINNET ? "mainnet" : "testnet";
    it(`${net} + ${row.live ? "LIVE" : "PAPER"} + ${row.funded ? "funded" : "unfunded"} -> ${row.expect}`, () => {
      const a: ExecInputs = {
        ...healthy,
        chainId: row.chainId,
        liveTradingEnabled: row.live,
        cashUsdg: row.funded ? 500_000_000n : 0n,
      };
      assert.equal(execModeOf(a).mode, row.expect);
    });
  }

  it("and real execution requires mainnet AND explicit intent, both", () => {
    // Stated once more as a property rather than a table, so a future edit that
    // satisfies every row above by coincidence still fails here.
    for (const chainId of [MAINNET, TESTNET]) {
      for (const live of [true, false]) {
        const a: ExecInputs = { ...healthy, chainId, liveTradingEnabled: live };
        assert.equal(
          canTradeForReal(a),
          chainId === MAINNET && live,
          `chain ${chainId}, live ${live}`,
        );
      }
    }
  });
});

/**
 * WHAT WOULD STILL BE IN THE WAY, said BEFORE the switch is flipped.
 *
 * Consent and capability are different questions, and separating them created a
 * new way to surprise somebody: an owner practising on a testnet grant is no
 * longer told anything is wrong — correctly, because nothing is — and would
 * learn the truth by turning Live on and landing in a red BLOCKED banner. That
 * is the same "the remedy did not work" experience this change exists to end,
 * moved one step later.
 *
 * So the paper verdict carries the rail's health alongside the owner's choice.
 */
describe("a paper verdict still knows what would block live", () => {
  it("carries the rail's blocker without presenting it as today's problem", () => {
    const a: ExecInputs = { ...healthy, liveTradingEnabled: false, chainId: TESTNET };
    const m = execModeOf(a);
    assert.equal(m.mode, "paper");
    assert.equal(m.mode === "paper" ? m.rule : null, "live-not-enabled", "the CHOICE is the headline");
    assert.equal(
      m.mode === "paper" ? m.wouldBlockLive : null,
      "wrong-chain",
      "and the rail's fault is carried, not hidden",
    );
  });

  it("and reports null when the rail is sound — no invented problem", () => {
    const m = execModeOf({ ...healthy, liveTradingEnabled: false });
    assert.equal(m.mode === "paper" ? m.wouldBlockLive : "unset", null);
  });

  it("measured with consent forced ON, so it is never circular", () => {
    // Asked naively, "what blocks live?" for a paper owner answers
    // "live-not-enabled" — true and useless. It has to be asked as "if they said
    // yes, what then?", which is a question about machinery alone.
    const m = execModeOf({ ...healthy, liveTradingEnabled: false, cashUsdg: 0n });
    assert.notEqual(m.mode === "paper" ? m.wouldBlockLive : null, "live-not-enabled");
    assert.equal(m.mode === "paper" ? m.wouldBlockLive : null, "no-cash");
  });

  it("an owner who HAS consented gets the blocker as the headline, not as a footnote", () => {
    const m = execModeOf({ ...healthy, liveTradingEnabled: true, chainId: TESTNET });
    assert.equal(m.mode === "paper" ? m.rule : null, "wrong-chain");
  });
});

/**
 * THE TWO THINGS AN ADVERSARIAL REVIEW FOUND, both consequences of making Paper
 * a mode an owner can deliberately sit in rather than a fallback from a broken
 * rail. Neither existed before that was possible.
 */
describe("the broker lane crosses the fork too", () => {
  it("A LIVE ORDER EXECUTOR IS USED ONLY ON THE LIVE RAIL", () => {
    // `intent.kind === "equity-order"` is handled and RETURNS before the swap
    // fork consults execMode(), so `place()` was reachable without anyone having
    // asked whether real execution was wanted. Harmless today — `orderExecutor`
    // is hardwired null and every order paper-fills — which is exactly what made
    // it invisible: the first live OrderExecutor would have landed on the wrong
    // side of the consent gate with nothing failing to say so.
    const src = readFileSync(path.join(__dirname, "index.ts"), "utf8");
    assert.match(
      src,
      /\(execMode\(\)\.mode === "live" \? active\.orderExecutor : null\) \?\?/,
      "the broker lane must ask the fork before using a live executor",
    );
  });
});

describe("switching INTO paper cannot be taken silently", () => {
  /**
   * On the paper rail the tick values the PAPER BOOK — positions come from
   * `paperPositionsOf(bookRow.shares)` and nothing reads the chain — so a
   * position bought with real funds becomes invisible to the agent: no
   * stop-loss, no take-profit, no exit, and a tidy simulated book rendered over
   * the top of it.
   *
   * That was unreachable while paper was only a fallback from a broken rail,
   * because a broken rail could not have exited either. Making Paper a choice
   * made it reachable, so the choice has to say what it costs.
   */
  it("the chat command says what it STOPS doing, not just what it starts", () => {
    const commands = readFileSync(
      path.join(__dirname, "..", "..", "web", "src", "lib", "chat-commands.ts"),
      "utf8",
    );
    const goPaper = commands.slice(commands.indexOf('id: "go-paper"'), commands.indexOf('id: "go-live"'));
    assert.match(goPaper, /stop managing it/i, "unmanaged real positions must be named");
    assert.match(goPaper, /stop-loss/i);
    assert.match(goPaper, /Nothing is sold/i, "and the owner told their tokens are not touched");
  });

  it("and so does the settings control", () => {
    const settings = readFileSync(
      path.join(__dirname, "..", "..", "web", "src", "terminal", "screens", "Settings.tsx"),
      "utf8",
    );
    // Rendered only on the way OUT of live — an owner who was never live has no
    // real position to strand, and a warning they cannot act on is noise.
    assert.match(settings, /!liveTradingVal && \(view\.values\.liveTradingEnabled/);
    assert.match(settings, /stops managing them/i);
  });
});

/**
 * THE MIGRATION WINDOW, which my own runbook got wrong.
 *
 * It said "deploy with =report first", on the reasoning that a report writes
 * nothing and is therefore safe. But the report deploy carries the ENFORCEMENT
 * too, and `reconcile()` spawns children before the backfill runs — so a
 * report-only run would drop every live agent to paper for as long as it took a
 * human to read the log and redeploy. Worse than idle: a live agent on the paper
 * rail loses its stop-loss and take-profit, because holdings there come from the
 * paper book.
 *
 * So the gate stands down for exactly as long as the migration is unfinished,
 * and the two are driven by the SAME variable so they cannot disagree about
 * whether it has run.
 *
 * THIS IS NOT AN ESCAPE HATCH FOR CONSENT. It grants nothing new — it restores
 * the behaviour that shipped for months, for one release, and step three of the
 * rollout removes the variable that enables it.
 */
describe("the consent gate stands down while its migration is still running", () => {
  it("DEFERRED: the rail behaves exactly as it did before the gate existed", () => {
    const a: ExecInputs = { ...healthy, liveTradingEnabled: false, enforceLiveIntent: false };
    assert.equal(canTradeForReal(a), true, "a funded mainnet agent keeps trading");
    assert.equal(execModeOf(a).mode, "live");
  });

  it("and it does not invent a blocker for an agent it is not gating", () => {
    // `liveBlocker` must not name `live-not-enabled` while the gate is stood
    // down, or every agent in the fleet would carry a reason that is not true.
    const a: ExecInputs = { ...healthy, liveTradingEnabled: false, enforceLiveIntent: false, chainId: TESTNET };
    const m = execModeOf(a);
    assert.equal(m.mode === "paper" ? m.rule : null, "wrong-chain");
  });

  it("ENFORCED BY DEFAULT — an absent flag is not a stood-down gate", () => {
    // The dangerous direction. If omitting the field disabled the gate, every
    // caller that forgot it would silently trade real money without consent.
    const { enforceLiveIntent: _omitted, ...withoutIt } = {
      ...healthy,
      liveTradingEnabled: false,
      enforceLiveIntent: true,
    };
    assert.equal(canTradeForReal(withoutIt as ExecInputs), false, "absent must mean enforced");
  });

  it("and enforced whenever it is true", () => {
    const a: ExecInputs = { ...healthy, liveTradingEnabled: false, enforceLiveIntent: true };
    assert.equal(canTradeForReal(a), false);
  });

  it("A DRY RUN MUST NOT CHANGE BEHAVIOUR — the report cannot un-gate the fleet", () => {
    /**
     * This used to assert the OPPOSITE, and was right at the time: standing
     * down was tied to `MERRYMEN_BACKFILL_LIVE_INTENT=report` so the two could
     * not disagree about whether the migration had run.
     *
     * That reasoning expired the moment the migration ran. With consent now
     * recorded for the fleet, re-running the report to check a detail would
     * have switched enforcement off for every tenant for the length of a
     * read-only question — reopening "funding implies consent" as a side effect
     * of asking. The coupling that once prevented an outage had become the way
     * to cause one.
     *
     * Comments are stripped before matching because the replacement comment in
     * settings.ts QUOTES the retired expression to explain why it went.
     */
    const raw = readFileSync(path.join(__dirname, "settings.ts"), "utf8");
    const settings = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

    // The RESOLUTION, not the interface declaration a few lines above it —
    // `enforceLiveIntent: boolean;` matches a naive search first and would make
    // every assertion below vacuous.
    const line = [...settings.matchAll(/enforceLiveIntent:[^\n]*/g)]
      .map((m) => m[0])
      .find((l) => !/:\s*boolean;/.test(l));
    assert.ok(line, "enforceLiveIntent must still be resolved in settings.ts");
    assert.doesNotMatch(
      line,
      /MERRYMEN_BACKFILL_LIVE_INTENT/,
      "asking the migration to report must not decide whether the gate is enforced",
    );
    assert.match(line, /env\.MERRYMEN_LIVE_INTENT_STAND_DOWN/);
  });

  it("and consent itself still has no env override", () => {
    // The stand-down restores PREVIOUS behaviour for one migration. Setting the
    // owner's answer from a shell would be the house consenting on their
    // behalf, which is the defect this whole gate exists to remove.
    const raw = readFileSync(path.join(__dirname, "settings.ts"), "utf8");
    const settings = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const line = settings.match(/liveTradingEnabled: bool\([^\n]*/);
    assert.ok(line, "liveTradingEnabled must still be resolved from the tenant's own file");
    assert.doesNotMatch(line[0], /env\./, "no environment variable may set an owner's consent");
  });

  it("and the backfill runs BEFORE children are spawned", () => {
    // The ordering that makes the apply step windowless. After `reconcile()`
    // the first cohort starts with the flag still absent.
    const orch = readFileSync(path.join(__dirname, "orchestrator.ts"), "utf8");
    const backfillAt = orch.indexOf("await runLiveIntentBackfillIfAsked();");
    const reconcileAt = orch.indexOf("await reconcile();", backfillAt - 2000);
    assert.ok(backfillAt > 0 && reconcileAt > backfillAt, "the grants must land first");
  });
});
