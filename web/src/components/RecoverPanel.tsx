"use client";

import { useState } from "react";

/**
 * "Get my money out" — the one-click counterpart to `merrymen recover`.
 *
 * Funds sit in a counterfactual smart account, not a plain wallet, so users
 * can't reach them by importing the owner key into MetaMask. This sweeps the
 * balance to any address they control, signed by the owner (sudo) key — works
 * even after a kill switch. For an active agent the server signs with the key in
 * grant.json (nothing typed); after a kill, the user pastes their backed-up key.
 */

interface Balance {
  symbol: string;
  amount: string;
}
interface Ctx {
  hasStoredKey: boolean;
  hasBundler: boolean;
  chainId?: number;
  explorer?: string;
  smartAccount?: string;
  ownerAddress?: string;
  balances?: Balance[];
  error?: string;
}
interface PlanRes {
  smartAccount: string;
  ownerAddress: string;
  explorer: string;
  chainId: number;
  balances: Balance[];
  error?: string;
}
interface SweepRes {
  txHash: string;
  to: string;
  smartAccount: string;
  explorer: string;
  balances: Balance[];
  error?: string;
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const isAddr = (v: string) => /^0x[0-9a-fA-F]{40}$/.test(v.trim());
const isKey = (v: string) => /^0x[0-9a-fA-F]{64}$/.test(v.trim());
const MAINNET = 4663;
const TESTNET = 46630;

export function RecoverPanel() {
  const [open, setOpen] = useState(false);
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [loadingCtx, setLoadingCtx] = useState(false);

  const [ownerKey, setOwnerKey] = useState("");
  const [chainId, setChainId] = useState<number>(MAINNET);
  const [plan, setPlan] = useState<PlanRes | null>(null);

  const [to, setTo] = useState("");
  const [busy, setBusy] = useState<null | "checking" | "sweeping">(null);
  const [result, setResult] = useState<SweepRes | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function expand() {
    setOpen(true);
    if (ctx || loadingCtx) return;
    setLoadingCtx(true);
    try {
      const r = await fetch("/api/recover");
      setCtx((await r.json()) as Ctx);
    } catch {
      setCtx({ hasStoredKey: false, hasBundler: false, error: "couldn't reach the recovery service" });
    }
    setLoadingCtx(false);
  }

  async function checkPasted() {
    setError(null);
    if (!isKey(ownerKey)) {
      setError("that isn't a 32-byte owner key (0x + 64 hex chars).");
      return;
    }
    setBusy("checking");
    try {
      const r = await fetch("/api/recover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "plan", ownerKey: ownerKey.trim(), chainId }),
      });
      const j = (await r.json()) as PlanRes;
      if (!r.ok || j.error) setError(j.error ?? "couldn't read that wallet.");
      else setPlan(j);
    } catch {
      setError("couldn't reach the recovery service.");
    }
    setBusy(null);
  }

  // Balances/addresses come from the pasted-key plan if present, else the GET ctx.
  const balances = plan?.balances ?? ctx?.balances ?? [];
  const smartAccount = plan?.smartAccount ?? ctx?.smartAccount;
  const explorer = plan?.explorer ?? ctx?.explorer;
  const activeChain = plan?.chainId ?? ctx?.chainId ?? chainId;
  const hasBundler = ctx?.hasBundler ?? false;
  // Do we know what's in the account yet? (stored-key ctx, or a checked paste.)
  const known = !!(plan || (ctx?.hasStoredKey && ctx));
  const empty = known && balances.length === 0;

  async function sweep() {
    setError(null);
    if (!isAddr(to)) {
      setError("enter a valid destination address (0x + 40 hex).");
      return;
    }
    const list = balances.map((b) => `${b.amount} ${b.symbol}`).join(", ") || "the balance";
    if (!window.confirm(`Sweep ${list} to ${to.trim()}?\n\nThis is real and irreversible. The account keeps a little ETH to pay for gas.`)) {
      return;
    }
    setBusy("sweeping");
    try {
      const body: Record<string, unknown> = { mode: "sweep", to: to.trim() };
      if (plan) {
        body.ownerKey = ownerKey.trim();
        body.chainId = chainId;
      }
      const r = await fetch("/api/recover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = (await r.json()) as SweepRes;
      if (!r.ok || j.error) setError(j.error ?? "recovery failed.");
      else setResult(j);
    } catch {
      setError("couldn't reach the recovery service.");
    }
    setBusy(null);
  }

  return (
    <div className="panel recover-panel">
      <div className="section-title">recover funds</div>

      {!open ? (
        <>
          <p className="recover-sub">
            Your money lives in a smart account, not a MetaMask wallet — so importing the owner key
            won&apos;t show it. Sweep it back to any address you control, anytime (even after a kill).
          </p>
          <button className="recover-btn" onClick={() => void expand()}>
            🏹 recover my funds
          </button>
        </>
      ) : loadingCtx ? (
        <p className="recover-sub">reading your account…</p>
      ) : result ? (
        <div className="recover-done">
          <p className="recover-sub">
            <b>Recovered ✓</b> — {result.balances.map((b) => `${b.amount} ${b.symbol}`).join(", ")} sent to{" "}
            <span className="mono">{short(result.to)}</span>.
          </p>
          <a className="recover-btn" href={`${result.explorer}/tx/${result.txHash}`} target="_blank" rel="noreferrer">
            view the transaction ↗
          </a>
        </div>
      ) : (
        <>
          {/* Killed/expired: no stored key — ask for the backed-up one. */}
          {ctx && !ctx.hasStoredKey && !plan && (
            <>
              <p className="recover-sub">
                No active agent on this machine, so paste the <b>owner key</b> you backed up when you
                created the wallet. It stays on your machine — it&apos;s used once to sign the sweep.
              </p>
              <input
                className="recover-input mono"
                type="password"
                placeholder="owner key (0x…)"
                value={ownerKey}
                onChange={(e) => setOwnerKey(e.target.value)}
                autoComplete="off"
              />
              <div className="recover-chain">
                <label>
                  <input type="radio" checked={chainId === MAINNET} onChange={() => setChainId(MAINNET)} /> mainnet · 4663
                </label>
                <label>
                  <input type="radio" checked={chainId === TESTNET} onChange={() => setChainId(TESTNET)} /> testnet · 46630
                </label>
              </div>
              <button className="recover-btn" onClick={() => void checkPasted()} disabled={busy !== null}>
                {busy === "checking" ? "reading the wallet…" : "check what's in it"}
              </button>
            </>
          )}

          {/* Balances known — show them and the sweep form. */}
          {known && (
            <>
              {smartAccount && (
                <p className="recover-sub">
                  account{" "}
                  {explorer ? (
                    <a className="mono" href={`${explorer}/address/${smartAccount}`} target="_blank" rel="noreferrer">
                      {short(smartAccount)} ↗
                    </a>
                  ) : (
                    <span className="mono">{short(smartAccount)}</span>
                  )}{" "}
                  · chain {activeChain}
                </p>
              )}

              {empty ? (
                <p className="recover-sub">This account is empty — nothing to recover.</p>
              ) : (
                <>
                  <div className="recover-holdings mono">
                    {balances.map((b) => (
                      <span key={b.symbol} className="recover-hold">
                        {b.amount} {b.symbol}
                      </span>
                    ))}
                  </div>

                  {!hasBundler && (
                    <p className="recover-warn">
                      Recovery sends an on-chain transaction, so it needs your bundler key. Add a free
                      Pimlico key in <a href="/settings">settings</a>, then come back.
                    </p>
                  )}

                  <input
                    className="recover-input mono"
                    type="text"
                    placeholder="send to… (an address you control, e.g. MetaMask)"
                    value={to}
                    onChange={(e) => setTo(e.target.value)}
                    autoComplete="off"
                  />
                  <button
                    className="recover-btn go"
                    onClick={() => void sweep()}
                    disabled={busy !== null || !hasBundler || !isAddr(to)}
                  >
                    {busy === "sweeping" ? "signing & sending (up to a minute)…" : "recover funds →"}
                  </button>
                </>
              )}
            </>
          )}

          {error && <p className="recover-err mono">{error}</p>}

          <p className="recover-note">
            Signed by your <b>owner key</b> (not the capped session key), so it works after a kill and
            isn&apos;t bound by trade limits. Same engine as <span className="mono">merrymen recover</span>.
          </p>
        </>
      )}
    </div>
  );
}
