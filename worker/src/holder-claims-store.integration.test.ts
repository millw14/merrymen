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
import { after, describe, it } from "node:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-claims-"));
process.env.MERRYMEN_HOME = HOME;
process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 7).toString("base64");

const { FileSettingsStore, PgSettingsStore } = await import("./settings-store");
type Store = InstanceType<typeof FileSettingsStore> | InstanceType<typeof PgSettingsStore>;
type Client = { query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };

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

  it("AN UNREADABLE CLAIM IS NOT A FREE WALLET — reading, claiming and releasing all throw", async () => {
    process.env.MERRYMEN_HOME = path.join(HOME, "file-corrupt");
    const s = new FileSettingsStore();
    await s.claimHolder(W, A);
    writeFileSync(path.join(HOME, "file-corrupt", "holder-claims", `${W}.json`), "{ not json");
    await assert.rejects(s.holderClaims());
    await assert.rejects(s.holderClaims([W]));
    await assert.rejects(s.claimHolder(W, B), "B must be refused, not handed a wallet whose holder we cannot read");
    await assert.rejects(s.releaseHolder(W, A));
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
