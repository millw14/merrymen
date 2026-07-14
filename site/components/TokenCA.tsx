"use client";

import { useState } from "react";

/**
 * The $MERRYMEN token contract address, verifiable on-chain. Launched via
 * Virtuals on Robinhood Chain (the same chain the agents trade). Factual only
 * — no price, no "buy", no returns; the footer already carries the
 * not-financial-advice line.
 */
const CA = "0xa15cd06dd305269a0f48bebeb30aa3588fba7b32";
const EXPLORER = `https://robinhoodchain.blockscout.com/token/${CA}`;

export function TokenCA() {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(CA);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard blocked — the address is selectable inline */
    }
  };
  return (
    <div className="token-ca">
      <span className="token-ca-label">
        <b>$MERRYMEN</b> token · Robinhood Chain
      </span>
      <code className="token-ca-addr" title={CA}>{CA}</code>
      <button type="button" className="token-ca-btn" onClick={copy}>
        {copied ? "copied ✓" : "copy"}
      </button>
      <a className="token-ca-btn" href={EXPLORER} target="_blank" rel="noreferrer">
        explorer ↗
      </a>
    </div>
  );
}
