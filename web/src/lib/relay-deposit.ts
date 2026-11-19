/**
 * ETH OR SOL INTO USDG ON ROBINHOOD CHAIN, PRICED BY RELAY AND SIGNED ON RELAY.
 *
 * Milla picked Relay on 2026-11-19, from live quotes taken that day. It was the
 * one provider that priced all three routes the deposit panel offers:
 * - ETH on Robinhood Chain itself
 * - ETH on Ethereum or an L2
 * - SOL on Solana
 * Robinhood's own bridging page names it too. The comparison is in the
 * deposit-path plan.
 *
 * THIS MODULE MOVES NO MONEY. The first slice is quotes plus deep links:
 * - Merrymen asks Relay's `/price` what a conversion would deliver and shows
 *   that answer.
 * - "Continue on Relay" opens relay.link, prefilled with the agent account as
 *   the recipient.
 * - The owner connects whichever wallet holds the funds and signs there.
 * The server never holds funds, never signs, and converts nothing on its own.
 * Nothing here reads a session or a key.
 *
 * WE NEVER SEND THE OWNER'S WALLET TO RELAY. `/price` needs a sender to price
 * against. A fixed placeholder that is nobody's wallet works on every route
 * (checked live 2026-11-19), so the owner's own address stays on this page. The
 * agent account does go: it is the recipient, and the deep link carries it
 * anyway.
 *
 * A QUOTE IS SHOWN ONLY IF IT IS THE ONE WE ASKED FOR. `parseRelayPrice`
 * refuses an answer when any of these differ from the request:
 * - the input chain, currency or amount
 * - the output token (USDG at its exact address, 6 decimals, chain 4663)
 * - the recipient
 * - the slippage cap
 * A quote for the wrong token, or for somebody else's address, is worse than
 * no quote.
 *
 * RELAY RE-PRICES WHEN THE OWNER SIGNS. The figures here are what Relay said
 * when asked. The panel says the final ones are on Relay's screen. A deep link
 * cannot carry a slippage cap, so the panel also names ours for the owner to
 * check there.
 */
import { CASH, USDG_DECIMALS } from "@merrymen/core";
import { EVM_NATIVE, SOL_NATIVE, formatAmount, formatFixed, type DepositSource } from "./deposit-math";

export const RELAY_API = "https://api.relay.link";
export const RELAY_APP = "https://relay.link";
/** Relay's path name for Robinhood Chain, as Robinhood's bridging page links it. */
export const RELAY_ROBINHOOD_PATH = "robinhood";
export const ROBINHOOD_CHAIN_ID = 4663;

/** Senders `/price` accepts that are nobody's wallet. See the header. */
export const PRICE_SENDER: Readonly<Record<DepositSource["family"], string>> = Object.freeze({
  evm: "0x0000000000000000000000000000000000000001",
  solana: SOL_NATIVE,
});

const USDG = CASH.USDG.toLowerCase();

export interface RelayPriceRequest {
  user: string;
  recipient: string;
  originChainId: number;
  destinationChainId: number;
  originCurrency: string;
  destinationCurrency: string;
  amount: string;
  tradeType: "EXACT_INPUT";
  slippageTolerance: string;
}

/** The body of a `/price` request for converting `amount` of `source` into USDG at `agent`. */
export function priceRequest(source: DepositSource, amount: bigint, agent: string): RelayPriceRequest {
  return {
    user: PRICE_SENDER[source.family],
    recipient: agent,
    originChainId: source.relayChainId,
    destinationChainId: ROBINHOOD_CHAIN_ID,
    originCurrency: source.currency,
    destinationCurrency: CASH.USDG,
    amount: amount.toString(),
    tradeType: "EXACT_INPUT",
    slippageTolerance: String(source.slippageBps),
  };
}

/** One fee line, in whatever currency Relay charged it. */
export interface QuoteFee {
  label: string;
  amount: bigint;
  decimals: number;
  symbol: string;
  usd: string | null;
}

export interface DepositQuote {
  sourceId: DepositSource["id"];
  amountIn: bigint;
  /** What Relay priced the input at, in dollars, or null when it did not say. */
  amountInUsd: string | null;
  /** USDG base units Relay expects to deliver. */
  expectedOut: bigint;
  /** USDG base units the fill may not go below. Relay refunds instead. */
  minOut: bigint;
  slippageBps: number;
  /** Relay's estimate in seconds from signing to delivery. */
  etaSeconds: number;
  /** Relay's total impact, fees included, as a positive percent string ("0.25"), or null. */
  impactPercent: string | null;
  fees: QuoteFee[];
  /** The transfer's own network fee on the source chain, in source base units, or null. */
  sourceNetworkFee: bigint | null;
  route: string;
}

export type ParsedPrice =
  | { ok: true; quote: DepositQuote }
  | { ok: false; reason: string };

/** What the owner is told when Relay refuses, by Relay's error code. Relay's own message text is never shown. */
const REFUSALS: Readonly<Record<string, string>> = Object.freeze({
  AMOUNT_TOO_LOW: "That amount is below what Relay will convert on this route. Try a larger amount.",
  INSUFFICIENT_LIQUIDITY: "Relay doesn't have the liquidity for this amount right now. Try a smaller amount or try again later.",
  NO_SWAP_ROUTES_FOUND: "Relay found no route for this conversion right now. Try again later.",
  UNSUPPORTED_ROUTE: "Relay doesn't support this route right now.",
  UNSUPPORTED_CHAIN: "Relay doesn't support this network right now.",
});
const GENERIC_REFUSAL = "Relay couldn't price this conversion right now. Nothing was sent. Try again in a moment.";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);
const digits = (v: unknown): bigint | null => (typeof v === "string" && /^\d+$/.test(v) ? BigInt(v) : null);
const usdText = (v: unknown): string | null => (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) ? v : null);
const sameAddress = (a: unknown, b: string, family: DepositSource["family"] | "evm") =>
  typeof a === "string" && (family === "evm" ? a.toLowerCase() === b.toLowerCase() : a === b);

/** The route, as one line. */
export function routeLabel(source: DepositSource): string {
  return source.relayChainId === ROBINHOOD_CHAIN_ID
    ? `Relay swap on Robinhood Chain: ${source.asset} → USDG`
    : `Relay: ${source.asset} on ${source.network} → USDG on Robinhood Chain`;
}

/**
 * Relay's `/price` answer as a quote we can show, or the reason we will not.
 *
 * `body` is untrusted JSON from a third party. Anything missing, malformed, or
 * different from the request refuses the whole quote.
 */
export function parseRelayPrice(body: unknown, request: { source: DepositSource; amount: bigint; agent: string }): ParsedPrice {
  const { source, amount, agent } = request;
  const root = obj(body);
  if (!root) return { ok: false, reason: GENERIC_REFUSAL };
  const details = obj(root.details);
  if (!details) {
    const code = typeof root.errorCode === "string" ? root.errorCode : "";
    return { ok: false, reason: REFUSALS[code] ?? GENERIC_REFUSAL };
  }
  const mismatch = (what: string): ParsedPrice => ({ ok: false, reason: `Relay's answer didn't match this request (${what}), so no quote is shown. Nothing was sent.` });

  const inSide = obj(details.currencyIn);
  const inCurrency = obj(inSide?.currency);
  if (!inSide || !inCurrency) return mismatch("input");
  if (inCurrency.chainId !== source.relayChainId) return mismatch("input network");
  if (!sameAddress(inCurrency.address, source.currency, source.family)) return mismatch("input currency");
  if (inCurrency.decimals !== source.decimals) return mismatch("input decimals");
  if (digits(inSide.amount) !== amount) return mismatch("input amount");

  const outSide = obj(details.currencyOut);
  const outCurrency = obj(outSide?.currency);
  if (!outSide || !outCurrency) return mismatch("output");
  if (outCurrency.chainId !== ROBINHOOD_CHAIN_ID) return mismatch("output network");
  if (typeof outCurrency.address !== "string" || outCurrency.address.toLowerCase() !== USDG) return mismatch("output token");
  if (outCurrency.decimals !== USDG_DECIMALS) return mismatch("output decimals");
  const expectedOut = digits(outSide.amount);
  const minOut = digits(outSide.minimumAmount);
  if (expectedOut === null || minOut === null || expectedOut <= 0n || minOut <= 0n || minOut > expectedOut) return mismatch("output amount");

  if (details.recipient !== undefined && !sameAddress(details.recipient, agent, "evm")) return mismatch("recipient");

  const slippage = obj(details.slippageTolerance);
  const slippageBps = typeof slippage?.total === "string" && /^\d+$/.test(slippage.total) ? Number(slippage.total) : NaN;
  if (!Number.isFinite(slippageBps) || slippageBps > source.slippageBps) return mismatch("slippage");

  const eta = details.timeEstimate;
  const etaSeconds = typeof eta === "number" && Number.isFinite(eta) && eta >= 0 ? eta : NaN;
  if (Number.isNaN(etaSeconds)) return mismatch("time estimate");

  const impact = obj(details.totalImpact);
  const impactRaw = usdText(impact?.percent);
  const impactPercent = impactRaw === null ? null : impactRaw.replace(/^-/, "");

  const fees: QuoteFee[] = [];
  let sourceNetworkFee: bigint | null = null;
  const feeRoot = obj(root.fees);
  const feeLine = (key: string, label: string) => {
    const fee = obj(feeRoot?.[key]);
    const currency = obj(fee?.currency);
    const value = digits(fee?.amount);
    if (!fee || !currency || value === null || typeof currency.decimals !== "number" || typeof currency.symbol !== "string") return null;
    return { label, amount: value, decimals: currency.decimals, symbol: currency.symbol, usd: usdText(fee.amountUsd), chainId: currency.chainId, address: currency.address };
  };
  const relayer = feeLine("relayer", "Relay fee");
  if (relayer && relayer.amount > 0n) fees.push(strip(relayer));
  const app = feeLine("app", "App fee");
  // Merrymen takes no fee. Should an answer ever carry one, it is shown, not hidden.
  if (app && app.amount > 0n) fees.push(strip(app));
  const gas = feeLine("gas", `Network fee on ${source.network}`);
  if (gas && gas.amount > 0n) {
    fees.push(strip(gas));
    if (gas.chainId === source.relayChainId && sameAddress(gas.address, source.currency, source.family)) sourceNetworkFee = gas.amount;
  }

  return {
    ok: true,
    quote: {
      sourceId: source.id,
      amountIn: amount,
      amountInUsd: usdText(inSide.amountUsd),
      expectedOut,
      minOut,
      slippageBps,
      etaSeconds,
      impactPercent,
      fees,
      sourceNetworkFee,
      route: routeLabel(source),
    },
  };
}

function strip(fee: QuoteFee & { chainId?: unknown; address?: unknown }): QuoteFee {
  return { label: fee.label, amount: fee.amount, decimals: fee.decimals, symbol: fee.symbol, usd: fee.usd };
}

/**
 * Ask Relay for a price, from the browser. No cookie and no referrer go with
 * it. A network failure or timeout is a refusal with nothing shown, never a
 * quote.
 */
export async function requestRelayPrice(
  request: { source: DepositSource; amount: bigint; agent: string },
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<ParsedPrice> {
  try {
    const response = await fetchImpl(`${RELAY_API}/price`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(priceRequest(request.source, request.amount, request.agent)),
      signal: AbortSignal.timeout(timeoutMs),
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    let body: unknown = null;
    try { body = await response.json(); } catch { body = null; }
    return parseRelayPrice(body, request);
  } catch {
    return { ok: false, reason: "Couldn't reach Relay for a price. Nothing was sent. Check your connection and try again." };
  }
}

/** "under a minute" or "about N minutes": the ETA as an owner reads it. */
export function etaText(seconds: number): string {
  if (seconds < 60) return "under a minute";
  const minutes = Math.ceil(seconds / 60);
  return minutes === 1 ? "about a minute" : `about ${minutes} minutes`;
}

/** USDG base units as dollars, truncated to cents: "40.00". */
export function usdgText(units: bigint): string {
  return formatFixed(units, USDG_DECIMALS, 2);
}

/**
 * relay.link, opened on Robinhood Chain with everything prefilled. Relay
 * documents these parameters: fromChainId, fromCurrency, toCurrency,
 * toAddress, amount and tradeType.
 *
 * `to` is USDG by default. The agent's gas top-up asks for native ETH.
 */
export function relayDeepLink(source: DepositSource, amount: bigint, agent: string, to: "USDG" | "ETH" = "USDG"): string {
  const url = new URL(`/bridge/${RELAY_ROBINHOOD_PATH}`, RELAY_APP);
  url.searchParams.set("fromChainId", String(source.relayChainId));
  url.searchParams.set("fromCurrency", source.currency);
  url.searchParams.set("toCurrency", to === "USDG" ? CASH.USDG : EVM_NATIVE);
  url.searchParams.set("toAddress", agent);
  url.searchParams.set("amount", formatAmount(amount, source.decimals));
  url.searchParams.set("tradeType", "EXACT_INPUT");
  return url.toString();
}

/** Relay's public page for following a request. The owner reaches it from their own transaction on relay.link. */
export const RELAY_ACTIVITY_URL = `${RELAY_APP}/transactions`;
