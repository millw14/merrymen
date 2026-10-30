"use client";

import { useCallback, useEffect, useState } from "react";
import { readPerpsAccount, type PerpsAccountResponse } from "../lib/perps-account";
import { walletUrl } from "../lib/wallet-param";
import type { AccountState } from "./HostedControls";
import { fetchAccountForSession, sameAccountSession } from "./account-session";
import { requestJson } from "./request-json";
import { samePerpsIdentity } from "./perps-client";
import { startRefreshLoop } from "./refresh-loop";

export interface PerpsAccountState { account: AccountState | null; report: PerpsAccountResponse | null; error: string; busy: boolean }
/** A failed private read clears its data. No Spot book or previous owner's data fills the gap. */
export function usePerpsAccount(readReport = true) {
  const [state, setState] = useState<PerpsAccountState>({ account: null, report: null, error: "", busy: true });
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    let active = true;
    const loop = startRefreshLoop({ everyMs: 30_000, paused: () => document.hidden, report() {}, onFlight(busy) { if (active) setState(value => ({ ...value, busy })); }, pass: async () => {
      try {
        const result = await fetchAccountForSession(null, "perps");
        if (result.kind !== "ready") throw new Error("Your Perps wallet could not be verified. Refresh to try again.");
        const { account } = result;
        if (account.status.exists && (!account.status.grant || account.status.grant.purpose !== "perps")) throw new Error("The server did not identify a Perps wallet. Refresh to try again.");
        const signedIn = !account.session.hosted || account.session.address !== null;
        const raw = readReport && signedIn ? await requestJson<unknown>(walletUrl("/api/perps/account", "perps")) : null;
        const report = raw === null ? null : readPerpsAccount(raw);
        if (raw !== null && !report) throw new Error("The Perps report was unreadable. No empty book is assumed.");
        if (report && !samePerpsIdentity(report, account)) throw new Error("Your account changed during the read. Refresh to try again.");
        const after = await requestJson<AccountState["session"]>("/api/auth/session");
        if (!sameAccountSession(account.session, after)) throw new Error("Your sign-in changed. Refresh to load the current wallet.");
        if (active) setState({ account, report, error: "", busy: false });
        return true;
      } catch (error) {
        if (active) setState({ account: null, report: null, error: error instanceof Error ? error.message : "Your Perps wallet could not be read.", busy: false });
        return false;
      }
    } });
    const wake = () => { if (!document.hidden) loop.wake(); };
    document.addEventListener("visibilitychange", wake);
    return () => { active = false; loop.stop(); document.removeEventListener("visibilitychange", wake); };
  }, [readReport, revision]);
  return { ...state, refresh };
}
