import { ArrowLeft, X } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { validAmount } from "../amount";
import { money, type LiveMine } from "../live";
import { Face } from "../ui";

export function Deposit({
  mine,
  mode = "deposit",
  compact = false,
  onBack,
}: {
  mine: LiveMine;
  mode?: "deposit" | "withdraw";
  compact?: boolean;
  onBack: () => void;
}) {
  const flowRef = useRef<HTMLDivElement>(null);
  const withdrawing = mode === "withdraw";
  const available = Math.max(0, mine.glance.cashUsd ?? 0);
  const title = withdrawing ? "Withdraw" : "Add funds";
  const reviewTitle = withdrawing ? "Review withdrawal" : "Review funding";
  const [amount, setAmount] = useState(withdrawing ? "" : "100");
  const [review, setReview] = useState(false);
  const [attempted, setAttempted] = useState(false);
  useLayoutEffect(() => {
    if (compact) flowRef.current?.parentElement?.scrollTo(0, 0);
  }, [review, compact]);
  const valid =
    validAmount(amount) && (!withdrawing || Number(amount) <= available);
  return (
    <div
      ref={flowRef}
      className={`money-flow funding-flow ${review ? "is-review" : ""}`}
    >
      <header className="flow-top">
        {compact && <span>{title}</span>}
        <button
          type="button"
          className="flow-back"
          onClick={() => (review && !compact ? setReview(false) : onBack())}
          aria-label={
            compact
              ? `Close ${title.toLowerCase()}`
              : review
                ? "Edit amount"
                : "Back"
          }
        >
          {compact ? <X size={18} /> : <ArrowLeft size={18} />}
        </button>
        {!compact && <span>{review ? reviewTitle : title}</span>}
      </header>
      <ol className="fund-steps" aria-label={`${title} steps`}>
        <li aria-current={!review ? "step" : undefined}>
          <span>{review ? "✓" : "1"}</span> Amount
        </li>
        <li aria-current={review ? "step" : undefined}>
          <span>2</span> Review
        </li>
      </ol>
      <div className="flow-intro">
        <h1>{review ? reviewTitle : title}</h1>
        <p>
          {review
            ? "Review the amount and where it would go."
            : withdrawing
              ? "Choose an amount from your available cash."
              : "Choose an amount for your agent."}
        </p>
      </div>
      <div className="fund-recipient">
        <Face name={mine.name} slug={mine.slug} />
        <div>
          <span>{withdrawing ? "From" : "Funding"}</span>
          <strong>{mine.name}</strong>
        </div>
        <div>
          <span>{withdrawing ? "Available cash" : "Current balance"}</span>
          <strong>{money(withdrawing ? available : mine.equity)}</strong>
        </div>
      </div>
      {review ? (
        <>
          <div className="fund-review-amount">
            <span>{withdrawing ? "Amount to withdraw" : "Amount to add"}</span>
            <strong>{money(Number(amount))}</strong>
            <button type="button" onClick={() => setReview(false)}>
              Edit amount
            </button>
          </div>
          <dl className="fund-breakdown">
            <div>
              <dt>Agent</dt>
              <dd>{mine.name}</dd>
            </div>
            <div>
              <dt>Current balance</dt>
              <dd>{money(mine.equity)}</dd>
            </div>
            <div className="fund-result">
              <dt>
                {withdrawing
                  ? "Balance after withdrawal"
                  : "Balance after funding"}
              </dt>
              <dd>
                {money(
                  mine.equity == null
                    ? null
                    : mine.equity + (withdrawing ? -1 : 1) * Number(amount),
                )}
              </dd>
            </div>
          </dl>
          <div className="flow-actions">
            <button type="button" className="flow-primary" onClick={onBack}>
              Done
            </button>
            {!compact && (
              <button
                type="button"
                className="flow-secondary"
                onClick={() => setReview(false)}
              >
                Change amount
              </button>
            )}
          </div>
        </>
      ) : (
        <form
          className="fund-form"
          onSubmit={(e) => {
            e.preventDefault();
            setAttempted(true);
            if (valid) setReview(true);
          }}
          noValidate
        >
          <label className="fund-amount-label" htmlFor="fund-amount">
            Amount in USD
          </label>
          <div className="fund-amount-input">
            <span aria-hidden>$</span>
            <input
              id="fund-amount"
              style={{ width: `${Math.max(1, amount.length) + 0.3}ch` }}
              inputMode="decimal"
              autoComplete="off"
              maxLength={12}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              aria-invalid={attempted && !valid}
              aria-describedby="fund-amount-help"
            />
          </div>
          <p
            id="fund-amount-help"
            role={attempted && !valid ? "alert" : undefined}
            className={attempted && !valid ? "flow-error" : "flow-hint"}
          >
            {attempted && !valid
              ? withdrawing && Number(amount) > available
                ? `Available cash is ${money(available)}.`
                : "Enter an amount above $0 with up to two decimal places."
              : "Choose an amount or enter your own."}
          </p>
          <div className="fund-presets">
            {(withdrawing
              ? [0.25, 0.5, 0.75, 1]
                  .map(
                    (fraction) => Math.floor(available * fraction * 100) / 100,
                  )
                  .filter(
                    (value, index, list) =>
                      value > 0 && list.indexOf(value) === index,
                  )
              : [25, 50, 100, 250]
            ).map((value) => (
              <button
                type="button"
                key={value}
                aria-pressed={Number(amount) === value}
                onClick={() => {
                  setAmount(String(value));
                  setAttempted(false);
                }}
              >
                ${value}
              </button>
            ))}
          </div>
          <div className="flow-actions">
            <button type="submit" className="flow-primary">
              {reviewTitle} <span aria-hidden>→</span>
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
