import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { StoredGrant } from "../../packages/core/src/index";
import { homePaths, merrymenHome } from "./home";
import { grantIdentity, killedGrant, killRequested } from "./kill-request";

/** Reads the grant handoff written by web's /api/grants (~/.merrymen/grant.json). */
export function loadGrantFile(): StoredGrant | null {
  const file = process.env.MERRYMEN_GRANT_FILE ?? homePaths.grant();
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
  const home = merrymenHome();
  if (killRequested(home)) return null;
  const killed = killedGrant(home);
  return killed !== null && killed === grantIdentity(grant) ? null : grant;
}

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
 * Returns the archived smart-account address, or null when there was nothing
 * to keep. Never throws: a kill switch must fire even if the disk is full.
 */
export function archiveCurrentGrant(): string | null {
  const file = process.env.MERRYMEN_GRANT_FILE ?? homePaths.grant();
  try {
    const raw = readFileSync(file, "utf8");
    const grant = JSON.parse(raw.replace(/^﻿/, "")) as StoredGrant;
    if (!grant?.smartAccount) return null;
    const dir = homePaths.grantsArchive();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // The archived file carries a plaintext owner key — owner-only (0600),
    // never the default world-readable 0644.
    writeFileSync(path.join(dir, `${grant.smartAccount.toLowerCase()}.json`), raw, {
      encoding: "utf8",
      mode: 0o600,
    });
    return grant.smartAccount;
  } catch {
    return null; // nothing to keep
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
