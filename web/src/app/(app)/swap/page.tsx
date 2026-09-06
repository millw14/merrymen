"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { formatEther } from "viem";
import { PageHeader } from "@/components/shell/PageHeader";
import "@/styles/form.css";
import "./swap.css";

interface SwapQuote {
  ok: boolean;
  reason?: string;
  smartAccount?: string;
  deployed?: boolean;
  grantReady?: boolean;
  ethWei?: string;
  usdgRaw?: string;
  reserveWei?: string;
  surplusWei?: string;
  requestedWei?: string;
  amountWei?: string;
  capped?: boolean;
  quote?: {
    expectedOut: string;
    minOut: string;
    fee: number;
    source: "twap";
    divergenceBps: number;
  } | null;
  quoteReason?: string | null;
  slippageBps?: number;
  autoConvertEnabled?: boolean;
}

/** localStorage key — the amount survives refresh and nav, no URL. */
const LS_AMOUNT = "merrymen.swap.amount";

/** Decimal ETH string → wei bigint. Returns null when not a valid amount. */
function ethToWei(s: string): bigint | null {
  const t = s.trim();
  if (!/^\d+(\.\d{1,18})?$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  try {
    return BigInt(whole) * 10n ** 18n + BigInt((frac + "0".repeat(18)).slice(0, 18));
  } catch {
    return null;
  }
}

function fmtUsdg(raw6: string): string {
  try {
    const v = BigInt(raw6);
    const whole = v / 1_000_000n;
    const frac = (v % 1_000_000n).toString().padStart(6, "0").slice(0, 2);
    return `${whole.toString()}.${frac}`;
  } catch {
    return "—";
  }
}

const QUOTE_PROBLEMS: Record<string, string> = {
  "no-pool": "No WETH→USDG pool found — nothing to price from.",
  "no-twap": "No usable price yet — a fresh pool with no 15-minute average. Check back later.",
  "too-thin": "Pool too thin to quote safely — refusing rather than guessing.",
  divergent: "Pool is moving right now — refusing rather than trading into it.",
  dust: "That amount prices to dust.",
};

export default function SwapPage() {
  const [amount, setAmount] = useState("");
  const [quote, setQuote] = useState<SwapQuote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [history, setHistory] = useState<{ level: string; message: string }[]>([]);

  const wei = ethToWei(amount);

  const refreshQuote = useCallback(async (weiStr: string) => {
    setQuoteLoading(true);
    try {
      const r = await fetch(`/api/swap/quote?wei=${weiStr}`);
      setQuote((await r.json()) as SwapQuote);
    } catch {
      setQuote(null);
    } finally {
      setQuoteLoading(false);
    }
  }, []);

  // Restore the amount after refresh/nav.
  useEffect(() => {
    try {
      const savedAmount = localStorage.getItem(LS_AMOUNT);
      if (savedAmount) setAmount(savedAmount);
    } catch {
      /* private mode — the page still works, just without resume */
    }
  }, []);

  const onAmount = (v: string) => {
    setAmount(v);
    try {
      localStorage.setItem(LS_AMOUNT, v);
    } catch {
      /* ignore */
    }
    setReviewing(false);
  };

  // Debounced preview as the amount is typed.
  useEffect(() => {
    if (wei === null || wei <= 0n) {
      setQuote(null);
      return;
    }
    const t = setTimeout(() => void refreshQuote(wei.toString()), 400);
    return () => clearTimeout(t);
  }, [amount, refreshQuote, wei]);

  // Recent convert activity — the event feed is the worker's record of what
  // actually fired.
  useEffect(() => {
    fetch("/api/feed")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const events = (d?.events ?? []) as { level: string; message: string }[];
        setHistory(
          events
            .filter((e) => /auto-convert ✓|manual-swap|auto-convert skipped/.test(e.message))
            .slice(0, 5),
        );
      })
      .catch(() => {});
  }, []);

  const surplus = quote?.ok && quote.surplusWei ? BigInt(quote.surplusWei) : null;
  const grantReady = quote?.grantReady;
  const quoted = quote?.ok && quote.quote && quote.amountWei && BigInt(quote.amountWei) > 0n;

  return (
    <>
      <PageHeader title="Swap" sub="ETH → USDG · one-shot, kept for gas" />
      <div className="mm-wrap">
        <div className="sw">
          <p className="sw-sub">
            A manual one-shot conversion for trading funds, quoted live from the chain with the same reserve the
            worker will keep. Execution lands in the follow-up — this page previews today.
          </p>

          {quote && !quote.ok && (
            <div className="sw-result warn">
              {quote.reason === "no-grant" && (
                <span>
                  No grant on file. <Link href="/grant">Sign a grant</Link> first.
                </span>
              )}
              {quote.reason === "wrong-chain" && <span>This swap only runs on the live trading chain.</span>}
              {quote.reason === "rpc-unreadable" && (
                <span>Couldn&apos;t read the chain just now — balances unknown, refusing to guess. It retries.</span>
              )}
            </div>
          )}

          {quote?.ok && grantReady === false && (
            <div className="sw-result err">
              <span>
                This key was signed before the ETH→USDG permission existed. <Link href="/grant">Re-sign at
                /grant</Link> when execution lands.
              </span>
            </div>
          )}

          {quote?.ok && (
            <div className="mm-panel sw-figs">
              <div className="sw-fig">
                <span>Balance</span>
                <b>{formatEther(BigInt(quote.ethWei ?? "0"))} ETH</b>
              </div>
              <div className="sw-fig">
                <span>Reserve kept</span>
                <b>{formatEther(BigInt(quote.reserveWei ?? "0"))} ETH</b>
              </div>
              <div className="sw-fig">
                <span>Convertible</span>
                <b>{formatEther(BigInt(quote.surplusWei ?? "0"))} ETH</b>
              </div>
            </div>
          )}

          <div className="mm-field">
            <div className="mm-labelrow">
              <span className="mm-label">Amount (ETH)</span>
            </div>
            <div className="mm-input">
              <input
                inputMode="decimal"
                placeholder="0.01"
                value={amount}
                onChange={(e) => onAmount(e.target.value)}
                aria-label="Amount in ETH"
              />
              <button
                type="button"
                className="mm-btn sm sw-max"
                disabled={surplus === null || surplus <= 0n}
                onClick={() => surplus !== null && onAmount(formatEther(surplus))}
              >
                MAX
              </button>
            </div>
            <p className="sw-note">
              {quote?.ok
                ? `Balance ${formatEther(BigInt(quote.ethWei ?? "0"))} ETH · the worker keeps ${formatEther(BigInt(quote.reserveWei ?? "0"))} ETH for gas.`
                : "Type an amount for a live quote."}{" "}
              <Link href="/settings">Auto-convert lives in Settings</Link>.
            </p>
          </div>

          {quoteLoading && <p className="sw-note">Quoting…</p>}

          {quoted && quote?.quote && (
            <div className="mm-panel sw-quote">
              <div className="sw-quote-row">
                <span>You get (est.)</span>
                <strong>~{fmtUsdg(quote.quote.expectedOut)} USDG</strong>
              </div>
              <div className="sw-quote-row">
                <span>Minimum after slippage</span>
                <span>{fmtUsdg(quote.quote.minOut)} USDG</span>
              </div>
              <div className="sw-quote-row">
                <span>Pool fee</span>
                <span>{(quote.quote.fee / 10_000).toFixed(2)}%</span>
              </div>
              <div className="sw-quote-row">
                <span>Price source</span>
                <span>15-min average (TWAP)</span>
              </div>
              {quote.quote.divergenceBps > 500 && (
                <p className="sw-note sw-note-warn">
                  Heads up: the live price is {(quote.quote.divergenceBps / 100).toFixed(1)}% away from the average —
                  the pool may be moving right now. Your slippage guard still applies.
                </p>
              )}
              {quote.capped && (
                <p className="sw-note sw-note-warn">Capped to the convertible surplus — the rest stays as gas.</p>
              )}
            </div>
          )}

          {quote?.ok && quote.amountWei === "0" && wei !== null && wei > 0n && (
            <p className="sw-note sw-note-warn">
              Nothing convertible at this balance — the whole amount is the gas reserve.
            </p>
          )}

          {quote?.ok && quote.amountWei !== "0" && !quote.quote && quote.quoteReason && (
            <p className="sw-note sw-note-warn">{QUOTE_PROBLEMS[quote.quoteReason] ?? "No quote right now."}</p>
          )}

          {!reviewing ? (
            <div className="sw-btn-row">
              <button type="button" className="mm-btn primary" disabled={!quoted} onClick={() => setReviewing(true)}>
                Review quote
              </button>
            </div>
          ) : (
            <>
              <div className="sw-btn-row">
                <button
                  type="button"
                  className="mm-btn primary"
                  disabled={true}
                  title="Execution lands in the follow-up PR"
                >
                  Confirm swap — execution lands next
                </button>
              </div>
              <button type="button" className="sw-back" onClick={() => setReviewing(false)}>
                ← back to edit
              </button>
            </>
          )}

          {history.length > 0 && (
            <div className="mm-panel sw-history">
              <h2 className="mm-kicker">Recent conversions</h2>
              <ul>
                {history.map((e, i) => (
                  <li key={i} className={e.level}>
                    {e.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <p className="sw-note">
            <Link href="/settings">Settings</Link> · <Link href="/grant">Grant</Link>
          </p>
        </div>
      </div>
    </>
  );
}
