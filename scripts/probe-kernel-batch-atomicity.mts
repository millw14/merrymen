/**
 * DOES A KERNEL BATCH REVERT WHOLE WHEN ONE INNER CALL REVERTS? — measured on
 * Robinhood Chain, against the real deployed account, spending nothing.
 *
 * WHY THIS HAD TO BE MEASURED. The multi-quote class route puts two hops and a
 * vault buy in ONE UserOperation: USDG → quote asset → `vault.buy`. Its whole
 * safety argument is all-or-nothing execution — if `vault.buy` reverts after
 * hop 1 has already filled, a partial batch would leave the account holding an
 * intermediate token that no producer is watching, and the per-trade USDG cap
 * would no longer bound the stock leg because the stock is already bought. The
 * repo knew only two things about this: a batch has no branching
 * (worker/src/index.ts), and Kernel checks `success` without decoding on a
 * codeless CALL (packages/core/src/protocols.ts). Neither answers the question.
 *
 * ERC-7579 says execType `0x00` is revert-on-failure and `0x01` (TRY_EXEC) is
 * continue-on-failure, and @zerodev/sdk 5.5.10 encodes our batches with `0x00`
 * because worker/src/executor.ts passes no execType. That is a claim about a
 * spec and a claim about a library. This measures the chain.
 *
 * THREE SCENARIOS, AND WHY THE THIRD IS THE ONE THAT MAKES IT A PROOF:
 *
 *   A  DEFAULT, both inner calls succeed   → execute succeeds, allowance = 2
 *      Proves the harness itself works: the execMode, the batch encoding, the
 *      EntryPoint spoof and the post-state read are all correct.
 *   B  DEFAULT, second inner call reverts  → execute REVERTS, allowance = 0
 *      The claim under test. Alone it proves nothing: a malformed payload
 *      would also revert and leave the allowance untouched, and would look
 *      exactly like atomicity.
 *   C  TRY_EXEC, second inner call reverts → execute succeeds, allowance = 1
 *      The same bytes as B with ONE byte changed. A partial batch lands and
 *      the first call's state survives. So B's revert came from the execType,
 *      not from a broken payload, and the difference between atomic and
 *      partial is observable with this harness.
 *
 * READ-ONLY. `eth_simulateV1` executes against live state and discards it;
 * nothing is signed, no UserOperation is built, no key is touched. The account
 * is a real one (the canary's) because the point is to test the deployed
 * Kernel implementation rather than a fixture.
 *
 *   npx tsx scripts/probe-kernel-batch-atomicity.mts [--account 0x..] [--rpc url]
 */
import { createPublicClient, encodeAbiParameters, encodeFunctionData, http, parseAbi } from "viem";
import { robinhoodChain } from "../packages/core/src/chain";
import { CASH, ENTRYPOINT, UNISWAP } from "../packages/core/src/index";

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--") ? process.argv[i + 1]! : fallback;
};

/** Shogun's smart account — deployed Kernel v3.3, the canary for the class route. */
const ACCOUNT = (arg("account", "0x05a198A677Fbcd8f5c168d397Fa7ef5eB6D65487") as `0x${string}`);
const RPC = arg("rpc", process.env.RPC_URL ?? robinhoodChain.rpcUrls.default.http[0])!;
const USDG = CASH.USDG as `0x${string}`;
const SPENDER = UNISWAP.swapRouter02 as `0x${string}`;

const client = createPublicClient({ chain: robinhoodChain, transport: http(RPC) });

/**
 * ERC-7579 ExecMode, 32 bytes:
 *   [0]      callType     0x01 = BATCH
 *   [1]      execType     0x00 = DEFAULT (revert on failure) / 0x01 = TRY_EXEC
 *   [2..5]   unused
 *   [6..9]   modeSelector
 *   [10..31] modePayload
 */
const execMode = (execType: "00" | "01") => `0x01${execType}${"00".repeat(30)}` as `0x${string}`;

const EXECUTION_TUPLE = [
  { type: "tuple[]", components: [{ type: "address" }, { type: "uint256" }, { type: "bytes" }] },
] as const;

const KERNEL_EXECUTE_ABI = parseAbi(["function execute(bytes32 execMode, bytes executionCalldata) payable"]);
const ERC20 = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

const approve = (amount: bigint) => ({
  to: USDG,
  data: encodeFunctionData({ abi: ERC20, functionName: "approve", args: [SPENDER, amount] }),
});
/**
 * The deliberate failure: transfer more USDG than any account holds. An ERC-20
 * balance check is the most boring revert there is — no custom error, no
 * proxy, no permission — so a failure here can only be the transfer.
 */
const revertingCall = () => ({
  to: USDG,
  data: encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [ACCOUNT, 2n ** 200n] }),
});

function executeCalldata(execType: "00" | "01", calls: { to: `0x${string}`; data: `0x${string}` }[]) {
  const executionCalldata = encodeAbiParameters(EXECUTION_TUPLE, [
    calls.map((c) => [c.to, 0n, c.data] as const) as never,
  ]);
  return encodeFunctionData({
    abi: KERNEL_EXECUTE_ABI,
    functionName: "execute",
    args: [execMode(execType), executionCalldata],
  });
}

interface SimCall {
  status: string;
  returnData: string;
  gasUsed: string;
  error?: { message: string };
}

/** One simulated block: the batch, then the allowance read that sees its state. */
async function scenario(label: string, execType: "00" | "01", inner: { to: `0x${string}`; data: `0x${string}` }[]) {
  const res = (await client.request({
    method: "eth_simulateV1",
    params: [
      {
        blockStateCalls: [
          {
            calls: [
              { from: ENTRYPOINT.v07, to: ACCOUNT, data: executeCalldata(execType, inner), value: "0x0" },
              {
                from: ENTRYPOINT.v07,
                to: USDG,
                data: encodeFunctionData({ abi: ERC20, functionName: "allowance", args: [ACCOUNT, SPENDER] }),
                value: "0x0",
              },
            ],
          },
        ],
        traceTransfers: false,
        validation: false,
      },
      "latest",
    ],
  } as never)) as { calls: SimCall[] }[];

  const calls = res?.[0]?.calls ?? [];
  const batch = calls[0];
  const read = calls[1];
  const allowance = read && read.status === "0x1" && read.returnData ? BigInt(read.returnData) : null;
  const ok = batch?.status === "0x1";
  console.log(
    `${label}\n` +
      `   execute:   ${ok ? "SUCCEEDED" : "REVERTED"}${batch?.error?.message ? ` (${batch.error.message.slice(0, 120)})` : ""}\n` +
      `   allowance: ${allowance === null ? "unreadable" : allowance.toString()} (USDG raw, spender = SwapRouter02)`,
  );
  return { ok, allowance };
}

async function main() {
  const code = await client.getCode({ address: ACCOUNT });
  if (!code || code === "0x") throw new Error(`${ACCOUNT} has no code — not a deployed Kernel account`);
  const head = await client.getBlockNumber();
  console.log(
    `[atomicity] chain ${robinhoodChain.id} · rpc ${RPC} · head ${head}\n` +
      `[atomicity] account ${ACCOUNT} (${(code.length - 2) / 2} bytes) · caller ${ENTRYPOINT.v07} (EntryPoint 0.7, spoofed)\n` +
      `[atomicity] read-only: eth_simulateV1 against live state, nothing signed, nothing sent\n`,
  );

  const a = await scenario("A  DEFAULT (0x00), both inner calls succeed — approve 1 then approve 2", "00", [
    approve(1n),
    approve(2n),
  ]);
  const b = await scenario("B  DEFAULT (0x00), second inner call reverts — approve 1 then an impossible transfer", "00", [
    approve(1n),
    revertingCall(),
  ]);
  const c = await scenario("C  TRY_EXEC (0x01), second inner call reverts — the same bytes, one byte changed", "01", [
    approve(1n),
    revertingCall(),
  ]);

  const harnessWorks = a.ok && a.allowance === 2n;
  const atomic = !b.ok && b.allowance === 0n;
  const sensitive = c.ok && c.allowance === 1n;

  console.log(
    `\n[atomicity] harness works:      ${harnessWorks ? "yes" : "NO — the rest of this run means nothing"}\n` +
      `[atomicity] DEFAULT is atomic:  ${atomic ? "yes — the whole batch reverted and hop 1's state did not survive" : "NO"}\n` +
      `[atomicity] probe is sensitive: ${sensitive ? "yes — TRY_EXEC left a partial batch, so B's revert was the execType" : "NO"}`,
  );

  if (harnessWorks && atomic && sensitive) {
    console.log(
      `\n[atomicity] PROVEN on chain ${robinhoodChain.id} at block ${head}: a Kernel batch encoded CALL_TYPE.BATCH +\n` +
        `            EXEC_TYPE.DEFAULT reverts whole when an inner call reverts. The multi-quote route may\n` +
        `            rely on all-or-nothing execution within one UserOperation.`,
    );
    return;
  }
  console.log(
    `\n[atomicity] NOT PROVEN. The multi-quote route must refuse every non-USDG entry with \`route-not-atomic\`\n` +
      `            until this is explained — see docs/multi-quote-route.md §3.4.`,
  );
  process.exitCode = 1;
}

main().catch((e) => {
  console.error("[atomicity] failed:", e);
  process.exit(1);
});
