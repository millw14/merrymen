import { safeFetchUrl } from "../../../packages/core/src/safe-url";

/**
 * What a launched token's logo URI is allowed to become.
 *
 * The URI comes from a token contract and is written by whoever launched it,
 * which makes it attacker-controlled by construction. These two functions are
 * the whole allowlist: everything the image proxy will fetch has passed both.
 *
 * They live here rather than in the route because a Next route module may only
 * export route handlers — exporting a helper from one is a build error, and the
 * alternative (leaving them unexported and untested) puts the security-relevant
 * half of the proxy beyond reach of a test.
 */

/** Where an ipfs:// URI or a bare CID gets resolved. Both measured 100% from a server. */
export const GATEWAYS = ["https://ipfs.io/ipfs/", "https://nftstorage.link/ipfs/"];

/** CIDv0 or CIDv1, which is what a bare-CID logo looks like. */
const CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,})$/;

/**
 * Turn whatever the contract said into candidate URLs, most likely first.
 *
 * Returns a LIST because the gateways disagree about which CIDs they hold, and
 * one 404 should not empty the card. Returns [] for anything it will not fetch.
 */
export function resolveLogo(raw: string): string[] {
  const s = raw.trim();
  if (!s) return [];
  if (s.startsWith("ipfs://")) {
    const path = s.slice("ipfs://".length).replace(/^ipfs\//, "");
    return path ? GATEWAYS.map((g) => g + path) : [];
  }
  if (CID_RE.test(s)) return GATEWAYS.map((g) => g + s);
  // Plain https passes through. Plain http does NOT: the app is served over
  // https, so a mixed-content image is blocked by the browser anyway, and
  // proxying it would launder that away rather than fix it.
  if (s.startsWith("https://")) return [s];
  return [];
}

/**
 * Refuse a host that would turn the proxy into a probe of its own network.
 *
 * This client-safe screen is shared with research. The route additionally
 * resolves DNS and pins the actual connection through the Node transport.
 */
export function safeHost(u: URL): boolean {
  return safeFetchUrl(u.href) !== null;
}
