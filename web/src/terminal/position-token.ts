import type { LiveToken } from "./live";

/** The ledger key stays separate from the token's display metadata. */
export interface PositionIdentity {
  symbol: string;
  token?: string | null;
  displaySymbol?: string | null;
}

/** An address-bearing position must never navigate to a different token with the same ticker. */
export function tokenForPosition(position: PositionIdentity, tokens: readonly LiveToken[]): LiveToken | undefined {
  if (position.token) {
    const address = position.token.toLowerCase();
    return tokens.find(token => token.id.toLowerCase() === address);
  }
  // Compatibility with older feeds, which only sent a symbol. Ambiguous names do not link.
  const matches = tokens.filter(token => token.symbol.toLowerCase() === position.symbol.toLowerCase());
  return matches.length === 1 ? matches[0] : undefined;
}

/** Cashtags are presentation only; unavailable metadata falls back to the address, never a made-up ticker. */
export function positionLabel(position: PositionIdentity): string {
  const raw = position.displaySymbol === undefined ? position.symbol : position.displaySymbol;
  const ticker = (raw ?? "").trim().replace(/^\$+/, "");
  if (/^[A-Za-z0-9._-]{1,32}$/.test(ticker) && !/^(?:0x|T[0-9A-F]{11}$)/i.test(ticker)) {
    return `$${ticker}`;
  }
  const address = position.token;
  return address && /^0x[0-9a-f]{40}$/i.test(address)
    ? `${address.slice(0, 6)}…${address.slice(-4)}`
    : "Unknown token";
}
