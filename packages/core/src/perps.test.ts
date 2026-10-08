import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decodeEventLog,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  pad,
  toBytes,
  toEventSelector,
  toFunctionSelector,
} from "viem";
import {
  LIGHTER_CHANGE_PUBKEY_ABI,
  LIGHTER_DEPOSIT_ABI,
  LIGHTER_EVENTS_ABI,
  LIGHTER_OWNER_RECOVER_ABI,
  LIGHTER_READ_ABI,
  LIGHTER_WITHDRAW_PENDING_ABI,
} from "./abis";
import {
  GOLDILOCKS_P,
  GRANT_PERP_LIGHTER,
  LIGHTER_MARKETS_V1,
  LIGHTER_ROUTE_V1,
  PERP_BLOCKERS,
  PERP_COI_MAX,
  PERP_LEG,
  PERP_MAX_ORDER_PRICE,
  PERP_TRADE_FEE_BPS,
  PERP_TREND_UNIVERSE,
  baseForNotional,
  custodySentence,
  effectiveMinNotionalMicro,
  fundingPaymentMicro,
  grantPerp,
  imfPercentToBp,
  isPerpBlocker,
  isPerpKey,
  isolatedLiqPrice,
  isolatedLiqPriceFromCost,
  isolatedMarginMicro,
  leverageFromImfBp,
  leverageTarget,
  liqDistanceBps,
  minOpenBase,
  notionalMicro,
  parseDecimalToScaled,
  parseMicroUsdg,
  parsePerpsReport,
  peakBasisMicro,
  perpCoi,
  perpMarketById,
  perpMarketByKey,
  perpsBlockerText,
  pubKeyWords,
  stopBeatsLiquidation,
  stopPrices,
  takePrices,
  unrealizedPnlMicro,
  validatePerpPubKey,
  worstPriceForTaker,
  type PerpExposure,
  type PerpMarketSpec,
  type PerpSide,
  type PerpsReport,
} from "./perps";
import { CASH } from "./tokens";

// ── fixtures (live mainnet reads, 2026-09-29; copied in so the test needs no network) ──

/**
 * GET https://api.rh.lighter.xyz/api/v1/orderBookDetails?filter=perp, every perp:
 * [market_id, symbol, size_decimals, price_decimals, min_base_amount,
 *  min_quote_amount, min_initial_margin_fraction, maintenance_margin_fraction,
 *  closeout_margin_fraction, mark_price]. Every one was `status: active`,
 * liquidation_fee "1.0000", default IMF 5000.
 */
type ObdRow = readonly [number, string, number, number, string, string, number, number, number, string];
const OBD_PERP_2026_09_29: readonly ObdRow[] = [
  [0, "ETH", 4, 2, "0.0050", "10.000000", 200, 120, 80, "2680.86"],
  [1, "BTC", 5, 1, "0.00020", "10.000000", 200, 120, 80, "83218.6"],
  [2, "HYPE", 3, 3, "0.100", "10.000000", 500, 300, 200, "86.681"],
  [3, "SOL", 3, 3, "0.100", "10.000000", 400, 240, 160, "118.438"],
  [4, "ZEC", 4, 2, "0.0150", "10.000000", 1000, 600, 400, "1395.22"],
  [5, "LIT", 2, 4, "5.00", "10.000000", 2000, 1200, 800, "4.4617"],
  [6, "XRP", 2, 4, "5.00", "10.000000", 500, 300, 200, "1.5147"],
  [7, "NEAR", 2, 4, "4.00", "10.000000", 1000, 600, 400, "4.9499"],
  [8, "VVV", 3, 3, "0.500", "10.000000", 2000, 1200, 800, "26.834"],
  [9, "SUI", 1, 5, "3.0", "10.000000", 1000, 600, 400, "1.14311"],
  [10, "AAPL", 4, 2, "0.0200", "10.000000", 500, 300, 200, "331.18"],
  [11, "AMZN", 4, 2, "0.0250", "10.000000", 1000, 600, 400, "247.07"],
  [12, "GOOGL", 4, 2, "0.0200", "10.000000", 500, 300, 200, "340.06"],
  [13, "META", 4, 2, "0.0200", "10.000000", 500, 300, 200, "719.74"],
  [14, "MSFT", 4, 2, "0.0200", "10.000000", 500, 300, 200, "508.73"],
  [15, "NVDA", 4, 2, "0.0400", "10.000000", 500, 300, 200, "230.61"],
  [16, "TSLA", 4, 2, "0.0200", "10.000000", 500, 300, 200, "353.62"],
  [17, "ORCL", 4, 2, "0.0400", "10.000000", 1000, 600, 400, "138.86"],
  [18, "SPCX", 4, 2, "0.0400", "10.000000", 500, 300, 200, "149.12"],
  [19, "BABA", 4, 2, "0.0400", "10.000000", 1000, 600, 400, "107.82"],
  [20, "BE", 4, 2, "0.0300", "10.000000", 1000, 600, 400, "298.40"],
  [21, "USAR", 3, 3, "0.300", "10.000000", 1000, 600, 400, "14.103"],
  [22, "USO", 4, 2, "0.0500", "10.000000", 1000, 600, 400, "145.25"],
  [23, "COIN", 4, 2, "0.0025", "10.000000", 1000, 600, 400, "190.40"],
  [24, "CRCL", 3, 3, "0.100", "10.000000", 1000, 600, 400, "84.856"],
  [25, "QQQ", 4, 2, "0.0100", "10.000000", 200, 120, 80, "738.10"],
  [26, "SPY", 4, 2, "0.0100", "10.000000", 200, 120, 80, "764.27"],
  [27, "SGOV", 4, 2, "0.0500", "10.000000", 1000, 600, 400, "100.50"],
  [28, "SLV", 3, 3, "0.100", "10.000000", 1000, 600, 400, "55.024"],
  [29, "AMD", 4, 2, "0.0300", "10.000000", 1000, 600, 400, "613.06"],
  [30, "INTC", 4, 2, "0.0500", "10.000000", 1000, 600, 400, "116.58"],
  [31, "MU", 4, 2, "0.0100", "10.000000", 1000, 600, 400, "1071.46"],
  [32, "SNDK", 4, 2, "0.0100", "10.000000", 1000, 600, 400, "1715.02"],
  [33, "CRWV", 4, 2, "0.0400", "10.000000", 1000, 600, 400, "86.59"],
  [34, "PLTR", 3, 3, "0.050", "10.000000", 1000, 600, 400, "186.044"],
  [35, "SOXL", 4, 2, "0.0300", "10.000000", 500, 300, 200, "148.71"],
  [36, "CASHCAT", 1, 5, "50.0", "10.000000", 3333, 2000, 1333, "0.17744"],
  [37, "SKHY", 4, 2, "0.0500", "10.000000", 1000, 600, 400, "186.83"],
  [38, "ANTHROPIC", 5, 1, "0.00320", "10.000000", 2000, 1200, 800, "2110.7"],
  [39, "ANSEM", 1, 5, "30.0", "10.000000", 3333, 2000, 1333, "0.13796"],
  [40, "XAU", 4, 2, "0.0020", "10.000000", 400, 240, 160, "4158.34"],
  [41, "XAG", 2, 4, "0.15", "10.000000", 400, 240, 160, "60.9831"],
  [42, "OPENAI", 4, 2, "0.0050", "10.000000", 2000, 1200, 800, "1716.25"],
  [43, "SHEIN", 2, 4, "1.00", "10.000000", 2000, 1200, 800, "4.0827"],
  [44, "PONS", 1, 5, "20.0", "10.000000", 3333, 2000, 1333, "0.53320"],
  [45, "AI", 1, 5, "30.0", "10.000000", 3333, 2000, 1333, "0.19980"],
  [46, "TSM", 4, 2, "0.0200", "10.000000", 1000, 600, 400, "457.31"],
  [47, "ASTS", 3, 3, "0.100", "10.000000", 1000, 600, 400, "59.548"],
  [48, "CLSK", 3, 3, "0.500", "10.000000", 1000, 600, 400, "13.455"],
  [49, "IREN", 3, 3, "0.150", "10.000000", 1000, 600, 400, "41.454"],
  [50, "LUNR", 3, 3, "0.500", "10.000000", 1000, 600, 400, "14.912"],
  [51, "QBTS", 3, 3, "0.500", "10.000000", 1000, 600, 400, "16.480"],
  [52, "RGTI", 3, 3, "0.500", "10.000000", 1000, 600, 400, "15.918"],
  [53, "SMCI", 3, 3, "0.200", "10.000000", 1000, 600, 400, "41.566"],
  [54, "SOFI", 3, 3, "0.400", "10.000000", 1000, 600, 400, "15.967"],
  [55, "WULF", 3, 3, "0.500", "10.000000", 1000, 600, 400, "15.191"],
  [56, "AMC", 1, 5, "3.0", "10.000000", 1000, 600, 400, "3.07665"],
];

/** The fixture row as the PerpMarketSpec markets.ts would build from it. */
function specOf(symbol: string): PerpMarketSpec & { mark: bigint } {
  const r = OBD_PERP_2026_09_29.find((row) => row[1] === symbol);
  assert.ok(r, `fixture has ${symbol}`);
  const [marketId, , sd, pd, minBase, minQuote, minImf, mmf, closeout, mark] = r;
  const minBaseAmount = parseDecimalToScaled(minBase, sd);
  const minQuoteMicro = parseMicroUsdg(minQuote);
  const markInt = parseDecimalToScaled(mark, pd);
  assert.ok(minBaseAmount !== null && minQuoteMicro !== null && markInt !== null);
  return {
    marketId,
    sizeDecimals: sd,
    priceDecimals: pd,
    minBaseAmount,
    minQuoteMicro,
    minImfBp: minImf,
    defaultImfBp: 5000,
    mmfBp: mmf,
    closeoutBp: closeout,
    liquidationFeeBp: 100,
    status: "active",
    mark: markInt,
  };
}

/**
 * Every live ISOLATED position (margin_mode 1, non-zero size) in the spike's
 * account reads: 25 from the 5-account scan (scratchpad/spike/venue-signer/
 * tied_scan.json: accounts 36358, 18958, 1176, 4838) and 3 from
 * /api/v1/account?by=index&value=22149 read twice (acct_22149.json and
 * acct_22149_v2.json — the second after an hourly funding debit moved its
 * allocated margin and, with it, the venue's liquidation price).
 *
 * [source, account, symbol, sign, position, avg_entry_price, position_value,
 *  unrealized_pnl, allocated_margin, liquidation_price, initial_margin_fraction (PERCENT)]
 *
 * The scan kept no `sign` column; each scan row's sign was derived from its
 * own unrealized_pnl against position_value − |s| × avg_entry_price. The
 * cost-basis test below re-checks every sign independently.
 */
type IsoRow = readonly [string, number, string, 1 | -1, string, string, string, string, string, string, string];
const ISOLATED_2026_09_29: readonly IsoRow[] = [
  ["tied", 36358, "SPY", -1, "0.5890", "763.91", "449.960660", "-0.016624", "9.033860", "770.009287530953", "2.00"],
  ["tied", 18958, "LIT", 1, "203.63", "4.4376", "902.427071", "-1.204786", "180.963236", "4.032875028460711", "20.00"],
  ["tied", 1176, "AAPL", 1, "0.0243", "332.37", "8.054235", "-0.022477", "1.633129", "273.3690976199567", "20.00"],
  ["tied", 1176, "SPY", -1, "0.0300", "764.01", "22.922700", "-0.002400", "4.584060", "905.9407114624506", "20.00"],
  ["tied", 1176, "ANTHROPIC", -1, "0.00785", "2107.6", "16.547015", "-0.002355", "3.312700", "2258.5714285714284", "20.00"],
  ["tied", 4838, "BTC", 1, "0.01441", "82935.4", "1196.172659", "1.073939", "23.634855", "82282.59341100843", "2.00"],
  ["tied", 4838, "HYPE", -1, "42.489", "86.184", "3660.809751", "1.082686", "182.447609", "87.84318239306712", "5.00"],
  ["tied", 4838, "SOL", 1, "36.704", "118.392", "4338.889952", "-6.554425", "177.379557", "116.35130277934599", "4.00"],
  ["tied", 4838, "ZEC", 1, "0.4837", "1393.99", "674.224593", "-0.048370", "67.536128", "1334.431916653104", "10.00"],
  ["tied", 4838, "LIT", 1, "1745.26", "4.4310", "7731.152748", "-2.174481", "1546.173269", "4.02854404084622", "20.00"],
  ["tied", 4838, "NEAR", -1, "321.83", "4.9714", "1591.738997", "8.214531", "161.048187", "5.1621115888559475", "10.00"],
  ["tied", 4838, "AAPL", -1, "22.7126", "332.05", "7528.318396", "13.393710", "375.587692", "338.4332411529155", "5.00"],
  ["tied", 4838, "GOOGL", 1, "5.4187", "338.99", "1837.101861", "0.195022", "91.674412", "332.0369623025571", "5.00"],
  ["tied", 4838, "META", 1, "0.4692", "719.00", "337.312572", "-0.042228", "16.903399", "704.0969076559355", "5.00"],
  ["tied", 4838, "NVDA", 1, "12.7934", "231.12", "2951.693248", "-5.078598", "153.392484", "225.90412372745678", "5.00"],
  ["tied", 4838, "TSLA", -1, "11.9448", "354.78", "4236.701112", "1.046901", "210.631650", "361.5644637663349", "5.00"],
  ["tied", 4838, "ORCL", 1, "12.3489", "139.65", "1723.782951", "-0.690774", "176.709606", "133.33637598525013", "10.00"],
  ["tied", 4838, "SPCX", -1, "67.3537", "148.67", "10012.127505", "1.361259", "513.923697", "151.74799301430178", "5.00"],
  ["tied", 4838, "CRCL", 1, "13.889", "84.744", "1179.745549", "2.742808", "117.578480", "81.14674103032706", "10.00"],
  ["tied", 4838, "QQQ", -1, "0.7159", "738.60", "528.312723", "0.448691", "10.437039", "744.2447205678802", "2.00"],
  ["tied", 4838, "SPY", 1, "8.3981", "766.30", "6417.492096", "-17.989792", "147.491853", "757.8336032677914", "2.00"],
  ["tied", 4838, "AMD", 1, "0.3530", "614.37", "216.526670", "-0.345940", "21.738093", "588.0734042553191", "10.00"],
  ["tied", 4838, "SNDK", 1, "2.3596", "1713.66", "4024.510164", "-19.031862", "421.079386", "1633.193617381958", "10.00"],
  ["tied", 4838, "ANTHROPIC", -1, "4.74530", "2108.3", "10002.617870", "1.910616", "2003.420285", "2259.3688136155774", "20.00"],
  ["tied", 4838, "XAG", 1, "46.21", "60.9138", "2814.983812", "0.156868", "113.433527", "59.896583509530615", "4.00"],
  ["acct", 22149, "NVDA", 1, "3.9685", "230.83", "916.683815", "0.647589", "76.476136", "218.0989960890466", "8.33"],
  ["acct", 22149, "QQQ", 1, "1.2054", "739.09", "890.031198", "-0.873438", "74.277343", "685.702541162609", "8.33"],
  ["v2", 22149, "NVDA", 1, "3.9685", "230.83", "914.818620", "-1.217606", "76.465162", "218.10184714939425", "8.33"],
];

/**
 * Two real API public keys from the official signer (lighter-go v1.0.9 WASM):
 * the `pubkey:` lines of SignChangePubKey's messageToSign in the spike
 * (spike-node22.json changePubKeySelf / changePubKeyOtherKey), each paired
 * with the base64 PubKey the same call put in its signed tx_info.
 */
const PUBKEY_VECTORS = [
  {
    hex: "0x2427c4493c2df1a3ecdd750f1398b865e5428907c41065f0612cb3fa6b5ea0d7ac00465b07f3acd7",
    txInfoB64: "JCfESTwt8aPs3XUPE5i4ZeVCiQfEEGXwYSyz+mteoNesAEZbB/Os1w==",
  },
  {
    hex: "0x3fba6f2e6d1cc97965c00bcb9032ffbd408f77cfb929db0a49d4abd0b090426efb651217ad43f02d",
    txInfoB64: "P7pvLm0cyXllwAvLkDL/vUCPd8+5KdsKSdSr0LCQQm77ZRIXrUPwLQ==",
  },
] as const;

const PK = PUBKEY_VECTORS[0].hex;

/** 40 key bytes from five u64 limbs, little-endian, as hex (no 0x). */
function limbsHex(limbs: readonly bigint[]): string {
  return limbs
    .map((l) => {
      let s = "";
      for (let i = 0; i < 8; i++) s += ((l >> BigInt(8 * i)) & 0xffn).toString(16).padStart(2, "0");
      return s;
    })
    .join("");
}

// ── the route ───────────────────────────────────────────────────────────────

describe("LIGHTER_ROUTE_V1 is the venue as probed, frozen", () => {
  it("names the Robinhood instance on 4663 and signs for 466324", () => {
    assert.equal(GRANT_PERP_LIGHTER, "perp-lighter-v1");
    assert.equal(LIGHTER_ROUTE_V1.chainId, 4663);
    assert.equal(LIGHTER_ROUTE_V1.l2ChainId, 466324);
    assert.equal(LIGHTER_ROUTE_V1.proxy, "0x94bab9693ba2f6358507effcbd372b0660afff9d");
    assert.equal(LIGHTER_ROUTE_V1.apiBase, "https://api.rh.lighter.xyz");
    assert.equal(LIGHTER_ROUTE_V1.wsUrl, "wss://api.rh.lighter.xyz/stream");
    assert.equal(LIGHTER_ROUTE_V1.assetIndex, 3);
    assert.equal(LIGHTER_ROUTE_V1.routePerps, 0);
    assert.equal(LIGHTER_ROUTE_V1.usdgTickSize, 1);
    assert.equal(LIGHTER_ROUTE_V1.minDepositMicro, 1_000_000n);
  });

  it("collateral is the same USDG the rest of merrymen holds", () => {
    // Two spellings of one address are two chances to disagree; this is the
    // one place perps and spot must agree on what cash is.
    assert.equal(LIGHTER_ROUTE_V1.usdg, CASH.USDG.toLowerCase());
  });

  it("every address is lowercase and every level is frozen", () => {
    for (const a of [LIGHTER_ROUTE_V1.proxy, LIGHTER_ROUTE_V1.usdg]) assert.equal(a, a.toLowerCase());
    assert.ok(Object.isFrozen(LIGHTER_ROUTE_V1));
    assert.ok(Object.isFrozen(LIGHTER_ROUTE_V1.topics));
    assert.ok(Object.isFrozen(LIGHTER_ROUTE_V1.reservedKeyIndexes));
  });

  it("the key index is fixed, in range, and never one Lighter reserves", () => {
    assert.equal(LIGHTER_ROUTE_V1.apiKeyIndex, 16);
    assert.deepEqual([...LIGHTER_ROUTE_V1.reservedKeyIndexes], [0, 1, 2, 3, 157]);
    assert.ok(!(LIGHTER_ROUTE_V1.reservedKeyIndexes as readonly number[]).includes(LIGHTER_ROUTE_V1.apiKeyIndex));
    assert.ok(LIGHTER_ROUTE_V1.apiKeyIndex <= 254, "255 is the signer's nil index: 'the last client created'");
  });

  it("topic hashes equal viem's keccak of the event signatures and of the event ABI", () => {
    const deposit = keccak256(toBytes("Deposit(uint48,address,uint16,uint8,uint128)"));
    const withdrawPending = keccak256(toBytes("WithdrawPending(address,uint16,uint128)"));
    assert.equal(LIGHTER_ROUTE_V1.topics.deposit, deposit);
    assert.equal(LIGHTER_ROUTE_V1.topics.withdrawPending, withdrawPending);
    assert.equal(withdrawPending, "0xef80235b5f4cf1822ad6a8621af41ac64372ff672c402874f507fc63dbe5e06f");
    const [depEv, wpEv] = LIGHTER_EVENTS_ABI;
    assert.equal(toEventSelector(depEv), deposit);
    assert.equal(toEventSelector(wpEv), withdrawPending);
  });
});

// ── ABIs ────────────────────────────────────────────────────────────────────

describe("Lighter ABIs carry the deployed selectors", () => {
  it("granted constants hold exactly one function each", () => {
    // The call-policy builder resolves by name; a second function in a granted
    // list is a second thing a permission could be built from.
    for (const abi of [LIGHTER_DEPOSIT_ABI, LIGHTER_CHANGE_PUBKEY_ABI, LIGHTER_WITHDRAW_PENDING_ABI]) {
      assert.equal(abi.length, 1);
      assert.equal(abi[0].type, "function");
    }
  });

  it("selectors match the ones extracted from the proxy's implementation bytecode", () => {
    assert.equal(toFunctionSelector(LIGHTER_DEPOSIT_ABI[0]), "0x8a857083");
    assert.equal(toFunctionSelector(LIGHTER_CHANGE_PUBKEY_ABI[0]), "0x17010c68");
    assert.equal(toFunctionSelector(LIGHTER_WITHDRAW_PENDING_ABI[0]), "0x2f25807e");
    const recover = Object.fromEntries(LIGHTER_OWNER_RECOVER_ABI.map((f) => [f.name, toFunctionSelector(f)]));
    assert.deepEqual(recover, { withdraw: "0xd20191bd", cancelAllOrders: "0xa4b6f756", createOrder: "0x3c40c676" });
    const read = Object.fromEntries(LIGHTER_READ_ABI.map((f) => [f.name, toFunctionSelector(f)]));
    assert.deepEqual(read, { addressToAccountIndex: "0xabf6a038", getPendingBalance: "0xd1cbc64f", assetConfigs: "0xcd565e08" });
  });

  it("deposit encodes the four words the wall pins", () => {
    const self = "0x1111111111111111111111111111111111111111";
    const data = encodeFunctionData({ abi: LIGHTER_DEPOSIT_ABI, functionName: "deposit", args: [self, 3, 0, 25_000_000n] });
    const words = data.slice(10).match(/.{64}/g) ?? [];
    assert.equal(words.length, 4);
    assert.equal(BigInt(`0x${words[0]}`), BigInt(self));
    assert.equal(BigInt(`0x${words[1]}`), 3n);
    assert.equal(BigInt(`0x${words[2]}`), 0n);
    assert.equal(BigInt(`0x${words[3]}`), 25_000_000n);
  });

  it("WithdrawPending indexes the owner, so a payout to us is a topic1 match", () => {
    const owner = "0x8e93b78e0000000000000000000000000000beef";
    const log = decodeEventLog({
      abi: LIGHTER_EVENTS_ABI,
      topics: [LIGHTER_ROUTE_V1.topics.withdrawPending, pad(owner)],
      data: encodeAbiParameters([{ type: "uint16" }, { type: "uint128" }], [3, 5_000_000n]),
    });
    assert.equal(log.eventName, "WithdrawPending");
    const args = log.args as { owner: string; assetIndex: number; baseAmount: bigint };
    assert.equal(args.owner.toLowerCase(), owner);
    assert.equal(args.assetIndex, 3);
    assert.equal(args.baseAmount, 5_000_000n);
  });

  it("Deposit indexes nothing: all five fields are in data", () => {
    const to = "0x8e93b78e0000000000000000000000000000beef";
    const log = decodeEventLog({
      abi: LIGHTER_EVENTS_ABI,
      topics: [LIGHTER_ROUTE_V1.topics.deposit],
      data: encodeAbiParameters(
        [{ type: "uint48" }, { type: "address" }, { type: "uint16" }, { type: "uint8" }, { type: "uint128" }],
        [22149, to, 3, 0, 82_973_191n],
      ),
    });
    assert.equal(log.eventName, "Deposit");
    const args = log.args as { toAccountIndex: number; assetIndex: number; routeType: number; baseAmount: bigint };
    assert.equal(args.toAccountIndex, 22149);
    assert.equal(args.assetIndex, 3);
    assert.equal(args.routeType, 0);
    assert.equal(args.baseAmount, 82_973_191n);
  });
});

// ── markets ─────────────────────────────────────────────────────────────────

describe("LIGHTER_MARKETS_V1 is every perp the venue listed, and nothing else", () => {
  it("all 57 fixture perps are present with the venue's id and symbol", () => {
    assert.equal(LIGHTER_MARKETS_V1.length, 57);
    assert.equal(OBD_PERP_2026_09_29.length, 57);
    for (const [id, symbol] of OBD_PERP_2026_09_29) {
      const m = perpMarketById(id);
      assert.ok(m, `market ${id} ${symbol}`);
      assert.equal(m.symbol, symbol);
      assert.equal(m.key, `${symbol}-PERP`);
      assert.equal(perpMarketByKey(`${symbol}-PERP`), m);
    }
  });

  it("ids and keys are unique, and no spot id (≥ 2048) is in the table", () => {
    assert.equal(new Set(LIGHTER_MARKETS_V1.map((m) => m.marketId)).size, 57);
    assert.equal(new Set(LIGHTER_MARKETS_V1.map((m) => m.key)).size, 57);
    for (const m of LIGHTER_MARKETS_V1) assert.ok(m.marketId >= 0 && m.marketId < 2048);
    assert.equal(perpMarketById(2048), null);
    assert.equal(perpMarketById(2049), null);
  });

  it("the anchors the contract names", () => {
    assert.equal(perpMarketByKey("ETH-PERP")?.marketId, 0);
    assert.equal(perpMarketByKey("BTC-PERP")?.marketId, 1);
    assert.equal(perpMarketByKey("SOL-PERP")?.marketId, 3);
  });

  it("the table is frozen, row by row", () => {
    assert.ok(Object.isFrozen(LIGHTER_MARKETS_V1));
    for (const m of LIGHTER_MARKETS_V1) assert.ok(Object.isFrozen(m));
  });

  it("lookups are exact: bare symbols and case variants are not keys", () => {
    assert.equal(perpMarketByKey("BTC"), null);
    assert.equal(perpMarketByKey("btc-perp"), null);
    assert.equal(perpMarketByKey("FOO-PERP"), null);
    assert.equal(perpMarketById(-1), null);
    assert.equal(perpMarketById(57), null);
  });

  it("isPerpKey is membership, not shape", () => {
    assert.equal(isPerpKey("BTC-PERP"), true);
    assert.equal(isPerpKey("FOO-PERP"), false);
    assert.equal(isPerpKey("TSLA"), false);
    assert.equal(isPerpKey(1), false);
    assert.equal(isPerpKey(null), false);
    for (const k of PERP_TREND_UNIVERSE) assert.ok(isPerpKey(k), k);
    assert.deepEqual([...PERP_TREND_UNIVERSE], ["BTC-PERP", "ETH-PERP", "SOL-PERP"]);
  });

  it("the judgement-call classes", () => {
    const cls = (s: string) => perpMarketByKey(`${s}-PERP`)?.cls;
    for (const s of ["ETH", "BTC", "HYPE", "SOL", "ZEC", "LIT", "XRP", "NEAR", "VVV", "SUI"]) assert.equal(cls(s), "crypto", s);
    for (const s of ["CASHCAT", "ANSEM", "AI", "PONS"]) assert.equal(cls(s), "meme", s);
    for (const s of ["ANTHROPIC", "OPENAI", "SHEIN"]) assert.equal(cls(s), "pre-ipo", s);
    for (const s of ["SPY", "QQQ", "SOXL", "SGOV", "SLV", "USO"]) assert.equal(cls(s), "etf", s);
    for (const s of ["XAU", "XAG"]) assert.equal(cls(s), "metal", s);
    // SPCX is tagged STOCK by Lighter (the SpaceX pre-IPO market is a separate
    // SPACEX listing) and sits in the listed large caps' 500 tier.
    for (const s of ["SPCX", "SKHY", "AAPL", "TSLA", "NVDA", "AMC", "BE", "USAR"]) assert.equal(cls(s), "equity", s);
  });

  it("classes agree with the venue's margin tiers where the tiers are distinctive", () => {
    // Not a rule the venue promises — a tripwire. A meme outside the 3333 tier,
    // or a pre-IPO name inside a listed-stock tier, means a class was misread.
    for (const [id, , , , , , minImf] of OBD_PERP_2026_09_29) {
      const m = perpMarketById(id);
      assert.ok(m);
      if (m.cls === "meme") assert.equal(minImf, 3333, m.key);
      if (m.cls === "pre-ipo") assert.equal(minImf, 2000, m.key);
      if (minImf === 3333) assert.equal(m.cls, "meme", m.key);
    }
  });
});

// ── the API key the wall seals ──────────────────────────────────────────────

describe("validatePerpPubKey accepts exactly the keys changePubKey accepts", () => {
  it("real signer keys pass, and the tx_info's base64 bytes are the same bytes in the same order", () => {
    for (const v of PUBKEY_VECTORS) {
      assert.equal(validatePerpPubKey(v.hex), v.hex);
      assert.equal(`0x${Buffer.from(v.txInfoB64, "base64").toString("hex")}`, v.hex);
    }
  });

  it("canonicalises: bare and upper-case inputs become 0x + lowercase", () => {
    assert.equal(validatePerpPubKey(PK.slice(2)), PK);
    assert.equal(validatePerpPubKey(`0x${PK.slice(2).toUpperCase()}`), PK);
  });

  it("rejects the wrong length, non-hex and doubled prefixes", () => {
    assert.equal(validatePerpPubKey(PK.slice(0, -2)), null);
    assert.equal(validatePerpPubKey(`${PK}00`), null);
    assert.equal(validatePerpPubKey(`0x${"g".repeat(80)}`), null);
    assert.equal(validatePerpPubKey(`0x0x${PK.slice(4)}`), null);
    assert.equal(validatePerpPubKey(""), null);
    assert.equal(validatePerpPubKey(123 as unknown as string), null);
  });

  it("rejects the all-zero key", () => {
    assert.equal(validatePerpPubKey(`0x${"0".repeat(80)}`), null);
  });

  it("limbs are LITTLE-endian and each must be < p", () => {
    assert.equal(GOLDILOCKS_P, 18446744069414584321n);
    // p − 1 is the largest field element: accepted in any limb.
    assert.ok(validatePerpPubKey(limbsHex([1n, 2n, GOLDILOCKS_P - 1n, 3n, 4n])));
    // p itself, and 2^64 − 1, are not.
    assert.equal(validatePerpPubKey(limbsHex([1n, 2n, GOLDILOCKS_P, 3n, 4n])), null);
    assert.equal(validatePerpPubKey(limbsHex([2n ** 64n - 1n, 0n, 0n, 0n, 1n])), null);
    // The byte pattern that is < p read little-endian but ≥ p read big-endian:
    // 0x01000000ffffffff LE = 0xffffffff00000001 = p → rejected; its mirror is
    // 0xffffffff00000001 LE = 0x01000000ffffffff < p → accepted.
    assert.equal(validatePerpPubKey(`${"01000000ffffffff"}${"01".padEnd(16, "0").repeat(4)}`), null);
    assert.ok(validatePerpPubKey(`${"ffffffff00000001"}${"01".padEnd(16, "0").repeat(4)}`));
  });
});

describe("pubKeyWords are words 4 and 5 of changePubKey's calldata", () => {
  it("proved against viem's encoder for both real keys", () => {
    for (const { hex } of PUBKEY_VECTORS) {
      const data = encodeFunctionData({
        abi: LIGHTER_CHANGE_PUBKEY_ABI,
        functionName: "changePubKey",
        args: [22149, LIGHTER_ROUTE_V1.apiKeyIndex, hex],
      });
      assert.equal(data.slice(0, 10), "0x17010c68");
      const word = (i: number) => `0x${data.slice(10 + 64 * i, 10 + 64 * (i + 1))}`;
      assert.equal((data.length - 10) / 64, 6, "exactly six words");
      assert.equal(BigInt(word(0)), 22149n);
      assert.equal(BigInt(word(1)), 16n);
      assert.equal(BigInt(word(2)), 0x60n, "the offset the wall pins");
      assert.equal(BigInt(word(3)), 40n, "the length the wall pins");
      const [w4, w5] = pubKeyWords(hex);
      assert.equal(word(4), w4);
      assert.equal(word(5), w5);
      assert.equal(w4.length, 66);
      assert.equal(w5.length, 66);
      assert.ok(w5.endsWith("0".repeat(48)), "right-padded, as ABI bytes are");
    }
  });

  it("refuses to build words for a key the contract would reject", () => {
    assert.throws(() => pubKeyWords(`0x${"0".repeat(80)}`), RangeError);
    assert.throws(() => pubKeyWords("0x1234"), RangeError);
  });
});

describe("grantPerp: marker, chain, route, index and key — all or nothing", () => {
  const good = {
    grantFeatures: ["tradeable-v2", GRANT_PERP_LIGHTER],
    chainId: 4663,
    perp: { route: GRANT_PERP_LIGHTER, apiKeyIndex: 16, apiPublicKey: PK, apiKeySealed: "sealed-blob" },
  };

  it("a complete grant yields exactly the whitelisted fields", () => {
    assert.deepEqual(grantPerp(good), { route: "perp-lighter-v1", apiKeyIndex: 16, apiPublicKey: PK, apiKeySealed: "sealed-blob" });
  });

  it("never carries a private key through, whatever else the block holds", () => {
    const out = grantPerp({ ...good, perp: { ...good.perp, apiPrivateKey: "0xdeadbeef", extra: 1 } });
    assert.ok(out);
    assert.deepEqual(Object.keys(out).sort(), ["apiKeyIndex", "apiKeySealed", "apiPublicKey", "route"]);
  });

  it("self-hosted grants have no sealed blob, and that is fine", () => {
    const { apiKeySealed: _drop, ...perp } = good.perp;
    assert.deepEqual(grantPerp({ ...good, perp }), { route: "perp-lighter-v1", apiKeyIndex: 16, apiPublicKey: PK });
  });

  it("canonicalises the stored key", () => {
    assert.equal(grantPerp({ ...good, perp: { ...good.perp, apiPublicKey: PK.slice(2).toUpperCase() } })?.apiPublicKey, PK);
  });

  it("any one missing piece is no grant", () => {
    assert.equal(grantPerp(null), null);
    assert.equal(grantPerp(undefined), null);
    assert.equal(grantPerp({ ...good, grantFeatures: ["tradeable-v2"] }), null);
    assert.equal(grantPerp({ ...good, grantFeatures: undefined }), null);
    assert.equal(grantPerp({ ...good, chainId: 46630 }), null);
    assert.equal(grantPerp({ ...good, perp: undefined }), null);
    assert.equal(grantPerp({ ...good, perp: "perp-lighter-v1" }), null);
    assert.equal(grantPerp({ ...good, perp: { ...good.perp, route: "perp-lighter-v2" } }), null);
    assert.equal(grantPerp({ ...good, perp: { ...good.perp, apiKeyIndex: 17 } }), null);
    assert.equal(grantPerp({ ...good, perp: { ...good.perp, apiKeyIndex: "16" } }), null);
    assert.equal(grantPerp({ ...good, perp: { ...good.perp, apiPublicKey: `0x${"0".repeat(80)}` } }), null);
    assert.equal(grantPerp({ ...good, perp: { ...good.perp, apiPublicKey: undefined } }), null);
    assert.equal(grantPerp({ ...good, perp: { ...good.perp, apiKeySealed: 42 } }), null);
    assert.equal(grantPerp({ ...good, perp: { ...good.perp, apiKeySealed: "" } }), null);
  });
});

// ── nonces and COIs ─────────────────────────────────────────────────────────

describe("perpCoi = nonce × 8 + leg, bounded below 2^48", () => {
  it("legs", () => {
    assert.deepEqual({ ...PERP_LEG }, { entry: 0, sl: 1, tp: 2, close: 3 });
    const n = 1790696714356n; // a live millisecond SkipNonce nonce (account 6560, key 6)
    assert.equal(perpCoi(n, PERP_LEG.entry), n * 8n);
    assert.equal(perpCoi(n, PERP_LEG.sl), n * 8n + 1n);
    assert.equal(perpCoi(n, PERP_LEG.tp), n * 8n + 2n);
    assert.equal(perpCoi(n, PERP_LEG.close), n * 8n + 3n);
  });

  it("distinct nonces never share a COI, whichever legs", () => {
    const seen = new Set<bigint>();
    for (let n = 1n; n <= 50n; n++) for (const leg of [0, 1, 2, 3] as const) seen.add(perpCoi(n, leg));
    assert.equal(seen.size, 200);
  });

  it("throws rather than wrapping or colliding", () => {
    assert.equal(PERP_COI_MAX, 2n ** 48n - 1n);
    assert.throws(() => perpCoi(0n, 0), RangeError);
    assert.throws(() => perpCoi(-5n, 0), RangeError);
    assert.throws(() => perpCoi(2n ** 45n, 0), RangeError, "2^45 × 8 = 2^48");
    assert.equal(perpCoi(2n ** 45n - 1n, 3), 2n ** 48n - 5n);
    assert.throws(() => perpCoi(5n, 4 as 0), RangeError);
    assert.throws(() => perpCoi(5 as unknown as bigint, 0), RangeError);
  });
});

// ── parsing ─────────────────────────────────────────────────────────────────

describe("parseMicroUsdg is exact or null — never a float", () => {
  it("documented 6-dp amounts", () => {
    assert.equal(parseMicroUsdg("72.497126"), 72_497_126n);
    assert.equal(parseMicroUsdg("-0.5"), -500_000n);
    assert.equal(parseMicroUsdg("1"), 1_000_000n);
    assert.equal(parseMicroUsdg("0.000001"), 1n);
    assert.equal(parseMicroUsdg("-0.000000"), 0n);
    assert.equal(parseMicroUsdg("281474976.710655"), 281_474_976_710_655n);
  });

  it("everything else is unread", () => {
    // Lighter's float-rendered total_asset_value: not a number it booked.
    assert.equal(parseMicroUsdg("1679.8316029999999"), null);
    assert.equal(parseMicroUsdg("1."), null);
    assert.equal(parseMicroUsdg(".5"), null);
    assert.equal(parseMicroUsdg("1.0000001"), null);
    assert.equal(parseMicroUsdg("+1"), null);
    assert.equal(parseMicroUsdg(" 1"), null);
    assert.equal(parseMicroUsdg("1e6"), null);
    assert.equal(parseMicroUsdg("--1"), null);
    assert.equal(parseMicroUsdg(""), null);
    assert.equal(parseMicroUsdg(1), null);
    assert.equal(parseMicroUsdg(1.5), null);
    assert.equal(parseMicroUsdg(null), null);
    assert.equal(parseMicroUsdg(undefined), null);
    assert.equal(parseMicroUsdg(1n), null);
  });
});

describe("parseDecimalToScaled: pad fewer decimals, refuse more", () => {
  it("venue strings at their declared precision", () => {
    assert.equal(parseDecimalToScaled("83218.6", 1), 832186n);
    assert.equal(parseDecimalToScaled("0.00020", 5), 20n);
    assert.equal(parseDecimalToScaled("0.0002", 5), 20n);
    assert.equal(parseDecimalToScaled("5", 0), 5n);
    assert.equal(parseDecimalToScaled("-1.5", 2), -150n);
  });

  it("more decimals than allowed, or a bad precision, is null", () => {
    assert.equal(parseDecimalToScaled("0.00020", 4), null);
    assert.equal(parseDecimalToScaled("5.0", 0), null);
    assert.equal(parseDecimalToScaled("1", -1), null);
    assert.equal(parseDecimalToScaled("1", 1.5), null);
    assert.equal(parseDecimalToScaled("1,5", 2), null);
    assert.equal(parseDecimalToScaled(1.5, 2), null);
    assert.equal(parseDecimalToScaled("9".repeat(101), 0), null);
  });

  it("every fixture mark, minimum size and quote minimum parses at its market's precision", () => {
    for (const [, sym, sd, pd, minBase, minQuote, , , , mark] of OBD_PERP_2026_09_29) {
      assert.notEqual(parseDecimalToScaled(mark, pd), null, `${sym} mark`);
      assert.notEqual(parseDecimalToScaled(minBase, sd), null, `${sym} min base`);
      assert.equal(parseMicroUsdg(minQuote), 10_000_000n, `${sym} min quote`);
    }
  });
});

describe("imfPercentToBp — a position's IMF is a PERCENT string", () => {
  it("normalises to 1/10000", () => {
    assert.equal(imfPercentToBp("8.33"), 833);
    assert.equal(imfPercentToBp("20.00"), 2000);
    assert.equal(imfPercentToBp("2.00"), 200);
    assert.equal(imfPercentToBp("100"), 10_000);
  });

  it("refuses what cannot be a margin fraction", () => {
    assert.equal(imfPercentToBp("0"), null);
    assert.equal(imfPercentToBp("100.01"), null);
    assert.equal(imfPercentToBp("8.333"), null);
    assert.equal(imfPercentToBp(833), null);
  });
});

// ── integer math ────────────────────────────────────────────────────────────

/** A spec whose decimals sum past 6, so base × price is NOT whole micro and rounding shows. */
const COARSE: Pick<PerpMarketSpec, "sizeDecimals" | "priceDecimals"> = { sizeDecimals: 5, priceDecimals: 3 };

describe("notional and size: exposure up, size down", () => {
  it("every live market has sizeDecimals + priceDecimals = 6, so base × price is exact micro", () => {
    for (const [, sym, sd, pd] of OBD_PERP_2026_09_29) {
      assert.equal(sd + pd, 6, sym);
      const spec = specOf(sym);
      assert.equal(notionalMicro(123n, spec.mark, spec, "floor"), notionalMicro(123n, spec.mark, spec, "ceil"));
    }
  });

  it("notional rounds UP by default, floor only when asked", () => {
    assert.equal(notionalMicro(1n, 1n, COARSE), 1n); // 0.01 micro
    assert.equal(notionalMicro(1n, 1n, COARSE, "floor"), 0n);
    assert.equal(notionalMicro(0n, 5n, COARSE), 0n);
    const btc = specOf("BTC");
    assert.equal(notionalMicro(20n, btc.mark, btc), 16_643_720n); // 0.0002 BTC × 83218.6
    assert.throws(() => notionalMicro(-1n, 1n, btc), RangeError);
  });

  it("baseForNotional floors, so the size never exceeds the cap; ceil reaches a minimum", () => {
    const btc = specOf("BTC");
    const cap = 25_000_000n;
    const lo = baseForNotional(cap, btc.mark, btc);
    const hi = baseForNotional(cap, btc.mark, btc, "ceil");
    assert.equal(lo, 30n);
    assert.equal(hi, 31n);
    assert.ok(notionalMicro(lo, btc.mark, btc) <= cap);
    assert.ok(notionalMicro(hi, btc.mark, btc) >= cap);
    assert.throws(() => baseForNotional(cap, 0n, btc), RangeError);
  });

  it("the effective minimum is max(min quote, min base × price)", () => {
    // BTC and ETH bind on size (≈16.6 and ≈13.4 USDG), XRP on the 10 USDG quote.
    assert.equal(effectiveMinNotionalMicro(specOf("BTC"), specOf("BTC").mark), 16_643_720n);
    assert.equal(effectiveMinNotionalMicro(specOf("ETH"), specOf("ETH").mark), 13_404_300n);
    assert.equal(effectiveMinNotionalMicro(specOf("LIT"), specOf("LIT").mark), 22_308_500n);
    assert.equal(effectiveMinNotionalMicro(specOf("XRP"), specOf("XRP").mark), 10_000_000n);
  });

  it("minOpenBase clears both minimums for every market", () => {
    for (const [, sym] of OBD_PERP_2026_09_29) {
      const s = specOf(sym);
      const b = minOpenBase(s, s.mark);
      assert.ok(b >= s.minBaseAmount, sym);
      assert.ok(notionalMicro(b, s.mark, s) >= effectiveMinNotionalMicro(s, s.mark), sym);
    }
  });
});

describe("leverageTarget — L = min(setting, venue max, 10), IMF rounded up", () => {
  it("BTC (min IMF 200): the owner's setting governs, up to 10", () => {
    const btc = specOf("BTC");
    assert.deepEqual(leverageTarget(2, btc), { leverage: 2, imfBp: 5000 });
    assert.deepEqual(leverageTarget(10, btc), { leverage: 10, imfBp: 1000 });
    assert.deepEqual(leverageTarget(50, btc), { leverage: 10, imfBp: 1000 }, "never above 10, whatever the venue allows");
    assert.deepEqual(leverageTarget(1, btc), { leverage: 1, imfBp: 10_000 });
  });

  it("a meme market (min IMF 3333) caps at 3x, at 3334 bp — not the SDK's 3333", () => {
    const cat = specOf("CASHCAT");
    assert.deepEqual(leverageTarget(10, cat), { leverage: 3, imfBp: 3334 });
    assert.deepEqual(leverageTarget(2, cat), { leverage: 2, imfBp: 5000 });
  });

  it("the venue's own tiers: SOL 25x, LIT 5x", () => {
    assert.deepEqual(leverageTarget(10, specOf("SOL")), { leverage: 10, imfBp: 1000 });
    assert.deepEqual(leverageTarget(10, specOf("LIT")), { leverage: 5, imfBp: 2000 });
    assert.deepEqual(leverageTarget(7, specOf("BTC")), { leverage: 7, imfBp: 1429 });
  });

  it("for every market and setting: IMF ≥ the market minimum and applied leverage ≤ L ≤ setting", () => {
    for (const [, sym] of OBD_PERP_2026_09_29) {
      const s = specOf(sym);
      for (let setting = 1; setting <= 10; setting++) {
        const { leverage, imfBp } = leverageTarget(setting, s);
        assert.ok(leverage <= setting && leverage >= 1, `${sym} ${setting}`);
        assert.ok(imfBp >= s.minImfBp, `${sym} ${setting}`);
        assert.ok(10_000 / imfBp <= leverage, `${sym} ${setting}`);
      }
    }
  });

  it("settings that are not positive integers throw", () => {
    const btc = specOf("BTC");
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) assert.throws(() => leverageTarget(bad, btc), RangeError);
    assert.throws(() => leverageTarget(2, { minImfBp: 0 }), RangeError);
  });

  it("display leverage is floor(1_000_000 / imfBp) / 100", () => {
    assert.equal(leverageFromImfBp(5000), 2);
    assert.equal(leverageFromImfBp(3334), 2.99);
    assert.equal(leverageFromImfBp(1429), 6.99);
    assert.equal(leverageFromImfBp(833), 12);
  });
});

describe("isolated margin rounds UP", () => {
  it("rounding and a live vector", () => {
    assert.equal(isolatedMarginMicro(10_000_001n, 5000), 5_000_001n);
    assert.equal(isolatedMarginMicro(10_000_000n, 5000), 5_000_000n);
    // Account 1176's SPY short at 20% IMF: notional 0.03 × 764.01 = 22.9203,
    // allocated_margin read back as exactly 4.584060.
    const spy = specOf("SPY");
    assert.equal(isolatedMarginMicro(notionalMicro(300n, 76401n, spy), 2000), 4_584_060n);
    assert.throws(() => isolatedMarginMicro(1n, 0), RangeError);
    assert.throws(() => isolatedMarginMicro(1n, 10_001), RangeError);
  });
});

/** Venue liquidation_price (a float-rendered string) in units of 10^-24 tick, for exact comparison. */
const FINE = 24;
function venueFine(liq: string, pd: number): bigint {
  const v = parseDecimalToScaled(liq, FINE);
  assert.ok(v !== null, liq);
  // v is liq × 10^24; the tick is 10^-pd, so v is already in 10^-(24 − pd) ticks.
  return v;
}

describe("isolated liquidation price reproduces the venue's, live positions", () => {
  it("from the exact cost basis: within one tick of every venue liquidation_price, on the entry side", () => {
    for (const [src, acct, sym, sign, pos, avgEntry, pv, upnl, am, liq] of ISOLATED_2026_09_29) {
      const spec = specOf(sym);
      const base = parseDecimalToScaled(pos, spec.sizeDecimals);
      const pvMicro = parseMicroUsdg(pv);
      const uMicro = parseMicroUsdg(upnl);
      const amMicro = parseMicroUsdg(am);
      assert.ok(base !== null && pvMicro !== null && uMicro !== null && amMicro !== null);
      // |s| × entry = position_value − sign × unrealized_pnl, exactly.
      const cost = pvMicro - BigInt(sign) * uMicro;
      // The sign check that does not depend on the liquidation price: the
      // cost basis must sit within half a tick × |s| of |s| × avg_entry_price.
      const shown = notionalMicro(base, parseDecimalToScaled(avgEntry, spec.priceDecimals) ?? 0n, spec);
      const halfTickCost = (base * 1_000_000n) / (2n * 10n ** BigInt(spec.sizeDecimals + spec.priceDecimals)) + 1n;
      assert.ok((cost > shown ? cost - shown : shown - cost) <= halfTickCost, `${src} ${acct} ${sym}: sign`);
      const side: PerpSide = sign === 1 ? "long" : "short";
      const ours = isolatedLiqPriceFromCost({
        side,
        entryCostMicro: cost,
        baseAmount: base,
        allocatedMarginMicro: amMicro,
        mmfBp: spec.mmfBp,
        spec,
      });
      assert.ok(ours !== null, `${acct} ${sym}`);
      const scale = 10n ** BigInt(FINE - spec.priceDecimals);
      const venue = venueFine(liq, spec.priceDecimals);
      const diff = ours * scale - venue; // in 10^-(24−pd) ticks
      assert.ok((diff < 0n ? -diff : diff) < scale, `${src} ${acct} ${sym}: ${ours} vs ${liq} — more than one tick`);
      // Conservative side: a long's estimate is at or above the venue's, a
      // short's at or below (allowing a millionth of a tick of float noise in
      // the venue's own string).
      const noise = scale / 1_000_000n;
      if (side === "long") assert.ok(diff >= -noise, `${acct} ${sym}: long estimate below venue`);
      else assert.ok(diff <= noise, `${acct} ${sym}: short estimate above venue`);
    }
  });

  it("from the displayed (tick-rounded) avg_entry_price: off by at most the half tick that rounding hides", () => {
    // At open we know the entry exactly (the IOC worst price). For a position
    // the venue holds, avg_entry_price is rounded to the tick, which moves the
    // estimate by up to half a tick / (1 ∓ MMF) on top of our one tick of
    // rounding. This pins that bound, so a formula error cannot hide in it.
    for (const [src, acct, sym, sign, pos, avgEntry, , , am, liq] of ISOLATED_2026_09_29) {
      const spec = specOf(sym);
      const base = parseDecimalToScaled(pos, spec.sizeDecimals);
      const entry = parseDecimalToScaled(avgEntry, spec.priceDecimals);
      const amMicro = parseMicroUsdg(am);
      assert.ok(base !== null && entry !== null && amMicro !== null);
      const side: PerpSide = sign === 1 ? "long" : "short";
      const ours = isolatedLiqPrice({ side, entryPrice: entry, baseAmount: base, allocatedMarginMicro: amMicro, mmfBp: spec.mmfBp, spec });
      assert.ok(ours !== null);
      const scale = 10n ** BigInt(FINE - spec.priceDecimals);
      const diff = ours * scale - venueFine(liq, spec.priceDecimals);
      // |diff| < 1 + 0.5 × 10000 / (10000 − mmf) ticks, in integers.
      const bound = scale + (scale * 10_000n) / (2n * (10_000n - BigInt(spec.mmfBp)));
      assert.ok((diff < 0n ? -diff : diff) < bound, `${src} ${acct} ${sym}: ${ours} vs ${liq}`);
    }
  });

  it("the funding debit on account 22149 moved the venue's price, and ours moves with it", () => {
    const nvda = specOf("NVDA");
    const at = (am: bigint) =>
      isolatedLiqPrice({ side: "long", entryPrice: 23083n, baseAmount: 39685n, allocatedMarginMicro: am, mmfBp: nvda.mmfBp, spec: nvda });
    const before = at(76_476_136n);
    const after = at(76_465_162n);
    assert.ok(before !== null && after !== null && after >= before, "less margin, liquidation no farther away");
  });

  it("MMF is the market's constant, not a share of the chosen IMF", () => {
    // 10x on a 10x market (ZEC: min IMF 1000, MMF 600): liquidation sits
    // (10% − 6%)/(1 − 6%) ≈ 4.26% below entry — not 4% (which 60% of the
    // chosen 10% would give, and is only the same number by coincidence).
    const zec = specOf("ZEC");
    const entry = 100_000n;
    const base = 10_000n; // 1 ZEC
    const am = isolatedMarginMicro(notionalMicro(base, entry, zec), 1000);
    const liq = isolatedLiqPrice({ side: "long", entryPrice: entry, baseAmount: base, allocatedMarginMicro: am, mmfBp: zec.mmfBp, spec: zec });
    assert.equal(liq, 95_745n); // ceil(90000 / 0.94) = ceil(95744.68)
  });

  it("rounds toward the entry: up for a long, down for a short", () => {
    const s = COARSE;
    const long = isolatedLiqPrice({ side: "long", entryPrice: 1000n, baseAmount: 3n, allocatedMarginMicro: 0n, mmfBp: 300, spec: s });
    const short = isolatedLiqPrice({ side: "short", entryPrice: 1000n, baseAmount: 3n, allocatedMarginMicro: 0n, mmfBp: 300, spec: s });
    assert.equal(long, 1031n); // 1000 / 0.97 = 1030.93 → up
    assert.equal(short, 970n); // 1000 / 1.03 = 970.87 → down
  });

  it("a 1x long has no positive liquidation price; a 1x short does", () => {
    const btc = specOf("BTC");
    const entry = btc.mark;
    const am = isolatedMarginMicro(notionalMicro(30n, entry, btc), 10_000);
    assert.equal(isolatedLiqPrice({ side: "long", entryPrice: entry, baseAmount: 30n, allocatedMarginMicro: am, mmfBp: 120, spec: btc }), null);
    // A short margined at 1x is liquidated near 2 × entry / (1 + MMF):
    // 1664372 / 1.012 = 1644636.36, rounded down toward the entry.
    const short = isolatedLiqPrice({ side: "short", entryPrice: entry, baseAmount: 30n, allocatedMarginMicro: am, mmfBp: 120, spec: btc });
    assert.equal(short, 1_644_636n);
  });

  it("malformed input throws rather than guessing", () => {
    const btc = specOf("BTC");
    const base = { entryPrice: 1n, baseAmount: 1n, allocatedMarginMicro: 0n, mmfBp: 120, spec: btc };
    assert.throws(() => isolatedLiqPrice({ ...base, side: "long", baseAmount: 0n }), RangeError);
    assert.throws(() => isolatedLiqPrice({ ...base, side: "long", entryPrice: 0n }), RangeError);
    assert.throws(() => isolatedLiqPrice({ ...base, side: "long", allocatedMarginMicro: -1n }), RangeError);
    assert.throws(() => isolatedLiqPrice({ ...base, side: "long", mmfBp: 10_000 }), RangeError);
    assert.throws(() => isolatedLiqPrice({ ...base, side: "sell" as PerpSide }), RangeError);
    assert.throws(() => isolatedLiqPriceFromCost({ ...base, side: "long", entryCostMicro: 0n }), RangeError);
  });

  it("distance to liquidation is floored, and negative once crossed", () => {
    assert.equal(liqDistanceBps({ side: "long", markPrice: 832186n, liqPrice: 758065n }), 890);
    assert.equal(liqDistanceBps({ side: "short", markPrice: 1000n, liqPrice: 1031n }), 310);
    assert.equal(liqDistanceBps({ side: "long", markPrice: 1000n, liqPrice: 1001n }), -10);
    assert.equal(liqDistanceBps({ side: "long", markPrice: 1000n, liqPrice: null }), null);
  });
});

describe("stops and takes never sit farther from the entry than the owner set", () => {
  it("a long's stop sells below: trigger and worst price both rounded UP", () => {
    const { trigger, price } = stopPrices({ side: "long", entryRefPrice: 832187n, stopLossBps: 500, stopSlipBps: 200 });
    assert.equal(trigger, 790578n); // 832187 × 0.95 = 790577.65 → up
    assert.equal(price, 774767n); // 790578 × 0.98 = 774766.44 → up
  });

  it("a short's stop buys above: trigger and worst price both rounded DOWN", () => {
    const { trigger, price } = stopPrices({ side: "short", entryRefPrice: 832187n, stopLossBps: 500, stopSlipBps: 200 });
    assert.equal(trigger, 873796n); // 832187 × 1.05 = 873796.35 → down
    assert.equal(price, 891271n); // 873796 × 1.02 = 891271.92 → down
  });

  it("for many references and settings: within the owner's stop and slippage, on the right side", () => {
    for (const ref of [3n, 17n, 1000n, 13_455n, 832_187n, 4_294_000_000n]) {
      for (const sl of [100, 250, 500, 1234, 2500]) {
        for (const slip of [50, 200, 450]) {
          for (const side of ["long", "short"] as const) {
            let r: { trigger: bigint; price: bigint };
            try {
              r = stopPrices({ side, entryRefPrice: ref, stopLossBps: sl, stopSlipBps: slip });
            } catch (e) {
              // Only the extremes may refuse: a reference so small the stop
              // rounds onto it, or a short's stop pushed past the venue's
              // maximum price. No live market sits at either.
              const pastMax = side === "short" && ref * BigInt(10_000 + sl) * BigInt(10_000 + slip) > PERP_MAX_ORDER_PRICE * 10n ** 8n;
              assert.ok(e instanceof RangeError && (ref < 1000n || pastMax), `${side} ${ref} ${sl} ${slip}`);
              continue;
            }
            if (side === "long") {
              assert.ok(r.trigger < ref && r.price <= r.trigger && r.price >= 1n);
              assert.ok((ref - r.trigger) * 10_000n <= ref * BigInt(sl), "trigger no farther than set");
              assert.ok((r.trigger - r.price) * 10_000n <= r.trigger * BigInt(slip), "slippage no wider than set");
            } else {
              assert.ok(r.trigger > ref && r.price >= r.trigger && r.price <= PERP_MAX_ORDER_PRICE);
              assert.ok((r.trigger - ref) * 10_000n <= ref * BigInt(sl), "trigger no farther than set");
              assert.ok((r.price - r.trigger) * 10_000n <= r.trigger * BigInt(slip), "slippage no wider than set");
            }
          }
        }
      }
    }
  });

  it("an unplaceable stop throws — the open must be refused, not sent bare", () => {
    assert.throws(() => stopPrices({ side: "long", entryRefPrice: 10n, stopLossBps: 100, stopSlipBps: 200 }), RangeError);
    assert.throws(() => stopPrices({ side: "long", entryRefPrice: 1000n, stopLossBps: 0, stopSlipBps: 200 }), RangeError);
    assert.throws(() => stopPrices({ side: "long", entryRefPrice: 1000n, stopLossBps: 10_000, stopSlipBps: 200 }), RangeError);
    assert.throws(() => stopPrices({ side: "short", entryRefPrice: PERP_MAX_ORDER_PRICE, stopLossBps: 500, stopSlipBps: 200 }), RangeError);
    assert.throws(() => stopPrices({ side: "flat" as PerpSide, entryRefPrice: 1000n, stopLossBps: 500, stopSlipBps: 200 }), RangeError);
  });

  it("takes mirror the stop on the winning side", () => {
    const long = takePrices({ side: "long", entryRefPrice: 832187n, takeProfitBps: 1000, stopSlipBps: 200 });
    assert.equal(long.trigger, 915405n); // 832187 × 1.1 = 915405.7 → down (toward entry)
    assert.equal(long.price, 897097n); // 915405 × 0.98 = 897096.9 → up (toward trigger)
    const short = takePrices({ side: "short", entryRefPrice: 832187n, takeProfitBps: 1000, stopSlipBps: 200 });
    assert.equal(short.trigger, 748969n); // 832187 × 0.9 = 748968.3 → up (toward entry)
    assert.equal(short.price, 763948n); // 748969 × 1.02 = 763948.38 → down (toward trigger)
  });

  it("a short cannot take profit at or past a 100% fall", () => {
    assert.throws(() => takePrices({ side: "short", entryRefPrice: 1000n, takeProfitBps: 10_000, stopSlipBps: 200 }), RangeError);
    assert.ok(takePrices({ side: "long", entryRefPrice: 1000n, takeProfitBps: 50_000, stopSlipBps: 200 }).trigger === 6000n);
  });
});

describe("worstPriceForTaker rounds toward the mark", () => {
  it("sell no lower than mark × (1 − slip), buy no higher than mark × (1 + slip)", () => {
    assert.equal(worstPriceForTaker({ isAsk: true, mark: 832187n, maxSlippageBps: 50 }), 828027n); // 828026.07 → up
    assert.equal(worstPriceForTaker({ isAsk: false, mark: 832187n, maxSlippageBps: 50 }), 836347n); // 836347.9 → down
    assert.equal(worstPriceForTaker({ isAsk: false, mark: 1000n, maxSlippageBps: 0 }), 1000n);
  });

  it("refuses marks and results the venue cannot carry", () => {
    assert.throws(() => worstPriceForTaker({ isAsk: true, mark: 0n, maxSlippageBps: 50 }), RangeError);
    assert.throws(() => worstPriceForTaker({ isAsk: false, mark: PERP_MAX_ORDER_PRICE, maxSlippageBps: 50 }), RangeError);
    assert.throws(() => worstPriceForTaker({ isAsk: true, mark: 1000n, maxSlippageBps: -1 }), RangeError);
  });
});

describe("P&L, funding and peaks", () => {
  it("unrealized P&L floors: gains never overstated, losses never understated", () => {
    const btc = specOf("BTC");
    assert.equal(unrealizedPnlMicro({ side: "long", baseAmount: 20n, entryPrice: 832186n, markPrice: 832196n, spec: btc }), 200n);
    assert.equal(unrealizedPnlMicro({ side: "short", baseAmount: 20n, entryPrice: 832186n, markPrice: 832196n, spec: btc }), -200n);
    assert.equal(unrealizedPnlMicro({ side: "long", baseAmount: 3n, entryPrice: 1000n, markPrice: 1001n, spec: COARSE }), 0n); // +0.03
    assert.equal(unrealizedPnlMicro({ side: "long", baseAmount: 3n, entryPrice: 1001n, markPrice: 1000n, spec: COARSE }), -1n); // −0.03
    assert.equal(unrealizedPnlMicro({ side: "short", baseAmount: 3n, entryPrice: 1000n, markPrice: 1001n, spec: COARSE }), -1n);
  });

  it("funding: `direction` names the side that PAYS; the payer is charged the ceiling", () => {
    const btc = specOf("BTC");
    // /fundings BTC value 0.842547 USDG per BTC, 0.3 BTC held.
    const args = { baseAmount: 30_000n, valuePerBase: 842_547n, spec: btc } as const;
    assert.equal(fundingPaymentMicro({ ...args, side: "long", direction: "long" }), -252_765n); // 252764.1 → pays 252765
    assert.equal(fundingPaymentMicro({ ...args, side: "short", direction: "long" }), 252_764n);
    assert.equal(fundingPaymentMicro({ ...args, side: "short", direction: "short" }), -252_765n);
    assert.equal(fundingPaymentMicro({ ...args, side: "long", direction: "short" }), 252_764n);
  });

  it("funding at the value string's own precision loses nothing", () => {
    // /fundings TSLA value 0.00141704 per share (8 dp), 11.9448 held:
    // 119448 × 141704 / 10^6 = 16926.259392 micro.
    const tsla = specOf("TSLA");
    const args = { baseAmount: 119_448n, valuePerBase: 141_704n, valueDecimals: 8, spec: tsla } as const;
    assert.equal(fundingPaymentMicro({ ...args, side: "long", direction: "long" }), -16_927n);
    assert.equal(fundingPaymentMicro({ ...args, side: "short", direction: "long" }), 16_926n);
  });

  it("a negative funding value has no observed convention, so it is refused", () => {
    const btc = specOf("BTC");
    assert.throws(() => fundingPaymentMicro({ side: "long", direction: "long", baseAmount: 1n, valuePerBase: -1n, spec: btc }), RangeError);
    assert.equal(fundingPaymentMicro({ side: "long", direction: "long", baseAmount: 1n, valuePerBase: 0n, spec: btc }), 0n);
  });

  it("peak basis subtracts each winner, never the net", () => {
    // Net unrealized is +60; per position the open gains are 80.
    assert.equal(peakBasisMicro(1_000n, [50n, -20n, 30n]), 920n);
    assert.equal(peakBasisMicro(1_000n, [-50n]), 1_000n);
    assert.equal(peakBasisMicro(1_000n, []), 1_000n);
  });
});

describe("stopBeatsLiquidation — the open's last gate", () => {
  // BTC 10x long, entered at the IOC worst price, 5% stop with 2% slip.
  const btc = specOf("BTC");
  const entry = 832_186n;
  const base = 30n;
  const am = isolatedMarginMicro(notionalMicro(base, entry, btc), 1000);
  const liq = isolatedLiqPrice({ side: "long", entryPrice: entry, baseAmount: base, allocatedMarginMicro: am, mmfBp: btc.mmfBp, spec: btc });
  const stop = stopPrices({ side: "long", entryRefPrice: entry, stopLossBps: 500, stopSlipBps: 200 });

  it("the defaults clear a 2% buffer at 10x on BTC, and not a 3% one", () => {
    assert.equal(liq, 758_065n);
    assert.equal(stop.price, 774_766n);
    assert.equal(stopBeatsLiquidation({ side: "long", stopPrice: stop.price, liqPrice: liq, entryPrice: entry, bufferBps: 200 }), true);
    assert.equal(stopBeatsLiquidation({ side: "long", stopPrice: stop.price, liqPrice: liq, entryPrice: entry, bufferBps: 300 }), false);
  });

  it("mirrors for a short", () => {
    const sLiq = isolatedLiqPrice({ side: "short", entryPrice: entry, baseAmount: base, allocatedMarginMicro: am, mmfBp: btc.mmfBp, spec: btc });
    const sStop = stopPrices({ side: "short", entryRefPrice: entry, stopLossBps: 500, stopSlipBps: 200 });
    assert.ok(sLiq !== null);
    assert.equal(stopBeatsLiquidation({ side: "short", stopPrice: sStop.price, liqPrice: sLiq, entryPrice: entry, bufferBps: 100 }), true);
    assert.equal(stopBeatsLiquidation({ side: "short", stopPrice: sLiq + 1n, liqPrice: sLiq, entryPrice: entry, bufferBps: 0 }), false);
  });

  it("a stop beyond liquidation never passes", () => {
    assert.equal(stopBeatsLiquidation({ side: "long", stopPrice: 758_000n, liqPrice: liq, entryPrice: entry, bufferBps: 0 }), false);
    assert.equal(stopBeatsLiquidation({ side: "long", stopPrice: 758_065n, liqPrice: liq, entryPrice: entry, bufferBps: 0 }), false);
  });

  it("null liquidation: trivially beaten on a 1x long, unknown on a short", () => {
    assert.equal(stopBeatsLiquidation({ side: "long", stopPrice: 790_000n, liqPrice: null, entryPrice: entry, bufferBps: 200 }), true);
    assert.equal(stopBeatsLiquidation({ side: "short", stopPrice: 900_000n, liqPrice: null, entryPrice: entry, bufferBps: 200 }), false);
  });

  it("what it cannot judge keeps the open out", () => {
    const ok = { side: "long" as const, stopPrice: stop.price, liqPrice: liq, entryPrice: entry };
    assert.equal(stopBeatsLiquidation({ ...ok, bufferBps: -1 }), false);
    assert.equal(stopBeatsLiquidation({ ...ok, bufferBps: 1.5 }), false);
    assert.equal(stopBeatsLiquidation({ ...ok, stopPrice: entry + 1n, bufferBps: 0 }), false, "a long 'stop' above the entry");
    assert.equal(stopBeatsLiquidation({ ...ok, side: "short", stopPrice: entry - 1n, bufferBps: 0 }), false);
    assert.equal(stopBeatsLiquidation({ ...ok, side: "flat" as PerpSide, bufferBps: 0 }), false);
  });
});

describe("fees", () => {
  it("v1 charges no per-trade fee on perps", () => {
    assert.equal(PERP_TRADE_FEE_BPS, 0);
  });
});

// ── owner words ─────────────────────────────────────────────────────────────

describe("perpsBlockerText speaks to the owner", () => {
  it("every blocker has plain words and no slug", () => {
    assert.equal(PERP_BLOCKERS.length, 14);
    for (const b of PERP_BLOCKERS) {
      assert.ok(isPerpBlocker(b));
      const { what, remedy } = perpsBlockerText(b);
      assert.ok(what.length > 10, b);
      for (const text of [what, remedy ?? ""]) {
        assert.ok(!text.includes(b), `${b} leaks its slug`);
        assert.ok(!/perps?-[a-z]/.test(text), `${b} leaks a slug`);
      }
    }
  });

  it("states that clear by themselves invent no chore", () => {
    for (const b of ["perps-awaiting-deposit", "perps-key-pending", "perps-venue-unreachable"] as const) {
      assert.equal(perpsBlockerText(b).remedy, null, b);
    }
    assert.ok(perpsBlockerText("perps-not-granted").remedy);
  });

  it("a live account's refusal never says paper", () => {
    assert.ok(!/paper/i.test(perpsBlockerText("perps-live-off").what));
  });

  it("isPerpBlocker rejects the rest", () => {
    assert.equal(isPerpBlocker("dead-policy"), false);
    assert.equal(isPerpBlocker(null), false);
  });
});

describe("custodySentence never says the money is home unless it is", () => {
  const HOME = /stay in your smart account/;
  /** The fields a known exposure must state even when they are zero: read, never assumed. */
  const NOTHING_ELSE = { depositsInTransitMicro: 0n, poolShareCount: 0, spotBalanceCount: 0, otherAccounts: { count: 0, valueMicro: 0n } };
  const EMPTY = { kind: "known", collateralMicro: 0n, openPositions: 0, openOrders: 0, pendingWithdrawalsMicro: 0n, withdrawalDelaySec: null, ...NOTHING_ELSE } as const;

  it("none — the only state that may say it", () => {
    assert.match(custodySentence({ kind: "none" }), HOME);
  });

  it("known with exposure names it, says stops stay, and names recover", () => {
    const s = custodySentence({
      kind: "known",
      ...NOTHING_ELSE,
      collateralMicro: 29_123_456n,
      openPositions: 2,
      openOrders: 2,
      pendingWithdrawalsMicro: 0n,
      withdrawalDelaySec: 626,
    });
    assert.doesNotMatch(s, HOME);
    assert.match(s, /Still on Lighter: 2 open positions, 2 resting orders, 29\.13 USDG of collateral\./);
    assert.match(s, /stops/);
    assert.match(s, /merrymen recover/);
  });

  it("amounts round UP to the cent — never understated", () => {
    const s = custodySentence({ kind: "known",
      ...NOTHING_ELSE, collateralMicro: 1n, openPositions: 0, openOrders: 0, pendingWithdrawalsMicro: 0n, withdrawalDelaySec: null });
    assert.match(s, /0\.01 USDG/);
    const big = custodySentence({ kind: "known",
      ...NOTHING_ELSE, collateralMicro: 1_234_567_000_000n, openPositions: 0, openOrders: 0, pendingWithdrawalsMicro: 0n, withdrawalDelaySec: null });
    assert.match(big, /1,234,567\.00 USDG/);
  });

  it("a stand-down result is reported step by step", () => {
    const s = custodySentence({
      kind: "known",
      ...NOTHING_ELSE,
      collateralMicro: 0n,
      openPositions: 1,
      openOrders: 1,
      pendingWithdrawalsMicro: 12_000_000n,
      withdrawalDelaySec: 1314,
      standdown: { closed: ["BTC-PERP"], residual: ["SOL-PERP"], withdrawRequestedMicro: 12_000_000n, failedSteps: ["close SOL-PERP: too much slippage"] },
    });
    assert.doesNotMatch(s, HOME);
    assert.match(s, /Closed: BTC-PERP\./);
    assert.match(s, /Could not be closed: SOL-PERP\./);
    assert.match(s, /12\.00 USDG/);
    assert.match(s, /about 22 min/);
    assert.match(s, /too much slippage/);
    assert.match(s, /merrymen recover/);
  });

  it("known and empty is said plainly — still not as 'your funds stay'", () => {
    const s = custodySentence({ kind: "known",
      ...NOTHING_ELSE, collateralMicro: 0n, openPositions: 0, openOrders: 0, pendingWithdrawalsMicro: 0n, withdrawalDelaySec: null });
    assert.match(s, /Lighter reads empty/);
    assert.doesNotMatch(s, HOME);
  });

  it("money in transit is still exposure", () => {
    const s = custodySentence({ kind: "known",
      ...NOTHING_ELSE, collateralMicro: 0n, openPositions: 0, openOrders: 0, pendingWithdrawalsMicro: 5_000_000n, withdrawalDelaySec: null });
    assert.doesNotMatch(s, HOME);
    assert.match(s, /5\.00 USDG is on its way back/);
    assert.match(s, /merrymen recover/);
  });

  it("money on its way IN, pool shares, spot balances and other accounts are all still on Lighter — never 'reads empty'", () => {
    // Each alone, on an otherwise empty account.
    const cases: Array<[string, PerpExposure, RegExp]> = [
      ["a margin deposit landed and not yet credited", { ...EMPTY, depositsInTransitMicro: 12_000_000n }, /12\.00 USDG deposited to Lighter has landed on chain and is not yet credited/],
      ["shares in a public pool", { ...EMPTY, poolShareCount: 1 }, /Still on Lighter: shares in 1 public pool\./],
      ["spot balances or unlocks", { ...EMPTY, spotBalanceCount: 2 }, /Still on Lighter: 2 balances in its spot account or unlocking\./],
      ["a sub-account holding USDG", { ...EMPTY, otherAccounts: { count: 1, valueMicro: 5_000_000_000n } }, /1 other Lighter account under your smart account holding 5,000\.00 USDG/],
      ["a sub-account we could not value", { ...EMPTY, otherAccounts: { count: 2, valueMicro: null } }, /2 other Lighter accounts under your smart account\./],
      ["other accounts never read", { ...EMPTY, otherAccounts: null }, /Other Lighter accounts under your smart account could not be read/],
    ];
    for (const [why, e, said] of cases) {
      const s = custodySentence(e);
      assert.doesNotMatch(s, /reads empty/, why);
      assert.doesNotMatch(s, HOME, why);
      assert.match(s, said, why);
      assert.match(s, /merrymen recover/, why);
    }
  });

  it("unread says we could not look and how the owner can", () => {
    const s = custodySentence({ kind: "unread" });
    assert.doesNotMatch(s, HOME);
    assert.match(s, /could not be read/);
    assert.match(s, /merrymen recover/);
    assert.match(custodySentence({ kind: "unread" }, { recover: "open Recover in the app" }), /open Recover in the app/);
  });

  it("is never a constant", () => {
    const kinds: PerpExposure[] = [
      { kind: "none" },
      { kind: "unread" },
      { kind: "known",
      ...NOTHING_ELSE, collateralMicro: 1_000_000n, openPositions: 1, openOrders: 0, pendingWithdrawalsMicro: 0n, withdrawalDelaySec: null },
      { kind: "known",
      ...NOTHING_ELSE, collateralMicro: 2_000_000n, openPositions: 1, openOrders: 0, pendingWithdrawalsMicro: 0n, withdrawalDelaySec: null },
    ];
    assert.equal(new Set(kinds.map((k) => custodySentence(k))).size, kinds.length);
  });
});

// ── the report ──────────────────────────────────────────────────────────────

describe("parsePerpsReport is a strict whitelist", () => {
  const full: PerpsReport = {
    v: 1,
    mode: "live",
    blocker: null,
    venueReadAt: 1_790_697_000_000,
    protectAt: 1_790_697_010_000,
    accountIndex: 22149,
    positions: [
      {
        market: "BTC-PERP",
        side: "long",
        baseAmount: "0.00030",
        entryPrice: "83218.6",
        markPrice: "83220.1",
        leverage: 2,
        marginMicro: "12482790",
        liqPrice: "41931.3",
        unrealizedMicro: "-450",
        stopTrigger: "79057.7",
        fundingMicro: "-12",
      },
    ],
    openNotionalMicro: "24965580",
    collateralMicro: "17517210",
    inTransitMicro: "0",
    minLiqDistanceBps: 4961,
    stopsMissing: 0,
    incident: false,
  };

  it("round-trips through JSON", () => {
    assert.deepEqual(parsePerpsReport(JSON.parse(JSON.stringify(full))), full);
  });

  it("optional setup facts preserve old reports, whitelist fields and reject malformed minimums", () => {
    assert.equal("entriesHalted" in parsePerpsReport(full)!, false);
    assert.equal("entryMinimums" in parsePerpsReport(full)!, false);
    const entryMinimums = [{ market: "BTC-PERP", minNotionalMicro: "17000000" }];
    assert.deepEqual(parsePerpsReport({ ...full, entriesHalted: true, entryMinimums: [{ ...entryMinimums[0], apiKey: "secret" }] }),
      { ...full, entriesHalted: true, entryMinimums });
    for (const bad of [null, {}, [{ market: "BTC", minNotionalMicro: "1" }], [{ market: "BTC-PERP", minNotionalMicro: "0" }],
      [{ market: "BTC-PERP", minNotionalMicro: "-1" }], [{ market: "BTC-PERP", minNotionalMicro: 1 }], [...entryMinimums, ...entryMinimums]]) {
      assert.equal(parsePerpsReport({ ...full, entryMinimums: bad }), null);
    }
    assert.equal(parsePerpsReport({ ...full, entriesHalted: "false" }), null);
    const automation = { evaluatedAt: 1_790_000_000, driver: "perp-trend", style: "scalp-breakout", state: "waiting", reason: "Waiting for a closed candle." };
    assert.deepEqual(parsePerpsReport({ ...full, automation })?.automation, automation);
    for (const bad of [{ ...automation, style: "unknown" }, { ...automation, evaluatedAt: -1 }, { ...automation, state: "trading" }]) {
      const report = parsePerpsReport({ ...full, automation: bad });
      assert.ok(report);
      assert.equal(report.automation, undefined);
      assert.deepEqual(report.positions, parsePerpsReport(full)!.positions);
    }
  });

  it("drops unknown keys, top level and per position", () => {
    const raw = { ...full, secret: "x", positions: [{ ...full.positions[0], apiKey: "0xabc" }] };
    const out = parsePerpsReport(raw);
    assert.deepEqual(out, full);
    assert.ok(out && !("secret" in out));
  });

  it("absent nullable fields read as null (not said), never as zero", () => {
    const { venueReadAt: _a, collateralMicro: _b, minLiqDistanceBps: _c, blocker: _d, ...rest } = full;
    const out = parsePerpsReport({ ...rest, positions: [] });
    assert.ok(out);
    assert.equal(out.venueReadAt, null);
    assert.equal(out.collateralMicro, null);
    assert.equal(out.minLiqDistanceBps, null);
    assert.equal(out.blocker, null);
  });

  it("junk and wrong types reject the whole report", () => {
    const pos = full.positions[0];
    const junk: unknown[] = [
      null,
      undefined,
      42,
      "report",
      [],
      { ...full, v: 2 },
      { ...full, v: "1" },
      { ...full, mode: "maybe" },
      { ...full, blocker: "nope" },
      { ...full, positions: "none" },
      { ...full, positions: undefined },
      { ...full, stopsMissing: -1 },
      { ...full, stopsMissing: 1.5 },
      { ...full, stopsMissing: undefined },
      { ...full, incident: "false" },
      { ...full, incident: undefined },
      { ...full, accountIndex: 0 },
      { ...full, venueReadAt: -1 },
      { ...full, collateralMicro: 17_517_210 },
      { ...full, collateralMicro: "17.5" },
      { ...full, minLiqDistanceBps: "4961" },
      { ...full, minLiqDistanceBps: Number.NaN },
      // One malformed position rejects all: dropping it would render a book
      // with a leveraged position missing — "No positions" by omission.
      { ...full, positions: [pos, { ...pos, side: "sell" }] },
      { ...full, positions: [{ ...pos, market: "BTC" }] },
      { ...full, positions: [{ ...pos, market: "btc-perp" }] },
      { ...full, positions: [{ ...pos, baseAmount: 0.0003 }] },
      { ...full, positions: [{ ...pos, baseAmount: "0" }] },
      { ...full, positions: [{ ...pos, entryPrice: "-1" }] },
      { ...full, positions: [{ ...pos, marginMicro: "1.5" }] },
      { ...full, positions: [{ ...pos, marginMicro: undefined }] },
      { ...full, positions: [{ ...pos, leverage: 0 }] },
      { ...full, positions: [{ ...pos, liqPrice: 41931.3 }] },
      { ...full, positions: [{ ...pos, unrealizedMicro: "-4.5" }] },
      { ...full, positions: [null] },
    ];
    for (const j of junk) assert.equal(parsePerpsReport(j), null, JSON.stringify(j, (_k, v) => (v === undefined ? "<undef>" : v)));
  });

  it("reports immutable profile deadlines and keeps exposure when optional metadata is unknown", () => {
    const annotated = { ...full.positions[0], entryStyle: "scalp-breakout", styleOpenedAtSec: 1000, holdDeadlineSec: 2800 };
    const parsed = parsePerpsReport({ ...full, positions: [annotated] });
    assert.equal(parsed?.positions[0]?.entryStyle, "scalp-breakout");
    assert.equal(parsed?.positions[0]?.holdDeadlineSec, 2800);
    for (const bad of [{ entryStyle: "future-profile" }, { holdDeadlineSec: 999999 }, { styleOpenedAtSec: -1 }, { styleOpenedAtSec: 0 }, { styleOpenedAtSec: "1000" }]) {
      const p = parsePerpsReport({ ...full, positions: [{ ...annotated, ...bad }] });
      assert.ok(p);
      assert.equal(p.positions.length, 1);
      assert.equal(p.positions[0]?.entryStyle, undefined);
      assert.equal(p.positions[0]?.baseAmount, annotated.baseAmount);
    }
  });

  it("every mode and blocker is accepted", () => {
    for (const mode of ["off", "paper", "live", "refuse"] as const) assert.equal(parsePerpsReport({ ...full, mode })?.mode, mode);
    for (const blocker of PERP_BLOCKERS) assert.equal(parsePerpsReport({ ...full, blocker })?.blocker, blocker);
  });
});
