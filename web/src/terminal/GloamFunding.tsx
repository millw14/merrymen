"use client";

import { useState } from "react";
import { useT } from "@/lib/i18n";
import { gloamFundingLink } from "@/lib/gloam-funding";

/**
 * A SECOND WAY TO REACH THE SAME ADDRESS, not a second address.
 *
 * Shown in the Add funds panel under the agent account it is about. It reads
 * no session, grant or wallet, signs nothing and posts nothing: the one thing
 * it does is copy the address already on screen and open Gloam's Pay in a new
 * tab. `noreferrer` so Gloam is not told which merrymen page sent the owner.
 *
 * Where the link would not reach the agent (any chain but Robinhood Chain
 * mainnet) it renders nothing. See lib/gloam-funding.ts.
 */
export function GloamFunding({ address, chainId }: { address: string; chainId: number }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const href = gloamFundingLink(chainId);
  if (!href) return null;
  return (
    <>
      <h3>{t("fund.gloam.title")}</h3>
      <p>{t("fund.gloam.body")}</p>
      <p>{t("fund.gloam.public")}</p>
      <p>{t("fund.gloam.steps")}</p>
      <p>{t("fund.gloam.unchanged")}</p>
      <a
        className="flow-secondary"
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={() => {
          // Started inside the click so the browser allows it. A refusal is not
          // an error worth a banner: the address is printed above, selectable.
          void navigator.clipboard?.writeText(address).then(() => setCopied(true), () => {});
        }}
      >
        {copied ? t("fund.gloam.opened") : t("fund.gloam.open")}
      </a>
    </>
  );
}
