/** Read-only market preparation followed by one atomic paper-ledger commit. */
import { CHAINS, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM, canonicalId } from "../../packages/core/src/ids";
import { isHostedMode } from "../../packages/core/src/hosted";
import {
  SOLANA_QUOTE_MAX_AGE_MS,
  parseSolanaSwapIntent,
  parseSolanaTradeFloor,
  solanaPaperAgentId,
  solanaTradeFloorMet,
  validateSolanaQuote,
  type SolanaMint,
  type SolanaQuote,
  type SolanaSwapIntent,
} from "../../packages/core/src/solana";
import { SolanaMarketError, type SolanaZeroOutputQuote } from "./solana-market";
import {
  SOLANA_PAPER_WRITE_OFF_SLIPPAGE_BPS, solanaPaperIntentFingerprint, SolanaPaperStoreError, type SolanaPaperCommit, type SolanaPaperReceipt,
  type SolanaPaperSnapshot, type SolanaPaperWriteOff, type SolanaPaperWriteOffRecord,
} from "./solana-paper-store";

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

export class SolanaPaperServiceError extends Error {
  constructor(message: string) { super(message); this.name = "SolanaPaperServiceError"; }
}
/** The fixed refusal of a paper trade whose fresh quote guarantees less than the owner's previewed minimum. */
export const SOLANA_PAPER_PRICE_MOVED = "The fresh quote's minimum output is below the previewed minimum.";
/**
 * That refusal, carrying the fresh quote's guaranteed output so the owner can
 * see it and choose to trade at it with a new request. Nothing was recorded.
 */
export class SolanaPaperPriceMovedError extends SolanaPaperServiceError {
  constructor(readonly freshMinOutAmount: string) { super(SOLANA_PAPER_PRICE_MOVED); }
}

export function assertSolanaPaperLocalMode(): void {
  if (isHostedMode()) {
    throw new SolanaPaperServiceError("Solana paper trading is local-only until hosted tenant binding is implemented.");
  }
}

export interface SolanaPaperMarket {
  readMint(address: string): Promise<SolanaMint>;
  quote(intent: SolanaSwapIntent): Promise<SolanaQuote>;
}

export interface SolanaPaperLedger {
  get(owner: string): SolanaPaperSnapshot | null | Promise<SolanaPaperSnapshot | null>;
  findTrade(owner: string, requestId: string): SolanaPaperReceipt | null | Promise<SolanaPaperReceipt | null>;
  commit(input: SolanaPaperCommit): SolanaPaperReceipt | Promise<SolanaPaperReceipt>;
  /** Owner write-off of a dust lot; a ledger without it offers none. */
  writeOff?(input: SolanaPaperWriteOff): (SolanaPaperSnapshot & { writtenOff: SolanaPaperWriteOffRecord }) | Promise<SolanaPaperSnapshot & { writtenOff: SolanaPaperWriteOffRecord }>;
}

/** Slippage for the write-off's full-size exit quote (the store's ceiling for its evidence). */
export { SOLANA_PAPER_WRITE_OFF_SLIPPAGE_BPS };

function requireFreshMint(mint: SolanaMint, expected: string, nowMs: number): void {
  if (!mint || mint.address !== expected || canonicalId(CHAINS.solana, "token", mint.address) !== expected
    || ![TOKEN_PROGRAM, TOKEN_2022_PROGRAM].includes(mint.program)
    || !Number.isInteger(mint.decimals) || mint.decimals < 0 || mint.decimals > 18
    || !Number.isSafeInteger(mint.slot) || mint.slot < 1
    || !Number.isSafeInteger(mint.observedAtMs) || mint.observedAtMs > nowMs
    || nowMs - mint.observedAtMs >= SOLANA_QUOTE_MAX_AGE_MS
    || !Array.isArray(mint.buyBlockedReasons) || mint.buyBlockedReasons.some((reason) => typeof reason !== "string")) {
    throw new SolanaPaperServiceError("Solana mint evidence is missing, stale or inconsistent.");
  }
  if (expected === SOLANA_USDG_MINT && (mint.program !== TOKEN_2022_PROGRAM || mint.decimals !== 6)) {
    throw new SolanaPaperServiceError("The USDG mint does not match the configured cash asset.");
  }
}

/** Limit concurrent provider requests; a failed mark never becomes a zero valuation. */
async function mapBounded<T, U>(values: readonly T[], task: (value: T, index: number) => Promise<U>): Promise<U[]> {
  const results: U[] = new Array(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(3, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await task(values[index]!, index);
    }
  }));
  return results;
}

export function createSolanaPaperService(
  store: SolanaPaperLedger,
  market: SolanaPaperMarket,
  now: () => number = Date.now,
  /** Server-authenticated scope with a tenant-partitioned ledger. Never request data. */
  scope?: { owner: string },
) {
  function assertScope(owner: string): void {
    if (!scope) return assertSolanaPaperLocalMode();
    solanaPaperAgentId(scope.owner);
    if (owner !== scope.owner) throw new SolanaPaperServiceError("The Solana paper owner does not match this authenticated account.");
  }
  async function prepare(owner: string, rawIntent: unknown, valuePortfolio: boolean) {
    assertScope(owner);
    solanaPaperAgentId(owner);
    const intent = parseSolanaSwapIntent(rawIntent);
    const book = await store.get(owner);
    if (!book) throw new SolanaPaperServiceError("Create the Solana paper book before requesting a trade.");
    if (now() >= book.limits.expiresAtMs) throw new SolanaPaperServiceError("The Solana paper book's limits have expired.");
    const buying = intent.inputMint === SOLANA_USDG_MINT;
    if (buying && BigInt(intent.amountRaw) > BigInt(book.cashRaw)) {
      throw new SolanaPaperServiceError("Insufficient simulated USDG for this buy.");
    }
    let remainderIntent: SolanaSwapIntent | null = null;
    if (!buying) {
      const position = book.positions.find((p) => p.mint === intent.inputMint);
      if (!position || BigInt(intent.amountRaw) > BigInt(position.amountRaw)) {
        throw new SolanaPaperServiceError("Insufficient simulated token balance for this sell.");
      }
      const remainder = BigInt(position.amountRaw) - BigInt(intent.amountRaw);
      if (remainder > 0n) {
        remainderIntent = parseSolanaSwapIntent({ kind: "spl-swap", chain: CHAINS.solana, mode: "paper", requestId: "remainder-check",
          inputMint: intent.inputMint, outputMint: SOLANA_USDG_MINT, amountRaw: remainder.toString(), slippageBps: intent.slippageBps });
      }
    }
    const [inputMint, outputMint] = await Promise.all([
      market.readMint(intent.inputMint), market.readMint(intent.outputMint),
    ]);
    requireFreshMint(inputMint, intent.inputMint, now());
    requireFreshMint(outputMint, intent.outputMint, now());
    if (buying && (inputMint.buyBlockedReasons.length || outputMint.buyBlockedReasons.length)) {
      throw new SolanaPaperServiceError("Buying is blocked by the current token safety checks.");
    }
    const quote = await market.quote(intent);
    validateSolanaQuote(quote, intent, now());
    // Prove a current route back to cash for exactly the simulated entry
    // size. A buy quote alone says nothing about whether an exit is quoted.
    const exitIntent = buying ? parseSolanaSwapIntent({
      kind: "spl-swap", chain: CHAINS.solana, mode: "paper", requestId: "entry-exit-check",
      inputMint: intent.outputMint, outputMint: SOLANA_USDG_MINT,
      amountRaw: quote.minOutAmount, slippageBps: intent.slippageBps,
    }) : null;
    const exitQuote = exitIntent ? await market.quote(exitIntent) : null;
    if (exitQuote && exitIntent) validateSolanaQuote(exitQuote, exitIntent, now());
    // A partial sell must leave something a route still buys back: dust no
    // route will buy could never be sold and would hold a position slot.
    let remainderQuote: SolanaQuote | null = null;
    if (remainderIntent) {
      try { remainderQuote = await market.quote(remainderIntent); }
      catch (error) {
        // A book rule the owner can act on, answered like the store's own refusals.
        if (error instanceof SolanaMarketError && error.code === "zero-output") throw new SolanaPaperStoreError("remainder_unquoted");
        throw error;
      }
      validateSolanaQuote(remainderQuote, remainderIntent, now());
    }
    // Existing holdings must have current executable-sized exit quotes before
    // another buy. An unrelated illiquid holding must not stop an exit.
    const quoted = valuePortfolio && buying ? await mapBounded(book.positions, async (position, index) => {
      try {
        return await market.quote(parseSolanaSwapIntent({
          kind: "spl-swap", chain: CHAINS.solana, mode: "paper", requestId: `mark-${index}`,
          inputMint: position.mint, outputMint: SOLANA_USDG_MINT,
          amountRaw: position.amountRaw, slippageBps: intent.slippageBps,
        }));
      } catch (error) {
        // Dust no route will buy (a partial sell's remainder) is valued at
        // zero and recorded, rather than blocking every later buy. Any other
        // failure, an outage included, still blocks: never a zero valuation.
        if (error instanceof SolanaMarketError && error.code === "zero-output") return null;
        throw error;
      }
    }) : [];
    const marks = quoted.filter((mark): mark is SolanaQuote => mark !== null);
    const zeroValuedMints = book.positions.filter((_, index) => quoted[index] === null).map((position) => position.mint);
    return { intent, quote, exitQuote, remainderQuote, remainderIntent, inputMint, outputMint, marks, zeroValuedMints, version: book.version };
  }

  return {
    /** A preview has no accounting effect, and is not an execution authorization. */
    preview: (owner: string, intent: unknown) => prepare(owner, intent, false),
    /**
     * `minOutAmount`: the owner's floor, the previewed quote's guaranteed output.
     * Not part of the request's identity: a recorded request is returned whatever
     * floor a retry carries; a new one is refused before commit when the fresh
     * quote guarantees less, and nothing is recorded.
     */
    async trade(owner: string, rawIntent: unknown, admission: { minOutAmount?: string | null } = {}) {
      assertScope(owner);
      solanaPaperAgentId(owner);
      const intent = parseSolanaSwapIntent(rawIntent);
      const floor = admission.minOutAmount === undefined || admission.minOutAmount === null ? null : parseSolanaTradeFloor(admission.minOutAmount);
      // Recovery works even while RPC/Jupiter is down, or after limits expire.
      const existing = await store.findTrade(owner, intent.requestId);
      if (existing) {
        if (solanaPaperIntentFingerprint(existing.intent) !== solanaPaperIntentFingerprint(intent)) {
          throw new SolanaPaperServiceError("This request ID already belongs to a different paper trade.");
        }
        return existing;
      }
      const prepared = await prepare(owner, intent, true);
      if (!solanaTradeFloorMet(prepared.quote.minOutAmount, floor)) {
        throw new SolanaPaperPriceMovedError(prepared.quote.minOutAmount);
      }
      const nowMs = now();
      // Portfolio quote reads can take time; never commit using an expired
      // safety observation just because it was fresh at preparation start.
      requireFreshMint(prepared.inputMint, intent.inputMint, nowMs);
      requireFreshMint(prepared.outputMint, intent.outputMint, nowMs);
      if (prepared.exitQuote) {
        validateSolanaQuote(prepared.exitQuote, {
          ...intent, requestId: "entry-exit-check", inputMint: intent.outputMint,
          outputMint: SOLANA_USDG_MINT, amountRaw: prepared.quote.minOutAmount,
        }, nowMs);
      }
      if (prepared.remainderQuote && prepared.remainderIntent) validateSolanaQuote(prepared.remainderQuote, prepared.remainderIntent, nowMs);
      return store.commit({
        owner, intent, quote: prepared.quote, marks: prepared.marks,
        ...(prepared.zeroValuedMints.length ? { zeroValuedMints: prepared.zeroValuedMints } : {}),
        ...(prepared.remainderQuote ? { remainderQuote: prepared.remainderQuote } : {}),
        buyExitQuote: prepared.exitQuote ?? undefined,
        safetyObservedAtMs: Math.min(prepared.inputMint.observedAtMs, prepared.outputMint.observedAtMs),
        tokenDecimals: intent.inputMint === SOLANA_USDG_MINT ? prepared.outputMint.decimals : prepared.inputMint.decimals,
        expectedVersion: prepared.version, nowMs,
      });
    },
    /**
     * The owner's write-off of one dust lot. The whole lot is quoted back to
     * USDG first: only the market's zero-output answer qualifies it. A lot a
     * route still buys must be sold instead, and a failed quote (an outage)
     * writes off nothing.
     *
     * Owner decision (2026-10-20, conservative default): only that positive
     * evidence counts. A token with no route at all (delisted, rugged: Jupiter
     * errors or finds no route) raises a different error and can never be
     * written off, so its lot keeps its position slot. The alternative is an
     * explicit no-route write-off that needs repeated no-route answers spread
     * over time; it is not built. Both ledgers offer it: the local CLI book and
     * the hosted tenant book (SolanaTradingStore.paper()), each running
     * applySolanaPaperWriteOff under its own book lock with a post-lock clock.
     */
    async writeOff(owner: string, mint: string) {
      assertScope(owner);
      solanaPaperAgentId(owner);
      // A ledger without one offers none: this deployment's shape, not the owner's request.
      if (!store.writeOff) throw new SolanaPaperServiceError("This Solana paper ledger has no owner write-off.");
      const book = await store.get(owner);
      if (!book) throw new SolanaPaperStoreError("book_missing");
      const position = book.positions.find((p) => p.mint === mint);
      if (!position) throw new SolanaPaperStoreError("no_position");
      try {
        await market.quote(parseSolanaSwapIntent({ kind: "spl-swap", chain: CHAINS.solana, mode: "paper", requestId: "write-off-check",
          inputMint: mint, outputMint: SOLANA_USDG_MINT, amountRaw: position.amountRaw, slippageBps: SOLANA_PAPER_WRITE_OFF_SLIPPAGE_BPS }));
      } catch (error) {
        if (!(error instanceof SolanaMarketError && error.code === "zero-output")) throw error;
        // The answer itself is the evidence, checked again by the ledger and kept
        // with the write-off. A market that only says "zero" (no answer attached)
        // gives none: the ledger refuses that as invalid_quote and writes off nothing.
        return store.writeOff({ owner, mint, amountRaw: position.amountRaw, zeroOutputQuote: error.zeroOutput as SolanaZeroOutputQuote, expectedVersion: book.version });
      }
      // A route still buys it back: not dust, so it is sold, not written off.
      throw new SolanaPaperStoreError("not_dust");
    },
  };
}
