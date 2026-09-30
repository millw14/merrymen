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

/**
 * A CLASS TRADE IS A TRADE, even though its token never touches the account.
 *
 * The paired-leg rule is the primary one here precisely because it does not
 * depend on knowing the venue — it reads transaction context, which the header
 * says an allowlist can never do. But it asked whether the other token moved to
 * or from THE ACCOUNT, and a class buy delivers to the vault by design.
 *
 * So neither leg paired, both fell to `no-pair-external`, and a trade was booked
 * as a deposit or a withdrawal. That is not a display bug: net contributions are
 * the denominator of every P&L figure, so a spent 25 USDG counted as a
 * withdrawal shows up as profit that never existed.
 *
 * And the vault can never be on `protocolAddresses` — it is CREATE2-salted with
 * one smart account, so there is no global list it could belong to. Hence a
 * per-call parameter rather than a constant.
 */
describe("a class vault's legs are the account's own trades", () => {
  const ME = "0x00000000000000000000000000000000000000a1";
  const VAULT = "0x00000000000000000000000000000000000000c0";
  const CURVE = "0x00000000000000000000000000000000000000c3";
  const USDG = "0x0000000000000000000000000000000000000dd0";
  const PEPE = "0x0000000000000000000000000000000000000ee0";

  const leg = (token: string, from: string, to: string, amountRaw: string) => ({
    token,
    from,
    to,
    amountRaw,
  });

  // A class BUY: cash to the vault, vault to the curve, token to the vault.
  const buyLegs = [
    leg(USDG, ME, VAULT, "25000000"),
    leg(USDG, VAULT, CURVE, "25000000"),
    leg(PEPE, CURVE, VAULT, "400000000000000000000"),
  ];
  // A class SELL: token out of the vault, proceeds straight to the owner.
  const sellLegs = [
    leg(PEPE, VAULT, CURVE, "400000000000000000000"),
    leg(USDG, CURVE, ME, "31000000"),
  ];

  it("THE BUG: without the vault, a class buy is booked as a WITHDRAWAL", () => {
    const v = classifyUsdgMovement({
      account: ME,
      usdg: buyLegs[0]!,
      txLegs: buyLegs,
      usdgToken: USDG,
    });
    assert.equal(v.kind, "capital-out");
    assert.equal(v.evidence.rule, "no-pair-external");
  });

  it("THE FIX: naming the vault makes it a trade", () => {
    const v = classifyUsdgMovement({
      account: ME,
      usdg: buyLegs[0]!,
      txLegs: buyLegs,
      usdgToken: USDG,
      custodyAddresses: [VAULT],
    });
    assert.equal(v.kind, "trade-out");
    assert.equal(v.evidence.rule, "paired-token-movement");
    assert.equal(v.pairedToken, PEPE);
  });

  it("excludes own-vault refunds during buys from contributed capital", () => {
    const refund = leg(USDG, VAULT, ME, "9268223");
    const txLegs = [...buyLegs, refund];
    const classified = [buyLegs[0]!, refund].map((usdg) => ({
      amountRaw: usdg.amountRaw,
      classification: classifyUsdgMovement({ account: ME, usdg, txLegs, usdgToken: USDG, custodyAddresses: [VAULT] }),
    }));
    assert.equal(classified[0]!.classification.kind, "trade-out");
    assert.equal(classified[1]!.classification.kind, "internal");
    assert.equal(classified[1]!.classification.evidence.rule, "custody-transfer");
    assert.equal(totalCapital(classified).grossContributionsRaw, "0");
    assert.equal(totalCapital(classified).grossWithdrawalsRaw, "0");
  });

  it("treats unpaired cash parking and returns as internal only for this vault", () => {
    for (const usdg of [leg(USDG, ME, VAULT, "5000000"), leg(USDG, VAULT, ME, "1147072")]) {
      const input = { account: ME, usdg, txLegs: [usdg], usdgToken: USDG };
      assert.equal(classifyUsdgMovement({ ...input, custodyAddresses: [VAULT.toUpperCase()] }).kind, "internal");
      assert.equal(classifyUsdgMovement({ ...input, custodyAddresses: [CURVE] }).kind,
        usdg.from === ME ? "capital-out" : "capital-in");
    }
  });

  it("and the WHY says where the token actually went, so it is re-derivable", () => {
    // A classification an auditor cannot re-derive is an assertion, and "into
    // the account" would be false here.
    const v = classifyUsdgMovement({
      account: ME,
      usdg: buyLegs[0]!,
      txLegs: buyLegs,
      usdgToken: USDG,
      custodyAddresses: [VAULT],
    });
    assert.match(v.why, /vault/);
    assert.match(v.why, new RegExp(VAULT));
  });

  it("a class sell is sale proceeds, not a deposit", () => {
    const v = classifyUsdgMovement({
      account: ME,
      usdg: sellLegs[1]!,
      txLegs: sellLegs,
      usdgToken: USDG,
      custodyAddresses: [VAULT],
    });
    assert.equal(v.kind, "trade-in");
    assert.equal(v.pairedToken, PEPE);
  });

  it("an ordinary trade is unchanged, and still says `the account`", () => {
    // The widening must be additive. A normal swap's token DOES reach the
    // account, and its sentence must not start talking about a vault.
    const swapLegs = [leg(USDG, ME, CURVE, "25000000"), leg(PEPE, CURVE, ME, "400000000000000000000")];
    const v = classifyUsdgMovement({
      account: ME,
      usdg: swapLegs[0]!,
      txLegs: swapLegs,
      usdgToken: USDG,
      custodyAddresses: [VAULT],
    });
    assert.equal(v.kind, "trade-out");
    assert.match(v.why, /INTO the account/);
  });

  it("a REAL withdrawal to a stranger is still a withdrawal", () => {
    // The rule must not become "anything with a second leg is a trade".
    const STRANGER = "0x00000000000000000000000000000000000000f1";
    const v = classifyUsdgMovement({
      account: ME,
      usdg: leg(USDG, ME, STRANGER, "25000000"),
      txLegs: [leg(USDG, ME, STRANGER, "25000000")],
      usdgToken: USDG,
      custodyAddresses: [VAULT],
    });
    assert.equal(v.kind, "capital-out");
  });

  it("and a token landing at SOMEONE ELSE'S vault does not pair", () => {
    // custodyAddresses is per-account. Another owner's vault is a stranger.
    const OTHER_VAULT = "0x00000000000000000000000000000000000000c1";
    const v = classifyUsdgMovement({
      account: ME,
      usdg: leg(USDG, ME, OTHER_VAULT, "25000000"),
      txLegs: [
        leg(USDG, ME, OTHER_VAULT, "25000000"),
        leg(PEPE, CURVE, OTHER_VAULT, "400000000000000000000"),
      ],
      usdgToken: USDG,
      custodyAddresses: [VAULT],
    });
    assert.equal(v.kind, "capital-out");
  });

  it("absent custodyAddresses reproduces today's behaviour exactly", () => {
    const swapLegs = [leg(USDG, ME, CURVE, "25000000"), leg(PEPE, CURVE, ME, "400000000000000000000")];
    const withField = classifyUsdgMovement({
      account: ME,
      usdg: swapLegs[0]!,
      txLegs: swapLegs,
      usdgToken: USDG,
      custodyAddresses: [],
    });
    const without = classifyUsdgMovement({
      account: ME,
      usdg: swapLegs[0]!,
      txLegs: swapLegs,
      usdgToken: USDG,
    });
    assert.deepEqual(withField, without);
    // And an EMPTY reserve list is the same as none: the energy rule only
    // exists when a caller names the reserve.
    const withReserve = classifyUsdgMovement({
      account: ME,
      usdg: swapLegs[0]!,
      txLegs: swapLegs,
      usdgToken: USDG,
      custodyAddresses: [],
      reserveTokens: [],
    });
    assert.deepEqual(withReserve, without);
  });
});

/**
 * BUYING ENERGY IS CAPITAL LEAVING THE BOOK, NOT A TRADE AND NOT A WITHDRAWAL.
 *
 * The energy route is USDG -> VIRTUAL -> $MERRYMEN over two Uniswap v2 pairs,
 * with the token's buy tax skimmed to the token contract on the way. Four legs,
 * and only two touch the account: USDG out, $MERRYMEN in.
 *
 * Why a distinct kind rather than `capital-out`: the live deposit scanner books
 * every capital-in/out it sees, and the worker books this purchase itself at
 * landing. `reserve-out` is the kind the scanner leaves alone and the fleet
 * tools count — so there is exactly one live booker.
 */
describe("the energy reserve purchase", () => {
  const ME = "0x00000000000000000000000000000000000000a1";
  const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
  const VIRTUAL = "0xc6911796042b15d7fa4f6cde69e245ddcd3d9c31";
  const MERRYMEN = "0xa15cd06dd305269a0f48bebeb30aa3588fba7b32";
  const PAIR_A = "0x00000000000000000000000000000000000000b1"; // USDG/VIRTUAL
  const PAIR_B = "0x00000000000000000000000000000000000000b2"; // VIRTUAL/MERRYMEN
  const VAULT = "0x00000000000000000000000000000000000000c0";
  const TSLA = "0x322f0929c4625ed5bad873c95208d54e1c003b2d";

  const energyLegs = [
    leg(USDG, ME, PAIR_A, "42000000"),
    leg(VIRTUAL, PAIR_A, PAIR_B, "90000000000000000000"),
    leg(MERRYMEN, PAIR_B, MERRYMEN, "2000000000000000000000"), // the buy tax, to the token contract
    leg(MERRYMEN, PAIR_B, ME, "98000000000000000000000"),
  ];
  const classify = (legs: TransferLeg[], extra: { reserveTokens?: string[]; custodyAddresses?: string[] } = {}) =>
    classifyUsdgMovement({ account: ME, usdg: legs[0]!, txLegs: legs, usdgToken: USDG, ...extra });

  it("with the reserve named, the USDG leg is reserve-out", () => {
    const v = classify(energyLegs, { reserveTokens: [MERRYMEN] });
    assert.equal(v.kind, "reserve-out");
    assert.equal(v.evidence.rule, "reserve-purchase");
    assert.equal(v.pairedToken, MERRYMEN);
    assert.equal(v.evidence.direction, "out");
    assert.equal(v.evidence.txLegCount, 4);
    assert.match(v.why, /outside the trading book/);
  });

  it("the reserve list is compared without regard to case", () => {
    assert.equal(classify(energyLegs, { reserveTokens: [MERRYMEN.toUpperCase().replace("0X", "0x")] }).kind, "reserve-out");
  });

  it("without the reserve named, the same legs are the trade they always were", () => {
    const v = classify(energyLegs);
    assert.equal(v.kind, "trade-out");
    assert.equal(v.evidence.rule, "paired-token-movement");
  });

  it("a MIXED batch — the reserve and a position arriving together — stays a trade", () => {
    // Part of this USDG bought a position. Calling the whole leg reserve-out
    // would lower contributions for money that is still in the book.
    const mixed = [...energyLegs, leg(TSLA, PAIR_A, ME, "13000000000000000")];
    assert.equal(classify(mixed, { reserveTokens: [MERRYMEN] }).kind, "trade-out");
  });

  it("the reserve landing at a custody vault stays a trade — the energy route pays the account", () => {
    const toVault = [leg(USDG, ME, PAIR_A, "42000000"), leg(MERRYMEN, PAIR_B, VAULT, "98000000000000000000000")];
    assert.equal(classify(toVault, { reserveTokens: [MERRYMEN], custodyAddresses: [VAULT] }).kind, "trade-out");
  });

  it("there is no reserve-in: USDG arriving against the reserve leaving is sale proceeds", () => {
    const sell = [leg(MERRYMEN, ME, PAIR_B, "98000000000000000000000"), leg(USDG, PAIR_A, ME, "40000000")];
    const v = classifyUsdgMovement({ account: ME, usdg: sell[1]!, txLegs: sell, usdgToken: USDG, reserveTokens: [MERRYMEN] });
    assert.equal(v.kind, "trade-in");
  });

  it("an ordinary trade is untouched by naming the reserve", () => {
    const swap = [leg(USDG, ME, PAIR_A, "25000000"), leg(TSLA, PAIR_A, ME, "13000000000000000")];
    assert.deepEqual(classify(swap, { reserveTokens: [MERRYMEN] }), classify(swap));
  });

  it("a plain withdrawal is still a withdrawal with the reserve named", () => {
    const out = [leg(USDG, ME, "0x00000000000000000000000000000000000000f1", "5000000")];
    assert.equal(classify(out, { reserveTokens: [MERRYMEN] }).kind, "capital-out");
  });

  it("totals: reserve purchases are their own figure and come off net contributions", () => {
    const funding = leg(USDG, "0x00000000000000000000000000000000000000f1", ME, "100000000");
    const home = leg(USDG, ME, "0x00000000000000000000000000000000000000f1", "10000000");
    const t = totalCapital([
      { amountRaw: funding.amountRaw, classification: classify([funding], { reserveTokens: [MERRYMEN] }) },
      { amountRaw: home.amountRaw, classification: classify([home], { reserveTokens: [MERRYMEN] }) },
      { amountRaw: "42000000", classification: classify(energyLegs, { reserveTokens: [MERRYMEN] }) },
      { amountRaw: "8000000", classification: classify(energyLegs, { reserveTokens: [MERRYMEN] }) },
    ]);
    assert.equal(t.grossContributionsRaw, "100000000");
    assert.equal(t.grossWithdrawalsRaw, "10000000", "withdrawals stay external-only");
    assert.equal(t.grossReservePurchasesRaw, "50000000");
    assert.equal(t.reservePurchases, 2);
    assert.equal(t.netContributionsRaw, "40000000", "in − out − reserve");
    assert.equal(t.tradeLegs, 0, "a reserve purchase is not counted as a trade leg");
  });

  it("an account that never bought energy totals zero reserve", () => {
    const t = totalCapital([]);
    assert.equal(t.grossReservePurchasesRaw, "0");
    assert.equal(t.reservePurchases, 0);
  });
});
