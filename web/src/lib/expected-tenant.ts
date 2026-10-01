/**
 * A stale page can send a destructive request with a newer tab's cookie. The
 * authenticated cookie says who can act; this claim says whose account the
 * page showed when the owner clicked. Hosted destructive routes require both
 * to name the same tenant before they touch a grant or queue a reset.
 */
export async function expectedTenantMatches(req: Request, tenant: `0x${string}`): Promise<boolean> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return false;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const claimed = (body as { expectedTenant?: unknown }).expectedTenant;
  return typeof claimed === "string" && /^0x[0-9a-fA-F]{40}$/.test(claimed) &&
    claimed.toLowerCase() === tenant.toLowerCase();
}
