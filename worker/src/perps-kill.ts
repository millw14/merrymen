/**
 * THE PERPS HALF OF EVERY KILL.
 *
 * A login's Perps wallet (Kernel index 1) has a grant of its own, and nothing
 * that stops the Spot wallet reaches it: not removing the Spot grant, not
 * Solana's switch. So every kill path calls this beside its Solana half
 * (solana-kill.ts): the web's "Kill all agents" (DELETE /api/grants,
 * delete-agent, which the phone apps send too), the orchestrator's honourKill
 * for a hosted Telegram /kill, the self-hosted Telegram /kill (index.ts) and
 * `merrymen kill` (perps-kill-cli.ts). From the moment a Perps wallet can
 * exist, a kill must reach it, so this lands before anything can make one.
 *
 * IT REVOKES THE PERPS GRANT. Hosted, the tenant's row in the Perps grant
 * store; self-hosted, the Perps home's grant.json, archived first so its owner
 * key survives.
 *
 * AND IT STANDS THE PAPER BOOK DOWN (slice 3, paper only). The Perps wallet's
 * paper strategy is turned off — `perpsEnabled` false in that wallet's own
 * settings (settings-store.ts disablePaperPerpsForKill; self-hosted, the Perps
 * home's settings.json) — so a permission signed after the kill does not start
 * leveraged practice trading again until the owner turns it back on. Its paper
 * positions are FROZEN where they are: with the grant gone no worker arms on
 * that wallet, so nothing opens, trades, protects or values them; a worker that
 * was running stops at its next grant read. Nothing is closed at a price,
 * because a paper close needs a fresh mark the kill does not have, and a price
 * made up here would book P&L that never happened. If the owner later signs a
 * new permission, the lane finds them held with perps off: nothing new opens,
 * and what is held keeps its stops and closes on its own rules (perps/lane.ts).
 * Hosted, the orchestrator also stands the running Perps worker down before
 * the ✅ (orchestrator.ts standDownForKill). The live stand-down (closing
 * positions at Lighter and bringing the money home) arrives with the live
 * executor, after the paper slices, and this half grows a third answer then:
 * closing.
 *
 * THE SAME GUARANTEES AS SOLANA'S HALF:
 *  - a half that fails throws (or, for self-hosted Telegram, answers
 *    "not-stopped"), and the caller reports the kill incomplete, never done —
 *    the grant revoked but the paper strategy left on is a failed half too;
 *  - a retry is safe: each answer is a fact about what is stored now;
 *  - every completed kill writes a disabled settings revision, even with no
 *    current grant, so a delayed enable cannot undo a kill or its retry;
 *  - it runs whatever MERRYMEN_PERPS says. A flag limits trading, never a kill.
 */
import { statSync, rmSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isHostedMode } from "../../packages/core/src/hosted";
import { writeFileAtomicSync, fsyncDirSync } from "./atomic-write";
import { getGrantStore, type GrantStore } from "./grant-store";
import { archiveGrantFile } from "./grant";
import { liftKillPause, pauseForKeptGrant, purposeHome, merrymenHome } from "./home";
import { errorText } from "./redact-urls";
import { readSettingsFileAt } from "./settings";
import { withSettingsFileLock } from "./settings-file-lock";
import { disablePaperPerpsForKill } from "./settings-store";
import { withLocalStateLock } from "./local-state-lock";
import { localPerpsBinding, readLocalPerpsBinding, retainLocalPerpsBinding, clearLocalPerpsBinding } from "./local-perps-binding";

/** What a kill needs of the Perps grant store. */
export type PerpsKillStore = Pick<GrantStore, "revokeForKill">;

/** What a kill needs of the Perps settings: the paper strategy turned off (settings-store.ts disablePaperPerpsForKill). */
export type PerpsPaperKill = (tenant: `0x${string}`) => Promise<"disabled" | "none">;

/**
 * A HOSTED kill's Perps half, by tenant: its Perps grant is revoked, and its
 * paper strategy turned off.
 *
 * `coveredSec` is for a kill carried out after it was asked for (honourKill):
 * only a grant stored at or before it is removed, as the Spot half's
 * removeUnlessNewer does, because a Perps grant signed after the kill is the
 * owner's own later decision — and so are the settings that came with it,
 * which are then left alone. "stopped": a grant was revoked (what every kill
 * answer then says: its grant is deleted). "newer": only a grant signed after
 * the kill is there, and it stays. "none": there was no grant — its paper
 * strategy is turned off all the same. Throws when either store cannot say:
 * the kill is then incomplete (the grant first, so a settings store that fails
 * never keeps the grant in place; a retry finds it gone and tries the settings
 * again).
 */
export async function stopPerpsForKill(
  tenant: `0x${string}`,
  opts: { coveredSec?: number; store?: PerpsKillStore; paper?: PerpsPaperKill } = {},
): Promise<"stopped" | "newer" | "none"> {
  const store = opts.store ?? getGrantStore("perps");
  const result = await store.revokeForKill(tenant, opts.coveredSec);
  if (result === "newer") return "newer";
  // Turned off whether or not a grant was there: a kill that revoked one and
  // failed here leaves the setting on, and its retry finds no grant.
  try {
    await (opts.paper ?? ((t) => disablePaperPerpsForKill(t, undefined, true)))(tenant);
  } catch (e) {
    // The store's own words (a driver's host and port, a DEK or unseal
    // failure) are the operator's, logged here; the owner is told what it means.
    console.error(`[kill] ${tenant}: the Perps wallet's settings could not be switched off — ${errorText(e)}`);
    throw new PerpsPaperNotStopped("its settings could not be read or written just now", result === "removed");
  }
  return result === "removed" ? "stopped" : "none";
}

/**
 * A self-hosted Perps grant that could not be revoked: the archive of its
 * owner key could not be written, so the grant is kept (deleting it would lose
 * that key for good) and its home is paused instead, when it can be.
 */
export class PerpsKillIncomplete extends Error {
  constructor(why: string, readonly paused: boolean) {
    super(`Your Perps wallet's grant was NOT revoked: ${why}, and deleting it without a copy would lose its owner key for good.` +
      (paused ? " Its trading is paused instead." : " Its trading could not be paused either."));
    this.name = "PerpsKillIncomplete";
  }
}

/**
 * A Perps wallet whose paper strategy could not be turned off: self-hosted,
 * its settings.json would not read or write; hosted, its settings store could
 * not say. The grant was still revoked when it could be, so nothing trades on
 * it; the owner is told to switch perps off in Settings before signing a new
 * permission. A kill that ends here is incomplete, never done.
 */
export class PerpsPaperNotStopped extends PerpsKillIncomplete {
  /**
   * The grant was revoked by this call, before the paper strategy failed: a
   * hosted kill that stays pending still owes the owner a ✅ naming it
   * (kill-request.ts honourKillRequest).
   */
  readonly perpsRemoved: boolean;
  constructor(why: string, revoked: boolean) {
    super(why, false);
    this.perpsRemoved = revoked;
    this.message =
      `Your Perps wallet's practice perpetuals could NOT be switched off: ${why}.` +
      (revoked ? " Its grant was revoked, so nothing trades on it now;" : " It has no grant, so nothing trades on it now;") +
      " switch perps off in Settings → Perpetuals before you sign a new permission for it.";
    this.name = "PerpsPaperNotStopped";
  }
}

/**
 * The self-hosted Perps home's paper strategy turned off: `perpsEnabled` false
 * in its settings.json, every other key as it was, written atomically (0600,
 * as patchSettingsFile writes it). No file is "none" and makes nothing; a file
 * that will not read is refused, never replaced, as patchSettingsFile refuses
 * it — rewriting it from nothing would lose every other setting.
 */
export function turnOffLocalPaperPerps(home: string, ensureRevision = false): "disabled" | "none" {
  const file = path.join(home, "settings.json");
  // A wallet never set up still costs no directory or lock-file creation.
  if (!ensureRevision && readSettingsFileAt(file).kind === "absent") return "none";
  return withSettingsFileLock(file, () => {
    const read = readSettingsFileAt(file);
    if (read.kind === "absent" && !ensureRevision) return "none";
    if (read.kind === "unusable") throw new Error(read.why);
    const settings = read.kind === "parsed" ? read.settings : {};
    writeFileAtomicSync(file, JSON.stringify({ ...settings, perpsEnabled: false, perpsControlNonce: randomUUID() }, null, 2), 0o600, { durable: true });
    return settings.perpsEnabled === true ? "disabled" : "none";
  });
}

/**
 * Self-hosted is one owner's install, so its kill stops every local Perps
 * wallet: the one grant.json in the Perps home (purposeHome("perps")),
 * archived into that home's own archive first, exactly as the Spot kill keeps
 * its owner key, and that home's paper strategy turned off
 * (turnOffLocalPaperPerps). Even when neither existed, a disabled revision
 * is recorded so an older browser page cannot undo the kill. A grant that cannot be archived throws PerpsKillIncomplete; a paper
 * strategy that could not be turned off throws PerpsPaperNotStopped, after the
 * grant has been revoked.
 */
export async function stopLocalPerpsWallet(): Promise<{ grant: "revoked" | "none"; paper: "disabled" | "none" }> {
  if (isHostedMode()) throw new Error("A hosted kill names its tenant.");
  const home = purposeHome("perps");
  // Every completed kill advances a revision, including retries after the
  // grant was removed but the first settings write failed. A stale page must
  // never reuse the old absent-settings revision to re-enable entries.
  return withLocalStateLock(merrymenHome(), async () => stopLocalPerpsWalletLocked(home));
}

async function stopLocalPerpsWalletLocked(home: string): Promise<{ grant: "revoked" | "none"; paper: "disabled" | "none" }> {
  // THE PAPER STRATEGY OFF FIRST, so it is off whatever the grant meets below;
  // a failure here is said after the grant has been dealt with.
  let paper: "disabled" | "none" = "none";
  let paperFailed: string | null = null;
  try {
    paper = turnOffLocalPaperPerps(home, true);
  } catch (e) {
    paperFailed = e instanceof Error ? e.message : String(e);
  }
  const grant = revokeLocalPerpsGrant(home);
  clearLocalPerpsBinding(home);
  if (paperFailed !== null) throw new PerpsPaperNotStopped(paperFailed, grant === "revoked");
  return { grant, paper };
}

/**
 * The self-hosted Perps home's grant.json archived (owner key and all) and
 * removed: the grant half alone. A kill runs it after turning the paper
 * strategy off (stopLocalPerpsWallet); a Perps PERMISSION REPLACEMENT runs it
 * alone (stopLocalPerpsGrantForRenewal), because a renewal is the owner
 * keeping the wallet trading, never a reason to switch its perps off. "none"
 * when there is no such file. Throws PerpsKillIncomplete when the archive
 * cannot be written (the grant is kept and the home paused).
 */
function revokeLocalPerpsGrant(home: string, beforeRemove?: () => void): "revoked" | "none" {
  const file = path.join(home, "grant.json");
  try {
    statSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "none";
    throw e;
  }
  const kept = archiveGrantFile(file, path.join(home, "grants"));
  if (kept.kind === "failed") throw new PerpsKillIncomplete(kept.why, pauseForKeptGrant(home));
  beforeRemove?.();
  rmSync(file, { force: true });
  fsyncDirSync(home);
  // A pause an earlier, refused kill left in this home has done its job.
  liftKillPause(home);
  return "revoked";
}

/**
 * A self-hosted Perps permission replacement's stop (the web DELETE with
 * `purpose: "permission-replacement"` naming `?wallet=perps`): the grant
 * archived and removed so the renewal can be posted, and NOTHING else — its
 * settings, paper strategy included, are the owner's and stay.
 */
export async function stopLocalPerpsGrantForRenewal(expectedAccount: string, expectedSession: string): Promise<"stopped" | "none" | "changed"> {
  if (isHostedMode()) throw new Error("A hosted renewal names its tenant.");
  if (![expectedAccount, expectedSession].every(value => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value))) throw new Error("The permission being replaced is not identified");
  return withLocalStateLock(merrymenHome(), async () => {
    const home = purposeHome("perps");
    let grant: unknown;
    try { grant = JSON.parse(readFileSync(path.join(home, "grant.json"), "utf8").replace(/^\ufeff/, "")); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      const binding = readLocalPerpsBinding(home);
      return binding && (binding.smartAccount !== expectedAccount.toLowerCase() || binding.sessionKeyAddress !== expectedSession.toLowerCase()) ? "changed" : "none";
    }
    const binding = localPerpsBinding(grant);
    if (binding.smartAccount !== expectedAccount.toLowerCase() || binding.sessionKeyAddress !== expectedSession.toLowerCase()) return "changed";
    // Archive first; persist only public identity before deleting the signing
    // grant. A crash cannot lose the owner relationship between the wallets.
    return revokeLocalPerpsGrant(home, () => retainLocalPerpsBinding(grant, home)) === "revoked" ? "stopped" : "none";
  });
}

/**
 * stopLocalPerpsWallet, as one answer: "stopped" when it revoked a grant,
 * which is what a kill answer then says. A paper strategy turned off with no
 * grant beside it is "none": nothing could trade on it. (`merrymen kill` says
 * each part, from stopLocalPerpsWallet.)
 */
export async function stopLocalPerpsForKill(): Promise<"stopped" | "none"> {
  return (await stopLocalPerpsWallet()).grant === "revoked" ? "stopped" : "none";
}

/**
 * A kill's Perps half as a route answers for it: `stopped` when a Perps grant
 * was revoked, `none` when there is none (or only one signed after the kill),
 * `not-stopped` when it could not be done, with the owner-facing reason when
 * there is one they can act on (PerpsKillIncomplete). `left: "paper"` when the
 * grant was dealt with and only the paper strategy could not be turned off, so
 * the answer never says a revoked grant may still sign. Never throws.
 */
export type PerpsHalf = { state: "stopped" | "none" | "not-stopped"; why?: string; left?: "paper" };
export async function perpsHalf(stop: () => Promise<"stopped" | "newer" | "none">): Promise<PerpsHalf> {
  try {
    return { state: (await stop()) === "stopped" ? "stopped" : "none" };
  } catch (e) {
    return {
      state: "not-stopped",
      ...(e instanceof PerpsKillIncomplete ? { why: e.message } : {}),
      ...(e instanceof PerpsPaperNotStopped ? { left: "paper" as const } : {}),
    };
  }
}

/**
 * A self-hosted kill's Perps half for Telegram's answer (kill-confirm.ts):
 * "stopped" when a Perps grant was revoked, null when there was none, and
 * "not-stopped" when it could not be, so the kill is said to be incomplete.
 * "paper-not-stopped" when the grant went but the paper strategy could not be
 * turned off: incomplete too, and said as what it is, not as a live grant.
 */
export async function selfHostedPerpsKill(): Promise<"stopped" | "not-stopped" | "paper-not-stopped" | null> {
  try {
    return (await stopLocalPerpsForKill()) === "stopped" ? "stopped" : null;
  } catch (e) {
    return e instanceof PerpsPaperNotStopped ? "paper-not-stopped" : "not-stopped";
  }
}
