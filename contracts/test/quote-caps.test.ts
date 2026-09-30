import { expect } from "chai";
import { MAX_CAP, UI_ONE, rawCapFor } from "../scripts/lib/quote-caps";

/**
 * The dollars-to-raw-units translation that gets SEALED.
 *
 * WHY THIS IS TESTED AT ALL, when it is four lines of arithmetic in a deploy
 * script: it is the only number in the class-vault design that is computed once
 * and then trusted forever. PonsClassVaultV2 compares a raw `quoteIn` against a
 * raw ceiling and reads no price and no ERC-8056 multiplier to do it — that is
 * the property that stops a hostile curve choosing its own limit. The cost of
 * that property is that nothing downstream can notice the number is wrong. A
 * misplaced multiplier here does not produce a bad trade; it produces a ceiling
 * that does not mean what the owner was told it means, on a contract whose
 * bytecode is frozen the moment it is deployed.
 *
 * No chain, no hardhat fixture — pure integers.
 */
describe("quote cap derivation", () => {
  const ONE_DOLLAR_8DP = 100_000_000n; // Chainlink answers 8dp

  it("a dollar-priced 6dp quote with no split is the identity: $250 → 250_000_000", () => {
    // USDG. The deploy script short-circuits this case (there is no feed to
    // read), so the general formula agreeing with it is what says the
    // short-circuit is a shortcut rather than a second, divergent rule.
    expect(rawCapFor(250, 6, ONE_DOLLAR_8DP, UI_ONE)).to.equal(250_000_000n);
    expect(rawCapFor(250, 6, ONE_DOLLAR_8DP, UI_ONE)).to.equal(BigInt(Math.round(250 * 10 ** 6)));
  });

  it("$25 of an 18dp share at $180.00 is 25/180 of a share", () => {
    const cap = rawCapFor(25, 18, 180_00000000n, UI_ONE);
    expect(cap).to.equal(138_888_888_888_888_888n);
    // Stated the other way round, so a reader can check it without the formula:
    // cap × price ≈ $25, to within one raw unit of rounding.
    const usdMicro = (cap * 180_00000000n) / (UI_ONE * 100n);
    expect(usdMicro).to.equal(24_999_999n); // $24.999999 — under $25, never over
  });

  it("THE v1 BUG IN ONE LINE: the same $25 is 25e6 in USDG and ~1.4e17 in a share", () => {
    // Nine orders of magnitude between two ceilings that v1 held as ONE number.
    // This is the whole reason the vault was versioned rather than re-tuned.
    const usdg = rawCapFor(25, 6, ONE_DOLLAR_8DP, UI_ONE);
    const nvda = rawCapFor(25, 18, 180_00000000n, UI_ONE);
    expect(usdg).to.equal(25_000_000n);
    expect(nvda / usdg).to.equal(5_555_555_555n);
  });

  it("a bigger share multiplier means FEWER raw units, not more", () => {
    // THE MISTAKE THAT LOOKS RIGHT IN REVIEW. A 10:1 split that leaves raw
    // balances alone doubles-and-then-some what one raw unit is worth, because
    // the feed prices the DISPLAYED share. Inverting this would seal a ceiling a
    // hundred times the allowance and nothing downstream would notice.
    const plain = rawCapFor(25, 18, 180_00000000n, UI_ONE);
    const tenToOne = rawCapFor(25, 18, 180_00000000n, 10n * UI_ONE);
    expect(tenToOne).to.equal(plain / 10n);
    expect(tenToOne < plain).to.equal(true);
  });

  it("a more expensive share buys a smaller cap, linearly", () => {
    const cheap = rawCapFor(100, 18, 50_00000000n, UI_ONE);
    const dear = rawCapFor(100, 18, 200_00000000n, UI_ONE);
    expect(cheap).to.equal(dear * 4n);
  });

  it("rounds DOWN — the only direction that is not merely inconvenient", () => {
    // $1 at $3.00 is 0.333… of a share. Rounding up would seal a ceiling
    // ABOVE the allowance the owner approved.
    const cap = rawCapFor(1, 18, 3_00000000n, UI_ONE);
    expect(cap).to.equal(333_333_333_333_333_333n);
    expect(cap * 3n < UI_ONE).to.equal(true);
  });

  it("scales with the allowance and with the token's own decimals", () => {
    expect(rawCapFor(50, 18, 100_00000000n, UI_ONE)).to.equal(rawCapFor(25, 18, 100_00000000n, UI_ONE) * 2n);
    // The same dollars in a 6dp quote and an 18dp quote differ by exactly 1e12.
    expect(rawCapFor(10, 18, ONE_DOLLAR_8DP, UI_ONE)).to.equal(rawCapFor(10, 6, ONE_DOLLAR_8DP, UI_ONE) * 10n ** 12n);
  });

  it("fractional dollars survive to the sixth decimal", () => {
    expect(rawCapFor(0.5, 6, ONE_DOLLAR_8DP, UI_ONE)).to.equal(500_000n);
    expect(rawCapFor(12.345678, 6, ONE_DOLLAR_8DP, UI_ONE)).to.equal(12_345_678n);
  });

  it("a plausible seed fits the vault's uint96 slot, and an implausible one does not", () => {
    // The guard exists because PonsClassVaultV2 packs cap/spent/windowStart into
    // one word. Refusing by name beats truncating: a truncated cap is a silently
    // different promise.
    expect(rawCapFor(250, 6, ONE_DOLLAR_8DP, UI_ONE) < MAX_CAP).to.equal(true);
    expect(rawCapFor(25, 18, 180_00000000n, UI_ONE) < MAX_CAP).to.equal(true);
    // ~$14bn of a $1 18dp asset is where a uint96 runs out. Nobody seeds that,
    // which is the point — the script refuses rather than wrapping.
    expect(rawCapFor(100_000_000_000, 18, ONE_DOLLAR_8DP, UI_ONE) > MAX_CAP).to.equal(true);
  });

  it("refuses inputs that would silently produce a nonsense ceiling", () => {
    // A reverting or unanswered feed reads as 0 or a negative in more than one
    // client. Either would divide into a ceiling of every share in existence.
    expect(() => rawCapFor(25, 18, 0n, UI_ONE)).to.throw();
    expect(() => rawCapFor(25, 18, -1n, UI_ONE)).to.throw();
    expect(() => rawCapFor(25, 18, 180_00000000n, 0n)).to.throw();
    expect(() => rawCapFor(0, 18, 180_00000000n, UI_ONE)).to.throw();
    expect(() => rawCapFor(-5, 18, 180_00000000n, UI_ONE)).to.throw();
    expect(() => rawCapFor(Number.NaN, 18, 180_00000000n, UI_ONE)).to.throw();
  });
});
