import { env as processEnv } from "node:process";
import { canonicalId, CHAINS, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM } from "../../packages/core/src/ids";
import {
  parseSolanaSwapIntent, validateSolanaQuote, SOLANA_QUOTE_MAX_AGE_MS,
  type SolanaMint, type SolanaQuote, type SolanaSwapIntent,
} from "../../packages/core/src/solana";
import { solanaVaultUsdgMintRefusal } from "../../packages/core/src/solana-live";
import {
  readSolanaMainnetRpcConfig, readSolanaJson, requireSolanaSlot, SolanaRpcError,
  withSolanaMainnetRead, withSolanaReadDeadline,
} from "./solana-rpc";

export const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const SOLANA_MARKET_MAX_SLOT_LAG = 75;
export const SOLANA_MARKET_MAX_SLOT_LEAD = 32;
// Paper-only: v1 still supplies contextSlot. V2 /order's published response
// schema has no quote contextSlot, so it cannot meet our independent slot-age
// check. Do not fabricate slot provenance from our RPC read when migrating.
// https://developers.jup.ag/docs/api-reference/swap/v1/quote
// https://github.com/jup-ag/docs/blob/main/openapi-spec/swap/v2/swap.yaml
const JUPITER_QUOTE_URL = "https://api.jup.ag/swap/v1/quote";
const QUOTE_TTL_MS = SOLANA_QUOTE_MAX_AGE_MS;
const U64_MAX = (1n << 64n) - 1n;
const ERRORS = {
  "invalid-address": "A canonical Solana mint address is required.",
  "missing-jupiter-key": "MERRYMEN_JUPITER_API_KEY is required for Solana quotes.",
  "invalid-jupiter-key": "The Jupiter API key setting is invalid.",
  "invalid-clock": "The Solana market clock is invalid.",
  "invalid-mint": "Solana RPC did not return a supported initialized mint.",
  "stale-mint": "Solana mint context is outside the current slot bounds.",
  "invalid-quote": "Jupiter did not return a valid quote for the requested swap.",
  "zero-output": "Jupiter quotes no output for this amount; it is too small to trade.",
  "stale-quote": "Jupiter quote context is outside the current slot bounds.",
} as const;
/**
 * Jupiter's zero-output answer, as validated: the evidence that no route buys
 * `inAmount` of `inputMint` back right now. SolanaMarketError("zero-output")
 * carries it, so a caller that acts on "dust" (a write-off) keeps the answer
 * itself, not just the time it heard it.
 */
export interface SolanaZeroOutputQuote {
  source: "jupiter";
  inputMint: string;
  outputMint: string;
  inAmount: string;
  /** Jupiter's outAmount: 0, or so small that its slippage floor is 0. */
  outAmount: string;
  /** Jupiter's otherAmountThreshold, which a zero-output answer always has at "0". */
  minOutAmount: "0";
  slippageBps: number;
  /** Jupiter's context slot, when the answer carried a valid one. */
  contextSlot: number | null;
  /** When the quote was requested (the market clock, before the request). */
  quotedAtMs: number;
}
export class SolanaMarketError extends Error {
  /** Only on "zero-output" from the market's quote: the answer itself. */
  readonly zeroOutput?: Readonly<SolanaZeroOutputQuote>;
  constructor(readonly code: keyof typeof ERRORS, zeroOutput?: SolanaZeroOutputQuote) {
    super(ERRORS[code]); this.name = "SolanaMarketError";
    if (zeroOutput) this.zeroOutput = Object.freeze({ ...zeroOutput });
  }
}

/**
 * MERRYMEN_JUPITER_API_KEY as every Jupiter request sends it, and as status
 * checks it: trimmed, then 1 to 1024 printable ASCII characters with no spaces.
 * Missing, or anything else, refuses (the live route builder answers either as
 * its 'configuration' code). One rule, so status never shows live trading ready
 * with a key every quote and route would refuse.
 */
export function solanaJupiterApiKey(env: Readonly<Record<string, string | undefined>>): string {
  const apiKey = env.MERRYMEN_JUPITER_API_KEY?.trim();
  if (!apiKey) throw new SolanaMarketError("missing-jupiter-key");
  if (apiKey.length > 1024 || /[^\x21-\x7e]/.test(apiKey)) throw new SolanaMarketError("invalid-jupiter-key");
  return apiKey;
}

type JsonObject = Record<string, unknown>;
function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function address(value: unknown): value is string {
  return typeof value === "string" && value.length >= 32 && value.length <= 44 &&
    canonicalId(CHAINS.solana, "token", value) === value;
}
function authority(value: unknown): boolean { return value === null || address(value); }
function unsigned(value: unknown, positive = false): value is string {
  return typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value) &&
    BigInt(value) <= U64_MAX && (!positive || BigInt(value) > 0n);
}
function base64Bytes(value: unknown, length: number): boolean {
  if (typeof value !== "string" || value.length !== Math.ceil(length / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const decoded = Buffer.from(value, "base64");
  return decoded.byteLength === length && decoded.toString("base64") === value;
}
function int(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
}
function timestamp(now: () => number): number {
  const value = now();
  if (!int(value, Number.MAX_SAFE_INTEGER - QUOTE_TTL_MS)) throw new SolanaMarketError("invalid-clock");
  return value;
}
function invalidMint(): never { throw new SolanaMarketError("invalid-mint"); }

/** Mint JSON shapes follow Agave's UiMint/UiExtension, not display metadata. */
function mintFromRpc(raw: unknown, mint: string, minSlot: number, observedAtMs: number): SolanaMint {
  if (!object(raw) || !object(raw.context) || !int(raw.context.slot)) return invalidMint();
  if (raw.context.slot < minSlot || raw.context.slot > minSlot + SOLANA_MARKET_MAX_SLOT_LEAD) {
    throw new SolanaMarketError("stale-mint");
  }
  const value = raw.value;
  if (!object(value) || value.executable !== false ||
    (value.owner !== SPL_TOKEN_PROGRAM && value.owner !== TOKEN_2022_PROGRAM) || !object(value.data)) return invalidMint();
  const data = value.data;
  const expectedProgram = value.owner === SPL_TOKEN_PROGRAM ? "spl-token" : "spl-token-2022";
  if (data.program !== expectedProgram || !int(data.space) || data.space < 82 ||
    (value.space !== undefined && value.space !== data.space) || !object(data.parsed) ||
    data.parsed.type !== "mint" || !object(data.parsed.info)) return invalidMint();
  const info = data.parsed.info;
  if (info.isInitialized !== true || !int(info.decimals, 18) || !unsigned(info.supply) ||
    !authority(info.freezeAuthority) || !authority(info.mintAuthority)) return invalidMint();
  const extensions = info.extensions;
  // Agave omits empty extensions. Absence is only unambiguous at base mint size.
  if (extensions !== undefined && (!Array.isArray(extensions) || extensions.length > 64)) return invalidMint();
  const list: unknown[] = extensions as unknown[] | undefined ?? [];
  if ((data.space > 82 && list.length === 0) || (value.owner === SPL_TOKEN_PROGRAM && list.length !== 0)) return invalidMint();
  const trustedCash = mint === SOLANA_USDG_MINT && value.owner === TOKEN_2022_PROGRAM && info.decimals === 6;
  if (mint === SOLANA_USDG_MINT && !trustedCash) return invalidMint();
  // The vault program's check_mint fails every swap, buys and exits alike, on a USDG mint it
  // refuses (a transfer fee or hook program, or any other extension): sign none of them.
  if (trustedCash && solanaVaultUsdgMintRefusal(info) !== null) return invalidMint();
  const reasons = new Set<string>();
  if (info.freezeAuthority !== null && !trustedCash) reasons.add("freeze-authority");
  // A live mint authority can inflate supply after the buy and dilute every holder.
  if (info.mintAuthority !== null && !trustedCash) reasons.add("mint-authority");
  const seen = new Set<string>();
  for (const extension of list) {
    if (!object(extension) || typeof extension.extension !== "string" || seen.has(extension.extension)) return invalidMint();
    seen.add(extension.extension);
    const state = extension.state;
    switch (extension.extension) {
      case "permanentDelegate":
        if (!object(state) || !authority(state.delegate)) return invalidMint();
        if (state.delegate !== null && !trustedCash) reasons.add("permanent-delegate");
        break;
      case "transferHook":
        if (!object(state) || !authority(state.programId) || !authority(state.authority)) return invalidMint();
        if (state.programId !== null) reasons.add("transfer-hook");
        // A disabled hook whose authority remains can point at any program later.
        else if (state.authority !== null && !trustedCash) reasons.add("transfer-hook-authority");
        break;
      case "transferFeeConfig": {
        if (!object(state) || !authority(state.transferFeeConfigAuthority) || !authority(state.withdrawWithheldAuthority)) return invalidMint();
        for (const fee of [state.olderTransferFee, state.newerTransferFee]) {
          if (!object(fee) || !int(fee.epoch) || !int(fee.transferFeeBasisPoints, 10_000) ||
            typeof fee.maximumFee !== "number" || !Number.isInteger(fee.maximumFee) || fee.maximumFee < 0 ||
            fee.maximumFee > Number(U64_MAX)) return invalidMint();
          // Check scheduled fees too: no buying immediately before activation.
          if (fee.transferFeeBasisPoints > 0 && fee.maximumFee > 0) reasons.add("transfer-fee");
        }
        break;
      }
      case "defaultAccountState":
        if (!object(state) || !["initialized", "frozen", "uninitialized"].includes(String(state.accountState))) return invalidMint();
        if (state.accountState !== "initialized") reasons.add("default-frozen");
        break;
      case "nonTransferable": reasons.add("non-transferable"); break;
      // These extensions do not change raw balances or ordinary transfers.
      case "metadataPointer": case "tokenMetadata": case "groupPointer":
      case "groupMemberPointer": case "tokenGroup": case "tokenGroupMember":
      case "mintCloseAuthority":
        if (!object(state)) return invalidMint();
        break;
      case "confidentialTransferMint":
        if (!object(state) || !authority(state.authority) || typeof state.autoApproveNewAccounts !== "boolean" ||
          !(state.auditorElgamalPubkey === null || base64Bytes(state.auditorElgamalPubkey, 32))) return invalidMint();
        if (!trustedCash) reasons.add("unsupported-token-extension");
        break;
      case "confidentialTransferFeeConfig":
        // Unlike the transparent transfer-fee withheldAmount, this is an
        // encrypted 64-byte ElGamal ciphertext encoded in base64 by Agave.
        if (!object(state) || !authority(state.authority) || typeof state.harvestToMintEnabled !== "boolean" ||
          !base64Bytes(state.withheldAmount, 64) || !(state.withdrawWithheldAuthorityElgamalPubkey === null ||
            base64Bytes(state.withdrawWithheldAuthorityElgamalPubkey, 32))) return invalidMint();
        if (!trustedCash) reasons.add("unsupported-token-extension");
        break;
      default:
        // Unknown/unparseable extensions, pausing, rebasing and account-only
        // extensions never become implicitly safe when RPC adds new parsers.
        reasons.add("unsupported-token-extension");
    }
  }
  return { address: mint, program: value.owner, decimals: info.decimals,
    slot: raw.context.slot, observedAtMs, buyBlockedReasons: [...reasons] };
}

function noPlatformFee(value: unknown): boolean {
  return value === undefined || value === null ||
    (object(value) && value.amount === "0" && value.feeBps === 0);
}

export function validSolanaJupiterRoute(value: unknown, intent: SolanaSwapIntent, outAmount: string): boolean {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) return false;
  type Edge = { to: string; amount: bigint; weight: number; precision: number };
  type Node = { incoming: bigint; outgoing: bigint; degree: number; edges: Edge[] };
  const nodes = new Map<string, Node>();
  const node = (mint: string): Node => {
    let result = nodes.get(mint);
    if (!result) { result = { incoming: 0n, outgoing: 0n, degree: 0, edges: [] }; nodes.set(mint, result); }
    return result;
  };
  for (const step of value) {
    if (!object(step) || !object(step.swapInfo)) return false;
    const info = step.swapInfo;
    if (!address(info.ammKey) || !address(info.inputMint) || !address(info.outputMint) ||
      info.inputMint === info.outputMint || !unsigned(info.inAmount, true) || !unsigned(info.outAmount, true)) return false;
    // bps is more precise than the optional integer percent. When both are
    // supplied, a whole-percent display may round but cannot contradict bps.
    const hasBps = step.bps !== undefined && step.bps !== null;
    const hasPercent = step.percent !== undefined && step.percent !== null;
    if ((!hasBps && !hasPercent) || (hasBps && (!int(step.bps, 10_000) || step.bps === 0)) ||
      (hasPercent && !int(step.percent, 100))) return false;
    const bps = hasBps ? step.bps as number : (step.percent as number) * 100;
    if (bps === 0 || (hasBps && hasPercent && Math.abs((step.percent as number) * 100 - bps) >= 100)) return false;
    // Current v1 quotes account DEX fees in their advertised in/out amounts.
    // feeAmount is informational, never added/subtracted again. Reject a
    // different wire convention rather than manufacture unreported balances.
    if ((info.feeAmount !== undefined && !unsigned(info.feeAmount)) ||
      (info.feeMint !== undefined && !address(info.feeMint))) return false;
    const input = node(info.inputMint), output = node(info.outputMint);
    const amount = BigInt(info.inAmount);
    input.outgoing += amount;
    output.incoming += BigInt(info.outAmount);
    output.degree++;
    input.edges.push({ to: info.outputMint, amount, weight: bps, precision: hasBps ? 10_000 : 100 });
  }
  const source = nodes.get(intent.inputMint), destination = nodes.get(intent.outputMint);
  if (!source || !destination || source.incoming !== 0n || source.outgoing !== BigInt(intent.amountRaw) ||
    destination.outgoing !== 0n || destination.incoming !== BigInt(outAmount)) return false;
  for (const [mint, current] of nodes) {
    // Exact flow conservation includes split and merged intermediate routes.
    // Unspent intermediate balances cannot silently disappear from a paper fill.
    if (mint !== intent.inputMint && mint !== intent.outputMint &&
      (current.incoming === 0n || current.incoming !== current.outgoing)) return false;
    if (current.edges.length === 0) continue;
    // Percentages apply to the allocation at an input mint, not globally over
    // hops. A two-hop 100% -> 100% route is valid; a 1% sole route is not.
    if (current.edges.reduce((sum, edge) => sum + edge.weight, 0) !== 10_000) return false;
    for (const edge of current.edges) {
      const difference = edge.amount * 10_000n - current.outgoing * BigInt(edge.weight);
      const absolute = difference < 0n ? -difference : difference;
      // Rounded display percentages have one unit of advertised precision;
      // exact raw conservation above remains mandatory, including rounding dust.
      const tolerance = current.outgoing * BigInt(10_000 / edge.precision) + 10_000n;
      if (absolute > tolerance) return false;
    }
  }
  // Kahn's algorithm rejects cycles even when a cycle's amounts conserve and
  // its mints are connected to the requested source and destination.
  const ready = [...nodes.values()].filter(current => current.degree === 0);
  let visited = 0;
  while (ready.length) {
    const current = ready.pop()!; visited++;
    for (const edge of current.edges) {
      const target = nodes.get(edge.to)!;
      if (--target.degree === 0) ready.push(target);
    }
  }
  return visited === nodes.size;
}

/**
 * A well-formed answer for exactly this swap whose minimum output is nothing:
 * the amount is too small for any route to return a unit (dust). This is a
 * definite answer about the amount, unlike an outage or a malformed quote,
 * and it is never a fill: callers may only value such a holding at zero.
 */
function zeroOutputQuote(raw: unknown, intent: SolanaSwapIntent, quotedAtMs: number): SolanaZeroOutputQuote | null {
  if (!object(raw) || Object.hasOwn(raw, "error") || raw.swapMode !== "ExactIn" ||
    raw.inputMint !== intent.inputMint || raw.outputMint !== intent.outputMint || raw.inAmount !== intent.amountRaw ||
    raw.slippageBps !== intent.slippageBps || !unsigned(raw.outAmount) || raw.otherAmountThreshold !== "0") return null;
  // The slippage floor of the quoted output must itself round to zero.
  if (BigInt(raw.outAmount) * BigInt(10_000 - intent.slippageBps) >= 10_000n) return null;
  return { source: "jupiter", inputMint: intent.inputMint, outputMint: intent.outputMint, inAmount: intent.amountRaw, outAmount: raw.outAmount,
    minOutAmount: "0", slippageBps: intent.slippageBps, contextSlot: int(raw.contextSlot) ? raw.contextSlot : null, quotedAtMs };
}

export type SolanaMarket = {
  readMint(address: string): Promise<SolanaMint>;
  quote(intent: SolanaSwapIntent): Promise<SolanaQuote>;
};
type MarketOptions = {
  env?: Readonly<Record<string, string | undefined>>;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  /** Per-provider attempt, capped at 30s. Default 5s; injected for tests. */
  timeoutMs?: number;
};

/** Mainnet read-only market data. No signing keys, wallet identities or transactions are accepted. */
export function createSolanaMarket(options: MarketOptions = {}): SolanaMarket {
  const source = options.env ?? processEnv;
  const config = readSolanaMainnetRpcConfig(source);
  const request = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const readOptions = { fetch: request, timeoutMs: options.timeoutMs };
  return {
    async readMint(mint) {
      if (!address(mint)) throw new SolanaMarketError("invalid-address");
      return withSolanaMainnetRead(config, async rpc => {
        const observedAtMs = timestamp(now);
        const slot = requireSolanaSlot(await rpc("getSlot", [{ commitment: "finalized" }]));
        const raw = await rpc("getAccountInfo", [mint, { encoding: "jsonParsed", commitment: "finalized", minContextSlot: slot }]);
        return mintFromRpc(raw, mint, slot, observedAtMs);
      }, readOptions);
    },
    async quote(rawIntent) {
      const intent = parseSolanaSwapIntent(rawIntent);
      const apiKey = solanaJupiterApiKey(source);
      const url = new URL(JUPITER_QUOTE_URL);
      url.search = new URLSearchParams({ inputMint: intent.inputMint, outputMint: intent.outputMint,
        amount: intent.amountRaw, slippageBps: String(intent.slippageBps), swapMode: "ExactIn",
        restrictIntermediateTokens: "true", platformFeeBps: "0" }).toString();
      const quotedAtMs = timestamp(now);
      const raw = await withSolanaReadDeadline(async signal => {
        let response: Response;
        try { response = await request(url, { method: "GET", headers: { "x-api-key": apiKey }, redirect: "error", signal }); }
        catch { throw new SolanaRpcError(signal.aborted ? "timeout" : "network"); }
        return readSolanaJson(response, signal);
      }, options.timeoutMs);
      const zero = zeroOutputQuote(raw, intent, quotedAtMs);
      if (zero) throw new SolanaMarketError("zero-output", zero);
      if (!object(raw) || Object.hasOwn(raw, "error") || raw.swapMode !== "ExactIn" ||
        raw.inputMint !== intent.inputMint || raw.outputMint !== intent.outputMint || raw.inAmount !== intent.amountRaw ||
        raw.slippageBps !== intent.slippageBps || !unsigned(raw.outAmount, true) ||
        !unsigned(raw.otherAmountThreshold, true) || !int(raw.contextSlot) ||
        !noPlatformFee(raw.platformFee) || !validSolanaJupiterRoute(raw.routePlan, intent, raw.outAmount)) {
        throw new SolanaMarketError("invalid-quote");
      }
      const currentSlot = await withSolanaMainnetRead(config, async rpc =>
        requireSolanaSlot(await rpc("getSlot", [{ commitment: "finalized" }])), readOptions);
      if (raw.contextSlot < currentSlot - SOLANA_MARKET_MAX_SLOT_LAG || raw.contextSlot > currentSlot + SOLANA_MARKET_MAX_SLOT_LEAD) {
        throw new SolanaMarketError("stale-quote");
      }
      const quote: SolanaQuote = { source: "jupiter", inputMint: intent.inputMint, outputMint: intent.outputMint,
        inAmount: intent.amountRaw, outAmount: raw.outAmount, minOutAmount: raw.otherAmountThreshold,
        slippageBps: intent.slippageBps, contextSlot: raw.contextSlot, quotedAtMs, expiresAtMs: quotedAtMs + QUOTE_TTL_MS };
      validateSolanaQuote(quote, intent, timestamp(now));
      return quote;
    },
  };
}
