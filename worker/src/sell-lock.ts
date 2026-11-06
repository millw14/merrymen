/**
 * CAN IT BE SOLD BACK? A SALE SIMULATED BEFORE THE BUY.
 *
 * Shogun, 2026-11-04 00:15 UTC: the Brain bought 2.5 USDG of GATO
 * (0x436b01e4…c0aB) into the Trencher vault. GATO's transfer to its only pool
 * reverts for every holder except its deployer, so the vault holds 2,842 GATO
 * that no route can sell, and every exit since has failed with the bundler's
 * "STF". The buy cleared every check we had, because none of them moves the
 * TOKEN: the quoter swaps against the pool's reserves and reverts inside its
 * own callback, before the token's transfer into the pool ever runs, and the
 * price, depth, impact and allowlist checks only read.
 *
 * WHAT THIS DOES. Before a memecoin buy: one eth_call, which changes nothing,
 * of `token.transfer(pool, amount)` FROM THE ACCOUNT THAT WILL HOLD THE COIN —
 * the Trencher vault or the smart account, never the deployer — INTO THE POOL
 * THE ROUTE TRADES AGAINST. The account does not hold the coin yet, so the call
 * hands it a balance with a state override on the token's own balance slot,
 * found once per token by asking `balanceOf` with every common layout marked
 * (findBalanceSlot). It never depends on the agent already holding the token.
 *
 * If that sale reverts, one more call sends the same amount to a plain address.
 * When THAT goes through, the refusal is about the pool, which is the shape of
 * the trap: `locked`. Everything that cannot be shown — a failed read, a layout
 * this cannot set, no pool, a plain transfer refused as well — is `unknown`,
 * and an unknown refuses the buy exactly as `locked` does. Only `sellable` lets
 * a buy through (sellRefusal).
 *
 * WHAT THIS IS NOT, and each limit is real:
 *   - Not a tax check. A coin that keeps 99% of every sale returns success.
 *   - Not a promise about later. An owner who flips a switch after the buy is
 *     not seen; a `sellable` answer is cached for minutes, not hours, for that.
 *   - Not the router's exact call. A sale is `transferFrom(holder, pool)` by
 *     the router; this is `transfer(pool)` by the holder, which reaches the same
 *     `_transfer(holder, pool)` in every ERC-20 template we know. A token that
 *     tells the two apart is not caught.
 *   - Not every layout. A balance kept anywhere but a plain mapping slot (a
 *     reflection token's `_rOwned`, say) cannot be set, so the answer is
 *     `unknown`, and the buy is refused rather than made blind.
 *
 * COST, BOUNDED ON PURPOSE: the fleet's read quota is spent and its reads fail
 * over to the public RPC. One sale (plus one control when it reverts) per token
 * per cache window, two `balanceOf` calls per token per process to find its
 * slot, and one `getPool` per route. Answers are cached by verdict
 * (SELL_CHECK_TTL_MS) and concurrent asks for the same coin share one call.
 *
 * Verified against Robinhood Chain's public RPC, 2026-11-06: it serves eth_call
 * state overrides (it does not serve eth_createAccessList, which is why the slot
 * is found by marking candidates rather than by an access list). GATO's balance
 * is a plain mapping at slot 0; a transfer of it from an overridden holder to its
 * pool 0xd97ffa83…0d56 reverts, and from the pool to any other address goes
 * through.
 */

import {
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  erc20Abi,
  getAddress,
  keccak256,
  pad,
  parseAbi,
  slice,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

/** What a simulated sale showed. Only `sellable` lets a buy through. */
export type SellCheck =
  | { verdict: "sellable" }
  /** The sale into the pool reverted, and a plain transfer of the same amount went through. */
  | { verdict: "locked"; pool: Address; detail: string }
  /**
   * Nothing could be shown either way. `transient` is a failed read, which the
   * next window asks again; otherwise it is a fact about the coin (a layout
   * this cannot set, no pool, every transfer refused) and is asked rarely.
   */
  | { verdict: "unknown"; transient: boolean; detail: string };

/** How long each answer is believed, by verdict. */
export const SELL_CHECK_TTL_MS = {
  /** Short: an owner can lock a coin at any moment, and a buy is the moment that matters. */
  sellable: 10 * 60_000,
  /** Long: a lock rarely lifts, and a coin held in the vault is asked every tick. */
  locked: 6 * 3_600_000,
  /** A fact about the coin rather than about this read. */
  unknownSettled: 6 * 3_600_000,
  /** A failed read: asked again in a minute, never in a loop. */
  unknownTransient: 60_000,
} as const;

/**
 * Where a sale goes when there is no pool in the question: a fixed address with
 * no code and no history, derived rather than chosen so that no token's
 * special-case list (the zero address, 0x…dEaD) can name it.
 */
export const CONTROL_RECIPIENT: Address = getAddress(slice(keccak256(toHex("merrymen sell-lock control recipient")), 12));

/** The marker `findBalanceSlot` writes: big enough that no real balance meets it by chance, small enough not to overflow arithmetic on it. */
const MARK = 1n << 100n;

/** OpenZeppelin v5 ERC20Upgradeable's namespaced storage (ERC-7201); `_balances` is its first field. */
const OZ5_ERC20_STORAGE = "0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00" as const;
/** Solady ERC20's `_BALANCE_SLOT_SEED`. */
const SOLADY_BALANCE_SEED = 0x87a211a2n;

/**
 * Solidity mapping slots a balance is found at: 0–63 (OpenZeppelin v4 puts it
 * at 0, a tax token behind Ownable and friends a few slots later), and the
 * upgradeable layouts, where each inherited base reserves a 50-slot gap —
 * `_balances` at 51 behind Initializable and Context (this chain's own WETH,
 * 0x0Bd7…AD73, and every launchpad clone of ERC20Upgradeable), 101 or 151 with
 * one or two more bases ahead of it.
 */
const MAPPING_SLOTS: readonly bigint[] = [
  ...Array.from({ length: 64 }, (_, i) => BigInt(i)),
  ...Array.from({ length: 6 }, (_, i) => 100n + BigInt(i)),
  ...Array.from({ length: 6 }, (_, i) => 150n + BigInt(i)),
];

/**
 * Every storage slot a common ERC-20 keeps `holder`'s balance in, most likely
 * first: a Solidity mapping (MAPPING_SLOTS), a Vyper mapping at 0–7,
 * OpenZeppelin v5's namespaced storage, and Solady's seeded slot.
 */
export function balanceSlotCandidates(holder: Address): Hex[] {
  const out: Hex[] = [];
  for (const i of MAPPING_SLOTS) {
    out.push(keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [holder, i])));
  }
  for (let i = 0n; i < 8n; i++) {
    out.push(keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "address" }], [i, holder])));
  }
  out.push(keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [holder, OZ5_ERC20_STORAGE])));
  // Solady: mstore(0x0c, seed); mstore(0x00, owner); keccak256(0x0c, 0x20) —
  // the owner's 20 bytes, then the low 12 bytes of the seed word.
  out.push(keccak256(encodePacked(["address", "uint96"], [holder, SOLADY_BALANCE_SEED])));
  return [...new Set(out)];
}

const word = (v: bigint): Hex => pad(toHex(v), { size: 32 });

/**
 * DID THE CHAIN ANSWER "REVERTED", AS OPPOSED TO NOT ANSWERING?
 *
 * Strict on purpose, because the answer decides between `locked` and `unknown`
 * and only one of them may ever be written by a failed request. A revert must
 * be named in the cause chain (viem's ExecutionRevertedError, or JSON-RPC code
 * 3), and nothing in the chain may be a transport failure: a 429, a timeout, a
 * dropped socket or a provider's "limit exceeded" is our request failing, and
 * is `unknown`. rpc-error.ts classifyRpcError reads every CallExecutionError as
 * a revert, which is right for its retry question and wrong for this one.
 */
export function chainReverted(error: unknown): boolean {
  let reverted = false;
  let e: unknown = error;
  for (let depth = 0; e && depth < 16; depth++) {
    const node = e as { name?: unknown; code?: unknown; status?: unknown };
    const name = String(node.name ?? "");
    if (TRANSPORT_FAILURES.has(name)) return false;
    if (typeof node.status === "number" && (node.status === 429 || node.status >= 500)) return false;
    if (node.code === -32005 || node.code === 429) return false;
    if (name === "ExecutionRevertedError" || node.code === 3) reverted = true;
    e = (e as { cause?: unknown }).cause;
  }
  return reverted;
}

const TRANSPORT_FAILURES = new Set([
  "HttpRequestError",
  "TimeoutError",
  "WebSocketRequestError",
  "SocketClosedError",
  "LimitExceededRpcError",
  "AbortError",
]);

const describe = (e: unknown): string => {
  const o = e as { shortMessage?: unknown; message?: unknown } | null;
  const text = typeof o?.shortMessage === "string" ? o.shortMessage : typeof o?.message === "string" ? o.message : String(e);
  // No URL ever reaches a log line from here: a keyed provider's key is in it.
  return text.replace(/https?:\/\/\S+/g, "<rpc>").replace(/\s+/g, " ").slice(0, 120);
};

type Override = { slot: Hex; value: bigint } | null;

/**
 * One transfer, simulated. `ok` is a transfer the token accepted the way the
 * vault's own `_call` does (TrencherVault.sol): no return data, or a single
 * word that decodes true. `refused` is a revert or a `false`. Anything else
 * — the request failing — is `failed`.
 */
async function simulateTransfer(
  client: PublicClient,
  args: { token: Address; from: Address; to: Address; amount: bigint; override: Override },
): Promise<{ kind: "ok" } | { kind: "refused" } | { kind: "failed"; detail: string }> {
  try {
    const { data } = await client.call({
      account: args.from,
      to: args.token,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [args.to, args.amount] }),
      ...(args.override
        ? { stateOverride: [{ address: args.token, stateDiff: [{ slot: args.override.slot, value: word(args.override.value) }] }] }
        : {}),
    });
    if (!data || data === "0x") return { kind: "ok" };
    if (data.length === 66) return BigInt(data) === 1n ? { kind: "ok" } : { kind: "refused" };
    return { kind: "refused" };
  } catch (e) {
    return chainReverted(e) ? { kind: "refused" } : { kind: "failed", detail: describe(e) };
  }
}

/**
 * WHERE `holder`'s BALANCE OF `token` LIVES, so a sale can be simulated from an
 * account that holds none.
 *
 * Two calls. The first asks `balanceOf(holder)` with EVERY candidate slot set
 * to its own distinct marker, so the one that comes back names the slot. The
 * second asks again with ONLY that slot set, because a balance read through
 * another marked slot (a reflection token's "is excluded" flag routing it to a
 * second mapping) would otherwise be taken for a plain one. Only an exact
 * echo of the marker counts: a token that transforms its balance cannot be set
 * by this, and says so.
 */
export async function findBalanceSlot(
  client: PublicClient,
  token: Address,
  holder: Address,
): Promise<{ ok: true; slot: Hex } | { ok: false; transient: boolean; detail: string }> {
  const candidates = balanceSlotCandidates(holder);
  const read = async (stateDiff: { slot: Hex; value: Hex }[]): Promise<bigint | { failed: string }> => {
    try {
      const { data } = await client.call({
        to: token,
        data: encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [holder] }),
        stateOverride: [{ address: token, stateDiff }],
      });
      return decodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", data: data ?? "0x" });
    } catch (e) {
      return { failed: describe(e) };
    }
  };
  const all = await read(candidates.map((slot, i) => ({ slot, value: word(MARK + BigInt(i)) })));
  if (typeof all !== "bigint") return { ok: false, transient: true, detail: `its balance could not be read (${all.failed})` };
  const at = all >= MARK && all < MARK + BigInt(candidates.length) ? Number(all - MARK) : -1;
  if (at < 0) return { ok: false, transient: false, detail: "its balances are not kept in a layout a simulated sale can set" };
  const slot = candidates[at]!;
  const alone = await read([{ slot, value: word(MARK) }]);
  if (typeof alone !== "bigint") return { ok: false, transient: true, detail: `its balance could not be read (${alone.failed})` };
  if (alone !== MARK) return { ok: false, transient: false, detail: "its balances are not kept in a layout a simulated sale can set" };
  return { ok: true, slot };
}

/**
 * Simulate selling `amount` of `token` from `holder` into every pool in
 * `pools`, and say what it showed. See the header for the verdicts.
 *
 * `heldRaw` is what `holder` actually holds. When that covers `amount` the
 * chain's own state is used and nothing is overridden — the most faithful
 * question there is, and the one a coin already in the vault is asked.
 */
export async function simulateSell(
  client: PublicClient,
  args: {
    token: Address;
    holder: Address;
    pools: readonly Address[];
    amount: bigint;
    heldRaw?: bigint;
    /** Where this token's balance slot for this holder is, when already found. */
    slot?: Hex;
  },
): Promise<SellCheck & { slot?: Hex }> {
  if (args.pools.length === 0) return { verdict: "unknown", transient: false, detail: "no pool was found to sell it into" };
  const amount = args.amount > 0n ? args.amount : 1n;
  let override: Override = null;
  let slot = args.slot;
  if (args.heldRaw === undefined || args.heldRaw < amount) {
    if (!slot) {
      const found = await findBalanceSlot(client, args.token, args.holder);
      if (!found.ok) return { verdict: "unknown", transient: found.transient, detail: found.detail };
      slot = found.slot;
    }
    // Twice the amount: a coin that refuses to let a holder sell its whole
    // balance must not read as a coin that refuses every sale.
    override = { slot, value: amount * 2n };
  }
  const withSlot = <T extends SellCheck>(c: T): T & { slot?: Hex } => (slot ? { ...c, slot } : c);
  let refusedAt: Address | null = null;
  let failed: string | null = null;
  for (const pool of args.pools) {
    const r = await simulateTransfer(client, { token: args.token, from: args.holder, to: pool, amount, override });
    if (r.kind === "refused") {
      refusedAt = pool;
      break;
    }
    if (r.kind === "failed") failed ??= r.detail;
  }
  if (!refusedAt) {
    return failed
      ? withSlot({ verdict: "unknown", transient: true, detail: `a test sale could not be run (${failed})` })
      : withSlot({ verdict: "sellable" });
  }
  // THE CONTROL: the same amount, from the same holder, to a plain address.
  // Without it a reverted sale could be our override missing the balance, or
  // a coin that refuses every transfer, and neither is the pool refusing.
  const control = await simulateTransfer(client, {
    token: args.token,
    from: args.holder,
    to: CONTROL_RECIPIENT,
    amount,
    override,
  });
  if (control.kind === "ok") {
    return withSlot({
      verdict: "locked",
      pool: refusedAt,
      detail: `a test sale into its pool ${refusedAt} was refused, while a plain transfer of the same amount went through`,
    });
  }
  if (control.kind === "failed") {
    return withSlot({ verdict: "unknown", transient: true, detail: `a test sale could not be checked (${control.detail})` });
  }
  return withSlot({
    verdict: "unknown",
    transient: false,
    detail: "a test sale into its pool was refused, and so was a plain transfer, so a sale could not be shown",
  });
}

/** The two refusals a buy can meet here, spelled as the tape spells them. */
export type SellRefusalRule = "sell-locked" | "sell-unverified";

/**
 * May a buy go ahead on this answer? Null when it may. An unknown refuses
 * exactly as a lock does: a coin that cannot be shown to sell is not bought.
 */
export function sellRefusal(check: SellCheck, label: string): { rule: SellRefusalRule; detail: string } | null {
  switch (check.verdict) {
    case "sellable":
      return null;
    case "locked":
      return { rule: "sell-locked", detail: `not buying ${label}: ${check.detail}, so it could be bought and never sold` };
    case "unknown":
      return {
        rule: "sell-unverified",
        detail: `not buying ${label}: ${check.detail}, and a coin that cannot be shown to sell back is not bought`,
      };
  }
}

const V3_FACTORY_ABI = parseAbi(["function getPool(address a, address b, uint24 fee) view returns (address)"]);
const ZERO = "0x0000000000000000000000000000000000000000";

/** The route a buy priced, in the shape venues/uniswap.ts `Quote` carries it. */
export interface RouteRef {
  /** What the buy spends: the first token of a direct route. */
  tokenIn: Address;
  /** The coin being bought. */
  token: Address;
  fee: number;
  path?: { tokens: readonly Address[]; fees: readonly number[] };
  v4?: unknown;
}

/**
 * THE CACHE, AND THE ONLY DOOR TO THE CHAIN IN THIS FILE THE TICK USES.
 *
 * One per worker, in index.ts. Every answer is kept for its verdict's window
 * (SELL_CHECK_TTL_MS), keyed by token, holder and pools; two asks for the same
 * coin at once share one simulation; a balance slot, once found, is kept for
 * the process; and a v3 pool address, once read, is kept for good, because the
 * factory never moves one.
 */
export class SellLockGate {
  private readonly verdicts = new Map<string, { token: string; check: SellCheck; until: number }>();
  private readonly inflight = new Map<string, Promise<SellCheck>>();
  private readonly slots = new Map<string, Hex>();
  private readonly poolAt = new Map<string, Address>();
  private readonly canonical = new Map<string, { pools: Address[]; until: number }>();
  private readonly now: () => number;
  private readonly ttl: Record<keyof typeof SELL_CHECK_TTL_MS, number>;

  constructor(opts: { now?: () => number; ttl?: Partial<Record<keyof typeof SELL_CHECK_TTL_MS, number>> } = {}) {
    this.now = opts.now ?? Date.now;
    this.ttl = { ...SELL_CHECK_TTL_MS, ...opts.ttl };
  }

  private ttlOf(check: SellCheck): number {
    if (check.verdict === "sellable") return this.ttl.sellable;
    if (check.verdict === "locked") return this.ttl.locked;
    return check.transient ? this.ttl.unknownTransient : this.ttl.unknownSettled;
  }

  /** The answer for selling `token` from `holder` into `pools`, from the cache when it is still believed. */
  async check(
    client: PublicClient,
    req: { token: Address; holder: Address; pools: readonly Address[]; amount: bigint; heldRaw?: bigint },
  ): Promise<SellCheck> {
    const token = req.token.toLowerCase();
    const holder = req.holder.toLowerCase();
    const key = [token, holder, req.heldRaw === undefined ? "entry" : "held", ...req.pools.map((p) => p.toLowerCase()).sort()].join("|");
    const now = this.now();
    const cached = this.verdicts.get(key);
    if (cached && cached.until > now) return cached.check;
    const running = this.inflight.get(key);
    if (running) return running;
    const slotKey = `${token}|${holder}`;
    const run = (async (): Promise<SellCheck> => {
      const result = await simulateSell(client, { ...req, slot: this.slots.get(slotKey) }).catch(
        (e): SellCheck => ({ verdict: "unknown", transient: true, detail: `a test sale could not be run (${describe(e)})` }),
      );
      const { slot, ...check } = result as SellCheck & { slot?: Hex };
      if (slot) this.slots.set(slotKey, slot);
      this.remember(key, token, check);
      return check;
    })();
    this.inflight.set(key, run);
    try {
      return await run;
    } finally {
      this.inflight.delete(key);
    }
  }

  /**
   * A BUY'S QUESTION: can the coin `route` buys be sold back, from `holder`,
   * into the pool it is bought from? A pool that cannot be found or read is an
   * `unknown` like any other, and is remembered for its window so the
   * candidate list hears of it too (refusalFor).
   */
  async checkEntry(
    client: PublicClient,
    req: { route: RouteRef; holder: Address; amount: bigint; venue: { v3Factory: Address; v4PoolManager: Address } },
  ): Promise<SellCheck> {
    const at = await this.routePool(client, req.route, req.venue);
    if (!at.ok) {
      const check: SellCheck = { verdict: "unknown", transient: true, detail: at.detail };
      this.remember(`${req.route.token}|${req.holder}|route`.toLowerCase(), req.route.token.toLowerCase(), check);
      return check;
    }
    return this.check(client, { token: req.route.token, holder: req.holder, pools: [at.pool], amount: req.amount });
  }

  private remember(key: string, token: string, check: SellCheck): void {
    const now = this.now();
    this.prune(now);
    this.verdicts.set(key, { token, check, until: now + this.ttlOf(check) });
  }

  /**
   * The freshest refusal still believed for `token`, from ANY holder or pool —
   * no chain read. Lets a strategy stop proposing (and the Brain stop
   * reviewing) a coin the execution gate has just turned back.
   */
  refusalFor(token: string): Exclude<SellCheck, { verdict: "sellable" }> | null {
    const t = token.toLowerCase();
    const now = this.now();
    let best: { check: Exclude<SellCheck, { verdict: "sellable" }>; until: number } | null = null;
    for (const v of this.verdicts.values()) {
      if (v.token !== t || v.until <= now || v.check.verdict === "sellable") continue;
      if (!best || v.until > best.until) best = { check: v.check, until: v.until };
    }
    return best?.check ?? null;
  }

  /**
   * The pool a buy along `route` buys from, which is the pool its coin sells
   * into: the last hop of a v3 path, the direct pool otherwise, and the v4
   * singleton for a v4 route (every v4 sale settles into the PoolManager).
   */
  async routePool(
    client: PublicClient,
    route: RouteRef,
    venue: { v3Factory: Address; v4PoolManager: Address },
  ): Promise<{ ok: true; pool: Address } | { ok: false; detail: string }> {
    if (route.v4) return { ok: true, pool: venue.v4PoolManager };
    let a: Address;
    let fee: number;
    if (route.path) {
      const n = route.path.tokens.length;
      if (n < 2 || route.path.fees.length !== n - 1 || route.path.tokens[n - 1]!.toLowerCase() !== route.token.toLowerCase()) {
        return { ok: false, detail: "the route does not end in the coin being bought" };
      }
      a = route.path.tokens[n - 2]!;
      fee = route.path.fees[n - 2]!;
    } else {
      a = route.tokenIn;
      fee = route.fee;
    }
    const key = `${venue.v3Factory}|${a}|${route.token}|${fee}`.toLowerCase();
    const known = this.poolAt.get(key);
    if (known) return { ok: true, pool: known };
    try {
      const pool = await client.readContract({ address: venue.v3Factory, abi: V3_FACTORY_ABI, functionName: "getPool", args: [a, route.token, fee] });
      if (pool.toLowerCase() === ZERO) return { ok: false, detail: "the factory names no pool for that route" };
      this.poolAt.set(key, pool);
      return { ok: true, pool };
    } catch (e) {
      return { ok: false, detail: `its pool could not be read (${describe(e)})` };
    }
  }

  /**
   * Every canonical v3 pool `token` has against `quotes` at `fees` — where a
   * coin already held could be sold — in one multicall, kept for the locked
   * window. A failed read is not "no pools".
   */
  async canonicalPools(
    client: PublicClient,
    token: Address,
    venue: { v3Factory: Address; quotes: readonly Address[]; fees: readonly number[] },
  ): Promise<{ ok: true; pools: Address[] } | { ok: false; detail: string }> {
    const key = `${venue.v3Factory}|${token}`.toLowerCase();
    const now = this.now();
    const known = this.canonical.get(key);
    if (known && known.until > now) return { ok: true, pools: known.pools };
    const asks = venue.quotes.flatMap((q) => venue.fees.map((fee) => ({ q, fee })));
    try {
      const rows = await client.multicall({
        contracts: asks.map(({ q, fee }) => ({ address: venue.v3Factory, abi: V3_FACTORY_ABI, functionName: "getPool", args: [token, q, fee] }) as const),
        allowFailure: true,
      });
      const pools: Address[] = [];
      for (const r of rows) {
        if (r.status !== "success") return { ok: false, detail: "its pools could not be read" };
        if ((r.result as string).toLowerCase() !== ZERO) pools.push(r.result as Address);
      }
      this.canonical.set(key, { pools, until: now + this.ttl.locked });
      return { ok: true, pools };
    } catch (e) {
      return { ok: false, detail: `its pools could not be read (${describe(e)})` };
    }
  }

  /** Forget expired answers, so a long-lived worker's map stays the size of what it is still asking about. */
  private prune(now: number): void {
    if (this.verdicts.size < 256) return;
    for (const [k, v] of this.verdicts) if (v.until <= now) this.verdicts.delete(k);
  }
}
