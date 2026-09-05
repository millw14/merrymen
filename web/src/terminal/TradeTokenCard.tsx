import { money, type LiveToken, type Thesis } from "./live";
import { Coin, Delta } from "./ui";

export function TradeTokenCard({
  trade,
  token,
  onToken,
}: {
  trade: Thesis;
  token?: LiveToken;
  onToken: (id: string) => void;
}) {
  return (
    <button
      type="button"
      className={`trade-token-card ${trade.action ?? "hold"}`}
      disabled={!token}
      onClick={() => token && onToken(token.id)}
      aria-label={`${trade.symbol ?? "Token"}, trade amount ${money(trade.sizeUsdg)}${token?.change24hPct != null ? `, token change ${token.change24hPct}% over 24 hours` : ""}. View token details`}
    >
      <span className="wire-seat">
        <Coin symbol={trade.symbol ?? "—"} logo={token?.logo ?? ""} />
        {trade.symbol ?? "—"}
      </span>
      <span className="wire-part-fig">
        <b>{money(trade.sizeUsdg)}</b>
        <span title="Token price change over 24 hours">
          <Delta value={token?.change24hPct ?? null} suffix="%" size={11} />
        </span>
      </span>
    </button>
  );
}
