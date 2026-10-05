/**
 * THE EXEC BACKOFF — what is held, for how long, and what is never held.
 *
 * The holds themselves are pure and run here against a fake clock. The wiring
 * in main() cannot be booted by a test, so the half that could go wrong there
 * — an exit sent through the skip, a hold noted after the install that should
 * have cleared it, an owner's order dropped without a reply — is pinned over
 * index.ts with comments stripped, the way energy-wiring.test.ts pins energy.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  BACKOFF_SCHEDULE_MIN,
  ExecBackoff,
  KEY_INSTALL_HOLD_MS,
  backsOff,
  heldReply,
  holdMsFor,
  retryAfterMin,
  type BackoffLimits,
} from "./exec-backoff";
import { GasRefused, UserOpReverted, type AgentExecutor } from "./executor";
import { installKeyRecorded } from "./key-install-accounting";
import { SponsorRefused } from "./paymaster";
import type { TradeIntent } from "./policy";

const USDG = "0x00000000000000000000000000000000000000c0" as const;
const STOCK = "0x00000000000000000000000000000000000000a1" as const;
/** An owner-added stock token a LEGACY grant does not count among its built-ins. */
const EXTRA_STOCK = "0x00000000000000000000000000000000000000a2" as const;
const COIN = "0x00000000000000000000000000000000000000b1" as const;
const OTHER_COIN = "0x00000000000000000000000000000000000000b2" as const;
const ROUTER = "0x00000000000000000000000000000000000000d1" as const;
const ADAPTER = "0x00000000000000000000000000000000000000d2" as const;
const VAULT = "0x00000000000000000000000000000000000000E1" as const;
const CURVE = "0x00000000000000000000000000000000000000f1" as const;

const LIMITS: BackoffLimits = { cashToken: USDG, quoteAssets: [USDG, STOCK], ponsClassVault: VAULT };
const MIN = 60_000;
const T0 = 1_760_000_000_000;

const buy = (token: `0x${string}` = COIN): TradeIntent => ({
  kind: "swap", target: ROUTER, sellToken: USDG, buyToken: token, sellAmountRaw: 5_000_000n, notionalUsdg: 5_000_000n,
});
const sell = (token: `0x${string}` = COIN): TradeIntent => ({
  kind: "swap", target: ROUTER, sellToken: token, buyToken: USDG, sellAmountRaw: 10n ** 18n, notionalUsdg: 5_000_000n,
});
const curve = (assetIn: `0x${string}`, assetOut: `0x${string}`, target: `0x${string}` = VAULT): TradeIntent => ({
  kind: "curve-trade", target, curve: CURVE, assetIn, assetOut, amountInRaw: 1n, minAmountOutRaw: 1n, notionalUsdg: 5_000_000n,
});

/** A backoff whose `[backoff]` lines are kept rather than printed. */
function backoff() {
  const lines: string[] = [];
  return { b: new ExecBackoff((l) => lines.push(l)), lines };
}

describe("THE SCHEDULE", () => {
  it("lengthens with each refusal of the same key, and stops at the last step", () => {
    assert.deepEqual([...BACKOFF_SCHEDULE_MIN], [5, 15, 30, 60]);
    const got = [1, 2, 3, 4, 5, 9].map((s) => holdMsFor("gas-absurd", s)! / MIN);
    assert.deepEqual(got, [5, 15, 30, 60, 60, 60]);
  });

  it("holds `enable-too-wide` exactly as long as the key install waits to retry, at every strike", () => {
    assert.equal(KEY_INSTALL_HOLD_MS, 30 * MIN);
    for (const s of [1, 2, 7]) assert.equal(holdMsFor("enable-too-wide", s), KEY_INSTALL_HOLD_MS);
  });

  it("does NOT hold a refusal that says we could not read something, or raced our own landing", () => {
    for (const rule of ["nonce-changed", "enable-unverified", "prefund-unverified", "sponsor-unreachable"]) {
      assert.equal(holdMsFor(rule, 1), null, rule);
    }
    // The sponsor saying no is not the sponsor being unreachable.
    for (const rule of ["sponsor-refused", "sponsor-absurd", "gas-unreadable", "prefund-short"]) {
      assert.equal(holdMsFor(rule, 1), 5 * MIN, rule);
    }
  });

  it("a hold ends when its time does, and a refusal after it counts as the next strike", () => {
    const { b, lines } = backoff();
    const first = b.note(buy(), LIMITS, "gas-absurd", T0)!;
    assert.equal(first.untilMs, T0 + 5 * MIN);
    assert.ok(b.held(buy(), LIMITS, T0 + 5 * MIN - 1), "held until the last millisecond");
    assert.equal(b.held(buy(), LIMITS, T0 + 5 * MIN), null, "and not one after");
    const second = b.note(buy(), LIMITS, "gas-absurd", T0 + 6 * MIN)!;
    assert.equal(second.strikes, 2);
    assert.equal(second.untilMs, T0 + 21 * MIN);
    assert.equal(lines.length, 2, "one [backoff] line per change");
    assert.match(lines[1]!, /^\[backoff\] holding swap:0x0+c0->0x0+b1 for 15m after gas-absurd \(refusal 2 this arm\)$/);
  });

  it("is per token pair: one coin's refusal holds nothing else", () => {
    const { b } = backoff();
    b.note(buy(COIN), LIMITS, "gas-absurd", T0);
    assert.equal(b.held(buy(OTHER_COIN), LIMITS, T0 + MIN), null);
  });
});

describe("AN EXIT IS NEVER BLOCKED", () => {
  // Every shape of the way out, including the one the breaker's own test gets
  // wrong: a curve sale into an owner-added stock token on a legacy grant,
  // which isExitIntent reads as an entry (energy.ts sellsHeldLeg).
  const exits: [string, TradeIntent][] = [
    ["a swap into cash", sell()],
    ["a curve sale into cash", curve(COIN, USDG)],
    ["a curve sale into a built-in quote", curve(COIN, STOCK)],
    ["a curve sale into an extra quote on a legacy grant", curve(COIN, EXTRA_STOCK)],
    ["a transfer home", { kind: "transfer", target: USDG, recipient: ROUTER, amountUsdg: 1n }],
    ["a vault withdrawal", { kind: "vault-withdraw", target: ROUTER, amountUsdg: 1n }],
  ];

  for (const [name, intent] of exits) {
    it(`${name}: never held, and never starts a hold`, () => {
      const { b, lines } = backoff();
      assert.equal(backsOff(intent, LIMITS), false);
      assert.equal(b.note(intent, LIMITS, "gas-absurd", T0), null);
      assert.deepEqual(lines, []);
      // Every hold that could conceivably match it is in force: the reverse
      // pair, the vault route, and the coin's own buy.
      b.note(buy(COIN), LIMITS, "gas-absurd", T0);
      b.note(curve(USDG, COIN), LIMITS, "gas-absurd", T0);
      b.note(curve(STOCK, OTHER_COIN), LIMITS, "enable-too-wide", T0);
      assert.equal(b.held(intent, LIMITS, T0 + MIN), null);
    });
  }

  it("and the buys beside them are", () => {
    assert.equal(backsOff(buy(), LIMITS), true);
    assert.equal(backsOff(curve(USDG, COIN), LIMITS), true);
    assert.equal(backsOff(curve(STOCK, COIN), LIMITS), true);
    // A buy this misses is merely not held — today's behaviour.
    assert.equal(backsOff(curve(EXTRA_STOCK, COIN), LIMITS), false);
    assert.equal(backsOff({ kind: "vault-deposit", target: ROUTER, amountUsdg: 1n }, LIMITS), false);
    assert.equal(
      backsOff({ kind: "energy-buy", target: ROUTER, sellToken: USDG, buyToken: COIN, sellAmountRaw: 1n, notionalUsdg: 1n }, LIMITS),
      false,
      "the owner's energy buy is its own route",
    );
  });
});

describe("AN OWNER ORDER GETS AN EXPLICIT REPLY", () => {
  it("names the rule and when asking again can help", () => {
    const line = heldReply({ rule: "gas-absurd", untilMs: T0 + 5 * MIN }, T0);
    assert.match(line, /not sent: gas-absurd, retry after 5m/);
    assert.match(line, /network fee estimate was far above/, "with the vocabulary's sentence beside the slug");
    assert.match(line, /Nothing was signed and nothing was spent\./);
  });

  it("and what the owner can do about it, where there is something", () => {
    const line = heldReply({ rule: "prefund-short", untilMs: T0 + 15 * MIN }, T0);
    assert.match(line, /^⏳ not sent: prefund-short, retry after 15m — .+\. Send a little ETH/);
  });

  it("rounds up, and never says 0m", () => {
    assert.equal(retryAfterMin({ untilMs: T0 + 4 * MIN + 1 }, T0), 5);
    assert.equal(retryAfterMin({ untilMs: T0 + 1 }, T0), 1);
    assert.equal(retryAfterMin({ untilMs: T0 }, T0), 1);
  });

  it("a rule the vocabulary does not know is still named", () => {
    assert.equal(
      heldReply({ rule: "sponsor-refused", untilMs: T0 + 15 * MIN }, T0),
      "⏳ not sent: sponsor-refused, retry after 15m. Nothing was signed and nothing was spent.",
    );
  });
});

describe("A VAULT ROUTE-WIDE KEY", () => {
  it("`gas-absurd` on the sealed vault holds every class entry, not just its coin", () => {
    const { b, lines } = backoff();
    const h = b.note(curve(USDG, COIN), LIMITS, "gas-absurd", T0)!;
    assert.equal(h.key, `curve-trade@${VAULT.toLowerCase()}`);
    assert.equal(b.held(curve(USDG, OTHER_COIN), LIMITS, T0 + MIN)?.rule, "gas-absurd");
    assert.equal(b.held(curve(STOCK, OTHER_COIN), LIMITS, T0 + MIN)?.rule, "gas-absurd");
    assert.match(lines[0]!, /holding curve-trade@0x0+e1 for 5m after gas-absurd/);
  });

  it("is the vault's alone: the adapter route keeps its per-coin key", () => {
    const { b } = backoff();
    const h = b.note(curve(USDG, COIN, ADAPTER), LIMITS, "gas-absurd", T0)!;
    assert.equal(h.key, `curve-trade:${USDG}->${COIN}`);
    assert.equal(b.held(curve(USDG, OTHER_COIN, ADAPTER), LIMITS, T0 + MIN), null);
    assert.equal(b.held(curve(USDG, OTHER_COIN), LIMITS, T0 + MIN), null, "nor does it reach the vault");
  });

  it("and only `gas-absurd` writes it: any other refusal on the vault is about its coin", () => {
    const { b } = backoff();
    b.note(curve(USDG, COIN), LIMITS, "gas-unreadable", T0);
    assert.equal(b.held(curve(USDG, OTHER_COIN), LIMITS, T0 + MIN), null);
    assert.equal(b.held(curve(USDG, COIN), LIMITS, T0 + MIN)?.rule, "gas-unreadable");
  });

  it("a coin held on both keys answers with the hold that ends last", () => {
    const { b } = backoff();
    b.note(curve(USDG, COIN), LIMITS, "enable-too-wide", T0); // pair, 30m
    b.note(curve(USDG, OTHER_COIN), LIMITS, "gas-absurd", T0); // route, 5m
    assert.equal(b.held(curve(USDG, COIN), LIMITS, T0 + MIN)?.untilMs, T0 + 30 * MIN);
  });

  it("with no vault sealed there is no route to hold", () => {
    const { b } = backoff();
    const { ponsClassVault: _, ...noVault } = LIMITS;
    assert.equal(b.note(curve(USDG, COIN), noVault, "gas-absurd", T0)!.key, `curve-trade:${USDG}->${COIN}`);
  });
});

describe("CLEAR ON INSTALL SUCCESS", () => {
  it("drops every `enable-too-wide` hold, and only those", () => {
    const { b, lines } = backoff();
    b.note(buy(COIN), LIMITS, "enable-too-wide", T0);
    b.note(curve(USDG, OTHER_COIN), LIMITS, "enable-too-wide", T0);
    b.note(buy(OTHER_COIN), LIMITS, "gas-absurd", T0);
    assert.equal(b.clearRule("enable-too-wide", "key installed"), 2);
    assert.equal(b.held(buy(COIN), LIMITS, T0 + MIN), null);
    assert.equal(b.held(curve(USDG, OTHER_COIN), LIMITS, T0 + MIN), null);
    assert.equal(b.held(buy(OTHER_COIN), LIMITS, T0 + MIN)?.rule, "gas-absurd");
    assert.equal(lines.at(-1), "[backoff] cleared 2 enable-too-wide holds: key installed");
    // Its strikes went with it: a fresh refusal is the first again.
    assert.equal(b.note(buy(COIN), LIMITS, "gas-absurd", T0 + MIN)!.strikes, 1);
  });

  it("says nothing when there was nothing to clear", () => {
    const { b, lines } = backoff();
    assert.equal(b.clearRule("enable-too-wide", "key installed"), 0);
    assert.deepEqual(lines, []);
  });

  /** An executor whose install does one thing, and a ledger that accepts every row. */
  function install(outcome: "landed" | "refused" | "sponsor" | "reverted") {
    const executor: AgentExecutor = {
      address: USDG,
      execute: async () => { throw new Error("a trade may never be substituted for an install"); },
      installKey: async (hooks) => {
        if (outcome === "refused") throw new GasRefused("gas-absurd", "wall alone is too wide");
        if (outcome === "sponsor") throw new SponsorRefused("sponsor-refused", "declined");
        await hooks!.onSubmitted!(`0x${"1".repeat(64)}`, { nonce: 0n });
        if (outcome === "reverted") {
          throw new UserOpReverted(`0x${"1".repeat(64)}`, "execution reverted", {
            txHash: `0x${"2".repeat(64)}`, gasWei: 1n, gasUnits: 1n, gasPayer: "owner",
          });
        }
        return { txHash: `0x${"2".repeat(64)}`, userOpHash: `0x${"1".repeat(64)}`, logs: [], blockNumber: 1n, gasWei: 1n, gasUnits: 1n, gasPayer: "owner" };
      },
    };
    const deps = { addTrade: async () => true, refreshBudget: async () => {}, event: async () => {}, resolveMinutes: 5 };
    return { executor, deps };
  }

  async function logged(run: () => Promise<boolean>): Promise<{ landed: boolean; lines: string[] }> {
    const lines: string[] = [];
    const real = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
    try {
      return { landed: await run(), lines: lines.filter((l) => l.startsWith("[key-install]")) };
    } finally {
      console.log = real;
    }
  }

  it("installKeyRecorded answers true only for an install that landed, with one [key-install] line per attempt", async () => {
    const cases = [
      ["landed", true, /^\[key-install\] agent-x landed 0x2{64}$/],
      ["refused", false, /^\[key-install\] agent-x refused before signing \(gas-absurd\)$/],
      ["sponsor", false, /^\[key-install\] agent-x not sent \(sponsor-refused\)$/],
      ["reverted", false, /^\[key-install\] agent-x reverted on-chain 0x1{64}$/],
    ] as const;
    for (const [outcome, landed, line] of cases) {
      const { executor, deps } = install(outcome);
      const got = await logged(() => installKeyRecorded(deps, "agent-x", executor));
      assert.equal(got.landed, landed, outcome);
      assert.equal(got.lines.length, 1, `${outcome}: exactly one line`);
      assert.match(got.lines[0]!, line);
    }
  });
});

describe("CLEAR ON ARM", () => {
  it("drops every hold, whatever its rule, and says how many", () => {
    const { b, lines } = backoff();
    b.note(buy(COIN), LIMITS, "gas-absurd", T0);
    b.note(curve(USDG, OTHER_COIN), LIMITS, "gas-absurd", T0);
    b.note(buy(OTHER_COIN), LIMITS, "enable-too-wide", T0);
    assert.equal(b.clear("armed"), 3);
    for (const i of [buy(COIN), curve(USDG, COIN), buy(OTHER_COIN)]) assert.equal(b.held(i, LIMITS, T0 + MIN), null);
    assert.equal(lines.at(-1), "[backoff] cleared 3 holds: armed");
    assert.equal(b.clear("armed"), 0);
    assert.equal(lines.length, 4, "an empty clear is not a change");
  });
});

/**
 * THE WIRING, pinned over index.ts with comments stripped — prose about a
 * hold is not a hold. main() cannot be booted by a test; each of these is a
 * mistake every pure test above would pass.
 */
const codeOf = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
const CODE = codeOf(readFileSync(new URL("./index.ts", import.meta.url), "utf8"));
const SKIP = "if (entry && !intent.decisionId && liveHold(intent)) continue;";

/** A function declared in main() — two-space indent — up to its closing brace. */
function body(name: string): string {
  const at = CODE.search(new RegExp(`\\n  (async )?function ${name}\\(`));
  assert.ok(at > 0, `${name} must exist for this pin to mean anything`);
  return CODE.slice(at, CODE.indexOf("\n  }\n", at));
}

describe("WHERE THE WORKER ASKS", () => {
  it("ONLY ON THE LIVE RAIL: paper and a refused rail meet their own answer, not a stale gas rule", () => {
    assert.match(
      CODE,
      /const liveHold = \(intent: TradeIntent\): Hold \| null =>\s*active && execMode\(\)\.mode === "live" \? execBackoff\.held\(intent, active\.limits, Date\.now\(\)\) : null;/,
    );
    // And nobody asks the backoff any other way.
    assert.equal((CODE.match(/execBackoff\.held\(/g) ?? []).length, 1);
  });

  it("THE STRATEGY LOOP skips a held entry with no decision before anything is claimed or decided", () => {
    const at = CODE.indexOf("for (const [proposedAt, intent] of proposed.entries()) {");
    const loop = CODE.slice(at, CODE.indexOf("\n    }\n", at));
    const entry = loop.indexOf("const entry = countsAsEntry(");
    const skip = loop.indexOf(SKIP);
    assert.ok(entry > 0 && skip > entry, "asked of the entry test's answer, never of an exit");
    assert.ok(skip < loop.indexOf("tgClaimGroupEntry(intent)"), "before the group claim");
    assert.ok(skip < loop.indexOf("await claimEntry()"), "before the energy claim");
    assert.ok(skip < loop.indexOf("await ensureDecision("), "before any decision row");
  });

  it("THE CLASS ENTRIES the same, and THE CLASS EXITS never ask", () => {
    const at = CODE.indexOf("const entries: Tick = await classGate.entries(async () => await proposeClassEntries());");
    const loop = CODE.slice(at, CODE.indexOf("\n    }\n", at));
    const skip = loop.indexOf(SKIP);
    assert.ok(skip > loop.indexOf("const entry = countsAsEntry("));
    assert.ok(skip < loop.indexOf("await claimEntry()") && skip < loop.indexOf("await ensureDecision("));
    const exits = CODE.slice(CODE.indexOf("const exits = await proposeClassExits();"), at);
    assert.doesNotMatch(exits, /execBackoff/);
  });

  it("processIntentLocked books a held intent `rejected` under the held rule — never a silent return", () => {
    const fn = body("processIntentLocked");
    const suppressed = fn.indexOf("if (suppressed && verdict.ok) {");
    const asked = fn.indexOf("const backedOff = liveHold(intent);");
    assert.ok(suppressed > 0 && asked > suppressed, "read beside suppressedIntents, after checkPolicy");
    const branch = fn.slice(asked, fn.indexOf("return;", asked));
    assert.match(branch, /if \(backedOff && verdict\.ok\) \{\s*await recordTrade\(\{/);
    assert.match(branch, /status: "rejected",\s*reject_rule: backedOff\.rule,/);
    assert.ok(asked < fn.indexOf("if (!verdict.ok) {"), "it acts only on what the policy allowed, so a cap breach still names its cap");
  });

  it("a gas refusal is noted BEFORE the key install that would clear it, and a sponsor refusal is noted too", () => {
    const fn = body("processIntentLocked");
    const gas = fn.slice(fn.indexOf("if (e instanceof GasRefused) {"), fn.indexOf("if (e instanceof SponsorRefused) {"));
    const noted = gas.indexOf("execBackoff.note(intent, limits, e.rule, Date.now());");
    assert.ok(noted > gas.indexOf("await recordTrade("), "after the refusal's own row");
    assert.ok(noted < gas.indexOf("await installKeyAlone(agentId, executor)"), "before the install");
    const sponsor = fn.slice(fn.indexOf("if (e instanceof SponsorRefused) {"), fn.indexOf("if (e instanceof UserOpUnresolved) {"));
    assert.match(sponsor, /execBackoff\.note\(intent, limits, e\.rule, Date\.now\(\)\);\s*return;/);
  });

  it("CLEAR ON INSTALL SUCCESS: a landed install drops the `enable-too-wide` holds", () => {
    const fn = body("installKeyAlone");
    assert.match(fn, /const landed = await installKeyRecorded\(\{/);
    assert.match(fn, /if \(landed\) execBackoff\.clearRule\("enable-too-wide", /);
    assert.match(CODE, /const KEY_INSTALL_RETRY_MS = KEY_INSTALL_HOLD_MS;/, "the hold and the retry are one number");
  });

  it("CLEAR ON ARM, in the same breath as suppressedIntents", () => {
    assert.match(CODE, /suppressedIntents\.clear\(\);\n\s*execBackoff\.clear\("armed"\);/);
  });

  it("BOTH ORDER PATHS say a held order as held: the owner's and the Brain's", () => {
    const swap = body("submitChatTrade");
    assert.match(swap, /\.\.\.sayTradeOutcome\(outcome, side, named, usdgAmount, sold \?\? usdgAmount\), \.\.\.orderHeldReply\(intent, outcome\),/);
    const curveOrder = body("submitChatCurveTrade");
    assert.match(curveOrder, /\.\.\.sayTradeOutcome\(outcome, side, symbol, usdgAmount, actual\), \.\.\.orderHeldReply\(intent, outcome\),/);
    const reply = body("orderHeldReply");
    assert.match(reply, /outcome\?\.status !== "rejected"\) return \{\};/);
    assert.match(reply, /const held = liveHold\(intent\);/);
    assert.match(reply, /held && held\.rule === outcome\.rejectRule \? no\(heldReply\(held, Date\.now\(\)\)\) : \{\}/);
  });
});
