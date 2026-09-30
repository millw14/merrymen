/**
 * THE ON-CHAIN PERP LEGS ON THE USEROP RAIL (perps/legs.ts; docs/perps.md
 * rules 3, 9, 12; the no-trades-rows and margin-in-transit amendments).
 *
 * main() cannot be booted by a test, so processIntentLocked's perp arm is
 * pinned twice: its ORDER over index.ts's text (perp-legs-wiring.test.ts), and
 * its PIECES here, run the way that arm, the stranded resolver and the orphan
 * sweep run them — the same functions, in the same order, against a REAL
 * sqlite ledger, with a fake executor that behaves as executor.ts does (the
 * `submitted` row written by its hook BEFORE anything is broadcast) and fake
 * receipts shaped as Robinhood Chain returns them.
 *
 *   what is signed   — the fence runs over every build and refuses a builder
 *                      that drifted; the key registration's index comes from
 *                      the chain and must match the plan.
 *   what landed      — the proxy's own event in the op's OWN logs names the
 *                      leg; another sender's deposit in the same bundle is
 *                      never ours; ambiguity is never guessed into a kind.
 *   what is recorded — the pre-broadcast trades row and the deposit's margin
 *                      row commit together; the landed settlement moves the
 *                      margin row `submitted → landed` in the same db.tx, with
 *                      one `margin` journal entry; the stranded resolver and
 *                      the orphan sweep reach exactly the same rows.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import { encodeAbiParameters, encodeFunctionData, erc20Abi, toEventSelector, type Hex } from "viem";
import { ENTRYPOINT, LIGHTER_ROUTE_V1, type PerpGrant } from "../../../packages/core/src/index";
import { verifyChain } from "../audit";
import type { Call, ExecuteHooks } from "../executor";
import { execModeOf, type ExecInputs } from "../exec-mode";
import { findOrphanOps, opLogsOf, resolveSubmittedOps, type ReconcileChain } from "../inflight-reconcile";
import type { ReceiptLog } from "../fills";
import type { TradeIntent } from "../policy";
import {
  LIGHTER_PRIORITY_REQUEST_TOPIC,
  PERP_LEG_KINDS,
  isPerpLegKind,
  perpClaimExecMode,
  perpLegCalls,
  perpLegCashExplained,
  perpLegKind,
  perpLegLandedTransfer,
  perpLegMismatch,
  perpLegOfReceipt,
  perpLegOrphan,
  perpLegResolution,
  perpLegSubmittedTransfer,
  readLighterAccountIndex,
  readLighterPendingAt,
  type PerpLegIntent,
} from "./legs";

const key = (b: string) => `0x${(b + "00".repeat(7)).repeat(5)}` as `0x${string}`;
const SEALED = key("01");
const PERP: PerpGrant = { route: "perp-lighter-v1", apiKeyIndex: 16, apiPublicKey: SEALED };
const PROXY = LIGHTER_ROUTE_V1.proxy;
const USDG_TOKEN = LIGHTER_ROUTE_V1.usdg;
const EP = (ENTRYPOINT.v07 as string).toLowerCase() as `0x${string}`;
const OTHER = "0x4444444444444444444444444444444444444444" as `0x${string}`;
const IDX = 22_149n;
const CHAIN = LIGHTER_ROUTE_V1.chainId;
const USDG = (n: number) => BigInt(Math.round(n * 1_000_000));
const pad = (a: string) => `0x${"0".repeat(24)}${a.slice(2).toLowerCase()}` as Hex;
const h32 = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;
const USEROP_TOPIC = "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f" as Hex;
const BEFORE_EXEC_TOPIC = toEventSelector("BeforeExecution()") as Hex;
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as Hex;

const deposit = (amountUsdg: bigint): PerpLegIntent => ({ kind: "perp-margin", direction: "deposit", target: PROXY, amountUsdg });
const claim = (amountUsdg: bigint): PerpLegIntent => ({ kind: "perp-margin", direction: "claim", amountUsdg });
const register = (accountIndex: number): PerpLegIntent => ({ kind: "perp-key", accountIndex });

// ── receipt logs, shaped as the chain returns them ──────────────────────────

type L = ReceiptLog & { logIndex: number };
const transferLog = (i: number, from: string, to: string, amount: bigint): L => ({
  address: USDG_TOKEN,
  topics: [TRANSFER_TOPIC, pad(from), pad(to)],
  data: encodeAbiParameters([{ type: "uint256" }], [amount]),
  logIndex: i,
});
const depositLog = (i: number, to: string, amount: bigint, o: { idx?: bigint; asset?: number; route?: number; address?: string } = {}): L => ({
  address: o.address ?? PROXY,
  topics: [LIGHTER_ROUTE_V1.topics.deposit],
  data: encodeAbiParameters(
    [{ type: "uint48" }, { type: "address" }, { type: "uint16" }, { type: "uint8" }, { type: "uint128" }],
    [Number(o.idx ?? IDX), to as `0x${string}`, o.asset ?? 3, o.route ?? 0, amount],
  ),
  logIndex: i,
});
const withdrawPendingLog = (i: number, owner: string, amount: bigint): L => ({
  address: PROXY,
  topics: [LIGHTER_ROUTE_V1.topics.withdrawPending, pad(owner)],
  data: encodeAbiParameters([{ type: "uint16" }, { type: "uint128" }], [3, amount]),
  logIndex: i,
});
const u48 = (v: bigint) => v.toString(16).padStart(12, "0");
const priorityLog = (i: number, sender: string, type: number, pubData: Hex): L => ({
  address: PROXY,
  topics: [LIGHTER_PRIORITY_REQUEST_TOPIC as Hex],
  data: encodeAbiParameters(
    [{ type: "address" }, { type: "uint64" }, { type: "uint8" }, { type: "bytes" }, { type: "uint64" }],
    [sender as `0x${string}`, 7n, type, pubData, 1_900_000_000n],
  ),
  logIndex: i,
});
const changePubKeyData = (idx: bigint, pk: `0x${string}`, apiKeyIndex = 16) =>
  `0x3e${u48(idx)}${u48(idx)}${apiKeyIndex.toString(16).padStart(2, "0")}${pk.slice(2)}` as Hex;
const userOpEvent = (i: number, hash: string, sender: string, success = true, nonce = 5n): L => ({
  address: EP,
  topics: [USEROP_TOPIC, hash as Hex, pad(sender), pad("0x0000000000000000000000000000000000000000")],
  data: encodeAbiParameters([{ type: "uint256" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }], [nonce, success, 1000n, 100n]),
  logIndex: i,
});
const beforeExecution = (i: number): L => ({ address: EP, topics: [BEFORE_EXEC_TOPIC], data: "0x", logIndex: i });

/** One deposit op's own logs: Transfer(self → proxy), the deposit's priority request, Deposit(self). */
const depositOpLogs = (self: string, amount: bigint, from = 0) => [
  transferLog(from, self, PROXY, amount),
  priorityLog(from + 1, self, 61, "0x3d"),
  depositLog(from + 2, self, amount),
];

// ── a real ledger ───────────────────────────────────────────────────────────

const scratch = mkdtempSync(path.join(os.tmpdir(), "merrymen-perp-legs-"));
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
// A second connection to the same file, for looking at the rows themselves.
const raw = new DatabaseSync(path.join(process.env.MERRYMEN_HOME, "merrymen.db"));
raw.exec("PRAGMA busy_timeout = 5000");
after(() => {
  raw.close();
  store.closeStoreForTest();
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

let nextAgent = 1;
async function agent(): Promise<`0x${string}`> {
  const account = `0xab${(nextAgent++).toString(16).padStart(38, "0")}`;
  return (await store.ensureAgent({
    smartAccount: account,
    owner: "0x00000000000000000000000000000000000000b1",
    sessionKeyAddress: "0x00000000000000000000000000000000000000c1",
    serialized: "x",
    caps: { perTradeUsdg: 50, dailyUsdg: 500, expiryDays: 14, maxDrawdownPct: 10, maxOpsPerDay: 48 },
    grantedAt: 1_000_000,
    expiresAt: 2_000_000_000,
    chainId: 4663,
  } as never)) as `0x${string}`;
}

interface TradeDb {
  kind: string;
  target: string;
  status: string;
  amount_usdg: number;
  user_op_hash: string | null;
  tx_hash: string | null;
  sell_token: string | null;
  buy_token: string | null;
  fill_side: string | null;
  fill_cash_usdg: number | null;
  fill_qty_raw: string | null;
  trade_fee_usdg: number | null;
}
async function tradesOf(agentId: string): Promise<TradeDb[]> {
  return raw.prepare("SELECT * FROM trades WHERE agent_id = ? ORDER BY id").all(agentId) as unknown as TradeDb[];
}
async function transfersOf(agentId: string) {
  return raw.prepare("SELECT * FROM perp_transfers WHERE agent_id = ? ORDER BY created_at, id").all(agentId.toLowerCase()) as unknown as {
    direction: string;
    state: string;
    amount_micro: string;
    user_op_hash: string | null;
    chain_id: number | null;
    tx_hash: string | null;
    log_index: number | null;
    initiator: string;
  }[];
}
const marginEntries = async (agentId: string) => (await store.readJournal(agentId, 1)).filter((e) => e.kind === "margin");

/**
 * processIntentLocked's perp arm, piece by piece, exactly as index.ts runs it:
 * perpLegCalls (the fence) → executor.execute(calls, hooks) whose onSubmitted
 * writes the trades row and the margin row in ONE addTrade → the receipt
 * (perpLegOfReceipt + perpLegMismatch) → the landed trades row with the
 * margin row's `landed` step in the same db.tx.
 */
async function runLeg(
  agentId: `0x${string}`,
  intent: PerpLegIntent,
  exec: (calls: Call[], hooks: ExecuteHooks) => Promise<{ txHash: `0x${string}`; userOpHash: `0x${string}`; logs: readonly L[] }>,
  opts: { chainAccountIndex?: bigint | null; builders?: Parameters<typeof perpLegCalls>[1]["builders"] } = {},
): Promise<{ outcome: "refused"; rule: string } | { outcome: "landed" } | { outcome: "unsettled"; why: string }> {
  const rowKind = perpLegKind(intent as TradeIntent)!;
  const amount = intent.kind === "perp-key" ? 0n : intent.amountUsdg;
  const built = perpLegCalls(intent, { perp: PERP, account: agentId, chainAccountIndex: opts.chainAccountIndex, builders: opts.builders });
  if (!built.ok) {
    await store.addTrade({ agent_id: agentId, kind: rowKind, target: PROXY, amount_usdg: Number(amount) / 1e6, status: "rejected", reject_rule: built.rule });
    return { outcome: "refused", rule: built.rule };
  }
  const res = await exec(built.calls, {
    onSubmitted: async (userOpHash) => {
      const t = perpLegSubmittedTransfer(intent, userOpHash);
      const wrote = await store.addTrade(
        { agent_id: agentId, kind: rowKind, target: PROXY, amount_usdg: Number(amount) / 1e6, user_op_hash: userOpHash, status: "submitted" },
        t === null ? undefined : { with: store.perpTransferWith({ ...t, agentId, mode: "live" }) },
      );
      if (!wrote) throw new Error("not recorded");
    },
  });
  const reading = perpLegOfReceipt(res.logs, agentId, CHAIN);
  const mismatch = perpLegMismatch(intent, reading, SEALED);
  if (mismatch !== null) return { outcome: "unsettled", why: mismatch };
  const landed = reading.kind === "leg" ? perpLegLandedTransfer(reading.leg, { userOpHash: res.userOpHash, txHash: res.txHash, chainId: CHAIN }) : null;
  const wrote = await store.addTrade(
    { agent_id: agentId, kind: rowKind, target: PROXY, amount_usdg: Number(amount) / 1e6, tx_hash: res.txHash, user_op_hash: res.userOpHash, status: "landed" },
    landed === null ? undefined : { with: store.perpTransferWith({ ...landed, agentId, mode: "live" }) },
  );
  assert.ok(wrote, "the landed row and its margin row committed");
  return { outcome: "landed" };
}

describe("the kinds", () => {
  it("a payout claim ignores entry consent/cash but retains every execution authority gate", () => {
    const base: ExecInputs = {
      armed: true, executor: true, chainId: 4663, cashUsdg: 0n, perpVenueMicro: 0n,
      gasWei: 1n, gasSponsored: false, deadPolicy: false, wallTooWide: false,
      paperTradingEnabled: true, liveTradingEnabled: false,
    };
    assert.equal(execModeOf(base).mode, "paper");
    assert.deepEqual(perpClaimExecMode(base), { mode: "live" });
    for (const block of [{ armed: false }, { executor: false }, { chainId: 46630 },
      { deadPolicy: true }, { wallTooWide: true }, { gasWei: 0n }]) {
      assert.notEqual(perpClaimExecMode({ ...base, ...block }).mode, "live", JSON.stringify(block, (_, v) => typeof v === "bigint" ? String(v) : v));
    }
  });

  it("three trades kinds, never transfer or swap; a withdrawal is no leg (the lane's, an L2 request)", () => {
    assert.deepEqual([...PERP_LEG_KINDS], ["perp-deposit", "perp-key", "perp-claim"]);
    assert.equal(perpLegKind(deposit(USDG(5)) as TradeIntent), "perp-deposit");
    assert.equal(perpLegKind(claim(USDG(5)) as TradeIntent), "perp-claim");
    assert.equal(perpLegKind(register(22149) as TradeIntent), "perp-key");
    assert.equal(perpLegKind({ kind: "perp-margin", direction: "withdraw", amountUsdg: 1n }), null);
    assert.equal(isPerpLegKind("transfer"), false);
    assert.equal(isPerpLegKind("perp-margin"), false);
  });
});

describe("WHAT IS SIGNED: onboard's builders, then the fence, always", () => {
  const self = "0x3333333333333333333333333333333333333333" as `0x${string}`;
  it("a deposit is exactly [USDG.approve(proxy, a), proxy.deposit(self, 3, 0, a)]", () => {
    const b = perpLegCalls(deposit(USDG(12)), { perp: PERP, account: self });
    assert.ok(b.ok);
    if (!b.ok) return;
    assert.equal(b.calls.length, 2);
    assert.equal(b.calls[0]!.to, USDG_TOKEN);
    assert.equal(b.calls[1]!.to, PROXY);
  });

  it("A BUILDER THAT DRIFTED IS REFUSED BY THE FENCE before anything is signed: an approve to another spender", () => {
    const drifted = (a: { perp: PerpGrant; account: `0x${string}`; amountMicro: bigint }): Call[] => [
      { to: USDG_TOKEN, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [OTHER, a.amountMicro] }) },
      { to: PROXY, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [OTHER, a.amountMicro] }) },
    ];
    const b = perpLegCalls(deposit(USDG(12)), { perp: PERP, account: self, builders: { deposit: drifted } });
    assert.equal(b.ok, false);
    if (b.ok) return;
    assert.match(b.rule, /^fence-/);
  });

  it("a deposit naming another target, an ungranted route, or an amount under Lighter's minimum is refused", () => {
    const other = perpLegCalls({ kind: "perp-margin", direction: "deposit", target: OTHER, amountUsdg: USDG(5) }, { perp: PERP, account: self });
    assert.equal(!other.ok && other.rule, "fence-recipient");
    const ungranted = perpLegCalls(deposit(USDG(5)), { perp: null, account: self });
    assert.equal(!ungranted.ok && ungranted.rule, "perp-not-granted");
    const tiny = perpLegCalls(deposit(999_999n), { perp: PERP, account: self });
    assert.equal(!tiny.ok && tiny.rule, "perp-order-malformed");
  });

  it("THE KEY REGISTRATION'S INDEX COMES FROM THE CHAIN, and must be the one planned on", () => {
    assert.equal(perpLegCalls(register(22149), { perp: PERP, account: self, chainAccountIndex: IDX }).ok, true);
    for (const [onChain, why] of [
      [null, "unread"],
      [0n, "no account yet"],
      [IDX + 1n, "another account"],
    ] as const) {
      const b = perpLegCalls(register(22149), { perp: PERP, account: self, chainAccountIndex: onChain });
      assert.equal(!b.ok && b.rule, "perp-venue-unready", why);
    }
  });

  it("a claim is exactly [proxy.withdrawPendingBalance(self, 3, a)]", () => {
    const b = perpLegCalls(claim(USDG(7)), { perp: PERP, account: self });
    assert.ok(b.ok && b.calls.length === 1 && b.calls[0]!.to === PROXY);
  });
});

describe("WHAT LANDED: the proxy's own event, in the op's own logs", () => {
  const self = "0x3333333333333333333333333333333333333333";
  it("Deposit(self) → perp-deposit; the changePubKey request from self → perp-key; WithdrawPending(self) → perp-claim", () => {
    const d = perpLegOfReceipt(depositOpLogs(self, USDG(12)), self, CHAIN);
    assert.deepEqual(d, { kind: "leg", leg: { kind: "perp-deposit", logIndex: 2, accountIndex: IDX, amountMicro: USDG(12) } });
    const k = perpLegOfReceipt([priorityLog(4, self, 62, changePubKeyData(IDX, SEALED))], self, CHAIN);
    assert.deepEqual(k, { kind: "leg", leg: { kind: "perp-key", logIndex: 4, accountIndex: IDX, masterAccountIndex: IDX, apiKeyIndex: 16, publicKey: SEALED } });
    const c = perpLegOfReceipt([transferLog(0, PROXY, self, USDG(7)), withdrawPendingLog(1, self, USDG(7))], self, CHAIN);
    assert.deepEqual(c, { kind: "leg", leg: { kind: "perp-claim", logIndex: 1, amountMicro: USDG(7) } });
  });

  it("nothing from the proxy is not a leg; off Lighter's chain nothing is", () => {
    assert.deepEqual(perpLegOfReceipt([transferLog(0, self, OTHER, 5n)], self, CHAIN), { kind: "none" });
    assert.deepEqual(perpLegOfReceipt(depositOpLogs(self, USDG(12)), self, 46630), { kind: "none" });
  });

  it("NEVER GUESSED: a deposit to another account, another owner's claim, two legs, a recover's priority request, a copycat address", () => {
    const amb = (logs: L[]) => perpLegOfReceipt(logs, self, CHAIN).kind;
    assert.equal(amb([depositLog(0, OTHER, USDG(5))]), "ambiguous");
    assert.equal(amb([withdrawPendingLog(0, OTHER, USDG(5))]), "ambiguous");
    assert.equal(amb([...depositOpLogs(self, USDG(5)), withdrawPendingLog(9, self, USDG(5))]), "ambiguous");
    assert.equal(amb([priorityLog(0, self, 66, "0x42")]), "ambiguous", "a withdraw priority request is the owner's recover");
    assert.equal(perpLegOfReceipt([depositLog(0, self, USDG(5), { address: OTHER })], self, CHAIN).kind, "none", "only the proxy speaks");
  });

  it("perpLegMismatch holds the receipt to what was signed", () => {
    const d = perpLegOfReceipt(depositOpLogs(self, USDG(12)), self, CHAIN);
    assert.equal(perpLegMismatch(deposit(USDG(12)), d, SEALED), null);
    assert.match(perpLegMismatch(deposit(USDG(13)), d, SEALED)!, /deposited/);
    assert.match(perpLegMismatch(claim(USDG(12)), d, SEALED)!, /not the perp-claim/);
    const k = perpLegOfReceipt([priorityLog(4, self, 62, changePubKeyData(IDX, key("09")))], self, CHAIN);
    assert.match(perpLegMismatch(register(Number(IDX)), k, SEALED)!, /other than the one the grant sealed/);
  });

  it("a claim's settlement explains only what moved BESIDE its payout — the payout fold explains the payout", () => {
    const c = perpLegOfReceipt([transferLog(0, PROXY, self, USDG(7)), withdrawPendingLog(1, self, USDG(7))], self, CHAIN);
    assert.equal(perpLegCashExplained(USDG(7), c), 0n);
    const d = perpLegOfReceipt(depositOpLogs(self, USDG(12)), self, CHAIN);
    assert.equal(perpLegCashExplained(-USDG(12), d), -USDG(12), "a deposit's own movement is its whole explanation");
    assert.equal(perpLegCashExplained(null, d), null, "unread stays unread");
  });

  it("opLogsOf cuts ONE op out of a bundle: another sender's deposit to us, earlier in the bundle, is not ours", () => {
    const hashA = h32(0xa);
    const hashB = h32(0xb);
    const receipt: L[] = [
      beforeExecution(0),
      // op A — someone else crediting OUR Lighter account (anyone may deposit to `_to`)
      transferLog(1, OTHER, PROXY, USDG(99)),
      depositLog(2, self, USDG(99)),
      userOpEvent(3, hashA, OTHER),
      // op B — ours: a key registration
      priorityLog(4, self, 62, changePubKeyData(IDX, SEALED)),
      userOpEvent(5, hashB, self),
    ];
    const mine = opLogsOf(receipt, 5)!;
    assert.deepEqual(mine.map((l) => l.logIndex), [4]);
    assert.equal(perpLegOfReceipt(mine, self, CHAIN).kind, "leg");
    const whole = perpLegOfReceipt(receipt, self, CHAIN);
    assert.equal(whole.kind, "ambiguous", "the whole bundle would have read two legs");
    assert.equal(opLogsOf(receipt, null), null);
    assert.equal(opLogsOf(receipt, 4), null, "a position that is not a UserOperationEvent");
    assert.equal(opLogsOf([{ ...receipt[0]!, logIndex: undefined as unknown as number }, receipt[5]!], 5), null, "an unpositioned log");
  });
});

describe("WHAT IS RECORDED, through the arm's own steps, on a real ledger", () => {
  it("SUBMITTED BEFORE SEND: the trades row and the deposit's margin row exist when the executor broadcasts", async () => {
    const id = await agent();
    const userOpHash = h32(0x1001);
    const txHash = h32(0x2001);
    let sawBeforeBroadcast = false;
    const r = await runLeg(id, deposit(USDG(12)), async (calls, hooks) => {
      assert.equal(calls.length, 2);
      await hooks.onSubmitted!(userOpHash, { nonce: 3n });
      // executor.ts broadcasts only AFTER the hook resolved — look now.
      const t = await tradesOf(id);
      const m = await transfersOf(id);
      sawBeforeBroadcast = t.length === 1 && t[0]!.status === "submitted" && m.length === 1 && m[0]!.state === "submitted";
      assert.equal(m[0]!.user_op_hash, userOpHash);
      assert.deepEqual(await marginEntries(id), [], "submitted moves no money and journals nothing");
      return { txHash, userOpHash, logs: depositOpLogs(id, USDG(12)) };
    });
    assert.deepEqual(r, { outcome: "landed" });
    assert.ok(sawBeforeBroadcast);
  });

  it("LANDED: one trades row settled in place, target the proxy, no fill columns; the margin row landed by its Deposit log, journaled once", async () => {
    const id = await agent();
    const userOpHash = h32(0x1002);
    const txHash = h32(0x2002);
    await runLeg(id, deposit(USDG(12)), async (_c, hooks) => {
      await hooks.onSubmitted!(userOpHash, { nonce: 4n });
      return { txHash, userOpHash, logs: depositOpLogs(id, USDG(12), 7) };
    });
    const t = await tradesOf(id);
    assert.equal(t.length, 1, "the pre-broadcast row was resolved in place, never inserted beside");
    assert.equal(t[0]!.kind, "perp-deposit");
    assert.equal(t[0]!.status, "landed");
    assert.equal(t[0]!.target.toLowerCase(), PROXY);
    for (const col of ["sell_token", "buy_token", "fill_side", "fill_cash_usdg", "fill_qty_raw"] as const) assert.equal(t[0]![col], null, col);
    const m = await transfersOf(id);
    assert.equal(m.length, 1);
    assert.equal(m[0]!.state, "landed");
    assert.equal(m[0]!.chain_id, CHAIN);
    assert.equal(m[0]!.tx_hash, txHash);
    assert.equal(m[0]!.log_index, 9, "the Deposit log's own position");
    assert.equal(m[0]!.amount_micro, USDG(12).toString());
    const margin = await marginEntries(id);
    assert.equal(margin.length, 1, "submitted → landed moved money once");
    const journal = await store.readJournal(id, 1);
    assert.deepEqual(journal.map((e) => e.kind).sort(), ["fill", "margin"], "the trades row's tx-and-gas fill beside the margin fact");
    assert.deepEqual(verifyChain(journal), []);
    // A re-read of the same landing (the orphan sweep reaching an op this
    // process settled) moves nothing and journals nothing.
    const again = await store.upsertPerpTransfer({ ...perpLegLandedTransfer({ kind: "perp-deposit", logIndex: 9, accountIndex: IDX, amountMicro: USDG(12) }, { userOpHash, txHash, chainId: CHAIN })!, agentId: id, mode: "live" });
    assert.equal(again.outcome, "unchanged");
    assert.equal((await marginEntries(id)).length, 1);
    // It counts as spend like a vault deposit, and as an op.
    assert.equal(await store.getSpentTodayUsdg(id, "live"), 12);
    assert.equal(await store.getOpsToday(id, "live"), 1);
  });

  it("a claim and a key registration are rows of their own kinds, spend nothing, count as ops, and write no margin row", async () => {
    const id = await agent();
    await runLeg(id, claim(USDG(7)), async (_c, hooks) => {
      await hooks.onSubmitted!(h32(0x1003), { nonce: 1n });
      return { txHash: h32(0x2003), userOpHash: h32(0x1003), logs: [transferLog(0, PROXY, id, USDG(7)), withdrawPendingLog(1, id, USDG(7))] };
    });
    await runLeg(
      id,
      register(Number(IDX)),
      async (_c, hooks) => {
        await hooks.onSubmitted!(h32(0x1004), { nonce: 2n });
        return { txHash: h32(0x2004), userOpHash: h32(0x1004), logs: [priorityLog(0, id, 62, changePubKeyData(IDX, SEALED))] };
      },
      { chainAccountIndex: IDX },
    );
    const t = await tradesOf(id);
    assert.deepEqual(t.map((r) => [r.kind, r.status]), [["perp-claim", "landed"], ["perp-key", "landed"]]);
    assert.deepEqual(await transfersOf(id), [], "the claim's money is payouts.ts's, the key moved none");
    assert.equal(await store.getSpentTodayUsdg(id, "live"), 0);
    assert.equal(await store.getOpsToday(id, "live"), 2);
  });

  it("A RECEIPT THAT DOES NOT SHOW THE LEG settles nothing: the op stays submitted, still counted", async () => {
    const id = await agent();
    const r = await runLeg(id, deposit(USDG(12)), async (_c, hooks) => {
      await hooks.onSubmitted!(h32(0x1005), { nonce: 1n });
      return { txHash: h32(0x2005), userOpHash: h32(0x1005), logs: [transferLog(0, id, PROXY, USDG(12))] };
    });
    assert.equal(r.outcome, "unsettled");
    assert.deepEqual((await tradesOf(id)).map((x) => x.status), ["submitted"]);
    assert.deepEqual((await transfersOf(id)).map((x) => x.state), ["submitted"]);
    assert.equal(await store.getSpentTodayUsdg(id, "live"), 12, "a submitted deposit is charged from the moment it leaves");
  });

  it("A FENCE REFUSAL SENDS NOTHING: a rejected row, no margin row, the executor never called", async () => {
    const id = await agent();
    let called = false;
    const drifted = (a: { perp: PerpGrant; account: `0x${string}`; amountMicro: bigint }): Call[] => [
      { to: USDG_TOKEN, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [OTHER, a.amountMicro] }) },
      { to: PROXY, value: 0n, data: "0x" },
    ];
    const r = await runLeg(
      id,
      deposit(USDG(12)),
      async () => {
        called = true;
        throw new Error("never");
      },
      { builders: { deposit: drifted } },
    );
    assert.equal(r.outcome, "refused");
    assert.equal(called, false);
    assert.deepEqual((await tradesOf(id)).map((x) => [x.kind, x.status]), [["perp-deposit", "rejected"]]);
    assert.deepEqual(await transfersOf(id), []);
  });
});

// ── the stranded resolver and the orphan sweep ──────────────────────────────

/** A ReconcileChain over fixed receipts: UserOperationEvents are found by their topics, receipts by tx. */
function fakeChain(receipts: Map<string, L[]>, head = 10_000n): ReconcileChain {
  return {
    getBlockNumber: async () => head,
    async getLogs(a) {
      const out = [];
      for (const [tx, logs] of receipts) {
        for (const l of logs) {
          if (l.address.toLowerCase() !== a.address.toLowerCase()) continue;
          const ok = a.topics.every((t, i) => t === null || (Array.isArray(t) ? t.includes(l.topics[i] as Hex) : String(l.topics[i]).toLowerCase() === String(t).toLowerCase()));
          if (ok) out.push({ topics: l.topics as Hex[], data: l.data as Hex, transactionHash: tx as Hex, blockNumber: "0x100" as Hex, logIndex: `0x${l.logIndex.toString(16)}` as Hex });
        }
      }
      return out;
    },
    async getReceiptLogs(tx) {
      return receipts.get(tx.toLowerCase()) ?? null;
    },
  };
}

describe("THE STRANDED RESOLVER'S PERP BRANCH", () => {
  it("a submitted deposit whose receipt proves it is settled landed, with its margin row, exactly as the arm would", async () => {
    const id = await agent();
    const userOpHash = h32(0x3001);
    const txHash = h32(0x4001);
    // The arm got as far as the pre-broadcast write, then the process died.
    await store.addTrade(
      { agent_id: id, kind: "perp-deposit", target: PROXY, amount_usdg: 12, user_op_hash: userOpHash, status: "submitted" },
      { with: store.perpTransferWith({ ...perpLegSubmittedTransfer(deposit(USDG(12)), userOpHash)!, agentId: id, mode: "live" }) },
    );
    const chain = fakeChain(new Map([[txHash, [beforeExecution(0), ...depositOpLogs(id, USDG(12), 1), userOpEvent(4, userOpHash, id)]]]));
    const [r] = await resolveSubmittedOps({ chain, smartAccount: id, usdgToken: USDG_TOKEN, hashes: [userOpHash], lookbackBlocks: 1000n });
    assert.ok(r && r.success && r.opLogs !== null);
    const res = perpLegResolution({ kind: "perp-deposit", success: true, opLogs: r.opLogs, receiptUsdgDelta6: r.usdgDelta6, account: id, chainId: CHAIN, userOpHash, txHash: r.txHash, submittedTransferMicro: null });
    assert.ok(res.settle);
    if (!res.settle) return;
    assert.equal(res.cashExplained, -USDG(12), "its own receipt movement explains its cash");
    await store.addTrade(
      { agent_id: id, kind: "perp-deposit", target: PROXY, amount_usdg: 12, user_op_hash: userOpHash, tx_hash: r.txHash, status: "landed", basis_source: "receipt" },
      { with: store.perpTransferWith({ ...res.transfer!, agentId: id, mode: "live" }) },
    );
    assert.deepEqual((await tradesOf(id)).map((x) => [x.kind, x.status]), [["perp-deposit", "landed"]]);
    const m = await transfersOf(id);
    assert.deepEqual(m.map((x) => [x.state, x.log_index]), [["landed", 3]]);
    assert.equal((await marginEntries(id)).length, 1);
  });

  it("an unreadable receipt, or one that does not show the leg, leaves the row submitted — never guessed", () => {
    const base = { kind: "perp-deposit" as const, success: true, receiptUsdgDelta6: null, account: OTHER, chainId: CHAIN, userOpHash: h32(1), txHash: h32(2), submittedTransferMicro: null };
    assert.equal(perpLegResolution({ ...base, opLogs: null }).settle, false);
    assert.equal(perpLegResolution({ ...base, opLogs: [] }).settle, false);
    const claimLogs = [withdrawPendingLog(0, OTHER, USDG(3))];
    const wrongKind = perpLegResolution({ ...base, opLogs: claimLogs });
    assert.ok(!wrongKind.settle && /perp-claim/.test(wrongKind.why));
  });

  it("A REVERTED deposit: its margin row goes `failed`, journaling nothing, and leaves the open set", async () => {
    const id = await agent();
    const userOpHash = h32(0x3002);
    await store.addTrade(
      { agent_id: id, kind: "perp-deposit", target: PROXY, amount_usdg: 5, user_op_hash: userOpHash, status: "submitted" },
      { with: store.perpTransferWith({ ...perpLegSubmittedTransfer(deposit(USDG(5)), userOpHash)!, agentId: id, mode: "live" }) },
    );
    const open = await store.listOpenPerpTransfers(id, "live");
    const res = perpLegResolution({ kind: "perp-deposit", success: false, opLogs: null, receiptUsdgDelta6: 0n, account: id, chainId: CHAIN, userOpHash, txHash: h32(9), submittedTransferMicro: open[0]!.amountMicro });
    assert.ok(res.settle && res.transfer?.state === "failed");
    if (!res.settle) return;
    await store.addTrade(
      { agent_id: id, kind: "perp-deposit", target: PROXY, amount_usdg: 5, user_op_hash: userOpHash, status: "reverted", reject_rule: "reverted on-chain (resolved)" },
      { with: store.perpTransferWith({ ...res.transfer!, agentId: id, mode: "live" }) },
    );
    assert.deepEqual(await store.listOpenPerpTransfers(id, "live"), [], "no longer holding the ratchets");
    assert.deepEqual(await marginEntries(id), []);
    assert.equal(await store.getSpentTodayUsdg(id, "live"), 0, "a revert spent nothing");
  });

  it("A MARGIN ROW THE LEDGER REFUSES rolls the trades row back: the op stays submitted for someone to look at", async () => {
    const id = await agent();
    const userOpHash = h32(0x3003);
    await store.addTrade(
      { agent_id: id, kind: "perp-deposit", target: PROXY, amount_usdg: 5, user_op_hash: userOpHash, status: "submitted" },
      { with: store.perpTransferWith({ ...perpLegSubmittedTransfer(deposit(USDG(5)), userOpHash)!, agentId: id, mode: "live" }) },
    );
    // A landing that names another amount than the row it advances.
    const wrong = perpLegLandedTransfer({ kind: "perp-deposit", logIndex: 1, accountIndex: IDX, amountMicro: USDG(6) }, { userOpHash, txHash: h32(0x4003), chainId: CHAIN })!;
    const wrote = await store.addTrade(
      { agent_id: id, kind: "perp-deposit", target: PROXY, amount_usdg: 5, user_op_hash: userOpHash, tx_hash: h32(0x4003), status: "landed" },
      { with: store.perpTransferWith({ ...wrong, agentId: id, mode: "live" }) },
    );
    assert.equal(wrote, false);
    assert.deepEqual((await tradesOf(id)).map((x) => x.status), ["submitted"]);
    assert.deepEqual((await transfersOf(id)).map((x) => x.state), ["submitted"]);
  });
});

describe("THE ORPHAN SWEEP'S PERP BRANCH", () => {
  it("a landed op the ledger never saw is classified by its own logs: deposit (with its margin row), key, claim — and anything else is left to the safe default", async () => {
    const id = await agent();
    const dep = h32(0x5001);
    const reg = h32(0x5002);
    const clm = h32(0x5003);
    const swp = h32(0x5004);
    const receipts = new Map<string, L[]>([
      [h32(0x6001), [beforeExecution(0), ...depositOpLogs(id, USDG(8), 1), userOpEvent(4, dep, id)]],
      [h32(0x6002), [beforeExecution(0), priorityLog(1, id, 62, changePubKeyData(IDX, SEALED)), userOpEvent(2, reg, id)]],
      [h32(0x6003), [beforeExecution(0), transferLog(1, PROXY, id, USDG(3)), withdrawPendingLog(2, id, USDG(3)), userOpEvent(3, clm, id)]],
      [h32(0x6004), [beforeExecution(0), transferLog(1, id, OTHER, USDG(2)), userOpEvent(2, swp, id)]],
    ]);
    const orphans = await findOrphanOps({ chain: fakeChain(receipts), smartAccount: id, usdgToken: USDG_TOKEN, knownOpHashes: new Set(), lookbackBlocks: 1000n });
    assert.equal(orphans.length, 4);
    const by = new Map(orphans.map((o) => [o.userOpHash, perpLegOrphan(o, id, CHAIN)]));
    assert.deepEqual([by.get(dep)?.kind, by.get(dep)?.amountMicro, by.get(dep)?.transfer?.state], ["perp-deposit", USDG(8), "landed"]);
    assert.deepEqual([by.get(reg)?.kind, by.get(reg)?.amountMicro, by.get(reg)?.transfer], ["perp-key", 0n, null]);
    assert.deepEqual([by.get(clm)?.kind, by.get(clm)?.amountMicro, by.get(clm)?.transfer], ["perp-claim", USDG(3), null]);
    assert.equal(by.get(swp), null, "not a perp leg: the sweep's own safe default");
    // The deposit's rows, written as index.ts writes them.
    const d = by.get(dep)!;
    const wrote = await store.addTrade(
      { agent_id: id, kind: d.kind, target: PROXY, amount_usdg: 8, user_op_hash: dep, tx_hash: h32(0x6001), status: "landed", basis_source: "receipt" },
      { with: store.perpTransferWith({ ...d.transfer!, agentId: id, mode: "live" }) },
    );
    assert.ok(wrote);
    assert.deepEqual((await transfersOf(id)).map((x) => [x.state, x.initiator]), [["landed", "agent"]]);
    assert.equal((await marginEntries(id)).length, 1);
  });

  it("an op whose logs cannot be cut from its bundle is never classified", async () => {
    const id = await agent();
    const hash = h32(0x5005);
    // No BeforeExecution boundary: which logs are whose is unknown.
    const receipts = new Map<string, L[]>([[h32(0x6005), [...depositOpLogs(id, USDG(8), 0), userOpEvent(3, hash, id)]]]);
    const [o] = await findOrphanOps({ chain: fakeChain(receipts), smartAccount: id, usdgToken: USDG_TOKEN, knownOpHashes: new Set(), lookbackBlocks: 1000n });
    assert.equal(o?.opLogs, null);
    assert.equal(perpLegOrphan(o!, id, CHAIN), null);
  });
});

describe("the two chain reads", () => {
  const client = (answer: unknown | Error) => ({
    calls: [] as unknown[],
    async readContract(args: never) {
      this.calls.push(args);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  });
  it("addressToAccountIndex: 0 is the chain's own none; a failure is unread; off Lighter's chain nothing is asked", async () => {
    assert.equal(await readLighterAccountIndex(client(0), OTHER, CHAIN), 0n);
    assert.equal(await readLighterAccountIndex(client(22149), OTHER, CHAIN), IDX);
    assert.equal(await readLighterAccountIndex(client(new Error("rpc")), OTHER, CHAIN), null);
    assert.equal(await readLighterAccountIndex(client(-1), OTHER, CHAIN), null);
    const c = client(new Error("never asked"));
    assert.equal(await readLighterAccountIndex(c, OTHER, 46630), 0n);
    assert.equal(c.calls.length, 0);
  });
  it("getPendingBalance is read AT the cash's block, and unread is null — never 0", async () => {
    const c = client(USDG(4));
    assert.equal(await readLighterPendingAt(c, OTHER, CHAIN, 12345n), USDG(4));
    assert.equal((c.calls[0] as { blockNumber: bigint }).blockNumber, 12345n);
    assert.equal(await readLighterPendingAt(client(new Error("behind")), OTHER, CHAIN, 12345n), null);
  });
});

describe("the live reconciler's two writers, on the store's own connection (store.ts)", () => {
  it("insertAdoptedPerpOrder adopts once and perpNonceRecorded then finds the nonce — so the reconciler's store is store.ts itself", async () => {
    const id = await agent();
    assert.equal(await store.perpNonceRecorded(id, Number(IDX), 16, 77), false);
    const a = {
      agentId: id,
      epoch: 1,
      accountIndex: Number(IDX),
      apiKeyIndex: 16,
      nonce: 77,
      txHash: null,
      txType: null,
      status: "filled" as const,
      effect: "close" as const,
      reduceOnly: true,
      marketId: 1,
      worstNotionalMicro: 0n,
      filledBase: 1n,
      filledQuoteMicro: USDG(1),
      createdAtSec: 1_800_000_000,
      legs: [{ role: "close" as const, clientOrderIndex: 77 * 8 + 3, venueOrderIndex: "123", status: "filled" as const, venueStatus: "filled" }],
    };
    assert.equal((await store.insertAdoptedPerpOrder(a)).outcome, "inserted");
    assert.equal((await store.insertAdoptedPerpOrder(a)).outcome, "exists");
    assert.equal(await store.perpNonceRecorded(id, Number(IDX), 16, 77), true);
  });
});
