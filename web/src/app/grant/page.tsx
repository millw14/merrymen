"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Info } from "@/components/Info";
import { LogoMark } from "@/components/Logo";
import { explorerFor, robinhoodChain, robinhoodTestnet } from "@merrymen/core";
import {
  clearGrant,
  createAgentWallet,
  FAUCET_URL,
  loadGrant,
  previewOwnerAccount,
  readFunding,
  restoreAgentWallet,
  type Funding,
  type Grant,
  type GrantCaps,
  type OwnerPreview,
} from "@/lib/session";

const DEFAULTS: GrantCaps = {
  perTradeUsdg: 50,
  dailyUsdg: 500,
  expiryDays: 14,
  maxDrawdownPct: 10,
  maxOpsPerDay: 48,
};

/** One-click cap presets — pick a temperament, tweak if you like, ride. */
const PRESETS: { id: string; label: string; blurb: string; caps: GrantCaps }[] = [
  {
    id: "scout",
    label: "🌱 cautious · the scout",
    blurb: "dip a toe — tiny trades, tight leash",
    caps: { perTradeUsdg: 10, dailyUsdg: 50, expiryDays: 7, maxDrawdownPct: 5, maxOpsPerDay: 24 },
  },
  {
    id: "outlaw",
    label: "🏹 balanced · the outlaw",
    blurb: "the sensible default",
    caps: DEFAULTS,
  },
  {
    id: "warlord",
    label: "⚔️ bold · the warlord",
    blurb: "bigger arrows, wider walls",
    caps: { perTradeUsdg: 200, dailyUsdg: 2000, expiryDays: 30, maxDrawdownPct: 15, maxOpsPerDay: 96 },
  },
];

const sameCaps = (a: GrantCaps, b: GrantCaps) =>
  (Object.keys(a) as (keyof GrantCaps)[]).every((k) => a[k] === b[k]);

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
  // Whether the SERVER still holds this grant (grant.json). null = still checking.
  // The browser copy and the server file can desync — a kill switch or CLI kill
  // deletes the server file but not this localStorage — so the dashboard shows
  // "no merryman" while this page would happily show a wallet the worker ignores.
  const [serverArmed, setServerArmed] = useState<boolean | null>(null);
  const [reArming, setReArming] = useState(false);
  // ── restore: bring an already-funded wallet back with its owner key ──────
  const [mode, setMode] = useState<"create" | "restore">("create");
  const [restoreKey, setRestoreKey] = useState("");
  const [preview, setPreview] = useState<OwnerPreview | null>(null);
  const [previewFunding, setPreviewFunding] = useState<Funding | null>(null);
  const [previewing, setPreviewing] = useState(false);
  // Swapping the ACTIVE wallet for another one you own. Without this you'd have
  // to "discard" a funded wallet just to reach the restore tab — the exact scary
  // click that strands people. Switching archives the outgoing wallet instead.
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    setGrant(loadGrant());
    setBackedUp(localStorage.getItem(BACKUP_KEY) === "1");
    fetch("/api/grants")
      .then((r) => (r.ok ? r.json() : { exists: false }))
      .then((s: { exists?: boolean }) => setServerArmed(!!s.exists))
      .catch(() => setServerArmed(null));
  }, []);

  /** Re-push the stored grant so the worker obeys it again (undo a desync). */
  async function reArm() {
    const g = loadGrant();
    if (!g) return;
    setReArming(true);
    try {
      const r = await fetch("/api/grants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(g),
      });
      if (r.ok) setServerArmed(true);
    } catch {
      /* leave the banner up; the button re-enables */
    }
    setReArming(false);
  }

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

  /** Which account does this owner key control, and what's in it? Read-only. */
  async function checkOwnerKey() {
    setError(null);
    setPreview(null);
    setPreviewFunding(null);
    const key = restoreKey.trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
      setError("that isn't an owner key — expected 0x followed by 64 hex characters.");
      return;
    }
    setPreviewing(true);
    try {
      const p = await previewOwnerAccount(key as `0x${string}`, chainId);
      setPreview(p);
      setPreviewFunding(await readFunding(p.smartAccount, chainId).catch(() => null));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setPreviewing(false);
  }

  /** Re-arm the funded account with a fresh session key under the caps above. */
  async function onRestore() {
    setError(null);
    setStatus("starting…");
    try {
      const g = await restoreAgentWallet(restoreKey.trim() as `0x${string}`, caps, setStatus, chainId);
      // They just pasted the owner key, so it's demonstrably backed up — skip the
      // backup gate and drop them straight into the funded/manage view.
      localStorage.setItem(BACKUP_KEY, "1");
      setBackedUp(true);
      setGrant(g);
      setRestoreKey("");
      setPreview(null);
      setSwitching(false); // the restored wallet IS the active one now
      setServerArmed(true);
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
    // Discarding forgets THIS wallet's keys from the browser. If it still holds
    // funds, those funds don't move — they stay in the smart account, reachable
    // only with the owner key. Make the user acknowledge that before they can
    // strand money by starting over (exactly the trap that loses funded wallets).
    if ((funding?.usdgUnits ?? 0n) > 0n) {
      const amt = funding ? funding.usdg.toFixed(2) : "some";
      const okToDrop = window.confirm(
        `This wallet still holds ${amt} USDG.\n\n` +
          `Discarding it here does NOT move the funds — they stay in the smart account and can ` +
          `only be reached with THIS wallet's owner key. Back that key up first, or sweep the ` +
          `funds out now by running:  merrymen recover\n\n` +
          `Discard anyway?`,
      );
      if (!okToDrop) return;
    }
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
  // This browser thinks it has a wallet, but the server/worker no longer holds
  // its grant — the wallet is inert until re-armed (or should be discarded).
  const desynced = grant !== null && serverArmed === false;

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
        {/* ─── desync banner: browser has a wallet the server no longer holds ── */}
        {desynced && (
          <div className="grant-panel desync-panel">
            <h1 className="grant-title">this wallet isn&apos;t active</h1>
            <p className="grant-sub">
              Your browser still has this wallet, but the worker no longer holds its grant — so the
              dashboard shows no merryman and it won&apos;t trade. This happens after a{" "}
              <b>kill switch</b> or a <code>merrymen kill</code>. Re-arm it to make the band obey it
              again, or discard it and start fresh.
            </p>
            <div className="fund-addr mono">
              <span className="rk">account · {chainLabel(grant!.chainId)}</span>
              <span className="rv" style={{ wordBreak: "break-all" }}>{grant!.smartAccount}</span>
            </div>
            <div className="fund-actions" style={{ display: "flex", gap: 10 }}>
              <button className="grant-btn" onClick={() => void reArm()} disabled={reArming} style={{ flex: 1 }}>
                {reArming ? "re-arming…" : "re-arm this wallet"}
              </button>
              <button className="btn-kill" onClick={discard} style={{ flex: 1 }}>
                discard &amp; start fresh
              </button>
            </div>
          </div>
        )}

        {/* ─── phase 1: pick a chain, set caps, create the wallet ────────── */}
        {(!grant || switching) && (
          <div className="grant-panel">
            {switching && grant && (
              <div className="switch-note">
                You&apos;re running <span className="mono">{short(grant.smartAccount)}</span> right
                now. Restoring another wallet makes <b>that</b> one the active agent instead — your
                current wallet is <b>archived on this machine with its owner key</b>, so nothing is
                lost and you can switch back or sweep it anytime.
                <button
                  className="copy-btn"
                  style={{ marginTop: 10 }}
                  onClick={() => {
                    setSwitching(false);
                    setError(null);
                    setPreview(null);
                    setRestoreKey("");
                  }}
                >
                  ← never mind, keep {short(grant.smartAccount)}
                </button>
              </div>
            )}
            <div className="mode-tabs">
              <button
                type="button"
                className={`mode-tab ${mode === "create" ? "on" : ""}`}
                onClick={() => {
                  setMode("create");
                  setError(null);
                }}
              >
                new wallet
              </button>
              <button
                type="button"
                className={`mode-tab ${mode === "restore" ? "on" : ""}`}
                onClick={() => {
                  setMode("restore");
                  setError(null);
                }}
              >
                restore a funded wallet
              </button>
            </div>

            <h1 className="grant-title">
              {mode === "create" ? "Create your agent's wallet" : "Restore your funded wallet"}
            </h1>
            <p className="grant-sub">
              {mode === "create" ? (
                <>
                  No wallet to connect. merrymen makes a fresh wallet and gives <b>you</b> the key.
                  You set the spending limits below — and the blockchain itself{" "}
                  <Info>These aren&apos;t honor-system limits. The account contract on the chain rejects any trade over your caps, so even a hacked agent can&apos;t break them.</Info>{" "}
                  enforces them, so your agent can never spend more than you allow.
                </>
              ) : (
                <>
                  Already funded a merrymen wallet? Paste its <b>owner key</b> and the very same
                  account comes back{" "}
                  <Info>Your smart-account address is derived from the owner key, so the same key always reproduces the same account — with the funds still in it. Restoring signs a fresh session key; it moves nothing on-chain.</Info>{" "}
                  — same address, same funds — armed with a fresh session key under the caps you set
                  below. This is the way back in after a kill switch or a new machine.
                </>
              )}
            </p>

            <div className="chain-choice">
              <button
                type="button"
                className={`chain-card ${!isMainnet ? "selected" : ""}`}
                onClick={() => setChainId(TESTNET)}
              >
                <span className="chain-card-title">🌲 Practice (testnet)</span>
                <span className="chain-card-body">
                  Free play money, same exact flow. Best place to start and learn how it works.
                </span>
              </button>
              <button
                type="button"
                className={`chain-card danger ${isMainnet ? "selected" : ""}`}
                onClick={() => setChainId(MAINNET)}
              >
                <span className="chain-card-title">⚔️ Real money (mainnet)</span>
                <span className="chain-card-body">
                  The real Robinhood Chain — real funds, real trades. Only when you&apos;re ready.
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

            {mode === "restore" && (
              <div className="restore-box">
                <span className="field-label">your wallet&apos;s owner key</span>
                <input
                  className="restore-input mono"
                  type="password"
                  placeholder="0x… (the key you backed up when you created it)"
                  value={restoreKey}
                  onChange={(e) => setRestoreKey(e.target.value)}
                  autoComplete="off"
                />
                <button className="copy-btn" onClick={() => void checkOwnerKey()} disabled={previewing}>
                  {previewing ? "checking…" : "check this wallet"}
                </button>

                {preview && (
                  <div className="restore-preview mono">
                    <div>
                      <span className="rk">this key controls</span>
                      <span className="rv" style={{ wordBreak: "break-all" }}>{preview.smartAccount}</span>
                    </div>
                    <div>
                      <span className="rk">which holds</span>
                      <span className="rv">
                        {previewFunding
                          ? `${previewFunding.usdg.toFixed(2)} USDG · ${(Number(previewFunding.gasWei) / 1e18).toFixed(5)} ETH`
                          : "…"}
                      </span>
                    </div>
                    <div className="restore-confirm">
                      {previewFunding && previewFunding.usdg > 0
                        ? "✓ Funds found — restore it below and your band rides again."
                        : "This account is empty on this chain. Check the chain selector, or try your other owner key."}
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="preset-row">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`preset-card ${sameCaps(caps, p.caps) ? "selected" : ""}`}
                  onClick={() => setCaps(p.caps)}
                >
                  <span className="preset-label">{p.label}</span>
                  <span className="preset-blurb">{p.blurb}</span>
                  <span className="preset-caps mono">
                    {p.caps.perTradeUsdg}/trade · {p.caps.dailyUsdg}/day · {p.caps.maxDrawdownPct}% breaker ·{" "}
                    {p.caps.expiryDays}d key
                  </span>
                </button>
              ))}
            </div>

            <p className="field-lead">Pick a preset above, or fine-tune the limits:</p>
            <div className="grant-fields">
              <label className="field">
                <span className="field-label">most it can spend on one trade</span>
                <span className="field-input">
                  <input type="number" min={1} value={caps.perTradeUsdg} onChange={set("perTradeUsdg")} />
                  <span className="field-unit">USDG</span>
                </span>
              </label>
              <label className="field">
                <span className="field-label">most it can spend in a day</span>
                <span className="field-input">
                  <input type="number" min={1} value={caps.dailyUsdg} onChange={set("dailyUsdg")} />
                  <span className="field-unit">USDG</span>
                </span>
              </label>
              <label className="field">
                <span className="field-label">
                  auto-expire the agent after{" "}
                  <Info>A safety timer. After this many days the agent&apos;s key stops working on its own — so a forgotten agent can&apos;t trade forever.</Info>
                </span>
                <span className="field-input">
                  <input type="number" min={1} max={90} value={caps.expiryDays} onChange={set("expiryDays")} />
                  <span className="field-unit">days</span>
                </span>
              </label>
              <label className="field">
                <span className="field-label">most trades per day</span>
                <span className="field-input">
                  <input type="number" min={1} value={caps.maxOpsPerDay} onChange={set("maxOpsPerDay")} />
                  <span className="field-unit">trades</span>
                </span>
              </label>
              <label className="field">
                <span className="field-label">
                  stop if it&apos;s down by{" "}
                  <Info>A circuit breaker. If the account drops this far from its best value, the agent stops trading automatically to stem the bleeding.</Info>
                </span>
                <span className="field-input">
                  <input type="number" min={1} max={50} value={caps.maxDrawdownPct} onChange={set("maxDrawdownPct")} />
                  <span className="field-unit">%</span>
                </span>
              </label>
            </div>

            <div className="grant-summary">
              <b>In plain English:</b> on {isMainnet ? "real money" : "practice"}, this agent can trade
              at most <b>{caps.perTradeUsdg} USDG</b> per trade, <b>{caps.dailyUsdg} USDG</b> per day,
              and <b>{caps.maxOpsPerDay}</b> trades per day. It stops itself if it&apos;s down{" "}
              <b>{caps.maxDrawdownPct}%</b>, and its key auto-expires in <b>{caps.expiryDays} days</b>.
              These limits are enforced by the blockchain — the agent literally cannot exceed them.
            </div>

            {mode === "create" ? (
              <button className="grant-btn" onClick={onCreate} disabled={status !== null || createBlocked}>
                {status ??
                  (createBlocked
                    ? "acknowledge the real-funds warning above first"
                    : `Create my agent (${isMainnet ? "real money" : "practice"})`)}
              </button>
            ) : (
              <button
                className="grant-btn"
                onClick={() => void onRestore()}
                disabled={status !== null || createBlocked || !preview}
              >
                {status ??
                  (createBlocked
                    ? "acknowledge the real-funds warning above first"
                    : !preview
                      ? "check your owner key above first"
                      : `Restore & arm ${short(preview.smartAccount)}`)}
              </button>
            )}
            {error && <div className="grant-error mono">{error}</div>}

            <div className="grant-note">
              {mode === "create"
                ? "The keys are made right here in your browser so you can save them yourself — nobody else ever sees them."
                : "Your owner key never leaves this browser — it's used to re-derive your account and sign the new session key locally. Restoring moves no funds and costs no gas."}
            </div>
          </div>
        )}

        {/* ─── phase 2: back up the owner key (gated) ──────────────────── */}
        {grant && !backedUp && !desynced && !switching && (
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
              <br />
              This key controls the account, but its <i>own</i> address (
              <span className="mono">{short(grant.owner)}</span>) is different — that&apos;s the
              address MetaMask shows if you import the key. You fund and recover the{" "}
              <b>account</b> address, not the key&apos;s address.
            </div>
          </div>
        )}

        {/* ─── phase 3: fund the account ───────────────────────────────── */}
        {grant && backedUp && !desynced && !switching && (
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

            <div className="paper-note mono" style={{ marginBottom: 14 }}>
              📜 <b>Already riding.</b> Your band is trading in <b>paper mode</b> right now — real
              live prices, simulated fills — so you can watch it work before funding anything. Head
              to the <Link href="/">dashboard</Link> to see it. Fund the account below only when
              you&apos;re ready for live trades.
            </div>

            <div className="fund-addr mono">
              <span className="rk">account address · {chainLabel(grant.chainId)}</span>
              <span className="rv" style={{ wordBreak: "break-all" }}>{grant.smartAccount}</span>
              <CopyBtn value={grant.smartAccount} label="copy address" />
            </div>

            <div className="grant-note" style={{ marginTop: 12 }}>
              <b>This is a smart-account address, not a MetaMask wallet.</b>{" "}
              <Info>An ERC-4337 smart account. Your owner key controls it, but the key&apos;s own address (what MetaMask derives when you import it) is different — so MetaMask shows an empty wallet, not this account. That&apos;s expected.</Info>{" "}
              Your owner key controls it, but that key&apos;s <i>own</i> address is different — import
              the key into MetaMask and you&apos;ll see an empty wallet, not these funds. To move the
              money out anytime — even after a kill switch — run{" "}
              <span className="mono">merrymen recover</span>, which sweeps the balance to any address
              you choose.
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
              <button
                className="copy-btn"
                style={{ padding: "10px 16px" }}
                onClick={() => {
                  setSwitching(true);
                  setMode("restore");
                  setError(null);
                }}
              >
                switch to another wallet
              </button>
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
