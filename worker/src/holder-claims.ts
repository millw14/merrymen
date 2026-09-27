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
 *   backfillHolderClaims — proofs linked before claims existed have no claim,
 *   and effectiveHolder counts no unclaimed proof. Claimed once at startup in
 *   the order they were proven, so where two accounts linked one wallet the
 *   earlier keeps it.
 *
 * Nothing here moves money or touches a grant; the worst a fault here can do
 * is count a wallet for one account fewer or none, never one more.
 */
import { isHolderProof, type EffectiveHolder, type HolderProof, type MerrymenSettings } from "../../packages/core/src/index";
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
export function childSettingsFor(settings: MerrymenSettings | null, holder: EffectiveHolder | null): MerrymenSettings {
  const { holderAddress: _typedIn, ...rest } = settings ?? {};
  return holder ? { ...rest, holderAddress: holder.address } : rest;
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
  /** Tenants whose settings could not be read; their proofs wait for the next run. */
  unreadable: string[];
}

/**
 * CLAIM EVERY STORED PROOF, IN THE ORDER IT WAS PROVEN.
 *
 * IDEMPOTENT: a claim already held is left alone, and a lost race is a
 * collision logged, not an error — so it is safe at every orchestrator start
 * and on two replicas at once (both walk the same order, so the first claim
 * ever made on a wallet is always its earliest proof's).
 *
 * A tenant whose settings will not open is skipped and named rather than
 * failing the whole run: one sealed blob that will not decrypt must not keep
 * every other linked holder uncounted. The listing itself failing throws —
 * nothing was learnt, so the caller tries again.
 */
export async function backfillHolderClaims(
  store: Pick<SettingsStore, "listTenants" | "get" | "claimHolder">,
  log: (line: string) => void = () => {},
): Promise<BackfillOutcome> {
  const out: BackfillOutcome = { claimed: 0, held: 0, collisions: [], unreadable: [] };
  const rows: ProofRow[] = [];
  for (const tenant of await store.listTenants()) {
    let settings: MerrymenSettings | null;
    try {
      settings = await store.get(tenant);
    } catch (e) {
      out.unreadable.push(tenant);
      log(`holder claims backfill: ${tenant} settings unreadable, skipped — ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const proof = settings?.holderProof;
    if (isHolderProof(proof)) rows.push({ tenant, proof });
  }
  for (const { tenant, proof } of planHolderBackfill(rows)) {
    const r = await store.claimHolder(proof.address, tenant);
    if (!r.ok) {
      out.collisions.push({ tenant, wallet: proof.address, heldBy: r.heldBy });
      log(
        `holder claims backfill: COLLISION — ${tenant} linked ${proof.address} (proven ${new Date(proof.at).toISOString()}), ` +
          `but ${r.heldBy} holds it; it counts only there now`,
      );
    } else if (r.fresh) out.claimed += 1;
    else out.held += 1;
  }
  return out;
}
