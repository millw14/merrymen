import { money, type LiveToken, type Thesis } from "./live";
import { stampFor } from "./strategy";
import { Face, Stamp } from "./ui";
import { parseWhy, thesisLine } from "./why";

export function chorusOf(posts: Thesis[]): Thesis[][] {
  const map = new Map<string, Thesis[]>();
  for (const t of posts) {
    const key = `${t.symbol ?? ""}|${thesisLine(t)}|${t.sizeUsdg ?? ""}|${t.action ?? ""}`;
    const list = map.get(key) ?? [];
    list.push(t);
    map.set(key, list);
  }
  return [...map.values()];
}

export function MoveTicket({
  t,
  tokens,
  hideWho,
  onAgent,
  onToken,
}: {
  t: Thesis;
  tokens: LiveToken[];
  hideWho?: boolean;
  onAgent?: (slug: string) => void;
  onToken?: (id: string) => void;
}) {
  const w = parseWhy(t);
  const blocked = t.outcome === "refused" || t.outcome === "reverted";
  const sym = "symbol" in w ? w.symbol : t.symbol;
  const tok = tokens.find((x) => x.symbol.toUpperCase() === (sym ?? "").toUpperCase());
  const take = thesisLine(t);
  const click = () => {
    if (sym && onToken && tok) onToken(tok.id);
    else if (t.slug && onAgent) onAgent(t.slug);
  };

  return (
    <button type="button" className={`held${hideWho ? " solo" : ""}${blocked ? " dim" : ""}`} onClick={click}>
      {!hideWho && <Face name={t.name} slug={t.slug} />}
      <div className="held-who">
        <div className="held-top">
          <div className="held-id">
            {!hideWho && <strong>{t.handle ?? t.name}</strong>}
            {!hideWho && t.slug ? <Stamp>{stampFor(t.slug)}</Stamp> : null}
            {hideWho && <strong>{verb(w, sym)}</strong>}
          </div>
          {sizeOf(t)}
        </div>
        {!hideWho && (
          <div className="held-sub">
            <span>{verb(w, sym)}</span>
          </div>
        )}
        {take ? <p>{take}</p> : null}
      </div>
    </button>
  );
}

export function MoveChorus({
  group,
  tokens,
  onToken,
  onAgent,
}: {
  group: Thesis[];
  tokens: LiveToken[];
  onToken?: (id: string) => void;
  onAgent?: (slug: string) => void;
}) {
  const t = group[0]!;
  if (group.length === 1) {
    return <MoveTicket t={t} tokens={tokens} onToken={onToken} onAgent={onAgent} />;
  }
  const w = parseWhy(t);
  const blocked = t.outcome === "refused" || t.outcome === "reverted";
  const sym = t.symbol;
  const tok = tokens.find((x) => x.symbol.toUpperCase() === (sym ?? "").toUpperCase());
  const take = thesisLine(t);
  return (
    <button
      type="button"
      className={`held chorus${blocked ? " dim" : ""}`}
      onClick={() => {
        if (sym && tok && onToken) onToken(tok.id);
        else if (t.slug && onAgent) onAgent(t.slug);
      }}
    >
      <span className="faces held-faces">
        {group.slice(0, 3).map((g) => (
          <Face key={g.slug ?? g.name} name={g.name} slug={g.slug} />
        ))}
      </span>
      <div className="held-who">
        <div className="held-top">
          <div className="held-id">
            <strong>{verb(w, sym)}</strong>
          </div>
          {sizeOf(t)}
        </div>
        {take ? <p>{take}</p> : null}
      </div>
    </button>
  );
}

function verb(w: ReturnType<typeof parseWhy>, sym: string | null): string {
  switch (w.kind) {
    case "buy":
      return `Bought ${w.symbol}`;
    case "sell":
      return `Sold ${w.symbol}`;
    case "hold":
      return `Holding ${w.symbol}`;
    case "park":
      return "Parked";
    case "unpark":
      return "Unparked";
    case "other":
      return sym ?? "Moved";
    default: {
      const _x: never = w;
      return _x;
    }
  }
}

function sizeOf(t: Thesis) {
  const n = t.sizeUsdg;
  if (n == null || n <= 0) return null;
  return <b>{money(n)}</b>;
}
