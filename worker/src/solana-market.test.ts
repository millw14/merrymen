import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CHAINS, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM } from "../../packages/core/src/ids";
import { SolanaPaperValidationError, type SolanaSwapIntent } from "../../packages/core/src/solana";
import { createSolanaMarket, SolanaMarketError, SPL_TOKEN_PROGRAM } from "./solana-market";
import { SOLANA_MAINNET_GENESIS_HASH, SOLANA_RESPONSE_LIMIT_BYTES, SolanaRpcError } from "./solana-rpc";

const TOKEN = "So11111111111111111111111111111111111111112";
const OTHER = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SECRET = "fixture-market-secret";
const PRIMARY = `https://rpc.example.test/?api-key=${SECRET}`;
const FALLBACK = "https://backup.example.test/?api-key=independent-fixture-key";
const ENV = { MERRYMEN_SOLANA_RPC_MAINNET: PRIMARY, MERRYMEN_JUPITER_API_KEY: SECRET };
const INTENT: SolanaSwapIntent = { kind: "spl-swap", chain: CHAINS.solana, mode: "paper", requestId: "market_test_1",
  inputMint: SOLANA_USDG_MINT, outputMint: TOKEN, amountRaw: "1000000", slippageBps: 100 };
const NOW = 1_800_000_000_000;
const SLOT = 400_000_000;
type Obj = Record<string, any>;
const rawMint = (overrides: Obj = {}): Obj => ({
  context: { slot: SLOT }, value: { executable: false, owner: SPL_TOKEN_PROGRAM,
    data: { program: "spl-token", space: 82, parsed: { type: "mint", info: {
      decimals: 9, supply: "1000000000000000000", isInitialized: true,
      mintAuthority: null, freezeAuthority: null,
    } } } }, ...overrides,
});
const token2022Mint = (extensions: unknown[], usdg = false): Obj => {
  const value = rawMint();
  value.value.owner = TOKEN_2022_PROGRAM;
  value.value.data.program = "spl-token-2022";
  value.value.data.space = extensions.length ? 400 : 82;
  value.value.data.parsed.info.decimals = usdg ? 6 : 9;
  value.value.data.parsed.info.extensions = extensions;
  return value;
};
const rawQuote = (overrides: Obj = {}): Obj => ({
  inputMint: INTENT.inputMint, outputMint: INTENT.outputMint, inAmount: INTENT.amountRaw,
  outAmount: "2000000", otherAmountThreshold: "1980000", swapMode: "ExactIn", slippageBps: 100,
  contextSlot: SLOT, routePlan: [{ percent: 100, swapInfo: { ammKey: OTHER,
    inputMint: INTENT.inputMint, outputMint: INTENT.outputMint, inAmount: INTENT.amountRaw, outAmount: "2000000" } }], ...overrides,
});
const response = (value: unknown) => new Response(JSON.stringify(value));
const rpcResponse = (id: number, result: unknown) => response({ jsonrpc: "2.0", id, result });
function fixture(options: {
  mint?: Obj; quote?: Obj; slot?: number; now?: () => number; timeoutMs?: number;
  fetch?: typeof fetch; env?: Record<string, string>;
} = {}) {
  const calls: Array<{ url: string; init?: RequestInit; method: string; params: unknown[] }> = [];
  const fetcher: typeof fetch = options.fetch ?? (async (input, init) => {
    const url = String(input);
    if (url.startsWith("https://api.jup.ag/")) {
      calls.push({ url, init, method: "quote", params: [] });
      return response(options.quote ?? rawQuote());
    }
    const body = JSON.parse(String(init?.body));
    calls.push({ url, init, method: body.method, params: body.params });
    const result = body.method === "getGenesisHash" ? SOLANA_MAINNET_GENESIS_HASH :
      body.method === "getSlot" ? options.slot ?? SLOT : options.mint ?? rawMint();
    return rpcResponse(body.id, result);
  });
  return { market: createSolanaMarket({ env: options.env ?? ENV, now: options.now ?? (() => NOW), fetch: fetcher,
    timeoutMs: options.timeoutMs }), calls };
}
function safeError(error: unknown): boolean {
  assert.ok(error instanceof SolanaMarketError || error instanceof SolanaRpcError || error instanceof SolanaPaperValidationError);
  assert.equal(error.cause, undefined);
  for (const text of [String(error), error.stack ?? "", JSON.stringify(error)]) {
    assert.ok(!text.includes(SECRET)); assert.ok(!text.includes(PRIMARY));
  }
  return true;
}
const marketError = (code: SolanaMarketError["code"]) => (error: unknown) => {
  assert.ok(error instanceof SolanaMarketError); assert.equal(error.code, code); return safeError(error);
};
const rpcError = (code: SolanaRpcError["code"]) => (error: unknown) => {
  assert.ok(error instanceof SolanaRpcError); assert.equal(error.code, code); return safeError(error);
};

describe("Solana mint reads", () => {
  it("verifies mainnet each time and reads a finalized mint with minContextSlot", async () => {
    const { market, calls } = fixture();
    assert.deepEqual(await market.readMint(TOKEN), { address: TOKEN, program: SPL_TOKEN_PROGRAM,
      decimals: 9, slot: SLOT, observedAtMs: NOW, buyBlockedReasons: [] });
    assert.deepEqual(calls.map(c => c.method), ["getGenesisHash", "getSlot", "getAccountInfo"]);
    assert.deepEqual(calls[1]?.params, [{ commitment: "finalized" }]);
    assert.deepEqual(calls[2]?.params, [TOKEN, { encoding: "jsonParsed", commitment: "finalized", minContextSlot: SLOT }]);
    await market.readMint(TOKEN);
    assert.equal(calls.filter(c => c.method === "getGenesisHash").length, 2);
    for (const call of calls) { assert.equal(call.init?.redirect, "error"); assert.equal(call.init?.method, "POST"); }
  });
  it("rejects noncanonical addresses before contacting RPC", async () => {
    const { market, calls } = fixture();
    for (const value of ["ETH", ` ${TOKEN}`, SECRET, "0x" + "1".repeat(40), "1".repeat(100000)]) {
      await assert.rejects(market.readMint(value), marketError("invalid-address"));
    }
    assert.equal(calls.length, 0);
  });
  it("does not interpret missing, non-mint, uninitialized, spoofed or malformed accounts", async () => {
    const mutate: Array<(value: Obj) => void> = [
      x => { x.value = null; }, x => { x.value.executable = true; }, x => { x.value.owner = OTHER; },
      x => { x.value.data = ["raw", "base64"]; }, x => { x.value.data.program = "spl-token-2022"; },
      x => { x.value.data.parsed.type = "account"; }, x => { x.value.data.parsed.info.isInitialized = false; },
      x => { delete x.value.data.parsed.info.freezeAuthority; }, x => { delete x.value.data.parsed.info.mintAuthority; },
      x => { x.value.data.parsed.info.freezeAuthority = SECRET; }, x => { x.value.data.parsed.info.decimals = 19; },
      x => { x.value.data.parsed.info.decimals = "9"; }, x => { x.value.data.parsed.info.supply = 12; },
      x => { x.value.data.parsed.info.supply = "18446744073709551616"; }, x => { x.value.data.space = 81; },
      x => { x.value.data.space = 200; }, x => { x.value.space = 1; },
      x => { x.value.data.parsed.info.extensions = [{ extension: "metadataPointer", state: {} }]; },
      x => { x.context.slot = "400000000"; },
    ];
    for (const apply of mutate) {
      const mint = rawMint(); apply(mint);
      await assert.rejects(fixture({ mint }).market.readMint(TOKEN), marketError("invalid-mint"));
    }
  });
  it("rejects stale and implausibly future mint slots", async () => {
    for (const slot of [SLOT - 1, SLOT + 33]) {
      await assert.rejects(fixture({ mint: rawMint({ context: { slot } }) }).market.readMint(TOKEN), marketError("stale-mint"));
    }
    const { market } = fixture({ mint: rawMint({ context: { slot: SLOT + 32 } }) });
    assert.equal((await market.readMint(TOKEN)).slot, SLOT + 32);
  });
  it("requires configured USDG to match its exact program and six decimals", async () => {
    await assert.rejects(fixture().market.readMint(SOLANA_USDG_MINT), marketError("invalid-mint"));
    await assert.rejects(fixture({ mint: token2022Mint([]) }).market.readMint(SOLANA_USDG_MINT), marketError("invalid-mint"));
    assert.deepEqual((await fixture({ mint: token2022Mint([], true) }).market.readMint(SOLANA_USDG_MINT)).buyBlockedReasons, []);
  });
});

describe("Token-2022 buy screening", () => {
  const fee = (bps = 0, maximumFee = 0) => ({ epoch: 1, transferFeeBasisPoints: bps, maximumFee });
  const feeExtension = (older = fee(), newer = fee()) => ({ extension: "transferFeeConfig", state: {
    transferFeeConfigAuthority: OTHER, withdrawWithheldAuthority: OTHER, withheldAmount: 0,
    olderTransferFee: older, newerTransferFee: newer,
  } });
  it("reports freeze, delegate, fees, hooks, default frozen, nontransferable and unknown extensions", async () => {
    const cases: Array<[Obj, string]> = [
      [{ extension: "permanentDelegate", state: { delegate: OTHER } }, "permanent-delegate"],
      [feeExtension(fee(1, 20)), "transfer-fee"], [feeExtension(fee(), fee(1, 20)), "transfer-fee"],
      [{ extension: "transferHook", state: { authority: OTHER, programId: OTHER } }, "transfer-hook"],
      [{ extension: "defaultAccountState", state: { accountState: "frozen" } }, "default-frozen"],
      [{ extension: "nonTransferable" }, "non-transferable"],
      [{ extension: "future-extension-with-" + SECRET }, "unsupported-token-extension"],
      [{ extension: "unparseableExtension" }, "unsupported-token-extension"],
      [{ extension: "scaledUiAmountConfig", state: {} }, "unsupported-token-extension"],
      [{ extension: "pausableConfig", state: { paused: false } }, "unsupported-token-extension"],
    ];
    for (const [extension, reason] of cases) {
      const mint = token2022Mint([extension]); mint.value.data.parsed.info.freezeAuthority = OTHER;
      const result = await fixture({ mint }).market.readMint(TOKEN);
      assert.deepEqual(result.buyBlockedReasons, ["freeze-authority", reason]);
      assert.ok(!JSON.stringify(result).includes(SECRET));
    }
  });
  it("permits passive and disabled extensions without treating missing fields as disabled", async () => {
    const extensions = [feeExtension(fee(0, Number(18446744073709551615n))),
      { extension: "permanentDelegate", state: { delegate: null } },
      { extension: "transferHook", state: { authority: null, programId: null } },
      { extension: "defaultAccountState", state: { accountState: "initialized" } },
      { extension: "metadataPointer", state: { authority: OTHER, metadataAddress: TOKEN } },
      { extension: "mintCloseAuthority", state: { closeAuthority: OTHER } }];
    assert.deepEqual((await fixture({ mint: token2022Mint(extensions) }).market.readMint(TOKEN)).buyBlockedReasons, []);
    for (const extension of [
      { extension: "transferHook", state: { authority: null } },
      { extension: "permanentDelegate", state: {} },
      { extension: "defaultAccountState", state: {} },
      { extension: "transferFeeConfig", state: {} },
      feeExtension({ ...fee(), transferFeeBasisPoints: "0" } as any),
    ]) {
      await assert.rejects(fixture({ mint: token2022Mint([extension]) }).market.readMint(TOKEN), marketError("invalid-mint"));
    }
  });
  it("blocks an active mint authority and a hook authority that can enable a hook later", async () => {
    // Supply can be inflated at any time while a mint authority exists.
    const inflatable = rawMint(); inflatable.value.data.parsed.info.mintAuthority = OTHER;
    assert.deepEqual((await fixture({ mint: inflatable }).market.readMint(TOKEN)).buyBlockedReasons, ["mint-authority"]);
    const both = rawMint(); both.value.data.parsed.info.mintAuthority = OTHER; both.value.data.parsed.info.freezeAuthority = OTHER;
    assert.deepEqual((await fixture({ mint: both }).market.readMint(TOKEN)).buyBlockedReasons, ["freeze-authority", "mint-authority"]);
    // A disabled hook with an authority is one instruction away from an arbitrary transfer program.
    const dormant = token2022Mint([{ extension: "transferHook", state: { authority: OTHER, programId: null } }]);
    assert.deepEqual((await fixture({ mint: dormant }).market.readMint(TOKEN)).buyBlockedReasons, ["transfer-hook-authority"]);
    const inflatableHook = token2022Mint([{ extension: "transferHook", state: { authority: OTHER, programId: null } }]);
    inflatableHook.value.data.parsed.info.mintAuthority = OTHER;
    assert.deepEqual((await fixture({ mint: inflatableHook }).market.readMint(TOKEN)).buyBlockedReasons, ["mint-authority", "transfer-hook-authority"]);
    // Neither power can be renounced back into safety by a null program alone.
    const locked = token2022Mint([{ extension: "transferHook", state: { authority: null, programId: null } }]);
    assert.deepEqual((await fixture({ mint: locked }).market.readMint(TOKEN)).buyBlockedReasons, []);
  });
  it("permits known USDG issuer powers but refuses USDG with a hook program, a transfer fee or another extension outright, as the vault does", async () => {
    const extensions = [{ extension: "permanentDelegate", state: { delegate: OTHER } }, feeExtension(),
      { extension: "transferHook", state: { authority: OTHER, programId: null } },
      { extension: "confidentialTransferFeeConfig", state: { authority: OTHER,
        withdrawWithheldAuthorityElgamalPubkey: Buffer.alloc(32).toString("base64"), harvestToMintEnabled: true,
        withheldAmount: Buffer.alloc(64).toString("base64") } }];
    const mint = token2022Mint(extensions, true); mint.value.data.parsed.info.freezeAuthority = OTHER;
    // The configured cash issuer mints USDG; that power is not a reason to refuse cash.
    mint.value.data.parsed.info.mintAuthority = OTHER;
    assert.deepEqual((await fixture({ mint }).market.readMint(SOLANA_USDG_MINT)).buyBlockedReasons, []);
    // The vault's check_mint fails every swap, exits included, on such a USDG mint
    // (solanaVaultUsdgMintRefusal), so the worker refuses the mint itself, not only buys.
    for (const ext of [feeExtension(fee(), fee(10, 100)), feeExtension(fee(), fee(10, 0)), feeExtension(fee(10, 0), fee()),
      { extension: "transferHook", state: { authority: OTHER, programId: OTHER } },
      { extension: "defaultAccountState", state: { accountState: "initialized" } },
      { extension: "groupPointer", state: { authority: OTHER, groupAddress: SOLANA_USDG_MINT } }]) {
      const active = token2022Mint([extensions[0], ext], true); active.value.data.parsed.info.freezeAuthority = OTHER;
      await assert.rejects(fixture({ mint: active }).market.readMint(SOLANA_USDG_MINT), marketError("invalid-mint"));
    }
    // Another token keeps its buy-blocking reasons.
    for (const [ext, reason] of [[feeExtension(fee(), fee(10, 100)), "transfer-fee"],
      [{ extension: "transferHook", state: { authority: null, programId: OTHER } }, "transfer-hook"]] as const) {
      assert.deepEqual((await fixture({ mint: token2022Mint([ext]) }).market.readMint(TOKEN)).buyBlockedReasons, [reason]);
    }
  });
  it("rejects corrupt confidential ciphertext without mistaking it for a raw token amount", async () => {
    for (const withheldAmount of ["0", "10", "", Buffer.alloc(32).toString("base64"), "A".repeat(88)]) {
      const mint = token2022Mint([{ extension: "confidentialTransferFeeConfig", state: {
        authority: OTHER, withdrawWithheldAuthorityElgamalPubkey: null, harvestToMintEnabled: true, withheldAmount,
      } }], true);
      await assert.rejects(fixture({ mint }).market.readMint(SOLANA_USDG_MINT), marketError("invalid-mint"));
    }
  });
  it("rejects duplicate extension tags and absent extension data on extended mints", async () => {
    const ext = { extension: "transferHook", state: { authority: null, programId: null } };
    await assert.rejects(fixture({ mint: token2022Mint([ext, ext]) }).market.readMint(TOKEN), marketError("invalid-mint"));
    const mint = token2022Mint([ext]); delete mint.value.data.parsed.info.extensions;
    await assert.rejects(fixture({ mint }).market.readMint(TOKEN), marketError("invalid-mint"));
  });
});

describe("Jupiter paper quotes", () => {
  it("uses only the fixed quote endpoint, binds request fields and strips upstream instructions", async () => {
    const { market, calls } = fixture({ quote: rawQuote({ swapTransaction: SECRET, instructions: [SECRET] }) });
    const result = await market.quote(INTENT);
    assert.deepEqual(result, { source: "jupiter", inputMint: INTENT.inputMint, outputMint: INTENT.outputMint,
      inAmount: INTENT.amountRaw, outAmount: "2000000", minOutAmount: "1980000", slippageBps: 100,
      contextSlot: SLOT, quotedAtMs: NOW, expiresAtMs: NOW + 30000 });
    const call = calls[0]!; const url = new URL(call.url);
    assert.equal(url.origin + url.pathname, "https://api.jup.ag/swap/v1/quote");
    assert.deepEqual(Object.fromEntries(url.searchParams), { inputMint: INTENT.inputMint, outputMint: INTENT.outputMint,
      amount: INTENT.amountRaw, slippageBps: "100", swapMode: "ExactIn", restrictIntermediateTokens: "true", platformFeeBps: "0" });
    assert.equal(call.init?.method, "GET"); assert.equal(call.init?.redirect, "error");
    assert.equal(new Headers(call.init?.headers).get("x-api-key"), SECRET);
    assert.deepEqual(calls.map(c => c.method), ["quote", "getGenesisHash", "getSlot"]);
    assert.ok(!JSON.stringify(result).includes(SECRET));
  });
  it("requires a private API key and accepts no live-mode or arbitrary-instruction intents", async () => {
    const { market, calls } = fixture({ env: { MERRYMEN_SOLANA_RPC_MAINNET: PRIMARY } });
    await assert.rejects(market.quote(INTENT), marketError("missing-jupiter-key"));
    for (const raw of [{ ...INTENT, mode: "live" }, { ...INTENT, slippageBps: 101 }, { ...INTENT, instructions: [SECRET] }]) {
      await assert.rejects(market.quote(raw as SolanaSwapIntent), safeError);
    }
    assert.equal(calls.length, 0);
    await assert.rejects(fixture({ env: { ...ENV, MERRYMEN_JUPITER_API_KEY: "secret\nheader" } }).market.quote(INTENT), marketError("invalid-jupiter-key"));
  });
  it("rejects mismatched mints, amounts, mode, slippage, malformed amounts and missing provenance", async () => {
    for (const override of [
      { inputMint: OTHER }, { outputMint: OTHER }, { inAmount: "999999" }, { outAmount: 10 },
      { outAmount: "0" }, { outAmount: "01" }, { outAmount: "18446744073709551616" },
      { otherAmountThreshold: "0" }, { otherAmountThreshold: undefined }, { swapMode: "ExactOut" },
      { slippageBps: 101 }, { contextSlot: undefined }, { contextSlot: "400000000" }, { error: SECRET },
      { routePlan: [] }, { routePlan: [{}] }, { routePlan: null },
    ]) {
      await assert.rejects(fixture({ quote: rawQuote(override) }).market.quote(INTENT), marketError("invalid-quote"));
    }
    for (const otherAmountThreshold of ["1979999", "2000001"]) {
      await assert.rejects(fixture({ quote: rawQuote({ otherAmountThreshold }) }).market.quote(INTENT), safeError);
    }
  });
  it("reports a well-formed quote with no minimum output as dust, distinct from an invalid quote", async () => {
    // 1 raw unit at 1% slippage floors to 0, as does an output of 0.
    for (const outAmount of ["0", "1"]) {
      await assert.rejects(fixture({ quote: rawQuote({ outAmount, otherAmountThreshold: "0", routePlan: [] }) }).market.quote(INTENT), marketError("zero-output"));
    }
    // The error carries the validated answer, the evidence a write-off keeps, and nothing else of the reply.
    const zero = await fixture({ quote: rawQuote({ outAmount: "1", otherAmountThreshold: "0", routePlan: [], extra: SECRET }) }).market.quote(INTENT)
      .then(() => null, (error: unknown) => error);
    assert.ok(zero instanceof SolanaMarketError && zero.code === "zero-output");
    assert.deepEqual(zero.zeroOutput, { source: "jupiter", inputMint: INTENT.inputMint, outputMint: INTENT.outputMint, inAmount: INTENT.amountRaw,
      outAmount: "1", minOutAmount: "0", slippageBps: 100, contextSlot: SLOT, quotedAtMs: NOW });
    assert.ok(Object.isFrozen(zero.zeroOutput));
    const noSlot = await fixture({ quote: rawQuote({ outAmount: "0", otherAmountThreshold: "0", contextSlot: "x" }) }).market.quote(INTENT)
      .then(() => null, (error: unknown) => error as SolanaMarketError);
    assert.equal(noSlot?.zeroOutput?.contextSlot, null, "a missing or invalid context slot is recorded as such, never invented");
    // Every other market error carries no answer.
    const invalid = await fixture({ quote: rawQuote({ outAmount: "2", otherAmountThreshold: "0" }) }).market.quote(INTENT).then(() => null, (error: unknown) => error as SolanaMarketError);
    assert.equal(invalid?.code, "invalid-quote");
    assert.equal(invalid?.zeroOutput, undefined);
    // Anything else about the answer wrong, or an output whose floor is not
    // zero, stays an invalid quote: dust is never inferred from a bad reply.
    for (const override of [
      { outAmount: "2", otherAmountThreshold: "0" }, { outAmount: "0", otherAmountThreshold: "1" },
      { outAmount: "0", otherAmountThreshold: "0", inputMint: OTHER }, { outAmount: "0", otherAmountThreshold: "0", inAmount: "999999" },
      { outAmount: "0", otherAmountThreshold: "0", slippageBps: 50 }, { outAmount: "0", otherAmountThreshold: "0", swapMode: "ExactOut" },
      { outAmount: "0", otherAmountThreshold: "0", error: "no route" }, { outAmount: "-1", otherAmountThreshold: "0" },
      { outAmount: 0, otherAmountThreshold: "0" }, { outAmount: "0", otherAmountThreshold: 0 },
    ]) {
      await assert.rejects(fixture({ quote: rawQuote(override) }).market.quote(INTENT), marketError("invalid-quote"), JSON.stringify(override));
    }
  });
  it("requires an actual connected route; supports split and multi-hop quotes", async () => {
    const route = rawQuote().routePlan;
    for (const mutate of [
      (r: Obj[]) => { r[0]!.swapInfo.inputMint = OTHER; },
      (r: Obj[]) => { r[0]!.percent = 0; },
      (r: Obj[]) => { r[0]!.swapInfo.ammKey = SECRET; },
      (r: Obj[]) => { r[0]!.swapInfo.outAmount = "0"; },
    ]) {
      const bad = structuredClone(route); mutate(bad);
      await assert.rejects(fixture({ quote: rawQuote({ routePlan: bad }) }).market.quote(INTENT), marketError("invalid-quote"));
    }
    const first = structuredClone(route[0]); first.swapInfo.outputMint = OTHER;
    const second = structuredClone(route[0]); second.swapInfo.inputMint = OTHER; second.swapInfo.inAmount = first.swapInfo.outAmount;
    assert.equal((await fixture({ quote: rawQuote({ routePlan: [first, second] }) }).market.quote(INTENT)).outAmount, "2000000");
  });
  it("rejects undersized route evidence, invented output and inconsistent allocations", async () => {
    const route = rawQuote().routePlan;
    for (const percent of [1, 100]) {
      const tiny = structuredClone(route[0]); tiny.percent = percent;
      tiny.swapInfo.inAmount = "1"; tiny.swapInfo.outAmount = "1";
      await assert.rejects(fixture({ quote: rawQuote({ routePlan: [tiny] }) }).market.quote(INTENT), marketError("invalid-quote"));
    }
    for (const [field, value] of [["inAmount", "999999"], ["inAmount", "1000001"], ["outAmount", "1999999"], ["outAmount", "2000001"]]) {
      const bad = structuredClone(route[0]); bad.swapInfo[field!] = value;
      await assert.rejects(fixture({ quote: rawQuote({ routePlan: [bad] }) }).market.quote(INTENT), marketError("invalid-quote"));
    }
    for (const values of [{ percent: 1 }, { percent: 99 }, { percent: 100, bps: 1 }, { percent: 100, bps: 0 }]) {
      const bad = { ...structuredClone(route[0]), ...values };
      await assert.rejects(fixture({ quote: rawQuote({ routePlan: [bad] }) }).market.quote(INTENT), marketError("invalid-quote"));
    }
  });
  it("conserves direct split and merged multi-hop amounts using exact integers", async () => {
    const route = rawQuote().routePlan;
    const first = structuredClone(route[0]); first.percent = 40;
    first.swapInfo.inAmount = "400000"; first.swapInfo.outAmount = "800000";
    const second = structuredClone(route[0]); second.percent = 60;
    second.swapInfo.inAmount = "600000"; second.swapInfo.outAmount = "1200000";
    const direct = [first, second];
    assert.equal((await fixture({ quote: rawQuote({ routePlan: direct }) }).market.quote(INTENT)).outAmount, "2000000");
    const wrongAllocation = structuredClone(direct); wrongAllocation[0].percent = 50; wrongAllocation[1].percent = 50;
    await assert.rejects(fixture({ quote: rawQuote({ routePlan: wrongAllocation }) }).market.quote(INTENT), marketError("invalid-quote"));
    first.swapInfo.outputMint = OTHER; second.swapInfo.outputMint = OTHER;
    const last = structuredClone(route[0]); last.swapInfo.inputMint = OTHER; last.swapInfo.inAmount = "2000000";
    assert.equal((await fixture({ quote: rawQuote({ routePlan: [first, second, last] }) }).market.quote(INTENT)).outAmount, "2000000");
    last.swapInfo.inAmount = "1999999";
    await assert.rejects(fixture({ quote: rawQuote({ routePlan: [first, second, last] }) }).market.quote(INTENT), marketError("invalid-quote"));
  });
  it("accepts basis-point allocations and optional rounded percentages", async () => {
    const first = structuredClone(rawQuote().routePlan[0]);
    first.bps = 3333; first.percent = 33; first.swapInfo.inAmount = "333300"; first.swapInfo.outAmount = "666600";
    const second = structuredClone(rawQuote().routePlan[0]);
    second.bps = 6667; second.percent = null; second.swapInfo.inAmount = "666700"; second.swapInfo.outAmount = "1333400";
    assert.equal((await fixture({ quote: rawQuote({ routePlan: [first, second] }) }).market.quote(INTENT)).outAmount, "2000000");
    first.percent = 50;
    await assert.rejects(fixture({ quote: rawQuote({ routePlan: [first, second] }) }).market.quote(INTENT), marketError("invalid-quote"));
    const nullBps = structuredClone(rawQuote().routePlan[0]); nullBps.bps = null;
    assert.equal((await fixture({ quote: rawQuote({ routePlan: [nullBps] }) }).market.quote(INTENT)).outAmount, "2000000");
  });
  it("rejects cyclic routes even when all raw amounts conserve", async () => {
    const middle = "11111111111111111111111111111111";
    const route = rawQuote().routePlan[0];
    const edge = (inputMint: string, outputMint: string, inAmount: string, outAmount: string, percent: number) => ({
      percent, swapInfo: { ...route.swapInfo, inputMint, outputMint, inAmount, outAmount },
    });
    const cycle = [edge(INTENT.inputMint, OTHER, "1000000", "2000000", 100),
      edge(OTHER, TOKEN, "2000000", "2000000", 67), edge(OTHER, middle, "1000000", "1000000", 33),
      edge(middle, OTHER, "1000000", "1000000", 100)];
    await assert.rejects(fixture({ quote: rawQuote({ routePlan: cycle }) }).market.quote(INTENT), marketError("invalid-quote"));
  });
  it("accepts only absent, null or explicitly zero platform fees", async () => {
    for (const platformFee of [undefined, null, { amount: "0", feeBps: 0 }]) {
      assert.equal((await fixture({ quote: rawQuote({ platformFee }) }).market.quote(INTENT)).outAmount, "2000000");
    }
    for (const platformFee of [{}, { amount: "1", feeBps: 0 }, { amount: "0", feeBps: 1 },
      { amount: 0, feeBps: 0 }, { amount: "0", feeBps: "0" }]) {
      await assert.rejects(fixture({ quote: rawQuote({ platformFee }) }).market.quote(INTENT), marketError("invalid-quote"));
    }
  });
  it("compares quote slot to a contemporaneous verified RPC and rejects stale or future context", async () => {
    for (const contextSlot of [SLOT - 76, SLOT + 33]) {
      await assert.rejects(fixture({ quote: rawQuote({ contextSlot }) }).market.quote(INTENT), marketError("stale-quote"));
    }
    for (const contextSlot of [SLOT - 75, SLOT + 32]) {
      assert.equal((await fixture({ quote: rawQuote({ contextSlot }) }).market.quote(INTENT)).contextSlot, contextSlot);
    }
  });
  it("stamps before fetching and rejects quote aging or a backwards clock", async () => {
    for (const age of [30000, -1]) {
      let reads = 0;
      await assert.rejects(fixture({ now: () => reads++ === 0 ? NOW : NOW + age }).market.quote(INTENT), safeError);
    }
    let reads = 0;
    const quote = await fixture({ now: () => reads++ === 0 ? NOW : NOW + 1234 }).market.quote(INTENT);
    assert.equal(quote.quotedAtMs, NOW); assert.equal(quote.expiresAtMs, NOW + 30000);
  });
  it("bounds requests and body streams and never leaks remote response details", async () => {
    const scenarios: Array<[typeof fetch, SolanaRpcError["code"]]> = [
      [async () => { throw new Error(PRIMARY); }, "network"],
      [async () => new Response(SECRET, { status: 401 }), "http"],
      [async () => new Response(null, { status: 302, headers: { location: PRIMARY } }), "redirect"],
      [async () => new Response(SECRET), "malformed"],
      [async () => new Response(" ".repeat(SOLANA_RESPONSE_LIMIT_BYTES + 1)), "too-large"],
      [async () => new Promise<Response>(() => {}), "timeout"],
      [async () => new Response(new ReadableStream({ start() {} })), "timeout"],
    ];
    for (const [fetch, code] of scenarios) {
      await assert.rejects(fixture({ fetch, timeoutMs: 10 }).market.quote(INTENT), rpcError(code));
    }
  });
});
