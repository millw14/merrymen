/**
 * The worker's mint screen and the vault program on the mainnet USDG mint.
 * contracts/solana/runtime-tests/fixtures/usdg-mainnet-mint.json holds the
 * mint's bytes as one read-only getAccountInfo returned them, and variants of
 * those bytes, each with the verdict the compiled vault gives (custody.rs
 * runs a buy and an exit against every one). Here the worker's readMint reads
 * the same bytes as Agave's jsonParsed encoding presents them:
 * usdg-mainnet-mint.jsonparsed.json is Agave 2.3.13's own account decoder
 * output for each variant (contracts/solana/scripts/usdg-jsonparsed.mjs, made
 * offline), and this file's own decoding of the bytes must equal it. A USDG
 * mint the vault refuses fails every swap on chain, buys and exits alike, so
 * the worker must refuse it before anything is signed, and must accept the
 * mint the vault accepts.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { base58Encode, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM } from "../../packages/core/src/ids";
import { SOLANA_VAULT_USDG_MINT_EXTENSIONS, solanaVaultUsdgMintRefusal } from "../../packages/core/src/solana-live";
import { createSolanaMarket, SolanaMarketError } from "./solana-market";
import { SOLANA_MAINNET_GENESIS_HASH } from "./solana-rpc";

type Op = { op: "set"; at: number; hex: string } | { op: "append"; hex: string };
type Variant = { name: string; vault: "accepts" | "refuses"; ops: Op[]; sha256: string };
const fixture = JSON.parse(readFileSync(new URL("../../contracts/solana/runtime-tests/fixtures/usdg-mainnet-mint.json", import.meta.url), "utf8")) as {
  address: string; owner: string; slot: number; lamports: number; dataBase64: string; dataSha256: string;
  decoded: { extensions: string[] }; variants: Variant[];
};
/** Agave's account decoder on the same bytes: the jsonParsed form an RPC node returns for each variant. */
const agave = JSON.parse(readFileSync(new URL("../../contracts/solana/runtime-tests/fixtures/usdg-mainnet-mint.jsonparsed.json", import.meta.url), "utf8")) as {
  source: string; ledgerTool: string; variants: { name: string; sha256: string; address: string }[];
  ledgerToolOutput: { accounts: { pubkey: string; account: Record<string, unknown> & { data: unknown } }[] };
};
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/**
 * The production RPC provider's own jsonParsed answer for the USDG mint, when one is
 * committed (contracts/solana/scripts/usdg-rpc-jsonparsed.mjs, one read-only call, run
 * only with the owner's OK). Agave 2.3.13's decoder above runs offline; a provider may
 * run a newer one, and the worker refuses a field shape it does not expect.
 */
const RPC_ANSWER = new URL("../../contracts/solana/runtime-tests/fixtures/usdg-mainnet-mint.rpc-jsonparsed.json", import.meta.url);
type RpcScript = {
  OUTPUT: string; USDG_MINT: string; requestBody(): string;
  parseArgs(argv: string[]): { provider: string; rpc: string };
  rpcRecord(body: string, head: { provider: string; readAtUtc: string }): string;
};
const rpcScript = () => import(new URL("../../contracts/solana/scripts/usdg-rpc-jsonparsed.mjs", import.meta.url).href) as Promise<RpcScript>;
/** Field names, in sorted order, with each leaf's JSON type: what a decoder change would alter. */
function shapeOf(value: unknown): unknown {
  if (value === null) return "null";
  if (Array.isArray(value)) return value.map(shapeOf);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, shapeOf(record[key])]));
  }
  return typeof value;
}

/** The account Agave's decoder printed for a variant, as getAccountInfo's value. */
function agaveAccount(variant: Variant) {
  const placed = agave.variants.filter((v) => v.name === variant.name && v.sha256 === variant.sha256);
  assert.equal(placed.length, 1, `${variant.name}: not decoded by Agave once`);
  const printed = agave.ledgerToolOutput.accounts.filter((a) => a.pubkey === placed[0]!.address);
  assert.equal(printed.length, 1, `${variant.name}: not printed once`);
  return printed[0]!.account;
}

/** The read bytes changed by a variant's ops, in order, exactly as custody.rs applies them. */
function variantBytes(variant: Variant): Buffer {
  let data = Buffer.from(fixture.dataBase64, "base64");
  for (const op of variant.ops) {
    const bytes = Buffer.from(op.hex, "hex");
    if (op.op === "set") bytes.copy(data, op.at);
    else data = Buffer.concat([data, bytes]);
  }
  assert.equal(sha256(data), variant.sha256, variant.name);
  return data;
}

/**
 * A Token-2022 mint account in Agave's jsonParsed form (account-decoder's
 * UiMint and UiExtension, camelCase, tagged "extension" with "state"), for the
 * extension types the fixture uses. Anything else is unparseableExtension, as
 * Agave reports a type it cannot decode. An independent decoding of the bytes:
 * the test below holds it equal to Agave's own output, so the committed
 * decoder output is shown to be of these bytes.
 */
function jsonParsedMint(data: Buffer, slot: number) {
  const key = (at: number) => base58Encode(new Uint8Array(data.subarray(at, at + 32)));
  const optional = (at: number) => (data.subarray(at, at + 32).every((b) => b === 0) ? null : key(at));
  const optionalBase64 = (at: number, length: number) =>
    data.subarray(at, at + length).every((b) => b === 0) ? null : data.subarray(at, at + length).toString("base64");
  const fee = (at: number) => ({ epoch: Number(data.readBigUInt64LE(at)), maximumFee: Number(data.readBigUInt64LE(at + 8)),
    transferFeeBasisPoints: data.readUInt16LE(at + 16) });
  const text = (at: number): [string, number] => {
    const length = data.readUInt32LE(at);
    return [data.subarray(at + 4, at + 4 + length).toString("utf8"), at + 4 + length];
  };
  assert.equal(data[165], 1, "AccountType::Mint");
  const extensions: unknown[] = [];
  for (let at = 166; at + 4 <= data.length;) {
    const type = data.readUInt16LE(at), length = data.readUInt16LE(at + 2), v = at + 4;
    if (type === 0) break;
    assert.ok(v + length <= data.length, "TLV entry overruns the account");
    switch (type) {
      case 1: extensions.push({ extension: "transferFeeConfig", state: { transferFeeConfigAuthority: optional(v), withdrawWithheldAuthority: optional(v + 32),
        withheldAmount: Number(data.readBigUInt64LE(v + 64)), olderTransferFee: fee(v + 72), newerTransferFee: fee(v + 90) } }); break;
      case 3: extensions.push({ extension: "mintCloseAuthority", state: { closeAuthority: optional(v) } }); break;
      case 4: extensions.push({ extension: "confidentialTransferMint", state: { authority: optional(v), autoApproveNewAccounts: data[v + 32] === 1,
        auditorElgamalPubkey: optionalBase64(v + 33, 32) } }); break;
      case 6: extensions.push({ extension: "defaultAccountState", state: { accountState: ["uninitialized", "initialized", "frozen"][data[v]!] } }); break;
      case 12: extensions.push({ extension: "permanentDelegate", state: { delegate: optional(v) } }); break;
      case 14: extensions.push({ extension: "transferHook", state: { authority: optional(v), programId: optional(v + 32) } }); break;
      case 16: extensions.push({ extension: "confidentialTransferFeeConfig", state: { authority: optional(v),
        withdrawWithheldAuthorityElgamalPubkey: optionalBase64(v + 32, 32), harvestToMintEnabled: data[v + 64] === 1,
        withheldAmount: data.subarray(v + 65, v + 129).toString("base64") } }); break;
      case 18: extensions.push({ extension: "metadataPointer", state: { authority: optional(v), metadataAddress: optional(v + 32) } }); break;
      case 19: {
        const [name, afterName] = text(v + 64), [symbol, afterSymbol] = text(afterName), [uri, afterUri] = text(afterSymbol);
        assert.equal(data.readUInt32LE(afterUri), 0, "no additional metadata in the fixture");
        extensions.push({ extension: "tokenMetadata", state: { updateAuthority: optional(v), mint: key(v + 32), name, symbol, uri, additionalMetadata: [] } });
        break;
      }
      case 20: extensions.push({ extension: "groupPointer", state: { authority: optional(v), groupAddress: optional(v + 32) } }); break;
      default: extensions.push({ extension: "unparseableExtension" });
    }
    at = v + length;
  }
  const coption = (at: number) => (data.readUInt32LE(at) === 1 ? key(at + 4) : null);
  return { context: { slot }, value: { executable: false, owner: fixture.owner, lamports: fixture.lamports, space: data.length,
    data: { program: "spl-token-2022", space: data.length, parsed: { type: "mint", info: {
      decimals: data[44], freezeAuthority: coption(46), isInitialized: data[45] === 1, mintAuthority: coption(0),
      supply: data.readBigUInt64LE(36).toString(), extensions } } } } };
}

type Verdict = "accepts" | "refuses buys only" | "refuses";
/** What the worker does with a getAccountInfo value: trade both ways, refuse buys only, or refuse the mint (every swap). */
async function workerVerdict(account: unknown): Promise<Verdict> {
  const slot = fixture.slot;
  const fetcher: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { id: number; method: string };
    const result = body.method === "getGenesisHash" ? SOLANA_MAINNET_GENESIS_HASH : body.method === "getSlot" ? slot : { context: { slot }, value: account };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  };
  const market = createSolanaMarket({ env: { MERRYMEN_SOLANA_RPC_MAINNET: "https://rpc.example.test/" }, fetch: fetcher, now: () => 1_800_000_000_000 });
  try {
    const mint = await market.readMint(SOLANA_USDG_MINT);
    assert.deepEqual([mint.address, mint.program, mint.decimals], [SOLANA_USDG_MINT, TOKEN_2022_PROGRAM, 6]);
    return mint.buyBlockedReasons.length ? "refuses buys only" : "accepts";
  } catch (error) {
    if (error instanceof SolanaMarketError && error.code === "invalid-mint") return "refuses";
    throw error;
  }
}

/**
 * Variants the vault refuses but the worker's screen (worker/src/solana-market.ts
 * mintFromRpc) does not yet refuse for every swap, with what the worker does today:
 * it would sign an exit, or a buy, that fails on chain with VaultError::Mint. The fix
 * is a cross-track change to solana-market.ts mintFromRpc: refuse (invalid-mint) a USDG
 * mint that solanaVaultUsdgMintRefusal (packages/core/src/solana-live.ts, check_mint's
 * USDG branch) refuses: any extension outside SOLANA_VAULT_USDG_MINT_EXTENSIONS, a
 * transfer fee above 0 bps older or newer, or a transfer hook program. That function
 * already refuses every gap (checked below). Each gap's test pins today's verdict, so it
 * fails the moment the worker's screen changes either way: when the fix lands, delete
 * the entry (the test then requires the vault's verdict); a regression elsewhere fails
 * too. Nothing here is todo or skipped.
 */
const WORKER_GAPS = new Map<string, Verdict>([]);

describe("the mainnet USDG mint, as the worker and the vault see it", () => {
  it("is the mint read from mainnet, carrying only extensions the vault accepts", () => {
    assert.equal(fixture.address, SOLANA_USDG_MINT);
    assert.equal(fixture.owner, TOKEN_2022_PROGRAM);
    assert.equal(sha256(Buffer.from(fixture.dataBase64, "base64")), fixture.dataSha256);
    const read = fixture.variants[0]!;
    assert.deepEqual([read.name, read.vault, read.ops], ["as read", "accepts", []]);
    const parsed = jsonParsedMint(variantBytes(read), fixture.slot).value.data.parsed.info;
    assert.deepEqual((parsed.extensions as { extension: string }[]).map((e) => e.extension),
      fixture.decoded.extensions.map((name) => name[0]!.toLowerCase() + name.slice(1)));
    for (const { extension } of parsed.extensions as { extension: string }[]) assert.ok(SOLANA_VAULT_USDG_MINT_EXTENSIONS.includes(extension), extension);
    assert.ok(fixture.variants.some((v) => v.vault === "refuses"));
    for (const [name, today] of WORKER_GAPS) {
      const variant = fixture.variants.find((v) => v.name === name);
      assert.equal(variant?.vault, "refuses", name);
      assert.notEqual(today, "refuses", `${name}: a gap the worker already closes`);
      // The check the worker is missing already gives the vault's verdict on Agave's decoding.
      const info = (agaveAccount(variant!).data as { parsed: { info: unknown } }).parsed.info;
      assert.notEqual(solanaVaultUsdgMintRefusal(info), null, name);
    }
    // solana-market.ts refuses every USDG mint the vault refuses: a new gap is a regression.
    assert.equal(WORKER_GAPS.size, 0, "the worker refuses every USDG mint the vault refuses");
  });
  it("is decoded by Agave's own jsonParsed decoder, and this file decodes every variant exactly as Agave does", () => {
    assert.equal(agave.source, "usdg-mainnet-mint.json");
    assert.match(agave.ledgerTool, /^agave-ledger-tool 2\.3\.13 /);
    assert.deepEqual(agave.variants.map((v) => [v.name, v.sha256]), fixture.variants.map((v) => [v.name, v.sha256]));
    assert.equal(agave.ledgerToolOutput.accounts.length, fixture.variants.length);
    for (const variant of fixture.variants) {
      const bytes = variantBytes(variant), account = agaveAccount(variant);
      const { rentEpoch, ...decoded } = account;
      assert.equal(typeof rentEpoch, "number", variant.name);
      assert.deepEqual(decoded, jsonParsedMint(bytes, fixture.slot).value, variant.name);
    }
  });
  /**
   * An RPC provider's jsonParsed answer for the mint, checked against Agave 2.3.13's
   * decoding of the committed bytes: the same fields, types and extensions in the same
   * order; the vault's check_mint accepts it and so does the worker. A mismatch means the
   * provider's decoder differs (fix the worker's reader first) or the mint changed (read
   * its bytes again, with usdg-mainnet-mint.json).
   */
  async function checkRpcAnswer(record: { address: string; response: { result: { value: { data: { parsed: { info: unknown } } } } } }) {
    assert.equal(record.address, SOLANA_USDG_MINT);
    const value = record.response.result.value;
    assert.deepEqual(shapeOf(value), shapeOf(agaveAccount(fixture.variants[0]!)), "the provider's jsonParsed form differs from Agave 2.3.13's");
    assert.equal(solanaVaultUsdgMintRefusal(value.data.parsed.info), null);
    assert.equal(await workerVerdict(value), "accepts");
  }
  it("checks a recorded RPC answer for the mint against Agave 2.3.13's decoding, and catches a renamed field", async () => {
    const script = await rpcScript();
    assert.equal(script.USDG_MINT, SOLANA_USDG_MINT);
    assert.equal(new URL(script.OUTPUT, RPC_ANSWER).href, RPC_ANSWER.href);
    assert.deepEqual(JSON.parse(script.requestBody()), { jsonrpc: "2.0", id: 1, method: "getAccountInfo",
      params: [SOLANA_USDG_MINT, { encoding: "jsonParsed", commitment: "finalized" }] });
    // An answer exactly as Agave 2.3.13 decodes the read bytes passes, through the script's own record.
    const answer = (account: unknown) => `{"jsonrpc":"2.0","result":{"context":{"apiVersion":"2.3.13","slot":${fixture.slot}},"value":${JSON.stringify(account)}},"id":1}`;
    const asRead = agaveAccount(fixture.variants[0]!);
    const record = JSON.parse(script.rpcRecord(answer(asRead), { provider: "test", readAtUtc: "2026-10-20T00:00:00Z" }));
    assert.deepEqual([record.provider, record.slot, record.apiVersion, record.method, record.encoding, record.commitment],
      ["test", fixture.slot, "2.3.13", "getAccountInfo", "jsonParsed", "finalized"]);
    assert.ok(!JSON.stringify(record).includes("://rpc"), "no URL is recorded");
    await checkRpcAnswer(record);
    // A decoder that renames one fee field is caught here; the worker would refuse USDG (no trading).
    const renamed = JSON.parse(JSON.stringify(asRead).replaceAll("transferFeeBasisPoints", "basisPoints"));
    await assert.rejects(checkRpcAnswer(JSON.parse(script.rpcRecord(answer(renamed), { provider: "test", readAtUtc: "x" }))), /differs from Agave 2\.3\.13/);
    assert.equal(await workerVerdict(renamed), "refuses");
    // The script records only a jsonParsed Token-2022 mint answer to its own request, never a URL as the provider.
    assert.throws(() => script.rpcRecord(answer({ ...asRead, owner: "11111111111111111111111111111111" }), { provider: "test", readAtUtc: "x" }), /not the USDG mint/);
    assert.throws(() => script.rpcRecord('{"jsonrpc":"2.0","error":{"code":-32602},"id":1}', { provider: "test", readAtUtc: "x" }), /returned an error/);
    assert.throws(() => script.rpcRecord(answer(asRead).replace('"id":1', '"id":2'), { provider: "test", readAtUtc: "x" }), /not a JSON-RPC 2\.0 response/);
    assert.deepEqual(script.parseArgs(["--provider", "Helius", "--rpc", "https://rpc.example.test/?api-key=k"]),
      { provider: "Helius", rpc: "https://rpc.example.test/?api-key=k" });
    for (const argv of [["--provider", "https://rpc.example.test/", "--rpc", "https://rpc.example.test/"], ["--provider", "x", "--rpc", "http://rpc.example.test/"],
      ["--rpc", "https://rpc.example.test/"], ["--provider", "x", "--rpc", "https://a.test/", "--rpc", "https://b.test/"], ["--provider", "x", "--key", "y"]]) {
      assert.throws(() => script.parseArgs(argv), /usage|--provider|--rpc/, argv.join(" "));
    }
  });
  const committed = existsSync(RPC_ANSWER);
  it("is read by the production RPC provider in the form Agave 2.3.13 decodes it", {
    skip: committed ? false : "no production RPC answer is committed yet: with the owner's OK, run contracts/solana/scripts/usdg-rpc-jsonparsed.mjs once",
  }, async () => {
    await checkRpcAnswer(JSON.parse(readFileSync(RPC_ANSWER, "utf8")));
  });
  for (const variant of fixture.variants) {
    const today = WORKER_GAPS.get(variant.name);
    const vault = variant.vault === "accepts" ? "trades it both ways, and so does the worker" : "refuses every swap, and so must the worker, before signing";
    it(`${variant.name}: the vault ${vault}${today ? ` (gap: the worker ${today}, until solana-market.ts refuses it)` : ""}`, async () => {
      const verdict = await workerVerdict(agaveAccount(variant));
      if (today === undefined) assert.equal(verdict, variant.vault);
      else assert.equal(verdict, today, `the worker's screen changed for "${variant.name}": if it now refuses, as the vault does, delete it from WORKER_GAPS`);
    });
  }
});
