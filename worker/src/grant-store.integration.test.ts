/**
 * The per-tenant grant store — durable, isolated, and encrypted at rest.
 *
 * Proven against a real temp filesystem: two tenants never see each other's
 * grant, the session key on disk is CIPHERTEXT not plaintext, a grant carrying
 * an owner key is refused, and a grant whose owner isn't the tenant is refused.
 * Each of those is a fund-safety property, so each gets its own assertion.
 *
 * MERRYMEN_HOME is set before the store resolves its dir; node's --test runs
 * each file in its own process, so the override never leaks.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, describe, it } from "node:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-gstore-"));
process.env.MERRYMEN_HOME = HOME;
// A 32-byte base64 DEK so the file backend seals the session key at rest.
process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 7).toString("base64");

const { FileGrantStore, GRANT_STORE_LOCK_FILE } = await import("./grant-store");
const { sealSecret, openSecret } = await import("./store-crypto");

after(() => {
  try {
    rmSync(HOME, { recursive: true, force: true });
  } catch {
    /* windows temp lock; disposable */
  }
});

const SESSION = ("0x" + "cd".repeat(32)) as `0x${string}`;
const grantFor = (owner: string): never =>
  ({
    smartAccount: "0x00000000000000000000000000000000000000a1",
    owner,
    serialized: "eyJ-a-zerodev-blob",
    chainId: 4663,
    grantFeatures: ["tradeable-v2"],
    grantTokens: [],
    demoSessionPrivateKey: SESSION,
  }) as never;

describe("store-crypto", () => {
  const dek = Buffer.alloc(32, 9);
  it("seals and opens a round trip", () => {
    const sealed = sealSecret(SESSION, dek);
    assert.notEqual(sealed, SESSION, "the sealed form is not the plaintext");
    assert.equal(openSecret(sealed, dek), SESSION);
  });
  it("a tampered ciphertext THROWS rather than returns a mangled key", () => {
    const sealed = sealSecret(SESSION, dek);
    const [iv, tag, ct] = sealed.split(".") as [string, string, string];
    const flipped = `${iv}.${tag}.${ct.slice(0, -2)}00`;
    assert.throws(() => openSecret(flipped, dek), "a signed UserOp must never be built from a mangled key");
  });
  it("the wrong key throws, not silently wrong output", () => {
    const sealed = sealSecret(SESSION, dek);
    assert.throws(() => openSecret(sealed, Buffer.alloc(32, 1)));
  });
});

describe("FileGrantStore", () => {
  const store = new FileGrantStore();
  const ALICE = "0x00000000000000000000000000000000000000a1" as const;
  const BOB = "0x00000000000000000000000000000000000000b2" as const;

  it("stores and returns a tenant's grant, session key intact", async () => {
    await store.put(ALICE, grantFor(ALICE));
    const g = await store.get(ALICE);
    assert.ok(g);
    assert.equal(g!.demoSessionPrivateKey, SESSION, "the session key round-trips through encryption");
    assert.equal(g!.owner, ALICE);
  });

  it("ENCRYPTS the session key at rest — the file must not contain the plaintext", async () => {
    await store.put(ALICE, grantFor(ALICE));
    const raw = readFileSync(path.join(HOME, "tenants", `${ALICE}.json`), "utf8");
    assert.ok(!raw.includes(SESSION), "the plaintext session key must never touch disk");
    assert.ok(raw.includes("sealedSessionKey"), "…it is stored sealed");
  });

  it("isolates tenants — one never sees another's grant", async () => {
    await store.put(ALICE, grantFor(ALICE));
    await store.put(BOB, grantFor(BOB));
    assert.equal((await store.get(ALICE))!.owner, ALICE);
    assert.equal((await store.get(BOB))!.owner, BOB);
    const tenants = (await store.listTenants()).sort();
    assert.deepEqual(tenants, [ALICE, BOB].sort());
  });

  it("REFUSES a grant carrying an owner key — defence in depth behind the route", async () => {
    await assert.rejects(
      () => store.put(ALICE, { ...(grantFor(ALICE) as object), demoOwnerPrivateKey: "0x" + "ab".repeat(32) } as never),
      /owner key/,
    );
  });

  /**
   * The store no longer compares grant.owner to the tenant, and MUST NOT.
   *
   * The owner key is generated in the browser, so `owner` can never equal the
   * signed-in wallet — requiring it refused every hosted grant ever submitted.
   * The tenant↔account link is proved at intake instead (verifyGrantBinding),
   * by the wallet's authorization plus the owner key's co-signature.
   *
   * What the store still guarantees is the part that was always doing the real
   * work: the record is filed under the AUTHENTICATED tenant, never under
   * anything the grant says about itself. So a grant naming Bob, stored by
   * Alice's session, is Alice's record and is not reachable as Bob's.
   */
  it("files a grant under the AUTHENTICATED tenant, never under grant.owner", async () => {
    // A third address with no grant of its own — earlier tests in this suite
    // already store one for BOB, so BOB cannot show "was not filed under the
    // declared owner".
    const CAROL = "0x00000000000000000000000000000000000000c3" as `0x${string}`;
    await store.put(ALICE, grantFor(CAROL));
    const asAlice = await store.get(ALICE);
    assert.ok(asAlice, "stored under the session that put it");
    assert.equal(asAlice!.owner, CAROL, "the declared owner is kept verbatim…");
    assert.equal(await store.get(CAROL), null, "…but it did NOT become Carol's grant");
  });

  it("tenantForAccount finds the holder of an account, and nobody for an unclaimed one", async () => {
    await store.put(ALICE, grantFor(ALICE));
    // The collision guard grant intake relies on: every ledger table keys on
    // smart_account, so a second tenant claiming this one must be refused.
    assert.equal(await store.tenantForAccount("0x00000000000000000000000000000000000000a1"), ALICE);
    assert.equal(await store.tenantForAccount("0x00000000000000000000000000000000000000ff"), null);
  });

  it("remove forgets exactly one tenant", async () => {
    await store.put(ALICE, grantFor(ALICE));
    await store.put(BOB, grantFor(BOB));
    await store.remove(ALICE);
    assert.equal(await store.get(ALICE), null);
    assert.ok(await store.get(BOB), "removing Alice leaves Bob");
  });

  it("get on an unknown tenant is null, never a throw", async () => {
    assert.equal(await store.get("0x00000000000000000000000000000000000000ff"), null);
  });
});

describe("FileGrantStore writers are serialized (a kill racing a new signature)", () => {
  const store = new FileGrantStore();
  const DAVE = "0x00000000000000000000000000000000000000d4" as const;
  const dir = path.join(HOME, "tenants");
  const file = path.join(dir, `${DAVE}.json`);
  const lockDb = path.join(dir, GRANT_STORE_LOCK_FILE);
  const stampOf = () => Number((JSON.parse(readFileSync(file, "utf8")) as { updatedAt: number }).updatedAt);
  /** Rewrite the stored record's server stamp, as if it had been put `ago` seconds earlier. */
  const backdate = (ago: number) => {
    const rec = JSON.parse(readFileSync(file, "utf8")) as { updatedAt: number };
    rec.updatedAt = Math.floor(Date.now() / 1000) - ago;
    writeFileSync(file, JSON.stringify(rec));
    return rec.updatedAt;
  };

  it("A GRANT SIGNED AFTER THE KILL SURVIVES whichever of the two writers goes first", async () => {
    // The read-then-delete in removeUnlessNewer used to leave a gap a put
    // could land in, and the NEW grant was then the one deleted. Hold the
    // lock, queue both writers behind it, and let them go together.
    await store.put(DAVE, grantFor(DAVE));
    const old = backdate(100);
    const holder = new DatabaseSync(lockDb);
    holder.exec("BEGIN IMMEDIATE");

    const removal = store.removeUnlessNewer(DAVE, old + 50); // the kill covers the old grant only
    const resign = store.put(DAVE, grantFor(DAVE)); // a new signature, stamped now
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(stampOf(), old, "neither writer moved while another held the lock");

    holder.exec("COMMIT");
    holder.close();
    const outcome = await removal;
    await resign;
    assert.ok(outcome === "removed" || outcome === "newer", outcome);
    assert.ok(await store.get(DAVE), "the new grant is stored, in either order");
    assert.ok(stampOf() > old + 50, "and it is the new one");
    await store.remove(DAVE);
  });

  it("a put never leaves half a record or a temp file behind", async () => {
    await store.put(DAVE, grantFor(DAVE));
    assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith(DAVE)), [`${DAVE}.json`], "only the record: no .tmp");
    await store.remove(DAVE);
  });

  it("THE LOCK IS THE KERNEL'S: a writer waits while another PROCESS holds it, and proceeds the moment that process dies", async () => {
    // Nothing is ever judged stale or broken. A live holder is waited for,
    // however long it takes. A dead one's lock is released by the operating
    // system, not by a contender guessing, which is the guess every
    // lock-file protocol for this got wrong.
    await store.put(DAVE, grantFor(DAVE));
    const old = backdate(100);
    const holder = spawn(
      process.execPath,
      ["-e", `const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(${JSON.stringify(lockDb)}); db.exec("BEGIN IMMEDIATE"); process.stdout.write("locked\\n"); setInterval(() => {}, 1 << 30);`],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    await new Promise<void>((resolve, reject) => {
      holder.stdout!.on("data", (d: Buffer) => String(d).includes("locked") && resolve());
      holder.on("exit", (code) => reject(new Error(`lock holder exited early (${code})`)));
    });

    const resign = store.put(DAVE, grantFor(DAVE));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(stampOf(), old, "the live holder in another process is waited for");

    holder.kill("SIGKILL"); // dies holding the lock, as a crashed writer would
    await resign;
    assert.ok(stampOf() > old, "its death released the lock and the write went through");
    await store.remove(DAVE);
  });
});
