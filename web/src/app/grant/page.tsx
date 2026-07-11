"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { LogoMark } from "@/components/Logo";
import { explorerFor, robinhoodChain, robinhoodTestnet } from "@merrymen/core";
import {
  clearGrant,
  createAgentWallet,
  FAUCET_URL,
  loadGrant,
  readFunding,
  type Funding,
  type Grant,
  type GrantCaps,
} from "@/lib/session";

const DEFAULTS: GrantCaps = {
  perTradeUsdg: 50,
  dailyUsdg: 500,
  expiryDays: 14,
  maxDrawdownPct: 10,
  maxOpsPerDay: 48,
};

const BACKUP_KEY = "merrymen.grant.backedup.v1";
const TESTNET = robinhoodTestnet.id; // 46630 — the sandbox
const MAINNET = robinhoodChain.id; // 4663 — real funds

function short(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function chainLabel(id: number): string {
  return id === TESTNET ? `testnet · ${TESTNET}` : `mainnet · ${MAINNET}`;
}

function CopyBtn({ value, label = "copy" }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="copy-btn"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        } catch {
          /* clipboard blocked — user can select manually */
        }
      }}
    >
      {done ? "copied ✓" : label}
    </button>
  );
}

export default function GrantPage() {
  const [caps, setCaps] = useState<GrantCaps>(DEFAULTS);
  const [chainId, setChainId] = useState<number>(TESTNET);
  const [mainnetAck, setMainnetAck] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [grant, setGrant] = useState<Grant | null>(null);
  const [backedUp, setBackedUp] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [ack, setAck] = useState(false);
  const [funding, setFunding] = useState<Funding | null>(null);

  useEffect(() => {
    setGrant(loadGrant());
    setBackedUp(localStorage.getItem(BACKUP_KEY) === "1");
  }, []);

  // Poll the account's on-chain balances (on the GRANT's chain) at the fund step.
  const refreshFunding = useCallback(async (addr: `0x${string}`, forChain: number) => {
    try {
      setFunding(await readFunding(addr, forChain));
    } catch {
      /* transient RPC error — keep the last reading */
    }
  }, []);

  useEffect(() => {
    if (!grant || !backedUp) return;
    refreshFunding(grant.smartAccount, grant.chainId);
    const id = setInterval(() => refreshFunding(grant.smartAccount, grant.chainId), 8000);
    return () => clearInterval(id);
  }, [grant, backedUp, refreshFunding]);

  const set = (k: keyof GrantCaps) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setCaps((c) => ({ ...c, [k]: Number(e.target.value) }));

  const isMainnet = chainId === MAINNET;
  // Mainnet is real money — the create button stays locked until the user
  // explicitly owns that (keys are plaintext-local; caps are the seatbelt).
  const createBlocked = isMainnet && !mainnetAck;

  async function onCreate() {
    setError(null);
    setStatus("starting…");
    try {
      const g = await createAgentWallet(caps, setStatus, chainId);
      setGrant(g);
      setStatus(null);
    } catch (e) {
      setStatus(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function confirmBackup() {
    localStorage.setItem(BACKUP_KEY, "1");
    setBackedUp(true);
  }

  function discard() {
    clearGrant();
    // Also destroy the worker-side handoff — otherwise the "discarded" grant
    // stays armed and the worker keeps trading on it (kill-switch semantics).
    void fetch("/api/grants", { method: "DELETE" }).catch(() => {});
    localStorage.removeItem(BACKUP_KEY);
    setGrant(null);
    setBackedUp(false);
    setReveal(false);
    setAck(false);
    setMainnetAck(false);
    setFunding(null);
  }

  const gasFunded = (funding?.gasWei ?? 0n) > 0n;
  const usdgFunded = (funding?.usdgUnits ?? 0n) > 0n;
  // Once a grant exists, the truth is what's IN it — not the selector state.
  const activeChainId = grant ? grant.chainId : chainId;
  const grantIsTestnet = (grant?.chainId ?? TESTNET) === TESTNET;

  return (
    <>
      <header className="topbar">
        <Link href="/" className="brand" style={{ color: "inherit", textDecoration: "none" }}>
          <span className="arrow"><LogoMark size={20} /></span>
          <span>merrymen</span>
        </Link>
        <span className={`chain-pill ${activeChainId === MAINNET ? "mainnet" : ""}`}>
          <span className="dot" />
          {chainLabel(activeChainId)}
        </span>
      </header>

      <main className="grant-shell">
        {/* ─── phase 1: pick a chain, set caps, create the wallet ────────── */}
        {!grant && (
          <div className="grant-panel">
            <h1 className="grant-title">create your agent wallet</h1>
            <p className="grant-sub">
              No wallet to connect — merrymen mints a fresh account whose owner key lives with
              you. Pick your ground, set the caps the <b>account contract itself</b> will enforce,
              then create it and fund it.
            </p>

            <div className="chain-choice">
              <button
                type="button"
                className={`chain-card ${!isMainnet ? "selected" : ""}`}
                onClick={() => setChainId(TESTNET)}
              >
                <span className="chain-card-title">🌲 testnet · practice</span>
                <span className="chain-card-body">
                  free funds from the faucet, the same pipeline end to end. Venues are absent here,
                  so swaps simulate and no-route — the sandbox.
                </span>
              </button>
              <button
                type="button"
                className={`chain-card danger ${isMainnet ? "selected" : ""}`}
                onClick={() => setChainId(MAINNET)}
              >
                <span className="chain-card-title">⚔️ mainnet · real funds</span>
                <span className="chain-card-body">
                  the real Robinhood Chain — real USDG, real stock tokens, real execution. This is
                  where the band actually trades.
                </span>
              </button>
            </div>

            {isMainnet && (
              <div className="mainnet-warning">
                <b>This is real money.</b> Your owner &amp; session keys are generated and stored in
                plain text on <b>this machine</b> (~/.merrymen and this browser) — anyone with
                access to it controls the funds. There is no recovery service and no undo. Your
                caps below are the seatbelt: start small, raise them as trust grows.
                <label className="ack-row" style={{ marginTop: 10 }}>
                  <input
                    type="checkbox"
                    checked={mainnetAck}
                    onChange={(e) => setMainnetAck(e.target.checked)}
                  />
                  <span>
                    I understand — real funds, keys stored locally in plain text, and my caps are my
                    protection.
                  </span>
                </label>
              </div>
            )}

            <div className="grant-fields">
              <label className="field">
                <span className="field-label">max per trade</span>
                <span className="field-input">
                  <input type="number" min={1} value={caps.perTradeUsdg} onChange={set("perTradeUsdg")} />
                  <span className="field-unit">USDG</span>
                </span>
              </label>
              <label className="field">
                <span className="field-label">max per day</span>
                <span className="field-input">
                  <input type="number" min={1} value={caps.dailyUsdg} onChange={set("dailyUsdg")} />
                  <span className="field-unit">USDG</span>
                </span>
              </label>
              <label className="field">
                <span className="field-label">key expires in</span>
                <span className="field-input">
                  <input type="number" min={1} max={90} value={caps.expiryDays} onChange={set("expiryDays")} />
                  <span className="field-unit">days</span>
                </span>
              </label>
              <label className="field">
                <span className="field-label">max ops per day</span>
                <span className="field-input">
                  <input type="number" min={1} value={caps.maxOpsPerDay} onChange={set("maxOpsPerDay")} />
                  <span className="field-unit">ops</span>
                </span>
              </label>
              <label className="field">
                <span className="field-label">drawdown breaker</span>
                <span className="field-input">
                  <input type="number" min={1} max={50} value={caps.maxDrawdownPct} onChange={set("maxDrawdownPct")} />
                  <span className="field-unit">%</span>
                </span>
              </label>
            </div>

            <div className="grant-summary mono">
              on {chainLabel(chainId)} — this key may ONLY: approve USDG to Rialto router / Morpho
              vault (≤ {caps.perTradeUsdg} USDG) · call the Rialto router · deposit ≤{" "}
              {caps.dailyUsdg} USDG to the vault · withdraw from the vault · ≤ {caps.maxOpsPerDay}{" "}
              ops/day · dead in {caps.expiryDays}d regardless
            </div>

            <button className="grant-btn" onClick={onCreate} disabled={status !== null || createBlocked}>
              {status ??
                (createBlocked
                  ? "acknowledge the real-funds warning above first"
                  : `create wallet on ${isMainnet ? "mainnet" : "testnet"} & raise the wall`)}
            </button>
            {error && <div className="grant-error mono">{error}</div>}

            <div className="grant-note">
              the owner &amp; session keys are generated in your browser so you can back them up and
              inspect the flow — production owner keys will live in a TEE and never leave it.
            </div>
          </div>
        )}

        {/* ─── phase 2: back up the owner key (gated) ──────────────────── */}
        {grant && !backedUp && (
          <div className="grant-panel">
            <h1 className="grant-title">back up your owner key</h1>
            <p className="grant-sub">
              This key controls the account and <b>every dollar you fund it with</b>. It lives only
              in this browser. Save it somewhere safe now — if you lose it, the funds are gone. We
              can&apos;t recover it for you.
            </p>

            <div className="key-box mono">
              <div className="key-row">
                <span className="rk">owner key</span>
                <span className="rv" style={{ wordBreak: "break-all" }}>
                  {reveal ? grant.demoOwnerPrivateKey ?? "(external wallet — no key stored)" : "•".repeat(40)}
                </span>
              </div>
              <div className="key-actions">
                <button className="copy-btn" onClick={() => setReveal((r) => !r)}>
                  {reveal ? "hide" : "reveal"}
                </button>
                {grant.demoOwnerPrivateKey && (
                  <CopyBtn value={grant.demoOwnerPrivateKey} label="copy key" />
                )}
              </div>
            </div>

            <label className="ack-row">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              <span>I&apos;ve saved my owner key somewhere safe. I understand losing it means losing the funds.</span>
            </label>

            <button className="grant-btn" onClick={confirmBackup} disabled={!ack}>
              I&apos;ve backed it up — fund the account
            </button>

            <div className="grant-note">
              your account: <span className="mono">{short(grant.smartAccount)}</span> · session key
              (worker-only, capped): <span className="mono">{short(grant.sessionKeyAddress)}</span>
            </div>
          </div>
        )}

        {/* ─── phase 3: fund the account ───────────────────────────────── */}
        {grant && backedUp && (
          <div className="grant-panel">
            <h1 className="grant-title">fund your account</h1>
            <p className="grant-sub">
              {grantIsTestnet ? (
                <>
                  Send testnet gas and USDG to the account address below. Nothing deploys until the
                  first trade — funding is what lets that first UserOp land.
                </>
              ) : (
                <>
                  Send <b>ETH (for gas)</b> and <b>USDG (trading capital)</b> on Robinhood Chain
                  (4663) to the account address below. <b>Real funds</b> — double-check the address
                  and start with a small test amount first.
                </>
              )}
            </p>

            <div className="fund-addr mono">
              <span className="rk">account address · {chainLabel(grant.chainId)}</span>
              <span className="rv" style={{ wordBreak: "break-all" }}>{grant.smartAccount}</span>
              <CopyBtn value={grant.smartAccount} label="copy address" />
            </div>

            <div className="fund-balances">
              <div className={`fund-bal ${gasFunded ? "ok" : ""}`}>
                <span className="fund-bal-k">native gas</span>
                <span className="fund-bal-v mono">
                  {funding ? (Number(funding.gasWei) / 1e18).toFixed(5) : "…"}
                </span>
                <span className="fund-bal-s">{gasFunded ? "funded ✓" : "needed to deploy + trade"}</span>
              </div>
              <div className={`fund-bal ${usdgFunded ? "ok" : ""}`}>
                <span className="fund-bal-k">USDG</span>
                <span className="fund-bal-v mono">{funding ? funding.usdg.toFixed(2) : "…"}</span>
                <span className="fund-bal-s">{usdgFunded ? "funded ✓" : "the agent's trading capital"}</span>
              </div>
            </div>

            <div className="fund-actions">
              {grantIsTestnet ? (
                <a className="grant-btn" href={FAUCET_URL} target="_blank" rel="noreferrer" style={{ textAlign: "center", textDecoration: "none" }}>
                  open the gas faucet ↗
                </a>
              ) : (
                <a
                  className="grant-btn"
                  href={`${explorerFor(grant.chainId)}/address/${grant.smartAccount}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{ textAlign: "center", textDecoration: "none" }}
                >
                  view on explorer ↗
                </a>
              )}
              <button className="copy-btn" onClick={() => grant && refreshFunding(grant.smartAccount, grant.chainId)}>
                refresh balances
              </button>
            </div>

            {gasFunded ? (
              <div className="fund-ready mono">
                funded — run <b>merrymen start</b> and your band rides. balances refresh here every
                few seconds.
              </div>
            ) : (
              <div className="grant-note">
                waiting for the first deposit to land… this panel updates automatically.
                {!grantIsTestnet && " (no faucet on mainnet — send from your own wallet or exchange)"}
              </div>
            )}

            <div className="grant-result mono" style={{ marginTop: 18 }}>
              <div>
                <span className="rk">chain</span>
                <span className="rv">{chainLabel(grant.chainId)}</span>
              </div>
              <div>
                <span className="rk">owner</span>
                <span className="rv">{short(grant.owner)}</span>
              </div>
              <div>
                <span className="rk">session key</span>
                <span className="rv">{short(grant.sessionKeyAddress)}</span>
              </div>
              <div>
                <span className="rk">expires</span>
                <span className="rv">{new Date(grant.expiresAt * 1000).toLocaleString()}</span>
              </div>
            </div>

            <div className="caps" style={{ justifyContent: "center", marginTop: 14 }}>
              <span className="cap">max <b>{grant.caps.perTradeUsdg} USDG</b>/trade</span>
              <span className="cap"><b>{grant.caps.dailyUsdg} USDG</b>/day</span>
              <span className="cap"><b>{grant.caps.maxOpsPerDay}</b> ops/day</span>
              <span className="cap">breaker <b>{grant.caps.maxDrawdownPct}%</b></span>
            </div>

            <div className="grant-actions">
              <Link href="/" className="grant-btn" style={{ textAlign: "center", textDecoration: "none" }}>
                back to the band
              </Link>
              <button className="btn-kill" style={{ padding: "10px 16px" }} onClick={discard}>
                discard &amp; start over
              </button>
            </div>
          </div>
        )}
      </main>
    </>
  );
}
