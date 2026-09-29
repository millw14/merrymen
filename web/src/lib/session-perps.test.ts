import assert from "node:assert/strict";
import { describe, it } from "node:test";
// FIRST, before ./session: the fixture pins the Trencher factory's trusted
// bytecode hash in the environment, which trencher-permission.ts reads once,
// when session.ts loads it.
import { signerGrant } from "./canonical-wall-fixture";
import { GRANT_PERP_LIGHTER, LIGHTER_ROUTE_V1, publicGrantView, type StoredGrant } from "@merrymen/core";
import { decidePerpSeal, PerpSigningRefusal, priorPerpFor, type PerpRefusalCode } from "./session";
import { checkCanonicalWall } from "./canonical-wall";

/**
 * A LIGHTER KEY OUTLIVES EVERY GRANT, SO NO SIGNATURE MAY LOSE ONE QUIETLY.
 *
 * docs/perps.md rules 3 and 5, as the signer enforces them. The energy buy is
 * the precedent this deliberately does NOT follow: energy that does not fit is
 * dropped and the agent is funded another way; perps that the previous grant
 * carried are carried forward by default, and every path that would leave a
 * live venue account without the worker that holds its key is a refusal with a
 * name — the wall does not fit, the venue is not provably flat, the chain has
 * no Lighter, another account's key is armed.
 *
 * The pure decision is tested branch by branch; the carry-forward itself is
 * run through the REAL signer (prepareAgentGrant over the stub chain the
 * canonical-wall tests use), and each grant it mints is put through the
 * hosted wall check, so "carried" here means "the server would store it".
 */

const ACCOUNT = "0x00000000000000000000000000000000000a11ce" as const;
const OTHER_ACCOUNT = "0x00000000000000000000000000000000000b0b00" as const;
const KEY = `0x${"1a".repeat(40)}` as `0x${string}`;
const OTHER_KEY = `0x${"2b".repeat(40)}` as `0x${string}`;
const EXTRA = { symbol: "CATE", address: "0x0000000000000000000000000000000000ca7e00" as const, decimals: 18 };

/** A previous grant's public projection carrying perps, as GET /api/grants returns it. */
const withPerps = (account: string, key: string = KEY, extra: Record<string, unknown> = {}) => ({
  smartAccount: account,
  chainId: LIGHTER_ROUTE_V1.chainId,
  grantFeatures: ["tradeable-v2", GRANT_PERP_LIGHTER],
  perp: { route: GRANT_PERP_LIGHTER, apiKeyIndex: LIGHTER_ROUTE_V1.apiKeyIndex, apiPublicKey: key },
  ...extra,
});
const withoutPerps = (account: string) => ({ smartAccount: account, chainId: 4663, grantFeatures: ["tradeable-v2"] });

const refusal = (fn: () => unknown, code: PerpRefusalCode) =>
  assert.throws(fn, (e: unknown) => e instanceof PerpSigningRefusal && e.code === code);
const refusedAsync = (p: Promise<unknown>, code: PerpRefusalCode) =>
  assert.rejects(p, (e: unknown) => e instanceof PerpSigningRefusal && e.code === code);

const decide = (o: Partial<Parameters<typeof decidePerpSeal>[0]> & { prior?: ReturnType<typeof priorPerpFor> }) =>
  decidePerpSeal({
    chainId: o.chainId ?? 4663,
    requested: o.requested,
    prior: o.prior ?? priorPerpFor(ACCOUNT, {}),
    drop: o.drop ?? false,
    venueFlat: o.venueFlat,
  });

describe("which previous grant speaks for this account", () => {
  it("the server's projection wins when it names this account; the browser's copy otherwise", () => {
    const server = withoutPerps(ACCOUNT);
    const local = { current: withPerps(ACCOUNT) };
    // The server refuses (409) any grant that would drop a key from a venue
    // that is not flat, so its "no perps" for this account is trustworthy.
    assert.equal(priorPerpFor(ACCOUNT, { server, local }).same.state, "none");
    // Unknown server answer (undefined): the browser's copy carries it.
    const carried = priorPerpFor(ACCOUNT, { local }).same;
    assert.equal(carried.state, "carried");
    assert.equal(carried.state === "carried" && carried.apiPublicKey, KEY);
    // The server's answer about ANOTHER account does not speak for this one.
    assert.equal(priorPerpFor(ACCOUNT, { server: withoutPerps(OTHER_ACCOUNT), local }).same.state, "carried");
  });

  it("an archived copy counts for its own account, after the armed one", () => {
    const prior = priorPerpFor(ACCOUNT, { local: { current: withoutPerps(OTHER_ACCOUNT), archived: [withPerps(ACCOUNT)] } });
    assert.equal(prior.same.state, "carried");
    // The armed copy for this account outranks its own archive (newest first).
    assert.equal(priorPerpFor(ACCOUNT, { local: { current: withoutPerps(ACCOUNT), archived: [withPerps(ACCOUNT)] } }).same.state, "none");
  });

  it("the sealed blob rides along with the key it seals, so a re-sign after a kill can still reach it", () => {
    const g = withPerps(ACCOUNT, KEY);
    const sealed = { ...g, perp: { ...g.perp, apiKeySealed: "blob" } };
    const fromLocal = priorPerpFor(ACCOUNT, { local: { current: sealed } }).same;
    assert.equal(fromLocal.state === "carried" && fromLocal.apiKeySealed, "blob");
    // A projection (publicGrantView) has none, and none is invented.
    const fromServer = priorPerpFor(ACCOUNT, { server: g }).same;
    assert.equal(fromServer.state === "carried" && "apiKeySealed" in fromServer, false);
  });

  it("a marker with a block the worker would not honour is UNREADABLE, never none", () => {
    for (const bad of [
      withPerps(ACCOUNT, `0x${"ff".repeat(40)}`),
      withPerps(ACCOUNT, KEY, { chainId: 46630 }),
      { ...withPerps(ACCOUNT), perp: { route: GRANT_PERP_LIGHTER, apiKeyIndex: 3, apiPublicKey: KEY } },
      { ...withPerps(ACCOUNT), perp: undefined },
    ]) {
      assert.equal(priorPerpFor(ACCOUNT, { server: bad }).same.state, "unreadable");
    }
    // A block WITHOUT the marker was never a permission the worker armed.
    const { grantFeatures: _f, ...unmarked } = withPerps(ACCOUNT);
    void _f;
    assert.equal(priorPerpFor(ACCOUNT, { server: { ...unmarked, grantFeatures: ["tradeable-v2"] } }).same.state, "none");
  });

  it("the ARMED grant — the server's, else this browser's current one — may be another account's", () => {
    assert.equal(priorPerpFor(ACCOUNT, { server: withPerps(OTHER_ACCOUNT) }).otherArmed?.perp.state, "carried");
    assert.equal(priorPerpFor(ACCOUNT, { local: { current: withPerps(OTHER_ACCOUNT) } }).otherArmed?.perp.state, "carried");
    // null = the server holds nothing, which outranks a stale browser copy.
    assert.equal(priorPerpFor(ACCOUNT, { server: null, local: { current: withPerps(OTHER_ACCOUNT) } }).otherArmed, null);
    // An archived account is not armed.
    assert.equal(priorPerpFor(ACCOUNT, { local: { archived: [withPerps(OTHER_ACCOUNT)] } }).otherArmed, null);
  });
});

describe("the decision", () => {
  it("nothing before, nothing asked: no perps", () => {
    assert.equal(decide({}), null);
  });

  it("a new opt-in is sealed as given, canonicalised, with its sealed blob", () => {
    assert.deepEqual(decide({ requested: { apiPublicKey: KEY } }), { apiPublicKey: KEY });
    assert.deepEqual(decide({ requested: { apiPublicKey: KEY.toUpperCase().replace("0X", "0x") as `0x${string}`, apiKeySealed: "b" } }), {
      apiPublicKey: KEY,
      apiKeySealed: "b",
    });
  });

  it("a key that is not canonical is refused, and never echoed", () => {
    for (const apiPublicKey of [`0x${"ff".repeat(40)}`, `0x${"00".repeat(40)}`, `0x${"1a".repeat(39)}`, 7 as never]) {
      refusal(() => decide({ requested: { apiPublicKey: apiPublicKey as `0x${string}` } }), "perp-key-invalid");
    }
    refusal(() => decide({ requested: { apiPublicKey: KEY, apiKeySealed: "" } }), "perp-key-invalid");
    try {
      decide({ requested: { apiPublicKey: `0x${"ab".repeat(39)}` as `0x${string}` } });
    } catch (e) {
      assert.ok(!(e as Error).message.includes("abab"), "the refusal must not print the key it was handed");
    }
  });

  it("a previous grant with perps CARRIES FORWARD by default — the same key", () => {
    const prior = priorPerpFor(ACCOUNT, { server: withPerps(ACCOUNT) });
    assert.deepEqual(decide({ prior }), { apiPublicKey: KEY });
    // Passing the same key again is the same decision (and a fresher blob wins).
    assert.deepEqual(decide({ prior, requested: { apiPublicKey: KEY, apiKeySealed: "fresh" } }), { apiPublicKey: KEY, apiKeySealed: "fresh" });
  });

  it("a DIFFERENT key over a carried one is refused — rotation is the owner key's job", () => {
    const prior = priorPerpFor(ACCOUNT, { server: withPerps(ACCOUNT) });
    refusal(() => decide({ prior, requested: { apiPublicKey: OTHER_KEY } }), "perp-key-changed");
  });

  it("dropping needs venueFlat === true, and nothing less", () => {
    const prior = priorPerpFor(ACCOUNT, { server: withPerps(ACCOUNT) });
    for (const venueFlat of [undefined, null, false]) refusal(() => decide({ prior, drop: true, venueFlat }), "perp-drop-not-flat");
    // Truthy is not true: a flatness answer is a boolean the server read, not a hint.
    refusal(() => decide({ prior, drop: true, venueFlat: 1 as never }), "perp-drop-not-flat");
    assert.equal(decide({ prior, drop: true, venueFlat: true }), null);
    // And the escape hatch works for an unreadable block too — flat is flat.
    const unreadable = priorPerpFor(ACCOUNT, { server: withPerps(ACCOUNT, `0x${"ff".repeat(40)}`) });
    refusal(() => decide({ prior: unreadable }), "perp-prior-unreadable");
    assert.equal(decide({ prior: unreadable, drop: true, venueFlat: true }), null);
    // Dropping what was never there is not a refusal.
    assert.equal(decide({ drop: true }), null);
    // Asking to seal AND drop is a contradiction, not a choice.
    refusal(() => decide({ prior, drop: true, venueFlat: true, requested: { apiPublicKey: KEY } }), "perp-drop-and-seal");
  });

  it("off mainnet, perps asked for or carried are refused — never left out", () => {
    refusal(() => decide({ chainId: 46630, requested: { apiPublicKey: KEY } }), "perp-off-mainnet");
    refusal(() => decide({ chainId: 46630, prior: priorPerpFor(ACCOUNT, { server: withPerps(ACCOUNT) }) }), "perp-off-mainnet");
    // A flat drop may move the key to the test network: it carries nothing.
    assert.equal(decide({ chainId: 46630, prior: priorPerpFor(ACCOUNT, { server: withPerps(ACCOUNT) }), drop: true, venueFlat: true }), null);
  });

  it("another account's armed perps block signing this one — whatever this one asks", () => {
    const prior = priorPerpFor(ACCOUNT, { server: withPerps(OTHER_ACCOUNT) });
    refusal(() => decide({ prior }), "perp-other-account");
    refusal(() => decide({ prior, requested: { apiPublicKey: KEY } }), "perp-other-account");
    refusal(() => decide({ prior, drop: true, venueFlat: true }), "perp-other-account");
    // Another account WITHOUT perps is today's re-arm, untouched.
    assert.equal(decide({ prior: priorPerpFor(ACCOUNT, { server: withoutPerps(OTHER_ACCOUNT) }) }), null);
  });
});

describe("through the real signer", () => {
  const passes = (g: StoredGrant) => assert.deepEqual(checkCanonicalWall(g as unknown as Record<string, unknown>), { ok: true });

  it("a re-sign carries the key forward from the server's PUBLIC projection alone", async () => {
    const { grant: first } = await signerGrant({ account: ACCOUNT, perp: { apiPublicKey: KEY, apiKeySealed: "blob" } });
    passes(first);
    // What a second browser or the phone sees: publicGrantView drops the blob.
    const projection = publicGrantView(first);
    assert.equal((projection.perp as Record<string, unknown> | undefined)?.apiKeySealed, undefined);
    const { grant: again } = await signerGrant({ account: ACCOUNT, previousGrant: projection });
    passes(again);
    assert.ok(again.grantFeatures?.includes(GRANT_PERP_LIGHTER), "the marker is carried");
    assert.deepEqual(again.perp, { route: GRANT_PERP_LIGHTER, apiKeyIndex: 16, apiPublicKey: KEY });
    assert.notEqual(again.sessionKeyAddress, first.sessionKeyAddress, "it is still a new signature");
  });

  it("a carried perps block that no longer fits is REFUSED with its remedy, never dropped", async () => {
    await assert.rejects(
      signerGrant({ account: ACCOUNT, previousGrant: withPerps(ACCOUNT), extraTokens: [EXTRA] }),
      (e: unknown) =>
        e instanceof PerpSigningRefusal &&
        e.code === "perp-does-not-fit" &&
        /Remove some tokens/.test(e.message) &&
        /turn perpetuals off/.test(e.message) &&
        /has not been replaced/.test(e.message),
    );
    // And a new opt-in that does not fit is refused too — the owner chooses.
    await refusedAsync(signerGrant({ account: ACCOUNT, perp: { apiPublicKey: KEY }, trencher: true }), "perp-does-not-fit");
  });

  it("energy is what gives way: a default wall with perps drops the energy buy, not perps", async () => {
    const { grant: plain } = await signerGrant({ account: ACCOUNT });
    assert.ok(plain.grantFeatures?.includes("energy-buy-v1"), "premise: the default wall carries the energy buy");
    const { grant } = await signerGrant({ account: ACCOUNT, perp: { apiPublicKey: KEY } });
    assert.ok(grant.grantFeatures?.includes(GRANT_PERP_LIGHTER));
    assert.ok(!grant.grantFeatures?.includes("energy-buy-v1"), "no room for both on a first install — energy gave way");
    passes(grant);
  });

  it("dropping through the real signer: refused unless flat, then a wall without perps", async () => {
    const previousGrant = withPerps(ACCOUNT);
    await refusedAsync(signerGrant({ account: ACCOUNT, previousGrant, perpDrop: true }), "perp-drop-not-flat");
    await refusedAsync(signerGrant({ account: ACCOUNT, previousGrant, perpDrop: true, venueFlat: null }), "perp-drop-not-flat");
    const { grant } = await signerGrant({ account: ACCOUNT, previousGrant, perpDrop: true, venueFlat: true });
    assert.ok(!grant.grantFeatures?.includes(GRANT_PERP_LIGHTER));
    assert.equal(grant.perp, undefined);
    passes(grant);
  });

  it("off mainnet, and another account's armed perps, refuse before any signature", async () => {
    await refusedAsync(signerGrant({ account: ACCOUNT, perp: { apiPublicKey: KEY }, chainId: 46630 }), "perp-off-mainnet");
    await refusedAsync(signerGrant({ account: ACCOUNT, previousGrant: withPerps(OTHER_ACCOUNT) }), "perp-other-account");
  });
});
