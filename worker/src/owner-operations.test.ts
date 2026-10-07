/**
 * OWNER OPERATIONS, read off real receipts.
 *
 * The receipts are the public chain's own (Robinhood Chain 4663, read with
 * eth_getTransactionReceipt and eth_getBlockByNumber; testdata/
 * owner-operations-receipts.json):
 *
 *   0x4b6dcd… (account 0xa96bf429…)  invalidateNonce, root sequence 0
 *                                    sweep(USDG) of its custody vault 0xc8776faf…
 *                                    recoverFunds: 348.368488 USDG + NVDA dust out
 *                                    its session key's enable-mode sell (vType 2)
 *   0x9eaa728e…                      a pure USDG root withdrawal, 145.499004 out
 *   0x0e1ca0… (account 0x88e47214…)  the root sweep of USDG, MU, USAR, steakUSDG
 *
 * Each is read exactly as the reconciler and admission read it; the synthetic
 * cases below them are the shapes no fixture happened to carry.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { CASH } from "../../packages/core/src/index";
import { isRootSuccessOf, ownerOperationOf, ownerOperationRow, ownerOperationsNotice, rootExecutionLogs, type OwnerReceiptLog } from "./owner-operations";

type FixtureLog = [address: string, topics: string[], data: string, logIndex: string];
interface Fixture { tx: string; block: string; blockHash: string; timestamp: number; from: string; to: string; status: string; logs: FixtureLog[] }
const FX = JSON.parse(readFileSync(new URL("./testdata/owner-operations-receipts.json", import.meta.url), "utf8")) as Record<string, Fixture>;
const logsOf = (f: Fixture): OwnerReceiptLog[] => f.logs.map(([address, topics, data, logIndex]) => ({ address, topics, data, logIndex }));

const USDG = String(CASH.USDG).toLowerCase();
const EP = "0x0000000071727de22e5e9d8baf0edac6f37da032";
const UOE = "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f";
const BEFORE = "0xbb47ee3e183a558b1a2ff0874b079f3fc5478b7454eacf2bfc5af2ff5878f972";
const TR = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const A4B = "0xa96bf429888e1aab4255762d17d29c53f6a0370d";
const VAULT_4B = "0xc8776faff15212c359b23bae531ff3ac7d760e0f";
const A9E = "0x9eaa728e989678bb3545dff3bd53d0e9cf19e33a";
const A0E = "0x88e47214b5a0ca488cdabb4c9c28c3b71441ba78";
const NVDA = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";
const read = (name: string, userOpHash: string, account: string, custody: string[] = []) =>
  ownerOperationOf({ receiptLogs: logsOf(FX[name]!), userOpHash, txHash: FX[name]!.tx, account, custody, usdg: USDG, chainId: 4663 });

describe("real owner operations", () => {
  it("invalidateNonce (root sequence 0): acknowledged, it moved nothing", () => {
    const r = read("invalidateNonce", "0x496e7211db25d250d9142105ab5024debcf05519c734d83191145af8eac09ffa", A4B);
    assert.ok(r);
    assert.equal(r.disposition, "acknowledged");
    assert.deepEqual(r.reasons, []);
    assert.deepEqual(r.usdgLegs, []);
    assert.deepEqual(r.covers, []);
    assert.deepEqual(r.tokenMoves, []);
    assert.equal(r.nonce, "0x845adb2c711129d4f3966735ed98a9f09fc4ce5700000000000000000000", "the root nonce, re-checkable");
    assert.equal(r.paymaster, "0x0000000000000000000000000000000000000000", "self-paid");
    assert.equal(r.logIndex, 8);
  });

  it("the vault's sweep(USDG), with the vault as custody: acknowledged, and it answers its own custody leg (log 13)", () => {
    const r = read("vaultSweep", "0x0ea85970d6cd230721eb03d667ad46795f1f215647cbad9d1f456779be91c9b9", A4B, [VAULT_4B]);
    assert.ok(r);
    assert.equal(r.disposition, "acknowledged");
    assert.deepEqual(r.covers, [`${FX.vaultSweep!.tx}:13`]);
    assert.equal(r.usdgLegs.length, 1);
    assert.deepEqual({ ...r.usdgLegs[0] }, { logIndex: 13, from: VAULT_4B, to: A4B, amountRaw: "1162301", kind: "internal", rule: "custody-transfer", answeredBy: "this-record" });
  });

  it("the same sweep without custody configured reads as the scanner would read it: a capital-in left for the scanner's flow, nothing covered", () => {
    const r = read("vaultSweep", "0x0ea85970d6cd230721eb03d667ad46795f1f215647cbad9d1f456779be91c9b9", A4B);
    assert.ok(r);
    assert.equal(r.disposition, "acknowledged");
    assert.deepEqual(r.covers, []);
    assert.equal(r.usdgLegs[0]!.kind, "capital-in");
    assert.equal(r.usdgLegs[0]!.answeredBy, "flow");
  });

  it("recoverFunds: review (token-departed), its USDG leg (log 8) a capital-out for the scanner's flow, NVDA (log 9) leaving in kind", () => {
    const r = read("recoverFunds", "0x04f8241f6d02241469b9c2bc2d2f8cc4cca719eb5c6d54f3a77077c7e41ab3a7", A4B, [VAULT_4B]);
    assert.ok(r);
    assert.equal(r.disposition, "review");
    assert.deepEqual(r.reasons, ["token-departed"]);
    assert.deepEqual(r.usdgLegs.map((l) => [l.logIndex, l.kind, l.answeredBy, l.amountRaw]), [[8, "capital-out", "flow", "348368488"]]);
    assert.deepEqual(r.tokenMoves.map((m) => [m.logIndex, m.token, m.direction, m.amountRaw]), [[9, NVDA, "departed", "12397031985369"]]);
    assert.deepEqual(r.covers, [], "a capital leg is never covered by the record");
    assert.equal(r.gasWei, "7770613603662", "actualGasCost, from the event's own data");
    assert.equal(r.gasUnits, "248794");
  });

  it("a pure USDG root withdrawal (0x9eaa728e…): acknowledged, log 18 a capital-out for the scanner's flow", () => {
    const r = read("pureUsdgWithdraw", "0xed68e288670aa284fb2df3702648df50b9420ed9751c675229887cc1336f7b77", A9E);
    assert.ok(r);
    assert.equal(r.disposition, "acknowledged");
    assert.deepEqual(r.usdgLegs.map((l) => [l.logIndex, l.kind, l.answeredBy]), [[18, "capital-out", "flow"]]);
    assert.deepEqual(r.covers, []);
  });

  it("0x0e1c's sweep: review, with three tokens leaving (MU, USAR, steakUSDG) beside the capital-out", () => {
    const r = read("multiTokenSweep", "0x0a223e56ed7a7f42c5fed39a376ea6f14eaa975abcf8bce14e6b652cdf3d9e85", A0E);
    assert.ok(r);
    assert.equal(r.disposition, "review");
    assert.deepEqual(r.reasons, ["token-departed"]);
    assert.deepEqual(r.tokenMoves.map((m) => m.token), ["0xff080c8ce2e5feadaca0da81314ae59d232d4afd", "0xd917b029c761d264c6a312bbbcda868658ef86a6", "0xbeeff033f34c046626b8d0a041844c5d1a5409dd"]);
    assert.deepEqual(r.usdgLegs.map((l) => [l.logIndex, l.kind, l.amountRaw]), [[7, "capital-out", "144818530"]]);
  });

  it("the session key's enable-mode sell (mode 1, vType 2) is not an owner operation: null, so it stays on today's path", () => {
    assert.equal(read("sessionEnable", "0x75ab968e2c2dad36467d00f665ab8a2667539517a86d64fdd05d0aadb2c5e905", A4B, [VAULT_4B]), null);
  });

  it("an operation the receipt does not carry for this account is null, never somebody else's", () => {
    assert.equal(read("recoverFunds", "0x04f8241f6d02241469b9c2bc2d2f8cc4cca719eb5c6d54f3a77077c7e41ab3a7", A0E), null, "another account");
    assert.equal(read("recoverFunds", `0x${"ab".repeat(32)}`, A4B), null, "another hash");
  });

  it("a receipt whose logs carry no position is unread (null): an execution cannot be told from its neighbours' without one", () => {
    const logs = logsOf(FX.recoverFunds!).map((l) => ({ ...l, logIndex: undefined }));
    assert.equal(ownerOperationOf({ receiptLogs: logs, userOpHash: "0x04f8241f6d02241469b9c2bc2d2f8cc4cca719eb5c6d54f3a77077c7e41ab3a7", txHash: FX.recoverFunds!.tx,
      account: A4B, custody: [], usdg: USDG, chainId: 4663 }), null);
  });

  it("viem's numeric log positions read the same as the RPC's hex ones", () => {
    const logs = logsOf(FX.recoverFunds!).map((l) => ({ ...l, logIndex: Number(BigInt(l.logIndex as string)) }));
    const r = ownerOperationOf({ receiptLogs: logs, userOpHash: "0x04f8241f6d02241469b9c2bc2d2f8cc4cca719eb5c6d54f3a77077c7e41ab3a7", txHash: FX.recoverFunds!.tx,
      account: A4B, custody: [VAULT_4B], usdg: USDG, chainId: 4663 });
    assert.deepEqual(r, read("recoverFunds", "0x04f8241f6d02241469b9c2bc2d2f8cc4cca719eb5c6d54f3a77077c7e41ab3a7", A4B, [VAULT_4B]));
  });
});

// ── the shapes no fixture carried ────────────────────────────────────────────

const ACCOUNT = `0x${"ac".repeat(20)}`, ROUTER = `0x${"9f".repeat(20)}`, EOA = `0x${"e0".repeat(20)}`, VAULT = `0x${"c5".repeat(20)}`, COIN = `0x${"c0".repeat(20)}`;
const TX = `0x${"77".repeat(32)}`, OP = `0x${"44".repeat(32)}`;
const topic = (a: string) => `0x${a.replace(/^0x/, "").padStart(64, "0")}`;
const word = (n: bigint) => n.toString(16).padStart(64, "0");
const ROOT_NONCE = (0x845adb2c711129d4f3966735ed98a9f09fc4ce57n << 64n) | 3n;
const event = (nonce: bigint, success = 1n, i = 9): OwnerReceiptLog => ({
  address: EP, topics: [UOE, OP, topic(ACCOUNT), topic(`0x${"0".repeat(40)}`)], data: `0x${word(nonce)}${word(success)}${word(1000n)}${word(50n)}`, logIndex: `0x${i.toString(16)}`,
});
const before = (i: number): OwnerReceiptLog => ({ address: EP, topics: [BEFORE], data: "0x", logIndex: `0x${i.toString(16)}` });
const transfer = (token: string, from: string, to: string, amount: bigint, i: number): OwnerReceiptLog =>
  ({ address: token, topics: [TR, topic(from), topic(to)], data: `0x${word(amount)}`, logIndex: `0x${i.toString(16)}` });
const synth = (logs: OwnerReceiptLog[], custody: string[] = []) =>
  ownerOperationOf({ receiptLogs: logs, userOpHash: OP, txHash: TX, account: ACCOUNT, custody, usdg: USDG, chainId: 4663 });

describe("the shapes no fixture carried", () => {
  it("a root-key BUY: the token arrived (review), and its USDG leg is a trade, not capital", () => {
    const r = synth([before(1), transfer(USDG, ACCOUNT, ROUTER, 5_000_000n, 2), transfer(COIN, ROUTER, ACCOUNT, 42n, 3), event(ROOT_NONCE)]);
    assert.ok(r);
    assert.equal(r.disposition, "review");
    assert.deepEqual(r.reasons, ["usdg-not-capital", "token-arrived"]);
    assert.equal(r.usdgLegs[0]!.kind, "trade-out");
    assert.deepEqual(r.tokenMoves.map((m) => m.direction), ["arrived"]);
  });

  it("an in-kind arrival with no USDG paid is review (token-arrived) alone", () => {
    const r = synth([before(1), transfer(COIN, EOA, ACCOUNT, 42n, 2), event(ROOT_NONCE)]);
    assert.deepEqual(r?.reasons, ["token-arrived"]);
  });

  it("a token moved between the account and its own vault is both: arrived at one book address, departed another", () => {
    const r = synth([before(1), transfer(COIN, VAULT, ACCOUNT, 42n, 2), event(ROOT_NONCE)], [VAULT]);
    assert.deepEqual(r?.reasons, ["token-arrived", "token-departed"]);
    assert.equal(r?.tokenMoves[0]!.direction, "internal");
  });

  it("USDG from the vault to an outside wallet is capital through custody: review", () => {
    const r = synth([before(1), transfer(USDG, VAULT, EOA, 7_000_000n, 2), event(ROOT_NONCE)], [VAULT]);
    assert.deepEqual(r?.reasons, ["usdg-through-custody"]);
    assert.equal(r?.usdgLegs[0]!.kind, "custody-only");
  });

  it("a USDG log of the account outside the operation's execution is review, never left beside the record", () => {
    const r = synth([transfer(USDG, ACCOUNT, EOA, 1_000_000n, 0), before(1), event(ROOT_NONCE)]);
    assert.deepEqual(r?.reasons, ["usdg-outside-segment"]);
  });

  it("an operation event with no BeforeExecution ahead of it: its execution was not read — review (segment-unread)", () => {
    const r = synth([event(ROOT_NONCE)]);
    assert.deepEqual(r?.reasons, ["segment-unread"]);
  });

  it("root in ENABLE mode, a secondary validator, a permission, an unknown type, and a revert are not owner operations: null", () => {
    const enable = (1n << 248n) | ROOT_NONCE;
    const secondary = (1n << 240n) | 5n;
    const permission = (2n << 240n) | 5n;
    const unknown = (7n << 240n) | 5n;
    for (const n of [enable, secondary, permission, unknown]) assert.equal(synth([before(1), event(n)]), null, n.toString(16));
    assert.equal(synth([before(1), event(ROOT_NONCE, 0n)]), null, "reverted");
  });

  it("a USDG log of the account that moves nothing (a self-transfer, an amount of zero) is acknowledged AND covered by the record — admission reads it", () => {
    const r = synth([before(1), transfer(USDG, ACCOUNT, ACCOUNT, 5n, 2), transfer(USDG, ACCOUNT, EOA, 0n, 3), transfer(COIN, EOA, ACCOUNT, 0n, 4), event(ROOT_NONCE)]);
    assert.equal(r?.disposition, "acknowledged");
    assert.deepEqual(r?.usdgLegs.map((l) => ({ ...l })), [
      { logIndex: 2, from: ACCOUNT, to: ACCOUNT, amountRaw: "5", kind: "no-movement", rule: "self-transfer", answeredBy: "this-record" },
      { logIndex: 3, from: ACCOUNT, to: EOA, amountRaw: "0", kind: "no-movement", rule: "zero-amount", answeredBy: "this-record" },
    ]);
    assert.deepEqual(r?.covers, [`${TX}:2`, `${TX}:3`]);
    assert.deepEqual(r?.tokenMoves, [], "another token's zero is not a move at all: admission never reads it");
  });

  it("a USDG self-transfer OUTSIDE the execution is not the record's to cover: review (usdg-outside-segment)", () => {
    const r = synth([transfer(USDG, ACCOUNT, ACCOUNT, 5n, 0), before(1), event(ROOT_NONCE)]);
    assert.deepEqual(r?.reasons, ["usdg-outside-segment"]);
    assert.deepEqual(r?.covers, []);
  });

  it("a custody contract's own USDG that moves nothing is not a leg: admission never reads a log that is not the account's", () => {
    const r = synth([before(1), transfer(USDG, VAULT, VAULT, 5n, 2), transfer(USDG, VAULT, EOA, 0n, 3), event(ROOT_NONCE)], [VAULT]);
    assert.equal(r?.disposition, "acknowledged");
    assert.deepEqual(r?.usdgLegs, []);
  });
});

describe("an amount that cannot be read", () => {
  it("a Transfer whose data is not one quantity (none, '0x', more than 64 digits, not hex) leaves the receipt unread — null, never an amount of zero: admission reads amounts by the same rule", () => {
    const leg = (data: string): OwnerReceiptLog => ({ ...transfer(USDG, ACCOUNT, EOA, 0n, 2), data });
    for (const data of ["", "0x", `0x${"0".repeat(65)}`, "0xzz"]) {
      assert.equal(synth([before(1), leg(data), event(ROOT_NONCE)]), null, JSON.stringify(data));
    }
    // Anywhere in the receipt: another token's, outside the execution.
    assert.equal(synth([{ ...transfer(COIN, EOA, ROUTER, 0n, 0), data: "0x" }, before(1), event(ROOT_NONCE)]), null);
    // One quantity reads, however short, in either case.
    assert.equal(synth([before(1), leg("0x0"), event(ROOT_NONCE)])?.disposition, "acknowledged");
    assert.deepEqual(synth([before(1), { ...transfer(USDG, ACCOUNT, EOA, 0n, 2), data: `0x${word(0xabcn).toUpperCase()}` }, event(ROOT_NONCE)])?.usdgLegs.map((l) => l.amountRaw), ["2748"]);
  });
});

describe("which logs an owner operation executed (the deposit scanner's question about a trade's bundle)", () => {
  const ev = (sender: string, hash: string, nonce: bigint, success: bigint, i: number): OwnerReceiptLog => ({
    address: EP, topics: [UOE, hash, topic(sender), topic(`0x${"0".repeat(40)}`)], data: `0x${word(nonce)}${word(success)}${word(1000n)}${word(50n)}`, logIndex: `0x${i.toString(16)}`,
  });
  const SESSION_NONCE = (2n << 240n) | 12n;
  const ROOT_OP = `0x${"a1".repeat(32)}`, SESSION_OP = `0x${"b2".repeat(32)}`, REVERTED_OP = `0x${"c3".repeat(32)}`, OTHER_OP = `0x${"d4".repeat(32)}`;
  const receipt = [
    transfer(USDG, ACCOUNT, EOA, 1n, 0), // validation: nobody's execution
    before(1),
    transfer(USDG, ACCOUNT, EOA, 2n, 2), ev(ACCOUNT, ROOT_OP, ROOT_NONCE, 1n, 3), // the owner's own
    transfer(USDG, ACCOUNT, ROUTER, 3n, 4), transfer(COIN, ROUTER, ACCOUNT, 4n, 5), ev(ACCOUNT, SESSION_OP, SESSION_NONCE, 1n, 6), // the agent's trade
    transfer(USDG, ROUTER, ACCOUNT, 5n, 7), ev(ACCOUNT, REVERTED_OP, ROOT_NONCE, 0n, 8), // a root op that reverted
    transfer(USDG, EOA, ACCOUNT, 6n, 9), ev(EOA, OTHER_OP, ROOT_NONCE, 1n, 10), // another account's root op
  ];

  it("maps each log a successful root operation of the account executed to its hash: never a session key's, a revert's, another account's, or validation's", () => {
    assert.deepEqual([...rootExecutionLogs(receipt, ACCOUNT, TX)!], [[2, ROOT_OP]]);
    assert.deepEqual([...rootExecutionLogs(receipt, ACCOUNT.toUpperCase().replace(/^0X/, "0x"), TX)!], [[2, ROOT_OP]], "the account in any spelling");
  });

  it("null when a log carries no position: nothing can be told from its neighbours", () => {
    assert.equal(rootExecutionLogs(receipt.map((l, i) => (i === 4 ? { ...l, logIndex: undefined } : l)), ACCOUNT, TX), null);
  });
});

describe("the log-level proof admission repeats", () => {
  it("a successful root event of the account passes; a session key, a revert, another sender or malformed data do not", () => {
    const at = (l: OwnerReceiptLog) => ({ topics: l.topics, data: l.data });
    assert.equal(isRootSuccessOf(at(event(ROOT_NONCE)), ACCOUNT), true);
    assert.equal(isRootSuccessOf(at(event((2n << 240n) | 5n)), ACCOUNT), false, "a session key");
    assert.equal(isRootSuccessOf(at(event(ROOT_NONCE, 0n)), ACCOUNT), false, "reverted");
    assert.equal(isRootSuccessOf(at(event(ROOT_NONCE)), EOA), false, "another sender");
    assert.equal(isRootSuccessOf({ topics: event(ROOT_NONCE).topics, data: "0x1234" }, ACCOUNT), false, "malformed");
    const recover = FX.recoverFunds!.logs.find(([, t]) => t[0] === UOE)!;
    assert.equal(isRootSuccessOf({ topics: recover[1], data: recover[2] }, A4B), true, "the real recoverFunds event");
    const session = FX.sessionEnable!.logs.find(([, t]) => t[0] === UOE)!;
    assert.equal(isRootSuccessOf({ topics: session[1], data: session[2] }, A4B), false, "the real session-key event");
  });
});

describe("the record and the notice", () => {
  it("the row carries the root proof, the block time and the recording epoch, and a review reason only on a review", () => {
    const r = read("recoverFunds", "0x04f8241f6d02241469b9c2bc2d2f8cc4cca719eb5c6d54f3a77077c7e41ab3a7", A4B, [VAULT_4B])!;
    const row = ownerOperationRow(r, { agentId: A4B, chainId: 4663, blockNumber: BigInt(FX.recoverFunds!.block), blockTime: FX.recoverFunds!.timestamp, recordedEpoch: 1 });
    assert.equal(row.review_reason, "token-departed");
    assert.equal(row.block_time, 1790947791, "2026-10-02T13:29:51Z, from the chain");
    assert.equal(row.block_number, 78267605);
    assert.equal(row.recorded_epoch, 1);
    assert.equal(row.validator, "root");
    assert.equal(row.covers_logs_json, "[]");
    const ack = ownerOperationRow(read("invalidateNonce", "0x496e7211db25d250d9142105ab5024debcf05519c734d83191145af8eac09ffa", A4B)!,
      { agentId: A4B, chainId: 4663, blockNumber: 1n, blockTime: 1, recordedEpoch: 1 });
    assert.equal(ack.review_reason, null);
  });

  it("the owner is told these are their own operations, that count toward no limit — and only what the book does with the rest", () => {
    const ok = ownerOperationsNotice([read("invalidateNonce", "0x496e7211db25d250d9142105ab5024debcf05519c734d83191145af8eac09ffa", A4B)!])!;
    assert.equal(ok.level, "ok");
    assert.match(ok.text, /not agent trades: they count toward no trading limit/);
    const recover = ownerOperationsNotice([read("recoverFunds", "0x04f8241f6d02241469b9c2bc2d2f8cc4cca719eb5c6d54f3a77077c7e41ab3a7", A4B)!], (t) => (t === NVDA ? "NVDA" : null))!;
    assert.equal(recover.level, "warn");
    // A departure: a withdrawal in kind, which no flow records — never "not a loss".
    assert.match(recover.text, /NVDA left the account under your own key: a withdrawal in kind, not a trade\. No flow records a withdrawal in kind/);
    assert.match(recover.text, /kept for review/);
    assert.doesNotMatch(recover.text, /not a loss/);
    // Its capital leg: left to the scanner, never said to be booked.
    assert.match(recover.text, /348\.368488 USDG\) is your capital, not performance, and is left to the deposit scanner to book as a deposit or withdrawal/);
    const buy = ownerOperationsNotice([synth([before(1), transfer(COIN, EOA, ACCOUNT, 42n, 2), event(ROOT_NONCE)])!])!;
    assert.match(buy.text, /If you paid USDG for it in that transaction, its cost can be recovered from that receipt on a later tick/);
    assert.doesNotMatch(buy.text, /I will recover|no rule can exit/);
    assert.equal(ownerOperationsNotice([]), null);
  });
});
