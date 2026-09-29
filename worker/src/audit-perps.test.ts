/**
 * VERIFYING A PERP BOOK (docs/perps.md, "Verify"; the accounting finding
 * verify-false-fail-and-silent-skip).
 *
 * Four things this file pins, each the answer to a way the verifier would
 * otherwise be wrong about a perp book:
 *
 *   FORMAT      a perp book is exported as `merrymen-journal-v2`, which every
 *               verifier already shipped refuses by name instead of misreading;
 *               a book without perps stays v1, byte for byte; this verifier
 *               reads both and refuses anything else with exit 2, never 1.
 *   KINDS       reconstruct knows perp-fill, funding, margin and perp-carry,
 *               and a kind it was never taught is REFUSED — the arithmetic is
 *               not judged — rather than skipped and summed without.
 *   EVIDENCE    Lighter's fills and funding are VENUE-ATTESTED: in the
 *               arithmetic, never chain-verified, never failed, always a gap.
 *               Margin is checked against Robinhood Chain receipts by the
 *               verifier's own decoder, against the venue PINNED here.
 *   IDENTITY    equity = cash + positions + vault + quarantine + (C+ΣM+ΣU+T),
 *               and what equity must be explained by includes the venue's
 *               realized P&L, fees and funding.
 *
 * The CLI's exit codes are driven through the real command at the end.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { LIGHTER_ROUTE_V1 } from "../../packages/core/src/perps";
import {
  GENESIS,
  JOURNAL_FORMAT_V1,
  JOURNAL_FORMAT_V2,
  VERIFIER_VENUES,
  compareRecord,
  exportHeader,
  journalHasPerps,
  linkHash,
  marginChainHash,
  readExportHeader,
  reconcile,
  reconstruct,
  verifyChain,
  type ExportedEntry,
  type FetchedReceipt,
  type VerifiedVenue,
} from "./audit";

const ACCT = "0x1111111111111111111111111111111111111111";
const STRANGER = "0x7777777777777777777777777777777777777777";
const PIN = VERIFIER_VENUES["lighter-rh"];
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** Build a well-formed chain from payloads, the way the store would. */
function chain(payloads: { kind: string; payload: unknown }[]): ExportedEntry[] {
  const out: ExportedEntry[] = [];
  let prev = GENESIS;
  payloads.forEach((p, i) => {
    const payload_json = JSON.stringify(p.payload);
    const hash = linkHash(prev, payload_json);
    out.push({ seq: i + 1, agent_id: ACCT, epoch: 2, kind: p.kind, payload_json, prev_hash: prev, hash, at: 1_790_000_000 + i });
    prev = hash;
  });
  return out;
}

const hash64 = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const DEP_TX = hash64(0xd0);
const PAY_TX = hash64(0xa0);
const L2_HASH = "ab".repeat(40); // an 80-hex Lighter hash — never an eth RPC question

// ── a perp book that adds up ────────────────────────────────────────────────
//
// 1000 contributed; 300 posted as margin (landed, then credited at the venue);
// one position opened and closed for +20 realized, funding −1.5 paid; a second
// open now with 12.5 of isolated margin and +5 unrealized. Spot book: 700 cash.
//   at Lighter: C = 300 + 20 − 1.5 − 12.5 = 306, ΣM = 12.5, ΣU = 5, T = 0
//   equity    : 700 + 323.5 = 1023.5
//   explained : 1000 + 0 + 20 − 0 + (−1.5) = 1018.5 → residual 5 = the venue's U
const flowIn = { kind: "flow", payload: { amountUsdg: 1000, direction: "in", source: "chain-log", txHash: hash64(0xf0) } };
const marginLanded = {
  kind: "margin",
  payload: {
    amountMicro: "300000000", chainId: 4663, direction: "deposit", from: "submitted", initiator: "agent", logIndex: 4,
    mode: "live", paidLogIndex: null, paidTxHash: null, to: "landed", transferId: "t1", txHash: DEP_TX, userOpHash: hash64(0xe0),
    venueTxHash: null,
  },
};
const marginCredited = { kind: "margin", payload: { ...marginLanded.payload, from: "landed", to: "credited" } };
const fill = (over: Record<string, unknown>) => ({
  kind: "perp-fill",
  payload: {
    attribution: "intent", base: "20000", clientOrderIndex: null, entryQuoteBeforeMicro: "0", feeMicro: "0", market: "BTC-PERP",
    marketId: 1, mode: "live", orderId: null, positionBefore: "0", price: "11500000", quoteMicro: "23000000", realizedMicro: "0",
    role: "taker", side: "long", sideRole: "bid", tradeType: "trade", venueOrderIndex: null, venueTradeId: "1150715509",
    venueTsMs: 1_790_696_152_553, venueTxHash: L2_HASH, ...over,
  },
});
const openFill = fill({});
const closeFill = fill({ venueTradeId: "1150715600", sideRole: "ask", realizedMicro: "20000000", positionBefore: "20000", entryQuoteBeforeMicro: "23000000" });
const secondOpen = fill({ venueTradeId: "1150716000", marketId: 0, market: "ETH-PERP" });
const funding = {
  kind: "funding",
  payload: { fundingHour: 1_790_697_600, fundingId: "f1", market: "BTC-PERP", marketId: 1, mode: "live", paymentMicro: "-1500000", positionBase: "20000", positionSide: "long", ratePpm: 12 },
};
const perpMark = (over: Record<string, unknown> = {}) => ({
  kind: "mark",
  payload: {
    blockNumber: "5000", cashUsdg: 700, equityUsdg: 1023.5, ethWei: "0", marks: [], mode: "live", positionsUsdg: 0,
    quarantinedCostUsdg: 0, vaultUsdg: 0, cashReadBlock: 5000,
    perpCollateralMicro: "306000000", perpInTransitMicro: "0", perpIsolatedMarginMicro: "12500000", perpSnapshotTime: 1_790_697_700_000_000,
    perpUnrealizedGainMicro: "5000000", perpUnrealizedMicro: "5000000", ...over,
  },
});
const PERP_BOOK = [flowIn, marginLanded, marginCredited, openFill, closeFill, funding, secondOpen, perpMark()];

const venue = (accountIndex: number | null = 22_149): VerifiedVenue => ({ ...PIN, name: "lighter-rh", accountIndex });

describe("the export formats", () => {
  it("THE PIN IS CORE'S ROUTE — the verifier's own copy of the venue cannot drift from the one the wall seals", () => {
    assert.equal(PIN.chainId, LIGHTER_ROUTE_V1.chainId);
    assert.equal(PIN.l2ChainId, LIGHTER_ROUTE_V1.l2ChainId);
    assert.equal(PIN.proxy, LIGHTER_ROUTE_V1.proxy.toLowerCase());
    assert.equal(PIN.usdg, LIGHTER_ROUTE_V1.usdg.toLowerCase());
    assert.equal(PIN.assetIndex, LIGHTER_ROUTE_V1.assetIndex);
    assert.equal(PIN.routeType, LIGHTER_ROUTE_V1.routePerps);
    assert.equal(PIN.usdgTickSize, LIGHTER_ROUTE_V1.usdgTickSize);
    assert.equal(PIN.depositTopic, LIGHTER_ROUTE_V1.topics.deposit);
    assert.equal(PIN.withdrawPendingTopic, LIGHTER_ROUTE_V1.topics.withdrawPending);
  });

  it("A BOOK WITHOUT PERPS EXPORTS THE V1 HEADER BYTE FOR BYTE — every shipped verifier still reads it", () => {
    const entries = chain([flowIn, { kind: "mark", payload: { equityUsdg: 1000 } }, { kind: "fee", payload: { feeUsdg: 1 } }]);
    const h = exportHeader({ agentId: ACCT, epoch: 2, chainId: 4663, usdgToken: PIN.usdg, entries });
    assert.equal(
      JSON.stringify(h),
      JSON.stringify({ format: "merrymen-journal", version: 1, agentId: ACCT, epoch: 2, chainId: 4663, usdgToken: PIN.usdg, records: 3 }),
    );
  });

  it("a perp record, a perp term on a mark, or a venue account makes it v2 — carrying the PINNED venue", () => {
    const withKind = exportHeader({ agentId: ACCT, epoch: 2, chainId: 4663, usdgToken: PIN.usdg, entries: chain([funding]) });
    assert.equal(withKind.format, JOURNAL_FORMAT_V2);
    assert.equal(withKind.version, 2);
    assert.deepEqual(withKind.venue, { venue: "lighter-rh", l2ChainId: 466_324, proxy: PIN.proxy, accountIndex: null });
    assert.ok(journalHasPerps(chain([perpMark()])));
    assert.ok(!journalHasPerps(chain([flowIn, { kind: "mark", payload: { equityUsdg: 1 } }])));
    // Collateral carried into an epoch with no perp record of its own yet.
    const carried = exportHeader({ agentId: ACCT, epoch: 3, chainId: 4663, usdgToken: PIN.usdg, entries: [], perpAccount: { accountIndex: 22_149 } });
    assert.equal(carried.format, JOURNAL_FORMAT_V2);
    assert.equal((carried.venue as { accountIndex: number }).accountIndex, 22_149);
  });

  it("READS v1 and v2, and REFUSES (never fails) a format, version or venue it does not know", () => {
    assert.deepEqual(readExportHeader({ format: JOURNAL_FORMAT_V1, version: 1 }), { ok: true, version: 1, venue: null });
    assert.deepEqual(readExportHeader({ format: JOURNAL_FORMAT_V1 }), { ok: true, version: 1, venue: null });
    const v2 = readExportHeader(exportHeader({ agentId: ACCT, epoch: 2, chainId: 4663, usdgToken: PIN.usdg, entries: [], perpAccount: { accountIndex: 7 } }));
    assert.ok(v2.ok && v2.version === 2 && v2.venue?.accountIndex === 7 && v2.venue.proxy === PIN.proxy);
    const good = { format: JOURNAL_FORMAT_V2, version: 2, venue: { venue: "lighter-rh", l2ChainId: 466_324, proxy: PIN.proxy, accountIndex: null } };
    const refused = (h: Record<string, unknown>) => {
      const r = readExportHeader(h);
      assert.equal(r.ok, false, JSON.stringify(h));
      return r.ok ? "" : r.why;
    };
    assert.match(refused({ format: JOURNAL_FORMAT_V1, version: 2 }), /reads version 1/);
    assert.match(refused({ ...good, version: 3 }), /reads version 2/);
    assert.match(refused({ format: "merrymen-journal-v3", version: 3 }), /not a merrymen journal export this verifier knows/);
    assert.match(refused({ format: JOURNAL_FORMAT_V2, version: 2 }), /name its venue/);
    assert.match(refused({ ...good, venue: { ...good.venue, venue: "lighter-eth" } }), /does not know/);
    assert.match(refused({ ...good, venue: { ...good.venue, proxy: STRANGER } }), /pinned one is/);
    assert.match(refused({ ...good, venue: { ...good.venue, l2ChainId: 304 } }), /L2 chain/);
    assert.match(refused({ ...good, venue: { ...good.venue, accountIndex: -1 } }), /not an account index/);
    // Case never matters for the address.
    assert.ok(readExportHeader({ ...good, venue: { ...good.venue, proxy: LIGHTER_ROUTE_V1.proxy.toUpperCase().replace("0X", "0x") } }).ok);
  });
});

describe("reconstruct and reconcile a perp book", () => {
  it("A PERP BOOK THAT ADDS UP IS CHECKED AND HOLDS — composition and envelope, perp terms included", () => {
    const book = reconstruct(chain(PERP_BOOK), { version: 2 });
    assert.equal(book.perpRealizedUsdg, 20);
    assert.equal(book.perpFundingUsdg, -1.5);
    assert.equal(book.perpFeesUsdg, 0);
    assert.equal(book.unknownRecords?.length, 0);
    const r = reconcile(book);
    assert.deepEqual(r.findings, []);
    assert.equal(r.checked, true);
    assert.ok(Math.abs(r.residualUsdg! - 5) < 1e-9, "the residual is the venue's unrealized, and the spot half is zero");
  });

  it("VENUE-ATTESTED IS ITS OWN CLASS — fills, funding and the venue's steps; the chain steps are chain refs", () => {
    const book = reconstruct(chain(PERP_BOOK), { version: 2 });
    assert.deepEqual(
      book.venueAttested?.map((v) => [v.seq, v.kind]),
      [[3, "margin"], [4, "perp-fill"], [5, "perp-fill"], [6, "funding"], [7, "perp-fill"]],
    );
    assert.deepEqual(book.chainRefs.map((c) => [c.seq, c.kind, c.txHash]), [[1, "flow", flowIn.payload.txHash], [2, "margin", DEP_TX]]);
    assert.equal(book.unanchored.length, 0, "venue records are not 'unanchored' — they have an anchor, the venue's");
    assert.ok(book.chainRefs.every((c) => /^0x[0-9a-f]{64}$/i.test(c.txHash)), "no 80-hex Lighter hash is ever an RPC question");
  });

  it("a payout's chain step is the payout transaction; a withdrawal's L2 request is the venue's word", () => {
    const executed = { direction: "withdraw", from: "submitted", to: "executed", venueTxHash: L2_HASH, txHash: null, paidTxHash: null, mode: "live", amountMicro: "5000000" };
    const paid = { ...executed, from: "executed", to: "paid", paidTxHash: PAY_TX };
    assert.equal(marginChainHash(executed), null);
    assert.equal(marginChainHash(paid), PAY_TX);
    const book = reconstruct(chain([{ kind: "margin", payload: executed }, { kind: "margin", payload: paid }]), { version: 2 });
    assert.deepEqual(book.venueAttested?.map((v) => v.seq), [1]);
    assert.deepEqual(book.chainRefs.map((c) => [c.seq, c.txHash]), [[2, PAY_TX]]);
  });

  it("paper perps are simulated — unanchored, like a paper fill", () => {
    const book = reconstruct(chain([fill({ mode: "paper" }), { kind: "funding", payload: { ...funding.payload, mode: "paper" } }]), { version: 2 });
    assert.deepEqual(book.unanchored.map((u) => u.kind), ["perp-fill", "funding"]);
    assert.equal(book.venueAttested?.length, 0);
  });

  it("THE COMPOSITION INCLUDES THE VENUE: a mark whose total does not equal its six terms FAILS", () => {
    const r = reconcile(reconstruct(chain([...PERP_BOOK.slice(0, -1), perpMark({ equityUsdg: 1033.5 })]), { version: 2 }));
    assert.ok(r.findings.some((f) => f.check === "arithmetic" && /at Lighter/.test(f.detail)), JSON.stringify(r.findings));
  });

  it("the envelope includes the venue's money: a perp gain nobody booked is money from nowhere", () => {
    // The closing fill's +20 left out of the journal: equity has it, the record does not.
    const r = reconcile(reconstruct(chain(PERP_BOOK.filter((p) => p !== closeFill)), { version: 2 }));
    assert.ok(r.findings.some((f) => /exceeds what the record can explain/.test(f.detail)), JSON.stringify(r.findings));
  });

  it("the peak term must be what it claims: an open gain below the net unrealized FAILS", () => {
    const r = reconcile(reconstruct(chain([...PERP_BOOK.slice(0, -1), perpMark({ perpUnrealizedGainMicro: "4000000" })]), { version: 2 }));
    assert.ok(r.findings.some((f) => /open perp gain/.test(f.detail)));
  });

  it("UNKNOWN IS NEVER ZERO: a v2 mark missing a venue term, or a fill with no realized figure, leaves it unchecked — not failed", () => {
    const { perpInTransitMicro: _t, ...noTransit } = perpMark().payload;
    const missing = reconcile(reconstruct(chain([...PERP_BOOK.slice(0, -1), { kind: "mark", payload: noTransit }]), { version: 2 }));
    assert.equal(missing.checked, false);
    assert.deepEqual(missing.findings, []);
    const underived = reconcile(reconstruct(chain(PERP_BOOK.map((p) => (p === closeFill ? fill({ ...closeFill.payload, realizedMicro: null }) : p))), { version: 2 }));
    assert.equal(underived.checked, false);
    assert.deepEqual(underived.findings, [], "a figure not yet derived is not a figure that is wrong");
  });

  it("a position carried in at mark leaves the envelope unchecked (its P&L runs from the carry, the venue's U from its entry)", () => {
    const carry = { kind: "perp-carry", payload: { base: "20000", entryQuoteMicro: "23000000", market: "BTC-PERP", marketId: 1, markPrice: "11500000", mode: "live", side: "long" } };
    const r = reconcile(reconstruct(chain([carry, ...PERP_BOOK]), { version: 2 }));
    assert.equal(r.checked, false);
    assert.deepEqual(r.findings, []);
  });
});

describe("a kind this verifier does not know is refused, never skipped", () => {
  it("AN UNKNOWN KIND IS LISTED AND THE ARITHMETIC IS NOT JUDGED — no pass, no false accusation", () => {
    const book = reconstruct(chain([flowIn, { kind: "perp-rebate", payload: { amountMicro: "5" } }, perpMark()]), { version: 2 });
    assert.deepEqual(book.unknownRecords?.map((u) => [u.seq, u.kind]), [[2, "perp-rebate"]]);
    const r = reconcile(book);
    assert.equal(r.checked, false);
    assert.equal(r.residualUsdg, null);
    assert.deepEqual(r.findings, []);
    assert.match(r.note, /does not understand/);
  });

  it("A PERP RECORD IN A V1 EXPORT IS REFUSED — only v2 carries them — and so is a perp term on a v1 mark", () => {
    assert.deepEqual(reconstruct(chain([flowIn, funding])).unknownRecords?.map((u) => u.kind), ["funding"]);
    assert.deepEqual(reconstruct(chain([flowIn, perpMark()])).unknownRecords?.map((u) => u.kind), ["mark"]);
  });

  it("the fee accrual is a kind this verifier KNOWS — it is not in the equity identity, and it is not refused", () => {
    assert.equal(reconstruct(chain([flowIn, { kind: "fee", payload: { feeUsdg: 1 } }])).unknownRecords?.length, 0);
  });
});

describe("a tampered perp fill", () => {
  it("BREAKS THE HASH CHAIN — a venue-attested record is still a chained one", () => {
    const entries = chain(PERP_BOOK);
    assert.deepEqual(verifyChain(entries), []);
    const edited = entries.map((e) =>
      e.seq === 5 ? { ...e, payload_json: e.payload_json.replace('"realizedMicro":"20000000"', '"realizedMicro":"90000000"') } : e,
    );
    assert.notEqual(edited[4]!.payload_json, entries[4]!.payload_json, "sanity: the edit landed");
    const f = verifyChain(edited);
    assert.ok(f.some((x) => x.check === "chain" && x.seq === 5), JSON.stringify(f));
  });
});

describe("a v1 book's verdicts are unchanged", () => {
  it("reconstruct and reconcile of a spot book give what they always did, with or without the version said", () => {
    const spot = chain([
      flowIn,
      { kind: "fill", payload: { amountUsdg: 50, fillSide: "buy", realizedPnlUsdg: null, status: "landed", txHash: hash64(1) } },
      { kind: "mark", payload: { equityUsdg: 1002, cashUsdg: 950, positionsUsdg: 52, vaultUsdg: 0, quarantinedCostUsdg: 0 } },
    ]);
    const a = reconcile(reconstruct(spot));
    const b = reconcile(reconstruct(spot, { version: 1 }));
    assert.deepEqual(a, b);
    assert.equal(a.checked, true);
    assert.deepEqual(a.findings, []);
    assert.equal(a.residualUsdg, 2);
    assert.doesNotMatch(a.note, /perp/, "the note a spot book has always printed");
  });
});

// ── margin against its receipt ──────────────────────────────────────────────

const word = (v: bigint | string) => (typeof v === "string" ? v.toLowerCase().replace(/^0x/, "") : v.toString(16)).padStart(64, "0");
const transfer = (from: string, to: string, amount: bigint, i: number) => ({
  address: PIN.usdg,
  topics: [TRANSFER_TOPIC, `0x${word(from)}`, `0x${word(to)}`],
  data: `0x${word(amount)}`,
  logIndex: `0x${i.toString(16)}`,
});
const depositLog = (to: string, amount: bigint, i: number, accountIndex = 22_149n) => ({
  address: PIN.proxy,
  topics: [PIN.depositTopic],
  data: `0x${word(accountIndex)}${word(to)}${word(3n)}${word(0n)}${word(amount)}`,
  logIndex: `0x${i.toString(16)}`,
});
const wpLog = (owner: string, amount: bigint, i: number) => ({
  address: PIN.proxy,
  topics: [PIN.withdrawPendingTopic, `0x${word(owner)}`],
  data: `0x${word(3n)}${word(amount)}`,
  logIndex: `0x${i.toString(16)}`,
});
const check = (payload: Record<string, unknown>, receipt: FetchedReceipt, v: VerifiedVenue | null = venue()) =>
  compareRecord({ seq: 9, kind: "margin", payload, receipt, account: ACCT, usdgToken: PIN.usdg, venue: v });

describe("margin is checked against Robinhood Chain, by the verifier's own decoder", () => {
  const AMT = 300_000_000n;
  const depositReceipt: FetchedReceipt = { status: "0x1", logs: [transfer(ACCT, PIN.proxy, AMT, 2), depositLog(ACCT, AMT, 4)] };

  it("CONFIRMS a deposit the proxy credited to this account, at the log the record names", () => {
    assert.deepEqual(check(marginLanded.payload, depositReceipt), []);
  });

  it("CATCHES a deposit the proxy credited to SOMEBODY ELSE — the money left the book", () => {
    const f = check(marginLanded.payload, { status: "0x1", logs: [transfer(ACCT, PIN.proxy, AMT, 2), depositLog(STRANGER, AMT, 4)] });
    assert.match(f[0]?.detail ?? "", /credits 0x7777/);
  });

  it("catches a deposit with no Deposit event, the wrong venue account, or the wrong amount", () => {
    assert.equal(check(marginLanded.payload, { status: "0x1", logs: [transfer(ACCT, PIN.proxy, AMT, 2)] }).length, 1);
    assert.equal(check(marginLanded.payload, { status: "0x1", logs: [transfer(ACCT, PIN.proxy, AMT, 2), depositLog(ACCT, AMT, 4, 999n)] }).length, 1);
    assert.equal(check(marginLanded.payload, { status: "0x1", logs: [transfer(ACCT, PIN.proxy, AMT - 1n, 2), depositLog(ACCT, AMT - 1n, 4)] }).length, 1);
    // A Deposit from any address but the pinned proxy is not the venue's.
    assert.equal(
      check(marginLanded.payload, { status: "0x1", logs: [transfer(ACCT, PIN.proxy, AMT, 2), { ...depositLog(ACCT, AMT, 4), address: STRANGER }] }).length,
      1,
    );
  });

  it("CONFIRMS a relayer payout naming this account, batched with another owner's", () => {
    const paid = { direction: "withdraw", from: "executed", to: "paid", amountMicro: "8085000000", paidTxHash: PAY_TX, mode: "live" };
    const receipt: FetchedReceipt = {
      status: "0x1",
      logs: [transfer(PIN.proxy, STRANGER, 2_457_020_000n, 10), wpLog(STRANGER, 2_457_020_000n, 11), transfer(PIN.proxy, ACCT, 8_085_000_000n, 12), wpLog(ACCT, 8_085_000_000n, 13)],
    };
    assert.deepEqual(check(paid, receipt), []);
    // No WithdrawPending naming us: not a payout to this account.
    assert.equal(check(paid, { status: "0x1", logs: [transfer(PIN.proxy, ACCT, 8_085_000_000n, 12)] }).length, 1);
    // Events and money disagree.
    assert.equal(check(paid, { status: "0x1", logs: [transfer(PIN.proxy, ACCT, 1n, 12), wpLog(ACCT, 8_085_000_000n, 13)] }).length, 1);
  });

  it("a margin record with no venue to check it against is a finding, never a pass", () => {
    assert.match(check(marginLanded.payload, depositReceipt, null)[0]?.detail ?? "", /names no venue/);
  });
});

// ── the command itself ──────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(path.join(os.tmpdir(), "merrymen-verify-perps-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** Run `verify` on an export exactly as an auditor would, and return its exit code and output. */
function verify(header: Record<string, unknown>, entries: ExportedEntry[]): { code: number | null; out: string } {
  const file = path.join(scratch, `ledger-${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(file, [JSON.stringify(header), ...entries.map((e) => JSON.stringify(e))].join("\n") + "\n");
  const r = spawnSync(process.execPath, ["--import", "tsx", path.join(HERE, "audit-cli.ts"), "verify", file], {
    encoding: "utf8",
    env: { ...process.env, MERRYMEN_HOME: path.join(scratch, "home") },
    timeout: 60_000,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
const v2Header = (entries: ExportedEntry[]) =>
  exportHeader({ agentId: ACCT, epoch: 2, chainId: 4663, usdgToken: PIN.usdg, entries, perpAccount: { accountIndex: 22_149 } });

describe("the verify command's verdicts", () => {
  it("A SYNTHETIC V2 BOOK THAT ADDS UP: arithmetic HELD, venue records named, INDETERMINATE (2) — never failed", () => {
    const entries = chain(PERP_BOOK);
    const { code, out } = verify(v2Header(entries), entries);
    assert.equal(code, 2, out);
    assert.match(out, /portfolio arithmetic truth\s+HELD/);
    assert.match(out, /VENUE-ATTESTED/);
    assert.match(out, /venue-attested record\(s\) \(Lighter\) not checked/);
    assert.doesNotMatch(out, /verdict: FAILED/);
  });

  it("A TAMPERED PERP FILL FAILS (1) — the hash chain", () => {
    const entries = chain(PERP_BOOK).map((e) =>
      e.seq === 5 ? { ...e, payload_json: e.payload_json.replace('"realizedMicro":"20000000"', '"realizedMicro":"90000000"') } : e,
    );
    const { code, out } = verify(v2Header(entries), entries);
    assert.equal(code, 1, out);
    assert.match(out, /verdict: FAILED/);
  });

  it("AN UNKNOWN KIND IS REFUSED WITH A MESSAGE (2) — not skipped, not failed", () => {
    const entries = chain([flowIn, { kind: "perp-rebate", payload: { amountMicro: "5" } }, perpMark()]);
    const { code, out } = verify(v2Header(entries), entries);
    assert.equal(code, 2, out);
    assert.match(out, /does not understand/);
    assert.match(out, /perp-rebate/);
    assert.doesNotMatch(out, /verdict: FAILED/);
  });

  it("A FORMAT THIS VERIFIER DOES NOT KNOW IS REFUSED (2), never failed (1)", () => {
    const { code, out } = verify({ format: "merrymen-journal-v9", version: 9 }, []);
    assert.equal(code, 2, out);
    assert.match(out, /INDETERMINATE/);
  });

  it("A V1 BOOK'S VERDICT IS UNCHANGED — the spot book that holds is still exit 2 without --rpc, and one that does not add up is still 1", () => {
    const spot = [flowIn, { kind: "mark", payload: { equityUsdg: 1000, cashUsdg: 1000, positionsUsdg: 0, vaultUsdg: 0, quarantinedCostUsdg: 0 } }];
    const entries = chain(spot);
    const header = exportHeader({ agentId: ACCT, epoch: 2, chainId: 4663, usdgToken: PIN.usdg, entries });
    assert.equal(header.format, JOURNAL_FORMAT_V1);
    const ok = verify(header, entries);
    assert.equal(ok.code, 2, ok.out);
    assert.match(ok.out, /portfolio arithmetic truth\s+HELD/);
    assert.doesNotMatch(ok.out, /VENUE-ATTESTED|perps:/);
    const bad = chain([flowIn, { kind: "mark", payload: { equityUsdg: 1500, cashUsdg: 1000, positionsUsdg: 0, vaultUsdg: 0, quarantinedCostUsdg: 0 } }]);
    assert.equal(verify(header, bad).code, 1);
  });
});
