import type { Db } from "../../../worker/src/db";
import { officialCoinTokens, type CustomToken } from "../../../packages/core/src/index";
import { fillSymbolFor, nonCashLeg, tokenLabelSync } from "../../../worker/src/token-label";

// Feed holdings are on Robinhood mainnet. Passing these through the existing
// guard also stops an unrelated contract borrowing an official coin's ticker.
const OFFICIAL_TOKENS = officialCoinTokens(4663);

/** A complete token identity; a ledger's shortened Trencher ID is never enough. */
export function positionTokenAddress(value: string | null | undefined): string | null {
  return typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null;
}

/** Same fill sanitizer as the worker, with official names protected as well. */
export function positionFillSymbol(token: string, value: string | null, officialTokens: readonly CustomToken[] = OFFICIAL_TOKENS): string | null {
  const label = fillSymbolFor(token, [value], officialTokens);
  return label && !/^T[0-9A-F]{11}$/i.test(label) ? label : null;
}

/** Labels are optional display metadata, read once for this owner's held tokens. */
export async function readPositionLabels(
  db: Db,
  account: string,
  book: "paper" | "live",
  tokens: readonly (string | null | undefined)[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const addresses = [...new Set(tokens.map(positionTokenAddress).filter((t): t is string => t !== null))];
  for (const token of addresses) {
    // No database or RPC: known cash, stocks and official coins retain their
    // curated names even when a receipt-restored holding has no named fill.
    const known = tokenLabelSync(null, null, token);
    if (known.trusted && known.ticker) out.set(token, known.ticker);
  }
  const want = addresses.filter(token => !out.has(token));
  if (want.length === 0) return out;
  const marks = want.map(() => "?").join(", ");
  try {
    // Use the existing account/time index, and never borrow another owner's or
    // paper book's label. Bare restart copies have no fill_symbol to contribute.
    const rows = (await db.prepare(
      `SELECT buy_token, sell_token, fill_symbol FROM trades
        WHERE agent_id = ? AND status = ? AND kind IN ('swap', 'curve-trade') AND fill_symbol IS NOT NULL
          AND (LOWER(buy_token) IN (${marks}) OR LOWER(sell_token) IN (${marks}))
        ORDER BY created_at DESC, id DESC LIMIT 5000`,
    ).all(account, book === "paper" ? "paper" : "landed", ...want, ...want)) as {
      buy_token: string | null; sell_token: string | null; fill_symbol: string | null;
    }[];
    const requested = new Set(want);
    for (const row of rows) {
      const token = positionTokenAddress(nonCashLeg(row));
      if (!token || !requested.has(token) || out.has(token)) continue;
      const label = positionFillSymbol(token, row.fill_symbol);
      if (label) out.set(token, label);
    }
  } catch {
    // Older ledgers may lack fill_symbol. Labels never make holdings disappear.
  }
  return out;
}
