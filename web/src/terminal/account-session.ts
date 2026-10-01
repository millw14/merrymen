import type { AccountState } from "./HostedControls";
import type { ReadState } from "./live";
import { requestJson } from "./request-json";

type Session = AccountState["session"];
type Status = AccountState["status"];
const address = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
const validSession = (value: Session): boolean =>
  value !== null && typeof value === "object" && typeof value.hosted === "boolean" &&
  (value.address === null || address(value.address));

/** A session address is the tenant boundary for every private account read. */
export function sameAccountSession(a: Session, b: Session): boolean {
  return a.hosted === b.hosted && a.address?.toLowerCase() === b.address?.toLowerCase();
}

/** A hosted private feed must identify the same tenant as the confirmed grant. */
export function feedMatchesAccount(session: Session | null, feedTenant: string | null | undefined): boolean {
  if (!session) return false;
  if (!session.hosted) return true;
  if (feedTenant === undefined) return false;
  if (feedTenant === null) return session.address === null;
  return address(feedTenant) && session.address?.toLowerCase() === feedTenant.toLowerCase();
}

/** Wait for the first feed answer before treating a missing tenant as a mismatch. */
export function accountFeedRead(session: Session | null, feedTenant: string | null | undefined, read: ReadState): ReadState {
  if (read === "unread") return "unread";
  return feedMatchesAccount(session, feedTenant) ? read : "unreadable";
}

/**
 * Read the session before grants so a login changed in another tab is noticed
 * even when the grant store is unavailable. A second session read catches a
 * change between requests; the grant response's own tenant catches A→B→A,
 * where both session reads could say A while the grant was read for B.
 */
export async function readAccountForSession(
  previous: Session | null,
  readSession: () => Promise<Session>,
  readStatus: () => Promise<Status>,
): Promise<
  | { kind: "changed" }
  | { kind: "unverified"; error: unknown }
  | { kind: "failed"; error: unknown }
  | { kind: "ready"; account: AccountState }
> {
  let session: Session;
  try {
    session = await readSession();
  } catch (error) {
    return { kind: "unverified", error };
  }
  if (!validSession(session)) return { kind: "unverified", error: new Error("Account session was unreadable.") };
  if (previous && !sameAccountSession(previous, session)) return { kind: "changed" };

  let status: Status;
  try {
    status = await readStatus();
  } catch (error) {
    // The cookie can change while grants is in flight. Check it even when that
    // request failed, before deciding an older account is safe to keep.
    try {
      const afterFailure = await readSession();
      if (!validSession(afterFailure)) return { kind: "unverified", error: new Error("Account session was unreadable.") };
      return sameAccountSession(session, afterFailure) ? { kind: "failed", error } : { kind: "changed" };
    } catch (sessionError) {
      return { kind: "unverified", error: sessionError };
    }
  }
  let verifiedSession: Session;
  try {
    verifiedSession = await readSession();
  } catch (error) {
    return { kind: "unverified", error };
  }
  if (!validSession(verifiedSession)) return { kind: "unverified", error: new Error("Account session was unreadable.") };
  if (!sameAccountSession(session, verifiedSession)) return { kind: "changed" };
  if (!status || typeof status !== "object" || typeof status.exists !== "boolean") {
    return { kind: "unverified", error: new Error("Account status was unreadable.") };
  }
  if (verifiedSession.hosted) {
    if (status.tenant === undefined || (status.tenant !== null && !address(status.tenant))) {
      return { kind: "unverified", error: new Error("Account status did not identify its tenant.") };
    }
    if (!sameAccountSession(verifiedSession, { hosted: true, address: status.tenant })) {
      return { kind: "unverified", error: new Error("Account status belongs to a different tenant.") };
    }
  }
  return { kind: "ready", account: { session: verifiedSession, status } };
}

/** The HTTP form of the tenant-bound account read, shared by account screens. */
export function fetchAccountForSession(previous: Session | null) {
  return readAccountForSession(
    previous,
    () => requestJson<Session>("/api/auth/session"),
    () => requestJson<Status>("/api/grants"),
  );
}
