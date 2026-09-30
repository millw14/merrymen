/** Durable, atomic challenge consumption shared by every authentication route. */
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isHostedMode } from "../../packages/core/src/hosted";
import { makePgDb, wrapSqlite, type Db } from "./db";
import { merrymenHome } from "./home";

export interface NonceStore {
  /** True only for the first successful claim. Storage failures must throw. */
  consume(nonce: string, expiresAt: number, now: number): Promise<boolean>;
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS auth_used_nonces (
  nonce_hash TEXT PRIMARY KEY,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_used_nonces_expiry ON auth_used_nonces (expires_at);`;

// Keep spent challenges beyond their five-minute lifetime so ordinary clock skew
// between web instances cannot reopen one during cleanup.
const RETENTION_MS = 10 * 60_000;

async function consumeInDb(db: Db, nonce: string, expiresAt: number, now: number): Promise<boolean> {
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return false;
  await db.prepare("DELETE FROM auth_used_nonces WHERE expires_at < ?").run(now - RETENTION_MS);
  const result = await db.prepare(
    `INSERT INTO auth_used_nonces (nonce_hash, expires_at) VALUES (?, ?)
     ON CONFLICT (nonce_hash) DO NOTHING`,
  ).run(createHash("sha256").update(nonce).digest("hex"), expiresAt);
  return result.changes === 1;
}

/** Shared SQL storage. The unique insert, not a preceding read, decides the winner. */
export class SqlNonceStore implements NonceStore {
  private ready: Promise<Db> | null = null;
  constructor(private connect: () => Promise<Db>, private dialect: "postgres" | "sqlite" = "postgres") {}

  private database(): Promise<Db> {
    if (!this.ready) {
      this.ready = this.connect().then(async (db) => {
        if (this.dialect === "postgres") {
          // Concurrent first boots must not race Postgres's catalog creation.
          // This lock is transaction-scoped and shared across web instances.
          await db.tx(async (tx) => {
            await tx.prepare("SELECT pg_advisory_xact_lock(?)").get(1_297_691_982);
            await tx.exec(SCHEMA);
          });
        } else {
          await db.exec(SCHEMA);
        }
        return db;
      }).catch((error) => {
        this.ready = null;
        throw error;
      });
    }
    return this.ready;
  }

  async consume(nonce: string, expiresAt: number, now: number): Promise<boolean> {
    return consumeInDb(await this.database(), nonce, expiresAt, now);
  }
}

/** Self-hosted processes share a small SQLite file; no legacy-home migration. */
export class LocalNonceStore implements NonceStore {
  constructor(private home: string) {}
  async consume(nonce: string, expiresAt: number, now: number): Promise<boolean> {
    mkdirSync(this.home, { recursive: true });
    const raw = new DatabaseSync(join(this.home, "auth-nonces.sqlite"));
    try {
      raw.exec("PRAGMA busy_timeout = 5000");
      raw.exec(SCHEMA);
      return await consumeInDb(wrapSqlite(raw), nonce, expiresAt, now);
    } finally {
      raw.close();
    }
  }
}

const postgresStores = new Map<string, NonceStore>();

export function getNonceStore(): NonceStore {
  const url = process.env.DATABASE_URL;
  if (url) {
    let store = postgresStores.get(url);
    if (!store) {
      store = new SqlNonceStore(() => makePgDb(url));
      postgresStores.set(url, store);
    }
    return store;
  }
  // An ephemeral or instance-local file cannot prevent hosted replays after a
  // redeploy or on another replica. Never fall back when shared storage is absent.
  if (isHostedMode()) throw new Error("hosted challenge verification requires DATABASE_URL");
  return new LocalNonceStore(merrymenHome());
}
