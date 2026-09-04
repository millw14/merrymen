import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyUsdgMovement, totalCapital, type TransferLeg } from "./capital-classify";

/**
 * THE CANARY IS THE REFERENCE FIXTURE, and it is the case a naive rule gets
 * wrong: one inbound 10.000000 USDG transfer and four outbound 1.666500 USDG
 * transfers. Inbound-is-a-deposit / outbound-is-a-withdrawal reports 10 in and
 * 6.666 out — a 6.666 USDG withdrawal that is really four TSLA purchases, and a
 * contributed-capital figure of 3.334 instead of 10.
 */

const ACCOUNT = "0x3E34E58e39DC6614e047dFD3BAD5B7DEA45DCd62";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const TSLA = "0x322F0929c4625eD5bAd873c95208D54E1c003b2d";
const ROUTER = "0xf4acdaeeb7022862a763c9b1b885e11191c889e3";
const OWNER_WALLET = "0xac563ac23bac8d803992502088ebf46ab892f95c";

const leg = (token: string, from: string, to: string, amountRaw: string): TransferLeg => ({
  token,
  from,
  to,
  amountRaw,
});

describe("C1 — the canary's five transfers", () => {
  it("the funding transfer is CAPITAL", () => {
    const usdg = leg(USDG, OWNER_WALLET, ACCOUNT, "10000000");
    const c = classifyUsdgMovement({ account: ACCOUNT, usdg, txLegs: [usdg], usdgToken: USDG });
    assert.equal(c.kind, "capital-in");
    assert.match(c.why, /external capital/);
  });

  it("a router outflow paired with TSLA arriving is a TRADE, not a withdrawal", () => {
    // The whole point. This is the movement a naive rule books as the owner
    // taking money out.
    const usdg = leg(USDG, ACCOUNT, ROUTER, "1666500");
    const tsla = leg(TSLA, ROUTER, ACCOUNT, "4420417473624633");
    const c = classifyUsdgMovement({ account: ACCOUNT, usdg, txLegs: [usdg, tsla], usdgToken: USDG });
    assert.equal(c.kind, "trade-out");
    assert.equal(c.pairedToken, TSLA);
    assert.match(c.why, /bought something, it did not leave/);
  });

  it("and it does so WITHOUT the router being on any list", () => {
    // 0xf4acdaee… appears in no protocol table in this repo. An allowlist would
    // have called this a withdrawal.
    const usdg = leg(USDG, ACCOUNT, ROUTER, "1666500");
    const tsla = leg(TSLA, ROUTER, ACCOUNT, "4420417473624633");
    const c = classifyUsdgMovement({
      account: ACCOUNT,
      usdg,
      txLegs: [usdg, tsla],
      usdgToken: USDG,
      protocolAddresses: ["0x8366a39cc670b4001a1121b8f6a443a643e40951"], // the V4 PoolManager, not this router
    });
    assert.equal(c.kind, "trade-out");
  });

  it("THE WHOLE FIXTURE totals to exactly 10.000000 USDG contributed", () => {
    const tsla = (raw: string) => leg(TSLA, ROUTER, ACCOUNT, raw);
    const movements = [
      { usdg: leg(USDG, OWNER_WALLET, ACCOUNT, "10000000"), other: [] as TransferLeg[] },
      { usdg: leg(USDG, ACCOUNT, ROUTER, "1666500"), other: [tsla("4420417473624633")] },
      { usdg: leg(USDG, ACCOUNT, ROUTER, "1666500"), other: [tsla("4420460174801013")] },
      { usdg: leg(USDG, ACCOUNT, ROUTER, "1666500"), other: [tsla("4420470491247900")] },
      { usdg: leg(USDG, ACCOUNT, ROUTER, "1666500"), other: [tsla("4422869427188655")] },
    ];
    const classified = movements.map((m) => ({
      amountRaw: m.usdg.amountRaw,
      classification: classifyUsdgMovement({
        account: ACCOUNT,
        usdg: m.usdg,
        txLegs: [m.usdg, ...m.other],
        usdgToken: USDG,
      }),
    }));
    const t = totalCapital(classified);

    assert.equal(t.grossContributionsRaw, "10000000", "contributed capital is 10.000000 USDG");
    assert.equal(t.grossWithdrawalsRaw, "0", "nothing was ever withdrawn");
    assert.equal(t.netContributionsRaw, "10000000");
    assert.equal(t.tradeLegs, 4);
    assert.equal(t.ambiguous, 0);

    // What the naive rule would have said, pinned so the difference is explicit.
    const naiveNet = 10_000_000n - 4n * 1_666_500n;
    assert.equal(naiveNet, 3_334_000n);
    assert.notEqual(t.netContributionsRaw, naiveNet.toString());
  });
});

describe("C2 — a sale is not a deposit", () => {
  it("USDG arriving while a token leaves is sale proceeds", () => {
    const usdg = leg(USDG, ROUTER, ACCOUNT, "5000000");
    const tsla = leg(TSLA, ACCOUNT, ROUTER, "13000000000000000");
    const c = classifyUsdgMovement({ account: ACCOUNT, usdg, txLegs: [usdg, tsla], usdgToken: USDG });
    assert.equal(c.kind, "trade-in");
    assert.match(c.why, /sale proceeds, not a deposit/);
  });

  it("a genuine withdrawal to an outside wallet is capital-out", () => {
    const usdg = leg(USDG, ACCOUNT, OWNER_WALLET, "1010000000");
    const c = classifyUsdgMovement({ account: ACCOUNT, usdg, txLegs: [usdg], usdgToken: USDG });
    assert.equal(c.kind, "capital-out");
  });
});

describe("C3 — it refuses rather than guesses", () => {
  it("a protocol address with NOTHING coming back is ambiguous, not a trade", () => {
    // Removing it from capital on the strength of a list would be a guess; so
    // would booking it as a withdrawal. Neither is available.
    const usdg = leg(USDG, ACCOUNT, ROUTER, "1666500");
    const c = classifyUsdgMovement({
      account: ACCOUNT,
      usdg,
      txLegs: [usdg],
      usdgToken: USDG,
      protocolAddresses: [ROUTER],
    });
    assert.equal(c.kind, "ambiguous");
    assert.match(c.why, /either capital or a completed trade/);
  });

  it("a self-transfer says nothing about capital", () => {
    const usdg = leg(USDG, ACCOUNT, ACCOUNT, "1000000");
    assert.equal(classifyUsdgMovement({ account: ACCOUNT, usdg, txLegs: [usdg], usdgToken: USDG }).kind, "ambiguous");
  });

  it("a movement between two accounts this system controls is internal", () => {
    const other = "0x47Bab4113ba596dC84E5654A400074D7e0ae2F3D";
    const usdg = leg(USDG, ACCOUNT, other, "1000000");
    const c = classifyUsdgMovement({
      account: ACCOUNT,
      usdg,
      txLegs: [usdg],
      usdgToken: USDG,
      knownAccounts: [other],
    });
    assert.equal(c.kind, "internal");
  });

  it("a zero-amount paired leg does not make a swap", () => {
    // An approval or a dust log must not turn a real deposit into a trade.
    const usdg = leg(USDG, OWNER_WALLET, ACCOUNT, "10000000");
    const dust = leg(TSLA, ACCOUNT, ROUTER, "0");
    const c = classifyUsdgMovement({ account: ACCOUNT, usdg, txLegs: [usdg, dust], usdgToken: USDG });
    assert.equal(c.kind, "capital-in");
  });

  it("another USDG leg in the same tx is not a 'different token'", () => {
    const usdg = leg(USDG, OWNER_WALLET, ACCOUNT, "10000000");
    const otherUsdg = leg(USDG, ACCOUNT, ROUTER, "1000");
    const c = classifyUsdgMovement({ account: ACCOUNT, usdg, txLegs: [usdg, otherUsdg], usdgToken: USDG });
    assert.equal(c.kind, "capital-in", "a same-token leg cannot be the other half of a swap");
  });
});

describe("C4 — gross and net are separately derivable", () => {
  it("funded 1010 then withdrawn 1010 is NOT 'no contribution ever happened'", () => {
    // The exact shape of 0xfd58500678406D33293EcAd9976c6c5EE653ECa1 on chain.
    const inLeg = leg(USDG, OWNER_WALLET, ACCOUNT, "1010000000");
    const outLeg = leg(USDG, ACCOUNT, OWNER_WALLET, "1010000000");
    const t = totalCapital([
      {
        amountRaw: inLeg.amountRaw,
        classification: classifyUsdgMovement({ account: ACCOUNT, usdg: inLeg, txLegs: [inLeg], usdgToken: USDG }),
      },
      {
        amountRaw: outLeg.amountRaw,
        classification: classifyUsdgMovement({ account: ACCOUNT, usdg: outLeg, txLegs: [outLeg], usdgToken: USDG }),
      },
    ]);
    assert.equal(t.netContributionsRaw, "0", "net is zero");
    assert.equal(t.grossContributionsRaw, "1010000000", "but 1010 really was contributed");
    assert.equal(t.grossWithdrawalsRaw, "1010000000", "and really was taken back");
  });

  it("an account with no transfers at all has zero of everything", () => {
    const t = totalCapital([]);
    assert.equal(t.grossContributionsRaw, "0");
    assert.equal(t.grossWithdrawalsRaw, "0");
    assert.equal(t.netContributionsRaw, "0");
    assert.equal(t.ambiguous, 0);
  });

  it("money crosses as base-unit strings, never floats", () => {
    const big = leg(USDG, OWNER_WALLET, ACCOUNT, "123456789012345678901234");
    const t = totalCapital([
      {
        amountRaw: big.amountRaw,
        classification: classifyUsdgMovement({ account: ACCOUNT, usdg: big, txLegs: [big], usdgToken: USDG }),
      },
    ]);
    assert.equal(t.grossContributionsRaw, "123456789012345678901234", "exact past 2^53");
  });
});
