import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { StoredGrant } from "../../packages/core/src/index";
import { fsyncDirSync, writeFileAtomicSync } from "./atomic-write";
import { homePaths, merrymenHome } from "./home";
import { mayArm } from "./kill-request";

/**
 * The grant file this worker reads, archives and — on a kill — deletes. ONE
 * answer for all three: the kill used to delete homePaths.grant() while it read
 * and archived MERRYMEN_GRANT_FILE, so with that set it reported the grant
 * destroyed and the next tick re-armed from the file it never touched.
 */
export function grantFilePath(): string {
  return process.env.MERRYMEN_GRANT_FILE ?? homePaths.grant();
}

/** Reads the grant handoff written by web's /api/grants (~/.merrymen/grant.json). */
export function loadGrantFile(): StoredGrant | null {
  const file = grantFilePath();
  try {
    const grant = JSON.parse(readFileSync(file, "utf8")) as StoredGrant;
    if (!grant.serialized || !grant.smartAccount) return null;
    return grant;
  } catch {
    return null;
  }
}

/**
 * The grant the worker may ARM: the file's, unless a hosted kill forbids it.
 *
 * Only a hosted /kill leaves the request (kill-request.ts). While it is
 * pending, nothing arms: the orchestrator can race a copy of the key back
 * into this home, and the copy is still on disk, but it is not a grant. Once
 * a newer grant has superseded the kill, that one arms. The KILLED grant
 * never does, however it gets back into the file. Self-hosted there is never
 * a request, so this is loadGrantFile.
 */
export function loadArmableGrant(): StoredGrant | null {
  const grant = loadGrantFile();
  if (!grant) return null;
  return mayArm(merrymenHome(), grant) ? grant : null;
}

/**
 * What archiving the live grant came to.
 *
 *   archived  a copy is ON DISK — synced, and its directory entry with it —
 *             byte for byte what grant.json held
 *   nothing   no grant.json, or one that does not parse to a grant naming an
 *             account: there is nothing a copy could be filed under
 *   failed    there IS a grant, and no durable copy of it could be made
 *
 * `failed` used to be `null`, the same value as `nothing`, so the kill switch
 * deleted grant.json either way — on a full or read-only disk, the only copy
 * of the owner key.
 */
export type GrantArchive =
  | { kind: "archived"; account: string }
  | { kind: "nothing" }
  | { kind: "failed"; why: string };

/** The only thing an archive file is ever named from. Keeps a smartAccount of `../x` out of the path. */
const isAddress = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);

/**
 * Copy the live grant into the archive before anything destroys it.
 *
 * `grant.json` is a SINGLE SLOT, and for a grant that has never been replaced
 * it is the only on-disk copy of the owner key — the key `merrymen recover`
 * needs to sweep funds out of the smart account. Deleting it without a copy
 * strands the funds permanently.
 *
 * The CLI (`archiveCurrentGrant` in cli/bin.mjs) and the web `DELETE
 * /api/grants` have both done this for months. The worker's own kill switch —
 * reachable from Telegram — did not, because the worker package had no archive
 * path at all. This is that function, on this side of the fence.
 *
 * DURABLE BEFORE IT RETURNS `archived`. A plain write is in the page cache when
 * it returns, and the caller deletes grant.json straight after: on a power loss
 * a filesystem with delayed allocation can keep the delete and lose the copy's
 * data. So the copy is written through a synced temp file and a rename, the
 * archive directory is synced, and so is its parent when the directory is new.
 * A same-account copy already there is replaced whole, never truncated.
 *
 * Never throws: the caller decides what a `failed` archive means.
 */
export function archiveCurrentGrant(): GrantArchive {
  const file = grantFilePath();
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? { kind: "nothing" } : { kind: "failed", why: `grant.json could not be read (${code ?? "unknown error"})` };
  }
  let account: unknown;
  try {
    account = (JSON.parse(raw.replace(/^\ufeff/, "")) as Partial<StoredGrant> | null)?.smartAccount;
  } catch {
    return { kind: "nothing" };
  }
  if (account === undefined || account === null || account === "") return { kind: "nothing" };
  // A grant that names an account this cannot file it under is still a grant.
  if (!isAddress(account)) return { kind: "failed", why: "its smartAccount is not an address, so no archive can be named for it" };
  try {
    const dir = homePaths.grantsArchive();
    // mkdirSync returns the first directory it had to create, or undefined.
    if (mkdirSync(dir, { recursive: true, mode: 0o700 }) !== undefined) fsyncDirSync(path.dirname(dir));
    // The archived file carries a plaintext owner key — owner-only (0600),
    // set on the temp file before it is visible.
    writeFileAtomicSync(path.join(dir, `${account.toLowerCase()}.json`), raw, 0o600, { durable: true });
    return { kind: "archived", account };
  } catch (e) {
    return { kind: "failed", why: `the archive could not be written (${(e as NodeJS.ErrnoException).code ?? "unknown error"})` };
  }
}

/**
 * Is this session key past its expiry?
 *
 * `>=` rather than `>` deliberately: `expiresAt` is the first second at which
 * the on-chain timestamp policy refuses, so a grant is dead AT its expiry, not
 * one second after. Getting that boundary wrong means the worker submits one
 * last op that the account contract rejects.
 */
export function grantExpired(grant: StoredGrant, nowSec: number): boolean {
  return nowSec >= grant.expiresAt;
}

/**
 * Identity of a signature, for deduping one-shot announcements about it.
 *
 * Keyed on the pair rather than the account, because re-signing yields the SAME
 * smart account (the address derives from the owner key alone) with a new
 * `grantedAt`. A newly signed key that is itself already lapsed is a different
 * fact from the one before it and deserves to be reported again.
 *
 * `grantedAt` is whole seconds, so two grants minted inside the same second
 * collide. That is why nothing which must CONVERGE — a status write, clearing
 * the armed handle — may be gated on this key; only the announcement may.
 */
export function grantKey(grant: StoredGrant): string {
  return `${grant.smartAccount}:${grant.grantedAt}`;
}
