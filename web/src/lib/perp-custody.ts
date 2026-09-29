/**
 * THE SERVER'S HALF OF docs/perps.md RULE 5 — what a grant intake checks
 * about the Lighter key, and the one refusal that catches old app builds.
 *
 * Shared by POST /api/grants (hosted and self-hosted), partner activation and
 * GET /api/perps/flat, so the doors cannot drift.
 *
 * 1. THE KEY A GRANT NAMES MUST BE HELD, AND BE THIS OWNER'S.
 *    A grant carries `perp = { route, apiKeyIndex, apiPublicKey,
 *    apiKeySealed? }` — the PUBLIC key the wall pins, and at most a sealed
 *    blob of the private one. So at intake:
 *      hosted       `apiKeySealed` must OPEN under the DEK for (this tenant,
 *                   this account, this public key, 16) — the blob keygen
 *                   issued for exactly this. Absent, it is a CARRY-FORWARD: the
 *                   stored grant for the same account must name the same
 *                   public key, and its blob is re-attached here, server side
 *                   — which is why a phone that never held the blob (GET never
 *                   returns it) can re-sign. Otherwise refused, by name: a wall
 *                   pinning a key nobody holds registers a key nobody can use.
 *      self-hosted  `$MERRYMEN_HOME/perp-keys/<pub>.json` must exist and pair
 *                   with the public key (keystore.loadPerpPrivateKey). A
 *                   sealed blob has no business here and is refused.
 *    Everywhere: no plaintext private key, by name or by shape
 *    (carriesPerpPrivateKey), and the marker and the block come together or
 *    not at all (grantPerp is the one reader).
 *
 * 2. NO PATH MAY LEAVE A NON-FLAT VENUE ACCOUNT WITHOUT ITS KEY.
 *    A registered API key stays valid at the venue whatever the grant says,
 *    and only the owner can revoke it. When the STORED grant carries perps and
 *    the new one drops the block for the same account, names a different
 *    account, or names a different public key (a rotation — see
 *    dropsVenueKey), the stored account's venue must read provably flat
 *    (worker/src/perps/flatness.ts) — or it is a 409 with rule 5's sentence.
 *    `null` (unread) is refused exactly like `false`. This is the only layer
 *    that catches an app build that predates perps, which would otherwise
 *    re-sign the block away without knowing it was there.
 *
 * 3. A NEW OPT-IN IS THE OPERATOR'S TO OFFER (rule 1, "Rollout").
 *    Minting a Lighter key, sealing it into a wall and (hosted) holding it
 *    are what the operator's levers restrict: `perpsOptInOffered` is true only
 *    when perpsCeilingFor(MERRYMEN_PERPS, MERRYMEN_PERPS_LIVE_TENANTS) reads
 *    `live` for the account. GET /api/grants says so (`perpsOptIn`), the
 *    dashboard shows the box only then, keygen answers 403 otherwise, and the
 *    intake refuses a block that is not a carry-forward of the stored one.
 *    A carry-forward is never gated: turning an operator lever must never
 *    strand a key the venue already has (rule 5).
 *
 * NOTHING HERE LOGS, and no refusal carries key material.
 */
import { createPublicClient } from "viem";
import {
  carriesPerpPrivateKey,
  chainForId,
  GRANT_PERP_LIGHTER,
  grantPerp,
  LIGHTER_ROUTE_V1,
  type StoredGrant,
} from "@merrymen/core";
import { merrymenHome } from "@merrymen/home";
import { webChainRead } from "@/lib/chain-read";
import { lighterReadFromClient, venueFlatness, type VenueFlatness } from "../../../worker/src/perps/flatness";
import { openPerpKey } from "../../../worker/src/perps/key-seal";
import { loadPerpPrivateKey, PerpKeystoreError } from "../../../worker/src/perps/keystore";
import { mergeSettings, perpsCeilingFor } from "../../../worker/src/settings";

export type { VenueFlatness } from "../../../worker/src/perps/flatness";
/** The store DEK (MERRYMEN_STORE_DEK), or null — re-exported so routes reach it through one door. */
export { storeDek } from "../../../worker/src/store-crypto";

/** Rule 5's sentence, verbatim — the 409 every door gives. */
export const PERP_NOT_FLAT_MESSAGE =
  "your agent still has money or positions on Lighter; close them from the dashboard or run merrymen recover, then sign again";

/** A refusal in the shape every route renders: status, owner-facing words, a stable code. */
export interface PerpRefusal {
  status: number;
  error: string;
  code: string;
  /** What the venue read found, for a 409 (never key material). */
  detail?: string;
  flat?: false | null;
}

/** The only fields a perp block may have. Anything else — `apiPrivateKey` above all — is refused. */
const PERP_BLOCK_FIELDS: ReadonlySet<string> = new Set(["route", "apiKeyIndex", "apiPublicKey", "apiKeySealed"]);

const eqAddr = (a: unknown, b: unknown) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

type GrantLike = Pick<StoredGrant, "smartAccount" | "chainId" | "grantFeatures" | "perp">;

/**
 * MAY THIS ACCOUNT TAKE A NEW PERPS OPT-IN ON THIS SERVER? True only when the
 * operator's ceiling for it is `live`: perps OFF or PAPER (the hosted default —
 * Rollout Phase 1, "signers do not offer the opt-in") and, hosted, an account
 * not on MERRYMEN_PERPS_LIVE_TENANTS (Phase 2's allowlist) all say no. Paper
 * perps need no grant and no key, so the opt-in — which mints a real Lighter
 * key and seals the venue permissions — is a live-only door.
 *
 * The same resolution the worker opens by (worker/src/settings.ts
 * perpsCeilingFor over mergeSettings' env-only operator fields), never a
 * second reading of the variables: a typo there is OFF for both. `smartAccount`
 * is the grant's account, never the SIWE tenant. Server-only (reads env).
 */
export function perpsOptInOffered(smartAccount: string | null | undefined, env: Record<string, string | undefined> = process.env): boolean {
  return perpsCeilingFor(mergeSettings({}, env), smartAccount) === "live";
}

/** The refusal every door gives a new opt-in the operator does not offer. */
export const PERP_NOT_OFFERED: PerpRefusal = Object.freeze({
  status: 403,
  code: "perp-not-offered",
  error:
    "perpetuals are not offered for this agent on this server yet, so no new Lighter key can be made or sealed. Sign again without perpetuals.",
});

/**
 * CHECK, AND (hosted) COMPLETE, AN INCOMING GRANT'S PERP BLOCK.
 *
 * Returns the grant to store — the incoming one, with `apiKeySealed`
 * re-attached on a hosted carry-forward — or a named refusal. A grant with no
 * marker and no block passes untouched (after the plaintext-key scan, which
 * every grant gets).
 */
export function acceptIncomingPerp(args: {
  hosted: boolean;
  /** The authenticated tenant (hosted); ignored self-hosted. */
  tenant: `0x${string}` | null;
  incoming: StoredGrant;
  /** The grant currently stored for this tenant / this install, or null. */
  stored: StoredGrant | null;
  dek: Buffer | null;
  /** MERRYMEN_HOME (self-hosted key files). */
  home: string;
  /**
   * `perpsOptInOffered(incoming.smartAccount)`, computed by the route.
   * REQUIRED, so no door can forget it; only a block that is not a
   * carry-forward of the stored one reads it.
   */
  perpsOffered: boolean;
}): { ok: true; grant: StoredGrant } | { ok: false; refusal: PerpRefusal } {
  const { incoming } = args;
  const refuse = (status: number, code: string, error: string) => ({ ok: false as const, refusal: { status, code, error } });

  if (carriesPerpPrivateKey(incoming)) {
    return refuse(
      422,
      "perp-private-key-forbidden",
      "this grant carries a Lighter private key — a signer only ever holds the public key. Generate the key from the dashboard and sign again.",
    );
  }
  const marked = incoming.grantFeatures?.includes(GRANT_PERP_LIGHTER) === true;
  const present = incoming.perp !== undefined && incoming.perp !== null;
  if (!marked && !present) return { ok: true, grant: incoming };

  const perp = grantPerp(incoming);
  if (!marked || !present || perp === null) {
    return refuse(
      400,
      "perp-block-malformed",
      "this grant's perpetuals permission and its Lighter key do not match (the marker and a valid key on Robinhood Chain come together). Reload and sign again.",
    );
  }
  if (typeof incoming.perp !== "object" || Object.keys(incoming.perp as object).some((k) => !PERP_BLOCK_FIELDS.has(k))) {
    return refuse(400, "perp-block-fields", "this grant's Lighter block carries fields a grant never has. Reload and sign again.");
  }
  const ctx = { smartAccount: incoming.smartAccount, apiPublicKey: perp.apiPublicKey, apiKeyIndex: perp.apiKeyIndex };

  // A NEW BLOCK — not the stored grant's key for the same account carried
  // forward — is a new opt-in, and only the operator offers those (section 3
  // above). Keygen already refuses to mint one; this catches a key minted
  // before the operator restricted, and anything that did not come through
  // keygen at all. The carry-forward is never gated.
  const storedKey = args.stored && eqAddr(args.stored.smartAccount, incoming.smartAccount) ? grantPerp(args.stored) : null;
  const carried = storedKey !== null && storedKey.apiPublicKey === perp.apiPublicKey;
  if (!carried && args.perpsOffered !== true) return { ok: false, refusal: { ...PERP_NOT_OFFERED } };

  if (!args.hosted) {
    if (perp.apiKeySealed !== undefined) {
      return refuse(400, "perp-key-sealed-self-hosted", "a self-hosted agent keeps its Lighter key in its own key file, not in the grant. Generate the key from this dashboard and sign again.");
    }
    try {
      loadPerpPrivateKey({ home: args.home, apiPublicKey: perp.apiPublicKey });
    } catch (e) {
      const why = e instanceof PerpKeystoreError ? e.reason : "unreadable";
      return refuse(
        400,
        "perp-key-missing",
        `the Lighter key this permission names is not in this install's key store (${why}). Generate the key from this dashboard and sign again.`,
      );
    }
    return { ok: true, grant: incoming };
  }

  // ── hosted ────────────────────────────────────────────────────────────
  if (!args.tenant) return refuse(401, "not-signed-in", "not signed in");
  if (!args.dek) {
    return refuse(503, "perp-key-store-unavailable", "this service cannot hold a Lighter key right now (its key store is not configured). Try again later.");
  }
  if (perp.apiKeySealed !== undefined) {
    try {
      openPerpKey(perp.apiKeySealed, { tenant: args.tenant, ...ctx }, args.dek);
    } catch {
      return refuse(
        400,
        "perp-key-not-yours",
        "the Lighter key in this grant was not issued to this login and this agent account. Generate a new key and sign again.",
      );
    }
    return { ok: true, grant: incoming };
  }

  // CARRY-FORWARD: the same account, the same public key, the stored blob.
  const stored = args.stored;
  const storedPerp = stored && eqAddr(stored.smartAccount, incoming.smartAccount) ? grantPerp(stored) : null;
  if (storedPerp && storedPerp.apiPublicKey === perp.apiPublicKey && storedPerp.apiKeySealed !== undefined) {
    try {
      openPerpKey(storedPerp.apiKeySealed, { tenant: args.tenant, ...ctx }, args.dek);
    } catch {
      return refuse(400, "perp-key-missing", "the Lighter key this permission names is no longer held by this service. Generate a new key and sign again.");
    }
    return {
      ok: true,
      grant: { ...incoming, perp: { ...(incoming.perp as object), apiKeySealed: storedPerp.apiKeySealed } } as StoredGrant,
    };
  }
  return refuse(
    400,
    "perp-key-missing",
    "the Lighter key this permission names is not held by this service for this account. Generate the key from the dashboard and sign again.",
  );
}

/**
 * Does replacing `stored` with `incoming` let go of the STORED venue key?
 *
 * Yes when the stored grant carries perps and the new one
 *   - names another account,
 *   - drops the block for the same account, or
 *   - names a DIFFERENT public key for the same account (a rotation).
 *
 * WHY A ROTATION COUNTS. It keeps *a* key in the grant, but not the one the
 * venue has registered: the stored key stays valid at index 16 until an
 * on-chain `changePubKey` for the new one lands, which can fail outright
 * (21126: no key change while cross collateral is 0, reachable on an
 * isolated-only book) and at best takes a UserOp. Meanwhile the store's put
 * overwrites the only sealed copy of the old key (hosted) and the child's
 * perp-key.json is renamed over (child-key.ts), so open positions would sit
 * with no key-holder able to sign their exits. The signers refuse this move
 * outright (session.ts `perp-key-changed`: rotation is the owner key's, via
 * recover); this is the layer that catches a caller that is not one of them
 * — an SDK call with no previous grant, a hand-built POST, or a replayed
 * older blob (every blob ever issued for this tenant and account still opens).
 * On a provably flat venue there is nothing to strand, so it is allowed.
 *
 * A stored grant that CLAIMS perps (the marker) but whose block does not read
 * is treated as holding a key too: it cannot say which key the venue has, so
 * any replacement lets go of it — the signers' `perp-prior-unreadable`.
 */
export function dropsVenueKey(stored: GrantLike | null | undefined, incoming: GrantLike): boolean {
  if (!stored) return false;
  const held = grantPerp(stored);
  const claimed = stored.grantFeatures?.includes(GRANT_PERP_LIGHTER) === true;
  if (held === null && !claimed) return false;
  if (!eqAddr(stored.smartAccount, incoming.smartAccount)) return true;
  const next = grantPerp(incoming);
  if (next === null || held === null) return true;
  // Both canonical (grantPerp lowercases), so a case change is not a rotation.
  return next.apiPublicKey !== held.apiPublicKey;
}

export type FlatnessReader = (smartAccount: `0x${string}`) => Promise<VenueFlatness>;

/**
 * THE 409 (rule 5). Null when the replacement is allowed; a refusal when the
 * stored account's venue is not PROVABLY flat. A reader that throws is an
 * unread venue — refused like one.
 */
export async function perpDropRefusal(args: {
  stored: GrantLike | null | undefined;
  incoming: GrantLike;
  flatness?: FlatnessReader;
}): Promise<PerpRefusal | null> {
  if (!dropsVenueKey(args.stored, args.incoming)) return null;
  const account = String(args.stored?.smartAccount ?? "").toLowerCase() as `0x${string}`;
  let f: VenueFlatness;
  try {
    f = await (args.flatness ?? readVenueFlatness)(account);
  } catch {
    f = { flat: null, detail: "the venue could not be read" };
  }
  if (f.flat === true) return null;
  if (f.flat === false) return { status: 409, code: "perp-venue-not-flat", error: PERP_NOT_FLAT_MESSAGE, detail: f.detail, flat: false };
  return {
    status: 409,
    code: "perp-venue-unread",
    error: `Lighter could not be read just now, so merrymen must assume ${PERP_NOT_FLAT_MESSAGE}`,
    detail: f.detail,
    flat: null,
  };
}

/**
 * A TEST SEAM on globalThis, not a module variable: under the test runner a
 * route and its test can hold two instances of this module (the CJS/ESM
 * split the grants tests already work around), and an override one instance
 * cannot see is an override that silently does nothing — here, a real network
 * read in a unit test.
 */
const FLATNESS_OVERRIDE = Symbol.for("merrymen.test.venueFlatness");
type WithOverride = typeof globalThis & { [FLATNESS_OVERRIDE]?: FlatnessReader | null };

/** Tests only: answer every flatness read with `fn` (null restores the real read). */
export function setVenueFlatnessForTest(fn: FlatnessReader | null): void {
  (globalThis as WithOverride)[FLATNESS_OVERRIDE] = fn;
}

/**
 * The server's read: Robinhood Chain 4663 through the web's batched,
 * non-retrying transport, and Lighter's public API — never a key, never a
 * token. Never throws.
 */
export async function readVenueFlatness(smartAccount: `0x${string}`): Promise<VenueFlatness> {
  const override = (globalThis as WithOverride)[FLATNESS_OVERRIDE];
  if (override) return override(smartAccount);
  try {
    const client = createPublicClient({ chain: chainForId(LIGHTER_ROUTE_V1.chainId), transport: webChainRead() });
    return await venueFlatness({
      smartAccount,
      chainId: LIGHTER_ROUTE_V1.chainId,
      read: lighterReadFromClient(client as unknown as { readContract: (args: never) => Promise<unknown> }),
      home: merrymenHome(),
    });
  } catch {
    return { flat: null, detail: "the venue could not be read" };
  }
}

// ── a small per-caller limiter for the two perps routes ──────────────────────

/**
 * A rolling-minute budget per caller (the tenant hosted, the install
 * self-hosted). In memory and per process ON PURPOSE: it exists to keep one
 * signed-in tab from turning keygen (a WASM run each) or flatness (several
 * venue and chain reads each) into a loop, not to be a distributed quota —
 * the repo has no shared limiter, and a restart forgetting the window is
 * harmless for both routes.
 */
export function perRouteLimiter(perMinute: number, now: () => number = Date.now) {
  const seen = new Map<string, number[]>();
  return (key: string): { ok: true } | { ok: false; retryAfterSec: number } => {
    const t = now();
    const log = (seen.get(key) ?? []).filter((x) => x > t - 60_000);
    if (log.length >= perMinute) {
      seen.set(key, log);
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil(((log[0] ?? t) + 60_000 - t) / 1000)) };
    }
    log.push(t);
    seen.set(key, log);
    // Bounded: a caller that went away is forgotten on its next miss or never.
    if (seen.size > 10_000) {
      for (const [k, v] of seen) if (!v.some((x) => x > t - 60_000)) seen.delete(k);
    }
    return { ok: true };
  };
}

/** `Cache-Control` for every perps-route and grants response: per-user, never stored. */
export const NO_STORE_HEADERS = Object.freeze({ "Cache-Control": "private, no-store" });
