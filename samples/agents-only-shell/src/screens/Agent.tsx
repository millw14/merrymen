import { useState } from "react";
import { BookBar } from "../glance";
import { ageOf, money, sizeOf, type LiveMine, type LiveToken, type Thesis } from "../live";
import { strategyForSlug, strategyName, type StrategyId } from "../strategy";
import { Face, Stamp } from "../ui";
import { isWhy, parseWhy, takeFor, whyLine } from "../why";

const ASKS = ["Why the book?", "What did you last do?", "What's parked?"] as const;

export function Agent({
  mine,
  tokens,
  onToken,
  onDeposit,
}: {
  mine: LiveMine | null;
  tokens: LiveToken[];
  onToken: (id: string) => void;
  onDeposit: () => void;
}) {
  const [ask, setAsk] = useState("");
  const [extra, setExtra] = useState<{ q: string; a: string }[]>([]);

  if (!mine) {
    return (
      <div className="talk">
        <p className="thesis">Yours reports here.</p>
        <button type="button" className="fund solid" onClick={onDeposit}>
          Fund an agent
        </button>
      </div>
    );
  }

  const eq = mine.equity;
  const chg = mine.chg24;
  const [whole, frac] = money(eq).replace("$", "").split(".");
  const stamp = strategyName(mine.glance.id);
  const strategy = strategyForSlug(mine.slug ?? mine.name, mine.glance.id);
  const done = mine.moves.filter((m) => m.action === "buy" || m.action === "sell" || m.action === "hold");

  const send = (q: string) => {
    const line = q.trim();
    if (!line) return;
    setExtra((prev) => [...prev, { q: line, a: reply(mine, line) }]);
    setAsk("");
  };

  return (
    <div className="talk">
      <header className="desk-bar">
        <div className="desk-strip">
          <div className="visit-who">
            <Face name={mine.name} slug={mine.slug} />
            <div className="held-id">
              <strong>{mine.name}</strong>
              <Stamp>{stamp}</Stamp>
              <i className="live" aria-hidden />
            </div>
          </div>
          {eq != null && (
            <div className="desk-nums">
              <div className="balance sm">
                ${whole}
                {frac !== undefined && <sup>.{frac}</sup>}
              </div>
              {chg != null && (
                <p className={`chg-24 ${chg < 0 ? "down" : "up"}`}>
                  {chg < 0 ? "−" : "+"}${Math.abs(chg).toFixed(2)} today
                </p>
              )}
            </div>
          )}
        </div>
        <BookBar glance={mine.glance} />
      </header>

      <div className="thread">
        {done.map((m, i) => (
          <MoveNote
            key={`${m.head}-${i}`}
            t={m}
            tokens={tokens}
            strategy={strategy}
            standing={mine.thesis}
            slug={mine.slug ?? ""}
            onToken={onToken}
          />
        ))}
        {extra.map((m, i) => (
          <div key={i} className="turn">
            <div className="bubble me">
              <p>{m.q}</p>
            </div>
            <div className="bubble them">
              <p>{m.a}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="asks">
        {ASKS.map((q) => (
          <button key={q} type="button" className="ask-chip" onClick={() => send(q)}>
            {q}
          </button>
        ))}
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          send(ask);
        }}
      >
        <input value={ask} onChange={(e) => setAsk(e.target.value)} placeholder={`Ask ${mine.name}`} />
        <button type="submit">Ask</button>
      </form>
    </div>
  );
}

function MoveNote({
  t,
  tokens,
  strategy,
  standing,
  slug,
  onToken,
}: {
  t: Thesis;
  tokens: LiveToken[];
  strategy: StrategyId;
  standing: string | null;
  slug: string;
  onToken: (id: string) => void;
}) {
  const w = parseWhy(t);
  const sym = "symbol" in w ? w.symbol : t.symbol;
  const tok = tokens.find((x) => x.symbol.toUpperCase() === (sym ?? "").toUpperCase());
  const take = takeFor(slug, sym ?? "", t.reason, standing, strategy);
  const size = sizeOf(t);
  const age = ageOf(t);
  return (
    <button
      type="button"
      className="bubble them note"
      onClick={() => {
        if (sym && tok) onToken(tok.id);
      }}
    >
      <div className="note-top">
        <strong>
          {verb(w)} {sym ?? ""}
        </strong>
        {size != null ? <b>{money(size)}</b> : null}
        {age ? <em>{age}</em> : null}
      </div>
      {take ? <p>{take}</p> : null}
    </button>
  );
}

function verb(w: ReturnType<typeof parseWhy>): string {
  switch (w.kind) {
    case "buy":
      return "Bought";
    case "sell":
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

function reply(mine: LiveMine, q: string): string {
  const last = mine.moves[0];
  const g = mine.glance;
  const asked = q.toLowerCase();
  if (asked.includes("book") || asked.includes("hold") || asked.includes("own") || asked.includes("park")) {
    if (g.legs?.length) return g.legs.map((l) => l.symbol).join(", ");
    if (g.open?.length) return g.open.map((s) => s.symbol).join(", ");
    if (g.parked?.length) return `Parked in ${g.parked.join(", ")}.`;
    if (g.deepest) return `${g.deepest.symbol} · ${g.deepest.offHigh}% off`;
  }
  if (asked.includes("last") && last) return whyLine(last);
  if (last) return whyLine(last);
  return mine.thesis && isWhy(mine.thesis) ? mine.thesis : "Nothing yet.";
}
