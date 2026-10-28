/**
 * Standalone local Solana simulation ledger. This database is deliberately not
 * the worker's live ledger: no grants, signing material, or chain transactions.
 * Fills use the quote's minimum output. Network fees and account rent are not
 * modeled; a receipt records a simulation, never proof of execution on chain.
 */
import { DatabaseSync } from "node:sqlite";
import { CHAINS, SOLANA_USDG_MINT } from "../../packages/core/src/ids";
import {
  parseSolanaRawAmount, parseSolanaSwapIntent, solanaPaperAgentId,
  SOLANA_QUOTE_MAX_AGE_MS,
  validateSolanaPaperLimits, validateSolanaQuote,
  type SolanaPaperLimits, type SolanaQuote, type SolanaSwapIntent,
} from "../../packages/core/src/solana";
import type { SolanaZeroOutputQuote } from "./solana-market";

const APPLICATION_ID = 0x4d535031; // MSP1: refuses existing unrelated databases.
const DAY_MS = 86_400_000;
export const SOLANA_PAPER_MAX_POSITIONS = 32;
const ERRORS = {
  invalid_input: "Invalid Solana paper input",
  incompatible_database: "This is not a standalone Solana paper database",
  book_exists: "The Solana paper book already exists; it cannot be refilled or reset",
  book_missing: "The Solana paper book does not exist",
  request_conflict: "The Solana paper request ID was already used for a different intent",
  version_conflict: "The Solana paper book changed while quoting; obtain fresh quotes",
  clock_rollback: "The Solana paper clock moved backwards",
  expired: "The Solana paper limits have expired",
  invalid_quote: "The Solana quote is invalid, stale, or does not match the intent",
  invalid_marks: "Fresh exact-size USDG marks are required for every open Solana position",
  stale_safety: "The Solana mint safety evidence is missing, stale or future-dated",
  per_trade_limit: "The Solana paper per-trade limit would be exceeded",
  daily_limit: "The Solana paper rolling 24-hour notional limit would be exceeded",
  operation_limit: "The Solana paper rolling 24-hour operation limit would be exceeded",
  drawdown_limit: "The Solana paper drawdown limit blocks additional buys",
  insufficient_balance: "The Solana paper balance is insufficient",
  decimals_conflict: "The Solana position decimals changed",
  position_limit: "The Solana paper open-position limit would be exceeded",
  balance_overflow: "The Solana paper token balance would exceed u64",
  loosen_required: "Raising a Solana paper limit (per-trade, daily, operations or drawdown) needs --loosen; lowering one never does",
  remainder_unquoted: "This Solana paper sell would leave a remainder that no route buys back; sell the whole position, or less of it",
  not_dust: "Only a whole position that no route buys back right now can be written off; sell it instead",
  no_position: "The Solana paper book holds no position in that mint",
} as const;
export class SolanaPaperStoreError extends Error {
  readonly code: keyof typeof ERRORS;
  constructor(code: keyof typeof ERRORS) {
    super(ERRORS[code]);
    this.name = "SolanaPaperStoreError";
    this.code = code;
  }
}
function fail(code: keyof typeof ERRORS): never { throw new SolanaPaperStoreError(code); }

export interface SolanaPaperPosition {
  mint: string;
  decimals: number;
  amountRaw: string;
  costBasisUsdgRaw: string;
}
export interface SolanaPaperReceipt {
  owner: string;
  agentId: string;
  chain: typeof CHAINS.solana;
  mode: "paper";
  execution: "simulated";
  /** Fee/rent exclusion remains visible when a receipt is exported alone. */
  excludesNetworkFeesAndRent: true;
  requestId: string;
  intent: SolanaSwapIntent;
  quote: SolanaQuote;
  /** Oldest observation timestamp across the input and output mint checks. */
  safetyObservedAtMs: number;
  /** Recorded buy exit evidence; this is not an executed exit. */
  buyExitQuote?: SolanaQuote;
  /** A partial sell's evidence that what it left can still be sold. */
  remainderQuote?: SolanaQuote;
  /** Held mints valued at zero for this decision: no route returned any output for them. */
  zeroValuedMints?: string[];
  side: "buy" | "sell";
  createdAtMs: number;
  version: number;
  inputAmountRaw: string;
  outputAmountRaw: string;
  notionalUsdgRaw: string;
  realizedPnlRaw: string;
}
export interface SolanaPaperSnapshot {
  owner: string;
  agentId: string;
  chain: typeof CHAINS.solana;
  mode: "paper";
  version: number;
  initialCashRaw: string;
  cashRaw: string;
  hwmRaw: string;
  realizedPnlRaw: string;
  limits: SolanaPaperLimits;
  /** Every owner renewal of the limits, oldest first. Absent until the first renewal. */
  limitsHistory?: SolanaPaperLimitsChange[];
  /** Dust lots the owner wrote off, oldest first. Absent until the first one. */
  writeOffs?: SolanaPaperWriteOffRecord[];
  positions: SolanaPaperPosition[];
  /** Most recent 100, newest first. Durable replay records are never pruned. */
  trades: SolanaPaperReceipt[];
  createdAtMs: number;
  updatedAtMs: number;
}
export type SolanaPaperBook = Omit<SolanaPaperSnapshot, "trades">;
/** The limits a renewal can raise, and so loosen; a later expiry is what a renewal is for. */
const LOOSENABLE = ["perTradeUsdg", "dailyUsdg", "maxOpsPerDay", "maxDrawdownBps"] as const;
type RenewableLimit = (typeof LOOSENABLE)[number] | "expiresAtMs";
/**
 * A renewal names the limits to change; any limit it omits keeps its current
 * value. Without `expiresAtMs` the expiry moves only when that is what the
 * renewal is for: an expired book gets SOLANA_PAPER_RENEW_DEFAULT_DAYS from
 * now, and a renewal that names no other change extends a running book to
 * that, or keeps its expiry if later. A renewal that names another change
 * keeps a running book's expiry as it is, so tightening a limit never also
 * lengthens how long the book may trade. Raising a limit needs `loosen`.
 */
export type SolanaPaperLimitsRenewal = { expiresAtMs?: number; loosen?: boolean }
  & Partial<Pick<SolanaPaperLimits, (typeof LOOSENABLE)[number]>>;
const RENEWAL_FIELDS = new Set(["expiresAtMs", "loosen", ...LOOSENABLE]);
export const SOLANA_PAPER_RENEW_DEFAULT_DAYS = 7;
/** One renewal, kept in the book forever: what the limits were, what they became, and when. */
export interface SolanaPaperLimitsChange {
  renewedAtMs: number;
  /** The book version this renewal produced. */
  version: number;
  previous: SolanaPaperLimits;
  limits: SolanaPaperLimits;
  /** Limits this renewal raised, which it could only do with `loosen`. */
  loosened: string[];
}
/**
 * A dust lot the owner wrote off: removed from the positions with its whole
 * remaining cost basis realized as a loss, so P&L shows what it cost. Cash,
 * equity (the lot was already valued at zero) and the peak do not move.
 */
export interface SolanaPaperWriteOffRecord {
  mint: string;
  decimals: number;
  amountRaw: string;
  costBasisUsdgRaw: string;
  /** Minus the cost basis. */
  realizedPnlRaw: string;
  /** When the market answered that no route buys the whole lot back (zeroOutputQuote.quotedAtMs). */
  zeroOutputObservedAtMs: number;
  /** That answer itself, as the market validated it: the write-off's evidence. */
  zeroOutputQuote: SolanaZeroOutputQuote;
  writtenOffAtMs: number;
  /** The book version the write-off produced. */
  version: number;
}
/** An owner's write-off of one dust lot, with the market's zero-output answer for the whole lot as evidence. */
export interface SolanaPaperWriteOff {
  owner: string;
  mint: string;
  /** The whole lot: a write-off never splits a position. */
  amountRaw: string;
  /**
   * The market's zero-output answer for exactly this lot back to USDG
   * (SolanaMarketError("zero-output").zeroOutput), checked again here and kept.
   */
  zeroOutputQuote: SolanaZeroOutputQuote;
  expectedVersion: number;
}
/**
 * The most slippage a write-off's zero-output quote may use. Its floor must
 * round to zero, and a larger slippage would let a quote with real output
 * pass as "zero": at 1% only an output of 0 or 1 raw unit qualifies.
 */
export const SOLANA_PAPER_WRITE_OFF_SLIPPAGE_BPS = 100;

/** What a renewal changed, for the owner to read: each changed limit's old and new value. */
export interface SolanaPaperRenewalReport {
  changes: Partial<Record<RenewableLimit, { from: string | number; to: string | number }>>;
  loosened: string[];
  expiryShortened: boolean;
}
type Book = SolanaPaperBook;
export interface SolanaPaperCommit {
  owner: string;
  intent: SolanaSwapIntent;
  quote: SolanaQuote;
  /** Oldest observation timestamp across the input and output mint checks. */
  safetyObservedAtMs: number;
  /** Required for a new buy: executable exit evidence for exactly minOut units. */
  buyExitQuote?: SolanaQuote;
  /**
   * Required for a partial sell: an executable quote back to USDG for exactly
   * what the sell leaves, so a sell never leaves dust that no route buys back.
   */
  remainderQuote?: SolanaQuote;
  /** Decimals of the non-USDG mint, verified by the market client. */
  tokenDecimals: number;
  /** All current positions at exact full size, or [] for an exit during outage. */
  marks: SolanaQuote[];
  /**
   * Held mints whose full-size exit quote returned no output at all (dust).
   * Each is valued at zero, the most conservative value: it can only lower
   * equity, so it never raises the peak or loosens the drawdown limit. Never
   * use it for a mark that failed; a failed mark blocks the buy.
   */
  zeroValuedMints?: string[];
  expectedVersion: number;
  /** Preparation timestamp only; risk checks use the store clock after locking. */
  nowMs: number;
}

function checked<T>(code: keyof typeof ERRORS, fn: () => T): T {
  try { return fn(); } catch { return fail(code); }
}
function timestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) fail("invalid_input");
}
function ownerKey(owner: string): string {
  checked("invalid_input", () => solanaPaperAgentId(owner));
  return owner;
}
function balance(amount: bigint): string {
  return checked("balance_overflow", () => {
    const raw = amount.toString();
    parseSolanaRawAmount(raw, true);
    return raw;
  });
}
/** Stable exact intent identity; deliberately excludes a retry's fresh quote. */
export function solanaPaperIntentFingerprint(value: SolanaSwapIntent): string {
  const intent = checked("invalid_input", () => parseSolanaSwapIntent(value));
  return JSON.stringify([
    intent.kind, intent.chain, intent.mode, intent.requestId,
    intent.inputMint, intent.outputMint, intent.amountRaw, intent.slippageBps,
  ]);
}

export class SolanaPaperStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(file: string, options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
    this.db = new DatabaseSync(file);
    try {
      // Check before setting WAL or schema pragmas: an accidental live DB path
      // must not modify the existing worker's database or its journal mode.
      this.assertDatabaseIdentity();
      this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
      this.transaction(() => {
        this.assertDatabaseIdentity();
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS solana_paper_books (
            owner TEXT COLLATE BINARY PRIMARY KEY,
            version INTEGER NOT NULL CHECK (version >= 0),
            book_json TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS solana_paper_trades (
            owner TEXT COLLATE BINARY NOT NULL REFERENCES solana_paper_books(owner),
            request_id TEXT COLLATE BINARY NOT NULL,
            fingerprint TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL,
            notional_usdg_raw TEXT NOT NULL,
            receipt_json TEXT NOT NULL,
            PRIMARY KEY (owner, request_id)
          );
          CREATE INDEX IF NOT EXISTS solana_paper_trades_window ON solana_paper_trades(owner, created_at_ms);
          PRAGMA application_id = ${APPLICATION_ID};
          PRAGMA user_version = 1;
        `);
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void { this.db.close(); }

  private assertDatabaseIdentity(): void {
    const appId = this.db.prepare("PRAGMA application_id").get()!.application_id;
    const version = this.db.prepare("PRAGMA user_version").get()!.user_version;
    const objects = this.db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
    if (appId === 0 && version === 0 && objects.length === 0) return;
    if (appId !== APPLICATION_ID || version !== 1) fail("incompatible_database");
    const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
    if (tables.length !== 2 || tables.some((row) => row.name !== "solana_paper_books" && row.name !== "solana_paper_trades")) fail("incompatible_database");
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private readBook(owner: string): Book | null {
    const row = this.db.prepare("SELECT book_json FROM solana_paper_books WHERE owner = ?").get(owner);
    return row ? JSON.parse(String(row.book_json)) as Book : null;
  }

  create(owner: string, initialCashRaw: string, limits: SolanaPaperLimits, preparedAtMs = this.now()): SolanaPaperSnapshot {
    ownerKey(owner);
    timestamp(preparedAtMs);
    checked("invalid_input", () => parseSolanaRawAmount(initialCashRaw));
    return this.transaction(() => {
      if (this.readBook(owner)) fail("book_exists");
      const nowMs = this.now();
      timestamp(nowMs);
      if (preparedAtMs > nowMs) fail("invalid_input");
      const validatedLimits = checked("invalid_input", () => validateSolanaPaperLimits(limits, nowMs));
      const book: Book = {
        owner, agentId: solanaPaperAgentId(owner), chain: CHAINS.solana, mode: "paper", version: 0,
        initialCashRaw, cashRaw: initialCashRaw, hwmRaw: initialCashRaw, realizedPnlRaw: "0",
        limits: validatedLimits, positions: [], createdAtMs: nowMs, updatedAtMs: nowMs,
      };
      this.db.prepare("INSERT INTO solana_paper_books(owner, version, book_json) VALUES (?, ?, ?)")
        .run(owner, 0, JSON.stringify(book));
      return { ...book, trades: [] };
    });
  }

  /**
   * Owner-run renewal of an existing book's limits, the only way to continue a
   * book whose limits expired. It replaces `limits` and nothing else: cash,
   * initial cash, the high-water mark, realized P&L, positions and every
   * receipt stay as they were, so a renewal can neither refill nor reset a
   * book. The new limits pass the same validation as creation, and the rolling
   * 24-hour caps keep counting trades made before the renewal. The version
   * advances, so a trade quoted against the old limits must be quoted again.
   *
   * It never loosens silently: raising the per-trade, daily, operations or
   * drawdown limit needs `loosen` (lowering one never does), a renewal without
   * an explicit expiry never shortens the current one and lengthens a running
   * book's only when it names no other change (SolanaPaperLimitsRenewal), and
   * every renewal is appended to the book's `limitsHistory` with the previous
   * and new limits.
   */
  renew(owner: string, renewal: SolanaPaperLimitsRenewal, preparedAtMs = this.now()): SolanaPaperSnapshot & { renewal: SolanaPaperRenewalReport } {
    ownerKey(owner);
    timestamp(preparedAtMs);
    if (!renewal || typeof renewal !== "object" || Array.isArray(renewal) || Object.keys(renewal).some((key) => !RENEWAL_FIELDS.has(key))
      || (renewal.expiresAtMs !== undefined && typeof renewal.expiresAtMs !== "number")
      || (renewal.loosen !== undefined && typeof renewal.loosen !== "boolean")) fail("invalid_input");
    const { loosen = false, ...named } = renewal;
    const changes = Object.fromEntries(Object.entries(named).filter(([, value]) => value !== undefined)) as Partial<SolanaPaperLimits>;
    return this.transaction(() => {
      const book = this.readBook(owner);
      if (!book) fail("book_missing");
      const nowMs = this.now();
      timestamp(nowMs);
      if (preparedAtMs > nowMs) fail("invalid_input");
      if (nowMs < book.updatedAtMs) fail("clock_rollback");
      if (book.version === Number.MAX_SAFE_INTEGER) fail("version_conflict");
      const previous = book.limits;
      const defaultExpiry = nowMs + SOLANA_PAPER_RENEW_DEFAULT_DAYS * DAY_MS;
      // Without an explicit expiry: revive an expired book; extend a running
      // one only for a renewal that asks for nothing else; otherwise keep it.
      const namesOtherChange = Object.keys(changes).some((key) => key !== "expiresAtMs");
      const expiresAtMs = changes.expiresAtMs ?? (nowMs >= previous.expiresAtMs ? defaultExpiry
        : namesOtherChange ? previous.expiresAtMs : Math.max(previous.expiresAtMs, defaultExpiry));
      // Validation errors keep their own message: they say which limit is wrong.
      const limits = validateSolanaPaperLimits({ ...previous, ...changes, expiresAtMs }, nowMs);
      const loosened = LOOSENABLE.filter((key) => BigInt(limits[key]) > BigInt(previous[key]));
      if (loosened.length && !loosen) fail("loosen_required");
      const renewed: Book = {
        ...book, limits, version: book.version + 1, updatedAtMs: nowMs,
        limitsHistory: [...(book.limitsHistory ?? []), { renewedAtMs: nowMs, version: book.version + 1, previous, limits, loosened: [...loosened] }],
      };
      const update = this.db.prepare("UPDATE solana_paper_books SET version = ?, book_json = ? WHERE owner = ? AND version = ?")
        .run(renewed.version, JSON.stringify(renewed), owner, book.version);
      if (update.changes !== 1) fail("version_conflict");
      const report: SolanaPaperRenewalReport = { changes: {}, loosened: [...loosened], expiryShortened: limits.expiresAtMs < previous.expiresAtMs };
      for (const key of [...LOOSENABLE, "expiresAtMs"] as const) {
        if (limits[key] !== previous[key]) report.changes[key] = { from: previous[key], to: limits[key] };
      }
      return { ...this.get(owner)!, renewal: report };
    });
  }

  get(owner: string): SolanaPaperSnapshot | null {
    ownerKey(owner);
    // One read statement supplies book + trades under the same SQLite snapshot.
    const rows = this.db.prepare(`
      SELECT b.book_json, t.receipt_json FROM solana_paper_books b
      LEFT JOIN solana_paper_trades t ON t.owner = b.owner
      WHERE b.owner = ? ORDER BY t.created_at_ms DESC, t.rowid DESC LIMIT 100
    `).all(owner);
    if (!rows.length) return null;
    return {
      ...JSON.parse(String(rows[0]!.book_json)) as Book,
      trades: rows.filter((row) => row.receipt_json !== null).map((row) => JSON.parse(String(row.receipt_json)) as SolanaPaperReceipt),
    };
  }

  findTrade(owner: string, requestId: string): SolanaPaperReceipt | null {
    ownerKey(owner);
    if (typeof requestId !== "string" || requestId.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(requestId)) fail("invalid_input");
    const row = this.db.prepare("SELECT receipt_json FROM solana_paper_trades WHERE owner = ? AND request_id = ?").get(owner, requestId);
    return row ? JSON.parse(String(row.receipt_json)) as SolanaPaperReceipt : null;
  }

  commit(input: SolanaPaperCommit): SolanaPaperReceipt {
    const owner = ownerKey(input.owner);
    const intent = checked("invalid_input", () => parseSolanaSwapIntent(input.intent));
    const fingerprint = solanaPaperIntentFingerprint(intent);
    return this.transaction(() => {
      // Durable idempotency precedes expiry/quote/version validation: a crash
      // after COMMIT must never cause a second fill or need a new market quote.
      const prior = this.db.prepare("SELECT fingerprint, receipt_json FROM solana_paper_trades WHERE owner = ? AND request_id = ?").get(owner, intent.requestId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) fail("request_conflict");
        return JSON.parse(String(prior.receipt_json)) as SolanaPaperReceipt;
      }
      const nowMs = this.now();
      const existingBook = this.readBook(owner);
      if (!existingBook) fail("book_missing");
      const recent = this.db.prepare("SELECT notional_usdg_raw FROM solana_paper_trades WHERE owner = ? AND created_at_ms > ?").all(owner, nowMs - DAY_MS);
      const { book, receipt } = applySolanaPaperCommit(existingBook, input, recent.map((row) => String(row.notional_usdg_raw)), nowMs);
      this.db.prepare("INSERT INTO solana_paper_trades(owner, request_id, fingerprint, created_at_ms, notional_usdg_raw, receipt_json) VALUES (?, ?, ?, ?, ?, ?)")
        .run(owner, intent.requestId, fingerprint, nowMs, receipt.notionalUsdgRaw, JSON.stringify(receipt));
      const update = this.db.prepare("UPDATE solana_paper_books SET version = ?, book_json = ? WHERE owner = ? AND version = ?")
        .run(book.version, JSON.stringify(book), owner, input.expectedVersion);
      if (update.changes !== 1) fail("version_conflict");
      return receipt;
    });
  }

  /** The owner's write-off of one dust lot (applySolanaPaperWriteOff). */
  writeOff(input: SolanaPaperWriteOff): SolanaPaperSnapshot & { writtenOff: SolanaPaperWriteOffRecord } {
    const owner = ownerKey(input.owner);
    return this.transaction(() => {
      const existing = this.readBook(owner);
      if (!existing) fail("book_missing");
      const { book, record } = applySolanaPaperWriteOff(existing, input, this.now());
      const update = this.db.prepare("UPDATE solana_paper_books SET version = ?, book_json = ? WHERE owner = ? AND version = ?")
        .run(book.version, JSON.stringify(book), owner, input.expectedVersion);
      if (update.changes !== 1) fail("version_conflict");
      return { ...this.get(owner)!, writtenOff: record };
    });
  }
}

/**
 * Pure write-off accounting, shared like applySolanaPaperCommit. Call under the
 * book's write lock with a post-lock clock. Only a whole lot that the market
 * just answered no route buys back can go: the answer itself is the evidence
 * (a Jupiter ExactIn quote of exactly this lot to USDG, at most
 * SOLANA_PAPER_WRITE_OFF_SLIPPAGE_BPS, a minimum output of 0 and an output
 * whose slippage floor is 0, with a context slot, quoted within the freshness
 * window), checked here again and kept in the record. A failed or missing
 * quote never qualifies, and the owner asks for each one. The lot leaves the
 * positions (freeing its slot) with its whole cost basis realized as a loss;
 * cash, the peak and the rolling trade caps do not move, and nothing is added
 * to the trades.
 */
export function applySolanaPaperWriteOff(bookInput: SolanaPaperBook, input: SolanaPaperWriteOff,
  nowMs: number): { book: SolanaPaperBook; record: SolanaPaperWriteOffRecord } {
  ownerKey(input.owner);
  timestamp(nowMs);
  const book = structuredClone(bookInput);
  if (input.owner !== book.owner) fail("invalid_input");
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion !== book.version || book.version === Number.MAX_SAFE_INTEGER) fail("version_conflict");
  if (nowMs < book.updatedAtMs) fail("clock_rollback");
  const evidence = zeroOutputEvidence(input.zeroOutputQuote);
  if (evidence.quotedAtMs > nowMs || nowMs - evidence.quotedAtMs >= SOLANA_QUOTE_MAX_AGE_MS) fail("stale_safety");
  const position = book.positions.find((item) => item.mint === input.mint);
  if (!position || typeof input.amountRaw !== "string" || input.amountRaw !== position.amountRaw) fail("not_dust");
  // The answer is about exactly this lot, back to cash, and buys back nothing.
  if (evidence.inputMint !== position.mint || evidence.outputMint !== SOLANA_USDG_MINT || evidence.inAmount !== position.amountRaw
    || BigInt(evidence.outAmount) * BigInt(10_000 - evidence.slippageBps) >= 10_000n) fail("not_dust");
  const basis = BigInt(position.costBasisUsdgRaw);
  book.positions = book.positions.filter((item) => item.mint !== input.mint);
  book.realizedPnlRaw = (BigInt(book.realizedPnlRaw) - basis).toString();
  book.version++;
  book.updatedAtMs = nowMs;
  const record: SolanaPaperWriteOffRecord = {
    mint: position.mint, decimals: position.decimals, amountRaw: position.amountRaw, costBasisUsdgRaw: position.costBasisUsdgRaw,
    realizedPnlRaw: (-basis).toString(), zeroOutputObservedAtMs: evidence.quotedAtMs, zeroOutputQuote: evidence, writtenOffAtMs: nowMs, version: book.version,
  };
  book.writeOffs = [...(book.writeOffs ?? []), record];
  return { book, record };
}

/** A well-formed zero-output answer, copied field by field (nothing else is kept), or invalid_quote. */
function zeroOutputEvidence(value: unknown): SolanaZeroOutputQuote {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_quote");
  const raw = value as Record<string, unknown>;
  const amount = (field: unknown) => typeof field === "string" && /^(0|[1-9][0-9]{0,19})$/.test(field) && BigInt(field) < 2n ** 64n;
  if (raw.source !== "jupiter" || typeof raw.inputMint !== "string" || typeof raw.outputMint !== "string"
    || !amount(raw.inAmount) || BigInt(raw.inAmount as string) === 0n || !amount(raw.outAmount) || raw.minOutAmount !== "0"
    || !Number.isSafeInteger(raw.slippageBps) || (raw.slippageBps as number) < 0 || (raw.slippageBps as number) > SOLANA_PAPER_WRITE_OFF_SLIPPAGE_BPS
    || !Number.isSafeInteger(raw.contextSlot) || (raw.contextSlot as number) < 1
    || !Number.isSafeInteger(raw.quotedAtMs) || (raw.quotedAtMs as number) < 0) fail("invalid_quote");
  return { source: "jupiter", inputMint: raw.inputMint as string, outputMint: raw.outputMint as string, inAmount: raw.inAmount as string,
    outAmount: raw.outAmount as string, minOutAmount: "0", slippageBps: raw.slippageBps as number, contextSlot: raw.contextSlot as number,
    quotedAtMs: raw.quotedAtMs as number };
}

/** Pure fill accounting shared by local CLI and tenant-bound SQLite/Postgres books.
 * Call only under a write lock, after durable replay lookup, with an authoritative
 * post-lock clock and the complete rolling-window notional list.
 */
export function applySolanaPaperCommit(bookInput: SolanaPaperBook, input: SolanaPaperCommit,
  recentNotionals: readonly string[], nowMs: number): { book: SolanaPaperBook; receipt: SolanaPaperReceipt } {
  const owner = ownerKey(input.owner);
  const intent = checked("invalid_input", () => parseSolanaSwapIntent(input.intent));
  timestamp(input.nowMs);
  // BEGIN IMMEDIATE can wait for another process. Caller preparation time
  // is not an execution clock: freshness and rolling caps use time sampled
  // only after we actually own the write transaction.
  timestamp(nowMs);
  if (input.nowMs > nowMs) fail("invalid_input");
  const book = structuredClone(bookInput);
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion !== book.version || book.version === Number.MAX_SAFE_INTEGER) fail("version_conflict");
  if (nowMs < book.updatedAtMs) fail("clock_rollback");
  if (nowMs >= book.limits.expiresAtMs) fail("expired");
  if (!Number.isSafeInteger(input.safetyObservedAtMs) || input.safetyObservedAtMs < 0
    || input.safetyObservedAtMs > nowMs || nowMs - input.safetyObservedAtMs >= SOLANA_QUOTE_MAX_AGE_MS) fail("stale_safety");
  if (!Number.isSafeInteger(input.tokenDecimals) || input.tokenDecimals < 0 || input.tokenDecimals > 18) fail("invalid_input");
  checked("invalid_quote", () => validateSolanaQuote(input.quote, intent, nowMs));
  if (!Array.isArray(input.marks) || input.marks.length > SOLANA_PAPER_MAX_POSITIONS) fail("invalid_marks");
  const side = intent.inputMint === SOLANA_USDG_MINT ? "buy" : "sell";
  if (side === "buy") {
    if (!input.buyExitQuote) fail("invalid_quote");
    const exitIntent: SolanaSwapIntent = {
      kind: "spl-swap", chain: CHAINS.solana, mode: "paper", requestId: "entry-exit-check",
      inputMint: intent.outputMint, outputMint: SOLANA_USDG_MINT,
      amountRaw: input.quote.minOutAmount, slippageBps: intent.slippageBps,
    };
    checked("invalid_quote", () => validateSolanaQuote(input.buyExitQuote!, exitIntent, nowMs));
  }
  const tokenMint = side === "buy" ? intent.outputMint : intent.inputMint;
  const position = book.positions.find((item) => item.mint === tokenMint);
  if (position && position.decimals !== input.tokenDecimals) fail("decimals_conflict");
  if (side === "buy" && !position && book.positions.length >= SOLANA_PAPER_MAX_POSITIONS) fail("position_limit");
  const amountIn = BigInt(intent.amountRaw);
  const amountOut = BigInt(input.quote.minOutAmount);
  // Sell risk counts the quoted gross USDG value, not the reduced simulated
  // fill, so a slippage setting cannot enlarge a risk allowance.
  const notional = side === "buy" ? amountIn : BigInt(input.quote.outAmount);
  if (notional > BigInt(book.limits.perTradeUsdg)) fail("per_trade_limit");
  if (recentNotionals.length >= book.limits.maxOpsPerDay) fail("operation_limit");
  if (recentNotionals.reduce((sum, raw) => sum + BigInt(raw), 0n) + notional > BigInt(book.limits.dailyUsdg)) fail("daily_limit");

  const zeroValued = input.zeroValuedMints ?? [];
  if (!Array.isArray(zeroValued) || zeroValued.length > SOLANA_PAPER_MAX_POSITIONS || new Set(zeroValued).size !== zeroValued.length
    || zeroValued.some((mint) => !book.positions.some((held) => held.mint === mint))) fail("invalid_marks");

  const cashBefore = BigInt(book.cashRaw);
  let equityBefore = cashBefore;
  // Explicit degraded exit mode: [] permits selling without other assets'
  // feeds. Partial or stale marks never silently masquerade as a full book.
  const completeMarks = side === "buy" || input.marks.length > 0 || zeroValued.length > 0;
  if (completeMarks) {
    if (input.marks.length + zeroValued.length !== book.positions.length) fail("invalid_marks");
    for (const held of book.positions) {
      const mark = input.marks.find((quote) => quote.inputMint === held.mint);
      if (zeroValued.includes(held.mint)) {
        // Dust no route will buy is worth nothing here, never an extrapolation.
        if (mark) fail("invalid_marks");
        continue;
      }
      if (!mark) fail("invalid_marks");
      const markIntent: SolanaSwapIntent = {
        kind: "spl-swap", chain: CHAINS.solana, mode: "paper", requestId: "mark",
        inputMint: held.mint, outputMint: SOLANA_USDG_MINT, amountRaw: held.amountRaw,
        slippageBps: mark.slippageBps,
      };
      checked("invalid_marks", () => validateSolanaQuote(mark, markIntent, nowMs));
      const value = BigInt(mark.minOutAmount);
      equityBefore += value;
    }
  }
  let hwm = BigInt(book.hwmRaw);
  if (equityBefore > hwm) hwm = equityBefore;
  if (side === "buy" && (hwm - equityBefore) * 10_000n >= hwm * BigInt(book.limits.maxDrawdownBps)) fail("drawdown_limit");

  let realized = 0n;
  let remainderQuote: SolanaQuote | undefined;
  if (side === "buy") {
    if (amountIn > cashBefore) fail("insufficient_balance");
    book.cashRaw = balance(cashBefore - amountIn);
    if (position) {
      position.amountRaw = balance(BigInt(position.amountRaw) + amountOut);
      position.costBasisUsdgRaw = (BigInt(position.costBasisUsdgRaw) + amountIn).toString();
    } else {
      book.positions.push({ mint: tokenMint, decimals: input.tokenDecimals, amountRaw: balance(amountOut), costBasisUsdgRaw: amountIn.toString() });
    }
  } else {
    if (!position || amountIn > BigInt(position.amountRaw)) fail("insufficient_balance");
    const heldAmount = BigInt(position.amountRaw);
    if (amountIn < heldAmount) {
      const remainderIntent: SolanaSwapIntent = {
        kind: "spl-swap", chain: CHAINS.solana, mode: "paper", requestId: "remainder-check",
        inputMint: tokenMint, outputMint: SOLANA_USDG_MINT, amountRaw: (heldAmount - amountIn).toString(), slippageBps: intent.slippageBps,
      };
      if (!input.remainderQuote) fail("remainder_unquoted");
      checked("remainder_unquoted", () => validateSolanaQuote(input.remainderQuote!, remainderIntent, nowMs));
      remainderQuote = structuredClone(input.remainderQuote);
    }
    const heldBasis = BigInt(position.costBasisUsdgRaw);
    // Full exit explicitly consumes every remaining basis unit; partial
    // sells floor the allocated basis, retaining rounding dust in the lot.
    const basisSold = amountIn === heldAmount ? heldBasis : heldBasis * amountIn / heldAmount;
    realized = amountOut - basisSold;
    book.cashRaw = balance(cashBefore + amountOut);
    if (amountIn === heldAmount) book.positions = book.positions.filter((item) => item.mint !== tokenMint);
    else {
      position.amountRaw = (heldAmount - amountIn).toString();
      position.costBasisUsdgRaw = (heldBasis - basisSold).toString();
    }
  }
  // No position's post-trade liquidation value is invented by extrapolating
  // a purchase quote or scaling a previous mark. Cash alone is a lower bound;
  // the next fully marked decision can establish a higher portfolio peak.
  const cashAfter = BigInt(book.cashRaw);
  if (cashAfter > hwm) hwm = cashAfter;
  book.hwmRaw = hwm.toString();
  book.realizedPnlRaw = (BigInt(book.realizedPnlRaw) + realized).toString();
  book.version++;
  book.updatedAtMs = nowMs;
  const receipt: SolanaPaperReceipt = {
    owner, agentId: book.agentId, chain: CHAINS.solana, mode: "paper", execution: "simulated",
    excludesNetworkFeesAndRent: true, requestId: intent.requestId, intent,
    quote: structuredClone(input.quote), side, createdAtMs: nowMs, version: book.version,
    safetyObservedAtMs: input.safetyObservedAtMs,
    ...(side === "buy" ? { buyExitQuote: structuredClone(input.buyExitQuote!) } : {}),
    ...(zeroValued.length ? { zeroValuedMints: [...zeroValued] } : {}),
    ...(remainderQuote ? { remainderQuote } : {}),
    inputAmountRaw: amountIn.toString(), outputAmountRaw: amountOut.toString(),
    notionalUsdgRaw: notional.toString(), realizedPnlRaw: realized.toString(),
  };
  return { book, receipt };
}
