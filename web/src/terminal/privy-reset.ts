/**
 * RESET SIGN-IN, Privy's half only.
 *
 * When Privy cannot start, the browser's own remedy ("clear site data") would
 * also delete this origin's grants, and a stored grant can hold an older
 * agent's owner key (`demoOwnerPrivateKey`, see web/src/lib/session.ts). So
 * this removes exactly what Privy keeps on this origin and nothing else:
 *
 *   - localStorage and sessionStorage keys starting `privy:` (access, refresh
 *     and identity tokens, saved users, OAuth state, the analytics id)
 *   - cookies named `privy-…` (`privy-token`, `privy-refresh-token`,
 *     `privy-id-token`, `privy-session` and their per-user forms), which Privy
 *     writes host-only on path `/`
 *
 * Merrymen's own keys are `merrymen.…`, `merrymen:…` and `merryman.…`, and its
 * session cookie is the server's, so none of them can match.
 *
 * With no saved refresh credential left, Privy's start-up skips the session
 * refresh, so a refresh that fails or never answers cannot hold sign-in on
 * "Loading…" again. It cannot help when something blocks Privy itself.
 */
export const PRIVY_STORAGE_PREFIX = "privy:";
export const PRIVY_COOKIE_PREFIX = "privy-";

export interface PrivyResetScope {
  localStorage?: Storage;
  sessionStorage?: Storage;
  document?: { cookie: string };
}

export interface PrivyResetResult {
  /** `localStorage:<key>` or `sessionStorage:<key>` for each removed key. */
  storage: string[];
  /** Raw names of the expired cookies. */
  cookies: string[];
}

const EXPIRED = "Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/";

export function clearPrivySignIn(
  scope: PrivyResetScope = typeof window === "undefined" ? {} : window,
): PrivyResetResult {
  const storage: string[] = [];
  for (const area of ["localStorage", "sessionStorage"] as const) {
    try {
      // Blocked storage throws on access, not only on use.
      const store = scope[area];
      if (!store) continue;
      const keys: string[] = [];
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i);
        if (key?.startsWith(PRIVY_STORAGE_PREFIX)) keys.push(key);
      }
      for (const key of keys) {
        store.removeItem(key);
        storage.push(`${area}:${key}`);
      }
    } catch {
      // A refused store holds nothing Privy could read back; the cookies
      // below are still worth clearing.
    }
  }

  const cookies: string[] = [];
  const jar = scope.document;
  let header = "";
  try { header = jar?.cookie ?? ""; } catch { header = ""; }
  for (const part of header.split(";")) {
    // Keep the raw (still encoded) name: that is the name the browser matches.
    const name = part.split("=", 1)[0]?.trim();
    if (!jar || !name?.startsWith(PRIVY_COOKIE_PREFIX)) continue;
    try {
      jar.cookie = `${name}=; ${EXPIRED}`;
      cookies.push(name);
    } catch {
      // A refused write leaves that cookie; Privy then refreshes as before.
    }
  }
  return { storage, cookies };
}

/** A seam so tests can observe the reload; jsdom cannot navigate. */
export function reloadPage(): void {
  window.location.reload();
}
