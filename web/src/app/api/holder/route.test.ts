/**
 * /api/holder — ONE $MERRYMEN WALLET POWERS ONE AGENT, through the real route.
 *
 * The proof bound a wallet to an account and nothing bound it back, so one
 * 100,000-token wallet linked into N accounts powered N agents. The route now
 * CLAIMS the wallet before it stores the proof: first claim wins, a second
 * account is refused with 409 and nothing stored, an unreadable store refuses
 * rather than letting a second account in, and unlinking frees the wallet.
 *
 * Hosted, as it only exists there: the real GET → sign → POST round trip with
 * real viem signatures. The nonce store and the settings store are the two
 * things stood in for — `pg` is not installed here — and the settings store
 * that stands in is the REAL PgSettingsStore running its SQL on sqlite.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

const ORIGIN = "https://app.merrymen.dev";
const saved = Object.fromEntries(
  ["MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_SESSION_SECRET", "DATABASE_URL", "MERRYMEN_PUBLIC_ORIGIN", "MERRYMEN_STORE_DEK"].map(
    (k) => [k, process.env[k]],
  ),
);

type Route = typeof import("./route");
type SettingsStoreModule = typeof import("../../../../../worker/src/settings-store");
type Client = { query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };

let home: string;
let route: Route;
let auth: typeof import("@/lib/auth");
let stores: SettingsStoreModule;
/** The store the route is being served, rebuilt per case. */
let store: InstanceType<SettingsStoreModule["PgSettingsStore"]>;

/** sqlite standing in for Postgres: `$n` → `?n`, rows from anything that returns them. */
function sqliteClient(): Client {
  const db = new DatabaseSync(":memory:");
  return {
    async query(sql, params = []) {
      await new Promise((r) => setImmediate(r)); // let concurrent requests interleave
      const stmt = db.prepare(sql.replace(/\$(\d+)/g, "?$1"));
      if (/^\s*SELECT|RETURNING/i.test(sql)) return { rows: stmt.all(...(params as string[])) as Record<string, unknown>[] };
      stmt.run(...(params as string[]));
      return { rows: [] };
    },
  };
}

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "mm-holder-route-"));
  process.env.MERRYMEN_HOME = home;
  process.env.MERRYMEN_HOSTED = "1";
  process.env.MERRYMEN_SESSION_SECRET = "test-secret-at-least-thirty-two-characters-long";
  process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 9).toString("base64");
  // Hosted challenge verification requires shared storage; never connected to.
  process.env.DATABASE_URL = "postgres://127.0.0.1:1/never-connected";
  delete process.env.MERRYMEN_PUBLIC_ORIGIN;
  auth = await import("@/lib/auth");
  // THROUGH require, ON PURPOSE (grants/owner-facing.test.ts): the route
  // reaches worker modules by require, and a stub on the ESM instance of the
  // same file is a stub the route never calls.
  const req = createRequire(import.meta.url);
  const { SqlNonceStore } = req("../../../../../worker/src/auth-nonce-store.ts") as typeof import("../../../../../worker/src/auth-nonce-store");
  // Single-use, as the real one is: the nonce is burned on first consume.
  const used = new Set<string>();
  mock.method(SqlNonceStore.prototype, "consume", async (nonce: string) => {
    if (used.has(nonce)) return false;
    used.add(nonce);
    return true;
  });
  stores = req("../../../../../worker/src/settings-store.ts") as SettingsStoreModule;
  route = await import("./route");
});
beforeEach(() => {
  const client = sqliteClient();
  store = new stores.PgSettingsStore("postgres://stand-in", async () => client);
  stores.useSettingsStoreForTest(store);
});
after(() => {
  mock.restoreAll();
  stores.resetSettingsStoreForTest();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const lc = (a: string) => a.toLowerCase() as `0x${string}`;
const cookie = (tenant: string) => ({ cookie: `${auth.SESSION_COOKIE}=${auth.mintSession(lc(tenant))}` });
const newWallet = () => privateKeyToAccount(generatePrivateKey());

/** The whole round trip: ask for the text, sign it with `wallet`, POST it as `tenant`. */
async function link(tenant: string, wallet: PrivateKeyAccount) {
  const got = await route.GET(
    new Request(`${ORIGIN}/api/holder?holder=${wallet.address}`, { headers: cookie(tenant) }),
  );
  assert.equal(got.status, 200);
  const { message, nonce } = (await got.json()) as { message: string; nonce: string };
  const signature = await wallet.signMessage({ message });
  const res = await route.POST(
    new Request(`${ORIGIN}/api/holder`, {
      method: "POST",
      headers: { "content-type": "application/json", ...cookie(tenant) },
      body: JSON.stringify({ holder: wallet.address, signature, nonce }),
    }),
  );
  return { status: res.status, body: (await res.json()) as { ok?: boolean; error?: string; ownerFacing?: boolean } };
}
async function unlink(tenant: string) {
  const res = await route.DELETE(new Request(`${ORIGIN}/api/holder`, { method: "DELETE", headers: cookie(tenant) }));
  return { status: res.status, body: (await res.json()) as { ok?: boolean; error?: string } };
}
async function patch(tenant: string) {
  const res = await route.PATCH(new Request(`${ORIGIN}/api/holder`, { method: "PATCH", headers: cookie(tenant) }));
  return (await res.json()) as { linked: { address: string } | null; reads: string | null };
}
const proofOf = async (tenant: string) => (await store.get(lc(tenant)))?.holderProof ?? null;

describe("POST /api/holder claims the wallet before it stores the proof", () => {
  it("THE FIRST ACCOUNT TO LINK A WALLET GETS IT", async () => {
    const a = newWallet();
    const w = newWallet();
    const res = await link(a.address, w);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await proofOf(a.address))?.address, lc(w.address));
    assert.equal((await store.holderClaims()).get(lc(w.address)), lc(a.address));
    assert.deepEqual(await patch(a.address), { linked: await proofOf(a.address), reads: "linked" });
  });

  it("A SECOND ACCOUNT IS REFUSED WITH 409 — AND NOTHING IS STORED FOR IT", async () => {
    const a = newWallet();
    const b = newWallet();
    const w = newWallet();
    assert.equal((await link(a.address, w)).status, 200);
    const second = await link(b.address, w);
    assert.equal(second.status, 409);
    assert.match(second.body.error ?? "", /already powers another merrymen account/);
    assert.match(second.body.error ?? "", /a wallet can power one account/);
    assert.equal(second.body.ownerFacing, true);
    assert.ok(!(second.body.error ?? "").toLowerCase().includes(lc(a.address)), "the other account is never named");
    assert.equal(await proofOf(b.address), null, "no proof — a signature is not a holding");
    assert.equal((await store.holderClaims()).get(lc(w.address)), lc(a.address), "the claim did not move");
    assert.deepEqual(await patch(b.address), { linked: null, reads: "login" });
  });

  it("CONCURRENT LINKS OF ONE WALLET FROM TWO ACCOUNTS → ONE 200, ONE 409", async () => {
    const a = newWallet();
    const b = newWallet();
    const w = newWallet();
    const [ra, rb] = await Promise.all([link(a.address, w), link(b.address, w)]);
    assert.deepEqual([ra.status, rb.status].sort(), [200, 409]);
    const winner = ra.status === 200 ? a : b;
    const loser = winner === a ? b : a;
    assert.equal((await store.holderClaims()).get(lc(w.address)), lc(winner.address));
    assert.equal(await proofOf(loser.address), null);
  });

  it("re-linking your own wallet is not a conflict", async () => {
    const a = newWallet();
    const w = newWallet();
    assert.equal((await link(a.address, w)).status, 200);
    assert.equal((await link(a.address, w)).status, 200);
    assert.equal((await store.holderClaims()).get(lc(w.address)), lc(a.address));
  });

  it("LINKING A DIFFERENT WALLET MOVES THE CLAIM — the old one is freed", async () => {
    const a = newWallet();
    const b = newWallet();
    const w1 = newWallet();
    const w2 = newWallet();
    assert.equal((await link(a.address, w1)).status, 200);
    assert.equal((await link(a.address, w2)).status, 200);
    const claims = await store.holderClaims();
    assert.equal(claims.get(lc(w2.address)), lc(a.address));
    assert.equal(claims.has(lc(w1.address)), false, "one account holds one wallet");
    assert.equal((await link(b.address, w1)).status, 200, "the old wallet is free for someone else");
  });

  it("A LOGIN WALLET LINKED INTO ANOTHER ACCOUNT STOPS COUNTING FOR ITS OWN", async () => {
    const a = newWallet();
    const b = newWallet();
    assert.equal((await link(b.address, a)).status, 200, "b links a's login wallet, with a's signature");
    assert.deepEqual(await patch(a.address), { linked: null, reads: "none" });
  });

  it("AN UNREADABLE STORE REFUSES — 503, no claim, no proof", async () => {
    const a = newWallet();
    const w = newWallet();
    const claim = mock.method(store, "claimHolder", async () => {
      throw new Error("Connection terminated unexpectedly");
    });
    try {
      const res = await link(a.address, w);
      assert.equal(res.status, 503);
      assert.match(res.body.error ?? "", /couldn't check whether another account already uses this wallet/);
      assert.equal(res.body.ownerFacing, true);
    } finally {
      claim.mock.restore();
    }
    assert.equal(await proofOf(a.address), null);
    assert.equal((await store.holderClaims()).size, 0);
  });

  it("A PROOF THAT FAILS TO SAVE GIVES BACK THE CLAIM IT JUST TOOK", async () => {
    const a = newWallet();
    const b = newWallet();
    const w = newWallet();
    const put = mock.method(store, "put", async () => {
      throw new Error("disk full");
    });
    try {
      assert.equal((await link(a.address, w)).status, 503);
    } finally {
      put.mock.restore();
    }
    assert.equal((await store.holderClaims()).has(lc(w.address)), false, "a failed link must not hold the wallet hostage");
    assert.equal((await link(b.address, w)).status, 200);
  });

  it("…but never a claim it already held, which may back a stored proof", async () => {
    const a = newWallet();
    const w = newWallet();
    assert.equal((await link(a.address, w)).status, 200);
    const put = mock.method(store, "put", async () => {
      throw new Error("disk full");
    });
    try {
      assert.equal((await link(a.address, w)).status, 503);
    } finally {
      put.mock.restore();
    }
    assert.equal((await store.holderClaims()).get(lc(w.address)), lc(a.address));
    assert.equal((await proofOf(a.address))?.address, lc(w.address));
  });

  it("the nonce is still single-use: a refused link cannot be replayed into another account", async () => {
    const a = newWallet();
    const w = newWallet();
    const got = await route.GET(new Request(`${ORIGIN}/api/holder?holder=${w.address}`, { headers: cookie(a.address) }));
    const { message, nonce } = (await got.json()) as { message: string; nonce: string };
    const signature = await w.signMessage({ message });
    const post = () =>
      route.POST(
        new Request(`${ORIGIN}/api/holder`, {
          method: "POST",
          headers: { "content-type": "application/json", ...cookie(a.address) },
          body: JSON.stringify({ holder: w.address, signature, nonce }),
        }),
      );
    assert.equal((await post()).status, 200);
    assert.equal((await post()).status, 400);
  });
});

describe("DELETE /api/holder releases the claim", () => {
  it("UNLINKED, THE WALLET IS FREE FOR ANOTHER ACCOUNT", async () => {
    const a = newWallet();
    const b = newWallet();
    const w = newWallet();
    assert.equal((await link(a.address, w)).status, 200);
    assert.equal((await link(b.address, w)).status, 409);
    const res = await unlink(a.address);
    assert.equal(res.status, 200);
    assert.equal(await proofOf(a.address), null);
    assert.equal((await store.holderClaims()).has(lc(w.address)), false);
    assert.equal((await link(b.address, w)).status, 200);
    assert.deepEqual(await patch(a.address), { linked: null, reads: "login" });
  });

  it("an account with nothing linked unlinks to no effect, and never frees someone else's claim", async () => {
    const a = newWallet();
    const b = newWallet();
    const w = newWallet();
    assert.equal((await link(a.address, w)).status, 200);
    assert.equal((await unlink(b.address)).status, 200);
    assert.equal((await store.holderClaims()).get(lc(w.address)), lc(a.address));
  });

  it("A STORE THAT FAILS MID-UNLINK ANSWERS 503, AND ASKING AGAIN FINISHES THE JOB", async () => {
    const a = newWallet();
    const b = newWallet();
    const w = newWallet();
    assert.equal((await link(a.address, w)).status, 200);
    const put = mock.method(store, "put", async () => {
      throw new Error("Connection terminated unexpectedly");
    });
    try {
      assert.equal((await unlink(a.address)).status, 503);
    } finally {
      put.mock.restore();
    }
    // Released first, so the proof still stored counts nowhere meanwhile…
    assert.equal((await store.holderClaims()).has(lc(w.address)), false);
    assert.deepEqual(await patch(a.address), { linked: await proofOf(a.address), reads: "login" });
    // …and the retry finds the proof and finishes.
    assert.equal((await unlink(a.address)).status, 200);
    assert.equal(await proofOf(a.address), null);
    assert.equal((await link(b.address, w)).status, 200);
  });

  it("an unreadable claims store refuses the unlink and changes nothing", async () => {
    const a = newWallet();
    const w = newWallet();
    assert.equal((await link(a.address, w)).status, 200);
    const release = mock.method(store, "releaseHolder", async () => {
      throw new Error("Connection terminated unexpectedly");
    });
    try {
      assert.equal((await unlink(a.address)).status, 503);
    } finally {
      release.mock.restore();
    }
    assert.equal((await proofOf(a.address))?.address, lc(w.address));
    assert.equal((await store.holderClaims()).get(lc(w.address)), lc(a.address));
  });
});

describe("PATCH says which wallet the tier reads", () => {
  it("and says nothing (null) when the claims cannot be read, rather than guess", async () => {
    const a = newWallet();
    const claims = mock.method(store, "holderClaims", async () => {
      throw new Error("Connection terminated unexpectedly");
    });
    try {
      assert.deepEqual(await patch(a.address), { linked: null, reads: null });
    } finally {
      claims.mock.restore();
    }
  });
});
