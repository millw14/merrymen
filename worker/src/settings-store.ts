/**
 * The per-tenant SETTINGS store — a hosted tenant's own configuration (strategy,
 * basket, custom tokens, their Telegram bot, sizing knobs).
 *
 * Self-hosted keeps its single settings.json and never touches this. Hosted needs
 * MANY settings, one per tenant, durable across a redeploy, and reachable from
 * two services: the web app WRITES it (the settings page), the orchestrator READS
 * it and hands each child worker a settings.json. Grant and settings are separate
 * stores because they have different shapes and lifecycles — but they share the
 * same backend selection and the same at-rest sealing, so a tenant's bot token
 * never sits in the clear beside the ciphertext.
 *
 * What reaches this store is ALREADY clean: the settings API strips every
 * house-key and remote-execution field (HOSTED_FORBIDDEN_SETTING_FIELDS) before
 * writing, so a stored blob carries only what a tenant may legitimately own. The
 * whole blob is sealed anyway (it can hold telegramBotToken, a secret), under the
 * same DEK the grant store uses — held by web + orchestrator, never by a child.
 *
 * NODE-ONLY (node:crypto, node:fs, pg). Imported by the web API and the worker,
 * never the browser bundle.
 */
import { link, mkdir, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { merrymenHome } from "./home";
import { openSecret, requireDek, sealSecret, storeDek } from "./store-crypto";
import type { MerrymenSettings } from "../../packages/core/src/index";

/** The outcome of claiming a holder wallet for an account. */
export type HolderClaim =
  /** Ours — `fresh` when this call created it, false when we already held it. */
  | { ok: true; fresh: boolean }
  /** Another account holds it. `heldBy` is that account: never shown to the caller. */
  | { ok: false; heldBy: `0x${string}` };

export interface SettingsStore {
  /** Persist (replace) a tenant's settings. */
  put(tenant: `0x${string}`, settings: MerrymenSettings): Promise<void>;
  /** A tenant's settings, or null if none stored. */
  get(tenant: `0x${string}`): Promise<MerrymenSettings | null>;
  /** Every tenant that has stored settings. */
  listTenants(): Promise<`0x${string}`[]>;
  /** Forget a tenant's settings (on kill). */
  remove(tenant: `0x${string}`): Promise<void>;
  /**
   * ONE $MERRYMEN WALLET POWERS ONE AGENT — the cross-account record.
   *
   * Settings are sealed per tenant, so they cannot answer "who else linked this
   * wallet?"; this can. First claim wins, atomically: two accounts claiming the
   * same wallet at the same instant get one winner. A claim this account
   * already holds is `{ ok: true, fresh: false }`. Throws when the store cannot
   * be read — the caller must refuse, never assume the wallet is free.
   * See effectiveHolder (packages/core/src/holder-proof.ts) for how it is read.
   */
  claimHolder(wallet: string, tenant: string): Promise<HolderClaim>;
  /** Release a claim — only if `tenant` holds it; anyone else's is left alone. */
  releaseHolder(wallet: string, tenant: string): Promise<void>;
  /**
   * wallet → the account holding it, lower-cased. Every claim, or only those
   * among `wallets` (the web asks about two; the orchestrator reads the whole
   * table once per reconcile rather than once per tenant). Throws when
   * unreadable — an unread claim is not "nobody claims it".
   */
  holderClaims(wallets?: readonly string[]): Promise<Map<string, `0x${string}`>>;
}

const CLAIM_ADDRESS = /^0x[0-9a-f]{40}$/;

/** Lower-case and shape-check an address before it becomes a claim key. */
function claimKey(what: "wallet" | "tenant", v: string): `0x${string}` {
  const lc = String(v).trim().toLowerCase();
  if (!CLAIM_ADDRESS.test(lc)) throw new Error(`holder claim: ${what} must be a 0x address`);
  return lc as `0x${string}`;
}

/** Seal the settings JSON when a DEK is present, else store it plaintext. */
function seal(settings: MerrymenSettings): string {
  const json = JSON.stringify(settings);
  const dek = storeDek();
  return dek ? sealSecret(json, dek) : json;
}

/** Reverse of seal — unseal if it looks sealed (iv.tag.ct), else parse plaintext. */
function unseal(blob: string): MerrymenSettings {
  const dek = storeDek();
  // A sealed blob is exactly three base64url parts; anything else is plaintext
  // JSON (self-hosted / no DEK), which starts with '{'.
  const looksSealed = dek && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(blob);
  const json = looksSealed ? openSecret(blob, dek) : blob;
  return JSON.parse(json) as MerrymenSettings;
}

interface StoredSettingsRecord {
  tenant: `0x${string}`;
  sealed: string;
  updatedAt: number;
}

// ── file backend ─────────────────────────────────────────────────────────────

export class FileSettingsStore implements SettingsStore {
  private dir = path.join(merrymenHome(), "tenant-settings");
  private file(tenant: string) {
    return path.join(this.dir, `${tenant.toLowerCase()}.json`);
  }
  async put(tenant: `0x${string}`, settings: MerrymenSettings): Promise<void> {
    const rec: StoredSettingsRecord = { tenant, sealed: seal(settings), updatedAt: Math.floor(Date.now() / 1000) };
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.file(tenant), JSON.stringify(rec, null, 2), { encoding: "utf8", mode: 0o600 });
  }
  async get(tenant: `0x${string}`): Promise<MerrymenSettings | null> {
    try {
      const rec = JSON.parse(await readFile(this.file(tenant), "utf8")) as StoredSettingsRecord;
      return unseal(rec.sealed);
    } catch {
      return null;
    }
  }
  async listTenants(): Promise<`0x${string}`[]> {
    try {
      return (await readdir(this.dir)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5) as `0x${string}`);
    } catch {
      return [];
    }
  }
  async remove(tenant: `0x${string}`): Promise<void> {
    await rm(this.file(tenant), { force: true });
  }

  /**
   * HOLDER CLAIMS ON DISK — REAL, NOT "ALWAYS ALLOW".
   *
   * The file backend is not only self-hosted: it is also the single-service
   * hosted deploy (grant-store.ts FileGrantStore.tenantForAccount, tenant-lease
   * "the single-service testnet deploy"), which has many tenants. Allowing
   * every claim there would leave the one-wallet-one-agent rule off on exactly
   * the deploy nobody watches. Self-hosted never reaches these methods — the
   * holder route is hosted-only and holderWalletFor returns before reading for
   * a null tenant — so enforcing them costs self-hosted nothing.
   *
   * ONE FILE PER WALLET, CREATED BY link(2). The claim is written complete to
   * a private temp file and then hard-linked to `<wallet>.json`; link refuses
   * with EEXIST when the name exists, atomically, across processes. First claim
   * wins without a lock, and a crash can never leave a half-written claim.
   * Its own directory, so listTenants (every *.json under tenant-settings)
   * never mistakes a wallet for a tenant.
   */
  private claimsDir = path.join(merrymenHome(), "holder-claims");
  private claimFile(wallet: string) {
    return path.join(this.claimsDir, `${wallet}.json`);
  }
  /** The account holding `wallet`, or null when none. Throws on a claim it cannot read. */
  private async claimHolderOf(wallet: `0x${string}`): Promise<`0x${string}` | null> {
    let raw: string;
    try {
      raw = await readFile(this.claimFile(wallet), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    const rec = JSON.parse(raw) as Partial<StoredClaim>;
    // A claim we cannot read is not "nobody claims it" — throw, and the
    // caller refuses rather than letting a second account in.
    return claimKey("tenant", String(rec.tenant));
  }
  async claimHolder(wallet: string, tenant: string): Promise<HolderClaim> {
    const w = claimKey("wallet", wallet);
    const t = claimKey("tenant", tenant);
    await mkdir(this.claimsDir, { recursive: true });
    for (let attempt = 0; attempt < 3; attempt++) {
      const tmp = path.join(this.claimsDir, `.${w}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
      const rec: StoredClaim = { wallet: w, tenant: t, claimedAt: Date.now() };
      await writeFile(tmp, JSON.stringify(rec), { encoding: "utf8", mode: 0o600 });
      try {
        await link(tmp, this.claimFile(w));
        return { ok: true, fresh: true };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      } finally {
        await unlink(tmp).catch(() => {});
      }
      const holder = await this.claimHolderOf(w);
      // Released between the link and the read: the wallet is free, ask again.
      if (holder === null) continue;
      return holder === t ? { ok: true, fresh: false } : { ok: false, heldBy: holder };
    }
    throw new Error("holder claim: the wallet's claim kept changing — try again");
  }
  async releaseHolder(wallet: string, tenant: string): Promise<void> {
    const w = claimKey("wallet", wallet);
    const t = claimKey("tenant", tenant);
    if ((await this.claimHolderOf(w)) !== t) return; // not ours to release
    await rm(this.claimFile(w), { force: true });
  }
  async holderClaims(wallets?: readonly string[]): Promise<Map<string, `0x${string}`>> {
    let keys: `0x${string}`[];
    if (wallets) {
      // Only an address can ever have been claimed; anything else has no claim.
      keys = wallets.map((x) => String(x).trim().toLowerCase()).filter((x): x is `0x${string}` => CLAIM_ADDRESS.test(x));
    } else {
      try {
        keys = (await readdir(this.claimsDir))
          .filter((f) => /^0x[0-9a-f]{40}\.json$/.test(f))
          .map((f) => f.slice(0, -5) as `0x${string}`);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return new Map();
        throw e;
      }
    }
    const out = new Map<string, `0x${string}`>();
    for (const w of new Set(keys)) {
      const holder = await this.claimHolderOf(w);
      if (holder) out.set(w, holder);
    }
    return out;
  }
}

interface StoredClaim {
  wallet: string;
  tenant: string;
  /** Epoch ms, like HolderProof.at. */
  claimedAt: number;
}

// ── postgres backend ─────────────────────────────────────────────────────────

export interface PgClientLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** Opens the connection. pg in production; a test passes a stand-in. */
export type PgConnect = (url: string) => Promise<PgClientLike>;

async function connectPg(url: string): Promise<PgClientLike> {
  // @ts-expect-error pg has no types here (runtime-only); webpackIgnore stops the bundler resolving it
  const pg = (await import(/* webpackIgnore: true */ "pg")) as unknown as {
    Client: new (c: { connectionString: string }) => PgClientLike & { connect(): Promise<void> };
  };
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  return c;
}

/**
 * Postgres backend for the multi-service hosted deploy. `pg` is imported at
 * RUNTIME only (webpackIgnore) so the file backend builds with it absent; the DEK
 * is required, exactly as PgGrantStore. Gated on a live-Postgres integration test
 * before any funding deploy (docs/hosted-platform-plan.md).
 */
export class PgSettingsStore implements SettingsStore {
  private ready: Promise<PgClientLike> | null = null;
  constructor(
    private url: string,
    private connect: PgConnect = connectPg,
  ) {
    requireDek();
  }
  private async client(): Promise<PgClientLike> {
    if (!this.ready) {
      this.ready = (async () => {
        const c = await this.connect(this.url);
        await c.query(
          `CREATE TABLE IF NOT EXISTS tenant_settings (
             tenant TEXT PRIMARY KEY,
             sealed TEXT NOT NULL,
             updated_at BIGINT NOT NULL
           )`,
        );
        // ONE ROW PER WALLET, so the primary key IS the one-wallet-one-agent
        // rule: a second account's INSERT conflicts and changes nothing.
        // Plain columns, not sealed: a wallet and the account holding it are
        // both public addresses, and the table must be queryable by wallet.
        await c.query(
          `CREATE TABLE IF NOT EXISTS holder_claims (
             wallet TEXT PRIMARY KEY,
             tenant TEXT NOT NULL,
             claimed_at BIGINT NOT NULL
           )`,
        );
        return c;
      })();
    }
    return this.ready;
  }
  async put(tenant: `0x${string}`, settings: MerrymenSettings): Promise<void> {
    const c = await this.client();
    await c.query(
      `INSERT INTO tenant_settings (tenant, sealed, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (tenant) DO UPDATE SET sealed = EXCLUDED.sealed, updated_at = EXCLUDED.updated_at`,
      [tenant.toLowerCase(), seal(settings), Math.floor(Date.now() / 1000)],
    );
  }
  async get(tenant: `0x${string}`): Promise<MerrymenSettings | null> {
    const c = await this.client();
    const { rows } = await c.query(`SELECT sealed FROM tenant_settings WHERE tenant = $1`, [tenant.toLowerCase()]);
    return rows[0] ? unseal(String(rows[0].sealed)) : null;
  }
  async listTenants(): Promise<`0x${string}`[]> {
    const c = await this.client();
    const { rows } = await c.query(`SELECT tenant FROM tenant_settings`);
    return rows.map((r) => String(r.tenant) as `0x${string}`);
  }
  async remove(tenant: `0x${string}`): Promise<void> {
    const c = await this.client();
    await c.query(`DELETE FROM tenant_settings WHERE tenant = $1`, [tenant.toLowerCase()]);
  }
  /**
   * INSERT … ON CONFLICT DO NOTHING, THEN LOOK. The insert is the atomic
   * first-claim-wins; RETURNING says whether it was ours. When it conflicted,
   * a SEPARATE statement reads the holder, because under READ COMMITTED a row
   * committed by a racing claim after this statement's snapshot conflicts yet
   * stays invisible to a SELECT inside the same statement. If the holder
   * released it in between, the wallet is free again and we simply ask again.
   */
  async claimHolder(wallet: string, tenant: string): Promise<HolderClaim> {
    const w = claimKey("wallet", wallet);
    const t = claimKey("tenant", tenant);
    const c = await this.client();
    for (let attempt = 0; attempt < 3; attempt++) {
      const ins = await c.query(
        `INSERT INTO holder_claims (wallet, tenant, claimed_at) VALUES ($1, $2, $3)
         ON CONFLICT (wallet) DO NOTHING RETURNING tenant`,
        [w, t, Date.now()],
      );
      if (ins.rows[0]) return { ok: true, fresh: true };
      const { rows } = await c.query(`SELECT tenant FROM holder_claims WHERE wallet = $1`, [w]);
      if (!rows[0]) continue;
      const holder = claimKey("tenant", String(rows[0].tenant));
      return holder === t ? { ok: true, fresh: false } : { ok: false, heldBy: holder };
    }
    throw new Error("holder claim: the wallet's claim kept changing — try again");
  }
  /** One conditional DELETE: only the holder's own release removes the row. */
  async releaseHolder(wallet: string, tenant: string): Promise<void> {
    const c = await this.client();
    await c.query(`DELETE FROM holder_claims WHERE wallet = $1 AND tenant = $2`, [
      claimKey("wallet", wallet),
      claimKey("tenant", tenant),
    ]);
  }
  async holderClaims(wallets?: readonly string[]): Promise<Map<string, `0x${string}`>> {
    const keys = wallets
      ? [...new Set(wallets.map((x) => String(x).trim().toLowerCase()).filter((x) => CLAIM_ADDRESS.test(x)))]
      : null;
    if (keys && keys.length === 0) return new Map();
    const c = await this.client();
    const { rows } = keys
      ? await c.query(
          `SELECT wallet, tenant FROM holder_claims WHERE wallet IN (${keys.map((_, i) => `$${i + 1}`).join(", ")})`,
          keys,
        )
      : await c.query(`SELECT wallet, tenant FROM holder_claims`);
    const out = new Map<string, `0x${string}`>();
    for (const r of rows) out.set(String(r.wallet).toLowerCase(), claimKey("tenant", String(r.tenant)));
    return out;
  }
}

let cached: SettingsStore | null = null;
export function getSettingsStore(): SettingsStore {
  if (cached) return cached;
  const url = process.env.DATABASE_URL;
  cached = url ? new PgSettingsStore(url) : new FileSettingsStore();
  return cached;
}

/** Test seam: drop the cached store so a test can change the environment. */
export function resetSettingsStoreForTest(): void {
  cached = null;
}

/**
 * Test seam: serve `store` until the next reset. Hosted routes need a
 * DATABASE_URL (the nonce store refuses without one), and `pg` is absent here,
 * so a hosted route test stands a PgSettingsStore over sqlite in through this.
 */
export function useSettingsStoreForTest(store: SettingsStore): void {
  cached = store;
}
