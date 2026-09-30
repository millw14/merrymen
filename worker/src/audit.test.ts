import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GENESIS,
  compareRecord,
  linkHash,
  reconcile,
  reconstruct,
  verifyChain,
  type ExportedEntry,
} from "./audit";

/** Build a well-formed chain from a list of payloads, the way the store would. */
function chain(payloads: { kind: string; payload: unknown }[]): ExportedEntry[] {
  const out: ExportedEntry[] = [];
  let prev = GENESIS;
  payloads.forEach((p, i) => {
    const payload_json = JSON.stringify(p.payload);
    const hash = linkHash(prev, payload_json);
    out.push({
      seq: i + 1,
      agent_id: "0xagent",
      epoch: 2,
      kind: p.kind,
      payload_json,
      prev_hash: prev,
      hash,
      at: 1_700_000_000 + i,
    });
    prev = hash;
  });
  return out;
}

const deposit = { kind: "flow", payload: { amountUsdg: 1000, direction: "in", source: "chain-log", txHash: "0xdep" } };
const buy = {
  kind: "fill",
  payload: { amountUsdg: 50, gasWei: "3450000000000", realizedPnlUsdg: null, status: "landed", txHash: "0xbuy" },
};
const sell = {
  kind: "fill",
  payload: { amountUsdg: 60, gasWei: "3450000000000", realizedPnlUsdg: 10, status: "landed", txHash: "0xsell" },
};
const mark = { kind: "mark", payload: { equityUsdg: 1010, marks: [], blockNumber: "5000" } };

describe("verifyChain — tamper evidence", () => {
  it("an untouched chain verifies clean", () => {
    assert.deepEqual(verifyChain(chain([deposit, buy, sell, mark])), []);
  });

  it("an EDITED payload is caught — the recorded hash no longer matches", () => {
    const c = chain([deposit, buy, sell, mark]);
    // The obvious attack: quietly turn a 10 USDG gain into 1,000.
    c[2]!.payload_json = JSON.stringify({ ...JSON.parse(c[2]!.payload_json), realizedPnlUsdg: 1000 });
    const findings = verifyChain(c);
    assert.ok(findings.some((f) => f.check === "chain" && f.seq === 3));
  });

  it("a RE-HASHED edit is still caught — every later link breaks", () => {
    // A more careful attacker edits the payload AND recomputes its hash. That
    // works for one row and breaks the next one's prev_hash, which is the whole
    // point of chaining rather than hashing each record alone.
    const c = chain([deposit, buy, sell, mark]);
    const edited = JSON.stringify({ ...JSON.parse(c[2]!.payload_json), realizedPnlUsdg: 1000 });
    c[2]!.payload_json = edited;
    c[2]!.hash = linkHash(c[2]!.prev_hash, edited);
    const findings = verifyChain(c);
    assert.ok(findings.some((f) => f.check === "chain" && f.seq === 4), JSON.stringify(findings));
  });

  it("a DELETED record shows as a sequence gap even if the chain is re-stitched", () => {
    const c = chain([deposit, buy, sell, mark]);
    const without = [c[0]!, c[2]!, c[3]!]; // drop the buy
    const findings = verifyChain(without);
    assert.ok(findings.some((f) => f.check === "gap"), JSON.stringify(findings));
  });

  it("a gap does not cascade into a break at every later row", () => {
    // Otherwise one deletion drowns the real signal in noise.
    const c = chain([deposit, buy, sell, mark]);
    const findings = verifyChain([c[0]!, c[2]!, c[3]!]);
    assert.equal(findings.filter((f) => f.check === "gap").length, 1);
    assert.equal(findings.filter((f) => f.check === "chain").length, 0);
  });

  it("an empty export is not a failure — it is an agent that has done nothing", () => {
    assert.deepEqual(verifyChain([]), []);
  });
});

describe("reconstruct — the book from primitives", () => {
  it("sums flows, realized P&L and gas", () => {
    const book = reconstruct(chain([deposit, buy, sell, mark]));
    assert.equal(book.netContributionsUsdg, 1000);
    assert.equal(book.realizedPnlUsdg, 10);
    assert.equal(book.gasWei, 6_900_000_000_000n);
    assert.equal(book.publishedEquityUsdg, 1010);
  });

  it("a withdrawal reduces contributions", () => {
    const book = reconstruct(
      chain([deposit, { kind: "flow", payload: { amountUsdg: 400, direction: "out", source: "transfer-intent", txHash: "0xout" } }]),
    );
    assert.equal(book.netContributionsUsdg, 600);
  });

  it("lists every record an RPC could check", () => {
    const book = reconstruct(chain([deposit, buy, sell, mark]));
    assert.deepEqual(book.chainRefs.map((r) => r.txHash), ["0xdep", "0xbuy", "0xsell"]);
  });

  it("SEPARATES what cannot be checked, rather than quietly counting it", () => {
    // An inferred flow moves the numbers and names no transaction. Counting it
    // silently would let a figure that rests on guesswork pass as verified.
    const inferred = { kind: "flow", payload: { amountUsdg: 500, direction: "in", source: "inferred", txHash: null } };
    const paper = { kind: "fill", payload: { amountUsdg: 25, realizedPnlUsdg: 3, status: "paper", txHash: null } };
    const book = reconstruct(chain([inferred, paper]));
    assert.equal(book.netContributionsUsdg, 500);
    assert.equal(book.unanchored.length, 2);
    assert.match(book.unanchored[0]!.why, /inferred/);
    assert.match(book.unanchored[1]!.why, /simulated/);
  });
});

describe("compareRecord — the ledger against the chain", () => {
  const ME = "0x00000000000000000000000000000000000000a1";
  const ROUTER = "0x00000000000000000000000000000000000000b2";
  const USDG = "0x0000000000000000000000000000000000000dd0";
  const NVDA = "0x0000000000000000000000000000000000000ee0";
  const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const ONE = 10n ** 18n;

  const topic = (a: string) => `0x${"0".repeat(24)}${a.slice(2)}`;
  const hexv = (v: bigint) => `0x${v.toString(16).padStart(64, "0")}`;
  const xfer = (token: string, from: string, to: string, v: bigint) => ({
    address: token,
    topics: [TRANSFER, topic(from), topic(to)],
    data: hexv(v),
  });
  const ok = (logs: ReturnType<typeof xfer>[]) => ({ status: "0x1", logs });

  const buyPayload = {
    fillSide: "buy",
    fillCashUsdg: 50,
    fillQtyRaw: (ONE / 4n).toString(),
    buyToken: NVDA,
    sellToken: USDG,
    txHash: "0xbuy",
  };
  const check = (payload: Record<string, unknown>, receipt: Parameters<typeof compareRecord>[0]["receipt"], kind = "fill") =>
    compareRecord({ seq: 1, kind, payload, receipt, account: ME, usdgToken: USDG });

  it("confirms a buy whose legs match the chain", () => {
    const r = ok([xfer(USDG, ME, ROUTER, 50_000_000n), xfer(NVDA, ROUTER, ME, ONE / 4n)]);
    assert.deepEqual(check(buyPayload, r), []);
  });

  it("CATCHES a quantity the chain does not support", () => {
    // The exact failure the receipt work fixed: a fill booked from the quote
    // records fewer units than actually arrived. An audit now sees it.
    const r = ok([xfer(USDG, ME, ROUTER, 50_000_000n), xfer(NVDA, ROUTER, ME, ONE / 3n)]);
    const f = check(buyPayload, r);
    assert.equal(f.length, 1);
    assert.match(f[0]!.detail, /raw units/);
  });

  it("CATCHES a cash amount the chain does not support", () => {
    const r = ok([xfer(USDG, ME, ROUTER, 40_000_000n), xfer(NVDA, ROUTER, ME, ONE / 4n)]);
    assert.match(check(buyPayload, r)[0]!.detail, /USDG movement/);
  });

  it("tolerates a one-unit cash difference — our storage is float, the chain is not", () => {
    const r = ok([xfer(USDG, ME, ROUTER, 50_000_001n), xfer(NVDA, ROUTER, ME, ONE / 4n)]);
    assert.deepEqual(check(buyPayload, r), []);
  });

  it("checks direction, not just magnitude", () => {
    // Same amounts, opposite way round: a 'buy' whose USDG came IN.
    const r = ok([xfer(USDG, ROUTER, ME, 50_000_000n), xfer(NVDA, ME, ROUTER, ONE / 4n)]);
    assert.ok(check(buyPayload, r).length >= 1);
  });

  it("confirms a deposit, and catches an inflated one", () => {
    const flow = { direction: "in", amountUsdg: 1000, txHash: "0xdep" };
    const good = ok([xfer(USDG, ROUTER, ME, 1_000_000_000n)]);
    assert.deepEqual(check(flow, good, "flow"), []);
    const short = ok([xfer(USDG, ROUTER, ME, 10_000_000n)]);
    assert.match(check(flow, short, "flow")[0]!.detail, /claims a inflow of 1000/);
  });

  it("a transaction that isn't on this chain is a finding, not a pass", () => {
    assert.match(check(buyPayload, null)[0]!.detail, /no such transaction/);
  });

  it("a FAILED transaction recorded as settled is a finding", () => {
    const reverted = { status: "0x0", logs: [] };
    assert.match(check(buyPayload, reverted)[0]!.detail, /FAILED/);
  });

  it("ignores transfers between other parties in the same transaction", () => {
    const r = ok([
      xfer(USDG, ME, ROUTER, 50_000_000n),
      xfer(USDG, ROUTER, "0x00000000000000000000000000000000000000cc", 50_000_000n),
      xfer(NVDA, ROUTER, ME, ONE / 4n),
    ]);
    assert.deepEqual(check(buyPayload, r), []);
  });
});

describe("reconcile", () => {
  it("reports the unrealized residual rather than calling it an error", () => {
    const book = reconstruct(chain([deposit, buy, sell, mark]));
    const r = reconcile(book);
    // 1010 published − (1000 contributed + 10 realized) = 0 here.
    assert.equal(r.residualUsdg, 0);
  });

  it("says so when there is nothing to reconcile against", () => {
    const r = reconcile(reconstruct(chain([deposit])));
    assert.equal(r.residualUsdg, null);
    assert.match(r.note, /nothing to reconcile/);
  });
});

/**
 * AN ENERGY PURCHASE, AS AN AUDITOR SEES IT.
 *
 * The purchase is booked as an 'energy-buy' out-flow (capital leaving the book)
 * and its trade row is fill-less: the reserve is never a position, so there is
 * no fillSide and nothing enters grossBuyNotional. $MERRYMEN is never in
 * positions, so the composition check is untouched. With the flow booked the
 * envelope residual is exactly what it would be without the purchase; with the
 * flow MISSING, equity sits below contributions by the spend with no purchase to
 * explain it — the floor finding fires, and that is the detector for a booking a
 * redeploy lost.
 */
describe("an energy purchase in the journal", () => {
  const ME = "0x00000000000000000000000000000000000000a1";
  const PAIR = "0x00000000000000000000000000000000000000b1";
  const USDG = "0x0000000000000000000000000000000000000dd0";
  const MERRYMEN = "0xa15cd06dd305269a0f48bebeb30aa3588fba7b32";
  const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const topic = (a: string) => `0x${"0".repeat(24)}${a.slice(2)}`;
  const xfer = (token: string, from: string, to: string, v: bigint) => ({
    address: token,
    topics: [TRANSFER, topic(from), topic(to)],
    data: `0x${v.toString(16).padStart(64, "0")}`,
  });

  const funded = { kind: "flow", payload: { amountUsdg: 100, direction: "in", source: "chain-log", txHash: "0xdep" } };
  const energyFlow = {
    kind: "flow",
    payload: { amountUsdg: 42, direction: "out", source: "energy-buy", txHash: "0xenergy", logIndex: 3, blockNumber: 9 },
  };
  // The landed energy trade: no fillSide, no basis — the reserve is not a position.
  const energyTrade = {
    kind: "fill",
    payload: { amountUsdg: 42, gasWei: "3450000000000", realizedPnlUsdg: null, status: "landed", txHash: "0xenergy" },
  };
  // 100 in, 42 set aside as energy: 58 USDG of cash, nothing held.
  const markAfter = {
    kind: "mark",
    payload: { equityUsdg: 58, cashUsdg: 58, positionsUsdg: 0, vaultUsdg: 0, quarantinedCostUsdg: 0, marks: [] },
  };

  it("with the energy-buy flow booked: no envelope finding, residual zero", () => {
    const book = reconstruct(chain([funded, energyTrade, energyFlow, markAfter]));
    assert.equal(book.netContributionsUsdg, 58);
    assert.equal(book.grossBuyNotionalUsdg, 0, "a fill-less energy trade is not a position purchase");
    assert.equal(book.unanchored.length, 0, "the energy flow carries its transaction");
    const r = reconcile(book);
    assert.equal(r.checked, true);
    assert.equal(r.residualUsdg, 0);
    assert.deepEqual(r.findings, []);
  });

  it("with the flow MISSING, the floor 'arithmetic' finding fires — the detector for a lost booking", () => {
    const r = reconcile(reconstruct(chain([funded, energyTrade, markAfter])));
    assert.equal(r.residualUsdg, -42);
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0]!.check, "arithmetic");
    assert.match(r.findings[0]!.detail, /contributions exceed what the record can support/);
    assert.match(r.findings[0]!.detail, /implies an unrealized LOSS of 42\.000000, but only 0\.000000 was ever spent/);
  });

  it("the flow and the fill-less trade both agree with the receipt", () => {
    const receipt = {
      status: "0x1",
      logs: [xfer(USDG, ME, PAIR, 42_000_000n), xfer(MERRYMEN, PAIR, ME, 98_000n * 10n ** 18n)],
    };
    const check = (kind: string, payload: Record<string, unknown>) =>
      compareRecord({ seq: 1, kind, payload, receipt, account: ME, usdgToken: USDG });
    assert.deepEqual(check("flow", energyFlow.payload), [], "the account's USDG delta is −amountIn");
    assert.deepEqual(check("fill", energyTrade.payload), [], "and the trade row claims no legs to contradict");
  });
});
