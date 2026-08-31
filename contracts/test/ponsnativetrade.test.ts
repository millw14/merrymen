import { expect } from "chai";
import hre from "hardhat";
import { getAddress, parseEventLogs } from "viem";

/**
 * PonsNativeTrade — the native-quoted half of the launchpad, which its sibling
 * refuses on purpose.
 *
 * The CURVE MECHANICS these tests sit on (that `sell` pays a caller-named
 * recipient DIRECTLY, and that `buy` requires msg.value == quoteIn exactly) were
 * established by probing a live curve on Robinhood Chain mainnet, and a mock
 * could not prove them anyway. What is proved here is the half that is ours, and
 * specifically the claims the design rests on:
 *
 *   - a SELL never routes ETH through this contract, so it needs no receive()
 *     and holds nothing — the property that lets the wall grant it at
 *     valueLimit 0 like everything else;
 *   - the floor is measured against the CALLER's own balance change, so a curve
 *     that takes the input and pays nothing is REFUSED rather than absorbed;
 *   - each direction refuses the other venue by name, so neither adapter can be
 *     pointed at the other's curves;
 *   - a graduated curve is refused;
 *   - the two selectors are genuinely independent, which is what lets an owner
 *     grant exit-only.
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

const FOREVER = 2n ** 48n;

async function setup() {
  const [wallet] = await hre.viem.getWalletClients();
  const account = wallet!.account.address;
  const publicClient = await hre.viem.getPublicClient();

  const token = await hre.viem.deployContract("PonsMockERC20");
  const curve = await hre.viem.deployContract("MockNativePonsCurve", [token.address]);
  const adapter = await hre.viem.deployContract("PonsNativeTrade");

  // The curve needs ETH to pay a seller, and tokens to hand a buyer.
  await wallet!.sendTransaction({ to: curve.address, value: 10n ** 18n });
  await token.write.mint([curve.address, 10n ** 24n]);

  return { wallet, account, publicClient, token, curve, adapter };
}

describe("PonsNativeTrade — selling into a native-quoted curve", () => {
  it("pays the CALLER in ETH and leaves nothing in the adapter", async () => {
    const { account, publicClient, token, curve, adapter } = await setup();
    await token.write.mint([account, 1000n]);
    await token.write.approve([adapter.address, 1000n]);

    const before = await publicClient.getBalance({ address: account });
    const hash = await adapter.write.sellForNative([curve.address, token.address, 1000n, 1n, FOREVER]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const after = await publicClient.getBalance({ address: account });

    // The account gained the ETH, net of the gas it paid to send this tx.
    const gas = receipt.gasUsed * receipt.effectiveGasPrice;
    expect(after - before + gas).to.equal(2000n, "the caller should receive the ETH");

    // THE PROPERTY THE WHOLE DESIGN RESTS ON: the adapter never held any.
    expect(await publicClient.getBalance({ address: adapter.address })).to.equal(0n);
    expect(await token.read.balanceOf([adapter.address])).to.equal(0n);

    const logs = parseEventLogs({ abi: adapter.abi, logs: receipt.logs, eventName: "NativeTrade" });
    expect(logs[0]!.args.isBuy).to.equal(false);
    expect(logs[0]!.args.amountOut).to.equal(2000n);
    expect(getAddress(logs[0]!.args.account)).to.equal(getAddress(account));
  });

  it("REFUSES a curve that takes the tokens and pays no ETH", async () => {
    // The threat model's central claim. The curve returns a healthy-looking 999
    // and pays nothing; the adapter measures the caller's balance instead.
    const { account, token, adapter } = await setup();
    const hostile = await hre.viem.deployContract("MockHostileNativeCurve", [token.address]);
    await token.write.mint([account, 1000n]);
    await token.write.approve([adapter.address, 1000n]);

    try {
      await adapter.write.sellForNative([hostile.address, token.address, 1000n, 1n, FOREVER]);
      expect.fail("a curve that pays nothing must not succeed");
    } catch (e) {
      expect(errorNameOf(e)).to.equal("NoOutput");
    }
  });

  it("refuses an ERC-20-quoted curve by name — that is the sibling's venue", async () => {
    const { account, token, adapter } = await setup();
    const quote = await hre.viem.deployContract("PonsMockERC20");
    const erc20Curve = await hre.viem.deployContract("MockPonsCurve", [token.address, quote.address]);
    await token.write.mint([account, 1000n]);
    await token.write.approve([adapter.address, 1000n]);

    try {
      await adapter.write.sellForNative([erc20Curve.address, token.address, 1000n, 1n, FOREVER]);
      expect.fail("an ERC-20-quoted curve must be refused here");
    } catch (e) {
      expect(errorNameOf(e)).to.equal("NotNativeQuoted");
    }
  });

  it("refuses a graduated curve", async () => {
    const { account, token, curve, adapter } = await setup();
    await curve.write.setGraduated([true]);
    await token.write.mint([account, 1000n]);
    await token.write.approve([adapter.address, 1000n]);

    try {
      await adapter.write.sellForNative([curve.address, token.address, 1000n, 1n, FOREVER]);
      expect.fail("a graduated curve must be refused");
    } catch (e) {
      expect(errorNameOf(e)).to.equal("CurveGraduated");
    }
  });

  it("refuses a token the curve does not recognise", async () => {
    const { account, token, curve, adapter } = await setup();
    const other = await hre.viem.deployContract("PonsMockERC20");
    await other.write.mint([account, 1000n]);
    await other.write.approve([adapter.address, 1000n]);

    try {
      await adapter.write.sellForNative([curve.address, other.address, 1000n, 1n, FOREVER]);
      expect.fail("the caller's token and the curve's must agree");
    } catch (e) {
      expect(errorNameOf(e)).to.equal("TokenDoesNotMatchCurve");
    }
    void token;
  });

  it("enforces the floor against what ARRIVED, not what the curve claimed", async () => {
    // The distinction the whole guarantee turns on. This curve passes its OWN
    // slippage check on the figure it reports and then transfers half of it —
    // the untrusted party grading its own work. Only a balance read on the
    // caller catches that, which is why the adapter does not use the return
    // value for anything.
    const { account, token, curve, adapter } = await setup();
    await curve.write.setPayPct([50n]);
    await token.write.mint([account, 1000n]);
    await token.write.approve([adapter.address, 1000n]);

    try {
      await adapter.write.sellForNative([curve.address, token.address, 1000n, 1500n, FOREVER]);
      expect.fail("a short fill must revert even when the curve says otherwise");
    } catch (e) {
      expect(errorNameOf(e)).to.equal("InsufficientOutput");
    }
  });

  it("refuses an expired deadline and a zero size", async () => {
    const { account, token, curve, adapter } = await setup();
    await token.write.mint([account, 1000n]);
    await token.write.approve([adapter.address, 1000n]);

    try {
      await adapter.write.sellForNative([curve.address, token.address, 1000n, 1n, 1n]);
      expect.fail("an expired deadline must revert");
    } catch (e) {
      expect(errorNameOf(e)).to.equal("Expired");
    }
    try {
      await adapter.write.sellForNative([curve.address, token.address, 0n, 1n, FOREVER]);
      expect.fail("a zero size must revert");
    } catch (e) {
      expect(errorNameOf(e)).to.equal("ZeroAmount");
    }
  });
});

describe("PonsNativeTrade — buying with native ETH", () => {
  it("forwards the whole value and delivers tokens to the CALLER", async () => {
    const { account, publicClient, token, curve, adapter } = await setup();

    const before = await token.read.balanceOf([account]);
    const hash = await adapter.write.buyWithNative([curve.address, token.address, 1n, FOREVER], {
      value: 1000n,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    expect((await token.read.balanceOf([account])) - before).to.equal(2000n);
    // Nothing retained, and no receive() to retain it with.
    expect(await publicClient.getBalance({ address: adapter.address })).to.equal(0n);

    const logs = parseEventLogs({ abi: adapter.abi, logs: receipt.logs, eventName: "NativeTrade" });
    expect(logs[0]!.args.isBuy).to.equal(true);
    expect(logs[0]!.args.amountIn).to.equal(1000n);
  });

  it("REFUSES a curve that takes the ETH and delivers no tokens", async () => {
    const { token, adapter } = await setup();
    const hostile = await hre.viem.deployContract("MockHostileNativeCurve", [token.address]);

    try {
      await adapter.write.buyWithNative([hostile.address, token.address, 1n, FOREVER], { value: 1000n });
      expect.fail("a curve that delivers nothing must not succeed");
    } catch (e) {
      expect(errorNameOf(e)).to.equal("NoOutput");
    }
  });

  it("refuses a zero-value buy — msg.value IS the size", async () => {
    const { token, curve, adapter } = await setup();
    try {
      await adapter.write.buyWithNative([curve.address, token.address, 1n, FOREVER], { value: 0n });
      expect.fail("a zero-value buy must revert");
    } catch (e) {
      expect(errorNameOf(e)).to.equal("ZeroAmount");
    }
  });

  it("refuses an ERC-20-quoted curve here too", async () => {
    const { token, adapter } = await setup();
    const quote = await hre.viem.deployContract("PonsMockERC20");
    const erc20Curve = await hre.viem.deployContract("MockPonsCurve", [token.address, quote.address]);
    try {
      await adapter.write.buyWithNative([erc20Curve.address, token.address, 1n, FOREVER], { value: 1000n });
      expect.fail("an ERC-20-quoted curve must be refused here");
    } catch (e) {
      expect(errorNameOf(e)).to.equal("NotNativeQuoted");
    }
  });
});

describe("PonsNativeTrade — the contract holds nothing", () => {
  it("has no receive() and no fallback, so plain ETH cannot be parked in it", async () => {
    // Load-bearing rather than trivia. "It never holds a balance" is the reason
    // there is nothing here to steal and no rescue function to need, and a
    // receive() added later for convenience would quietly end that.
    const { wallet, adapter, publicClient } = await setup();
    try {
      await wallet!.sendTransaction({ to: adapter.address, value: 1n });
      expect.fail("the adapter must not accept a plain ETH transfer");
    } catch {
      /* expected: no receive, no fallback */
    }
    expect(await publicClient.getBalance({ address: adapter.address })).to.equal(0n);
  });

  it("exposes exactly two external functions, so the two permissions are independent", async () => {
    // The design's whole claim is that an owner can grant the EXIT without
    // granting the entry. That is only true while these are separate selectors
    // on separate ABI entries.
    const { adapter } = await setup();
    const fns = adapter.abi.filter((f: { type: string }) => f.type === "function");
    const names = fns.map((f: { name: string }) => f.name).sort();
    expect(names).to.deep.equal(["buyWithNative", "sellForNative"]);
    const sell = fns.find((f: { name: string }) => f.name === "sellForNative")!;
    const buy = fns.find((f: { name: string }) => f.name === "buyWithNative")!;
    // The sell must stay NON-payable: it is what lets the wall grant it at
    // valueLimit 0, alongside every other permission.
    expect((sell as { stateMutability: string }).stateMutability).to.equal("nonpayable");
    expect((buy as { stateMutability: string }).stateMutability).to.equal("payable");
  });
});
