/**
 * ONE $MERRYMEN WALLET POWERS ONE AGENT — the claims record, both backends.
 *
 * Settings are sealed per tenant, so nothing could answer "who else linked this
 * wallet?" and one 100,000-token bag could power any number of agents. The
 * claim is that answer. What must hold, in both backends:
 *
 *   FIRST CLAIM WINS, ATOMICALLY — N accounts racing for one wallet get one
 *   winner, and everyone else is told who holds it.
 *   ONLY THE HOLDER RELEASES — a release by anybody else changes nothing.
 *   AN UNREADABLE CLAIM IS NEVER "FREE" — it throws, and callers refuse.
 *
 * The file backend is proven against a real temp directory. The Postgres
 * backend has no live database in this repo's tests (pg is runtime-only), so it
 * runs its REAL SQL against sqlite behind the store's connection seam: the
 * primary key, ON CONFLICT DO NOTHING and RETURNING behave the same there. The
 * one Postgres-only hazard — a racing claim that conflicts but is invisible to
 * the same statement's snapshot — is scripted explicitly below.
 */
import assert from "node:assert/strict";
import { after, describe, it, mock } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-claims-"));
process.env.MERRYMEN_HOME = HOME;
process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 7).toString("base64");

const { FileSettingsStore, PgSettingsStore } = await import("./settings-store");
type Store = InstanceType<typeof FileSettingsStore> | InstanceType<typeof PgSettingsStore>;
type Client = { query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
/** The file store's wallet lock, private in the type only — driven directly where a race needs it. */
type Locker = { withClaimLock<T>(w: `0x${string}`, fn: () => Promise<T>): Promise<T> };
const lockOf = (s: InstanceType<typeof FileSettingsStore>) => s as unknown as Locker;

after(() => {
  try {
    rmSync(HOME, { recursive: true, force: true });
  } catch {
    /* disposable */
  }
});

const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000b2";
const W = "0x000000000000000000000000000000000000beef";
const W2 = "0x000000000000000000000000000000000000cafe";
const tenantN = (i: number) => `0x${(0xc00 + i).toString(16).padStart(40, "0")}`;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** sqlite standing in for Postgres: `$n` → `?n`, rows from anything that returns them. */
function sqliteClient(opts: { yieldFirst?: boolean; log?: string[] } = {}): Client {
  const db = new DatabaseSync(":memory:");
  return {
    async query(sql, params = []) {
      // Yield first, so concurrent callers genuinely interleave statement by
      // statement, the way a pool (or one client's queue) serves them.
      if (opts.yieldFirst) await new Promise((r) => setImmediate(r));
      opts.log?.push(sql.replace(/\s+/g, " ").trim());
      const stmt = db.prepare(sql.replace(/\$(\d+)/g, "?$1"));
      if (/^\s*SELECT|RETURNING/i.test(sql)) {
        return { rows: stmt.all(...(params as (string | number)[])) as Record<string, unknown>[] };
      }
      stmt.run(...(params as (string | number)[]));
      return { rows: [] };
    },
  };
}

function behavesAsAClaimsRecord(name: string, make: () => Store) {
  describe(`${name}: the holder claims`, () => {
    it("FIRST CLAIM WINS; the same account again is ok and not fresh; another account is told who holds it", async () => {
      const s = make();
      assert.deepEqual(await s.claimHolder(W, A), { ok: true, fresh: true });
      assert.deepEqual(await s.claimHolder(W, A), { ok: true, fresh: false }, "re-linking your own wallet is not a conflict");
      assert.deepEqual(await s.claimHolder(W, B), { ok: false, heldBy: A });
      assert.deepEqual([...(await s.holderClaims())], [[W, A]]);
    });

    it("case never decides it — wallet and account are compared lower-cased", async () => {
      const s = make();
      const upper = (x: string) => x.toUpperCase().replace("0X", "0x");
      assert.deepEqual(await s.claimHolder(upper(W), upper(A)), { ok: true, fresh: true });
      assert.deepEqual(await s.claimHolder(W, A), { ok: true, fresh: false });
      assert.deepEqual(await s.claimHolder(W, upper(B)), { ok: false, heldBy: A });
      assert.equal((await s.holderClaims([upper(W)])).get(W), A);
    });

    it("ONLY THE HOLDER RELEASES: another account's release changes nothing", async () => {
      const s = make();
      await s.claimHolder(W, A);
      await s.releaseHolder(W, B);
      assert.deepEqual(await s.claimHolder(W, B), { ok: false, heldBy: A }, "B cannot free A's wallet and take it");
      await s.releaseHolder(W, A);
      assert.equal((await s.holderClaims()).size, 0);
      assert.deepEqual(await s.claimHolder(W, B), { ok: true, fresh: true }, "released, it is free for the next account");
      await s.releaseHolder(W2, A); // nothing to release — not an error
    });

    it("THE WALLET'S OWN SIGNATURE MOVES ITS CLAIM: free → claimed, ours → held, another's → moved here", async () => {
      const s = make();
      const day = Date.UTC(2026, 8, 28);
      assert.deepEqual(await s.takeHolder(W, A, day + 10 * HOUR), { ok: true, fresh: true });
      assert.deepEqual(await s.takeHolder(W, A, day + 11 * HOUR), { ok: true, fresh: false });
      const moved = await s.takeHolder(W, B, day + 12 * HOUR);
      assert.deepEqual(moved, { ok: true, fresh: true, from: A, was: { tenant: A, claimedAt: day + 10 * HOUR, movedAt: null } });
      assert.equal((await s.holderClaims()).get(W), B, "the claim is B's now — A's proof counts nowhere");
      assert.deepEqual(await s.claimHolder(W, A), { ok: false, heldBy: B }, "first-claim-wins (the backfill's way) never moves it back");
    });

    it("ONE MOVE PER WALLET PER UTC DAY: a second answers when it can move, and the next day it can", async () => {
      const s = make();
      const day = Date.UTC(2026, 8, 28);
      const C = tenantN(99);
      await s.takeHolder(W, A, day + 1 * HOUR);
      assert.equal((await s.takeHolder(W, B, day + 2 * HOUR)).ok, true, "a first claim is not a move: one move is still left today");
      assert.deepEqual(await s.takeHolder(W, C, day + 23 * HOUR), { ok: false, movableAt: day + DAY });
      assert.deepEqual(await s.takeHolder(W, A, day + 23 * HOUR + 59 * MINUTE), { ok: false, movableAt: day + DAY }, "not even back");
      assert.equal((await s.holderClaims()).get(W), B, "a refused move changes nothing");
      const next = await s.takeHolder(W, C, day + DAY);
      assert.equal(next.ok && next.from, B, "a new UTC day, a new move");
      assert.deepEqual(await s.takeHolder(W, A, day + DAY + HOUR), { ok: false, movableAt: day + 2 * DAY });
    });

    it("A MOVE UNDONE IS PUT BACK EXACTLY — the claim, and the day's one move", async () => {
      const s = make();
      const day = Date.UTC(2026, 8, 28);
      await s.takeHolder(W, A, day + HOUR);
      const moved = await s.takeHolder(W, B, day + 2 * HOUR);
      assert.ok(moved.ok && moved.from);
      await s.undoTakeHolder(W, A, moved.was); // not A's to undo: nothing happens
      assert.equal((await s.holderClaims()).get(W), B);
      await s.undoTakeHolder(W, B, moved.was);
      assert.equal((await s.holderClaims()).get(W), A);
      const again = await s.takeHolder(W, B, day + 3 * HOUR);
      assert.equal(again.ok && again.from, A, "the undone move did not spend the day's move");
    });

    it("CONCURRENT MOVES OF ONE WALLET → AT MOST ONE LANDS; the rest are told when", async () => {
      const s = make();
      const day = Date.UTC(2026, 8, 28);
      await s.takeHolder(W, A, day + HOUR);
      const tenants = Array.from({ length: 8 }, (_, i) => tenantN(i));
      const out = await Promise.all(tenants.map((t) => s.takeHolder(W, t, day + 2 * HOUR)));
      const moved = out.flatMap((r, i) => (r.ok ? [tenants[i]!] : []));
      assert.equal(moved.length, 1, JSON.stringify(out));
      assert.ok(out.every((r) => r.ok || r.movableAt === day + DAY));
      assert.equal((await s.holderClaims()).get(W), moved[0]);
    });

    it("ONE CLAIM PER ACCOUNT: releaseHolderClaims frees every claim the account holds but `keep`, and nobody else's", async () => {
      const s = make();
      const W3 = "0x000000000000000000000000000000000000d00d";
      await s.claimHolder(W, A);
      await s.claimHolder(W2, A);
      await s.claimHolder(W3, B);
      await s.releaseHolderClaims(A, W2);
      assert.deepEqual(new Map(await s.holderClaims()), new Map([[W2, A], [W3, B]]), "kept W2, freed W, left B's alone");
      await s.releaseHolderClaims(A.toUpperCase().replace("0X", "0x"));
      assert.deepEqual(new Map(await s.holderClaims()), new Map([[W3, B]]), "no keep: every claim of A's, case aside");
      await s.releaseHolderClaims(A); // nothing left — not an error
      await assert.rejects(s.releaseHolderClaims("someone"));
    });

    it("holderClaims reads every claim, or only the wallets asked about", async () => {
      const s = make();
      await s.claimHolder(W, A);
      await s.claimHolder(W2, B);
      assert.deepEqual(new Map(await s.holderClaims()), new Map([[W, A], [W2, B]]));
      assert.deepEqual(new Map(await s.holderClaims([W2, A, "not-an-address"])), new Map([[W2, B]]));
      assert.equal((await s.holderClaims([])).size, 0);
    });

    it("CONCURRENT CLAIMS FOR ONE WALLET → EXACTLY ONE WINNER, and every loser names it", async () => {
      const s = make();
      const tenants = Array.from({ length: 12 }, (_, i) => tenantN(i));
      const out = await Promise.all(tenants.map((t) => s.claimHolder(W, t)));
      const winners = out.flatMap((r, i) => (r.ok ? [tenants[i]!] : []));
      assert.equal(winners.length, 1, JSON.stringify(out));
      assert.ok(out.every((r) => r.ok || r.heldBy === winners[0]), "every loser is told the one winner");
      assert.equal((await s.holderClaims()).get(W), winners[0]);
    });

    it("THE BACKFILL RECORD: none until written, then read back exactly, and replaced whole", async () => {
      const s = make();
      assert.equal(await s.holderBackfill(), null, "never ran");
      await s.saveHolderBackfill({ startedAt: 1_000, pending: [A, B] });
      assert.deepEqual(await s.holderBackfill(), { startedAt: 1_000, pending: [A, B] });
      await s.saveHolderBackfill({ startedAt: 1_000, pending: [] });
      assert.deepEqual(await s.holderBackfill(), { startedAt: 1_000, pending: [] });
      assert.equal((await s.holderClaims()).size, 0, "the record is not a claim");
      await assert.rejects(s.saveHolderBackfill({ startedAt: 1, pending: ["someone" as `0x${string}`] }), "only addresses are ever pending");
    });

    it("a claim is only ever an address", async () => {
      const s = make();
      await assert.rejects(s.claimHolder("0xnothex", A));
      await assert.rejects(s.claimHolder(W, "someone"));
      assert.equal((await s.holderClaims()).size, 0);
    });
  });
}

let fileRun = 0;
behavesAsAClaimsRecord("FileSettingsStore", () => {
  // A fresh home per case, so each case starts from no claims.
  process.env.MERRYMEN_HOME = path.join(HOME, `file-${++fileRun}`);
  return new FileSettingsStore();
});

behavesAsAClaimsRecord("PgSettingsStore (its SQL on sqlite)", () => {
  const client = sqliteClient({ yieldFirst: true });
  return new PgSettingsStore("postgres://stand-in", async () => client);
});

describe("FileSettingsStore specifics", () => {
  it("claims live beside the settings, never among them — a wallet is not listed as a tenant", async () => {
    process.env.MERRYMEN_HOME = path.join(HOME, "file-listing");
    const s = new FileSettingsStore();
    await s.put(A, { strategy: "trencher" });
    await s.claimHolder(W, A);
    assert.deepEqual(await s.listTenants(), [A]);
  });

  it("no temp file is left behind, won or lost", async () => {
    process.env.MERRYMEN_HOME = path.join(HOME, "file-temps");
    const s = new FileSettingsStore();
    await s.claimHolder(W, A);
    await s.claimHolder(W, B);
    assert.deepEqual(readdirSync(path.join(HOME, "file-temps", "holder-claims")), [`${W}.json`]);
  });

  it("…nor a lock or temp file after a move, a refused move, an undo or a release", async () => {
    process.env.MERRYMEN_HOME = path.join(HOME, "file-move-temps");
    const s = new FileSettingsStore();
    await s.takeHolder(W, A, 1);
    const moved = await s.takeHolder(W, B, 2);
    await s.takeHolder(W, A, 3);
    assert.ok(moved.ok && moved.from);
    await s.undoTakeHolder(W, B, moved.was);
    await s.releaseHolder(W, A);
    assert.deepEqual(readdirSync(path.join(HOME, "file-move-temps", "holder-claims")), []);
  });

  it("A LOCK LEFT BY A PROCESS THAT DIED HOLDING IT IS BROKEN, never waited on for ever", async () => {
    process.env.MERRYMEN_HOME = path.join(HOME, "file-stale-lock");
    const s = new FileSettingsStore();
    await s.takeHolder(W, A, 1);
    const lock = path.join(HOME, "file-stale-lock", "holder-claims", `.${W}.lock`);
    writeFileSync(lock, "4242");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    const moved = await s.takeHolder(W, B, 2);
    assert.equal(moved.ok && moved.from, A);
  });

  it("A STALE LOCK IS BROKEN BY ONE CONTENDER ONLY — a live lock that took its place in between is never removed", async () => {
    // Two contenders judge the same dead lock stale. The other one gets there
    // first: it breaks the dead lock and takes a fresh one. What this store
    // then removes — by whatever means — must not be that fresh lock, or both
    // are inside at once (two moves past one day's check).
    process.env.MERRYMEN_HOME = path.join(HOME, "file-stale-race");
    const s = new FileSettingsStore();
    await s.takeHolder(W, A, 1);
    const lock = path.join(HOME, "file-stale-race", "holder-claims", `.${W}.lock`);
    writeFileSync(lock, "4242");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    let raced = false;
    const otherContenderWins = () => {
      if (raced) return;
      raced = true;
      rmSync(lock);
      writeFileSync(lock, "the other contender");
    };
    const realUnlink = fsp.unlink;
    const realRename = fsp.rename;
    mock.method(fsp, "unlink", async (p: string) => {
      if (p === lock) otherContenderWins();
      return realUnlink(p);
    });
    mock.method(fsp, "rename", async (from: string, to: string) => {
      if (from === lock) otherContenderWins();
      return realRename(from, to);
    });
    syncBuiltinESMExports();
    try {
      let otherReleased = false;
      let enteredWhileOtherHeld: boolean | null = null;
      const inside = lockOf(s).withClaimLock(W as `0x${string}`, async () => {
        enteredWhileOtherHeld = !otherReleased;
      });
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(raced, true, "set-up: the race happened");
      assert.equal(readFileSync(lock, "utf8"), "the other contender", "the live lock is still there, still the other's");
      otherReleased = true;
      rmSync(lock);
      await inside;
      assert.equal(enteredWhileOtherHeld, false, "never inside while the other contender held the lock");
    } finally {
      mock.restoreAll();
      syncBuiltinESMExports();
    }
  });

  it("…and a holder's own release removes only its own lock", async () => {
    // A holder that outlived CLAIM_LOCK_STALE_MS has had its lock broken and
    // taken by another process: its finally must not delete that one.
    process.env.MERRYMEN_HOME = path.join(HOME, "file-own-release");
    const s = new FileSettingsStore();
    await s.takeHolder(W, A, 1);
    const lock = path.join(HOME, "file-own-release", "holder-claims", `.${W}.lock`);
    await lockOf(s).withClaimLock(W as `0x${string}`, async () => {
      rmSync(lock);
      writeFileSync(lock, "another holder");
    });
    assert.equal(readFileSync(lock, "utf8"), "another holder");
    assert.deepEqual(
      readdirSync(path.join(HOME, "file-own-release", "holder-claims")).sort(),
      [`.${W}.lock`, `${W}.json`],
      "nothing moved aside is left behind",
    );
  });

  it("…but a live one is waited on, and a release waits for the move holding it", async () => {
    process.env.MERRYMEN_HOME = path.join(HOME, "file-live-lock");
    const s = new FileSettingsStore();
    await s.takeHolder(W, A, 1);
    const lock = path.join(HOME, "file-live-lock", "holder-claims", `.${W}.lock`);
    writeFileSync(lock, "4242");
    let released = false;
    const release = s.releaseHolder(W, A).then(() => (released = true));
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(released, false, "the release is waiting on the lock");
    rmSync(lock);
    await release;
    assert.equal((await s.holderClaims()).size, 0);
  });

  it("AN UNREADABLE CLAIM IS NOT A FREE WALLET — reading, claiming and releasing all throw", async () => {
    process.env.MERRYMEN_HOME = path.join(HOME, "file-corrupt");
    const s = new FileSettingsStore();
    await s.claimHolder(W, A);
    writeFileSync(path.join(HOME, "file-corrupt", "holder-claims", `${W}.json`), "{ not json");
    await assert.rejects(s.holderClaims());
    await assert.rejects(s.holderClaims([W]));
    await assert.rejects(s.claimHolder(W, B), "B must be refused, not handed a wallet whose holder we cannot read");
    await assert.rejects(s.releaseHolder(W, A));
    await assert.rejects(s.releaseHolderClaims(A), "it might be A's: an unlink that cannot tell must not say done");
  });

  it("the backfill record lives beside the claims, not among them, and a torn one throws", async () => {
    process.env.MERRYMEN_HOME = path.join(HOME, "file-backfill");
    const s = new FileSettingsStore();
    await s.saveHolderBackfill({ startedAt: 5, pending: [] });
    assert.deepEqual(readdirSync(path.join(HOME, "file-backfill")).sort(), ["holder-claims-backfill.json"], "no temp file left behind");
    assert.equal((await s.holderClaims()).size, 0);
    writeFileSync(path.join(HOME, "file-backfill", "holder-claims-backfill.json"), "{ torn");
    await assert.rejects(s.holderBackfill(), "an unreadable record is not 'never ran'");
  });

  it("with no claims directory yet, there are simply no claims", async () => {
    process.env.MERRYMEN_HOME = path.join(HOME, "file-empty");
    assert.equal((await new FileSettingsStore().holderClaims()).size, 0);
  });
});

describe("PgSettingsStore specifics", () => {
  it("THE TABLE IS CREATED WITH THE STORE, keyed by wallet", async () => {
    const log: string[] = [];
    const s = new PgSettingsStore("postgres://stand-in", async () => sqliteClient({ log }));
    await s.holderClaims();
    assert.ok(
      log.some((q) => /^CREATE TABLE IF NOT EXISTS holder_claims \( wallet TEXT PRIMARY KEY, tenant TEXT NOT NULL, claimed_at BIGINT NOT NULL \)$/.test(q)),
      log.join("\n"),
    );
  });

  it("THE BACKFILL RECORD HAS ITS OWN TABLE, created with the store", async () => {
    const log: string[] = [];
    const s = new PgSettingsStore("postgres://stand-in", async () => sqliteClient({ log }));
    await s.holderBackfill();
    assert.ok(
      log.includes("CREATE TABLE IF NOT EXISTS holder_claims_meta ( key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at BIGINT NOT NULL )"),
      log.join("\n"),
    );
  });

  it("a record it cannot parse throws, never reads as 'never ran'", async () => {
    const client = sqliteClient();
    const s = new PgSettingsStore("postgres://stand-in", async () => client);
    await s.holderBackfill();
    await client.query(`INSERT INTO holder_claims_meta (key, value, updated_at) VALUES ('backfill', '{"startedAt":"soon"}', 1)`);
    await assert.rejects(s.holderBackfill(), /unreadable/);
  });

  it("A TABLE MADE BEFORE MOVES EXISTED GAINS moved_at — and a second opening finds it there and carries on", async () => {
    const log: string[] = [];
    const client = sqliteClient({ log });
    // The table as the first release created it: three columns, one claim.
    await client.query(`CREATE TABLE holder_claims (wallet TEXT PRIMARY KEY, tenant TEXT NOT NULL, claimed_at BIGINT NOT NULL)`);
    await client.query(`INSERT INTO holder_claims (wallet, tenant, claimed_at) VALUES ($1, $2, $3)`, [W, A, 5]);
    const first = new PgSettingsStore("postgres://stand-in", async () => client);
    const moved = await first.takeHolder(W, B, Date.UTC(2026, 8, 28));
    assert.deepEqual(moved, { ok: true, fresh: true, from: A, was: { tenant: A, claimedAt: 5, movedAt: null } });
    assert.ok(log.includes("ALTER TABLE holder_claims ADD COLUMN moved_at BIGINT"), log.join("\n"));
    // The other service (or the next start) opens the same database.
    const second = new PgSettingsStore("postgres://stand-in", async () => client);
    assert.deepEqual(await second.takeHolder(W, A, Date.UTC(2026, 8, 28) + HOUR), { ok: false, movableAt: Date.UTC(2026, 8, 29) });
  });

  it("…the duplicate column is Postgres's 42701 there; any other failure to add it is a failure", async () => {
    for (const [err, ok] of [
      [Object.assign(new Error('column "moved_at" of relation "holder_claims" already exists'), { code: "42701" }), true],
      [Object.assign(new Error("permission denied for table holder_claims"), { code: "42501" }), false],
    ] as const) {
      const real = sqliteClient();
      const client: Client = {
        async query(sql, params) {
          if (/^ALTER TABLE holder_claims ADD COLUMN moved_at/.test(sql)) {
            await real.query(sql, params);
            throw err;
          }
          return real.query(sql, params);
        },
      };
      const s = new PgSettingsStore("postgres://stand-in", async () => client);
      if (ok) assert.deepEqual(await s.takeHolder(W, A), { ok: true, fresh: true });
      else await assert.rejects(s.takeHolder(W, A), /permission denied/);
    }
  });

  it("THE MOVE IS ONE CONDITIONAL UPDATE on the holder it read and the day's allowance", async () => {
    const log: string[] = [];
    const s = new PgSettingsStore("postgres://stand-in", async () => sqliteClient({ log }));
    await s.takeHolder(W, A);
    await s.takeHolder(W, B);
    assert.ok(
      log.includes(
        "UPDATE holder_claims SET tenant = $2, claimed_at = $3, moved_at = $3 WHERE wallet = $1 AND tenant = $4 AND (moved_at IS NULL OR moved_at < $5) RETURNING tenant",
      ),
      log.join("\n"),
    );
  });

  it("A MOVE THAT LOSES ITS RACE LOOKS AGAIN — and finds the day's move already spent", async () => {
    // Between this call's SELECT and its UPDATE another account's move lands:
    // the UPDATE matches no row, and the second look answers 'when'.
    const real = sqliteClient();
    const day = Date.UTC(2026, 8, 28);
    let raced = false;
    const client: Client = {
      async query(sql, params) {
        if (/^\s*UPDATE holder_claims SET tenant = \$2/.test(sql) && !raced) {
          raced = true;
          await real.query(`UPDATE holder_claims SET tenant = $1, moved_at = $2 WHERE wallet = $3`, [tenantN(7), day + 2 * HOUR, W]);
        }
        return real.query(sql, params);
      },
    };
    const s = new PgSettingsStore("postgres://stand-in", async () => client);
    await s.takeHolder(W, A, day + HOUR);
    assert.deepEqual(await s.takeHolder(W, B, day + 3 * HOUR), { ok: false, movableAt: day + DAY });
    assert.equal((await s.holderClaims()).get(W), tenantN(7));
  });

  it("A RACING CLAIM THAT CONFLICTS BUT IS NOT YET VISIBLE, THEN RELEASED: asked again, and won fresh", async () => {
    // Postgres READ COMMITTED: the INSERT conflicts with a row committed after
    // the statement's snapshot, and the follow-up SELECT can find it already
    // released. The store must ask again, never answer from an empty read.
    const real = sqliteClient();
    let inserts = 0;
    const client: Client = {
      async query(sql, params) {
        if (/^\s*INSERT INTO holder_claims/.test(sql) && inserts++ === 0) return { rows: [] };
        return real.query(sql, params);
      },
    };
    const s = new PgSettingsStore("postgres://stand-in", async () => client);
    assert.deepEqual(await s.claimHolder(W, A), { ok: true, fresh: true });
    assert.equal(inserts, 2);
  });

  it("and a claim that keeps flickering is an error, never a guess", async () => {
    const real = sqliteClient();
    const client: Client = {
      async query(sql, params) {
        if (/^\s*INSERT INTO holder_claims/.test(sql)) return { rows: [] };
        return real.query(sql, params);
      },
    };
    const s = new PgSettingsStore("postgres://stand-in", async () => client);
    await assert.rejects(s.claimHolder(W, A), /kept changing/);
  });

  it("AN UNREACHABLE DATABASE THROWS — it is never read as 'nobody claims it'", async () => {
    const s = new PgSettingsStore("postgres://stand-in", async () => {
      throw new Error("connect ECONNREFUSED");
    });
    await assert.rejects(s.claimHolder(W, A));
    await assert.rejects(s.holderClaims());
    await assert.rejects(s.releaseHolder(W, A));
  });

  it("release is one conditional DELETE on wallet AND account", async () => {
    const log: string[] = [];
    const s = new PgSettingsStore("postgres://stand-in", async () => sqliteClient({ log }));
    await s.releaseHolder(W, A);
    assert.ok(log.includes("DELETE FROM holder_claims WHERE wallet = $1 AND tenant = $2"), log.join("\n"));
  });

  it("an account's claims go in ONE DELETE on the account", async () => {
    const log: string[] = [];
    const s = new PgSettingsStore("postgres://stand-in", async () => sqliteClient({ log }));
    await s.releaseHolderClaims(A, W);
    await s.releaseHolderClaims(A);
    assert.ok(log.includes("DELETE FROM holder_claims WHERE tenant = $1 AND wallet <> $2"), log.join("\n"));
    assert.ok(log.includes("DELETE FROM holder_claims WHERE tenant = $1"), log.join("\n"));
  });
});

describe("PgSettingsStore: two services creating the new table at once", () => {
  it("THE LOSER OF THE CATALOG RACE (23505 / 42P07) STILL OPENS THE STORE — it must not stay broken for the process", async () => {
    // Web and the orchestrator both open this store after the deploy that
    // adds holder_claims. A failed first init is cached for the life of the
    // process, so losing Postgres's IF NOT EXISTS race must not be a failure.
    for (const code of ["23505", "42P07"]) {
      const real = sqliteClient();
      const client: Client = {
        async query(sql, params) {
          if (/^\s*CREATE TABLE IF NOT EXISTS holder_claims/.test(sql)) {
            await real.query(sql, params); // the other service won: it exists
            throw Object.assign(new Error("duplicate key value violates unique constraint"), { code });
          }
          return real.query(sql, params);
        },
      };
      const s = new PgSettingsStore("postgres://stand-in", async () => client);
      assert.deepEqual(await s.claimHolder(W, A), { ok: true, fresh: true }, code);
    }
  });

  it("any other failure to create it is still a failure", async () => {
    const client: Client = {
      async query(sql) {
        if (/CREATE TABLE IF NOT EXISTS holder_claims/.test(sql)) {
          throw Object.assign(new Error("permission denied for schema public"), { code: "42501" });
        }
        return { rows: [] };
      },
    };
    const s = new PgSettingsStore("postgres://stand-in", async () => client);
    await assert.rejects(s.holderClaims(), /permission denied/);
  });
});
