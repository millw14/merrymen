import { useState } from "react";
import { validAmount } from "../amount";
import { money } from "../live";

export function Limits({
  perTrade,
  perDay,
  onSave,
  onBack,
}: {
  perTrade: string;
  perDay: string;
  onSave: (trade: string, day: string) => void;
  onBack: () => void;
}) {
  const [trade, setTrade] = useState(perTrade);
  const [day, setDay] = useState(perDay);
  const [attempted, setAttempted] = useState(false);
  const tradeError = !validAmount(trade)
    ? "Enter an amount above $0 with up to two decimal places."
    : validAmount(day) && Number(trade) > Number(day)
      ? "The per-trade limit can’t exceed the daily limit."
      : "";
  const dayError = !validAmount(day)
    ? "Enter an amount above $0 with up to two decimal places."
    : "";
  return (
    <div className="money-flow limits-flow">
      <header className="flow-top">
        <button
          type="button"
          className="flow-back"
          onClick={onBack}
          aria-label="Back"
        >
          ←
        </button>
        <span>Trading limits</span>
      </header>
      <div className="flow-intro">
        <h1>Trading limits</h1>
        <p>
          Choose how much your agent can use for a single trade and across a
          day.
        </p>
      </div>
      <form
        className="limits-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          setAttempted(true);
          if (!tradeError && !dayError)
            onSave(Number(trade).toFixed(2), Number(day).toFixed(2));
        }}
      >
        <div className="limit-field">
          <label htmlFor="trade-limit">Per trade</label>
          <p id="trade-help">The most your agent can use in one trade.</p>
          <div className="limit-input">
            <span aria-hidden>$</span>
            <input
              id="trade-limit"
              inputMode="decimal"
              autoComplete="off"
              maxLength={12}
              value={trade}
              onChange={(e) => setTrade(e.target.value)}
              aria-invalid={attempted && !!tradeError}
              aria-describedby={`trade-help${attempted && tradeError ? " trade-error" : ""}`}
            />
          </div>
          {attempted && tradeError && (
            <p id="trade-error" className="flow-error" role="alert">
              {tradeError}
            </p>
          )}
        </div>
        <div className="limit-field">
          <label htmlFor="day-limit">Per day</label>
          <p id="day-help">The total allowed across the day’s trades.</p>
          <div className="limit-input">
            <span aria-hidden>$</span>
            <input
              id="day-limit"
              inputMode="decimal"
              autoComplete="off"
              maxLength={12}
              value={day}
              onChange={(e) => setDay(e.target.value)}
              aria-invalid={attempted && !!dayError}
              aria-describedby={`day-help${attempted && dayError ? " day-error" : ""}`}
            />
          </div>
          {attempted && dayError && (
            <p id="day-error" className="flow-error" role="alert">
              {dayError}
            </p>
          )}
        </div>
        <div className="flow-notice">
          <strong>These are ceilings, not targets</strong>
          <p>
            {!tradeError && !dayError
              ? `Your agent can use up to ${money(Number(trade))} per trade, within a ${money(Number(day))} daily limit. It doesn’t have to spend the full amount.`
              : "Your agent can spend less than these limits. Updating them doesn’t place a trade."}
          </p>
        </div>
        <div className="flow-actions">
          <button type="submit" className="flow-primary">
            Save limits
          </button>
          <button type="button" className="flow-secondary" onClick={onBack}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
