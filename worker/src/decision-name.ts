/**
 * THE NAME A DECISION ABOUT A COIN IS WRITTEN WITH — AND WHERE IT COMES FROM
 * WHEN THE TAPE HAS FORGOTTEN THE COIN AND A REDEPLOY HAS WIPED THE LEDGER.
 *
 * An autonomous Trencher symbol is address-derived (`T` plus eleven hex), and a
 * feed that prints only that says "sell TA151B4A9E1B 5.01 USDG" at a reader.
 * The name rides alongside it, display only, and this decides it:
 *
 *   1. THE TAPE'S, when the watch set still labels the coin (coinDisplayName).
 *      A held coin drops off the tape's qualified list, and discovery then
 *      labels it with its own id.
 *   2. THIS AGENT'S OWN LEDGER, the name its buy was written with
 *      (store.displayNameFor) — the child's sqlite, which every redeploy wipes.
 *   3. THE COIN'S OWN CONTRACT, which no redeploy touches (ChainCoinNames).
 *
 * Without the third, a coin bought before the latest deploy — the default
 * Trencher holds for up to three days — had every exit and review written
 * unnamed, and the reader's fallback, which looks only inside its own window,
 * could not recover a name that old.
 */
import type { StockToken } from "../../packages/core/src/index";
import { coinDisplayName } from "./coin-name";

/**
 * WHAT A COIN'S OWN CONTRACT CALLS IT, read once per coin per process.
 *
 * `symbol()` is text the deployer chose and can change, which is exactly why
 * it is never the coin's IDENTITY here (see coin-name.ts). As a display name
 * it is the same word the tape showed: a GeckoTerminal pool label is built
 * from it ("CASHCAT / WETH 1%"). And unlike the tape and the child's ledger,
 * the chain is still there after a redeploy.
 *
 * NEVER WAITED FOR. `peek` answers from what is already known and starts the
 * read when nothing is, so the decision in hand goes out unnamed and the answer
 * names the next one. It used to be awaited, raced against 1.5s — and a decision
 * is what an exit waits on before its swap is sent: three stops in one tick sat
 * 4.5s behind name reads, and the next tick waited again for a read still in
 * flight. A name is display text; no read of one may delay a trade. `warm`
 * starts the read before any decision needs it (discovery, for held coins).
 *
 * A failed read is remembered for `retryMs`, so a dead RPC is asked once per
 * window, not once per decision. A read that has not answered in `staleMs` no
 * longer holds the coin's slot, so one that never settles cannot stop the coin
 * ever being asked again. Sanitised by the same rule as the tape's label: an
 * address-shaped or unreadable answer is no name, never a placeholder.
 */
export class ChainCoinNames {
  private readonly known = new Map<string, string | null>();
  private readonly inflight = new Map<string, number>();
  private readonly failedAt = new Map<string, number>();
  private readonly retryMs: number;
  private readonly staleMs: number;
  private readonly now: () => number;

  constructor(
    private readonly readSymbol: (address: `0x${string}`) => Promise<unknown>,
    opts: { retryMs?: number; staleMs?: number; now?: () => number } = {},
  ) {
    this.retryMs = opts.retryMs ?? 5 * 60_000;
    this.staleMs = opts.staleMs ?? 60_000;
    this.now = opts.now ?? Date.now;
  }

  /**
   * The coin's name if a read has already answered, else null — and a read is
   * started so that a later decision has it. Synchronous, so no caller can
   * await the chain through it.
   */
  peek(token: StockToken): string | null {
    // A stock is already named by its ticker; only an address-derived id needs
    // a word, and coinDisplayName answers null for anything else anyway.
    if (token.kind !== "memecoin") return null;
    const key = token.address.toLowerCase();
    if (this.known.has(key)) return this.known.get(key) ?? null;
    this.start(token, key);
    return null;
  }

  /** Start the read ahead of any decision about the coin. Never waits, never throws. */
  warm(token: StockToken): void {
    this.peek(token);
  }

  private start(token: StockToken, key: string): void {
    const now = this.now();
    const since = this.inflight.get(key);
    if (since !== undefined && now - since < this.staleMs) return;
    const failed = this.failedAt.get(key);
    if (failed !== undefined && now - failed < this.retryMs) return;
    this.inflight.set(key, now);
    // Called on a later microtask, so a reader that throws synchronously is a
    // failed read like any other rather than an exception out of peek().
    void Promise.resolve()
      .then(() => this.readSymbol(token.address))
      .then(
        (raw) => {
          const name = coinDisplayName({ symbol: token.symbol, name: typeof raw === "string" ? raw : "", kind: "memecoin" });
          this.known.set(key, name);
          this.failedAt.delete(key);
        },
        () => {
          this.failedAt.set(key, this.now());
        },
      )
      .finally(() => {
        if (this.inflight.get(key) === now) this.inflight.delete(key);
      });
  }
}

/**
 * START THE NAME READS FOR WHAT THE TRENCHER HOLDS, as soon as discovery lists it.
 *
 * `peek` answers only what is already known, and after a redeploy the first
 * decision about a held coin is often its exit — so, unwarmed, the one row that
 * matters most would be the one written unnamed. Discovery lists every held coin
 * (by its own id) before the tick can value it: the tick waits for that list,
 * so the read has the minutes until the next tick to answer. HELD COINS ONLY:
 * a pool the tape qualified carries the tape's own label, and a read for every
 * coin on the tape would be a mainnet call per pool nobody bought.
 *
 * Never throws: it runs inside discovery's result handler, whose failure path
 * tells the owner discovery could not verify its data — a false sentence to
 * send over a display name.
 */
export function warmHeldNames(
  names: Pick<ChainCoinNames, "warm">,
  discovered: { tokens: readonly StockToken[]; held: readonly string[] },
): void {
  try {
    const held = new Set(discovered.held.map((a) => a.toLowerCase()));
    for (const t of discovered.tokens) {
      try {
        if (held.has(t.address.toLowerCase())) names.warm(t);
      } catch {
        // One malformed row costs its own name, not the others'.
      }
    }
  } catch {
    // A name is display only.
  }
}

/** The ledger step: store.displayNameFor's signature, so the real one plugs in. */
export type LedgerName = (
  agentId: string,
  symbol: string,
  fromTape: string | null,
  fromChain?: () => Promise<string | null>,
) => Promise<string | null>;

/**
 * One resolver for every decision-writing call site in the tick, so the exit,
 * the Trencher review and the Brain review cannot each ask a different
 * question. Never throws: a name is display only, and no lookup here may cost
 * a trade.
 *
 * The chain is asked only through the ledger step, which asks it only for an
 * address-derived id and only after its own miss — one rule, in store.ts. And
 * it is asked with `peek`: what is already known, never a wait (ChainCoinNames).
 */
export function makeDecisionNamer(deps: {
  /** The watch set as it stands now — re-read on every call. */
  watchTokens: () => readonly StockToken[];
  ledger: LedgerName;
  chain: ChainCoinNames;
}): (agentId: string, symbol: string) => Promise<string | null> {
  return async (agentId, symbol) => {
    try {
      const token = deps.watchTokens().find((t) => t.symbol === symbol);
      return await deps.ledger(agentId, symbol, coinDisplayName(token), token ? async () => deps.chain.peek(token) : undefined);
    } catch {
      return null;
    }
  };
}
