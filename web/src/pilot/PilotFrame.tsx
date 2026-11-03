import type { ReactNode } from "react";
import "./pilot.css";

export function PilotFrame({ children }: { children: ReactNode }) {
  return <div className="pilot-page"><header className="pilot-header"><a className="pilot-brand" href="/home">merrymen</a><nav aria-label="Pilot navigation"><a href="/perps/join">Paper pilot</a><a href="/withdraw?wallet=perps">Withdraw &amp; recover</a></nav></header><main className="pilot-main">{children}</main><footer className="pilot-footer">Paper Perps uses simulated funds. Requests need administrator approval. Approval does not grant trading permission.</footer></div>;
}
