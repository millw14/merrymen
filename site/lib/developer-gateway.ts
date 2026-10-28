/**
 * The gateway's /developer/v1 routes, as this site's SERVER reaches them.
 *
 * Server-only: it reads MERRYMEN_DEVELOPER_PORTAL_SECRET. The proxy route and
 * the /api page import it; the console (a client component) must not, and
 * imports developer-billing.ts instead.
 */
import { FALLBACK_PLANS, normalizePlans, type PlansView } from "./developer-billing";

/**
 * Where the portal credential goes, or null to fail closed.
 *
 * MERRYMEN_DEVELOPER_GATEWAY_ORIGIN points a preview or local site at another
 * gateway. The secret travels with every request, so the override must be a
 * bare https origin (plain http only on localhost), and a malformed one is
 * refused rather than ignored. The secret needs 32+ bytes, as the gateway
 * already requires: a shorter one could only ever be refused there.
 */
export function developerGateway(): { origin: string; secret: string } | null {
  const secret = process.env.MERRYMEN_DEVELOPER_PORTAL_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32) { console.error("[developer] MERRYMEN_DEVELOPER_PORTAL_SECRET is unset or under 32 bytes"); return null; }
  try {
    const url = new URL(process.env.MERRYMEN_DEVELOPER_GATEWAY_ORIGIN || "https://ai.merrymen.dev");
    const local = url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
    if ((url.protocol === "https:" || local) && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash) return { origin: url.origin, secret };
  } catch { /* Reported below. */ }
  console.error("[developer] MERRYMEN_DEVELOPER_GATEWAY_ORIGIN must be an https origin, or http on localhost");
  return null;
}

/** How long a rendered Plans section may be reused. Short: a treasury or mode change should show within a minute. */
export const PLANS_REVALIDATE_SEC = 60;

/**
 * GET /plans for the public Plans section, or the static table when the
 * gateway cannot be asked or answers with something unusable. The fallback
 * carries no treasury, so a page rendered from it never offers a payment.
 *
 * No session is sent: plans are the same for everyone, which is also what
 * makes the answer safe to cache for every reader.
 */
export async function fetchPlans(): Promise<PlansView> {
  const target = developerGateway();
  if (!target) return FALLBACK_PLANS;
  // `next` is Next's fetch-cache option; a variable rather than a literal so
  // the type check does not depend on Next's global RequestInit augmentation.
  const init: RequestInit & { next?: { revalidate: number } } = { headers: { authorization: `Bearer ${target.secret}` }, redirect: "error",
    signal: AbortSignal.timeout(5_000), next: { revalidate: PLANS_REVALIDATE_SEC } };
  try {
    const response = await fetch(`${target.origin}/developer/v1/plans`, init);
    const plans = response.ok ? normalizePlans(await response.json()) : null;
    if (plans) return plans;
    console.error(`[developer] GET /plans answered ${response.status} without usable plans; showing the static table`);
  } catch { console.error("[developer] GET /plans unreachable; showing the static table"); }
  return FALLBACK_PLANS;
}
