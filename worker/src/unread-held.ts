/**
 * A HELD COIN WHOSE BALANCE DID NOT COME BACK — what the tick does about it.
 *
 * PR #383 made a failed balance row count as "unread", never "not held". The
 * tick then put every unread coin the books say we hold into the same gate as
 * an unread cash balance, and that gate RETURNS before any strategy runs: no
 * stop-loss and no take-profit on any position, and every owner or Telegram
 * order refused. A row that fails on every tick (a token whose balanceOf
 * reverts for the holder, a symbol pointed at the wrong address) kept the
 * agent like that for good. Trencher agents froze the same way before #383,
 * because a second, raw read of the vault turned any one failed row into
 * "the whole read failed".
 *
 * The codebase's rule is "unvaluable means don't judge, never don't act", and
 * the unread Lighter venue already lives by it (index.ts venueGap). So does
 * this now: a held coin that did not read makes the book INCOMPLETE — no
 * equity row, no peak, no fee, no flow booking, equity unknown — while the
 * strategies, the drain and the class and perp routes keep running, so every
 * OTHER position can still be sold. Only whole-book gaps (cash, ETH, the
 * Morpho vault, the class vault, a whole positions read, the Trencher vault's
 * cash) still hold the tick.
 *
 * Unknown equity switches the drawdown breaker off (policy.ts), so this is
 * never shipped without its stand-in: policy.ts `holding-unread` refuses every
 * non-exit, and every sale of the unread coin itself, while any is set.
 *
 * PURE, every function here, because index.ts has no exports and a regex pin
 * cannot prove the unfreeze. index.ts calls these and keeps the state.
 */
import { bookGaps } from "./equity";
import type { AgentState } from "./policy";

/** How the Trencher vault's cash is named among the gaps that hold the tick. */
export const TRENCHER_CASH_GAP = "Trencher vault cash";

/**
 * WHICH UNREAD COINS THE BOOKS SAY WE HOLD — the ones that make the book
 * incomplete. Sorted, unique, and only ever symbols from `unread`.
 *
 * A failed row's coin is held if ANY of these says so:
 *
 *   - an open live basis, or a basis lookup that threw (`basisOnRecord`, the
 *     result of custody.ts unreadHeldOnRecord through openBasisQty — never
 *     getBasis, which answers zero for a failed query);
 *   - the Trencher vault's own tokens() lists it (vault custody only). The
 *     contract prunes that list at a zero balance, so it covers a vault coin
 *     whose basis was closed while the vault held every unit (Shogun's GATO);
 *   - it was held on the last LIVE tick that composed a book (in memory, and
 *     never from the `positions` table: that table has no mode column and
 *     paper ticks write it, so a paper row would pin a coin the live account
 *     never held). This closes the gap #383 left, where a held coin with no
 *     basis whose row failed dropped out of equity as if sold;
 *   - another custody's row read it as held THIS tick (the account row failed
 *     and the vault's answered, or the other way round). It is held by
 *     definition, and leaving it in the book would carry it at a partial
 *     balance — the half that answered — against its whole basis.
 *
 * A coin with none of these is still left out, as #383 decided: a mainnet
 * address with no code on a testnet grant fails every tick, and treating it
 * as held would refuse every buy for good. `strandedBasisSymbols` still
 * refuses to close anything on its account.
 */
export function unreadHeldOf(a: {
  unread: readonly string[];
  basisOnRecord: readonly string[];
  /** Lowercased addresses from the Trencher vault's tokens(); empty without vault custody. */
  vaultTokens: readonly string[];
  watch: readonly { symbol: string; address: string }[];
  lastLiveHeld: ReadonlySet<string>;
  heldThisTick: ReadonlySet<string>;
}): string[] {
  const basis = new Set(a.basisOnRecord);
  const vault = new Set(a.vaultTokens.map((t) => t.toLowerCase()));
  const inVault = new Set(a.watch.filter((t) => vault.has(t.address.toLowerCase())).map((t) => t.symbol));
  return [...new Set(a.unread)]
    .filter((s) => basis.has(s) || inVault.has(s) || a.lastLiveHeld.has(s) || a.heldThisTick.has(s))
    .sort();
}

/**
 * NEVER A PARTIAL HOLDING. An unread-held coin leaves every list WHOLE:
 * `positions`, `missingPrice` and `unpricedByDesign`.
 *
 * Partial is worse than absent. With the account row unread and the vault's
 * read, the coin would be valued at the vault half and judged against the
 * whole basis — a phantom loss the strategist's stop floor sells on.
 *
 * AND NEVER ROUTED THROUGH THE UNPRICED SET. The quarantine would carry it at
 * cost, which overstates equity when it has fallen, and the Trencher sells an
 * "unpriceable" coin it cannot see from the ledger (strategies/trencher.ts).
 * So this runs before `lastUnpricedSymbols` is built and before the quarantine.
 *
 * Returns the same object when nothing is unread.
 */
export function withoutUnreadHeld<P extends { symbol: string }>(
  book: { positions: P[]; missingPrice: string[]; unpricedByDesign: string[] },
  unreadHeld: readonly string[],
): { positions: P[]; missingPrice: string[]; unpricedByDesign: string[] } {
  if (unreadHeld.length === 0) return book;
  const gone = new Set(unreadHeld);
  return {
    positions: book.positions.filter((p) => !gone.has(p.symbol)),
    missingPrice: book.missingPrice.filter((s) => !gone.has(s)),
    unpricedByDesign: book.unpricedByDesign.filter((s) => !gone.has(s)),
  };
}

/**
 * WHICH GAPS HOLD THE TICK AND WHICH ONLY MAKE THE BOOK INCOMPLETE.
 *
 * `holdTick` takes the early return (index.ts `unreadBook`): the whole-book
 * gaps, every one a fixed protocol address or a whole read, so transient —
 * cash, ETH and the Morpho vault (`balances`), the class vault (all or
 * nothing, snapshot.ts readClassCustody), a whole positions read that failed,
 * and the Trencher vault's USDG. index.ts relies on the ETH read being whole
 * below that return.
 *
 * `incomplete` is the per-token half: the held coins whose own row failed.
 * They NEVER hold the tick — that return switches off every stop-loss on
 * every other position for as long as one row fails — and are empty when the
 * whole read failed, because "positions" then holds it and names it.
 */
export function classifyBookGaps(g: {
  /** bal.unread: "eth", "cash", "vault". */
  balances: readonly string[];
  /** classRead.unread: "class". */
  classVault: readonly string[];
  /** The account's positions read, or the Trencher vault's, failed whole. */
  positionsReadFailed: boolean;
  /** The Trencher vault's USDG balance could not be read. */
  trencherCashUnread: boolean;
  /** unreadHeldOf, this tick. */
  unreadHeld: readonly string[];
}): { holdTick: string[]; incomplete: string[] } {
  return {
    holdTick: bookGaps({
      unreadBalances: [...g.balances, ...g.classVault, ...(g.trencherCashUnread ? [TRENCHER_CASH_GAP] : [])],
      positionsReadFailed: g.positionsReadFailed,
      missingPrice: [], // reported separately by the tick — it has its own message
    }),
    incomplete: g.positionsReadFailed ? [] : [...new Set(g.unreadHeld)].sort(),
  };
}

/** What the wall is handed (policy.ts AgentState.heldUnread). */
export type HeldUnread = NonNullable<AgentState["heldUnread"]>;

/** Nothing unread: what paper, and every tick that read every row, hands the wall. */
export const NO_HELD_UNREAD: HeldUnread = Object.freeze({ symbols: Object.freeze([]) as readonly string[], tokens: new Map() });

/**
 * The unread-held coins as the wall reads them: by symbol, for the refusal
 * that names them, and by lowercased address, for the refusal of a trade
 * that would SELL one (policy.ts soldTokenOf). A symbol the watch set has no
 * address for still refuses every non-exit by name.
 */
export function heldUnreadOf(symbols: readonly string[], watch: readonly { symbol: string; address: string }[]): HeldUnread {
  if (symbols.length === 0) return NO_HELD_UNREAD;
  const want = new Set(symbols);
  return {
    symbols: [...want].sort(),
    tokens: new Map(watch.filter((t) => want.has(t.symbol)).map((t) => [t.address.toLowerCase(), t.symbol])),
  };
}

/** "A", "A and B", "A, B and C". */
function names(list: readonly string[]): string {
  if (list.length <= 1) return list[0] ?? "";
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

/**
 * THE OWNER'S EVENT, ONCE PER CHANGE OF THE SET — latched on the sorted
 * symbol key, the way the Lighter outage is (index.ts perpUnreadNoted).
 *
 * A warn whenever the set changes to a non-empty one, naming every coin in it;
 * one ok when it empties. Null when the set is the one the owner was last told
 * about. The policy rule and the order gates follow the raw per-tick set; this
 * only decides what is said.
 *
 * THE REMEDY DEPENDS ON WHERE THE COIN COMES FROM. A coin the owner watches
 * can be fixed in Settings or unwatched. A coin in the Trencher vault's own
 * token list cannot be unwatched — the vault's tokens() puts it back in the
 * watch set every tick — so telling its owner to check Settings would send
 * them looking for a control that does not exist.
 */
export function unreadHeldNotice(
  lastKey: string,
  unreadHeld: readonly string[],
  vaultCoins: ReadonlySet<string>,
  /**
   * What this tick's book holds, by symbol. A coin can leave the set without
   * reading again: the owner stopped watching it (the remedy this notice
   * gives), or it now reads as zero. "Back in the book" is only said of one
   * that is.
   */
  heldNow: ReadonlySet<string>,
): { key: string; event: { level: "warn" | "ok"; text: string } | null } {
  const now = [...new Set(unreadHeld)].sort();
  const key = now.join(",");
  if (key === lastKey) return { key, event: null };
  if (now.length === 0) {
    const was = lastKey.split(",").filter((s) => s.length > 0);
    const back = was.filter((s) => heldNow.has(s));
    const gone = was.filter((s) => !heldNow.has(s));
    const said: string[] = [];
    if (back.length > 0) {
      said.push(
        `I can read ${names(back)} again — ${back.length === 1 ? "it is" : "they are"} back in the book and no ` +
          `longer ${back.length === 1 ? "holds" : "hold"} back new buys.`,
      );
    }
    if (gone.length > 0) {
      const one = gone.length === 1;
      said.push(
        `${names(gone)} no longer ${one ? "holds" : "hold"} back new buys: ${one ? "it reads" : "they read"} as not ` +
          `held now, or ${one ? "is" : "are"} no longer watched, so I stopped counting ${one ? "it" : "them"}.`,
      );
    }
    return { key, event: { level: "ok", text: said.join(" ") } };
  }
  const one = now.length === 1;
  const it = one ? "it" : "them";
  const wallet = now.filter((s) => !vaultCoins.has(s));
  const vault = now.filter((s) => vaultCoins.has(s));
  const remedies: string[] = [];
  if (wallet.length > 0) {
    remedies.push(
      `If it lasts more than a few minutes, check ${names(wallet)}'s token address in Settings, or stop watching ` +
        `${wallet.length === 1 ? "it" : "them"} — I then stop counting ${wallet.length === 1 ? "it" : "them"} in ` +
        `your book, which can read as a loss against your drawdown limit.`,
    );
  }
  if (vault.length > 0) {
    remedies.push(
      `${names(vault)} ${vault.length === 1 ? "comes" : "come"} from your Trencher vault's own token list, so ` +
        `${vault.length === 1 ? "it" : "they"} cannot be unwatched: the balance check is failing on-chain. The coins ` +
        `stay in the vault either way. If it lasts more than a few minutes, contact support.`,
    );
  }
  return {
    key,
    event: {
      level: "warn",
      text:
        `couldn't read your ${names(now)} balance, and my books say you hold ${it} — so trading is exits-only ` +
        `until ${one ? "it reads" : "they read"}: nothing new is bought, while stop-losses, take-profits and sells ` +
        `of everything else still go out. Brain reviews and rebalancing trims wait for it too. I won't sell ` +
        `${names(now)} on a guessed size, and equity, P&L, the ` +
        `high-water mark and the fee are paused. This is a data gap, not a loss. ` +
        remedies.join(" "),
    },
  };
}

/**
 * The equity the tick book shows between ticks, and whether it is a partial
 * sum composed while a holding was unread.
 */
export interface ShownEquity {
  equityUsdg: bigint;
  shortOfHolding: boolean;
}

/** Before any tick has composed: nothing shown, and nothing short. */
export const NOTHING_SHOWN: ShownEquity = Object.freeze({ equityUsdg: 0n, shortOfHolding: false });

/**
 * WHAT THE TICK SHOWS, between ticks, as its equity (index.ts shownEquityUsdg).
 *
 * While the venue or a holding is unread the composed figure is a partial sum
 * — lower than the book, not equal to it — and it is what the heartbeat
 * divides a drawdown by and what an owner's order is judged against. So the
 * LAST figure shown stays, as a tick that cannot read a balance leaves it —
 * unless there never was one, when the partial figure beats a zero that reads
 * as "still saddling up" and would refuse the owner's sells too. That partial
 * is then flagged, so the heartbeat can stay silent about it.
 */
export function shownEquityOf(a: {
  equityUsdg: bigint;
  /** The book could be totalled this tick. */
  complete: boolean;
  venueUnread: boolean;
  holdingUnread: boolean;
  last: ShownEquity;
}): ShownEquity {
  if ((a.venueUnread || a.holdingUnread) && a.last.equityUsdg > 0n) return a.last;
  return { equityUsdg: a.equityUsdg, shortOfHolding: !a.complete && a.holdingUnread };
}

/**
 * THE HEARTBEAT'S DRAWDOWN, or null when the figure it would divide by is a
 * partial sum missing an unread holding.
 *
 * shownEquityOf keeps the last whole figure while a holding is unread, except
 * when there is none to keep: after a restart during the gap the tick book
 * starts at zero, so the first figure it holds is the partial one, and every
 * tick after keeps it. Divided into the peak, that is a loss nobody made, and
 * the notifier tells the owner "I have stopped buying… review your signed
 * drawdown limit" (telegram/notifier.ts) — a nudge toward re-signing a risk
 * limit over a read gap.
 *
 * NARROW ON PURPOSE: silenced only for a figure composed short of an unread
 * holding. An unread venue, an unknown cost and the early returns keep today's
 * behaviour.
 */
export function heartbeatDrawdownBps(a: { peakUsdg: bigint; shown: ShownEquity }): number | null {
  if (a.shown.shortOfHolding) return null;
  if (a.peakUsdg <= 0n || a.shown.equityUsdg <= 0n) return null;
  return Math.max(0, Number(((a.peakUsdg - a.shown.equityUsdg) * 10_000n) / a.peakUsdg));
}
