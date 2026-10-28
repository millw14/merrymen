/**
 * WHO THE OPERATOR NAMED, READ THE SAME WAY BY THE WEB AND THE ORCHESTRATOR.
 *
 * MERRYMEN_XPOST_ACTIVE_TENANTS is set on both services: the orchestrator
 * puts the named owners on the active cadence and lets them answer tags, and
 * the web tells those owners so in the reply warning. Two parsers would let
 * the warning and the behaviour disagree about who is active, so there is one.
 * MERRYMEN_XPOST_REPLIES_APPROVED, the operator's gate on replies at all, is
 * read here for the same reason: the web offers the reply switch to exactly
 * the owners the orchestrator will poll and answer for.
 *
 * PURE. It is handed the raw value and reads no environment (boundary.test.ts:
 * only client.ts does), so a test holds every case.
 */

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * THE OPERATOR'S ACTIVE OWNERS, by tenant address only: a name or a handle is
 * not an identity. Lowercased. An entry that is not an address is dropped and
 * reported by its 1-based position, never by value, so a key pasted into the
 * wrong variable never reaches a log; the rest still apply. Unset or blank is
 * nobody.
 */
export function activeTenantsOf(raw: string | undefined | null): { tenants: Set<string>; badEntries: number[] } {
  const tenants = new Set<string>();
  const badEntries: number[] = [];
  const value = (raw ?? "").trim();
  if (!value) return { tenants, badEntries };
  value.split(",").map((v) => v.trim()).filter(Boolean).forEach((v, i) => {
    if (ADDRESS.test(v)) tenants.add(v.toLowerCase());
    else badEntries.push(i + 1);
  });
  return { tenants, badEntries };
}

/**
 * WHO MAY REPLY ON X AT ALL (MERRYMEN_XPOST_REPLIES_APPROVED), before any
 * owner's own reply consent:
 *
 *   "1"      — every owner who consents: comment replies, and an active
 *              owner's answers to tags (the meaning it always had);
 *   "active" — only the owners MERRYMEN_XPOST_ACTIVE_TENANTS names; for
 *              everyone else replies are not approved at all;
 *   unset or blank — nobody.
 *
 * Anything else is nobody too, and `unreadable` says so, so the caller can
 * name the variable in a boot line — never its value. Matched exactly, as
 * the gate always was: " 1 " or "true" is not an approval.
 */
export type RepliesScope = "off" | "all" | "active";

export function repliesScopeOf(raw: string | undefined | null): { scope: RepliesScope; unreadable: boolean } {
  if (raw === "1") return { scope: "all", unreadable: false };
  if (raw === "active") return { scope: "active", unreadable: false };
  return { scope: "off", unreadable: (raw ?? "").trim() !== "" };
}

/** May this owner's agent reply or answer at all, under the operator's scope. Its own consent is still asked separately. */
export function repliesAllowedFor(scope: RepliesScope, activeTenants: ReadonlySet<string>, tenant: string): boolean {
  if (scope === "all") return true;
  return scope === "active" && activeTenants.has(String(tenant ?? "").trim().toLowerCase());
}
