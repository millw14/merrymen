/**
 * The per-tenant grant store — where a hosted deploy keeps each tenant's signed
 * grant, durably and in isolation.
 *
 * Self-hosted keeps its single grant.json file and never touches this. Hosted
 * needs three things this provides: (1) MANY grants, one per tenant, not a
 * single slot; (2) DURABILITY across a redeploy — Railway's container
 * filesystem is ephemeral, and a lost grant strands a funded account; (3)
 * ENCRYPTION at rest of the session key. Web (the write side) and the
 * orchestrator (the read side) share this one module so they cannot disagree
 * about the shape.
 *
 * TENANT = the owner address, lowercased — the SIWE-authenticated wallet. A
 * grant is always stored under grant.owner, and callers pass the authenticated
 * tenant so the store can refuse a mismatch: the store is the last place the
 * "this grant belongs to this wallet" invariant can be enforced before bytes
 * hit disk.
 *
 * TWO WALLETS PER TENANT. A login's owner key holds a Spot wallet (Kernel index
 * 0, every account made before Perps) and a Perps wallet (index 1). Each has
 * its own grant here: Spot in `grants` and `<home>/tenants/`, exactly where
 * it always was, and Perps in `perps_grants` and `<home>/tenants-perps/`.
 * Nothing ever moves or rewrites a Spot row for Perps. getGrantStore takes the
 * wallet with no default, so every caller names the one it means; a default
 * of Spot is how the perps branch's kill, exits and profile reads came to
 * miss the Perps wallet.
 *
 * ONE OWNER, TWO SEPARATE AUTHORITIES, decided where both are written: a put
 * takes one lock for the tenant across both wallets and refuses a Perps grant
 * owned by a different key than the Spot one, an account address either
 * wallet (or another login) already holds, and a separate Perps wallet beside
 * a Spot grant that still carries a perpetuals permission of its own.
 *
 * TWO BACKENDS, selected by DATABASE_URL:
 *  - Postgres (hosted, multi-service): web and the orchestrator are separate
 *    Railway services that cannot share a volume, so the shared store is a
 *    network database. Selected when DATABASE_URL is set.
 *  - File (self-hosted, single-service, tests): one file per tenant under a
 *    directory, session key sealed when a DEK is present. The default.
 *
 * NODE-ONLY (node:crypto, node:fs, pg). Imported by web API routes (node
 * runtime) and the worker via the @merrymen/grant-store alias — never by the
 * browser bundle, which is why it lives here and not in core's browser barrel.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { merrymenHome } from "./home";
import { carriesOwnerKey, GRANT_PERP_LIGHTER, grantPurpose, isGrantPurpose } from "../../packages/core/src/index";
import { openSecret, requireDek, sealSecret, storeDek } from "./store-crypto";
import type { GrantPurpose, StoredGrant } from "../../packages/core/src/index";
import { privateKeyToAccount } from "viem/accounts";
import { writeFileAtomic } from "./atomic-write";
import { LEDGER_IMPORT_SCHEMA, LEDGER_IMPORT_GENERATIONS_SCHEMA } from "./ledger-import-schema";

/** Never evict old authority fences to make room for another permission. */
export const MAX_RETIRED_SESSION_KEYS = 256;

/** Where each wallet's grants live. Spot's are where they always were. */
const WALLET_TABLE = { spot: "grants", perps: "perps_grants" } as const satisfies Record<GrantPurpose, string>;
const WALLET_DIR = { spot: "tenants", perps: "tenants-perps" } as const satisfies Record<GrantPurpose, string>;
const otherWallet = (wallet: GrantPurpose): GrantPurpose => (wallet === "spot" ? "perps" : "spot");

/**
 * A grant the tenant's other wallet, or another login, rules out. Nothing was
 * written. `message` is written for the owner.
 */
export class GrantWalletConflict extends Error {
  constructor(
    readonly code: "account-claimed" | "account-shared" | "owner-differs" | "legacy-perps" | "perps-owner",
    message: string,
  ) {
    super(message);
    this.name = "GrantWalletConflict";
  }
}

const ACCOUNT_CLAIMED = "this agent account is already linked to a different login";

/**
 * THE TWO WALLETS ARE ONE OWNER'S, AND NEITHER IS THE OTHER. Checked against
 * the tenant's other wallet as stored, under the same lock as the write, so
 * two first setups racing each other cannot each pass against nothing.
 *
 *  - The same owner key: the login's recovery covers both wallets, and a
 *    second owner would be a second root nobody agreed to.
 *  - Different accounts: one address cannot be both wallets, or the Perps
 *    grant would be a second key on the Spot account.
 *  - No perpetuals left on Spot: a Spot grant that still carries the Lighter
 *    permission is legacy Perps authority, and has to be retired before a
 *    separate Perps wallet exists beside it.
 *
 * Exported for the one writer that is not a store: a self-hosted POST
 * /api/grants, which writes each wallet's grant.json in its own home and
 * holds the other wallet's file to these same three rules.
 *
 * No refusal here says "neither wallet was changed": a renewal or restore
 * POSTs its grant after its own stop, which a refusal does not undo, and a
 * hand-sent request can meet any of them there (self-hosted, nothing derives
 * a Spot grant's account, so one naming the Perps account meets
 * account-shared after its stop). Each says what this request did: this
 * permission was not saved, the other wallet was not changed. Owner-differs,
 * account-shared and legacy-perps reach the owner as written; the plain
 * Errors reach a hosted owner as the route's fixed 503 ("Your permission
 * could not be saved", grants/route.ts storeRefused), and a self-hosted one
 * as otherLocalWalletRefusal's own sentence. The Wallet screen's restore and
 * renewal ask the Perps owner first (restore-perps-owner.ts).
 */
export function assertIndependentWallets(
  incoming: StoredGrant,
  other: Pick<StoredGrant, "owner" | "smartAccount" | "purpose" | "perp" | "grantFeatures"> | null,
): void {
  if (!other) return;
  if (typeof other.owner !== "string" || typeof other.smartAccount !== "string") {
    throw new Error("Your other wallet's grant could not be read, so this one could not be checked against it and was not saved. Your other wallet was not changed.");
  }
  if (other.owner.toLowerCase() !== String(incoming.owner).toLowerCase()) {
    throw new GrantWalletConflict("owner-differs", "Both of a login's wallets must use the same owner key, so this permission was not saved. Your other wallet was not changed.");
  }
  if (other.smartAccount.toLowerCase() === incoming.smartAccount.toLowerCase()) {
    throw new GrantWalletConflict("account-shared", "Your Spot and Perps wallets must be different accounts, so this permission was not saved. Your other wallet was not changed.");
  }
  const spot = grantPurpose(incoming) === "spot" ? incoming : other;
  if (spot.perp !== undefined || spot.grantFeatures?.includes(GRANT_PERP_LIGHTER)) {
    throw new GrantWalletConflict(
      "legacy-perps",
      "Your Spot wallet still carries a perpetuals permission. Retire it before a separate Perps wallet can be made. This permission was not saved, and your other wallet was not changed.",
    );
  }
}

interface ReplacementStop {
  /** Hash of the actual signing key, never the client's claimed address. */
  sessionKeyHash: string;
  sessionKeyAddress: `0x${string}`;
  stoppedAt: number;
}

export type ReplacementStopResult = "stopped" | "absent" | "changed";

export class GrantReplacementConflict extends Error {
  constructor() {
    super("This permission cannot be armed: its session key was stopped, or permission replacement history is full. Nothing was changed; contact support if a fresh permission is rejected.");
    this.name = "GrantReplacementConflict";
  }
}

/** A grant safe to persist server-side: session-key-only, session key sealed. */
export interface StoredRecord {
  tenant: `0x${string}`;
  chainId: number;
  /** The grant, session key REMOVED (it lives sealed, separately). */
  grant: Omit<StoredGrant, "demoSessionPrivateKey" | "demoOwnerPrivateKey"> & {
    replacementStop?: ReplacementStop;
    retiredSessionKeyHashes?: string[];
  };
  /** The session key, AES-256-GCM sealed when a DEK is set, else plaintext. */
  sealedSessionKey: string;
  updatedAt: number;
}

export interface GrantStore {
  /** The wallet this store holds grants for. */
  readonly wallet: GrantPurpose;
  /** Persist (or replace) a tenant's grant. Throws on an owner key or a tenant mismatch. */
  put(tenant: `0x${string}`, grant: StoredGrant): Promise<void>;
  /** The tenant's grant, session key decrypted back in, or null. */
  get(tenant: `0x${string}`): Promise<StoredGrant | null>;
  /** Every tenant with a grant — for the orchestrator to lease and arm. */
  listTenants(): Promise<`0x${string}`[]>;
  /**
   * Public grant expiry for process scheduling; no session key is decrypted.
   * `updatedAt` is the record's server-stamped write time (unix seconds), or
   * null when it cannot be read: what the orchestrator's re-sign watch
   * (MERRYMEN_RESUME_AUTO_PAPER, ledger-resume.ts grantRowKey) tells one
   * signature of the row from the next by, beside the expiry.
   */
  listTenantExpiries?(): Promise<Array<{ tenant: `0x${string}`; purpose: GrantPurpose; expiresAt: number | null; updatedAt?: number | null }>>;
  /**
   * Which tenant already holds this smart account, in EITHER wallet, or null.
   *
   * The collision guard for grant intake: every ledger table keys on
   * smart_account, so two tenants sharing one account would write into a single
   * partition. Callers must treat a THROW as "refuse", never as "nobody holds
   * it" — an unreadable store must not be able to wave a collision through. Two
   * tenants claiming the one account throws too.
   */
  tenantForAccount(smartAccount: `0x${string}`): Promise<`0x${string}` | null>;
  /** Is there a record for this tenant, readable or not? Never false for an unreadable one. */
  hasStoredGrant(tenant: `0x${string}`): Promise<boolean>;
  /**
   * THE OWNER OF THE RECORD THIS STORE HOLDS for the tenant, shown or not (one
   * stopped for a renewal, which `get` hides), as the other wallet's put reads
   * it (assertIndependentWallets): null when there is none. THROWS when the
   * record cannot be read, names another wallet, or carries no owner or
   * account, where that put refuses: a record the put would refuse on is
   * never "stored" to a reader that asks before a stop
   * (grants/route.ts GET, restore-perps-owner.ts).
   */
  storedGrantOwner(tenant: `0x${string}`): Promise<string | null>;
  /** Forget a tenant's grant (the kill switch). */
  remove(tenant: `0x${string}`): Promise<void>;
  /** Remove signing capability, retaining the roster/home during permission replacement. */
  stopForReplacement(tenant: `0x${string}`, expectedAccount?: string, expectedSession?: string): Promise<ReplacementStopResult>;
  /**
   * Forget a tenant's grant IF it was stored at or before `atSec` (unix
   * seconds, compared with the record's server-stamped `updatedAt`).
   *
   * The kill switch for a kill that was asked for somewhere else — Telegram,
   * inside the tenant's child — and carried out later by the orchestrator. In
   * between, the owner may have signed a new grant on purpose, and that one
   * must survive. `grantedAt` cannot decide it: the browser stamps it, so a
   * skewed clock would pass an old grant off as new. `updatedAt` is stamped
   * here, on the server, at the moment of the put.
   *
   * One conditional DELETE, so a put racing the kill cannot be lost to a
   * read-then-delete. A tie counts as covered: the grant is removed.
   */
  removeUnlessNewer(tenant: `0x${string}`, atSec: number): Promise<"removed" | "absent" | "newer">;
  /**
   * A KILL'S REMOVAL: remove, or with `coveredSec` removeUnlessNewer, after a
   * READ-ONLY look that costs a tenant with nothing here no lock and no
   * schema. A Perps store never written to has no table and no directory, and
   * a kill for a Spot-only owner must not be the thing that makes them
   * (perps-kill.ts), nor wait behind their making.
   */
  revokeForKill(tenant: `0x${string}`, coveredSec?: number): Promise<"removed" | "absent" | "newer">;
}

/** Split a full grant into a persistable record, refusing anything with an owner key. */
function toRecord(tenant: `0x${string}`, grant: StoredGrant, wallet: GrantPurpose): StoredRecord {
  // A grant lands only in the wallet it names (grantPurpose: absent is Spot).
  if (grantPurpose(grant) !== wallet) {
    throw new Error(`this grant is for the ${grantPurpose(grant)} wallet, not the ${wallet} wallet`);
  }
  // A PERPS WALLET IS OWNED BY THE LOGIN'S OWN WALLET: the embedded wallet
  // (privy-did-owner-v1 binds owner = tenant) or an external one that signs
  // in and owns. Never a key generated in a browser, which is what any other
  // owner is: main stopped making those for real money, and a second wallet
  // must not bring them back.
  if (wallet === "perps" && String(grant.owner).toLowerCase() !== tenant.toLowerCase()) {
    throw new GrantWalletConflict(
      "perps-owner",
      "A Perps wallet must be owned by the wallet you sign in with, not a key made in the browser. Nothing was saved.",
    );
  }
  if (carriesOwnerKey(grant)) {
    throw new Error("refusing to store a grant that carries an owner key");
  }
  // NOTE: this deliberately no longer requires grant.owner === tenant. The owner
  // key is generated in the browser, so the two can never be equal; requiring it
  // rejected every hosted grant ever submitted. The tenant↔account link is
  // proved at intake instead, by two signatures over a server-issued nonce
  // (verifyGrantBinding in web/src/lib/auth.ts) — the wallet's, and the owner
  // key's co-signature proving the browser actually holds what it vouched for.
  // What survives here as defence in depth is the owner-key refusal above and
  // the fact that the record is keyed on the AUTHENTICATED tenant below, never
  // on anything the grant declares about itself.
  const { demoSessionPrivateKey, demoOwnerPrivateKey, replacementStop, retiredSessionKeyHashes, ...rest } = grant as StoredGrant & {
    demoOwnerPrivateKey?: string;
    replacementStop?: unknown;
    retiredSessionKeyHashes?: unknown;
  };
  if (replacementStop !== undefined || retiredSessionKeyHashes !== undefined) throw new Error("Permission replacement state is managed by the service, not the submitted grant.");
  void demoOwnerPrivateKey; // discarded; the guard above already refused a real one
  const dek = storeDek();
  const sealedSessionKey = dek ? sealSecret(demoSessionPrivateKey, dek) : demoSessionPrivateKey;
  return {
    tenant,
    chainId: grant.chainId,
    grant: rest,
    sealedSessionKey,
    updatedAt: Math.floor(Date.now() / 1000),
  };
}

/** Reassemble a full grant, decrypting the session key back in. */
function fromRecord(rec: StoredRecord, wallet: GrantPurpose): StoredGrant | null {
  // A record of the other wallet is never handed out as this one's.
  if (grantPurpose(rec.grant) !== wallet) throw new Error(`a stored grant names the ${grantPurpose(rec.grant)} wallet, in the ${wallet} wallet's store`);
  if (rec.grant.replacementStop !== undefined) return null;
  const dek = storeDek();
  const sessionKey = dek ? openSecret(rec.sealedSessionKey, dek) : rec.sealedSessionKey;
  const { replacementStop, retiredSessionKeyHashes, ...grant } = rec.grant;
  void replacementStop; void retiredSessionKeyHashes;
  return { ...grant, demoSessionPrivateKey: sessionKey as `0x${string}` } as StoredGrant;
}

function sessionKeyHash(key: string): string {
  if (typeof key !== "string" || !/^0x[0-9a-f]{64}$/i.test(key)) {
    throw new Error("The permission's session key cannot be verified. Nothing was replaced.");
  }
  return createHash("sha256").update(Buffer.from(key.slice(2), "hex")).digest("hex");
}

function retiredSessionKeys(grant: StoredRecord["grant"]): string[] {
  const keys = grant.retiredSessionKeyHashes ?? [];
  if (!Array.isArray(keys) || keys.length > MAX_RETIRED_SESSION_KEYS || keys.some(key => typeof key !== "string" || !/^[0-9a-f]{64}$/.test(key))) {
    throw new Error("The permission replacement history could not be verified. Nothing was replaced.");
  }
  const retired = [...new Set(keys)];
  if (grant.replacementStop) {
    const key = grant.replacementStop.sessionKeyHash;
    if (typeof key !== "string" || !/^[0-9a-f]{64}$/.test(key)) throw new Error("The stopped permission could not be verified. Nothing was replaced.");
    if (!retired.includes(key)) retired.push(key);
  }
  // At capacity, the current key can still be stopped in replacementStop
  // without evicting any historical hash. A fresh put must retain room for
  // its own eventual stop and refuses when this effective history is full.
  if (retired.length > MAX_RETIRED_SESSION_KEYS + 1) throw new Error("Permission replacement history is full. Nothing was replaced; contact support.");
  return retired;
}

/** A stop does not authorize a new grant: keep updatedAt for pending /kill requests. */
function replacementRecord(rec: StoredRecord, expectedAccount?: string, expectedSession?: string): StoredRecord | null {
  if (expectedAccount !== undefined && rec.grant.smartAccount.toLowerCase() !== expectedAccount.toLowerCase()) return null;
  let stop = rec.grant.replacementStop;
  if (!stop) {
    const dek = storeDek();
    const key = dek ? openSecret(rec.sealedSessionKey, dek) : rec.sealedSessionKey;
    stop = {
      sessionKeyHash: sessionKeyHash(key),
      sessionKeyAddress: privateKeyToAccount(key as `0x${string}`).address,
      stoppedAt: Math.floor(Date.now() / 1000),
    };
  }
  if (expectedSession !== undefined && stop.sessionKeyAddress.toLowerCase() !== expectedSession.toLowerCase()) return null;
  retiredSessionKeys(rec.grant); // Validate every existing historical fence.
  const retired = [...new Set(rec.grant.retiredSessionKeyHashes ?? [])];
  if (!retired.includes(stop.sessionKeyHash) && retired.length < MAX_RETIRED_SESSION_KEYS) {
    retired.push(stop.sessionKeyHash);
  }
  // A full array stays intact; replacementStop separately fences the current
  // key. No later put may clear that marker at full effective capacity.
  return {
    ...rec,
    grant: { ...rec.grant, expiresAt: 0, serialized: "", replacementStop: stop, retiredSessionKeyHashes: retired },
    // ZeroDev's serialized account embeds another copy of the session key.
    // Both copies must disappear before reporting a durable replacement stop.
    sealedSessionKey: "",
  };
}

// ── file backend ─────────────────────────────────────────────────────────────

/** How long a writer waits for another writer, in any process, before giving up. */
const LOCK_WAIT_MS = 5_000;

/** The file whose SQLite write lock serializes this store's writers. */
export const GRANT_STORE_LOCK_FILE = ".writers.lock.db";

/** SQLITE_BUSY / SQLITE_LOCKED: another connection holds the write lock. */
function lockBusy(e: unknown): boolean {
  const code = (e as { errcode?: number }).errcode;
  return code === 5 || code === 6 || /database is (locked|busy)/i.test(String((e as Error)?.message ?? e));
}

/** A record as written, or null when there is none. Anything unreadable throws. */
async function readRecord(file: string): Promise<StoredRecord | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as StoredRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * One JSON record per tenant under <home>/tenants/ (Spot) or
 * <home>/tenants-perps/ (Perps). Used self-hosted, in tests, and for a
 * single-service hosted deploy on a persistent volume. The session key is
 * sealed on disk when a DEK is present — verified by test: the file must not
 * contain the plaintext key.
 */
export class FileGrantStore implements GrantStore {
  private readonly dir: string;
  constructor(readonly wallet: GrantPurpose) {
    if (!isGrantPurpose(wallet)) throw new Error("Unrecognised wallet purpose");
    this.dir = path.join(merrymenHome(), WALLET_DIR[wallet]);
  }
  private file(tenant: string, wallet: GrantPurpose = this.wallet) {
    return path.join(wallet === this.wallet ? this.dir : path.join(merrymenHome(), WALLET_DIR[wallet]), `${tenant.toLowerCase()}.json`);
  }
  /**
   * ONE WRITER AT A TIME, ACROSS PROCESSES — AND ACROSS BOTH WALLETS.
   *
   * removeUnlessNewer reads a record's stamp and then deletes it. Without
   * this, a put from another process (the web's grant intake beside the
   * orchestrator) could land between the two, and a grant signed after the
   * kill would be the one deleted. Readers take no lock: a put renames a
   * finished record into place, so a reader sees the old record or the new
   * one, never half of one.
   *
   * Both wallets take the SAME lock, the one in the Spot directory where it
   * always was: a put checks the tenant's other wallet and every account claim
   * before it writes, and that check is only worth anything if no write to
   * either wallet can land in between.
   *
   * THE LOCK IS THE OPERATING SYSTEM'S. It is SQLite's write lock on
   * GRANT_STORE_LOCK_FILE, taken by BEGIN IMMEDIATE (fcntl on POSIX,
   * LockFileEx on Windows). The kernel holds it and releases it when the
   * holding process exits, however it exits. So a lock is never stale, and
   * nothing ever has to break one. That is what the lock-file versions of
   * this kept getting wrong: every protocol for breaking a dead holder's lock
   * left a window where a live holder's lock went missing.
   *
   * A connection per call, closed after it: no handle stays open between
   * writes. Callers in the same process contend through SQLite exactly as
   * other processes do. The wait is a retry loop, not SQLite's busy timeout,
   * so a contended lock never blocks the event loop.
   */
  private async locked<T>(tenant: string, fn: () => Promise<T>): Promise<T> {
    const lockDir = path.join(merrymenHome(), WALLET_DIR.spot);
    await mkdir(lockDir, { recursive: true });
    const db = new DatabaseSync(path.join(lockDir, GRANT_STORE_LOCK_FILE));
    try {
      const giveUpAt = Date.now() + LOCK_WAIT_MS;
      for (;;) {
        try {
          db.exec("BEGIN IMMEDIATE");
          break;
        } catch (e) {
          if (!lockBusy(e)) throw e;
          if (Date.now() > giveUpAt) throw new Error(`grant store busy for ${tenant}: another writer holds the lock`);
          await new Promise((r) => setTimeout(r, 20));
        }
      }
      try {
        const out = await fn();
        db.exec("COMMIT");
        return out;
      } catch (e) {
        try {
          db.exec("ROLLBACK");
        } catch {
          /* nothing to roll back */
        }
        throw e;
      }
    } finally {
      db.close();
    }
  }
  async put(tenant: `0x${string}`, grant: StoredGrant): Promise<void> {
    await this.locked(tenant, async () => {
      const prior = await readRecord(this.file(tenant));
      const retired = prior ? retiredSessionKeys(prior.grant) : [];
      if (retired.length >= MAX_RETIRED_SESSION_KEYS || retired.includes(sessionKeyHash(grant.demoSessionPrivateKey))) {
        throw new GrantReplacementConflict();
      }
      // Stamped inside the lock, so `updatedAt` is when the record landed.
      const rec = toRecord(tenant, grant, this.wallet);
      if (retired.length > 0) rec.grant.retiredSessionKeyHashes = retired;
      // The tenant's other wallet and every account claim, read under the same
      // lock as the write below. An unreadable record anywhere refuses.
      const other = await readRecord(this.file(tenant, otherWallet(this.wallet)));
      if (other && grantPurpose(other.grant) !== otherWallet(this.wallet)) {
        throw new Error("Your other wallet's grant could not be verified, so this permission was not saved.");
      }
      assertIndependentWallets(grant, other?.grant ?? null);
      for (const holder of await this.holdersOf(grant.smartAccount)) {
        if (holder !== tenant.toLowerCase()) throw new GrantWalletConflict("account-claimed", ACCOUNT_CLAIMED);
      }
      await mkdir(this.dir, { recursive: true });
      await writeFileAtomic(this.file(tenant), JSON.stringify(rec, null, 2), 0o600, { durable: true });
    });
  }
  async get(tenant: `0x${string}`): Promise<StoredGrant | null> {
    try {
      const rec = JSON.parse(await readFile(this.file(tenant), "utf8")) as StoredRecord;
      return fromRecord(rec, this.wallet);
    } catch {
      return null;
    }
  }
  async hasStoredGrant(tenant: `0x${string}`): Promise<boolean> {
    try {
      await stat(this.file(tenant));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  async storedGrantOwner(tenant: `0x${string}`): Promise<string | null> {
    const rec = await readRecord(this.file(tenant));
    if (!rec) return null;
    return verifiedOwner(rec.grant, this.wallet);
  }
  async listTenants(): Promise<`0x${string}`[]> {
    return this.tenantsIn(this.dir);
  }
  private async tenantsIn(dir: string): Promise<`0x${string}`[]> {
    try {
      const files = await readdir(dir);
      return files.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5) as `0x${string}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      // Cleanup callers must not turn an unreadable roster into proof of deletion.
      throw error;
    }
  }
  async listTenantExpiries(): Promise<Array<{ tenant: `0x${string}`; purpose: GrantPurpose; expiresAt: number | null; updatedAt: number | null }>> {
    const tenants = await this.listTenants();
    const purpose = this.wallet;
    return Promise.all(tenants.map(async (tenant) => {
      try {
        const rec = JSON.parse(await readFile(this.file(tenant), "utf8")) as StoredRecord;
        const expiry = rec.grant.expiresAt;
        return { tenant, purpose, expiresAt: typeof expiry === "number" && Number.isFinite(expiry) ? expiry : null,
          updatedAt: typeof rec.updatedAt === "number" && Number.isFinite(rec.updatedAt) ? rec.updatedAt : null };
      } catch {
        // An unreadable grant must not be treated as armed. Leave its row in
        // the roster so existing cleanup and repair paths can still find it.
        return { tenant, purpose, expiresAt: null, updatedAt: null };
      }
    }));
  }
  async remove(tenant: `0x${string}`): Promise<void> {
    await this.locked(tenant, () => rm(this.file(tenant), { force: true }));
  }
  async stopForReplacement(tenant: `0x${string}`, expectedAccount?: string, expectedSession?: string): Promise<ReplacementStopResult> {
    return this.locked(tenant, async () => {
      let rec: StoredRecord;
      try { rec = JSON.parse(await readFile(this.file(tenant), "utf8")) as StoredRecord; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
        throw error;
      }
      const stopped = replacementRecord(rec, expectedAccount, expectedSession);
      if (!stopped) return "changed";
      await writeFileAtomic(this.file(tenant), JSON.stringify(stopped, null, 2), 0o600, { durable: true });
      return "stopped";
    });
  }
  async removeUnlessNewer(tenant: `0x${string}`, atSec: number): Promise<"removed" | "absent" | "newer"> {
    // The read and the delete under one lock (see `locked`), so no put lands
    // between them.
    return this.locked(tenant, async () => {
      let raw: string;
      try {
        raw = await readFile(this.file(tenant), "utf8");
      } catch (e) {
        // Only a missing file is "absent". Any other read failure is not an
        // answer, and the caller must not treat it as a completed kill.
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return "absent";
        throw e;
      }
      let updatedAt = Number.NaN;
      try {
        updatedAt = Number((JSON.parse(raw) as StoredRecord).updatedAt);
      } catch {
        /* an unreadable record cannot prove it is newer — it is removed below */
      }
      if (updatedAt > atSec) return "newer";
      await rm(this.file(tenant), { force: true });
      return "removed";
    });
  }
  async revokeForKill(tenant: `0x${string}`, coveredSec?: number): Promise<"removed" | "absent" | "newer"> {
    // No record, no lock: a wallet never set up here costs the kill nothing,
    // and its directory is never made.
    if (!(await this.hasStoredGrant(tenant))) return "absent";
    if (coveredSec !== undefined) return this.removeUnlessNewer(tenant, coveredSec);
    return this.locked(tenant, async () => {
      try {
        await rm(this.file(tenant));
        return "removed";
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return "absent";
        throw e;
      }
    });
  }
  async tenantForAccount(smartAccount: `0x${string}`): Promise<`0x${string}` | null> {
    const holders = await this.holdersOf(smartAccount);
    if (holders.length > 1) throw new Error("this smart account is claimed by more than one login");
    return holders[0] ?? null;
  }
  /**
   * Every tenant holding this account, in either wallet. A scan, deliberately:
   * the file backend is the single-service/self-hosted path where the tenant
   * count is small, and an index would be another thing to keep in step with
   * the files themselves. A read that throws propagates — the caller must
   * refuse rather than assume the account is unclaimed.
   */
  private async holdersOf(smartAccount: `0x${string}`): Promise<`0x${string}`[]> {
    const want = smartAccount.toLowerCase();
    const holders = new Set<`0x${string}`>();
    for (const wallet of ["spot", "perps"] as const) {
      for (const tenant of await this.tenantsIn(path.join(merrymenHome(), WALLET_DIR[wallet]))) {
        const rec = JSON.parse(await readFile(this.file(tenant, wallet), "utf8")) as StoredRecord;
        if (rec.grant?.smartAccount?.toLowerCase() === want) holders.add(tenant.toLowerCase() as `0x${string}`);
      }
    }
    return [...holders];
  }
}

// ── postgres backend ─────────────────────────────────────────────────────────

/** The slice of a pg client this store uses. Kept minimal so `pg` is a runtime-only dep. */
interface PgClientLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end?(): Promise<void>;
  on?(event: "error" | "end", cb: () => void): void;
}

/** Opens a grant-store connection. A test can supply a stand-in for a refused connection. */
export type PgGrantConnect = (url: string) => Promise<PgClientLike>;

async function connectPgGrant(url: string): Promise<PgClientLike> {
  // @ts-expect-error pg has no types here (runtime-only); webpackIgnore stops the bundler resolving it
  const pg = (await import(/* webpackIgnore: true */ "pg")) as unknown as {
    Client: new (c: { connectionString: string }) => PgClientLike & { connect(): Promise<void> };
  };
  const c = new pg.Client({ connectionString: url });
  try {
    await c.connect();
    return c;
  } catch (e) {
    await Promise.resolve().then(() => c.end?.()).catch(() => {});
    throw e;
  }
}

/** The columns every wallet's grants table has: `grants`' own, unchanged. */
const walletTableDdl = (table: string) =>
  `CREATE TABLE IF NOT EXISTS ${table} (
               tenant TEXT PRIMARY KEY,
               chain_id INTEGER NOT NULL,
               grant_json JSONB NOT NULL,
               sealed_session_key TEXT NOT NULL,
               updated_at BIGINT NOT NULL
             )`;

/** Does this table exist, by a catalog read that takes no lock and writes nothing? */
async function tableExists(c: PgClientLike, table: string): Promise<boolean> {
  const { rows } = await c.query(`SELECT to_regclass($1) IS NOT NULL AS found`, [table]);
  return rows[0]?.found === true;
}

/**
 * CREATE TABLE IF NOT EXISTS from two services at once: the loser of a first
 * creation can see a duplicate catalog row (23505) or a duplicate table
 * (42P07), which is the answer it wanted.
 */
async function createIfAbsent(c: PgClientLike, ddl: string): Promise<void> {
  try {
    await c.query(ddl);
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    if (code === "23505" || code === "42P07") return;
    throw e;
  }
}

/**
 * The advisory locks a put takes, in this order: the tenant (both its wallets),
 * then the account. Each in a namespace of its own, so a tenant lock can never
 * be an account lock, and every put takes them in the same order.
 */
const OWNER_LOCK_NS = 0x4d4d474f;
const ACCOUNT_LOCK_NS = 0x4d4d4741;

const parseGrantJson = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v) as StoredRecord["grant"];

/** A stored record's owner, as the other wallet's put would compare it; throws where that put refuses. */
function verifiedOwner(grant: StoredRecord["grant"] | null, wallet: GrantPurpose): string {
  if (!grant || grantPurpose(grant as StoredGrant) !== wallet || typeof grant.owner !== "string" || typeof grant.smartAccount !== "string") {
    throw new Error("This wallet's stored grant could not be verified.");
  }
  return grant.owner;
}

/**
 * Postgres backend for the multi-service hosted deploy, where web and the
 * orchestrator are separate Railway services sharing a network database.
 *
 * `pg` is imported at RUNTIME only (dynamic import), so it is not a compile-time
 * dependency and the file backend needs it neither installed nor typed. The DEK
 * is REQUIRED here — a hosted server storing session keys in the clear is
 * exactly what encryption-at-rest exists to prevent — so the constructor path
 * asserts it.
 *
 * ONE TABLE PER WALLET. Spot's `grants` is made, as it always was, when the
 * store first connects. Perps' `perps_grants` is made by the first Perps put
 * and by nothing else: until then every read answers empty and every kill
 * finds nothing, by a catalog read, so a fleet that never had a Perps wallet
 * never gains a table, a lock or a write from this code.
 *
 * INTEGRATION-TEST GATE: the SQL below is typechecked but not exercised in this
 * repo's test run (no live Postgres). Per docs/hosted-platform-plan.md it must
 * pass a live-Postgres round-trip before any deploy that funds a real account.
 */
export class PgGrantStore implements GrantStore {
  private ready: Promise<PgClientLike> | null = null;
  private readonly table: (typeof WALLET_TABLE)[GrantPurpose];
  /** Is this wallet's table known to exist? Tables are never dropped, so yes is final. */
  private present: boolean;
  /**
   * `reads`: the connection this store's single statements go on, when another
   * store's is shared. getGrantStore gives the Perps store the Spot store's, so a
   * Spot-only owner's kill needs no connection of its own for its Perps half and
   * cannot fail on one: that half then fails only where the Spot half would. The
   * shared connection is never given a BEGIN (transaction, below).
   */
  constructor(
    private url: string,
    readonly wallet: GrantPurpose,
    private connect: PgGrantConnect = connectPgGrant,
    private reads?: () => Promise<PgClientLike>,
  ) {
    if (!isGrantPurpose(wallet)) throw new Error("Unrecognised wallet purpose");
    this.table = WALLET_TABLE[wallet];
    this.present = wallet === "spot";
    requireDek(); // fail fast: hosted Postgres without a DEK is a plaintext-at-rest bug
  }
  /** This store's statement connection, for another store to share (getGrantStore). */
  sharedConnection(): Promise<PgClientLike> {
    return this.client();
  }
  private async client(): Promise<PgClientLike> {
    if (this.reads) return this.reads();
    if (!this.ready) {
      const started = (this.ready = (async () => {
        const c = await this.connect(this.url);
        let alive = true;
        const lost = () => {
          alive = false;
          if (this.ready === started) this.ready = null;
        };
        // A once-healthy connection can also end after a database restart.
        // Make the next request reconnect; the request that lost it still fails.
        c.on?.("error", () => {
          lost();
          void Promise.resolve().then(() => c.end?.()).catch(() => {});
        });
        c.on?.("end", lost);
        try {
          // SPOT'S SCHEMA, as it always was. A Perps store's connection writes
          // no schema at all: its table is made by its first put (transaction).
          if (this.wallet === "spot") {
            await c.query(walletTableDdl("grants"));
            // Explicit deletion must fence an already staged original-book
            // transfer in the same statement as removing its grant. Set up the
            // nonpayload tombstones before any request can take that path.
            await c.query(LEDGER_IMPORT_SCHEMA);
            await c.query(LEDGER_IMPORT_GENERATIONS_SCHEMA);
          }
          if (!alive) throw new Error("grant store connection ended during setup");
        } catch (e) {
          // A failed CREATE must not leave a connection open on every retry.
          await Promise.resolve().then(() => c.end?.()).catch(() => {});
          throw e;
        }
        return c;
      })());
      // A refused first connection is not the answer for every subsequent
      // account read (or orchestrator reconcile) for the process's lifetime.
      // The next independent call retries; no failed financial write is replayed.
      started.catch(() => {
        if (this.ready === started) this.ready = null;
      });
    }
    return this.ready;
  }
  /** The connection, or null when this wallet's table has never been made (nothing is stored). */
  private async existing(): Promise<PgClientLike | null> {
    const c = await this.client();
    if (!this.present) this.present = await tableExists(c, this.table);
    return this.present ? c : null;
  }
  /**
   * ONE WRITE, ON A CONNECTION OF ITS OWN, AS ONE TRANSACTION.
   *
   * The shared connection is never given a BEGIN: anything else this process
   * sent on it meanwhile — a kill's DELETE, say — would run inside that
   * transaction and be rolled back with it. So a put opens its own, and
   * closes it. A put is an owner signing; one connection for it is nothing.
   */
  private async transaction<T>(fn: (c: PgClientLike) => Promise<T>): Promise<T> {
    const c = await this.connect(this.url);
    // The statements below fail on a dropped connection; its event must not end the process.
    c.on?.("error", () => {});
    try {
      if (this.wallet !== "spot") {
        await createIfAbsent(c, walletTableDdl(this.table));
        this.present = true;
      }
      await c.query("BEGIN");
      try {
        // A lock held elsewhere (another put for this tenant or account) is
        // waited for, but not for ever: the put fails, nothing is written, and
        // the owner signs again.
        await c.query("SET LOCAL lock_timeout = '10s'");
        const out = await fn(c);
        await c.query("COMMIT");
        return out;
      } catch (e) {
        await c.query("ROLLBACK").catch(() => {});
        throw e;
      }
    } finally {
      await Promise.resolve().then(() => c.end?.()).catch(() => {});
    }
  }
  /**
   * CROSS-WALLET RULES AND ACCOUNT CLAIMS, IN THE WRITE'S OWN TRANSACTION.
   *
   * The tenant lock serializes the tenant's two wallets, and the account lock
   * every login's claim on this address, so what is checked here is still
   * true when the row lands. (The route's tenantForAccount answers sooner and
   * friendlier, but outside any transaction: two logins racing past it each
   * found the account free.) The upsert itself is main's, unchanged: the
   * stopped-key and history fences decide in the same statement as the write.
   */
  async put(tenant: `0x${string}`, grant: StoredGrant): Promise<void> {
    const rec = toRecord(tenant, grant, this.wallet);
    const keyHash = sessionKeyHash(grant.demoSessionPrivateKey);
    const account = grant.smartAccount.toLowerCase();
    // Spot's tables (made by its shared connection) exist before the transaction
    // below writes them; Perps makes its own table in that transaction.
    if (this.wallet === "spot") await this.client();
    const t = this.table;
    const other = WALLET_TABLE[otherWallet(this.wallet)];
    await this.transaction(async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock($1::int, hashtext($2))`, [OWNER_LOCK_NS, tenant.toLowerCase()]);
      await c.query(`SELECT pg_advisory_xact_lock($1::int, hashtext($2))`, [ACCOUNT_LOCK_NS, account]);
      const otherHere = await tableExists(c, other);
      if (otherHere) {
        const { rows } = await c.query(`SELECT grant_json FROM ${other} WHERE tenant = $1`, [tenant.toLowerCase()]);
        const theirs = rows[0] ? parseGrantJson(rows[0].grant_json) : null;
        if (theirs && grantPurpose(theirs) !== otherWallet(this.wallet)) {
          throw new Error("Your other wallet's grant could not be verified, so this permission was not saved.");
        }
        assertIndependentWallets(grant, theirs);
      }
      for (const table of otherHere ? [t, other] : [t]) {
        const { rows } = await c.query(
          `SELECT tenant FROM ${table} WHERE lower(grant_json->>'smartAccount') = $1 AND lower(tenant) <> $2 LIMIT 1`,
          [account, tenant.toLowerCase()],
        );
        if (rows.length > 0) throw new GrantWalletConflict("account-claimed", ACCOUNT_CLAIMED);
      }
      const { rows } = await c.query(
        `INSERT INTO ${t} (tenant, chain_id, grant_json, sealed_session_key, updated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant) DO UPDATE SET
         chain_id = EXCLUDED.chain_id,
         grant_json = jsonb_set(EXCLUDED.grant_json, '{retiredSessionKeyHashes}',
           CASE WHEN ${t}.grant_json->'replacementStop'->>'sessionKeyHash' IS NOT NULL
                     AND NOT COALESCE(${t}.grant_json->'retiredSessionKeyHashes' ? (${t}.grant_json->'replacementStop'->>'sessionKeyHash'), FALSE)
             THEN COALESCE(${t}.grant_json->'retiredSessionKeyHashes', '[]'::jsonb) || jsonb_build_array(${t}.grant_json->'replacementStop'->>'sessionKeyHash')
             ELSE COALESCE(${t}.grant_json->'retiredSessionKeyHashes', '[]'::jsonb) END),
         sealed_session_key = EXCLUDED.sealed_session_key, updated_at = EXCLUDED.updated_at
       WHERE (${t}.grant_json->'replacementStop' IS NULL
          OR ${t}.grant_json->'replacementStop'->>'sessionKeyHash' <> $6)
         AND CASE WHEN ${t}.grant_json->'retiredSessionKeyHashes' IS NULL
                    OR jsonb_typeof(${t}.grant_json->'retiredSessionKeyHashes') = 'array'
           THEN jsonb_array_length(COALESCE(${t}.grant_json->'retiredSessionKeyHashes', '[]'::jsonb))
             + CASE WHEN ${t}.grant_json->'replacementStop'->>'sessionKeyHash' IS NOT NULL
                      AND NOT COALESCE(${t}.grant_json->'retiredSessionKeyHashes' ? (${t}.grant_json->'replacementStop'->>'sessionKeyHash'), FALSE)
               THEN 1 ELSE 0 END < $7
           ELSE FALSE END
         AND NOT COALESCE(${t}.grant_json->'retiredSessionKeyHashes' ? $6, FALSE)
       RETURNING tenant`,
        [rec.tenant, rec.chainId, JSON.stringify(rec.grant), rec.sealedSessionKey, rec.updatedAt, keyHash, MAX_RETIRED_SESSION_KEYS],
      );
      if (rows.length === 0) throw new GrantReplacementConflict();
    });
  }
  private async readRow(c: PgClientLike, tenant: `0x${string}`): Promise<StoredRecord | null> {
    const { rows } = await c.query(
      `SELECT tenant, chain_id, grant_json, sealed_session_key, updated_at FROM ${this.table} WHERE tenant = $1`,
      [tenant.toLowerCase()],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      tenant: String(row.tenant) as `0x${string}`,
      chainId: Number(row.chain_id),
      grant: parseGrantJson(row.grant_json),
      sealedSessionKey: String(row.sealed_session_key),
      updatedAt: Number(row.updated_at),
    };
  }
  async get(tenant: `0x${string}`): Promise<StoredGrant | null> {
    const c = await this.existing();
    if (!c) return null;
    const rec = await this.readRow(c, tenant);
    return rec ? fromRecord(rec, this.wallet) : null;
  }
  async hasStoredGrant(tenant: `0x${string}`): Promise<boolean> {
    const c = await this.existing();
    if (!c) return false;
    const { rows } = await c.query(`SELECT 1 FROM ${this.table} WHERE tenant = $1`, [tenant.toLowerCase()]);
    return rows.length > 0;
  }
  async storedGrantOwner(tenant: `0x${string}`): Promise<string | null> {
    const c = await this.existing();
    if (!c) return null;
    const { rows } = await c.query(`SELECT grant_json FROM ${this.table} WHERE tenant = $1`, [tenant.toLowerCase()]);
    if (!rows[0]) return null;
    return verifiedOwner(parseGrantJson(rows[0].grant_json), this.wallet);
  }
  async listTenants(): Promise<`0x${string}`[]> {
    const c = await this.existing();
    if (!c) return [];
    const { rows } = await c.query(`SELECT tenant FROM ${this.table}`);
    return rows.map((r) => String(r.tenant) as `0x${string}`);
  }
  async listTenantExpiries(): Promise<Array<{ tenant: `0x${string}`; purpose: GrantPurpose; expiresAt: number | null; updatedAt: number | null }>> {
    const c = await this.existing();
    if (!c) return [];
    const { rows } = await c.query(`SELECT tenant, grant_json->>'expiresAt' AS expires_at, updated_at FROM ${this.table}`);
    return rows.map((row) => {
      const expiry = Number(row.expires_at), stamp = Number(row.updated_at);
      return {
        tenant: String(row.tenant) as `0x${string}`,
        purpose: this.wallet,
        expiresAt: row.expires_at !== null && Number.isFinite(expiry) ? expiry : null,
        updatedAt: row.updated_at !== null && row.updated_at !== undefined && Number.isFinite(stamp) ? stamp : null,
      };
    });
  }
  /**
   * Delete the tenant's row, or with `atSec` only one stored at or before it,
   * and say whether a row went. One statement either way. Spot's also fences
   * a staged original-book transfer in that statement (ledger-import.ts binds
   * one to the Spot grant row); Perps has no such transfer, so a Perps removal
   * leaves a Spot one alone.
   */
  private async deleteRow(c: PgClientLike, tenant: `0x${string}`, atSec?: number): Promise<boolean> {
    const t = tenant.toLowerCase();
    const covered = atSec === undefined ? "" : " AND updated_at <= $2";
    const params = atSec === undefined ? [t] : [t, atSec];
    if (this.wallet !== "spot") {
      const { rows } = await c.query(`DELETE FROM ${this.table} WHERE tenant = $1${covered} RETURNING tenant`, params);
      return rows.length > 0;
    }
    const { rows } = await c.query(`WITH gone AS (
      DELETE FROM grants WHERE tenant = $1${covered} RETURNING tenant
    ), invalidated AS (
      UPDATE tenant_ledger_import AS i SET state = 'deleted', sealed = NULL, bytes = 0
      FROM gone WHERE i.tenant = gone.tenant RETURNING i.generation, i.tenant
    ), fenced AS (
      UPDATE tenant_ledger_import_generations AS g SET state = 'deleted'
      FROM invalidated WHERE g.generation = invalidated.generation AND g.tenant = invalidated.tenant
      RETURNING g.generation
    ) SELECT tenant FROM gone`, params);
    return rows.length > 0;
  }
  async remove(tenant: `0x${string}`): Promise<void> {
    const c = await this.existing();
    if (c) await this.deleteRow(c, tenant);
  }
  async stopForReplacement(tenant: `0x${string}`, expectedAccount?: string, expectedSession?: string): Promise<ReplacementStopResult> {
    const c = await this.existing();
    if (!c) return "absent";
    const rec = await this.readRow(c, tenant);
    if (!rec) return "absent";
    const stopped = replacementRecord(rec, expectedAccount, expectedSession);
    if (!stopped) return "changed";
    // Compare the exact previous record, not a seconds-resolution timestamp:
    // another tab's fresh grant must survive even when both writes share a second.
    const updated = await c.query(
      `UPDATE ${this.table} SET grant_json = $4::jsonb, sealed_session_key = ''
       WHERE tenant = $1 AND grant_json = $2::jsonb AND sealed_session_key = $3 RETURNING tenant`,
      [tenant.toLowerCase(), JSON.stringify(rec.grant), rec.sealedSessionKey, JSON.stringify(stopped.grant)],
    );
    return updated.rows.length > 0 ? "stopped" : "changed";
  }
  async removeUnlessNewer(tenant: `0x${string}`, atSec: number): Promise<"removed" | "absent" | "newer"> {
    const c = await this.existing();
    if (!c) return "absent";
    if (await this.deleteRow(c, tenant, atSec)) return "removed";
    // Nothing deleted: either there is no row, or it was put after the kill.
    // This read only names which — the decision was the DELETE above.
    const left = await c.query(`SELECT 1 FROM ${this.table} WHERE tenant = $1`, [tenant.toLowerCase()]);
    return left.rows.length > 0 ? "newer" : "absent";
  }
  async revokeForKill(tenant: `0x${string}`, coveredSec?: number): Promise<"removed" | "absent" | "newer"> {
    // existing(): a catalog read, and for Perps no schema at all. A kill never
    // waits on, or fails at, the making of a table it would find empty.
    if (coveredSec !== undefined) return this.removeUnlessNewer(tenant, coveredSec);
    const c = await this.existing();
    if (!c) return "absent";
    return (await this.deleteRow(c, tenant)) ? "removed" : "absent";
  }
  async tenantForAccount(smartAccount: `0x${string}`): Promise<`0x${string}` | null> {
    const c = await this.client();
    // The account lives inside grant_json, so this reads it out of the JSONB
    // rather than a column. Fine at this size; if the fleet grows, the index to
    // add is on (grant_json->>'smartAccount').
    const holders = new Set<string>();
    for (const wallet of ["spot", "perps"] as const) {
      const table = WALLET_TABLE[wallet];
      if (!(wallet === this.wallet ? await this.existing() : (await tableExists(c, table)))) continue;
      const { rows } = await c.query(`SELECT tenant FROM ${table} WHERE lower(grant_json->>'smartAccount') = $1`, [smartAccount.toLowerCase()]);
      for (const row of rows) holders.add(String(row.tenant).toLowerCase());
    }
    if (holders.size > 1) throw new Error("this smart account is claimed by more than one login");
    const [holder] = holders;
    return holder ? (holder as `0x${string}`) : null;
  }
}

/**
 * The store for one wallet: Postgres when DATABASE_URL is set, else the file
 * backend. THE WALLET HAS NO DEFAULT: a call that does not say which wallet it
 * means is a compile error, not a quiet read of Spot.
 */
const cached = new Map<GrantPurpose, GrantStore>();
export function getGrantStore(wallet: GrantPurpose): GrantStore {
  if (!isGrantPurpose(wallet)) throw new Error("Unrecognised wallet purpose");
  const found = cached.get(wallet);
  if (found) return found;
  const url = process.env.DATABASE_URL;
  const store = !url ? new FileGrantStore(wallet)
    // The Perps store's statements share the Spot store's connection (see PgGrantStore).
    : wallet === "perps" ? new PgGrantStore(url, wallet, connectPgGrant, () => (getGrantStore("spot") as PgGrantStore).sharedConnection())
    : new PgGrantStore(url, wallet);
  cached.set(wallet, store);
  return store;
}

/** Test seam: drop the cached stores so a test can change the environment. */
export function resetGrantStoreForTest(): void {
  cached.clear();
}
