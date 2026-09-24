/**
 * WHAT A TRADE WAS IN — A NAME AN OWNER CAN READ, FROM AN ADDRESS.
 *
 * Asked "what are their names", an agent answered "the ledger doesn't list
 * token names, just the USDG amounts", and it was right: `trades.target` is
 * never a token (it is a router, a vault, an adapter, or — on a row recovered
 * after a restart — the account itself), `fill_symbol` was only ever written in
 * the shared Postgres (it is now also written at trade time, see
 * fillSymbolFor), and a child's sqlite is wiped by every redeploy. The P&L
 * card printed `target` and so showed the owner their own vault's address as
 * if it were the coin.
 *
 * The coin IS knowable. The non-cash leg of `sell_token`/`buy_token` names it on
 * every executor row; a handful of local tables can put a word to that
 * address; and for a row recovered after a restart — no legs at all — the
 * transaction receipt still says which token moved. This module does exactly
 * that and nothing more, in a fixed order, cheapest and most trustworthy first.
 *
 * TRUST. A stock ticker or a token the owner added is theirs to trust. A coin's
 * own symbol() is whatever its deployer typed, so a label from the chain, the
 * discovery table or a decision is marked untrusted, and one that copies a
 * trusted ticker (a launchpad coin calling itself "USDG") always carries its
 * short address so it cannot pass for the real thing.
 *
 * Read-only throughout. It takes the read-only connection its caller already
 * opened, and the chain reads are single `eth_call`s with a timeout, cached.
 */

import { erc20Abi, type PublicClient } from "viem";

import { CASH, STOCK_TOKENS, officialCoinByAddress, type CustomToken } from "../../packages/core/src/index";
import { netTokenDeltas, type ReceiptLog } from "./fills";
import { pickAcquiredLeg } from "./inflight-reconcile";

/** The slice of a read-only sqlite connection this needs. */
export interface LabelDb {
  prepare(sql: string): { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] };
}

export type LabelSource =
  | "cash"
  | "stock"
  | "official"
  | "custom"
  | "account"
  | "decision"
  | "discovered"
  | "position"
  | "chain"
  | "none";

export interface TokenLabel {
  /** Lowercased, or null when the input was not an address. */
  address: string | null;
  /** What to call it. Never an address-shaped string. */
  ticker: string | null;
  /** A longer name, when one is known and differs from the ticker. */
  name: string | null;
  source: LabelSource;
  /** Curated or owner-chosen. False = the coin named itself. */
  trusted: boolean;
  /** An untrusted label that copies a trusted ticker. */
  clash: boolean;
}

const USDG = CASH.USDG.toLowerCase();
const WETH = CASH.WETH.toLowerCase();
const ADDR_RE = /^0x[0-9a-f]{40}$/;
/** A Trencher id, `T` + the last 11 hex of the address — an id, not a name. */
const TID_RE = /^T[0-9A-F]{11}$/;
/** What the chain may call itself before we repeat it (history-fill-repair's rule). */
const SAFE_SYMBOL_RE = /^[A-Za-z0-9$._ -]{1,32}$/;

export function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

/**
 * A ticker reduced to letters and digits for the impersonation check, so a
 * coin calling itself "$USDG", "USDG." or "t-sla" is still caught.
 */
function guardKey(s: string): string {
  return s.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

/** Symbols an untrusted label may not borrow without being flagged. */
function trustedTickers(custom: readonly CustomToken[]): Map<string, string> {
  const m = new Map<string, string>([
    ["USDG", USDG],
    ["WETH", WETH],
    ["ETH", WETH],
  ]);
  for (const t of STOCK_TOKENS) m.set(guardKey(t.symbol), t.address.toLowerCase());
  for (const t of custom) m.set(guardKey(t.symbol), t.address.toLowerCase());
  return m;
}

/** Is this a usable name, not an address in disguise or a placeholder? */
function usable(s: string | null | undefined): string | null {
  const v = (s ?? "").trim();
  if (!v || v === "?" || /^0x/i.test(v) || v.includes("…") || TID_RE.test(v)) return null;
  if (!SAFE_SYMBOL_RE.test(v)) return null;
  return v;
}

/** The token a trade row moved: the leg that is not the cash token. */
export function nonCashLeg(r: { sell_token?: string | null; buy_token?: string | null }): string | null {
  const s = r.sell_token?.toLowerCase() ?? null;
  const b = r.buy_token?.toLowerCase() ?? null;
  if (s === USDG && b) return b;
  if (b === USDG && s) return s;
  return null;
}

/** What may be stored as a fill's name: history-fill-repair's rule — no spaces; the web re-checks it. */
const FILL_SYMBOL_RE = /^[A-Za-z0-9$._-]{1,32}$/;

/**
 * The name to store with a fill of `coin` (trades.fill_symbol), or null.
 *
 * A curated or owner-chosen ticker for that address first. Otherwise the first
 * candidate that is a name — not an address, a Trencher id or a placeholder —
 * and does not copy a trusted ticker: the dashboard shows this column with no
 * impersonation check of its own, so a launchpad coin calling itself "NVDA" or
 * "$USDG" must never be stored under that name.
 */
export function fillSymbolFor(
  coin: string | null | undefined,
  candidates: readonly (string | null | undefined)[],
  custom: readonly CustomToken[] = [],
): string | null {
  const a = (coin ?? "").trim().toLowerCase();
  if (!ADDR_RE.test(a) || a === USDG || a === WETH) return null;
  const ok = (s: string) => FILL_SYMBOL_RE.test(s) && !/^0x/i.test(s) && !TID_RE.test(s);
  const known = tokenLabelSync(null, null, a, { customTokens: custom });
  if (known.trusted && known.ticker) return ok(known.ticker) ? known.ticker : null;
  const guard = trustedTickers(custom);
  for (const c of candidates) {
    const v = (c ?? "").trim();
    if (!ok(v)) continue;
    const owner = guard.get(guardKey(v));
    if (owner && owner !== a) continue;
    return v;
  }
  return null;
}

/** buy or sell, from the legs when the fill side was not recorded. */
export function sideOf(r: { fill_side?: string | null; sell_token?: string | null; buy_token?: string | null }): "buy" | "sell" | null {
  if (r.fill_side === "buy" || r.fill_side === "sell") return r.fill_side;
  if (r.sell_token?.toLowerCase() === USDG) return "buy";
  if (r.buy_token?.toLowerCase() === USDG) return "sell";
  return null;
}

/**
 * A row the arm-time reconciler recorded after a restart: the real trade
 * happened earlier on chain, this row was written when the agent came back, so
 * its time is the restart and not the trade. Unique shape — the wall never
 * lets the account target itself.
 */
export function isRestartCopy(r: {
  kind: string;
  target: string | null;
  agent_id: string;
  decision_id?: string | null;
  fill_side?: string | null;
}): boolean {
  return (
    r.kind === "swap" &&
    !!r.target &&
    r.target.toLowerCase() === r.agent_id.toLowerCase() &&
    !r.decision_id &&
    !r.fill_side
  );
}

function row<T>(db: LabelDb, sql: string, ...args: unknown[]): T | undefined {
  try {
    return db.prepare(sql).get(...args) as T | undefined;
  } catch {
    return undefined; // an older ledger without the table/column: no answer, not an error
  }
}

export interface LabelOpts {
  customTokens?: readonly CustomToken[];
  /** Addresses that are this owner's own account and vaults — never a coin. */
  own?: readonly string[];
}

/**
 * Every local source, no network. Returns a `none` label (with the address)
 * when nothing local knows it — the async version then asks the chain.
 */
export function tokenLabelSync(db: LabelDb | null, agentId: string | null, input: string, o: LabelOpts = {}): TokenLabel {
  const a = input.trim().toLowerCase();
  const custom = o.customTokens ?? [];
  const base = (l: Omit<TokenLabel, "address" | "clash"> & { clash?: boolean }): TokenLabel => ({ address: ADDR_RE.test(a) ? a : null, clash: false, ...l });

  if (!ADDR_RE.test(a)) {
    // Not an address — a ticker already. Echo it as the owner would type it.
    const t = usable(input);
    return base({ ticker: t ? t.toUpperCase() : null, name: null, source: "none", trusted: false });
  }
  // 0. Not a coin at all.
  if (o.own?.some((x) => x.toLowerCase() === a) || (agentId && agentId.toLowerCase() === a)) {
    return base({ ticker: null, name: "your agent's own account", source: "account", trusted: true });
  }
  // 1-4. Curated or owner-chosen.
  if (a === USDG) return base({ ticker: "USDG", name: "dollars (USDG)", source: "cash", trusted: true });
  if (a === WETH) return base({ ticker: "WETH", name: "wrapped ETH", source: "cash", trusted: true });
  const stock = STOCK_TOKENS.find((t) => t.address.toLowerCase() === a);
  if (stock) return base({ ticker: stock.symbol, name: stock.name !== stock.symbol ? stock.name : null, source: "stock", trusted: true });
  const official = officialCoinByAddress(4663, a);
  if (official) return base({ ticker: official.symbol, name: null, source: "official", trusted: true });
  const mine = custom.find((t) => t.address.toLowerCase() === a);
  if (mine) return base({ ticker: mine.symbol.toUpperCase(), name: null, source: "custom", trusted: true });

  const guard = trustedTickers(custom);
  const untrusted = (ticker: string | null, name: string | null, source: LabelSource): TokenLabel => {
    const owner = ticker ? guard.get(guardKey(ticker)) : undefined;
    return base({ ticker, name: name && name !== ticker ? name : null, source, trusted: false, clash: !!owner && owner !== a });
  };

  if (db) {
    // 5. The decision behind a trade in this token — its symbol, or the name
    //    the discovery feed gave it.
    const d = agentId
      ? row<{ symbol: string | null; display_name: string | null }>(
          db,
          `SELECT d.symbol, d.display_name FROM trades t JOIN decisions d ON d.id = t.decision_id AND d.agent_id = t.agent_id
            WHERE t.agent_id = ? AND (lower(t.buy_token) = ? OR lower(t.sell_token) = ?)
              AND (d.symbol IS NOT NULL OR d.display_name IS NOT NULL)
            ORDER BY t.id DESC LIMIT 1`,
          agentId,
          a,
          a,
        )
      : undefined;
    const dTicker = usable(d?.symbol);
    const dName = usable(d?.display_name);
    if (dTicker || dName) return untrusted(dTicker ?? dName, dName, "decision");
    // 6. A Trencher id's display name.
    const tid = `T${a.slice(-11).toUpperCase()}`;
    const t = agentId
      ? row<{ display_name: string | null }>(
          db,
          "SELECT display_name FROM decisions WHERE agent_id = ? AND symbol = ? AND display_name IS NOT NULL ORDER BY at DESC LIMIT 1",
          agentId,
          tid,
        )
      : undefined;
    const tName = usable(t?.display_name);
    if (tName) return untrusted(tName, null, "decision");
    // 7. What discovery read off the token.
    const p = row<{ symbol: string | null }>(db, "SELECT symbol FROM discovered_pools WHERE address = ? LIMIT 1", a);
    const pSym = usable(p?.symbol);
    if (pSym) return untrusted(pSym, null, "discovered");
    // 8. A current holding.
    const h = agentId
      ? row<{ symbol: string | null }>(db, "SELECT symbol FROM positions WHERE agent_id = ? AND lower(token) = ? LIMIT 1", agentId, a)
      : undefined;
    const hSym = usable(h?.symbol);
    if (hSym) return untrusted(hSym, null, "position");
    // 9. The name stored with a fill: written at trade time (fillSymbolFor) or
    //    read off the receipt by the shared ledger's repair. Untrusted unless
    //    it is a curated ticker — and a curated address was answered above.
    const f = agentId
      ? row<{ fill_symbol: string | null }>(
          db,
          `SELECT fill_symbol FROM trades WHERE agent_id = ? AND (lower(buy_token) = ? OR lower(sell_token) = ?)
              AND fill_symbol IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
          agentId,
          a,
          a,
        )
      : undefined;
    const fSym = usable(f?.fill_symbol);
    if (fSym) return untrusted(fSym, null, "chain");
  }
  return base({ ticker: null, name: null, source: "none", trusted: false });
}

/** Chain symbol() reads, remembered for an hour. Failures are remembered too, briefly. */
const chainCache = new Map<string, { at: number; symbol: string | null }>();
const CHAIN_TTL_MS = 3_600_000;
const CHAIN_MISS_TTL_MS = 300_000;

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((r) => {
    t = setTimeout(() => r(null), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } catch {
    return null;
  } finally {
    if (t) clearTimeout(t);
  }
}

/** Read a token's own symbol(). Null when unreadable, unsafe or slow. */
export async function chainSymbol(client: Pick<PublicClient, "readContract">, address: string, timeoutMs = 3_000): Promise<string | null> {
  const a = address.toLowerCase();
  const hit = chainCache.get(a);
  const now = Date.now();
  if (hit && now - hit.at < (hit.symbol ? CHAIN_TTL_MS : CHAIN_MISS_TTL_MS)) return hit.symbol;
  const raw = await withTimeout(
    client.readContract({ address: a as `0x${string}`, abi: erc20Abi, functionName: "symbol" }) as Promise<string>,
    timeoutMs,
  );
  const symbol = usable(typeof raw === "string" ? raw : null);
  chainCache.set(a, { at: now, symbol });
  return symbol;
}

/** Test seam. */
export function clearTokenLabelCacheForTest(): void {
  chainCache.clear();
  receiptCache.clear();
}

/** Every local source, then the chain. */
export async function tokenLabel(
  db: LabelDb | null,
  agentId: string | null,
  input: string,
  o: LabelOpts & { client?: Pick<PublicClient, "readContract"> | null; timeoutMs?: number } = {},
): Promise<TokenLabel> {
  const local = tokenLabelSync(db, agentId, input, o);
  if (local.source !== "none" || !local.address || !o.client) return local;
  const sym = await chainSymbol(o.client, local.address, o.timeoutMs);
  if (!sym) return local;
  const owner = trustedTickers(o.customTokens ?? []).get(guardKey(sym));
  return { ...local, ticker: sym, source: "chain", trusted: false, clash: !!owner && owner !== local.address };
}

/**
 * The words for a label. A clash always carries the short address, and so
 * does a label with nothing better than the address.
 */
export function labelText(l: TokenLabel): string {
  const word = l.ticker ?? l.name;
  if (!word) return l.address ? shortAddr(l.address) : "an unknown token";
  if (l.source === "account") return word;
  return l.clash && l.address ? `${word} (${shortAddr(l.address)}, not the real ${word})` : word;
}

/** What a receipt says a trade was, for a row that lost its legs. */
export interface ReceiptFacts {
  token: string;
  side: "buy" | "sell";
  /** USDG that moved, 6dp. */
  cashUsdg: bigint;
  /** Unix seconds of the block — the trade's true time. */
  blockTime: number | null;
}

const receiptCache = new Map<string, ReceiptFacts | null>();

/**
 * Side, token and cash from a transaction's own Transfer logs, netted over
 * everything that is this owner's book (the account and its vaults).
 *
 * Needed for rows recovered after a restart, which carry no legs. Memoised per
 * hash: a mined receipt never changes. Null when the receipt is unreadable or
 * does not describe one clean cash-for-token swap.
 */
export async function receiptFacts(
  client: Pick<PublicClient, "getTransactionReceipt" | "getBlock">,
  txHash: string,
  book: readonly string[],
  timeoutMs = 4_000,
): Promise<ReceiptFacts | null> {
  const key = `${txHash.toLowerCase()}|${[...book].map((b) => b.toLowerCase()).sort().join(",")}`;
  if (receiptCache.has(key)) return receiptCache.get(key)!;
  const receipt = await withTimeout(client.getTransactionReceipt({ hash: txHash as `0x${string}` }), timeoutMs);
  if (!receipt) return null; // not cached: a timeout is not an answer
  const leg = pickAcquiredLeg(netTokenDeltas(receipt.logs as unknown as ReceiptLog[], book), USDG);
  if (!leg) {
    receiptCache.set(key, null);
    return null;
  }
  const block = await withTimeout(client.getBlock({ blockNumber: receipt.blockNumber }), timeoutMs);
  const facts: ReceiptFacts = {
    token: leg.token,
    side: leg.side,
    cashUsdg: leg.cashUsdg,
    blockTime: block ? Number(block.timestamp) : null,
  };
  // Cached only with its time: a block read that timed out is not an answer either.
  if (block) receiptCache.set(key, facts);
  return facts;
}
