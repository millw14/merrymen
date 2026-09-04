import { useMemo, useState } from "react";
import { beatsOf, castOf, lanesOf, spellCast, type Actor, type Beat } from "../beat";
import { cadenceWords, countdown, nextRun, runLeft, useNow } from "../clock";
import { BookBar, nextLeg } from "../glance";
import { money, type LiveAgent, type LiveMine, type LiveToken, type Thesis } from "../live";
import { strategyForSlug, strategyName } from "../strategy";
import { Coin, Dial, Empty, Face, Flip, Stamp } from "../ui";
import { isWhy, whyLine } from "../why";
import { Wire } from "../wire";

const ASKS = ["What do you hold?", "What did you last do?", "What's left to spend?"] as const;

export function Agent({
  mine,
  tokens,
  agents,
  theses,
  perTrade,
  perDay,
  onToken,
  onProfile,
  onDeposit,
  onLimits,
}: {
  mine: LiveMine | null;
  tokens: LiveToken[];
  agents: LiveAgent[];
  theses: Thesis[];
  perTrade: string;
  perDay: string;
  onToken: (id: string) => void;
  onProfile: (slug: string) => void;
  onDeposit: () => void;
  onLimits: () => void;
}) {
  const now = useNow(1000);
  const [ask, setAsk] = useState("");
  const [extra, setExtra] = useState<{ q: string; a: string }[]>([]);

  const held = useMemo(
    () => new Set((mine?.glance.legs ?? []).map((l) => l.symbol.toUpperCase())),
    [mine],
  );
  const missed = useMemo(() => missedOn(theses, agents, held, now), [theses, agents, held, now]);
  const mineBeats = useMemo(() => beatsOf(mine?.moves ?? [], agents), [mine, agents]);
  const lanes = useMemo(() => lanesOf(mineBeats, now), [mineBeats, now]);

  if (!mine) {
    return <Empty title="Yours reports here." action={{ label: "Fund an agent", onClick: onDeposit }} />;
  }

  const strategy = strategyForSlug(mine.slug ?? mine.name, mine.glance.id);
  const left = countdown(nextRun(strategy, now) - now);
  const target = nextLeg(mine.glance);
  const spent = spentToday(mine, now);

  const send = (q: string) => {
    const line = q.trim();
    if (!line) return;
    setExtra((prev) => [...prev, { q: line, a: reply(mine, line, perDay, spent) }]);
    setAsk("");
  };

  return (
    <div className="page agent-page">
      <header className="agent-id">
        <Face name={mine.name} slug={mine.slug} />
        <div className="held-id">
          <strong>{mine.name}</strong>
          <Stamp>{strategyName(strategy)}</Stamp>
          <i className="live" aria-hidden />
        </div>
      </header>

      <div className="wire-top">
        <div className="hero-fig">
          <Dial left={runLeft(strategy, now)} />
          <Flip text={left.text} dir="down" />
        </div>
        <p className="hero-lede">
          until {mine.name} buys {target ?? "again"}
        </p>
        <div className="cap-bar">
          <i style={{ width: `${Math.min(100, (spent / Math.max(1, Number(perDay))) * 100)}%` }} />
        </div>
        <button type="button" className="cap-line" onClick={onLimits}>
          <span>
            {money(spent)} of ${perDay} today
          </span>
          <em>Change caps</em>
        </button>
        <p className="cap-meta">
          ${perTrade} a trade · {cadenceWords(strategy)}
        </p>
      </div>

      <section className="strip">
        <BookBar glance={mine.glance} target={target} />
      </section>

      {missed.length > 0 && (
        <section className="strip">
          <div className="missed">
            {missed.map((m) => {
              const tok = tokens.find((t) => t.symbol.toUpperCase() === m.symbol);
              return (
                <button
                  key={m.symbol}
                  type="button"
                  className="missed-row"
                  onClick={() => tok && onToken(tok.id)}
                >
                  <span className="faces">
                    {m.cast.slice(0, 3).map((a) => (
                      <Face key={a.slug} name={a.name} slug={a.slug} small />
                    ))}
                    <span className="face-out">
                      <Face name={mine.name} slug={mine.slug} small />
                    </span>
                  </span>
                  <span className="missed-said">
                    <strong>{spellCast(m.cast.map((a) => a.handle))}</strong> bought {m.symbol}
                  </span>
                  <Coin symbol={m.symbol} logo={tok?.logo ?? ""} />
                </button>
              );
            })}
          </div>
        </section>
      )}

      <section className="strip">
        {mineBeats.length === 0 ? (
          <Empty title="Nothing on the wire yet." />
        ) : (
          <Wire lanes={lanes} tokens={tokens} now={now} solo onToken={onToken} onAgent={onProfile} />
        )}
      </section>

      {extra.length > 0 && (
        <div className="turns">
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
      )}

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
        <input value={ask} onChange={(e) => setAsk(e.target.value)} placeholder={`Ask ${mine.name} anything`} />
        <button type="submit">Ask</button>
      </form>
    </div>
  );
}

interface Missed {
  symbol: string;
  cast: Actor[];
}

function missedOn(theses: Thesis[], agents: LiveAgent[], held: Set<string>, now: number): Missed[] {
  const recent = beatsOf(theses, agents).filter(
    (b: Beat) => b.action === "buy" && now - b.at < 24 * 3_600_000 && !held.has(b.symbol),
  );
  const by = new Map<string, Actor[]>();
  for (const b of recent) {
    const list = by.get(b.symbol) ?? [];
    for (const a of castOf(b)) if (!list.some((x) => x.slug === a.slug)) list.push(a);
    by.set(b.symbol, list);
  }
  return [...by.entries()]
    .map(([symbol, cast]) => ({ symbol, cast }))
    .sort((a, b) => b.cast.length - a.cast.length)
    .slice(0, 3);
}

function spentToday(mine: LiveMine, now: number): number {
  return mine.moves.reduce((n, t) => {
    if (t.action !== "buy" && t.action !== "sell") return n;
    if (t.at == null || now - t.at > 24 * 3_600_000) return n;
    return n + (t.sizeUsdg ?? 0);
  }, 0);
}

function reply(mine: LiveMine, q: string, perDay: string, spent: number): string {
  const last = mine.moves[0];
  const g = mine.glance;
  const asked = q.toLowerCase();
  if (asked.includes("spend") || asked.includes("left") || asked.includes("cap")) {
    return `${money(spent)} of $${perDay} today.`;
  }
  if (asked.includes("book") || asked.includes("hold") || asked.includes("own") || asked.includes("park")) {
    if (g.legs?.length) return `${g.legs.map((l) => `${l.symbol} ${l.weight}%`).join(", ")}.`;
    if (g.open?.length) return g.open.map((s) => s.symbol).join(", ");
    if (g.parked?.length) return `Parked in ${g.parked.join(", ")}.`;
    if (g.deepest) return `${g.deepest.symbol}, ${g.deepest.offHigh}% off its high.`;
  }
  if (last) return whyLine(last);
  return mine.thesis && isWhy(mine.thesis) ? mine.thesis : "Nothing yet.";
}
