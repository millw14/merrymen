import { expect } from "chai";
import hre from "hardhat";
import { encodeFunctionData, getAddress, keccak256, encodeAbiParameters, concat } from "viem";

/**
 * PonsClassVaultV2 — one ceiling per quote asset, and an exit that consults none
 * of them.
 *
 * THE BUG THIS VERSION EXISTS FOR, stated as a test rather than a paragraph:
 * `a 6dp quote and an 18dp quote each spend to their own ceiling` (below) cannot
 * pass against v1, because v1 holds ONE number and charges every buy against it.
 * That number is 250_000_000 — 250 USDG at 6dp — and a five-dollar entry quoted
 * in an 18dp share is ~2.8e16 raw. v1 refuses it by eight orders of magnitude,
 * in the one place no off-chain code can correct.
 *
 * The three claims this suite is built around:
 *
 *   1. A CAP IS RAW UNITS OF ONE EXACT ADDRESS. Never scaled, never compared
 *      across assets, and the contract reads no price and no ERC-8056 multiplier
 *      to make them commensurable — proved by completing a round trip against a
 *      quote token whose every oracle view reverts.
 *   2. THE CAP IS THE ALLOWLIST. Zero means refused, and `QuoteNotApproved` is a
 *      different fact from `SpendCapExceeded`: one means re-seal, the other means
 *      wait. A worker that cannot tell them apart retries the unfixable one.
 *   3. SELLING AND SWEEPING CONSULT NEITHER. Un-approve a quote, zero every cap,
 *      and an open position still exits. A membership check on the way out would
 *      rebuild the no-exit trap this contract family exists to remove.
 *
 * Curve mechanics (a live curve pulls its input from its caller by transferFrom
 * and pays a caller-named recipient) were established against mainnet during
 * PonsSelfTrade's design; the mocks mirror them, as v1's suite does.
 */
function errorNameOf(e: unknown): string {
  const walk = (x: unknown): string | undefined => {
    const o = x as { data?: { errorName?: string }; cause?: unknown };
    return o?.data?.errorName ?? (o?.cause ? walk(o.cause) : undefined);
  };
  const decoded = walk(e);
  if (decoded) return decoded;
  const text = String((e as Error)?.message ?? e);
  return (
    /custom error '(\w+)\(/.exec(text)?.[1] ??
    // The mock curve's floor is a plain `require(..., "SlippageExceeded")`,
    // which is a string revert and not a custom error.
    /reverted with reason string '([^']+)'/.exec(text)?.[1] ??
    text
  );
}

/**
 * chai-as-promised is not installed here, and the rest of this suite refuses on
 * purpose rather than pattern-matching a message. `rejects` is that shape as a
 * helper: it fails loudly when the call SUCCEEDS, which is the direction a
 * refusal test gets wrong silently.
 */
async function rejects(fn: () => Promise<unknown>, why: string): Promise<string> {
  try {
    await fn();
  } catch (e) {
    return errorNameOf(e);
  }
  throw new Error(`expected a refusal: ${why}`);
}

/** bigint comparisons, which chai's `greaterThan` will not take. */
const gt = (a: bigint, b: bigint) => expect(a > b, `${a} > ${b}`).to.equal(true);

const FOREVER = 2n ** 48n;
const ONE = 10n ** 18n;
/** 250 USDG at 6dp — v1's whole global ceiling, here as ONE quote's cap. */
const USDG_CAP = 250_000_000n;
const DAY = 86_400;

/**
 * The fixture seals TWO quotes with deliberately incommensurable raw caps: a 6dp
 * quote at v1's exact default, and an 18dp quote at one whole unit. Every cap
 * test below is really a test that these two numbers never meet.
 */
async function setup() {
  const [ownerWallet, strangerWallet] = await hre.viem.getWalletClients();
  const owner = ownerWallet!.account.address;
  const stranger = strangerWallet!.account.address;
  const publicClient = await hre.viem.getPublicClient();

  const quote6 = await hre.viem.deployContract("PonsMockDecimalERC20", [6]);
  const quote18 = await hre.viem.deployContract("PonsMockDecimalERC20", [18]);
  const token = await hre.viem.deployContract("PonsMockERC20");
  const token2 = await hre.viem.deployContract("PonsMockERC20");
  const curve6 = await hre.viem.deployContract("MockPonsCurve", [token.address, quote6.address]);
  const curve18 = await hre.viem.deployContract("MockPonsCurve", [token2.address, quote18.address]);

  const seedQuotes = [quote6.address, quote18.address] as const;
  const seedCaps = [USDG_CAP, ONE] as const;
  const vault = await hre.viem.deployContract("PonsClassVaultV2", [owner, [...seedQuotes], [...seedCaps]]);

  await quote6.write.mint([owner, 1_000_000_000n]);
  await quote18.write.mint([owner, 1_000n * ONE]);
  await token.write.mint([curve6.address, 1_000_000n * ONE]);
  await token2.write.mint([curve18.address, 1_000_000n * ONE]);
  await quote6.write.mint([curve6.address, 1_000_000_000n]);
  await quote18.write.mint([curve18.address, 1_000n * ONE]);

  // The account's ordinary quote approve — the only approve in the whole flow.
  await quote6.write.approve([vault.address, 1_000_000_000n]);
  await quote18.write.approve([vault.address, 1_000n * ONE]);

  return {
    owner, stranger, strangerWallet, publicClient,
    quote6, quote18, token, token2, curve6, curve18, vault, seedQuotes, seedCaps,
  };
}

describe("PonsClassVaultV2 — a cap per quote asset", () => {
  it("THE v1 BUG: a 6dp quote and an 18dp quote each spend to their own ceiling, and neither bounds the other", async () => {
    // Against v1 this is impossible by construction: one number, 250_000_000,
    // charged against a quoteIn of 1e18. The whole version exists for this line.
    const { vault, quote6, quote18, curve6, curve18, owner } = await setup();

    await vault.write.buy([curve6.address, quote6.address, USDG_CAP, 0n, FOREVER]);
    await vault.write.buy([curve18.address, quote18.address, ONE, 0n, FOREVER]);

    expect(await vault.read.spendRemaining([quote6.address])).to.equal(0n);
    expect(await vault.read.spendRemaining([quote18.address])).to.equal(0n);

    // Both are exhausted, each by its own ceiling, and each says so by name.
    for (const [curve, quote, wanted] of [
      [curve6, quote6, 1n],
      [curve18, quote18, 1n],
    ] as const) {
      try {
        await vault.write.buy([curve.address, quote.address, wanted, 0n, FOREVER]);
        expect.fail("a spent window must refuse");
      } catch (e) {
        expect(errorNameOf(e)).to.equal("SpendCapExceeded");
      }
    }
    // And the owner really did spend both, in their own units.
    expect(await quote6.read.balanceOf([owner])).to.equal(1_000_000_000n - USDG_CAP);
    expect(await quote18.read.balanceOf([owner])).to.equal(1_000n * ONE - ONE);
  });

  it("exhausting one quote's window leaves every other quote's untouched", async () => {
    const { vault, quote6, quote18, curve6 } = await setup();
    await vault.write.buy([curve6.address, quote6.address, USDG_CAP, 0n, FOREVER]);
    expect(await vault.read.spendRemaining([quote6.address])).to.equal(0n);
    expect(await vault.read.spendRemaining([quote18.address])).to.equal(ONE);
  });

  it("the charge is keyed on the asset actually pulled", async () => {
    const { vault, quote6, quote18, curve18 } = await setup();
    await vault.write.buy([curve18.address, quote18.address, ONE / 2n, 0n, FOREVER]);
    expect(await vault.read.spendRemaining([quote18.address])).to.equal(ONE / 2n);
    expect(await vault.read.spendRemaining([quote6.address])).to.equal(USDG_CAP);
  });

  it("a quote that was never sealed is refused by a DIFFERENT name than an exhausted one, and moves nothing", async () => {
    // `remaining == 0` answers both questions; only the error tells them apart,
    // and the two remedies are opposite: re-seal versus wait.
    const { vault, owner } = await setup();
    const rogue = await hre.viem.deployContract("PonsMockDecimalERC20", [18]);
    const rogueCurve = await hre.viem.deployContract("MockPonsCurve", [
      (await hre.viem.deployContract("PonsMockERC20")).address,
      rogue.address,
    ]);
    await rogue.write.mint([owner, 100n * ONE]);
    await rogue.write.approve([vault.address, 100n * ONE]);

    try {
      await vault.write.buy([rogueCurve.address, rogue.address, ONE, 0n, FOREVER]);
      expect.fail("an unsealed quote must be refused");
    } catch (e) {
      expect(errorNameOf(e)).to.equal("QuoteNotApproved");
    }
    expect(await rogue.read.balanceOf([owner])).to.equal(100n * ONE);
    expect(await rogue.read.balanceOf([vault.address])).to.equal(0n);
    expect(await vault.read.quoteCap([rogue.address])).to.equal(0n);
  });

  it("the full quoteIn is charged even when the curve pulls less, and the refund does not credit the window back", async () => {
    // A ceiling errs upward. The residue goes home in the same call, but the
    // window was charged for what was handed over, not for what was taken.
    const { vault, quote6, curve6, owner } = await setup();
    await curve6.write.setTakeFraction([50n]);
    await vault.write.buy([curve6.address, quote6.address, 100_000_000n, 0n, FOREVER]);
    expect(await vault.read.spendRemaining([quote6.address])).to.equal(USDG_CAP - 100_000_000n);
    // Half came back to the owner, and none of it stayed here.
    expect(await quote6.read.balanceOf([vault.address])).to.equal(0n);
    expect(await quote6.read.balanceOf([owner])).to.equal(1_000_000_000n - 50_000_000n);
  });

  it("the window rolls per quote, and rolling one does not roll another", async () => {
    const { vault, quote6, quote18, curve6, curve18 } = await setup();
    await vault.write.buy([curve6.address, quote6.address, USDG_CAP, 0n, FOREVER]);
    await vault.write.buy([curve18.address, quote18.address, ONE / 2n, 0n, FOREVER]);

    await hre.network.provider.send("evm_increaseTime", [DAY + 1]);
    await hre.network.provider.send("evm_mine", []);

    expect(await vault.read.spendRemaining([quote6.address])).to.equal(USDG_CAP);
    // quote18's window ALSO rolled — its start was set in the same block. What
    // this proves is the read is per quote, not that the clocks are independent;
    // the independence is proved by the next assertion, after a fresh spend.
    expect(await vault.read.spendRemaining([quote18.address])).to.equal(ONE);

    await vault.write.buy([curve6.address, quote6.address, USDG_CAP, 0n, FOREVER]);
    expect(await vault.read.spendRemaining([quote6.address])).to.equal(0n);
    expect(await vault.read.spendRemaining([quote18.address])).to.equal(ONE);
  });
});

describe("PonsClassVaultV2 — the exit consults nothing", () => {
  it("sells with every cap set to zero, and pays the owner", async () => {
    // THE EXIT GUARANTEE. If a reviewer ever adds a membership check to `sell`,
    // this is the test that fails, and v2 becomes worse than v1.
    const { vault, quote6, token, curve6, owner, seedQuotes } = await setup();
    await vault.write.buy([curve6.address, quote6.address, 100_000_000n, 0n, FOREVER]);
    const held = await token.read.balanceOf([vault.address]);
    gt(held, 0n);

    await vault.write.setQuoteCaps([[...seedQuotes], [0n, 0n]]);

    const before = await quote6.read.balanceOf([owner]);
    await vault.write.sell([curve6.address, held, 0n, FOREVER]);
    gt(await quote6.read.balanceOf([owner]), before);
    expect(await token.read.balanceOf([vault.address])).to.equal(0n);
  });

  it("a sell never credits a window — proceeds are not buying power", async () => {
    // Netting would be a mint: sell junk to a curve you control, get budget.
    const { vault, quote6, token, curve6 } = await setup();
    await vault.write.buy([curve6.address, quote6.address, USDG_CAP, 0n, FOREVER]);
    expect(await vault.read.spendRemaining([quote6.address])).to.equal(0n);
    await vault.write.sell([curve6.address, await token.read.balanceOf([vault.address]), 0n, FOREVER]);
    expect(await vault.read.spendRemaining([quote6.address])).to.equal(0n);
  });

  it("sweep consults neither the cap nor the approved set nor the curve", async () => {
    const { vault, quote6, token, curve6, owner, seedQuotes } = await setup();
    await vault.write.buy([curve6.address, quote6.address, 100_000_000n, 0n, FOREVER]);
    await vault.write.setQuoteCaps([[...seedQuotes], [0n, 0n]]);
    await curve6.write.setGraduated([true]);

    const before = await token.read.balanceOf([owner]);
    await vault.write.sweep([token.address]);
    gt(await token.read.balanceOf([owner]), before);
    expect(await token.read.balanceOf([vault.address])).to.equal(0n);
  });

  it("a full round trip completes against a quote whose uiMultiplier, tokenPaused and feed ALL revert", async () => {
    // NO ORACLE, NO MULTIPLIER, NOTHING THE BRAIN PRODUCED, AT EXECUTION TIME —
    // proved from the bytecode rather than from the source comments.
    const [ownerWallet] = await hre.viem.getWalletClients();
    const owner = ownerWallet!.account.address;
    const quote = await hre.viem.deployContract("PonsMockStockQuoteERC20");
    const token = await hre.viem.deployContract("PonsMockERC20");
    const curve = await hre.viem.deployContract("MockPonsCurve", [token.address, quote.address]);
    const vault = await hre.viem.deployContract("PonsClassVaultV2", [owner, [quote.address], [10n * ONE]]);

    await quote.write.mint([owner, 100n * ONE]);
    await quote.write.mint([curve.address, 100n * ONE]);
    await token.write.mint([curve.address, 1_000_000n * ONE]);
    await quote.write.approve([vault.address, 100n * ONE]);

    // Every oracle view on this token reverts.
    await rejects(() => quote.read.uiMultiplier(), "uiMultiplier must revert");
    await rejects(() => quote.read.tokenPaused(), "tokenPaused must revert");

    await vault.write.buy([curve.address, quote.address, ONE, 0n, FOREVER]);
    const held = await token.read.balanceOf([vault.address]);
    gt(held, 0n);
    await vault.write.sell([curve.address, held, 0n, FOREVER]);
    expect(await token.read.balanceOf([vault.address])).to.equal(0n);
  });

  it("the vault holds no quote asset between calls", async () => {
    const { vault, quote6, quote18, curve6 } = await setup();
    await vault.write.buy([curve6.address, quote6.address, 100_000_000n, 0n, FOREVER]);
    expect(await quote6.read.balanceOf([vault.address])).to.equal(0n);
    expect(await quote18.read.balanceOf([vault.address])).to.equal(0n);
  });
});

describe("PonsClassVaultV2 — the setter", () => {
  it("is owner-only", async () => {
    const { vault, strangerWallet, seedQuotes } = await setup();
    try {
      await vault.write.setQuoteCaps([[...seedQuotes], [10n ** 30n, 10n ** 30n]], {
        account: strangerWallet!.account,
      });
      expect.fail("a stranger must not set caps");
    } catch (e) {
      expect(errorNameOf(e)).to.equal("NotOwner");
    }
  });

  it("does not reset a spent window when the same cap is re-sealed", async () => {
    const { vault, quote6, curve6 } = await setup();
    await vault.write.buy([curve6.address, quote6.address, 200_000_000n, 0n, FOREVER]);
    expect(await vault.read.spendRemaining([quote6.address])).to.equal(50_000_000n);
    await vault.write.setQuoteCaps([[quote6.address], [USDG_CAP]]);
    expect(await vault.read.spendRemaining([quote6.address])).to.equal(50_000_000n);
  });

  it("lowering a cap below what this window already spent leaves remaining at exactly zero, and never panics", async () => {
    // The panic button working. A plain `cap - spent` would revert with an
    // arithmetic panic here, which reads as a broken contract rather than a
    // refusal.
    const { vault, quote6, curve6 } = await setup();
    await vault.write.buy([curve6.address, quote6.address, 200_000_000n, 0n, FOREVER]);
    await vault.write.setQuoteCaps([[quote6.address], [1n]]);
    expect(await vault.read.spendRemaining([quote6.address])).to.equal(0n);
    try {
      await vault.write.buy([curve6.address, quote6.address, 1n, 0n, FOREVER]);
      expect.fail("must refuse");
    } catch (e) {
      expect(errorNameOf(e)).to.equal("SpendCapExceeded");
    }
  });

  it("a cap set to zero refuses the next buy with QuoteNotApproved — removal is instant and total", async () => {
    const { vault, quote6, curve6 } = await setup();
    await vault.write.setQuoteCaps([[quote6.address], [0n]]);
    try {
      await vault.write.buy([curve6.address, quote6.address, 1n, 0n, FOREVER]);
      expect.fail("must refuse");
    } catch (e) {
      expect(errorNameOf(e)).to.equal("QuoteNotApproved");
    }
  });

  it("re-sealing a removed quote does not add a second entry to approvedQuotes", async () => {
    const { vault, quote6, seedQuotes } = await setup();
    await vault.write.setQuoteCaps([[quote6.address], [0n]]);
    await vault.write.setQuoteCaps([[quote6.address], [USDG_CAP]]);
    const [assets, caps] = await vault.read.approvedQuotes();
    expect(assets.length).to.equal(seedQuotes.length);
    expect(caps[0]).to.equal(USDG_CAP);
  });

  it("totalCapPerWindow is the sum an owner is actually risking per day", async () => {
    const { vault } = await setup();
    expect(await vault.read.totalCapPerWindow()).to.equal(USDG_CAP + ONE);
  });
});

describe("PonsClassVaultV2 — validation", () => {
  it("refuses a mismatched seed, an empty seed, a zero seed cap, a zero address and a duplicate", async () => {
    const [ownerWallet] = await hre.viem.getWalletClients();
    const owner = ownerWallet!.account.address;
    const a = (await hre.viem.deployContract("PonsMockERC20")).address;
    const zero = "0x0000000000000000000000000000000000000000" as const;

    const cases: [string, unknown[]][] = [
      ["LengthMismatch", [owner, [a], [1n, 2n]]],
      ["EmptySeed", [owner, [], []]],
      ["ZeroCap", [owner, [a], [0n]]],
      ["ZeroQuote", [owner, [zero], [1n]]],
      ["DuplicateQuote", [owner, [a, a], [1n, 2n]]],
      ["ZeroOwner", [zero, [a], [1n]]],
    ];
    for (const [name, args] of cases) {
      try {
        await hre.viem.deployContract("PonsClassVaultV2", args as never);
        expect.fail(`${name} must be refused at birth`);
      } catch (e) {
        expect(errorNameOf(e), name).to.equal(name);
      }
    }
  });

  it("refuses a cap that does not fit the slot rather than truncating it", async () => {
    // A silently truncated ceiling is a ceiling nobody agreed to.
    const { vault, quote6 } = await setup();
    try {
      await vault.write.setQuoteCaps([[quote6.address], [2n ** 96n]]);
      expect.fail("must refuse");
    } catch (e) {
      expect(errorNameOf(e)).to.equal("CapTooLarge");
    }
    expect(await vault.read.quoteCap([quote6.address])).to.equal(USDG_CAP);
  });

  it("refuses a ninth distinct quote", async () => {
    const { vault } = await setup();
    const extra: `0x${string}`[] = [];
    for (let i = 0; i < 7; i++) extra.push((await hre.viem.deployContract("PonsMockERC20")).address);
    // Two are seeded, so six more fit and the seventh does not.
    await vault.write.setQuoteCaps([extra.slice(0, 6), extra.slice(0, 6).map(() => 1n)]);
    try {
      await vault.write.setQuoteCaps([[extra[6]!], [1n]]);
      expect.fail("must refuse a ninth");
    } catch (e) {
      expect(errorNameOf(e)).to.equal("TooManyQuotes");
    }
  });

  it("emits one QuoteCapSet per seeded entry, so the approved set is reconstructible from logs", async () => {
    const { publicClient, vault } = await setup();
    const logs = await publicClient.getContractEvents({
      address: vault.address,
      abi: vault.abi,
      eventName: "QuoteCapSet",
      fromBlock: 0n,
    });
    expect(logs.length).to.equal(2);
    expect(logs.map((l) => (l.args as { cap: bigint }).cap)).to.deep.equal([USDG_CAP, ONE]);
  });

  it("names the quote asset in ClassBuy and ClassSell, which v1's events did not", async () => {
    // Without this word every off-chain reader takes quoteIn for USDG at 6dp,
    // and an 18dp entry books as ~1e12 times what it cost.
    const { publicClient, vault, quote6, token, curve6 } = await setup();
    await vault.write.buy([curve6.address, quote6.address, 100_000_000n, 0n, FOREVER]);
    await vault.write.sell([curve6.address, await token.read.balanceOf([vault.address]), 0n, FOREVER]);

    const buys = await publicClient.getContractEvents({ address: vault.address, abi: vault.abi, eventName: "ClassBuy", fromBlock: 0n });
    const sells = await publicClient.getContractEvents({ address: vault.address, abi: vault.abi, eventName: "ClassSell", fromBlock: 0n });
    expect(getAddress((buys[0]!.args as { quoteAsset: string }).quoteAsset)).to.equal(getAddress(quote6.address));
    expect(getAddress((sells[0]!.args as { quoteAsset: string }).quoteAsset)).to.equal(getAddress(quote6.address));
  });
});

describe("PonsClassVaultV2 — hostile counterparties", () => {
  it("a hostile curve cannot re-enter at all — it is not the owner, which is refused before the flag is reached", async () => {
    // STRONGER THAN THE REENTRANCY FLAG, and worth stating as its own fact: the
    // vault answers exactly one caller. A curve calling back gets NotOwner, so
    // the `inTrade` guard is never even consulted on this path.
    const [ownerWallet] = await hre.viem.getWalletClients();
    const owner = ownerWallet!.account.address;
    const quote = await hre.viem.deployContract("PonsMockDecimalERC20", [18]);
    const token = await hre.viem.deployContract("PonsMockERC20");
    const curve = await hre.viem.deployContract("MockReentrantClassCurve", [token.address, quote.address]);
    const vault = await hre.viem.deployContract("PonsClassVaultV2", [owner, [quote.address], [100n * ONE]]);
    await curve.write.setVault([vault.address]);
    await quote.write.mint([owner, 100n * ONE]);
    await quote.write.approve([vault.address, 100n * ONE]);

    expect(await rejects(() => vault.write.buy([curve.address, quote.address, ONE, 0n, FOREVER]), "a re-entrant curve")).to.equal("NotOwner");
    // The whole call reverted, so nothing was charged and nothing moved.
    expect(await vault.read.spendRemaining([quote.address])).to.equal(100n * ONE);
    expect(await quote.read.balanceOf([owner])).to.equal(100n * ONE);
  });

  it("a hostile quote TOKEN that calls back from inside transferFrom takes the pull down with it", async () => {
    // The hostile-ISSUER case: a Stock Token is a BeaconProxy whose issuer can
    // upgrade every one of them at once. Its re-entry is refused for the same
    // reason (it is not the owner) and the refusal surfaces as TransferFailed,
    // because the failing call is the pull — `_pull` checks `ok` rather than
    // trusting the token, which is why this is a revert and not a silent zero.
    const [ownerWallet] = await hre.viem.getWalletClients();
    const owner = ownerWallet!.account.address;
    const quote = await hre.viem.deployContract("PonsMockReentrantQuoteERC20");
    const token = await hre.viem.deployContract("PonsMockERC20");
    const curve = await hre.viem.deployContract("MockPonsCurve", [token.address, quote.address]);
    const vault = await hre.viem.deployContract("PonsClassVaultV2", [owner, [quote.address], [100n * ONE]]);
    await quote.write.mint([owner, 100n * ONE]);
    await quote.write.approve([vault.address, 100n * ONE]);
    await token.write.mint([curve.address, 1_000_000n * ONE]);
    await quote.write.arm([vault.address, curve.address]);

    expect(await rejects(() => vault.write.buy([curve.address, quote.address, ONE, 0n, FOREVER]), "a re-entrant quote token")).to.equal("TransferFailed");
    expect(await quote.read.balanceOf([owner])).to.equal(100n * ONE);
  });

  it("and the re-entrancy flag catches the one caller that CAN get back in: the owner itself", async () => {
    // A curve that asks the ACCOUNT to call `buy` again from inside the first
    // buy. That arrives as msg.sender == owner and passes the caller check, so
    // `inTrade` is the only thing standing — which is what it is for.
    const runner = await hre.viem.deployContract("MockKernelBatch");
    const quote = await hre.viem.deployContract("PonsMockDecimalERC20", [18]);
    const token = await hre.viem.deployContract("PonsMockERC20");
    const curve = await hre.viem.deployContract("MockOwnerReentrantCurve", [token.address, quote.address]);
    const vault = await hre.viem.deployContract("PonsClassVaultV2", [runner.address, [quote.address], [100n * ONE]]);
    await curve.write.arm([runner.address, vault.address]);
    await quote.write.mint([runner.address, 100n * ONE]);
    await token.write.mint([curve.address, 1_000_000n * ONE]);

    const approve = encodeFunctionData({
      abi: [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }] as const,
      functionName: "approve",
      args: [vault.address, 100n * ONE],
    });
    const buy = encodeFunctionData({
      abi: [{ type: "function", name: "buy", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], outputs: [{ type: "uint256" }] }] as const,
      functionName: "buy",
      args: [curve.address, quote.address, ONE, 0n, FOREVER],
    });

    expect(
      await rejects(
        () => runner.write.execute([[
          { target: quote.address, value: 0n, data: approve },
          { target: vault.address, value: 0n, data: buy },
        ]]),
        "an owner-routed re-entry",
      ),
    ).to.equal("Reentrant");
    expect(await vault.read.spendRemaining([quote.address])).to.equal(100n * ONE);
  });

  it("a refused buy leaves no trace: no charge, no balance change, no standing allowance to the curve", async () => {
    const { vault, quote6, curve6, owner } = await setup();
    // A floor the curve cannot meet.
    try {
      await vault.write.buy([curve6.address, quote6.address, 1_000_000n, 10n ** 30n, FOREVER]);
      expect.fail("must refuse");
    } catch (e) {
      expect(errorNameOf(e)).to.equal("SlippageExceeded");
    }
    expect(await vault.read.spendRemaining([quote6.address])).to.equal(USDG_CAP);
    expect(await quote6.read.balanceOf([owner])).to.equal(1_000_000_000n);
    expect(await quote6.read.allowance([vault.address, curve6.address])).to.equal(0n);
  });

  it("a curve that pays nothing is caught by the balance delta, not by its own claim", async () => {
    const { vault, quote6, owner } = await setup();
    const token = await hre.viem.deployContract("PonsMockERC20");
    const hostile = await hre.viem.deployContract("MockHostileCurve", [token.address, quote6.address]);
    try {
      await vault.write.buy([hostile.address, quote6.address, 1_000_000n, 0n, FOREVER]);
      expect.fail("must refuse");
    } catch (e) {
      expect(errorNameOf(e)).to.equal("NoOutput");
    }
    expect(await quote6.read.balanceOf([owner])).to.equal(1_000_000_000n);
  });

  it("still refuses a native-quoted curve and a graduated one, by name", async () => {
    const { vault, quote6, curve6, token } = await setup();
    const native = await hre.viem.deployContract("MockPonsCurve", [
      token.address,
      "0x0000000000000000000000000000000000000000",
    ]);
    try {
      await vault.write.buy([native.address, quote6.address, 1n, 0n, FOREVER]);
      expect.fail("native must be refused");
    } catch (e) {
      expect(errorNameOf(e)).to.equal("NativeQuoteNotSupported");
    }
    await curve6.write.setGraduated([true]);
    try {
      await vault.write.buy([curve6.address, quote6.address, 1n, 0n, FOREVER]);
      expect.fail("graduated must be refused");
    } catch (e) {
      expect(errorNameOf(e)).to.equal("CurveGraduated");
    }
  });

  it("belongs to one account: a stranger cannot buy, sell or sweep", async () => {
    const { vault, quote6, curve6, token, strangerWallet } = await setup();
    for (const call of [
      () => vault.write.buy([curve6.address, quote6.address, 1n, 0n, FOREVER], { account: strangerWallet!.account }),
      () => vault.write.sell([curve6.address, 1n, 0n, FOREVER], { account: strangerWallet!.account }),
      () => vault.write.sweep([token.address], { account: strangerWallet!.account }),
    ]) {
      try {
        await call();
        expect.fail("a stranger must not reach this vault");
      } catch (e) {
        expect(errorNameOf(e)).to.equal("NotOwner");
      }
    }
  });
});

describe("PonsClassVaultFactoryV2 — an address that does not move", () => {
  async function factorySetup() {
    const [ownerWallet] = await hre.viem.getWalletClients();
    const owner = ownerWallet!.account.address;
    const quote = await hre.viem.deployContract("PonsMockDecimalERC20", [6]);
    const quote2 = await hre.viem.deployContract("PonsMockDecimalERC20", [18]);
    const factory = await hre.viem.deployContract("PonsClassVaultFactoryV2", [
      [quote.address, quote2.address],
      [USDG_CAP, ONE],
    ]);
    return { owner, quote, quote2, factory };
  }

  it("predicts the address it actually produces, for several owners", async () => {
    // Compared directly, not by reading `owner()` off the prediction — that
    // check passes even when the two disagree.
    const { factory } = await factorySetup();
    const wallets = await hre.viem.getWalletClients();
    for (const w of wallets.slice(0, 3)) {
      const who = w.account.address;
      const predicted = await factory.read.vaultFor([who]);
      const hash = await factory.write.deploy([who]);
      const publicClient = await hre.viem.getPublicClient();
      await publicClient.waitForTransactionReceipt({ hash });
      const code = await publicClient.getCode({ address: predicted });
      expect(code, `no code at the predicted address for ${who}`).to.not.equal(undefined);
      const vault = await hre.viem.getContractAt("PonsClassVaultV2", predicted);
      expect(getAddress(await vault.read.owner())).to.equal(getAddress(who));
    }
  });

  it("THE POINT OF v2's ADDRESS MODEL: the prediction is unchanged after any number of cap edits", async () => {
    const { owner, quote, factory } = await factorySetup();
    const before = await factory.read.vaultFor([owner]);
    await factory.write.deploy([owner]);
    const vault = await hre.viem.getContractAt("PonsClassVaultV2", before);
    await vault.write.setQuoteCaps([[quote.address], [1n]]);
    await vault.write.setQuoteCaps([[quote.address], [USDG_CAP * 2n]]);
    expect(await factory.read.vaultFor([owner])).to.equal(before);
  });

  it("a v2 vault is somewhere else entirely from that owner's v1 vault", async () => {
    const { owner, factory } = await factorySetup();
    const v1 = await hre.viem.deployContract("PonsClassVaultFactory");
    expect(await factory.read.vaultFor([owner])).to.not.equal(await v1.read.vaultFor([owner]));
  });

  it("one owner, one vault: a second deploy reverts", async () => {
    const { owner, factory } = await factorySetup();
    await factory.write.deploy([owner]);
    await rejects(() => factory.write.deploy([owner]), "a second deploy for the same owner");
  });

  it("deployment stays permissionless, and a stranger's deploy still produces the OWNER's vault with this factory's seed", async () => {
    const { owner, quote, quote2, factory } = await factorySetup();
    const [, strangerWallet] = await hre.viem.getWalletClients();
    await factory.write.deploy([owner], { account: strangerWallet!.account });
    const vault = await hre.viem.getContractAt("PonsClassVaultV2", await factory.read.vaultFor([owner]));
    expect(getAddress(await vault.read.owner())).to.equal(getAddress(owner));
    expect(await vault.read.quoteCap([quote.address])).to.equal(USDG_CAP);
    expect(await vault.read.quoteCap([quote2.address])).to.equal(ONE);
  });

  it("refuses to deploy for the zero address", async () => {
    const { factory } = await factorySetup();
    expect(await rejects(() => factory.write.deploy(["0x0000000000000000000000000000000000000000"]), "deploy(0)")).to.equal("ZeroOwner");
  });

  it("cannot itself be constructed with an empty, mismatched or zero-valued seed", async () => {
    const a = (await hre.viem.deployContract("PonsMockERC20")).address;
    for (const args of [
      [[], []],
      [[a], [1n, 2n]],
      [[a], [0n]],
      [["0x0000000000000000000000000000000000000000"], [1n]],
    ]) {
      await rejects(() => hre.viem.deployContract("PonsClassVaultFactoryV2", args as never), `seed ${JSON.stringify(args, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
    }
  });

  it("a vault it makes carries exactly the seed, and zero for every address outside it", async () => {
    const { owner, quote, quote2, factory } = await factorySetup();
    await factory.write.deploy([owner]);
    const vault = await hre.viem.getContractAt("PonsClassVaultV2", await factory.read.vaultFor([owner]));
    expect(await vault.read.quoteCap([quote.address])).to.equal(USDG_CAP);
    expect(await vault.read.quoteCap([quote2.address])).to.equal(ONE);
    expect(await vault.read.quoteCap([(await hre.viem.deployContract("PonsMockERC20")).address])).to.equal(0n);
    expect(await vault.read.totalCapPerWindow()).to.equal(USDG_CAP + ONE);
  });

  it("the init code hash it will CREATE2 with matches the locally compiled artifact", async () => {
    // The only check that catches a factory built from a different commit.
    // FACTORY_VERSION is a number any contract could return; this is bytecode.
    const { owner, quote, quote2, factory } = await factorySetup();
    const artifact = await hre.artifacts.readArtifact("PonsClassVaultV2");
    const expected = keccak256(
      concat([
        artifact.bytecode as `0x${string}`,
        encodeAbiParameters(
          [{ type: "address" }, { type: "address[]" }, { type: "uint256[]" }],
          [owner, [quote.address, quote2.address], [USDG_CAP, ONE]],
        ),
      ]),
    );
    expect(await factory.read.vaultInitCodeHash([owner])).to.equal(expected);
  });

  it("says which version it is, and v1 cannot answer that question at all", async () => {
    const { factory } = await factorySetup();
    expect(await factory.read.FACTORY_VERSION()).to.equal(2);
    const v1 = await hre.artifacts.readArtifact("PonsClassVaultFactory");
    const names = v1.abi.map((e) => (e as { name?: string }).name);
    expect(names).to.not.include("FACTORY_VERSION");
    expect(names).to.not.include("seedQuoteSet");
  });

  it("publishes the seed the signer must pin the wall's quote set from", async () => {
    const { quote, quote2, factory } = await factorySetup();
    const [assets, caps] = await factory.read.seedQuoteSet();
    expect(assets.map((a) => getAddress(a))).to.deep.equal([getAddress(quote.address), getAddress(quote2.address)]);
    expect(caps).to.deep.equal([USDG_CAP, ONE]);
  });
});

describe("PonsClassVaultV2 — deploy and buy in ONE batch", () => {
  /**
   * The batch the worker actually sends for a first class trade is
   * `[factory.deploy, quote.approve, vault.buy]` in one UserOperation, and a
   * Kernel v3.3 BATCH/DEFAULT op reverts whole — measured on chain 4663 at
   * block 64670932 by scripts/probe-kernel-batch-atomicity.mts. These two tests
   * are the half of that claim which can be checked in hardhat: that the batch
   * succeeds for a seeded quote, and that a refusal takes the deploy with it.
   */
  async function batchSetup() {
    const runner = await hre.viem.deployContract("MockKernelBatch");
    const quote = await hre.viem.deployContract("PonsMockDecimalERC20", [6]);
    const token = await hre.viem.deployContract("PonsMockERC20");
    const curve = await hre.viem.deployContract("MockPonsCurve", [token.address, quote.address]);
    const factory = await hre.viem.deployContract("PonsClassVaultFactoryV2", [[quote.address], [USDG_CAP]]);
    // The runner IS the smart account for this test: it owns the vault and
    // holds the cash.
    const vaultAddr = await factory.read.vaultFor([runner.address]);
    await quote.write.mint([runner.address, 1_000_000_000n]);
    await quote.write.mint([curve.address, 1_000_000_000n]);
    await token.write.mint([curve.address, 1_000_000n * ONE]);
    const publicClient = await hre.viem.getPublicClient();
    return { runner, quote, token, curve, factory, vaultAddr, publicClient };
  }

  const FACTORY_ABI = [
    { type: "function", name: "deploy", stateMutability: "nonpayable", inputs: [{ type: "address" }], outputs: [{ type: "address" }] },
  ] as const;
  const ERC20_ABI = [
    { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  ] as const;
  const VAULT_ABI = [
    {
      type: "function",
      name: "buy",
      stateMutability: "nonpayable",
      inputs: [{ type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
      outputs: [{ type: "uint256" }],
    },
  ] as const;

  it("a vault that did not exist is deployed and buys in the same transaction", async () => {
    const { runner, quote, token, curve, factory, vaultAddr, publicClient } = await batchSetup();
    expect(await publicClient.getCode({ address: vaultAddr })).to.equal(undefined);

    await runner.write.execute([
      [
        { target: factory.address, value: 0n, data: encodeFunctionData({ abi: FACTORY_ABI, functionName: "deploy", args: [runner.address] }) },
        { target: quote.address, value: 0n, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [vaultAddr, 100_000_000n] }) },
        { target: vaultAddr, value: 0n, data: encodeFunctionData({ abi: VAULT_ABI, functionName: "buy", args: [curve.address, quote.address, 100_000_000n, 0n, FOREVER] }) },
      ],
    ]);

    expect(await publicClient.getCode({ address: vaultAddr })).to.not.equal(undefined);
    gt(await token.read.balanceOf([vaultAddr]), 0n);
  });

  it("the same batch with an UNSEEDED quote reverts whole, and the vault does not exist afterwards", async () => {
    const { runner, quote, factory, vaultAddr, publicClient } = await batchSetup();
    const rogue = await hre.viem.deployContract("PonsMockDecimalERC20", [18]);
    const rogueToken = await hre.viem.deployContract("PonsMockERC20");
    const rogueCurve = await hre.viem.deployContract("MockPonsCurve", [rogueToken.address, rogue.address]);
    await rogue.write.mint([runner.address, 100n * ONE]);
    void quote;

    await rejects(
      () => runner.write.execute([
        [
          { target: factory.address, value: 0n, data: encodeFunctionData({ abi: FACTORY_ABI, functionName: "deploy", args: [runner.address] }) },
          { target: rogue.address, value: 0n, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [vaultAddr, ONE] }) },
          { target: vaultAddr, value: 0n, data: encodeFunctionData({ abi: VAULT_ABI, functionName: "buy", args: [rogueCurve.address, rogue.address, ONE, 0n, FOREVER] }) },
        ],
      ]),
      "an unseeded quote in a deploy-then-buy batch",
    );

    // ALL OR NOTHING: the deploy did not survive the refused buy.
    expect(await publicClient.getCode({ address: vaultAddr })).to.equal(undefined);
  });
});
