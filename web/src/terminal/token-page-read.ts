/**
 * THE TOKEN PAGE'S OWN READ — holders, coverage, and the coin's activity — as
 * a hook that is keyed on the token and nothing else.
 *
 * It lived inline in Token.tsx, joined to the feed's posts, and listed those
 * posts among its dependencies. The shell reads the feed every ten seconds now,
 * so every feed read would have blanked the holders list to a skeleton and
 * asked the ledger again. The posts are joined afterwards (token-seats.ts); this
 * read takes no posts at all, so no feed read can reach it.
 *
 * Out of the .tsx so it can be executed: Token.tsx pulls in lightweight-charts,
 * which the test runner cannot load.
 */
import { useEffect, useMemo, useState } from "react";
import type { PoolEvidence } from "../../../worker/src/venues/pool-evidence";
import type { DiscoveryRow } from "@/lib/read-discoveries";
import type { TokenHolder, TokenRead } from "@/lib/read-token";
import type { Seat } from "./bars";
import type { Thesis } from "./live";
import { coverageOf, readTokenPage, type HoldersRead } from "./token-holders";
import { seatsOf } from "./token-seats";

export interface TokenPageData {
  ledger: TokenRead;
  market: { symbolClash: boolean; coin: DiscoveryRow | null };
  evidence: PoolEvidence | null;
}

export interface TokenPageRead {
  /** What the ledger returned. Empty until it answers, and after a failure. */
  holders: TokenHolder[];
  /** Where the holders read stands — see token-holders.ts. */
  holdersRead: HoldersRead;
  holderError: string;
  coverage: { published: number; total: number } | null;
  symbolClash: boolean;
  activity: { coin: DiscoveryRow | null; evidence: PoolEvidence | null; loading: boolean };
}

const UNAVAILABLE = "Public holdings are unavailable right now.";

export const LOADING_PAGE: TokenPageRead = {
  holders: [],
  holdersRead: "loading",
  holderError: "",
  coverage: null,
  symbolClash: false,
  activity: { coin: null, evidence: null, loading: true },
};

/** What one answer amounts to — the same rules the inline effect applied. */
export function pageReadOf(read: { ok: true; data: TokenPageData } | { ok: false }): TokenPageRead {
  if (!read.ok) {
    return { ...LOADING_PAGE, holdersRead: "failed", holderError: UNAVAILABLE, activity: { coin: null, evidence: null, loading: false } };
  }
  const data = read.data;
  const base = {
    ...LOADING_PAGE,
    symbolClash: data.market.symbolClash,
    activity: { coin: data.market.coin, evidence: data.evidence, loading: false },
  };
  if (!data.ledger.fillsRead) return { ...base, holdersRead: "failed", holderError: UNAVAILABLE };
  return { ...base, holdersRead: "ok", coverage: coverageOf(data.ledger), holders: data.ledger.holders };
}

/**
 * THE PAGE'S READ WITH ITS SEATS ALREADY JOINED — what Token.tsx draws.
 *
 * The join takes the clash flag from the read it came with, here, rather than
 * from the page. Both tickers are attacker-chosen, and the flag is the gate
 * that keeps a real agent's reasoning about the listed token off an impostor's
 * page. When Token.tsx passed it to seatsOf by hand, the one line that
 * mattered sat in a file the test runner cannot load, so a literal `false`
 * there left every test green. Now the page has nothing to pass.
 *
 * The posts are joined AFTER the read, as a derivation: a feed read every ten
 * seconds changes a thesis and re-reads nothing (see useTokenPageRead).
 */
export function useTokenPage(
  tokenId: string,
  symbol: string,
  theses: readonly Thesis[],
  attempt: number,
): TokenPageRead & { seats: Seat[] } {
  const read = useTokenPageRead(tokenId, symbol, attempt);
  const seats = useMemo(
    () => seatsOf(read.holders, theses, symbol, read.symbolClash),
    [read.holders, theses, symbol, read.symbolClash],
  );
  return { ...read, seats };
}

/** `attempt` is bumped by Try again, which re-runs the read. */
export function useTokenPageRead(tokenId: string, symbol: string, attempt: number): TokenPageRead {
  const [read, setRead] = useState<TokenPageRead>(LOADING_PAGE);
  useEffect(() => {
    let alive = true;
    setRead(LOADING_PAGE);
    // BOUNDED, and a failure is one plain sentence — see readTokenPage.
    void readTokenPage<TokenPageData>(tokenId).then((r) => {
      if (alive) setRead(pageReadOf(r));
    });
    return () => {
      alive = false;
    };
  }, [tokenId, symbol, attempt]);
  return read;
}
