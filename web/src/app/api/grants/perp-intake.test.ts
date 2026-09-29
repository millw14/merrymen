/**
 * POST /api/grants, SELF-HOSTED, AND THE LIGHTER KEY (docs/perps.md rule 5).
 *
 * Driven through the real POST with grant.json and the key store on a temp
 * MERRYMEN_HOME. The venue is stood in for through perp-custody's flatness
 * seam, so each case says exactly what Lighter answered. What must hold:
 *   - a perp block is accepted only when its key file exists and pairs;
 *   - a plaintext key, a sealed blob, a marker without its block: refused;
 *   - a grant that drops perps, names another account, or names another key
 *     (a rotation), while the stored one carries perps: 409 unless the STORED
 *     account reads provably flat —
 *     and nothing is archived or overwritten when it is refused.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

const saved = Object.fromEntries(["MERRYMEN_HOME", "MERRYMEN_HOSTED", "DATABASE_URL", "MERRYMEN_PERPS"].map((k) => [k, process.env[k]]));
const home = mkdtempSync(path.join(tmpdir(), "mm-grants-perp-intake-"));
process.env.MERRYMEN_HOME = home;
delete process.env.MERRYMEN_HOSTED;
delete process.env.DATABASE_URL;
// The self-hosted default (live): the owner is the operator. One case below restricts it.
delete process.env.MERRYMEN_PERPS;

let POST: (req: Request) => Promise<Response>;
let custody: typeof import("@/lib/perp-custody");
let writePerpKeyFile: typeof import("../../../../../worker/src/perps/keystore").writePerpKeyFile;

const GRANT_FILE = path.join(home, "grant.json");
const ARCHIVE = path.join(home, "grants");
const ACCOUNT = "0x00000000000000000000000000000000000000a1";
const OTHER = "0x00000000000000000000000000000000000000a2";
const pub = (b: number) => `0x${(b.toString(16).padStart(2, "0") + "00".repeat(7)).repeat(5)}`;
const PRIV = `0x${"ab".repeat(40)}`;

let flatAnswer: { flat: true } | { flat: false; detail: string } | { flat: null; detail: string } = { flat: true };
const flatAsked: string[] = [];

before(async () => {
  custody = await import("@/lib/perp-custody");
  ({ writePerpKeyFile } = await import("../../../../../worker/src/perps/keystore"));
  custody.setVenueFlatnessForTest(async (a) => {
    flatAsked.push(a);
    return flatAnswer;
  });
  ({ POST } = await import("./route"));
  writePerpKeyFile(home, { privateKey: PRIV as `0x${string}`, publicKey: pub(1) as `0x${string}` });
});
after(() => {
  custody.setVenueFlatnessForTest(null);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
beforeEach(() => {
  rmSync(GRANT_FILE, { force: true });
  rmSync(ARCHIVE, { recursive: true, force: true });
  flatAnswer = { flat: true };
  flatAsked.length = 0;
});

function grant(o: { account?: string; perp?: Record<string, unknown> | null; marker?: boolean; extra?: Record<string, unknown> } = {}) {
  const marker = o.marker ?? o.perp !== null;
  return {
    smartAccount: o.account ?? ACCOUNT,
    owner: "0x00000000000000000000000000000000000000e5",
    sessionKeyAddress: "0x00000000000000000000000000000000000000f6",
    serialized: "eyJ-not-a-real-permission",
    caps: { perTradeUsdg: 10, dailyUsdg: 50, expiryDays: 14, maxDrawdownPct: 20, maxOpsPerDay: 100 },
    grantedAt: 1_790_000_000,
    expiresAt: 1_791_209_600,
    chainId: 4663,
    grantFeatures: marker ? ["tradeable-v2", "perp-lighter-v1"] : ["tradeable-v2"],
    ...(o.perp === null ? {} : { perp: { route: "perp-lighter-v1", apiKeyIndex: 16, apiPublicKey: pub(1), ...(o.perp ?? {}) } }),
    demoSessionPrivateKey: `0x${"cd".repeat(32)}`,
    demoOwnerPrivateKey: `0x${"ef".repeat(32)}`,
    ...o.extra,
  };
}

const post = (body: unknown) =>
  POST(new Request("http://localhost:3100/api/grants", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

async function expectRefusal(res: Response, status: number, code: string) {
  const body = (await res.json()) as { error?: string; code?: string; ownerFacing?: boolean };
  assert.equal(res.status, status, JSON.stringify(body));
  assert.equal(body.code, code);
  assert.equal(body.ownerFacing, true);
  assert.ok(!JSON.stringify(body).includes(PRIV.slice(2, 20)), "no key material in a refusal");
  return body;
}

describe("the perp block must name a key this install holds", () => {
  it("a grant without perps is stored as before", async () => {
    const res = await post(grant({ perp: null }));
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(readFileSync(GRANT_FILE, "utf8")).smartAccount, ACCOUNT);
  });

  it("a perp block whose key file exists and pairs is stored", async () => {
    const res = await post(grant());
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(readFileSync(GRANT_FILE, "utf8")).perp, { route: "perp-lighter-v1", apiKeyIndex: 16, apiPublicKey: pub(1) });
  });

  it("a key this install never generated: 400, nothing written", async () => {
    await expectRefusal(await post(grant({ perp: { apiPublicKey: pub(2) } })), 400, "perp-key-missing");
    assert.equal(existsSync(GRANT_FILE), false);
  });

  it("a sealed blob, a plaintext key, a marker without its block: refused by name", async () => {
    await expectRefusal(await post(grant({ perp: { apiKeySealed: `pk1.${"A".repeat(16)}.${"B".repeat(22)}.${"C".repeat(110)}` } })), 400, "perp-key-sealed-self-hosted");
    await expectRefusal(await post(grant({ perp: { apiPrivateKey: PRIV } })), 422, "perp-private-key-forbidden");
    await expectRefusal(await post(grant({ perp: null, extra: { notes: PRIV } })), 422, "perp-private-key-forbidden");
    await expectRefusal(await post(grant({ perp: null, marker: true })), 400, "perp-block-malformed");
    assert.equal(existsSync(GRANT_FILE), false);
  });
});

describe("a NEW opt-in only where the operator offers it; a carry-forward always", () => {
  it("MERRYMEN_PERPS=off: a new perp block is 403 perp-not-offered and nothing is written; the stored key carried forward is accepted", async () => {
    process.env.MERRYMEN_PERPS = "off";
    try {
      await expectRefusal(await post(grant()), 403, "perp-not-offered");
      assert.equal(existsSync(GRANT_FILE), false);
      // The same key the stored grant already names: never gated.
      writeFileSync(GRANT_FILE, JSON.stringify(grant(), null, 2));
      assert.equal((await post(grant())).status, 200);
      assert.equal(JSON.parse(readFileSync(GRANT_FILE, "utf8")).perp.apiPublicKey, pub(1));
      // A grant without perps is untouched by the lever (the stored perps
      // grant is let go of only because the venue reads flat here).
      flatAnswer = { flat: true };
      assert.equal((await post(grant({ perp: null, account: OTHER }))).status, 200);
      assert.deepEqual(flatAsked, [ACCOUNT]);
    } finally {
      delete process.env.MERRYMEN_PERPS;
    }
  });
});

describe("no path leaves a non-flat venue without its key — the 409", () => {
  const storeCurrent = (g: unknown) => writeFileSync(GRANT_FILE, JSON.stringify(g, null, 2));

  for (const [label, next] of [
    ["the same account, perps dropped", () => grant({ perp: null })],
    ["another account", () => grant({ perp: null, account: OTHER })],
  ] as const) {
    it(`${label}: NOT FLAT is a 409 with rule 5's sentence; nothing archived, nothing overwritten`, async () => {
      storeCurrent(grant());
      const before = readFileSync(GRANT_FILE, "utf8");
      flatAnswer = { flat: false, detail: "account 22149: 1 open position (BTC-PERP)" };
      const body = await expectRefusal(await post(next()), 409, "perp-venue-not-flat");
      assert.equal(body.error, custody.PERP_NOT_FLAT_MESSAGE);
      assert.deepEqual(flatAsked, [ACCOUNT], "the STORED account's venue is what is read");
      assert.equal(readFileSync(GRANT_FILE, "utf8"), before);
      assert.equal(existsSync(ARCHIVE), false);
    });

    it(`${label}: UNREAD is refused exactly like not flat`, async () => {
      storeCurrent(grant());
      flatAnswer = { flat: null, detail: "Lighter's account list could not be read: rate-limited" };
      const body = await expectRefusal(await post(next()), 409, "perp-venue-unread");
      assert.ok(body.error?.includes(custody.PERP_NOT_FLAT_MESSAGE));
    });

    it(`${label}: PROVABLY FLAT is allowed, and the outgoing grant is archived as before`, async () => {
      storeCurrent(grant());
      flatAnswer = { flat: true };
      const res = await post(next());
      assert.equal(res.status, 200);
      assert.equal(JSON.parse(readFileSync(GRANT_FILE, "utf8")).perp, undefined);
      assert.ok(existsSync(path.join(ARCHIVE, `${ACCOUNT}.json`)));
    });
  }

  // A ROTATION strands the registered key exactly as a drop does: the worker
  // loads only the key the grant names, so the old one — still valid at index
  // 16 until a changePubKey for the new one lands, which 21126 can refuse —
  // would sit in perp-keys/ with nothing signing exits for its positions.
  describe("a key change on the same account (the new key's file exists and pairs)", () => {
    const ROTATED = pub(3);
    before(() => writePerpKeyFile(home, { privateKey: `0x${"9c".repeat(40)}` as `0x${string}`, publicKey: ROTATED as `0x${string}` }));

    it("NOT FLAT is a 409; grant.json still names the registered key and nothing is archived", async () => {
      storeCurrent(grant());
      const before = readFileSync(GRANT_FILE, "utf8");
      flatAnswer = { flat: false, detail: "account 22149: 2 open positions" };
      const body = await expectRefusal(await post(grant({ perp: { apiPublicKey: ROTATED } })), 409, "perp-venue-not-flat");
      assert.equal(body.error, custody.PERP_NOT_FLAT_MESSAGE);
      assert.deepEqual(flatAsked, [ACCOUNT]);
      assert.equal(readFileSync(GRANT_FILE, "utf8"), before);
      assert.equal(existsSync(ARCHIVE), false);
    });

    it("UNREAD is refused exactly like not flat", async () => {
      storeCurrent(grant());
      flatAnswer = { flat: null, detail: "rate-limited" };
      await expectRefusal(await post(grant({ perp: { apiPublicKey: ROTATED } })), 409, "perp-venue-unread");
    });

    it("PROVABLY FLAT is allowed: the new key is stored", async () => {
      storeCurrent(grant());
      flatAnswer = { flat: true };
      assert.equal((await post(grant({ perp: { apiPublicKey: ROTATED } }))).status, 200);
      assert.equal(JSON.parse(readFileSync(GRANT_FILE, "utf8")).perp.apiPublicKey, ROTATED);
      assert.deepEqual(flatAsked, [ACCOUNT]);
    });
  });

  it("a re-sign that CARRIES the key forward never asks the venue", async () => {
    storeCurrent(grant());
    flatAnswer = { flat: false, detail: "positions" };
    assert.equal((await post(grant())).status, 200);
    assert.deepEqual(flatAsked, []);
  });

  it("a stored grant WITHOUT perps never asks the venue", async () => {
    storeCurrent(grant({ perp: null }));
    flatAnswer = { flat: false, detail: "positions" };
    assert.equal((await post(grant({ perp: null, account: OTHER }))).status, 200);
    assert.deepEqual(flatAsked, []);
  });

  it("a corrupt grant.json that mentions the perps marker is not assumed empty", async () => {
    writeFileSync(GRANT_FILE, '{"grantFeatures":["perp-lighter-v1"], oops');
    await expectRefusal(await post(grant({ perp: null })), 409, "perp-venue-unread");
    // …while one that cannot have held perps does not block a re-sign.
    writeFileSync(GRANT_FILE, "{ not json");
    assert.equal((await post(grant({ perp: null }))).status, 200);
  });
});
