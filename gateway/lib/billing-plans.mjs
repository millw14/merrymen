/**
 * PARTNER API PLANS: the single source of truth for what a plan costs and grants.
 *
 * The numbers are tunable. Editing them is safe for anyone already paying: a
 * charge in the billing ledger (lib/billing.mjs) records the price, request
 * quota and rate it was sold at, and a paid period keeps those until it ends.
 * A new price applies from the next charge. A tier removed from this table
 * keeps every recorded entitlement until it ends; a renewal into a tier that is
 * no longer here falls back to Free.
 *
 * MONEY IS BIGINT RAW UNITS, never Number: 1,000,000 tokens is 1e24 raw, far
 * past what a double holds exactly. Time is integer milliseconds.
 *
 * Copy rule, as everywhere $MERRYMEN appears: a plan is paid for API usage.
 * Nothing here or in what renders it says where the tokens go or what they are
 * worth.
 */

/** One billing period: 30 days. Plans, renewals and Free windows all use it. */
export const PERIOD_MS = 2_592_000_000;
export const PERIOD_DAYS = 30;

/**
 * $MERRYMEN on Robinhood Chain. Mirrors packages/core/src/token.ts and the
 * explorer in packages/core/src/chain.ts, inline because the gateway is plain
 * ESM with no build step and must not import the TypeScript packages.
 */
export const TOKEN = Object.freeze({
  symbol: "MERRYMEN",
  address: "0xa15cd06dd305269a0f48bebeb30aa3588fba7b32",
  decimals: 18,
  chainId: 4663,
  explorer: "https://robinhoodchain.blockscout.com",
});
export const ONE_TOKEN = 10n ** BigInt(TOKEN.decimals);

const plan = (id, name, tokens, requests, rpm) => Object.freeze({ id, name, price_raw: BigInt(tokens) * ONE_TOKEN, requests, rpm });

/**
 * Display order is this order. `rpm` is per ACCOUNT, shared by all of an
 * owner's keys; `requests` is per period (a Free owner's period is a 30-day
 * window, see lib/billing.mjs).
 */
export const PLANS = Object.freeze({
  free: plan("free", "Free", 0, 1_000, 30),
  crumbs: plan("crumbs", "Crumbs", 100_000, 50_000, 60),
  loaf: plan("loaf", "Loaf", 400_000, 250_000, 120),
  feast: plan("feast", "Feast", 1_000_000, 1_000_000, 300),
});

/**
 * Refuse a table that would mis-bill, at load, so a bad edit fails the image
 * build (`npm run check` imports this) rather than a customer's request.
 */
export function validatePlans(plans) {
  const entries = Object.entries(plans ?? {});
  if (!plans?.free) throw new Error("plans: a free tier is required");
  for (const [id, p] of entries) {
    if (p.id !== id || !/^[a-z][a-z0-9_-]{0,31}$/.test(id)) throw new Error(`plans: bad id ${id}`);
    if (typeof p.name !== "string" || !p.name) throw new Error(`plans: ${id} needs a name`);
    if (typeof p.price_raw !== "bigint" || p.price_raw < 0n) throw new Error(`plans: ${id} price must be a non-negative bigint`);
    if (!Number.isSafeInteger(p.requests) || p.requests < 1) throw new Error(`plans: ${id} requests must be a positive integer`);
    if (!Number.isSafeInteger(p.rpm) || p.rpm < 1) throw new Error(`plans: ${id} rpm must be a positive integer`);
  }
  // Free is the fallback for every lapse; a price on it would charge for that.
  if (plans.free.price_raw !== 0n) throw new Error("plans: free must cost 0");
  for (const [id, p] of entries) if (id !== "free" && p.price_raw === 0n) throw new Error(`plans: ${id} is paid and needs a price`);
  return plans;
}
validatePlans(PLANS);

/** Exact decimal of a raw amount in whole tokens: no rounding, trailing zeros trimmed. */
export function formatTokens(raw) {
  const v = BigInt(raw);
  const sign = v < 0n ? "-" : "";
  const abs = v < 0n ? -v : v;
  const whole = abs / ONE_TOKEN;
  const frac = (abs % ONE_TOKEN).toString().padStart(TOKEN.decimals, "0").replace(/0+$/, "");
  return `${sign}${whole}${frac ? `.${frac}` : ""}`;
}

/**
 * Whole tokens, rounded UP: what a person should send. Paying the exact raw
 * amount by hand means typing eighteen decimals; one token over is kept as
 * credit, one raw unit short and nothing activates.
 */
export function ceilTokens(raw) {
  const v = BigInt(raw);
  if (v <= 0n) return "0";
  return ((v + ONE_TOKEN - 1n) / ONE_TOKEN).toString();
}

/** "1.5", "-250000" → raw. For the operator CLI; refuses anything ambiguous. */
export function parseTokens(text) {
  const m = /^([+-]?)(\d{1,30})(?:\.(\d{1,18}))?$/.exec(String(text ?? "").trim());
  if (!m) throw new Error(`not a token amount: ${text}`);
  const raw = BigInt(m[2]) * ONE_TOKEN + BigInt((m[3] ?? "").padEnd(TOKEN.decimals, "0"));
  return m[1] === "-" ? -raw : raw;
}
