import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CHAINS, SOLANA_USDG_MINT, base58Encode } from "./ids";
import { SOLANA_VAULT_MAX_DAILY_OPS } from "./solana-live";
import {
  SOLANA_MAX_OPS_PER_DAY,
  SOLANA_MAX_PERMISSION_MS,
  SOLANA_PERMISSION_CLOCK_SKEW_MS,
  SOLANA_QUOTE_MAX_AGE_MS,
  SOLANA_SLIPPAGE_BPS_MAX,
  SolanaPaperValidationError,
  parseSolanaRawAmount,
  parseSolanaSwapIntent,
  parseSolanaTradeRequest,
  solanaPaperAgentId,
  solanaTradeFloorMet,
  requireSolanaLiveSellLimits,
  requireSolanaLiveTradeMinimum,
  SOLANA_LIVE_MIN_TRADE_USDG_RAW,
  SOLANA_LIVE_PER_TRADE_BELOW_MINIMUM,
  validateSolanaAccountLimits,
  validateSolanaPaperLimits,
  validateSolanaQuote,
  type SolanaPaperLimits,
  type SolanaQuote,
  type SolanaSwapIntent,
} from "./solana";

const NOW = 1_790_000_000_000;
const MINT = "So11111111111111111111111111111111111111112";
const OTHER_MINT = base58Encode(new Uint8Array(32).fill(42));
const MAX = "18446744073709551615";
const intent = (patch: Partial<SolanaSwapIntent> = {}): SolanaSwapIntent => ({
  kind: "spl-swap", chain: CHAINS.solana, mode: "paper", requestId: "paper-123_abc",
  inputMint: SOLANA_USDG_MINT, outputMint: MINT, amountRaw: "1000000", slippageBps: 100,
  ...patch,
});
const limits = (patch: Partial<SolanaPaperLimits> = {}): SolanaPaperLimits => ({
  perTradeUsdg: "10000000", dailyUsdg: "50000000", maxOpsPerDay: 24, maxDrawdownBps: 1000,
  expiresAtMs: NOW + 86_400_000, ...patch,
});
const quote = (patch: Partial<SolanaQuote> = {}): SolanaQuote => ({
  source: "jupiter", inputMint: SOLANA_USDG_MINT, outputMint: MINT, inAmount: "1000000",
  outAmount: "123456789", minOutAmount: "122222221", slippageBps: 100, contextSlot: 123456789,
  quotedAtMs: NOW - 1000, expiresAtMs: NOW + 29_000, ...patch,
});

describe("Solana raw amounts", () => {
  it("preserves all u64 precision, including amounts larger than safe JS numbers", () => {
    for (const value of ["1", "1000000", "9007199254740993", MAX]) {
      assert.equal(parseSolanaRawAmount(value), BigInt(value));
    }
    assert.equal(parseSolanaRawAmount("0", true), 0n);
    assert.throws(() => parseSolanaRawAmount("0"), /positive/);
  });

  it("rejects ambiguous, unbounded and numeric inputs before arithmetic", () => {
    const bad: unknown[] = [null, undefined, 1, 0, 1n, true, {}, [], "", " ", " 1", "1 ", "1\n", "1\r", "1\t",
      "+1", "-1", "-0", "00", "01", "1.0", "1e6", "0x10", "１", "18446744073709551616", "9".repeat(100_000)];
    for (const value of bad) {
      assert.throws(() => parseSolanaRawAmount(value));
      assert.throws(() => parseSolanaRawAmount(value, true));
    }
  });
});

describe("Solana paper swap intents", () => {
  it("accepts buys and exits with exactly one USDG leg, without altering the input", () => {
    const buy = Object.freeze(intent());
    const sell = intent({ inputMint: MINT, outputMint: SOLANA_USDG_MINT, amountRaw: "123456789" });
    assert.deepEqual(parseSolanaSwapIntent(buy), buy);
    assert.notEqual(parseSolanaSwapIntent(buy), buy);
    assert.deepEqual(parseSolanaSwapIntent(sell), sell);
  });

  it("rejects live mode, other chains, other kinds and unknown execution fields", () => {
    for (const patch of [
      { mode: "live" }, { mode: "funded" }, { chain: CHAINS.solanaDevnet }, { chain: CHAINS.robinhood },
      { chain: "solana:mainnet" }, { chain: 4663 }, { kind: "swap" }, { transaction: "untrusted" },
      { privateKey: "untrusted" },
    ]) assert.throws(() => parseSolanaSwapIntent({ ...intent(), ...patch }));
  });

  it("requires all fields on a real object", () => {
    for (const bad of [null, undefined, [], "intent", 1]) assert.throws(() => parseSolanaSwapIntent(bad));
    for (const key of Object.keys(intent())) {
      const missing = { ...intent() } as Record<string, unknown>;
      delete missing[key];
      assert.throws(() => parseSolanaSwapIntent(missing));
    }
    assert.throws(() => parseSolanaSwapIntent(Object.create(intent())));
  });

  it("limits request IDs to bounded safe identifiers without trimming", () => {
    for (const requestId of ["a", "123", "a_b-c", "f0e1d2c3-1111-2222-3333-000000000000", "a".repeat(128)]) {
      assert.equal(parseSolanaSwapIntent(intent({ requestId })).requestId, requestId);
    }
    for (const requestId of ["", "a".repeat(129), "../a", "/tmp/a", "a.b", "a:b", " a", "a ", "a\n", "_a", "-a", "é", "a/b", "a\\b", "a\0b"]) {
      assert.throws(() => parseSolanaSwapIntent(intent({ requestId })));
    }
  });

  it("keeps mint case and refuses whitespace, EVM addresses, signatures and malformed keys", () => {
    assert.equal(parseSolanaSwapIntent(intent({ outputMint: OTHER_MINT })).outputMint, OTHER_MINT);
    const invalid = ["", "0x" + "a".repeat(40), " " + MINT, MINT + " ", MINT + "\n", "0".repeat(32),
      base58Encode(new Uint8Array(31).fill(4)), base58Encode(new Uint8Array(33).fill(4)), base58Encode(new Uint8Array(64).fill(4)), "1".repeat(100_000)];
    for (const mint of invalid) {
      assert.throws(() => parseSolanaSwapIntent(intent({ inputMint: mint })));
      assert.throws(() => parseSolanaSwapIntent(intent({ outputMint: mint })));
    }
  });

  it("cannot trade token-to-token or USDG-to-itself", () => {
    assert.throws(() => parseSolanaSwapIntent(intent({ outputMint: SOLANA_USDG_MINT })), /exactly one USDG/);
    assert.throws(() => parseSolanaSwapIntent(intent({ inputMint: MINT, outputMint: OTHER_MINT })), /exactly one USDG/);
    assert.throws(() => parseSolanaSwapIntent(intent({ inputMint: MINT, outputMint: MINT })), /exactly one USDG/);
  });

  it("does not silently relax slippage or coerce an amount", () => {
    assert.equal(SOLANA_SLIPPAGE_BPS_MAX, 100);
    for (const slippageBps of [0, 1, 99, 100]) assert.equal(parseSolanaSwapIntent(intent({ slippageBps })).slippageBps, slippageBps);
    for (const slippageBps of [-1, 101, 10_000, 0.5, NaN, Infinity, "100", null]) {
      assert.throws(() => parseSolanaSwapIntent({ ...intent(), slippageBps }));
    }
    for (const amountRaw of ["0", "01", "1.1", "1e6", 1_000_000, MAX + "0"]) {
      assert.throws(() => parseSolanaSwapIntent({ ...intent(), amountRaw }));
    }
  });
});

describe("Solana trade requests and the owner's previewed minimum", () => {
  it("carries the previewed minimum beside the intent, never inside it, and leaves it out when absent", () => {
    assert.deepEqual(parseSolanaTradeRequest(intent()), { intent: intent(), minOutAmount: null });
    assert.deepEqual(parseSolanaTradeRequest({ ...intent(), minOutAmount: "122222221" }), { intent: intent(), minOutAmount: "122222221" });
    assert.deepEqual(parseSolanaTradeRequest({ ...intent(), minOutAmount: MAX }).minOutAmount, MAX);
    // The intent itself is still exact: any other extra field is refused.
    assert.throws(() => parseSolanaTradeRequest({ ...intent(), minOutAmount: "1", outAmount: "2" }), SolanaPaperValidationError);
    assert.throws(() => parseSolanaSwapIntent({ ...intent(), minOutAmount: "1" }), SolanaPaperValidationError);
    for (const value of [null, [], "x"]) assert.throws(() => parseSolanaTradeRequest(value), SolanaPaperValidationError);
  });
  it("accepts only a positive canonical whole number of base units as the minimum", () => {
    for (const minOutAmount of ["0", "01", " 1", "1.5", "-1", "1e3", "18446744073709551616", 1, 1n, null, undefined, ""]) {
      assert.throws(() => parseSolanaTradeRequest({ ...intent(), minOutAmount }), /previewed minimum output/, String(minOutAmount));
    }
  });
  it("is met exactly at the previewed minimum and above it, never below", () => {
    assert.equal(solanaTradeFloorMet("122222221", null), true);
    assert.equal(solanaTradeFloorMet("122222221", "122222221"), true);
    assert.equal(solanaTradeFloorMet("122222222", "122222221"), true);
    assert.equal(solanaTradeFloorMet("122222220", "122222221"), false);
    assert.equal(solanaTradeFloorMet("0", "1"), false);
  });
});

describe("Solana paper limits", () => {
  it("validates raw micro-USDG without losing precision or mutating settings", () => {
    const config = Object.freeze(limits({ perTradeUsdg: MAX, dailyUsdg: MAX, maxDrawdownBps: 10_000 }));
    assert.deepEqual(validateSolanaPaperLimits(config, NOW), config);
    assert.notEqual(validateSolanaPaperLimits(config, NOW), config);
    assert.deepEqual(validateSolanaPaperLimits(limits({ perTradeUsdg: "1", dailyUsdg: "1", maxOpsPerDay: 1, maxDrawdownBps: 1 }), NOW),
      limits({ perTradeUsdg: "1", dailyUsdg: "1", maxOpsPerDay: 1, maxDrawdownBps: 1 }));
  });

  it("rejects expiry at the present boundary and invalid clocks", () => {
    for (const expiresAtMs of [NOW, NOW - 1, -1, Infinity, NaN, NOW + 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => validateSolanaPaperLimits(limits({ expiresAtMs }), NOW));
    }
    for (const nowMs of [-1, NaN, Infinity, NOW + 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => validateSolanaPaperLimits(limits(), nowMs));
    }
    assert.doesNotThrow(() => validateSolanaPaperLimits(limits({ expiresAtMs: NOW + 1 }), NOW));
  });

  it("requires positive caps and per-trade no larger than daily", () => {
    for (const patch of [{ perTradeUsdg: "0" }, { dailyUsdg: "0" }, { perTradeUsdg: "50000001" },
      { perTradeUsdg: 1 }, { dailyUsdg: "1.0" }, { dailyUsdg: "18446744073709551616" }]) {
      assert.throws(() => validateSolanaPaperLimits({ ...limits(), ...patch }, NOW));
    }
  });

  it("bounds operation and drawdown limits without coercion or disabling zero", () => {
    for (const maxOpsPerDay of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "24", null]) {
      assert.throws(() => validateSolanaPaperLimits({ ...limits(), maxOpsPerDay }, NOW));
    }
    for (const maxDrawdownBps of [0, -1, 10_001, 0.5, NaN, Infinity, "1000", null]) {
      assert.throws(() => validateSolanaPaperLimits({ ...limits(), maxDrawdownBps }, NOW));
    }
  });

  it("rejects malformed records and missing or extra limits", () => {
    for (const input of [null, undefined, [], "limits", {}, { ...limits(), enabled: true }]) {
      assert.throws(() => validateSolanaPaperLimits(input, NOW));
    }
    for (const key of Object.keys(limits())) {
      const missing = { ...limits() } as Record<string, unknown>;
      delete missing[key];
      assert.throws(() => validateSolanaPaperLimits(missing, NOW));
    }
  });
  it("keeps SOL sell limits paired, positive and ordered, and requires them for live", () => {
    const capped = limits({ perTradeWsol: "250000000", dailyWsol: "1000000000" });
    assert.deepEqual(validateSolanaPaperLimits(capped, NOW), capped);
    assert.deepEqual(requireSolanaLiveSellLimits(capped), { perTradeWsol: 250_000_000n, dailyWsol: 1_000_000_000n });
    for (const patch of [{ perTradeWsol: "1" }, { dailyWsol: "1" }, { perTradeWsol: "0", dailyWsol: "1" },
      { perTradeWsol: "2", dailyWsol: "1" }, { perTradeWsol: "1", dailyWsol: "1.5" }, { perTradeWsol: 1 as unknown as string, dailyWsol: "1" }]) {
      assert.throws(() => validateSolanaPaperLimits({ ...limits(), ...patch }, NOW), SolanaPaperValidationError);
    }
    // Paper accounts saved before the SOL sell limits still validate, but cannot go live.
    assert.deepEqual(validateSolanaPaperLimits(limits(), NOW), limits());
    assert.throws(() => requireSolanaLiveSellLimits(limits()), /SOL sell limits/);
  });

  it("refuses live limits whose per-trade USDG limit is under the 1 USDG live minimum, and leaves the shape check alone", () => {
    const live = limits({ perTradeUsdg: "999999", perTradeWsol: "250000000", dailyWsol: "1000000000" });
    // Still valid limits (admission and paper read them): only saving and registering them live refuses.
    assert.deepEqual(validateSolanaAccountLimits(live, NOW), live);
    assert.throws(() => requireSolanaLiveTradeMinimum(live), (error: unknown) => error instanceof SolanaPaperValidationError && error.message === SOLANA_LIVE_PER_TRADE_BELOW_MINIMUM);
    assert.doesNotThrow(() => requireSolanaLiveTradeMinimum({ ...live, perTradeUsdg: SOLANA_LIVE_MIN_TRADE_USDG_RAW.toString() }));
  });

  it("refuses at save the live operation count and permission length the vault cannot honour (audit core-abi-3, web-auth F4)", () => {
    assert.equal(SOLANA_MAX_OPS_PER_DAY, SOLANA_VAULT_MAX_DAILY_OPS, "the program's cap");
    const live = limits({ perTradeWsol: "250000000", dailyWsol: "1000000000" });
    const latest = NOW + SOLANA_MAX_PERMISSION_MS + SOLANA_PERMISSION_CLOCK_SKEW_MS;
    // Live-shaped limits (with SOL sell caps) go through validateSolanaPaperLimits in the settings route: a 400, not a 503 at setup.
    for (const check of [validateSolanaPaperLimits, validateSolanaAccountLimits]) {
      assert.equal(check({ ...live, maxOpsPerDay: SOLANA_MAX_OPS_PER_DAY }, NOW).maxOpsPerDay, 96);
      for (const maxOpsPerDay of [97, 1000, Number.MAX_SAFE_INTEGER]) {
        assert.throws(() => check({ ...live, maxOpsPerDay }, NOW), (e: unknown) => e instanceof SolanaPaperValidationError && /between 1 and 96/.test(e.message));
      }
      assert.equal(check({ ...live, expiresAtMs: NOW + SOLANA_MAX_PERMISSION_MS }, NOW).expiresAtMs, NOW + SOLANA_MAX_PERMISSION_MS);
      assert.equal(check({ ...live, expiresAtMs: latest }, NOW).expiresAtMs, latest, "a browser clock a few minutes ahead");
      for (const expiresAtMs of [latest + 1, NOW + 100 * 365 * 86_400_000]) {
        assert.throws(() => check({ ...live, expiresAtMs }, NOW), (e: unknown) => e instanceof SolanaPaperValidationError && /168 hours/.test(e.message));
      }
    }
    // A tenant's account is bounded with or without sell caps; the standalone paper CLI (no sell caps) is not.
    assert.throws(() => validateSolanaAccountLimits(limits({ maxOpsPerDay: 97 }), NOW), /between 1 and 96/);
    assert.throws(() => validateSolanaAccountLimits(limits({ expiresAtMs: latest + 1 }), NOW), /168 hours/);
    assert.equal(validateSolanaPaperLimits(limits({ maxOpsPerDay: 100_000, expiresAtMs: NOW + 365 * 86_400_000 }), NOW).maxOpsPerDay, 100_000);
    // Rechecking stored limits later only moves the end closer.
    assert.doesNotThrow(() => validateSolanaAccountLimits({ ...live, expiresAtMs: latest }, NOW + 60_000));
  });
});

describe("Solana ExactIn quote validation", () => {
  it("accepts bound fresh quotes, including a stricter minimum output", () => {
    assert.doesNotThrow(() => validateSolanaQuote(quote(), intent(), NOW));
    assert.doesNotThrow(() => validateSolanaQuote(quote({ minOutAmount: "123456789" }), intent(), NOW));
    assert.doesNotThrow(() => validateSolanaQuote(quote({ quotedAtMs: NOW, expiresAtMs: NOW + 1 }), intent(), NOW));
  });

  it("binds the provider, both mints, exact input and slippage to the caller's intent", () => {
    for (const patch of [{ source: "unknown" }, { inputMint: MINT }, { outputMint: OTHER_MINT }, { inAmount: "999999" },
      { inAmount: "1000001" }, { inAmount: 1_000_000 }, { slippageBps: 99 }, { slippageBps: 101 }, { slippageBps: "100" }]) {
      assert.throws(() => validateSolanaQuote({ ...quote(), ...patch } as SolanaQuote, intent(), NOW), /does not match/);
    }
  });

  it("revalidates typed intents so casts cannot pass live trades through", () => {
    for (const patch of [{ mode: "live" }, { chain: CHAINS.robinhood }, { slippageBps: 500 }, { amountRaw: "0" }]) {
      assert.throws(() => validateSolanaQuote(quote(), { ...intent(), ...patch } as SolanaSwapIntent, NOW));
    }
  });

  it("checks slippage exactly in integer arithmetic at the floor boundary", () => {
    assert.doesNotThrow(() => validateSolanaQuote(quote({ minOutAmount: "122222221" }), intent(), NOW));
    assert.throws(() => validateSolanaQuote(quote({ minOutAmount: "122222220" }), intent(), NOW), /slippage/);
    assert.throws(() => validateSolanaQuote(quote({ minOutAmount: "123456790" }), intent(), NOW), /slippage/);
    const floor = (BigInt(MAX) * 9900n / 10_000n).toString();
    assert.doesNotThrow(() => validateSolanaQuote(quote({ outAmount: MAX, minOutAmount: floor }), intent(), NOW));
    assert.throws(() => validateSolanaQuote(quote({ outAmount: MAX, minOutAmount: (BigInt(floor) - 1n).toString() }), intent(), NOW));
  });

  it("requires exact output at zero slippage and positive output even for tiny trades", () => {
    assert.doesNotThrow(() => validateSolanaQuote(quote({ slippageBps: 0, minOutAmount: "123456789" }), intent({ slippageBps: 0 }), NOW));
    assert.throws(() => validateSolanaQuote(quote({ slippageBps: 0, minOutAmount: "123456788" }), intent({ slippageBps: 0 }), NOW));
    assert.doesNotThrow(() => validateSolanaQuote(quote({ outAmount: "1", minOutAmount: "1" }), intent(), NOW));
    assert.throws(() => validateSolanaQuote(quote({ outAmount: "1", minOutAmount: "0" }), intent(), NOW));
    for (const raw of ["0", "01", "1.5", "18446744073709551616", 100, null]) {
      assert.throws(() => validateSolanaQuote({ ...quote(), outAmount: raw } as SolanaQuote, intent(), NOW));
      assert.throws(() => validateSolanaQuote({ ...quote(), minOutAmount: raw } as SolanaQuote, intent(), NOW));
    }
  });

  it("expires at 30 seconds or earlier, and rejects future and backwards windows", () => {
    assert.equal(SOLANA_QUOTE_MAX_AGE_MS, 30_000);
    assert.doesNotThrow(() => validateSolanaQuote(quote({ quotedAtMs: NOW - 29_999, expiresAtMs: NOW + 1 }), intent(), NOW));
    for (const patch of [
      { quotedAtMs: NOW + 1 }, { quotedAtMs: NOW - 30_000, expiresAtMs: NOW + 1 },
      { expiresAtMs: NOW }, { expiresAtMs: NOW - 1 }, { expiresAtMs: NOW - 1001 },
      { expiresAtMs: NOW + 29_001 }, { quotedAtMs: NOW, expiresAtMs: NOW + 30_001 },
    ]) assert.throws(() => validateSolanaQuote(quote(patch), intent(), NOW), /stale|expiry/);
  });

  it("rejects noninteger times, slots, malformed quote records and extra fields", () => {
    for (const field of ["quotedAtMs", "expiresAtMs", "contextSlot"] as const) {
      for (const value of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, "123", null]) {
        assert.throws(() => validateSolanaQuote({ ...quote(), [field]: value }, intent(), NOW));
      }
    }
    assert.throws(() => validateSolanaQuote(quote({ contextSlot: 0 }), intent(), NOW));
    for (const bad of [null, undefined, [], "quote", { ...quote(), swapMode: "ExactOut" }]) {
      assert.throws(() => validateSolanaQuote(bad as SolanaQuote, intent(), NOW));
    }
    for (const key of Object.keys(quote())) {
      const missing = { ...quote() } as Record<string, unknown>;
      delete missing[key];
      assert.throws(() => validateSolanaQuote(missing as unknown as SolanaQuote, intent(), NOW));
    }
    for (const badNow of [NaN, Infinity, -1, NOW + 0.5]) assert.throws(() => validateSolanaQuote(quote(), intent(), badNow));
  });
});

describe("Solana paper agent namespace", () => {
  it("preserves case and isolates a validated Solana owner", () => {
    assert.equal(solanaPaperAgentId(OTHER_MINT), `sol:${OTHER_MINT}`);
    for (const bad of ["", OTHER_MINT + " ", "sol:" + OTHER_MINT, "0x" + "a".repeat(40), "../../book"]) {
      assert.throws(() => solanaPaperAgentId(bad));
    }
  });
});

it("exposes typed, credential-safe validation failures to command boundaries", () => {
  const secret = "https://rpc.invalid/?api-key=private-test-value";
  const actions = [
    () => parseSolanaRawAmount(secret),
    () => parseSolanaSwapIntent({ ...intent(), requestId: secret }),
    () => parseSolanaSwapIntent({ ...intent(), inputMint: secret }),
    () => validateSolanaPaperLimits({ ...limits(), dailyUsdg: secret }, NOW),
    () => validateSolanaQuote({ ...quote(), source: secret } as unknown as SolanaQuote, intent(), NOW),
    () => solanaPaperAgentId(secret),
  ];
  for (const action of actions) {
    assert.throws(action, (error: unknown) => {
      assert.ok(error instanceof SolanaPaperValidationError);
      assert.equal(error.name, "SolanaPaperValidationError");
      assert.ok(!error.message.includes(secret));
      assert.ok(!error.message.includes("private-test-value"));
      return true;
    });
  }
});
