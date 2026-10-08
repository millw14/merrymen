"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { EXPLORER } from "../../lib/chain";
import {
  TOKEN, amountToSend, balanceOfCalldata, checkWallet, endMessage, formatDate, formatDateTime, formatTokens, group, historyLabel, normalizeAccount,
  normalizePreview, payWithWallet, paymentsReady, previewSentence, priceLabel, short, switchToRobinhood, txHash, waitingMessage, walletError, watchPayment,
  type AccountView, type Eip1193, type PayCheck, type PlanPreview, type PlansView,
} from "../../lib/developer-billing";
import { request, requestRaw } from "./developer-client";

/**
 * What the console knows about the signed-in wallet's developer account.
 * `unsupported` is a gateway without accounts yet (its GET /account is a plain
 * 404): keys then work exactly as before, so the site can ship first.
 */
export type AccountState =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "unsupported" }
  | { kind: "error"; message: string }
  | { kind: "ready"; view: AccountView };

/** GET /account, read into the state above. Throws only for an ended session, which the console handles. */
export async function loadAccount(): Promise<AccountState> {
  try {
    const view = normalizeAccount(await request("account"));
    return view ? { kind: "ready", view } : { kind: "error", message: "Your account details could not be read. Try again shortly." };
  } catch (e) {
    const err = e as { status?: number; code?: string; message?: string };
    if (err.code === "signed_out") throw e;
    if (err.code === "account_missing") return { kind: "missing" };
    if (err.status === 404) return { kind: "unsupported" };
    return { kind: "error", message: err.message || "Your account details could not be loaded." };
  }
}

type Key = { key_id: string; name: string; status: string };
type Run = (task: string, fn: () => Promise<void>) => Promise<void>;
const ethereum = () => typeof window === "undefined" ? undefined : (window as Window & { ethereum?: Eip1193 }).ethereum;

/* ── A payment the page is waiting on, kept through a reload or a sign-out ── */

const PENDING = "mm_developer_pending_payment";
/** Browser storage is a convenience here: the gateway holds nothing until the hash is submitted, so losing this only means pasting it again. */
function rememberPayment(wallet: string, hash: string) { try { localStorage.setItem(PENDING, JSON.stringify({ wallet, hash, at: Date.now() })); } catch { /* Private mode: the hash is still on screen. */ } }
function forgetPayment() { try { localStorage.removeItem(PENDING); } catch { /* As above. */ } }
function pendingPayment(wallet: string): string | null {
  try {
    const saved = JSON.parse(localStorage.getItem(PENDING) || "null") as { wallet?: string; hash?: string; at?: number } | null;
    return saved?.wallet === wallet && typeof saved.at === "number" && Date.now() - saved.at < 86_400_000 ? txHash(saved.hash) : null;
  } catch { return null; }
}

type Watch = { hash: string; round: number; phase: "checking" | "credited" | "failed" | "stalled"; message: string };

/**
 * Account, plan and payment, for a signed-in wallet. Every write goes through
 * the gateway, which re-checks everything; this panel only asks and shows.
 */
export function AccountPanel({ address, plans, state, keys, busy, run, defaultName, onAccount, reload, onSignedOut }: {
  address: string; plans: PlansView; state: AccountState; keys: Key[]; busy: string; run: Run; defaultName: string;
  onAccount: (view: AccountView) => void; reload: () => Promise<void>; onSignedOut: () => void;
}) {
  const [name, setName] = useState(defaultName);
  const [watch, setWatch] = useState<Watch | null>(null);
  useEffect(() => { setName(defaultName); }, [defaultName]);
  const ready = state.kind === "ready";
  // Resume a payment sent before a reload or a sign-in: it is credited only when its hash is submitted.
  useEffect(() => { if (!ready) return; const hash = pendingPayment(address); if (hash) setWatch(w => w ?? { hash, round: 0, phase: "checking", message: "" }); }, [ready, address]);
  const follow = useCallback((hash: string) => { rememberPayment(address, hash); setWatch(w => ({ hash, round: (w?.round ?? 0) + 1, phase: "checking", message: "" })); }, [address]);
  const callbacks = useRef({ onAccount, reload, onSignedOut });
  callbacks.current = { onAccount, reload, onSignedOut };
  useEffect(() => {
    if (!watch || watch.phase !== "checking") return;
    let cancelled = false, timer: ReturnType<typeof setTimeout> | undefined;
    const hash = watch.hash;
    void watchPayment(hash, {
      check: h => requestRaw("payments", { tx_hash: h }), wait: ms => new Promise(resolve => { timer = setTimeout(resolve, ms); }), cancelled: () => cancelled,
      onWaiting: outcome => setWatch(w => w && w.hash === hash ? { ...w, message: waitingMessage(outcome, plans.confirmations?.min_age_sec) } : w),
    }).then(async end => {
      if (end.kind === "cancelled") return;
      if (end.kind === "signed_out") { callbacks.current.onSignedOut(); return; }
      // Credited or refused, the hash has its answer; a stalled one stays saved to check again later.
      if (end.kind !== "stalled") forgetPayment();
      setWatch(w => w && w.hash === hash ? { ...w, phase: end.kind, message: endMessage(end, address) } : w);
      if (end.kind === "credited") { if (end.account) callbacks.current.onAccount(end.account); else await callbacks.current.reload().catch(() => {}); }
    });
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
    // A new hash or a "Check again" starts a fresh round; message updates do not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watch?.hash, watch?.round, watch?.phase === "checking"]);

  if (state.kind === "unsupported") return null;
  if (state.kind === "loading") return <div className="dev-billing" role="status">Loading your developer account…</div>;
  if (state.kind === "error") return <div className="dev-billing"><p className="dev-billing-note">{state.message}</p><button className="dev-secondary" disabled={!!busy} onClick={() => run("account", reload)}>Try again</button></div>;
  if (state.kind === "missing") return <form className="dev-billing dev-account-create" onSubmit={e => { e.preventDefault(); void run("account-create", async () => {
    try { await request("account", { name: name.trim() }); } catch (err) { if ((err as { code?: string }).code !== "account_exists") throw err; }
    await reload();
  }); }}>
    <div><h3>Create your developer account</h3><p>One account for this wallet. It holds your plan, usage and credit, and every key you create shares it. Creating it is free and sends no transaction.</p></div>
    <label>Account name<input required maxLength={48} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Prism Finance" /></label>
    <button className="dev-primary" disabled={!!busy || !name.trim()}>{busy === "account-create" ? "Creating…" : "Create account ↗"}</button>
  </form>;

  const view = state.view, on = plans.billing.mode !== "off";
  // A treasury is only ever taken from a live answer that passed paymentsReady: never from the static table.
  const due = amountToSend(view.due_raw), treasury = paymentsReady(plans) ? plans.treasury : null;
  return <div className="dev-billing">
    <AccountSummary view={view} plans={plans} keys={keys} />
    {on ? <PlanChooser view={view} plans={plans} busy={busy} run={run} onAccount={onAccount} reload={reload} />
      : <p className="dev-billing-note">Paid plans are coming soon. Your account is ready, and every key you create belongs to it.</p>}
    {due !== null && treasury !== null && <PaymentPanel wallet={address} amount={due} treasury={treasury} busy={busy} run={run} onSent={follow} />}
    {due !== null && on && treasury === null && <p className="dev-billing-note">Payments are not open yet, so nothing can be paid here. Nothing is lost: your selection waits.</p>}
    {watch && <PaymentStatus watch={watch} onRetry={() => setWatch(w => w && { ...w, round: w.round + 1, phase: "checking", message: "" })} onDismiss={() => { forgetPayment(); setWatch(null); }} />}
  </div>;
}

/* ── What the account has ─────────────────────────────────────────────────── */

export function AccountSummary({ view, plans, keys }: { view: AccountView; plans: PlansView; keys: Key[] }) {
  const { plan, usage } = view, credit = BigInt(view.credit_raw);
  const selected = plans.plans.find(p => p.id === plan.selected);
  const pct = usage && usage.limit > 0 ? Math.min(100, Math.round(usage.used / usage.limit * 100)) : 0;
  const keyName = (id: string) => keys.find(k => k.key_id === id)?.name ?? id;
  return <div className="dev-account-summary">
    <div className="dev-account-plan">
      <span>PLAN</span><strong>{plan.name}</strong>
      <small>{plan.id === "free" ? "No payment" : plan.ends_at ? `Until ${formatDate(plan.ends_at)}` : ""}{plan.renews_on_next_request ? " · renews on your next API request" : ""}</small>
      {selected && plan.selected !== plan.id && <small>Next: {selected.name}{view.due_raw ? " once it is paid" : plan.ends_at ? ` from ${formatDate(plan.ends_at)}` : ""}</small>}
    </div>
    <div className="dev-account-credit">
      <span>CREDIT</span><strong>{formatTokens(credit, { decimals: 2 })} <small>MERRYMEN</small></strong>
      {credit < 0n ? <small className="dev-warn">A reversed payment left a shortfall. Paid plans do not start or renew until it is covered.</small>
        : view.due_raw ? <small>Due: {formatTokens(view.due_raw, { decimals: 0, round: "up" })} MERRYMEN</small> : <small>Nothing due</small>}
    </div>
    {usage && plans.billing.mode !== "off" && <div className="dev-usage">
      <div className="dev-usage-head"><span>USAGE</span><span>{group(usage.used)} of {group(usage.limit)} requests{usage.resets_at ? ` · resets ${formatDate(usage.resets_at)}` : ""}</span></div>
      <div className="dev-meter" role="progressbar" aria-label="Requests used this period" aria-valuemin={0} aria-valuemax={usage.limit} aria-valuenow={Math.min(usage.used, usage.limit)}><i style={{ width: `${pct}%` }} /></div>
      {!plans.billing.enforced && <small>Counted, not yet enforced: requests past the limit still go through.</small>}
      {usage.by_key.length > 0 && <ul className="dev-usage-keys" aria-label="Requests by key">{usage.by_key.map(k => <li key={k.key_id}><span>{keyName(k.key_id)}</span><code>{group(k.used)}</code></li>)}</ul>}
    </div>}
    {view.history.length > 0 && <details className="dev-history"><summary>History ({view.history.length})</summary><ul>{[...view.history].reverse().map((h, i) => {
      const amount = BigInt(h.amount_raw), magnitude = amount < 0n ? -amount : amount;
      const sign = h.type === "payment" ? "+" : h.type === "adjustment" ? (amount < 0n ? "−" : "+") : magnitude === 0n ? "" : "−";
      return <li key={`${h.at}-${i}`}><time dateTime={h.at}>{formatDateTime(h.at)}</time><span>{historyLabel(h, plans.plans)}</span><code>{sign}{formatTokens(magnitude, { decimals: 2 })}</code>
        {h.tx_hash && <a href={`${EXPLORER}/tx/${h.tx_hash}`} target="_blank" rel="noreferrer" aria-label="View transaction on Blockscout">tx ↗</a>}</li>;
    })}</ul></details>}
  </div>;
}

/* ── Choosing a plan: preview first, then confirm ─────────────────────────── */

function PlanChooser({ view, plans, busy, run, onAccount, reload }: { view: AccountView; plans: PlansView; busy: string; run: Run; onAccount: (v: AccountView) => void; reload: () => Promise<void> }) {
  const [choice, setChoice] = useState(view.plan.selected);
  const [preview, setPreview] = useState<{ tier: string; preview: PlanPreview } | null>(null);
  const plan = plans.plans.find(p => p.id === choice);
  return <div className="dev-plan-choice">
    <fieldset disabled={!!busy}><legend>Choose a plan</legend>
      <div className="dev-plan-options">{plans.plans.map(p => <label key={p.id} className={choice === p.id ? "chosen" : ""}>
        <input type="radio" name="dev-plan" value={p.id} checked={choice === p.id} onChange={() => { setChoice(p.id); setPreview(null); }} />
        <strong>{p.name}</strong><span>{priceLabel(p)}</span><small>{group(p.requests)} requests · {p.rpm}/min{p.id === view.plan.id ? " · current" : p.id === view.plan.selected ? " · selected" : ""}</small>
      </label>)}</div>
    </fieldset>
    {!preview ? <button className="dev-secondary" disabled={!!busy || !plan || choice === view.plan.selected} onClick={() => run("plan-preview", async () => {
      const answer = normalizePreview(await request("plan", { tier: choice }));
      if (!answer) throw new Error("This plan change could not be previewed. Try again shortly.");
      setPreview({ tier: choice, preview: answer });
    })}>{busy === "plan-preview" ? "Checking…" : "Review change"}</button>
      : plan && <div className="dev-plan-preview" role="region" aria-label="Plan change preview">
        <p>{previewSentence(preview.preview, plan, view.plan.name)}</p>
        <div><button className="dev-primary" disabled={!!busy} onClick={() => run("plan-confirm", async () => {
          const next = normalizeAccount(await request("plan", { tier: preview.tier, confirm: true }));
          setPreview(null);
          if (next) onAccount(next); else await reload();
        })}>{busy === "plan-confirm" ? "Confirming…" : `Confirm ${plan.name}`}</button><button className="dev-textlink" disabled={!!busy} onClick={() => setPreview(null)}>Cancel</button></div>
      </div>}
  </div>;
}

/* ── Paying what is due ───────────────────────────────────────────────────── */

/**
 * The wallet button, drawn from a PayCheck alone so every refusal can be
 * shown (and tested) without a wallet: no button that could send from the
 * wrong account or network is ever drawn.
 */
export function WalletPay({ check, amount, busy, balance, onConnect, onSwitch, onPay }: {
  check: PayCheck | null; amount: bigint; busy: string; balance: bigint | null; onConnect: () => void; onSwitch: () => void; onPay: () => void;
}) {
  if (!check) return <p className="dev-pay-check" role="status">Checking your browser wallet…</p>;
  if (check.ok) return <div className="dev-pay-wallet">
    <button className="dev-primary" disabled={!!busy} onClick={onPay}>{busy === "pay" ? "Confirm in your wallet…" : `Pay ${formatTokens(amount, { decimals: 0 })} MERRYMEN with wallet ↗`}</button>
    {balance !== null && <small>This wallet holds {formatTokens(balance, { decimals: 2 })} MERRYMEN{balance >= amount ? `; after this payment it holds ${formatTokens(balance - amount, { decimals: 2 })}` : ", less than this payment"}.</small>}
  </div>;
  return <div className="dev-pay-wallet"><p className="dev-pay-check" role="status">{check.message}</p>
    {check.reason === "not_connected" && <button className="dev-secondary" disabled={!!busy} onClick={onConnect}>Connect wallet</button>}
    {check.reason === "wrong_chain" && <button className="dev-secondary" disabled={!!busy} onClick={onSwitch}>{busy === "switch" ? "Check your wallet…" : "Switch to Robinhood Chain"}</button>}
  </div>;
}

function PaymentPanel({ wallet, amount, treasury, busy, run, onSent }: { wallet: string; amount: bigint; treasury: string; busy: string; run: Run; onSent: (hash: string) => void }) {
  const [check, setCheck] = useState<PayCheck | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [paste, setPaste] = useState("");
  const [copied, setCopied] = useState("");
  const recheck = useCallback(async () => {
    const provider = ethereum();
    const next = await checkWallet(provider, wallet).catch((): PayCheck => ({ ok: false, reason: "not_connected", message: `Connect ${short(wallet)} in your wallet to pay from this page.` }));
    setCheck(next);
    setBalance(null);
    if (next.ok && provider) {
      try {
        const answer = await provider.request({ method: "eth_call", params: [{ to: TOKEN.address, data: balanceOfCalldata(wallet) }, "latest"] });
        if (typeof answer === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(answer)) setBalance(BigInt(answer));
      } catch { /* Shown only when known. */ }
    }
  }, [wallet]);
  useEffect(() => {
    void recheck();
    const provider = ethereum(), changed = () => { void recheck(); };
    provider?.on?.("accountsChanged", changed); provider?.on?.("chainChanged", changed);
    return () => { provider?.removeListener?.("accountsChanged", changed); provider?.removeListener?.("chainChanged", changed); };
  }, [recheck]);
  const copy = async (what: string, text: string) => { try { await navigator.clipboard.writeText(text); setCopied(what); setTimeout(() => setCopied(""), 1500); } catch { /* Selectable inline. */ } };
  const tokens = formatTokens(amount, { decimals: 0 });
  return <div className="dev-pay" aria-labelledby="dev-pay-title">
    <h3 id="dev-pay-title">Pay {tokens} MERRYMEN</h3>
    <dl className="dev-pay-details">
      <div><dt>Amount</dt><dd><code>{tokens} MERRYMEN</code><button type="button" onClick={() => copy("amount", (amount / 10n ** 18n).toString())}>{copied === "amount" ? "Copied ✓" : "Copy"}</button></dd></div>
      <div><dt>To (Merrymen payments wallet)</dt><dd><code>{treasury}</code><button type="button" onClick={() => copy("treasury", treasury)}>{copied === "treasury" ? "Copied ✓" : "Copy"}</button><a href={`${EXPLORER}/address/${treasury}`} target="_blank" rel="noreferrer">Blockscout ↗</a></dd></div>
      <div><dt>Token</dt><dd><code>{TOKEN.address}</code><a href={`${EXPLORER}/token/${TOKEN.address}`} target="_blank" rel="noreferrer">$MERRYMEN ↗</a></dd></div>
      <div><dt>Network</dt><dd>Robinhood Chain (chain ID 4663)</dd></div>
      <div><dt>From</dt><dd><code>{wallet}</code> <small>(the wallet you signed in with)</small></dd></div>
    </dl>
    <p className="dev-warn">Send only from {short(wallet)}. A transfer from any other wallet, an exchange, a smart account or a swap cannot be credited to this account, and payments are not returned.</p>
    <WalletPay check={check} amount={amount} busy={busy} balance={balance}
      onConnect={() => run("connect-pay", async () => { const provider = ethereum(); if (provider) { try { await provider.request({ method: "eth_requestAccounts" }); } catch (e) { throw new Error(walletError(e)); } } await recheck(); })}
      onSwitch={() => run("switch", async () => { const provider = ethereum(); if (provider) { try { await switchToRobinhood(provider); } catch (e) { throw new Error(walletError(e)); } } await recheck(); })}
      onPay={() => run("pay", async () => {
        const provider = ethereum();
        if (!provider) { await recheck(); return; }
        let hash: string;
        try { hash = await payWithWallet({ provider, wallet, treasury, amount }); } catch (e) { await recheck(); throw new Error(walletError(e)); }
        onSent(hash);
      })} />
    <form className="dev-pay-paste" onSubmit={e => { e.preventDefault(); const hash = txHash(paste); if (hash) { onSent(hash); setPaste(""); } }}>
      <label>Already sent? Paste the transaction hash.<input value={paste} onChange={e => setPaste(e.target.value)} placeholder="0x…" pattern="\s*0x[0-9a-fA-F]{64}\s*" autoComplete="off" spellCheck={false} /></label>
      <button className="dev-secondary" disabled={!!busy || !txHash(paste)}>Check payment</button>
    </form>
    <p className="dev-small-print">Paying moves MERRYMEN out of your wallet. Merry Circle tiers and hosted energy follow the balance you hold.</p>
  </div>;
}

function PaymentStatus({ watch, onRetry, onDismiss }: { watch: Watch; onRetry: () => void; onDismiss: () => void }) {
  const tone = watch.phase === "credited" ? "ok" : watch.phase === "failed" ? "bad" : "wait";
  return <div className={`dev-pay-status ${tone}`} role={watch.phase === "failed" ? "alert" : "status"}>
    <p><strong>{watch.phase === "credited" ? "Credited" : watch.phase === "failed" ? "Not credited" : watch.phase === "stalled" ? "Still waiting" : "Checking payment"}</strong> {watch.message || "Checking your payment…"}</p>
    <p><a href={`${EXPLORER}/tx/${watch.hash}`} target="_blank" rel="noreferrer"><code>{short(watch.hash)}</code> on Blockscout ↗</a>
      {watch.phase === "stalled" && <button className="dev-textlink" onClick={onRetry}>Check again</button>}
      {watch.phase !== "checking" && <button className="dev-textlink" onClick={onDismiss}>Dismiss</button>}</p>
  </div>;
}
