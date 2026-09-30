/**
 * LIGHTER PAYOUTS, FROM THE CHAIN (payouts.ts; docs/perps.md rule 12).
 *
 * What each block pins, and why it is load-bearing:
 *   the fold    — only WithdrawPending(owner = this account, asset 3) counts,
 *                 over exactly (cursor, N]; reorged-out logs and other assets
 *                 are dropped; a window not fully read, or an answer to some
 *                 other question, is `complete: false` — unknown, never 0.
 *   the ledger  — against a REAL sqlite ledger, because "each row in one db.tx
 *                 with its margin journal entry" and "UNIQUE on the payout's
 *                 chain identity" are properties of the store, not of a fake:
 *                 a relayer batch pays two withdrawals, excess is the owner's
 *                 and alerted, a re-read books nothing, and a crash between
 *                 writes leaves rows owed rather than money counted twice.
 *   in transit  — T_in / T_out from the open rows, less what already arrived,
 *                 and a pending balance above T_out is a book gap.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { encodeAbiParameters, type Hex } from "viem";
import { LIGHTER_ROUTE_V1 } from "../../../packages/core/src/index";
import { verifyChain } from "../audit";
import type { RawLog } from "../inflight-reconcile";
import { PAYOUT_MAX_SPAN, foldPayouts, inTransit, payoutKey, payoutStoreFor, recordPayouts, type Payout, type PayoutStore } from "./payouts";

const SELF = "0x3333333333333333333333333333333333333333" as `0x${string}`;
const OTHER = "0x4444444444444444444444444444444444444444" as `0x${string}`;
const PROXY = LIGHTER_ROUTE_V1.proxy;
const T0 = LIGHTER_ROUTE_V1.topics.withdrawPending;
const pad = (a: string) => `0x${"0".repeat(24)}${a.slice(2).toLowerCase()}` as Hex;
const hex = (n: number | bigint) => `0x${n.toString(16)}` as Hex;
const txh = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;
const USDG = (n: number) => BigInt(Math.round(n * 1_000_000));

function wpLog(o: { block: number; index: number; tx?: number; amount: bigint; asset?: number; owner?: string; removed?: boolean; address?: string }): RawLog & { removed?: boolean; address?: string } {
  return {
    address: o.address ?? PROXY,
    topics: [T0, pad(o.owner ?? SELF)],
    data: encodeAbiParameters([{ type: "uint16" }, { type: "uint128" }], [o.asset ?? 3, o.amount]),
    transactionHash: txh(o.tx ?? o.block * 100 + o.index),
    blockNumber: hex(o.block),
    logIndex: hex(o.index),
    ...(o.removed === undefined ? {} : { removed: o.removed }),
  };
}

type GetLogsArgs = { address: `0x${string}`; fromBlock: bigint; toBlock: bigint; topics: (Hex | Hex[] | null)[] };
function fakeChain(logs: RawLog[], opts: { fail?: (a: GetLogsArgs) => Error | null } = {}) {
  const calls: GetLogsArgs[] = [];
  const getLogs = async (a: GetLogsArgs) => {
    calls.push(a);
    const err = opts.fail?.(a) ?? null;
    if (err) throw err;
    // A provider answers what the filter asked — within the range; the fold
    // re-checks topics itself, so these fakes may return strays on purpose.
    return logs.filter((l) => {
      const b = BigInt(l.blockNumber as string);
      return b >= a.fromBlock && b <= a.toBlock;
    });
  };
  return { calls, getLogs };
}

const fold = (logs: RawLog[], from = 100n, to = 200n, over: Partial<Parameters<typeof foldPayouts>[0]> = {}) => {
  const c = fakeChain(logs);
  return foldPayouts({ getLogs: c.getLogs, proxy: PROXY, account: SELF, fromBlockExclusive: from, toBlockInclusive: to, ...over }).then((r) => ({ r, calls: c.calls }));
};

describe("foldPayouts: WithdrawPending to this account, over exactly (cursor, N]", () => {
  it("asks for the proxy's WithdrawPending with owner = pad32(self), from cursor + 1 to N", async () => {
    const { r, calls } = await fold([wpLog({ block: 150, index: 2, amount: USDG(10) })]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.address, PROXY);
    assert.deepEqual(calls[0]!.topics, [T0.toLowerCase(), pad(SELF)]);
    assert.equal(calls[0]!.fromBlock, 101n);
    assert.equal(calls[0]!.toBlock, 200n);
    assert.deepEqual(r, {
      complete: true,
      payouts: [{ txHash: txh(15002), logIndex: 2, blockNumber: 150n, amountMicro: USDG(10) }],
      sumMicro: USDG(10),
      scannedTo: 200n,
    });
  });

  it("orders by chain position, sums, drops removed logs, other assets and zero amounts", async () => {
    const { r } = await fold([
      wpLog({ block: 180, index: 0, amount: USDG(1) }),
      wpLog({ block: 120, index: 7, amount: USDG(2) }),
      wpLog({ block: 120, index: 3, amount: USDG(4) }),
      wpLog({ block: 130, index: 1, amount: USDG(100), removed: true }), // reorged out
      wpLog({ block: 140, index: 1, amount: 10n ** 18n, asset: 1 }), // ETH, not margin of ours
      wpLog({ block: 141, index: 1, amount: 0n }),
      wpLog({ block: 142, index: 1, amount: USDG(8), removed: false }),
    ]);
    assert.equal(r.complete, true);
    if (!r.complete) return;
    assert.deepEqual(r.payouts.map((p) => [p.blockNumber, p.logIndex, p.amountMicro]), [
      [120n, 3, USDG(4)],
      [120n, 7, USDG(2)],
      [142n, 1, USDG(8)],
      [180n, 0, USDG(1)],
    ]);
    assert.equal(r.sumMicro, USDG(15));
  });

  it("multiplies by the asset's tick size", async () => {
    const { r } = await fold([wpLog({ block: 150, index: 0, amount: 7n })], 100n, 200n, { tickSize: 1000 });
    assert.equal(r.complete && r.sumMicro, 7000n);
  });

  it("pages at most 10,000,000 blocks a call, and halves on a range error without skipping a block", async () => {
    const { calls } = await fold([], 0n, 25_000_000n);
    assert.deepEqual(calls.map((c) => [c.fromBlock, c.toBlock]), [
      [1n, 10_000_000n],
      [10_000_001n, 20_000_000n],
      [20_000_001n, 25_000_000n],
    ]);
    const c = fakeChain([wpLog({ block: 60, index: 0, amount: USDG(3) })], { fail: (a) => (a.toBlock - a.fromBlock >= 50n ? new Error("block range too large") : null) });
    const r = await foldPayouts({ getLogs: c.getLogs, proxy: PROXY, account: SELF, fromBlockExclusive: 0n, toBlockInclusive: 100n });
    assert.equal(r.complete && r.sumMicro, USDG(3));
    const covered = c.calls.filter((x) => x.toBlock - x.fromBlock < 50n);
    assert.equal(covered[0]!.fromBlock, 1n);
    assert.equal(covered.at(-1)!.toBlock, 100n);
    for (let i = 1; i < covered.length; i++) assert.equal(covered[i]!.fromBlock, covered[i - 1]!.toBlock + 1n, "contiguous");
  });

  it("a window it could not read in full is complete: false — never 'no payouts'", async () => {
    const c = fakeChain([], { fail: () => new Error("boom") });
    const r = await foldPayouts({ getLogs: c.getLogs, proxy: PROXY, account: SELF, fromBlockExclusive: 100n, toBlockInclusive: 200n });
    assert.equal(r.complete, false);
    assert.equal("sumMicro" in r, false, "no sum to misread as zero");
  });

  it("an answer to another question is complete: false — never 'that log did not count'", async () => {
    for (const stray of [
      wpLog({ block: 150, index: 0, amount: USDG(1), owner: OTHER }),
      wpLog({ block: 150, index: 0, amount: USDG(1), address: OTHER }),
      { ...wpLog({ block: 150, index: 0, amount: USDG(1) }), topics: [T0] as Hex[] },
      { ...wpLog({ block: 150, index: 0, amount: USDG(1) }), data: "0x01" as Hex },
      { ...wpLog({ block: 150, index: 0, amount: USDG(1) }), data: `0x${"ff".repeat(64)}` as Hex },
      { ...wpLog({ block: 150, index: 0, amount: USDG(1) }), logIndex: undefined },
      { ...wpLog({ block: 150, index: 0, amount: USDG(1) }), transactionHash: "0x12" as Hex },
      { ...wpLog({ block: 150, index: 0, amount: USDG(1) }), removed: "yes" as unknown as boolean },
    ]) {
      const { r } = await fold([stray]);
      assert.equal(r.complete, false, JSON.stringify(stray, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    }
    // A log outside the window the provider was asked for.
    const c = { getLogs: async () => [wpLog({ block: 250, index: 0, amount: USDG(1) })] };
    const r = await foldPayouts({ getLogs: c.getLogs, proxy: PROXY, account: SELF, fromBlockExclusive: 100n, toBlockInclusive: 200n });
    assert.equal(r.complete, false);
  });

  it("the same log twice is one payout; two different bodies at one position is a bad answer", async () => {
    const a = wpLog({ block: 150, index: 0, amount: USDG(1) });
    const { r } = await fold([a, a]);
    assert.equal(r.complete && r.payouts.length, 1);
    const { r: bad } = await fold([a, { ...a, data: encodeAbiParameters([{ type: "uint16" }, { type: "uint128" }], [3, USDG(2)]) }]);
    assert.equal(bad.complete, false);
  });

  it("a reading behind the cursor is unknown; one AT the cursor is an empty window", async () => {
    assert.equal((await fold([], 200n, 199n)).r.complete, false);
    const { r, calls } = await fold([], 200n, 200n);
    assert.deepEqual(r, { complete: true, payouts: [], sumMicro: 0n, scannedTo: 200n });
    assert.equal(calls.length, 0);
  });

  it("caller bugs throw before anything is read: another proxy, a page over 10M blocks", async () => {
    await assert.rejects(fold([], 100n, 200n, { proxy: OTHER }), /not the Lighter proxy/);
    await assert.rejects(fold([], 100n, 200n, { maxSpan: PAYOUT_MAX_SPAN + 1n }), /outside/);
    await assert.rejects(fold([], 100n, 200n, { tickSize: 0 }), /not positive/);
  });
});

describe("inTransit: rule 12b at block N", () => {
  const row = (direction: "deposit" | "withdraw", state: string, amountMicro: bigint) => ({ direction, state, amountMicro }) as never;
  it("T_in is landed deposits; T_out is executed withdrawals; submitted money has not left anywhere", () => {
    const t = inTransit({
      openTransfers: [row("deposit", "landed", USDG(10)), row("deposit", "submitted", USDG(99)), row("withdraw", "executed", USDG(5)), row("withdraw", "submitted", USDG(77))],
      pendingBalanceMicro: USDG(5),
    });
    assert.deepEqual(t, { tInMicro: USDG(10), tOutMicro: USDG(5), gap: false, why: null });
  });
  it("what already arrived toward a withdrawal (the carry) is not also in transit", () => {
    const t = inTransit({ openTransfers: [row("withdraw", "executed", USDG(10))], pendingBalanceMicro: USDG(6), carriedPayoutMicro: USDG(4) });
    assert.deepEqual(t, { tInMicro: 0n, tOutMicro: USDG(6), gap: false, why: null });
    assert.equal(inTransit({ openTransfers: [], pendingBalanceMicro: 0n, carriedPayoutMicro: USDG(4) }).tOutMicro, 0n, "never below zero");
  });
  it("pending above T_out is a withdrawal the ledger never recorded: a book gap", () => {
    assert.deepEqual(inTransit({ openTransfers: [], pendingBalanceMicro: 1n }), { tInMicro: 0n, tOutMicro: 0n, gap: true, why: "pending-exceeds-transit" });
    assert.equal(inTransit({ openTransfers: [row("withdraw", "executed", USDG(5))], pendingBalanceMicro: USDG(5) + 1n }).gap, true);
    // A withdrawal the venue executed while its row still reads submitted: a gap until the row moves — unknown is not zero.
    assert.equal(inTransit({ openTransfers: [row("withdraw", "submitted", USDG(5))], pendingBalanceMicro: USDG(5) }).gap, true);
  });
  it("pending unread is a gap; nothing pending and nothing open is not", () => {
    assert.deepEqual(inTransit({ openTransfers: [], pendingBalanceMicro: null }), { tInMicro: 0n, tOutMicro: 0n, gap: true, why: "pending-unread" });
    assert.deepEqual(inTransit({ openTransfers: [], pendingBalanceMicro: 0n }), { tInMicro: 0n, tOutMicro: 0n, gap: false, why: null });
  });
  it("a row that is not money throws", () => {
    assert.throws(() => inTransit({ openTransfers: [row("withdraw", "executed", 0n)], pendingBalanceMicro: 0n }));
    assert.throws(() => inTransit({ openTransfers: [], pendingBalanceMicro: 0n, carriedPayoutMicro: -1n }));
  });
});

// ── the ledger, against a real sqlite store ─────────────────────────────────

const scratch = mkdtempSync(path.join(os.tmpdir(), "merrymen-perp-payouts-"));
const isolatedCwd = path.join(scratch, "cwd");
mkdirSync(isolatedCwd);
process.env.MERRYMEN_HOME = path.join(scratch, "home");
delete process.env.DATABASE_URL;
const originalCwd = process.cwd();
const store = await import("../store");
try {
  process.chdir(isolatedCwd);
  await store.initStore();
} finally {
  process.chdir(originalCwd);
}
after(() => {
  store.closeStoreForTest();
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

let nextAgent = 1;
async function agent(): Promise<string> {
  const account = `0xAb${(nextAgent++).toString(16).padStart(38, "0")}`;
  return store.ensureAgent({
    smartAccount: account,
    owner: "0x00000000000000000000000000000000000000b1",
    sessionKeyAddress: "0x00000000000000000000000000000000000000c1",
    serialized: "x",
    caps: { perTradeUsdg: 50, dailyUsdg: 500, expiryDays: 14, maxDrawdownPct: 10, maxOpsPerDay: 48 },
    grantedAt: 1_000_000,
    expiresAt: 2_000_000_000,
    chainId: 4663,
  } as never);
}

/** A withdrawal we requested: persisted before its L2 Withdraw was sent, then (usually) executed. Ids sort in creation order. */
async function requested(agentId: string, id: string, amount: bigint, state: "submitted" | "executed" = "executed", initiator: "agent" | "standdown" = "agent") {
  // Row ids are global: each agent's are prefixed with its own tail, and `bare` strips it for the assertions.
  const tail = agentId.slice(-8).toLowerCase();
  const r = await store.upsertPerpTransfer({
    agentId,
    mode: "live",
    id: `${tail}:${id}`,
    direction: "withdraw",
    amountMicro: amount,
    initiator,
    state,
    venueTxHash: `${tail}${id.replace(/[^0-9a-f]/g, "")}`.padStart(80, "0"),
  });
  assert.equal(r.outcome, "inserted");
}
const bare = (id: string) => id.slice(id.indexOf(":") + 1);
const payout = (n: number, amount: bigint, block = 1000 + n, logIndex = n): Payout => ({ txHash: txh(0xbeef00 + n), logIndex, blockNumber: BigInt(block), amountMicro: amount });
const rows = (agentId: string) => store.listOpenPerpTransfers(agentId, "live");
const rowIds = async (agentId: string) => (await rows(agentId)).map((x) => bare(x.id));
const ps = (agentId: string) => payoutStoreFor(agentId, store);
const journalOf = async (agentId: string) => store.readJournal(agentId, 1);

describe("recordPayouts: in aggregate, oldest first, once", () => {
  it("a relayer batch claim that pays two withdrawals at once: both paid, each with its own margin entry", async () => {
    const id = await agent();
    await requested(id, "w-1", USDG(10));
    await requested(id, "w-2", USDG(5), "executed", "standdown");
    const p = payout(1, USDG(15));
    const r = await recordPayouts(ps(id), [p]);
    assert.deepEqual(r.paid.map((x) => [bare(x.transferId), x.amountMicro, x.by]), [
      ["w-1", USDG(10), payoutKey(p)],
      ["w-2", USDG(5), payoutKey(p)],
    ]);
    assert.equal(r.excessMicro, 0n);
    assert.equal(r.alert, false);
    assert.equal(r.carryMicro, 0n);
    assert.deepEqual(await rows(id), [], "nothing left in transit");
    const journal = await journalOf(id);
    // Born executed (one entry each), then executed → paid (one each).
    const paid = journal.filter((e) => e.kind === "margin" && (JSON.parse(e.payload_json) as { to: string }).to === "paid");
    assert.equal(paid.length, 2);
    for (const e of paid) {
      const pl = JSON.parse(e.payload_json) as { paidTxHash: string; paidLogIndex: number; from: string };
      assert.equal(pl.paidTxHash, p.txHash, "verify checks each row against the payout's receipt");
      assert.equal(pl.from, "executed");
    }
    assert.deepEqual(verifyChain(journal), []);
    assert.equal(inTransit({ openTransfers: await rows(id), pendingBalanceMicro: 0n }).gap, false);
  });

  it("a re-read books nothing: the payout's chain identity is already claimed", async () => {
    const id = await agent();
    await requested(id, "w-1", USDG(10));
    await requested(id, "w-2", USDG(5));
    const p = payout(1, USDG(15));
    await recordPayouts(ps(id), [p]);
    // A later withdrawal is owed now: the re-read must not pay it with money that already paid the first two.
    await requested(id, "w-3", USDG(15));
    const before = (await journalOf(id)).length;
    const again = await recordPayouts(ps(id), [p]);
    assert.deepEqual(again.alreadyBooked, [payoutKey(p)]);
    assert.deepEqual(again.paid, []);
    assert.deepEqual(again.excess, []);
    assert.equal((await journalOf(id)).length, before, "no journal entry for a re-read");
    assert.deepEqual(await rowIds(id), ["w-3"], "still owed");
    // And with nothing owed at all, a re-read is not "excess" either.
    const id2 = await agent();
    await requested(id2, "w-1", USDG(10));
    await recordPayouts(ps(id2), [payout(2, USDG(10))]);
    const third = await recordPayouts(ps(id2), [payout(2, USDG(10))]);
    assert.deepEqual(third.alreadyBooked, [payoutKey(payout(2, USDG(10)))]);
    assert.equal(third.alert, false);
  });

  it("payouts in turn pay requests in turn — oldest first", async () => {
    const id = await agent();
    await requested(id, "w-1", USDG(10));
    await requested(id, "w-2", USDG(5));
    const p1 = payout(1, USDG(10));
    const p2 = payout(2, USDG(5));
    const r = await recordPayouts(ps(id), [p2, p1]); // handed out of order; booked in chain order
    assert.deepEqual(r.paid.map((x) => [bare(x.transferId), x.by]), [
      ["w-1", payoutKey(p1)],
      ["w-2", payoutKey(p2)],
    ]);
  });

  it("a withdrawal still reading submitted (its execution unseen) is paid too — the chain outranks the venue's history", async () => {
    const id = await agent();
    await requested(id, "w-1", USDG(3), "submitted");
    const r = await recordPayouts(ps(id), [payout(1, USDG(3))]);
    assert.deepEqual(r.paid.map((x) => bare(x.transferId)), ["w-1"]);
    assert.deepEqual(await rows(id), []);
  });

  it("deposits are never touched", async () => {
    const id = await agent();
    await store.upsertPerpTransfer({ agentId: id, mode: "live", direction: "deposit", amountMicro: USDG(20), initiator: "agent", state: "landed", chainId: 4663, txHash: txh(77), logIndex: 1 });
    const r = await recordPayouts(ps(id), [payout(1, USDG(20))]);
    assert.equal(r.excessMicro, USDG(20), "a payout with no withdrawal owed is the owner's, not the deposit's");
    assert.deepEqual((await rows(id)).map((x) => [x.direction, x.state]), [["deposit", "landed"]]);
  });
});

describe("excess is the owner's: booked, alerted, never capital, never twice", () => {
  it("a payout with nothing owed (an owner's recover) is its own owner-initiated paid withdrawal", async () => {
    const id = await agent();
    const p = payout(1, USDG(7));
    const r = await recordPayouts(ps(id), [p]);
    assert.equal(r.alert, true);
    assert.equal(r.excessMicro, USDG(7));
    const journal = await journalOf(id);
    assert.equal(journal.length, 1);
    const pl = JSON.parse(journal[0]!.payload_json) as Record<string, unknown>;
    assert.equal(pl.direction, "withdraw");
    assert.equal(pl.initiator, "owner");
    assert.equal(pl.to, "paid");
    assert.equal(pl.txHash, p.txHash, "identified by its chain log");
    assert.equal(pl.logIndex, p.logIndex);
    assert.equal(pl.paidTxHash, p.txHash, "and anchored to it for verify");
    assert.equal(pl.chainId, 4663);
    const again = await recordPayouts(ps(id), [p]);
    assert.deepEqual(again.alreadyBooked, [payoutKey(p)]);
    assert.equal(again.alert, false);
    assert.equal((await journalOf(id)).length, 1);
  });

  it("a payout larger than what is owed: the request is paid, the rest is the owner's", async () => {
    const id = await agent();
    await requested(id, "w-1", USDG(10));
    const p = payout(1, USDG(13));
    const r = await recordPayouts(ps(id), [p]);
    assert.deepEqual(r.paid.map((x) => bare(x.transferId)), ["w-1"]);
    assert.equal(r.excessMicro, USDG(3));
    assert.equal(r.alert, true);
    const again = await recordPayouts(ps(id), [p]);
    assert.deepEqual(again.alreadyBooked, [payoutKey(p)]);
    assert.equal(again.excessMicro, 0n);
  });
});

describe("a partial claim: carried, never guessed", () => {
  it("a payout short of the oldest request is carried; the next completes it; a re-supplied carried payout is counted once", async () => {
    const id = await agent();
    await requested(id, "w-1", USDG(10));
    const p1 = payout(1, USDG(4));
    const r1 = await recordPayouts(ps(id), [p1]);
    assert.deepEqual(r1.paid, []);
    assert.equal(r1.carryMicro, USDG(4));
    assert.equal((await journalOf(id)).length, 1, "only the request's own entry: nothing paid yet");
    // In transit: the 4 already home is not also on its way.
    const t = inTransit({ openTransfers: await rows(id), pendingBalanceMicro: USDG(6), carriedPayoutMicro: r1.carryMicro });
    assert.deepEqual([t.tOutMicro, t.gap], [USDG(6), false]);
    const p2 = payout(2, USDG(6));
    // The next fold overlaps: p1 comes back beside the carry that already holds it.
    const r2 = await recordPayouts(ps(id), [p1, p2], { carry: r1.carry });
    assert.deepEqual(r2.paid.map((x) => [bare(x.transferId), x.by]), [["w-1", payoutKey(p2)]]);
    assert.equal(r2.excessMicro, 0n);
    assert.equal(r2.carryMicro, 0n);
    assert.deepEqual(await rows(id), []);
  });

  it("a payout that completes one request and part-pays the next carries only the part", async () => {
    const id = await agent();
    await requested(id, "w-1", USDG(10));
    await requested(id, "w-2", USDG(10));
    const p = payout(1, USDG(14));
    const r = await recordPayouts(ps(id), [p]);
    assert.deepEqual(r.paid.map((x) => bare(x.transferId)), ["w-1"]);
    assert.deepEqual(r.carry.map((c) => [payoutKey(c.payout), c.remainingMicro]), [[payoutKey(p), USDG(4)]]);
    // The rest arrives: w-2 is paid by the payout that completed it, and the
    // carried remainder of p — whose identity w-1 already holds — is not refused for it.
    const q = payout(2, USDG(6));
    const r2 = await recordPayouts(ps(id), [p, q], { carry: r.carry });
    assert.deepEqual(r2.paid.map((x) => [bare(x.transferId), x.by]), [["w-2", payoutKey(q)]]);
    assert.deepEqual(r2.alreadyBooked, []);
    assert.deepEqual(await rows(id), []);
  });

  it("a carry is rejected when it is not part of its payout", async () => {
    const id = await agent();
    await assert.rejects(recordPayouts(ps(id), [], { carry: [{ payout: payout(1, USDG(1)), remainingMicro: USDG(2) }] }), /not part of that payout/);
  });
});

describe("a crash between writes leaves rows owed — never money counted twice", () => {
  it("the claim is written first; after a crash the payout is skipped whole on the re-read", async () => {
    const id = await agent();
    await requested(id, "w-1", USDG(10));
    await requested(id, "w-2", USDG(5));
    const real = ps(id);
    let writes = 0;
    const crashing: PayoutStore = {
      owedWithdrawals: () => real.owedWithdrawals(),
      upsertTransfer: async (t) => {
        if (++writes === 2) throw new Error("process killed");
        return real.upsertTransfer(t);
      },
    };
    const p = payout(1, USDG(15));
    await assert.rejects(recordPayouts(crashing, [p]), /process killed/);
    // w-1 carries the claim; w-2 was never written. A new request arrives.
    await requested(id, "w-3", USDG(5));
    const r = await recordPayouts(real, [p]);
    assert.deepEqual(r.alreadyBooked, [payoutKey(p)]);
    assert.deepEqual(r.paid, [], "w-3 is NOT paid with money that already paid w-1");
    assert.deepEqual(await rowIds(id), ["w-2", "w-3"], "held in transit: the ratchets hold, the alert fires");
  });
});
