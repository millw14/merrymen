/**
 * What this system is willing to fetch from a URL somebody else chose.
 *
 * ONE DEFINITION, THREE CALLERS. The image proxy wrote the first version of this
 * because a token's logo URI comes from a token contract, which makes it
 * attacker-chosen by construction. The research browser has exactly the same
 * hazard and worse consequences — it runs a real browser, on a box with private
 * network neighbours — so the guard moved here rather than being written twice.
 * Two copies of a security check are one copy and one liability.
 *
 * This module is client-safe URL screening, not a transport. Server callers
 * additionally resolve and pin a public address using server/public-network.ts.
 */

/** Only globally routable addresses are acceptable outbound destinations. */
export function isPublicAddress(raw: string): boolean {
  const address = raw.toLowerCase().replace(/^\[|\]$/g, "");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(address)) {
    const octets = address.split(".").map(Number);
    if (octets.some((n) => n > 255)) return false;
    const [a = 0, b = 0, c = 0] = octets;
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  if (!address.includes(":")) return false;
  // Canonicalization rejects malformed IPv6 and converts embedded IPv4. Permit
  // global unicast only: mapped IPv4, NAT64, local and transition ranges stay
  // refused regardless of how the operating system would route them.
  let normalized: string;
  try { normalized = new URL(`https://[${address}]/`).hostname.slice(1, -1); }
  catch { return false; }
  const [first = "", second = ""] = normalized.split(":");
  const a = Number.parseInt(first, 16);
  const b = Number.parseInt(second || "0", 16);
  return a >= 0x2000 && a <= 0x3fff &&
    !(a === 0x2001 && (b <= 0x1ff || b === 0xdb8)) &&
    a !== 0x2002 && !(a === 0x3fff && b <= 0x0fff);
}

/**
 * Cloud metadata endpoints, by address rather than by name.
 *
 * 169.254.169.254 is covered by the link-local range above, but it earns its own
 * mention: it is the single most valuable address to an attacker who can make
 * this system fetch a URL, because on most clouds it hands out credentials to
 * anything that asks.
 */
export const METADATA_HOSTS = ["169.254.169.254", "metadata.google.internal", "metadata"] as const;

export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (!h) return true;
  if (h.includes(":") || /^[\d.]+$/.test(h)) return !isPublicAddress(h);
  if (!h.includes(".") || h === "localhost" || h.endsWith(".localhost")) return true;
  // Railway puts every service on `*.railway.internal`, so this is not
  // hypothetical here: the orchestrator, the database and the web service are
  // all reachable by name from the same network the browser sits on.
  if (h.endsWith(".internal") || h.endsWith(".local")) return true;
  if ((METADATA_HOSTS as readonly string[]).includes(h)) return true;
  return false;
}

/**
 * Is this a URL we will fetch at all?
 *
 * HTTPS ONLY, and plain http is refused rather than upgraded. The app is served
 * over https, so a mixed-content resource is blocked by the browser anyway —
 * fetching it server-side would launder that away instead of fixing it, and a
 * plaintext fetch is also the one an on-path attacker can rewrite.
 */
export function safeFetchUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  if (isPrivateHost(u.hostname)) return null;
  // Credentials in a URL are never something we want to send on someone's
  // behalf, and their presence usually means the URL was crafted.
  if (u.username || u.password) return null;
  return u;
}

/** True when the URL is one we are willing to fetch. */
export function isSafeFetchUrl(raw: string): boolean {
  return safeFetchUrl(raw) !== null;
}
