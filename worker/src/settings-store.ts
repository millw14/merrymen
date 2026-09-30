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
  | { ok: false; heldBy: `0x${string}` }
  /**
   * Nobody holds it, but an account held it and let it go (a HolderRelease
   * exists): only the wallet's own fresh signature (takeHolder) claims it now.
   */
  | { ok: false; heldBy: null };

/** A claim as stored, for putting back exactly what a move replaced. */
export interface HolderClaimRecord {
  tenant: `0x${string}`;
  /** Epoch ms. */
  claimedAt: number;
  /** Epoch ms of the last move onto this row, or null when it never moved. */
  movedAt: number | null;
  /** The account that last move took it from, or null when it never moved. */
  movedFrom: `0x${string}` | null;
}

/** The outcome of a fresh signature from the wallet itself (takeHolder). */
export type HolderTake =
  /** Claimed now (`fresh`), or this account held it already. */
  | { ok: true; fresh: boolean; from?: undefined }
  /** MOVED here from `from` by this call. `was` is the claim it replaced: never shown to the caller. */
  | { ok: true; fresh: true; from: `0x${string}`; was: HolderClaimRecord }
  /**
   * It already moved in the last 24 hours; it can move from `movableAt`
   * (epoch ms: that move + 24 h). `held`: another account holds it now —
   * false when that account has since let it go (the move is kept past a
   * release).
   */
  | { ok: false; movableAt: number; held: boolean };

/**
 * HOW A WALLET'S CLAIM WAS LAST LET GO — the record that outlives the claim.
 *
 * The once-a-day move used to live on the claim row alone, and every unlink
 * deleted that row: release, and the next account's claim was a fresh one
 * with the day's move unspent. Someone with a handful of accounts could pass
 * one bag through any number of agents in a day (unlink, link elsewhere,
 * move, unlink…), and the limit bound only the phished owner who did not
 * cooperate. So a release first records who held the claim and its last move,
 * and a claim on a wallet nobody holds is judged against it (claimOnReleased).
 * Only a release writes it, and nothing deletes it.
 */
export interface HolderRelease {
  /** The account that held the claim when it was let go. */
  tenant: `0x${string}`;
  /** The claim's last move (epoch ms) and whom it took it from, as they were at the release. */
  movedAt: number | null;
  movedFrom: `0x${string}` | null;
}

/** A wallet's claim moves at most once in any 24 hours (takeHolder). */
const MOVE_WINDOW_MS = 86_400_000;

/**
 * WHEN `tenant` MAY MOVE `wallet`'s CLAIM OFF `was`: null for now, else the
 * epoch ms 24 hours after its last move. One rule for both backends.
 *
 * ONE MOVE PER WALLET IN ANY 24 HOURS, so a bag cannot be passed round a
 * string of agents — but the limit alone let ONE phished signature lock the
 * real owner out for a day: the attacker's move spent it, and the owner's
 * own fresh signature then met 429 even from the wallet's own sign-in
 * account. Two moves are therefore always allowed, and neither widens who
 * can hold the wallet in the window:
 *
 *   THE WALLET'S OWN SIGN-IN ACCOUNT (tenant === wallet). The session is
 *   that wallet's login and the signature is that wallet's key — the one
 *   party a move limit must never lock out.
 *
 *   BACK TO THE ACCOUNT IT WAS LAST MOVED FROM. The holders stay the pair
 *   the window's move already made, {from, to}; every such move still needs
 *   a fresh signature over a five-minute nonce.
 *
 * Both still stamp the move (movedAt = now, movedFrom = the holder it left),
 * so neither frees a move for anybody else within the next 24 hours.
 *
 * ROLLING FROM THE MOVE, NOT THE UTC CALENDAR DAY. Counted by calendar day,
 * the first move after midnight was free whatever happened at 23:59 — and
 * it re-stamped movedFrom. Two phished signatures submitted either side of
 * midnight moved the owner's wallet O → A1 → A2, the second rewrote
 * movedFrom to A1, and the owner's own signature met 429 for a whole day
 * (the take-back above no longer named O). Rolling, a second move by
 * anybody but the pair needs 24 hours from the first, so the owner's
 * take-back stays open; and any two unexempt moves are now at least a day
 * apart, never seconds either side of midnight — as tight as a calendar day
 * everywhere, and tighter across one.
 */
function moveBarredUntil(
  wallet: `0x${string}`,
  tenant: `0x${string}`,
  was: Pick<HolderClaimRecord, "movedAt" | "movedFrom">,
  now: number,
): number | null {
  if (was.movedAt === null || now - was.movedAt >= MOVE_WINDOW_MS) return null;
  if (tenant === wallet || tenant === was.movedFrom) return null;
  return was.movedAt + MOVE_WINDOW_MS;
}

/**
 * A CLAIM ON A WALLET NOBODY HOLDS, judged against how it was last let go:
 * the move stamp the new claim carries, or when it may be made.
 *
 *   Never held since releases were recorded (`last` null) — the first claim
 *   ever: not a move, nothing stamped.
 *   The account that let it go takes it again — not a move, and the last
 *   move it carried is carried on, its 24 hours still running.
 *   Any other account — a MOVE, exactly as if it had been taken off the
 *   holder directly: moveBarredUntil decides it (the wallet's own sign-in
 *   account and the account it was last moved from are never refused), and
 *   it is stamped.
 */
function claimOnReleased(
  wallet: `0x${string}`,
  tenant: `0x${string}`,
  last: HolderRelease | null,
  now: number,
): { ok: true; movedAt: number | null; movedFrom: `0x${string}` | null } | { ok: false; movableAt: number } {
  if (!last) return { ok: true, movedAt: null, movedFrom: null };
  if (last.tenant === tenant) return { ok: true, movedAt: last.movedAt, movedFrom: last.movedFrom };
  const barred = moveBarredUntil(wallet, tenant, last, now);
  if (barred !== null) return { ok: false, movableAt: barred };
  return { ok: true, movedAt: now, movedFrom: last.tenant };
}

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
   *
   * ONLY A WALLET NO ACCOUNT HAS EVER LET GO. This claims with no signature —
   * its one caller is the backfill of proofs made before claims existed — so
   * a wallet some account claimed and then released on purpose (an unlink, a
   * re-link, a move away) is `{ ok: false, heldBy: null }`, whoever asks: an
   * old proof, or a retry after a crash, never hands it to anyone. Its owner
   * signs again (takeHolder), which is the remedy the screen already offers.
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
   * AT MOST ONE MOVE PER WALLET IN ANY 24 HOURS, recorded on the claim and
   * kept past a release (HolderRelease), so one bag cannot be passed round a
   * string of agents in a day — except back to the wallet's own sign-in
   * account or to the account it was last moved from (moveBarredUntil).
   * Within it the answer is `{ ok: false, movableAt, held }`. A wallet nobody
   * holds is claimed as claimOnReleased says; one already ours is
   * `{ ok: true, fresh: false }`. Throws when the store cannot be read.
   */
  takeHolder(wallet: string, tenant: string, now?: number): Promise<HolderTake>;
  /**
   * Undo what takeHolder did — only while `tenant` still holds the claim. For
   * a caller whose proof failed to save: the link did not happen, so neither
   * did the claim or the move. `was` (the claim a move replaced) is put back
   * exactly; null removes a claim the call created, WITHOUT recording a
   * release, so the wallet's record is left as it was and no move is spent.
   */
  undoTakeHolder(wallet: string, tenant: string, was: HolderClaimRecord | null): Promise<void>;
  /**
   * Release a claim — only if `tenant` holds it; anyone else's is left alone.
   * The release is recorded (HolderRelease) before the claim goes.
   */
  releaseHolder(wallet: string, tenant: string): Promise<void>;
  /**
   * ONE CLAIM PER ACCOUNT: release EVERY claim `tenant` holds, except `keep`
   * — each recorded, as releaseHolder.
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
  /**
   * NULL ONLY WHEN NOTHING IS STORED. A blob that will not read — torn, not
   * JSON, sealed under another DEK, EMFILE — throws, as PgSettingsStore.get
   * does. Read as "no settings" it was worse than an error everywhere: the
   * holder-claims backfill saw no proof and never marked the tenant pending
   * (so that holder's claim was skipped for good), and every read-modify-write
   * (`?? {}` then put) replaced the tenant's whole settings with its one field.
   */
  async get(tenant: `0x${string}`): Promise<MerrymenSettings | null> {
    let raw: string;
    try {
      raw = await readFile(this.file(tenant), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    const rec = JSON.parse(raw) as StoredSettingsRecord;
    return unseal(rec.sealed);
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
   * with EEXIST when the name exists, atomically, across processes, so a
   * claim is never overwritten by a creation and a crash can never leave a
   * half-written one. Its own directory, so listTenants (every *.json under
   * tenant-settings) never mistakes a wallet for a tenant.
   *
   * EVERY CHANGE TO A WALLET'S CLAIM TAKES THE WALLET'S LOCK — creating one
   * too. A move (takeHolder) and a conditional release are each
   * read-then-write; without the lock a release that read "ours" could delete
   * the claim a move had just put there, and two moves in one instant could
   * both pass the move limit. And a claim on a free wallet is judged
   * against the wallet's release record, which a release writes: unlocked, a
   * claim could read the record, a claim-and-release land in between, and the
   * claim then be made against a record that no longer says who let it go.
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
      movedFrom: rec.movedFrom === undefined ? null : claimKey("tenant", String(rec.movedFrom)),
    };
  }
  /** The account holding `wallet`, or null when none. Throws on a claim it cannot read. */
  private async claimHolderOf(wallet: `0x${string}`): Promise<`0x${string}` | null> {
    return (await this.readClaim(wallet))?.tenant ?? null;
  }
  /**
   * Create `w`'s claim, only if it has none: a private temp file hard-linked
   * into place. False when a claim is already there. Under the wallet's lock.
   */
  private async createClaim(w: `0x${string}`, rec: HolderClaimRecord): Promise<boolean> {
    const tmp = path.join(this.claimsDir, `.${w}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    await writeFile(tmp, JSON.stringify(storedClaim(w, rec)), { encoding: "utf8", mode: 0o600 });
    try {
      await link(tmp, this.claimFile(w));
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      return false;
    } finally {
      await unlink(tmp).catch(() => {});
    }
  }
  /**
   * THE RELEASE RECORDS (HolderRelease), one file per wallet, beside the
   * claims rather than among them — a file in holder-claims is a claim.
   * Replaced whole by rename(2), under the wallet's lock.
   */
  private releasesDir = path.join(merrymenHome(), "holder-wallet-moves");
  private releaseFile(wallet: string) {
    return path.join(this.releasesDir, `${wallet}.json`);
  }
  /** How `w`'s claim was last let go, or null when it never was. Throws on a record it cannot read. */
  private async readRelease(w: `0x${string}`): Promise<HolderRelease | null> {
    let raw: string;
    try {
      raw = await readFile(this.releaseFile(w), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    // Unreadable is not "never released": that would make the next claim a
    // first claim, with no move stamped. Throw, and the caller refuses.
    const rec = JSON.parse(raw) as { tenant?: unknown; movedAt?: unknown; movedFrom?: unknown };
    return {
      tenant: claimKey("tenant", String(rec.tenant)),
      movedAt: typeof rec.movedAt === "number" && Number.isFinite(rec.movedAt) ? rec.movedAt : null,
      movedFrom: rec.movedFrom === undefined || rec.movedFrom === null ? null : claimKey("tenant", String(rec.movedFrom)),
    };
  }
  /** Record how `w`'s claim is being let go: before the claim goes, so a crash between leaves both saying the same. */
  private async writeRelease(w: `0x${string}`, was: HolderClaimRecord): Promise<void> {
    await mkdir(this.releasesDir, { recursive: true });
    const rec = { wallet: w, tenant: was.tenant, movedAt: was.movedAt, movedFrom: was.movedFrom };
    const tmp = path.join(this.releasesDir, `.${w}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    await writeFile(tmp, JSON.stringify(rec), { encoding: "utf8", mode: 0o600 });
    try {
      await rename(tmp, this.releaseFile(w));
    } catch (e) {
      await unlink(tmp).catch(() => {});
      throw e;
    }
  }
  /** Replace `w`'s claim whole: a private temp file renamed over it. Only under the wallet's lock. */
  private async replaceClaim(w: `0x${string}`, rec: HolderClaimRecord): Promise<void> {
    const tmp = path.join(this.claimsDir, `.${w}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    await writeFile(tmp, JSON.stringify(storedClaim(w, rec)), { encoding: "utf8", mode: 0o600 });
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
   * moves where the limit allows one. A lock is now only ever taken away by
   * takeAwayLock, which moves it aside atomically and deletes it only if it
   * is the very lock that was judged; the holder's own release goes the same
   * way with its own token (releaseOwnLock), so it cannot delete a lock
   * another process holds — nor leave its own behind for a breaker to put
   * back after it has gone.
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
      await releaseOwnLock(lock, token).catch(() => {});
    }
  }
  async claimHolder(wallet: string, tenant: string, now: number = Date.now()): Promise<HolderClaim> {
    const w = claimKey("wallet", wallet);
    const t = claimKey("tenant", tenant);
    return this.withClaimLock(w, async (): Promise<HolderClaim> => {
      const holder = await this.claimHolderOf(w);
      if (holder !== null) return holder === t ? { ok: true, fresh: false } : { ok: false, heldBy: holder };
      if ((await this.readRelease(w)) !== null) return { ok: false, heldBy: null };
      if (await this.createClaim(w, { tenant: t, claimedAt: now, movedAt: null, movedFrom: null })) {
        return { ok: true, fresh: true };
      }
      throw new Error("holder claim: the wallet's claim kept changing — try again");
    });
  }
  async takeHolder(wallet: string, tenant: string, now: number = Date.now()): Promise<HolderTake> {
    const w = claimKey("wallet", wallet);
    const t = claimKey("tenant", tenant);
    return this.withClaimLock(w, async (): Promise<HolderTake> => {
      const was = await this.readClaim(w);
      if (was) {
        if (was.tenant === t) return { ok: true, fresh: false };
        const barred = moveBarredUntil(w, t, was, now);
        if (barred !== null) return { ok: false, movableAt: barred, held: true };
        await this.replaceClaim(w, { tenant: t, claimedAt: now, movedAt: now, movedFrom: was.tenant });
        return { ok: true, fresh: true, from: was.tenant, was };
      }
      const next = claimOnReleased(w, t, await this.readRelease(w), now);
      if (!next.ok) return { ok: false, movableAt: next.movableAt, held: false };
      if (await this.createClaim(w, { tenant: t, claimedAt: now, movedAt: next.movedAt, movedFrom: next.movedFrom })) {
        return { ok: true, fresh: true };
      }
      throw new Error("holder claim: the wallet's claim kept changing — try again");
    });
  }
  async undoTakeHolder(wallet: string, tenant: string, was: HolderClaimRecord | null): Promise<void> {
    const w = claimKey("wallet", wallet);
    const t = claimKey("tenant", tenant);
    const back: HolderClaimRecord | null = was && {
      tenant: claimKey("tenant", was.tenant),
      claimedAt: was.claimedAt,
      movedAt: was.movedAt,
      movedFrom: was.movedFrom === null ? null : claimKey("tenant", was.movedFrom),
    };
    await this.withClaimLock(w, async () => {
      if ((await this.claimHolderOf(w)) !== t) return;
      // No release is recorded: the claim this call made never happened.
      if (back) await this.replaceClaim(w, back);
      else await rm(this.claimFile(w), { force: true });
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
      const was = await this.readClaim(w);
      if (was?.tenant !== t) return; // moved away meanwhile
      await this.writeRelease(w, was);
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
  /** The account that move took it from; absent when it never moved. */
  movedFrom?: string;
}

function storedClaim(w: `0x${string}`, rec: HolderClaimRecord): StoredClaim {
  return {
    wallet: w,
    tenant: rec.tenant,
    claimedAt: rec.claimedAt,
    ...(rec.movedAt === null ? {} : { movedAt: rec.movedAt }),
    ...(rec.movedFrom === null ? {} : { movedFrom: rec.movedFrom }),
  };
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

/** Where takeAwayLock moves `lock` while it reads it: `<lock>.<pid>.<random>.gone`, beside it. */
const asidePrefix = (lock: string) => `${path.basename(lock)}.`;

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
 *
 * "absent" when nothing was at the name: gone for good, OR moved aside by
 * another process's takeAwayLock that will link it back (releaseOwnLock).
 */
async function takeAwayLock(lock: string, token: string): Promise<"removed" | "absent" | "not-it"> {
  const aside = `${lock}.${process.pid}.${randomBytes(6).toString("hex")}.gone`;
  try {
    await rename(lock, aside);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw e;
  }
  const moved = await readFile(aside, "utf8").catch(() => null);
  if (moved !== token) await link(aside, lock).catch(() => {});
  await unlink(aside).catch(() => {});
  return moved === token ? "removed" : "not-it";
}

/** How long a holder's release waits for a breaker to finish with its lock: breaks are microseconds of file I/O. */
const OWN_RELEASE_WAIT_MS = 2_000;

/**
 * THE HOLDER'S OWN RELEASE: takeAwayLock with its own token — and a missing
 * lock is not taken at its word.
 *
 * A contender breaking a stale lock can move THIS holder's live lock aside
 * instead, when the dead one it judged was replaced between its look and
 * its rename. It then sees the token is not the one it judged and links the
 * lock back — the right thing while the holder is inside. But if the
 * holder's release came in between, it found no lock, called that released
 * and returned; the link-back then left a lock with a fresh mtime that
 * nobody held, and every claim, move and release of the wallet waited it
 * out and failed 'busy' for CLAIM_LOCK_STALE_MS.
 *
 * So after "absent" the holder looks for its own token among the moved-aside
 * locks FIRST, and waits while one is there — a break in progress, which
 * ends with a link-back (then it is at the name, and taken away again) or a
 * delete (a break of this holder's own lock, judged stale: gone). Only with
 * none aside does it look at the name: a link-back that finished before the
 * look at the asides is at the name by then, so the two looks in that order
 * cannot both miss it. Bounded, in case a breaker died mid-break: its aside
 * then never comes back under the lock's name.
 */
async function releaseOwnLock(lock: string, token: string): Promise<void> {
  const until = Date.now() + OWN_RELEASE_WAIT_MS;
  for (;;) {
    if ((await takeAwayLock(lock, token)) !== "absent") return;
    if (Date.now() > until) return;
    if (await heldAside(lock, token)) {
      await new Promise((r) => setTimeout(r, 2)); // a break in progress: let it finish
      continue;
    }
    // None aside: gone for good, or somebody else's now — unless it was
    // linked back before the look above, and then it is at the name: again.
    if ((await readLock(lock))?.token !== token) return;
  }
}

/** Whether some process has `lock` moved aside (takeAwayLock) while it still holds `token`. */
async function heldAside(lock: string, token: string): Promise<boolean> {
  const dir = path.dirname(lock);
  const prefix = asidePrefix(lock);
  for (const f of await readdir(dir)) {
    if (!f.startsWith(prefix) || !f.endsWith(".gone")) continue;
    if ((await readFile(path.join(dir, f), "utf8").catch(() => null)) === token) return true;
  }
  return false;
}

// ── postgres backend ─────────────────────────────────────────────────────────

/**
 * A release, recorded from the claim rows it is about to delete (followed by
 * the caller's WHERE on holder_claims, then ON_RELEASE_CONFLICT). The WHERE
 * is what keeps sqlite's parser — the stand-in the tests run this SQL on —
 * from reading ON CONFLICT as a join constraint.
 */
const RECORD_RELEASE = `INSERT INTO holder_wallet_moves (wallet, last_tenant, moved_at, moved_from)
  SELECT wallet, tenant, moved_at, moved_from FROM holder_claims`;
const ON_RELEASE_CONFLICT = `ON CONFLICT (wallet) DO UPDATE SET last_tenant = EXCLUDED.last_tenant,
  moved_at = EXCLUDED.moved_at, moved_from = EXCLUDED.moved_from`;
/**
 * …AND THEN DELETE ONLY A CLAIM ITS WALLET'S RECORD NOW DESCRIBES EXACTLY
 * (appended to the caller's DELETE … WHERE on holder_claims).
 *
 * The record and the delete are two statements, and the store shares one
 * pg.Client across requests, so another request's statements run between
 * them — and under READ COMMITTED each statement reads afresh. Unconditional,
 * the DELETE on the account took whatever that account held BY THEN: a move
 * onto it that landed between the two (a DELETE and a POST /api/holder fired
 * together) was deleted with no record, the wallet read as never claimed, and
 * its next claim was a first-ever one with its last move forgotten — one bag
 * passed on through as many accounts as the race was won.
 *
 * So a claim goes only while holder, last move and whom it came from are
 * still what its record says, and every deleted claim is one its record
 * carries. One that arrived in between is simply not deleted: as if it had
 * landed just after this release, which is an order the two requests could
 * have run in anyway. Portable (sqlite runs it too) and with no BEGIN, which
 * a client shared across requests cannot hold open. Postgres re-checks the
 * row's own columns against a concurrent change before deleting it.
 */
const RECORDED_AS_IS = `AND EXISTS (SELECT 1 FROM holder_wallet_moves m WHERE m.wallet = holder_claims.wallet
  AND m.last_tenant = holder_claims.tenant AND COALESCE(m.moved_at, -1) = COALESCE(holder_claims.moved_at, -1)
  AND COALESCE(m.moved_from, '') = COALESCE(holder_claims.moved_from, ''))`;

/** A nullable BIGINT epoch-ms column. */
function pgMs(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

/** A nullable account column; a malformed one throws, never reads as "none". */
function pgTenant(v: unknown): `0x${string}` | null {
  return v === null || v === undefined ? null : claimKey("tenant", String(v));
}

export interface PgClientLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/**
 * CREATE TABLE IF NOT EXISTS, SAFE AGAINST A SECOND SERVICE DOING THE SAME.
 *
 * Web and the orchestrator both open this store, and after the deploy that
 * adds a table both create it at once. Postgres's IF NOT EXISTS is not atomic
 * against that: the loser can fail on the catalog's own unique index (23505),
 * see the table appear mid-statement (42P07), or find the table's row type
 * already made (42710 duplicate_object: `type "holder_claims_meta" already
 * exists`, from a real Postgres 17 in one of eighteen racing boots over the
 * previous release's schema). Each means the table now exists, which is all
 * this wanted.
 */
async function createIfAbsent(c: PgClientLike, ddl: string): Promise<void> {
  try {
    await c.query(ddl);
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    if (code === "23505" || code === "42P07" || code === "42710") return;
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
  /**
   * The one connection, with every table made — once, and only once it WORKED.
   *
   * A failed start is forgotten, so the next call starts afresh: cached, one
   * refused connection or one lost CREATE race during a deploy failed every
   * later call on the store for the life of the process — in the web, every
   * settings read, holder link and tier. Concurrent first callers still share
   * one attempt.
   */
  private async client(): Promise<PgClientLike> {
    if (!this.ready) {
      const started = (this.ready = (async () => {
        const c = await this.connect(this.url);
        try {
          await this.makeTables(c);
        } catch (e) {
          // CLOSED, so a start that keeps failing (a permission, a lost
          // race every time) cannot pile up one open connection per call.
          void Promise.resolve((c as { end?: () => unknown }).end?.()).catch(() => {});
          throw e;
        }
        return c;
      })());
      started.catch(() => {
        if (this.ready === started) this.ready = null;
      });
    }
    return this.ready;
  }
  private async makeTables(c: PgClientLike): Promise<void> {
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
    // moves at most once in any 24 hours. Added, not created, so a table
    // made before moves existed gains it; NULL = never moved.
    await addColumnIfAbsent(c, `ALTER TABLE holder_claims ADD COLUMN moved_at BIGINT`);
    // …and which account that move took it from: a move BACK there
    // within the 24 hours is allowed (moveBarredUntil). NULL = never moved.
    await addColumnIfAbsent(c, `ALTER TABLE holder_claims ADD COLUMN moved_from TEXT`);
    // HOW EACH WALLET'S CLAIM WAS LAST LET GO (HolderRelease): a release
    // deletes the claim row, and the last move must outlive it. Its own
    // table, so a service still running the previous build — which reads
    // every holder_claims row as a live claim — never mistakes one of
    // these for a claim. Written only by a release, never deleted.
    await createIfAbsent(
      c,
      `CREATE TABLE IF NOT EXISTS holder_wallet_moves (
         wallet TEXT PRIMARY KEY,
         last_tenant TEXT NOT NULL,
         moved_at BIGINT,
         moved_from TEXT
       )`,
    );
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
   * first-claim-wins — and only on a wallet with no release record, in the
   * same statement; RETURNING says whether it was ours. When it did not land,
   * SEPARATE statements read the holder and then the record, because under
   * READ COMMITTED a row committed by a racing claim after this statement's
   * snapshot conflicts yet stays invisible to a SELECT inside the same
   * statement. Neither there — a claim raced in and was undone, which records
   * no release — the wallet is free: ask again.
   */
  async claimHolder(wallet: string, tenant: string): Promise<HolderClaim> {
    const w = claimKey("wallet", wallet);
    const t = claimKey("tenant", tenant);
    const c = await this.client();
    for (let attempt = 0; attempt < 3; attempt++) {
      const ins = await c.query(
        `INSERT INTO holder_claims (wallet, tenant, claimed_at) SELECT CAST($1 AS TEXT), CAST($2 AS TEXT), CAST($3 AS BIGINT)
         WHERE NOT EXISTS (SELECT 1 FROM holder_wallet_moves WHERE wallet = $1)
         ON CONFLICT (wallet) DO NOTHING RETURNING tenant`,
        [w, t, Date.now()],
      );
      if (ins.rows[0]) return { ok: true, fresh: true };
      const { rows } = await c.query(`SELECT tenant FROM holder_claims WHERE wallet = $1`, [w]);
      if (rows[0]) {
        const holder = claimKey("tenant", String(rows[0].tenant));
        return holder === t ? { ok: true, fresh: false } : { ok: false, heldBy: holder };
      }
      const rel = await c.query(`SELECT last_tenant FROM holder_wallet_moves WHERE wallet = $1`, [w]);
      if (rel.rows[0]) return { ok: false, heldBy: null };
    }
    throw new Error("holder claim: the wallet's claim kept changing — try again");
  }
  /**
   * CLAIM, OR MOVE — EACH ONE CONDITIONAL STATEMENT ON WHAT WAS READ.
   *
   * Held by another account: the UPDATE names the holder and the last move it
   * read, so it changes the row only if nothing moved or released it since —
   * two moves racing for one wallet cannot both win (the first stamps
   * moved_at, and the second's row no longer matches), and a move can never
   * land on a claim it did not see. moveBarredUntil decides whether it may.
   *
   * Held by nobody: the INSERT carries the stamp claimOnReleased gave, and
   * only if the release record is still the one read (or, never released,
   * still absent) — a claim-and-release landing in between would otherwise
   * let this claim skip the move it now is. The row's primary key still makes
   * the first of two claims the only one.
   *
   * Changed under it, it looks again.
   */
  async takeHolder(wallet: string, tenant: string, now: number = Date.now()): Promise<HolderTake> {
    const w = claimKey("wallet", wallet);
    const t = claimKey("tenant", tenant);
    const c = await this.client();
    for (let attempt = 0; attempt < 3; attempt++) {
      const { rows } = await c.query(
        `SELECT tenant, claimed_at, moved_at, moved_from FROM holder_claims WHERE wallet = $1`,
        [w],
      );
      if (rows[0]) {
        const was: HolderClaimRecord = {
          tenant: claimKey("tenant", String(rows[0].tenant)),
          claimedAt: Number(rows[0].claimed_at),
          movedAt: pgMs(rows[0].moved_at),
          movedFrom: pgTenant(rows[0].moved_from),
        };
        if (was.tenant === t) return { ok: true, fresh: false };
        const barred = moveBarredUntil(w, t, was, now);
        if (barred !== null) return { ok: false, movableAt: barred, held: true };
        const moved = await c.query(
          `UPDATE holder_claims SET tenant = $2, claimed_at = $3, moved_at = $3, moved_from = $4
           WHERE wallet = $1 AND tenant = $4 AND COALESCE(moved_at, -1) = $5 RETURNING tenant`,
          [w, t, now, was.tenant, was.movedAt ?? -1],
        );
        if (moved.rows[0]) return { ok: true, fresh: true, from: was.tenant, was };
        continue;
      }
      const rel = await c.query(`SELECT last_tenant, moved_at, moved_from FROM holder_wallet_moves WHERE wallet = $1`, [w]);
      const last: HolderRelease | null = rel.rows[0]
        ? {
            tenant: claimKey("tenant", String(rel.rows[0].last_tenant)),
            movedAt: pgMs(rel.rows[0].moved_at),
            movedFrom: pgTenant(rel.rows[0].moved_from),
          }
        : null;
      const next = claimOnReleased(w, t, last, now);
      if (!next.ok) return { ok: false, movableAt: next.movableAt, held: false };
      // CAST: a bare $n in a SELECT list has no type for Postgres to infer.
      const values = `SELECT CAST($1 AS TEXT), CAST($2 AS TEXT), CAST($3 AS BIGINT), CAST($4 AS BIGINT), CAST($5 AS TEXT)`;
      const ins = last
        ? await c.query(
            `INSERT INTO holder_claims (wallet, tenant, claimed_at, moved_at, moved_from) ${values}
             WHERE EXISTS (SELECT 1 FROM holder_wallet_moves WHERE wallet = $1 AND last_tenant = $6 AND COALESCE(moved_at, -1) = $7)
             ON CONFLICT (wallet) DO NOTHING RETURNING tenant`,
            [w, t, now, next.movedAt, next.movedFrom, last.tenant, last.movedAt ?? -1],
          )
        : await c.query(
            `INSERT INTO holder_claims (wallet, tenant, claimed_at, moved_at, moved_from) ${values}
             WHERE NOT EXISTS (SELECT 1 FROM holder_wallet_moves WHERE wallet = $1)
             ON CONFLICT (wallet) DO NOTHING RETURNING tenant`,
            [w, t, now, next.movedAt, next.movedFrom],
          );
      if (ins.rows[0]) return { ok: true, fresh: true };
    }
    throw new Error("holder claim: the wallet's claim kept changing — try again");
  }
  /**
   * One conditional statement: only while `tenant` still holds it. A claim
   * the call created goes with no release recorded, so the wallet's record
   * stays exactly as it was.
   */
  async undoTakeHolder(wallet: string, tenant: string, was: HolderClaimRecord | null): Promise<void> {
    const w = claimKey("wallet", wallet);
    const t = claimKey("tenant", tenant);
    const c = await this.client();
    if (!was) {
      await c.query(`DELETE FROM holder_claims WHERE wallet = $1 AND tenant = $2`, [w, t]);
      return;
    }
    await c.query(
      `UPDATE holder_claims SET tenant = $3, claimed_at = $4, moved_at = $5, moved_from = $6 WHERE wallet = $1 AND tenant = $2`,
      [w, t, claimKey("tenant", was.tenant), was.claimedAt, was.movedAt, was.movedFrom === null ? null : claimKey("tenant", was.movedFrom)],
    );
  }
  /**
   * RECORD, THEN DELETE WHAT WAS RECORDED — both conditional on the holder.
   * Recorded first, so a crash between leaves the claim held and its record
   * saying the same; never a claim gone with no record of its last move. And
   * the DELETE takes only a claim its record still describes (RECORDED_AS_IS),
   * so a move that lands between the two survives rather than vanishing.
   */
  async releaseHolder(wallet: string, tenant: string): Promise<void> {
    const w = claimKey("wallet", wallet);
    const t = claimKey("tenant", tenant);
    const c = await this.client();
    await c.query(`${RECORD_RELEASE} WHERE wallet = $1 AND tenant = $2 ${ON_RELEASE_CONFLICT}`, [w, t]);
    await c.query(`DELETE FROM holder_claims WHERE wallet = $1 AND tenant = $2 ${RECORDED_AS_IS}`, [w, t]);
  }
  /**
   * One DELETE on the account, so it clears strays whatever put them there —
   * each recorded first, and deleted only as recorded (releaseHolder).
   */
  async releaseHolderClaims(tenant: string, keep?: string): Promise<void> {
    const t = claimKey("tenant", tenant);
    const c = await this.client();
    if (keep === undefined) {
      await c.query(`${RECORD_RELEASE} WHERE tenant = $1 ${ON_RELEASE_CONFLICT}`, [t]);
      await c.query(`DELETE FROM holder_claims WHERE tenant = $1 ${RECORDED_AS_IS}`, [t]);
    } else {
      const k = claimKey("wallet", keep);
      await c.query(`${RECORD_RELEASE} WHERE tenant = $1 AND wallet <> $2 ${ON_RELEASE_CONFLICT}`, [t, k]);
      await c.query(`DELETE FROM holder_claims WHERE tenant = $1 AND wallet <> $2 ${RECORDED_AS_IS}`, [t, k]);
    }
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
