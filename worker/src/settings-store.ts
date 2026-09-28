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
import { link, mkdir, open, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
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

/** A claim as stored, for putting back exactly what a move replaced. */
export interface HolderClaimRecord {
  tenant: `0x${string}`;
  /** Epoch ms. */
  claimedAt: number;
  /** Epoch ms of the last move onto this row, or null when it never moved. */
  movedAt: number | null;
}

/** The outcome of a fresh signature from the wallet itself (takeHolder). */
export type HolderTake =
  /** Claimed now (`fresh`), or this account held it already. */
  | { ok: true; fresh: boolean; from?: undefined }
  /** MOVED here from `from` by this call. `was` is the claim it replaced: never shown to the caller. */
  | { ok: true; fresh: true; from: `0x${string}`; was: HolderClaimRecord }
  /** Another account holds it and it already moved once this UTC day; it can move from `movableAt` (epoch ms). */
  | { ok: false; movableAt: number };

/** A wallet's claim moves at most once per UTC day (takeHolder). */
const DAY_MS = 86_400_000;
const utcDayStart = (ms: number) => Math.floor(ms / DAY_MS) * DAY_MS;

/**
 * WHERE THE ONE-TIME HOLDER-CLAIMS BACKFILL STANDS (holder-claims.ts
 * backfillHolderClaims), kept in the same store as the claims it made.
 *
 * ONCE EVER, NOT ONCE PER PROCESS. A per-process flag re-ran the backfill at
 * every deploy, and a wallet whose claim had since been released on purpose
 * (an unlink, a re-link elsewhere) went straight back to the oldest proof
 * still sitting in some collision loser's settings — nobody signing anything.
 * This record is what lets every later start know the job is done.
 */
export interface HolderBackfillState {
  /** When the first run read the proofs, epoch ms. A retry claims no proof made after it. */
  startedAt: number;
  /**
   * Tenants whose settings no run has been able to read yet — the ONLY
   * tenants a retry reads, so a proof that lost (or was released) is never
   * looked at twice. Empty: the backfill is finished for good.
   */
  pending: `0x${string}`[];
}

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
  /**
   * THE WALLET'S OWN FRESH SIGNATURE IS AUTHORITY OVER ITS CLAIM — /api/holder
   * calls this only after burning the nonce and recovering `wallet` from a
   * signature over a message naming `tenant`.
   *
   * First claim wins stays the rule between accounts that cannot sign for the
   * wallet. But first-claim-wins alone let a claim made with a phished,
   * borrowed or long-abandoned signature lock the wallet's own key out for
   * good: its fresh signature met 409, and only the holding account could
   * unlink. So when another account holds the claim, this MOVES it here, in
   * one conditional statement — and the old account's proof then counts
   * nowhere (effectiveHolder follows the claim).
   *
   * AT MOST ONE MOVE PER WALLET PER UTC DAY, recorded on the claim itself, so
   * one bag cannot be passed round a string of agents in a day. Within it the
   * answer is `{ ok: false, movableAt }`. Unclaimed or already ours, it is
   * claimHolder. Throws when the store cannot be read.
   */
  takeHolder(wallet: string, tenant: string, now?: number): Promise<HolderTake>;
  /**
   * Put back what a move replaced — only while `tenant` still holds the
   * claim. For a caller whose proof failed to save after takeHolder moved the
   * claim: the link did not happen, so neither did the move.
   */
  undoTakeHolder(wallet: string, tenant: string, was: HolderClaimRecord): Promise<void>;
  /** Release a claim — only if `tenant` holds it; anyone else's is left alone. */
  releaseHolder(wallet: string, tenant: string): Promise<void>;
  /**
   * ONE CLAIM PER ACCOUNT: release EVERY claim `tenant` holds, except `keep`.
   *
   * By the claims themselves, never by the stored proof. The proof lives in a
   * settings blob that several writers read and write back whole (the
   * settings PUT, x-proof, the orchestrator's promotions, a second tab), so a
   * stale write can put back an old proof after a link moved on — and a
   * release keyed on the proof then frees the wrong wallet and strands the
   * right one: a claim no screen names and no unlink can find.
   */
  releaseHolderClaims(tenant: string, keep?: string): Promise<void>;
  /**
   * wallet → the account holding it, lower-cased. Every claim, or only those
   * among `wallets` (the web asks about two; the orchestrator reads the whole
   * table once per reconcile rather than once per tenant). Throws when
   * unreadable — an unread claim is not "nobody claims it".
   */
  holderClaims(wallets?: readonly string[]): Promise<Map<string, `0x${string}`>>;
  /**
   * The backfill's record, or null when no run has ever finished. Throws when
   * it cannot be read — an unread record is not "never ran", and a re-run
   * would hand released wallets back to stale proofs.
   */
  holderBackfill(): Promise<HolderBackfillState | null>;
  /** Replace the backfill's record. */
  saveHolderBackfill(state: HolderBackfillState): Promise<void>;
}

const CLAIM_ADDRESS = /^0x[0-9a-f]{40}$/;
/** holder_claims_meta's row for HolderBackfillState. */
const BACKFILL_KEY = "backfill";

/** Shape-check a stored backfill record; anything else throws, never reads as "never ran". */
function backfillState(v: unknown): HolderBackfillState {
  const s = v as Partial<HolderBackfillState> | null;
  if (
    !s ||
    typeof s !== "object" ||
    typeof s.startedAt !== "number" ||
    !Number.isFinite(s.startedAt) ||
    !Array.isArray(s.pending) ||
    !s.pending.every((t) => typeof t === "string" && CLAIM_ADDRESS.test(t))
  ) {
    throw new Error("holder claims backfill record is unreadable");
  }
  return { startedAt: s.startedAt, pending: [...s.pending] };
}

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
   *
   * CHANGING OR REMOVING AN EXISTING CLAIM TAKES THE WALLET'S LOCK. A move
   * (takeHolder) and a conditional release are each read-then-write; without
   * the lock a release that read "ours" could delete the claim a move had
   * just put there, and two moves in one instant could both pass the
   * once-a-day check. Creating a claim needs no lock: link(2) only ever
   * succeeds on a wallet with no claim, which nothing under the lock is
   * about to change.
   */
  private claimsDir = path.join(merrymenHome(), "holder-claims");
  private claimFile(wallet: string) {
    return path.join(this.claimsDir, `${wallet}.json`);
  }
  /** `wallet`'s claim, or null when none. Throws on a claim it cannot read. */
  private async readClaim(wallet: `0x${string}`): Promise<HolderClaimRecord | null> {
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
    return {
      tenant: claimKey("tenant", String(rec.tenant)),
      claimedAt: Number(rec.claimedAt) || 0,
      movedAt: typeof rec.movedAt === "number" && Number.isFinite(rec.movedAt) ? rec.movedAt : null,
    };
  }
  /** The account holding `wallet`, or null when none. Throws on a claim it cannot read. */
  private async claimHolderOf(wallet: `0x${string}`): Promise<`0x${string}` | null> {
    return (await this.readClaim(wallet))?.tenant ?? null;
  }
  /** Replace `w`'s claim whole: a private temp file renamed over it. Only under the wallet's lock. */
  private async replaceClaim(w: `0x${string}`, rec: HolderClaimRecord): Promise<void> {
    const stored: StoredClaim = { wallet: w, tenant: rec.tenant, claimedAt: rec.claimedAt, ...(rec.movedAt === null ? {} : { movedAt: rec.movedAt }) };
    const tmp = path.join(this.claimsDir, `.${w}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    await writeFile(tmp, JSON.stringify(stored), { encoding: "utf8", mode: 0o600 });
    try {
      await rename(tmp, this.claimFile(w));
    } catch (e) {
      await unlink(tmp).catch(() => {});
      throw e;
    }
  }
  /**
   * THE WALLET'S LOCK: a lock file created with O_EXCL, so one holder across
   * processes. Every holder is milliseconds of file I/O, so a lock older than
   * CLAIM_LOCK_STALE_MS was left by a process that died holding it and is
   * broken; a live one is waited on, briefly, then refused (the route answers
   * 503 and the owner tries again) rather than waited on for ever.
   *
   * EVERY LOCK CARRIES A TOKEN, AND NOTHING REMOVES A LOCK IT DID NOT NAME.
   * Breaking a stale lock was stat-then-unlink: two contenders could both
   * judge the same dead lock stale, the first break it and take a fresh one,
   * and the second then unlink THAT fresh one — two holders at once, and two
   * moves past one day's check. A lock is now only ever taken away by
   * takeAwayLock, which moves it aside atomically and deletes it only if it
   * is the very lock that was judged; the holder's own release goes the same
   * way with its own token, so it cannot delete a lock another process holds.
   */
  private async withClaimLock<T>(w: `0x${string}`, fn: () => Promise<T>): Promise<T> {
    await mkdir(this.claimsDir, { recursive: true });
    const lock = path.join(this.claimsDir, `.${w}.lock`);
    const token = `${process.pid}.${randomBytes(8).toString("hex")}`;
    for (let attempt = 0; ; attempt++) {
      if (attempt >= 200) throw new Error("holder claim: the wallet's claim is busy — try again");
      try {
        await writeFile(lock, token, { flag: "wx", mode: 0o600 });
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      const seen = await readLock(lock);
      if (!seen) continue; // released since: take it now
      if (seen.ageMs > CLAIM_LOCK_STALE_MS) {
        await takeAwayLock(lock, seen.token);
        continue;
      }
      await new Promise((r) => setTimeout(r, 5 + Math.floor(Math.random() * 20)));
    }
    try {
      return await fn();
    } finally {
      await takeAwayLock(lock, token).catch(() => {});
    }
  }
  async claimHolder(wallet: string, tenant: string, now: number = Date.now()): Promise<HolderClaim> {
    const w = claimKey("wallet", wallet);
    const t = claimKey("tenant", tenant);
    await mkdir(this.claimsDir, { recursive: true });
    for (let attempt = 0; attempt < 3; attempt++) {
      const tmp = path.join(this.claimsDir, `.${w}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
      const rec: StoredClaim = { wallet: w, tenant: t, claimedAt: now };
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
  async takeHolder(wallet: string, tenant: string, now: number = Date.now()): Promise<HolderTake> {
    const w = claimKey("wallet", wallet);
    const t = claimKey("tenant", tenant);
    const dayStart = utcDayStart(now);
    for (let attempt = 0; attempt < 3; attempt++) {
      const first = await this.claimHolder(w, t, now);
      if (first.ok) return { ok: true, fresh: first.fresh };
      const out = await this.withClaimLock(w, async (): Promise<HolderTake | null> => {
        const was = await this.readClaim(w);
        if (!was) return null; // released meanwhile: claim it afresh
        if (was.tenant === t) return { ok: true, fresh: false };
        if (was.movedAt !== null && was.movedAt >= dayStart) return { ok: false, movableAt: dayStart + DAY_MS };
        await this.replaceClaim(w, { tenant: t, claimedAt: now, movedAt: now });
        return { ok: true, fresh: true, from: was.tenant, was };
      });
      if (out) return out;
    }
    throw new Error("holder claim: the wallet's claim kept changing — try again");
  }
  async undoTakeHolder(wallet: string, tenant: string, was: HolderClaimRecord): Promise<void> {
    const w = claimKey("wallet", wallet);
    const t = claimKey("tenant", tenant);
    const back: HolderClaimRecord = { tenant: claimKey("tenant", was.tenant), claimedAt: was.claimedAt, movedAt: was.movedAt };
    await this.withClaimLock(w, async () => {
      if ((await this.claimHolderOf(w)) === t) await this.replaceClaim(w, back);
    });
  }
  async releaseHolder(wallet: string, tenant: string): Promise<void> {
    await this.releaseIfHeld(claimKey("wallet", wallet), claimKey("tenant", tenant));
  }
  /** Remove `w`'s claim only if `t` holds it — read and removed under the wallet's lock. */
  private async releaseIfHeld(w: `0x${string}`, t: `0x${string}`): Promise<void> {
    // Not ours (or none): nothing to take the lock for.
    if ((await this.claimHolderOf(w)) !== t) return;
    await this.withClaimLock(w, async () => {
      if ((await this.claimHolderOf(w)) !== t) return; // moved away meanwhile
      await rm(this.claimFile(w), { force: true });
    });
  }
  /**
   * No index by account on disk, so every claim is read. A claim that will
   * not read throws, as everywhere else here: it might be this account's.
   */
  async releaseHolderClaims(tenant: string, keep?: string): Promise<void> {
    const t = claimKey("tenant", tenant);
    const k = keep === undefined ? null : claimKey("wallet", keep);
    let names: string[];
    try {
      names = await readdir(this.claimsDir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    for (const f of names) {
      if (!/^0x[0-9a-f]{40}\.json$/.test(f)) continue;
      const w = f.slice(0, -5) as `0x${string}`;
      if (w !== k) await this.releaseIfHeld(w, t);
    }
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

  /**
   * BESIDE THE CLAIMS DIRECTORY, NOT IN IT: a file in there is a wallet's
   * claim. Replaced by rename(2), so a crash leaves the old record or the
   * new one, never half of either.
   */
  private backfillFile = path.join(merrymenHome(), "holder-claims-backfill.json");
  async holderBackfill(): Promise<HolderBackfillState | null> {
    let raw: string;
    try {
      raw = await readFile(this.backfillFile, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    return backfillState(JSON.parse(raw));
  }
  async saveHolderBackfill(state: HolderBackfillState): Promise<void> {
    const rec = backfillState(state);
    const tmp = `${this.backfillFile}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    await mkdir(path.dirname(this.backfillFile), { recursive: true });
    await writeFile(tmp, JSON.stringify(rec), { encoding: "utf8", mode: 0o600 });
    try {
      await rename(tmp, this.backfillFile);
    } catch (e) {
      await unlink(tmp).catch(() => {});
      throw e;
    }
  }
}

interface StoredClaim {
  wallet: string;
  tenant: string;
  /** Epoch ms, like HolderProof.at. */
  claimedAt: number;
  /** Epoch ms of the last move onto this claim (takeHolder); absent when it never moved. */
  movedAt?: number;
}

/** No lock is held for longer than a few file operations; one this old was orphaned by a crash. */
const CLAIM_LOCK_STALE_MS = 30_000;

/**
 * A lock's token and age, read through ONE open file, so the age judged and
 * the token later compared belong to the same lock. Null when there is none.
 */
async function readLock(lock: string): Promise<{ token: string; ageMs: number } | null> {
  let fh: Awaited<ReturnType<typeof open>>;
  try {
    fh = await open(lock, "r");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  try {
    const st = await fh.stat();
    return { token: await fh.readFile("utf8"), ageMs: Date.now() - st.mtimeMs };
  } finally {
    await fh.close().catch(() => {});
  }
}

/**
 * REMOVE `lock` ONLY IF IT IS STILL THE ONE HOLDING `token`.
 *
 * rename(2) is atomic, so of any number of processes taking the same lock
 * away exactly one gets it, under a name nobody else uses. What was moved is
 * then read: the lock that was meant is deleted; anything else — a live lock
 * that replaced the judged one between the look and the rename — is linked
 * straight back under the lock's name, never deleted. link(2) refuses if a
 * third process has taken the name meanwhile, which is the one case left: it
 * needs three contenders inside a few microseconds, after a crash.
 */
async function takeAwayLock(lock: string, token: string): Promise<void> {
  const aside = `${lock}.${process.pid}.${randomBytes(6).toString("hex")}.gone`;
  try {
    await rename(lock, aside);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return; // already gone
    throw e;
  }
  const moved = await readFile(aside, "utf8").catch(() => null);
  if (moved !== token) await link(aside, lock).catch(() => {});
  await unlink(aside).catch(() => {});
}

// ── postgres backend ─────────────────────────────────────────────────────────

export interface PgClientLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/**
 * CREATE TABLE IF NOT EXISTS, SAFE AGAINST A SECOND SERVICE DOING THE SAME.
 *
 * Web and the orchestrator both open this store, and after the deploy that
 * adds a table both create it at once. Postgres's IF NOT EXISTS is not atomic
 * against that: the loser can fail on the catalog's own unique index (23505)
 * or see the table appear mid-statement (42P07). Either means the table now
 * exists, which is all this wanted.
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
 * ALTER TABLE … ADD COLUMN, SAFE TO RUN AT EVERY START AND FROM TWO SERVICES.
 *
 * A column that is already there (this start after the first, or the other
 * service won the race) is Postgres's duplicate_column, 42701 — which is all
 * this wanted. The sqlite stand-in the tests run this SQL on says the same
 * in words. Anything else is a real failure.
 */
async function addColumnIfAbsent(c: PgClientLike, ddl: string): Promise<void> {
  try {
    await c.query(ddl);
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    if (code === "42701" || /duplicate column/i.test(e instanceof Error ? e.message : String(e))) return;
    throw e;
  }
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
        await createIfAbsent(
          c,
          `CREATE TABLE IF NOT EXISTS tenant_settings (
             tenant TEXT PRIMARY KEY,
             sealed TEXT NOT NULL,
             updated_at BIGINT NOT NULL
           )`,
        );
        // ONE ROW PER WALLET, so the primary key IS the one-wallet-one-agent
        // rule: a second account's INSERT conflicts and changes nothing.
        // Plain columns, like `grants`: it holds no secret, and it must be
        // queryable by wallet, which a sealed blob is not.
        await createIfAbsent(
          c,
          `CREATE TABLE IF NOT EXISTS holder_claims (
             wallet TEXT PRIMARY KEY,
             tenant TEXT NOT NULL,
             claimed_at BIGINT NOT NULL
           )`,
        );
        // When the claim last MOVED between accounts (takeHolder): a wallet
        // moves at most once per UTC day. Added, not created, so a table
        // made before moves existed gains it; NULL = never moved.
        await addColumnIfAbsent(c, `ALTER TABLE holder_claims ADD COLUMN moved_at BIGINT`);
        // One row per fact about the claims themselves — today only whether
        // the one-time backfill has finished (HolderBackfillState).
        await createIfAbsent(
          c,
          `CREATE TABLE IF NOT EXISTS holder_claims_meta (
             key TEXT PRIMARY KEY,
             value TEXT NOT NULL,
             updated_at BIGINT NOT NULL
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
  /**
   * CLAIM, OR MOVE IN ONE CONDITIONAL UPDATE. The UPDATE names the holder it
   * read and the once-a-day condition, so it changes the row only if nothing
   * moved or released it since: two moves racing for one wallet cannot both
   * win, and a move can never land on a claim it did not see. Changed under
   * it, it looks again.
   */
  async takeHolder(wallet: string, tenant: string, now: number = Date.now()): Promise<HolderTake> {
    const w = claimKey("wallet", wallet);
    const t = claimKey("tenant", tenant);
    const dayStart = utcDayStart(now);
    const c = await this.client();
    for (let attempt = 0; attempt < 3; attempt++) {
      const ins = await c.query(
        `INSERT INTO holder_claims (wallet, tenant, claimed_at) VALUES ($1, $2, $3)
         ON CONFLICT (wallet) DO NOTHING RETURNING tenant`,
        [w, t, now],
      );
      if (ins.rows[0]) return { ok: true, fresh: true };
      const { rows } = await c.query(`SELECT tenant, claimed_at, moved_at FROM holder_claims WHERE wallet = $1`, [w]);
      if (!rows[0]) continue; // released meanwhile: claim it afresh
      const was: HolderClaimRecord = {
        tenant: claimKey("tenant", String(rows[0].tenant)),
        claimedAt: Number(rows[0].claimed_at),
        movedAt: rows[0].moved_at === null || rows[0].moved_at === undefined ? null : Number(rows[0].moved_at),
      };
      if (was.tenant === t) return { ok: true, fresh: false };
      if (was.movedAt !== null && was.movedAt >= dayStart) return { ok: false, movableAt: dayStart + DAY_MS };
      const moved = await c.query(
        `UPDATE holder_claims SET tenant = $2, claimed_at = $3, moved_at = $3
         WHERE wallet = $1 AND tenant = $4 AND (moved_at IS NULL OR moved_at < $5) RETURNING tenant`,
        [w, t, now, was.tenant, dayStart],
      );
      if (moved.rows[0]) return { ok: true, fresh: true, from: was.tenant, was };
    }
    throw new Error("holder claim: the wallet's claim kept changing — try again");
  }
  /** One conditional UPDATE: only while `tenant` still holds it. */
  async undoTakeHolder(wallet: string, tenant: string, was: HolderClaimRecord): Promise<void> {
    const c = await this.client();
    await c.query(
      `UPDATE holder_claims SET tenant = $3, claimed_at = $4, moved_at = $5 WHERE wallet = $1 AND tenant = $2`,
      [claimKey("wallet", wallet), claimKey("tenant", tenant), claimKey("tenant", was.tenant), was.claimedAt, was.movedAt],
    );
  }
  /** One conditional DELETE: only the holder's own release removes the row. */
  async releaseHolder(wallet: string, tenant: string): Promise<void> {
    const c = await this.client();
    await c.query(`DELETE FROM holder_claims WHERE wallet = $1 AND tenant = $2`, [
      claimKey("wallet", wallet),
      claimKey("tenant", tenant),
    ]);
  }
  /** One DELETE on the account, so it clears strays whatever put them there. */
  async releaseHolderClaims(tenant: string, keep?: string): Promise<void> {
    const t = claimKey("tenant", tenant);
    const c = await this.client();
    if (keep === undefined) await c.query(`DELETE FROM holder_claims WHERE tenant = $1`, [t]);
    else await c.query(`DELETE FROM holder_claims WHERE tenant = $1 AND wallet <> $2`, [t, claimKey("wallet", keep)]);
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
  async holderBackfill(): Promise<HolderBackfillState | null> {
    const c = await this.client();
    const { rows } = await c.query(`SELECT value FROM holder_claims_meta WHERE key = $1`, [BACKFILL_KEY]);
    return rows[0] ? backfillState(JSON.parse(String(rows[0].value))) : null;
  }
  async saveHolderBackfill(state: HolderBackfillState): Promise<void> {
    const c = await this.client();
    await c.query(
      `INSERT INTO holder_claims_meta (key, value, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [BACKFILL_KEY, JSON.stringify(backfillState(state)), Date.now()],
    );
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
