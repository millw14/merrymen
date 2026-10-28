/**
 * Builds one bounded CPI, never a provider transaction. V1 is deliberate:
 * /quote supplies contextSlot and /swap-instructions consumes that exact quote.
 * V2 /build has no quote contextSlot and uses a different instruction ABI.
 * https://developers.jup.ag/docs/api-reference/swap/v1/swap-instructions
 */
import { address } from "@solana/kit";
import { CHAINS } from "../../packages/core/src/ids";
import { SOLANA_JUPITER_SHARED_ROUTE_DISCRIMINATOR } from "../../packages/core/src/solana-live";
import { parseSolanaRawAmount, parseSolanaSwapIntent, SolanaPaperValidationError, validateSolanaQuote, type SolanaQuote } from "../../packages/core/src/solana";
import { createSolanaMarket, solanaJupiterApiKey, validSolanaJupiterRoute } from "./solana-market";
import { readSolanaJson, requireSolanaSlot, SolanaRpcError, withSolanaReadDeadline } from "./solana-rpc";
import type { SolanaLiveRpc } from "./solana-live-rpc";

export const JUPITER_SWAP_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
// Anchor sha256("global:shared_accounts_route")[0..8].
const ROUTE_DISCRIMINATOR = Buffer.from(SOLANA_JUPITER_SHARED_ROUTE_DISCRIMINATOR);
/**
 * The other V1 Jupiter route instructions, as Anchor sha256("global:<name>")[0..8].
 * Jupiter answering one of these is a route the vault does not take. Anything
 * else (random bytes, a V2 instruction we did not ask for) is the provider's.
 */
const OTHER_ROUTE_DISCRIMINATORS = [
  [229, 23, 203, 151, 122, 227, 173, 42], // route
  [150, 86, 71, 116, 167, 93, 14, 104], // route_with_token_ledger
  [208, 51, 239, 151, 123, 43, 237, 92], // exact_out_route
  [176, 209, 105, 168, 154, 125, 69, 62], // shared_accounts_exact_out_route
  [230, 121, 143, 80, 119, 159, 106, 170], // shared_accounts_route_with_token_ledger
].map(bytes => Buffer.from(bytes));
/** The largest route the vault takes. */
const MAX_ROUTE_DATA_BYTES = 900, MAX_ROUTE_ACCOUNTS = 64, MAX_ROUTE_STEPS = 64, MAX_LOOKUP_TABLES = 8;
/**
 * Jupiter's maxAccounts on every live quote, below the bounds the vault's own
 * transaction leaves a route. contracts/solana/runtime-tests/tests/jupiter_fork.rs
 * measures them: a route can name at most 55 distinct accounts (the 64-account
 * lock limit less the vault's and a refund account), and the vault takes at most
 * MAX_ROUTE_ACCOUNTS (64) route accounts counting repeats (check_route_accounts).
 * Its Whirlpool route names 29 route accounts, only 21 of them distinct (about
 * 1.4 to 1), so 40 keeps such a route under both bounds whether Jupiter's rough
 * estimate counts distinct or repeated accounts, with margin. Without it,
 * Jupiter's default (64) can answer a route the vault or validateJupiterCpi
 * refuses: that fails closed, but an exit on that route can fail again and again.
 * validateJupiterCpi still refuses more than MAX_ROUTE_ACCOUNTS whatever Jupiter
 * answers. refresh.mjs's QUOTE mirrors it.
 */
export const SOLANA_JUPITER_MAX_ACCOUNTS = 40;
export interface JupiterCpiAccount { address: string; isSigner: boolean; isWritable: boolean }
export interface JupiterCpiRoute {
  quote: SolanaQuote;
  dataBase64: string;
  accounts: readonly JupiterCpiAccount[];
  lookupTableAddresses: readonly string[];
}
export interface SolanaCpiBuildRequest {
  requestId: string; inputMint: string; outputMint: string; amountRaw: string; slippageBps: number;
  swapAuthority: string; sourceTokenAccount: string; destinationTokenAccount: string;
  inputTokenProgram: string; outputTokenProgram: string;
}
/**
 * Why no bounded vault swap was built, so the web can answer each precisely:
 * - configuration: this deployment's Jupiter key is missing or unusable. The
 *   owner can do nothing about it (answered as unavailable).
 * - route: Jupiter answered with a well-formed route the vault does not take:
 *   another pinned V1 Jupiter route instruction than sharedAccountsRoute, or a
 *   sharedAccountsRoute consistent with the request but too large for the vault
 *   (more than 64 hops or accounts, more than 8 lookup tables, oversized data).
 *   Another amount, or a later preview, may route differently.
 * - provider: an answer that cannot be used (malformed, an unknown instruction,
 *   inconsistent with the request or the quote, a quote outside the RPC's slot
 *   window), and anything else not attributable to the route itself. Never
 *   "no supported route". "route" is answered only once everything else about
 *   the answer has been checked.
 * The message names no setting or provider content; the web never reflects it.
 */
export type SolanaLiveMarketErrorCode = "configuration" | "route" | "provider";
const LIVE_MARKET_MESSAGES: Record<SolanaLiveMarketErrorCode, string> = {
  configuration: "Jupiter quote access is not configured for live routes.",
  route: "Jupiter did not return a supported bounded vault swap.",
  provider: "Jupiter's answer could not be used to build a bounded vault swap.",
};
export class SolanaLiveMarketError extends Error {
  constructor(readonly code: SolanaLiveMarketErrorCode) { super(LIVE_MARKET_MESSAGES[code]); this.name = "SolanaLiveMarketError"; }
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function fail(code: SolanaLiveMarketErrorCode): never { throw new SolanaLiveMarketError(code); }
/**
 * The shared quote validators applied to Jupiter's answer. build() parses the
 * owner's request before asking Jupiter anything, so a validation error here is
 * about the answer (malformed, inconsistent with the request, or stale because
 * the provider was slow): 'provider', never the owner's 400 with validator text.
 */
function providerChecked<T>(check: () => T): T {
  try { return check(); } catch (error) {
    if (error instanceof SolanaPaperValidationError) return fail("provider");
    throw error;
  }
}
function key(value: unknown): string {
  try { if (typeof value === "string" && address(value) === value) return value; } catch { /* Safe error below. */ }
  return fail("provider");
}

/** Pinned sharedAccountsRoute, ExactIn, fee-free, no token-ledger variants. */
export function validateJupiterCpi(raw: unknown, expected: SolanaCpiBuildRequest, quote: SolanaQuote): Omit<JupiterCpiRoute, "quote"> {
  if (!object(raw) || !object(raw.swapInstruction)) return fail("provider");
  const ix = raw.swapInstruction;
  if (ix.programId !== JUPITER_SWAP_PROGRAM || typeof ix.data !== "string" || !Array.isArray(ix.accounts) || ix.accounts.length < 11) return fail("provider");
  // Everything is decoded and checked before anything is counted: a malformed
  // answer is the provider's, whatever its size or instruction.
  const data = Buffer.from(ix.data, "base64");
  if (data.toString("base64") !== ix.data || data.length < 8) return fail("provider");
  const accounts = ix.accounts.map((rawAccount): JupiterCpiAccount => {
    if (!object(rawAccount) || typeof rawAccount.isSigner !== "boolean" || typeof rawAccount.isWritable !== "boolean") return fail("provider");
    return { address: key(rawAccount.pubkey), isSigner: rawAccount.isSigner, isWritable: rawAccount.isWritable };
  });
  if (!Array.isArray(raw.addressLookupTableAddresses)) return fail("provider");
  const lookupTableAddresses = raw.addressLookupTableAddresses.map(key);
  if (new Set(lookupTableAddresses).size !== lookupTableAddresses.length) return fail("provider");
  // Another pinned Jupiter route instruction: a well-formed shape the vault does not take.
  const discriminator = data.subarray(0, 8);
  if (!discriminator.equals(ROUTE_DISCRIMINATOR)) return fail(OTHER_ROUTE_DISCRIMINATORS.some(other => discriminator.equals(other)) ? "route" : "provider");
  if (data.length < 36) return fail("provider");
  const tail = data.length - 19;
  if (data.readBigUInt64LE(tail).toString() !== expected.amountRaw ||
      data.readBigUInt64LE(tail + 8).toString() !== quote.outAmount ||
      data.readUInt16LE(tail + 16) !== expected.slippageBps || data[tail + 18] !== 0) return fail("provider");
  const routeCount = data.readUInt32LE(9);
  if (routeCount < 1 || tail < 13 + routeCount * 4) return fail("provider");
  if (accounts[2]!.address !== expected.swapAuthority || !accounts[2]!.isSigner ||
      accounts[3]!.address !== expected.sourceTokenAccount || !accounts[3]!.isWritable ||
      accounts[6]!.address !== expected.destinationTokenAccount || !accounts[6]!.isWritable ||
      accounts[7]!.address !== expected.inputMint || accounts[8]!.address !== expected.outputMint ||
      accounts[9]!.address !== JUPITER_SWAP_PROGRAM ||
      accounts.some((account, index) => account.isSigner !== (index === 2))) return fail("provider");
  // SPL Token is always account 0; Token-2022 is optional account 10.
  if (accounts[0]!.address !== "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" ||
      accounts[10]!.address !== "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb") return fail("provider");
  // A well-formed answer consistent with the request: only its size can still refuse it.
  if (data.length > MAX_ROUTE_DATA_BYTES || accounts.length > MAX_ROUTE_ACCOUNTS || routeCount > MAX_ROUTE_STEPS ||
      lookupTableAddresses.length > MAX_LOOKUP_TABLES) return fail("route");
  // No provider setup/cleanup/compute/tip/other instructions are consumed.
  // The vault creates and closes its temporary input ATA itself.
  return { dataBase64: ix.data, accounts, lookupTableAddresses };
}

export function createSolanaLiveMarket(options: {
  rpc: SolanaLiveRpc; env?: Readonly<Record<string, string | undefined>>;
  fetch?: typeof globalThis.fetch; now?: () => number; timeoutMs?: number;
}): { build(request: SolanaCpiBuildRequest): Promise<JupiterCpiRoute>; readMint: ReturnType<typeof createSolanaMarket>["readMint"] } {
  const env = options.env ?? process.env;
  const fetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  return {
    readMint: createSolanaMarket(options).readMint,
    async build(request) {
      const intent = parseSolanaSwapIntent({ kind: "spl-swap", chain: CHAINS.solana, mode: "paper",
        requestId: request.requestId, inputMint: request.inputMint, outputMint: request.outputMint,
        amountRaw: request.amountRaw, slippageBps: request.slippageBps });
      for (const value of [request.swapAuthority, request.sourceTokenAccount, request.destinationTokenAccount,
        request.inputTokenProgram, request.outputTokenProgram]) key(value);
      let apiKey: string;
      try { apiKey = solanaJupiterApiKey(env); } catch { return fail("configuration"); }
      const json = (url: string, body?: unknown) => withSolanaReadDeadline(async signal => {
        let response: Response;
        try { response = await fetch(url, { method: body === undefined ? "GET" : "POST",
          headers: { "x-api-key": apiKey, "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "error", signal }); }
        catch { throw new SolanaRpcError(signal.aborted ? "timeout" : "network"); }
        return readSolanaJson(response, signal);
      }, options.timeoutMs);
      const params = new URLSearchParams({ inputMint: intent.inputMint, outputMint: intent.outputMint,
        amount: intent.amountRaw, slippageBps: String(intent.slippageBps), swapMode: "ExactIn",
        restrictIntermediateTokens: "true", platformFeeBps: "0", instructionVersion: "V1", maxAccounts: String(SOLANA_JUPITER_MAX_ACCOUNTS) });
      const quotedAtMs = now();
      const raw = await json(`https://api.jup.ag/swap/v1/quote?${params}`);
      if (!object(raw) || raw.swapMode !== "ExactIn" || typeof raw.outAmount !== "string") return fail("provider");
      const outAmount = raw.outAmount;
      const quote: SolanaQuote = providerChecked(() => {
        // A zero output too: the preview (the market's quote) answers a dust amount
        // as too small first; here it is an answer the vault cannot use.
        parseSolanaRawAmount(outAmount);
        if (
            !validSolanaJupiterRoute(raw.routePlan, intent, outAmount) ||
            !(raw.platformFee === undefined || raw.platformFee === null ||
              (object(raw.platformFee) && raw.platformFee.amount === "0" && raw.platformFee.feeBps === 0))) return fail("provider");
        const parsed: SolanaQuote = { source: "jupiter", inputMint: raw.inputMint as string,
          outputMint: raw.outputMint as string, inAmount: raw.inAmount as string, outAmount,
          minOutAmount: raw.otherAmountThreshold as string, slippageBps: raw.slippageBps as number,
          contextSlot: raw.contextSlot as number, quotedAtMs, expiresAtMs: quotedAtMs + 30_000 };
        validateSolanaQuote(parsed, intent, now());
        return parsed;
      });
      const built = await json("https://api.jup.ag/swap/v1/swap-instructions", {
        userPublicKey: request.swapAuthority, quoteResponse: raw,
        destinationTokenAccount: request.destinationTokenAccount, wrapAndUnwrapSol: false,
        useSharedAccounts: true, dynamicSlippage: false, dynamicComputeUnitLimit: false,
        skipUserAccountsRpcCalls: true, computeUnitPriceMicroLamports: 0,
      });
      const slot = await options.rpc.read(async rpc => requireSolanaSlot(await rpc("getSlot", [{ commitment: "finalized" }])));
      // Outside the RPC's slot window: a provider (or RPC) lagging, never a route the vault refuses.
      if (quote.contextSlot < slot - 75 || quote.contextSlot > slot + 32) return fail("provider");
      // A provider slow enough for its quote to go stale meanwhile.
      providerChecked(() => validateSolanaQuote(quote, intent, now()));
      return { quote, ...validateJupiterCpi(built, request, quote) };
    },
  };
}
