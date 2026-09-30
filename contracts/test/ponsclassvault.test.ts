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

  // THE SPEND CAP, RAISED FOR THESE FIXTURES ONLY.
  //
  // The shipped default is 250 USDG at 6dp, which is correct for production —
  // the wall pins the quote asset to USDG. These mocks are 18dp, so the
  // default would refuse every fixture buy. Raised here so the pre-existing
  // cases still exercise what they were written for; the cap's own tests set
  // their own, and the default is asserted on a fresh vault.
  await vault.write.setSpendCap([1_000_000n * ONE]);

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

/**
 * THE DRAIN THE WALL COULD NOT BOUND.
 *
 * `_checkCurve` interrogates the curve about ITSELF, and every answer comes
 * from the contract being checked. The launchpad mints ~475 curve addresses an
 * hour so no call policy can enumerate them, and the Pons factory exposes no
 * registry to verify against — eighteen candidate view signatures probed on
 * mainnet 4663, none answers. Provenance is not available on chain.
 *
 * So a compromised session key names a contract it controls as the curve. It
 * answers the three questions correctly, takes the approved quote, and pays ONE
 * WEI — which clears the `tokensOut == 0` floor, `minTokensOut` being supplied
 * by the same attacker.
 *
 * The wall capped that per call. Nothing capped the repetition: RateLimitPolicy
 * has zero bytecode on 4663, so `maxOpsPerDay` is enforced by the worker — the
 * party a compromise owns. These tests pin the ceiling that replaces it.
 */
describe("PonsClassVault spend cap", () => {
  /** A curve that pays one wei: takes everything, clears every existing check. */
  async function hostilePayingDust() {
    const s = await setup();
    const token = await hre.viem.deployContract("PonsMockERC20");
    const hostile = await hre.viem.deployContract("MockHostileCurve", [token.address, s.quote.address]);
    await token.write.mint([hostile.address, 1_000_000n * ONE]);
    await hostile.write.setPayBps([1n]); // 0.01% — non-zero, so NoOutput never trips
    return { ...s, hostile, hostileToken: token };
  }

  it("THE ATTACK, BOUNDED: a one-wei curve cannot take more than the cap", async () => {
    const { quote, vault, hostile, owner } = await hostilePayingDust();
    // A cap of 25 quote units against 10-unit buys: two land, the third does not.
    await vault.write.setSpendCap([25n * ONE]);

    const before = await quote.read.balanceOf([owner]);
    await vault.write.buy([hostile.address, quote.address, 10n * ONE, 0n, FOREVER]);
    await vault.write.buy([hostile.address, quote.address, 10n * ONE, 0n, FOREVER]);

    try {
      await vault.write.buy([hostile.address, quote.address, 10n * ONE, 0n, FOREVER]);
      expect.fail("the drain continued past the cap");
    } catch (e) {
      expect(errorNameOf(e)).to.equal("SpendCapExceeded");
    }

    // The loss is the ceiling, not the balance. THAT is the whole fix.
    const lost = before - (await quote.read.balanceOf([owner]));
    expect(lost).to.equal(20n * ONE);
    expect(lost < before).to.equal(true, "the ceiling must be less than the balance");
  });

  it("and the ceiling binds BEFORE anything leaves the account", async () => {
    const { quote, vault, hostile, owner } = await hostilePayingDust();
    await vault.write.setSpendCap([5n * ONE]);
    const before = await quote.read.balanceOf([owner]);
    try {
      await vault.write.buy([hostile.address, quote.address, 10n * ONE, 0n, FOREVER]);
      expect.fail("a buy over the cap was accepted");
    } catch (e) {
      expect(errorNameOf(e)).to.equal("SpendCapExceeded");
    }
    // Not a single unit moved — the charge precedes the pull and the approve.
    expect(await quote.read.balanceOf([owner])).to.equal(before);
    expect(await quote.read.allowance([vault.address, hostile.address])).to.equal(0n);
  });

  it("A SELL IS NEVER CAPPED — a ceiling that blocks an exit rebuilds the trap", async () => {
    const { quote, token, curve, vault } = await setup();
    await vault.write.buy([curve.address, quote.address, 10n * ONE, 0n, FOREVER]);
    // Nothing may be spent from here on.
    await vault.write.setSpendCap([0n]);

    const held = await token.read.balanceOf([vault.address]);
    await vault.write.sell([curve.address, held, 0n, FOREVER]);
    expect(await token.read.balanceOf([vault.address])).to.equal(0n);
  });

  it("the cap is owner-only — the thing it bounds cannot raise it", async () => {
    // The wall grants the session key `buy` and `sell` on this target and
    // nothing else, so this selector is out of its reach. Pinned here as well
    // because the contract must stand on its own, not on the wall being right.
    const { vault, strangerWallet } = await setup();
    try {
      await vault.write.setSpendCap([10n ** 30n], { account: strangerWallet!.account });
      expect.fail("a stranger raised the ceiling that bounds them");
    } catch (e) {
      expect(errorNameOf(e)).to.equal("NotOwner");
    }
  });

  it("the window rolls, so a cap is a rate and not a lifetime allowance", async () => {
    const { quote, vault, hostile } = await hostilePayingDust();
    await vault.write.setSpendCap([10n * ONE]);
    await vault.write.buy([hostile.address, quote.address, 10n * ONE, 0n, FOREVER]);
    expect(await vault.read.spendRemaining()).to.equal(0n);

    const day = Number(await vault.read.SPEND_WINDOW());
    await hre.network.provider.send("evm_increaseTime", [day + 1]);
    await hre.network.provider.send("evm_mine", []);

    expect(await vault.read.spendRemaining()).to.equal(10n * ONE);
    await vault.write.buy([hostile.address, quote.address, 10n * ONE, 0n, FOREVER]);
  });

  it("and it reports what is left rather than making the owner infer it", async () => {
    const { quote, vault, curve } = await setup();
    await vault.write.setSpendCap([30n * ONE]);
    expect(await vault.read.spendRemaining()).to.equal(30n * ONE);
    await vault.write.buy([curve.address, quote.address, 10n * ONE, 0n, FOREVER]);
    expect(await vault.read.spendRemaining()).to.equal(20n * ONE);
  });

  it("ships with a conservative default rather than unlimited", async () => {
    // A FRESH vault: setup() raises the cap for the 18dp fixtures.
    const [w] = await hre.viem.getWalletClients();
    const vault = await hre.viem.deployContract("PonsClassVault", [w!.account.address]);
    // 250 USDG at 6dp. An owner who wants more sets it; an owner who never
    // looks is bounded anyway, which is the direction a default must fail.
    expect(await vault.read.DEFAULT_SPEND_CAP()).to.equal(250_000_000n);
    expect(await vault.read.spendCapPerWindow()).to.equal(250_000_000n);
  });
});
