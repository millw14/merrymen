import { parseFleetId, unsupportedFleetIdLabel } from "./fleet-id";

/** Operator-only process hold. It never edits a grant, settings or the ledger. */
export const ACCOUNTING_HOLD_ENV = "MERRYMEN_ACCOUNTING_HOLD_TENANTS";

/**
 * The tenants held, or a throw: a hold that dropped one entry would leave
 * that tenant running. An id that is not 0x and 40 hex (a Solana one, say)
 * refuses the same way, with its own reason: this build cannot hold what it
 * cannot name, and holding the rest would be the partial hold.
 */
export function accountingHoldTenants(env: Record<string, string | undefined>): ReadonlySet<string> {
  const raw = env[ACCOUNTING_HOLD_ENV]?.trim();
  if (!raw) return new Set();
  const held = new Set<string>();
  for (const value of raw.split(",").map((entry) => entry.trim().toLowerCase())) {
    const id = parseFleetId(value);
    if (!id) throw new Error(`${ACCOUNTING_HOLD_ENV} must contain only complete, comma-separated tenant addresses; refusing a partial hold`);
    if (id.kind !== "evm") {
      throw new Error(`${ACCOUNTING_HOLD_ENV} names a tenant that is not a complete Robinhood Chain address (0x and 40 hex), and this build cannot hold another chain's; refusing a partial hold`);
    }
    held.add(id.id);
  }
  return held;
}

export function accountingTenantHeld(tenant: string, env: Record<string, string | undefined> = process.env): boolean {
  return accountingHoldTenants(env).has(tenant.toLowerCase());
}

/** A validated target hold lets the other tenants start while the chain scan runs. */
export async function runAccountingReconstructionAtStartup(args: {
  heldTenants: ReadonlySet<string>;
  reconstruct: () => Promise<void>;
  onError: (error: unknown) => void;
}): Promise<void> {
  const task = Promise.resolve().then(args.reconstruct);
  if (!args.heldTenants.size) { await task; return; }
  // No retry or second task: the operator controls this one startup run. The
  // reconstruction's commit boundary must still check shutdown and its hold.
  void task.catch(args.onError);
}

export interface AccountingMaintenanceLocalState {
  processPresent: boolean;
  localHomePresent: boolean;
}

/** Local preconditions only: the operator must separately verify old deployments are REMOVED. */
export function accountingCommitRefusal(args: {
  mode: string;
  accounts: readonly string[];
  plans: readonly { smartAccount: string; tenant: string | null }[];
  env: Record<string, string | undefined>;
  localState: (tenant: string) => AccountingMaintenanceLocalState;
}): string | null {
  if (args.mode !== "commit") return null;
  const holds = accountingHoldTenants(args.env);
  if (!args.accounts.length) return "commit requires complete, explicitly selected smart-account addresses";
  for (const account of args.accounts) {
    const id = parseFleetId(account);
    if (!id) return "commit requires complete, explicitly selected smart-account addresses";
    if (id.kind !== "evm") return "commit names an account that is not a complete Robinhood Chain address (0x and 40 hex); this build repairs no other chain's";
  }
  for (const account of new Set(args.accounts.map((value) => value.toLowerCase()))) {
    const matches = args.plans.filter((plan) => plan.smartAccount.toLowerCase() === account);
    if (matches.length !== 1 || !matches[0]!.tenant) return `${account}: selected account must resolve to exactly one tenant`;
    const tenant = matches[0]!.tenant!.toLowerCase();
    // Never held, because no hold can name it: said as what it is.
    const owner = parseFleetId(tenant);
    if (owner?.kind !== "evm") return `${account}: resolves to a tenant that is not a Robinhood Chain address (${unsupportedFleetIdLabel(matches[0]!.tenant!)}); this build repairs no other chain's`;
    if (!holds.has(tenant)) return `${account}: tenant ${tenant} must be explicitly held by ${ACCOUNTING_HOLD_ENV}`;
    const local = args.localState(tenant);
    if (local.processPresent) return `${account}: a local process, spawn, restart or exit is still present`;
    if (local.localHomePresent) return `${account}: local tenant state exists; commit requires a fresh container while the hold stays set`;
  }
  return null;
}
