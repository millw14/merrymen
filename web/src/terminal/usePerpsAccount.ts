import { useCallback, useEffect, useState } from "react";
import type { AccountState } from "./HostedControls";
import type { PerpsAccountResponse } from "@/lib/perps-account";
import { deskPerpsOf } from "./live";
import { startRefreshLoop } from "./refresh-loop";

/** Dedicated wallet, same login. Never fill missing Perps data with the Spot book. */
export function usePerpsAccount(session: AccountState["session"] | null) {
  const owner = session?.hosted ? session.address?.toLowerCase() ?? null : null;
  const identity = session ? session.hosted ? owner : "local" : null;
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{ identity: string | null; account: AccountState | null; report: PerpsAccountResponse | null; failed: boolean; busy: boolean }>({ identity: null, account: null, report: null, failed: false, busy: false });
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    if (!session || !identity) { setState({ identity, account: session ? { session, status: { exists: false } } : null, report: null, failed: false, busy: false }); return; }
    let stopped = false; let abort: AbortController | null = null;
    const loop = startRefreshLoop({ everyMs: 30_000, paused: () => document.hidden, report() {}, onFlight(busy) { if (!stopped) setState(s => ({ ...s, busy })); }, pass: async () => {
      abort = new AbortController();
      const timer = setTimeout(() => abort?.abort(), 12_000);
      try {
        const params = new URLSearchParams({ purpose: "perps", ...(owner ? { owner } : {}) });
        const [grantResponse, reportResponse] = await Promise.all([
          fetch(`/api/grants?${params}`, { credentials: "same-origin", cache: "no-store", signal: abort.signal }),
          fetch("/api/perps/account?purpose=perps", { credentials: "same-origin", cache: "no-store", signal: abort.signal }),
        ]);
        if (!grantResponse.ok || !reportResponse.ok) throw new Error("dedicated account unavailable");
        const [status, report] = await Promise.all([grantResponse.json() as Promise<AccountState["status"]>, reportResponse.json() as Promise<PerpsAccountResponse>]);
        if (!status || typeof status.exists !== "boolean" || !report || report.owner !== owner || !["ready", "unread", "not-configured"].includes(report.state)) throw new Error("account owner mismatch");
        if (status.exists && (!status.grant || !report.account || status.grant.smartAccount?.toLowerCase() !== report.account.smartAccount?.toLowerCase() || status.grant.chainId !== report.account.chainId)) throw new Error("account identity mismatch");
        if (!status.exists && report.account !== null) throw new Error("account changed during read");
        if (!stopped) setState({ identity, account: { session, status }, report, failed: false, busy: false });
        return true;
      } catch {
        if (!stopped) setState({ identity, account: null, report: null, failed: true, busy: false });
        return false;
      } finally { clearTimeout(timer); }
    } });
    const wake = () => { if (!document.hidden) loop.wake(); };
    document.addEventListener("visibilitychange", wake);
    return () => { stopped = true; abort?.abort(); loop.stop(); document.removeEventListener("visibilitychange", wake); };
  }, [identity, owner, session?.hosted, revision]);
  const visible = state.identity === identity ? state : { account: null, report: null, failed: false, busy: true };
  return { ...visible, perps: visible.report ? visible.report.perpsAccount?.state === "unreadable" ? undefined : deskPerpsOf({ perps: visible.report.perps, perpsAccount: visible.report.perpsAccount }, Date.now()) : undefined, refresh };
}
