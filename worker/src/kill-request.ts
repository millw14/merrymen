/**
 * A HOSTED KILL THAT STAYS KILLED.
 *
 * Self-hosted, the kill switch is one file: grant.json is the grant, and
 * deleting it ends the agent. Hosted, grant.json is only the child's COPY. The
 * grant lives in the tenant store, and the orchestrator's reconcile rewrites a
 * missing copy from it every pass ("no file — writing it is the right answer
 * either way"). So a Telegram /kill deleted the copy, told the owner the grant
 * was destroyed, and fifteen seconds later the agent had it back and re-armed.
 *
 * A child cannot reach the store itself: CHILD_SECRET_STRIP removes
 * DATABASE_URL and the DEK, on purpose. So the child leaves a request in its
 * own home and the orchestrator, which holds both, carries it out:
 *
 *  - child: write `kill-request.json`, naming the killed grant, then delete
 *    grant.json (killHosted);
 *  - orchestrator: remove the tenant's grant from the store, but only one
 *    stored at or before the kill, give or take KILL_CLOCK_SLACK_SEC
 *    (honourKillRequest). The existing kill-switch branch of reconcile then
 *    stands the child down and wipes its home;
 *  - both sides, while the request is PENDING: the orchestrator writes no
 *    grant.json into that home, and the child arms nothing it finds there.
 *
 * The last rule closes the race between them. The orchestrator can check for
 * the request, the child can then write it, and the orchestrator can then
 * restore grant.json from its earlier read. The child still refuses to arm.
 *
 * A GRANT SIGNED AFTER THE KILL (the store answers `newer`) arms. The request
 * is not deleted: it is marked superseded. It stops being pending, so the
 * writers hand the child the new grant. It still names the killed grant, and
 * the child refuses that exact grant for as long as this home exists
 * (loadArmableGrant). Deleting it would bring back the race above: a copy of
 * the killed grant written back just before, or even after, the new one would
 * arm again.
 *
 * THE REQUEST IS NOT DURABLE, SO THE CHILD DOES NOT CLAIM THE KILL IS DONE.
 * It lives in the child's home, and a redeploy discards the container along
 * with it. A request lost before the store is changed is a grant that arms
 * again. So:
 *
 *  - the orchestrator carries requests out on its three-second order-ferry
 *    clock and again on shutdown, not only in the fifteen-second reconcile.
 *    The window in which one can be lost is seconds, not a pass;
 *  - the child's reply says only what the child did. The ✅ that the grant is
 *    gone (KILL_DONE_TEXT) is sent by the orchestrator after the conditional
 *    DELETE succeeds. That is the one party that knows it happened.
 *  - a lost request means no ✅. The child's reply tells the owner what to do
 *    if none arrives.
 *
 * Hosted only. A self-hosted kill never writes the request, so nothing here
 * changes what a self-hosted kill does.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { StoredGrant } from "../../packages/core/src/index";
import type { GrantStore } from "./grant-store";

export const KILL_REQUEST_FILE = "kill-request.json";

/**
 * What the orchestrator tells the owner once the stored grant is deleted.
 * Plain text: the sender escapes it for Telegram's HTML mode.
 */
export const KILL_DONE_TEXT =
  "✅ Kill switch done: your stored trading grant is deleted, so this agent can no longer sign anything. " +
  "Your funds stay in your smart account. Sign a new grant on the dashboard to ride again.";

export function killRequestPath(home: string): string {
  return path.join(home, KILL_REQUEST_FILE);
}

/**
 * Which signed permission a grant is. It hashes `serialized`, the signed
 * permission itself, and not `smartAccount:grantedAt`. A re-sign keeps the
 * account, and `grantedAt` is whole seconds.
 */
export function grantIdentity(grant: Pick<StoredGrant, "serialized">): string {
  return createHash("sha256").update(String(grant.serialized)).digest("hex");
}

/** The request file as written. Every field is optional because it is read back from disk. */
interface KillRequestFile {
  smartAccount?: unknown;
  grant?: unknown;
  killedAt?: unknown;
  supersededAt?: unknown;
}

/** The file, or "unreadable" when it exists but cannot be parsed, or null when absent. */
function readFile(home: string): KillRequestFile | "unreadable" | null {
  let raw: string;
  try {
    raw = readFileSync(killRequestPath(home), "utf8");
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? null : "unreadable";
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as KillRequestFile) : "unreadable";
  } catch {
    return "unreadable";
  }
}

/**
 * Is a kill PENDING in this home: asked for, and not superseded by a grant
 * signed after it? A request that exists but cannot be read counts as
 * pending. The file is the request, and a latch that can be lost by
 * corrupting it is no latch.
 */
export function killRequested(home: string): boolean {
  const f = readFile(home);
  if (f === null) return false;
  if (f === "unreadable") return true;
  return !(Number(f.supersededAt) > 0);
}

/**
 * The identity of the grant killed in this home, pending or superseded, or
 * null. The child refuses to arm that exact grant again (loadArmableGrant).
 */
export function killedGrant(home: string): string | null {
  const f = readFile(home);
  return f && f !== "unreadable" && typeof f.grant === "string" ? f.grant : null;
}

export interface KillRequest {
  /** The account whose grant was killed, for the log line. */
  smartAccount: string | null;
  /**
   * When the kill was asked for, in unix seconds on this container's clock.
   * Grants the store received at or before this second are covered by it.
   */
  killedAt: number;
}

/**
 * The PENDING kill in this home, or null. A request that cannot be read is
 * dated `nowSec`, so it covers every grant stored so far. That can remove a
 * grant signed a moment after the kill, and the owner signs again. The other
 * way round would let a killed grant trade.
 */
export function readKillRequest(home: string, nowSec: number): KillRequest | null {
  if (!killRequested(home)) return null;
  const f = readFile(home);
  if (!f || f === "unreadable") return { smartAccount: null, killedAt: nowSec };
  const killedAt = Number(f.killedAt);
  return {
    smartAccount: typeof f.smartAccount === "string" ? f.smartAccount : null,
    killedAt: Number.isSafeInteger(killedAt) && killedAt > 0 ? killedAt : nowSec,
  };
}

/**
 * Write the request file atomically: a temporary name renamed into place, so
 * a write that fails partway leaves the previous file, not half a new one.
 * The temporary name is unique, because both processes write this file.
 */
function writeAtomically(home: string, body: KillRequestFile): void {
  const file = killRequestPath(home);
  const tmp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(body, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * Leave the request, naming the grant being killed. If the write fails, the
 * child's reply says the kill may not hold, and that has to be true. Throws
 * on failure.
 */
export function writeKillRequest(
  home: string,
  grant: Pick<StoredGrant, "smartAccount" | "serialized">,
  nowSec: number,
): void {
  writeAtomically(home, { smartAccount: grant.smartAccount, grant: grantIdentity(grant), killedAt: nowSec });
}

export interface HostedKillResult {
  ok: true;
  /**
   * `queued`: the request is on disk, so the orchestrator will remove the
   * stored grant and nothing arms here in the meantime. `failed`: only this
   * copy of the key is gone, and the orchestrator may hand it back.
   */
  revocation: "queued" | "failed";
  /** Why the request could not be written, when it could not. */
  reason?: string;
  /** Nothing is archived hosted: the server never held the owner key. */
  archived: null;
}

/**
 * The child's side of a hosted kill: leave the request, then drop the local
 * copy of the key.
 *
 * NO ARCHIVE, matching the hosted branch of DELETE /api/grants. The store
 * refuses any grant that carries an owner key, so grant.json here holds only
 * the session key. Archiving would put a second copy of the session key on
 * disk and save nothing.
 *
 * Throws only when NOTHING happened: the request failed AND the copy is still
 * there. If the request was written, a failed delete is covered: the child
 * does not arm while the request is pending.
 */
export function killHosted(
  home: string,
  grantFile: string,
  grant: Pick<StoredGrant, "smartAccount" | "serialized">,
  nowSec: number,
): HostedKillResult {
  let revocation: HostedKillResult["revocation"] = "queued";
  let reason: string | undefined;
  try {
    writeKillRequest(home, grant, nowSec);
  } catch (e) {
    revocation = "failed";
    reason = e instanceof Error ? e.message : String(e);
  }
  try {
    rmSync(grantFile, { force: true });
  } catch (e) {
    if (revocation === "failed") throw e;
  }
  return { ok: true, revocation, ...(reason ? { reason } : {}), archived: null };
}

/**
 * Seconds after the kill during which a stored grant still counts as covered.
 *
 * `killedAt` is read from this container's clock, and `updatedAt` from the
 * web service's clock. If the web clock runs ahead, a grant signed just BEFORE
 * the kill carries a later stamp and looks like a redeploy, and the kill is
 * ignored. The slack takes that case. The cost runs the other way: a grant
 * signed within these few seconds after a kill is removed too, and the owner
 * signs again. /kill then /confirm cannot come that close to a new signature
 * in practice.
 */
export const KILL_CLOCK_SLACK_SEC = 5;

export type KillOutcome =
  /** No pending request in this home. */
  | { outcome: "none" }
  /**
   * The stored grant is gone. Stand the child down. `removed` is true only for
   * the one call whose DELETE removed it. That call confirms to the owner. A
   * later pass finds it already absent.
   */
  | { outcome: "revoked"; request: KillRequest; removed: boolean }
  /**
   * The stored grant was signed AFTER the kill. The request is marked
   * superseded: that grant is handed over and arms. The killed one is still
   * refused.
   */
  | { outcome: "superseded"; request: KillRequest }
  /** Could not be carried out this pass. The request stays pending, so nothing arms, and the next pass retries. */
  | { outcome: "failed"; request: KillRequest; error: string };

/**
 * The orchestrator's side: carry out a pending request against the store.
 *
 * Keyed by the HOME the request sits in, never by anything the request says
 * about itself. A child can only ever ask for its own tenant's grant to be
 * removed, which that tenant can already do from the web.
 *
 * The request is NOT deleted on `revoked`. The reconcile that follows wipes
 * the whole home, and until then it keeps the child latched. If the wipe
 * fails, the leftover request is harmless: the next grant the owner signs is
 * stored after it, comes back `newer`, and supersedes it.
 */
export async function honourKillRequest(
  store: Pick<GrantStore, "removeUnlessNewer">,
  tenant: `0x${string}`,
  home: string,
  nowSec: number,
): Promise<KillOutcome> {
  const request = readKillRequest(home, nowSec);
  if (!request) return { outcome: "none" };
  let result: "removed" | "absent" | "newer";
  try {
    result = await store.removeUnlessNewer(tenant, request.killedAt + KILL_CLOCK_SLACK_SEC);
  } catch (e) {
    return { outcome: "failed", request, error: e instanceof Error ? e.message : String(e) };
  }
  if (result !== "newer") return { outcome: "revoked", request, removed: result === "removed" };
  // SUPERSEDED, NOT DELETED: the killed grant's identity stays in this home.
  const f = readFile(home);
  const kept: KillRequestFile = f && f !== "unreadable" ? f : { smartAccount: request.smartAccount, killedAt: request.killedAt };
  try {
    writeAtomically(home, { ...kept, supersededAt: nowSec });
  } catch (e) {
    // The new grant stays in the store, but with the request still pending
    // nothing writes or arms it. Retried next pass.
    return { outcome: "failed", request, error: e instanceof Error ? e.message : String(e) };
  }
  return { outcome: "superseded", request };
}
