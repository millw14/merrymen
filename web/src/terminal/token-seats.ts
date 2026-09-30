/**
 * THE TOKEN PAGE'S SEATS: the holders the ledger read, each with what its agent
 * last said about this token.
 *
 * Two reads with two clocks. The holders come from the token page's own read,
 * which runs when the token changes; the theses come from the feed, which the
 * shell reads every ten seconds. They were joined inside the holders effect,
 * which therefore listed `theses` as a dependency and re-read the ledger — and
 * blanked the list to a skeleton — every time the feed moved. Joined here, as a
 * derivation, a feed read changes a sentence and nothing else.
 */
import type { TokenHolder } from "@/lib/read-token";
import type { Seat } from "./bars";
import type { Thesis } from "./live";

export function seatsOf(
  holders: readonly TokenHolder[],
  theses: readonly Thesis[],
  symbol: string,
  /**
   * Two tokens share this symbol, so a post naming it may be about the other
   * one; the seat then says nothing rather than borrow a thesis.
   */
  symbolClash: boolean,
): Seat[] {
  const want = symbol.toUpperCase();
  return holders
    .filter((h): h is TokenHolder & { slug: string } => !!h.slug)
    .map((h) => ({
      paper: h.paper,
      basisSource: h.basisSource,
      slug: h.slug,
      name: h.name,
      handle: h.handle,
      owner: null,
      strategy: "",
      strategyId: "custom" as const,
      position: h.valueUsdg,
      pnlBps: h.pnlBps,
      avgEntry: h.entryPriceUsd ?? 0,
      thesis: symbolClash
        ? ""
        : theses.find((t) => t.slug === h.slug && t.symbol?.toUpperCase() === want)?.reason ?? "",
      time: h.enteredAt ?? 0,
      price: h.entryPriceUsd ?? 0,
    }));
}
