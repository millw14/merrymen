/**
 * ONE INSTALL, TWO WALLETS, SELF-HOSTED: POST and GET /api/grants?wallet=perps
 * (perps slice 5b).
 *
 * A self-hosted Perps wallet is a complete home of its own,
 * $MERRYMEN_HOME/accounts/perps (purposeHome): its grant.json, its archive
 * under grants/, its heartbeat and its ledger. The intake writes there and
 * nowhere else, and only after every check has passed:
 *
 * - MERRYMEN_PERPS is paper (D1), or nothing is written at all — and a
 *   renewal's stop (DELETE ?wallet=perps, permission-replacement) is refused
 *   with the renewal, while the kill still stops the wallet;
 * - a renewal's stop keeps no record of the stopped key (no retired-key fence
 *   here, unlike hosted), so the grant it stopped is armed again if posted
 *   again: the skipped revocation of D6 rests on the empty wall alone;
 * - the grant is the Perps wall, empty in this build (D5), as hosted;
 * - the Spot grant.json, if any, has the same owner key and another account;
 * - THE INDEX-1 DERIVATION (D8): nothing else ties a self-hosted Perps grant to
 *   its owner, so the account is re-derived from the owner at the Perps index
 *   with a live eth_call — an index-0 account is refused 403, and a chain
 *   that cannot answer is a 503 with nothing written, never a pass.
 *
 * Driven through the real route in a temporary MERRYMEN_HOME, with grants
 * sealed by the canonical-wall fixture and a stub chain whose EntryPoint
 * derives each Kernel account from its initCode. Adapted from the perps
 * branch's dual-purpose-local.test.ts (112dbeb6): `?wallet=`, main's renewal
 * stop (a permission replacement on ?wallet=perps) in place of the branch's
 * per-wallet DELETE, and the derivation the branch never made. Competing
 * POSTs now hold a shared writer lock while checking and saving both wallets.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, beforeEach, describe, it } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { LocalAccount } from "viem";
import type { StoredGrant } from "@merrymen/core";
import { RESTORE_PERPS_OWNER_DIFFERS, RESTORE_PERPS_UNREAD, restorePerpsRefusal } from "@/lib/restore-perps-owner";

const ORIGIN = "http://localhost:3100";
const ENV = ["MERRYMEN_HOME", "MERRYMEN_HOSTED", "DATABASE_URL", "MERRYMEN_GRANT_FILE", "MERRYMEN_PERPS"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
let home = "";
let route: typeof import("./route");
let fixture: typeof import("@/lib/canonical-wall-fixture");
let chain: ReturnType<typeof import("@/lib/canonical-wall-fixture").derivingChain>;
let owner: LocalAccount;
let SPOT: `0x${string}`, PERPS: `0x${string}`;

const spotFile = () => path.join(home, "grant.json");
const perpsHome = () => path.join(home, "accounts", "perps");
const perpsFile = () => path.join(perpsHome(), "grant.json");
const read = (file: string): string | null => { try { return readFileSync(file, "utf8"); } catch { return null; } };
const post = (grant: unknown, query = "?wallet=perps") =>
  route.POST(new Request(`${ORIGIN}/api/grants${query}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(grant) }));
const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, unknown> });
/** The Spot grant.json a self-hosted install holds: the same owner key, at index 0. */
const spotOnDisk = (over: Partial<StoredGrant> = {}) => JSON.stringify({
  owner: owner.address, smartAccount: SPOT, chainId: 4663, serialized: "spot-permission", sessionKeyAddress: owner.address,
  grantFeatures: ["tradeable-v2"], caps: { perTradeUsdg: 10, dailyUsdg: 50, expiryDays: 7, maxDrawdownPct: 20, maxOpsPerDay: 20 },
  grantedAt: 1, expiresAt: 9_999_999_999, demoOwnerPrivateKey: "kept-on-this-install", ...over,
}, null, 2);
const perpsGrant = async (account = PERPS, signer = owner) => (await fixture.signerGrant({ owner: signer, account, purpose: "perps" })).grant;

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "mm-grants-dual-local-"));
  process.env.MERRYMEN_HOME = home;
  for (const k of ["MERRYMEN_HOSTED", "DATABASE_URL", "MERRYMEN_GRANT_FILE"] as const) delete process.env[k];
  process.env.MERRYMEN_PERPS = "paper";
  fixture = await import("@/lib/canonical-wall-fixture");
  chain = fixture.derivingChain();
  chain.install();
  route = await import("./route");
  owner = privateKeyToAccount(generatePrivateKey());
  const { deriveKernelAccountAddress } = await import("@/lib/derive-account");
  const at = async (w: "spot" | "perps") => { const d = await deriveKernelAccountAddress(owner.address, 4663, w); assert.ok(d.ok); return d.address; };
  SPOT = await at("spot");
  PERPS = await at("perps");
});
after(() => {
  chain?.restore();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
beforeEach(() => {
  process.env.MERRYMEN_PERPS = "paper";
  chain.state.down = false;
  for (const name of ["grant.json", "accounts", "grants"]) rmSync(path.join(home, name), { recursive: true, force: true });
  writeFileSync(spotFile(), spotOnDisk());
});

describe("self-hosted: the Perps wallet is written to its own home, and only there", () => {
  it("a Perps grant at the owner's index-1 account lands whole in accounts/perps/grant.json, 0600; Spot's grant.json does not move", async () => {
    const before = read(spotFile());
    const grant = await perpsGrant();
    assert.deepEqual(await json(await post(grant)), { status: 200, body: { ok: true } });
    assert.deepEqual(JSON.parse(read(perpsFile())!), grant);
    assert.equal(statSync(perpsFile()).mode & 0o777, 0o600);
    assert.equal(read(spotFile()), before, "the Spot grant.json is byte for byte what it was");
    assert.equal(existsSync(path.join(home, "grants")), false, "and nothing of Spot's was archived");
  });

  it("a renewal (the stop, then the new grant) keeps the outgoing grant in the Perps home's own archive", async () => {
    const first = await perpsGrant();
    assert.equal((await post(first)).status, 200);
    const stop = await route.DELETE(new Request(`${ORIGIN}/api/grants?wallet=perps`, {
      method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ purpose: "permission-replacement", expectedAccount: first.smartAccount, expectedSession: first.sessionKeyAddress }),
    }));
    assert.deepEqual(await json(stop), { status: 200, body: { ok: true, replacement: true, state: "stopped" } });
    const next = await perpsGrant();
    assert.equal((await post(next)).status, 200);
    assert.deepEqual(JSON.parse(read(perpsFile())!), next);
    assert.deepEqual(readdirSync(path.join(perpsHome(), "grants")), [`${first.smartAccount.toLowerCase()}.json`]);
    assert.deepEqual(JSON.parse(read(path.join(perpsHome(), "grants", `${first.smartAccount.toLowerCase()}.json`))!), first);
    // A renewal straight over the old file archives it too.
    assert.equal((await post(await perpsGrant())).status, 200);
    assert.deepEqual(JSON.parse(read(path.join(perpsHome(), "grants", `${first.smartAccount.toLowerCase()}.json`))!), next);
  });

  it("D6 SELF-HOSTED HAS NO RETIRED-KEY FENCE: the grant a renewal stopped, posted again, is armed again — harmless only because its wall is empty, the one case renewalSkipsRevocation lets through", async () => {
    // Hosted, the store retires the stopped key's hash and refuses that key
    // until a kill deletes the record (dual-purpose.test.ts, D6). Here the
    // stop archives grant.json and retains only public identity, as main's
    // self-hosted Spot renewal never did; this machine's archive holds the key
    // and its owner key either way.
    // So nothing here may be read as that fence: a renewal that skips the
    // on-chain revocation (perps-renewal.ts) is safe on the empty wall alone.
    const first = await perpsGrant();
    assert.equal((await post(first)).status, 200);
    const stop = await route.DELETE(new Request(`${ORIGIN}/api/grants?wallet=perps`, {
      method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ purpose: "permission-replacement", expectedAccount: first.smartAccount, expectedSession: first.sessionKeyAddress }),
    }));
    assert.deepEqual(await json(stop), { status: 200, body: { ok: true, replacement: true, state: "stopped" } });
    assert.equal(existsSync(perpsFile()), false, "stopped");
    assert.deepEqual(await json(await post(first)), { status: 200, body: { ok: true } });
    assert.deepEqual(JSON.parse(read(perpsFile())!), first, "the stopped session key is armed again");
    // What makes that harmless: the wall it was sealed over rebuilds to no
    // permission at all, so the key can call nothing on chain…
    const { buildCallPermissions, grantWallOptions, GRANT_ENERGY } = await import("@merrymen/core");
    const { renewalSkipsRevocation } = await import("@/lib/perps-renewal");
    assert.deepEqual(buildCallPermissions(first.caps, first.smartAccount as `0x${string}`, grantWallOptions(first)), []);
    assert.equal(renewalSkipsRevocation(first), true);
    // …and a wall that could call anything never skips the revocation, here
    // or hosted: it is never let through on a fence this install lacks.
    assert.equal(renewalSkipsRevocation({ ...first, grantFeatures: [GRANT_ENERGY] }), false);
  });

  it("an install with no Spot grant makes its Perps wallet all the same", async () => {
    rmSync(spotFile());
    assert.equal((await post(await perpsGrant())).status, 200);
    assert.equal(existsSync(spotFile()), false);
  });
});

describe("self-hosted: every refusal lands before anything is written", () => {
  const untouched = (before: string | null) => {
    assert.equal(read(spotFile()), before, "the Spot grant.json is untouched");
    assert.equal(existsSync(perpsHome()), false, "and no Perps home was made");
  };

  it("rechecks the other wallet after a slow derivation, before saving a conflicting first grant", async () => {
    const grant = await perpsGrant();
    const stranger = privateKeyToAccount(generatePrivateKey());
    const spot = JSON.parse(spotOnDisk({ owner: stranger.address }));
    rmSync(spotFile());
    const fetchChain = globalThis.fetch;
    let reached!: () => void;
    let release!: () => void;
    const deriving = new Promise<void>(resolve => { reached = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      reached();
      await released;
      return fetchChain(...args);
    }) as typeof fetch;
    const incoming = post(grant);
    try {
      await deriving;
      assert.equal((await post(spot, "")).status, 200);
      release();
      const refused = await json(await incoming);
      assert.equal(refused.status, 409, "a first grant saved during the derivation must still bind the other wallet's owner");
      assert.equal(refused.body.code, "owner-differs");
      assert.deepEqual(JSON.parse(read(spotFile())!), spot);
      assert.equal(read(perpsFile()), null);
    } finally {
      release();
      await incoming;
      globalThis.fetch = fetchChain;
    }
  });

  it("D8: THE OWNER'S INDEX-0 ACCOUNT UNDER wallet=perps is refused 403, and so is anyone else's", async () => {
    // No Spot grant.json, so the index is the only thing that tells the two apart.
    rmSync(spotFile());
    const atSpot = await json(await post(await perpsGrant(SPOT)));
    assert.equal(atSpot.status, 403, JSON.stringify(atSpot.body));
    untouched(null);
    const stranger = privateKeyToAccount(generatePrivateKey());
    assert.equal((await post(await perpsGrant(PERPS, stranger))).status, 403, "an account that is not the owner's own");
    untouched(null);
  });

  it("D8: A DERIVATION THAT CANNOT BE MADE is a 503 with nothing written, never a pass", async () => {
    const before = read(spotFile());
    const grant = await perpsGrant();
    chain.state.down = true;
    const down = await json(await post(grant));
    assert.equal(down.status, 503, JSON.stringify(down.body));
    untouched(before);
  });

  it("PERPS OFF: 403 perps-wallet-not-offered, nothing written", async () => {
    const before = read(spotFile());
    const grant = await perpsGrant();
    for (const ceiling of [undefined, "off", "live", "papr"]) {
      if (ceiling === undefined) delete process.env.MERRYMEN_PERPS;
      else process.env.MERRYMEN_PERPS = ceiling;
      const res = await json(await post(grant));
      assert.equal(res.status, 403, String(ceiling));
      assert.equal(res.body.code, "perps-wallet-not-offered");
      untouched(before);
    }
  });

  it("PERPS OFF: a Perps renewal's first step is refused 403 and its grant.json is kept byte for byte; the kill still stops it", async () => {
    // A renewal's stop archived and removed accounts/perps/grant.json, then
    // the POST that should have followed was refused: a Perps wallet gone from
    // this install until perps came back on. It is refused with the renewal.
    const grant = await perpsGrant();
    assert.equal((await post(grant)).status, 200);
    const before = { perps: read(perpsFile()), spot: read(spotFile()), home: readdirSync(perpsHome()).sort() };
    const renewalStop = () => route.DELETE(new Request(`${ORIGIN}/api/grants?wallet=perps`, {
      method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ purpose: "permission-replacement" }),
    }));
    for (const ceiling of [undefined, "off", "live", "papr"]) {
      if (ceiling === undefined) delete process.env.MERRYMEN_PERPS;
      else process.env.MERRYMEN_PERPS = ceiling;
      const res = await json(await renewalStop());
      assert.equal(res.status, 403, String(ceiling));
      assert.equal(res.body.code, "perps-wallet-not-offered");
      assert.match(String(res.body.error), /was not stopped[\s\S]*Nothing was changed/);
      assert.equal(read(perpsFile()), before.perps, `the Perps grant.json is byte for byte what it was (${String(ceiling)})`);
      assert.deepEqual(readdirSync(perpsHome()).sort(), before.home, "and nothing was archived beside it");
      assert.equal(read(spotFile()), before.spot, "the Spot grant.json is untouched");
    }
    // The kill is not a renewal: it stops the Perps wallet whatever the lever says.
    delete process.env.MERRYMEN_PERPS;
    const killed = await json(await route.DELETE(new Request(`${ORIGIN}/api/grants`, { method: "DELETE" })));
    assert.deepEqual(killed, { status: 200, body: { ok: true, perps: "stopped" } });
    assert.equal(existsSync(perpsFile()), false);
    assert.deepEqual(JSON.parse(read(path.join(perpsHome(), "grants", `${grant.smartAccount.toLowerCase()}.json`))!), grant, "its owner key is kept in its own archive");
  });

  it("the Spot grant.json must have the same owner key and another account: 409 with the store's code", async () => {
    const other = privateKeyToAccount(generatePrivateKey()).address;
    writeFileSync(spotFile(), spotOnDisk({ owner: other }));
    const differs = await json(await post(await perpsGrant()));
    assert.equal(differs.status, 409);
    assert.equal(differs.body.code, "owner-differs");
    untouched(spotOnDisk({ owner: other }));

    writeFileSync(spotFile(), spotOnDisk({ smartAccount: PERPS }));
    const shared = await json(await post(await perpsGrant()));
    assert.equal(shared.status, 409);
    assert.equal(shared.body.code, "account-shared");

    writeFileSync(spotFile(), spotOnDisk({ grantFeatures: ["tradeable-v2", "perp-lighter-v1"] }));
    const legacy = await json(await post(await perpsGrant()));
    assert.equal(legacy.status, 409);
    assert.equal(legacy.body.code, "legacy-perps");
    // A hand-sent renewal or restore can meet any of these after its own stop (self-hosted, nothing derives a Spot
    // grant's account): each says what this request did, never that neither wallet changed.
    for (const refused of [differs, shared, legacy]) {
      assert.match(String(refused.body.error), /this permission was not saved.*your other wallet was not changed\./i);
      assert.doesNotMatch(String(refused.body.error), /neither wallet/i);
    }
  });

  it("a Spot grant.json that cannot be read or verified refuses 503: it is the grant the rule is about", async () => {
    for (const unreadable of ["{not json", spotOnDisk({ purpose: "perps" }), JSON.stringify({ smartAccount: SPOT })]) {
      writeFileSync(spotFile(), unreadable);
      const res = await json(await post(await perpsGrant()));
      assert.equal(res.status, 503, unreadable.slice(0, 20));
      assert.match(String(res.body.error), /could not be read.*was not saved\. Your spot wallet was not changed\./);
      untouched(unreadable);
    }
  });

  it("the wall: a Perps grant sealed over the Spot wall, or declaring any marker, is refused 400 invalid_wall", async () => {
    const before = read(spotFile());
    const grant = await perpsGrant();
    const overSpot = await fixture.resealed(grant, owner, { perpsOnly: false });
    const res = await json(await post(overSpot));
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "invalid_wall");
    assert.equal((await json(await post({ ...grant, grantFeatures: ["energy-buy-v1"] }))).body.code, "invalid_wall");
    untouched(before);
  });

  it("the Spot intake holds the Perps grant.json to the same rules: another owner's is 409, and grant.json is kept", async () => {
    mkdirSync(perpsHome(), { recursive: true });
    const stranger = privateKeyToAccount(generatePrivateKey()).address;
    writeFileSync(perpsFile(), JSON.stringify({ purpose: "perps", owner: stranger, smartAccount: PERPS }));
    const before = read(spotFile());
    const res = await json(await post(JSON.parse(spotOnDisk({ serialized: "renewed" })), ""));
    assert.equal(res.status, 409);
    assert.equal(res.body.code, "owner-differs");
    // It may answer the second step of a restore, after that restore's own stop:
    // it says what this request did, never that neither wallet changed.
    assert.equal(res.body.error, "Both of a login's wallets must use the same owner key, so this permission was not saved. Your other wallet was not changed.");
    assert.equal(read(spotFile()), before);
    // With the Perps wallet's own owner it is the renewal it always was.
    writeFileSync(perpsFile(), JSON.stringify({ purpose: "perps", owner: owner.address, smartAccount: PERPS }));
    assert.equal((await post(JSON.parse(spotOnDisk({ serialized: "renewed" })), "")).status, 200);
    assert.equal((JSON.parse(read(spotFile())!) as StoredGrant).serialized, "renewed");
  });
});

describe("self-hosted: GET ?wallet=perps reads the Perps home, never the Spot one", () => {
  const get = (query: string) => route.GET(new Request(`${ORIGIN}/api/grants${query}`));

  it("the Perps grant through the allowlist and its own heartbeat; the Spot answer is Spot's", async () => {
    const grant = await perpsGrant();
    assert.equal((await post(grant)).status, 200);
    writeFileSync(path.join(perpsHome(), "heartbeat.json"), JSON.stringify({ at: 1_790_000_000, mode: "paper" }));
    writeFileSync(path.join(home, "heartbeat.json"), JSON.stringify({ at: 1_780_000_000, mode: "live" }));
    const res = await get("?wallet=perps");
    assert.equal(res.headers.get("cache-control"), "private, no-store");
    const text = await res.text();
    const body = JSON.parse(text) as Record<string, unknown> & { grant: Record<string, unknown> };
    assert.equal(String(body.grant.smartAccount).toLowerCase(), PERPS.toLowerCase());
    assert.equal(body.workerAliveAt, 1_790_000_000, "the Perps worker's own heartbeat");
    assert.equal(body.mode, "paper");
    assert.equal(body.grant.serialized, undefined);
    assert.ok(!text.toLowerCase().includes(grant.demoSessionPrivateKey!.slice(2).toLowerCase()), "the session key never leaves");
    const spot = (await (await get("")).json()) as { grant: { smartAccount: string }; workerAliveAt: number };
    assert.equal(spot.grant.smartAccount, SPOT);
    assert.equal(spot.workerAliveAt, 1_780_000_000);
  });

  it("no Perps grant.json is { exists: false }, whatever Spot holds; one that names Spot is refused 503", async () => {
    assert.deepEqual(await json(await get("?wallet=perps")), { status: 200, body: { exists: false } });
    mkdirSync(perpsHome(), { recursive: true });
    writeFileSync(perpsFile(), spotOnDisk());
    const res = await json(await get("?wallet=perps"));
    assert.equal(res.status, 503);
    assert.doesNotMatch(JSON.stringify(res.body), /kept-on-this-install|spot-permission/);
  });

  it("A PERPS grant.json THAT IS THERE BUT CANNOT BE READ IS A 503, never none; a BOM is stripped as the POST strips it; and the Wallet screen's restore check sees each", async () => {
    // The restore asks this before its stop, which self-hosted removes Spot's
    // grant.json and stops Solana; the POST that ends it reads the Perps file
    // this same way (otherLocalWalletRefusal) and would refuse it after.
    const viaGet = (async (url: string | URL | Request) => get(String(url).replace(/^\/api\/grants/, ""))) as typeof fetch;
    const stranger = privateKeyToAccount(generatePrivateKey()).address;
    const grant = await perpsGrant();
    assert.equal((await post(grant)).status, 200);
    const onDisk = read(perpsFile())!;

    writeFileSync(perpsFile(), `\ufeff${onDisk}`);
    const bom = await json(await get("?wallet=perps"));
    assert.equal(bom.status, 200);
    assert.equal(bom.body.exists, true, "a BOM is no reason to call a wallet absent");
    assert.equal(String((bom.body.grant as { owner: string }).owner).toLowerCase(), owner.address.toLowerCase());
    assert.equal(await restorePerpsRefusal(stranger, viaGet), RESTORE_PERPS_OWNER_DIFFERS);
    assert.equal(await restorePerpsRefusal(owner.address, viaGet), null);

    for (const [what, damage] of [
      ["truncated", () => writeFileSync(perpsFile(), onDisk.slice(0, 20))],
      ["a directory", () => { rmSync(perpsFile()); mkdirSync(perpsFile()); }],
    ] as const) {
      damage();
      const res = await json(await get("?wallet=perps"));
      assert.equal(res.status, 503, what);
      assert.equal(res.body.error, "Couldn't read your Perps wallet. Please try again.", what);
      assert.equal(await restorePerpsRefusal(owner.address, viaGet), RESTORE_PERPS_UNREAD, `${what}: refused before the restore's stop, even under its own owner key`);
    }
    rmSync(perpsFile(), { recursive: true, force: true });
    assert.deepEqual(await json(await get("?wallet=perps")), { status: 200, body: { exists: false } }, "gone is none");
    assert.equal(await restorePerpsRefusal(stranger, viaGet), null);
    // Spot's answer is as it was: an unreadable Spot grant.json is none there.
    writeFileSync(spotFile(), "{not json");
    assert.deepEqual(await json(await get("")), { status: 200, body: { exists: false } });
  });

  it("perps off: still answered", async () => {
    assert.equal((await post(await perpsGrant())).status, 200);
    delete process.env.MERRYMEN_PERPS;
    const body = (await (await get("?wallet=perps")).json()) as { exists?: boolean };
    assert.equal(body.exists, true);
  });

  it("the Perps worker's report, from the Perps home's own ledger", async () => {
    const grant = await perpsGrant();
    assert.equal((await post(grant)).status, 200);
    const { wrapSqlite } = await import("../../../../../worker/src/db");
    const { applyLedgerSchema } = await import("../../../../../worker/src/store");
    const report = { v: 1, mode: "paper", blocker: null, venueReadAt: null, protectAt: null, accountIndex: null, positions: [],
      openNotionalMicro: "0", collateralMicro: "100000000", inTransitMicro: null, minLiqDistanceBps: null, stopsMissing: 0, incident: false };
    for (const [dir, perps] of [[perpsHome(), JSON.stringify(report)], [home, JSON.stringify({ ...report, collateralMicro: "999" })]] as const) {
      const raw = new DatabaseSync(path.join(dir, "merrymen.db"));
      try {
        const db = wrapSqlite(raw);
        await applyLedgerSchema(db);
        // Keyed as the worker keys it (worker/src/store.ts ensureAgent): by the
        // stored grant's smartAccount, verbatim. The real signer hands it over
        // checksummed, as viem derives it.
        await db.prepare(`INSERT INTO agents (smart_account, name, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, mode, epoch, perps)
          VALUES (?, 'Perps', '0x1', '0x2', 4663, '{}', 0, 0, 'paper', 1, ?)`).run(grant.smartAccount, perps);
      } finally { raw.close(); }
    }
    const body = (await (await get("?wallet=perps")).json()) as { perps?: unknown };
    assert.deepEqual(body.perps, report, "the Perps home's ledger, never the Spot one's");
  });
});

/** A delayed renewal is bound to the exact permission its screen displayed. */
describe("local renewal identity survives its grant removal", () => {
  const stop = (body: Record<string, unknown>) => route.DELETE(new Request(`${ORIGIN}/api/grants?wallet=perps`, {
    method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ purpose: "permission-replacement", ...body }),
  }));
  it("missing and stale account/session bindings change no files", async () => {
    const current = await perpsGrant(); assert.equal((await post(current)).status, 200);
    const original = read(perpsFile());
    for (const [body, expectedStatus] of [
      [{}, 400], [{ expectedAccount: current.smartAccount }, 400],
      [{ expectedAccount: SPOT, expectedSession: current.sessionKeyAddress }, 409],
      [{ expectedAccount: current.smartAccount, expectedSession: owner.address }, 409],
    ] as const) {
      assert.equal((await stop(body)).status, expectedStatus); assert.equal(read(perpsFile()), original);
      assert.equal(existsSync(path.join(perpsHome(), "grants")), false);
    }
  });
  it("the retained record contains no keys and still prevents a conflicting Spot restore after the Perps grant is gone", async () => {
    const current = await perpsGrant(); assert.equal((await post(current)).status, 200);
    assert.equal((await stop({ expectedAccount: current.smartAccount, expectedSession: current.sessionKeyAddress })).status, 200);
    assert.equal(existsSync(perpsFile()), false);
    const binding = path.join(perpsHome(), "permission-replacement.json");
    const text = read(binding); assert.ok(text); assert.doesNotMatch(text, /PrivateKey|serialized|signature/i); assert.equal(statSync(binding).mode & 0o777, 0o600);
    const status = await json(await route.GET(new Request(`${ORIGIN}/api/grants?wallet=perps`)));
    assert.equal(status.body.exists, false); assert.equal(status.body.stored, true); assert.equal(status.body.storedOwner, owner.address.toLowerCase());
    const pendingRead = (async () => Response.json(status.body)) as typeof fetch;
    assert.equal(await restorePerpsRefusal(owner.address, pendingRead), null);
    assert.equal(await restorePerpsRefusal(SPOT, pendingRead), RESTORE_PERPS_OWNER_DIFFERS);
    assert.equal((await stop({ expectedAccount: current.smartAccount, expectedSession: owner.address })).status, 409);
    assert.equal(read(binding), text, "a stale retry cannot replace the retained identity");
    const stranger = privateKeyToAccount(generatePrivateKey());
    const conflict = await json(await post(JSON.parse(spotOnDisk({ owner: stranger.address })), ""));
    assert.equal(conflict.status, 409); assert.equal(conflict.body.code, "owner-differs");
    const allowed = await post(JSON.parse(spotOnDisk()), ""); assert.equal(allowed.status, 200);
    assert.equal((await post(await perpsGrant())).status, 200); assert.equal(existsSync(binding), false);
  });
  it("an unreadable retained identity fails closed, and a kill clears the pending relationship", async () => {
    const current = await perpsGrant(); assert.equal((await post(current)).status, 200);
    assert.equal((await stop({ expectedAccount: current.smartAccount, expectedSession: current.sessionKeyAddress })).status, 200);
    const binding = path.join(perpsHome(), "permission-replacement.json");
    writeFileSync(binding, "{broken");
    assert.equal((await post(JSON.parse(spotOnDisk()), "")).status, 503);
    assert.equal((await route.GET(new Request(`${ORIGIN}/api/grants?wallet=perps`))).status, 503);
    const { stopLocalPerpsWallet } = await import("../../../../../worker/src/perps-kill");
    await stopLocalPerpsWallet(); assert.equal(existsSync(binding), false, "kill discards the relationship even when the stopped record is unreadable");
    assert.equal((await post(JSON.parse(spotOnDisk()), "")).status, 200);
  });
  it("a status read waits for the grant and retained identity writer transition", async () => {
    const current = await perpsGrant(); assert.equal((await post(current)).status, 200);
    const { withLocalStateLock } = await import("../../../../../worker/src/local-state-lock");
    const { retainLocalPerpsBinding } = await import("../../../../../worker/src/local-perps-binding");
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const writing = withLocalStateLock(home, async () => {
      rmSync(perpsFile()); entered(); await gate; retainLocalPerpsBinding(current, perpsHome());
    });
    await ready;
    let finished = false;
    const reading = route.GET(new Request(`${ORIGIN}/api/grants?wallet=perps`)).then(res => { finished = true; return res; });
    try { await new Promise(resolve => setTimeout(resolve, 35)); assert.equal(finished, false, "status cannot observe the gap between two identity files"); }
    finally { release(); await writing; }
    const status = await json(await reading);
    assert.equal(status.body.stored, true); assert.equal(status.body.storedOwner, owner.address.toLowerCase());
  });
  it("a delayed stop waits for the shared writer lock and compares the permission again after it is released", async () => {
    const first = await perpsGrant(), next = await perpsGrant(); assert.equal((await post(first)).status, 200);
    const { withLocalStateLock } = await import("../../../../../worker/src/local-state-lock");
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const writing = withLocalStateLock(home, async () => { entered(); await gate; writeFileSync(perpsFile(), JSON.stringify(next)); });
    await ready;
    let finished = false;
    const stopping = stop({ expectedAccount: first.smartAccount, expectedSession: first.sessionKeyAddress }).then(res => { finished = true; return res; });
    try { await new Promise(resolve => setTimeout(resolve, 35)); assert.equal(finished, false, "the stop participates in the grant writer lock"); }
    finally { release(); await writing; }
    assert.equal((await stopping).status, 409); assert.deepEqual(JSON.parse(read(perpsFile())!), next);
  });
});
