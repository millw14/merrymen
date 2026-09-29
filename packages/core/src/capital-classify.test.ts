import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeEventLog, encodeAbiParameters, encodeEventTopics, pad, toHex } from "viem";
import {
  classifyUsdgMovement,
  decodeLighterLog,
  lighterEventsFromReceiptLogs,
  lighterVenueProxies,
  logIndexOf,
  totalCapital,
  type ReceiptLogLike,
  type TransferLeg,
} from "./capital-classify";
import { LIGHTER_EVENTS_ABI } from "./abis";
import { LIGHTER_ROUTE_V1 } from "./perps";

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
const ROUTER_C1 = ROUTER;

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

/**
 * MARGIN IS NOT CAPITAL — the `venue-margin` rule, over receipts shaped exactly
 * like the live ones.
 *
 * Without it, a USDG deposit to the Lighter proxy is `capital-out` and a payout
 * is `capital-in`, both by `no-pair-external` (checked against mainnet receipts
 * 0xf8b3f4bf… and 0x0f82c519…). The effect: perp P&L laundered into
 * contributions, the performance fee charged on the owner's own money coming
 * home or never charged on gains, and a payout raising the high-water mark by
 * money that was already the owner's — which then reads as a drawdown.
 *
 * The fixtures are built from LIGHTER_EVENTS_ABI with viem's encoder, with the
 * values and log positions of the real receipts:
 *   0x28144cb2… a self-deposit — Approval 1, Transfer self→proxy 2,
 *               NewPriorityRequest 3, Deposit 4 {22149, self, 3, 0, 82973191}
 *   0x0f82c519… Lighter's relayer paying claims — per owner, Transfer
 *               proxy→owner at i and WithdrawPending(owner, 3, amount) at i+1
 *               (2457020000 and 8085000000)
 */
describe("the venue-margin rule", () => {
  type Log = ReceiptLogLike;

  const PROXY = LIGHTER_ROUTE_V1.proxy;
  const USDG_ = LIGHTER_ROUTE_V1.usdg;
  const ME = "0x8e93b78ef08d5e36da2e2473cd9027f8c286c176"; // the account behind venue account 22149
  const OTHER = "0x9021b1670000000000000000000000000000beef";
  const ROUTER = "0x8062df5b00000000000000000000000000000001"; // a Robinhood-intent-style router
  const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const APPROVAL = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
  /** A proxy log the rule never reads (the receipt's NewPriorityRequest stands here). */
  const OPAQUE_TOPIC = pad("0x01", { size: 32 });

  const word = (v: bigint | number) => pad(toHex(v), { size: 32 });
  const addrTopic = (a: string) => pad(a as `0x${string}`, { size: 32 }).toLowerCase();
  const transferLog = (logIndex: number, from: string, to: string, amount: bigint): Log => ({
    address: USDG_,
    topics: [TRANSFER, addrTopic(from), addrTopic(to)],
    data: word(amount),
    logIndex,
  });
  const approvalLog = (logIndex: number, owner: string, spender: string, amount: bigint): Log => ({
    address: USDG_,
    topics: [APPROVAL, addrTopic(owner), addrTopic(spender)],
    data: word(amount),
    logIndex,
  });
  const depositLog = (
    logIndex: number,
    ev: { toAccountIndex: bigint; toAddress: string; assetIndex: number; routeType: number; baseAmount: bigint },
    address: string = PROXY,
  ): Log => ({
    address,
    topics: encodeEventTopics({ abi: LIGHTER_EVENTS_ABI, eventName: "Deposit" }) as string[],
    data: encodeAbiParameters(
      LIGHTER_EVENTS_ABI[0].inputs,
      [Number(ev.toAccountIndex), ev.toAddress as `0x${string}`, ev.assetIndex, ev.routeType, ev.baseAmount],
    ),
    logIndex,
  });
  const withdrawPendingLog = (logIndex: number, owner: string, assetIndex: number, baseAmount: bigint, address: string = PROXY): Log => ({
    address,
    topics: encodeEventTopics({ abi: LIGHTER_EVENTS_ABI, eventName: "WithdrawPending", args: { owner: owner as `0x${string}` } }) as string[],
    data: encodeAbiParameters(
      LIGHTER_EVENTS_ABI[1].inputs.filter((i) => !i.indexed),
      [assetIndex, baseAmount],
    ),
    logIndex,
  });
  const opaqueLog = (logIndex: number): Log => ({ address: PROXY, topics: [OPAQUE_TOPIC], data: "0x", logIndex });

  const AMOUNT = 82_973_191n;
  /** 0x28144cb2…, as its logs lie. */
  const selfDeposit: Log[] = [
    approvalLog(1, ME, PROXY, AMOUNT),
    transferLog(2, ME, PROXY, AMOUNT),
    opaqueLog(3),
    depositLog(4, { toAccountIndex: 22149n, toAddress: ME, assetIndex: 3, routeType: 0, baseAmount: AMOUNT }),
  ];
  const legOf = (l: Log) => {
    const [, from, to] = l.topics;
    return {
      token: l.address,
      from: `0x${from!.slice(-40)}`,
      to: `0x${to!.slice(-40)}`,
      amountRaw: BigInt(l.data).toString(),
      logIndex: logIndexOf(l) ?? undefined,
    };
  };
  /** Classify the Transfer at `at` in `logs`, the way a scanner holding the receipt would. */
  const classifyAt = (logs: Log[], at: number, extra: Partial<Parameters<typeof classifyUsdgMovement>[0]> = {}) => {
    const legs = logs.filter((l) => l.topics[0] === TRANSFER).map(legOf);
    const usdg = legs.find((l) => l.logIndex === at)!;
    return classifyUsdgMovement({
      account: ME,
      usdg,
      txLegs: legs,
      usdgToken: USDG_,
      venueProxies: lighterVenueProxies(4663),
      venueLogs: logs,
      ...extra,
    });
  };

  it("one source for the proxies: Lighter's on 4663, none anywhere else", () => {
    assert.deepEqual(lighterVenueProxies(4663), [PROXY]);
    for (const chainId of [46630, 1, 8453]) assert.deepEqual(lighterVenueProxies(chainId), []);
  });

  it("the decoder reads what viem's encoder writes for LIGHTER_EVENTS_ABI, and viem agrees", () => {
    const events = lighterEventsFromReceiptLogs(selfDeposit, 4663);
    assert.equal(events.length, 1, "Approval, Transfer and the opaque proxy log are not margin events");
    assert.deepEqual(events[0], {
      event: "Deposit",
      proxy: PROXY,
      logIndex: 4,
      toAccountIndex: 22149n,
      toAddress: ME,
      assetIndex: 3,
      routeType: 0,
      baseAmount: AMOUNT,
    });
    const viemView = decodeEventLog({ abi: LIGHTER_EVENTS_ABI, data: selfDeposit[3]!.data as `0x${string}`, topics: selfDeposit[3]!.topics as [`0x${string}`] });
    assert.equal(viemView.eventName, "Deposit");
    assert.equal((viemView.args as { baseAmount: bigint }).baseAmount, AMOUNT);
    assert.equal(selfDeposit[3]!.topics[0], LIGHTER_ROUTE_V1.topics.deposit, "topic0 is the route's pinned hash");
    assert.equal(selfDeposit[3]!.topics.length, 1, "Deposit indexes nothing — it cannot be log-filtered by account");

    const wp = withdrawPendingLog(7, ME, 3, 8_085_000_000n);
    assert.equal(wp.topics[0], LIGHTER_ROUTE_V1.topics.withdrawPending);
    assert.deepEqual(decodeLighterLog(wp), {
      event: "WithdrawPending",
      proxy: PROXY,
      logIndex: 7,
      owner: ME,
      assetIndex: 3,
      baseAmount: 8_085_000_000n,
    });
  });

  it("the decoder reads only the venue, only on 4663, and only canonical encodings", () => {
    // A contract copying the proxy's event signatures is not the venue.
    const copycat = depositLog(4, { toAccountIndex: 1n, toAddress: ME, assetIndex: 3, routeType: 0, baseAmount: AMOUNT }, OTHER);
    assert.deepEqual(lighterEventsFromReceiptLogs([copycat], 4663), []);
    assert.deepEqual(lighterEventsFromReceiptLogs(selfDeposit, 46630), [], "no venue off mainnet");
    // Case of the emitting address does not matter; the contents do.
    assert.equal(lighterEventsFromReceiptLogs([{ ...selfDeposit[3]!, address: PROXY.toUpperCase().replace("0X", "0x") }], 4663).length, 1);

    const good = selfDeposit[3]!;
    const body = good.data.slice(2);
    const w = (i: number) => body.slice(i * 64, (i + 1) * 64);
    const withWord = (i: number, v: string) => `0x${[0, 1, 2, 3, 4].map((k) => (k === i ? v : w(k))).join("")}`;
    const malformed: Record<string, Log> = {
      "an extra data word": { ...good, data: `${good.data}${"00".repeat(32)}` },
      "a missing data word": { ...good, data: `0x${body.slice(0, 64 * 4)}` },
      "an indexed topic Deposit does not have": { ...good, topics: [...good.topics, addrTopic(ME)] },
      "a dirty high byte on toAddress": { ...good, data: withWord(1, `ff${w(1).slice(2)}`) },
      "a uint16 asset index past 2^16": { ...good, data: withWord(2, word(0x10003n).slice(2)) },
      "a uint8 route past 2^8": { ...good, data: withWord(3, word(0x100n).slice(2)) },
      "a uint48 account index past 2^48": { ...good, data: withWord(0, word(2n ** 48n).slice(2)) },
      "odd-length data": { ...good, data: `${good.data}0` },
    };
    for (const [why, log] of Object.entries(malformed)) {
      assert.equal(decodeLighterLog(log), null, why);
    }
    const wp = withdrawPendingLog(7, ME, 3, 1n);
    assert.equal(decodeLighterLog({ ...wp, topics: [wp.topics[0]!] }), null, "WithdrawPending without its owner topic");
    assert.equal(decodeLighterLog({ ...wp, topics: [wp.topics[0]!, `0xff${wp.topics[1]!.slice(4)}`] }), null, "a dirty owner topic");
  });

  it("THE BASELINE: without the rule, a deposit is a withdrawal and a payout is a deposit", () => {
    // What every scanner does today, and what the rule exists to stop. Pinned
    // so the two fields' absence is proven to change nothing.
    const out = classifyAt(selfDeposit, 2, { venueProxies: undefined, venueLogs: undefined });
    assert.equal(out.kind, "capital-out");
    assert.equal(out.evidence.rule, "no-pair-external");
    const payout = [transferLog(10, PROXY, ME, 8_085_000_000n), withdrawPendingLog(11, ME, 3, 8_085_000_000n)];
    const back = classifyAt(payout, 10, { venueProxies: undefined, venueLogs: undefined });
    assert.equal(back.kind, "capital-in");
    assert.equal(back.evidence.rule, "no-pair-external");
  });

  it("ABSENT OR EMPTY venueProxies is byte-identical to before the fields existed, whatever else is passed", () => {
    // Every movement shape this file already pins, plus the proxy legs, with
    // and without the new fields: the verdict objects must be deepEqual.
    const payout = [transferLog(10, PROXY, ME, 8_085_000_000n), withdrawPendingLog(11, ME, 3, 8_085_000_000n)];
    const shapes: { logs: Log[]; at: number }[] = [
      { logs: selfDeposit, at: 2 },
      { logs: payout, at: 10 },
      { logs: [transferLog(0, OTHER, ME, 10_000_000n)], at: 0 },
      { logs: [transferLog(0, ME, OTHER, 10_000_000n)], at: 0 },
      { logs: [transferLog(0, ME, ME, 1n)], at: 0 },
    ];
    for (const { logs, at } of shapes) {
      const before = classifyAt(logs, at, { venueProxies: undefined, venueLogs: undefined });
      assert.deepEqual(classifyAt(logs, at, { venueProxies: [], venueLogs: logs }), before, "empty proxies, logs present");
      assert.deepEqual(classifyAt(logs, at, { venueProxies: undefined }), before, "logs alone switch nothing on");
      assert.deepEqual(classifyAt(logs, at, { venueProxies: lighterVenueProxies(46630), venueLogs: logs }), before, "testnet has no venue");
    }
    // And with the proxies named, a leg that does not touch the proxy is
    // untouched too.
    const plain = [transferLog(0, OTHER, ME, 10_000_000n)];
    assert.deepEqual(classifyAt(plain, 0), classifyAt(plain, 0, { venueProxies: undefined, venueLogs: undefined }));
    // The canary fixture at the top of this file, with the fields on.
    const usdg = leg(USDG, ACCOUNT, ROUTER_C1, "1666500");
    const tsla = leg(TSLA, ROUTER_C1, ACCOUNT, "4420417473624633");
    const base = { account: ACCOUNT, usdg, txLegs: [usdg, tsla], usdgToken: USDG };
    assert.deepEqual(classifyUsdgMovement({ ...base, venueProxies: lighterVenueProxies(4663), venueLogs: [] }), classifyUsdgMovement(base));
  });

  it("a self-deposit is margin-out, proved by the Deposit its own call emitted", () => {
    const v = classifyAt(selfDeposit, 2);
    assert.equal(v.kind, "margin-out");
    assert.equal(v.evidence.rule, "venue-margin");
    assert.equal(v.evidence.direction, "out");
    assert.equal(v.evidence.counterparty, PROXY);
    assert.match(v.why, /log 4/);
    assert.match(v.why, /22149/);
    // The rule decides before the infrastructure and venue lists do, so naming
    // the proxy there as well cannot demote it to `protocol` or `ambiguous`.
    assert.equal(classifyAt(selfDeposit, 2, { protocolAddresses: [PROXY], systemAddresses: [PROXY] }).kind, "margin-out");
  });

  it("a Deposit naming SOMEONE ELSE is capital-out — today's verdict, now with its reason", () => {
    const toOther = [
      transferLog(2, ME, PROXY, AMOUNT),
      depositLog(4, { toAccountIndex: 777n, toAddress: OTHER, assetIndex: 3, routeType: 0, baseAmount: AMOUNT }),
    ];
    const v = classifyAt(toOther, 2);
    assert.equal(v.kind, "capital-out", "this account's USDG credited a venue account it does not own");
    assert.equal(v.evidence.rule, "venue-margin");
    assert.match(v.why, new RegExp(OTHER));
  });

  it("anything the receipt does not prove is ambiguous — never capital, never margin", () => {
    const refused: Record<string, { logs: Log[]; at?: number; extra?: Record<string, unknown> }> = {
      "an amount that differs": {
        logs: [transferLog(2, ME, PROXY, AMOUNT), depositLog(4, { toAccountIndex: 22149n, toAddress: ME, assetIndex: 3, routeType: 0, baseAmount: AMOUNT - 1n })],
      },
      "another asset": {
        logs: [transferLog(2, ME, PROXY, AMOUNT), depositLog(4, { toAccountIndex: 22149n, toAddress: ME, assetIndex: 1, routeType: 0, baseAmount: AMOUNT })],
      },
      "the spot route": {
        logs: [transferLog(2, ME, PROXY, AMOUNT), depositLog(4, { toAccountIndex: 22149n, toAddress: ME, assetIndex: 3, routeType: 1, baseAmount: AMOUNT })],
      },
      "no Deposit at all (a plain transfer to the venue)": { logs: [transferLog(2, ME, PROXY, AMOUNT)] },
      "a Deposit BEFORE the transfer, not after it": {
        logs: [depositLog(1, { toAccountIndex: 22149n, toAddress: ME, assetIndex: 3, routeType: 0, baseAmount: AMOUNT }), transferLog(2, ME, PROXY, AMOUNT)],
      },
      "a Deposit emitted by some other contract": {
        logs: [transferLog(2, ME, PROXY, AMOUNT), depositLog(4, { toAccountIndex: 22149n, toAddress: ME, assetIndex: 3, routeType: 0, baseAmount: AMOUNT }, OTHER)],
      },
      "other USDG entering the venue in between": {
        logs: [
          transferLog(2, ME, PROXY, AMOUNT),
          transferLog(3, ROUTER, PROXY, AMOUNT),
          depositLog(4, { toAccountIndex: 22149n, toAddress: ME, assetIndex: 3, routeType: 0, baseAmount: AMOUNT }),
        ],
      },
      "an undecodable Deposit where the pair should be": {
        logs: [transferLog(2, ME, PROXY, AMOUNT), { ...selfDeposit[3]!, data: `${selfDeposit[3]!.data}00` }],
      },
      "the logs withheld while the proxy is named": { logs: selfDeposit, extra: { venueLogs: undefined } },
      "no position for the leg": { logs: selfDeposit, extra: { usdg: { ...legOf(selfDeposit[1]!), logIndex: undefined } } },
      "a position that is not this transfer": { logs: selfDeposit, extra: { usdg: { ...legOf(selfDeposit[1]!), logIndex: 1 } } },
    };
    for (const [why, { logs, at = 2, extra = {} }] of Object.entries(refused)) {
      const v = classifyAt(logs, at, extra as never);
      assert.equal(v.kind, "ambiguous", why);
      assert.equal(v.evidence.rule, "venue-margin", `${why}: the venue rule decided it, not a fall-through`);
    }
  });

  it("SOMEONE ELSE'S deposit in the same transaction never pairs with ours", () => {
    // A third of live Deposits are routed: a router pulls USDG and credits
    // another address. Ours pairs by position with the Deposit its own call
    // emitted, whichever side of it theirs falls.
    const theirs = (t: number, d: number): Log[] => [
      transferLog(t, ROUTER, PROXY, 135_000_000n),
      depositLog(d, { toAccountIndex: 9n, toAddress: OTHER, assetIndex: 3, routeType: 0, baseAmount: 135_000_000n }),
    ];
    const after = [...selfDeposit, ...theirs(6, 8)];
    const before = [...theirs(0, 1), ...selfDeposit.map((l) => ({ ...l, logIndex: logIndexOf(l)! + 10 }))];
    assert.equal(classifyAt(after, 2).kind, "margin-out");
    assert.equal(classifyAt(before, 12).kind, "margin-out");
    // And two deposits of our own in one UserOp each find their own event.
    const twice = [
      ...selfDeposit,
      transferLog(6, ME, PROXY, 5_000_000n),
      opaqueLog(7),
      depositLog(8, { toAccountIndex: 22149n, toAddress: ME, assetIndex: 3, routeType: 0, baseAmount: 5_000_000n }),
    ];
    assert.equal(classifyAt(twice, 2).kind, "margin-out");
    assert.equal(classifyAt(twice, 6).kind, "margin-out");
  });

  it("a payout from the relayer's batch is margin-in; the other owner's is not ours at all", () => {
    // 0x0f82c519…: the relayer claims for several owners in one transaction.
    const batch = [
      transferLog(20, PROXY, OTHER, 2_457_020_000n),
      withdrawPendingLog(21, OTHER, 3, 2_457_020_000n),
      transferLog(22, PROXY, ME, 8_085_000_000n),
      withdrawPendingLog(23, ME, 3, 8_085_000_000n),
    ];
    const v = classifyAt(batch, 22);
    assert.equal(v.kind, "margin-in");
    assert.equal(v.evidence.rule, "venue-margin");
    assert.equal(v.evidence.direction, "in");
    assert.match(v.why, /log 23/);
    assert.equal(classifyAt(batch, 20).kind, "ambiguous", "a transfer that does not touch this account decides nothing");
    assert.equal(classifyAt(batch, 20).evidence.rule, "not-this-account");
  });

  it("the same owner paid twice with equal amounts pairs BY POSITION, one event each", () => {
    const X = 1_000_000n;
    const twice = [
      transferLog(30, PROXY, ME, X),
      withdrawPendingLog(31, ME, 3, X),
      transferLog(32, PROXY, ME, X),
      withdrawPendingLog(33, ME, 3, X),
    ];
    assert.equal(classifyAt(twice, 30).kind, "margin-in");
    assert.equal(classifyAt(twice, 32).kind, "margin-in");
    // Remove the second event: the second transfer has nothing of its own, and
    // borrowing the first one's would be pairing by amount.
    const oneEvent = twice.slice(0, 3);
    assert.equal(classifyAt(oneEvent, 30).kind, "margin-in");
    assert.equal(classifyAt(oneEvent, 32).kind, "ambiguous");
  });

  it("a proxy payout without its own WithdrawPending is ambiguous", () => {
    const X = 8_085_000_000n;
    const cases: Record<string, Log[]> = {
      "no event": [transferLog(10, PROXY, ME, X)],
      "the event names another owner": [transferLog(10, PROXY, ME, X), withdrawPendingLog(11, OTHER, 3, X)],
      "another asset": [transferLog(10, PROXY, ME, X), withdrawPendingLog(11, ME, 0, X)],
      "another amount": [transferLog(10, PROXY, ME, X), withdrawPendingLog(11, ME, 3, X - 1n)],
      "not adjacent": [transferLog(10, PROXY, ME, X), opaqueLog(11), withdrawPendingLog(12, ME, 3, X)],
      "emitted by another contract": [transferLog(10, PROXY, ME, X), withdrawPendingLog(11, ME, 3, X, OTHER)],
    };
    for (const [why, logs] of Object.entries(cases)) {
      const v = classifyAt(logs, 10);
      assert.equal(v.kind, "ambiguous", why);
      assert.equal(v.evidence.rule, "venue-margin", why);
    }
  });

  it("log positions are read as RPCs spell them, and a receipt with an unreadable one pairs nothing", () => {
    // viem gives numbers; raw JSON-RPC gives hex strings. Both are the same receipt.
    assert.equal(logIndexOf({ logIndex: 4 }), 4);
    assert.equal(logIndexOf({ logIndex: "0x4" }), 4);
    assert.equal(logIndexOf({ logIndex: "4" }), 4);
    assert.equal(logIndexOf({ logIndex: 4n }), 4);
    for (const bad of [undefined, null, -1, 1.5, "0xzz", "", 2n ** 64n, Number.NaN]) {
      assert.equal(logIndexOf({ logIndex: bad as never }), null, String(bad));
    }
    const hexed = selfDeposit.map((l) => ({ ...l, logIndex: `0x${logIndexOf(l)!.toString(16)}` }));
    assert.equal(classifyAt(hexed, 2).kind, "margin-out", "hex positions read exactly as numbers do");
    assert.equal(lighterEventsFromReceiptLogs(hexed, 4663)[0]!.logIndex, 4);
    // One unreadable position anywhere and "what sits between" is unknowable.
    const holed = [...selfDeposit.slice(0, 2), { ...selfDeposit[2]!, logIndex: null }, selfDeposit[3]!];
    const v = classifyAt(holed, 2);
    assert.equal(v.kind, "ambiguous");
    assert.match(v.why, /position could not be read/);
    // Two logs at one position is not a receipt; nothing pairs in it either.
    assert.equal(classifyAt([...selfDeposit, { ...selfDeposit[3]!, logIndex: 3 }], 2).kind, "ambiguous");
    // The decoder still reports WHAT a log said when it cannot say WHERE.
    assert.equal(lighterEventsFromReceiptLogs([{ ...selfDeposit[3]!, logIndex: undefined }], 4663)[0]!.logIndex, null);
  });

  it("the paired rule still comes first: a leg that was half of a swap is a trade", () => {
    // The ordering the header argues for — transaction context needs no list.
    const logs = [...selfDeposit];
    const legs = logs.filter((l) => l.topics[0] === TRANSFER).map(legOf);
    const v = classifyUsdgMovement({
      account: ME,
      usdg: legs[0]!,
      txLegs: [...legs, { token: TSLA, from: ROUTER, to: ME, amountRaw: "1000" }],
      usdgToken: USDG_,
      venueProxies: lighterVenueProxies(4663),
      venueLogs: logs,
    });
    assert.equal(v.kind, "trade-out");
  });

  it("totals: margin is its own figure and moves no contribution", () => {
    const payout = [transferLog(10, PROXY, ME, 8_085_000_000n), withdrawPendingLog(11, ME, 3, 8_085_000_000n)];
    const funding = [transferLog(0, OTHER, ME, 100_000_000n)];
    const t = totalCapital([
      { amountRaw: "100000000", classification: classifyAt(funding, 0) },
      { amountRaw: AMOUNT.toString(), classification: classifyAt(selfDeposit, 2) },
      { amountRaw: "8085000000", classification: classifyAt(payout, 10) },
    ]);
    assert.equal(t.grossContributionsRaw, "100000000", "the owner's funding is the only capital");
    assert.equal(t.grossWithdrawalsRaw, "0", "a margin deposit is not a withdrawal");
    assert.equal(t.netContributionsRaw, "100000000");
    assert.equal(t.grossMarginOutRaw, AMOUNT.toString());
    assert.equal(t.grossMarginInRaw, "8085000000");
    assert.equal(t.marginLegs, 2);
    assert.equal(t.tradeLegs, 0, "margin bought nothing");
    assert.equal(t.internal, 0);
    assert.equal(t.ambiguous, 0);
  });

  it("an account that never touched the venue totals zero margin", () => {
    const t = totalCapital([]);
    assert.equal(t.grossMarginOutRaw, "0");
    assert.equal(t.grossMarginInRaw, "0");
    assert.equal(t.marginLegs, 0);
  });

  it("totalCapital refuses a kind it does not know rather than counting it as nothing", () => {
    assert.throws(
      () => totalCapital([{ amountRaw: "1", classification: { kind: "mystery" } as never }]),
      /unhandled classification kind mystery/,
    );
  });
});
