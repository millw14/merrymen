"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { CreateAgent } from "@/terminal/screens/CreateAgent";
import { fetchAccountForSession } from "@/terminal/account-session";
import type { AccountState } from "@/terminal/HostedControls";
import { BrandLockup } from "../../BrandLockup";

/** One owner screen for the proposed setup, limits, approval and signing. */
export function SetupClient({ id }: { id: string }) {
  const [account, setAccount] = useState<AccountState | null>(null);
  const [failed, setFailed] = useState(false);
  const [reading, setReading] = useState(false);
  const readVersion = useRef(0);
  const owner = account?.session.address?.toLowerCase() ?? null;

  const refresh = useCallback(async () => {
    const version = ++readVersion.current;
    setReading(true);
    const result = await fetchAccountForSession(null);
    if (version !== readVersion.current) return;
    if (result.kind === "ready") {
      setAccount(result.account);
      setFailed(false);
    } else {
      // Do not keep an old tenant's setup visible after an unverified read.
      setAccount(null);
      setFailed(true);
    }
    setReading(false);
  }, []);

  useEffect(() => { void refresh(); return () => { readVersion.current++; }; }, [refresh]);
  const signedIn = () => {
    setAccount(null);
    void refresh();
  };

  return <div className="terminal-host partner-connect mcp-wallet-setup">
    <header className="connect-header">
      <BrandLockup />
      <span className="connect-header-label"><ShieldCheck size={14} aria-hidden /> Secure agent setup</span>
    </header>
    <main className="mcp-setup-main">
      <section className="connect-panel connect-panel-setup" aria-label="Finish your assistant setup" aria-busy={reading}>
        <CreateAgent
          key={`${id}:${account?.session.hosted}:${owner ?? "signed-out"}`}
          assistantProposalId={id}
          account={account}
          accountFailed={failed}
          retrying={reading}
          onRefresh={() => void refresh()}
          onSignedIn={signedIn}
          onBack={() => window.location.assign("/connect/apps")}
          onDone={() => window.location.assign("/agent")}
          onFund={() => window.location.assign("/deposit")}
        />
      </section>
      <p className="mcp-setup-note">Review once here, then manage your Merryman from the same chat. Nothing is signed until you choose to create it.</p>
    </main>
    <footer className="connect-footer">Only your wallet can authorize trading. Manage assistant access at <a href="/connect/apps">Connected apps</a>.</footer>
  </div>;
}
