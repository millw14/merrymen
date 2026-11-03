/**
 * THE SELF-HOSTED GRANT FILE'S SAFETY NET, and the kill switch built on it.
 *
 * Moved out of api/grants/route.ts so that POST /api/grants/discard (the web's
 * Start over) removes the grant exactly as DELETE /api/grants does: a route
 * file exports only its handlers, and neither route may import the other. The
 * grants route is reached from the partner runtime for its GET, on the model's
 * path, and Start over carries the command writer that path must never reach
 * (mcp/tools/chat.test.ts audits the graph). This file carries neither.
 */
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { liftKillPause, pauseForKeptGrant, purposeHome, merrymenHome } from "@merrymen/home";
import { fsyncDir, writeFileAtomic } from "@merrymen/atomic-write";
import { withLocalStateLock } from "../../../worker/src/local-state-lock";
import { clearLocalPerpsBinding } from "../../../worker/src/local-perps-binding";
import type { GrantPurpose, StoredGrant } from "@merrymen/core";

/**
 * A WALLET'S GRANT FILE, ITS ARCHIVE, AND THE HOME THEY SIT IN, self-hosted.
 *
 * `purposeHome` names the home: Spot's is MERRYMEN_HOME itself, so these are
 * exactly the grant.json and grants/ every install has always had; Perps's is
 * accounts/perps inside it, a complete home of its own (the same files
 * worker/src/perps-kill.ts archives and removes). No default, as the stores
 * take none: a caller names the wallet it means, and an unnamed one throws
 * before any file is touched.
 */
function grantFiles(wallet: GrantPurpose): { home: string; grant: string; archive: string } {
  const home = purposeHome(wallet);
  return { home, grant: path.join(home, "grant.json"), archive: path.join(home, "grants") };
}

/** A well-formed 0x EVM address — the ONLY thing we ever build an archive filename
 * from. Rejecting anything else keeps `smartAccount` from smuggling path separators
 * (../, absolute paths) into archiveCurrentGrant's `${addr}.json`. */
const isAddr = (v: unknown): v is `0x${string}` => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);

/**
 * Copy whatever grant.json currently holds into the archive, keyed by its smart
 * account, BEFORE we overwrite or delete it.
 *
 * grant.json is a single slot: creating a second wallet (or hitting the kill
 * switch) used to destroy the previous grant — and with it the ONLY on-disk copy
 * of that wallet's owner key, permanently stranding any funds still in it. This
 * is the safety net.
 *
 * ON DISK BEFORE IT SAYS `archived`: a synced temp file renamed into place, the
 * archive directory synced after it (and its parent when it is new). A plain
 * write is still in the page cache when grant.json is replaced a moment later,
 * and a power loss on a filesystem with delayed allocation can keep that
 * replace and lose the copy. A same-account copy is replaced whole, never
 * truncated in place.
 *
 * Never throws for the files. `failed` means a grant was there and no durable
 * copy exists — what that costs is the caller's decision (POST arms anyway;
 * DELETE does not). `wallet` says whose grant.json (grantFiles); a wallet that
 * names none throws, before anything is read.
 */
export async function archiveCurrentGrant(wallet: GrantPurpose): Promise<
  { kind: "archived"; account: string } | { kind: "nothing" } | { kind: "failed"; why: string }
> {
  const { grant: GRANT_FILE, archive: ARCHIVE_DIR } = grantFiles(wallet);
  let raw: string;
  try {
    raw = await readFile(GRANT_FILE, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? { kind: "nothing" } : { kind: "failed", why: `grant.json could not be read (${code ?? "unknown error"})` };
  }
  let account: unknown;
  try {
    account = (JSON.parse(raw.replace(/^\ufeff/, "")) as Partial<StoredGrant> | null)?.smartAccount;
  } catch {
    return { kind: "nothing" }; // not a grant — nothing to file it under
  }
  if (account === undefined || account === null || account === "") return { kind: "nothing" };
  // Never derive a path from a malformed address — but a grant that names one
  // is still a grant, and it was not kept.
  if (!isAddr(account)) return { kind: "failed", why: "its smartAccount is not an address, so no archive can be named for it" };
  try {
    // mkdir returns the first directory it had to create, or undefined.
    if ((await mkdir(ARCHIVE_DIR, { recursive: true, mode: 0o700 })) !== undefined) await fsyncDir(path.dirname(ARCHIVE_DIR));
    // One file per wallet, named by its address. Re-arming the same wallet just
    // refreshes its archive copy; a different wallet gets its own file. It holds
    // a plaintext OWNER KEY — owner-only (0600), set before it is visible.
    await writeFileAtomic(path.join(ARCHIVE_DIR, `${account.toLowerCase()}.json`), raw, 0o600, { durable: true });
    return { kind: "archived", account };
  } catch (e) {
    return { kind: "failed", why: `the archive could not be written (${(e as NodeJS.ErrnoException).code ?? "unknown error"})` };
  }
}

/** An owner key that cannot be kept must not be deleted by either web route. */
export class GrantArchiveError extends Error {
  /** `archive` is the directory the owner must fix, as they would type it: Spot's, unless told otherwise. */
  constructor(why: string, public readonly paused: boolean, archive = "~/.merrymen/grants/") {
    super(
      `The grant was NOT deleted: ${why}, and deleting it without a copy would lose your owner key for good. ` +
        (paused ? "Trading is paused instead. " : "Trading could not be paused either — stop the worker. ") +
        `Fix ${archive} (disk space, permissions), then try again.`,
    );
    this.name = "GrantArchiveError";
  }
}

/**
 * The self-hosted kill switch's grant half, shared by DELETE and Start over:
 * `wallet`'s grant.json archived, then removed, then only a kill's pause lifted,
 * all in that wallet's own home. Nothing of the other wallet's is touched. (A
 * Perps KILL also turns that home's paper strategy off; that is
 * worker/src/perps-kill.ts's stopLocalPerpsWallet, not this.)
 */
export async function removeSelfHostedGrant(wallet: GrantPurpose): Promise<void> {
  return withLocalStateLock(merrymenHome(), async () => {
    const { home, grant } = grantFiles(wallet);
    const kept = await archiveCurrentGrant(wallet);
    if (kept.kind === "failed") {
      throw new GrantArchiveError(kept.why, pauseForKeptGrant(home), wallet === "perps" ? "~/.merrymen/accounts/perps/grants/" : undefined);
    }
    await rm(grant, { force: true });
    try { await fsyncDir(home); }
    catch (e) {
      // A wallet that has never existed has no directory entry to sync. Keep
      // syncing an existing home even on retries after a prior unlink, and
      // propagate every real durability/read failure.
      if (kept.kind !== "nothing" || (e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (wallet === "perps") clearLocalPerpsBinding(home);
    liftKillPause(home);
  });
}
