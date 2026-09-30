/**
 * THE PERP LEDGER (docs/perps.md, "Ledger", rules 9, 10 and 12), against a real
 * sqlite ledger — the accounting-atomicity harness: an isolated home, the
 * store's own connection, and a second raw connection to inspect the file and
 * inject failures with triggers.
 *
 * What each block pins, and why it is load-bearing:
 *   facts     — a venue fact is booked ONCE however often it is re-read, its
 *               journal entry lands with it or not at all, and a re-read that
 *               disagrees with what was booked says so instead of overwriting.
 *   rule 9    — no nonce is handed out twice, even to concurrent callers; no
 *               order row is written for a nonce that was never reserved; a
 *               final answer is given exactly once.
 *   budgets   — perp orders count against the day's caps after a refresh and
 *               a restart, per rail, by fill once known and by worst notional
 *               until then; exits never count as spend.
 *   paper     — the paper perp book survives a checkpoint round trip whole,
 *               and a reset takes it with the cash.
 *   mirror    — the shared copy moves forward only, never carries the signed
 *               bytes, and copies an unchanged ledger as nothing.
 *   migration — the schema lands over an existing ledger without touching a
 *               row, and every statement translates for Postgres.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import { verifyChain } from "./audit";
import { translateSchema, wrapSqlite, type Db } from "./db";
import { MIRROR_STATE_DDL, mirrorTenant } from "./ledger-mirror";
import {
  mirrorPaperCheckpoints,
  paperCheckpointRejection,
  paperPerpRejection,
  restorePaperCheckpoint,
} from "./paper-checkpoint";
import type { PerpSignedTx } from "./store";
import type { PerpOrderIntent } from "./policy";
import { readFileSync } from "node:fs";
import { createPaperPerpExecutor } from "./perps/executor";
import { parseLighterFeed, specToJson } from "./perps/feed-reader";
import { parseOrderBookDetails } from "./perps/markets";

const scratch = mkdtempSync(path.join(os.tmpdir(), "merrymen-perp-ledger-"));
const isolatedCwd = path.join(scratch, "cwd");
mkdirSync(isolatedCwd);
process.env.MERRYMEN_HOME = path.join(scratch, "home");
delete process.env.DATABASE_URL;
const originalCwd = process.cwd();
const store = await import("./store");
try {
  process.chdir(isolatedCwd);
  await store.initStore();
} finally {
  process.chdir(originalCwd);
}
const raw = new DatabaseSync(path.join(process.env.MERRYMEN_HOME, "merrymen.db"));
const others: DatabaseSync[] = [];

after(() => {
  raw.close();
  for (const o of others) o.close();
  store.closeStoreForTest();
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

let nextAccount = 1;
/**
 * A fresh agent, spelled EIP-55-ish (mixed case) on purpose: the perp tables
 * store it lowercased while the journal must stay under the agents row's own
 * spelling, and a test agent spelled all-lowercase could not tell the two apart.
 */
async function agent(): Promise<string> {
  const hex = (nextAccount++).toString(16).padStart(38, "0");
  const account = `0xAb${hex}`;
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

const now = () => Math.floor(Date.now() / 1000);
const DAY_AGO = () => now() - 86_400;

function count(sql: string, ...args: (string | number)[]): number {
  return Number((raw.prepare(sql).get(...args) as { n: number }).n);
}

function fill(agentId: string, over: Partial<Parameters<typeof store.insertPerpFill>[0]> = {}) {
  return {
    agentId,
    mode: "live" as const,
    venueTradeId: "1150715509",
    sideRole: "bid" as const,
    marketId: 1,
    side: "long" as const,
    role: "taker" as const,
    base: 20_000n,
    price: 11_500_000n,
    quoteMicro: 23_000_000n,
    feeMicro: 0n,
    tradeType: "trade" as const,
    attribution: "intent" as const,
    venueTsMs: 1_790_696_152_553,
    ...over,
  };
}

/** A signed tx as perps/signer.ts returns one: client order indexes derived from the nonce. */
function signed(nonce: bigint, legs: readonly ("entry" | "sl" | "tp" | "close")[], txType = 28): PerpSignedTx {
  const legIndex = { entry: 0n, sl: 1n, tp: 2n, close: 3n } as const;
  return {
    txType,
    txInfo: `{"Nonce":${nonce},"Sig":"c2lnbmF0dXJl"}`,
    txHash: nonce.toString(16).padStart(80, "0"),
    accountIndex: 22_149,
    apiKeyIndex: 16,
    nonce: Number(nonce),
    expiredAt: Number(nonce) + 599_000,
    clientOrderIndexes: legs.map((role) => ({ role, clientOrderIndex: Number(nonce * 8n + legIndex[role]) })),
  };
}

async function liveOpen(agentId: string, worstNotionalMicro: bigint, reduceOnly = false): Promise<{ id: string; nonce: bigint }> {
  const nonce = await store.bumpNonceHighWater(agentId, "live", BigInt(Date.now()));
  const id = await store.insertPerpOrderSubmitted({
    agentId,
    mode: "live",
    effect: reduceOnly ? "close" : "open",
    reduceOnly,
    marketId: 1,
    worstNotionalMicro,
    signed: signed(nonce, reduceOnly ? ["close"] : ["entry", "sl"], reduceOnly ? 14 : 28),
  });
  return { id, nonce };
}

// ── facts: fills, funding, transfers ─────────────────────────────────────────

describe("a venue fact is booked once, with its journal entry", () => {
  it("books a fill once however often it is re-read, and chains it under the agent's own spelling", async () => {
    const id = await agent();
    assert.equal(await store.insertPerpFill(fill(id)), "inserted");
    assert.equal(await store.insertPerpFill(fill(id)), "duplicate");
    assert.equal(await store.insertPerpFill(fill(id, { realizedMicro: 5n })), "duplicate", "our own derivations may differ on a re-read");
    const rows = raw.prepare("SELECT agent_id FROM perp_fills WHERE agent_id = ?").all(id.toLowerCase()) as { agent_id: string }[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.agent_id, id.toLowerCase(), "perp rows are lowercased");
    const journal = await store.readJournal(id, 1);
    assert.deepEqual(journal.map((e) => e.kind), ["perp-fill"], "one entry, under the agents row's own spelling");
    assert.deepEqual(verifyChain(journal), []);
    const payload = JSON.parse(journal[0]!.payload_json) as Record<string, unknown>;
    assert.equal(payload.market, "BTC-PERP");
    assert.equal(payload.quoteMicro, "23000000", "money is journaled as integer strings");
  });

  it("books a self-trade as two fills, one per side", async () => {
    const id = await agent();
    assert.equal(await store.insertPerpFill(fill(id, { sideRole: "bid" })), "inserted");
    assert.equal(await store.insertPerpFill(fill(id, { sideRole: "ask", side: "long", role: "maker" })), "inserted");
    assert.equal(count("SELECT COUNT(*) AS n FROM perp_fills WHERE agent_id = ?", id.toLowerCase()), 2);
    assert.equal((await store.readJournal(id, 1)).length, 2);
  });

  it("says mismatch, and overwrites nothing, when a re-read disagrees with the booking", async () => {
    const id = await agent();
    await store.insertPerpFill(fill(id));
    assert.equal(await store.insertPerpFill(fill(id, { quoteMicro: 23_000_001n })), "mismatch");
    assert.equal(
      (raw.prepare("SELECT quote_micro FROM perp_fills WHERE agent_id = ?").get(id.toLowerCase()) as { quote_micro: string }).quote_micro,
      "23000000",
    );
    assert.equal((await store.readJournal(id, 1)).length, 1);
  });

  it("keeps paper and live apart: the same trade id on each rail is two facts", async () => {
    const id = await agent();
    assert.equal(await store.insertPerpFill(fill(id, { mode: "paper" })), "inserted");
    assert.equal(await store.insertPerpFill(fill(id, { mode: "live" })), "inserted");
  });

  it("refuses a malformed fill before writing anything", async () => {
    const id = await agent();
    await assert.rejects(store.insertPerpFill(fill(id, { base: 0n })), RangeError);
    await assert.rejects(store.insertPerpFill(fill(id, { side: "sell" as never })), RangeError);
    await assert.rejects(store.insertPerpFill(fill(id, { attribution: "guess" as never })), RangeError);
    assert.equal(count("SELECT COUNT(*) AS n FROM perp_fills WHERE agent_id = ?", id.toLowerCase()), 0);
    assert.equal((await store.readJournal(id, 1)).length, 0);
  });

  it("rolls the fill back when its journal entry fails, and then books it cleanly", async () => {
    const id = await agent();
    let hooked = 0;
    raw.exec("CREATE TRIGGER fail_journal BEFORE INSERT ON journal BEGIN SELECT RAISE(ABORT, 'injected journal failure'); END");
    try {
      await assert.rejects(store.insertPerpFill(fill(id), { with: async () => void hooked++ }), /injected journal failure/);
      assert.equal(count("SELECT COUNT(*) AS n FROM perp_fills WHERE agent_id = ?", id.toLowerCase()), 0);
    } finally {
      raw.exec("DROP TRIGGER fail_journal");
    }
    assert.equal(await store.insertPerpFill(fill(id), { with: async () => void hooked++ }), "inserted");
    assert.equal(await store.insertPerpFill(fill(id), { with: async () => void hooked++ }), "duplicate");
    assert.equal(hooked, 2, "the `with` hook ran inside both booking attempts and never for the duplicate");
    assert.equal(count("SELECT COUNT(*) AS n FROM perp_fills WHERE agent_id = ?", id.toLowerCase()), 1);
    assert.equal((await store.readJournal(id, 1)).length, 1);
  });

  it("rolls the fill back when its `with` hook throws", async () => {
    const id = await agent();
    await assert.rejects(
      store.insertPerpFill(fill(id), {
        with: async () => {
          throw new Error("paper book refused");
        },
      }),
      /paper book refused/,
    );
    assert.equal(count("SELECT COUNT(*) AS n FROM perp_fills WHERE agent_id = ?", id.toLowerCase()), 0);
    assert.equal((await store.readJournal(id, 1)).length, 0);
  });

  it("books funding once per id and once per market-hour", async () => {
    const id = await agent();
    const f = { agentId: id, mode: "live" as const, marketId: 1, fundingId: "77", fundingHour: 1_790_683_200, paymentMicro: -1_250n, ratePpm: 3 };
    assert.equal(await store.insertPerpFunding(f), "inserted");
    assert.equal(await store.insertPerpFunding(f), "duplicate");
    assert.equal(await store.insertPerpFunding({ ...f, paymentMicro: -1_251n }), "mismatch");
    assert.equal(await store.insertPerpFunding({ ...f, fundingId: "78" }), "hour-conflict", "one hour, one payment");
    assert.equal(await store.insertPerpFunding({ ...f, fundingId: "79", fundingHour: f.fundingHour + 3600 }), "inserted");
    await assert.rejects(store.insertPerpFunding({ ...f, fundingId: "80", fundingHour: f.fundingHour + 10 }), /not on the hour/);
    const journal = await store.readJournal(id, 1);
    assert.deepEqual(journal.map((e) => e.kind), ["funding", "funding"]);
    assert.deepEqual(verifyChain(journal), []);
  });

  it("rolls funding back when its journal entry fails", async () => {
    const id = await agent();
    const f = { agentId: id, mode: "paper" as const, marketId: 0, fundingId: "paper-0-1", fundingHour: 3600, paymentMicro: 10n };
    raw.exec("CREATE TRIGGER fail_journal BEFORE INSERT ON journal BEGIN SELECT RAISE(ABORT, 'injected journal failure'); END");
    try {
      await assert.rejects(store.insertPerpFunding(f), /injected journal failure/);
    } finally {
      raw.exec("DROP TRIGGER fail_journal");
    }
    assert.equal(count("SELECT COUNT(*) AS n FROM perp_funding WHERE agent_id = ?", id.toLowerCase()), 0);
    assert.equal(await store.insertPerpFunding(f), "inserted");
  });
});

describe("margin transfers move forward only, and journal each step that moves money", () => {
  const TX = `0x${"ab".repeat(32)}`;
  const OP = `0x${"cd".repeat(32)}`;

  it("walks a deposit submitted → landed → credited, journaling only the money-moving steps", async () => {
    const id = await agent();
    const base = { agentId: id, mode: "live" as const, direction: "deposit" as const, amountMicro: 25_000_000n, initiator: "agent" as const };
    const sub = await store.upsertPerpTransfer({ ...base, state: "submitted", userOpHash: OP });
    assert.equal(sub.outcome, "inserted");
    assert.equal((await store.readJournal(id, 1)).length, 0, "nothing has moved yet");
    // Found by its UserOp alone, and learns its chain log on the way.
    const landed = await store.upsertPerpTransfer({ ...base, state: "landed", userOpHash: OP, chainId: 4663, txHash: TX, logIndex: 4 });
    assert.deepEqual(landed, { outcome: "advanced", id: sub.id, from: "submitted", state: "landed", journaled: true });
    // Found by the chain log alone.
    const credited = await store.upsertPerpTransfer({ ...base, state: "credited", chainId: 4663, txHash: TX, logIndex: 4 });
    assert.equal(credited.outcome, "advanced");
    // The venue history lagging behind: never walked back.
    const lag = await store.upsertPerpTransfer({ ...base, state: "landed", userOpHash: OP });
    assert.deepEqual(lag, { outcome: "unchanged", id: sub.id, state: "credited" });
    const journal = await store.readJournal(id, 1);
    assert.deepEqual(journal.map((e) => e.kind), ["margin", "margin"]);
    assert.deepEqual(
      journal.map((e) => (JSON.parse(e.payload_json) as { from: string; to: string }).to),
      ["landed", "credited"],
    );
    assert.deepEqual(verifyChain(journal), []);
    assert.equal((await store.listOpenPerpTransfers(id, "live")).length, 0);
  });

  it("journals nothing for a request refused before anything moved, and one entry for a refund", async () => {
    const id = await agent();
    const w = { agentId: id, mode: "live" as const, direction: "withdraw" as const, amountMicro: 5_000_000n, initiator: "standdown" as const };
    const a = await store.upsertPerpTransfer({ ...w, state: "submitted", venueTxHash: "1".repeat(80) });
    assert.equal((await store.upsertPerpTransfer({ ...w, id: a.id!, state: "failed" })).outcome, "advanced");
    assert.equal((await store.readJournal(id, 1)).length, 0, "submitted → failed moved no money");
    const b = await store.upsertPerpTransfer({ ...w, state: "executed", venueTxHash: "2".repeat(80) });
    assert.equal(b.outcome, "inserted");
    assert.equal((await store.listOpenPerpTransfers(id, "live")).length, 1, "an executed withdrawal is in transit");
    assert.equal((await store.upsertPerpTransfer({ ...w, state: "refunded", venueTxHash: "2".repeat(80) })).outcome, "advanced");
    assert.equal((await store.readJournal(id, 1)).length, 2, "born executed, then refunded: two money steps");
  });

  it("refuses a transfer that contradicts the row it names", async () => {
    const id = await agent();
    const base = { agentId: id, mode: "live" as const, direction: "deposit" as const, amountMicro: 1_000_000n, initiator: "agent" as const };
    const a = await store.upsertPerpTransfer({ ...base, state: "landed", chainId: 4663, txHash: TX, logIndex: 1 });
    assert.equal((await store.upsertPerpTransfer({ ...base, amountMicro: 2_000_000n, state: "credited", chainId: 4663, txHash: TX, logIndex: 1 })).outcome, "refused");
    assert.equal((await store.upsertPerpTransfer({ ...base, id: a.id!, state: "credited", chainId: 4663, txHash: TX, logIndex: 2 })).outcome, "refused");
    await assert.rejects(store.upsertPerpTransfer({ ...base, state: "paid" }), /never 'paid'/);
    await assert.rejects(store.upsertPerpTransfer({ ...base, state: "landed", txHash: TX, logIndex: 3 }), /needs its chain id/);
    assert.equal((await store.readJournal(id, 1)).length, 1);
  });

  it("rolls a step back when its journal entry fails", async () => {
    const id = await agent();
    const base = { agentId: id, mode: "live" as const, direction: "deposit" as const, amountMicro: 3_000_000n, initiator: "agent" as const };
    const a = await store.upsertPerpTransfer({ ...base, state: "submitted" });
    raw.exec("CREATE TRIGGER fail_journal BEFORE INSERT ON journal BEGIN SELECT RAISE(ABORT, 'injected journal failure'); END");
    try {
      await assert.rejects(store.upsertPerpTransfer({ ...base, id: a.id!, state: "landed" }), /injected journal failure/);
    } finally {
      raw.exec("DROP TRIGGER fail_journal");
    }
    assert.equal((raw.prepare("SELECT state FROM perp_transfers WHERE id = ?").get(a.id!) as { state: string }).state, "submitted");
    assert.equal((await store.upsertPerpTransfer({ ...base, id: a.id!, state: "landed" })).outcome, "advanced");
  });
});

// ── rule 9 ────────────────────────────────────────────────────────────────────

describe("rule 9: one nonce per intent, persisted before send", () => {
  it("hands out strictly increasing nonces to concurrent callers, never the same one twice", async () => {
    const id = await agent();
    const floor = 1_790_000_000_000n;
    const got = await Promise.all(Array.from({ length: 25 }, () => store.bumpNonceHighWater(id, "live", floor)));
    const sorted = [...got].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    assert.equal(new Set(got.map(String)).size, 25, "every caller got its own nonce");
    for (let i = 1; i < sorted.length; i++) assert.equal(sorted[i]! - sorted[i - 1]!, 1n);
    assert.equal(sorted[0], floor);
    assert.equal(await store.getNonceHighWater(id, "live"), sorted[24]);
    // A floor below the high-water never goes backwards; one above it jumps.
    assert.equal(await store.bumpNonceHighWater(id, "live", 5n), sorted[24]! + 1n);
    assert.equal(await store.bumpNonceHighWater(id, "live", floor + 1000n), floor + 1000n);
    assert.equal(await store.getNonceHighWater(id, "paper"), null, "each rail keeps its own");
  });

  it("writes the row, its legs and the signed bytes, and refuses a nonce that was never reserved", async () => {
    const id = await agent();
    const nonce = await store.bumpNonceHighWater(id, "live", 1_790_000_000_000n);
    const tx = signed(nonce, ["entry", "sl", "tp"]);
    const orderId = await store.insertPerpOrderSubmitted({
      agentId: id, mode: "live", effect: "open", reduceOnly: false, marketId: 1, worstNotionalMicro: 23_000_000n, signed: tx,
    });
    const row = await store.perpOrderByTxHash(id, "live", tx.txHash);
    assert.equal(row?.id, orderId);
    assert.equal(row?.status, "submitted");
    assert.equal(row?.txInfo, tx.txInfo, "the exact signed bytes, for a re-send");
    assert.deepEqual(row?.legs.map((l) => [l.role, l.clientOrderIndex]), tx.clientOrderIndexes.map((l) => [l.role, l.clientOrderIndex]));
    assert.equal((await store.perpOrderByCoi(id, "live", tx.clientOrderIndexes[1]!.clientOrderIndex))?.leg.role, "sl");
    assert.deepEqual((await store.listSubmittedPerpOrders(id, "live")).map((o) => o.id), [orderId]);

    // Never reserved: nothing written, and the typed refusal.
    await assert.rejects(
      store.insertPerpOrderSubmitted({
        agentId: id, mode: "live", effect: "open", reduceOnly: false, marketId: 1, worstNotionalMicro: 1n, signed: signed(nonce + 50n, ["entry"]),
      }),
      (e: unknown) => e instanceof store.PerpNotRecorded && /never reserved/.test(e.message),
    );
    // The same nonce twice: the database refuses the second row.
    await assert.rejects(
      store.insertPerpOrderSubmitted({
        agentId: id, mode: "live", effect: "open", reduceOnly: false, marketId: 1, worstNotionalMicro: 1n,
        signed: { ...signed(nonce, ["entry"]), txHash: "f".repeat(80) },
      }),
      store.PerpNotRecorded,
    );
    assert.equal(count("SELECT COUNT(*) AS n FROM perp_orders WHERE agent_id = ?", id.toLowerCase()), 1);
  });

  it("refuses what rule 8 and the COI derivation do not admit, with nothing written", async () => {
    const id = await agent();
    const nonce = await store.bumpNonceHighWater(id, "live", 1_790_000_000_000n);
    const base = { agentId: id, mode: "live" as const, marketId: 1, worstNotionalMicro: 1_000_000n };
    const bad = [
      { ...base, effect: "open" as const, reduceOnly: true, signed: signed(nonce, ["entry"]) },
      { ...base, effect: "close" as const, reduceOnly: false, signed: signed(nonce, ["close"]) },
      { ...base, effect: "leverage" as const, reduceOnly: false, signed: signed(nonce, []) },
      { ...base, effect: "open" as const, reduceOnly: false, signed: { ...signed(nonce, ["entry"]), clientOrderIndexes: [{ role: "entry" as const, clientOrderIndex: 12345 }] } },
      { ...base, effect: "open" as const, reduceOnly: false },
      { ...base, effect: "withdraw" as const, reduceOnly: false, worstNotionalMicro: 0n, signed: signed(nonce, [], 13) },
    ];
    for (const s of bad) await assert.rejects(store.insertPerpOrderSubmitted(s), store.PerpNotRecorded);
    assert.equal(count("SELECT COUNT(*) AS n FROM perp_orders WHERE agent_id = ?", id.toLowerCase()), 0);
  });

  it("gives a final answer exactly once, forward only, even to racing resolvers", async () => {
    const id = await agent();
    const { id: orderId } = await liveOpen(id, 23_000_000n);
    assert.equal(await store.resolvePerpOrder({ agentId: id, mode: "live", id: orderId, status: "executed" }), true);
    const race = await Promise.all([
      store.resolvePerpOrder({ agentId: id, mode: "live", id: orderId, status: "filled", filledBase: 20_000n, filledQuoteMicro: 23_000_000n }),
      store.resolvePerpOrder({ agentId: id, mode: "live", id: orderId, status: "expired" }),
      store.resolvePerpOrder({ agentId: id, mode: "live", id: orderId, status: "cancelled", filledQuoteMicro: 0n }),
    ]);
    assert.deepEqual(race, [true, false, false], "the first final answer stands");
    assert.equal(await store.resolvePerpOrder({ agentId: id, mode: "live", id: orderId, status: "executed" }), false, "never backwards");
    const row = await store.getPerpOrder(id, "live", orderId);
    assert.equal(row?.status, "filled");
    assert.equal(row?.filledQuoteMicro, 23_000_000n);
    assert.ok(row?.resolvedAt);
    assert.deepEqual(await store.listSubmittedPerpOrders(id, "live"), []);
    await assert.rejects(store.resolvePerpOrder({ agentId: id, mode: "live", id: orderId, status: "submitted" as never }), RangeError);
  });

  it("moves legs forward only, and learns a venue order index without losing it", async () => {
    const id = await agent();
    const { nonce } = await liveOpen(id, 1_000_000n);
    const sl = Number(nonce * 8n + 1n);
    assert.equal(await store.updatePerpLegStatus({ agentId: id, mode: "live", clientOrderIndex: sl, status: "pending" }), true);
    assert.equal(await store.updatePerpLegStatus({ agentId: id, mode: "live", clientOrderIndex: sl, status: "pending", venueOrderIndex: "18446744073709551615" }), true);
    assert.equal(await store.updatePerpLegStatus({ agentId: id, mode: "live", clientOrderIndex: sl, status: "pending", venueOrderIndex: "1" }), false, "never overwritten");
    assert.equal(await store.updatePerpLegStatus({ agentId: id, mode: "live", clientOrderIndex: sl, status: "open", venueStatus: "open" }), true);
    assert.equal(await store.updatePerpLegStatus({ agentId: id, mode: "live", clientOrderIndex: sl, status: "submitted" }), false);
    assert.equal(await store.updatePerpLegStatus({ agentId: id, mode: "live", clientOrderIndex: sl, status: "cancelled", venueStatus: "canceled-too-much-slippage" }), true);
    assert.equal(await store.updatePerpLegStatus({ agentId: id, mode: "live", clientOrderIndex: sl, status: "filled" }), false, "a final leg is never rewritten");
    const leg = (await store.perpOrderByCoi(id, "live", sl))!.leg;
    assert.deepEqual([leg.status, leg.venueOrderIndex, leg.venueStatus], ["cancelled", "18446744073709551615", "canceled-too-much-slippage"]);
  });

  it("writes a withdrawal's request row and its transfer row together", async () => {
    const id = await agent();
    const nonce = await store.bumpNonceHighWater(id, "live", 1_790_000_000_000n);
    const tx = signed(nonce, [], 13);
    await store.insertPerpOrderSubmitted({
      agentId: id, mode: "live", effect: "withdraw", reduceOnly: false, marketId: null, worstNotionalMicro: 0n, signed: tx,
      withdraw: { amountMicro: 7_000_000n, initiator: "agent" },
    });
    const open = await store.listOpenPerpTransfers(id, "live");
    assert.equal(open.length, 1);
    assert.equal(open[0]!.venueTxHash, tx.txHash);
    assert.equal(open[0]!.state, "submitted");
    assert.equal(await store.perpOpsSince(id, "live", DAY_AGO()), 1, "one request, counted once — not once per table");
  });
});

// ── budgets ───────────────────────────────────────────────────────────────────

describe("budgets: perp orders count against the day, per rail", () => {
  it("counts submitted at worst notional, a resolved order by its fill, and no exit as spend", async () => {
    const id = await agent();
    const a = await liveOpen(id, 25_000_000n); // stays submitted: 25
    const b = await liveOpen(id, 20_000_000n); // part-filled then cancelled: 8
    await store.resolvePerpOrder({ agentId: id, mode: "live", id: b.id, status: "partial", filledBase: 1n, filledQuoteMicro: 8_000_000n });
    const c = await liveOpen(id, 15_000_000n); // rejected: 0
    await store.resolvePerpOrder({ agentId: id, mode: "live", id: c.id, status: "rejected" });
    const d = await liveOpen(id, 12_000_000n); // executed, fills not booked yet: 12
    await store.resolvePerpOrder({ agentId: id, mode: "live", id: d.id, status: "executed" });
    const e = await liveOpen(id, 30_000_000n, true); // a reduce-only close: never spend, still an op
    await store.resolvePerpOrder({ agentId: id, mode: "live", id: e.id, status: "filled", filledQuoteMicro: 30_000_000n });
    void a;
    assert.equal(await store.perpOpenNotionalSince(id, "live", DAY_AGO()), 45_000_000n);
    // ops: a (submitted), b (partial), d (executed), e (filled) — not c (rejected).
    assert.equal(await store.perpOpsSince(id, "live", DAY_AGO()), 4);
    assert.equal(await store.perpOpenNotionalSince(id, "paper", DAY_AGO()), 0n, "paper never sees live's orders");
    assert.equal(await store.perpOpsSince(id, "paper", DAY_AGO()), 0);
  });

  it("is what getSpentTodayUsdg and getOpsToday seed from — so a refresh or a restart keeps counting it", async () => {
    const id = await agent();
    await liveOpen(id, 10_000_000n);
    // The on-chain legs are trades rows: a deposit counts like a vault deposit,
    // a claim and a key registration do not, and all three are ops.
    for (const [kind, amount] of [["perp-deposit", 11], ["perp-claim", 50], ["perp-key", 0]] as const) {
      assert.equal(
        await store.addTrade({ agent_id: id, kind, target: "0x94bab9693ba2f6358507effcbd372b0660afff9d", amount_usdg: amount, status: "landed" }),
        true,
      );
    }
    assert.equal(await store.getSpentTodayUsdg(id, "live"), 21, "10 of opening notional + 11 of deposit");
    assert.equal(await store.getOpsToday(id, "live"), 4, "one perp order + three on-chain legs");
    assert.equal(await store.getSpentTodayUsdg(id, "paper"), 0);
    assert.equal(await store.getOpsToday(id, "paper"), 0);
  });

  it("forgets an order only when it leaves the trailing window", async () => {
    const id = await agent();
    const { id: orderId } = await liveOpen(id, 9_000_000n);
    raw.prepare("UPDATE perp_orders SET created_at = ? WHERE id = ?").run(now() - 86_401, orderId);
    assert.equal(await store.perpOpenNotionalSince(id, "live", DAY_AGO()), 0n);
    assert.equal(await store.perpOpsSince(id, "live", DAY_AGO()), 0);
  });

  it("counts paper orders on the paper rail", async () => {
    const id = await agent();
    await store.insertPerpOrderSubmitted({
      agentId: id, mode: "paper", effect: "open", reduceOnly: false, marketId: 0, worstNotionalMicro: 4_000_000n,
      legs: [{ role: "entry", clientOrderIndex: 8 }],
    });
    assert.equal(await store.getSpentTodayUsdg(id, "paper"), 4);
    assert.equal(await store.getOpsToday(id, "paper"), 1);
    assert.equal(await store.getSpentTodayUsdg(id, "live"), 0);
  });

  it("counts a paper withdrawal once, though it has no venue hash to link its two rows", async () => {
    const id = await agent();
    const orderId = await store.insertPerpOrderSubmitted({
      agentId: id, mode: "paper", effect: "withdraw", reduceOnly: false, marketId: null, worstNotionalMicro: 0n,
      withdraw: { amountMicro: 3_000_000n, initiator: "agent" },
    });
    assert.equal((await store.listOpenPerpTransfers(id, "paper"))[0]?.orderId, orderId);
    assert.equal(await store.perpOpsSince(id, "paper", DAY_AGO()), 1);
  });

  it("counts a transfer-only withdrawal request as an op, and never an owner's payout", async () => {
    const id = await agent();
    await store.upsertPerpTransfer({
      agentId: id, mode: "live", direction: "withdraw", amountMicro: 1_000_000n, initiator: "standdown", state: "executed", venueTxHash: "9".repeat(80),
    });
    await store.upsertPerpTransfer({
      agentId: id, mode: "live", direction: "withdraw", amountMicro: 2_000_000n, initiator: "owner", state: "paid",
      chainId: 4663, txHash: `0x${"ee".repeat(32)}`, logIndex: 7,
    });
    assert.equal(await store.perpOpsSince(id, "live", DAY_AGO()), 1);
  });
});

// ── positions, the account row, epochs, equity ───────────────────────────────

describe("positions and the account row", () => {
  it("replaces a rail's positions from one read, keeping a closed market's leverage state", async () => {
    const id = await agent();
    const pos = (marketId: number, base: bigint) => ({
      marketId, side: "long" as const, base, entryPrice: 11_500_000n, allocatedMarginMicro: 5_000_000n, imfBp: 5000, marginMode: "isolated" as const,
    });
    await store.setPerpPositions(id, "live", "venue", [pos(0, 10n), pos(1, 20n)]);
    await store.setPerpPositions(id, "live", "venue", [pos(1, 25n)]);
    assert.deepEqual((await store.getPerpPositions(id, "live")).map((p) => [p.marketId, p.base]), [[1, 25n]]);
    const all = await store.getPerpPositions(id, "live", { includeFlat: true });
    assert.deepEqual(all.map((p) => [p.marketId, p.side, p.base, p.imfBp]), [[0, null, 0n, 5000], [1, "long", 25n, 5000]]);
    await assert.rejects(store.upsertPerpPosition({ agentId: id, mode: "live", source: "paper", ...pos(3, 1n) }), /never sourced/);
    await assert.rejects(store.upsertPerpPosition({ agentId: id, mode: "paper", source: "paper", ...pos(3, 0n) }), /side exactly when/);
  });

  it("only ever adds to the retired keys, and never registers a retired one", async () => {
    const id = await agent();
    const k1 = `0x${"1".repeat(80)}`;
    const k2 = `0x${"2".repeat(80)}`;
    await store.patchPerpAccount(id, "live", { accountIndex: 22_149, registeredPubkey: k1 });
    await store.patchPerpAccount(id, "live", { registeredPubkey: k2, retirePubkeys: [k1] });
    await store.patchPerpAccount(id, "live", { retirePubkeys: [] });
    await assert.rejects(store.patchPerpAccount(id, "live", { registeredPubkey: k1 }), /retired/);
    await assert.rejects(store.patchPerpAccount(id, "live", { paperCollateralMicro: 1n }), /only the paper book/);
    await store.patchPerpAccount(id, "live", { lastSnapshotTime: 200, incident: { kind: "foreign-nonce", at: 5, detail: { nonce: 9 } } });
    await store.patchPerpAccount(id, "live", { lastSnapshotTime: 100 });
    const acct = await store.getPerpAccount(id, "live");
    assert.equal(acct?.registeredPubkey, k2);
    assert.deepEqual(acct?.retiredPubkeys, [k1]);
    assert.equal(acct?.lastSnapshotTime, 200, "an older snapshot never replaces a newer one's time");
    assert.equal(acct?.incident?.kind, "foreign-nonce");
  });
});

describe("epochs and equity", () => {
  it("carries open positions into the new epoch with the boundary, once each", async () => {
    const id = await agent();
    const carry = { mode: "live" as const, marketId: 1, side: "long" as const, base: 20_000n, markPrice: 11_600_000n, entryQuoteMicro: 23_200_000n };
    assert.equal(await store.openNextEpoch(id, 100, [carry, carry]), 2);
    const journal = await store.readJournal(id, 2);
    assert.deepEqual(journal.map((e) => e.kind), ["flow", "perp-carry"]);
    assert.deepEqual(verifyChain(journal), []);
    assert.equal(await store.recordPerpCarry(id, carry), false, "the epoch already holds it");
    assert.equal(await store.recordPerpCarry(id, { ...carry, marketId: 0 }), true);
    // A malformed carry refuses the whole boundary.
    await assert.rejects(store.openNextEpoch(id, 100, [{ ...carry, base: 0n }]), RangeError);
    assert.equal(await store.getAgentEpoch(id), 2);
  });

  it("writes the perp terms beside the total, and leaves them NULL when there are none", async () => {
    const id = await agent();
    const spot = { ethWei: 0n, cashUsdg: 900, vaultUsdg: 0, positionsUsdg: 0, mode: "live" as const };
    await store.addEquity(id, { ...spot, equityUsdg: 900 });
    await store.addEquity(id, {
      ...spot, equityUsdg: 975, cashReadBlock: 123_456n,
      perp: { collateralMicro: 50_000_000n, isolatedMarginMicro: 20_000_000n, unrealizedMicro: 5_000_000n, unrealizedGainMicro: 5_000_000n, inTransitMicro: 0n, snapshotTime: 1_790_696_152_553_000 },
    });
    const rows = raw.prepare("SELECT perp_collateral_micro, perp_unrealized_gain_micro, perp_snapshot_time, cash_read_block FROM equity WHERE agent_id = ? ORDER BY id").all(id) as Record<string, unknown>[];
    assert.deepEqual({ ...rows[0] }, { perp_collateral_micro: null, perp_unrealized_gain_micro: null, perp_snapshot_time: null, cash_read_block: null });
    assert.deepEqual({ ...rows[1] }, { perp_collateral_micro: "50000000", perp_unrealized_gain_micro: "5000000", perp_snapshot_time: 1_790_696_152_553_000, cash_read_block: 123_456 });
    const marks = (await store.readJournal(id, 1)).filter((e) => e.kind === "mark").map((e) => JSON.parse(e.payload_json) as Record<string, unknown>);
    assert.equal("perpCollateralMicro" in marks[0]!, false, "a mark with no perp term hashes as it always did");
    assert.equal(marks[1]!.perpIsolatedMarginMicro, "20000000");
    assert.equal(await store.lastKnownCashReadBlock(id), 123_456);
  });
});

// ── paper ─────────────────────────────────────────────────────────────────────

/** A shared or fresh database with the real schema, as the orchestrator builds one. */
async function ledgerDb(): Promise<{ db: Db; raw: DatabaseSync }> {
  const r = new DatabaseSync(":memory:");
  others.push(r);
  const db = wrapSqlite(r);
  await store.applyLedgerSchema(db);
  await db.exec(MIRROR_STATE_DDL);
  return { db, raw: r };
}

describe("the paper perp book rides the checkpoint", () => {
  it("round-trips collateral and positions, margin, imf and funding hour included", async () => {
    const id = await agent();
    await store.getPaperBook(id, 1000);
    await store.patchPerpAccount(id, "paper", { paperCollateralMicro: 50_000_000n });
    await store.upsertPerpPosition({
      agentId: id, mode: "paper", source: "paper", marketId: 1, side: "short", base: 20_000n, entryPrice: 11_500_000n,
      allocatedMarginMicro: 11_500_000n, imfBp: 5000, marginMode: "isolated", fundingHourApplied: 1_790_683_200,
      stopTrigger: 12_075_000n, stopPrice: 12_316_500n, openedAt: 1_790_680_000,
    });
    const child = wrapSqlite(raw);
    const shared = await ledgerDb();
    assert.ok((await mirrorPaperCheckpoints(child, shared.db)) >= 1);
    const cp = shared.raw.prepare("SELECT perp_json FROM paper_checkpoints WHERE agent_id = ?").get(id) as { perp_json: string };
    assert.equal(paperPerpRejection(cp.perp_json), null);
    shared.raw.prepare("INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at) VALUES (?, 'o', 's', 4663, '{}', 0, 0)").run(id);

    const fresh = await ledgerDb();
    assert.match(await restorePaperCheckpoint(fresh.db, shared.db, id), /restored, with the paper perp book/);
    const acct = fresh.raw.prepare("SELECT paper_collateral_micro FROM perp_accounts WHERE agent_id = ? AND mode = 'paper'").get(id.toLowerCase()) as { paper_collateral_micro: string };
    assert.equal(acct.paper_collateral_micro, "50000000");
    const pos = fresh.raw.prepare("SELECT side, base, allocated_margin_micro, imf_bp, funding_hour_applied, stop_price, source FROM perp_positions WHERE agent_id = ?").all(id.toLowerCase());
    assert.deepEqual(pos.map((p) => ({ ...p })), [
      { side: "short", base: "20000", allocated_margin_micro: "11500000", imf_bp: 5000, funding_hour_applied: 1_790_683_200, stop_price: "12316500", source: "paper" },
    ]);
  });

  it("a position the REAL paper engine opened is carried by the checkpoint, and restored whole into an empty child (R3-PAPER-CKPT-NULL-COLLATERAL)", async () => {
    // The engine books under an account row bumpNonceHighWater created with
    // paper_collateral_micro NULL; the checkpoint reads NULL collateral beside
    // an open position as a torn book and skips the WHOLE row — cash, shares
    // and basis too. Only the engine's own path proves the column is a read 0.
    const id = await agent();
    await store.getPaperBook(id, 100);
    const btc = parseOrderBookDetails(JSON.parse(readFileSync(path.join(import.meta.dirname, "perps", "fixtures", "orderBookDetails.perp.json"), "utf8")))!.markets.get(1)!;
    const H = 1_790_708_400;
    let clockMs = (H - 1800) * 1000;
    const feed = () =>
      parseLighterFeed(
        {
          v: 1,
          observedAt: clockMs - 500,
          markets: {
            "1": {
              observedAt: clockMs - 1_000,
              priceSource: "ws",
              mark: "800000",
              index: "800000",
              // The hour's payment exists only once the hour has passed.
              ...(clockMs > H * 1000 + 1_000 ? { lastFundingRatePctPerHour: "0.0012", lastFundingAt: H * 1000 + 40 } : {}),
              status: btc.spec.status,
              spec: specToJson(btc.spec),
              specObservedAt: clockMs - 60_000,
              takerFeePpm: 0,
              makerFeePpm: 0,
              bids: [["799900", "1000"]],
              asks: [["800000", "1000"]],
              bookObservedAt: clockMs - 1_000,
              bookSource: "ws",
            },
          },
        },
        clockMs,
      );
    const ex = createPaperPerpExecutor({ agentId: id, epoch: () => 1, feed, store, now: () => clockMs, paperStartUsdg: 100 });
    await ex.setLeverage!(1, 5000);
    const open = {
      kind: "perp-order", venue: "lighter", market: "BTC-PERP", marketId: 1, effect: "open", side: "long", reduceOnly: false,
      baseAmount: 20n, worstPrice: 804_000n, markPrice: 800_000n, notionalUsdg: 16_080_000n, imfBp: 5000, stopTrigger: 760_000n, stopPrice: 744_800n,
    } as PerpOrderIntent;
    const placed = await ex.place(open, await ex.review(open), { decisionId: null, agentId: id });
    assert.equal(placed.status, "filled");
    // An hour's funding, so funding_hour_applied is part of what must round-trip.
    clockMs = H * 1000 + 60_000;
    assert.equal((await ex.tick!()).events.length, 1);
    assert.equal((await store.getPerpAccount(id, "paper"))?.paperCollateralMicro, 0n, "the engine's book keeps a READ zero, never NULL");

    const child = wrapSqlite(raw);
    const shared = await ledgerDb();
    await mirrorPaperCheckpoints(child, shared.db);
    const cp = shared.raw.prepare("SELECT cash_usdg, perp_json FROM paper_checkpoints WHERE agent_id = ?").get(id) as { cash_usdg: number; perp_json: string } | undefined;
    assert.ok(cp, "the agent's checkpoint row was mirrored — not skipped over its perp book");
    assert.equal(paperPerpRejection(cp.perp_json), null);
    const state = JSON.parse(cp.perp_json) as { collateral_micro: string; positions: { market_id: number; allocated_margin_micro: string; funding_hour_applied: number; stop_trigger: string }[] };
    assert.equal(state.collateral_micro, "0");
    assert.equal(state.positions.length, 1);
    assert.equal(cp.cash_usdg, 92, "the margin left paper cash (8 USDG at 2x of 16)");

    shared.raw.prepare("INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at) VALUES (?, 'o', 's', 4663, '{}', 0, 0)").run(id);
    const fresh = await ledgerDb();
    assert.match(await restorePaperCheckpoint(fresh.db, shared.db, id), /restored, with the paper perp book/);
    const book = fresh.raw.prepare("SELECT cash_usdg FROM paper_book").get() as { cash_usdg: number };
    assert.equal(book.cash_usdg, 92, "cash as it stood with the position open — not the pre-open 100");
    const pos = fresh.raw.prepare("SELECT side, base, allocated_margin_micro, funding_hour_applied, stop_trigger, stop_price FROM perp_positions WHERE agent_id = ? AND mode = 'paper'").all(id.toLowerCase());
    assert.deepEqual(pos.map((p) => ({ ...p })), [
      { side: "long", base: "20", allocated_margin_micro: String(8_000_000 - 192), funding_hour_applied: H, stop_trigger: "760000", stop_price: "744800" },
    ]);
    const acct = fresh.raw.prepare("SELECT paper_collateral_micro FROM perp_accounts WHERE agent_id = ? AND mode = 'paper'").get(id.toLowerCase()) as { paper_collateral_micro: string };
    assert.equal(acct.paper_collateral_micro, "0");
  });

  it("refuses a perp book it could not write back whole", () => {
    const base = { agent_id: "a", epoch: 1, cash_usdg: 900, vault_usdg: 0, hwm_usdg: 1000, shares: "{}", basis_json: "[]", updated_at: 10 };
    const position = { market_id: 1, side: "long", base: "1", entry_price: "1", allocated_margin_micro: "0", imf_bp: 5000, margin_mode: "isolated", realized_micro: null, funding_micro: null, funding_hour_applied: null, stop_trigger: null, stop_price: null, take_trigger: null, take_price: null, opened_at: null };
    const ok = { v: 1, collateral_micro: "1", positions: [position] };
    assert.equal(paperCheckpointRejection({ ...base, perp_json: JSON.stringify(ok) }), null);
    assert.equal(paperCheckpointRejection({ ...base, perp_json: null }), null);
    assert.match(paperCheckpointRejection({ ...base, perp_json: JSON.stringify({ ...ok, collateral_micro: "-1" }) })!, /collateral/);
    assert.match(paperCheckpointRejection({ ...base, perp_json: JSON.stringify({ ...ok, positions: [{ ...position, market_id: 9999 }] }) })!, /market 9999/);
    assert.match(paperCheckpointRejection({ ...base, perp_json: JSON.stringify({ ...ok, positions: [position, position] }) })!, /held twice/);
    assert.match(paperCheckpointRejection({ ...base, perp_json: JSON.stringify({ ...ok, positions: [{ ...position, allocated_margin_micro: "-5" }] }) })!, /margin/);
    assert.match(paperCheckpointRejection({ ...base, perp_json: "{" })!, /unreadable/);
  });

  it("recovers from a valuation whose perp term is part of the identity, closing the paper perps at that mark", async () => {
    const id = await agent();
    const shared = await ledgerDb();
    shared.raw.prepare("INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at) VALUES (?, 'o', 's', 4663, '{}', 0, 0)").run(id);
    const mark = shared.raw.prepare(
      `INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, epoch, mode, at,
                           perp_collateral_micro, perp_isolated_margin_micro, perp_unrealized_micro, perp_unrealized_gain_micro, perp_in_transit_micro)
       VALUES (?, '0', ?, 0, 0, ?, 1, 'paper', ?, ?, ?, ?, ?, '0')`,
    );
    // A wick: 1,100 of equity, 150 of it an unrealized gain that reverted. Its basis is 950.
    mark.run(id, 900, 1100, 5, "50000000", "0", "150000000", "150000000");
    // The recoverable valuation: 900 cash + 50 collateral + 20 margin + 5 unrealized = 975.
    mark.run(id, 900, 975, 10, "50000000", "20000000", "5000000", "5000000");
    const fresh = await ledgerDb();
    assert.match(await restorePaperCheckpoint(fresh.db, shared.db, id), /closed into paper collateral/);
    const book = fresh.raw.prepare("SELECT cash_usdg, hwm_usdg FROM paper_book").get() as { cash_usdg: number; hwm_usdg: number };
    assert.equal(book.cash_usdg, 900);
    assert.equal(book.hwm_usdg, 975, "the wick never lifted the peak; today's book is the highest real candidate");
    const acct = fresh.raw.prepare("SELECT paper_collateral_micro FROM perp_accounts WHERE mode = 'paper'").get() as { paper_collateral_micro: string };
    assert.equal(acct.paper_collateral_micro, "75000000");

    // The identity without its perp term does not add up, and says so.
    const broken = await ledgerDb();
    broken.raw.prepare("INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at) VALUES (?, 'o', 's', 4663, '{}', 0, 0)").run(id);
    broken.raw.prepare(
      "INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, epoch, mode, at, perp_collateral_micro) VALUES (?, '0', 900, 0, 0, 975, 1, 'paper', 10, '50000000')",
    ).run(id);
    await assert.rejects(restorePaperCheckpoint((await ledgerDb()).db, broken.db, id), /does not add up/);

    // A paper perp fill after the valuation moved money the mark does not hold.
    shared.raw.prepare(
      `INSERT INTO perp_fills (agent_id, mode, epoch, venue_trade_id, side_role, market_id, side, base, price, quote_micro, fee_micro,
                               trade_type, attribution, venue_ts_ms, created_at)
       VALUES (?, 'paper', 1, 'p1', 'bid', 1, 'long', '1', '1', '1', '0', 'trade', 'intent', 1, 11)`,
    ).run(id.toLowerCase());
    await assert.rejects(restorePaperCheckpoint((await ledgerDb()).db, shared.db, id), /perp fills or funding are newer/);
  });

  it("resets the paper perp book with the paper cash, and never touches the live one", async () => {
    const id = await agent();
    await store.getPaperBook(id, 1000);
    await store.patchPerpAccount(id, "paper", { paperCollateralMicro: 9_000_000n });
    const p = { agentId: id, marketId: 1, side: "long" as const, base: 5n, entryPrice: 1n, allocatedMarginMicro: 1n };
    await store.upsertPerpPosition({ ...p, mode: "paper", source: "paper" });
    await store.upsertPerpPosition({ ...p, mode: "live", source: "venue" });
    const hw = await store.bumpNonceHighWater(id, "paper", 1_790_000_000_000n);
    await store.resetPaperLedger(id, 1000);
    assert.equal((await store.getPerpAccount(id, "paper"))?.paperCollateralMicro, 0n);
    assert.equal((await store.getPerpPositions(id, "paper", { includeFlat: true })).length, 0);
    assert.equal((await store.getPerpPositions(id, "live")).length, 1);
    assert.equal(await store.getNonceHighWater(id, "paper"), hw, "the high-water survives a reset");
  });
});

// ── the mirror ────────────────────────────────────────────────────────────────

describe("the mirror carries the perp ledger up, forward only", () => {
  it("copies every perp table — never the signed bytes or an incident's detail — and an unchanged ledger as nothing", async () => {
    const id = await agent();
    const acct = id.toLowerCase();
    const { id: orderId } = await liveOpen(id, 23_000_000n);
    await store.insertPerpFill(fill(id, { orderId }));
    await store.insertPerpFunding({ agentId: id, mode: "live", marketId: 1, fundingId: "501", fundingHour: 7200, paymentMicro: -3n });
    await store.upsertPerpTransfer({ agentId: id, mode: "live", direction: "deposit", amountMicro: 5_000_000n, initiator: "agent", state: "landed", chainId: 4663, txHash: `0x${"12".repeat(32)}`, logIndex: 0 });
    await store.upsertPerpPosition({ agentId: id, mode: "live", source: "venue", marketId: 1, side: "long", base: 20_000n, allocatedMarginMicro: 11_500_000n, imfBp: 5000, marginMode: "isolated" });
    await store.patchPerpAccount(id, "live", { accountIndex: 22_149, incident: { kind: "foreign-key", at: 7, detail: { pubkey: "secret-ish" } } });
    await store.addEquity(id, {
      ethWei: 0n, cashUsdg: 1, vaultUsdg: 0, positionsUsdg: 0, equityUsdg: 1, mode: "live",
      perp: { collateralMicro: 0n, isolatedMarginMicro: 0n, unrealizedMicro: 0n, unrealizedGainMicro: 0n, inTransitMicro: 0n, snapshotTime: null },
    });

    const child = wrapSqlite(raw);
    const shared = await ledgerDb();
    const first = await mirrorTenant({ tenant: "t1", child, shared: shared.db });
    assert.equal(first.failed, undefined, JSON.stringify(first.failed));
    for (const t of ["perp_fills", "perp_funding", "perp_orders", "perp_order_legs", "perp_transfers", "perp_positions", "perp_accounts"]) {
      assert.ok((first.copied[t] ?? 0) > 0, `${t} arrived`);
    }
    const order = shared.raw.prepare("SELECT status, tx_info, tx_hash FROM perp_orders WHERE id = ?").get(orderId) as Record<string, unknown>;
    assert.equal(order.status, "submitted");
    assert.equal(order.tx_info, null, "the signed bytes stay in the child");
    const incident = shared.raw.prepare("SELECT incident_json FROM perp_accounts WHERE agent_id = ? AND mode = 'live'").get(acct) as { incident_json: string };
    assert.deepEqual(JSON.parse(incident.incident_json), { at: 7, kind: "foreign-key" }, "kind and time, never the detail");
    const eq = shared.raw.prepare("SELECT perp_collateral_micro FROM equity WHERE agent_id = ?").get(id) as { perp_collateral_micro: string };
    assert.equal(eq.perp_collateral_micro, "0", "the equity row's perp terms travel with it");

    const again = await mirrorTenant({ tenant: "t1", child, shared: shared.db });
    for (const t of ["perp_fills", "perp_funding", "perp_orders", "perp_order_legs", "perp_transfers", "perp_positions", "perp_accounts"]) {
      assert.equal(again.copied[t], undefined, `${t}: an unchanged ledger copies as nothing`);
    }
    assert.equal(Number((shared.raw.prepare("SELECT COUNT(*) AS n FROM perp_fills WHERE agent_id = ?").get(acct) as { n: number }).n), 1);

    // The answer arrives: the resolved row replaces the submitted one.
    await store.resolvePerpOrder({ agentId: id, mode: "live", id: orderId, status: "filled", filledBase: 20_000n, filledQuoteMicro: 23_000_000n });
    raw.prepare("UPDATE perp_orders SET updated_at = updated_at + 1 WHERE id = ?").run(orderId);
    await mirrorTenant({ tenant: "t1", child, shared: shared.db });
    assert.equal((shared.raw.prepare("SELECT status FROM perp_orders WHERE id = ?").get(orderId) as { status: string }).status, "filled");

    // A STALE CHILD NEVER REGRESSES A ROW: walk the child's copy back and
    // make it look newer, as a ledger restored from an old backup would.
    raw.prepare("UPDATE perp_orders SET status = 'submitted', updated_at = updated_at + 10 WHERE id = ?").run(orderId);
    raw.prepare("UPDATE perp_transfers SET state = 'submitted', updated_at = updated_at + 10 WHERE agent_id = ?").run(acct);
    await mirrorTenant({ tenant: "t1", child, shared: shared.db });
    assert.equal((shared.raw.prepare("SELECT status FROM perp_orders WHERE id = ?").get(orderId) as { status: string }).status, "filled");
    assert.equal((shared.raw.prepare("SELECT state FROM perp_transfers WHERE agent_id = ?").get(acct) as { state: string }).state, "landed");

    // A nonce high-water never falls in shared storage, whatever the child says.
    const high = (shared.raw.prepare("SELECT nonce_high_water FROM perp_accounts WHERE agent_id = ? AND mode = 'live'").get(acct) as { nonce_high_water: string }).nonce_high_water;
    raw.prepare("UPDATE perp_accounts SET nonce_high_water = '1', updated_at = updated_at + 20 WHERE agent_id = ? AND mode = 'live'").run(acct);
    await mirrorTenant({ tenant: "t1", child, shared: shared.db });
    assert.equal(
      (shared.raw.prepare("SELECT nonce_high_water FROM perp_accounts WHERE agent_id = ? AND mode = 'live'").get(acct) as { nonce_high_water: string }).nonce_high_water,
      high,
    );
  });

  it("flattens a shared position the child has since closed — and not one it has merely not re-read", async () => {
    const id = await agent();
    const acct = id.toLowerCase();
    const shared = await ledgerDb();
    const child = wrapSqlite(raw);
    await store.upsertPerpPosition({ agentId: id, mode: "paper", source: "paper", marketId: 3, side: "long", base: 7n, allocatedMarginMicro: 1n });
    await mirrorTenant({ tenant: "t2", child, shared: shared.db });
    // The child's paper reset deletes its rows and touches its account row.
    await store.resetPaperLedger(id, 1000);
    raw.prepare("DELETE FROM perp_accounts WHERE agent_id = ?").run(acct);
    await mirrorTenant({ tenant: "t2", child, shared: shared.db });
    assert.equal((shared.raw.prepare("SELECT base FROM perp_positions WHERE agent_id = ?").get(acct) as { base: string }).base, "7", "silence is not flatness");
    await store.patchPerpAccount(id, "paper", { paperCollateralMicro: 0n });
    raw.prepare("UPDATE perp_accounts SET updated_at = updated_at + 5 WHERE agent_id = ?").run(acct);
    await mirrorTenant({ tenant: "t2", child, shared: shared.db });
    assert.equal((shared.raw.prepare("SELECT base FROM perp_positions WHERE agent_id = ?").get(acct) as { base: string }).base, "0");
  });

  it("skips a child ledger from before perps, with nothing to say and nothing failed", async () => {
    const old = new DatabaseSync(":memory:");
    others.push(old);
    old.exec("CREATE TABLE agents (smart_account TEXT PRIMARY KEY)");
    const shared = await ledgerDb();
    const r = await mirrorTenant({ tenant: "t3", child: wrapSqlite(old), shared: shared.db });
    assert.equal(Object.keys(r.copied).some((k) => k.startsWith("perp")), false);
    assert.equal(Object.keys(r.failed ?? {}).some((k) => k.startsWith("perp")), false);
  });
});

// ── migration ─────────────────────────────────────────────────────────────────

describe("the migration, over a ledger that already has rows", () => {
  const PERP_TABLES = ["perp_orders", "perp_order_legs", "perp_fills", "perp_funding", "perp_transfers", "perp_positions", "perp_accounts", "perp_carries"];
  const EQUITY_COLS = [
    "perp_collateral_micro", "perp_isolated_margin_micro", "perp_unrealized_micro", "perp_unrealized_gain_micro",
    "perp_in_transit_micro", "perp_snapshot_time", "cash_read_block",
  ];

  /**
   * The ledger as it stands BEFORE this change — built from the real schema and
   * then stripped of what the change adds, rather than restated by hand: a
   * hand-copied "before" drifts from the real one, and proves nothing.
   */
  async function preMigration(): Promise<{ db: Db; raw: DatabaseSync }> {
    const r = new DatabaseSync(":memory:");
    others.push(r);
    const db = wrapSqlite(r);
    await store.applyLedgerSchema(db);
    for (const t of PERP_TABLES) r.exec(`DROP TABLE ${t}`);
    for (const c of EQUITY_COLS) r.exec(`ALTER TABLE equity DROP COLUMN ${c}`);
    return { db, raw: r };
  }

  it("adds every table, index and column, keeps every row, and is a no-op the second time", async () => {
    const { db, raw: r } = await preMigration();
    r.exec(`INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, mode, at) VALUES ('0xa', '0', 10, 0, 0, 10, 'live', 1)`);
    r.exec(`INSERT INTO trades (agent_id, kind, target, amount_usdg, status) VALUES ('0xa', 'swap', '0xb', 5, 'landed')`);
    await store.applyLedgerSchema(db);
    await store.applyLedgerSchema(db);
    const tables = new Set((r.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name));
    for (const t of PERP_TABLES) assert.ok(tables.has(t), `${t} exists`);
    const indexes = new Set((r.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map((t) => t.name));
    for (const i of ["perp_orders_nonce", "perp_funding_hour", "perp_transfers_chain", "perp_transfers_venue", "perp_transfers_userop"]) {
      assert.ok(indexes.has(i), `${i} exists — a unique rule the ledger's safety rests on`);
    }
    const cols = new Set((r.prepare("SELECT name FROM pragma_table_info('equity')").all() as { name: string }[]).map((c) => c.name));
    for (const c of EQUITY_COLS) assert.ok(cols.has(c), `equity.${c} exists`);
    const legacy = r.prepare("SELECT perp_collateral_micro, cash_read_block, equity_usdg FROM equity").get() as Record<string, unknown>;
    assert.deepEqual({ ...legacy }, { perp_collateral_micro: null, cash_read_block: null, equity_usdg: 10 }, "an old row predates the question: NULL, never 0");
    assert.equal(Number((r.prepare("SELECT COUNT(*) AS n FROM trades").get() as { n: number }).n), 1);
  });

  it("translates every statement for Postgres, with nothing sqlite-only left in it", () => {
    for (const ddl of store.PERP_LEDGER_DDL) {
      const pg = translateSchema(ddl);
      assert.doesNotMatch(pg, /unixepoch|AUTOINCREMENT|\bREAL\b|\bINTEGER\b/, pg);
      assert.doesNotMatch(pg, /\bCHECK\b/, "no CHECK on a table the mirror copies");
      if (/ADD COLUMN/.test(ddl)) assert.match(pg, /ADD COLUMN IF NOT EXISTS/);
    }
  });
});
