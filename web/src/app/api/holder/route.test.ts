/**
 * /api/holder — ONE $MERRYMEN WALLET POWERS ONE AGENT, through the real route.
 *
 * The proof bound a wallet to an account and nothing bound it back, so one
 * 100,000-token wallet linked into N accounts powered N agents. The route now
 * CLAIMS the wallet before it stores the proof, an unreadable store refuses
 * rather than letting a second account in, and unlinking frees the wallet.
 * The wallet's own fresh signature MOVES a claim another account holds, at
 * most once per wallet in any 24 hours (429 after that, saying when).
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
  return {
    status: res.status,
    retryAfter: res.headers.get("retry-after"),
    body: (await res.json()) as { ok?: boolean; error?: string; ownerFacing?: boolean; moved?: boolean; movableAt?: number },
  };
}
async function unlink(tenant: string) {
  const res = await route.DELETE(new Request(`${ORIGIN}/api/holder`, { method: "DELETE", headers: cookie(tenant) }));
  return { status: res.status, body: (await res.json()) as { ok?: boolean; error?: string } };
}
async function patch(tenant: string) {
  const res = await route.PATCH(new Request(`${ORIGIN}/api/holder`, { method: "PATCH", headers: cookie(tenant) }));
  return (await res.json()) as { linked: { address: string } | null; reads: string | null; proof: string | null };
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
    assert.deepEqual(await patch(a.address), { linked: await proofOf(a.address), reads: "linked", proof: "counting" });
  });

  it("THE WALLET'S OWN FRESH SIGNATURE MOVES ITS CLAIM FROM ANOTHER ACCOUNT — which is never named", async () => {
    // First-claim-wins alone locked a wallet's real holder out for good once
    // any other account had claimed it (a phished or borrowed signature, an
    // account nobody can sign in to): their own fresh signature met 409.
    const a = newWallet();
    const b = newWallet();
    const w = newWallet();
    assert.equal((await link(a.address, w)).status, 200);
    const second = await link(b.address, w);
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(second.body.moved, true, "the signer is told it moved here");
    assert.ok(!JSON.stringify(second.body).toLowerCase().includes(lc(a.address)), "the other account is never named");
    assert.equal((await store.holderClaims()).get(lc(w.address)), lc(b.address), "the claim is b's now");
    assert.deepEqual(await patch(b.address), { linked: await proofOf(b.address), reads: "linked", proof: "counting" });
    assert.deepEqual(
      await patch(a.address),
      { linked: await proofOf(a.address), reads: "login", proof: "claimed-elsewhere" },
      "a's proof counts nowhere now — and a is told why",
    );
  });

  it("A LOGIN WALLET TAKES ITSELF BACK: the whale signs for their own account and it counts there again", async () => {
    const attacker = newWallet();
    const whale = newWallet();
    assert.equal((await link(attacker.address, whale)).status, 200, "a phished signature claimed the whale's wallet");
    assert.deepEqual(await patch(whale.address), { linked: null, reads: "none", proof: null }, "the whale's own account counted nothing");
    const back = await link(whale.address, whale);
    assert.equal(back.status, 200, JSON.stringify(back.body));
    assert.equal(back.body.moved, true);
    assert.deepEqual(await patch(whale.address), { linked: await proofOf(whale.address), reads: "linked", proof: "counting" });
    assert.deepEqual(await patch(attacker.address), { linked: await proofOf(attacker.address), reads: "login", proof: "claimed-elsewhere" });
  });

  it("ONE MOVE PER WALLET IN ANY 24 HOURS: the next is 429, says when, names nobody, and stores nothing", async () => {
    const a = newWallet();
    const b = newWallet();
    const c = newWallet();
    const w = newWallet();
    assert.equal((await link(a.address, w)).status, 200);
    const movedFrom = Date.now();
    assert.equal((await link(b.address, w)).status, 200, "the one move");
    const movedBy = Date.now();
    const third = await link(c.address, w);
    assert.equal(third.status, 429, JSON.stringify(third.body));
    // 24 hours from the move itself — not the next UTC midnight.
    const at = third.body.movableAt ?? 0;
    assert.ok(at >= movedFrom + 86_400_000 && at <= movedBy + 86_400_000, `movableAt ${at}`);
    assert.match(third.body.error ?? "", /already moved in the last 24 hours/);
    assert.match(third.body.error ?? "", /once every 24 hours/);
    assert.doesNotMatch(third.body.error ?? "", /today|UTC day|per day/, "no calendar day in it any more");
    const shown = /from (\d{2}):(\d{2}) UTC on (\d{1,2}) ([A-Z][a-z]{2}) (\d{4})/.exec(third.body.error ?? "");
    assert.ok(shown, third.body.error);
    const up = new Date(Math.ceil(at / 60_000) * 60_000);
    assert.deepEqual(
      [Number(shown[1]), Number(shown[2]), Number(shown[3]), Number(shown[5])],
      [up.getUTCHours(), up.getUTCMinutes(), up.getUTCDate(), up.getUTCFullYear()],
      "the minute it names is never before movableAt",
    );
    assert.equal(third.body.ownerFacing, true);
    assert.ok(Number(third.retryAfter) > 86_000 && Number(third.retryAfter) <= 86_400, `retry-after ${third.retryAfter}`);
    for (const who of [a, b]) {
      assert.ok(!JSON.stringify(third.body).toLowerCase().includes(lc(who.address)), "no account is named");
    }
    assert.doesNotMatch(third.body.error ?? "", /price|return|profit/i);
    assert.equal(await proofOf(c.address), null, "no proof — a refused move is not a holding");
    assert.equal((await store.holderClaims()).get(lc(w.address)), lc(b.address), "the claim did not move");
    const back = await link(a.address, w);
    assert.equal(back.status, 200, "back to the account it was moved from is allowed the same day");
    assert.equal(back.body.moved, true);
    assert.equal((await link(c.address, w)).status, 429, "and a third account still waits out the 24 hours");
  });

  it("A PHISHED MOVE NEVER LOCKS THE OWNER OUT: the wallet's own sign-in account takes it back at once", async () => {
    // One phished signature moved the claim off the owner's own login account
    // and spent the move; the owner's fresh signature from that very account
    // met 429 until 00:00 UTC while the attacker's agent ran on the bag.
    const whale = newWallet();
    const attacker = newWallet();
    const other = newWallet();
    assert.equal((await link(whale.address, whale)).status, 200);
    assert.equal((await link(attacker.address, whale)).body.moved, true, "the phished move");
    const back = await link(whale.address, whale);
    assert.equal(back.status, 200, JSON.stringify(back.body));
    assert.equal(back.body.moved, true);
    assert.deepEqual(await patch(whale.address), { linked: await proofOf(whale.address), reads: "linked", proof: "counting" });
    assert.equal((await link(other.address, whale)).status, 429, "taking it back still spends the 24 hours for anybody else");
  });

  it("AN UNLINK DOES NOT GIVE THE MOVE BACK: after a → b, b unlinks, and c and d are still 429 — naming nobody", async () => {
    // The review's bypass: every unlink deleted the claim row and its move,
    // so one bag could power a, b, c and d in one day.
    const [a, b, c, d] = [newWallet(), newWallet(), newWallet(), newWallet()];
    const w = newWallet();
    assert.equal((await link(a.address, w)).status, 200);
    assert.equal((await link(b.address, w)).body.moved, true, "the move");
    assert.equal((await unlink(b.address)).status, 200);
    for (const who of [c, d]) {
      const res = await link(who.address, w);
      assert.equal(res.status, 429, JSON.stringify(res.body));
      assert.match(res.body.error ?? "", /Another merrymen account used this wallet recently/);
      assert.match(res.body.error ?? "", /once every 24 hours/);
      assert.doesNotMatch(res.body.error ?? "", /powers another/, "nobody holds it now, and the copy does not say so");
      for (const x of [a, b]) assert.ok(!JSON.stringify(res.body).toLowerCase().includes(lc(x.address)), "no account is named");
      assert.equal(await proofOf(who.address), null);
    }
    assert.equal((await store.holderClaims()).has(lc(w.address)), false);
    assert.equal((await link(a.address, w)).status, 200, "a, which it was just moved from, may still have it back");
  });

  it("A FAILED LINK OF A RELEASED WALLET SPENDS NO MOVE — undone, not released", async () => {
    const [a, b, c] = [newWallet(), newWallet(), newWallet()];
    const w = newWallet();
    assert.equal((await link(a.address, w)).status, 200);
    assert.equal((await unlink(a.address)).status, 200);
    const put = mock.method(store, "put", async () => {
      throw new Error("disk full");
    });
    try {
      assert.equal((await link(b.address, w)).status, 503);
    } finally {
      put.mock.restore();
    }
    assert.equal((await store.holderClaims()).has(lc(w.address)), false);
    assert.equal((await link(c.address, w)).status, 200, "b's link never happened, so neither did its move");
  });

  it("CONCURRENT LINKS OF ONE WALLET FROM THREE ACCOUNTS → ONE CLAIM, AT MOST ONE MOVE; exactly one account counts it", async () => {
    const accounts = [newWallet(), newWallet(), newWallet()];
    const w = newWallet();
    const out = await Promise.all(accounts.map((x) => link(x.address, w)));
    assert.ok(out.every((r) => r.status === 200 || r.status === 429), JSON.stringify(out));
    assert.ok(out.filter((r) => r.status === 200).length >= 1);
    assert.ok(out.filter((r) => r.body.moved).length <= 1, "one move a day, however they race");
    const holder = (await store.holderClaims()).get(lc(w.address));
    const counting = [];
    for (const x of accounts) if ((await patch(x.address)).reads === "linked") counting.push(lc(x.address));
    assert.deepEqual(counting, [holder]);
  });

  it("A MOVE WHOSE PROOF FAILS TO SAVE IS PUT BACK — the other account keeps it, and its move is not spent", async () => {
    const a = newWallet();
    const b = newWallet();
    const c = newWallet();
    const w = newWallet();
    assert.equal((await link(a.address, w)).status, 200);
    const put = mock.method(store, "put", async () => {
      throw new Error("disk full");
    });
    try {
      assert.equal((await link(b.address, w)).status, 503);
    } finally {
      put.mock.restore();
    }
    assert.equal((await store.holderClaims()).get(lc(w.address)), lc(a.address), "nothing changed");
    assert.deepEqual(await patch(a.address), { linked: await proofOf(a.address), reads: "linked", proof: "counting" });
    assert.equal((await link(c.address, w)).status, 200, "the move is still there to use");
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
    assert.deepEqual(await patch(a.address), { linked: null, reads: "none", proof: null });
  });

  it("AN UNREADABLE STORE REFUSES — 503, no claim, no proof", async () => {
    const a = newWallet();
    const w = newWallet();
    const claim = mock.method(store, "takeHolder", async () => {
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

describe("ONE CLAIM PER ACCOUNT — by the claims, whatever the stored proof says", () => {
  it("A STALE SETTINGS WRITE PUT BACK THE OLD PROOF: unlink still frees the wallet actually claimed", async () => {
    // The review's race: the owner saves settings while linking W1 over W0.
    // The settings PUT read {proof W0}, the link claimed W1 and wrote
    // {proof W1}, then the PUT wrote back {proof W0}. The claim on W1 has no
    // proof left to find it by.
    const a = newWallet();
    const w0 = newWallet();
    const w1 = newWallet();
    assert.equal((await link(a.address, w0)).status, 200);
    const stale = (await store.get(lc(a.address)))!;
    assert.equal((await link(a.address, w1)).status, 200);
    await store.put(lc(a.address), stale);
    assert.equal((await store.holderClaims()).get(lc(w1.address)), lc(a.address), "set-up: W1 claimed, proof names W0");
    assert.equal((await unlink(a.address)).status, 200);
    const claims = await store.holderClaims();
    assert.equal(claims.has(lc(w1.address)), false, "the claim no screen showed is released too");
    assert.equal(claims.has(lc(w0.address)), false);
    assert.equal(await proofOf(a.address), null);
  });

  it("LINKING RELEASES EVERY OTHER CLAIM THE ACCOUNT HOLDS, not only the one its proof names", async () => {
    const a = newWallet();
    const w0 = newWallet();
    const stray = newWallet();
    const w2 = newWallet();
    assert.equal((await link(a.address, w0)).status, 200);
    await store.claimHolder(lc(stray.address), lc(a.address)); // left by an earlier race
    assert.equal((await link(a.address, w2)).status, 200);
    assert.deepEqual([...(await store.holderClaims())], [[lc(w2.address), lc(a.address)]], "one account, one claim");
  });

  it("RE-LINKING TO WALLET B WHEN B'S PROOF FAILS TO SAVE KEEPS WALLET A — claimed, named by the proof, and counting", async () => {
    // The review's case: a linked A, a new signature for B, then the proof
    // write fails. The old order released A before that write, so "nothing
    // changed" left A unclaimed while the stored proof still named it.
    const a = newWallet();
    const wa = newWallet();
    const wb = newWallet();
    const c = newWallet();
    assert.equal((await link(a.address, wa)).status, 200);
    const put = mock.method(store, "put", async () => {
      throw new Error("disk full");
    });
    try {
      const res = await link(a.address, wb);
      assert.equal(res.status, 503);
      assert.match(res.body.error ?? "", /nothing changed/);
    } finally {
      put.mock.restore();
    }
    const claims = await store.holderClaims();
    assert.equal(claims.get(lc(wa.address)), lc(a.address), "A is still this account's");
    assert.equal(claims.has(lc(wb.address)), false, "and only the claim this call took is undone");
    assert.equal((await proofOf(a.address))?.address, lc(wa.address));
    assert.deepEqual(await patch(a.address), { linked: await proofOf(a.address), reads: "linked", proof: "counting" });
    const moved = await link(c.address, wa);
    assert.equal(moved.status, 200);
    assert.equal(moved.body.moved, true, "A was never released: another account taking it is a move from this one");
    assert.equal((await link(a.address, wb)).status, 200, "and B is still free to link");
  });

  it("A RELEASE THAT FAILS AFTER THE PROOF IS STORED LEAVES THE NEW LINK COUNTING — and the next unlink clears the leftover", async () => {
    const a = newWallet();
    const wa = newWallet();
    const wb = newWallet();
    assert.equal((await link(a.address, wa)).status, 200);
    const release = mock.method(store, "releaseHolderClaims", async () => {
      throw new Error("Connection terminated unexpectedly");
    });
    const warn = mock.method(console, "warn", () => {});
    try {
      const res = await link(a.address, wb);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(warn.mock.callCount(), 1, "said out loud");
      assert.ok(!String(warn.mock.calls[0]!.arguments[0]).toLowerCase().includes(lc(wa.address)), "naming no wallet");
    } finally {
      release.mock.restore();
      warn.mock.restore();
    }
    assert.equal((await proofOf(a.address))?.address, lc(wb.address));
    assert.deepEqual(await patch(a.address), { linked: await proofOf(a.address), reads: "linked", proof: "counting" });
    const claims = await store.holderClaims();
    assert.equal(claims.get(lc(wb.address)), lc(a.address));
    assert.equal(claims.get(lc(wa.address)), lc(a.address), "the leftover: it backs no proof, so it counts nowhere");
    assert.equal((await unlink(a.address)).status, 200);
    assert.equal((await store.holderClaims()).size, 0, "one unlink releases both");
  });

  it("…and never anybody else's", async () => {
    const a = newWallet();
    const b = newWallet();
    const wa = newWallet();
    const wb = newWallet();
    assert.equal((await link(a.address, wa)).status, 200);
    assert.equal((await link(b.address, wb)).status, 200);
    assert.equal((await unlink(a.address)).status, 200);
    assert.equal((await store.holderClaims()).get(lc(wb.address)), lc(b.address));
  });
});

describe("DELETE /api/holder releases the claim", () => {
  it("UNLINKED, THE WALLET IS FREE FOR ANOTHER ACCOUNT", async () => {
    const a = newWallet();
    const b = newWallet();
    const w = newWallet();
    assert.equal((await link(a.address, w)).status, 200);
    const res = await unlink(a.address);
    assert.equal(res.status, 200);
    assert.equal(await proofOf(a.address), null);
    assert.equal((await store.holderClaims()).has(lc(w.address)), false);
    assert.equal((await link(b.address, w)).status, 200);
    assert.deepEqual(await patch(a.address), { linked: null, reads: "login", proof: null });
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
    assert.deepEqual(await patch(a.address), { linked: await proofOf(a.address), reads: "login", proof: "unclaimed" });
    // …and the retry finds the proof and finishes.
    assert.equal((await unlink(a.address)).status, 200);
    assert.equal(await proofOf(a.address), null);
    assert.equal((await link(b.address, w)).status, 200);
  });

  it("an unreadable claims store refuses the unlink and changes nothing", async () => {
    const a = newWallet();
    const w = newWallet();
    assert.equal((await link(a.address, w)).status, 200);
    const release = mock.method(store, "releaseHolderClaims", async () => {
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

describe("PATCH says which wallet the tier reads — and why a linked one is not counting", () => {
  it("AN UNCLAIMED PROOF IS 'unclaimed', NEVER 'another account has it' — and linking it again makes it count", async () => {
    // Linked before claims existed and not yet backfilled (or left by a
    // half-failed unlink): nobody else holds it. The screen used to tell this
    // owner to go and unlink it from an account that does not exist.
    const a = newWallet();
    const w = newWallet();
    await store.put(lc(a.address), { holderProof: { address: lc(w.address), at: 1 } });
    assert.deepEqual(await patch(a.address), { linked: await proofOf(a.address), reads: "login", proof: "unclaimed" });
    assert.equal((await link(a.address, w)).status, 200, "the same wallet, signed for again");
    assert.deepEqual(await patch(a.address), { linked: await proofOf(a.address), reads: "linked", proof: "counting" });
  });

  it("a proof whose claim another account holds is 'claimed-elsewhere'", async () => {
    const a = newWallet();
    const b = newWallet();
    const w = newWallet();
    await store.put(lc(a.address), { holderProof: { address: lc(w.address), at: 1 } });
    await store.claimHolder(lc(w.address), lc(b.address));
    assert.equal((await patch(a.address)).proof, "claimed-elsewhere");
  });

  it("and nothing either when the account's own settings cannot be read — never a crash, never 'nothing linked'", async () => {
    const a = newWallet();
    const get = mock.method(store, "get", async () => {
      throw new Error("unseal failed");
    });
    try {
      const res = await route.PATCH(new Request(`${ORIGIN}/api/holder`, { method: "PATCH", headers: cookie(a.address) }));
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { linked: null, reads: null, proof: null });
    } finally {
      get.mock.restore();
    }
  });

  it("and says nothing (null) when the claims cannot be read, rather than guess", async () => {
    const a = newWallet();
    const claims = mock.method(store, "holderClaims", async () => {
      throw new Error("Connection terminated unexpectedly");
    });
    try {
      assert.deepEqual(await patch(a.address), { linked: null, reads: null, proof: null });
    } finally {
      claims.mock.restore();
    }
  });
});
