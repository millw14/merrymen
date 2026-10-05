/**
 * THE IN-KIND SCAN, AGAINST TRANSACTIONS SHAPED THE WAY THE CHAIN RECORDS THEM.
 *
 * Every fixture here is a receipt as EntryPoint v0.7 writes it: validation,
 * BeforeExecution, then each op's execution logs followed by that op's own
 * UserOperationEvent carrying its nonce. The signer comes from that nonce and
 * nowhere else — there is no trades table in this test at all, which is the
 * point of the Shogun fixture: a swap whose row went missing is still a swap.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { concatHex, encodeAbiParameters, encodeFunctionData, pad, parseAbi, toHex, type Hex } from "viem";
import { ENTRYPOINT, NATIVE_ASSET } from "../../packages/core/src/index";
import {
  BEFORE_EXECUTION_TOPIC,
  kernelExecutions,
  scanAssetMovements,
  segmentReceipt,
  USER_OPERATION_EVENT_TOPIC,
  validatorOfNonce,
  type AccountAssetMovements,
} from "./asset-movements";
import { TRANSFER_TOPIC, type RawChainLog, type RpcCall } from "./chain-capital";

const EP = ENTRYPOINT.v07.toLowerCase();
const ME = "0x00000000000000000000000000000000000000a1";
const OTHER_ACCOUNT = "0x00000000000000000000000000000000000000a9";
const OWNER_KEY = "0x00000000000000000000000000000000000000a2";
const TENANT = "0x00000000000000000000000000000000000000a3";
const VAULT = "0x00000000000000000000000000000000000000c0";
const CURVE = "0x00000000000000000000000000000000000000c3";
const POOL = "0x00000000000000000000000000000000000000b1";
const PAIR_B = "0x00000000000000000000000000000000000000b2";
const STRANGER = "0x00000000000000000000000000000000000000f1";
const BUNDLER = "0x00000000000000000000000000000000000000e1";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const TSLA = "0x322f0929c4625ed5bad873c95208d54e1c003b2d";
const PEPE = "0x0000000000000000000000000000000000000ee0";
const VIRTUAL = "0xc6911796042b15d7fa4f6cde69e245ddcd3d9c31";
const MERRYMEN = "0xa15cd06dd305269a0f48bebeb30aa3588fba7b32";
const ECDSA_VALIDATOR = "0x845adb2c711129d4f3966735ed98a9f09fc4ce57";
const ZERO = "0x0000000000000000000000000000000000000000";

// ── nonces, built from the layout executor.ts measured ──────────────────
//   mode(1) ‖ vType(1) ‖ identifier(20) ‖ key(2) ‖ seq(8)
const rootNonce = (seq: bigint) => (BigInt(ECDSA_VALIDATOR) << 80n) | seq;
const sessionNonce = (seq: bigint, enable = false) =>
  ((enable ? 0x01n : 0x00n) << 248n) | (0x02n << 240n) | (0x3ca1cec8n << 208n) | seq;

// ── calldata ─────────────────────────────────────────────────────────────
const HANDLE_OPS = parseAbi([
  "struct PackedUserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }",
  "function handleOps(PackedUserOperation[] ops, address beneficiary)",
]);
const EXECUTE = parseAbi(["function execute(bytes32 execMode, bytes executionCalldata)"]);
const mode = (callType: string, execType = "00") => (`0x${callType}${execType}` + "0".repeat(60)) as Hex;
const single = (target: string, value: bigint, data: Hex = "0x") =>
  encodeFunctionData({
    abi: EXECUTE,
    functionName: "execute",
    args: [mode("00"), concatHex([target as Hex, toHex(value, { size: 32 }), data])],
  });
const batch = (calls: { target: string; value: bigint }[], execType = "00") =>
  encodeFunctionData({
    abi: EXECUTE,
    functionName: "execute",
    args: [
      mode("01", execType),
      encodeAbiParameters(
        [{ type: "tuple[]", components: [{ type: "address" }, { type: "uint256" }, { type: "bytes" }] }],
        [calls.map((c) => [c.target as Hex, c.value, "0x" as Hex] as const)],
      ),
    ],
  });
const handleOps = (ops: { sender: string; nonce: bigint; callData: Hex }[]) =>
  encodeFunctionData({
    abi: HANDLE_OPS,
    functionName: "handleOps",
    args: [
      ops.map((o) => ({
        sender: o.sender as Hex,
        nonce: o.nonce,
        initCode: "0x" as Hex,
        callData: o.callData,
        accountGasLimits: pad("0x0", { size: 32 }),
        preVerificationGas: 0n,
        gasFees: pad("0x0", { size: 32 }),
        paymasterAndData: "0x" as Hex,
        signature: "0x" as Hex,
      })),
      BUNDLER as Hex,
    ],
  });

// ── logs ─────────────────────────────────────────────────────────────────
const pad32 = (a: string) => "0x" + a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const word = (n: bigint) => n.toString(16).padStart(64, "0");
type Draft = Pick<RawChainLog, "address" | "topics" | "data">;
const transfer = (token: string, from: string, to: string, amount: bigint): Draft => ({
  address: token,
  topics: [TRANSFER_TOPIC, pad32(from), pad32(to)],
  data: "0x" + word(amount),
});
const beforeExecution = (): Draft => ({ address: EP, topics: [BEFORE_EXECUTION_TOPIC], data: "0x" });
let opCounter = 0;
const opEvent = (sender: string, nonce: bigint, success = true, paymaster = ZERO, entryPoint = EP): Draft => ({
  address: entryPoint,
  topics: [USER_OPERATION_EVENT_TOPIC, "0x" + word(BigInt(++opCounter) + 0xabcdn), pad32(sender), pad32(paymaster)],
  data: "0x" + word(nonce) + word(success ? 1n : 0n) + word(0n) + word(0n),
});

interface FakeTx {
  hash: string;
  block: number;
  from?: string;
  to?: string;
  input?: Hex;
  logs: Draft[];
  status?: string;
}
const finish = (tx: FakeTx): RawChainLog[] =>
  tx.logs.map((l, i) => ({
    ...l,
    blockNumber: "0x" + tx.block.toString(16),
    transactionHash: tx.hash,
    logIndex: "0x" + i.toString(16),
  }));

/**
 * A node that HONOURS the log filter — address and every topic position —
 * because a fake that returns everything to every sweep is a model of a node
 * that does not work (chain-capital.test.ts learned this the expensive way).
 */
const fakeChain = (txs: FakeTx[], opts: { unreadableReceipts?: string[]; failLogs?: number } = {}) => {
  const calls: { method: string; params: unknown[] }[] = [];
  let logFailures = opts.failLogs ?? 0;
  const rpc: RpcCall = async (method, params) => {
    calls.push({ method, params });
    if (method === "eth_getLogs") {
      if (logFailures > 0) {
        logFailures--;
        throw new Error("429 Too Many Requests");
      }
      const f = params[0] as { address?: string; fromBlock: string; toBlock: string; topics: (string | string[] | null)[] };
      const from = Number(BigInt(f.fromBlock));
      const to = Number(BigInt(f.toBlock));
      return txs.flatMap((tx) =>
        tx.block < from || tx.block > to
          ? []
          : finish(tx).filter(
              (l) =>
                (!f.address || l.address.toLowerCase() === f.address.toLowerCase()) &&
                f.topics.every((want, i) => {
                  if (want === null || want === undefined) return true;
                  const list = Array.isArray(want) ? want : [want];
                  return list.some((w) => w.toLowerCase() === String(l.topics[i] ?? "").toLowerCase());
                }),
            ),
      );
    }
    if (method === "eth_getTransactionReceipt") {
      const tx = txs.find((t) => t.hash === params[0]);
      if (!tx) return null;
      if (opts.unreadableReceipts?.includes(tx.hash)) throw new Error("connection reset");
      return {
        status: tx.status ?? "0x1",
        blockNumber: "0x" + tx.block.toString(16),
        blockHash: "0x" + word(BigInt(tx.block)),
        from: tx.from ?? BUNDLER,
        to: tx.to ?? EP,
        logs: finish(tx),
      };
    }
    if (method === "eth_getTransactionByHash") {
      const tx = txs.find((t) => t.hash === params[0]);
      return tx ? { hash: tx.hash, input: tx.input ?? "0x", from: tx.from ?? BUNDLER, to: tx.to ?? EP } : null;
    }
    if (method === "eth_getBlockByNumber") {
      const n = BigInt(params[0] as string);
      return { number: "0x" + n.toString(16), hash: "0x" + word(n), timestamp: "0x" + (1_790_000_000n + n).toString(16) };
    }
    throw new Error(`unexpected RPC method ${method}`);
  };
  return { rpc, calls };
};

const scan = async (
  txs: FakeTx[],
  extra: { custody?: string[]; unreadableReceipts?: string[]; failLogs?: number; accounts?: string[] } = {},
) => {
  const { rpc, calls } = fakeChain(txs, extra);
  const out = await scanAssetMovements(rpc, {
    accounts: (extra.accounts ?? [ME]).map((account) => ({
      account,
      custody: account === ME ? extra.custody : undefined,
      owners: [OWNER_KEY, TENANT],
    })),
    usdgToken: USDG,
    fromBlock: 0n,
    toBlock: 10_000n,
    reserveTokens: [MERRYMEN],
    systemAddresses: [EP],
    includeReviewTimestamps: true,
    sleep: async () => {},
  });
  return { me: out.get(ME)! as AccountAssetMovements, out, calls };
};

describe("who signed, read off the nonce", () => {
  it("reads the two nonces measured on 4663 the way executor.ts does", () => {
    // sudo-only account: mode 0x00, type 0x00. Walled enable: 0x01, 0x02.
    assert.equal(validatorOfNonce(BigInt("0x0000845adb2c711129d4f3966735ed98a9f09fc4ce570000" + "0000000000000000")), "root");
    assert.equal(validatorOfNonce(BigInt("0x01023ca1cec8" + "0".repeat(32) + "0000" + "0000000000000001")), "permission");
  });

  it("a session key's ENABLE op still executes as the session key", () => {
    assert.equal(validatorOfNonce(sessionNonce(0n, true)), "permission");
    assert.equal(validatorOfNonce(sessionNonce(7n)), "permission");
  });

  it("a secondary validator is named as one", () => {
    assert.equal(validatorOfNonce((0x01n << 240n) | (BigInt(ECDSA_VALIDATOR) << 80n)), "secondary");
  });

  it("anything it has not measured is refused — never read as the nearest thing", () => {
    // The nearest thing to "root" is a capital candidate.
    assert.equal(validatorOfNonce((0x01n << 248n) | rootNonce(0n)), null, "root in enable mode");
    assert.equal(validatorOfNonce((0x02n << 248n) | (0x02n << 240n)), null, "install mode");
    assert.equal(validatorOfNonce(0x03n << 240n), null, "unknown validator type");
    assert.equal(validatorOfNonce(-1n), null);
    assert.equal(validatorOfNonce(1n << 256n), null);
  });
});

describe("the ETH a Kernel execute sent", () => {
  it("reads a single call's value, with or without the executeUserOp prefix", () => {
    const call = single(CURVE, 10n ** 16n, "0xd0e30db0");
    assert.deepEqual(kernelExecutions(call), [{ target: CURVE, value: 10n ** 16n }]);
    assert.deepEqual(kernelExecutions(concatHex(["0x8dd7712f", call])), [{ target: CURVE, value: 10n ** 16n }]);
  });

  it("reads every call of a default batch", () => {
    const got = kernelExecutions(batch([{ target: TSLA, value: 0n }, { target: TENANT, value: 5n }]));
    assert.deepEqual(got, [{ target: TSLA, value: 0n }, { target: TENANT, value: 5n }]);
  });

  it("refuses a TRY batch and a delegatecall rather than guess what moved", () => {
    assert.equal(kernelExecutions(batch([{ target: TENANT, value: 5n }], "01")), null);
    const delegate = encodeFunctionData({ abi: EXECUTE, functionName: "execute", args: [mode("ff"), TENANT as Hex] });
    assert.equal(kernelExecutions(delegate), null);
    assert.equal(kernelExecutions("0xdeadbeef"), null);
  });
});

describe("which op produced which log", () => {
  it("splits a bundle at each op's own event, and leaves validation logs to nobody", () => {
    const logs = finish({
      hash: "0xb",
      block: 1,
      logs: [
        transfer(PEPE, STRANGER, ME, 1n), // validation phase — nobody's execution
        beforeExecution(),
        transfer(TSLA, ME, TENANT, 2n),
        opEvent(ME, rootNonce(1n)),
        transfer(USDG, ME, POOL, 3n),
        transfer(PEPE, POOL, ME, 4n),
        opEvent(ME, sessionNonce(2n)),
      ],
    });
    const { segments, unattributed, foreign } = segmentReceipt(logs);
    assert.equal(segments.length, 2);
    assert.equal(segments[0]!.logs.length, 1);
    assert.equal(segments[1]!.logs.length, 2);
    assert.equal(unattributed.length, 1);
    assert.equal(foreign.length, 0);
  });

  it("an op event from another EntryPoint is set aside, not decoded", () => {
    const logs = finish({ hash: "0xf", block: 1, logs: [opEvent(ME, rootNonce(1n), true, ZERO, ENTRYPOINT.v06)] });
    const { segments, foreign } = segmentReceipt(logs);
    assert.equal(segments.length, 0);
    assert.equal(foreign.length, 1);
  });
});

describe("the four shapes", () => {
  it("an owner sudo sweep is asset-out, with its block time for review", async () => {
    const { me } = await scan([
      {
        hash: "0x5eeb",
        block: 100,
        input: handleOps([{ sender: ME, nonce: rootNonce(4n), callData: single(TSLA, 0n, "0xa9059cbb") }]),
        logs: [beforeExecution(), transfer(TSLA, ME, TENANT, 13n * 10n ** 18n), opEvent(ME, rootNonce(4n))],
      },
    ]);
    assert.equal(me.movements.length, 1);
    const m = me.movements[0]!;
    assert.equal(m.classification.kind, "asset-out");
    assert.equal(m.classification.capitalCandidate, true);
    assert.equal(m.provenance.source, "user-op");
    assert.equal(m.provenance.source === "user-op" && m.provenance.validator, "root");
    assert.equal(m.at, 1_790_000_100);
    assert.equal(me.counts["asset-out"], 1);
    assert.equal(me.operations, 1);
    assert.equal(me.complete, true);
  });

  it("THE SHOGUN CASE: a session-key swap with no trades row anywhere is a trade leg", async () => {
    // No trades table is consulted — there is none in this test. The verdict
    // comes from the op's nonce and the USDG that left in the same op.
    const { me } = await scan([
      {
        hash: "0x5409",
        block: 200,
        input: handleOps([{ sender: ME, nonce: sessionNonce(9n), callData: single(POOL, 0n, "0x12345678") }]),
        logs: [
          beforeExecution(),
          transfer(USDG, ME, POOL, 25_000_000n),
          transfer(PEPE, POOL, ME, 400n * 10n ** 18n),
          opEvent(ME, sessionNonce(9n)),
        ],
      },
    ]);
    assert.equal(me.movements.length, 1, "the USDG leg is chain-capital's, not this scan's");
    const m = me.movements[0]!;
    assert.equal(m.asset, PEPE);
    assert.equal(m.classification.kind, "trade-leg");
    assert.equal(m.classification.capitalCandidate, false);
    assert.equal(m.provenance.source === "user-op" && m.provenance.validator, "permission");
    assert.equal(m.at, undefined, "a trade leg needs no review, so no block time was read for it");
  });

  it("a native-ETH curve buy is a trade leg, paired through the execution's value", async () => {
    const { me, calls } = await scan([
      {
        hash: "0xc0e1",
        block: 300,
        input: handleOps([{ sender: ME, nonce: sessionNonce(10n), callData: single(CURVE, 10n ** 16n, "0xd96a094a") }]),
        logs: [beforeExecution(), transfer(PEPE, CURVE, ME, 400n * 10n ** 18n), opEvent(ME, sessionNonce(10n))],
      },
    ]);
    const token = me.movements.find((m) => m.asset === PEPE)!;
    const eth = me.movements.find((m) => m.asset === NATIVE_ASSET)!;
    assert.equal(token.classification.kind, "trade-leg");
    assert.equal(token.classification.pairedAsset, NATIVE_ASSET);
    assert.equal(eth.classification.kind, "trade-leg");
    assert.equal(eth.amountRaw, (10n ** 16n).toString());
    assert.equal(eth.logIndex, null, "native ETH has no log of its own");
    assert.ok(calls.some((c) => c.method === "eth_getTransactionByHash"), "the calldata is where the ETH is written");
  });

  it("reserve and custody legs are excluded", async () => {
    const { me } = await scan(
      [
        {
          // The energy route: USDG → VIRTUAL → $MERRYMEN, the middle hop
          // never touching the account.
          hash: "0xe4e1",
          block: 400,
          input: handleOps([{ sender: ME, nonce: sessionNonce(11n), callData: single(POOL, 0n) }]),
          logs: [
            beforeExecution(),
            transfer(USDG, ME, POOL, 42_000_000n),
            transfer(VIRTUAL, POOL, PAIR_B, 90n * 10n ** 18n),
            transfer(MERRYMEN, PAIR_B, ME, 98_000n * 10n ** 18n),
            opEvent(ME, sessionNonce(11n)),
          ],
        },
        {
          // The owner sweeping a position back from the class vault. Swept by
          // BOTH directions (vault out, account in); recorded once.
          hash: "0x5a17",
          block: 401,
          input: handleOps([{ sender: ME, nonce: rootNonce(5n), callData: single(VAULT, 0n, "0x01") }]),
          logs: [beforeExecution(), transfer(PEPE, VAULT, ME, 400n * 10n ** 18n), opEvent(ME, rootNonce(5n))],
        },
      ],
      { custody: [VAULT] },
    );
    assert.deepEqual(
      me.movements.map((m) => [m.asset, m.classification.kind]),
      [
        [MERRYMEN, "reserve"],
        [PEPE, "custody"],
      ],
    );
    assert.equal(me.counts["asset-in"] + me.counts["asset-out"], 0);
  });
});

describe("a bundle is read op by op", () => {
  it("an owner sweep beside an agent swap stays a sweep — the swap's legs do not pair with it", async () => {
    // Pairing across the bundle would read the sweep's TSLA leaving against
    // the swap's PEPE arriving as one trade.
    const { me } = await scan([
      {
        hash: "0xb0b0",
        block: 500,
        input: handleOps([
          { sender: ME, nonce: rootNonce(6n), callData: single(TSLA, 0n, "0xa9059cbb") },
          { sender: ME, nonce: sessionNonce(12n), callData: single(POOL, 0n) },
        ]),
        logs: [
          beforeExecution(),
          transfer(TSLA, ME, TENANT, 13n * 10n ** 18n),
          opEvent(ME, rootNonce(6n)),
          transfer(USDG, ME, POOL, 25_000_000n),
          transfer(PEPE, POOL, ME, 400n * 10n ** 18n),
          opEvent(ME, sessionNonce(12n)),
        ],
      },
    ]);
    assert.deepEqual(
      me.movements.map((m) => [m.asset, m.classification.kind]),
      [
        [TSLA, "asset-out"],
        [PEPE, "trade-leg"],
      ],
    );
    assert.equal(me.operations, 2);
  });

  it("a movement outside every op's execution, in a tx this account acted in, is not read as 'nobody acted'", async () => {
    const { me } = await scan([
      {
        hash: "0xa11d",
        block: 510,
        input: handleOps([{ sender: ME, nonce: rootNonce(7n), callData: single(TSLA, 0n) }]),
        logs: [transfer(PEPE, TENANT, ME, 1n), beforeExecution(), opEvent(ME, rootNonce(7n))],
      },
    ]);
    const m = me.movements[0]!;
    assert.equal(m.provenance.source, "unknown");
    assert.equal(m.classification.kind, "ambiguous");
    assert.equal(m.classification.evidence.rule, "provenance-unread");
  });

  it("a token paymaster's charge is the op's gas, not part of the sweep", async () => {
    const PAYMASTER = "0x00000000000000000000000000000000000000d7";
    const { me } = await scan([
      {
        hash: "0x9a9a",
        block: 515,
        input: handleOps([{ sender: ME, nonce: rootNonce(12n), callData: single(TSLA, 0n) }]),
        logs: [
          beforeExecution(),
          transfer(TSLA, ME, TENANT, 13n * 10n ** 18n),
          transfer(PEPE, ME, PAYMASTER, 5n),
          opEvent(ME, rootNonce(12n), true, PAYMASTER),
        ],
      },
    ]);
    assert.deepEqual(
      me.movements.map((m) => [m.asset, m.classification.kind]),
      [
        [TSLA, "asset-out"],
        [PEPE, "protocol"],
      ],
    );
  });

  it("a reverted op moved nothing and records nothing", async () => {
    const { me } = await scan([
      {
        hash: "0xdead",
        block: 520,
        input: handleOps([{ sender: ME, nonce: rootNonce(8n), callData: single(TENANT, 10n ** 18n) }]),
        logs: [beforeExecution(), opEvent(ME, rootNonce(8n), false)],
      },
    ]);
    assert.equal(me.movements.length, 0);
    assert.equal(me.operations, 1);
  });
});

describe("what only the operation sweep can find", () => {
  it("an owner sweeping native ETH home has no Transfer log — it is found by its op and is asset-out", async () => {
    const { me } = await scan([
      {
        hash: "0xe7e7",
        block: 600,
        input: handleOps([{ sender: ME, nonce: rootNonce(9n), callData: single(TENANT, 5n * 10n ** 16n) }]),
        logs: [beforeExecution(), opEvent(ME, rootNonce(9n))],
      },
    ]);
    assert.equal(me.movements.length, 1);
    assert.equal(me.movements[0]!.asset, NATIVE_ASSET);
    assert.equal(me.movements[0]!.classification.kind, "asset-out");
  });

  it("unreadable calldata leaves an owner's unpaired token NON-capital and the scan incomplete", async () => {
    const { me } = await scan([
      {
        hash: "0x0dd1",
        block: 610,
        to: "0x00000000000000000000000000000000000000d0", // a bundler wrapper, not the EntryPoint
        logs: [beforeExecution(), transfer(PEPE, CURVE, ME, 1n), opEvent(ME, rootNonce(10n))],
      },
    ]);
    const m = me.movements[0]!;
    assert.equal(m.classification.evidence.rule, "executions-unread");
    assert.equal(m.classification.capitalCandidate, false);
    assert.equal(me.complete, false);
  });
});

describe("when this account did not act", () => {
  it("the tenant wallet sending TSLA is asset-in; a stranger's airdrop is ambiguous", async () => {
    const { me, calls } = await scan([
      { hash: "0x1111", block: 700, from: TENANT, to: TSLA, logs: [transfer(TSLA, TENANT, ME, 13n * 10n ** 18n)] },
      { hash: "0x2222", block: 701, from: STRANGER, to: PEPE, logs: [transfer(PEPE, STRANGER, ME, 1n)] },
    ]);
    assert.deepEqual(
      me.movements.map((m) => [m.asset, m.classification.kind, m.classification.evidence.rule]),
      [
        [TSLA, "asset-in", "owner-wallet"],
        [PEPE, "ambiguous", "unsolicited-inbound"],
      ],
    );
    assert.equal(calls.filter((c) => c.method === "eth_getTransactionByHash").length, 0, "no op of ours, no calldata needed");
  });

  it("a stranger's token logging Transfer(owner → account) is NOT a deposit — the log's sender is the contract's word", async () => {
    // Address poisoning with an amount: the fake token's own code writes the
    // owner's key as `from`, in a transaction the stranger sent.
    const FAKE = "0x0000000000000000000000000000000000000fa6";
    const { me } = await scan([
      { hash: "0x9015", block: 705, from: STRANGER, to: FAKE, logs: [transfer(FAKE, OWNER_KEY, ME, 10n ** 18n)] },
    ]);
    assert.equal(me.movements.length, 1);
    const m = me.movements[0]!;
    assert.deepEqual(m.provenance, { source: "none", actors: [STRANGER] });
    assert.equal(m.classification.kind, "ambiguous");
    assert.equal(m.classification.evidence.rule, "owner-named-only-by-log");
    assert.equal(m.classification.capitalCandidate, false);
    assert.equal(me.counts["asset-in"], 0);
  });

  it("another hosted account's op sending us a token is internal", async () => {
    const { me } = await scan(
      [
        {
          hash: "0x3333",
          block: 710,
          input: handleOps([{ sender: OTHER_ACCOUNT, nonce: rootNonce(1n), callData: single(TSLA, 0n) }]),
          logs: [beforeExecution(), transfer(TSLA, OTHER_ACCOUNT, ME, 1n), opEvent(OTHER_ACCOUNT, rootNonce(1n))],
        },
      ],
      { accounts: [ME, OTHER_ACCOUNT] },
    );
    assert.equal(me.movements[0]!.classification.kind, "internal");
    assert.equal(me.movements[0]!.provenance.source, "none");
  });

  it("zero-amount poisoning transfers are not recorded at all", async () => {
    const { me } = await scan([{ hash: "0x4444", block: 720, from: STRANGER, logs: [transfer(TSLA, ME, STRANGER, 0n)] }]);
    assert.equal(me.movements.length, 0);
  });
});

describe("coverage travels with the answer", () => {
  it("an unreadable receipt makes its movements ambiguous and the account incomplete", async () => {
    const { me } = await scan(
      [{ hash: "0x5555", block: 800, from: TENANT, logs: [transfer(TSLA, TENANT, ME, 1n)] }],
      { unreadableReceipts: ["0x5555"] },
    );
    assert.equal(me.complete, false);
    assert.equal(me.movements[0]!.classification.kind, "ambiguous");
    assert.equal(me.movements[0]!.classification.evidence.rule, "provenance-unread");
    assert.ok(me.notes.some((n) => /unreadable receipt 0x5555/.test(n)));
  });

  it("a rate-limited sweep is waited out, not split and not dropped", async () => {
    const { me, calls } = await scan(
      [{ hash: "0x6666", block: 900, from: TENANT, logs: [transfer(TSLA, TENANT, ME, 1n)] }],
      { failLogs: 2 },
    );
    assert.equal(me.complete, true);
    assert.equal(me.movements.length, 1);
    assert.equal(calls.filter((c) => c.method === "eth_getLogs").length, 5, "two refusals, then the three sweeps");
  });

  it("every answer says what it cannot see", async () => {
    const { me } = await scan([]);
    assert.ok(me.notes.some((n) => /native ETH received outside an operation/.test(n)));
  });

  it("calls nothing that writes", async () => {
    const { calls } = await scan([
      {
        hash: "0x7777",
        block: 950,
        input: handleOps([{ sender: ME, nonce: rootNonce(11n), callData: single(TSLA, 0n) }]),
        logs: [beforeExecution(), transfer(TSLA, ME, TENANT, 1n), opEvent(ME, rootNonce(11n))],
      },
    ]);
    const methods = new Set(calls.map((c) => c.method));
    for (const m of methods) {
      assert.ok(
        ["eth_getLogs", "eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_getBlockByNumber"].includes(m),
        `unexpected method ${m}`,
      );
    }
  });
});
