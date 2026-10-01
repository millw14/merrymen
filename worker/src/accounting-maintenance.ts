/** Operator-only process hold. It never edits a grant, settings or the ledger. */
export const ACCOUNTING_HOLD_ENV = "MERRYMEN_ACCOUNTING_HOLD_TENANTS";

export function accountingHoldTenants(env: Record<string, string | undefined>): ReadonlySet<string> {
  const raw = env[ACCOUNTING_HOLD_ENV]?.trim();
  if (!raw) return new Set();
  const entries = raw.split(",").map((value) => value.trim().toLowerCase());
  if (entries.some((value) => !/^0x[0-9a-f]{40}$/.test(value))) {
    throw new Error(`${ACCOUNTING_HOLD_ENV} must contain only complete, comma-separated tenant addresses; refusing a partial hold`);
  }
  return new Set(entries);
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
  if (!args.accounts.length || args.accounts.some((account) => !/^0x[0-9a-fA-F]{40}$/.test(account))) {
    return "commit requires complete, explicitly selected smart-account addresses";
  }
  for (const account of new Set(args.accounts.map((value) => value.toLowerCase()))) {
    const matches = args.plans.filter((plan) => plan.smartAccount.toLowerCase() === account);
    if (matches.length !== 1 || !matches[0]!.tenant) return `${account}: selected account must resolve to exactly one tenant`;
    const tenant = matches[0]!.tenant!.toLowerCase();
    if (!holds.has(tenant)) return `${account}: tenant ${tenant} must be explicitly held by ${ACCOUNTING_HOLD_ENV}`;
    const local = args.localState(tenant);
    if (local.processPresent) return `${account}: a local process, spawn, restart or exit is still present`;
    if (local.localHomePresent) return `${account}: local tenant state exists; commit requires a fresh container while the hold stays set`;
  }
  return null;
}
