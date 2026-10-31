"use client";
import { PerpsScreen, PerpsLinks } from "./PerpsScreen";
import { PerpsSettings } from "./PerpsSettings";
import { PerpsWallet } from "./PerpsWallet";
import { RecoverPanel } from "../components/RecoverPanel";

/** Recovery never depends on the offering switch or on an active grant. */
export function PerpsWorkspace({ screen, offered }: { screen: string; offered: boolean }) {
  if (screen === "withdraw") return <section className="perps-desk"><h1>Perps withdrawal &amp; recovery</h1><PerpsLinks/><p>The paper book holds simulated funds. If real assets reached this separate account, recover them with its owner wallet. Recovery remains available when paper Perps is switched off.</p><RecoverPanel wallet="perps"/></section>;
  if (screen === "grant" || screen === "create") return <PerpsWallet offered={offered} creating={screen === "create"}/>;
  if (screen === "settings") return <PerpsSettings offered={offered}/>;
  if (screen === "deposit") return <section className="perps-desk"><h1>Paper Perps needs no deposit</h1><PerpsLinks/><p>Real-money perpetual trading and funding are not enabled. Your practice book uses simulated USDG.</p></section>;
  if (!offered) return <section className="perps-desk"><h1>Paper Perps is not offered here</h1><a href="/withdraw?wallet=perps">Withdraw or recover an existing Perps wallet</a></section>;
  return <PerpsScreen/>;
}
