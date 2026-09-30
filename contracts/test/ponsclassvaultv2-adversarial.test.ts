import { expect } from "chai";
import hre from "hardhat";

/**
 * THE THREE DEFECTS AN ADVERSARIAL PASS FOUND BEFORE THIS CONTRACT WAS DEPLOYED.
 *
 * Every one of them was reproduced by execution rather than argued from the
 * source, and every one of them passed the 42-test suite beside this file. That
 * is the useful part: the original tests did not merely miss these, they
 * ENCODED the gaps. The slot-exhaustion test filled its slots with non-zero
 * caps. The factory-validation test enumerated exactly the four rules the
 * factory already had. The sweep test asserted that the balance moved and never
 * looked at the amount the event reported.
 *
 * This file exists as a separate suite so that stays legible: these are not
 * more coverage of the same claims, they are the claims that were wrong.
 */

const ONE = 10n ** 18n;
const FOREVER = 2n ** 48n;
const USDG_CAP = 250_000_000n;

/** The suite beside this one has no chai-as-promised either. Same helper, same reason. */
function errorNameOf(e: unknown): string {
  const s = e instanceof Error ? e.message : String(e);
  const custom = /reverted with custom error '([A-Za-z0-9_]+)\(/.exec(s);
  if (custom) return custom[1]!;
  const reason = /reverted with reason string '([^']*)'/.exec(s);
  if (reason) return `reason:${reason[1]}`;
  return s.slice(0, 200);
}

async function rejects(fn: () => Promise<unknown>, why: string): Promise<string> {
  try {
    await fn();
  } catch (e) {
    return errorNameOf(e);
  }
  throw new Error(`expected ${why} to be refused, and it was not`);
}

describe("DEFECT 1 — a zero cap must not buy a permanent slot", () => {
  /**
   * `_seal` pushed the quote into `quotes` BEFORE it looked at the cap, so
   * sealing zero on an address the vault had never seen consumed one of the
   * eight slots for ever. The array is append-only by design, so nothing could
   * free it again, and the vault could then never approve a real quote.
   *
   * The path is the one the contract's own docstring prescribes: the setter
   * takes a SET, so the natural owner screen sends the whole quote universe with
   * the disabled ones at zero.
   */
  async function vaultWithOneQuote() {
    const [w] = await hre.viem.getWalletClients();
    const owner = w!.account.address;
    const quote = await hre.viem.deployContract("PonsMockDecimalERC20", [6]);
    const vault = await hre.viem.deployContract("PonsClassVaultV2", [owner, [quote.address], [USDG_CAP]]);
    return { owner, quote, vault };
  }

  it("sealing zero on seven addresses the vault never knew leaves all seven slots free", async () => {
    const { vault } = await vaultWithOneQuote();
    const junk: `0x${string}`[] = [];
    for (let i = 0; i < 7; i++) junk.push((await hre.viem.deployContract("PonsMockERC20")).address);

    await vault.write.setQuoteCaps([junk, junk.map(() => 0n)]);

    const [assets] = await vault.read.approvedQuotes();
    expect(assets.length).to.equal(1, "a quote that was never approved is not an approved quote");

    // The proof that matters: seven real quotes still fit afterwards.
    const real: `0x${string}`[] = [];
    for (let i = 0; i < 7; i++) real.push((await hre.viem.deployContract("PonsMockERC20")).address);
    await vault.write.setQuoteCaps([real, real.map(() => ONE)]);
    const [after] = await vault.read.approvedQuotes();
    expect(after.length).to.equal(8);
  });

  it("and the zeroed address is still refused by name, so the no-op is not a silent approval", async () => {
    const { vault } = await vaultWithOneQuote();
    const junk = (await hre.viem.deployContract("PonsMockERC20")).address;
    await vault.write.setQuoteCaps([[junk], [0n]]);
    expect(await vault.read.quoteCap([junk])).to.equal(0n);
    expect(await vault.read.spendRemaining([junk])).to.equal(0n);
    const [assets] = await vault.read.approvedQuotes();
    expect(assets.map((a) => a.toLowerCase())).to.not.include(junk.toLowerCase());
  });

  it("MAX_QUOTES bounds assets that HELD a ceiling, which is what it is documented to bound", async () => {
    // Before the fix, TooManyQuotes could fire while the owner's total exposure
    // was one quote's cap — so the bound did not mean what its docstring said.
    const { vault } = await vaultWithOneQuote();
    const junk: `0x${string}`[] = [];
    for (let i = 0; i < 7; i++) junk.push((await hre.viem.deployContract("PonsMockERC20")).address);
    await vault.write.setQuoteCaps([junk, junk.map(() => 0n)]);
    expect(await vault.read.totalCapPerWindow()).to.equal(USDG_CAP);
    const [assets] = await vault.read.approvedQuotes();
    expect(assets.length).to.equal(1, "the array length must track the exposure the bound describes");
  });

  it("REGRESSION: zeroing a quote the vault DOES know still leaves it listed, as documented", async () => {
    // The documented behaviour that the fix must not break. A removed quote
    // keeps its slot and its window on purpose, so re-approving it cannot reset
    // what it already spent today.
    const { vault, quote } = await vaultWithOneQuote();
    await vault.write.setQuoteCaps([[quote.address], [0n]]);
    const [assets, caps] = await vault.read.approvedQuotes();
    expect(assets.length).to.equal(1, "a removed quote stays in the array");
    expect(caps[0]).to.equal(0n);
  });

  it("REGRESSION: a fresh quote with a real cap is still added", async () => {
    const { vault } = await vaultWithOneQuote();
    const q = (await hre.viem.deployContract("PonsMockERC20")).address;
    await vault.write.setQuoteCaps([[q], [ONE]]);
    expect(await vault.read.quoteCap([q])).to.equal(ONE);
    const [assets] = await vault.read.approvedQuotes();
    expect(assets.length).to.equal(2);
  });
});

describe("DEFECT 2 — a factory must refuse every seed its vaults would refuse", () => {
  /**
   * The factory validated four rules; the vault validates seven. A seed tripping
   * one of the missing three produced a factory that CONSTRUCTED CLEANLY and
   * then reverted inside `deploy` for every owner, for ever — no setter, no
   * admin, bytecode frozen.
   *
   * Nothing downstream caught it, which is the point. FACTORY_VERSION answered
   * 2. vaultFor answered a well-formed non-zero address. vaultInitCodeHash
   * matched the compiled artifact exactly, because the bytecode was right and
   * only the constructor arguments were poisoned. The deploy script's three
   * gates all passed and it never called deploy.
   */
  it("refuses a duplicate seed — the case one typo in the seed env var reaches", async () => {
    const a = (await hre.viem.deployContract("PonsMockERC20")).address;
    expect(
      await rejects(
        () => hre.viem.deployContract("PonsClassVaultFactoryV2", [[a, a], [1n, 2n]] as never),
        "a duplicated seed quote",
      ),
    ).to.equal("DuplicateSeedQuote");
  });

  it("refuses a ninth seed quote, which the vault would refuse and the factory did not", async () => {
    const nine: `0x${string}`[] = [];
    for (let i = 0; i < 9; i++) nine.push((await hre.viem.deployContract("PonsMockERC20")).address);
    expect(
      await rejects(
        () => hre.viem.deployContract("PonsClassVaultFactoryV2", [nine, nine.map(() => 1n)] as never),
        "nine seed quotes",
      ),
    ).to.equal("TooManySeedQuotes");
  });

  it("refuses a seed cap too large for the vault's slot", async () => {
    const a = (await hre.viem.deployContract("PonsMockERC20")).address;
    expect(
      await rejects(
        () => hre.viem.deployContract("PonsClassVaultFactoryV2", [[a], [2n ** 96n]] as never),
        "a seed cap past uint96",
      ),
    ).to.equal("SeedCapTooLarge");
  });

  it("THE INVARIANT: every seed the vault refuses, the factory refuses first", async () => {
    // Stated as one test rather than three, because the property is the
    // relationship and not any individual rule. A rule added to the vault later
    // and not to the factory reappears here as a factory that constructs and
    // cannot deploy.
    const [w] = await hre.viem.getWalletClients();
    const owner = w!.account.address;
    const a = (await hre.viem.deployContract("PonsMockERC20")).address;
    const b = (await hre.viem.deployContract("PonsMockERC20")).address;
    const nine: `0x${string}`[] = [];
    for (let i = 0; i < 9; i++) nine.push((await hre.viem.deployContract("PonsMockERC20")).address);
    const zero = "0x0000000000000000000000000000000000000000" as const;

    const seeds: [`0x${string}`[], bigint[]][] = [
      [[a, a], [1n, 2n]],
      [nine, nine.map(() => 1n)],
      [[a], [2n ** 96n]],
      [[zero], [1n]],
      [[a], [0n]],
      [[a, b], [1n]],
      [[], []],
    ];

    for (const [quotes, caps] of seeds) {
      const label = `seed of ${quotes.length} quote(s)`;
      // The vault refuses it…
      const vaultErr = await rejects(
        () => hre.viem.deployContract("PonsClassVaultV2", [owner, quotes, caps] as never),
        `${label} at the vault`,
      );
      // …so the factory must refuse it too, rather than minting vaults that
      // cannot be constructed.
      const factoryErr = await rejects(
        () => hre.viem.deployContract("PonsClassVaultFactoryV2", [quotes, caps] as never),
        `${label} at the factory`,
      );
      expect(vaultErr, label).to.not.equal("");
      expect(factoryErr, label).to.not.equal("");
    }
  });

  it("REGRESSION: a good seed still constructs, and its vault still deploys", async () => {
    const [w] = await hre.viem.getWalletClients();
    const owner = w!.account.address;
    const q1 = (await hre.viem.deployContract("PonsMockDecimalERC20", [6])).address;
    const q2 = (await hre.viem.deployContract("PonsMockDecimalERC20", [18])).address;
    const factory = await hre.viem.deployContract("PonsClassVaultFactoryV2", [[q1, q2], [USDG_CAP, ONE]]);
    const predicted = await factory.read.vaultFor([owner]);
    await factory.write.deploy([owner]);
    const publicClient = await hre.viem.getPublicClient();
    const code = await publicClient.getCode({ address: predicted });
    expect(code && code !== "0x", "deploy must produce the address vaultFor predicted").to.equal(true);
  });
});

describe("DEFECT 3 — a sweep reports what ARRIVED, not what was asked for", () => {
  /**
   * `sweep` emitted the balance it read BEFORE the transfer, and `_push` proves
   * only that the call did not revert and did not return false. A token that
   * returns true and moves nothing — an ordinary soft honeypot, and exactly the
   * kind of asset this vault exists to hold — produced a full-size withdrawal
   * event for tokens that never left. The off-chain fold sums those, so five
   * partial sweeps of a 500-unit position booked 1,500 as withdrawn and the
   * owner was told they took home three times what they put in.
   *
   * Every other value in this contract is a measured delta. This was the one
   * that was not.
   */
  async function vaultHolding(clampTo: bigint, held: bigint) {
    const [w] = await hre.viem.getWalletClients();
    const owner = w!.account.address;
    const quote = await hre.viem.deployContract("PonsMockDecimalERC20", [6]);
    const junk = await hre.viem.deployContract("PonsMockClampingERC20", [clampTo]);
    const vault = await hre.viem.deployContract("PonsClassVaultV2", [owner, [quote.address], [USDG_CAP]]);
    await junk.write.mint([vault.address, held]);
    return { owner, vault, junk };
  }

  it("a token that moves nothing is refused by name instead of succeeding for ever", async () => {
    const { vault, junk } = await vaultHolding(0n, 500n);
    expect(
      await rejects(() => vault.write.sweep([junk.address]), "a sweep that moves nothing"),
    ).to.equal("TransferFailed");
  });

  it("a clamping token reports what ARRIVED, and the sum of sweeps cannot exceed what was held", async () => {
    const { owner, vault, junk } = await vaultHolding(100n, 500n);
    const publicClient = await hre.viem.getPublicClient();

    let total = 0n;
    for (let i = 0; i < 5; i++) {
      await vault.write.sweep([junk.address]);
    }
    const logs = await publicClient.getContractEvents({
      address: vault.address,
      abi: vault.abi,
      eventName: "Swept",
      fromBlock: 0n,
    });
    for (const l of logs) total += (l.args as { amount: bigint }).amount;

    expect(await junk.read.balanceOf([owner])).to.equal(500n, "everything did leave, 100 at a time");
    expect(total).to.equal(
      500n,
      "the sweeps must sum to what was held — over-reporting is how a book withdraws capital still in the vault",
    );
    expect(await junk.read.balanceOf([vault.address])).to.equal(0n);
  });

  it("and a sixth sweep of the now-empty vault is ZeroAmount, a different fact from TransferFailed", async () => {
    // Two refusals that a caller must be able to tell apart: "there was nothing
    // to sweep" and "there was something and it did not arrive". One is done,
    // the other will never work.
    const { vault, junk } = await vaultHolding(100n, 100n);
    await vault.write.sweep([junk.address]);
    expect(await rejects(() => vault.write.sweep([junk.address]), "a sweep of an empty vault")).to.equal(
      "ZeroAmount",
    );
  });

  it("REGRESSION: an honest token still sweeps in one call and reports the full amount", async () => {
    const [w] = await hre.viem.getWalletClients();
    const owner = w!.account.address;
    const quote = await hre.viem.deployContract("PonsMockDecimalERC20", [6]);
    const token = await hre.viem.deployContract("PonsMockERC20");
    const vault = await hre.viem.deployContract("PonsClassVaultV2", [owner, [quote.address], [USDG_CAP]]);
    await token.write.mint([vault.address, 7n * ONE]);
    await vault.write.sweep([token.address]);
    expect(await token.read.balanceOf([owner])).to.equal(7n * ONE);
    expect(await token.read.balanceOf([vault.address])).to.equal(0n);
  });

  it("REGRESSION: the exit still consults neither the cap nor the approved set", async () => {
    // The property the whole contract family exists for. A sweep must work with
    // every cap zeroed and every quote un-approved, and the measurement change
    // must not have introduced a consultation.
    const [w] = await hre.viem.getWalletClients();
    const owner = w!.account.address;
    const quote = await hre.viem.deployContract("PonsMockDecimalERC20", [6]);
    const token = await hre.viem.deployContract("PonsMockERC20");
    const vault = await hre.viem.deployContract("PonsClassVaultV2", [owner, [quote.address], [USDG_CAP]]);
    await token.write.mint([vault.address, 3n * ONE]);
    await vault.write.setQuoteCaps([[quote.address], [0n]]);
    await vault.write.sweep([token.address]);
    expect(await token.read.balanceOf([owner])).to.equal(3n * ONE);
  });
});
