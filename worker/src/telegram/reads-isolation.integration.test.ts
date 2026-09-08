/**
 * Tenant isolation for the Telegram read formatters — the "one-way door".
 *
 * These reads used to select whole tables (equity, positions, trades, events,
 * decisions) with no agent filter, or resolve "the current agent" by guessing
 * the most-recently-active one. Fine while a database held exactly one tenant;
 * a cross-tenant LEAK the moment the ledger is shared. This proves the fix
 * against a REAL sqlite ledger holding TWO agents: every read scoped to Alice
 * returns Alice's rows and NEVER Bob's, and — in hosted mode — a read with no
 * agent refuses rather than falling back to the global guess.
 *
 * MERRYMEN_HOSTED is set so the no-fallback branch is exercised; MERRYMEN_HOME
 * is a throwaway temp db. node's --test runs each file in its own process, so
 * neither override leaks into another suite.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-iso-"));
process.env.MERRYMEN_HOME = HOME;
process.env.MERRYMEN_HOSTED = "1";

const { initStore, addTrade, addEvent, addEquity, setPositions, addDecision, newDecisionId } =
  await import("../store");
const { readTrades, readPositions, readRecentEvents, readWhyEvidence, readStatus, readReport } =
  await import("./reads");

const ALICE = "0x00000000000000000000000000000000000a11ce" as const;
const BOB = "0x0000000000000000000000000000000000000b0b" as const;

after(() => {
  try {
    rmSync(HOME, { recursive: true, force: true });
  } catch {
    /* windows temp lock; disposable */
  }
});

const ctx = (agentId: string | null) => ({
  agentId,
  name: "test",
  strategy: "steady-basket",
  venue: "uniswap",
  paused: false,
  workerAliveSec: 0,
  grant: null,
  chainId: null as number | null,
  telegramMaxActionUsdg: 50,
});

async function seed() {
  initStore();
  // Alice: a $11.11 AAPL buy with reasoning, a position, equity, an event.
  const aDec = newDecisionId();
  await addDecision({ id: aDec, agent_id: ALICE, source: "strategist", symbol: "AAPL", action: "buy", size_usdg: 11.11, reason: "ALICE_REASONING_gap_open" });
  await addTrade({ agent_id: ALICE, kind: "swap", target: "0x0000000000000000000000000000000000000001", amount_usdg: 11.11, status: "landed", tx_hash: "0xa11ce", decision_id: aDec });
  await setPositions(ALICE, [{ symbol: "AAPL", token: "0x0000000000000000000000000000000000000001", rawBalance: 1n, uiMultiplier: 1n, priceUsd: 1, priceStale: false, priceSource: "chainlink", valueUsdg: 111.0 }]);
  await addEquity(ALICE, { mode: "live", ethWei: 0n, cashUsdg: 111, vaultUsdg: 0, positionsUsdg: 0, equityUsdg: 111.11 });
  await addEvent(ALICE, "ok", "ALICE_SECRET_EVENT");

  // Bob: a $22.22 TSLA buy with different reasoning, position, equity, event.
  const bDec = newDecisionId();
  await addDecision({ id: bDec, agent_id: BOB, source: "strategist", symbol: "TSLA", action: "buy", size_usdg: 22.22, reason: "BOB_REASONING_momentum" });
  await addTrade({ agent_id: BOB, kind: "swap", target: "0x0000000000000000000000000000000000000002", amount_usdg: 22.22, status: "landed", tx_hash: "0xb0b", decision_id: bDec });
  await setPositions(BOB, [{ symbol: "TSLA", token: "0x0000000000000000000000000000000000000002", rawBalance: 1n, uiMultiplier: 1n, priceUsd: 1, priceStale: false, priceSource: "chainlink", valueUsdg: 222.0 }]);
  await addEquity(BOB, { mode: "live", ethWei: 0n, cashUsdg: 222, vaultUsdg: 0, positionsUsdg: 0, equityUsdg: 222.22 });
  await addEvent(BOB, "ok", "BOB_SECRET_EVENT");
}

describe("telegram reads — one tenant never sees another's ledger", () => {
  it("every scoped read shows Alice's rows and never Bob's", async () => {
    await seed();

    const trades = readTrades(ALICE);
    assert.match(trades, /11\.11/, "Alice's trade");
    assert.doesNotMatch(trades, /22\.22/, "…never Bob's");

    const positions = readPositions(ALICE);
    assert.match(positions, /AAPL/);
    assert.doesNotMatch(positions, /TSLA/);

    const events = readRecentEvents(ALICE);
    assert.match(events, /ALICE_SECRET_EVENT/);
    assert.doesNotMatch(events, /BOB_SECRET_EVENT/);

    const why = readWhyEvidence(ALICE);
    assert.equal(why.hasTrade, true);
    assert.match(why.text, /ALICE_REASONING_gap_open/);
    assert.doesNotMatch(why.text, /BOB_REASONING_momentum/);
    assert.doesNotMatch(why.text, /TSLA/);

    const status = readStatus(ctx(ALICE));
    assert.match(status, /111\.11/, "Alice's equity");
    assert.doesNotMatch(status, /222\.22/, "…never Bob's");

    const report = readReport(ctx(ALICE));
    assert.match(report, /AAPL/);
    assert.doesNotMatch(report, /TSLA/);
  });

  it("and the mirror image holds for Bob", async () => {
    const trades = readTrades(BOB);
    assert.match(trades, /22\.22/);
    assert.doesNotMatch(trades, /11\.11/);
    const why = readWhyEvidence(BOB);
    assert.match(why.text, /BOB_REASONING_momentum/);
    assert.doesNotMatch(why.text, /ALICE_REASONING_gap_open/);
  });

  it("HOSTED: a read with no agent refuses — never the global guess", () => {
    // Null agent in hosted mode must NOT fall back to currentAgentId (which
    // would return whichever agent traded last across the fleet — a leak).
    const trades = readTrades(null);
    assert.doesNotMatch(trades, /11\.11/);
    assert.doesNotMatch(trades, /22\.22/);

    const positions = readPositions(null);
    assert.doesNotMatch(positions, /AAPL/);
    assert.doesNotMatch(positions, /TSLA/);

    const events = readRecentEvents(null);
    assert.doesNotMatch(events, /ALICE_SECRET_EVENT/);
    assert.doesNotMatch(events, /BOB_SECRET_EVENT/);

    const why = readWhyEvidence(null);
    assert.equal(why.hasTrade, false);

    const status = readStatus(ctx(null));
    assert.doesNotMatch(status, /111\.11/);
    assert.doesNotMatch(status, /222\.22/);
  });
});

/**
 * THE DAILY REPORT IS ALSO POSTED IN PUBLIC.
 *
 * virtuals-streamer sends it to a terminal anybody can read, and it had been
 * sending the owner's exact equity, their biggest holding's dollar value, and
 * the newest event verbatim — which is where the strategist's own prose lands,
 * and where a policy refusal naming an allowlisted recipient can land too.
 *
 * The percentages are the point of a public report. The balance sheet is not
 * anybody else's business.
 */
describe("the daily report is also posted in public", () => {
  it("keeps the performance and drops the balance sheet", () => {
  const priv = readReport(ctx(ALICE));
  const pub = readReport(ctx(ALICE), true);

  assert.doesNotMatch(pub, /equity:/, "exact equity must not be published");
  assert.doesNotMatch(pub, /last word from camp/, "the newest event must not be published");
  assert.doesNotMatch(pub, /\$\d/, "no dollar figure survives");

  // …and the owner's own report is untouched.
  assert.match(priv, /equity:/);

    // What a public reader still gets: how it did, and how the wall did.
    assert.match(pub, /arrows today/);
    assert.match(pub, /strategy:/);
  });
});
