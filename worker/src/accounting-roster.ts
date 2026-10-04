/** Read-only ownership resolution for an explicitly scoped accounting repair. */
export interface ReconstructionGrant {
  tenant: string;
  smartAccount: string;
  owner: string | null;
  chainId: number;
  custodyAddresses: readonly string[];
}

export interface ReconstructionRoster {
  agents: Record<string, unknown>[];
  tenantByAccount: Map<string, string>;
  custodyVaults: Map<string, readonly string[]>;
  /** A conflicting claim must not be resolved by input order or by a grant. */
  refusals: Map<string, string>;
  rosterOnly: number;
}

const address = (value: unknown): string | null =>
  typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null;
const number = (value: unknown, fallback: number): number =>
  value === null || value === undefined ? fallback : Number(value);

/** Same current-row order as the public ledger readers, retaining raw spelling. */
function currentFirst(a: Record<string, unknown>, b: Record<string, unknown>): number {
  for (const [column, fallback] of [["epoch", 1], ["beat_at", 0], ["created_at", 0]] as const) {
    const difference = number(b[column], fallback) - number(a[column], fallback);
    if (difference) return difference;
  }
  const left = String(a.smart_account), right = String(b.smart_account);
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * A removed grant does not erase its durable account claim. Claims may supply
 * the tenant to hold, never signing permission or a custody vault. Financial
 * rows still come from the ledger, and the repair's exact snapshot/epoch guards
 * remain responsible for whether those rows can be changed.
 */
export function reconstructionRoster(args: {
  ledgerAgents: readonly Record<string, unknown>[];
  grants: readonly ReconstructionGrant[];
  claims: readonly Record<string, unknown>[];
}): ReconstructionRoster {
  const result: ReconstructionRoster = {
    agents: [], tenantByAccount: new Map(), custodyVaults: new Map(), refusals: new Map(), rosterOnly: 0,
  };
  const aliases = new Map<string, Record<string, unknown>[]>();
  const grantRows = new Map<string, ReconstructionGrant[]>();
  const claimTenants = new Map<string, Set<string>>();
  const refuse = (account: string, why: string) => {
    if (!result.refusals.has(account)) result.refusals.set(account, why);
  };
  for (const row of args.ledgerAgents) {
    const account = address(row.smart_account);
    if (!account) continue;
    const rows = aliases.get(account) ?? [];
    rows.push(row);
    aliases.set(account, rows);
  }
  for (const grant of args.grants) {
    const account = address(grant.smartAccount);
    if (!account) continue;
    const rows = grantRows.get(account) ?? [];
    rows.push(grant);
    grantRows.set(account, rows);
  }
  for (const claim of args.claims) {
    const account = address(claim.smart_account);
    if (!account) continue;
    const tenant = address(claim.tenant);
    if (!tenant) { refuse(account, "durable account claim has an invalid tenant"); continue; }
    const tenants = claimTenants.get(account) ?? new Set<string>();
    tenants.add(tenant);
    claimTenants.set(account, tenants);
  }

  // A claim with no financial row and no grant is not a new financial account.
  for (const account of new Set([...aliases.keys(), ...grantRows.keys()])) {
    const rows = (aliases.get(account) ?? []).slice().sort(currentFirst);
    const grants = grantRows.get(account) ?? [];
    const owners = new Set<string>();
    const chains = new Set<number>();
    for (const row of rows) {
      if (row.owner_address !== null && row.owner_address !== undefined) {
        const owner = address(row.owner_address);
        if (!owner) refuse(account, "ledger account alias has an invalid owner");
        else owners.add(owner);
      }
      const chain = number(row.chain_id, 0);
      if (!Number.isSafeInteger(chain) || chain <= 0) refuse(account, "ledger account alias has an invalid chain");
      else chains.add(chain);
      if (!Number.isSafeInteger(number(row.epoch, 1)) || number(row.epoch, 1) < 1 ||
          !Number.isSafeInteger(number(row.beat_at, 0)) || !Number.isSafeInteger(number(row.created_at, 0))) {
        refuse(account, "ledger account alias has invalid current-row ordering");
      }
    }
    const tenants = new Set<string>();
    const custody = new Map<string, readonly string[]>();
    for (const grant of grants) {
      const tenant = address(grant.tenant);
      if (!tenant) refuse(account, "grant account has an invalid tenant");
      else tenants.add(tenant);
      if (grant.owner !== null) {
        const owner = address(grant.owner);
        if (!owner) refuse(account, "grant account has an invalid owner");
        else owners.add(owner);
      }
      if (!Number.isSafeInteger(grant.chainId) || grant.chainId <= 0) refuse(account, "grant account has an invalid chain");
      else chains.add(grant.chainId);
      const vaults = [...new Set(grant.custodyAddresses.map(address))];
      if (vaults.some((vault) => vault === null)) refuse(account, "grant custody address is invalid");
      else custody.set(JSON.stringify((vaults as string[]).sort()), grant.custodyAddresses);
    }
    if (owners.size > 1) refuse(account, "ledger or grant account aliases disagree about the owner");
    if (chains.size > 1) refuse(account, "ledger or grant account aliases disagree about the chain");
    if (custody.size > 1) refuse(account, "grant account aliases disagree about custody");
    const claims = claimTenants.get(account) ?? new Set<string>();
    if (claims.size > 1) refuse(account, "durable account aliases resolve to multiple tenants");
    if (tenants.size > 1) refuse(account, "grant account aliases resolve to multiple tenants");
    for (const tenant of claims) tenants.add(tenant);
    if (tenants.size > 1) refuse(account, "grant and durable account claim resolve to different tenants");

    const current = rows[0];
    if (current) result.agents.push(current);
    else if (grants[0]) {
      result.rosterOnly += 1;
      result.agents.push({ smart_account: grants[0].smartAccount, owner_address: grants[0].owner,
        chain_id: grants[0].chainId, epoch: 1, mode: null, hwm_usdg: 0, contributions_known: null });
    }
    if (result.refusals.has(account)) continue;
    // No grant: exactly one normalized, valid durable tenant is required.
    if (tenants.size === 1) result.tenantByAccount.set(account, [...tenants][0]!);
    const vaults = [...custody.values()][0];
    if (vaults?.length) result.custodyVaults.set(account, vaults);
  }
  return result;
}
