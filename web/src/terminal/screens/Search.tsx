import { useMemo, useState } from "react";
import { coinPrice, lastLine, pctBps, type LiveAgent, type LiveToken } from "../live";
import { Coin, Face } from "../ui";

export function Search({
  tokens,
  agents,
  onBack,
  onToken,
  onProfile,
}: {
  tokens: LiveToken[];
  agents: LiveAgent[];
  onBack: () => void;
  onToken: (id: string) => void;
  onProfile: (slug: string) => void;
}) {
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  const toks = useMemo(
    () =>
      (query
        ? tokens.filter((t) => t.symbol.toLowerCase().includes(query) || t.name.toLowerCase().includes(query))
        : tokens
      ).slice(0, query ? 20 : 8),
    [query, tokens],
  );
  const ags = useMemo(
    () =>
      query
        ? agents.filter(
            (a) => a.name.toLowerCase().includes(query) || (a.handle ?? "").toLowerCase().includes(query),
          )
        : [],
    [query, agents],
  );

  return (
    <div className="find">
      <div className="find-bar">
        <button type="button" className="back" onClick={onBack} aria-label="Back">
          ←
        </button>
        <input
          className="search"
          autoFocus
          aria-label="Search tokens or agents"
          placeholder="Search tokens or agents"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {ags.map((a) => (
        <button key={a.slug} type="button" className="tok" onClick={() => onProfile(a.slug)}>
          <Face name={a.name} slug={a.slug} />
          <div>
            <strong>{a.handle ?? a.name}</strong>
            {a.last && <p className="meta">{lastLine(a.last)}</p>}
          </div>
          <span className={`px ${a.pnlBps == null ? "" : a.pnlBps >= 0 ? "up" : "down"}`}>{pctBps(a.pnlBps)}</span>
        </button>
      ))}
      {toks.map((t) => (
        <button key={t.id} type="button" className="tok" onClick={() => onToken(t.id)}>
          <Coin symbol={t.symbol} logo={t.logo} />
          <div>
            <strong>{t.symbol}</strong>
            <p className="meta">{t.name}</p>
          </div>
          <span className="px">{coinPrice(t.priceUsd)}</span>
        </button>
      ))}
      {query && ags.length === 0 && toks.length === 0 && <p className="meta">Nothing with that name.</p>}
    </div>
  );
}
