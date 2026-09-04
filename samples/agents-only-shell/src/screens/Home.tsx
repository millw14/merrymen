import { coinPrice, lede, money, pctPts, type LiveMine, type LiveToken, type TokenTab } from "../live";
import { isWhy } from "../why";
import { Coin, Face, LogoMark, NameBlock, Pill } from "../ui";

export function Home({
  tokens,
  mine,
  tokenTab,
  onTokenTab,
  onToken,
  onDeposit,
  onSearch,
  onDesk,
}: {
  tokens: LiveToken[];
  mine: LiveMine | null;
  tokenTab: TokenTab;
  onTokenTab: (tab: TokenTab) => void;
  onToken: (id: string) => void;
  onDeposit: () => void;
  onSearch: () => void;
  onDesk: () => void;
}) {
  const list =
    tokenTab === "buys"
      ? [...tokens].filter((t) => t.buys > 0 || t.cast.length > 0).sort((a, b) => b.buys - a.buys)
      : [...tokens]
          .filter((t) => t.agents > 0 || t.cast.length > 0)
          .sort((a, b) => b.agents - a.agents || (b.holders ?? 0) - (a.holders ?? 0));
  const shown = list.length > 0 ? list : [...tokens].sort((a, b) => (b.change24hPct ?? 0) - (a.change24hPct ?? 0)).slice(0, 8);

  const eq = mine?.equity ?? null;
  const chg = mine?.chg24 ?? null;
  const [whole, frac] = money(eq).replace("$", "").split(".");
  const take = mine?.thesis && isWhy(mine.thesis) ? lede(mine.thesis) : "";

  return (
    <>
      <header className="top">
        <div className="top-row">
          <LogoMark size={26} />
          <div className="top-actions">
            <button type="button" className="icon-btn" aria-label="Search" onClick={onSearch}>
              <SearchIcon />
            </button>
            <button type="button" className="fund" onClick={onDeposit}>
              Fund
            </button>
          </div>
        </div>

        {mine ? (
          <button type="button" className="hero" onClick={onDesk}>
            <div className="hero-who">
              <Face name={mine.name} slug={mine.slug} />
              <NameBlock title={mine.name} owner={mine.owner ?? "you"} />
              <i className="live" aria-hidden />
            </div>
            {eq !== null && (
              <div className="balance">
                ${whole}
                {frac !== undefined && <sup>.{frac}</sup>}
              </div>
            )}
            {chg !== null && (
              <p className={`chg-24 ${chg < 0 ? "down" : "up"}`}>
                {chg < 0 ? "−" : "+"}${Math.abs(chg).toFixed(2)} today
              </p>
            )}
            {take ? <p className="hero-said">{take}</p> : null}
          </button>
        ) : (
          <div className="hero empty">
            <h1>This one trades.</h1>
            <button type="button" className="fund solid" onClick={onDeposit}>
              Fund an agent
            </button>
          </div>
        )}
      </header>

      <section>
        <div className="pills">
          <Pill on={tokenTab === "buys"} onClick={() => onTokenTab("buys")}>
            Buying
          </Pill>
          <Pill on={tokenTab === "held"} onClick={() => onTokenTab("held")}>
            Held
          </Pill>
        </div>
        <div>
          {shown.map((t) => {
            const chgPct = t.change24hPct;
            const who = t.cast.slice(0, 3);
            return (
              <button key={t.id} type="button" className="tok" onClick={() => onToken(t.id)}>
                <Coin symbol={t.symbol} logo={t.logo} />
                <div>
                  <strong>{t.symbol}</strong>
                  {who.length > 0 ? (
                    <p className="meta cast">
                      <span className="faces">
                        {who.map((a) => (
                          <Face key={a.slug} name={a.name} slug={a.slug} small />
                        ))}
                      </span>
                      {who.map((a) => a.handle ?? a.name).join(", ")}
                      {t.cast.length > who.length ? ` +${t.cast.length - who.length}` : ""}
                    </p>
                  ) : (
                    <p className="meta">{t.name}</p>
                  )}
                </div>
                <div className="px">
                  {coinPrice(t.priceUsd)}
                  {chgPct != null && <small className={chgPct >= 0 ? "up" : "down"}>{pctPts(chgPct)}</small>}
                </div>
              </button>
            );
          })}
        </div>
      </section>
    </>
  );
}

function SearchIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l5 5" />
    </svg>
  );
}
