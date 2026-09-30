/**
 * THE NONCE ALLOCATOR — rule 9's "one nonce per intent", for the one
 * (account, API key) the live Lighter rail signs with.
 *
 * docs/perps.md rule 9 is the contract: "Nonces come from a per-(account,
 * key) high-water committed before signing: max(now_ms, venue nextNonce at
 * arm, high-water + 1)." What each part of that sentence buys:
 *
 *   COMMITTED BEFORE SIGNING   bumpNonceHighWater writes the new high-water
 *                              in its own transaction and only then does
 *                              next() return. A crash after that and before
 *                              the send leaves a GAP (SkipNonce allows gaps),
 *                              never a repeat: no restart can hand the same
 *                              nonce out twice, so no two signed txs can ever
 *                              share one — and client order indexes, which
 *                              are nonce × 8 + leg, inherit the property.
 *   now_ms                     nonces are milliseconds, so a wiped ledger
 *                              (a hosted child's is disposable) restarts
 *                              ABOVE every nonce it ever used, without having
 *                              to remember them.
 *   venue nextNonce AT ARM     … unless the clock went backwards, or something
 *                              else signed on this key with a nonce from the
 *                              future. The venue's own counter is the floor
 *                              the first nonce must clear; below it, sendTx
 *                              refuses with 21104 and the row sits ambiguous
 *                              until ExpiredAt. It is read at arm ONLY — it is
 *                              never evidence that a tx is dead (it also moves
 *                              when the tx itself executed).
 *   high-water + 1             strictly increasing, which SkipNonce requires
 *                              (2^47 − 1 > new > old per key), across every
 *                              caller in this process.
 *
 * ONE IN FLIGHT. next() is serialised: the lane, the protective loop and the
 * stand-down share this one allocator (docs/perps.md, protect.ts), and two
 * reservations interleaving inside one process would read the same in-memory
 * high-water. The store's reservation is atomic too (the row lock), so even a
 * second process on the same ledger can only ever get a larger nonce, never an
 * equal one.
 *
 * WHAT THE SIGNER AND THE STORE EACH CHECK, AND WHY THEY AGREE. The signer
 * (signer.ts SignContext) refuses unless `nonce > ctx.nonceHighWater`; the
 * store (insertPerpOrderSubmitted) refuses unless the persisted high-water is
 * `≥ nonce`. Both are true of one reservation only when `nonceHighWater` is
 * the high-water as it stood BEFORE the reservation — after it, the persisted
 * value IS the nonce and the signer's check could never pass. So next()
 * returns both numbers together: `nonce` (committed, what the row checks) and
 * `previousHighWater` (what the signer checks against).
 */

/** The ledger functions the allocator reserves through — store.ts's own, injectable for a test. */
export interface NonceStore {
  bumpNonceHighWater(agentId: string, mode: "live", floor: bigint | number): Promise<bigint>;
  getNonceHighWater(agentId: string, mode: "live"): Promise<bigint | null>;
}

/** One reserved nonce, already committed to the high-water when this is returned. */
export interface ReservedNonce {
  /** Sign with exactly this — never with a floor, never with a value of your own. */
  nonce: bigint;
  /**
   * The high-water as it stood before this reservation (0n when none was ever
   * reserved): the signer's `ctx.nonceHighWater`, which the nonce must exceed.
   */
  previousHighWater: bigint;
}

export type NonceUnavailableReason = "venue-unread" | "ledger-unread" | "store-contract";

/**
 * No nonce could be reserved. Nothing was signed; nothing may be. A live
 * rail that cannot arm stays unarmed (rule 11: unknown is never zero — an
 * unread venue counter is not a counter of 0).
 */
export class NonceUnavailable extends Error {
  override readonly name = "NonceUnavailable";
  readonly kind = "nonce-unavailable" as const;
  constructor(
    readonly reason: NonceUnavailableReason,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`perp nonce unavailable (${reason}): ${message}`, options);
  }
}

export interface NonceAllocator {
  readonly agentId: string;
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  /**
   * Read the persisted high-water and the venue's nextNonce and fix the floor
   * the next nonce must clear: max(now_ms, venue nextNonce, high-water + 1).
   * next() arms on its first call; call this at arm to fail early instead.
   * Returns the floor.
   */
  arm(): Promise<bigint>;
  /** Reserve and COMMIT the next nonce. Serialised: one in flight. */
  next(): Promise<ReservedNonce>;
  /** The committed high-water as this allocator last knew it; null before arm. */
  highWater(): bigint | null;
  armed(): boolean;
}

/** A promise-chain mutex: each call runs after the previous one settled, whatever it did. */
function serialiser(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

const maxBig = (...xs: bigint[]): bigint => xs.reduce((a, b) => (b > a ? b : a));

export function createNonceAllocator(opts: {
  agentId: string;
  accountIndex: number;
  apiKeyIndex: number;
  store: NonceStore;
  /** ms — the same clock the signer reads. */
  now: () => number;
  /** GET /nextNonce for (account, key); null when unread. */
  venueNextNonce: () => Promise<bigint | null>;
}): NonceAllocator {
  const { agentId, accountIndex, apiKeyIndex, store } = opts;
  if (typeof agentId !== "string" || agentId.trim() === "") throw new RangeError("nonce allocator: an agent id is required");
  if (!Number.isSafeInteger(accountIndex) || accountIndex < 1) throw new RangeError("nonce allocator: accountIndex must be a positive integer");
  // 255 is never a key the signer uses (signer.ts: "last client created").
  if (!Number.isSafeInteger(apiKeyIndex) || apiKeyIndex < 0 || apiKeyIndex > 254) throw new RangeError("nonce allocator: apiKeyIndex must be 0..254");
  const serial = serialiser();

  let hw: bigint | null = null;
  let floor: bigint | null = null;

  const nowMs = (): bigint => {
    const t = opts.now();
    if (!Number.isFinite(t) || t < 1) throw new NonceUnavailable("store-contract", "the clock is unreadable");
    return BigInt(Math.floor(t));
  };

  async function armLocked(): Promise<bigint> {
    let persisted: bigint | null;
    try {
      persisted = await store.getNonceHighWater(agentId, "live");
    } catch (e) {
      // An unreadable high-water is not a zero one: restarting the sequence
      // under nonces that may already be spent is exactly the replay rule 9
      // exists to prevent.
      throw new NonceUnavailable("ledger-unread", "the persisted high-water could not be read", { cause: e });
    }
    if (persisted !== null && (typeof persisted !== "bigint" || persisted < 0n)) {
      throw new NonceUnavailable("ledger-unread", "the persisted high-water is not a non-negative integer");
    }
    let venue: bigint | null;
    try {
      venue = await opts.venueNextNonce();
    } catch (e) {
      throw new NonceUnavailable("venue-unread", "Lighter's nextNonce could not be read", { cause: e });
    }
    if (venue === null) throw new NonceUnavailable("venue-unread", "Lighter's nextNonce is unread; the first nonce has no floor to clear");
    if (typeof venue !== "bigint" || venue < 0n) throw new NonceUnavailable("venue-unread", "Lighter's nextNonce is not a non-negative integer");
    hw = persisted ?? 0n;
    floor = maxBig(nowMs(), venue, hw + 1n);
    return floor;
  }

  return {
    agentId,
    accountIndex,
    apiKeyIndex,

    arm() {
      return serial(armLocked);
    },

    next() {
      return serial(async () => {
        if (hw === null || floor === null) await armLocked();
        const previous = hw as bigint;
        // The arm floor binds until a reservation clears it; after that the
        // high-water alone does (it is already past the floor).
        const candidate = maxBig(nowMs(), previous + 1n, floor as bigint);
        const committed = await store.bumpNonceHighWater(agentId, "live", candidate);
        // The store's contract: max(floor, persisted + 1). Anything below the
        // floor we asked for is a store that did not reserve what it said it
        // did — refuse rather than sign under it.
        if (typeof committed !== "bigint" || committed < candidate) {
          throw new NonceUnavailable("store-contract", `the ledger reserved ${String(committed)}, below the floor ${candidate} it was asked for`);
        }
        hw = committed;
        // Above the candidate means the PERSISTED high-water was ahead of this
        // allocator's memory — another writer on this ledger (a stand-down
        // child, say) — and the store answered persisted + 1, so the exact
        // previous value is known. Otherwise ours is the one it held, or a
        // lower bound on it; the nonce exceeds it either way.
        return { nonce: committed, previousHighWater: committed > candidate ? committed - 1n : previous };
      });
    },

    highWater() {
      return hw;
    },

    armed() {
      return hw !== null && floor !== null;
    },
  };
}
