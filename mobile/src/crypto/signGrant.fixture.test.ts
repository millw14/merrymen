import { beforeEach, describe, expect, it, vi } from "vitest";

// A test build is not a demo build: signGrant refuses to sign at all under the
// demo flag, so without this every case below would only prove that refusal.
vi.mock("@/net/api", () => ({ isMock: false }));
// The phone's keychain copy of its last grant. signGrant reads it on EVERY call,
// whatever the caller passes, so each case sets what the phone "remembers"
// rather than telling the signer. Hoisted because vi.mock is.
const phone = vi.hoisted(() => ({ stored: null as unknown, reads: 0 }));
vi.mock("./grantStore", () => ({
  readGrant: async () => {
    phone.reads++;
    return phone.stored;
  },
}));

import { GRANT_PERP_LIGHTER, GRANT_PONS_CLASS, GRANT_TRENCHER, LIGHTER_ROUTE_V1, TRADEABLE_V2 } from "@merrymen/core";
import { signGrant } from "./signGrant";
import { accountFromMnemonic } from "./mnemonic";
import {
  CLASS_FACTORY,
  CLASS_VAULT,
  TEST_CAPS,
  signerGrant,
  withStubChain,
} from "../../../web/src/lib/canonical-wall-fixture";
import { checkCanonicalWall } from "../../../web/src/lib/canonical-wall";

/**
 * THE EXPO SIGNER, EXECUTED.
 *
 * Until this file the phone's signer was only ever read as text — the lockstep
 * scans in worker/src/signer-lockstep.test.ts and web/src/lib/canonical-wall.test.ts
 * check that the right names sit in the right places, which says nothing about
 * whether the grant it builds is one the server would store. Here it runs for
 * real: real ZeroDev serialization, over the web fixture's stub chain (which
 * refuses any RPC it did not anticipate, so a new read in this signer fails
 * loudly), and every grant it mints goes through the hosted canonical-wall
 * check the server applies before storing anything.
 *
 * Perps on the phone are CARRY-FORWARD ONLY (docs/perps.md): it never takes a
 * new key and never drops one. So the perps cases are about the one thing it
 * does — a Lighter key the previous grant for THIS account held comes through
 * unchanged, PUBLIC half only — and about the account it must not borrow from.
 */

const ACCOUNT = "0x00000000000000000000000000000000000a11ce" as const;
const OTHER_ACCOUNT = "0x00000000000000000000000000000000000b0b00" as const;
const MNEMONIC = "test test test test test test test test test test test junk";
/**
 * Two real Lighter API public keys (packages/core/src/perps.test.ts
 * PUBKEY_VECTORS, from the official signer), so "canonical" here is the venue's
 * idea of canonical rather than a pattern that merely passes the check.
 */
const KEY = "0x2427c4493c2df1a3ecdd750f1398b865e5428907c41065f0612cb3fa6b5ea0d7ac00465b07f3acd7" as const;
const OTHER_KEY = "0x3fba6f2e6d1cc97965c00bcb9032ffbd408f77cfb929db0a49d4abd0b090426efb651217ad43f02d" as const;

/** A previous grant for `account` that carries perps, in the shape both sources have. */
const withPerps = (account: string, apiPublicKey: string = KEY, perp: Record<string, unknown> = {}) => ({
  smartAccount: account,
  chainId: LIGHTER_ROUTE_V1.chainId,
  grantFeatures: [TRADEABLE_V2, GRANT_PERP_LIGHTER],
  perp: { route: GRANT_PERP_LIGHTER, apiKeyIndex: LIGHTER_ROUTE_V1.apiKeyIndex, apiPublicKey, ...perp },
});

/** The phone's signer over the stub chain, which derives ACCOUNT for any owner. */
const phoneSigns = (extra: { previousGrant?: unknown; ponsClassVaultFactory?: `0x${string}` } = {}) =>
  withStubChain(ACCOUNT, () => signGrant({ mnemonic: MNEMONIC, caps: TEST_CAPS, ...extra }));

/** The dashboard's signer, same owner, same chain. */
const webSigns = (extra: { previousGrant?: unknown } = {}) =>
  signerGrant({ account: ACCOUNT, owner: accountFromMnemonic(MNEMONIC), ...extra });

const verdict = (g: unknown) => checkCanonicalWall(g as Record<string, unknown>);
const features = (g: { grantFeatures?: readonly string[] }) => [...(g.grantFeatures ?? [])];

/**
 * Every key in the grant, at any depth, that names a private key. The session
 * key is there BY DESIGN (the worker trades with it; capped and expiring) and
 * `serialized` is opaque base64 the canonical-wall check inspects itself, so
 * anything else here is a key that should never have left the device.
 */
function privateFields(v: unknown, path = ""): string[] {
  if (typeof v !== "object" || v === null) return [];
  return Object.entries(v as Record<string, unknown>).flatMap(([k, inner]) => {
    const at = path ? `${path}.${k}` : k;
    if (at === "demoSessionPrivateKey") return [];
    return [...(/private|secret|mnemonic|seed/i.test(k) ? [at] : []), ...privateFields(inner, at)];
  });
}

/** `a`'s entries that `b` also has, in `a`'s order — so two lists compare on order alone. */
const shared = (a: readonly string[], b: readonly string[]) => a.filter((f) => b.includes(f));

// Each case signs once or twice for real. That is quick on a warm machine, but
// a cold one loading ZeroDev and deriving keys can pass vitest's 5 s default.
const SLOW = 60_000;

beforeEach(() => {
  phone.stored = null;
  phone.reads = 0;
});

describe("the Expo signer, executed, mints a grant the server stores", () => {
  it("with nothing to carry: no perps marker, no perp block, and the hosted check accepts it", async () => {
    const { grant, sessionPrivateKey } = await phoneSigns();
    expect(grant.smartAccount.toLowerCase()).toBe(ACCOUNT);
    expect(verdict(grant)).toEqual({ ok: true });
    expect(features(grant)).not.toContain(GRANT_PERP_LIGHTER);
    expect("perp" in grant).toBe(false);
    // The phone consulted its own copy even though nobody passed one — the
    // carry-forward must not depend on a caller remembering to ask.
    expect(phone.reads).toBeGreaterThan(0);
    // The one key that may travel is the session key, and it is the one returned.
    expect(grant.demoSessionPrivateKey).toBe(sessionPrivateKey);
    expect("demoOwnerPrivateKey" in grant).toBe(false);
    expect(privateFields(grant)).toEqual([]);
  }, SLOW);
});

describe("perps are carried forward from a previous grant for the SAME account", () => {
  it("from the phone's stored grant: the same public key, under the marker, and nothing private", async () => {
    phone.stored = withPerps(ACCOUNT);
    const { grant } = await phoneSigns();
    expect(features(grant)).toContain(GRANT_PERP_LIGHTER);
    // Exactly the three public fields: the route, the ROUTE's key index (never a
    // stored one), and the same key the venue already has registered.
    expect(grant.perp).toEqual({ route: GRANT_PERP_LIGHTER, apiKeyIndex: LIGHTER_ROUTE_V1.apiKeyIndex, apiPublicKey: KEY });
    expect(privateFields(grant)).toEqual([]);
    // And the server would store it: the hosted check rebuilds the wall from
    // these fields, so this also proves the key in `perp` is the key sealed.
    expect(verdict(grant)).toEqual({ ok: true });
  }, SLOW);

  it("writes the key as the bytes the wall pinned, however the old copy spelled it, and keeps a sealed blob", async () => {
    // An un-prefixed, uppercase copy is the same key to the worker's reader
    // (grantPerp), so it must be the same key here, written canonically.
    phone.stored = withPerps(ACCOUNT, KEY.slice(2).toUpperCase(), { apiKeySealed: "sealed-blob" });
    const { grant } = await phoneSigns();
    expect(grant.perp).toEqual({
      route: GRANT_PERP_LIGHTER,
      apiKeyIndex: LIGHTER_ROUTE_V1.apiKeyIndex,
      apiPublicKey: KEY,
      // The hosted server's own opaque blob, bound to this account and key —
      // carried so a re-sign after a kill can still find its way back to the key.
      apiKeySealed: "sealed-blob",
    });
    expect(verdict(grant)).toEqual({ ok: true });
  }, SLOW);

  it("the server's projection speaks for the account before the phone's own copy does", async () => {
    // Same account, two different keys: the server's is the grant the worker
    // actually runs, so it wins, exactly as on the dashboard.
    phone.stored = withPerps(ACCOUNT, OTHER_KEY);
    const { grant } = await phoneSigns({ previousGrant: withPerps(ACCOUNT, KEY) });
    expect(grant.perp?.apiPublicKey).toBe(KEY);
    expect(verdict(grant)).toEqual({ ok: true });
  }, SLOW);

  it("a grant that claims perps but cannot say which key is a refusal, never a quiet 'none'", async () => {
    // Dropping the block would leave a key registered at the venue with no
    // worker holding it — the one outcome the carry-forward exists to prevent.
    phone.stored = { ...withPerps(ACCOUNT), perp: { route: GRANT_PERP_LIGHTER, apiKeyIndex: 3, apiPublicKey: KEY } };
    await expect(phoneSigns()).rejects.toThrow(/could not be read on this phone/);
  }, SLOW);
});

describe("a previous grant for ANOTHER account is ignored", () => {
  it("from either source: no perps carried, and the grant is the plain wall", async () => {
    // Another account's Lighter key sealed into this account's wall would be a
    // key this wall's worker can never use, for a venue account it does not own.
    phone.stored = withPerps(OTHER_ACCOUNT);
    const { grant } = await phoneSigns({ previousGrant: withPerps(OTHER_ACCOUNT, OTHER_KEY) });
    expect(features(grant)).not.toContain(GRANT_PERP_LIGHTER);
    expect("perp" in grant).toBe(false);
    expect(verdict(grant)).toEqual({ ok: true });
  }, SLOW);
});

describe("the phone and the dashboard seal the same markers in the same order", () => {
  it("given the same decisions, the same grantFeatures, perp block and class vault", async () => {
    // The dashboard seals the platform class vault by default; the phone only
    // when told the factory. Tell it, and the two have nothing left to differ on.
    const phonePlain = (await phoneSigns({ ponsClassVaultFactory: CLASS_FACTORY })).grant;
    const webPlain = (await webSigns()).grant;
    expect(features(phonePlain)).toEqual(features(webPlain));
    expect(phonePlain.ponsClassVaultAddress).toBe(CLASS_VAULT);
    expect(phonePlain.ponsClassVaultAddress).toBe(webPlain.ponsClassVaultAddress);
    expect(phonePlain.grantTokens).toEqual(webPlain.grantTokens);
    expect(verdict(phonePlain)).toEqual({ ok: true });

    // Carried perps: the phone from its stored copy, the dashboard from the
    // server's projection — two sources, one key, one wall.
    phone.stored = withPerps(ACCOUNT);
    const phonePerps = (await phoneSigns({ ponsClassVaultFactory: CLASS_FACTORY })).grant;
    const webPerps = (await webSigns({ previousGrant: withPerps(ACCOUNT) })).grant;
    expect(features(phonePerps)).toEqual(features(webPerps));
    expect(features(phonePerps)).toContain(GRANT_PERP_LIGHTER);
    expect(phonePerps.perp).toEqual(webPerps.perp);
    expect(verdict(phonePerps)).toEqual({ ok: true });
  }, SLOW);

  it("as onboarding calls it: the dashboard's markers minus those the phone never mints, in the dashboard's order", async () => {
    // onboarding/grant.tsx passes no class factory, and the phone has no
    // Trencher option at all. Those markers are absent by design, not drift.
    const notOnPhone = [GRANT_PONS_CLASS, GRANT_TRENCHER];

    const phonePlain = features((await phoneSigns()).grant);
    const webPlain = features((await webSigns()).grant);
    expect(phonePlain).toEqual(webPlain.filter((f) => !notOnPhone.includes(f)));

    // With perps the two can legitimately differ by more than that: without
    // the class permissions the phone's wall may still have room for the energy
    // buy where the dashboard's does not (perps take their room first, energy
    // gives way). So the claim is order, over the markers both seal.
    phone.stored = withPerps(ACCOUNT);
    const phonePerps = features((await phoneSigns()).grant);
    const webPerps = features((await webSigns({ previousGrant: withPerps(ACCOUNT) })).grant);
    expect(phonePerps).toContain(GRANT_PERP_LIGHTER);
    expect(webPerps).toContain(GRANT_PERP_LIGHTER);
    expect(phonePerps.filter((f) => notOnPhone.includes(f))).toEqual([]);
    expect(shared(phonePerps, webPerps)).toEqual(shared(webPerps, phonePerps));
    // The marker every slice appends to is last on both, so a later marker is
    // added after it on both rather than wedged in on one.
    expect(phonePerps.at(-1)).toBe(GRANT_PERP_LIGHTER);
    expect(webPerps.at(-1)).toBe(GRANT_PERP_LIGHTER);
  }, SLOW);
});
