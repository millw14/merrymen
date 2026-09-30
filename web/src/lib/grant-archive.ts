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
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { homePaths } from "@merrymen/home";
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
 * is the safety net. Best-effort: archiving must never block arming a grant.
 */
export async function archiveCurrentGrant(): Promise<void> {
  try {
    const raw = await readFile(homePaths.grant(), "utf8");
    const prev = JSON.parse(raw) as StoredGrant;
    if (!isAddr(prev?.smartAccount)) return; // never derive a path from a malformed address
    const dir = homePaths.grantsArchive();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // One file per wallet, named by its address. Re-arming the same wallet just
    // refreshes its archive copy; a different wallet gets its own file.
    const dst = path.join(dir, `${prev.smartAccount.toLowerCase()}.json`);
    await writeFile(dst, raw, { encoding: "utf8", mode: 0o600 });
    // This file holds a plaintext OWNER KEY — keep it owner-only (0600), not the
    // default world-readable 0644. chmod covers the file-already-existed case.
    await chmod(dst, 0o600).catch(() => {});
  } catch {
    // no grant.json yet, or it's unreadable — nothing worth keeping
  }
}

/**
 * The self-hosted kill switch: it destroys the session key, NOT the wallet —
 * archived first, so the owner key survives and the funds stay reachable.
 */
export async function removeSelfHostedGrant(): Promise<void> {
  await archiveCurrentGrant();
  await rm(homePaths.grant(), { force: true });
}
