/**
 * ONE $MERRYMEN WALLET POWERS ONE AGENT — the orchestrator's half.
 *
 * The rule is effectiveHolder (packages/core/src/holder-proof.ts) and the
 * record is the settings store's holder claims. This file is what the
 * orchestrator does with them, kept out of orchestrator.ts so it can be run
 * rather than grepped:
 *
 *   childSettingsFor — the settings.json a child is handed, with the counted
 *   wallet written in or, when no wallet counts, the key DELETED.
 *
 *   lastWrittenHolder — the wallet the orchestrator itself wrote last, kept
 *   for a pass where the claims cannot be read.
 *
 *   backfillHolderClaims — proofs linked before claims existed have no claim,
 *   and effectiveHolder counts no unclaimed proof. Claimed ONCE EVER (a record
 *   in the claims store says so) in the order they were proven, so where two
 *   accounts linked one wallet the earlier keeps it — and a wallet released
 *   since is never handed back to the proof that lost it.
 *
 * Nothing here moves money or touches a grant; the worst a fault here can do
 * is count a wallet for one account fewer or none, never one more.
 */
import { readFileSync } from "node:fs";
import { isHolderProof, type HolderProof, type MerrymenSettings } from "../../packages/core/src/index";
import type { SettingsStore } from "./settings-store";

/**
 * The child's settings: the tenant's own, with `holderAddress` decided here.
 *
 * THE STORED `holderAddress` IS DROPPED FIRST, WHATEVER IT SAYS. It is typed in
 * through the settings screen, shape-checked and nothing more — a claim about
 * anybody's balance — so it is never a fallback. When effectiveHolder names a
 * wallet it is written; when it names none (every candidate is claimed by
 * another account) the key is simply absent. The child resolves file, then
 * env, then default, and MERRYMEN_HOLDER_ADDRESS is stripped from its env, so
 * absent means no holder wallet: circle.ts then reads the agent's own account
 * alone. A self-declared value never survives into the child.
 */
export function childSettingsFor(settings: MerrymenSettings | null, holder: `0x${string}` | null): MerrymenSettings {
  const { holderAddress: _typedIn, ...rest } = settings ?? {};
  return holder ? { ...rest, holderAddress: holder } : rest;
}

/**
 * THE WALLET THE ORCHESTRATOR WROTE INTO THIS CHILD'S settings.json LAST, or
 * null (no file, no key, or not an address).
 *
 * For a pass where the holder claims cannot be read. The rest of settings.json
 * must still be written — a child spawned without one runs the defaults, and
 * the default is paper, which takes a live agent off its real stop-losses — so
 * the one field that needs the claims keeps the answer last derived from
 * claims that COULD be read. Only the orchestrator writes this key into a
 * child's file (the child's own Telegram patches cannot name it), so this is
 * never a self-declared value. A fresh home has no file, and so no wallet: the
 * same fail-closed answer as a settings outage, never a guess.
 */
export function lastWrittenHolder(settingsFile: string): `0x${string}` | null {
  try {
    const prev = JSON.parse(readFileSync(settingsFile, "utf8")) as MerrymenSettings;
    const a = typeof prev.holderAddress === "string" ? prev.holderAddress.toLowerCase() : "";
    return /^0x[0-9a-f]{40}$/.test(a) ? (a as `0x${string}`) : null;
  } catch {
    return null;
  }
}

export interface ProofRow {
  tenant: `0x${string}`;
  proof: HolderProof;
}

/**
 * EARLIEST PROOF FIRST. Two accounts that linked one wallet before claims
 * existed both signed for it; the one who proved it first keeps it. Ties (same
 * millisecond) fall to the lower account address — arbitrary, but the same on
 * every replica, so two replicas backfilling at once agree on every winner.
 */
export function planHolderBackfill(rows: readonly ProofRow[]): ProofRow[] {
  return rows
    .filter((r) => isHolderProof(r.proof))
    .map((r) => ({ tenant: r.tenant.toLowerCase() as `0x${string}`, proof: r.proof }))
    .sort((x, y) => x.proof.at - y.proof.at || (x.tenant < y.tenant ? -1 : x.tenant > y.tenant ? 1 : 0));
}

export interface BackfillOutcome {
  /** Claims this run created. */
  claimed: number;
  /** Proofs whose claim this account already held. */
  held: number;
  /** Proofs whose wallet another account holds — they count nowhere now. */
  collisions: { tenant: string; wallet: string; heldBy: string }[];
  /**
   * Proofs whose wallet an account claimed and let go since — never handed
   * to an old proof; its owner signs again to claim it.
   */
  released: { tenant: string; wallet: string }[];
  /** Tenants whose settings could not be read; their proofs wait for the next run. */
  unreadable: string[];
  /** An earlier run already read every tenant: this one read nothing and claimed nothing. */
  alreadyDone: boolean;
  /** Every tenant has now been read, so no run will ever claim again. */
  done: boolean;
}

/**
 * CLAIM EVERY STORED PROOF, IN THE ORDER IT WAS PROVEN — ONCE EVER.
 *
 * WHY ONCE EVER. The proofs this exists for were linked before claims
 * existed; every proof since was claimed by /api/holder the moment it was
 * made. So after one complete run, every claim a proof deserves exists — and
 * a proof with no claim after that is one whose claim was LET GO on purpose
 * (an unlink, a re-link, a wallet moved away), or the collision loser of the
 * first run. Run again at every start, as it used to be, and the oldest such
 * proof took the released wallet back at the next deploy with nobody signing
 * anything: an unlink undone, and the wallet's own login account emptied
 * again. The store's record (holderBackfill) is what remembers.
 *
 * RETRIED ONLY FOR WHAT IT COULD NOT READ. A tenant whose settings will not
 * open is skipped and named rather than failing the whole run — one sealed
 * blob that will not decrypt must not keep every other linked holder
 * uncounted — and recorded as pending. A retry reads THOSE tenants and no
 * others, so a proof that already lost (or won and was released since) is
 * never looked at twice; and of theirs it claims only a proof made before the
 * first run, since a later one was claimed by the route when it was made.
 *
 * AND NEVER A WALLET SOMEBODY LET GO. Remembering which tenants were read
 * was not enough: a pending tenant's proof could be the loser of a wallet
 * that the first run gave to another account and that account has unlinked
 * since — and a crash after some claims but before the record re-runs the
 * whole first pass over wallets released in between. claimHolder answers
 * `heldBy: null` for any wallet with a release record, so neither path hands
 * a released wallet to an old proof with nobody signing; its owner sees
 * "linked but not counting yet" and signs again.
 *
 * Within a run it is idempotent: a claim already held is left alone, and a
 * lost race is a collision logged, not an error — so two replicas at once
 * agree (both walk the same order, so the first claim ever made on a wallet
 * is always its earliest proof's). It never moves a claim.
 *
 * The record or the listing failing to read throws — nothing was learnt, so
 * the caller tries again. The record is written only after every claim, so a
 * crash mid-run re-runs the whole first pass rather than skipping any of it —
 * safe, because a wallet released in between has a release record.
 */
export async function backfillHolderClaims(
  store: Pick<SettingsStore, "listTenants" | "get" | "claimHolder" | "holderBackfill" | "saveHolderBackfill">,
  log: (line: string) => void = () => {},
  now: number = Date.now(),
): Promise<BackfillOutcome> {
  const out: BackfillOutcome = { claimed: 0, held: 0, collisions: [], released: [], unreadable: [], alreadyDone: false, done: false };
  const prior = await store.holderBackfill();
  if (prior && prior.pending.length === 0) return { ...out, alreadyDone: true, done: true };
  const startedAt = prior?.startedAt ?? now;
  const tenants = prior ? prior.pending : await store.listTenants();
  const rows: ProofRow[] = [];
  for (const tenant of tenants) {
    let settings: MerrymenSettings | null;
    try {
      settings = await store.get(tenant);
    } catch (e) {
      out.unreadable.push(tenant);
      log(`holder claims backfill: ${tenant} settings unreadable, skipped — ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const proof = settings?.holderProof;
    if (isHolderProof(proof) && proof.at <= startedAt) rows.push({ tenant, proof });
  }
  for (const { tenant, proof } of planHolderBackfill(rows)) {
    const r = await store.claimHolder(proof.address, tenant);
    if (!r.ok && r.heldBy === null) {
      out.released.push({ tenant, wallet: proof.address });
      log(
        `holder claims backfill: ${tenant} linked ${proof.address} (proven ${new Date(proof.at).toISOString()}), ` +
          `but an account has claimed and let it go since — left free; a fresh signature claims it`,
      );
    } else if (!r.ok) {
      out.collisions.push({ tenant, wallet: proof.address, heldBy: r.heldBy });
      log(
        `holder claims backfill: COLLISION — ${tenant} linked ${proof.address} (proven ${new Date(proof.at).toISOString()}), ` +
          `but ${r.heldBy} holds it; it counts only there now`,
      );
    } else if (r.fresh) out.claimed += 1;
    else out.held += 1;
  }
  // Only an address can ever hold a claim, so only an address is worth
  // reading again.
  const pending = out.unreadable
    .map((t) => t.toLowerCase())
    .filter((t): t is `0x${string}` => /^0x[0-9a-f]{40}$/.test(t));
  await store.saveHolderBackfill({ startedAt, pending });
  out.done = pending.length === 0;
  return out;
}
