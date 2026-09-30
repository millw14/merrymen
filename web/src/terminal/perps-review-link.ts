import { ownerPerpMarket } from "../../../worker/src/perps/owner-order";
/** A native handoff can open a review card; it never carries authority to act. */
export function perpsReviewLink(href: string): { next: string; proposal: { id: "flatten-perps" | "close-perp"; args: Record<string, string> } } | null {
  const url = new URL(href, "https://merrymen.invalid");
  const action = url.searchParams.get("perps"), book = url.searchParams.get("book");
  if (url.pathname !== "/agent" || (action !== "flatten" && action !== "close")) return null;
  if (book !== null && book !== "paper" && book !== "live") return null;
  const market = action === "close" ? ownerPerpMarket(url.searchParams.get("market")) : null;
  if (action === "close" && !market) return null;
  const args: Record<string, string> = { ...(market ? { symbol: market } : {}), ...(book ? { book } : {}) };
  for (const key of ["perps", "market", "book"]) url.searchParams.delete(key);
  return { next: `${url.pathname}${url.search}${url.hash}`, proposal: { id: action === "close" ? "close-perp" : "flatten-perps", args } };
}
