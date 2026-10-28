import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { getBase58Decoder } from "@solana/kit";
import { SOLANA_USDG_MINT, TOKEN_2022_PROGRAM } from "../../packages/core/src/ids";
import { SOLANA_CLASSIC_TOKEN_PROGRAM, SOLANA_WRAPPED_SOL_MINT } from "../../packages/core/src/solana-live";
import { SolanaPaperValidationError } from "../../packages/core/src/solana";
import { createSolanaLiveMarket, JUPITER_SWAP_PROGRAM, SOLANA_JUPITER_MAX_ACCOUNTS, SolanaLiveMarketError, validateJupiterCpi } from "./solana-live-market";
const key = (n: number) => getBase58Decoder().decode(new Uint8Array(32).fill(n));
function fixture() {
  const request = { requestId: "route-1", inputMint: SOLANA_USDG_MINT, outputMint: SOLANA_WRAPPED_SOL_MINT,
    amountRaw: "1000000", slippageBps: 100, swapAuthority: key(10), sourceTokenAccount: key(11), destinationTokenAccount: key(12),
    inputTokenProgram: TOKEN_2022_PROGRAM, outputTokenProgram: SOLANA_CLASSIC_TOKEN_PROGRAM };
  const quote = { source: "jupiter" as const, inputMint: request.inputMint, outputMint: request.outputMint,
    inAmount: request.amountRaw, outAmount: "2000000", minOutAmount: "1980000", slippageBps: 100,
    contextSlot: 1000, quotedAtMs: 100_000, expiresAtMs: 130_000 };
  const rawQuote = { ...quote, source: undefined, minOutAmount: undefined, quotedAtMs: undefined, expiresAtMs: undefined,
    otherAmountThreshold: quote.minOutAmount, swapMode: "ExactIn", platformFee: null, routePlan: [{ percent: 100,
      swapInfo: { ammKey: key(30), inputMint: request.inputMint, outputMint: request.outputMint, inAmount: request.amountRaw, outAmount: quote.outAmount } }] };
  const data = Buffer.alloc(36); createHash("sha256").update("global:shared_accounts_route").digest().subarray(0, 8).copy(data); data.writeUInt32LE(1, 9);
  data[14] = 100; data[16] = 1; data.writeBigUInt64LE(1_000_000n, 17); data.writeBigUInt64LE(2_000_000n, 25); data.writeUInt16LE(100, 33);
  const rawBuild = { swapInstruction: { programId: JUPITER_SWAP_PROGRAM, data: data.toString("base64"), accounts:
    [SOLANA_CLASSIC_TOKEN_PROGRAM, key(20), request.swapAuthority, request.sourceTokenAccount, key(21), key(22),
      request.destinationTokenAccount, request.inputMint, request.outputMint, JUPITER_SWAP_PROGRAM, TOKEN_2022_PROGRAM]
      .map((pubkey, i) => ({ pubkey, isSigner: i === 2, isWritable: [3,4,5,6].includes(i) })) }, addressLookupTableAddresses: [] as string[] };
  return { request, quote, rawQuote, rawBuild, data };
}
test("pinned route discriminator matches the Anchor IDL name independently", () => {
  const f = fixture();
  assert.deepEqual([...f.data.subarray(0, 8)], [193, 32, 155, 51, 65, 214, 156, 129]);
  assert.equal(validateJupiterCpi(f.rawBuild, f.request, f.quote).dataBase64, f.rawBuild.swapInstruction.data);
  createHash("sha256").update("global:route").digest().subarray(0, 8).copy(f.data);
  f.rawBuild.swapInstruction.data = f.data.toString("base64");
  assert.throws(() => validateJupiterCpi(f.rawBuild, f.request, f.quote));
});
test("quote and CPI use exact coherent v1 response, fixed origins, hard slippage and no provider transaction", async () => {
  const f = fixture(); const seen: { url: URL; init: RequestInit }[] = [];
  const market = createSolanaLiveMarket({ env: { MERRYMEN_SOLANA_RPC_MAINNET: "https://rpc.example/", MERRYMEN_JUPITER_API_KEY: "test-key" }, now: () => 100_000,
    rpc: { read: callback => callback(async () => 1000), send: async () => assert.fail("must not submit") },
    fetch: async (url, init) => { seen.push({ url: new URL(String(url)), init: init! });
      return Response.json(seen.length === 1 ? f.rawQuote : { ...f.rawBuild,
        setupInstructions: [{ programId: "untrusted" }], otherInstructions: [{ data: "untrusted" }], transaction: "untrusted" }); },
  });
  const built = await market.build(f.request);
  assert.deepEqual(built.quote, f.quote); assert.equal(built.dataBase64, f.rawBuild.swapInstruction.data);
  assert.ok(!Object.hasOwn(built, "transaction")); assert.ok(!Object.hasOwn(built, "otherInstructions"));
  assert.deepEqual(seen.map(item => item.url.origin + item.url.pathname), ["https://api.jup.ag/swap/v1/quote", "https://api.jup.ag/swap/v1/swap-instructions"]);
  assert.equal(seen[0]!.url.searchParams.get("instructionVersion"), "V1");
  // Routes sized under the vault's account bounds (55 distinct, 64 route accounts): 40, never Jupiter's default.
  assert.equal(SOLANA_JUPITER_MAX_ACCOUNTS, 40);
  assert.equal(seen[0]!.url.searchParams.get("maxAccounts"), "40");
  assert.equal(seen[0]!.url.searchParams.get("onlyDirectRoutes"), null);
  const body = JSON.parse(seen[1]!.init.body as string);
  assert.deepEqual(body.quoteResponse, JSON.parse(JSON.stringify(f.rawQuote)));
  assert.equal(body.userPublicKey, f.request.swapAuthority); assert.equal(body.destinationTokenAccount, f.request.destinationTokenAccount);
  assert.equal(body.wrapAndUnwrapSol, false); assert.equal(body.dynamicSlippage, false);
});
test("CPI rejects substituted authority, amount, output, slippage, fees, program and foreign signer", () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.rawBuild.swapInstruction.programId = key(40); },
    (f: ReturnType<typeof fixture>) => { f.rawBuild.swapInstruction.accounts[2]!.pubkey = key(40); },
    (f: ReturnType<typeof fixture>) => { f.rawBuild.swapInstruction.accounts[6]!.pubkey = key(40); },
    (f: ReturnType<typeof fixture>) => { f.rawBuild.swapInstruction.accounts[4]!.isSigner = true; },
    (f: ReturnType<typeof fixture>) => { f.data.writeBigUInt64LE(1n, 17); f.rawBuild.swapInstruction.data = f.data.toString("base64"); },
    (f: ReturnType<typeof fixture>) => { f.data.writeBigUInt64LE(1n, 25); f.rawBuild.swapInstruction.data = f.data.toString("base64"); },
    (f: ReturnType<typeof fixture>) => { f.data.writeUInt16LE(200, 33); f.rawBuild.swapInstruction.data = f.data.toString("base64"); },
    (f: ReturnType<typeof fixture>) => { f.data[35] = 1; f.rawBuild.swapInstruction.data = f.data.toString("base64"); },
    (f: ReturnType<typeof fixture>) => { f.rawBuild.addressLookupTableAddresses = [key(30), key(30)]; },
  ]) { const f = fixture(); mutate(f); assert.throws(() => validateJupiterCpi(f.rawBuild, f.request, f.quote)); }
});
test("stale chain context and incoherent quote graph never produce a CPI", async () => {
  for (const stale of [false, true]) {
    const f = fixture(); if (!stale) f.rawQuote.routePlan[0]!.swapInfo.inAmount = "1";
    let requests = 0;
    const market = createSolanaLiveMarket({ env: { MERRYMEN_SOLANA_RPC_MAINNET: "https://rpc.example/", MERRYMEN_JUPITER_API_KEY: "test-key" }, now: () => 100_000,
      rpc: { read: callback => callback(async () => 1100), send: async () => assert.fail("must not submit") },
      fetch: async () => Response.json(++requests === 1 ? f.rawQuote : f.rawBuild) });
    await assert.rejects(market.build(f.request)); if (!stale) assert.equal(requests, 1);
  }
});

const code = (expected: SolanaLiveMarketError["code"]) => (error: unknown) => error instanceof SolanaLiveMarketError && error.code === expected;
test("every refusal says why: a missing or unusable key is configuration, and nothing is asked of Jupiter", async () => {
  const f = fixture();
  for (const apiKey of [undefined, "", "   ", "bad key", "x".repeat(1025), "caf\u00e9"]) {
    let requests = 0;
    const market = createSolanaLiveMarket({ env: { MERRYMEN_SOLANA_RPC_MAINNET: "https://rpc.example/", ...(apiKey === undefined ? {} : { MERRYMEN_JUPITER_API_KEY: apiKey }) },
      now: () => 100_000, rpc: { read: callback => callback(async () => 1000), send: async () => assert.fail("must not submit") },
      fetch: async () => { requests++; return Response.json(f.rawQuote); } });
    await assert.rejects(market.build(f.request), code("configuration"), JSON.stringify(apiKey));
    assert.equal(requests, 0, JSON.stringify(apiKey));
  }
});
/** A sharedAccountsRoute of `length` bytes and `steps` route steps, consistent with the fixture's request and quote. */
function sharedRoute(length: number, steps: number) {
  const data = Buffer.alloc(length); createHash("sha256").update("global:shared_accounts_route").digest().subarray(0, 8).copy(data);
  data.writeUInt32LE(steps, 9); const tail = length - 19;
  data.writeBigUInt64LE(1_000_000n, tail); data.writeBigUInt64LE(2_000_000n, tail + 8); data.writeUInt16LE(100, tail + 16);
  return data.toString("base64");
}
const otherRoute = (name: string) => (f: ReturnType<typeof fixture>) => {
  createHash("sha256").update(`global:${name}`).digest().subarray(0, 8).copy(f.data); f.rawBuild.swapInstruction.data = f.data.toString("base64");
};
const extraAccounts = (count: number) => Array.from({ length: count }, (_, i) => ({ pubkey: key(100 + i), isSigner: false, isWritable: false }));
test("a route shape the vault does not take is 'route'; an unusable or inconsistent answer is 'provider'", () => {
  const route: Array<(f: ReturnType<typeof fixture>) => void> = [
    // Another pinned V1 Jupiter route instruction.
    otherRoute("route"), otherRoute("route_with_token_ledger"), otherRoute("exact_out_route"),
    otherRoute("shared_accounts_exact_out_route"), otherRoute("shared_accounts_route_with_token_ledger"),
    // A well-formed route consistent with the request, too large for the vault.
    f => { f.rawBuild.swapInstruction.accounts.push(...extraAccounts(54)); },
    f => { f.rawBuild.addressLookupTableAddresses = Array.from({ length: 9 }, (_, i) => key(60 + i)); },
    f => { f.rawBuild.swapInstruction.data = sharedRoute(13 + 65 * 4 + 19, 65); },
    f => { f.rawBuild.swapInstruction.data = sharedRoute(901, 1); },
  ];
  const provider: Array<(f: ReturnType<typeof fixture>) => void> = [
    // Malformed answers whatever their size or instruction: never "no supported route".
    f => { Buffer.alloc(8, 0xab).copy(f.data); f.rawBuild.swapInstruction.data = f.data.toString("base64"); },
    f => { f.rawBuild.swapInstruction.data = Buffer.alloc(901, 0xff).toString("base64"); },
    f => { f.rawBuild.swapInstruction.data = Buffer.alloc(901, 1).toString("base64"); },
    f => { f.rawBuild.swapInstruction.data = Buffer.alloc(7).toString("base64"); },
    f => { (f.rawBuild.swapInstruction as Record<string, unknown>).accounts = Array.from({ length: 65 }, () => ({ pubkey: "garbage", isSigner: "x" })); },
    f => { f.rawBuild.swapInstruction.accounts.push(...extraAccounts(53), { pubkey: "garbage", isSigner: false, isWritable: false }); },
    f => { f.rawBuild.addressLookupTableAddresses = [...Array.from({ length: 8 }, (_, i) => key(60 + i)), "garbage"]; },
    f => { otherRoute("route")(f); f.rawBuild.swapInstruction.accounts[5]!.pubkey = "not a key"; },
    f => { otherRoute("exact_out_route")(f); f.rawBuild.addressLookupTableAddresses = [key(30), "garbage"]; },
    // Oversized, but also inconsistent with the request or malformed inside.
    f => { f.rawBuild.swapInstruction.data = sharedRoute(901, 1); f.rawBuild.swapInstruction.accounts[2]!.pubkey = key(40); },
    f => { f.rawBuild.swapInstruction.accounts.push(...extraAccounts(54)); f.data.writeBigUInt64LE(1n, 17); f.rawBuild.swapInstruction.data = f.data.toString("base64"); },
    f => { f.data.writeUInt32LE(65, 9); f.rawBuild.swapInstruction.data = f.data.toString("base64"); },
    f => { (f.rawBuild as Record<string, unknown>).swapInstruction = null; },
    f => { f.rawBuild.swapInstruction.programId = key(40); },
    f => { f.rawBuild.swapInstruction.accounts.length = 10; },
    f => { f.rawBuild.swapInstruction.data = "not base64!"; },
    f => { f.rawBuild.swapInstruction.data = f.data.subarray(0, 30).toString("base64"); },
    f => { f.data.writeBigUInt64LE(1n, 17); f.rawBuild.swapInstruction.data = f.data.toString("base64"); },
    f => { f.data.writeBigUInt64LE(1n, 25); f.rawBuild.swapInstruction.data = f.data.toString("base64"); },
    f => { f.data.writeUInt16LE(200, 33); f.rawBuild.swapInstruction.data = f.data.toString("base64"); },
    f => { f.data[35] = 1; f.rawBuild.swapInstruction.data = f.data.toString("base64"); },
    f => { f.data.writeUInt32LE(0, 9); f.rawBuild.swapInstruction.data = f.data.toString("base64"); },
    f => { f.data.writeUInt32LE(5, 9); f.rawBuild.swapInstruction.data = f.data.toString("base64"); },
    f => { f.rawBuild.swapInstruction.accounts[2]!.pubkey = key(40); },
    f => { f.rawBuild.swapInstruction.accounts[4]!.isSigner = true; },
    f => { f.rawBuild.swapInstruction.accounts[5]!.pubkey = "not a key"; },
    f => { f.rawBuild.swapInstruction.accounts[10]!.pubkey = JUPITER_SWAP_PROGRAM; },
    f => { (f.rawBuild as Record<string, unknown>).addressLookupTableAddresses = null; },
    f => { f.rawBuild.addressLookupTableAddresses = [key(30), key(30)]; },
  ];
  for (const [expected, mutations] of [["route", route], ["provider", provider]] as const) {
    mutations.forEach((mutate, index) => {
      const f = fixture(); mutate(f);
      assert.throws(() => validateJupiterCpi(f.rawBuild, f.request, f.quote), code(expected), `${expected} ${index}`);
    });
  }
});
test("the largest route the vault takes is still built: 900 bytes, 64 steps, 64 accounts and 8 lookup tables", () => {
  const f = fixture();
  f.rawBuild.swapInstruction.data = sharedRoute(900, 64);
  f.rawBuild.swapInstruction.accounts.push(...extraAccounts(53));
  f.rawBuild.addressLookupTableAddresses = Array.from({ length: 8 }, (_, i) => key(60 + i));
  const built = validateJupiterCpi(f.rawBuild, f.request, f.quote);
  assert.equal(built.accounts.length, 64); assert.equal(built.lookupTableAddresses.length, 8);
  assert.equal(Buffer.from(built.dataBase64, "base64").length, 900);
});
test("a quote outside the RPC's slot window, an incoherent quote graph or a fee are 'provider', never 'route'", async () => {
  for (const problem of ["stale", "graph", "fee", "exact-out"] as const) {
    const f = fixture();
    if (problem === "graph") f.rawQuote.routePlan[0]!.swapInfo.inAmount = "1";
    if (problem === "fee") (f.rawQuote as Record<string, unknown>).platformFee = { amount: "5", feeBps: 1 };
    if (problem === "exact-out") f.rawQuote.swapMode = "ExactOut";
    const market = createSolanaLiveMarket({ env: { MERRYMEN_SOLANA_RPC_MAINNET: "https://rpc.example/", MERRYMEN_JUPITER_API_KEY: "test-key" }, now: () => 100_000,
      rpc: { read: callback => callback(async () => problem === "stale" ? 1100 : 1000), send: async () => assert.fail("must not submit") },
      fetch: async url => Response.json(String(url).includes("/quote?") ? f.rawQuote : f.rawBuild) });
    await assert.rejects(market.build(f.request), code("provider"), problem);
  }
});
test("a quote the shared validators refuse is the provider's too, never the owner's 400 with validator text", async () => {
  type Quote = ReturnType<typeof fixture>["rawQuote"] & Record<string, unknown>;
  const answers: Record<string, (q: Quote) => void> = {
    "non-canonical output": q => { q.outAmount = "02000000"; },
    "zero output": q => { q.outAmount = "0"; q.otherAmountThreshold = "0"; q.routePlan[0]!.swapInfo.outAmount = "0"; },
    "another slippage": q => { q.slippageBps = 50; },
    "minimum above the output": q => { q.otherAmountThreshold = "2000001"; },
    "no context slot": q => { delete (q as Record<string, unknown>).contextSlot; },
    "another input mint": q => { q.inputMint = SOLANA_WRAPPED_SOL_MINT; },
  };
  for (const [problem, mutate] of Object.entries(answers)) {
    const f = fixture(); mutate(f.rawQuote as Quote);
    let builds = 0;
    const market = createSolanaLiveMarket({ env: { MERRYMEN_SOLANA_RPC_MAINNET: "https://rpc.example/", MERRYMEN_JUPITER_API_KEY: "test-key" }, now: () => 100_000,
      rpc: { read: callback => callback(async () => 1000), send: async () => assert.fail("must not submit") },
      fetch: async url => String(url).includes("/quote?") ? Response.json(f.rawQuote) : (builds++, Response.json(f.rawBuild)) });
    await assert.rejects(market.build(f.request), code("provider"), problem);
    assert.equal(builds, 0, `${problem}: no swap instructions asked for`);
  }
  // A provider slow enough that its quote went stale before the swap instructions came back.
  const f = fixture(); let clock = 100_000;
  const slow = createSolanaLiveMarket({ env: { MERRYMEN_SOLANA_RPC_MAINNET: "https://rpc.example/", MERRYMEN_JUPITER_API_KEY: "test-key" }, now: () => clock,
    rpc: { read: callback => callback(async () => 1000), send: async () => assert.fail("must not submit") },
    fetch: async url => { if (!String(url).includes("/quote?")) clock += 31_000; return Response.json(String(url).includes("/quote?") ? f.rawQuote : f.rawBuild); } });
  await assert.rejects(slow.build(f.request), code("provider"), "stale after a slow build");
  // The owner's own malformed request is still refused as theirs, before anything is asked.
  let asked = 0;
  const owner = createSolanaLiveMarket({ env: { MERRYMEN_SOLANA_RPC_MAINNET: "https://rpc.example/", MERRYMEN_JUPITER_API_KEY: "test-key" }, now: () => 100_000,
    rpc: { read: callback => callback(async () => 1000), send: async () => assert.fail("must not submit") },
    fetch: async () => { asked++; return Response.json(f.rawQuote); } });
  await assert.rejects(owner.build({ ...f.request, amountRaw: "01" }), (error: unknown) => error instanceof SolanaPaperValidationError);
  assert.equal(asked, 0);
});
