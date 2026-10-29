"use client";

import { useState } from "react";
import { useT } from "@/lib/i18n";
import { gloamFundingEnabled, gloamFundingLink } from "@/lib/gloam-funding";

/**
 * A SECOND WAY TO REACH THE SAME ADDRESS, not a second address.
 *
 * Shown in the Add funds panel under the agent account it is about. It reads
 * no session, grant or wallet, signs nothing and posts nothing: the one thing
 * it does is offer copying and opening Gloam as separate actions. A failed
 * clipboard write must not send someone away to paste a stale destination.
 * `noreferrer` keeps the referring Merrymen page out of the navigation.
 *
 * Where the link would not reach the agent (any chain but Robinhood Chain
 * mainnet) it renders nothing. See lib/gloam-funding.ts.
 */
export function GloamFunding({ address, chainId }: { address: string; chainId: number }) {
  const t = useT();
  const [copy, setCopy] = useState<{ address: string; status: "copying" | "copied" | "failed" } | null>(null);
  const href = gloamFundingLink(chainId);
  if (!gloamFundingEnabled() || !href) return null;
  const status = copy?.address === address ? copy.status : null;
  const copyAddress = async () => {
    setCopy({ address, status: "copying" });
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(address);
      setCopy({ address, status: "copied" });
    } catch {
      setCopy({ address, status: "failed" });
    }
  };
  return (
    <>
      <h3>{t("fund.gloam.title")}</h3>
      <p>{t("fund.gloam.body")}</p>
      <p>{t("fund.gloam.public")}</p>
      <p>{t("fund.gloam.beta")}</p>
      <p>{t("fund.gloam.steps")}</p>
      <p>{t("fund.gloam.unchanged")}</p>
      <button
        type="button"
        className="flow-secondary"
        disabled={status === "copying"}
        onClick={() => void copyAddress()}
      >
        {t(status === "copying" ? "fund.gloam.copying" : "fund.gloam.copy")}
      </button>
      {status === "copied" && <p role="status">{t("fund.gloam.copied")}</p>}
      {status === "failed" && <div role="alert">
        <p>{t("fund.gloam.copyFailed")}</p>
        <p className="funding-address">{address}</p>
      </div>}
      <a
        className="flow-secondary"
        href={href}
        target="_blank"
        rel="noopener noreferrer"
      >
        {t("fund.gloam.open")}
      </a>
    </>
  );
}
