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
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
const raw = (v: unknown) => typeof v === "string" && RAW.test(v) ? BigInt(v).toString() : null;
/**
 * A display name from the gateway, stripped to printable text. React escapes
 * it; this keeps it short and visible. Every invisible formatting character
 * goes (Arabic letter mark, Mongolian vowel separator, zero-width and
 * directional marks, word joiner and invisible operators, isolates, BOM), so
 * one name cannot pass for another.
 */
const label = (v: unknown, max = 48) => typeof v === "string" ? v.replace(INVISIBLE, "").trim().slice(0, max) : "";
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

export type Freshness = { ok: true; plans: PlansView } | { ok: false; plans: PlansView | null; message: string };
/**
 * GET /plans read again at the moment of paying, against the treasury the
 * page is about to send to. A tab left open, or a page from the minute-long
 * cache, can show a treasury since rotated out or payments since closed; the
 * gateway credits neither and nothing is returned. Anything short of a live
 * answer naming the same treasury refuses, with the fresh plans to show.
 */
export function stillPayable(answer: unknown, treasury: string): Freshness {
  const fresh = normalizePlans(answer);
  if (!fresh) return { ok: false, plans: null, message: "The payment details could not be confirmed just now, so nothing was sent. Try again shortly." };
  if (!paymentsReady(fresh)) return { ok: false, plans: fresh, message: "Payments are paused just now, so nothing was sent. Your selection waits." };
  if (fresh.treasury !== treasury.toLowerCase()) return { ok: false, plans: fresh, message: "The Merrymen payments wallet changed since this page loaded, so nothing was sent. Check the new details and pay again." };
  return { ok: true, plans: fresh };
}

export interface HistoryItem { type: "payment" | "charge" | "reversal" | "adjustment"; at: string; amount_raw: string; tier: string | null; tx_hash: string | null; reason: string | null }
export interface AccountView {
  account: { id: string; name: string; wallet: string; created_at: string | null };
  /**
   * `renews_into`: the plan a charge waiting for the next metered request is
   * for (a lapsed period's renewal paid from credit), or null. Reads never
   * charge, so until that request the plan reads as Free.
   */
  plan: { id: string; name: string; starts_at: string | null; ends_at: string | null; selected: string; renews_on_next_request: boolean; renews_into: string | null };
  /** Base units; negative while a reversed payment leaves a shortfall. */
  credit_raw: string;
  /** Base units still to send for what is selected, or null when nothing is due. */
  due_raw: string | null;
  /**
   * What `due_raw` pays for, as the gateway says: starting the selected plan,
   * upgrading the running one, or renewing (the next period's price, owed only
   * once the running period ends). Null when unsaid.
   */
  due_for: "activation" | "upgrade" | "renewal" | null;
  usage: { used: number; limit: number; resets_at: string | null; by_key: { key_id: string; used: number }[] } | null;
  /** Newest first, at most 50. */
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
  for (const entry of Array.isArray(body.history) ? body.history : []) {
    const h = record(entry), at = iso(h?.at), amount = typeof h?.amount_tokens === "string" ? tokensToRaw(h.amount_tokens) : null;
    if (!h || !at || amount === null || !["payment", "charge", "reversal", "adjustment"].includes(h.type as string)) continue;
    const tx = typeof h.tx_hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(h.tx_hash) ? h.tx_hash.toLowerCase() : null;
    history.push({ type: h.type as HistoryItem["type"], at, amount_raw: amount.toString(), tier: label(h.tier, 32) || null, tx_hash: tx, reason: label(h.reason, 32) || null });
  }
  return {
    account: { id: account.id, name: label(account.name) || "Developer account", wallet: account.wallet.toLowerCase(), created_at: iso(account.created_at) },
    plan: { id: plan.id, name: label(plan.name, 32) || plan.id, starts_at: iso(plan.starts_at), ends_at: iso(plan.ends_at),
      selected: typeof plan.selected === "string" ? plan.selected : plan.id, renews_on_next_request: plan.renews_on_next_request === true,
      renews_into: plan.renews_on_next_request === true && typeof plan.renews_into === "string" && /^[a-z0-9_-]{1,32}$/.test(plan.renews_into) ? plan.renews_into : null },
    credit_raw: credit, due_raw: dueRaw !== null && BigInt(dueRaw) > 0n ? dueRaw : null,
    due_for: dueRaw !== null && BigInt(dueRaw) > 0n && ["activation", "upgrade", "renewal"].includes(body.due_for as string) ? body.due_for as AccountView["due_for"] : null,
    usage: used !== null && limit !== null ? { used, limit, resets_at: iso(usage?.resets_at), by_key: byKey(usage?.by_key) } : null,
    // Newest first, whatever order the gateway sends: the reader wants the latest at the top, and a long list keeps its latest 50.
    history: history.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 50),
  };
}

/**
 * When what is due only renews a plan that is running, the day it is needed
 * by (the period's end); null when it is needed now. Right after a payment
 * starts a plan, the gateway already reports the next period's price as due:
 * read as "due now", that asks a developer who has just paid to pay again.
 */
export const renewalBy = (view: AccountView): string | null =>
  view.due_raw !== null && view.due_for === "renewal" && view.plan.id !== "free" && view.plan.ends_at !== null ? view.plan.ends_at : null;

export type DueCheck = { ok: true } | { ok: false; account: AccountView | null; message: string };
/**
 * GET /account read again at the moment of paying, against the view the
 * payment panel was drawn from. The amount and what it pays for (starting a
 * plan, an upgrade, a renewal) were read when the page loaded. A payment
 * credited from a phone or another browser, a plan chosen on another device,
 * or an operator's adjustment makes them wrong since, and the transfer is not
 * returned: it would sit as credit for a period nobody asked to pay for yet.
 *
 * So the plan, the selection, the period, the credit and what is due for must
 * all be as drawn, and the amount the same. One change is not a change: an
 * upgrade costs less with every second of its period that passes, and the
 * amount on the button still covers it (the gateway only ever asks less as
 * the period runs), so a fall of up to 1% is paid as shown rather than
 * refused on every click. Anything else refuses, with the fresh view to show,
 * except another wallet's account (this browser signed in elsewhere), which
 * this page does not show.
 */
export function stillDue(answer: unknown, shown: AccountView): DueCheck {
  const fresh = normalizeAccount(answer);
  if (!fresh) return { ok: false, account: null, message: "Your account could not be read just now, so nothing was sent. Try again shortly." };
  if (fresh.account.id !== shown.account.id || fresh.account.wallet !== shown.account.wallet) {
    return { ok: false, account: null, message: "This browser is now signed in with another wallet, so nothing was sent. Reload the page to continue." };
  }
  const was = amountToSend(shown.due_raw), now = amountToSend(fresh.due_raw);
  if (now === null) return { ok: false, account: fresh, message: "Nothing is due now: your account changed since this page loaded, so nothing was sent." };
  const same = fresh.plan.id === shown.plan.id && fresh.plan.selected === shown.plan.selected && fresh.plan.starts_at === shown.plan.starts_at
    && fresh.plan.ends_at === shown.plan.ends_at && fresh.credit_raw === shown.credit_raw && fresh.due_for === shown.due_for;
  const decayed = fresh.due_for === "upgrade" && was !== null && now < was && (was - now) * 100n <= was;
  if (same && (now === was || decayed)) return { ok: true };
  return { ok: false, account: fresh, message: "What is due changed since this page loaded, so nothing was sent. Check the amount and pay again." };
}

export type PreviewEffect ="activate_now" | "upgrade_now" | "at_renewal" | "waiting_for_payment" | "cancel_renewal";
export interface PlanPreview {
  effect: PreviewEffect; charge_now_raw: string;
  /** A tier other than the chosen one that the charge now renews (a lapsed period's), or null. */
  charge_now_tier: string | null;
  due_raw: string | null; starts_at: string | null; ends_at: string | null;
  /**
   * The request quota of the period the change applies to. An upgrade's is
   * the time-left share of the new plan's, below the plan card's 30-day
   * figure; for one still to be paid, as of now (it falls as the period runs).
   */
  period_requests: number | null;
}
export function normalizePreview(input: unknown): PlanPreview | null {
  const body = record(input), effect = body?.effect;
  if (!body || !["activate_now", "upgrade_now", "at_renewal", "waiting_for_payment", "cancel_renewal"].includes(effect as string)) return null;
  const due = raw(body.due_raw) ?? (typeof body.due_tokens === "string" ? tokensToRaw(body.due_tokens)?.toString() ?? null : null);
  const tier = typeof body.charge_now_tier === "string" && /^[a-z0-9_-]{1,32}$/.test(body.charge_now_tier) ? body.charge_now_tier : null;
  return { effect: effect as PreviewEffect, charge_now_raw: raw(body.charge_now_raw) ?? "0", charge_now_tier: tier,
    due_raw: due !== null && BigInt(due) > 0n ? due : null, starts_at: iso(body.starts_at), ends_at: iso(body.ends_at), period_requests: count(body.period_requests) };
}

/** What previewSentence may also know about the account and the page. */
export interface PreviewContext {
  /** The plan table, to name a tier the gateway gives by id. */
  plans?: Plan[];
  /** The running plan's id, to tell choosing it again from choosing another; by name when absent. */
  currentId?: string;
  /** The account's credit in base units: what cancelling leaves on the account. */
  credit_raw?: string;
  /** Whether this page can take a payment now (paymentsReady); unless false, it can. */
  paymentsOpen?: boolean;
}

/**
 * What confirming would do, in one sentence the developer agrees to.
 * `selected` names the plan waiting for payment, if any: choosing Free before
 * it starts drops it. Every charge confirming makes is named, with what it
 * buys: a lapsed period's renewal paid from credit included.
 */
export function previewSentence(preview: PlanPreview, plan: Plan, current: string, selected?: string, context: PreviewContext = {}): string {
  const until = preview.ends_at ? ` until ${formatDate(preview.ends_at)}` : "";
  const charge = BigInt(preview.charge_now_raw) > 0n ? `${formatTokens(preview.charge_now_raw)} MERRYMEN comes out of your credit` : "";
  // The plan card says 30 days of the new plan; an upgrade buys the share of it that is left of this period.
  const share = (atMost: string) => preview.period_requests !== null && preview.period_requests < plan.requests
    ? ` An upgrade adds requests only for the time left: this period's quota becomes ${atMost}${group(preview.period_requests)} requests, and ${plan.name}'s full ${group(plan.requests)} starts with the next period.` : "";
  switch (preview.effect) {
    case "activate_now":
      // Free "activates" with nothing running: the account stays where it is, and only the unpaid selection goes.
      if (plan.price_raw === "0") return `Your account stays on ${plan.name}${selected && selected !== plan.name ? ` and the pending ${selected} selection is dropped` : ""}. Nothing is charged.`;
      return `${plan.name} starts now${until ? ` and runs${until}` : ""}. ${charge ? `${charge}.` : "Nothing is charged."}`;
    case "upgrade_now": return `You move to ${plan.name} now for the rest of this period${until}. ${charge || "Nothing is charged"}, and the requests you have used so far carry over.${share("")}`;
    case "at_renewal": {
      const on = preview.starts_at ? ` on ${formatDate(preview.starts_at)}` : "";
      if (context.currentId ? plan.id === context.currentId : plan.name === current) {
        // The running plan chosen again: it renews as it would have, and whatever was pending instead goes.
        const pending = !selected || selected === current ? "" : selected === "Free" ? ", so renewal is on again" : `, and the pending ${selected} change is dropped`;
        return `${current} renews when this period ends${on} (${priceLabel(plan)}, from your credit or a payment)${pending}. Nothing is charged now.`;
      }
      return `${plan.name} takes over when ${current} ends${on}. Nothing is charged now.`;
    }
    case "cancel_renewal": {
      const credit = context.credit_raw && RAW.test(context.credit_raw) && BigInt(context.credit_raw) > 0n
        ? ` Your ${formatTokens(context.credit_raw, { decimals: 2 })} MERRYMEN of credit stays on this account for later charges; it is not returned.` : "";
      return `${current} runs to the end of its period${preview.starts_at ? ` (${formatDate(preview.starts_at)})` : ""}, then your account moves to ${plan.name}. Nothing is charged.${credit}`;
    }
    case "waiting_for_payment": {
      // The chosen plan cannot be paid from credit, but a lapsed period's plan can: confirming renews that one now.
      const renewed = preview.charge_now_tier ? context.plans?.find(p => p.id === preview.charge_now_tier)?.name ?? preview.charge_now_tier : null;
      const renews = charge ? `${formatTokens(preview.charge_now_raw)} MERRYMEN of your credit renews ${renewed ? `${renewed} now, the plan your last period was on` : "your last paid plan now"}. ` : "";
      const arrives = preview.due_raw ? `${formatTokens(preview.due_raw, { round: "up", decimals: 0 })} MERRYMEN arrives` : "your payment arrives";
      // No treasury yet (billing observed, payments closed): there is no payment step below to point to.
      if (context.paymentsOpen === false) return `${renews}${plan.name} starts once payments open and ${arrives}.${share("at most ")} Your selection waits until then.`;
      // Paid later, an upgrade covers less of the period, so its quota is "at most" what it would be now.
      return `${renews}${plan.name} starts as soon as ${arrives}.${share("at most ")} Confirm, then pay below.`;
    }
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
/** A provider error's own words (the wrapped original's first), for the one refusal recognised by them. Never shown. */
const messageOf = (e: unknown): string => {
  const err = e as { message?: unknown; data?: { originalError?: { message?: unknown } } } | null;
  const m = err?.data?.originalError?.message ?? err?.message;
  return typeof m === "string" ? m : "";
};
/**
 * A wallet's refusal, said in words. Raw provider errors are not shown: they
 * read as a crash. "Nothing was sent" is said only where that is known: the
 * fallback here covers connecting, switching and reading, and a failed send
 * arrives as a SendUncertain with its own words.
 */
export function walletError(e: unknown): string {
  switch (codeOf(e)) {
    case 4001: return "You cancelled in your wallet.";
    case -32002: return "Open your wallet: a request is already waiting there.";
    case 4100: return "Your wallet has not connected this page yet. Connect it and try again.";
    case 4902: return "Your wallet does not have Robinhood Chain yet.";
  }
  return e instanceof PaymentRefused ? e.message : "Your wallet could not complete that. Nothing was sent; try again, or send it from your wallet app with the details above and paste the hash below.";
}
export class PaymentRefused extends Error {}
/** eth_sendTransaction failed after the wallet may have broadcast it: the page cannot know whether money left. */
export class SendUncertain extends PaymentRefused {}
/** Codes a wallet answers before anything is signed: the user declined, the account or chain is not connected, or a request is already open. */
const NOT_SENT = new Set<unknown>([4001, 4100, 4900, 4901, -32002]);
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
  let hash: unknown;
  try { hash = await provider.request({ method: "eth_sendTransaction", params: [{ from: wallet, to: TOKEN.address, value: "0x0", data, chainId: CHAIN_HEX }] }); } catch (e) {
    if (NOT_SENT.has(codeOf(e))) throw e;
    // A node refuses a transaction whose sender cannot pay its fee before it exists: nothing was sent, and the
    // remedy is ETH for gas on Robinhood Chain, which nothing else on the page mentions.
    if (/insufficient funds/i.test(messageOf(e))) throw new PaymentRefused(`This wallet does not have enough ETH on Robinhood Chain for the network fee, so nothing was sent. Add a little ETH to ${short(wallet)} on Robinhood Chain, then pay again.`);
    // An internal error, a relay timeout or a broadcast timeout can come after the user approved and the
    // wallet sent. "Try again" there is a second payment, and the first one's hash is not on this page.
    throw new SendUncertain("Your wallet reported an error, so this page cannot tell whether the payment was sent. Check your wallet's activity: if it shows this transfer, paste its hash below instead of paying again.");
  }
  const tx = txHash(hash);
  if (!tx) throw new PaymentRefused("Your wallet did not return a transaction hash. If it sent one, paste the hash below.");
  return tx;
}

/** A transaction hash, lowercased, or null. */
export const txHash = (value: unknown) => typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value.trim()) ? value.trim().toLowerCase() : null;

/* ── Waiting for the gateway to credit a payment ─────────────────────────── */

export const POLL_GIVE_UP_MS = 10 * 60_000;
/**
 * The most checks one wait sends, whatever the clock says. Ten minutes of the
 * backoff below is about 25 checks, so this never cuts a real wait short; it
 * is there for a clock that does not move as the waits do (a sleeping laptop
 * waking, a page whose timers fire early, a test that fast-forwards them),
 * which would otherwise keep asking without end.
 */
export const POLL_MAX_CHECKS = 40;
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
  | { kind: "retry"; code: string; message: string }
  | { kind: "unchecked"; code: string; message: string }
  | { kind: "signed_out" };
/**
 * POST /payments, read. Pending and transient answers keep the page waiting.
 *
 * Only a verdict on the transaction itself is final: the gateway's 422
 * refusals (failed, not found, too small, unsupported), which name the cause in
 * the gateway's own words, and a 400 for a "hash" that is not one. Any other
 * refusal (a rotated portal secret, a gateway rolled back to one without this
 * route, a missing account, this site's own 403) says nothing about the
 * transfer. It is `unchecked`: the page stops asking but keeps the hash, since
 * a transfer the page stops submitting is never credited.
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
  if (status === 429 || status >= 500 || status === 0) return { kind: "retry", code, message: message || "The payment check is busy. Trying again shortly." };
  if (status === 422 || (status === 400 && code === "invalid_tx_hash")) return { kind: "failed", code: code || "payment_refused", reason: typeof detail.reason === "string" ? detail.reason : null, message };
  return { kind: "unchecked", code, message: message || "The payment check was refused." };
}

/** `message` (and `code`) on a stalled end: the check itself was refused (see `unchecked`), not slow. */
export type WatchEnd = Extract<PaymentOutcome, { kind: "credited" | "failed" | "signed_out" }> | { kind: "stalled"; stage: string; message?: string; code?: string } | { kind: "cancelled" };
/**
 * Submit `hash` until the gateway credits or refuses it. Re-submitting is how
 * the gateway is asked again (it credits a transaction once, then answers
 * `already`), so a lost answer or a reload costs nothing. Gives up after ten
 * minutes or POLL_MAX_CHECKS checks, whichever comes first, with the last
 * stage seen, or at once when the check itself is refused, so the page can
 * say what to do next ("check again") and keep the hash.
 */
export async function watchPayment(hash: string, { check, wait, now = Date.now, cancelled, onWaiting }: {
  check: (hash: string) => Promise<{ status: number; data: unknown }>; wait: (ms: number) => Promise<void>; now?: () => number;
  cancelled: () => boolean; onWaiting: (outcome: Extract<PaymentOutcome, { kind: "pending" | "retry" }>) => void;
}): Promise<WatchEnd> {
  const started = now();
  let stage = "";
  for (let attempt = 0; ; attempt++) {
    const { status, data } = await check(hash).catch(() => ({ status: 0, data: null }));
    if (cancelled()) return { kind: "cancelled" };
    const outcome = paymentOutcome(status, data);
    if (outcome.kind === "unchecked") return { kind: "stalled", stage, message: outcome.message, code: outcome.code };
    if (outcome.kind !== "pending" && outcome.kind !== "retry") return outcome;
    if (outcome.kind === "pending") stage = outcome.stage;
    // Counted as well as timed: the count alone ends a loop whose clock never moves.
    if (attempt + 1 >= POLL_MAX_CHECKS || now() - started >= POLL_GIVE_UP_MS) return { kind: "stalled", stage };
    onWaiting(outcome);
    await wait(nextPollDelay(attempt, outcome.kind === "pending" ? outcome.retryAfterSec : null));
    if (cancelled()) return { kind: "cancelled" };
  }
}

/** What the page says while it waits. No confirmation counts: on a chain this fast they only flicker. */
export function waitingMessage(outcome: Extract<PaymentOutcome, { kind: "pending" | "retry" }>, minAgeSec = 120): string {
  if (outcome.kind === "retry") return outcome.code === "billing_off" || outcome.code === "payments_unavailable"
    ? "Payments are paused on our side just now. This payment is saved; checking again shortly…"
    : "The payment check is busy. Trying again shortly…";
  if (outcome.stage === "not_found_yet") return "Waiting for Robinhood Chain to include your transaction…";
  return `Confirming on Robinhood Chain (about ${Math.max(1, Math.ceil((outcome.readyInSec ?? minAgeSec) / 60))} min)…`;
}

const REASON_HINT: Record<string, (wallet: string) => string> = {
  wrong_sender: wallet => `Only transfers from ${short(wallet)} count for this account. If you sent it from another wallet, sign in with that wallet, create its account and submit this hash there.`,
  wrong_recipient: () => "This transfer did not go to the Merrymen payments wallet shown here.",
  wrong_token: () => "This transaction did not move MERRYMEN.",
  before_start_block: () => "This transfer was made before payments opened.",
};
/**
 * How a finished wait reads. A refusal is told in the gateway's own words,
 * which already name the cause and the remedy; the page's hint stands in only
 * when the gateway sent none, so the alert never says the same thing twice.
 */
export function endMessage(end: Exclude<WatchEnd, { kind: "signed_out" | "cancelled" }>, wallet: string): string {
  if (end.kind === "credited") return end.already ? "This payment was already credited." : "Payment credited.";
  if (end.kind === "stalled") {
    // Another tab of this browser signed in with another wallet: the gateway checked nothing, and this hash is kept for this one.
    if (end.code === "session_wallet_changed") return `This browser is now signed in with another wallet, so this payment was not checked. It stays saved for ${short(wallet)}: sign in with that wallet again to check it.`;
    if (end.message) return `This payment could not be checked just now (${end.message.replace(/[.\s]+$/, "")}). It is saved here: check again later. Nothing is lost while you wait.`;
    return end.stage === "not_found_yet"
      ? "We can't find this transaction on Robinhood Chain. If you sped it up or cancelled it in your wallet, paste the new hash below."
      : "Still not credited. Check again in a minute; nothing is lost while you wait.";
  }
  return end.message || (end.reason ? REASON_HINT[end.reason]?.(wallet) : "") || "This transaction cannot be credited.";
}

/**
 * Transfers the gateway reversed and has not credited again since, newest
 * first. A reorg that MOVED a transfer leaves a real payment, credited again
 * once its hash is submitted again; a check from a node that was out of step
 * can be one too. Either way the hash is the remedy, not a second payment.
 */
export function reversedToCheck(history: HistoryItem[]): string[] {
  const out: string[] = [];
  for (const h of history) {
    if (h.type !== "reversal" || !h.tx_hash || out.includes(h.tx_hash)) continue;
    const since = Date.parse(h.at);
    if (!history.some(x => x.type === "payment" && x.tx_hash === h.tx_hash && Date.parse(x.at) > since)) out.push(h.tx_hash);
  }
  return out;
}

/** One line of account history, in words. Never "refund": nothing goes back on chain. */
export function historyLabel(item: HistoryItem, plans: Plan[]): string {
  const tier = plans.find(p => p.id === item.tier)?.name ?? item.tier ?? "Plan";
  if (item.type === "payment") return "Payment received";
  if (item.type === "reversal") return "Payment reversed by the chain";
  if (item.type === "adjustment") return "Adjustment by Merrymen";
  return ({ activate: `${tier} started`, renew: `${tier} renewed`, upgrade: `Upgrade to ${tier}`, comp: `${tier} from Merrymen` } as Record<string, string>)[item.reason ?? ""] ?? `${tier} charge`;
}
