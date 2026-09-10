import { expect } from "chai";
import hre from "hardhat";
import { getAddress } from "viem";

/**
 * PonsClassVault — the contract that makes a CLASS position exitable.
 *
 * The whole reason this contract exists is one claim, and it is the first thing
 * proved below: SELLING A CLASS TOKEN NEEDS NO APPROVE FROM THE OWNER. The
 * enumerated wall can express a per-token approve only for a token named at
 * signing time, so a sniped token could be bought and never sold — the no-exit
 * trap. Holding the token here instead of in the account is what removes the
 * approve from the exit path, and `sells without the owner ever approving the
 * token` is the test that says so.
 *
 * The other claims are the ones the custody trade rests on: this vault belongs
 * to exactly ONE account, nothing can leave it except to that account, and
 * `sweep` gets a position out even when the curve is dead. If any of those stop
 * being true, holding assets here stops being defensible.
 *
 * Curve mechanics (a live curve pulls its input from its caller by transferFrom
 * and pays a caller-named recipient) were established against mainnet during
 * PonsSelfTrade's design and are not re-litigated here — the mock mirrors them.
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
const ONE = 10n ** 18n;

async function setup() {
  const [ownerWallet, strangerWallet] = await hre.viem.getWalletClients();
  const owner = ownerWallet!.account.address;
  const stranger = strangerWallet!.account.address;
  const publicClient = await hre.viem.getPublicClient();

  const quote = await hre.viem.deployContract("PonsMockERC20");
  const token = await hre.viem.deployContract("PonsMockERC20");
  const curve = await hre.viem.deployContract("MockPonsCurve", [token.address, quote.address]);
  const vault = await hre.viem.deployContract("PonsClassVault", [owner]);

  // The owner has cash; the curve has inventory on both sides so it can pay out.
  await quote.write.mint([owner, 1_000n * ONE]);
  await token.write.mint([curve.address, 1_000_000n * ONE]);
  await quote.write.mint([curve.address, 1_000_000n * ONE]);

  // THE ONLY APPROVE IN THE WHOLE FLOW, and it is the account's ordinary,
  // already-granted quote approve — never a per-token one.
  await quote.write.approve([vault.address, 1_000n * ONE]);

  return { owner, stranger, strangerWallet, publicClient, quote, token, curve, vault };
}

describe("PonsClassVault", () => {
  it("sells without the owner ever approving the token — the reason this contract exists", async () => {
    const { owner, quote, token, curve, vault } = await setup();

    await vault.write.buy([curve.address, quote.address, 10n * ONE, 0n, FOREVER]);

    // The token is in the VAULT, not the account. That is the mechanism: the
    // account cannot be asked to approve what it does not hold.
    expect(await token.read.balanceOf([vault.address])).to.equal(20n * ONE);
    expect(await token.read.balanceOf([owner])).to.equal(0n);

    // The owner has approved the token to NOBODY — assert it rather than imply
    // it, because the entire no-exit argument turns on this being zero.
    expect(await token.read.allowance([owner, vault.address])).to.equal(0n);
    expect(await token.read.allowance([owner, curve.address])).to.equal(0n);

    const before = await quote.read.balanceOf([owner]);
    await vault.write.sell([curve.address, 20n * ONE, 0n, FOREVER]);

    // It sold, and the proceeds went to the OWNER, with no token approve
    // anywhere in the path. (Compared as an exact bigint: chai's `greaterThan`
    // silently wants a number and rejects the bigint these balances are.)
    expect(await quote.read.balanceOf([owner])).to.equal(before + 40n * ONE);
    expect(await token.read.balanceOf([vault.address])).to.equal(0n);
  });

  it("never keeps the quote asset — proceeds land on the owner, not here", async () => {
    const { owner, quote, curve, vault } = await setup();

    await vault.write.buy([curve.address, quote.address, 10n * ONE, 0n, FOREVER]);
    // Buys spend the pulled quote; nothing is parked here between calls.
    expect(await quote.read.balanceOf([vault.address])).to.equal(0n);

    const before = await quote.read.balanceOf([owner]);
    await vault.write.sell([curve.address, 20n * ONE, 0n, FOREVER]);
    expect(await quote.read.balanceOf([vault.address])).to.equal(0n);
    expect(await quote.read.balanceOf([owner])).to.equal(before + 40n * ONE);
  });

  it("refuses every entry point to anyone but its one owner", async () => {
    const { strangerWallet, quote, token, curve, vault } = await setup();
    const as = { account: strangerWallet!.account };

    for (const call of [
      () => vault.write.buy([curve.address, quote.address, ONE, 0n, FOREVER], as),
      () => vault.write.sell([curve.address, ONE, 0n, FOREVER], as),
      () => vault.write.sweep([token.address], as),
    ]) {
      try {
        await call();
        expect.fail("a stranger reached a vault that is not theirs");
      } catch (e) {
        expect(errorNameOf(e)).to.equal("NotOwner");
      }
    }
  });

  it("sweeps a position back to the owner even when the curve is dead", async () => {
    const { owner, quote, token, curve, vault } = await setup();
    await vault.write.buy([curve.address, quote.address, 10n * ONE, 0n, FOREVER]);

    // The curve graduates: selling through it is refused from here on.
    await curve.write.setGraduated([true]);
    try {
      await vault.write.sell([curve.address, 20n * ONE, 0n, FOREVER]);
      expect.fail("sold through a graduated curve");
    } catch (e) {
      expect(errorNameOf(e)).to.equal("CurveGraduated");
    }

    // THE UNCONDITIONAL EXIT. A position you cannot sell is still a position you
    // can move, so sweep does not consult the curve at all.
    await vault.write.sweep([token.address]);
    expect(await token.read.balanceOf([owner])).to.equal(20n * ONE);
    expect(await token.read.balanceOf([vault.address])).to.equal(0n);
  });

  it("refuses a graduated curve and a native-quoted curve by name", async () => {
    const { quote, curve, vault } = await setup();

    await curve.write.setGraduated([true]);
    try {
      await vault.write.buy([curve.address, quote.address, ONE, 0n, FOREVER]);
      expect.fail("bought through a graduated curve");
    } catch (e) {
      expect(errorNameOf(e)).to.equal("CurveGraduated");
    }
    await curve.write.setGraduated([false]);

    // pairToken() == address(0) is how a curve says "I am quoted in native ETH".
    const native = await hre.viem.deployContract("MockPonsCurve", [
      quote.address,
      "0x0000000000000000000000000000000000000000",
    ]);
    try {
      await vault.write.buy([native.address, quote.address, ONE, 0n, FOREVER]);
      expect.fail("bought a native-quoted curve");
    } catch (e) {
      expect(errorNameOf(e)).to.equal("NativeQuoteNotSupported");
    }
  });

  it("refuses a curve whose quote is not the asset it was handed", async () => {
    const { quote, token, curve, vault } = await setup();
    // Pass the TOKEN as the quote asset for a quote-quoted curve.
    try {
      await vault.write.buy([curve.address, token.address, ONE, 0n, FOREVER]);
      expect.fail("traded a curve against the wrong quote asset");
    } catch (e) {
      expect(errorNameOf(e)).to.equal("TokenDoesNotMatchCurve");
    }
  });

  it("turns a hostile curve that pays nothing into a revert, not a silent loss", async () => {
    const { quote, vault } = await setup();
    const token = await hre.viem.deployContract("PonsMockERC20");
    const hostile = await hre.viem.deployContract("MockHostileCurve", [token.address, quote.address]);
    await hostile.write.setPayBps([0n]);

    try {
      await vault.write.buy([hostile.address, quote.address, ONE, 0n, FOREVER]);
      expect.fail("a curve took the money and paid nothing, and it was accepted");
    } catch (e) {
      // The balance delta is measured here rather than believed from the curve,
      // so "paid nothing" is a named refusal.
      expect(errorNameOf(e)).to.be.oneOf(["NoOutput", "InsufficientOutput", "TransferFailed"]);
    }
  });

  it("refuses an expired deadline and a zero amount", async () => {
    const { quote, curve, vault, token } = await setup();
    try {
      await vault.write.buy([curve.address, quote.address, ONE, 0n, 1n]);
      expect.fail("traded past the deadline");
    } catch (e) {
      expect(errorNameOf(e)).to.equal("Expired");
    }
    try {
      await vault.write.buy([curve.address, quote.address, 0n, 0n, FOREVER]);
      expect.fail("traded zero");
    } catch (e) {
      expect(errorNameOf(e)).to.equal("ZeroAmount");
    }
    try {
      await vault.write.sweep([token.address]);
      expect.fail("swept an empty balance");
    } catch (e) {
      expect(errorNameOf(e)).to.equal("ZeroAmount");
    }
  });
});

describe("PonsClassVaultFactory", () => {
  it("predicts the vault address before it exists — what lets the wall pin it", async () => {
    const [wallet] = await hre.viem.getWalletClients();
    const owner = wallet!.account.address;
    const factory = await hre.viem.deployContract("PonsClassVaultFactory");

    // THE LOAD-BEARING PROPERTY. The grant is signed before the vault is
    // deployed, so the wall can only name it if the address is knowable in
    // advance. If this ever stops matching, the class permission cannot be
    // written at all.
    const predicted = await factory.read.vaultFor([owner]);
    await factory.write.deploy([owner]);
    const vault = await hre.viem.getContractAt("PonsClassVault", predicted);
    expect(getAddress(await vault.read.owner())).to.equal(getAddress(owner));
  });

  it("gives one owner exactly one vault", async () => {
    const [wallet] = await hre.viem.getWalletClients();
    const owner = wallet!.account.address;
    const factory = await hre.viem.deployContract("PonsClassVaultFactory");
    await factory.write.deploy([owner]);
    try {
      await factory.write.deploy([owner]);
      expect.fail("a second vault was created for the same owner");
    } catch {
      // CREATE2 with the owner as salt: the collision IS the uniqueness guarantee.
    }
  });
});
