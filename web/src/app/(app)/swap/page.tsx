"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
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
    source: "twap" | "spot";
    divergenceBps: number;
  } | null;
  slippageBps?: number;
  autoConvertEnabled?: boolean;
}

interface SwapStatus {
  state: "none" | "queued" | "running" | "done";
  id?: string;
  ok?: boolean;
  line?: string | null;
}

type Stage = "edit" | "review" | "tracking" | "done";

/** localStorage keys — the pending flow survives refresh and nav, no URL. */
const LS_AMOUNT = "merrymen.swap.amount";
const LS_TRACK = "merrymen.swap.trackId";

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

export default function SwapPage() {
  const [amount, setAmount] = useState("");
  const [quote, setQuote] = useState<SwapQuote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [stage, setStage] = useState<Stage>("edit");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [trackId, setTrackId] = useState<string | null>(null);
  const [status, setStatus] = useState<SwapStatus | null>(null);
  const [history, setHistory] = useState<{ level: string; message: string }[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const wei = ethToWei(amount);
  const stopPoll = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  }, []);
  useEffect(() => stopPoll, [stopPoll]);

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

  // Restore an in-flight swap after refresh/nav — the pending flow lives
  // here, not in the URL, so coming back resumes instead of losing it.
  useEffect(() => {
    try {
      const savedAmount = localStorage.getItem(LS_AMOUNT);
      const savedTrack = localStorage.getItem(LS_TRACK);
      if (savedAmount) setAmount(savedAmount);
      if (savedTrack) {
        setTrackId(savedTrack);
        setStage("tracking");
      }
    } catch {
      /* private mode — the page still works, just without resume */
    }
  }, []);

  // Amount edits invalidate the review, not the tracking: typing a new
  // amount while a swap is tracked starts a fresh quote, the old one keeps
  // polling underneath until it settles.
  const onAmount = (v: string) => {
    setAmount(v);
    try {
      localStorage.setItem(LS_AMOUNT, v);
    } catch {
      /* ignore */
    }
    setStage((s) => (s === "review" ? "edit" : s));
    setSubmitError(null);
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

  // Recent convert activity, so the last auto-convert is visible here too —
  // the event feed is the worker's record of what actually fired.
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

  const pollStatus = useCallback(
    (id: string) => {
      stopPoll();
      const tick = async () => {
        try {
          const r = await fetch(`/api/swap/status?id=${id}`);
          const s = (await r.json()) as SwapStatus;
          setStatus(s);
          if (s.state === "done") {
            stopPoll();
            setStage("done");
            try {
              localStorage.removeItem(LS_TRACK);
            } catch {
              /* ignore */
            }
          }
        } catch {
          /* keep polling */
        }
      };
      void tick();
      pollRef.current = setInterval(tick, 5000);
      // Give up polling after ~6 minutes: the worker is likely stopped, and
      // the request itself sits harmlessly in settings until it runs.
      setTimeout(() => {
        stopPoll();
        setStatus((s) => (s?.state === "done" ? s : { state: "running", id }));
      }, 360_000);
    },
    [stopPoll],
  );

  // Resume a track that outlived a refresh or a trip to Settings.
  useEffect(() => {
    if (trackId && stage === "tracking") pollStatus(trackId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackId]);

  const submit = async () => {
    setSubmitError(null);
    setStatus(null);
    if (wei === null || wei <= 0n) {
      setSubmitError("Enter an amount of ETH first.");
      return;
    }
    const id = crypto.randomUUID();
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ manualSwapWei: wei.toString(), manualSwapId: id }),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; errors?: string[] };
    if (!res.ok || !body.ok) {
      setSubmitError(body.errors?.join("; ") ?? "Couldn't queue the swap.");
      return;
    }
    setTrackId(id);
    setStage("tracking");
    try {
      localStorage.setItem(LS_TRACK, id);
    } catch {
      /* ignore */
    }
    pollStatus(id);
  };

  const surplus = quote?.ok && quote.surplusWei ? BigInt(quote.surplusWei) : null;
  const grantReady = quote?.grantReady;
  const quoted = quote?.ok && quote.quote && quote.amountWei && BigInt(quote.amountWei) > 0n;
  const tracking = stage === "tracking";
  const stepIdx = !status || status.state === "queued" ? 0 : status.state === "running" ? 1 : 2;

  return (
    <>
      <PageHeader title="Swap" sub="ETH → USDG · one-shot, kept for gas" />
      <div className="mm-wrap">
        <div className="sw">
          <p className="sw-sub">
            A manual one-shot conversion for trading funds. The worker picks it up on its next tick, keeps the gas
            reserve, and reports back here. Same permission, same quote and same limits as auto-convert — and a
            manual swap counts as a fire, so auto-convert won&apos;t re-eat the leftover.
          </p>

          {quote && !quote.ok && (
            <div className="sw-result warn">
              {quote.reason === "no-grant" && (
                <span>
                  No grant on file. <Link href="/grant">Sign a grant</Link> first.
                </span>
              )}
              {quote.reason === "wrong-chain" && <span>This swap only runs on the live trading chain.</span>}
            </div>
          )}

          {quote?.ok && grantReady === false && (
            <div className="sw-result err">
              <span>
                This key was signed before the ETH→USDG permission existed. <Link href="/grant">Re-sign at
                /grant</Link>, then come back — submits until then are cancelled, never silently held.
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
                disabled={tracking}
                aria-label="Amount in ETH"
              />
              <button
                type="button"
                className="mm-btn sm sw-max"
                disabled={surplus === null || surplus <= 0n || tracking}
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
                <span>{quote.quote.source === "twap" ? "15-min average" : "live spot (fresh pool)"}</span>
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

          {submitError && <p className="sw-error">{submitError}</p>}

          {stage === "edit" && (
            <div className="sw-btn-row">
              <button
                type="button"
                className="mm-btn primary"
                disabled={!quoted || grantReady !== true}
                onClick={() => setStage("review")}
              >
                Review quote
              </button>
            </div>
          )}

          {stage === "review" && quoted && quote?.quote && (
            <>
              <div className="sw-btn-row">
                <button type="button" className="mm-btn primary" onClick={submit}>
                  Confirm swap {formatEther(BigInt(quote.amountWei ?? "0"))} ETH → ~{fmtUsdg(quote.quote.expectedOut)}{" "}
                  USDG
                </button>
              </div>
              <button type="button" className="sw-back" onClick={() => setStage("edit")}>
                ← back to edit
              </button>
            </>
          )}

          {tracking && (
            <>
              <div className="sw-steps" aria-live="polite">
                {(["Queued", "Claimed", "Done"] as const).map((label, i) => (
                  <div key={label} className={`sw-step${i < stepIdx ? " done" : i === stepIdx ? " on" : ""}`}>
                    <i>{label}</i>
                  </div>
                ))}
              </div>
              <p className="sw-note">
                {!status || status.state === "queued"
                  ? "Queued — the worker picks it up on its next tick. You can leave this page; it resumes here."
                  : "Claimed — the worker is executing it."}
              </p>
            </>
          )}

          {stage === "done" && status?.state === "done" && (
            <div className={`sw-result ${status.ok ? "ok" : "err"}`}>
              {status.ok ? <b>Swapped. </b> : <b>Didn&apos;t land. </b>}
              <span className="mono">{status.line ?? "Finished."}</span>
            </div>
          )}

          {stage === "done" && (
            <div className="sw-btn-row">
              <button
                type="button"
                className="mm-btn"
                onClick={() => {
                  setStage("edit");
                  setStatus(null);
                  setTrackId(null);
                }}
              >
                Swap again
              </button>
            </div>
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
            {quote?.autoConvertEnabled && " · auto-convert is on — it fires only on new deposits now."}
          </p>
        </div>
      </div>
    </>
  );
}
