/**
 * THE ARITHMETIC OF FUNDING AN AGENT FROM ETH OR SOL.
 *
 * Everything here is integer base units: wei, lamports, and USDG's six
 * decimals. A float never touches an amount the owner is about to sign for.
 *
 * WHY A RESERVE AT ALL. Two different wallets need fees:
 *
 * - The wallet the owner sends FROM pays the network fee for the transfer
 *   itself. "Max" that empties it leaves the owner unable to make the next
 *   transaction. On Solana, an account drained below its rent-exempt minimum
 *   cannot be left like that at all, so the transfer is rejected outright.
 * - The agent account pays its own fee on every trade, in ETH on Robinhood
 *   Chain. USDG cannot pay it. The largest bucket in the live-blocker census was
 *   `no-gas`: owners who sent USDG exactly as told and no ETH (live-blocker.ts).
 *
 * The first is `reserveFor` and `maxSendable`. The second is `agentGasOf`.
 *
 * UNKNOWN IS NEVER ZERO. A balance read that failed is `null`. It produces
 * "unread", never a Max of 0 and never "this wallet is empty".
 */

/** Where an owner's ETH or SOL starts. Every option routes into USDG on Robinhood Chain. */
export type SourceId = "eth-robinhood" | "eth-ethereum" | "eth-base" | "eth-arbitrum" | "sol-solana";

export interface DepositSource {
  id: SourceId;
  family: "evm" | "solana";
  /** The chain id Relay uses. Solana's is Relay's own, not an EVM id. */
  relayChainId: number;
  /** The network, as an owner would say it. */
  network: string;
  asset: "ETH" | "SOL";
  decimals: 18 | 9;
  /** Relay's id for the native currency on that chain. */
  currency: string;
  /**
   * The least this wallet keeps when Max is pressed, in base units.
   *
   * These were agreed with Milla on 2026-11-19: 0.002 ETH on Ethereum, where
   * one transfer can cost several dollars; 0.0003 ETH on the L2s and Robinhood
   * Chain; and 0.005 SOL on Solana. The SOL figure covers the rent-exempt
   * minimum (0.00089088 SOL), a possible token account's rent (0.00203928 SOL),
   * and the fee plus a priority fee, with room to spare.
   */
  floor: bigint;
  /**
   * The slippage cap we quote at, in basis points. Relay's own default came back
   * at 2%, so it is always passed rather than left to Relay. 50 bps for ETH and
   * 100 bps for SOL, as agreed.
   */
  slippageBps: number;
  /** How many decimals an amount typed for this asset may carry. Max is truncated to it. */
  inputDecimals: number;
}

const ETH_FLOOR_L1 = 2_000_000_000_000_000n; // 0.002 ETH
const ETH_FLOOR_L2 = 300_000_000_000_000n; //   0.0003 ETH
const SOL_FLOOR = 5_000_000n; //                 0.005 SOL

/** Relay's native-currency ids. */
export const EVM_NATIVE = "0x0000000000000000000000000000000000000000";
export const SOL_NATIVE = "11111111111111111111111111111111";
/** Relay's chain id for Solana mainnet. */
export const RELAY_SOLANA_CHAIN_ID = 792703809;

export const DEPOSIT_SOURCES: Readonly<Record<SourceId, DepositSource>> = Object.freeze({
  "eth-robinhood": { id: "eth-robinhood", family: "evm", relayChainId: 4663, network: "Robinhood Chain", asset: "ETH", decimals: 18, currency: EVM_NATIVE, floor: ETH_FLOOR_L2, slippageBps: 50, inputDecimals: 6 },
  "eth-ethereum": { id: "eth-ethereum", family: "evm", relayChainId: 1, network: "Ethereum", asset: "ETH", decimals: 18, currency: EVM_NATIVE, floor: ETH_FLOOR_L1, slippageBps: 50, inputDecimals: 6 },
  "eth-base": { id: "eth-base", family: "evm", relayChainId: 8453, network: "Base", asset: "ETH", decimals: 18, currency: EVM_NATIVE, floor: ETH_FLOOR_L2, slippageBps: 50, inputDecimals: 6 },
  "eth-arbitrum": { id: "eth-arbitrum", family: "evm", relayChainId: 42161, network: "Arbitrum", asset: "ETH", decimals: 18, currency: EVM_NATIVE, floor: ETH_FLOOR_L2, slippageBps: 50, inputDecimals: 6 },
  "sol-solana": { id: "sol-solana", family: "solana", relayChainId: RELAY_SOLANA_CHAIN_ID, network: "Solana", asset: "SOL", decimals: 9, currency: SOL_NATIVE, floor: SOL_FLOOR, slippageBps: 100, inputDecimals: 4 },
});

/** The ETH sources, in the order the panel offers them. */
export const ETH_SOURCES: readonly SourceId[] = ["eth-ethereum", "eth-base", "eth-arbitrum", "eth-robinhood"];

/**
 * A decimal the owner typed, as base units, or null when it is not one.
 *
 * Strict on purpose: no exponent, no sign, no grouping commas, and no more
 * fraction digits than the asset has. Extra digits are refused rather than
 * rounded, because a rounded amount is not the amount that was typed.
 */
export function parseAmount(text: string, decimals: number): bigint | null {
  const trimmed = text.trim();
  const match = /^(\d*)(?:\.(\d*))?$/.exec(trimmed);
  if (!match) return null;
  const whole = match[1] ?? "";
  const fraction = match[2] ?? "";
  if (whole === "" && fraction === "") return null;
  if (fraction.length > decimals) return null;
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt((fraction || "0").padEnd(decimals, "0"));
}

/**
 * Base units as a decimal, TRUNCATED to `fractionDigits`, with trailing zeros dropped.
 *
 * Truncated, never rounded: a displayed balance or minimum must never be more
 * than the real one.
 */
export function formatAmount(value: bigint, decimals: number, fractionDigits = decimals): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const unit = 10n ** BigInt(decimals);
  const whole = abs / unit;
  const keep = Math.min(fractionDigits, decimals);
  const fraction = (abs % unit).toString().padStart(decimals, "0").slice(0, keep).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/** Base units with exactly `digits` fraction digits, truncated: how dollars and USDG are shown ("40.00"). */
export function formatFixed(value: bigint, decimals: number, digits: number): string {
  const text = formatAmount(value, decimals, digits);
  const [whole, fraction = ""] = text.split(".");
  return digits > 0 ? `${whole}.${fraction.padEnd(digits, "0")}` : whole!;
}

/** Drop everything past `digits` fraction digits, toward zero. */
export function truncateTo(value: bigint, decimals: number, digits: number): bigint {
  if (digits >= decimals) return value;
  const step = 10n ** BigInt(decimals - digits);
  return value - (value % step);
}

/**
 * How much the source wallet keeps.
 *
 * The larger of the floor and twice the transfer's own estimated fee, when
 * Relay gave one. On every route measured, the floor was larger by orders of
 * magnitude. The doubling is there for the day a fee spikes past it.
 */
export function reserveFor(source: DepositSource, estimatedFee: bigint | null = null): bigint {
  const twice = estimatedFee !== null && estimatedFee > 0n ? estimatedFee * 2n : 0n;
  return twice > source.floor ? twice : source.floor;
}

export type MaxSendable =
  /** The balance was not read. Max is unavailable, and the panel says why. */
  | { kind: "unread" }
  /** The wallet holds no more than the reserve. Nothing can go without stranding it. */
  | { kind: "short"; balance: bigint; reserve: bigint }
  | { kind: "ok"; amount: bigint; balance: bigint; reserve: bigint };

/**
 * The most this wallet can send and still keep its reserve, truncated to the
 * digits the amount field accepts. Truncating lowers the amount, so the wallet
 * keeps a little more, never less.
 */
export function maxSendable(source: DepositSource, balance: bigint | null, reserve: bigint): MaxSendable {
  if (balance === null) return { kind: "unread" };
  const amount = truncateTo(balance - reserve, source.decimals, source.inputDecimals);
  if (balance <= reserve || amount <= 0n) return { kind: "short", balance, reserve };
  return { kind: "ok", amount, balance, reserve };
}

/**
 * The one quiet line under Max: what is kept, and why.
 *
 * `agentGas` is what Max also sets aside for the agent's own fees, when its
 * ETH reads zero or could not be read. That top-up is a second transfer out of
 * this same wallet, so a Max that ignored it would leave the wallet unable to
 * send it.
 */
export function reserveLine(source: DepositSource, reserve: bigint, agentGas: bigint | null = 0n): string {
  const amount = (v: bigint) => `${formatAmount(v, source.decimals, source.inputDecimals)} ${source.asset}`;
  const own = source.family === "solana"
    ? `Max keeps ${amount(reserve)} so your wallet stays open and can pay its next fee`
    : `Max keeps ${amount(reserve)} on ${source.network} so this wallet can pay its next fee`;
  // null: the agent needs gas and Relay has not priced the source asset yet.
  if (agentGas === null) return `${own}, and sets aside about $2 of ${source.asset} for your agent's gas.`;
  return agentGas > 0n ? `${own}, and sets aside ${amount(agentGas)} for your agent's gas.` : `${own}.`;
}

/**
 * The agent account's ETH on Robinhood Chain, as far as we know it.
 *
 * "empty" only for a measured zero. That is the same test the worker's
 * `no-gas` rule applies (exec-mode.ts), and the one case where adding ETH is
 * certainly needed. A failed read is "unread", and the panel says it could not
 * tell rather than asking for money that may already be there.
 */
export type AgentGas =
  | { kind: "sponsored" }
  | { kind: "unread" }
  | { kind: "empty" }
  | { kind: "ok"; wei: bigint };

export function agentGasOf(ethWei: string | null | undefined, gasSponsored?: boolean | null): AgentGas {
  if (gasSponsored === true) return { kind: "sponsored" };
  if (typeof ethWei !== "string" || !/^\d+$/.test(ethWei)) return { kind: "unread" };
  const wei = BigInt(ethWei);
  return wei === 0n ? { kind: "empty" } : { kind: "ok", wei };
}

/** A dollar figure such as Relay's `amountUsd` ("35.921563"), as micro-dollars truncated to six places, or null. */
export function usdMicrosOf(text: string | null | undefined): bigint | null {
  if (typeof text !== "string") return null;
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!match) return null;
  return parseAmount(`${match[1]}.${(match[2] ?? "").slice(0, 6)}`, 6);
}

/** About two dollars of gas for the agent, as agreed. */
export const AGENT_GAS_USD_MICROS = 2_000_000n;

/**
 * About `usdMicros` worth of the source asset, given a quote that priced
 * `amountIn` at `amountInUsd` dollars. Rounded UP to the input digits, so the
 * top-up is at least the target, and null when the quote carried no price.
 */
export function amountForUsd(source: DepositSource, amountIn: bigint, amountInUsd: string | null, usdMicros: bigint = AGENT_GAS_USD_MICROS): bigint | null {
  const usd = usdMicrosOf(amountInUsd);
  if (usd === null || usd <= 0n || amountIn <= 0n) return null;
  const raw = (amountIn * usdMicros + usd - 1n) / usd;
  const step = 10n ** BigInt(Math.max(0, source.decimals - source.inputDecimals));
  return ((raw + step - 1n) / step) * step;
}
