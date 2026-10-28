#!/usr/bin/env node
// Writes runtime-tests/fixtures/usdg-mainnet-mint.rpc-jsonparsed.json: the
// mainnet USDG mint as the deployment's own RPC provider returns it in the
// jsonParsed encoding the worker reads (worker/src/solana-market.ts), kept
// verbatim. usdg-mainnet-mint.jsonparsed.json is Agave 2.3.13's decoder run
// offline; a provider may run a newer one, and the worker refuses any field
// shape it does not expect, which would stop all Solana trading.
// worker/src/solana-usdg-mint.test.ts checks this answer against Agave
// 2.3.13's decoding of the committed bytes (the same fields, types and
// extensions) and runs the worker's mint screen and the vault's check_mint
// verdict (solanaVaultUsdgMintRefusal) on it.
//
//   node contracts/solana/scripts/usdg-rpc-jsonparsed.mjs --provider NAME --rpc HTTPS_URL
//
// ONE NETWORK READ, RUN ONLY WITH THE OWNER'S OK. It sends exactly one
// JSON-RPC request, getAccountInfo for the USDG mint (jsonParsed, finalized):
// no key, no signature, no transaction, no other method. The URL may carry an
// API key, so it is never printed or written: the fixture names the provider
// by --provider alone. Nothing else is read (no .env file, no keypair).
import { realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.join(HERE, "..", "runtime-tests", "fixtures");
export const OUTPUT = "usdg-mainnet-mint.rpc-jsonparsed.json";
export const USDG_MINT = "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
/** The largest answer kept: the mint's jsonParsed form is about 3 KiB. */
export const MAX_RESPONSE_BYTES = 64 * 1024;
const TIMEOUT_MS = 20_000;
const USAGE = "usage: usdg-rpc-jsonparsed.mjs --provider NAME --rpc HTTPS_URL";

/** The one request this script sends. */
export function requestBody() {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo",
    params: [USDG_MINT, { encoding: "jsonParsed", commitment: "finalized" }] });
}

/** --provider NAME (a label, never a URL) and --rpc HTTPS_URL, each exactly once; nothing else. */
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i], value = argv[i + 1];
    if ((flag !== "--provider" && flag !== "--rpc") || value === undefined || flag.slice(2) in out) throw new Error(USAGE);
    out[flag.slice(2)] = value;
  }
  if (!out.provider || !out.rpc) throw new Error(USAGE);
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(out.provider)) {
    throw new Error("--provider is a short name for the RPC provider (letters, digits, space, . _ -), never its URL");
  }
  let url;
  try { url = new URL(out.rpc); } catch { throw new Error("--rpc is not a URL"); }
  if (url.protocol !== "https:") throw new Error("--rpc must be an https URL");
  return { provider: out.provider, rpc: url.href };
}

/**
 * The fixture's text for one RPC answer: a head naming the read, then the
 * response body verbatim (u64 values keep every digit). Throws, saying why,
 * for anything but a jsonParsed Token-2022 mint answer to requestBody().
 */
export function rpcRecord(body, { provider, readAtUtc }) {
  if (typeof body !== "string" || Buffer.byteLength(body) > MAX_RESPONSE_BYTES) throw new Error("the answer is missing or too large");
  let answer;
  try { answer = JSON.parse(body); } catch { throw new Error("the answer is not JSON"); }
  if (answer?.jsonrpc !== "2.0" || answer.id !== 1) throw new Error("the answer is not a JSON-RPC 2.0 response to this request");
  if (answer.error !== undefined) throw new Error(`the RPC returned an error: ${JSON.stringify(answer.error).slice(0, 200)}`);
  const context = answer.result?.context, value = answer.result?.value;
  if (!Number.isSafeInteger(context?.slot) || context.slot <= 0) throw new Error("the answer has no context slot");
  if (value?.owner !== TOKEN_2022_PROGRAM || value.data?.program !== "spl-token-2022" || value.data?.parsed?.type !== "mint") {
    throw new Error("the answer is not the USDG mint in the jsonParsed encoding (owner Token-2022, a parsed mint)");
  }
  const head = {
    about: "The mainnet USDG mint as one read-only getAccountInfo (jsonParsed, finalized) returned it from the deployment's RPC provider, "
      + "named below; response is the answer verbatim. Written by contracts/solana/scripts/usdg-rpc-jsonparsed.mjs, which never records "
      + "the URL. worker/src/solana-usdg-mint.test.ts checks it against Agave 2.3.13's decoding of usdg-mainnet-mint.json. "
      + "Refresh it only by a new read, never by hand.",
    address: USDG_MINT,
    provider,
    method: "getAccountInfo",
    encoding: "jsonParsed",
    commitment: "finalized",
    readAtUtc,
    slot: context.slot,
    apiVersion: typeof context.apiVersion === "string" ? context.apiVersion : null,
  };
  const text = JSON.stringify(head, null, 2);
  return `${text.slice(0, -2)},\n  "response": ${body.trim()}\n}\n`;
}

async function main(argv) {
  const { provider, rpc } = parseArgs(argv);
  const response = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: requestBody(),
    redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`the RPC answered HTTP ${response.status}`);
  const text = rpcRecord(await response.text(), { provider, readAtUtc: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") });
  writeFileSync(path.join(FIXTURES, OUTPUT), text);
  const head = JSON.parse(text);
  console.log(`wrote ${path.join(FIXTURES, OUTPUT)} (${provider}, slot ${head.slot}, apiVersion ${head.apiVersion ?? "not given"})`);
  console.log("next: npx tsx --test worker/src/solana-usdg-mint.test.ts");
}

// Real paths on both sides: run through a symlink, the plain comparison would skip main.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((error) => {
    // Never the URL: a fetch error can carry it.
    const message = error instanceof Error ? error.message : String(error);
    console.error(`error: ${message.includes("://") ? "the read failed (details withheld: they may name the RPC URL)" : message}`);
    process.exit(1);
  });
}
