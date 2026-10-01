import { expect } from "chai";
import hre from "hardhat";
import { getAddress, parseEventLogs } from "viem";

/**
 * V4SelfSwap — the contract that exists so the wall can say something true
 * about a Uniswap v4 swap.
 *
 * The v4 MECHANICS it depends on (negative amountSpecified = exact input,
 * BalanceDelta packing, sqrtPriceLimit bounds, that the deployed PoolManager is
 * the release build) were verified against Robinhood Chain MAINNET during
 * design, by executing the compiled contract through eth_call state overrides
 * against the real USDG/NVDA and USDG/TSLA pools. Those facts are not
 * re-litigated here and a mock could not prove them anyway.
 *
 * What IS proved here is the half that is ours, and every claim the security
 * argument rests on: the payer is the caller, the payee is the caller, the
 * adapter keeps nothing, a standing allowance is not spendable by a third
 * party, a mis-settle is refused, an empty fill is refused, and the callback
 * cannot be driven by anyone but the PoolManager.
 */

/**
 * The repo does not register chai-as-promised, so reverts are caught the way
 * breaker.test.ts does it. But this SIMULATES rather than sends, for a specific
 * reason: hardhat surfaces a parameterless custom error by name in the message
 * and a PARAMETERISED one (SettleMismatch(uint256,uint256)) only as "an unknown
 * RPC error". Asserting on that message would have made two of these tests pass
 * for the wrong reason and one fail while the contract was correct.
 *
 * simulateContract decodes the revert against the ABI, so the assertions can
 * name the error. "It reverted" is a much weaker claim than "it reverted with
 * NoOutput", and on this contract the difference is the whole point.
 */
/**
 * The error name, from EITHER place hardhat puts it: a decoded `data.errorName`
 * on the simulate error, or the message text ("reverted with custom error
 * 'NotPoolManager()'").
 *
 * Which one it uses depends on whether the error carries parameters — a
 * parameterless error decodes into the message, a parameterised one like
 * SettleMismatch(uint256,uint256) surfaces only as "an unknown RPC error".
 * Reading just one of them made two of these tests pass for the wrong reason
 * and a third fail while the contract was correct.
 */
function errorNameOf(e: unknown): string {
  const walk = (x: unknown): string | undefined => {
    const o = x as { data?: { errorName?: string }; cause?: unknown };
    return o?.data?.errorName ?? (o?.cause ? walk(o.cause) : undefined);
  };
  const decoded = walk(e);
  if (decoded) return decoded;
  const text = String((e as Error)?.message ?? e);
  return /custom error '(\w+)\(/.exec(text)?.[1] ?? text;
}

async function revertName(
  adapter: { address: `0x${string}`; abi: readonly unknown[] },
  args: readonly unknown[],
  account: `0x${string}`,
): Promise<string> {
  const publicClient = await hre.viem.getPublicClient();
  try {
    await publicClient.simulateContract({
      address: adapter.address,
      abi: adapter.abi as never,
      functionName: "swapExactIn",
      args: args as never,
      account,
    });
    return "";
  } catch (e) {
    return errorNameOf(e);
  }
}

const DEADLINE = 1n << 40n; // far future
const FEE = 3000;
const SPACING = 60;
const NO_HOOKS = "0x0000000000000000000000000000000000000000" as const;

/** amount0 high, amount1 low — the packing the adapter unpacks. */
async function deploy() {
  const [caller, stranger] = await hre.viem.getWalletClients();
  const pm = await hre.viem.deployContract("MockPoolManager");
  const adapter = await hre.viem.deployContract("V4SelfSwap", [pm.address]);
  const publicClient = await hre.viem.getPublicClient();
  return { caller, stranger, pm, adapter, publicClient };
}

/**
 * Two tokens. NOT sorted by hope — an earlier version redeployed in a loop
 * until the addresses happened to sort the way it wanted, which passed alone
 * and failed in the suite because deployment addresses depend on run order.
 * A test whose outcome depends on address luck is worse than no test.
 */
async function tokens(kind: "plain" | "noReturn" | "dirtyBool" | "feeOnTransfer" = "plain") {
  const name = { plain: "MockERC20", noReturn: "MockNoReturnERC20", dirtyBool: "MockDirtyBoolERC20", feeOnTransfer: "MockFeeOnTransferERC20" }[kind];
  const tokenIn = await hre.viem.deployContract(name as "MockERC20");
  const tokenOut = await hre.viem.deployContract("MockERC20");
  /** Whether tokenIn is currency0, which is what decides the delta ordering. */
  const inIsZero = BigInt(tokenIn.address) < BigInt(tokenOut.address);
  /** Pack (owed, received) into (delta0, delta1) for whichever way they sorted. */
  const delta = (owed: bigint, received: bigint): [bigint, bigint] =>
    inIsZero ? [-owed, received] : [received, -owed];
  return { tokenIn, tokenOut, inIsZero, delta };
}

describe("V4SelfSwap", () => {
  it("pays from the caller and delivers to the caller, keeping nothing", async () => {
    const { caller, pm, adapter } = await deploy();
    const { tokenIn, tokenOut, delta } = await tokens();
    const me = getAddress(caller.account.address);

    await tokenIn.write.mint([me, 1_000_000n]);
    await tokenOut.write.mint([pm.address, 5_000_000n]);
    await tokenIn.write.approve([adapter.address, 1_000_000n]);
    // We owe 1_000_000 of currency0, we are owed 4_000_000 of currency1.
    await pm.write.setNextDelta(delta(1_000_000n, 4_000_000n));

    await adapter.write.swapExactIn([
      tokenIn.address, tokenOut.address, FEE, SPACING, NO_HOOKS, 1_000_000n, 1n, DEADLINE,
    ]);

    expect(await tokenIn.read.balanceOf([me])).to.equal(0n);
    expect(await tokenOut.read.balanceOf([me])).to.equal(4_000_000n, "the output landed with the caller");
    // THE CENTRAL CLAIM: the adapter is not a place where value can rest.
    expect(await tokenIn.read.balanceOf([adapter.address])).to.equal(0n);
    expect(await tokenOut.read.balanceOf([adapter.address])).to.equal(0n);
  });

  it("A STANDING ALLOWANCE IS NOT A SHARED WALLET — a stranger cannot spend it", async () => {
    // The permission model's load-bearing property. The account approves the
    // adapter and that approval persists between trades; if anyone else could
    // call swapExactIn against it, the adapter would be a drain with extra
    // steps. transferFrom(msg.sender, …) is what makes this impossible.
    const { caller, stranger, pm, adapter } = await deploy();
    const { tokenIn, tokenOut, delta } = await tokens();
    const victim = getAddress(caller.account.address);

    await tokenIn.write.mint([victim, 1_000_000n]);
    await tokenOut.write.mint([pm.address, 5_000_000n]);
    await tokenIn.write.approve([adapter.address, 1_000_000n]); // victim's standing allowance
    await pm.write.setNextDelta(delta(1_000_000n, 4_000_000n));

    const asStranger = await hre.viem.getContractAt("V4SelfSwap", adapter.address, {
      client: { wallet: stranger },
    });
    // The stranger holds none of tokenIn, so the pull comes from THEM and fails.
    const err = await revertName(adapter, [
        tokenIn.address, tokenOut.address, FEE, SPACING, NO_HOOKS, 1_000_000n, 1n, DEADLINE,
    ], getAddress(stranger.account.address));
    expect(err).to.not.equal("", "a stranger must not be able to spend the victim's standing allowance");
    expect(await tokenIn.read.balanceOf([victim])).to.equal(1_000_000n, "the victim is untouched");
  });

  it("refuses a fill of nothing, even when minAmountOut is 0", async () => {
    // A compromised session key can pass minAmountOut = 0 — the wall cannot
    // usefully pin it, since it is denominated in the output token. Without
    // this guard an empty-but-initialized pool yields a successful swap that
    // moved nothing, i.e. a manufactured 'landed' trade for the P&L to record.
    const { caller, pm, adapter } = await deploy();
    const { tokenIn, tokenOut, delta } = await tokens();
    await tokenIn.write.mint([getAddress(caller.account.address), 1_000_000n]);
    await tokenIn.write.approve([adapter.address, 1_000_000n]);
    await pm.write.setNextDelta(delta(1_000_000n, 0n));

    expect(await revertName(adapter, [
        tokenIn.address, tokenOut.address, FEE, SPACING, NO_HOOKS, 1_000_000n, 0n, DEADLINE,
    ], getAddress(caller.account.address))).to.equal("NoOutput");
  });

  it("never spends more of the allowance than the caller named, whatever the pool claims", async () => {
    // The pull comes from the DELTA, not the argument, and is then bounded by
    // the argument. That is what makes a LESS_THAN_OR_EQUAL condition on
    // amountIn an on-chain bound rather than a description of intent.
    const { caller, pm, adapter } = await deploy();
    const { tokenIn, tokenOut, delta } = await tokens();
    await tokenIn.write.mint([getAddress(caller.account.address), 10_000_000n]);
    await tokenOut.write.mint([pm.address, 5_000_000n]);
    await tokenIn.write.approve([adapter.address, 10_000_000n]);
    // A hostile pool demands more than was authorised for this call.
    await pm.write.setNextDelta(delta(9_000_000n, 4_000_000n));

    expect(await revertName(adapter, [
        tokenIn.address, tokenOut.address, FEE, SPACING, NO_HOOKS, 1_000_000n, 1n, DEADLINE,
    ], getAddress(caller.account.address))).to.equal("PullExceedsAmountIn");
  });

  it("takes a partial fill without overpaying — the delta is the truth, not the argument", async () => {
    const { caller, pm, adapter } = await deploy();
    const { tokenIn, tokenOut, delta } = await tokens();
    const me = getAddress(caller.account.address);
    await tokenIn.write.mint([me, 1_000_000n]);
    await tokenOut.write.mint([pm.address, 5_000_000n]);
    await tokenIn.write.approve([adapter.address, 1_000_000n]);
    // The pool only wanted a sliver of it.
    await pm.write.setNextDelta(delta(7_263n, 30_000n));

    await adapter.write.swapExactIn([
      tokenIn.address, tokenOut.address, FEE, SPACING, NO_HOOKS, 1_000_000n, 1n, DEADLINE,
    ]);
    expect(await tokenIn.read.balanceOf([me])).to.equal(992_737n, "the rest stayed with the caller");
    expect(await tokenOut.read.balanceOf([me])).to.equal(30_000n);
  });

  it("refuses a fee-on-transfer input rather than mis-settling it", async () => {
    // Named, not anonymous. Without SettleMismatch this surfaces as the
    // singleton's CurrencyNotSettled, which the worker cannot quarantine on.
    const { caller, pm, adapter } = await deploy();
    const { tokenIn, tokenOut, delta } = await tokens("feeOnTransfer");
    await tokenIn.write.mint([getAddress(caller.account.address), 1_000_000n]);
    await tokenOut.write.mint([pm.address, 5_000_000n]);
    await tokenIn.write.approve([adapter.address, 1_000_000n]);
    await pm.write.setNextDelta(delta(1_000_000n, 4_000_000n));

    expect(await revertName(adapter, [
        tokenIn.address, tokenOut.address, FEE, SPACING, NO_HOOKS, 1_000_000n, 1n, DEADLINE,
    ], getAddress(caller.account.address))).to.equal("SettleMismatch");
  });

  it("enforces minOut after output transfer tax, even with an existing holding", async () => {
    const { caller, pm, adapter } = await deploy();
    const tokenIn = await hre.viem.deployContract("MockERC20");
    const tokenOut = await hre.viem.deployContract("MockOutputTaxERC20");
    const me = getAddress(caller.account.address);
    await tokenIn.write.mint([me, 1_000_000n]);
    await tokenIn.write.approve([adapter.address, 1_000_000n]);
    await tokenOut.write.mint([me, 9_000_000n]);
    await tokenOut.write.mint([pm.address, 5_000_000n]);
    await pm.write.setNextDelta(BigInt(tokenIn.address) < BigInt(tokenOut.address)
      ? [-1_000_000n, 4_000_000n] : [4_000_000n, -1_000_000n]);

    // Nominal output clears the floor, but the 1% transfer tax delivers only
    // 3,960,000. The existing 9,000,000 cannot count toward this swap's floor.
    expect(await revertName(adapter, [
      tokenIn.address, tokenOut.address, FEE, SPACING, NO_HOOKS, 1_000_000n, 4_000_000n, DEADLINE,
    ], me)).to.equal("InsufficientOutput");
    expect(await tokenIn.read.balanceOf([me])).to.equal(1_000_000n);
    expect(await tokenOut.read.balanceOf([me])).to.equal(9_000_000n);
  });

  it("returns and emits actual output delivery when a tax stays within minOut", async () => {
    const { caller, pm, adapter, publicClient } = await deploy();
    const tokenIn = await hre.viem.deployContract("MockERC20");
    const tokenOut = await hre.viem.deployContract("MockOutputTaxERC20");
    const me = getAddress(caller.account.address);
    await tokenIn.write.mint([me, 1_000_000n]);
    await tokenIn.write.approve([adapter.address, 1_000_000n]);
    await tokenOut.write.mint([me, 9_000_000n]);
    await tokenOut.write.mint([pm.address, 5_000_000n]);
    await pm.write.setNextDelta(BigInt(tokenIn.address) < BigInt(tokenOut.address)
      ? [-1_000_000n, 4_000_000n] : [4_000_000n, -1_000_000n]);
    const args = [tokenIn.address, tokenOut.address, FEE, SPACING, NO_HOOKS,
      1_000_000n, 3_950_000n, DEADLINE] as const;

    const { result } = await publicClient.simulateContract({
      address: adapter.address, abi: adapter.abi, functionName: "swapExactIn", args, account: me,
    });
    expect(result).to.equal(3_960_000n);
    const hash = await adapter.write.swapExactIn(args);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const logs = parseEventLogs({ abi: adapter.abi, logs: receipt.logs, eventName: "SelfSwap" });
    expect(logs.length).to.equal(1);
    expect(logs[0]!.args.amountOut).to.equal(3_960_000n);
    expect(await tokenOut.read.balanceOf([me])).to.equal(12_960_000n);
    expect(await tokenIn.read.balanceOf([adapter.address])).to.equal(0n);
    expect(await tokenOut.read.balanceOf([adapter.address])).to.equal(0n);
  });

  it("refuses zero actual delivery even when the nominal output and minOut permit it", async () => {
    const { caller, pm, adapter } = await deploy();
    const tokenIn = await hre.viem.deployContract("MockERC20");
    const tokenOut = await hre.viem.deployContract("MockOutputTaxERC20");
    const me = getAddress(caller.account.address);
    await tokenIn.write.mint([me, 1_000_000n]);
    await tokenIn.write.approve([adapter.address, 1_000_000n]);
    await tokenOut.write.mint([pm.address, 5_000_000n]);
    await tokenOut.write.setTaxBps([10_000n]);
    await pm.write.setNextDelta(BigInt(tokenIn.address) < BigInt(tokenOut.address)
      ? [-1_000_000n, 4_000_000n] : [4_000_000n, -1_000_000n]);

    expect(await revertName(adapter, [
      tokenIn.address, tokenOut.address, FEE, SPACING, NO_HOOKS, 1_000_000n, 0n, DEADLINE,
    ], me)).to.equal("NoOutput");
  });

  it("accepts the non-standard ERC-20s this chain's memecoins are full of", async () => {
    for (const kind of ["noReturn", "dirtyBool"] as const) {
      const { caller, pm, adapter } = await deploy();
      const { tokenIn, tokenOut, delta } = await tokens(kind);
      const me = getAddress(caller.account.address);
      await tokenIn.write.mint([me, 1_000_000n]);
      await tokenOut.write.mint([pm.address, 5_000_000n]);
      await tokenIn.write.approve([adapter.address, 1_000_000n]);
      await pm.write.setNextDelta(delta(1_000_000n, 4_000_000n));

      await adapter.write.swapExactIn([
        tokenIn.address, tokenOut.address, FEE, SPACING, NO_HOOKS, 1_000_000n, 1n, DEADLINE,
      ]);
      expect(await tokenOut.read.balanceOf([me])).to.equal(4_000_000n, `${kind} must work`);
    }
  });

  it("the callback is not a public entry point", async () => {
    const { caller, adapter } = await deploy();
    const publicClient = await hre.viem.getPublicClient();
    let name = "";
    try {
      await publicClient.simulateContract({
        address: adapter.address,
        abi: adapter.abi as never,
        functionName: "unlockCallback",
        args: ["0x"] as never,
        account: getAddress(caller.account.address),
      });
    } catch (e) {
      name = errorNameOf(e);
    }
    expect(name).to.equal("NotPoolManager");
  });

  it("refuses the obvious nonsense before touching a token", async () => {
    const { caller, adapter } = await deploy();
    const { tokenIn, tokenOut } = await tokens();
    const me = getAddress(caller.account.address);
    const args = [tokenIn.address, tokenOut.address, FEE, SPACING, NO_HOOKS, 1_000_000n, 1n] as const;
    expect(await revertName(adapter, [...args, 1n], me)).to.equal("Expired");
    expect(
      await revertName(adapter, [tokenIn.address, tokenIn.address, FEE, SPACING, NO_HOOKS, 1n, 1n, DEADLINE], me),
    ).to.equal("IdenticalCurrencies");
    expect(
      await revertName(adapter, [tokenIn.address, tokenOut.address, FEE, SPACING, NO_HOOKS, 0n, 1n, DEADLINE], me),
    ).to.equal("ZeroAmount");
    expect(
      await revertName(adapter, [NO_HOOKS, tokenOut.address, FEE, SPACING, NO_HOOKS, 1n, 1n, DEADLINE], me),
    ).to.equal("NativeNotSupported");
  });

  it("emits the caller as the subject, because the PoolManager's own event names the adapter", async () => {
    const { caller, pm, adapter, publicClient } = await deploy();
    const { tokenIn, tokenOut, delta } = await tokens();
    const me = getAddress(caller.account.address);
    await tokenIn.write.mint([me, 1_000_000n]);
    await tokenOut.write.mint([pm.address, 5_000_000n]);
    await tokenIn.write.approve([adapter.address, 1_000_000n]);
    await pm.write.setNextDelta(delta(1_000_000n, 4_000_000n));

    const hash = await adapter.write.swapExactIn([
      tokenIn.address, tokenOut.address, FEE, SPACING, NO_HOOKS, 1_000_000n, 1n, DEADLINE,
    ]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const logs = parseEventLogs({ abi: adapter.abi, logs: receipt.logs, eventName: "SelfSwap" });
    expect(logs.length).to.equal(1);
    expect(getAddress(logs[0]!.args.account as string)).to.equal(me);
  });
});
