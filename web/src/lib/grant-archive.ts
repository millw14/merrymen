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
import { homePaths, liftKillPause, pauseForKeptGrant } from "@merrymen/home";
import { fsyncDir, writeFileAtomic } from "@merrymen/atomic-write";
import type { StoredGrant } from "@merrymen/core";

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
 * Never throws. `failed` means a grant was there and no durable copy exists —
 * what that costs is the caller's decision (POST arms anyway; DELETE does not).
 */
export async function archiveCurrentGrant(): Promise<
  { kind: "archived"; account: string } | { kind: "nothing" } | { kind: "failed"; why: string }
> {
  const GRANT_FILE = homePaths.grant();
  const ARCHIVE_DIR = homePaths.grantsArchive();
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
  constructor(why: string, public readonly paused: boolean) {
    super(
      `The grant was NOT deleted: ${why}, and deleting it without a copy would lose your owner key for good. ` +
        (paused ? "Trading is paused instead. " : "Trading could not be paused either — stop the worker. ") +
        "Fix ~/.merrymen/grants/ (disk space, permissions), then try again.",
    );
    this.name = "GrantArchiveError";
  }
}

/** The self-hosted kill switch, shared by DELETE and Start over. */
export async function removeSelfHostedGrant(): Promise<void> {
  const kept = await archiveCurrentGrant();
  if (kept.kind === "failed") throw new GrantArchiveError(kept.why, pauseForKeptGrant());
  await rm(homePaths.grant(), { force: true });
  liftKillPause();
}
