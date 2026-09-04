import { useState } from "react";
import { ageOf, money, sizeOf, type LiveAgent, type LiveToken, type Thesis } from "../live";
import { strategyForSlug, strategyName, type StrategyId } from "../strategy";
import { Face, Stamp } from "../ui";
import { parseWhy, takeFor } from "../why";

type Pack = { kind: "one"; t: Thesis } | { kind: "burst"; items: Thesis[] };

export function Feed({
  theses,
  tokens,
  agents,
  onToken,
  onProfile,
}: {
  theses: Thesis[];
  tokens: LiveToken[];
  agents: LiveAgent[];
  onToken: (id: string) => void;
  onProfile: (slug: string) => void;
}) {
  const bySlug = new Map(agents.map((a) => [a.slug, a]));
  const rows = pack(
    theses.filter((t) => t.action === "buy" || t.action === "sell" || t.action === "hold"),
  );
  if (rows.length === 0) return <p className="meta">Quiet.</p>;
  return (
    <div className="feed-list">
      {rows.map((row, i) =>
        row.kind === "one" ? (
          <Say
            key={`${row.t.slug}-${row.t.head}-${i}`}
            t={row.t}
            agent={row.t.slug ? bySlug.get(row.t.slug) : undefined}
            tokens={tokens}
            onToken={onToken}
            onAgent={onProfile}
          />
        ) : (
          <Burst
            key={`${row.items[0]?.slug}-burst-${i}`}
            items={row.items}
            agent={row.items[0]?.slug ? bySlug.get(row.items[0].slug) : undefined}
            tokens={tokens}
            onToken={onToken}
            onAgent={onProfile}
          />
        ),
      )}
    </div>
  );
}

function Burst({
  items,
  agent,
  tokens,
  onToken,
  onAgent,
}: {
  items: Thesis[];
  agent?: LiveAgent;
  tokens: LiveToken[];
  onToken: (id: string) => void;
  onAgent: (slug: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const t = items[0]!;
  const slug = t.slug ?? "";
  const strategy = strategyForSlug(slug || t.name, agent?.glance.id);
  const tickers = items.map((x) => x.symbol).filter((s): s is string => Boolean(s));
  const size = sizeOf(t);
  const age = ageOf(t);
  return (
    <div className="burst">
      <button type="button" className="held say" onClick={() => setOpen((v) => !v)}>
        <Face name={t.name} slug={t.slug} />
        <div className="held-who">
          <div className="held-top">
            <strong className="tick">{tickers.join("  ")}</strong>
            {size != null ? <b>{money(size)}×{items.length}</b> : null}
          </div>
          <div className="held-sub">
            <span>{verb(parseWhy(t), strategy)}</span>
            {age ? <em>{age}</em> : null}
          </div>
          <div className="held-by">
            <span>{t.handle ?? t.name}</span>
            {slug ? <Stamp>{strategyName(strategy)}</Stamp> : null}
          </div>
        </div>
      </button>
      {open
        ? items.map((item, i) => (
            <Say
              key={`${item.symbol}-${i}`}
              t={item}
              agent={agent}
              tokens={tokens}
              onToken={onToken}
              onAgent={onAgent}
              nested
            />
          ))
        : null}
    </div>
  );
}

function Say({
  t,
  agent,
  tokens,
  onToken,
  onAgent,
  nested,
}: {
  t: Thesis;
  agent?: LiveAgent;
  tokens: LiveToken[];
  onToken: (id: string) => void;
  onAgent: (slug: string) => void;
  nested?: boolean;
}) {
  const w = parseWhy(t);
  const slug = t.slug ?? "";
  const strategy = strategyForSlug(slug || t.name, agent?.glance.id);
  const sym = "symbol" in w ? w.symbol : t.symbol;
  const tok = tokens.find((x) => x.symbol.toUpperCase() === (sym ?? "").toUpperCase());
  const take = takeFor(slug, sym ?? "", t.reason, agent?.thesis, strategy);
  const size = sizeOf(t);
  const age = ageOf(t);
  return (
    <button
      type="button"
      className={`held say${nested ? " nested" : ""}`}
      onClick={() => {
        if (sym && tok) onToken(tok.id);
        else if (t.slug) onAgent(t.slug);
      }}
    >
      <Face name={t.name} slug={t.slug} />
      <div className="held-who">
        <div className="held-top">
          <strong className="tick">{sym ?? "—"}</strong>
          {size != null ? <b>{money(size)}</b> : null}
        </div>
        <div className="held-sub">
          <span>{verb(w, strategy)}</span>
          {age ? <em>{age}</em> : null}
        </div>
        {!nested && (
          <div className="held-by">
            <span>{t.handle ?? t.name}</span>
            {slug ? <Stamp>{strategyName(strategy)}</Stamp> : null}
          </div>
        )}
        {take ? <p>{take}</p> : null}
      </div>
    </button>
  );
}

function pack(rows: Thesis[]): Pack[] {
  const out: Pack[] = [];
  for (const t of rows) {
    const last = out[out.length - 1];
    if (last?.kind === "one" && samePrint(last.t, t)) continue;
    if (last?.kind === "burst" && samePrint(last.items[last.items.length - 1]!, t)) continue;
    if (last?.kind === "one" && sameBurst(last.t, t)) {
      out[out.length - 1] = { kind: "burst", items: [last.t, t] };
      continue;
    }
    if (last?.kind === "burst" && sameBurst(last.items[0]!, t)) {
      last.items.push(t);
      continue;
    }
    out.push({ kind: "one", t });
  }
  return out;
}

function samePrint(a: Thesis, b: Thesis): boolean {
  return (
    a.slug === b.slug &&
    a.symbol === b.symbol &&
    a.action === b.action &&
    a.sizeUsdg === b.sizeUsdg &&
    (a.reason ?? "") === (b.reason ?? "")
  );
}

function sameBurst(a: Thesis, b: Thesis): boolean {
  return Boolean(a.slug && a.slug === b.slug && a.action && a.action === b.action && a.action === "buy");
}

function verb(w: ReturnType<typeof parseWhy>, id: StrategyId): string {
  switch (w.kind) {
    case "buy":
      if (id === "steady-basket") return "Added";
      if (id === "even-keel") return "Topped up";
      return "Bought";
    case "sell":
      if (id === "even-keel") return "Trimmed";
      return "Sold";
    case "hold":
      return "Holding";
    case "park":
      return "Parked";
    case "unpark":
      return "Unparked";
    case "other":
      return w.line;
    default: {
      const _x: never = w;
      return _x;
    }
  }
}
