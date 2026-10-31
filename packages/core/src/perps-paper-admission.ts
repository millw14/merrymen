/** The paper pilot admits explicit owner addresses; a missing or malformed list admits nobody. */
export function perpsPaperTenantAllowed(owner: string, env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const raw = env.MERRYMEN_PERPS_PAPER_TENANTS;
  if (!raw || !/^0x[0-9a-f]{40}$/i.test(owner)) return false;
  const entries = raw.split(",").map(value => value.trim().toLowerCase());
  return entries.length <= 100 && entries.every(value => /^0x[0-9a-f]{40}$/.test(value)) && entries.includes(owner.toLowerCase());
}
