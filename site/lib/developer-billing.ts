/**
 * Paid API plans as the developer page sees them: the shapes GET /plans and
 * GET /account answer with, the amounts a developer reads and sends, and the
 * wallet checks that stand between a click and a transfer.
 *
 * Browser-safe on purpose. The console imports this file, so nothing here may
 * read a secret or an environment variable; the gateway call that needs the
 * portal secret lives in developer-gateway.ts, which only the server imports.
 *
 * MONEY IS BIGINT. Every amount arrives as a decimal string of base units
 * (`*_raw`) and stays a BigInt until it is drawn. Nothing here turns a token
 * amount into a Number, where 100,000 and 100,000.000000000000000001 are the
 * same value and a transfer built from one sends the wrong amount.
 *
 * THE GATEWAY DECIDES, THE PAGE ONLY ASKS. Whether a transfer counts is checked
 * on the gateway from the chain's own receipt (sender, token, recipient,
 * amount). The checks here exist so a developer cannot send from a wallet or a
 * network that the gateway would never credit: there are no refunds, so the
 * cheapest place to stop a mistake is before the wallet opens.
 */
import { CHAIN_ID, EXPLORER, RPC_URL } from "./chain";

/** Mirrors MERRYMEN_TOKEN in packages/core/src/token.ts (the site does not import core). */
export const TOKEN = { symbol: "MERRYMEN", address: "0xa15cd06dd305269a0f48bebeb30aa3588fba7b32", decimals: 18 } as const;
export const UNIT = 10n ** 18n;
export const CHAIN_HEX = `0x${CHAIN_ID.toString(16)}`;
/** wallet_addEthereumChain parameters, mirroring robinhoodChain in packages/core/src/chain.ts. */
export const ROBINHOOD_CHAIN = {
  chainId: CHAIN_HEX, chainName: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: [RPC_URL], blockExplorerUrls: [EXPLORER],
} as const;
const ZERO = "0x0000000000000000000000000000000000000000";

export type BillingMode = "off" | "observe" | "enforce";
export interface Plan { id: string; name: string; price_raw: string; requests: number; rpm: number }
/**
 * GET /plans, checked. Strings rather than BigInts so a server component can
 * hand it to the console as an ordinary prop.
 */
export interface PlansView {
  source: "live" | "fallback";
  billing: { mode: BillingMode; enforced: boolean };
  period_days: number;
  /** Lowercased, or null when the gateway has none (or sent something that is not one). */
  treasury: string | null;
  /** The gateway named this site's token, chain and decimals. Anything else and nothing is paid. */
  currency_ok: boolean;
  confirmations: { blocks: number; min_age_sec: number } | null;
  plans: Plan[];
}

/**
 * Spec §1's table, shown when the gateway cannot be asked. Display only: no
 * treasury, so no page built from it can offer a payment.
 */
export const FALLBACK_PLANS: PlansView = {
  source: "fallback", billing: { mode: "off", enforced: false }, period_days: 30, treasury: null, currency_ok: true, confirmations: null,
  plans: [
    { id: "free", name: "Free", price_raw: "0", requests: 1_000, rpm: 30 },
    { id: "crumbs", name: "Crumbs", price_raw: (100_000n * UNIT).toString(), requests: 50_000, rpm: 60 },
    { id: "loaf", name: "Loaf", price_raw: (400_000n * UNIT).toString(), requests: 250_000, rpm: 120 },
    { id: "feast", name: "Feast", price_raw: (1_000_000n * UNIT).toString(), requests: 1_000_000, rpm: 300 },
  ],
};

const record = (v: unknown): Record<string, unknown> | null => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
const count = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
const RAW = /^-?\d{1,78}$/;
const raw = (v: unknown) => typeof v === "string" && RAW.test(v) ? BigInt(v).toString() : null;
/** A display name from the gateway, stripped to printable text. React escapes it; this keeps it short and visible. */
const label = (v: unknown, max = 48) => typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, "").trim().slice(0, max) : "";
const iso = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : null;
export const isAddress = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);

/** GET /plans as the page may rely on it, or null when the answer is not usable at all. */
export function normalizePlans(input: unknown): PlansView | null {
  const body = record(input), billing = record(body?.billing), currency = record(body?.currency);
  if (!body || !billing || !Array.isArray(body.plans) || body.plans.length === 0 || body.plans.length > 12) return null;
  const mode = billing.mode;
  if (mode !== "off" && mode !== "observe" && mode !== "enforce") return null;
  const plans: Plan[] = [];
  for (const entry of body.plans) {
    const p = record(entry), price = raw(p?.price_raw) ?? (typeof p?.price_tokens === "string" ? tokensToRaw(p.price_tokens)?.toString() ?? null : null);
    const id = typeof p?.id === "string" && /^[a-z0-9_-]{1,32}$/.test(p.id) ? p.id : null, requests = count(p?.requests), rpm = count(p?.rpm);
    if (!id || price === null || price.startsWith("-") || requests === null || rpm === null) return null;
    plans.push({ id, name: label(p?.name, 32) || id, price_raw: price, requests, rpm });
  }
  const treasury = isAddress(body.treasury) && body.treasury.toLowerCase() !== ZERO ? body.treasury.toLowerCase() : null;
  const confirmations = record(body.confirmations), blocks = count(confirmations?.blocks), age = count(confirmations?.min_age_sec);
  return {
    source: "live", billing: { mode, enforced: billing.enforced === true && mode === "enforce" }, period_days: count(body.period_days) || 30, treasury,
    currency_ok: typeof currency?.address === "string" && currency.address.toLowerCase() === TOKEN.address && currency.chain_id === CHAIN_ID && currency.decimals === TOKEN.decimals,
    confirmations: blocks !== null && age !== null ? { blocks, min_age_sec: age } : null, plans,
  };
}

/**
 * Whether this page may show a way to pay. Every condition is a reason a
 * transfer would be uncreditable or misdirected: billing off, no treasury, a
 * currency other than ours, or a table the site made up itself.
 */
export const paymentsReady = (view: PlansView) => view.source === "live" && view.billing.mode !== "off" && view.treasury !== null && view.currency_ok;

export interface HistoryItem { type: "payment" | "charge" | "reversal" | "adjustment"; at: string; amount_raw: string; tier: string | null; tx_hash: string | null; reason: string | null }
export interface AccountView {
  account: { id: string; name: string; wallet: string; created_at: string | null };
  plan: { id: string; name: string; starts_at: string | null; ends_at: string | null; selected: string; renews_on_next_request: boolean };
  /** Base units; negative while a reversed payment leaves a shortfall. */
  credit_raw: string;
  /** Base units still to send for what is selected, or null when nothing is due. */
  due_raw: string | null;
  usage: { used: number; limit: number; resets_at: string | null; by_key: { key_id: string; used: number }[] } | null;
  history: HistoryItem[];
}

const byKey = (list: unknown) => (Array.isArray(list) ? list : []).flatMap(entry => {
  const k = record(entry), used = count(k?.used);
  return typeof k?.key_id === "string" && used !== null ? [{ key_id: k.key_id, used }] : [];
});
/** GET /account (and the account views POST /plan and POST /payments answer with), or null. */
export function normalizeAccount(input: unknown): AccountView | null {
  const body = record(input), account = record(body?.account), plan = record(body?.plan);
  if (!body || !account || !plan || typeof account.id !== "string" || !isAddress(account.wallet) || typeof plan.id !== "string") return null;
  const fromTokens = (v: unknown) => typeof v === "string" ? tokensToRaw(v)?.toString() ?? null : null;
  const credit = raw(body.credit_raw) ?? fromTokens(body.credit_tokens) ?? "0";
  const dueRaw = body.due_raw === null || body.due_raw === undefined ? (body.due_tokens == null ? null : fromTokens(body.due_tokens)) : raw(body.due_raw);
  const usage = record(body.usage), used = count(usage?.used), limit = count(usage?.limit);
  const history: HistoryItem[] = [];
  for (const entry of Array.isArray(body.history) ? body.history.slice(-50) : []) {
    const h = record(entry), at = iso(h?.at), amount = typeof h?.amount_tokens === "string" ? tokensToRaw(h.amount_tokens) : null;
    if (!h || !at || amount === null || !["payment", "charge", "reversal", "adjustment"].includes(h.type as string)) continue;
    const tx = typeof h.tx_hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(h.tx_hash) ? h.tx_hash.toLowerCase() : null;
    history.push({ type: h.type as HistoryItem["type"], at, amount_raw: amount.toString(), tier: label(h.tier, 32) || null, tx_hash: tx, reason: label(h.reason, 32) || null });
  }
  return {
    account: { id: account.id, name: label(account.name) || "Developer account", wallet: account.wallet.toLowerCase(), created_at: iso(account.created_at) },
    plan: { id: plan.id, name: label(plan.name, 32) || plan.id, starts_at: iso(plan.starts_at), ends_at: iso(plan.ends_at),
      selected: typeof plan.selected === "string" ? plan.selected : plan.id, renews_on_next_request: plan.renews_on_next_request === true },
    credit_raw: credit, due_raw: dueRaw !== null && BigInt(dueRaw) > 0n ? dueRaw : null,
    usage: used !== null && limit !== null ? { used, limit, resets_at: iso(usage?.resets_at), by_key: byKey(usage?.by_key) } : null,
    history,
  };
}

export type PreviewEffect = "activate_now" | "upgrade_now" | "at_renewal" | "waiting_for_payment" | "cancel_renewal";
export interface PlanPreview { effect: PreviewEffect; charge_now_raw: string; due_raw: string | null; starts_at: string | null; ends_at: string | null }
export function normalizePreview(input: unknown): PlanPreview | null {
  const body = record(input), effect = body?.effect;
  if (!body || !["activate_now", "upgrade_now", "at_renewal", "waiting_for_payment", "cancel_renewal"].includes(effect as string)) return null;
  const due = raw(body.due_raw) ?? (typeof body.due_tokens === "string" ? tokensToRaw(body.due_tokens)?.toString() ?? null : null);
  return { effect: effect as PreviewEffect, charge_now_raw: raw(body.charge_now_raw) ?? "0", due_raw: due !== null && BigInt(due) > 0n ? due : null, starts_at: iso(body.starts_at), ends_at: iso(body.ends_at) };
}

/** What confirming would do, in one sentence the developer agrees to. */
export function previewSentence(preview: PlanPreview, plan: Plan, current: string): string {
  const until = preview.ends_at ? ` until ${formatDate(preview.ends_at)}` : "";
  const charge = `${formatTokens(preview.charge_now_raw)} MERRYMEN`;
  switch (preview.effect) {
    case "activate_now": return `${plan.name} starts now and runs${until}. ${charge} comes out of your credit.`;
    case "upgrade_now": return `You move to ${plan.name} now for the rest of this period${until}. ${charge} comes out of your credit, and the requests you have used so far carry over.`;
    case "at_renewal": return `${plan.name} takes over when ${current} ends${preview.starts_at ? ` on ${formatDate(preview.starts_at)}` : ""}. Nothing is charged now.`;
    case "cancel_renewal": return `${current} runs to the end of its period${preview.starts_at ? ` (${formatDate(preview.starts_at)})` : ""}, then your account moves to ${plan.name}. Nothing is charged.`;
    case "waiting_for_payment": return `${plan.name} starts as soon as ${preview.due_raw ? `${formatTokens(preview.due_raw, { round: "up", decimals: 0 })} MERRYMEN arrives` : "your payment arrives"}. Confirm, then pay below.`;
  }
}

/* ── Amounts ─────────────────────────────────────────────────────────────── */

/** "1234567" -> "1,234,567", by hand: toLocaleString differs between the server and the reader's browser. */
export const group = (digits: string | number) => String(digits).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** An exact whole-token decimal string ("63333.5", "-12") in base units, or null. */
export function tokensToRaw(text: string): bigint | null {
  const m = /^(-)?(\d{1,60})(?:\.(\d{1,18}))?$/.exec(text.trim());
  if (!m) return null;
  const value = BigInt(m[2]) * UNIT + BigInt((m[3] || "").padEnd(18, "0") || "0");
  return m[1] ? -value : value;
}

/** Rounded up to a whole token: what a developer is asked to send, and what the transfer carries. */
export const ceilToWholeToken = (amount: bigint) => amount <= 0n ? 0n : (amount + UNIT - 1n) / UNIT * UNIT;

/**
 * Base units as tokens for reading. `decimals` caps the fraction; `round`
 * says which way the cut goes, so an amount owed never reads smaller than it is.
 */
export function formatTokens(amount: bigint | string, { decimals = 6, round = "down" }: { decimals?: number; round?: "down" | "up" } = {}): string {
  let value = typeof amount === "bigint" ? amount : RAW.test(amount) ? BigInt(amount) : 0n;
  const negative = value < 0n, places = Math.max(0, Math.min(18, decimals)), step = 10n ** BigInt(18 - places), sign = negative ? "-" : "";
  if (negative) value = -value;
  // A sliver below the shown precision would read as "0", which looks like nothing is there.
  if (round === "down" && value > 0n && value < step) return `${sign}<${places ? `0.${"0".repeat(places - 1)}1` : "1"}`;
  if (round === "up") value = (value + step - 1n) / step * step;
  const whole = value / UNIT, fraction = places ? (value % UNIT / step).toString().padStart(places, "0").replace(/0+$/, "") : "";
  return `${sign}${group(whole.toString())}${fraction ? `.${fraction}` : ""}`;
}

/** The amount to send for what is due: rounded up to a whole token, or null when nothing is. */
export function amountToSend(due_raw: string | null): bigint | null {
  if (due_raw === null || !RAW.test(due_raw)) return null;
  const due = BigInt(due_raw);
  return due > 0n ? ceilToWholeToken(due) : null;
}

export const priceLabel = (plan: Plan) => plan.price_raw === "0" ? "Free" : `${formatTokens(plan.price_raw, { decimals: 0, round: "up" })} MERRYMEN`;
export const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
export const formatDate = (value: string) => new Date(value).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
export const formatDateTime = (value: string) => `${new Date(value).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" })} UTC`;

/* ── Transfer encoding (no ABI library: one selector, two words) ─────────── */

const word = (hex: string) => hex.padStart(64, "0");
/**
 * ERC-20 `transfer(address,uint256)` calldata. Refuses the zero address and a
 * zero amount: either is a transfer nobody can be credited for.
 */
export function transferCalldata(to: string, amount: bigint): `0x${string}` {
  if (!isAddress(to) || to.toLowerCase() === ZERO) throw new Error("A payment needs a valid recipient.");
  if (amount <= 0n || amount >= 1n << 256n) throw new Error("A payment needs a positive amount.");
  return `0xa9059cbb${word(to.slice(2).toLowerCase())}${word(amount.toString(16))}`;
}
/** ERC-20 `balanceOf(address)` calldata. */
export function balanceOfCalldata(owner: string): `0x${string}` {
  if (!isAddress(owner)) throw new Error("Not an address.");
  return `0x70a08231${word(owner.slice(2).toLowerCase())}`;
}

/* ── The browser wallet ──────────────────────────────────────────────────── */

export interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
}
export function chainIdOf(value: unknown): number | null {
  try {
    if (typeof value === "number" && Number.isSafeInteger(value)) return value;
    if (typeof value === "string" && /^(0x[0-9a-fA-F]{1,16}|\d{1,16})$/.test(value)) return Number(BigInt(value));
  } catch { /* Falls through. */ }
  return null;
}

export type PayCheck =
  | { ok: true }
  | { ok: false; reason: "no_provider" | "not_connected" | "wrong_account" | "wrong_chain"; message: string };
/**
 * Whether "Pay with wallet" may be offered. The gateway credits a transfer
 * only from the signed-in wallet on Robinhood Chain, and there are no refunds,
 * so anything else is refused here with the reason and what to do.
 */
export function payEligibility({ provider, accounts, chainId, wallet }: { provider: boolean; accounts: unknown; chainId: unknown; wallet: string }): PayCheck {
  if (!provider) return { ok: false, reason: "no_provider", message: `No browser wallet on this page. Send the payment from ${short(wallet)} in your wallet app, then paste the transaction hash below.` };
  const first = Array.isArray(accounts) && typeof accounts[0] === "string" ? accounts[0].toLowerCase() : "";
  if (!first) return { ok: false, reason: "not_connected", message: `Connect ${short(wallet)} in your wallet to pay from this page.` };
  if (first !== wallet.toLowerCase()) return { ok: false, reason: "wrong_account", message: `Your wallet is set to ${short(first)}. Switch it to ${short(wallet)}, the wallet you signed in with: a payment from any other wallet cannot be credited to this account.` };
  if (chainIdOf(chainId) !== CHAIN_ID) return { ok: false, reason: "wrong_chain", message: "Your wallet is on another network. Switch it to Robinhood Chain to pay." };
  return { ok: true };
}
export async function checkWallet(provider: Eip1193 | undefined, wallet: string): Promise<PayCheck> {
  if (!provider) return payEligibility({ provider: false, accounts: [], chainId: null, wallet });
  const [accounts, chainId] = await Promise.all([provider.request({ method: "eth_accounts" }), provider.request({ method: "eth_chainId" })]);
  return payEligibility({ provider: true, accounts, chainId, wallet });
}

const codeOf = (e: unknown): unknown => {
  const err = e as { code?: unknown; data?: { originalError?: { code?: unknown } } } | null;
  return err?.data?.originalError?.code ?? err?.code;
};
/** A wallet's refusal, said in words. Raw provider errors are not shown: they read as a crash. */
export function walletError(e: unknown): string {
  switch (codeOf(e)) {
    case 4001: return "You cancelled in your wallet.";
    case -32002: return "Open your wallet: a request is already waiting there.";
    case 4100: return "Your wallet has not connected this page yet. Connect it and try again.";
    case 4902: return "Your wallet does not have Robinhood Chain yet.";
  }
  return e instanceof PaymentRefused ? e.message : "Your wallet could not complete that. Nothing was sent; try again, or pay manually below.";
}
export class PaymentRefused extends Error {}

/**
 * Switch the wallet to Robinhood Chain, adding it when the wallet does not
 * know it (4902). A switch can return without switching, so the chain is
 * read back rather than assumed.
 */
export async function switchToRobinhood(provider: Eip1193): Promise<void> {
  try { await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_HEX }] }); } catch (e) {
    if (codeOf(e) !== 4902) throw e;
    await provider.request({ method: "wallet_addEthereumChain", params: [ROBINHOOD_CHAIN] });
  }
  if (chainIdOf(await provider.request({ method: "eth_chainId" })) !== CHAIN_ID) throw new PaymentRefused("Your wallet is still on another network. Switch it to Robinhood Chain and try again.");
}

/**
 * Send `amount` of MERRYMEN from the signed-in wallet to the treasury and
 * return the transaction hash. The account and chain are read again right
 * before sending (the wallet can change after the button was drawn), the
 * sender is named explicitly, and a balance that cannot cover the payment is
 * refused before the wallet asks for gas.
 */
export async function payWithWallet({ provider, wallet, treasury, amount }: { provider: Eip1193; wallet: string; treasury: string; amount: bigint }): Promise<string> {
  const data = transferCalldata(treasury, amount);
  const check = await checkWallet(provider, wallet);
  if (!check.ok) throw new PaymentRefused(check.message);
  let balance: bigint | null = null;
  try {
    const answer = await provider.request({ method: "eth_call", params: [{ to: TOKEN.address, data: balanceOfCalldata(wallet) }, "latest"] });
    if (typeof answer === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(answer)) balance = BigInt(answer);
  } catch { /* The wallet will refuse an unaffordable transfer itself; this check only saves a failed transaction's gas. */ }
  if (balance !== null && balance < amount) throw new PaymentRefused(`This wallet holds ${formatTokens(balance, { decimals: 2 })} MERRYMEN; this payment needs ${formatTokens(amount, { decimals: 0, round: "up" })}.`);
  const hash = await provider.request({ method: "eth_sendTransaction", params: [{ from: wallet, to: TOKEN.address, value: "0x0", data, chainId: CHAIN_HEX }] });
  const tx = txHash(hash);
  if (!tx) throw new PaymentRefused("Your wallet did not return a transaction hash. If it sent one, paste the hash below.");
  return tx;
}

/** A transaction hash, lowercased, or null. */
export const txHash = (value: unknown) => typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value.trim()) ? value.trim().toLowerCase() : null;

/* ── Waiting for the gateway to credit a payment ─────────────────────────── */

export const POLL_GIVE_UP_MS = 10 * 60_000;
/**
 * Six seconds, stretching by half again after the second check, to 30 s. The
 * gateway allows 30 checks a minute per wallet; this stays far below it, and
 * honours a retry_after it asks for.
 */
export function nextPollDelay(attempt: number, retryAfterSec?: number | null): number {
  const backoff = Math.min(30_000, Math.round(6_000 * 1.5 ** Math.max(0, attempt - 2)));
  return typeof retryAfterSec === "number" && retryAfterSec > 0 ? Math.min(60_000, Math.max(backoff, retryAfterSec * 1000)) : backoff;
}

export type PaymentOutcome =
  | { kind: "credited"; already: boolean; account: AccountView | null }
  | { kind: "pending"; stage: string; readyInSec: number | null; retryAfterSec: number | null }
  | { kind: "failed"; code: string; reason: string | null; message: string }
  | { kind: "retry"; message: string }
  | { kind: "signed_out" };
/**
 * POST /payments, read. Pending and transient answers keep the page waiting;
 * a refusal (422, or a 4xx the developer must fix) stops it with the
 * gateway's own words, which name the cause (wrong sender, too small, …).
 */
export function paymentOutcome(status: number, input: unknown): PaymentOutcome {
  const body = record(input) ?? {}, error = record(body.error);
  const code = typeof error?.code === "string" ? error.code : typeof body.code === "string" ? body.code : "";
  const message = typeof error?.message === "string" ? error.message : typeof body.message === "string" ? body.message : "";
  const detail = error ?? body;
  if (status === 401 && code === "signed_out") return { kind: "signed_out" };
  if (status === 202 || code === "payment_pending") {
    return { kind: "pending", stage: typeof detail.stage === "string" ? detail.stage : "confirming", readyInSec: count(detail.ready_in_sec), retryAfterSec: count(detail.retry_after) };
  }
  if (status >= 200 && status < 300) return { kind: "credited", already: body.already === true, account: normalizeAccount(body) };
  if (status === 429 || status >= 500 || status === 0) return { kind: "retry", message: message || "The payment check is busy. Trying again shortly." };
  return { kind: "failed", code: code || "payment_refused", reason: typeof detail.reason === "string" ? detail.reason : null, message: message || "This transaction cannot be credited." };
}

/** One line of account history, in words. Never "refund": nothing goes back on chain. */
export function historyLabel(item: HistoryItem, plans: Plan[]): string {
  const tier = plans.find(p => p.id === item.tier)?.name ?? item.tier ?? "Plan";
  if (item.type === "payment") return "Payment received";
  if (item.type === "reversal") return "Payment reversed by the chain";
  if (item.type === "adjustment") return "Adjustment by Merrymen";
  return ({ activate: `${tier} started`, renew: `${tier} renewed`, upgrade: `Upgrade to ${tier}`, comp: `${tier} from Merrymen` } as Record<string, string>)[item.reason ?? ""] ?? `${tier} charge`;
}
