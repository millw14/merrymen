"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { EXPLORER } from "../../lib/chain";
import {
  TOKEN, amountToSend, balanceOfCalldata, checkWallet, endMessage, formatDate, formatDateTime, formatTokens, group, historyLabel, normalizeAccount,
  normalizePreview, payWithWallet, paymentsReady, previewSentence, priceLabel, short, stillPayable, switchToRobinhood, txHash, waitingMessage, walletError, watchPayment,
  type AccountView, type Eip1193, type PayCheck, type PlanPreview, type PlansView, type WatchEnd,
} from "../../lib/developer-billing";
import { MAX_PENDING, PENDING_KEY, forgetPayment, pendingPayments, rememberPayment } from "../../lib/pending-payments";
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

/* ── Payments the page is waiting on, kept through a reload or a sign-out ── */

/**
 * One submitted hash. `checking` and `stalled` are unanswered: the gateway has
 * said nothing final, holds nothing for it, and credits it only if the page
 * goes on submitting it. `credited` and `failed` are answered.
 */
type Watch = { hash: string; round: number; phase: "checking" | "credited" | "failed" | "stalled"; message: string };
const unanswered = (w: Watch) => w.phase === "checking" || w.phase === "stalled";
const checking = (hash: string, round = 0): Watch => ({ hash, round, phase: "checking", message: "" });

/**
 * Account, plan and payment, for a signed-in wallet. Every write goes through
 * the gateway, which re-checks everything; this panel only asks and shows.
 *
 * EVERY HASH IS WATCHED UNTIL IT IS ANSWERED. A second payment while one is
 * unanswered is a second transfer, and a hash the page stops submitting is
 * never credited, so: no wallet payment starts while any payment is
 * unanswered; a pasted hash joins the list, never replaces one; each is kept
 * in this browser (pending-payments.ts) until it is credited or refused, or
 * until the developer forgets it after a warning.
 */
export function AccountPanel({ address, plans, state, keys, busy, run, defaultName, onAccount, onPlans, reload, onSignedOut }: {
  address: string; plans: PlansView; state: AccountState; keys: Key[]; busy: string; run: Run; defaultName: string;
  onAccount: (view: AccountView) => void; onPlans: (plans: PlansView) => void; reload: () => Promise<void>; onSignedOut: () => void;
}) {
  const [name, setName] = useState(defaultName);
  const [watches, setWatches] = useState<Watch[]>([]);
  useEffect(() => { setName(defaultName); }, [defaultName]);
  const ready = state.kind === "ready";
  // The list as of the latest change, for the checks a click makes between renders.
  const current = useRef(watches);
  current.current = watches;
  const change = useCallback((next: (ws: Watch[]) => Watch[]) => { current.current = next(current.current); setWatches(next); }, []);
  /** Hashes saved in this browser (before a reload, a sign-in, or by another tab) that this page is not watching yet; they are added. */
  const adopt = useCallback(() => {
    const found = pendingPayments(address).filter(h => !current.current.some(w => w.hash === h));
    if (found.length) change(ws => [...ws, ...found.filter(h => !ws.some(w => w.hash === h)).map(h => checking(h))]);
    return found;
  }, [address, change]);
  useEffect(() => {
    if (!ready) return;
    adopt();
    // Another tab of this browser paid: check that payment here too, and hold back Pay.
    const saved = (e: StorageEvent) => { if (e.key === PENDING_KEY || e.key === null) adopt(); };
    window.addEventListener("storage", saved);
    return () => window.removeEventListener("storage", saved);
  }, [ready, adopt]);
  /**
   * Watch `hash` until it is answered. A hash the wallet just sent is always
   * kept; a pasted one is refused past MAX_PENDING unanswered, never swapped
   * for another.
   */
  const follow = useCallback((hash: string, sent: boolean) => {
    const known = current.current.find(w => w.hash === hash);
    if (known?.phase === "checking") return;
    if (!known && !sent && current.current.filter(unanswered).length >= MAX_PENDING) {
      throw new Error(`${MAX_PENDING} payments are already waiting to be checked. Wait for one to be answered, or forget one, before adding another.`);
    }
    rememberPayment(address, hash);
    change(ws => ws.some(w => w.hash === hash) ? ws.map(w => w.hash === hash ? checking(hash, w.round + 1) : w) : [...ws, checking(hash)]);
  }, [address, change]);
  const callbacks = useRef({ onAccount, reload, onSignedOut });
  callbacks.current = { onAccount, reload, onSignedOut };
  const onWaiting = useCallback((hash: string, message: string) => change(ws => ws.map(w => w.hash === hash && w.phase === "checking" ? { ...w, message } : w)), [change]);
  const onEnd = useCallback((hash: string, end: Exclude<WatchEnd, { kind: "cancelled" }>) => {
    // The session ended mid-check: the console signs out, and the hash stays saved for the next sign-in.
    if (end.kind === "signed_out") { callbacks.current.onSignedOut(); return; }
    // Credited or refused, the hash has its answer; a stalled one stays saved to check again.
    if (end.kind !== "stalled") forgetPayment(address, hash);
    change(ws => ws.map(w => w.hash === hash ? { ...w, phase: end.kind, message: endMessage(end, address) } : w));
    if (end.kind === "credited") { if (end.account) callbacks.current.onAccount(end.account); else void callbacks.current.reload().catch(() => {}); }
  }, [address, change]);
  // Several payments share the gateway's per-wallet budget for checks: each waits longer the more are checked at once.
  const spread = useRef(1);
  spread.current = Math.max(1, watches.filter(w => w.phase === "checking").length);
  /** What must still hold at the click, read now rather than trusted from when the panel was drawn. */
  const confirmPayable = useCallback(async (treasury: string) => {
    if (adopt().length) throw new Error("A payment from another tab of this browser is being checked below. Wait for it before paying again: paying now sends a second payment.");
    let answer: unknown = null;
    try { answer = await request("plans"); } catch { /* Unreadable: refused just below. */ }
    const fresh = stillPayable(answer, treasury);
    if (fresh.plans) onPlans(fresh.plans);
    if (!fresh.ok) throw new Error(fresh.message);
  }, [adopt, onPlans]);

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
  const open = watches.filter(unanswered);
  const waiting: Waiting = open.length === 0 ? null : { count: open.length, checking: open.some(w => w.phase === "checking") };
  return <div className="dev-billing">
    <AccountSummary view={view} plans={plans} keys={keys} />
    {plans.source === "fallback"
      // The account answered but the plans did not: whether billing is on is unknown here, so neither "coming soon" nor a plan list.
      ? <p className="dev-billing-note">Plan details could not be loaded just now. Reload the page to choose a plan or pay; nothing is lost meanwhile.</p>
      : on ? <PlanChooser view={view} plans={plans} busy={busy} run={run} onAccount={onAccount} reload={reload} />
        : <p className="dev-billing-note">Paid plans are coming soon. Your account is ready, and every key you create belongs to it.</p>}
    {due !== null && treasury !== null && <PaymentPanel wallet={address} amount={due} treasury={treasury} busy={busy} run={run} waiting={waiting}
      confirmPayable={confirmPayable} onSent={hash => follow(hash, true)} onPasted={hash => follow(hash, false)} />}
    {due !== null && on && treasury === null && <p className="dev-billing-note">Payments are not open yet, so nothing can be paid here. Nothing is lost: your selection waits.</p>}
    {watches.length > 0 && <div className="dev-pay-watches">{watches.map(w => <PaymentWatch key={w.hash} watch={w} spread={spread} minAgeSec={plans.confirmations?.min_age_sec}
      onWaiting={onWaiting} onEnd={onEnd}
      onRetry={() => { rememberPayment(address, w.hash); change(ws => ws.map(x => x.hash === w.hash ? checking(x.hash, x.round + 1) : x)); }}
      onForget={() => { forgetPayment(address, w.hash); change(ws => ws.filter(x => x.hash !== w.hash)); }}
      onDismiss={() => change(ws => ws.filter(x => x.hash !== w.hash))} />)}</div>}
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
    {view.history.length > 0 && <details className="dev-history"><summary>History ({view.history.length})</summary><ul>{view.history.map((h, i) => {
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
        <p>{previewSentence(preview.preview, plan, view.plan.name, plans.plans.find(p => p.id === view.plan.selected)?.name)}</p>
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

/** Unanswered payments, if any: then the panel offers no new payment, only a way to add a hash. */
type Waiting = { count: number; checking: boolean } | null;

function PaymentPanel({ wallet, amount, treasury, busy, run, waiting, confirmPayable, onSent, onPasted }: {
  wallet: string; amount: bigint; treasury: string; busy: string; run: Run; waiting: Waiting;
  confirmPayable: (treasury: string) => Promise<void>; onSent: (hash: string) => void; onPasted: (hash: string) => void;
}) {
  const [check, setCheck] = useState<PayCheck | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [pasted, setPasted] = useState("");
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
  const paste = <form className="dev-pay-paste" onSubmit={e => { e.preventDefault(); const hash = txHash(pasted); if (hash) void run("paste", async () => { onPasted(hash); setPasted(""); }); }}>
    <label>{waiting ? "Sped it up, or sent another transfer? Paste the transaction hash." : "Already sent? Paste the transaction hash."}<input value={pasted} onChange={e => setPasted(e.target.value)} placeholder="0x…" pattern="\s*0x[0-9a-fA-F]{64}\s*" autoComplete="off" spellCheck={false} /></label>
    <button className="dev-secondary" disabled={!!busy || !txHash(pasted)}>Check payment</button>
  </form>;
  // An unanswered payment holds back the next one: its transfer may still be on its way, and a second click is a second payment.
  if (waiting) return <section className="dev-pay" aria-labelledby="dev-pay-title">
    <h3 id="dev-pay-title">{waiting.checking ? "Checking your payment" : "Payment not credited yet"}</h3>
    <p className="dev-warn" role="status">{waiting.checking
      ? `${waiting.count === 1 ? "Your payment is" : `${waiting.count} payments are`} being checked below. Paying again sends a second payment, and payments are not returned: wait for ${waiting.count === 1 ? "it" : "them"} to be credited.`
      : `Your payment is not credited yet. Check it again below, or forget it, before paying again: paying now sends a second payment.`}</p>
    {paste}
  </section>;
  return <section className="dev-pay" aria-labelledby="dev-pay-title">
    <h3 id="dev-pay-title">Pay {tokens} MERRYMEN</h3>
    <dl className="dev-pay-details">
      <div><dt>Amount</dt><dd><code>{tokens} MERRYMEN</code><button type="button" aria-label="Copy amount" onClick={() => copy("amount", (amount / 10n ** 18n).toString())}>{copied === "amount" ? "Copied ✓" : "Copy"}</button></dd></div>
      <div><dt>To (Merrymen payments wallet)</dt><dd><code>{treasury}</code><button type="button" aria-label="Copy Merrymen payments wallet address" onClick={() => copy("treasury", treasury)}>{copied === "treasury" ? "Copied ✓" : "Copy"}</button><a href={`${EXPLORER}/address/${treasury}`} target="_blank" rel="noreferrer">Blockscout ↗</a></dd></div>
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
        // The treasury, the payments switch and this browser's other payments, as they are now.
        await confirmPayable(treasury);
        let hash: string;
        try { hash = await payWithWallet({ provider, wallet, treasury, amount }); } catch (e) { await recheck(); throw new Error(walletError(e)); }
        onSent(hash);
      })} />
    {paste}
    <p className="dev-small-print">Paying moves MERRYMEN out of your wallet. Merry Circle tiers and hosted energy follow the balance you hold.</p>
  </section>;
}

/**
 * One payment's check, and its result. The check runs while the payment is
 * `checking` and stops at its first final answer, after POLL_MAX_CHECKS
 * checks or ten minutes, or when this leaves the page.
 */
function PaymentWatch({ watch, spread, minAgeSec, onWaiting, onEnd, onRetry, onForget, onDismiss }: {
  watch: Watch; spread: { current: number }; minAgeSec: number | undefined;
  onWaiting: (hash: string, message: string) => void; onEnd: (hash: string, end: Exclude<WatchEnd, { kind: "cancelled" }>) => void;
  onRetry: () => void; onForget: () => void; onDismiss: () => void;
}) {
  const [forgetting, setForgetting] = useState(false);
  const handlers = useRef({ onWaiting, onEnd, minAgeSec });
  handlers.current = { onWaiting, onEnd, minAgeSec };
  const active = watch.phase === "checking";
  useEffect(() => {
    if (!active) return;
    let cancelled = false, timer: ReturnType<typeof setTimeout> | undefined;
    const hash = watch.hash;
    watchPayment(hash, {
      check: h => requestRaw("payments", { tx_hash: h }),
      wait: ms => new Promise(resolve => { timer = setTimeout(resolve, ms * spread.current); }),
      cancelled: () => cancelled,
      onWaiting: outcome => handlers.current.onWaiting(hash, waitingMessage(outcome, handlers.current.minAgeSec)),
    }).then(end => { if (!cancelled && end.kind !== "cancelled") handlers.current.onEnd(hash, end); },
      // Nothing in a check throws by design; if something does, the payment stays saved with a way to ask again.
      () => { if (!cancelled) handlers.current.onEnd(hash, { kind: "stalled", stage: "" }); });
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
    // A new hash or a "Check again" starts a fresh round; message updates do not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watch.hash, watch.round, active]);
  useEffect(() => { if (watch.phase !== "stalled") setForgetting(false); }, [watch.phase]);
  const tone = watch.phase === "credited" ? "ok" : watch.phase === "failed" ? "bad" : "wait";
  return <div className={`dev-pay-status ${tone}`} role={watch.phase === "failed" ? "alert" : "status"}>
    <p><strong>{watch.phase === "credited" ? "Credited" : watch.phase === "failed" ? "Not credited" : watch.phase === "stalled" ? "Still waiting" : "Checking payment"}</strong> {watch.message || "Checking your payment…"}</p>
    <p><a href={`${EXPLORER}/tx/${watch.hash}`} target="_blank" rel="noreferrer"><code>{short(watch.hash)}</code> on Blockscout ↗</a>
      {watch.phase === "stalled" && !forgetting && <><button className="dev-textlink" onClick={onRetry}>Check again</button><button className="dev-textlink" onClick={() => setForgetting(true)}>Forget this payment</button></>}
      {(watch.phase === "credited" || watch.phase === "failed") && <button className="dev-textlink" onClick={onDismiss}>Dismiss</button>}</p>
    {watch.phase === "stalled" && forgetting && <div className="dev-pay-forget">
      <p>This payment is not credited. Once forgotten, this page stops checking it, and it is credited only if you paste its hash again. Payments are not returned.</p>
      <p><button className="dev-textlink" onClick={onForget}>Forget it</button><button className="dev-textlink" onClick={() => setForgetting(false)}>Keep it</button></p>
    </div>}
  </div>;
}
