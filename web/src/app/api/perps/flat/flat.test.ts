/**
 * GET /api/perps/flat — authenticated like GET /api/grants, only for the
 * caller's own agent, never cached (docs/perps.md rule 5).
 *
 * The venue is stood in for through perp-custody's flatness seam; what is
 * pinned here is who may ask, about what, and that the answer is passed
 * through as the venue read gave it — `null` included, never rounded to a yes.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const saved = Object.fromEntries(
  ["MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_SESSION_SECRET", "DATABASE_URL", "MERRYMEN_STORE_DEK"].map((k) => [k, process.env[k]]),
);
const home = mkdtempSync(path.join(tmpdir(), "mm-perp-flat-route-"));
process.env.MERRYMEN_HOME = home;
process.env.MERRYMEN_SESSION_SECRET = "test-secret-at-least-thirty-two-characters-long";
process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 7).toString("base64");
delete process.env.DATABASE_URL;
delete process.env.MERRYMEN_HOSTED;

let GET: (req: Request) => Promise<Response>;
let auth: typeof import("@/lib/auth");
let custody: typeof import("@/lib/perp-custody");
let sealSecret: (p: string, d: Buffer) => string;
const asked: string[] = [];
let answer: { flat: true } | { flat: false; detail: string } | { flat: null; detail: string } = { flat: true };

before(async () => {
  auth = await import("@/lib/auth");
  custody = await import("@/lib/perp-custody");
  ({ sealSecret } = await import("../../../../../../worker/src/store-crypto"));
  custody.setVenueFlatnessForTest(async (a) => {
    asked.push(a);
    return answer;
  });
  ({ GET } = await import("./route"));
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
  asked.length = 0;
});

const ACCOUNT = "0x00000000000000000000000000000000000000a1";
const OTHER = "0x00000000000000000000000000000000000000a2";
const minimalGrant = { smartAccount: ACCOUNT, owner: "0x00000000000000000000000000000000000000e5", chainId: 4663, grantFeatures: ["tradeable-v2"] };
const get = (q: string, headers: Record<string, string> = {}) => GET(new Request(`http://localhost:3100/api/perps/flat${q}`, { headers }));
const noStore = (res: Response) => assert.match(res.headers.get("cache-control") ?? "", /private, no-store/);

it("the route is GET-only and force-dynamic", async () => {
  const mod = await import("./route");
  assert.deepEqual(Object.keys(mod).sort(), ["GET", "dynamic"]);
  assert.equal(mod.dynamic, "force-dynamic");
});

describe("self-hosted", () => {
  before(() => writeFileSync(path.join(home, "grant.json"), JSON.stringify(minimalGrant)));

  it("answers for the agent in grant.json, passing the venue's answer through — null stays null", async () => {
    for (const a of [{ flat: true } as const, { flat: false, detail: "account 1: 2 open positions" } as const, { flat: null, detail: "rate-limited" } as const]) {
      answer = a;
      const res = await get(`?smartAccount=${ACCOUNT.toUpperCase().replace("0X", "0x")}`);
      assert.equal(res.status, 200);
      noStore(res);
      const body = (await res.json()) as { flat: unknown; detail: unknown; smartAccount: unknown };
      assert.equal(body.smartAccount, ACCOUNT);
      assert.equal(body.flat, a.flat);
      assert.equal(body.detail, "detail" in a ? a.detail : null);
    }
    assert.deepEqual([...new Set(asked)], [ACCOUNT]);
  });

  it("any other account is a 404 and the venue is not asked; a malformed one a 400", async () => {
    const res = await get(`?smartAccount=${OTHER}`);
    assert.equal(res.status, 404);
    noStore(res);
    assert.equal((await get("?smartAccount=0x12")).status, 400);
    assert.equal((await get("")).status, 400);
    assert.deepEqual(asked, []);
  });
});

describe("hosted", () => {
  const tenant = privateKeyToAccount(generatePrivateKey()).address;
  before(() => {
    process.env.MERRYMEN_HOSTED = "1";
    const dir = path.join(home, "tenants");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, `${tenant.toLowerCase()}.json`),
      JSON.stringify({ tenant: tenant.toLowerCase(), chainId: 4663, grant: minimalGrant, sealedSessionKey: sealSecret(`0x${"cd".repeat(32)}`, Buffer.alloc(32, 7)), updatedAt: 1 }),
    );
  });
  after(() => {
    delete process.env.MERRYMEN_HOSTED;
  });

  it("signed out: 401, and the venue is not asked", async () => {
    const res = await get(`?smartAccount=${ACCOUNT}`);
    assert.equal(res.status, 401);
    noStore(res);
    assert.deepEqual(asked, []);
  });

  it("the tenant's own agent: answered; another tenant's session cannot ask about it", async () => {
    answer = { flat: false, detail: "account 1: 5 USDG collateral" };
    const mine = await get(`?smartAccount=${ACCOUNT}`, { cookie: `${auth.SESSION_COOKIE}=${auth.mintSession(tenant)}` });
    assert.equal(mine.status, 200);
    assert.equal(((await mine.json()) as { flat: unknown }).flat, false);
    const stranger = privateKeyToAccount(generatePrivateKey()).address;
    const theirs = await get(`?smartAccount=${ACCOUNT}`, { cookie: `${auth.SESSION_COOKIE}=${auth.mintSession(stranger)}` });
    assert.equal(theirs.status, 404);
    assert.deepEqual(asked, [ACCOUNT]);
  });
});
