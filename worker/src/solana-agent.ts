/** Deterministic, opt-in USDG/SOL rebalancer. Both modes use the same admission boundary. */
import { createHash } from "node:crypto";
import { CHAINS, SOLANA_USDG_MINT } from "../../packages/core/src/ids";
import { parseSolanaRawAmount, parseSolanaSwapIntent, SOLANA_LIVE_BELOW_MINIMUM, SOLANA_LIVE_MIN_TRADE_USDG_RAW, validateSolanaAccountLimits, validateSolanaQuote, type SolanaPaperLimits,
  type SolanaQuote } from "../../packages/core/src/solana";
import { SOLANA_WRAPPED_SOL_MINT } from "../../packages/core/src/solana-live";
import { SqlSolanaBindingStore, validateSolanaStrategy, type SolanaStrategy } from "../../web/src/lib/solana-binding-store";
import { createSolanaAppRuntime, getSolanaAppRuntime, SOLANA_STATUS_BELOW_BOOK, SOLANA_STATUS_DAILY_USDG_BUYS_USED, type SolanaAppRuntimeOptions } from "./solana-app-runtime";
import type { Db } from "./db";
import { createSolanaMarket, SolanaMarketError } from "./solana-market";
import type { SolanaPaperMarket } from "./solana-paper-service";
import { SOLANA_REFERENCE_DEFAULT_TOLERANCE_BPS, SOLANA_REFERENCE_MAX_TOLERANCE_BPS, solanaReferenceToleranceBps } from "./solana-reference-price";
import { getSolanaRuntimeDb } from "./solana-runtime-db";
import { ensureSolanaTradingSchema, SOLANA_AUTONOMOUS_REQUEST_PREFIX, SOLANA_DEFAULT_EXPIRED_ATTEMPT_ALLOWANCE, SOLANA_EXPIRED_ATTEMPTS_EXHAUSTED, SOLANA_LIVE_EXIT_RESERVE,
  SOLANA_OPERATOR_HOLD_ALL, solanaAutonomousSchedule, solanaExitReserveBuyRoom, solanaExpiredAttemptAllowance, solanaExpiredAttemptUse, solanaPendingOwnerScopes,
  solanaPendingOwnerTransactions, solanaRollingLimitUse, SolanaTradingStoreError, type SolanaAccountScope, type SolanaRegisteredSession } from "./solana-trading-store";

export interface SolanaRebalanceInput {
  cashRaw: string; wsolRaw: string; solValueUsdgRaw: string; limits: SolanaPaperLimits;
  strategy: SolanaStrategy; mode: "paper" | "live"; revision: number; nowMs: number;
  /** The account's next autonomous attempt index (solanaAutonomousSchedule): each attempt has its own request ID. */
  attempt: number;
  /**
   * Live only: the largest buy that keeps room to sell the whole position inside the rolling window (solanaExitReserveBuyRoom,
   * EXITS KEEP ROOM IN THE ROLLING LIMITS in solana-trading-store.ts). A buy is sized below it, and none is planned under the live
   * minimum. Absent: not bounded here (paper; admission still checks it).
   */
  buyRoomUsdgRaw?: string;
}
/** Integer-only sizing against an executable full-position exit quote. */
export function planSolanaRebalance(input: SolanaRebalanceInput) {
  const strategy = validateSolanaStrategy(input.strategy), limits = validateSolanaAccountLimits(input.limits, input.nowMs);
  if (!strategy.enabled) return null;
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) throw new Error("Invalid Solana strategy revision.");
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 0) throw new Error("Invalid Solana strategy attempt.");
  const cash = parseSolanaRawAmount(input.cashRaw, true), held = parseSolanaRawAmount(input.wsolRaw, true), value = parseSolanaRawAmount(input.solValueUsdgRaw, true);
  if ((held === 0n) !== (value === 0n)) throw new Error("A current executable SOL valuation is required.");
  const equity = cash + value;
  if (equity === 0n) return null;
  const target = equity * BigInt(strategy.targetSolBps) / 10_000n, delta = target - value;
  const deviation = delta < 0n ? -delta : delta;
  if (deviation * 10_000n < equity * BigInt(strategy.rebalanceBps) || delta === 0n) return null;
  const notional = [deviation, BigInt(strategy.tradeUsdgRaw), BigInt(limits.perTradeUsdg)].reduce((a, b) => a < b ? a : b);
  const buying = delta > 0n, room = input.buyRoomUsdgRaw === undefined ? null : parseSolanaRawAmount(input.buyRoomUsdgRaw, true);
  let amount = buying ? [notional, cash, ...(room === null ? [] : [room])].reduce((a, b) => a < b ? a : b) : held * notional / value;
  // A sell never asks for more WSOL input than the owner signed for one trade.
  if (!buying && limits.perTradeWsol !== undefined && amount > BigInt(limits.perTradeWsol)) amount = BigInt(limits.perTradeWsol);
  if (amount === 0n) return null;
  // Live admission refuses a trade worth under SOLANA_LIVE_MIN_TRADE_USDG_RAW (the shared fee payer pays it):
  // such a live buy is in band, not a refusal every tick. Sells are left to admission, which values them at the
  // independent reference: the mark here can be a dust quote, and a sale it undervalues must still be tried. One
  // admission refuses is treated as in band by the agent (BELOW THE LIVE MINIMUM in createSolanaAgent).
  if (input.mode === "live" && buying && amount < SOLANA_LIVE_MIN_TRADE_USDG_RAW) return null;
  // Never an earlier attempt's ID: a proven-expired request is never re-sent, a new attempt is a new request.
  const requestId = `${SOLANA_AUTONOMOUS_REQUEST_PREFIX}${input.revision}-${input.attempt}`;
  return { ...parseSolanaSwapIntent({ kind: "spl-swap", chain: CHAINS.solana, mode: "paper", requestId,
    inputMint: buying ? SOLANA_USDG_MINT : SOLANA_WRAPPED_SOL_MINT, outputMint: buying ? SOLANA_WRAPPED_SOL_MINT : SOLANA_USDG_MINT,
    amountRaw: amount.toString(), slippageBps: 50 }), mode: input.mode };
}
/** Re-quote the actual partial exit; a full-position minimum is not its unit price. */
export async function boundSolanaRebalanceSell(
  intent: NonNullable<ReturnType<typeof planSolanaRebalance>>, cap: bigint, market: SolanaPaperMarket, now: () => number,
) {
  if (intent.inputMint === SOLANA_USDG_MINT) return intent;
  let sized = intent;
  for (let attempt = 0; attempt < 3; attempt++) {
    const paper = parseSolanaSwapIntent({ ...sized, mode: "paper" });
    const quote = await market.quote(paper); validateSolanaQuote(quote, paper, now());
    const quoted = BigInt(quote.outAmount);
    if (quoted <= cap) return sized;
    const reduced = BigInt(sized.amountRaw) * cap * 9990n / (quoted * 10000n);
    if (reduced <= 0n) return null;
    sized = { ...sized, amountRaw: reduced.toString() };
  }
  return null;
}
/**
 * solMarkDust is optional for test runtimes; without it no zero-output mark of live SOL is taken for dust.
 * feePayerCheck is optional too; without it the agent checks no fee payer of its own.
 */
type Runtime = Pick<ReturnType<typeof getSolanaAppRuntime>, "status" | "trade"> & Partial<Pick<ReturnType<typeof getSolanaAppRuntime>, "solMarkDust" | "feePayerCheck" | "publishLiveRollout">>;
export interface SolanaAgentOptions {
  db: Db; runtime: Runtime; market: SolanaPaperMarket; now?: () => number; postgres?: boolean; signal?: AbortSignal;
  /** Live sells are charged at up to this much above their quote by the reference price; size below the cap by it. */
  referenceToleranceBps?: number;
  /** The runtime's MERRYMEN_SOLANA_EXPIRED_ATTEMPT_ALLOWANCE, for the expired-attempt alerts only. Default SOLANA_DEFAULT_EXPIRED_ATTEMPT_ALLOWANCE. */
  expiredAttemptAllowance?: number;
  /** Operator log lines ([alert] and [warn]). Default: stderr. Never carries keys, signed bytes or tenant identities. */
  log?: (line: string) => void;
}
/** While an expired-attempt condition persists for an account, its line is repeated at most this often. */
export const SOLANA_AGENT_ALERT_REPEAT_MS = 10 * 60_000;
/**
 * A stable, opaque name for one account in operator logs: no tenant identity or
 * owner key, but the same account always reads the same, and an operator who
 * knows the account can compute it.
 */
export function solanaAccountRef(scope: SolanaAccountScope): string {
  return createHash("sha256").update(`merrymen-solana-account/v1 ${scope.tenant} ${scope.owner}`).digest("hex").slice(0, 16);
}
/**
 * A live trade, or a signed owner transaction, still pending this long after it was admitted or prepared is
 * stuck: its blockhash expired a minute or two ago, so both providers should have agreed on its outcome by now.
 */
export const SOLANA_PENDING_STUCK_MS = 3 * 60_000;
/** How often the agent reads the shared fee payer itself, beside the reads status makes. */
export const SOLANA_AGENT_FEE_PAYER_CHECK_MS = 10 * 60_000;
/** The heartbeat is written at least this often during a tick; the UI shows the worker offline after 90 s. */
const HEARTBEAT_REFRESH_MS = 30_000;
/**
 * One tenant's tick outcome. waiting: its interval has not passed, so no status
 * read or quote was made. replayed: the attempt was already admitted (by another
 * worker), so nothing new was submitted.
 */
export type SolanaAgentOutcome = "held" | "waiting" | "submitted" | "replayed" | "unavailable";
export function createSolanaAgent(options: SolanaAgentOptions) {
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => { process.stderr.write(`${line}\n`); });
  const allowance = options.expiredAttemptAllowance ?? SOLANA_DEFAULT_EXPIRED_ATTEMPT_ALLOWANCE;
  /**
   * EXPIRED ATTEMPTS, SAID TO THE OPERATOR (owner decision G2-3: with the
   * default allowance of 0 every proven-expired attempt counts toward the
   * owner's maxOpsPerDay, so a burst of dropped packets can pause automated
   * trading, exits included, for up to 24 hours; the store has no logger).
   * - [alert] when expired attempts used up the account's daily operations: the
   *   agent holds the strategy before trying (dailyOperationsUsed), or admission
   *   refused it for that reason;
   * - [warn] when the expired attempts that count use more than half of them.
   * Each at most once per SOLANA_AGENT_ALERT_REPEAT_MS per account while it
   * persists, and at once again after it clears. Logging never changes an outcome.
   */
  const said = new Map<string, number>();
  const say = (key: string, line: string) => {
    const at = now(), last = said.get(key);
    if (last !== undefined && at >= last && at - last < SOLANA_AGENT_ALERT_REPEAT_MS) return;
    said.set(key, at);
    try { log(line); } catch { /* Logging never changes an outcome. */ }
  };
  type ExpiredUse = Awaited<ReturnType<typeof solanaExpiredAttemptUse>>;
  const report = (scope: SolanaAccountScope, use: ExpiredUse, maxOpsPerDay: number, refused: boolean) => {
    const account = solanaAccountRef(scope);
    const fields = JSON.stringify({ solana: refused ? "alert" : "warn", kind: refused ? "expired-attempts-exhausted" : "expired-attempts-high", account,
      expired: use.expired, counted: use.counted, allowance, operations: use.operations, maxOpsPerDay });
    const remedy = "MERRYMEN_SOLANA_EXPIRED_ATTEMPT_ALLOWANCE (a whole number from 0 to 96, default 0) sets how many a day do not count";
    if (refused) return say(`exhausted:${account}`, `[alert] Solana autonomous strategy refused: proven-expired attempts used up an account's daily operations, so its automated trades and exits pause until they leave the 24 h window: ${fields} — ${remedy}`);
    said.delete(`exhausted:${account}`);
    if (use.counted * 2 > maxOpsPerDay) say(`high:${account}`, `[warn] Solana proven-expired attempts use more than half of an account's daily operations; at the limit its automated trades and exits pause: ${fields} — ${remedy}`);
    else said.delete(`high:${account}`);
  };
  const expiredUse = async (scope: SolanaAccountScope, maxOpsPerDay: number, refused: boolean) => {
    try { report(scope, await solanaExpiredAttemptUse(options.db, scope, now(), allowance), maxOpsPerDay, refused); } catch {
      if (refused) say(`exhausted:${solanaAccountRef(scope)}`, `[alert] Solana autonomous strategy refused: proven-expired attempts used up an account's daily operations: ${
        JSON.stringify({ solana: "alert", kind: "expired-attempts-exhausted", account: solanaAccountRef(scope), allowance, maxOpsPerDay })}`);
    }
  };
  /**
   * Whether admission would refuse every live trade of this account, exits
   * included, for its daily operations, by the store's rolling 24-hour
   * arithmetic: trades (landed, failed or pending) reached maxOpsPerDay, or
   * with the proven-expired attempts beyond the allowance they did (said as the
   * [alert]). Checked before the status read, so such an account costs no RPC
   * read, quote, route or signature each tick while it waits for the window.
   * Only provider load rides on it: admission still enforces the limit itself.
   */
  const dailyOperationsUsed = async (scope: SolanaAccountScope, maxOpsPerDay: number): Promise<boolean> => {
    const use = await solanaExpiredAttemptUse(options.db, scope, now(), allowance);
    if (use.operations + use.counted < maxOpsPerDay) return false;
    if (use.operations < maxOpsPerDay) report(scope, use, maxOpsPerDay, true);
    return true;
  };
  /**
   * A live account whose vault holds less than its book (SOLANA_STATUS_BELOW_BOOK) while nothing of its own is
   * settling: tokens left it outside Merrymen, and its automated trades and exits stay held until the book
   * matches the vault again. Nothing in the worker books a decrease. The owner records their own withdrawals
   * made outside Merrymen under Owner controls; anything else an operator finds and, once explained, writes off
   * as a loss with `npm run solana:resolve -- shortfall` (solana-resolve-shortfall.ts), named by this alert's
   * account reference (docs/solana-integration.md, "A vault below its book"). Said as an [alert] at most once
   * per SOLANA_AGENT_ALERT_REPEAT_MS per account while it persists, and at once again after it clears.
   */
  const belowBook = (scope: SolanaAccountScope, blockers: readonly string[] | undefined) => {
    const account = solanaAccountRef(scope);
    if (!blockers?.includes(SOLANA_STATUS_BELOW_BOOK)) { said.delete(`below-book:${account}`); return; }
    say(`below-book:${account}`, `[alert] Solana vault below its book: an account's vault holds less USDG or SOL than its recorded trades, so its automated trades `
      + `and exits are held: ${JSON.stringify({ solana: "alert", kind: "vault-below-book", account })} — tokens left the vault outside Merrymen. If the owner `
      + "withdrew with their own key (the recovery tool or another wallet), they record those withdrawals under Owner controls and trading resumes. Otherwise "
      + `find what moved the tokens: npm run solana:resolve -- shortfall show ${account} shows both providers' balances beside the book, and shortfall book `
      + "writes an explained shortfall off as a loss (docs/solana-integration.md, \"A vault below its book\"). Until then the owner can revoke, and withdraw "
      + "what the vault holds");
  };
  /**
   * STUCK, SAID TO THE OPERATOR. After receipt recovery, any live trade admitted, or signed owner transaction
   * prepared, more than SOLANA_PENDING_STUCK_MS ago and still pending: both providers could not read or agree on
   * its outcome. Each holds its account's reservation (no new trade, no in-app owner transaction but a revoke).
   * One [alert] with counts and the oldest age only (no tenant, owner, signature or bytes), at most once per
   * SOLANA_AGENT_ALERT_REPEAT_MS while any is stuck, and at once again after none was. The operator finds which
   * with `npm run solana:resolve -- pending` (listSolanaStuckPending), which reads the same rows by name.
   */
  const stuck = async () => {
    const at = now(), cutoff = at - SOLANA_PENDING_STUCK_MS;
    const trades = await options.db.prepare("SELECT COUNT(*) AS n, MIN(created_at_ms) AS oldest FROM solana_runtime_submissions WHERE status='pending' AND created_at_ms<=?")
      .get(cutoff) as { n: number | string; oldest: number | string | null } | undefined;
    // Both owner slots: a revocation saved beside a record (REVOKE BESIDE A PENDING OWNER TRANSACTION) can be stuck too.
    const owners = (await solanaPendingOwnerTransactions(options.db)).flatMap(item =>
      item.signature && item.preparedAtMs !== null && item.preparedAtMs <= cutoff ? [item.preparedAtMs] : []);
    const tradeCount = Number(trades?.n ?? 0), oldest = [...(trades?.oldest == null ? [] : [Number(trades.oldest)]), ...owners];
    if (!tradeCount && !owners.length) { said.delete("pending-stuck"); return; }
    say("pending-stuck", `[alert] Solana transactions stuck pending: ${JSON.stringify({ solana: "alert", kind: "pending-stuck", trades: tradeCount,
      ownerTransactions: owners.length, oldestAgeMs: at - Math.min(...oldest) })} — both RPC providers could not read or agree on their outcome for over `
      + `${SOLANA_PENDING_STUCK_MS / 60_000} minutes; each holds its account's reservation (no new trade, no in-app owner transaction but a revoke). Check both `
      + "providers; npm run solana:resolve -- pending names each one (tenant, id, age, vault sequence), and show <tenant> <request-id> shows a trade's evidence");
  };
  /**
   * The shared fee payer, read by the agent itself every SOLANA_AGENT_FEE_PAYER_CHECK_MS while any live
   * permission is registered (runtime.feePayerCheck, which says the [alert]s status says, through the same
   * state): a payer that cannot fund exits pages the operator even when no status is read. A check that
   * cannot be made is tried again after the interval and never changes an outcome.
   */
  let feePayerCheckedAtMs: number | undefined;
  const feePayer = async () => {
    const at = now();
    if (!options.runtime.feePayerCheck || (feePayerCheckedAtMs !== undefined && at >= feePayerCheckedAtMs && at - feePayerCheckedAtMs < SOLANA_AGENT_FEE_PAYER_CHECK_MS)) return;
    const registered = await options.db.prepare("SELECT record_json FROM solana_runtime_sessions ORDER BY tenant,owner LIMIT 1").get() as { record_json: string } | undefined;
    if (!registered) return;
    let vault: string | undefined;
    try { const record = JSON.parse(registered.record_json); if (typeof record.vault === "string") vault = record.vault; } catch { /* Sized by the upper bound. */ }
    // At most one check per interval, failed ones included: a provider that is down is not asked every tick.
    feePayerCheckedAtMs = at;
    await options.runtime.feePayerCheck(vault === undefined ? {} : { vault });
  };
  /**
   * BELOW THE LIVE MINIMUM. Admission refuses a live trade worth under
   * SOLANA_LIVE_MIN_TRADE_USDG_RAW at the independent reference, unless it sells
   * the whole booked position (SOLANA_LIVE_BELOW_MINIMUM), after the executor
   * has quoted, routed, simulated and signed it. A strategy whose rebalance is
   * that small (a sale capped by a small strategy size, per-trade limit or SOL
   * sell limit, or a small vault's deviation) is treated as in band: tried
   * again once its interval passes, never every tick. Said as a [warn] at most
   * once per SOLANA_AGENT_ALERT_REPEAT_MS per account while it persists, and at
   * once again after it clears (the strategy trades, or plans nothing). Logging
   * never changes an outcome.
   */
  const belowMinimum = (scope: SolanaAccountScope, side: "buy" | "sell", intervalSeconds: number) => {
    const account = solanaAccountRef(scope);
    say(`below-minimum:${account}`, `[warn] Solana autonomous rebalance below the live minimum: admission refused an account's strategy trade worth under `
      + `1 USDG at the independent SOL price, so the strategy waits its interval and tries again: ${JSON.stringify({ solana: "warn", kind: "below-live-minimum",
        account, side, minimumUsdgRaw: SOLANA_LIVE_MIN_TRADE_USDG_RAW.toString(), intervalSeconds })} — the owner's strategy trade size, USDG per trade and SOL `
      + "sold per trade must each be worth at least 1 USDG (docs/solana-integration.md); a small vault's rebalance stays below it until the band widens");
  };
  const toleranceBps = options.referenceToleranceBps ?? SOLANA_REFERENCE_DEFAULT_TOLERANCE_BPS, headroom = BigInt(10_000 - toleranceBps);
  // When each tenant's strategy last found nothing to do (in band), or admission refused it
  // because expired attempts used up its daily operations, by settings revision.
  // Only provider load rides on this: admission spacing is durable in the store.
  const checked = new Map<string, { revision: number; atMs: number }>();
  /**
   * The USDG per 24 hours limit of the permission registered for this account, as activateLive kept it in the session record;
   * undefined without one (or one recorded before limits were kept). For planning only: admission reads it itself.
   */
  const registeredDailyUsdg = async (scope: SolanaAccountScope): Promise<bigint | undefined> => {
    const row = await options.db.prepare("SELECT record_json FROM solana_runtime_sessions WHERE tenant=? AND owner=?").get(scope.tenant, scope.owner) as { record_json: string } | undefined;
    try {
      const daily = row ? (JSON.parse(row.record_json) as SolanaRegisteredSession).limits?.dailyUsdg : undefined;
      return typeof daily === "string" && /^[0-9]{1,20}$/.test(daily) ? BigInt(daily) : undefined;
    } catch { return undefined; }
  };
  const admitted = async (scope: SolanaAccountScope, requestId: string) => !!(
    await options.db.prepare("SELECT 1 FROM solana_runtime_autonomous_attempts WHERE tenant=? AND owner=? AND request_id=?").get(scope.tenant, scope.owner, requestId) ??
    await options.db.prepare("SELECT 1 FROM solana_runtime_paper_trades WHERE tenant=? AND owner=? AND request_id=?").get(scope.tenant, scope.owner, requestId) ??
    await options.db.prepare("SELECT 1 FROM solana_runtime_submissions WHERE tenant=? AND owner=? AND request_id=?").get(scope.tenant, scope.owner, requestId));
  return {
    async tick() {
      await ensureSolanaTradingSchema(options.db, options.postgres);
      // Refreshed as the tick goes, so a long tick never shows the worker as offline.
      let beatAtMs = now();
      const beat = async (force = false) => {
        const at = now();
        if (!force && at - beatAtMs < HEARTBEAT_REFRESH_MS) return;
        beatAtMs = at;
        await options.db.prepare("INSERT INTO solana_runtime_worker_heartbeat(worker,last_seen_at_ms) VALUES('solana',?) ON CONFLICT(worker) DO UPDATE SET last_seen_at_ms=excluded.last_seen_at_ms").run(at);
        // With the heartbeat, the live rollout settings this worker runs, which the web compares with its own. Best effort: a
        // publish that fails leaves a digest older than this heartbeat, which the web counts as differing and holds live buys
        // for (SETTINGS THAT MUST MATCH, CHECKED, in the app runtime). It never stops receipt recovery, exits or this tick.
        try { await options.runtime.publishLiveRollout?.(); said.delete("rollout-unpublished"); } catch {
          say("rollout-unpublished", "[alert] solana-live-rollout unpublished: the Solana worker could not publish its MERRYMEN_SOLANA_LIVE_TENANTS and "
            + "MERRYMEN_SOLANA_LIVE_MAX_* digest with its heartbeat (solana_runtime_live_rollout_seen), so the web holds every live Solana buy until it can; "
            + "receipt recovery, exits, revoke and withdraw continue");
        }
      };
      await beat(true);
      // Disabling a strategy never disables receipt recovery. Confirmation is
      // read-only and must keep working after mode changes or key rotation.
      const unsettled = await options.db.prepare("SELECT DISTINCT tenant,owner FROM solana_runtime_submissions WHERE status='pending'").all() as SolanaAccountScope[];
      // A pending owner transaction in either slot: the main record, or a revocation saved beside it, which often
      // outlives the record it was prepared beside (REVOKE BESIDE A PENDING OWNER TRANSACTION in solana-trading-store.ts).
      const recovered = new Map<string, Awaited<ReturnType<Runtime["status"]>>>();
      for (const scope of [...unsettled, ...await solanaPendingOwnerScopes(options.db)]) {
        if (options.signal?.aborted) break;
        if (recovered.has(scope.tenant)) continue;
        try { recovered.set(scope.tenant, await options.runtime.status({ tenant: scope.tenant, owner: scope.owner })); } catch { /* Retry next tick; no replacement transaction. */ }
        await beat();
      }
      // What recovery could not settle, and the fee payer, are said to the operator; neither ever changes an outcome.
      try { await stuck(); } catch { /* Said next tick. */ }
      try { await feePayer(); } catch { /* Checked again after the interval. */ }
      const rows = await options.db.prepare("SELECT tenant,owner,requested_mode,limits_json,strategy_json,revision FROM solana_wallet_bindings WHERE chain=? AND strategy_json IS NOT NULL ORDER BY tenant")
        .all(CHAINS.solana) as Array<{ tenant: string; owner: string; requested_mode: "paper" | "live"; limits_json: string | null; strategy_json: string; revision: number }>;
      // Operator holds are read after receipt recovery, which they never stop.
      const holds = new Set((await options.db.prepare("SELECT scope FROM solana_operator_holds").all() as Array<{ scope: string }>).map(h => h.scope));
      const results: Array<{ owner: string; outcome: SolanaAgentOutcome }> = [];
      for (const row of rows) {
        if (options.signal?.aborted) break;
        await beat();
        const scope: SolanaAccountScope = { tenant: row.tenant, owner: row.owner };
        try {
          const strategy = validateSolanaStrategy(JSON.parse(row.strategy_json));
          if (!strategy.enabled || !row.limits_json) continue;
          if (holds.has(SOLANA_OPERATOR_HOLD_ALL) || holds.has(row.tenant)) { results.push({ owner: row.owner, outcome: "held" }); continue; }
          const limits = validateSolanaAccountLimits(JSON.parse(row.limits_json), now());
          // The interval spaces attempts (durably) and checks: until it is due, no status read and no quote.
          const revision = Number(row.revision), intervalMs = strategy.intervalSeconds * 1000, at = now();
          const schedule = await solanaAutonomousSchedule(options.db, scope, strategy.intervalSeconds);
          const last = checked.get(row.tenant);
          if (at < schedule.dueAtMs || (last && last.revision === revision && at - last.atMs < intervalMs)) { results.push({ owner: row.owner, outcome: "waiting" }); continue; }
          const inBand = () => { checked.set(row.tenant, { revision, atMs: at }); results.push({ owner: row.owner, outcome: "held" }); };
          if (row.requested_mode === "live" && await dailyOperationsUsed(scope, limits.maxOpsPerDay)) { results.push({ owner: row.owner, outcome: "held" }); continue; }
          // A paper strategy needs only its paper book: no chain reads, no vault verification.
          const status = recovered.get(scope.tenant) ?? await options.runtime.status(scope, row.requested_mode === "paper" ? { liveReads: false } : undefined);
          let cashRaw: string, wsolRaw: string;
          if (row.requested_mode === "paper") {
            if (!status.paper || status.paper.positions.some(p => p.mint !== SOLANA_WRAPPED_SOL_MINT)) { results.push({ owner: row.owner, outcome: "held" }); continue; }
            cashRaw = status.paper.cashRaw; wsolRaw = status.paper.positions.find(p => p.mint === SOLANA_WRAPPED_SOL_MINT)?.amountRaw ?? "0";
          } else {
            // Not while one of the account's own trades or owner transactions awaits final confirmation: one that
            // landed leaves the vault short of its book until it is booked (status holds its blocker back then too).
            belowBook(scope, status.live.pending.length || status.live.ownerTransaction?.status === "pending" ? undefined : status.live.blockers);
            if (!status.live.balances || !status.live.tradable || status.live.pending.length || (!status.live.ready && !status.live.canExit)) { results.push({ owner: row.owner, outcome: "held" }); continue; }
            // The book's amounts, never the chain's: quarantined SOL is not the strategy's to sell.
            cashRaw = status.live.tradable.cashUsdg; wsolRaw = status.live.tradable.wsolRaw;
          }
          let solValueUsdgRaw = "0";
          if (BigInt(wsolRaw) > 0n) {
            const markIntent = parseSolanaSwapIntent({ kind: "spl-swap", chain: CHAINS.solana, mode: "paper", requestId: "rebalance-mark",
              inputMint: SOLANA_WRAPPED_SOL_MINT, outputMint: SOLANA_USDG_MINT, amountRaw: wsolRaw, slippageBps: 50 });
            let mark: SolanaQuote | null = null;
            try { mark = await options.market.quote(markIntent); }
            catch (error) { if (!(error instanceof SolanaMarketError && error.code === "zero-output")) throw error; }
            if (mark) { validateSolanaQuote(mark, markIntent, now()); solValueUsdgRaw = mark.minOutAmount; }
            // SOL no route buys back (Jupiter's zero-output answer) is dust: nothing to sell and worth
            // zero, as the runtime and the paper book value it at a buy. Planned as no position, so
            // it never stops the strategy. Live, only once Pyth shows it is worth under a cent
            // (the runtime's solMarkDust, the bound its buy check applies): a zero-output answer for
            // more is unusable, and like any other failure makes the tick unavailable, with no route built.
            else if (row.requested_mode === "paper" || await options.runtime.solMarkDust?.(wsolRaw)) wsolRaw = "0";
            else throw new SolanaMarketError("invalid-quote");
          }
          // A live buy keeps room to sell the whole position inside the rolling window (EXITS KEEP ROOM...): sized below it here, so
          // no route is built for a buy assessRisk would refuse, with what it brings counted with THE FILL MARGIN as the check counts
          // it (solanaExitReserveBuyRoom). The mark is Jupiter's guaranteed output, which may sit up to the tolerance below the
          // independent price the check values the position at. Within the registered permission's USDG per
          // 24 hours limit too, where it is below the saved one (solanaExitReserveLimits): the vault sells the exit under its own.
          let buyRoomUsdgRaw: string | undefined;
          if (row.requested_mode === "live") {
            const used = await solanaRollingLimitUse(options.db, scope, now()), registered = await registeredDailyUsdg(scope);
            const daily = registered !== undefined && registered < BigInt(limits.dailyUsdg) ? registered : BigInt(limits.dailyUsdg);
            buyRoomUsdgRaw = solanaExitReserveBuyRoom({ usedUsdgRaw: used.notionalRaw, dailyUsdgRaw: daily,
              positionValueUsdgRaw: BigInt(solValueUsdgRaw) * 10_000n / headroom, toleranceBps }).toString();
          }
          let intent = planSolanaRebalance({ cashRaw, wsolRaw, solValueUsdgRaw, limits, strategy, mode: row.requested_mode, revision, nowMs: now(), attempt: schedule.attempt,
            ...(buyRoomUsdgRaw === undefined ? {} : { buyRoomUsdgRaw }) });
          const cap = [BigInt(strategy.tradeUsdgRaw), BigInt(limits.perTradeUsdg)].reduce((a, b) => a < b ? a : b);
          if (intent) intent = await boundSolanaRebalanceSell(intent, row.requested_mode === "live" ? cap * headroom / 10_000n : cap, options.market, now);
          if (!intent) { said.delete(`below-minimum:${solanaAccountRef(scope)}`); inBand(); continue; }
          if (row.requested_mode === "live" && !status.live.ready && intent.inputMint === SOLANA_USDG_MINT) { results.push({ owner: row.owner, outcome: "held" }); continue; }
          // Under 1 USDG of the day's USDG limit left (SOLANA_STATUS_DAILY_USDG_BUYS_USED): only a sale of the whole position fits, so a
          // partial one would be refused at admission after a paid route. It waits its interval instead, as the window moves.
          if (row.requested_mode === "live" && intent.inputMint === SOLANA_WRAPPED_SOL_MINT && intent.amountRaw !== wsolRaw
            && status.live.blockers.includes(SOLANA_STATUS_DAILY_USDG_BUYS_USED)) { inBand(); continue; }
          if (options.signal?.aborted) break;
          // Already admitted under this ID (another worker got there first): a replay submits nothing.
          if (await admitted(scope, intent.requestId)) { results.push({ owner: row.owner, outcome: "replayed" }); continue; }
          try { await options.runtime.trade(scope, { mode: row.requested_mode, intent, autonomousRevision: Number(row.revision), signal: options.signal }); }
          catch (error) {
            if (row.requested_mode !== "live" || !(error instanceof SolanaTradingStoreError)) throw error;
            // Held by the owner's daily operations, which expired attempts used up (counted by admission after the
            // check above): said as an [alert], and not tried again until the interval passes, as when in band.
            if (error.message === SOLANA_EXPIRED_ATTEMPTS_EXHAUSTED) { await expiredUse(scope, limits.maxOpsPerDay, true); inBand(); continue; }
            // Worth under the live minimum at the reference: in band until the interval passes (BELOW THE LIVE MINIMUM).
            if (error.message === SOLANA_LIVE_BELOW_MINIMUM) { belowMinimum(scope, intent.inputMint === SOLANA_USDG_MINT ? "buy" : "sell", strategy.intervalSeconds); inBand(); continue; }
            // A buy that would leave too little room to sell the position (EXITS KEEP ROOM..., refused before anything was signed or at
            // admission): in band until the interval passes, as the window moves or the price does. Never a sale.
            if (error.message === SOLANA_LIVE_EXIT_RESERVE) { inBand(); continue; }
            throw error;
          }
          said.delete(`below-minimum:${solanaAccountRef(scope)}`);
          if (row.requested_mode === "live") await expiredUse(scope, limits.maxOpsPerDay, false);
          results.push({ owner: row.owner, outcome: "submitted" });
        } catch { results.push({ owner: row.owner, outcome: "unavailable" }); }
      }
      await beat();
      return results;
    },
  };
}

/**
 * The Solana worker's own app runtime, the one runSolanaAgent runs: it publishes the live rollout settings it runs as the
 * worker's (solana_runtime_live_rollout_seen) and judges the web's (SETTINGS THAT MUST MATCH, CHECKED, in the app runtime).
 * Built as the web's runtime instead, it would write over the web's digest and read a worker digest nobody writes, so
 * neither service would ever see a difference.
 */
export function solanaWorkerRuntime(options: Omit<SolanaAppRuntimeOptions, "service"> = {}) {
  return createSolanaAppRuntime({ localTestDeployment: false, ...options, service: "worker" });
}

/** Dedicated sibling worker; Solana addresses never enter the RH worker loop. */
export async function runSolanaAgent(signal: AbortSignal) {
  const db = await getSolanaRuntimeDb();
  // Initialize the shared binding schema without inventing or registering a tenant.
  const bindings = new SqlSolanaBindingStore(async () => db, process.env.DATABASE_URL ? "postgres" : "sqlite");
  await bindings.get("0x0000000000000000000000000000000000000000");
  // A malformed tolerance must not stop receipt recovery: live trades already
  // refuse it in the runtime, so only size with the widest headroom here.
  let referenceToleranceBps = SOLANA_REFERENCE_MAX_TOLERANCE_BPS;
  try { referenceToleranceBps = solanaReferenceToleranceBps(process.env); } catch { /* Refused at trade time. */ }
  // Only for the expired-attempt alerts; a malformed setting refuses every live trade in the runtime anyway.
  let expiredAttemptAllowance = SOLANA_DEFAULT_EXPIRED_ATTEMPT_ALLOWANCE;
  try { expiredAttemptAllowance = solanaExpiredAttemptAllowance(process.env); } catch { /* Refused at trade time. */ }
  // The worker's own runtime: it publishes its live rollout settings as the worker's, and holds buys while the web's differ.
  const agent = createSolanaAgent({ db, runtime: solanaWorkerRuntime(), market: createSolanaMarket(),
    postgres: !!process.env.DATABASE_URL, signal,
    referenceToleranceBps, expiredAttemptAllowance });
  while (!signal.aborted) {
    try {
      const results = await agent.tick();
      // Counts only: no credentials, signed bytes or tenant identities in logs.
      if (results.some(r => r.outcome !== "waiting")) process.stdout.write(JSON.stringify({ solana: "tick", submitted: results.filter(r => r.outcome === "submitted").length,
        replayed: results.filter(r => r.outcome === "replayed").length, held: results.filter(r => r.outcome === "held").length,
        waiting: results.filter(r => r.outcome === "waiting").length, unavailable: results.filter(r => r.outcome === "unavailable").length }) + "\n");
    } catch { process.stderr.write("Solana worker storage is unavailable; no new trades were admitted.\n"); }
    await new Promise<void>(resolve => {
      if (signal.aborted) return resolve();
      const onAbort = () => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); resolve(); };
      const timer = setTimeout(onAbort, 15_000); signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
