/**
 * THE SHAPES PRODUCTION ACTUALLY PRODUCED, pinned so they cannot come back.
 *
 * These are not invented cases. Every fixture below is a row shape read out of
 * the hosted ledger during the diagnosis, and each one is a different way a
 * simulated balance became a claim about an owner's money:
 *
 *   out 1000, repeated        a paper book reset and re-run
 *   out 500, repeated         the same, at the other configured size
 *   out 58.335 / 41.670 /     paper FILLS. `reconcileFlows` books a cash change
 *      25.005 / 8.340         no ledger row explains — a rule written for a real
 *                             account, where only the owner can do that
 *
 * and the three account shapes the repair has to tell apart:
 *
 *   a paper account with zero chain history  → contributed exactly nothing
 *   a funded live account                    → contributed what the chain says
 *   a funded-then-withdrawn account          → net zero, gross NOT zero
 *
 * The last one is the one a naive fix gets wrong: netting to zero and reporting
 * "no contribution ever happened" is a different and false claim.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-paper-"));
process.env.MERRYMEN_HOME = HOME;

const { admitCapitalFlow, tradingModeOf } = await import("./paper-boundary");
const { initStore, addFlow, ensureAgent, setAgentMode, listFlows, getNetContributionsUsdg } = await import("./store");
const { homePaths } = await import("./home");
const { DatabaseSync } = await import("node:sqlite");
const { planReconstruction } = await import("./accounting-reconstruction");
const { classifyUsdgMovement, totalCapital } = await import("../../packages/core/src/index");
const { legsFromReceipt } = await import("./chain-capital");

const PAPER = "0x00000000000000000000000000000000000000a1";
const LIVE = "0x00000000000000000000000000000000000000a2";
const OWNER = "0x00000000000000000000000000000000000000ff";
const USDG = "0x0000000000000000000000000000000000000001";

function clearLedger(): void {
  const db = new DatabaseSync(homePaths.db());
  for (const t of ["agents", "equity", "flows", "trades", "fee_accruals"]) {
    try {
      db.exec(`DELETE FROM ${t}`);
    } catch {
      /* pre-migration copy */
    }
  }
  db.close();
}

function grant(smartAccount: string) {
  return {
    smartAccount,
    owner: OWNER,
    sessionKeyAddress: "0x00000000000000000000000000000000000000fe",
    chainId: 46630,
    caps: { perTradeUsdg: 50, dailyUsdg: 500, expiryDays: 14, maxDrawdownPct: 10, maxOpsPerDay: 48 },
    grantedAt: 1_700_000_000,
    expiresAt: 1_800_000_000,
  } as unknown as Parameters<typeof ensureAgent>[0];
}

after(() => {
  try {
    rmSync(HOME, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// ── THE RULE ───────────────────────────────────────────────────────────────

describe("the paper boundary", () => {
  it("refuses every unevidenced flow from a paper agent", () => {
    for (const source of ["inferred", "transfer-intent", "epoch-carry"] as const) {
      const v = admitCapitalFlow({ mode: "paper", source });
      assert.equal(v.admit, false, `${source} must not cross the boundary`);
    }
  });

  it("still admits a REAL deposit into a paper agent's smart account", () => {
    // A paper agent's address is a real address. Someone can really fund it, and
    // that Transfer is real capital — refusing it would lose an owner's money in
    // the other direction.
    assert.equal(admitCapitalFlow({ mode: "paper", source: "chain-log", txHash: "0xdeadbeef" }).admit, true);
  });

  it("refuses a chain-log row that carries no transaction", () => {
    // The source word claims a receipt; the missing hash says there isn't one.
    const v = admitCapitalFlow({ mode: "paper", source: "chain-log" });
    assert.equal(v.admit, false);
    assert.match(v.admit === false ? v.why : "", /not a receipt/);
  });

  it("leaves live agents exactly as they were", () => {
    for (const source of ["inferred", "transfer-intent", "epoch-carry", "chain-log"] as const) {
      assert.equal(admitCapitalFlow({ mode: "live", source }).admit, true);
    }
  });

  it("treats an unwritten mode as unknown, and unknown admits", () => {
    // Refusing here would silently drop a LIVE agent's opening balance in the
    // window before its first heartbeat. The narrow window is closed at the call
    // site instead, where the answer is synchronous — see index.ts.
    assert.equal(tradingModeOf(null), "unknown");
    assert.equal(tradingModeOf(undefined), "unknown");
    assert.equal(tradingModeOf("paper"), "paper");
    assert.equal(tradingModeOf("live"), "live");
    assert.equal(tradingModeOf("something else"), "unknown");
    assert.equal(admitCapitalFlow({ mode: "unknown", source: "inferred" }).admit, true);
  });
});

// ── THE EXACT ROWS, REPLAYED ───────────────────────────────────────────────

describe("the corruption shapes found in production", () => {
  /** Every figure below was read out of the hosted `flows` table. */
  const PAPER_ROWS: { direction: "in" | "out"; amountUsdg: number; what: string }[] = [
    { direction: "out", amountUsdg: 1000, what: "paper book reset" },
    { direction: "out", amountUsdg: 1000, what: "paper book reset, again" },
    { direction: "out", amountUsdg: 500, what: "paper book reset at the other size" },
    { direction: "out", amountUsdg: 500, what: "paper book reset at the other size, again" },
    { direction: "out", amountUsdg: 58.335, what: "a paper FILL, not a withdrawal" },
    { direction: "out", amountUsdg: 41.67, what: "a paper FILL, not a withdrawal" },
    { direction: "out", amountUsdg: 25.005, what: "a paper FILL, not a withdrawal" },
    { direction: "out", amountUsdg: 8.34, what: "a paper FILL, not a withdrawal" },
  ];

  it("refuses all of them at the rule", () => {
    for (const r of PAPER_ROWS) {
      const v = admitCapitalFlow({ mode: "paper", source: "inferred" });
      assert.equal(v.admit, false, `${r.direction} ${r.amountUsdg} (${r.what}) must be refused`);
      assert.match(v.admit === false ? v.why : "", /SIMULATED/);
    }
  });

  it("refuses all of them at the store, which is the boundary that matters", async () => {
    initStore();
    clearLedger();
    await ensureAgent(grant(PAPER));
    await setAgentMode(PAPER, "paper", 0, false);

    for (const r of PAPER_ROWS) {
      await addFlow({ agentId: PAPER, direction: r.direction, amountUsdg: r.amountUsdg, source: "inferred" });
    }

    const flows = await listFlows(PAPER, 100);
    assert.equal(flows.length, 0, "not one simulated row reached the ledger");
    assert.equal(await getNetContributionsUsdg(PAPER), null, "zero rows is UNKNOWN, not zero");
  });

  it("would have produced −3,133 USDG of phantom withdrawals without the rule", () => {
    // What the ledger actually held. Stated as a number so the regression has a
    // magnitude and not just a boolean: this is the shape behind the −59,000,
    // −26,000 and −7,900 figures, at the size one paper agent reached.
    const total = PAPER_ROWS.reduce((s, r) => s + (r.direction === "in" ? r.amountUsdg : -r.amountUsdg), 0);
    assert.equal(Number(total.toFixed(3)), -3133.35);
  });

  it("a paper agent's real deposit still lands", async () => {
    await addFlow({
      agentId: PAPER,
      direction: "in",
      amountUsdg: 10,
      source: "chain-log",
      txHash: "0xfeed",
      blockNumber: 1,
      logIndex: 0,
    });
    assert.equal(await getNetContributionsUsdg(PAPER), 10);
  });

  it("a live agent is unaffected — the fix is not a blanket refusal", async () => {
    await ensureAgent(grant(LIVE));
    await setAgentMode(LIVE, "live", 0, false);
    await addFlow({ agentId: LIVE, direction: "in", amountUsdg: 1000, source: "inferred" });
    assert.equal(await getNetContributionsUsdg(LIVE), 1000);
  });

  it("an explicit mode beats the stored one, because the first tick has no stored one", async () => {
    // `agents.mode` is written by the heartbeat. On an agent's very first tick it
    // is NULL — and the first tick is exactly when an opening balance is booked.
    clearLedger();
    await ensureAgent(grant(PAPER)); // no setAgentMode: mode is NULL, as at first tick
    await addFlow({ agentId: PAPER, direction: "in", amountUsdg: 3000, source: "inferred", mode: "paper" });
    assert.equal(await getNetContributionsUsdg(PAPER), null, "the caller's answer is the authoritative one");
  });
});

// ── THE THREE ACCOUNT SHAPES THE REPAIR MUST TELL APART ────────────────────

describe("account shapes", () => {
  const cap = (movements: { direction: "in" | "out"; amountRaw: string; kind: string }[]) => ({
    account: "",
    movements: movements.map((m, i) => ({
      txHash: `0x${(i + 1).toString(16).padStart(64, "0")}`,
      blockNumber: 100 + i,
      logIndex: i,
      direction: m.direction,
      amountRaw: m.amountRaw,
      counterparty: OWNER,
      classification: {
        kind: m.kind,
        why: "fixture",
        evidence: { counterparty: OWNER, direction: m.direction, txLegCount: 1, rule: "no-pair-external" },
      },
    })),
    totals: totalCapital(
      movements.map((m) => ({
        amountRaw: m.amountRaw,
        classification: {
          kind: m.kind,
          why: "fixture",
          evidence: { counterparty: OWNER, direction: m.direction, txLegCount: 1, rule: "no-pair-external" },
        },
      })) as never,
    ),
    complete: true,
    notes: [],
  });

  const planFor = (
    account: string,
    mode: string,
    movements: Parameters<typeof cap>[0],
    flows: Record<string, unknown>[],
    onchainCash: number,
  ) =>
    planReconstruction({
      agents: [{ smart_account: account, owner_address: OWNER, mode, epoch: 1 }],
      flows,
      equityByAccountEpoch: new Map([[`${account.toLowerCase()}#1`, onchainCash]]),
      chain: new Map([[account.toLowerCase(), { ...cap(movements), account } as never]]),
      onchainCash: new Map([[account.toLowerCase(), onchainCash]]),
    })[0]!;

  it("a paper account with zero chain history contributed exactly nothing", () => {
    const p = planFor(
      PAPER,
      "paper",
      [],
      [
        { id: 1, agent_id: PAPER, epoch: 1, direction: "out", amount_usdg: 1000, source: "inferred" },
        { id: 2, agent_id: PAPER, epoch: 1, direction: "out", amount_usdg: 58.335, source: "inferred" },
      ],
      0,
    );
    assert.equal(p.isPaper, true);
    assert.equal(p.insert.length, 0, "there is no chain evidence to insert");
    assert.equal(p.quarantine.length, 2, "and the simulated rows come out");
    assert.equal(p.contributionsAfterUsdg, 0);
    assert.equal(p.blocked, null, "zero is the ANSWER here, not a refusal");
    assert.equal(p.pnlPublishableAfter, false, "there is nothing to divide by");
  });

  it("a funded live account contributed what the chain says", () => {
    const p = planFor(
      LIVE,
      "live",
      [{ direction: "in", amountRaw: "10000000", kind: "capital-in" }],
      [{ id: 1, agent_id: LIVE, epoch: 1, direction: "in", amount_usdg: 30, source: "inferred" }],
      3.334,
    );
    assert.equal(p.isPaper, false);
    assert.equal(p.insert.length, 1);
    assert.equal(p.insert[0]!.amountUsdg, 10);
    assert.equal(p.contributionsAfterUsdg, 10, "10, not the 30 the inferred rows claimed");
    assert.equal(p.contributionsKnownAfter, true);
    assert.equal(p.pnlPublishableAfter, true);
  });

  it("a funded-then-withdrawn account nets to zero WITHOUT losing its history", () => {
    // The claim that must not be made here is "no contribution ever happened".
    const p = planFor(
      LIVE,
      "live",
      [
        { direction: "in", amountRaw: "1010000000", kind: "capital-in" },
        { direction: "out", amountRaw: "1010000000", kind: "capital-out" },
      ],
      [],
      0,
    );
    assert.equal(p.chainGrossInUsdg, 1010, "gross in survives");
    assert.equal(p.chainGrossOutUsdg, 1010, "gross out survives");
    assert.equal(p.chainNetUsdg, 0);
    assert.equal(p.insert.length, 2, "both legs are written, not one netted row");
    assert.equal(p.contributionsAfterUsdg, 0);
    assert.equal(p.pnlPublishableAfter, false, "net zero is not a denominator");
  });
});

// ── THE PAPER FILL, AS THE CLASSIFIER SEES IT ──────────────────────────────

describe("a paper-sized outflow that is really a trade", () => {
  it("is a trade leg, not a withdrawal, when the receipt shows the other side", () => {
    // 8.340 USDG out and TSLA in, one transaction. Address lists are irrelevant.
    const legs = legsFromReceipt([
      {
        address: USDG,
        topics: [
          "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
          `0x000000000000000000000000${LIVE.slice(2)}`,
          "0x000000000000000000000000f4acdaee1234567890123456789012345678abcd",
        ],
        data: "0x" + (8_340_000).toString(16),
        blockNumber: "0x1",
        transactionHash: "0xtrade",
        logIndex: "0x0",
      },
      {
        address: "0x00000000000000000000000000000000000000ee",
        topics: [
          "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
          "0x000000000000000000000000f4acdaee1234567890123456789012345678abcd",
          `0x000000000000000000000000${LIVE.slice(2)}`,
        ],
        data: "0x" + (22_000_000_000_000_000).toString(16),
        blockNumber: "0x1",
        transactionHash: "0xtrade",
        logIndex: "0x1",
      },
    ]);

    const v = classifyUsdgMovement({
      account: LIVE,
      usdg: legs[0]!,
      txLegs: legs,
      usdgToken: USDG,
    });
    assert.equal(v.kind, "trade-out");
    assert.equal(v.evidence.rule, "paired-token-movement");
    assert.equal(totalCapital([{ amountRaw: "8340000", classification: v }]).grossWithdrawalsRaw, "0");
  });
});

// ── THE CALL SITE, PINNED ──────────────────────────────────────────────────

describe("index.ts passes the mode it knows", () => {
  it("does not leave the paper decision to the store's fallback read", () => {
    // A source-level pin, and deliberately so: the fallback reads `agents.mode`,
    // which is NULL on the tick that books an opening balance. If someone drops
    // `mode` from this call the store still refuses paper agents that HAVE a
    // recorded mode — so the regression would be invisible except on exactly the
    // first tick of a fresh paper agent, which no integration test exercises and
    // which is the only tick that matters.
    const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const from = src.indexOf("const record = async (");
    assert.ok(from > 0, "reconcileFlows still has a `record` closure");
    const record = src.slice(from, src.indexOf("await adjustAgentHwm(agentId", from));
    assert.match(record, /paperActive\(\)/, "the mode is decided from paperActive(), synchronously");
    assert.match(record, /\bmode,/, "and passed into addFlow");
    assert.match(record, /if \(mode === "paper" && !evidence\)/, "and the high-water mark is not moved either");
  });
});

describe("both call sites obey the pairing rule", () => {
  it("the transfer-intent site refuses to move the peak for a flow that did not land", () => {
    // PR 2's whole claim is that the peak and the contribution move together.
    // addFlow was made to REPORT whether the row landed, and there are exactly
    // two production callers. Fixing one and leaving the other would leave the
    // invariant true in the deposit direction and false in the withdrawal one —
    // and this site is the more dangerous of the two to get wrong, because a
    // peak lowered for a withdrawal the ledger has no row for leaves net
    // contributions permanently too high with no retry path.
    const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const from = src.indexOf('if (intent.kind === "transfer") {');
    assert.ok(from > 0, "the transfer-intent flow site still exists");
    const block = src.slice(from, src.indexOf("} catch (e) {", from));
    assert.match(block, /const landed = await addFlow\(/, "it captures the answer");
    assert.match(block, /if \(landed\) \{/, "and gates the high-water mark on it");
    assert.match(block, /mode: "live"/, "and names the rail rather than inheriting a stale one");
    // The two statements that must NOT run unconditionally.
    const guarded = block.slice(block.indexOf("if (landed) {"));
    assert.match(guarded, /adjustAgentHwm/, "the peak adjustment is inside the guard");
    assert.match(guarded, /lastCashUsdg -= intent\.amountUsdg/, "so is the baseline decrement");
  });
});
