/**
 * AN OWNER'S X HANDLE, AND WHETHER IT MAY BECOME A LINK.
 *
 * Two separate questions, and conflating them is the whole hazard:
 *
 *   IS IT SAFE TO PUT IN AN href? — a character-set question. X's own rule is
 *   1–15 of [A-Za-z0-9_], so a handle that passes is a safe path segment with
 *   no scheme, no slash, no query and no traversal.
 *
 *   IS IT TRUE? — an ownership question, which the character set says nothing
 *   about. `xHandle` is typed by the owner and nothing has ever checked they
 *   own it, which is why `packages/core/src/settings.ts` says it "renders
 *   disclaimed and never as a link". Linking an unverified handle makes
 *   merrymen vouch for an association it never checked, and lets an agent
 *   impersonate anyone by typing their name.
 *
 * So: `xProfileUrl` answers the first question only, and callers must ALSO
 * have a proof before rendering an anchor. `web/src/app/api/x-proof` is where
 * the second question is answered.
 *
 * VALIDATION LIVES HERE, AT READ TIME, NOT AT THE WRITE.
 *
 * The hosted settings PUT does apply the regex — but `worker/src/settings.ts`
 * resolves the same field from a self-hosted `settings.json` or
 * `MERRYMEN_X_HANDLE` with only a `.trim()`, no shape check at all, unlike its
 * neighbours which check `/^0x[0-9a-fA-F]{40}$/`. Arbitrary text — including a
 * `javascript:` payload — can therefore already sit in `agents.x_handle` and is
 * mirrored to the shared database. Rows also predate the current regex. A
 * reader that trusts the writer is a reader that ships whatever is in the
 * column straight into an anchor.
 */

/** X's own rule, with an optional leading sigil people type out of habit. */
const HANDLE = /^@?([A-Za-z0-9_]{1,15})$/;

/** The bare handle, or null when it is not one. Never throws. */
export function normaliseXHandle(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const m = HANDLE.exec(raw.trim());
  return m ? m[1]! : null;
}

/**
 * The profile URL, or null.
 *
 * `x.com` rather than `twitter.com`: it is the canonical host now and redirects
 * cost the reader a hop. Returning null rather than a best-effort string is
 * deliberate — a caller that gets null renders plain text, and a dead or
 * hostile link never reaches the page.
 */
export function xProfileUrl(raw: string | null | undefined): string | null {
  const handle = normaliseXHandle(raw);
  return handle ? `https://x.com/${handle}` : null;
}

/** How the handle is shown: always with the sigil, never as a bare word. */
export function xHandleTag(raw: string | null | undefined): string | null {
  const handle = normaliseXHandle(raw);
  return handle ? `@${handle}` : null;
}

/**
 * A wallet address, shortened for a line of prose.
 *
 * The fallback when there is no proven handle. It is plain text by design: an
 * address is a fact we DID check (it is the wallet that signed in), but it is
 * not a social account, so there is nowhere honest for it to link to.
 */
export function shortAddress(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const a = raw.trim();
  if (!/^0x[0-9a-fA-F]{4,}$/.test(a)) return null;
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}
