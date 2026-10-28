/**
 * THE LEDGER FOLDS AN EVM HASH AND NOTHING ELSE (Solana P0).
 *
 * Two places case-folded every tx hash they touched: the migration that runs on
 * every ledger open, and insertFlowWithJournal, which writes a flow row and its
 * hash-chained journal entry. Right for an EVM hash, which is case-insensitive.
 * Wrong for a Solana signature, which is base58 and case-sensitive: lowercased,
 * it names nothing on chain. Both now fold only a 0x + 64 hex hash.
 *
 * WHAT HAS TO BE PROVEN FIRST is that this changes nothing that is there, since
 * every hash on the books today is 0x + 64 hex. So the migration is run over the
 * same rows twice, once as it was (the old statement, pinned verbatim below) and
 * once as it is, and the two books must match row for row. Then the case the
 * change exists for: a signature survives every open exactly as written, where
 * the old statement would have lowercased it.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// Before any store import can open a ledger: node's --test runs each file in
// its own process, so the override never leaks.
const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-hash-case-"));
process.env.MERRYMEN_HOME = HOME;

const {
  addFlow,
  applyLedgerSchema,
  canonicalJson,
  closeStoreForTest,
  ensureAgent,
  getAgentEpoch,
  hasChainFlow,
  hasFlowForTx,
  initStore,
  readJournal,
} = await import("./store");
const { wrapSqlite } = await import("./db");
const { verifyChain } = await import("./audit");
const { base58Encode, idFamily } = await import("../../packages/core/src/ids");
const { homePaths } = await import("./home");

after(() => {
  closeStoreForTest();
  rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** The fold as it shipped before this change, word for word. */
const PRE_SOLANA_FOLD = "UPDATE flows SET tx_hash = LOWER(tx_hash) WHERE tx_hash IS NOT NULL AND tx_hash <> LOWER(tx_hash)";

const ACCOUNT = "0x00000000000000000000000000000000000000c1";
const CHAIN = 4663;
const AT = 1_790_000_000;

/** 0x + 64 hex in each spelling an EVM writer can hand the ledger. */
const LOWER = `0x${"0123456789abcdef".repeat(4)}`;
const UPPER = `0x${"0123456789ABCDEF".repeat(4)}`;
const MIXED = `0x${"aBcDeF01".repeat(8)}`;
/** bookInitialCapital admits the prefix in either case (/^0x[0-9a-f]{64}$/i). */
const CAPITAL_X = `0X${"FEDCBA98".repeat(8)}`;

/** A real signature's shape: base58 decoding to 64 bytes. */
const SIGNATURE = base58Encode(Uint8Array.from({ length: 64 }, (_, i) => (i * 37 + 11) % 256));

/** A ledger as it stands before this open: the full schema, its index dropped and its flows emptied, as accounting-migration.test.ts builds one. */
async function ledger(): Promise<{ db: ReturnType<typeof wrapSqlite>; raw: DatabaseSync }> {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  await applyLedgerSchema(db);
  raw.exec("DROP INDEX IF EXISTS flows_chain_identity");
  raw.exec("DELETE FROM flows");
  raw
    .prepare(
      `INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, mode)
       VALUES (?, ?, ?, ?, '{}', 0, 0, 'live')`,
    )
    .run(ACCOUNT, ACCOUNT, ACCOUNT, CHAIN);
  return { db, raw };
}

function seed(raw: DatabaseSync, rows: Array<{ tx: string | null; log: number | null; source: string; chain: number | null }>): void {
  const ins = raw.prepare(
    `INSERT INTO flows (agent_id, direction, amount_usdg, tx_hash, block_number, log_index, source, epoch, chain_id, at)
     VALUES (?, 'in', 10, ?, ?, ?, ?, 1, ?, ?)`,
  );
  for (const r of rows) ins.run(ACCOUNT, r.tx, r.tx === null ? null : 100, r.log, r.source, r.chain, AT);
}

const flows = (raw: DatabaseSync) => raw.prepare("SELECT * FROM flows ORDER BY id").all() as Array<Record<string, unknown>>;

/** The EVM rows a ledger holds today: chain logs (stamped and legacy), the executor's transfer, inferred rows and a carry. */
const TODAYS_ROWS = [
  { tx: LOWER, log: 0, source: "chain-log", chain: CHAIN },
  { tx: UPPER, log: 1, source: "chain-log", chain: null },
  { tx: MIXED, log: null, source: "transfer-intent", chain: CHAIN },
  { tx: CAPITAL_X, log: 2, source: "chain-log", chain: CHAIN },
  { tx: null, log: null, source: "inferred", chain: null },
  { tx: null, log: null, source: "epoch-carry", chain: null },
];

describe("the open-time fold, over the rows that are there today", () => {
  it("leaves every EVM row exactly as the old fold did", async () => {
    // BEFORE: the old fold, then the schema. The schema's own fold finds
    // nothing left to fold after it, so this is the book the last release made.
    const before = await ledger();
    seed(before.raw, TODAYS_ROWS);
    before.raw.exec(PRE_SOLANA_FOLD);
    await applyLedgerSchema(before.db);

    // AFTER: the schema alone, as an open does now.
    const now = await ledger();
    seed(now.raw, TODAYS_ROWS);
    await applyLedgerSchema(now.db);

    assert.deepEqual(flows(now.raw), flows(before.raw), "row for row, column for column, the same book");
    assert.deepEqual(
      flows(now.raw).map((r) => r.tx_hash),
      [LOWER, UPPER.toLowerCase(), MIXED.toLowerCase(), CAPITAL_X.toLowerCase(), null, null],
      "and every EVM hash in it is lowercased, as before",
    );
    assert.equal(Number(flows(now.raw)[1]!.chain_id), CHAIN, "the legacy row still gets its chain from the grant");
  });
});

describe("a Solana signature", () => {
  it("is a signature, and has upper case in it to lose", () => {
    assert.equal(idFamily(SIGNATURE), "solana");
    assert.notEqual(SIGNATURE, SIGNATURE.toLowerCase());
  });

  it("survives every open exactly as written, beside an EVM row that is still folded", async () => {
    const rows = [
      { tx: SIGNATURE, log: 0, source: "chain-log", chain: CHAIN },
      { tx: MIXED, log: 1, source: "chain-log", chain: CHAIN },
    ];

    // The old fold would have destroyed it: the test can tell the difference.
    const old = await ledger();
    seed(old.raw, rows);
    old.raw.exec(PRE_SOLANA_FOLD);
    assert.equal(flows(old.raw)[0]!.tx_hash, SIGNATURE.toLowerCase(), "the old fold lowercased the signature");

    const now = await ledger();
    seed(now.raw, rows);
    // Every open runs it, so three opens.
    for (let i = 0; i < 3; i++) await applyLedgerSchema(now.db);
    const got = flows(now.raw);
    assert.equal(got[0]!.tx_hash, SIGNATURE, "left exactly as written");
    assert.equal(got[1]!.tx_hash, MIXED.toLowerCase(), "while the EVM hash beside it is folded as before");
  });
});

describe("anything else that is not a whole EVM hash", () => {
  it("is left as written too: a 0x string short of 64 hex digits is not an EVM hash", async () => {
    const now = await ledger();
    seed(now.raw, [{ tx: "0xAbC", log: 0, source: "chain-log", chain: CHAIN }]);
    await applyLedgerSchema(now.db);
    assert.equal(flows(now.raw)[0]!.tx_hash, "0xAbC");
  });
});

/** A live grant for one account on CHAIN, for the tests that write through the store. */
const grant = (smartAccount: string) =>
  ({
    smartAccount,
    owner: "0x00000000000000000000000000000000000000ff",
    sessionKeyAddress: "0x00000000000000000000000000000000000000fe",
    chainId: CHAIN,
    caps: { perTradeUsdg: 50, dailyUsdg: 500, expiryDays: 14, maxDrawdownPct: 10, maxOpsPerDay: 48 },
    grantedAt: 1_700_000_000,
    expiresAt: 1_800_000_000,
  }) as unknown as Parameters<typeof ensureAgent>[0];

describe("the writer, and the journal entry it chains", () => {
  const rowsOf = (agentId: string) => {
    const db = new DatabaseSync(homePaths.db());
    try {
      return db.prepare("SELECT tx_hash FROM flows WHERE agent_id = ? ORDER BY id").all(agentId) as Array<{ tx_hash: string }>;
    } finally {
      db.close();
    }
  };

  it("books an EVM hash lowercased, byte for byte the journal entry it always wrote", async () => {
    await initStore();
    const id = await ensureAgent(grant("0x00000000000000000000000000000000000000c2"));
    assert.equal(await addFlow({ agentId: id, direction: "out", amountUsdg: 5, source: "transfer-intent", txHash: MIXED, mode: "live" }), true);

    assert.deepEqual(rowsOf(id).map((r) => r.tx_hash), [MIXED.toLowerCase()]);
    const journal = await readJournal(id, await getAgentEpoch(id));
    assert.equal(journal.length, 1);
    assert.equal(
      journal[0]!.payload_json,
      canonicalJson({ amountUsdg: 5, blockNumber: null, direction: "out", logIndex: null, source: "transfer-intent", txHash: MIXED.toLowerCase() }),
    );
    assert.deepEqual(verifyChain(journal), []);
  });

  it("books a signature as written, in the row and in the journal, and an open does not touch either", async () => {
    await initStore();
    const id = await ensureAgent(grant("0x00000000000000000000000000000000000000c3"));
    assert.equal(await addFlow({ agentId: id, direction: "out", amountUsdg: 5, source: "transfer-intent", txHash: SIGNATURE, mode: "live" }), true);

    const epoch = await getAgentEpoch(id);
    const journal = await readJournal(id, epoch);
    assert.deepEqual(rowsOf(id).map((r) => r.tx_hash), [SIGNATURE]);
    assert.equal(JSON.parse(journal[0]!.payload_json).txHash, SIGNATURE);
    assert.deepEqual(verifyChain(journal), []);

    // Close and open the same file: the open runs every migration again.
    closeStoreForTest();
    await initStore();
    assert.deepEqual(rowsOf(id).map((r) => r.tx_hash), [SIGNATURE], "the open left the row as written");
    const reopened = await readJournal(id, epoch);
    assert.deepEqual(reopened, journal, "and the journal entry with it");
    assert.deepEqual(verifyChain(reopened), []);
  });
});

/**
 * THE LOOKUPS THAT STOP A SECOND BOOKING ASK UNDER THE SPELLING THE WRITER USED.
 *
 * hasFlowForTx is what settleTransferLanding (energy-settle.ts) asks before it
 * books a transfer home from its receipt; hasChainFlow is the same question
 * with a log index. Both used to lowercase every hash they were handed, which
 * matched the writer while the writer lowercased everything too. Now that a
 * signature is booked as written, a lowercasing lookup would miss it and the
 * same transfer would be booked twice, moving the peak again. Both ask under
 * ledgerTxHash now: for an EVM hash that is the lowercased hash, as before.
 */
describe("the lookups that stop a second booking", () => {
  it("find an EVM hash under every spelling, exactly as before", async () => {
    await initStore();
    const id = await ensureAgent(grant("0x00000000000000000000000000000000000000c4"));
    assert.equal(await addFlow({ agentId: id, direction: "out", amountUsdg: 5, source: "transfer-intent", txHash: MIXED, mode: "live" }), true);
    assert.equal(
      await addFlow({ agentId: id, direction: "in", amountUsdg: 7, source: "chain-log", txHash: UPPER, blockNumber: 100, logIndex: 3, mode: "live" }),
      true,
    );

    for (const spelling of [MIXED, MIXED.toLowerCase(), `0x${MIXED.slice(2).toUpperCase()}`, `0X${MIXED.slice(2)}`]) {
      assert.equal(await hasFlowForTx(id, spelling), true, `hasFlowForTx(${spelling})`);
    }
    for (const spelling of [UPPER, LOWER, `0X${UPPER.slice(2)}`]) {
      assert.equal(await hasChainFlow(id, spelling, 3), true, `hasChainFlow(${spelling}, 3)`);
      assert.equal(await hasFlowForTx(id, spelling), true, `hasFlowForTx(${spelling})`);
    }
    assert.equal(await hasChainFlow(id, UPPER, 4), false, "another log of the same tx is not booked");
    assert.equal(await hasFlowForTx(id, CAPITAL_X), false, "nor is a tx that was never booked");
  });

  it("find a signature booked as written, and only under that spelling", async () => {
    await initStore();
    const id = await ensureAgent(grant("0x00000000000000000000000000000000000000c5"));
    assert.equal(await hasFlowForTx(id, SIGNATURE), false, "nothing booked yet");
    assert.equal(await addFlow({ agentId: id, direction: "out", amountUsdg: 5, source: "transfer-intent", txHash: SIGNATURE, mode: "live" }), true);

    // The resolver's question before it books the same transfer from its
    // receipt. A lowercasing lookup answers false here, and it books again.
    assert.equal(await hasFlowForTx(id, SIGNATURE), true, "the transfer is seen as booked");
    // Base58 is case-sensitive: the lowercased string is some other signature.
    assert.equal(await hasFlowForTx(id, SIGNATURE.toLowerCase()), false, "a different signature is not");

    const other = base58Encode(Uint8Array.from({ length: 64 }, (_, i) => (i * 53 + 7) % 256));
    assert.notEqual(other, other.toLowerCase());
    assert.equal(
      await addFlow({ agentId: id, direction: "in", amountUsdg: 7, source: "chain-log", txHash: other, blockNumber: 100, logIndex: 2, mode: "live" }),
      true,
    );
    assert.equal(await hasChainFlow(id, other, 2), true, "the log is seen as booked");
    assert.equal(await hasChainFlow(id, other, 3), false, "another log of it is not");
    assert.equal(await hasChainFlow(id, other.toLowerCase(), 2), false, "nor the same log of a different signature");

    // And after a reopen, which runs the fold again, the answers are the same.
    closeStoreForTest();
    await initStore();
    assert.equal(await hasFlowForTx(id, SIGNATURE), true, "still seen after a reopen");
    assert.equal(await hasChainFlow(id, other, 2), true, "still seen after a reopen");
  });
});
