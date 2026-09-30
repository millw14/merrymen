/**
 * LIGHTER AUTH TOKENS — one cached token per (account, API key), minted by the
 * signer, sent only as the Authorization header (api.ts), never logged.
 *
 * WHY EVERY ACCOUNT READ CARRIES ONE. api.ts ("ONE IDENTITY"): an address-keyed
 * client sends nothing unauthenticated but sendTx, because an unauthenticated
 * request also counts against the shared egress IP that every hosted child
 * sits behind. Some reads (trades, positionFunding, active orders) refuse
 * without one anyway ("auth required for main accounts").
 *
 * THE LIFETIME. The venue refuses a deadline more than 8 h out, and the
 * signer (createAuthToken) refuses one past that as well. We mint at now + 7 h
 * — an hour of headroom for our clock running ahead of the venue's — and mint
 * again 30 minutes before the deadline, so a token handed to a request is never
 * one about to expire mid-flight.
 *
 * AN AUTH ERROR FORCES ONE REFRESH, NOT A LOOP. A token can die early (the key
 * was rotated by the owner, the venue restarted, our clock jumped): the read
 * that saw the refusal invalidates the cached token, mints one, and retries
 * ONCE. A second refusal is the answer — a key the venue no longer accepts is
 * an incident for reconcile.ts, not something to hammer the rate budget over.
 * Concurrent reads that all saw the same dead token refresh it once between
 * them: each remembers which token it used and only invalidates that one.
 *
 * NEVER LOGGED. The token is a bearer credential for every read of the
 * account. It lives in this closure only — not on an object a logger could
 * serialise — and no error from this file carries a byte of it (api.ts clips
 * token-shaped text out of venue messages the same way).
 */

import type { LighterApiError, LighterResult, SendTxError } from "./api";

/** Minted at now + this. Under the venue's (and signer.ts AUTH_TOKEN_MAX_SEC's) 8 h ceiling. */
export const AUTH_TOKEN_LIFETIME_SEC = 7 * 3600;
/** Minted again once the deadline is this close. */
export const AUTH_TOKEN_REFRESH_BEFORE_SEC = 30 * 60;

/** The one signer capability this file needs — signer.ts LighterSignerClient fits it as is. */
export interface AuthTokenMinter {
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  createAuthToken(deadlineSec: number): string;
}

/** A token could not be minted (the signer is dead, or refused). Carries no token and no key. */
export class AuthTokenUnavailable extends Error {
  override readonly name = "AuthTokenUnavailable";
  readonly kind = "auth-unavailable" as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(`lighter auth token unavailable: ${message}`, options);
  }
}

/**
 * Did the venue refuse this READ for its authentication? HTTP 401/403 of any
 * kind, or a venue refusal whose message names auth or a token ("auth required
 * for main accounts", "auth query param and Authorization header are empty",
 * an expired or invalid token). The venue has no dedicated code for an expired
 * token (20001 is also "invalid param"), so the message is the signal; a false
 * positive costs one extra mint and one retry, a false negative one failed
 * read. Rate limits and a tx not found are never auth errors.
 */
export function isLighterAuthError(e: LighterApiError | SendTxError): boolean {
  if (e.kind === "rate-limited" || e.kind === "not-found") return false;
  if (e.status === 401 || e.status === 403) return true;
  // Only the venue's message after the status — `detail` starts with the
  // method and path, and no path we call contains these words, but the
  // message is what the venue said.
  if (e.kind === "rejected") {
    const said = e.detail.split("→").slice(1).join("→");
    return /\bauth|authori[sz]|\btoken/i.test(said);
  }
  return false;
}

export interface LighterAuth {
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  /** A token valid for at least AUTH_TOKEN_REFRESH_BEFORE_SEC more; mints when the cached one is not. */
  token(): string;
  /** Drop the cached token; the next token() mints. */
  invalidate(): void;
  /**
   * Run one authenticated read; if the venue refuses it for its auth, mint a
   * fresh token and run it ONCE more. Throws AuthTokenUnavailable when no
   * token can be minted (nothing was sent).
   */
  withAuth<T, E extends LighterApiError | SendTxError = LighterApiError>(read: (auth: string) => Promise<LighterResult<T, E>>): Promise<LighterResult<T, E>>;
  /** The cached token's deadline (unix s), or null — for status displays. Never the token. */
  expiresAtSec(): number | null;
}

/**
 * The cache for ONE (account, key). `client` may be a getter so a signer that
 * was rebuilt (signer.ts signerLoader) is picked up; a getter that starts
 * returning another (account, key) is refused rather than followed — a token
 * minted for one account authenticates reads of that account, and a cache
 * that silently switched would hand one tenant's reads another's identity.
 */
export function createLighterAuth(opts: {
  client: AuthTokenMinter | (() => AuthTokenMinter);
  /** ms */
  now?: () => number;
  lifetimeSec?: number;
  refreshBeforeSec?: number;
}): LighterAuth {
  const getClient = typeof opts.client === "function" ? opts.client : ((c: AuthTokenMinter) => () => c)(opts.client);
  const now = opts.now ?? (() => Date.now());
  const lifetime = opts.lifetimeSec ?? AUTH_TOKEN_LIFETIME_SEC;
  const before = opts.refreshBeforeSec ?? AUTH_TOKEN_REFRESH_BEFORE_SEC;
  if (!Number.isSafeInteger(lifetime) || lifetime < 60 || lifetime > AUTH_TOKEN_LIFETIME_SEC) {
    throw new RangeError(`lighter auth: lifetimeSec must be an integer in 60..${AUTH_TOKEN_LIFETIME_SEC}`);
  }
  if (!Number.isSafeInteger(before) || before < 0 || before >= lifetime) throw new RangeError("lighter auth: refreshBeforeSec must be an integer below lifetimeSec");
  const first = getClient();
  const accountIndex = first.accountIndex;
  const apiKeyIndex = first.apiKeyIndex;

  let cached: { token: string; deadlineSec: number; minter: AuthTokenMinter; generation: number } | null = null;
  let generation = 0;

  const current = (): AuthTokenMinter => {
    const c = getClient();
    if (c.accountIndex !== accountIndex || c.apiKeyIndex !== apiKeyIndex) {
      throw new AuthTokenUnavailable(`this cache authenticates account ${accountIndex} key ${apiKeyIndex}, not account ${c.accountIndex} key ${c.apiKeyIndex}`);
    }
    return c;
  };

  const nowSec = (): number => Math.floor(now() / 1000);

  function mint(minter: AuthTokenMinter): NonNullable<typeof cached> {
    const deadlineSec = nowSec() + lifetime;
    let token: string;
    try {
      token = minter.createAuthToken(deadlineSec);
    } catch (e) {
      // The signer's own errors are redacted already, but only a fixed phrase
      // and the error's class leave this file: nothing it echoes is trusted.
      throw new AuthTokenUnavailable(`the signer could not mint one (${e instanceof Error ? e.name : "error"})`, { cause: e });
    }
    if (typeof token !== "string" || token.length === 0) throw new AuthTokenUnavailable("the signer returned no token");
    generation += 1;
    cached = { token, deadlineSec, minter, generation };
    return cached;
  }

  function fresh(): NonNullable<typeof cached> {
    const minter = current();
    // A rebuilt client (a new signer, or the owner's rotated key re-created at
    // the same index) signs with what may be a different key: a token from the
    // old handle is not assumed to still be good.
    if (cached !== null && cached.minter === minter && nowSec() < cached.deadlineSec - before) return cached;
    return mint(minter);
  }

  return {
    accountIndex,
    apiKeyIndex,

    token() {
      return fresh().token;
    },

    invalidate() {
      cached = null;
    },

    async withAuth(read) {
      const used = fresh();
      const first = await read(used.token);
      if (first.ok || !isLighterAuthError(first.error)) return first;
      // Only the token this read used: a concurrent read may already have
      // replaced it, and that one is the refresh.
      if (cached !== null && cached.generation === used.generation) cached = null;
      return read(fresh().token);
    },

    expiresAtSec() {
      return cached?.deadlineSec ?? null;
    },
  };
}
