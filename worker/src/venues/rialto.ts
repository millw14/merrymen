/**
 * Rialto — the meta-router venue. API-first: GET /quote returns a ready-to-send
 * transaction targeting the CURRENT RialtoRouter. Two hard rules from the
 * verification notes in @merrymen/core:
 *
 *   1. NEVER build router calldata by hand — the quote API is the only source.
 *   2. NEVER trust the API's target address — resolve the router from the
 *      on-chain registry (ownerOf(2) = taker router) and REFUSE any quote whose
 *      `to` differs. An attacker-controlled or buggy API response must not be
 *      able to point the agent's approval at an arbitrary contract.
 *
 * Gated on MERRYMEN_RIALTO_API_KEY (integrator onboarding is wallet-signed and
 * user-performed). Without the key, the venue stays approval-only.
 */

import { isAddress, isHex, parseAbi, type PublicClient } from "viem";
import { RIALTO } from "../../../packages/core/src/index";

const REGISTRY_ABI = parseAbi(["function ownerOf(uint256 id) view returns (address)"]);

/** Resolve the current taker-submitted router from the on-chain registry. */
export async function resolveRialtoRouter(client: PublicClient): Promise<`0x${string}`> {
  return (await client.readContract({
    address: RIALTO.routerRegistry as `0x${string}`,
    abi: REGISTRY_ABI,
    functionName: "ownerOf",
    args: [BigInt(RIALTO.FEATURE_TAKER_ROUTER)],
  })) as `0x${string}`;
}

export interface RialtoQuote {
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
  /** Indicative buy amount if the API provides one (raw units). */
  buyAmountRaw: bigint | null;
}

/**
 * Validate a raw /quote response against the registry-resolved router.
 * Returns null (with a reason) rather than a "fixed up" quote — a quote that
 * fails validation is a quote that must not execute.
 */
export function parseRialtoQuote(
  raw: unknown,
  expectedRouter: `0x${string}`,
): { quote: RialtoQuote | null; reason?: string } {
  if (!raw || typeof raw !== "object") return { quote: null, reason: "not an object" };
  const r = raw as Record<string, unknown>;
  // Tolerate both flat {to,data,value} and nested {transaction:{...}} shapes.
  const tx = (typeof r.transaction === "object" && r.transaction !== null
    ? (r.transaction as Record<string, unknown>)
    : r) as Record<string, unknown>;

  const to = tx.to;
  const data = tx.data;
  // strict:false — APIs return lowercase addresses; equality below is case-folded.
  if (typeof to !== "string" || !isAddress(to, { strict: false })) {
    return { quote: null, reason: "missing/invalid to" };
  }
  if (typeof data !== "string" || !isHex(data) || data.length < 10) {
    return { quote: null, reason: "missing/invalid calldata" };
  }
  if (to.toLowerCase() !== expectedRouter.toLowerCase()) {
    return {
      quote: null,
      reason: `target ${to} is not the registry-resolved router ${expectedRouter}`,
    };
  }
  let value = 0n;
  if (tx.value !== undefined && tx.value !== null) {
    try {
      value = BigInt(tx.value as string | number | bigint);
    } catch {
      return { quote: null, reason: "invalid value" };
    }
  }
  if (value !== 0n) {
    // ERC-20 swaps never need ETH along; a non-zero value is a red flag.
    return { quote: null, reason: `unexpected non-zero value ${value}` };
  }

  let buyAmountRaw: bigint | null = null;
  const buyField = r.buyAmount ?? r.outputAmount ?? r.amountOut;
  if (typeof buyField === "string" || typeof buyField === "number") {
    try {
      buyAmountRaw = BigInt(buyField);
    } catch {
      buyAmountRaw = null;
    }
  }

  return { quote: { to: to as `0x${string}`, data: data as `0x${string}`, value, buyAmountRaw } };
}

export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface RialtoClientOpts {
  apiKey: string;
  /** Header the API expects the key in (default x-api-key; settings-configurable). */
  headerName?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchFn?: FetchLike;
  apiBase?: string;
}

/**
 * Fetch and validate a swap quote. `taker` is the smart account executing it.
 * Header name for the key is unconfirmed pending onboarding docs — override
 * with MERRYMEN_RIALTO_API_KEY_HEADER if their integration guide differs.
 */
export async function fetchRialtoQuote(
  opts: RialtoClientOpts,
  args: {
    sellToken: `0x${string}`;
    buyToken: `0x${string}`;
    sellAmountRaw: bigint;
    taker: `0x${string}`;
    expectedRouter: `0x${string}`;
  },
): Promise<{ quote: RialtoQuote | null; reason?: string }> {
  const base = opts.apiBase ?? RIALTO.apiBase;
  const fetchFn = opts.fetchFn ?? (fetch as unknown as FetchLike);
  const headerName = opts.headerName ?? process.env.MERRYMEN_RIALTO_API_KEY_HEADER ?? "x-api-key";

  const url =
    `${base}/quote?sellToken=${args.sellToken}&buyToken=${args.buyToken}` +
    `&sellAmount=${args.sellAmountRaw.toString()}&taker=${args.taker}`;

  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchFn(url, { headers: { [headerName]: opts.apiKey } });
  } catch (e) {
    return { quote: null, reason: `quote request failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!res.ok) return { quote: null, reason: `quote API returned ${res.status}` };

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { quote: null, reason: "quote response is not JSON" };
  }
  return parseRialtoQuote(body, args.expectedRouter);
}
