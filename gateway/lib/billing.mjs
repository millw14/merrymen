/**
 * BILLING: MERRYMEN-paid plans for the partner API.
 *
 * A developer signs in with a wallet, creates an account, and pays by sending
 * $MERRYMEN from that wallet to a dedicated payments address. This module
 * verifies such a transfer on chain (READ-ONLY: the gateway never sends a
 * transaction and holds no key), keeps the account's credit and plan in an
 * append-only ledger, and meters every partner request against the plan.
 *
 * THE LEDGER IS THE TRUTH. $MERRYMEN_DATA_DIR/billing.jsonl, one JSON record a
 * line, replayed once at boot into an in-memory index and extended only by
 * appends. One append per state change; the index changes only after that
 * append resolves. Replay enforces the money invariants itself, so a record
 * written twice (a retry after a lost response, a crash between two writes)
 * cannot count twice:
 *   - a transfer is credited once per (chain_id, tx_hash, from), and every part
 *     of that key comes from the RPC's receipt, never from the request;
 *   - a repeated record id or charge_id is ignored;
 *   - a charge larger than everything the account ever paid or was granted
 *     means a payment line is missing: replay stops there and billing writes
 *     are refused, while reads and metering continue on what came before.
 * A torn last line (a write that died part-way) is cut before the next append
 * so it can never swallow the record after it, and a failed append refuses
 * further writes until that repair has run.
 *
 * Records: {id, type, at} plus
 *   account     {account_id, owner, name}
 *   select      {account_id, tier}                          (only when it changes)
 *   payment     {account_id, owner, chain_id, token, recipient, tx_hash,
 *                block_number, block_hash, amount_raw, log_indexes}
 *   charge      {account_id, charge_id, period_id, reason: activate|renew|
 *                upgrade|comp, tier, price_raw, tier_price_raw, requests,
 *                tier_requests, rpm, starts_at, ends_at}
 *   reversal    {account_id, payment_id, amount_raw, why}   (reorg reconciliation)
 *   adjustment  {account_id, amount_raw (signed), note, operator: true}  (CLI only)
 *   config      {treasury, previous, start_block}           (audit trail, at boot)
 * `tier_price_raw` and `tier_requests` are the tier's full 30-day price and
 * quota when the charge was made. An upgrade charges the price difference for
 * the time left and adds the quota difference for the same time left (its
 * `requests` is the period's new total), and a comp charges nothing, so later
 * upgrades price against them, never against today's table.
 * credit = Σpayment − Σreversal − Σcharge.price_raw + Σadjustment.
 *
 * ── API ─────────────────────────────────────────────────────────────────────
 *
 *   const config = parseBillingConfig(process.env);   // pure; log config.notes
 *   const billing = await createBilling({ ...config,
 *     publicClient: config.rpc ? createPaymentsClient(config.rpc) : null });
 *   // SIGTERM/SIGINT: server.close(); await billing.close(); process.exit(0)
 *
 * createBilling options (dataDir required):
 *   dataDir, mode ("off"|"observe"|"enforce"), treasury, previousTreasuries,
 *   startBlock, minConfirmations, minAgeSec  — as parseBillingConfig returns them
 *   publicClient   viem client for chain reads (createPaymentsClient); null = no payments
 *   now            clock (ms); billing.now() is the clock, or the ledger's latest record
 *                  when that is ahead of it by at most 5 minutes (a clock step back)
 *   log            one string per call; default console.error
 *   plans          the plan table (lib/billing-plans.mjs PLANS)
 *   keyRegistry    async () => Map of partner keys (lib/partners.mjs loadRegistry),
 *                  for the Free window anchor
 *   timers         false in tests: no 10 s tail/flush or 5 min reconcile timers
 *   readTimeoutMs  per chain read (10 s); give createPaymentsClient the same timeoutMs
 *   settleWaitMs   how long prepare() waits for a settle (2 s)
 *   readOnly       the operator CLI's view: no write probe, no config line, no timers
 *   writeLine      (file, line) => Promise, the append itself; tests inject failures here
 * The returned object has `mode` (effective, after the durability and ledger
 * checks), `enforced`, `paymentsReady` and `blocked` (null, or why billing
 * writes are refused).
 *
 * Developer routes. Each returns {status, json}; refusals use the developer
 * envelope {error:{code, message, ...}}. The caller does sign-in and rate limits.
 *   plansView()                         GET /plans
 *   accountView(owner)                  GET /account (pure: never appends)
 *   hasAccount(owner) -> boolean        POST /keys answers 409 account_required without one
 *   createAccount(owner, name)          POST /account -> 201 account view
 *   choosePlan(owner, {tier, confirm})  POST /plan: preview unless confirm === true
 *   submitPayment(owner, txHash)        POST /payments
 * Account view: {account:{id, name, wallet, created_at}, plan:{id, name, starts_at,
 *   ends_at, selected, renews_on_next_request}, credit_raw, credit_tokens, due_raw,
 *   due_tokens, due_for ("activation"|"upgrade"|"renewal"|null), usage:{used, limit,
 *   resets_at, by_key:[{key_id, used}]}, history:[newest first, at most 50]}.
 * Preview: {preview:true, tier, effect ("activate_now"|"upgrade_now"|"at_renewal"|
 *   "waiting_for_payment"|"cancel_renewal"), charge_now_raw, charge_now_tokens,
 *   due_raw, due_tokens, starts_at, ends_at}.
 * Payment: 200 {already, payment?:{tx_hash, amount_raw, amount_tokens,
 *   block_number}, ...account view}; 202 {code:"payment_pending", stage:
 *   "not_found_yet"|"confirming", tx_hash, confirmations?, needed?, ready_in_sec?}.
 * Codes: 400 invalid_address | invalid_name | invalid_tier | invalid_tx_hash;
 *   404 account_missing; 409 account_exists; 422 payment_failed |
 *   payment_not_found (reason: wrong_token|wrong_sender|wrong_recipient|
 *   before_start_block) | payment_too_small | payment_unsupported;
 *   503 billing_off | payments_unavailable | chain_unavailable | billing_unavailable.
 *
 * Partner gate, for a key with an owner (an operator key has none and is never
 * metered), after key and scope checks:
 *   billing.nextPlanFor(owner, keyCreatedAt) -> {id, name, requests, rpm, starts_at, ends_at}
 *                                       the plan the request is served on once a due charge is
 *                                       made (pure); rpm is per ACCOUNT: bucket it by owner
 *   await billing.prepare(owner)        settles first when one is due (2 s, then fail open)
 *   billing.planFor(owner, keyCreatedAt) the plan as it stands, before any due charge
 *   billing.reserve({owner, keyId, keyCreatedAt}) synchronous, counts the request:
 *     {ok:true, metered, ticket, headers}  or  {ok:false, status:402, error:{code:
 *     "quota_exhausted", message, plan, limit, used, resets_at, upgrade_url}, headers}
 *     (the caller adds request_id; headers carry the quota and retry-after)
 *   billing.release(ticket)             when isPlatformFailure(status, code) holds
 *   billing.meta(owner, keyCreatedAt) -> {billing|null, rate_per_min|null, headers} for /meta
 *   quotaHeaders(...) and isPlatformFailure(...) are exported.
 *
 * Operations: tail() picks up the CLI's lines (every 10 s on its own),
 * reconcile({all, dryRun}) re-verifies recent payments (every 5 min), flush()
 * writes usage.json, close() stops the timers, drains the queue and flushes.
 */

import { randomBytes } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createPublicClient, defineChain, http } from "viem";
import { loadRegistry, repairTail } from "./partners.mjs";
import { ONE_TOKEN, PERIOD_DAYS, PERIOD_MS, PLANS, TOKEN, ceilTokens, formatTokens, validatePlans } from "./billing-plans.mjs";

export const LEDGER_FILE = "billing.jsonl";
export const USAGE_FILE = "usage.json";
export const UPGRADE_URL = "https://merrymen.dev/api#plans";
export const MODES = Object.freeze(["off", "observe", "enforce"]);

const MAX_LINE_BYTES = 4096;
const TAIL_MS = 10_000;
const USAGE_FLUSH_MS = 10_000;
const RECONCILE_MS = 5 * 60_000;
const RECONCILE_WINDOW_MS = 30 * 60_000;
const SETTLE_WAIT_MS = 2_000;
const READ_TIMEOUT_MS = 10_000;
const CLOSE_DRAIN_MS = 5_000;
/**
 * How far the ledger's latest record may hold billing time ahead of this
 * host's clock. A step back of the clock within it is absorbed (time does not
 * run backwards); a record from further ahead (a clock that ran fast for one
 * write) must not pin billing time there, ending every paid period early.
 */
const MAX_AHEAD_MS = 5 * 60_000;
const HISTORY = 50;
/** More matching logs than this in one transaction is not a payment anybody sends by hand. */
const MAX_LOGS = 256;
/** Chain 4663 makes 9–10 blocks a second. Used only to estimate ready_in_sec. */
const BLOCK_MS = 100;
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const ADDRESS = /^0x[0-9a-f]{40}$/;
const HASH = /^0x[0-9a-f]{64}$/;
const RAW = /^(0|[1-9]\d{0,40})$/;
const SIGNED_RAW = /^(0|-?[1-9]\d{0,40})$/;
const TIER = /^[a-z][a-z0-9_-]{0,31}$/;
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const REASONS = ["activate", "renew", "upgrade", "comp"];

const hex = (bytes) => randomBytes(bytes).toString("hex");
const iso = (ms) => new Date(ms).toISOString();
const lower = (v) => (typeof v === "string" ? v.toLowerCase() : "");
const safeTime = (v) => Number.isSafeInteger(v) && v >= 0;
const tierOf = (plans, id) => (typeof id === "string" && Object.hasOwn(plans, id) ? plans[id] : null);
/** Log-safe error naming: never err.message, which for an RPC error carries its URL (and any key in it). */
const errName = (err) => String(err?.code ?? err?.name ?? "Error").replace(/[^\w.-]/g, "").slice(0, 60) || "Error";

// ── configuration ────────────────────────────────────────────────────────────

/**
 * Billing is OFF unless every requirement holds; each reason it is not is a
 * line in `notes` for the server to log at boot. Pure: the writability of the
 * data directory and the RPC's chain are checked by createBilling.
 *
 * DURABILITY GATE. The ledger is the only record of who paid. On a disk that a
 * deploy wipes (the default /data with no volume, render.yaml's service), every
 * past transfer becomes creditable again. So billing needs MERRYMEN_DATA_DIR set
 * explicitly, and a single process: two would each keep their own index and
 * credit one transfer twice.
 */
export function parseBillingConfig(env = process.env) {
  const notes = [];
  const shown = (v) => JSON.stringify(String(v).slice(0, 80));
  const requested = String(env.MERRYMEN_BILLING ?? "").trim().toLowerCase() || "off";
  let mode = MODES.includes(requested) ? requested : "off";
  if (mode !== requested) notes.push(`MERRYMEN_BILLING=${shown(requested)} is not off, observe or enforce: billing is off`);

  const dataDirExplicit = String(env.MERRYMEN_DATA_DIR ?? "").trim() !== "";
  const dataDir = dataDirExplicit ? env.MERRYMEN_DATA_DIR.trim() : "/data";

  const address = (raw, name) => {
    const v = String(raw ?? "").trim().toLowerCase();
    if (!v) return null;
    // The token contract and the zero address can hold nothing for us: a
    // transfer "to" either is a mistake or a burn, and neither is a payment.
    if (!ADDRESS.test(v) || v === ZERO_ADDRESS || v === TOKEN.address) {
      notes.push(`${name} ${shown(raw)} is not a usable address: ignored`);
      return null;
    }
    return v;
  };
  let treasury = address(env.MERRYMEN_PAYMENTS_TREASURY, "MERRYMEN_PAYMENTS_TREASURY");
  const previous = [...new Set(String(env.MERRYMEN_PAYMENTS_PREVIOUS_TREASURIES ?? "").split(",")
    .map((s) => s.trim()).filter(Boolean)
    .map((s) => address(s, "MERRYMEN_PAYMENTS_PREVIOUS_TREASURIES entry")).filter(Boolean))]
    .filter((a) => a !== treasury);

  const rawStart = String(env.MERRYMEN_PAYMENTS_START_BLOCK ?? "").trim();
  let startBlock = /^\d{1,15}$/.test(rawStart) ? Number(rawStart) : null;
  if (rawStart && startBlock === null) notes.push(`MERRYMEN_PAYMENTS_START_BLOCK ${shown(rawStart)} is not a block number`);
  // Without a floor, every transfer this address ever received from a signed-in
  // wallet would be claimable, however old and whatever it was for.
  if (treasury && startBlock === null) {
    notes.push("MERRYMEN_PAYMENTS_TREASURY needs MERRYMEN_PAYMENTS_START_BLOCK: payments are unavailable");
    treasury = null;
  }

  const int = (raw, fallback, min, name) => {
    const v = String(raw ?? "").trim();
    if (!v) return fallback;
    if (/^\d{1,9}$/.test(v) && Number(v) >= min) return Number(v);
    notes.push(`${name} ${shown(v)} must be an integer of at least ${min}: using ${fallback}`);
    return fallback;
  };
  const minConfirmations = int(env.MERRYMEN_PAYMENTS_MIN_CONFIRMATIONS, 64, 1, "MERRYMEN_PAYMENTS_MIN_CONFIRMATIONS");
  const minAgeSec = int(env.MERRYMEN_PAYMENTS_MIN_AGE_SEC, 120, 0, "MERRYMEN_PAYMENTS_MIN_AGE_SEC");
  const rpc = String(env.MERRYMEN_PAYMENTS_RPC ?? "").trim() || String(env.MERRYMEN_GATEWAY_RPC ?? "").trim() || null;

  if (mode !== "off" && !dataDirExplicit) {
    notes.push("billing needs MERRYMEN_DATA_DIR set explicitly to a persistent volume, on a single instance: billing is off");
    mode = "off";
  }
  if (mode === "enforce" && !treasury) {
    notes.push("enforce needs MERRYMEN_PAYMENTS_TREASURY and MERRYMEN_PAYMENTS_START_BLOCK: running observe");
    mode = "observe";
  }
  if (mode === "observe" && !treasury) notes.push("no payments treasury: plans, accounts and metering work; payments answer 503 payments_unavailable");
  return { requested, mode, dataDir, dataDirExplicit, treasury, previousTreasuries: treasury ? previous : [], startBlock,
    minConfirmations, minAgeSec, rpc, notes };
}

/**
 * The payments chain client: separate from the holder gate's, with no retries
 * and no block-number cache. A retried read can triple a 10 s stall, and a
 * cached head under-counts confirmations.
 */
export function createPaymentsClient(url, { timeoutMs = READ_TIMEOUT_MS } = {}) {
  const chain = defineChain({ id: TOKEN.chainId, name: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [url] } } });
  return createPublicClient({ chain, transport: http(url, { timeout: timeoutMs, retryCount: 0 }), cacheTime: 0 });
}

async function probeWritable(dir) {
  const probe = path.join(dir, `.billing-probe-${hex(6)}`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(probe, "ok", { flush: true });
    await rm(probe, { force: true });
    return null;
  } catch (err) {
    return errName(err);
  }
}

// ── replay ───────────────────────────────────────────────────────────────────

class Corrupt extends Error {}
/** Thrown by append when billing writes are refused; routes answer 503 billing_unavailable. */
export class BillingUnavailable extends Error {
  constructor(reason) { super(`billing writes are unavailable: ${reason}`); this.reason = reason; }
}

function emptyState() {
  return { ids: new Set(), chargeIds: new Set(), periods: new Map(), accounts: new Map(), byOwner: new Map(),
    payments: new Map(), paymentKeys: new Map(), config: null, maxAt: 0, corrupt: null, ignored: 0 };
}

const paymentKey = (chainId, txHash, from) => `${chainId}:${txHash}:${from}`;

/** Each returns a reason to ignore the record, or nothing once applied. */
const APPLY = {
  account(s, r) {
    if (!/^acct_[0-9a-f]{24}$/.test(r.account_id) || !ADDRESS.test(r.owner) || typeof r.name !== "string") return "malformed account";
    if (s.accounts.has(r.account_id)) return `repeated account ${r.account_id}`;
    if (s.byOwner.has(r.owner)) return `${r.owner} already has an account`;
    const a = { account_id: r.account_id, owner: r.owner, name: r.name, created_at: r.at, selected: "free",
      credit: 0n, gross: 0n, periods: [], history: [] };
    s.accounts.set(a.account_id, a);
    s.byOwner.set(a.owner, a);
  },
  select(s, r, a) {
    if (!TIER.test(r.tier ?? "")) return "malformed select";
    a.selected = r.tier;
  },
  payment(s, r, a) {
    if (r.owner !== a.owner || !Number.isSafeInteger(r.chain_id) || !ADDRESS.test(r.token ?? "") || !ADDRESS.test(r.recipient ?? "")
      || !HASH.test(r.tx_hash ?? "") || !safeTime(r.block_number) || !HASH.test(r.block_hash ?? "")
      || !RAW.test(r.amount_raw ?? "") || r.amount_raw === "0" || !Array.isArray(r.log_indexes)) return "malformed payment";
    const key = paymentKey(r.chain_id, r.tx_hash, r.owner);
    if (s.paymentKeys.has(key)) return `transfer ${r.tx_hash} from ${r.owner} is already credited`;
    const amount = BigInt(r.amount_raw);
    s.payments.set(r.id, { id: r.id, account_id: a.account_id, owner: a.owner, key, tx_hash: r.tx_hash,
      block_number: r.block_number, block_hash: r.block_hash, recipient: r.recipient, amount, at: r.at, reversed: false });
    s.paymentKeys.set(key, r.id);
    a.credit += amount;
    a.gross += amount;
    a.history.push(r);
  },
  charge(s, r, a) {
    if (!/^chg_[0-9a-f]{24}$/.test(r.charge_id ?? "") || !/^per_[0-9a-f]{24}$/.test(r.period_id ?? "") || !REASONS.includes(r.reason)
      || !TIER.test(r.tier ?? "") || !RAW.test(r.price_raw ?? "") || (r.tier_price_raw !== undefined && !RAW.test(r.tier_price_raw))
      || !Number.isSafeInteger(r.requests) || r.requests < 0 || !Number.isSafeInteger(r.rpm) || r.rpm < 1
      || (r.tier_requests !== undefined && (!Number.isSafeInteger(r.tier_requests) || r.tier_requests < 0))
      || !safeTime(r.starts_at) || !safeTime(r.ends_at) || r.ends_at <= r.starts_at) return "malformed charge";
    if (s.chargeIds.has(r.charge_id)) return `repeated charge ${r.charge_id}`;
    const price = BigInt(r.price_raw);
    let period = null;
    if (r.reason === "upgrade") {
      period = s.periods.get(r.period_id);
      if (!period || period.account_id !== a.account_id) return `upgrade of unknown period ${r.period_id}`;
    } else {
      if (s.periods.has(r.period_id)) return `repeated period ${r.period_id}`;
      if (r.reason === "comp" && price !== 0n) return "a comp charges nothing";
    }
    // settle() charges only what credit covers, and credit never exceeds what
    // was paid or granted. A charge beyond that means a payment line is gone:
    // stop here rather than guess which.
    if (price > 0n && a.gross < price) throw new Corrupt(`charge ${r.charge_id} exceeds everything ${a.owner} paid`);
    a.credit -= price;
    a.gross -= price;
    s.chargeIds.add(r.charge_id);
    const terms = { tier: r.tier, requests: r.requests, rpm: r.rpm, tier_price: BigInt(r.tier_price_raw ?? r.price_raw),
      tier_requests: r.tier_requests ?? r.requests };
    // `bought`: the period's tier is one the developer paid for (activated,
    // renewed or upgraded to), not only an operator's comp.
    if (period) Object.assign(period, terms, { bought: true });
    else {
      period = { period_id: r.period_id, account_id: a.account_id, reason: r.reason, starts_at: r.starts_at, ends_at: r.ends_at, ...terms,
        bought: r.reason !== "comp" };
      s.periods.set(period.period_id, period);
      a.periods.push(period);
    }
    a.history.push(r);
  },
  reversal(s, r, a) {
    const p = s.payments.get(r.payment_id);
    if (!p || p.account_id !== a.account_id || !RAW.test(r.amount_raw ?? "") || typeof r.why !== "string") return "malformed reversal";
    if (p.reversed) return `payment ${r.payment_id} is already reversed`;
    const amount = BigInt(r.amount_raw);
    if (amount > p.amount) return "reversal larger than its payment";
    p.reversed = true;
    // The transfer may be credited again: a reorg that MOVED it, rather than
    // dropping it, leaves a real payment that is final once it is deep enough.
    if (s.paymentKeys.get(p.key) === p.id) s.paymentKeys.delete(p.key);
    a.credit -= amount;
    a.history.push({ ...r, tx_hash: p.tx_hash });
  },
  adjustment(s, r, a) {
    if (!SIGNED_RAW.test(r.amount_raw ?? "") || r.operator !== true || typeof r.note !== "string") return "malformed adjustment";
    const amount = BigInt(r.amount_raw);
    a.credit += amount;
    if (amount > 0n) a.gross += amount;
    a.history.push(r);
  },
  config(s, r) {
    if (!(r.treasury === null || ADDRESS.test(r.treasury ?? "")) || !Array.isArray(r.previous)
      || !r.previous.every((x) => ADDRESS.test(x ?? "")) || !(r.start_block === null || safeTime(r.start_block))) return "malformed config";
    s.config = { treasury: r.treasury, previous: r.previous, start_block: r.start_block, at: r.at };
  },
};
const UNSCOPED = new Set(["account", "config"]);

function applyRecord(s, r) {
  if (!r || typeof r !== "object" || Array.isArray(r)) return "not a record";
  if (typeof r.id !== "string" || !/^[0-9a-f]{32}$/.test(r.id)) return "no record id";
  if (s.ids.has(r.id)) return `repeated id ${r.id}`;
  s.ids.add(r.id);
  if (!safeTime(r.at)) return "time is not a safe integer";
  if (typeof r.type !== "string" || !Object.hasOwn(APPLY, r.type)) return "unknown type";
  let a;
  if (!UNSCOPED.has(r.type)) {
    a = s.accounts.get(r.account_id);
    if (!a) return "unknown account";
  }
  const why = APPLY[r.type](s, r, a);
  if (why) return why;
  if (r.at > s.maxAt) s.maxAt = r.at;
  return null;
}

/**
 * Replay complete lines, in file order. A line without its newline is a torn
 * write and is not read. An unreadable COMPLETE line is corruption: torn tails
 * are cut before every append, so one can only come from outside this code.
 */
export function replayLedger(buf, { log = () => {}, skip = new Set() } = {}) {
  const s = emptyState();
  const bytes = buf.lastIndexOf(0x0a) + 1;
  const lines = buf.subarray(0, bytes).toString("utf8").split("\n");
  lines.pop();
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]) continue;
    let rec;
    try { rec = JSON.parse(lines[i]); } catch { s.corrupt = { line: i + 1, reason: "unreadable line" }; break; }
    if (rec && skip.has(rec.id)) continue;
    try {
      const why = applyRecord(s, rec);
      if (why) { s.ignored += 1; log(`[billing] ledger line ${i + 1} ignored: ${why}`); }
    } catch (err) {
      if (!(err instanceof Corrupt)) throw err;
      s.corrupt = { line: i + 1, reason: err.message };
      break;
    }
  }
  return { state: s, bytes };
}

// ── the writer ───────────────────────────────────────────────────────────────

const appendLine = (file, line) => appendFile(file, line, { encoding: "utf8", flush: true });
/** What another process may append while the gateway runs: the operator CLI's records. */
const tailAccepts = (r) => r?.type === "adjustment" || r?.type === "config" || (r?.type === "charge" && r.reason === "comp");

/**
 * The ledger file, its replayed index, and the ONE queue every billing write
 * goes through. Shared by createBilling and billing-cli.mjs, so the CLI appends
 * with the same repair and flush. `append` must run inside `enqueue`.
 */
export async function openLedger({ dataDir, now: clock = Date.now, log = console.error, writeLine = appendLine } = {}) {
  if (!dataDir) throw new Error("openLedger: dataDir is required");
  const file = path.join(dataDir, LEDGER_FILE);
  let state = emptyState();
  let offset = 0;
  let failed = false;
  let fatal = null;
  const rejected = new Set();
  let queue = Promise.resolve();

  async function rebuild() {
    let buf;
    try { buf = await readFile(file); } catch (err) { if (err.code !== "ENOENT") throw err; buf = Buffer.alloc(0); }
    const r = replayLedger(buf, { log, skip: rejected });
    state = r.state;
    offset = r.bytes;
    if (state.corrupt && fatal !== "corrupt") {
      fatal = "corrupt";
      log(`[billing] LEDGER CORRUPT at ${LEDGER_FILE} line ${state.corrupt.line}: ${state.corrupt.reason}. Billing writes are refused until an operator repairs it; reads and metering use the records before that line.`);
    }
  }
  try { await rebuild(); } catch (err) {
    fatal = "unreadable";
    log(`[billing] cannot read ${file} (${errName(err)}): billing writes are refused`);
  }

  const blocked = () => fatal ?? (failed ? "failed" : null);
  let warnedAhead = 0;
  /**
   * Billing time: the clock, or the ledger's latest record when that is ahead
   * by no more than MAX_AHEAD_MS, so a clock step back does not reopen ended
   * periods or rewind usage windows. A record from further ahead is logged
   * and otherwise ignored here: one write made while the host clock ran a
   * year fast must not end every paid period and renew it at that time.
   */
  const nowMs = () => {
    const c = clock();
    if (state.maxAt > c + MAX_AHEAD_MS && warnedAhead !== state.maxAt) {
      warnedAhead = state.maxAt;
      log(`[billing] CLOCK: ${LEDGER_FILE} has a record from ${iso(state.maxAt)}, ${Math.round((state.maxAt - c) / 60_000)} min ahead of this host's clock (${iso(c)}). Billing time follows the clock (at most ${MAX_AHEAD_MS / 60_000} min ahead of it); check the host's clock.`);
    }
    return Math.max(c, Math.min(state.maxAt, c + MAX_AHEAD_MS));
  };

  function enqueue(fn) {
    const run = queue.then(fn);
    queue = run.then(() => {}, () => {});
    return run;
  }

  /** Cut a torn tail and re-read the file, so the index is exactly what is on disk. */
  async function repair() {
    const removed = await repairTail(file);
    if (removed) log(`[billing] ${LEDGER_FILE} ended in a torn line: removed ${removed} bytes`);
    await rebuild();
  }

  /** Inside the queue: retry a pending repair, then say whether writes may go ahead. */
  async function writable() {
    if (failed && !fatal) {
      try { await repair(); failed = false; log("[billing] ledger repaired: writes resume"); } catch (err) { log(`[billing] ledger repair failed (${errName(err)})`); }
    }
    return blocked() === null;
  }

  async function append(fields, { at } = {}) {
    if (!(await writable())) throw new BillingUnavailable(blocked());
    await mkdir(dataDir, { recursive: true });
    // Before every append, not only the first: the CLI writes this file too.
    if (await repairTail(file)) { log(`[billing] ${LEDGER_FILE} ended in a torn line: cut before appending`); await rebuild(); }
    if (blocked()) throw new BillingUnavailable(blocked());
    const rec = { id: hex(16), type: fields.type, at: at ?? nowMs(), ...fields };
    const line = `${JSON.stringify(rec)}\n`;
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error(`ledger record over ${MAX_LINE_BYTES} bytes`);
    try {
      await writeLine(file, line);
    } catch (err) {
      // Some of the line, or all of it, may be on disk. Until the file is cut
      // back to a complete line and re-read, nothing more is written.
      failed = true;
      log(`[billing] ledger append failed (${errName(err)}): billing writes are refused until it is repaired`);
      try { await repair(); failed = false; log("[billing] ledger repaired: writes resume"); } catch (e) { log(`[billing] ledger repair failed (${errName(e)})`); }
      throw new BillingUnavailable("failed");
    }
    try {
      const why = applyRecord(state, rec);
      if (why) log(`[billing] own record ${rec.id} ignored on apply: ${why}`);
    } catch (err) {
      if (!(err instanceof Corrupt)) throw err;
      fatal = "corrupt";
      log(`[billing] LEDGER CORRUPT: own record ${rec.id}: ${err.message}`);
    }
    return rec;
  }

  /**
   * Pick up complete lines another process appended. The operator CLI may add
   * adjustments, comps and config; anything else means a second gateway is
   * writing this ledger, which double-credits (each keeps its own index), so it
   * is kept out of the index and writes stop until restart.
   *
   * Inside the queue. Reads only what lies past the lines already replayed,
   * and nothing at all when the file has not grown, so settle() runs it before
   * every charge: an operator's comp written seconds ago must be seen before a
   * renewal is paid for alongside it, not up to 10 s later.
   */
  async function catchUp() {
    const none = { foreign: 0, rejected: 0 };
    if (fatal === "unreadable") return none;
    let fh;
    try { fh = await open(file, "r"); } catch (err) { if (err.code === "ENOENT") return none; throw err; }
    let buf;
    try {
      const { size } = await fh.stat();
      if (size < offset) { await rebuild(); return none; } // cut back by another process's repair
      if (size === offset) return none;
      buf = Buffer.alloc(size - offset);
      buf = buf.subarray(0, (await fh.read(buf, 0, buf.length, offset)).bytesRead);
    } finally {
      await fh.close();
    }
    const fresh = buf.subarray(0, buf.lastIndexOf(0x0a) + 1);
    let foreign = 0, refused = 0;
    for (const line of fresh.toString("utf8").split("\n")) {
      if (!line) continue;
      let rec = null;
      try { rec = JSON.parse(line); } catch { foreign += 1; continue; } // rebuild reports it as corruption
      if (typeof rec?.id === "string" && state.ids.has(rec.id)) continue;
      foreign += 1;
      if (tailAccepts(rec)) continue;
      refused += 1;
      if (typeof rec?.id === "string") rejected.add(rec.id);
      fatal = "foreign_writer";
      log(`[billing] ANOTHER PROCESS APPENDED A ${String(rec?.type).slice(0, 20)} RECORD to ${LEDGER_FILE}. Billing must run on one instance only. Billing writes are refused until restart.`);
    }
    if (foreign) await rebuild();
    else offset += fresh.length;
    return { foreign, rejected: refused };
  }

  function tail() {
    return enqueue(async () => {
      if (failed) await writable(); // every 10 s, so a repair does not wait for the next payment
      return catchUp();
    });
  }

  return {
    file,
    get state() { return state; },
    blocked,
    /** Refused until restart: corrupt, unreadable, or a second writer. A failed append is not fatal. */
    get fatal() { return fatal; },
    writable,
    now: nowMs,
    enqueue,
    append,
    tail,
    /** tail() from inside the queue. */
    catchUp,
    rebuild: () => enqueue(rebuild),
  };
}

// ── plan rules (pure) ────────────────────────────────────────────────────────

/**
 * The period running now. settle() opens a period only when none runs, so
 * there is normally one; only an operator's comp can overlap another. Then the
 * dearest tier (as sold) wins, a tie going to the later line: a comp never
 * hides a better period the developer paid for, nor makes settle charge an
 * "upgrade" back to a tier a hidden period already gives. A dearer comp gives
 * its tier while it runs, and the paid period resumes, with its own usage
 * window, if it is still running when the comp ends. starts_at is not
 * consulted: a clock step back must not end a plan.
 */
export function activePeriod(acct, now) {
  let best = null;
  for (const p of acct.periods) if (p.ends_at > now && (!best || p.tier_price >= best.tier_price)) best = p;
  return best;
}

/**
 * What moving the rest of a period to a dearer tier costs: the price
 * difference for the time left, rounded down. Priced against what the period
 * was SOLD at, so a table edit cannot change it, and it only falls as the
 * period runs, so an amount quoted earlier always covers it.
 */
export function upgradeRaw(newPrice, oldPrice, endsAt, now) {
  const left = BigInt(Math.min(Math.max(endsAt - now, 0), PERIOD_MS));
  return ((newPrice - oldPrice) * left) / BigInt(PERIOD_MS);
}

/**
 * The request quota a period has after moving the rest of it to a dearer
 * tier: what it had, plus the tiers' quota difference for the time left,
 * rounded down. The same share of the period as upgradeRaw() charges for, so
 * a late upgrade buys a late upgrade's worth of requests: Feast's full
 * million for two days' price difference would sell most of a Feast period at
 * a fraction of its price. A tier with fewer requests than the period's never
 * takes any away. The rate becomes the new tier's: it only caps how fast
 * that quota is used, for the time that is left.
 */
export function upgradeRequests(newRequests, oldTierRequests, current, endsAt, now) {
  const left = BigInt(Math.min(Math.max(endsAt - now, 0), PERIOD_MS));
  const more = BigInt(Math.max(0, newRequests - oldTierRequests));
  return current + Number((more * left) / BigInt(PERIOD_MS));
}

/** The period that ended last. */
function lastPeriod(acct) {
  let last = null;
  for (const p of acct.periods) if (!last || p.ends_at >= last.ends_at) last = p;
  return last;
}

/**
 * The one charge settle() would make now, or null. Rules, in order:
 *   negative credit: nothing (a reversal is unpaid; nothing is bought on it);
 *   no period running, a paid tier selected, credit covers it: activate (first
 *     ever) or renew, starting NOW: an idle gap is never paid for;
 *   a renewal the selection cannot fund renews the tier that just ended if
 *     credit covers that, so an unpaid upgrade never drops service to Free;
 *     but only a tier the developer paid for: an operator's comp is a gift,
 *     and when one ends only the developer's own selection is renewed;
 *   a period running and a dearer tier selected: one upgrade charge for the
 *     time left, keeping the period and its usage, when credit covers it;
 *   a cheaper tier, or Free, waits for the period to end.
 */
export function decide(acct, now, plans) {
  if (acct.credit < 0n) return null;
  const sel = acct.selected === "free" ? null : tierOf(plans, acct.selected);
  const active = activePeriod(acct, now);
  if (!active) {
    if (acct.selected === "free") return null;
    const had = acct.periods.length > 0;
    if (sel && sel.price_raw > 0n && acct.credit >= sel.price_raw) return { reason: had ? "renew" : "activate", plan: sel, price: sel.price_raw };
    if (!had) return null;
    const ended = lastPeriod(acct);
    const last = ended.bought ? tierOf(plans, ended.tier) : null;
    if (last && last.price_raw > 0n && acct.credit >= last.price_raw) return { reason: "renew", plan: last, price: last.price_raw };
    return null;
  }
  if (!sel || sel.id === active.tier || sel.price_raw <= active.tier_price) return null;
  const price = upgradeRaw(sel.price_raw, active.tier_price, active.ends_at, now);
  if (acct.credit < price) return null;
  return { reason: "upgrade", plan: sel, price, period: active,
    requests: upgradeRequests(sel.requests, active.tier_requests, active.requests, active.ends_at, now) };
}

/** settle() run on a copy: what it would charge, and the account after. */
function simulate(acct, now, plans, selected = acct.selected) {
  const sim = { ...acct, selected, periods: acct.periods.map((p) => ({ ...p })) };
  const actions = [];
  for (let i = 0; i < 4; i++) {
    const act = decide(sim, now, plans);
    if (!act) break;
    actions.push(act);
    sim.credit -= act.price;
    const terms = { tier: act.plan.id, requests: act.requests ?? act.plan.requests, rpm: act.plan.rpm,
      tier_price: act.plan.price_raw, tier_requests: act.plan.requests };
    if (act.period) Object.assign(act.period, terms, { bought: true });
    else sim.periods.push({ period_id: `sim_${i}`, reason: act.reason, starts_at: now, ends_at: now + PERIOD_MS, ...terms, bought: true });
  }
  return { sim, actions };
}

/** What the developer still has to send for the selected tier to start, upgrade or renew. */
function dueFor(acct, now, plans) {
  const sel = acct.selected === "free" ? null : tierOf(plans, acct.selected);
  if (!sel) return null;
  const active = activePeriod(acct, now);
  let needed, why;
  if (!active) { needed = sel.price_raw; why = acct.periods.length ? "renewal" : "activation"; }
  else if (sel.id !== active.tier && sel.price_raw > active.tier_price) {
    needed = upgradeRaw(sel.price_raw, active.tier_price, active.ends_at, now);
    why = "upgrade";
  } else { needed = sel.price_raw; why = "renewal"; }
  const due = needed - acct.credit;
  return due > 0n ? { raw: due, why } : null;
}

function chargeFor(acct, act, now) {
  return { type: "charge", account_id: acct.account_id, charge_id: `chg_${hex(12)}`,
    period_id: act.period ? act.period.period_id : `per_${hex(12)}`, reason: act.reason, tier: act.plan.id,
    price_raw: act.price.toString(), tier_price_raw: act.plan.price_raw.toString(),
    requests: act.requests ?? act.plan.requests, tier_requests: act.plan.requests, rpm: act.plan.rpm,
    starts_at: now, ends_at: act.period ? act.period.ends_at : now + PERIOD_MS };
}

// ── chain reads ──────────────────────────────────────────────────────────────

class ChainError extends Error {}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new ChainError("timeout")), ms); timer.unref?.(); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function topicAddress(topic) {
  const t = lower(topic);
  return /^0x0{24}[0-9a-f]{40}$/.test(t) ? `0x${t.slice(26)}` : null;
}

/**
 * The ERC-20 Transfers in a receipt that pay `owner`'s account: the token's own
 * contract, exactly three topics (ERC-721 shares topic0 with four), one 32-byte
 * value, not removed, from the owner to a payments address, and not to itself.
 * When nothing matches, `reason` names the narrowest step that failed.
 */
export function matchTransfers(logs, { owner, recipients }) {
  const transfers = [];
  for (const log of logs ?? []) {
    if (log?.removed === true || lower(log?.address) !== TOKEN.address) continue;
    const topics = Array.isArray(log.topics) ? log.topics : [];
    if (topics.length !== 3 || lower(topics[0]) !== TRANSFER_TOPIC || !/^0x[0-9a-fA-F]{64}$/.test(log.data ?? "")) continue;
    const from = topicAddress(topics[1]), to = topicAddress(topics[2]);
    if (from && to) transfers.push({ from, to, value: BigInt(log.data), logIndex: Number(log.logIndex) });
  }
  if (!transfers.length) return { reason: "wrong_token" };
  const sent = transfers.filter((t) => t.from === owner && t.to !== owner);
  if (!sent.length) return { reason: "wrong_sender" };
  const ours = sent.filter((t) => recipients.has(t.to));
  if (!ours.length) return { reason: "wrong_recipient" };
  const paid = ours.filter((t) => t.value > 0n);
  return { amount: paid.reduce((sum, t) => sum + t.value, 0n), logIndexes: paid.map((t) => t.logIndex),
    recipient: (paid[0] ?? ours[0]).to };
}

// ── metering helpers (pure) ──────────────────────────────────────────────────

/** Headers on every metered response and on /meta. remaining is never negative. */
export function quotaHeaders({ limit, used, resetsAt, enforced }) {
  return {
    "x-merrymen-quota-limit": String(limit),
    "x-merrymen-quota-remaining": String(Math.max(0, limit - used)),
    "x-merrymen-quota-reset": String(Math.ceil(resetsAt / 1000)),
    "x-merrymen-quota-enforced": enforced ? "true" : "false",
  };
}

/**
 * A request the platform failed gives its unit back: the gateway or runtime
 * could not answer (5xx, upstream_*), or was busy (409 conversation_busy /
 * enrollment_busy, which the contract says to resend). A partner's own
 * mistake (any other 4xx) stays counted.
 */
export function isPlatformFailure(status, code) {
  return status >= 500 || (status === 409 && (code === "conversation_busy" || code === "enrollment_busy"))
    || (typeof code === "string" && code.startsWith("upstream_"));
}

function parseTime(v) {
  if (Number.isSafeInteger(v)) return v;
  if (typeof v !== "string" || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

const validName = (name) => typeof name === "string" && !!name.trim() && name.length <= 48
  && !/[\x00-\x1f\x7f]/.test(name) && name.isWellFormed();

// ── the service ──────────────────────────────────────────────────────────────

export async function createBilling({
  dataDir, mode = "off", treasury = null, previousTreasuries = [], startBlock = null,
  minConfirmations = 64, minAgeSec = 120, publicClient = null,
  now: clock = Date.now, log = console.error, plans = PLANS, keyRegistry = loadRegistry,
  timers = true, writeLine, readTimeoutMs = READ_TIMEOUT_MS, settleWaitMs = SETTLE_WAIT_MS, readOnly = false,
} = {}) {
  validatePlans(plans);
  if (!dataDir) throw new Error("createBilling: dataDir is required");
  if (!MODES.includes(mode)) { log(`[billing] unknown mode ${JSON.stringify(String(mode))}: billing is off`); mode = "off"; }
  // readOnly is the operator CLI's view of a running gateway's files: no probe,
  // no config line, no timers. It writes only through openLedger.
  if (readOnly) timers = false;
  if (mode !== "off" && !readOnly) {
    const why = await probeWritable(dataDir);
    if (why) { log(`[billing] ${dataDir} is not writable (${why}): billing is off`); mode = "off"; }
  }
  const ledger = await openLedger({ dataDir, now: clock, log, ...(writeLine ? { writeLine } : {}) });
  if (ledger.blocked() === "unreadable" && mode !== "off") { log("[billing] the ledger cannot be read: billing is off"); mode = "off"; }

  treasury = treasury ? lower(treasury) : null;
  const previous = [...new Set((previousTreasuries ?? []).map(lower))].filter((a) => ADDRESS.test(a) && a !== treasury);
  const recipients = new Set(treasury ? [treasury, ...previous] : []);
  let paymentsReady = mode !== "off" && !!treasury && Number.isSafeInteger(startBlock) && !!publicClient;
  const read = (p) => withTimeout(p, readTimeoutMs);
  if (paymentsReady) {
    try {
      const id = await read(publicClient.getChainId());
      if (id !== TOKEN.chainId) { paymentsReady = false; log(`[billing] PAYMENTS UNAVAILABLE: the payments RPC answers chain ${id}, not ${TOKEN.chainId}`); }
    } catch (err) {
      log(`[billing] could not confirm the payments RPC's chain at boot (${errName(err)}); it is checked before each credit`);
    }
  }

  // An audit line whenever where money goes changes: a swapped treasury must
  // leave a trace in the ledger it is paid into, not only in a deploy log.
  if (mode !== "off" && !readOnly) {
    await ledger.enqueue(async () => {
      const cur = { treasury, previous: [...previous].sort(), start_block: Number.isSafeInteger(startBlock) ? startBlock : null };
      const last = ledger.state.config;
      if (last && last.treasury === cur.treasury && last.start_block === cur.start_block
        && JSON.stringify([...last.previous].sort()) === JSON.stringify(cur.previous)) return;
      try {
        await ledger.append({ type: "config", ...cur });
        log(`[billing] PAYMENTS CONFIG RECORDED: treasury ${cur.treasury ?? "none"}, previous [${cur.previous.join(", ")}], start block ${cur.start_block ?? "none"}`);
      } catch (err) {
        log(`[billing] could not record the payments config (${errName(err)})`);
      }
    });
  }

  // ── usage counters ──
  const usageFile = path.join(dataDir, USAGE_FILE);
  /** `${owner}|${Free window start}` or `${owner}|${period_id}` -> {end, total, keys: Map(keyId -> n)} */
  const usage = new Map();
  let usageDirty = false;
  let usageWriting = null;
  if (mode !== "off") {
    try {
      const saved = JSON.parse(await readFile(usageFile, "utf8"));
      for (const [k, w] of Object.entries(saved?.windows ?? {})) {
        if (!/^0x[0-9a-f]{40}\|(\d+|per_[0-9a-f]{24})$/.test(k) || !safeTime(w?.end) || !safeTime(w?.total)) continue;
        const keys = new Map(Object.entries(w.keys ?? {}).filter(([, n]) => safeTime(n)));
        usage.set(k, { end: w.end, total: w.total, keys });
      }
    } catch (err) {
      if (err.code !== "ENOENT") log(`[billing] ${USAGE_FILE} is unreadable (${errName(err)}): usage counts start empty`);
    }
  }

  async function writeUsage() {
    const cutoff = ledger.now() - PERIOD_MS;
    const windows = {};
    for (const [k, w] of usage) {
      if (w.end < cutoff) { usage.delete(k); continue; }
      windows[k] = { end: w.end, total: w.total, keys: Object.fromEntries(w.keys) };
    }
    const tmp = `${usageFile}.tmp`;
    await mkdir(dataDir, { recursive: true });
    await writeFile(tmp, JSON.stringify({ v: 1, windows }), { encoding: "utf8", flush: true });
    await rename(tmp, usageFile);
  }

  /** usage.json, written whole and renamed into place. A crash loses at most the counts since the last flush. */
  async function flush() {
    while (usageWriting) await usageWriting;
    if (!usageDirty || mode === "off") return;
    usageDirty = false;
    usageWriting = writeUsage()
      .catch((err) => { usageDirty = true; log(`[billing] could not write ${USAGE_FILE} (${errName(err)})`); })
      .finally(() => { usageWriting = null; });
    await usageWriting;
  }

  // ── Free window anchors ──
  /**
   * A Free owner's 30-day windows start at their account's creation or their
   * first key, whichever came first, of ANY status: revoking the oldest key, or
   * creating an account late, must not move the window and hand out a fresh
   * quota. Revocations keep created_at in the registry, so the minimum is stable.
   */
  let keyAnchors = new Map();
  async function refreshAnchors() {
    try {
      const next = new Map(keyAnchors);
      for (const r of (await keyRegistry()).values()) {
        const t = parseTime(r.created_at);
        if (r.owner && t !== null && t < (next.get(r.owner) ?? Infinity)) next.set(r.owner, t);
      }
      keyAnchors = next;
    } catch (err) {
      log(`[billing] could not read the key registry for usage windows (${errName(err)})`);
    }
  }
  if (mode !== "off") await refreshAnchors();

  function anchorOf(owner, acct, keyCreatedAt) {
    const seen = parseTime(keyCreatedAt);
    if (seen !== null && seen < (keyAnchors.get(owner) ?? Infinity)) keyAnchors.set(owner, seen);
    const a = Math.min(acct?.created_at ?? Infinity, keyAnchors.get(owner) ?? Infinity);
    return Number.isFinite(a) ? a : 0;
  }

  const account = (owner) => ledger.state.byOwner.get(lower(owner)) ?? null;
  const nameOf = (tier) => tierOf(plans, tier)?.name ?? tier;

  /**
   * The plan a request is metered against, and its usage window's counter key.
   * A paid window is keyed by its period, which an upgrade keeps, so the count
   * carries over; keying it by its start could merge it with a Free window that
   * began in the same millisecond.
   */
  function planOf(owner, now, keyCreatedAt, acct = account(owner)) {
    const p = acct && activePeriod(acct, now);
    if (p) return { id: p.tier, name: nameOf(p.tier), requests: p.requests, rpm: p.rpm, start: p.starts_at, end: p.ends_at,
      period: true, window: `${owner}|${p.period_id}` };
    const anchor = anchorOf(owner, acct, keyCreatedAt);
    const start = anchor + Math.floor((now - anchor) / PERIOD_MS) * PERIOD_MS;
    const free = plans.free;
    return { id: "free", name: free.name, requests: free.requests, rpm: free.rpm, start, end: start + PERIOD_MS,
      period: false, window: `${owner}|${start}` };
  }

  const enforced = mode === "enforce";
  const quotaOf = (plan, used) => ({ limit: plan.requests, used, resetsAt: plan.end, enforced });

  function needsSettle(owner) {
    if (mode === "off" || ledger.fatal) return false;
    const acct = account(owner);
    return !!acct && decide(acct, ledger.now(), plans) !== null;
  }

  /**
   * The plan the NEXT metered request is served on: the plan as it stands,
   * or, when a charge is due, the plan that charge makes. Pure: nothing is
   * appended. The gate rate-limits with it, because it checks the rate before
   * the settle that makes the charge, and a renewal must not be refused at
   * Free's rate by the very request that would renew it.
   */
  function nextPlanOf(owner, now, keyCreatedAt) {
    const acct = account(owner);
    if (!acct || !needsSettle(owner)) return planOf(owner, now, keyCreatedAt, acct);
    return planOf(owner, now, keyCreatedAt, simulate(acct, now, plans).sim);
  }

  const missingNoted = new Set();
  async function settleLocked(owner) {
    let n = 0;
    if (mode !== "off" && account(owner)) {
      try { await ledger.catchUp(); } catch (err) { log(`[billing] could not read the ledger's new lines before settling (${errName(err)})`); }
    }
    for (let i = 0; i < 4; i++) {
      const acct = account(owner);
      if (mode === "off" || !acct || !(await ledger.writable())) break;
      const now = ledger.now();
      const act = decide(acct, now, plans);
      if (!act) {
        // "Renewing into a missing tier falls back to Free": say so once.
        const last = !activePeriod(acct, now) && acct.selected !== "free" && lastPeriod(acct);
        if (last && !tierOf(plans, acct.selected) && !missingNoted.has(`${owner}|${last.period_id}`)) {
          missingNoted.add(`${owner}|${last.period_id}`);
          log(`[billing] ${owner} selected ${acct.selected}, which is no longer a plan: it renews only into the tier that ended, or Free`);
        }
        break;
      }
      await ledger.append(chargeFor(acct, act, now), { at: now });
      n += 1;
      log(`[billing] ${owner} ${act.reason} ${act.plan.id}: ${formatTokens(act.price)} MERRYMEN of credit used`);
    }
    return n;
  }
  /** Apply what is due for `owner`. Only metered requests, payments and plan confirmations call this. */
  function settle(owner) {
    if (mode === "off") return Promise.resolve(0);
    return ledger.enqueue(() => settleLocked(lower(owner)));
  }

  const fail = (status, code, message, extra) => ({ status, json: { error: { code, message, ...extra } } });
  function unavailable(err) {
    if (!(err instanceof BillingUnavailable)) log(`[billing] write refused (${errName(err)})`);
    return fail(503, "billing_unavailable", "Billing is temporarily unavailable. Try again later.");
  }

  function historyEntry(r) {
    const e = { type: r.type, at: iso(r.at) };
    const amount = r.type === "charge" ? r.price_raw : r.amount_raw;
    e.amount_raw = amount;
    e.amount_tokens = formatTokens(amount);
    if (r.type === "payment" || r.type === "reversal") e.tx_hash = r.tx_hash;
    if (r.type === "charge") { e.tier = r.tier; e.reason = r.reason; }
    if (r.type === "reversal") e.reason = r.why;
    return e;
  }

  function usageOf(owner, now) {
    const plan = planOf(owner, now, null);
    const w = usage.get(plan.window);
    const byKey = [...(w?.keys ?? new Map())].map(([key_id, used]) => ({ key_id, used })).sort((a, b) => b.used - a.used);
    return { plan, used: w?.total ?? 0, byKey };
  }

  function accountJson(acct) {
    const now = ledger.now();
    const active = activePeriod(acct, now);
    const due = mode === "off" ? null : dueFor(acct, now, plans);
    const u = usageOf(acct.owner, now);
    return {
      account: { id: acct.account_id, name: acct.name, wallet: acct.owner, created_at: iso(acct.created_at) },
      plan: { id: active ? active.tier : "free", name: active ? nameOf(active.tier) : plans.free.name,
        starts_at: active ? iso(active.starts_at) : null, ends_at: active ? iso(active.ends_at) : null,
        selected: acct.selected, renews_on_next_request: needsSettle(acct.owner) },
      credit_raw: acct.credit.toString(), credit_tokens: formatTokens(acct.credit),
      due_raw: due ? due.raw.toString() : null, due_tokens: due ? ceilTokens(due.raw) : null, due_for: due?.why ?? null,
      usage: { used: u.used, limit: u.plan.requests, resets_at: iso(u.plan.end), by_key: u.byKey },
      history: acct.history.slice(-HISTORY).reverse().map(historyEntry),
    };
  }

  function preview(acct, tier, now) {
    const plan = plans[tier];
    const active = activePeriod(acct, now);
    const { sim, actions } = simulate(acct, now, plans, tier);
    const chargeNow = actions.reduce((sum, a) => sum + a.price, 0n);
    const mine = actions.find((a) => a.plan.id === tier);
    let effect, starts = null, ends = null, due = null;
    if (plan.price_raw === 0n) {
      effect = active ? "cancel_renewal" : "activate_now";
      starts = active ? active.ends_at : now;
    } else if (mine?.reason === "upgrade") {
      effect = "upgrade_now"; starts = now; ends = mine.period.ends_at;
    } else if (mine) {
      effect = "activate_now"; starts = now; ends = now + PERIOD_MS;
    } else if (active && (active.tier === tier || plan.price_raw <= active.tier_price)) {
      effect = "at_renewal"; starts = active.ends_at; ends = active.ends_at + PERIOD_MS;
      due = dueFor(sim, now, plans);
    } else {
      effect = "waiting_for_payment";
      due = dueFor(sim, now, plans);
    }
    return { preview: true, tier, effect, charge_now_raw: chargeNow.toString(), charge_now_tokens: formatTokens(chargeNow),
      due_raw: due ? due.raw.toString() : null, due_tokens: due ? ceilTokens(due.raw) : null,
      starts_at: starts === null ? null : iso(starts), ends_at: ends === null ? null : iso(ends) };
  }

  // ── payments ──
  const pending = (hash, stage, extra = {}) => ({ status: 202, json: { code: "payment_pending",
    message: stage === "not_found_yet" ? "Not on Robinhood Chain yet. Check again shortly." : "Confirming on Robinhood Chain.",
    tx_hash: hash, stage, ...extra } });
  const confirming = (hash, confirmations, ageMs) => {
    const blocksLeft = Math.max(0, minConfirmations - confirmations);
    const ageLeft = Math.max(0, minAgeSec * 1000 - ageMs);
    return pending(hash, "confirming", { confirmations, needed: minConfirmations,
      ready_in_sec: Math.max(1, Math.ceil(Math.max(ageLeft, blocksLeft * BLOCK_MS) / 1000)) });
  };

  /** Every chain read for one submission, outside the billing queue. Returns the record to append, or the answer. */
  async function verifyTransfer(owner, hash) {
    const chainId = await read(publicClient.getChainId());
    if (chainId !== TOKEN.chainId) {
      log(`[billing] payments RPC answered chain ${chainId}, not ${TOKEN.chainId}: payment refused`);
      return { answer: fail(503, "payments_unavailable", "Payments are temporarily unavailable.") };
    }
    let receipt;
    try { receipt = await read(publicClient.getTransactionReceipt({ hash })); } catch (err) {
      if (err?.name === "TransactionReceiptNotFoundError") return { answer: pending(hash, "not_found_yet") };
      throw err;
    }
    // The ledger keys on the receipt's own hash. One for another transaction is an RPC fault, not a payment.
    if (lower(receipt.transactionHash) !== hash) throw new ChainError("receipt for another transaction");
    if (receipt.status !== "success") return { answer: fail(422, "payment_failed", "This transaction failed on chain, so nothing was sent.") };
    const [latest, block] = await Promise.all([read(publicClient.getBlockNumber()), read(publicClient.getBlock({ blockNumber: receipt.blockNumber }))]);
    // Against the host's clock, not billing time, which may run up to
    // MAX_AHEAD_MS ahead of it: the minimum age is a reorg margin.
    const ageMs = clock() - Number(block.timestamp) * 1000;
    // The RPC disagrees with itself about which block holds this receipt: a
    // reorg in progress, or nodes out of step. Ask again later.
    if (lower(block.hash) !== lower(receipt.blockHash)) return { answer: confirming(hash, 0, ageMs) };
    const m = matchTransfers(receipt.logs, { owner, recipients });
    if (m.reason) {
      const msg = {
        wrong_token: `This transaction did not transfer $MERRYMEN (${TOKEN.address}).`,
        wrong_sender: `This transfer was not sent from your signed-in wallet ${owner}. Only $MERRYMEN sent from ${owner} is credited to this account; a transfer from another wallet is credited by signing in with that wallet and submitting the hash there.`,
        wrong_recipient: `This transfer did not go to the Merrymen payments wallet ${treasury}.`,
      }[m.reason];
      return { answer: fail(422, "payment_not_found", msg, { reason: m.reason }) };
    }
    if (Number(receipt.blockNumber) < startBlock) {
      return { answer: fail(422, "payment_not_found", "This transfer was made before API payments opened and cannot be credited.", { reason: "before_start_block" }) };
    }
    if (m.amount < ONE_TOKEN) return { answer: fail(422, "payment_too_small", "Send at least 1 MERRYMEN.") };
    if (m.logIndexes.length > MAX_LOGS) return { answer: fail(422, "payment_unsupported", "This transaction holds too many transfers. Send one transfer to the payments wallet.") };
    const confirmations = latest >= receipt.blockNumber ? Number(latest - receipt.blockNumber + 1n) : 0;
    if (confirmations < minConfirmations || ageMs < minAgeSec * 1000) return { answer: confirming(hash, confirmations, ageMs) };
    const blockNumber = Number(receipt.blockNumber);
    if (!Number.isSafeInteger(blockNumber)) throw new ChainError("block number");
    return { record: { type: "payment", owner, chain_id: chainId, token: TOKEN.address, recipient: m.recipient,
      tx_hash: lower(receipt.transactionHash), block_number: blockNumber, block_hash: lower(receipt.blockHash),
      amount_raw: m.amount.toString(), log_indexes: m.logIndexes } };
  }

  async function submitPayment(owner, txHash) {
    owner = lower(owner);
    if (mode === "off") return fail(503, "billing_off", "Paid plans are not available yet.");
    if (!account(owner)) return fail(404, "account_missing", "Create your developer account first.");
    // Lowercased first, and the ledger keeps the RECEIPT's hash: 0xAB… and
    // 0xab… are one transfer and must be one key.
    const hash = lower(typeof txHash === "string" ? txHash.trim() : "");
    if (!HASH.test(hash)) return fail(400, "invalid_tx_hash", "Paste the transaction hash: 0x and 64 hexadecimal characters.");
    if (!paymentsReady) return fail(503, "payments_unavailable", "Payments are not available yet.");
    if (ledger.fatal) return unavailable(new BillingUnavailable(ledger.fatal));
    // Already credited to this wallet: answer without asking the chain again.
    if (ledger.state.paymentKeys.has(paymentKey(TOKEN.chainId, hash, owner))) {
      return ledger.enqueue(async () => {
        try { await settleLocked(owner); } catch (err) { return unavailable(err); }
        return { status: 200, json: { already: true, ...accountJson(account(owner)) } };
      });
    }
    let verified;
    try { verified = await verifyTransfer(owner, hash); } catch (err) {
      log(`[billing] payment check for ${hash} failed: ${errName(err)}`);
      return fail(503, "chain_unavailable", "Robinhood Chain could not be read. Try again shortly.");
    }
    if (verified.answer) return verified.answer;
    const rec = verified.record;
    return ledger.enqueue(async () => {
      const acct = account(owner);
      if (!acct) return fail(404, "account_missing", "Create your developer account first.");
      try {
        if (ledger.state.paymentKeys.has(paymentKey(rec.chain_id, rec.tx_hash, owner))) {
          await settleLocked(owner);
          return { status: 200, json: { already: true, ...accountJson(account(owner)) } };
        }
        await ledger.append({ ...rec, account_id: acct.account_id });
        log(`[billing] ${owner} paid ${formatTokens(rec.amount_raw)} MERRYMEN in ${rec.tx_hash}`);
        await settleLocked(owner);
      } catch (err) { return unavailable(err); }
      return { status: 200, json: { already: false,
        payment: { tx_hash: rec.tx_hash, amount_raw: rec.amount_raw, amount_tokens: formatTokens(rec.amount_raw), block_number: rec.block_number },
        ...accountJson(account(owner)) } };
    });
  }

  /**
   * Why a credited payment no longer stands, or null. Absence counts only when
   * the RPC has reached the payment's block, so a lagging node cannot reverse a
   * real payment; any read error leaves it for the next run.
   */
  async function recheck(p) {
    let receipt = null;
    try { receipt = await read(publicClient.getTransactionReceipt({ hash: p.tx_hash })); } catch (err) {
      if (err?.name !== "TransactionReceiptNotFoundError") throw err;
    }
    if (!receipt) {
      const latest = await read(publicClient.getBlockNumber());
      return latest >= BigInt(p.block_number) ? "receipt_missing" : null;
    }
    if (receipt.status !== "success") return "reverted";
    if (lower(receipt.blockHash) !== p.block_hash) return "block_changed";
    const block = await read(publicClient.getBlock({ blockNumber: receipt.blockNumber }));
    if (lower(block.hash) !== p.block_hash) return "block_changed";
    const m = matchTransfers(receipt.logs, { owner: p.owner, recipients: new Set([...recipients, p.recipient]) });
    return m.reason || m.amount !== p.amount ? "amount_changed" : null;
  }

  let reconciling = null;
  /**
   * Re-verify payments credited in the last 30 minutes (all of them with
   * `all`). One that a reorg dropped or changed gets a reversal: its amount
   * leaves the credit, possibly below zero, and nothing more is charged until
   * it is paid. The plan already running is left alone.
   */
  async function reconcile({ all = false, dryRun = false } = {}) {
    if (!publicClient || (mode === "off" && !dryRun)) return [];
    while (reconciling) await reconciling;
    const run = (async () => {
      // On any other chain every receipt is "missing": that would reverse
      // every recent payment. Ask which chain this is before believing it.
      let chainId;
      try { chainId = await read(publicClient.getChainId()); } catch (err) { log(`[billing] reconcile skipped: chain unreadable (${errName(err)})`); return []; }
      if (chainId !== TOKEN.chainId) { log(`[billing] reconcile skipped: the payments RPC answers chain ${chainId}, not ${TOKEN.chainId}`); return []; }
      const since = ledger.now() - RECONCILE_WINDOW_MS;
      const findings = [];
      for (const p of [...ledger.state.payments.values()]) {
        if (p.reversed || (!all && p.at < since)) continue;
        let why;
        try { why = await recheck(p); } catch (err) { log(`[billing] reconcile could not re-read ${p.tx_hash} (${errName(err)})`); continue; }
        if (!why) continue;
        findings.push({ payment_id: p.id, owner: p.owner, tx_hash: p.tx_hash, amount_raw: p.amount.toString(), why });
        if (dryRun) continue;
        await ledger.enqueue(async () => {
          const cur = ledger.state.payments.get(p.id);
          if (!cur || cur.reversed) return;
          try {
            await ledger.append({ type: "reversal", account_id: cur.account_id, payment_id: cur.id, amount_raw: cur.amount.toString(), why });
            log(`[billing] PAYMENT REVERSED: ${cur.tx_hash} from ${cur.owner}, ${formatTokens(cur.amount)} MERRYMEN (${why})`);
          } catch (err) { log(`[billing] could not record the reversal of ${cur.tx_hash} (${errName(err)})`); }
        });
      }
      return findings;
    })();
    reconciling = run.finally(() => { reconciling = null; });
    return run;
  }

  // ── timers ──
  const handles = [];
  if (timers && mode !== "off") {
    handles.push(setInterval(() => { ledger.tail().catch((err) => log(`[billing] tail failed (${errName(err)})`)); refreshAnchors(); }, TAIL_MS));
    handles.push(setInterval(() => { flush(); }, USAGE_FLUSH_MS));
    if (paymentsReady) handles.push(setInterval(() => { reconcile().catch((err) => log(`[billing] reconcile failed (${errName(err)})`)); }, RECONCILE_MS));
    for (const h of handles) h.unref?.();
  }

  return {
    get mode() { return mode; },
    get enforced() { return enforced; },
    get paymentsReady() { return paymentsReady; },
    get blocked() { return ledger.blocked(); },
    now: () => ledger.now(),

    plansView() {
      return { status: 200, json: {
        billing: { mode, enforced }, period_days: PERIOD_DAYS,
        currency: { symbol: TOKEN.symbol, address: TOKEN.address, chain_id: TOKEN.chainId, decimals: TOKEN.decimals,
          explorer_url: `${TOKEN.explorer}/token/${TOKEN.address}` },
        treasury: paymentsReady ? treasury : null,
        confirmations: { blocks: minConfirmations, min_age_sec: minAgeSec },
        plans: Object.values(plans).map((p) => ({ id: p.id, name: p.name, price_tokens: formatTokens(p.price_raw),
          price_raw: p.price_raw.toString(), requests: p.requests, rpm: p.rpm })),
      } };
    },
    accountView(owner) {
      const acct = account(owner);
      return acct ? { status: 200, json: accountJson(acct) } : fail(404, "account_missing", "Create your developer account first.");
    },
    hasAccount: (owner) => !!account(owner),
    async createAccount(owner, name) {
      owner = lower(owner);
      if (!ADDRESS.test(owner)) return fail(400, "invalid_address", "Sign in with a wallet first.");
      if (!validName(name)) return fail(400, "invalid_name", "Account name must contain 1–48 characters");
      return ledger.enqueue(async () => {
        if (account(owner)) return fail(409, "account_exists", "This wallet already has a developer account.");
        try { await ledger.append({ type: "account", account_id: `acct_${hex(12)}`, owner, name: name.trim() }); } catch (err) { return unavailable(err); }
        return { status: 201, json: accountJson(account(owner)) };
      });
    },
    async choosePlan(owner, { tier, confirm } = {}) {
      owner = lower(owner);
      if (mode === "off") return fail(503, "billing_off", "Paid plans are not available yet.");
      if (!account(owner)) return fail(404, "account_missing", "Create your developer account first.");
      if (!tierOf(plans, tier)) return fail(400, "invalid_tier", `Choose one of: ${Object.keys(plans).join(", ")}.`);
      if (confirm !== true) return { status: 200, json: preview(account(owner), tier, ledger.now()) };
      return ledger.enqueue(async () => {
        if (!(await ledger.writable())) return unavailable(new BillingUnavailable(ledger.blocked()));
        const acct = account(owner);
        try {
          if (acct.selected !== tier) await ledger.append({ type: "select", account_id: acct.account_id, tier });
          await settleLocked(owner);
        } catch (err) { return unavailable(err); }
        return { status: 200, json: accountJson(account(owner)) };
      });
    },
    submitPayment,

    needsSettle: (owner) => needsSettle(lower(owner)),
    settle,
    /** Settle first when a charge is due; waits at most 2 s, then serves on the state before it. */
    async prepare(owner) {
      owner = lower(owner);
      if (!owner || !needsSettle(owner)) return true;
      let timer;
      const done = settle(owner).then(() => true, () => true);
      const waited = new Promise((resolve) => { timer = setTimeout(() => resolve(false), settleWaitMs); timer.unref?.(); });
      const settled = await Promise.race([done, waited]);
      clearTimeout(timer);
      return settled;
    },
    planFor(owner, keyCreatedAt) {
      const p = planOf(lower(owner), ledger.now(), keyCreatedAt);
      return { id: p.id, name: p.name, requests: p.requests, rpm: p.rpm, starts_at: p.start, ends_at: p.end };
    },
    /** planFor after the charge a metered request would make first, if one is due (pure). The gate's rate. */
    nextPlanFor(owner, keyCreatedAt) {
      const p = nextPlanOf(lower(owner), ledger.now(), keyCreatedAt);
      return { id: p.id, name: p.name, requests: p.requests, rpm: p.rpm, starts_at: p.start, ends_at: p.end };
    },
    /**
     * Count one request, or refuse it when enforced and spent. Synchronous, so
     * nothing runs between the check and the increment: the limit is a hard
     * bound under any concurrency. A refusal is not counted.
     */
    reserve({ owner, keyId, keyCreatedAt } = {}) {
      owner = lower(owner);
      if (mode === "off" || !ADDRESS.test(owner)) return { ok: true, metered: false, headers: {} };
      const plan = planOf(owner, ledger.now(), keyCreatedAt);
      const key = plan.window;
      const w = usage.get(key);
      const used = w?.total ?? 0;
      if (enforced && used >= plan.requests) {
        const resetIn = Math.max(1, Math.ceil((plan.end - ledger.now()) / 1000));
        return { ok: false, status: 402,
          error: { code: "quota_exhausted", message: `This account has used its ${plan.requests} requests on ${plan.name} until ${iso(plan.end)}. Choose a larger plan at ${UPGRADE_URL}.`,
            plan: plan.id, limit: plan.requests, used, resets_at: iso(plan.end), upgrade_url: UPGRADE_URL },
          headers: { ...quotaHeaders(quotaOf(plan, used)), "retry-after": String(resetIn) } };
      }
      const win = w ?? { end: plan.end, total: 0, keys: new Map() };
      if (!w) usage.set(key, win);
      win.total += 1;
      const id = String(keyId ?? "-");
      win.keys.set(id, (win.keys.get(id) ?? 0) + 1);
      usageDirty = true;
      return { ok: true, metered: true, ticket: { key, keyId: id }, headers: quotaHeaders(quotaOf(plan, win.total)) };
    },
    /** Give a unit back. Never below zero, and only to the window it came from. */
    release(ticket) {
      const w = ticket && usage.get(ticket.key);
      if (!w) return;
      if (w.total > 0) w.total -= 1;
      const n = w.keys.get(ticket.keyId) ?? 0;
      if (n > 1) w.keys.set(ticket.keyId, n - 1); else w.keys.delete(ticket.keyId);
      usageDirty = true;
    },
    /** For /meta, unmetered: the effective rate and the plan, read without counting. */
    meta(owner, keyCreatedAt) {
      owner = lower(owner);
      if (mode === "off" || !ADDRESS.test(owner)) return { billing: null, rate_per_min: null, headers: {} };
      const now = ledger.now();
      const plan = planOf(owner, now, keyCreatedAt);
      const used = usage.get(plan.window)?.total ?? 0;
      return {
        billing: { mode, enforced, plan: plan.id, requests_limit: plan.requests, requests_used: used, resets_at: iso(plan.end),
          plan_ends_at: plan.period ? iso(plan.end) : null, renews_on_next_request: needsSettle(owner) },
        rate_per_min: plan.rpm,
        headers: quotaHeaders(quotaOf(plan, used)),
      };
    },

    tail: () => ledger.tail(),
    reconcile,
    flush,
    /** Stop the timers, let queued billing writes finish (5 s at most), then save usage. */
    async close() {
      for (const h of handles) clearInterval(h);
      let timer;
      await Promise.race([ledger.enqueue(() => {}), new Promise((resolve) => { timer = setTimeout(resolve, CLOSE_DRAIN_MS); timer.unref?.(); })]);
      clearTimeout(timer);
      await flush();
    },
  };
}
