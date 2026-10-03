/** Durable house budget: one maximum-cost reservation for each distinct final quote. */
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ENTRYPOINT, isHostedMode } from "@merrymen/core";
import { makePgDb, type Db } from "../../../worker/src/db";
import { merrymenHome } from "../../../worker/src/home";
import { OWNER_SPONSOR_MAX_COST } from "./owner-sponsorship";

export const OWNER_SPONSOR_DAILY_COST = 10_000_000_000_000_000n;
export const OWNER_SPONSOR_DAILY_QUOTES = Number(OWNER_SPONSOR_DAILY_COST / OWNER_SPONSOR_MAX_COST);

const SCHEMA = `CREATE TABLE IF NOT EXISTS owner_gas_days (
  owner TEXT NOT NULL, day TEXT NOT NULL, reserved_quotes INTEGER NOT NULL,
  PRIMARY KEY (owner, day)
);
CREATE TABLE IF NOT EXISTS owner_gas_quotes (
  owner TEXT NOT NULL, day TEXT NOT NULL, digest TEXT NOT NULL,
  PRIMARY KEY (owner, day, digest)
);`;
const ENSURE = "INSERT INTO owner_gas_days (owner, day, reserved_quotes) VALUES (?, ?, 0) ON CONFLICT (owner, day) DO NOTHING";
const LOCK = "UPDATE owner_gas_days SET reserved_quotes = reserved_quotes WHERE owner = ? AND day = ?";
const EXISTING = "SELECT digest FROM owner_gas_quotes WHERE owner = ? AND day = ? AND digest = ?";
const TAKE = "UPDATE owner_gas_days SET reserved_quotes = reserved_quotes + 1 WHERE owner = ? AND day = ? AND reserved_quotes < ?";
const RECORD = "INSERT INTO owner_gas_quotes (owner, day, digest) VALUES (?, ?, ?)";

/** Sponsor data/signature can change on retry; the operation being paid for cannot. */
export function ownerQuoteDigest(op: Record<string, unknown>, chainId: number): string {
  const bytes = (key: string) => String(op[key] ?? "0x").toLowerCase();
  const quantity = (key: string) => BigInt(op[key] as string ?? "0x0").toString();
  const intent = ["owner-quote-v1", chainId, ENTRYPOINT.v07.toLowerCase(),
    ...["sender", "factory", "factoryData", "callData"].map(bytes),
    ...["nonce", "callGasLimit", "verificationGasLimit", "preVerificationGas", "maxFeePerGas", "maxPriorityFeePerGas", "paymasterVerificationGasLimit", "paymasterPostOpGasLimit"].map(quantity),
  ];
  return createHash("sha256").update(JSON.stringify(intent)).digest("hex");
}

export interface OwnerSponsorshipStore {
  reserve(owner: string, digest: string, now?: number): Promise<boolean>;
}

function reservationKey(owner: string, digest: string, now: number): [string, string, string] {
  if (!/^0x[0-9a-f]{40}$/i.test(owner) || !/^[0-9a-f]{64}$/.test(digest) || !Number.isFinite(now)) throw new Error("invalid owner sponsorship reservation");
  return [owner.toLowerCase(), new Date(now).toISOString().slice(0, 10), digest];
}

export class SqlOwnerSponsorshipStore implements OwnerSponsorshipStore {
  private ready: Promise<Db> | null = null;
  constructor(private connect: () => Promise<Db>, private dialect: "postgres" | "sqlite" = "postgres") {}
  private database(): Promise<Db> {
    if (!this.ready) this.ready = this.connect().then(async (db) => {
      await db.tx(async (tx) => {
        if (this.dialect === "postgres") await tx.prepare("SELECT pg_advisory_xact_lock(?)").get(1_297_691_983);
        await tx.exec(SCHEMA);
      });
      return db;
    }).catch((error) => { this.ready = null; throw error; });
    return this.ready;
  }
  async reserve(owner: string, digest: string, now = Date.now()): Promise<boolean> {
    const [who, day, hash] = reservationKey(owner, digest, now);
    return (await this.database()).tx(async (tx) => {
      await tx.prepare(ENSURE).run(who, day);
      // Lock before checking the digest or remaining budget. Different web
      // instances cannot both authorize the last available quote.
      await tx.prepare(LOCK).run(who, day);
      if (await tx.prepare(EXISTING).get(who, day, hash)) return true;
      if ((await tx.prepare(TAKE).run(who, day, OWNER_SPONSOR_DAILY_QUOTES)).changes !== 1) return false;
      await tx.prepare(RECORD).run(who, day, hash);
      return true;
    });
  }
}

export class LocalOwnerSponsorshipStore implements OwnerSponsorshipStore {
  constructor(private home: string) {}
  async reserve(owner: string, digest: string, now = Date.now()): Promise<boolean> {
    const [who, day, hash] = reservationKey(owner, digest, now);
    mkdirSync(this.home, { recursive: true });
    const db = new DatabaseSync(join(this.home, "owner-gas.sqlite"));
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec(SCHEMA);
      // Keep this local transaction synchronous: another connection in the
      // same process must not block the event loop while this one awaits it.
      db.exec("BEGIN IMMEDIATE");
      db.prepare(ENSURE).run(who, day);
      if (db.prepare(EXISTING).get(who, day, hash)) { db.exec("COMMIT"); return true; }
      if (db.prepare(TAKE).run(who, day, OWNER_SPONSOR_DAILY_QUOTES).changes !== 1) { db.exec("COMMIT"); return false; }
      db.prepare(RECORD).run(who, day, hash);
      db.exec("COMMIT");
      return true;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* No transaction was opened. */ }
      throw error;
    } finally { db.close(); }
  }
}

const sharedStores = new Map<string, OwnerSponsorshipStore>();
export function getOwnerSponsorshipStore(): OwnerSponsorshipStore {
  const url = process.env.DATABASE_URL;
  if (url) {
    let store = sharedStores.get(url);
    if (!store) { store = new SqlOwnerSponsorshipStore(() => makePgDb(url)); sharedStores.set(url, store); }
    return store;
  }
  if (isHostedMode()) throw new Error("hosted owner sponsorship requires shared storage");
  return new LocalOwnerSponsorshipStore(merrymenHome());
}
