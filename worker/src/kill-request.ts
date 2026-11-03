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
 * ONE FILE PER REQUEST (`kill-request-<nonce>.json`), never rewritten. Two
 * processes write here: the child adds requests, and the orchestrator
 * supersedes them. The child never touches an existing file. The orchestrator
 * supersedes by renaming exactly the files it read. So a second /kill written
 * while the first is being superseded is a file that rename never names, and
 * it stays pending. A single shared file would need a read-modify-write, and
 * the second kill could be overwritten inside it.
 *
 * THE REQUEST ALONE DOES NOT PROVE THE KILL IS DONE.
 * Its file and directory entries are synced in the child's persistent home.
 * Losing or replacing that volume can still lose a request before the store
 * changes, so preserving the home is a launch requirement. Therefore:
 *
 *  - the orchestrator carries requests out on its three-second order-ferry
 *    clock and again on shutdown, not only in the fifteen-second reconcile.
 *    This shortens the interval before the durable store confirms revocation;
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
import { readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { StoredGrant } from "../../packages/core/src/index";
import type { GrantStore } from "./grant-store";
import { writeFileAtomicSync } from "./atomic-write";

/** `kill-request-<nonce>.json` is pending; `kill-request-<nonce>.superseded.json` is not. */
export const KILL_REQUEST_PREFIX = "kill-request-";
const PENDING_SUFFIX = ".json";
const SUPERSEDED_SUFFIX = ".superseded.json";

/**
 * What the orchestrator tells the owner once the stored grant is deleted.
 * Plain text: the sender escapes it for Telegram's HTML mode.
 */
export const KILL_DONE_TEXT =
  "✅ Kill switch done: your stored trading grant is deleted, so this agent can no longer sign anything. " +
  "Your funds stay in your smart account. Sign a new grant on the dashboard to ride again.";

/**
 * Added to KILL_DONE_TEXT when the kill also revoked the owner's Perps wallet.
 * It says what is true of the grant and nothing about where that wallet's money
 * is: that is the stand-down's to say, once it exists (slices 3 and 4).
 */
export const KILL_DONE_PERPS_TEXT =
  "Your Perps wallet's stored trading grant is deleted too, so it can no longer sign anything either.";

/**
 * The ✅ for a kill sent to the bot a login's PERPS worker runs (it runs the
 * login's bot when there is no Spot grant to run it, orchestrator.ts bot
 * seat). Its grant is the Perps wallet's; a Spot grant from before the kill
 * went with it. Silent about where any money is, as KILL_DONE_PERPS_TEXT is.
 */
export const KILL_DONE_PERPS_HOME_TEXT =
  "✅ Kill switch done: your Perps wallet's stored trading grant is deleted, so its agent can no longer sign anything, " +
  "and any Spot wallet grant from before the kill is deleted too. Sign a new grant on the dashboard to ride again.";

/**
 * Which signed permission a grant is. It hashes `serialized`, the signed
 * permission itself, and not `smartAccount:grantedAt`. A re-sign keeps the
 * account, and `grantedAt` is whole seconds.
 */
export function grantIdentity(grant: Pick<StoredGrant, "serialized">): string {
  return createHash("sha256").update(String(grant.serialized)).digest("hex");
}

/** A request as written. Every field is optional because it is read back from disk. */
interface KillRequestBody {
  smartAccount?: unknown;
  grant?: unknown;
  killedAt?: unknown;
}

interface RequestFile {
  /** The file name in its pending form (ending .json), even when read under its superseded name. */
  name: string;
  superseded: boolean;
  /** "unreadable": the file exists but cannot be parsed. It still counts. */
  body: KillRequestBody | "unreadable";
}

function parse(raw: string): KillRequestBody | "unreadable" {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as KillRequestBody) : "unreadable";
  } catch {
    return "unreadable";
  }
}

/**
 * Every request in this home. A pending file can be renamed to its
 * superseded name between the listing and the read. Then it is read under
 * that name, so no request goes missing from a single look.
 */
/**
 * What this home says about kills.
 *
 * `unknown` means it cannot be fully read. Either the home could not be
 * listed, for any reason but its not existing, or a superseded request could
 * not be read, so the grant it killed is not known. The latch fails closed on
 * it: nothing is handed over and nothing arms until the state reads again. It
 * is not a kill, though, and never a reason to revoke a stored grant
 * (readKillRequest).
 */
interface KillState {
  requests: RequestFile[];
  unknown: boolean;
}

function killState(home: string): KillState {
  let names: string[];
  try {
    names = readdirSync(home);
  } catch (e) {
    return { requests: [], unknown: (e as NodeJS.ErrnoException).code !== "ENOENT" };
  }
  const requests = listRequests(home, names);
  return { requests, unknown: requests.some((r) => r.superseded && r.body === "unreadable") };
}

function listRequests(home: string, names: string[]): RequestFile[] {
  const out: RequestFile[] = [];
  for (const listed of names) {
    if (!listed.startsWith(KILL_REQUEST_PREFIX) || !listed.endsWith(PENDING_SUFFIX)) continue;
    const superseded = listed.endsWith(SUPERSEDED_SUFFIX);
    const name = superseded ? listed.slice(0, -SUPERSEDED_SUFFIX.length) + PENDING_SUFFIX : listed;
    const tries: [string, boolean][] = superseded
      ? [[listed, true]]
      : [[listed, false], [name.slice(0, -PENDING_SUFFIX.length) + SUPERSEDED_SUFFIX, true]];
    for (const [file, isSuperseded] of tries) {
      try {
        out.push({ name, superseded: isSuperseded, body: parse(readFileSync(path.join(home, file), "utf8")) });
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
        out.push({ name, superseded: isSuperseded, body: "unreadable" });
        break;
      }
    }
  }
  return out;
}

/**
 * Is a kill PENDING in this home: asked for, and not superseded by a grant
 * signed after it? A request that exists but cannot be read counts as
 * pending. The file is the request, and a latch that can be lost by
 * corrupting it is no latch. So does a home whose kill state cannot be read
 * (KillState.unknown): the latch fails closed.
 */
export function killRequested(home: string): boolean {
  const s = killState(home);
  return s.unknown || s.requests.some((r) => !r.superseded);
}

/**
 * May the child arm this grant? The whole latch is decided from ONE scan of
 * the home. Two scans, one for "pending" and one for "which grants were
 * killed", could disagree: a record read fine the first time and failed the
 * second would drop out of the killed set, and a killed grant would arm for a
 * tick.
 *
 * No, while a kill is pending or the state is unknown (killRequested). No,
 * for any grant a request here killed, pending or superseded. Yes otherwise.
 */
export function mayArm(home: string, grant: Pick<StoredGrant, "serialized">): boolean {
  const s = killState(home);
  if (s.unknown || s.requests.some((r) => !r.superseded)) return false;
  const id = grantIdentity(grant);
  return !s.requests.some((r) => r.body !== "unreadable" && r.body.grant === id);
}

export interface KillRequest {
  /** The account whose grant was killed, for the log line. */
  smartAccount: string | null;
  /**
   * When the kill was asked for, in unix seconds on this container's clock.
   * Grants the store received at or before this second are covered by it.
   * With several pending requests, the latest.
   */
  killedAt: number;
  /** The pending files this was read from: exactly the ones a supersede may rename. */
  files: string[];
}

/**
 * The PENDING kill in this home, or null. A request that cannot be read is
 * dated `nowSec`, so it covers every grant stored so far. That can remove a
 * grant signed a moment after the kill, and the owner signs again. The other
 * way round would let a killed grant trade.
 */
export function readKillRequest(home: string, nowSec: number): KillRequest | "unreadable" | null {
  const state = killState(home);
  const pending = state.requests.filter((r) => !r.superseded);
  // Unknown and no pending request in sight: that is no evidence of a kill,
  // so nothing may be revoked on it. The latch still holds (killRequested).
  if (pending.length === 0) return state.unknown ? "unreadable" : null;
  let killedAt = 0;
  let smartAccount: string | null = null;
  for (const r of pending) {
    const at = r.body === "unreadable" ? NaN : Number(r.body.killedAt);
    const dated = Number.isSafeInteger(at) && at > 0 ? at : nowSec;
    if (dated >= killedAt) {
      killedAt = dated;
      smartAccount = r.body !== "unreadable" && typeof r.body.smartAccount === "string" ? r.body.smartAccount : smartAccount;
    }
  }
  return { smartAccount, killedAt, files: pending.map((r) => r.name) };
}

/**
 * Leave a NEW request, naming the grant being killed. Written under a
 * temporary name and renamed into place, so a write that fails partway leaves
 * no request rather than half of one. If the write fails, the child's reply
 * says the kill may not hold, and that has to be true. Throws on failure.
 */
export function writeKillRequest(
  home: string,
  grant: Pick<StoredGrant, "smartAccount" | "serialized">,
  nowSec: number,
): void {
  const nonce = randomUUID();
  const file = path.join(home, `${KILL_REQUEST_PREFIX}${nonce}${PENDING_SUFFIX}`);
  const body: KillRequestBody = { smartAccount: grant.smartAccount, grant: grantIdentity(grant), killedAt: nowSec };
  writeFileAtomicSync(file, JSON.stringify(body, null, 2), 0o600, { durable: true, followSymlinks: false });
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
 * A HOSTED /kill, CONFIRMED IN CHAT, from whichever process answers the bot.
 *
 * That is the trading child (index.ts) and, while a tenant's trading is held,
 * the hold process (telegram/hold.ts). The owner must be able to revoke from
 * either, and the two must do exactly the same thing, so both call this. A
 * home with no grant file left says whether that is because a kill already
 * took it.
 */
export function hostedKillFromChat(
  home: string,
  grantFile: string,
  grant: Pick<StoredGrant, "smartAccount" | "serialized"> | null,
  nowSec: number,
): HostedKillResult | { ok: false; reason: string } {
  if (!grant) {
    return { ok: false, reason: killRequested(home) ? "already killed — the server is removing the grant" : "no grant" };
  }
  return killHosted(home, grantFile, grant, nowSec);
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

/**
 * Left in the home by the call whose DELETE removed a grant (the Robinhood
 * one, or the Perps wallet's) while another half of the kill failed: the
 * owner's ✅ is owed to the pass that finishes the kill. It says whether a
 * Perps grant was among what was removed, so that ✅ can say so too. Not a
 * request (no KILL_REQUEST_PREFIX), so it latches nothing. Taken by deleting
 * it, so of two passes that both finish the kill exactly one reports
 * `removed`. A child writing one itself can only bring a ✅ forward to a pass
 * that found its grant gone and every other half done, which is then true.
 */
export const KILL_CONFIRM_OWED = "kill-confirm-owed";
const OWED_PERPS = "perps";

function oweKillConfirm(home: string, perps: boolean): void {
  const file = path.join(home, KILL_CONFIRM_OWED);
  // Best effort: lost, the owner gets no ✅ and was told what to do then (killHosted's reply).
  // Never rewritten without the Perps note an earlier pass left in it.
  let owedPerps = perps;
  try { owedPerps = owedPerps || readFileSync(file, "utf8").includes(OWED_PERPS); } catch { /* none owed yet */ }
  try { writeFileSync(file, owedPerps ? OWED_PERPS : "", { mode: 0o600 }); } catch { /* see above */ }
}

function takeKillConfirm(home: string): { perps: boolean } | null {
  const file = path.join(home, KILL_CONFIRM_OWED);
  let perps = false;
  try { perps = readFileSync(file, "utf8").includes(OWED_PERPS); } catch { /* unreadable: still taken below if it is there */ }
  try {
    rmSync(file);
    return { perps };
  } catch {
    return null;
  }
}

export type KillOutcome =
  /** No pending request in this home. */
  | { outcome: "none" }
  /**
   * The stored grant is gone. Stand the child down. `removed` is true only for
   * the one call whose DELETE removed a grant (the Robinhood one or the Perps
   * wallet's) or, when another half of that call failed, the one that then
   * finished the kill (KILL_CONFIRM_OWED). That call confirms to the owner, and
   * `perps` says whether a Perps grant was among what this kill removed. A
   * later pass finds it already absent.
   */
  | { outcome: "revoked"; request: KillRequest; removed: boolean; perps: boolean }
  /**
   * The stored grant was signed AFTER the kill. The request is marked
   * superseded: that grant is handed over and arms. The killed one is still
   * refused. `perps`: this pass still removed a Perps grant the kill covered.
   */
  | { outcome: "superseded"; request: KillRequest; perps: boolean }
  /** Could not be carried out this pass. The request stays pending, so nothing arms, and the next pass retries. */
  | { outcome: "failed"; request: KillRequest; error: string };

/**
 * The halves of a kill beyond the Robinhood grant, run after its conditional
 * DELETE on every pass that finds a readable request. Each throws when it
 * could not do its part.
 */
export interface KillHalves {
  /**
   * Revoke the tenant's SPOT grant by the same cutoff, for a request whose
   * home is a Perps worker's: there the store judged first is the Perps one,
   * and the Spot grant is one more half. True when one was revoked by this
   * call. Absent for a Spot home's request, whose store is Spot's.
   */
  spot?: (coveredSec: number) => Promise<boolean>;
  /** Turn the tenant's Solana strategy off (solana-kill.ts). */
  solana?: () => Promise<unknown>;
  /**
   * Revoke the tenant's Perps grant if it was stored at or before
   * `coveredSec`, the same second the Robinhood grant was judged by
   * (perps-kill.ts). True when one was revoked by this call.
   */
  perps?: (coveredSec: number) => Promise<boolean>;
}

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
 *
 * THE ROBINHOOD GRANT GOES FIRST. `halves` stop what that grant does not
 * cover: the tenant's Solana strategy, and its Perps wallet, whose grant is
 * judged by the same cutoff as the Robinhood one, so a Perps grant signed
 * after the kill stays. They run on every pass that finds a readable request,
 * after the conditional DELETE, so nothing on their side can keep a killed
 * Robinhood grant stored (the web's DELETE /api/grants removes it first too).
 * And each runs whatever the others did, that DELETE failing included: no half
 * failing ever skips another, so a Robinhood store that cannot be read never
 * keeps the Perps key stored across every retry. A kill is still never
 * reported done while a half failed: the outcome is
 * `failed`, the request stays pending (the reconcile keeps a home whose kill
 * is not carried out), and the next pass finds the grant absent and retries.
 * The ✅ is owed by the call whose DELETE removed a grant: when a half fails,
 * it leaves KILL_CONFIRM_OWED in the home, and the pass that then finishes
 * takes it and reports `removed`, so the owner is told exactly once, when
 * all are done. The halves also run when the request turns out superseded;
 * stopping is the safe direction, and the newer grant arms once they succeed.
 */
export async function honourKillRequest(
  store: Pick<GrantStore, "removeUnlessNewer">,
  tenant: `0x${string}`,
  home: string,
  nowSec: number,
  halves: KillHalves = {},
): Promise<KillOutcome> {
  const request = readKillRequest(home, nowSec);
  if (!request) return { outcome: "none" };
  if (request === "unreadable") {
    return {
      outcome: "failed",
      request: { smartAccount: null, killedAt: nowSec, files: [] },
      error: "the kill state in this home cannot be read; nothing arms until it can",
    };
  }
  const coveredSec = request.killedAt + KILL_CLOCK_SLACK_SEC;
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
  // FIRST, BUT NOT ALONE. A Robinhood removal that fails (a store that cannot
  // be read, a broken grant file) is recorded, and the other halves still run:
  // otherwise the same fault on every retry would keep the Perps key stored and
  // the Solana strategy on for as long as it lasted. The kill is then `failed`
  // and stays pending, and the next pass tries every half again.
  let result: "removed" | "absent" | "newer" | { failed: string };
  try {
    result = await store.removeUnlessNewer(tenant, coveredSec);
  } catch (e) {
    result = { failed: message(e) };
  }
  const failures: string[] = [];
  let perpsRemoved = false;
  let spotRemoved = false;
  if (halves.spot) {
    try { spotRemoved = await halves.spot(coveredSec); } catch (e) { failures.push(`the Spot wallet could not be stopped: ${message(e)}`); }
  }
  if (halves.solana) {
    try { await halves.solana(); } catch (e) { failures.push(`the Solana strategy could not be stopped: ${message(e)}`); }
  }
  if (halves.perps) {
    try { perpsRemoved = await halves.perps(coveredSec); } catch (e) {
      // A Perps half that revoked the grant and then failed (its paper strategy,
      // perps-kill.ts PerpsPaperNotStopped) did remove one: owed in the ✅ the
      // finishing pass sends, though this pass is a failure.
      if ((e as { perpsRemoved?: unknown } | null)?.perpsRemoved === true) perpsRemoved = true;
      failures.push(`the Perps wallet could not be stopped: ${message(e)}`);
    }
  }
  if (typeof result === "object" || failures.length > 0) {
    // Owed by this call alone: the DELETE that removed a grant happens once.
    if (result === "removed" || perpsRemoved || spotRemoved) oweKillConfirm(home, perpsRemoved);
    if (typeof result === "object") {
      return { outcome: "failed", request, error: [result.failed, ...failures].join(", and ") };
    }
    const grant = result === "newer" ? "a grant signed after the kill is kept" : "the Robinhood grant is removed";
    return { outcome: "failed", request, error: `${grant}, but ${failures.join(", and ")}` };
  }
  if (result !== "newer") {
    const owed = takeKillConfirm(home);
    return { outcome: "revoked", request, removed: result === "removed" || perpsRemoved || spotRemoved || owed !== null, perps: perpsRemoved || owed?.perps === true };
  }
  // SUPERSEDED, NOT DELETED: each killed grant's identity stays in this home.
  // Only the files this call read are renamed. A request the child wrote since
  // is one this rename never names, so it stays pending for the next pass.
  for (const file of request.files) {
    const from = path.join(home, file);
    const to = path.join(home, file.slice(0, -PENDING_SUFFIX.length) + SUPERSEDED_SUFFIX);
    try {
      renameSync(from, to);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; // the home was wiped
      // The new grant stays in the store, but with a request still pending
      // nothing writes or arms it. Retried next pass.
      return { outcome: "failed", request, error: e instanceof Error ? e.message : String(e) };
    }
  }
  // A SUPERSEDED KILL CONFIRMS NOTHING: the owner signed again after it. A ✅
  // an earlier pass of this kill owed is dropped here, so it can never ride on a
  // later, unrelated kill (nor tell that one it deleted a Perps grant).
  takeKillConfirm(home);
  return { outcome: "superseded", request, perps: perpsRemoved };
}
