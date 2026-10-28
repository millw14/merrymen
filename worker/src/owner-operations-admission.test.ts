/**
 * ADMISSION ANSWERS AN OWNER'S OPERATION ONLY AS THE CHAIN PROVES IT.
 *
 * chainGapCheck reads the account's operations and USDG transfers and asks
 * Postgres for each. An owner record (owner_operations, mirrored from the
 * child) may answer an operation with no trade row — but only after the
 * operation's own log proves root, success and this account, and its receipt,
 * read now, re-derives to 'acknowledged' over the grant's custody. A session
 * key's operation is never answered by one; a capital leg still needs its
 * flow; a 'review' record is never loaded.
 *
 * On the 0x4b6dcd account's real receipts (testdata/owner-operations-receipts.json)
 * and 0x9eaa728e's pure USDG root withdrawal.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import type { Hex } from "viem";
import { wrapSqlite } from "./db";
import { applyLedgerSchema } from "./store";
import { MIRROR_STATE_DDL } from "./ledger-mirror";
import { PAPER_CHECKPOINT_SCHEMA } from "./paper-checkpoint";
import {
  chainFactsPostgresLacks, chainGapCheck, knownChainFacts, ownerAnswersFor, ownerOperationsPresent, readPgEvidence, resumePreconditions, type GapChain,
} from "./ledger-resume";
import type { RawLog } from "./inflight-reconcile";

type FixtureLog = [string, string[], string, string];
interface Fixture { tx: string; block: string; timestamp: number; logs: FixtureLog[] }
const FX = JSON.parse(readFileSync(new URL("./testdata/owner-operations-receipts.json", import.meta.url), "utf8")) as Record<string, Fixture>;
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const EP = "0x0000000071727de22e5e9d8baf0edac6f37da032";
const UOE = "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f";
const TENANT = "0x4b6dcd559c82ea897c34dacfb785fb0c8f85d4c5";
const A4B = "0xa96bf429888e1aab4255762d17d29c53f6a0370d";
const A9E = "0x9eaa728e989678bb3545dff3bd53d0e9cf19e33a";
const VAULT = "0xc8776faff15212c359b23bae531ff3ac7d760e0f";
const OP = {
  invalidateNonce: "0x496e7211db25d250d9142105ab5024debcf05519c734d83191145af8eac09ffa",
  vaultSweep: "0x0ea85970d6cd230721eb03d667ad46795f1f215647cbad9d1f456779be91c9b9",
  recoverFunds: "0x04f8241f6d02241469b9c2bc2d2f8cc4cca719eb5c6d54f3a77077c7e41ab3a7",
  pureUsdgWithdraw: "0xed68e288670aa284fb2df3702648df50b9420ed9751c675229887cc1336f7b77",
  sessionEnable: "0x75ab968e2c2dad36467d00f665ab8a2667539517a86d64fdd05d0aadb2c5e905",
} as const;
const HEAD = 80_000_000n;
const none = { ops: new Set<string>(), txs: new Set<string>(), flows: new Set<string>() };

/** The chain as admission reads it, from the fixtures named: their logs by address and topic, their receipts by hash. */
function chainOf(names: readonly string[], o: { receipts?: boolean; failReceipt?: boolean; mutate?: (l: RawLog) => RawLog } = {}): GapChain & { receiptReads: string[] } {
  const logs: RawLog[] = names.flatMap((n) => FX[n]!.logs.map(([address, topics, data, logIndex]) => ({
    address, topics: topics as Hex[], data: data as Hex, transactionHash: FX[n]!.tx as Hex, blockNumber: FX[n]!.block as Hex, logIndex: logIndex as Hex,
  }) as RawLog & { address: string }));
  const receiptReads: string[] = [];
  const chain: GapChain & { receiptReads: string[] } = {
    receiptReads,
    async getBlockNumber() { return HEAD; },
    async getBlockTimestamp() { return 0; },
    async getLogs(a) {
      return logs.filter((l) => (l as RawLog & { address: string }).address === a.address.toLowerCase() && BigInt(l.blockNumber!) >= a.fromBlock && BigInt(l.blockNumber!) <= a.toBlock
        && a.topics.every((t, i) => t === null || String(t).toLowerCase() === String(l.topics[i] ?? "").toLowerCase())).map((l) => (o.mutate ? o.mutate(l) : l));
    },
  };
  if (o.receipts !== false) {
    chain.getReceiptLogs = async (tx: string) => {
      receiptReads.push(tx);
      if (o.failReceipt) throw new Error("rate limited");
      const f = Object.values(FX).find((x) => typeof x === "object" && (x as Fixture).tx === tx) as Fixture | undefined;
      return f ? f.logs.map(([address, topics, data, logIndex]) => ({ address, topics, data, logIndex })) : null;
    };
  }
  return chain;
}
const check = (chain: GapChain, account: string, known: Parameters<typeof chainGapCheck>[0]["known"], custody: string[] = [VAULT]) =>
  chainGapCheck({ chain, account, usdg: USDG, fromBlock: 60_000_000n, known, ownerContext: { custody, chainId: 4663 }, maxSpan: 50_000_000n });
const record = (name: keyof typeof OP) => new Map([[OP[name], FX[name]!.tx]]);

describe("an owner record answers an operation only as the chain proves it", () => {
  it("invalidateNonce, with its acknowledged record: answered — clean", async () => {
    const r = await check(chainOf(["invalidateNonce"]), A4B, { ...none, ownerRecords: record("invalidateNonce") });
    assert.equal(r.status, "clean");
  });

  it("without a record, the same operation is missing, as today", async () => {
    const r = await check(chainOf(["invalidateNonce"]), A4B, none);
    assert.equal(r.status, "missing");
  });

  it("the vault's sweep(USDG): the operation and its custody leg (log 13) are both answered by the record, with no flow", async () => {
    const r = await check(chainOf(["vaultSweep"]), A4B, { ...none, ownerRecords: record("vaultSweep") });
    assert.equal(r.status, "clean");
  });

  it("the same sweep re-derived WITHOUT the vault as custody: the operation is answered, but its USDG leg is capital and stays missing until its flow", async () => {
    const r = await check(chainOf(["vaultSweep"]), A4B, { ...none, ownerRecords: record("vaultSweep") }, []);
    assert.equal(r.status, "missing");
    if (r.status !== "missing") return;
    assert.deepEqual(r.found.map((f) => [f.kind, f.logIndex]), [["transfer", 13]]);
    const flowed = await check(chainOf(["vaultSweep"]), A4B, { ...none, flows: new Set([`${FX.vaultSweep!.tx}:13`]), ownerRecords: record("vaultSweep") }, []);
    assert.equal(flowed.status, "clean");
  });

  it("a pure USDG root withdrawal: the operation answered, its capital-out (log 18) missing until the scanner's flow holds it", async () => {
    const r = await check(chainOf(["pureUsdgWithdraw"]), A9E, { ...none, ownerRecords: record("pureUsdgWithdraw") });
    assert.equal(r.status, "missing");
    if (r.status === "missing") assert.deepEqual(r.found.map((f) => [f.kind, f.logIndex, (f as { direction?: string }).direction]), [["transfer", 18, "out"]]);
    const flowed = await check(chainOf(["pureUsdgWithdraw"]), A9E, { ...none, flows: new Set([`${FX.pureUsdgWithdraw!.tx}:18`]), ownerRecords: record("pureUsdgWithdraw") });
    assert.equal(flowed.status, "clean");
  });

  it("recoverFunds with a row CLAIMING 'acknowledged': the receipt re-derives 'review' (NVDA left), so the operation stays missing — the row decides nothing", async () => {
    const r = await check(chainOf(["recoverFunds"]), A4B, { ...none, flows: new Set([`${FX.recoverFunds!.tx}:8`]), ownerRecords: record("recoverFunds") });
    assert.equal(r.status, "missing");
    if (r.status === "missing") assert.deepEqual(r.found.map((f) => [f.kind, f.kind === "operation" ? f.userOpHash : f.logIndex]), [["operation", OP.recoverFunds]]);
  });

  it("a record in ANOTHER transaction answers nothing", async () => {
    const r = await check(chainOf(["invalidateNonce"]), A4B, { ...none, ownerRecords: new Map([[OP.invalidateNonce, FX.vaultSweep!.tx]]) });
    assert.equal(r.status, "missing");
  });

  it("a record naming the SESSION KEY's operation answers nothing: its log is not root, and admission is never loosened for a session op", async () => {
    const chain = chainOf(["sessionEnable"]);
    const r = await check(chain, A4B, { ...none, flows: new Set([`${FX.sessionEnable!.tx}:36`]), ownerRecords: record("sessionEnable") });
    assert.equal(r.status, "missing");
    if (r.status === "missing") assert.ok(r.found.some((f) => f.kind === "operation" && f.userOpHash === OP.sessionEnable));
    assert.deepEqual(chain.receiptReads, [], "not even its receipt is read");
  });

  it("an operation log whose data does not decode answers nothing", async () => {
    const chain = chainOf(["invalidateNonce"], { mutate: (l) => (l.topics[0] === UOE ? { ...l, data: "0x1234" as Hex } : l) });
    const r = await check(chain, A4B, { ...none, ownerRecords: record("invalidateNonce") });
    assert.equal(r.status, "missing");
  });

  it("a receipt that cannot be read is 'unavailable' (retried), never clean", async () => {
    const r = await check(chainOf(["invalidateNonce"], { failReceipt: true }), A4B, { ...none, ownerRecords: record("invalidateNonce") });
    assert.equal(r.status, "unavailable");
  });

  it("a receipt the node says it does not have is 'unavailable' too, never clean and never skipped", async () => {
    const chain = chainOf(["invalidateNonce"]);
    chain.getReceiptLogs = async () => null;
    const r = await check(chain, A4B, { ...none, ownerRecords: record("invalidateNonce") });
    assert.equal(r.status, "unavailable");
  });

  it("the pure rule holds an operation by an owner answer only in the answer's own transaction", () => {
    const opLog = FX.invalidateNonce!.logs.find(([, t]) => t[0] === UOE)!;
    const op: RawLog = { topics: opLog[1] as Hex[], data: opLog[2] as Hex, transactionHash: FX.invalidateNonce!.tx as Hex, blockNumber: FX.invalidateNonce!.block as Hex,
      logIndex: opLog[3] as Hex };
    const answer = (txHash: string) => new Map([[OP.invalidateNonce, { txHash, covers: new Set<string>() }]]);
    assert.deepEqual(chainFactsPostgresLacks({ account: A4B, opLogs: [op], outLogs: [], inLogs: [], known: none, ownerAnswers: answer(FX.invalidateNonce!.tx) }), []);
    assert.deepEqual(chainFactsPostgresLacks({ account: A4B, opLogs: [op], outLogs: [], inLogs: [], known: none, ownerAnswers: answer(FX.vaultSweep!.tx) })
      .map((f) => f.kind), ["operation"]);
    assert.deepEqual(chainFactsPostgresLacks({ account: A9E, opLogs: [op], outLogs: [], inLogs: [], known: none, ownerAnswers: answer(FX.invalidateNonce!.tx) })
      .map((f) => f.kind), ["operation"], "and only for this account's own operation");
  });

  it("a chain that cannot read receipts answers nothing through a record: missing, fail closed", async () => {
    const r = await check(chainOf(["invalidateNonce"], { receipts: false }), A4B, { ...none, ownerRecords: record("invalidateNonce") });
    assert.equal(r.status, "missing");
  });

  it("no ownerContext, no answer", async () => {
    const r = await chainGapCheck({ chain: chainOf(["invalidateNonce"]), account: A4B, usdg: USDG, fromBlock: 60_000_000n, known: { ...none, ownerRecords: record("invalidateNonce") },
      maxSpan: 50_000_000n });
    assert.equal(r.status, "missing");
  });

  it("a covered leg the check did not itself read is not taken on the reading's word", async () => {
    const chain = chainOf(["vaultSweep"]);
    const opLogs = await chain.getLogs({ address: EP as `0x${string}`, fromBlock: 0n, toBlock: HEAD, topics: [UOE as Hex] });
    const known = { ops: new Set<string>(), ownerRecords: record("vaultSweep") };
    const ctx = { custody: [VAULT], chainId: 4663 };
    const answered = await ownerAnswersFor({ chain, account: A4B, usdg: USDG, opLogs, usdgLogs: await chain.getLogs({ address: USDG as `0x${string}`, fromBlock: 0n, toBlock: HEAD, topics: [] }),
      known, ownerContext: ctx });
    assert.deepEqual(answered !== "unavailable" && [...answered.get(OP.vaultSweep)!.covers], [`${FX.vaultSweep!.tx}:13`]);
    const unread = await ownerAnswersFor({ chain, account: A4B, usdg: USDG, opLogs, usdgLogs: [], known, ownerContext: ctx });
    assert.equal(unread !== "unavailable" && unread.has(OP.vaultSweep), false);
  });

  it("an answered owner operation does not cover the OTHER USDG legs of its transaction (the pure rule)", () => {
    const tx = FX.invalidateNonce!.tx;
    const opLog = FX.invalidateNonce!.logs.find(([, t]) => t[0] === UOE)!;
    const op: RawLog = { topics: opLog[1] as Hex[], data: opLog[2] as Hex, transactionHash: tx as Hex, blockNumber: FX.invalidateNonce!.block as Hex, logIndex: opLog[3] as Hex };
    const pad = (a: string) => `0x${a.slice(2).padStart(64, "0")}` as Hex;
    const leg: RawLog = { topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as Hex, pad(A4B), pad(`0x${"e0".repeat(20)}`)], data: `0x${"1".padStart(64, "0")}` as Hex,
      transactionHash: tx as Hex, blockNumber: FX.invalidateNonce!.block as Hex, logIndex: "0x2" as Hex };
    const found = chainFactsPostgresLacks({ account: A4B, opLogs: [op], outLogs: [leg], inLogs: [], known: none,
      ownerAnswers: new Map([[OP.invalidateNonce, { txHash: tx, covers: new Set<string>() }]]) });
    assert.deepEqual(found.map((f) => f.kind), ["transfer"], "the operation is held; the leg is not");
    // A trade row's operation, by contrast, holds every leg of its transaction (unchanged).
    assert.deepEqual(chainFactsPostgresLacks({ account: A4B, opLogs: [op], outLogs: [leg], inLogs: [], known: { ...none, ops: new Set([OP.invalidateNonce]) } }), []);
  });
});

// ── a USDG log that moves nothing ────────────────────────────────────────────
//
// A root operation whose only USDG log is a self-transfer (or an amount of
// zero) re-derives 'acknowledged'. Admission reads that log as a USDG
// transfer of the account like any other, so the record must answer it too,
// or the tenant is held for good on an operation its record says is settled.

const TR = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const BEFORE = "0xbb47ee3e183a558b1a2ff0874b079f3fc5478b7454eacf2bfc5af2ff5878f972";
const ROOT_NONCE = (0x845adb2c711129d4f3966735ed98a9f09fc4ce57n << 64n) | 4n;
const word = (n: bigint) => n.toString(16).padStart(64, "0");
const pad = (a: string) => `0x${a.replace(/^0x/, "").padStart(64, "0")}`;
const EOA = `0x${"e0".repeat(20)}`;
const SYNTH_OP = `0x${"5a".repeat(32)}`;
/** A synthetic root operation of A4B in its own transaction, its execution carrying `legs` (each [from, to, amount]); `outside` puts the first leg ahead of BeforeExecution. */
function synthetic(name: string, legs: Array<[string, string, bigint]>, o: { outside?: boolean } = {}): string {
  const tx = `0x${name.length.toString(16).padStart(2, "0")}${"7a".repeat(31)}`;
  const transfers: FixtureLog[] = legs.map(([from, to, amount], i) => [USDG, [TR, pad(from), pad(to)], `0x${word(amount)}`, `0x${(i + 1).toString(16)}`]);
  const before: FixtureLog = [EP, [BEFORE], "0x", o.outside ? `0x${(legs.length + 1).toString(16)}` : "0x0"];
  if (o.outside) transfers[0]![3] = "0x0";
  const event: FixtureLog = [EP, [UOE, SYNTH_OP, pad(A4B), pad(`0x${"0".repeat(40)}`)], `0x${word(ROOT_NONCE)}${word(1n)}${word(1000n)}${word(50n)}`,
    `0x${(legs.length + 2).toString(16)}`];
  FX[name] = { tx, block: "0x4000000", timestamp: 1_790_000_000, logs: [before, ...transfers, event] };
  return tx;
}

describe("a USDG log of the account that moves nothing", () => {
  it("a self-transfer, alone in a root operation, is answered by its acknowledged record: clean — and without the record, both are missing", async () => {
    const tx = synthetic("selfOnly", [[A4B, A4B, 5_000_000n]]);
    const r = await check(chainOf(["selfOnly"]), A4B, { ...none, ownerRecords: new Map([[SYNTH_OP, tx]]) });
    assert.equal(r.status, "clean", r.status === "missing" ? JSON.stringify(r.found) : "");
    const bare = await check(chainOf(["selfOnly"]), A4B, none);
    assert.equal(bare.status, "missing");
    if (bare.status === "missing") assert.deepEqual(bare.found.map((f) => [f.kind, (f as { direction?: string }).direction ?? null]), [["transfer", "self"], ["operation", null]]);
  });

  it("an amount of zero to an outside wallet moves nothing either: answered", async () => {
    const tx = synthetic("zeroOut", [[A4B, EOA, 0n]]);
    const r = await check(chainOf(["zeroOut"]), A4B, { ...none, ownerRecords: new Map([[SYNTH_OP, tx]]) });
    assert.equal(r.status, "clean", r.status === "missing" ? JSON.stringify(r.found) : "");
  });

  it("a USDG log whose amount cannot be read ('0x', or no data) is NOT an amount of zero: the reading vouches for nothing, and the operation and the log both stay missing", async () => {
    // (synthetic() names a transaction by its name's length: these two are unused lengths.)
    for (const [name, data] of [["emptyDataLeg", "0x"], ["missingDataLeg", ""]] as const) {
      const tx = synthetic(name, [[A4B, EOA, 0n]]);
      FX[name]!.logs[1]![2] = data;
      const r = await check(chainOf([name]), A4B, { ...none, ownerRecords: new Map([[SYNTH_OP, tx]]) });
      assert.equal(r.status, "missing", name);
      if (r.status === "missing") {
        assert.deepEqual(r.found.map((f) => [f.kind, f.kind === "transfer" ? f.amountRaw : f.userOpHash]), [["transfer", null], ["operation", SYNTH_OP]], name);
      }
    }
  });

  it("a self-transfer BESIDE a real withdrawal does not answer the withdrawal: that capital leg still needs its flow", async () => {
    const tx = synthetic("selfAndOut", [[A4B, A4B, 5_000_000n], [A4B, EOA, 7_000_000n]]);
    const r = await check(chainOf(["selfAndOut"]), A4B, { ...none, ownerRecords: new Map([[SYNTH_OP, tx]]) });
    assert.equal(r.status, "missing");
    if (r.status === "missing") assert.deepEqual(r.found.map((f) => [f.kind, f.logIndex, (f as { direction?: string }).direction]), [["transfer", 2, "out"]]);
    const flowed = await check(chainOf(["selfAndOut"]), A4B, { ...none, flows: new Set([`${tx}:2`]), ownerRecords: new Map([[SYNTH_OP, tx]]) });
    assert.equal(flowed.status, "clean");
  });

  it("a self-transfer OUTSIDE the operation's execution is not the record's: the reading is review, and the operation stays missing", async () => {
    const tx = synthetic("selfOutside", [[A4B, A4B, 5_000_000n]], { outside: true });
    const r = await check(chainOf(["selfOutside"]), A4B, { ...none, ownerRecords: new Map([[SYNTH_OP, tx]]) });
    assert.equal(r.status, "missing");
    if (r.status === "missing") assert.ok(r.found.some((f) => f.kind === "operation" && f.userOpHash === SYNTH_OP));
  });

  it("a cover is held only as its own log says: a covered log that moved USDG to an outside wallet is not taken on the reading's word", async () => {
    const tx = synthetic("selfCheck", [[A4B, A4B, 5_000_000n]]);
    const chain = chainOf(["selfCheck"]);
    const opLogs = await chain.getLogs({ address: EP as `0x${string}`, fromBlock: 0n, toBlock: HEAD, topics: [UOE as Hex] });
    const usdgLogs = await chain.getLogs({ address: USDG as `0x${string}`, fromBlock: 0n, toBlock: HEAD, topics: [] });
    const known = { ops: new Set<string>(), ownerRecords: new Map([[SYNTH_OP, tx]]) };
    const ctx = { custody: [VAULT], chainId: 4663 };
    const answered = await ownerAnswersFor({ chain, account: A4B, usdg: USDG, opLogs, usdgLogs, known, ownerContext: ctx });
    assert.deepEqual(answered !== "unavailable" && [...answered.get(SYNTH_OP)!.covers], [`${tx}:1`]);
    // The log the check read says otherwise (A4B -> an outside wallet, 5 USDG): the cover does not check, and nothing is answered.
    const lied = usdgLogs.map((l) => ({ ...l, topics: [l.topics[0]!, l.topics[1]!, pad(EOA) as Hex] }));
    const refused = await ownerAnswersFor({ chain, account: A4B, usdg: USDG, opLogs, usdgLogs: lied, known, ownerContext: ctx });
    assert.equal(refused !== "unavailable" && refused.has(SYNTH_OP), false);
  });
});

// ── Postgres's side ──────────────────────────────────────────────────────────

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const NOW = 1_800_000_000;
const CONTROLS = { readable: true, why: null };
async function sharedDb(o: { table?: boolean; grant?: string | null } = {}) {
  const raw = new DatabaseSync(":memory:");
  const shared = wrapSqlite(raw);
  await applyLedgerSchema(shared); await shared.exec(MIRROR_STATE_DDL); await shared.exec(PAPER_CHECKPOINT_SCHEMA);
  if (o.table === false) raw.exec("DROP TABLE owner_operations");
  // The orchestrator's grants, as the mirror and admission read them: the tenant's account.
  raw.exec("CREATE TABLE grants (tenant TEXT PRIMARY KEY, grant_json TEXT NOT NULL)");
  if (o.grant !== null) raw.prepare("INSERT INTO grants VALUES (?, ?)").run(TENANT, JSON.stringify({ smartAccount: o.grant ?? A4B }));
  raw.prepare(`INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, status, epoch, hwm_usdg, mode)
    VALUES (?, ?, ?, 4663, '{}', 1, 9999999999, 'armed', 1, 0, 'paper')`).run(A4B, TENANT, addr(1));
  raw.prepare("INSERT INTO trades (agent_id, kind, target, amount_usdg, status, created_at, epoch) VALUES (?, 'swap', 'x', 5, 'paper', ?, 1)").run(A4B, NOW - 5 * 86_400);
  raw.prepare("INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, at, epoch, mode) VALUES (?, '0', 90, 0, 10, 100, ?, 1, 'paper')").run(A4B, NOW - 5 * 86_400);
  return { raw, shared };
}
const insertRecord = (raw: DatabaseSync, o: { hash: string; tx: string; tenant?: string | null; agent?: string; chain?: number; disposition?: "acknowledged" | "review" }) =>
  raw.prepare(`INSERT INTO owner_operations (tenant, agent_id, chain_id, user_op_hash, tx_hash, block_number, block_time, log_index, nonce, validator, disposition, review_reason,
      usdg_legs_json, covers_logs_json, token_moves_json, paymaster, gas_wei, source, recorded_epoch, created_at)
    VALUES (?, ?, ?, ?, ?, 1, 1, 1, '0x0', 'root', ?, ?, '[]', '[]', '[]', ?, '1', 'arm-reconcile', 1, 100)`)
    .run(o.tenant === undefined ? TENANT : o.tenant, o.agent ?? A4B, o.chain ?? 4663, o.hash, o.tx, o.disposition ?? "acknowledged",
      (o.disposition ?? "acknowledged") === "review" ? "token-departed" : null, addr(0));

describe("what Postgres offers admission", () => {
  it("knownChainFacts loads only acknowledged root records of THIS tenant, account and chain — and none without the tenant", async () => {
    const { raw, shared } = await sharedDb();
    insertRecord(raw, { hash: OP.invalidateNonce, tx: FX.invalidateNonce!.tx });
    insertRecord(raw, { hash: OP.recoverFunds, tx: FX.recoverFunds!.tx, disposition: "review" });
    insertRecord(raw, { hash: OP.vaultSweep, tx: FX.vaultSweep!.tx, tenant: addr(0xbad) });
    insertRecord(raw, { hash: OP.pureUsdgWithdraw, tx: FX.pureUsdgWithdraw!.tx, chain: 46630 });
    insertRecord(raw, { hash: OP.sessionEnable, tx: FX.sessionEnable!.tx, tenant: null });
    const k = await knownChainFacts(shared, A4B, { tenant: TENANT, chainId: 4663 });
    assert.deepEqual([...k.ownerRecords], [[OP.invalidateNonce, FX.invalidateNonce!.tx]]);
    assert.equal((await knownChainFacts(shared, A4B)).ownerRecords.size, 0, "a caller that names no tenant gets no owner answers");
  });

  it("ONLY FOR THE TENANT'S OWN ACCOUNT: no grant, a grant naming another account, or two grant rows, and no owner record answers anything", async () => {
    const ask = async (shared: Awaited<ReturnType<typeof sharedDb>>["shared"], account = A4B) =>
      [...(await knownChainFacts(shared, account, { tenant: TENANT, chainId: 4663 })).ownerRecords];
    const own = await sharedDb();
    insertRecord(own.raw, { hash: OP.invalidateNonce, tx: FX.invalidateNonce!.tx });
    assert.deepEqual(await ask(own.shared), [[OP.invalidateNonce, FX.invalidateNonce!.tx]], "the grant names this account");
    const ungranted = await sharedDb({ grant: null });
    insertRecord(ungranted.raw, { hash: OP.invalidateNonce, tx: FX.invalidateNonce!.tx });
    assert.deepEqual(await ask(ungranted.shared), [], "no grant row");
    const other = await sharedDb({ grant: A9E });
    insertRecord(other.raw, { hash: OP.invalidateNonce, tx: FX.invalidateNonce!.tx });
    assert.deepEqual(await ask(other.shared), [], "the grant names another account");
    // A record stamped with this tenant under the account its grant does NOT name answers for neither.
    insertRecord(other.raw, { hash: OP.pureUsdgWithdraw, tx: FX.pureUsdgWithdraw!.tx, agent: A9E });
    assert.deepEqual(await ask(other.shared), [], "the caller's account is not the grant's");
    assert.deepEqual(await ask(other.shared, A9E), [[OP.pureUsdgWithdraw, FX.pureUsdgWithdraw!.tx]], "the grant's account, and only it");
    const two = await sharedDb();
    insertRecord(two.raw, { hash: OP.invalidateNonce, tx: FX.invalidateNonce!.tx });
    two.raw.prepare("INSERT INTO grants VALUES (?, ?)").run(TENANT.toUpperCase().replace(/^0X/, "0x"), JSON.stringify({ smartAccount: A4B }));
    assert.deepEqual(await ask(two.shared), [], "two grant rows name the tenant: ambiguous, so none");
    const table = await sharedDb();
    table.raw.exec("DROP TABLE grants");
    insertRecord(table.raw, { hash: OP.invalidateNonce, tx: FX.invalidateNonce!.tx });
    assert.deepEqual(await ask(table.shared), [], "no grants table: none, and nothing thrown");
  });

  it("the identity is PER ACCOUNT: another tenant's record of the same hash under its own account neither blocks nor answers this tenant's", async () => {
    const { raw, shared } = await sharedDb();
    insertRecord(raw, { hash: OP.invalidateNonce, tx: FX.invalidateNonce!.tx, tenant: addr(0xbad), agent: A9E });
    insertRecord(raw, { hash: OP.invalidateNonce, tx: FX.invalidateNonce!.tx });
    assert.throws(() => insertRecord(raw, { hash: OP.invalidateNonce, tx: FX.invalidateNonce!.tx, agent: A4B.toUpperCase().replace(/^0X/, "0x") }), /UNIQUE/,
      "one record per (chain, account, operation), in any letter-case");
    assert.deepEqual([...(await knownChainFacts(shared, A4B, { tenant: TENANT, chainId: 4663 })).ownerRecords], [[OP.invalidateNonce, FX.invalidateNonce!.tx]]);
  });

  it("a database without the table answers no owner record, and throws nothing", async () => {
    const { shared } = await sharedDb({ table: false });
    assert.equal(await ownerOperationsPresent(shared), false);
    assert.equal((await knownChainFacts(shared, A4B, { tenant: TENANT, chainId: 4663 })).ownerRecords.size, 0);
    const pre = await resumePreconditions(shared, { tenant: TENANT, account: A4B, grantAccount: A4B, nowSec: NOW, controls: CONTROLS, homePendingImport: false });
    assert.equal(pre.paper, true);
  });

  it("a paper tenant whose account the owner used on chain is read on chain: an owner record counts as a live operation", async () => {
    const { raw, shared } = await sharedDb();
    const before = await resumePreconditions(shared, { tenant: TENANT, account: A4B, grantAccount: A4B, nowSec: NOW, controls: CONTROLS, homePendingImport: false });
    assert.equal(before.chainRequired, false);
    insertRecord(raw, { hash: OP.invalidateNonce, tx: FX.invalidateNonce!.tx, disposition: "review" });
    const after = await resumePreconditions(shared, { tenant: TENANT, account: A4B, grantAccount: A4B, nowSec: NOW, controls: CONTROLS, homePendingImport: false });
    assert.equal(after.chainRequired, true);
    assert.equal(after.suggestedLevel, "exits-only");
  });

  it("an owner record under another spelling of the account is a second spelling, refused as for every financial table", async () => {
    const { raw, shared } = await sharedDb();
    insertRecord(raw, { hash: OP.invalidateNonce, tx: FX.invalidateNonce!.tx, agent: "0xA96bf429888e1aab4255762d17d29c53f6a0370D" });
    const pre = await resumePreconditions(shared, { tenant: TENANT, account: A4B, grantAccount: A4B, nowSec: NOW, controls: CONTROLS, homePendingImport: false });
    assert.ok(pre.refusals.some((r) => /spelled 2 ways/.test(r)), pre.refusals.join(" | "));
  });

  it("the evidence binds the tenant's owner records where there are any, and is unchanged where there are none", async () => {
    const { raw, shared } = await sharedDb();
    const empty = await readPgEvidence(shared, { tenant: TENANT, account: A4B, nowSec: NOW });
    assert.equal(Object.hasOwn(empty.tables, "ownerOperations"), false);
    insertRecord(raw, { hash: OP.invalidateNonce, tx: FX.invalidateNonce!.tx });
    const one = await readPgEvidence(shared, { tenant: TENANT, account: A4B, nowSec: NOW });
    assert.equal((one.tables.ownerOperations as { n: string }).n, "1");
    raw.prepare("UPDATE owner_operations SET disposition = 'review', review_reason = 'token-departed'").run();
    const changed = await readPgEvidence(shared, { tenant: TENANT, account: A4B, nowSec: NOW });
    assert.notEqual((changed.tables.ownerOperations as { digest: string }).digest, (one.tables.ownerOperations as { digest: string }).digest);
  });
});
