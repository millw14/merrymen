"use client";

import { useEffect, useRef, useState } from "react";
import { formatEther, formatUnits, type Address } from "viem";
import { usePrivyOwner } from "./usePrivyOwner";
import { redact, type BrowserWallet } from "@/lib/recover-client";
import type { GloamWithdrawalRecord } from "@/lib/gloam-withdrawal";
import type * as WithdrawalClient from "@/lib/gloam-withdrawal-client";

const ENABLED = process.env.NEXT_PUBLIC_GLOAM_WITHDRAWALS_ENABLED === "1";
const productionClient = () => import("@/lib/gloam-withdrawal-client");

export function GloamWithdrawal({ account, chainId, ownerKey }: { account: Address; chainId: number; ownerKey?: `0x${string}` }) {
  return ENABLED && chainId === 4663 ? <SignedInWithdrawal key={`${chainId}:${account}`} account={account} chainId={chainId} ownerKey={ownerKey} /> : null;
}

function SignedInWithdrawal({ account, chainId, ownerKey }: { account: Address; chainId: number; ownerKey?: `0x${string}` }) {
  const privyOwner = usePrivyOwner();
  const wallet: BrowserWallet = { smartAccount: account, chainId, ...(ownerKey ? { ownerKey } : { ownerAccount: privyOwner?.account }) };
  return <GloamWithdrawalView wallet={wallet} />;
}

/** The view can be tested without a wallet, chain, proving files or private keys. */
export function GloamWithdrawalView({ wallet, client = productionClient }: {
  wallet: BrowserWallet;
  client?: () => Promise<typeof WithdrawalClient>;
}) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [receiveTag, setReceiveTag] = useState("");
  const [record, setRecord] = useState<GloamWithdrawalRecord | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const active = useRef(false);

  useEffect(() => {
    let current = true;
    void client().then((api) => {
      const saved = api.loadGloamWithdrawal(wallet.smartAccount);
      if (current) { setRecord(saved); setLoaded(true); if (saved) setOpen(true); }
    }).catch((e) => { if (current) setError(redact(e, wallet.ownerKey)); });
    return () => { current = false; };
  }, [client, wallet.smartAccount, wallet.ownerKey]);

  async function action(run: (api: typeof WithdrawalClient) => Promise<void>) {
    if (active.current) return;
    active.current = true;
    setBusy(true); setError("");
    try { await run(await client()); }
    catch (e) {
      // Preserve the authoritative signed journal even when a network request times out.
      try { setRecord((await client()).loadGloamWithdrawal(wallet.smartAccount)); } catch { /* keep the existing disclosure */ }
      setError(redact(e, wallet.ownerKey));
    } finally { active.current = false; setBusy(false); setStatus(""); }
  }

  function backup() {
    if (!record) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(record, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `gloam-withdrawal-${record.commitment.slice(2, 14)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const hasSigner = Boolean(wallet.ownerKey || wallet.ownerAccount);
  const pending = record?.state === "signed";
  const final = record?.state === "confirmed" || record?.state === "reverted";
  const gasCeiling = record ? BigInt(record.operation.maxFeePerGas) *
    (BigInt(record.operation.callGasLimit) + BigInt(record.operation.verificationGasLimit) + BigInt(record.operation.preVerificationGas)) : null;

  return <section className="gloam-withdrawal">
    <button type="button" className="flow-secondary" aria-expanded={open} onClick={() => setOpen(!open)}>Withdraw USDG to Gloam</button>
    {open && <>
      <h3>Withdraw to your private Gloam balance</h3>
      <p>Optional beta on Robinhood Chain. You approve each withdrawal with your owner wallet. Your agent receives no new spending permissions.</p>
      <p>The amount and transfer from this agent into Gloam remain public. Gloam is beta software; its external audit is still pending. Later cash-outs from Gloam have their own fees.</p>
      {!hasSigner && <p role="status">Sign in with this agent’s owner wallet, or use the regular recovery option below.</p>}
      {!loaded && !error && <p role="status">Checking for a saved withdrawal…</p>}
      {loaded && !record && <form onSubmit={(event) => { event.preventDefault(); void action(async (api) => {
        const prepared = await api.prepareGloamWithdrawal(wallet, receiveTag, amount, setStatus);
        setRecord(prepared); setConfirmed(false);
      }); }}>
        <label htmlFor="gloam-amount">Amount in USDG</label>
        <input id="gloam-amount" className="recover-input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={busy} autoComplete="off" placeholder="20" required />
        <p>Up to 500 USDG per withdrawal. Only available USDG is moved; investments are not sold.</p>
        <label htmlFor="gloam-recipient">Your Gloam receive address</label>
        <textarea id="gloam-recipient" className="recover-input" rows={3} value={receiveTag} onChange={(e) => setReceiveTag(e.target.value)} disabled={busy} autoComplete="off" spellCheck={false} placeholder="gloamr1.…" required />
        <p>Copy your receive address from Gloam. Never paste a private key, recovery phrase or private payment note here.</p>
        <button type="submit" className="flow-primary" disabled={busy || !hasSigner}>Review withdrawal</button>
      </form>}
      {record && <>
        <dl>
          <dt>From your agent</dt><dd className="funding-address">{record.account}</dd>
          <dt>Amount</dt><dd>{formatUnits(BigInt(record.amount), 6)} USDG</dd>
          <dt>Gloam receive address</dt><dd className="funding-address" style={{ overflowWrap: "anywhere" }}>{record.receiveTag}</dd>
          <dt>Network</dt><dd>Robinhood Chain mainnet</dd>
          <dt>Maximum network fee</dt><dd>{gasCeiling === null ? "Not estimated" : formatEther(gasCeiling)} ETH, paid from your agent’s account</dd>
        </dl>
        <button type="button" className="flow-secondary" onClick={backup}>Download encrypted receipt</button>
        <p>This receipt contains the encrypted payment and transaction details, not your private keys. Your Gloam receive key is needed to claim it.</p>
        {record.state === "prepared" && <>
          <label><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} disabled={busy} /> I checked this is my Gloam address and I can access its private balance.</label>
          <button type="button" className="flow-primary" disabled={busy || !hasSigner || !confirmed} onClick={() => void action(async (api) => {
            setRecord(await api.approveGloamWithdrawal(wallet, record.hash, setStatus));
          })}>Approve {formatUnits(BigInt(record.amount), 6)} USDG withdrawal</button>
        </>}
        {pending && <>
          <p role="status">This withdrawal is saved. Checking it will reuse the same transaction, so a lost connection cannot create a second payment.</p>
          <button type="button" className="flow-primary" disabled={busy || !hasSigner} onClick={() => void action(async (api) => {
            setRecord(await api.approveGloamWithdrawal(wallet, record.hash, setStatus));
          })}>Check saved withdrawal</button>
        </>}
        {record.state === "confirmed" && <p role="status">Deposit confirmed. Open your Gloam account on Robinhood Chain to find and claim this payment into your private balance.</p>}
        {record.state === "reverted" && <p role="alert">The withdrawal reverted. No USDG was deposited by this operation; a network fee may have been spent.</p>}
        {record.transactionHash && <a target="_blank" rel="noopener noreferrer" href={`https://robin.etherscan.io/tx/${record.transactionHash}`}>View transaction</a>}
        {record.state === "confirmed" && <a className="flow-secondary" href="https://www.gloam.trade/app/vault" target="_blank" rel="noopener noreferrer">Open Gloam</a>}
        {(record.state === "prepared" || final) && <button type="button" className="flow-secondary" disabled={busy} onClick={() => void action(async (api) => {
          await api.clearGloamWithdrawal(wallet); setRecord(null); setConfirmed(false);
        })}>{final ? "Start another withdrawal" : "Cancel unsigned withdrawal"}</button>}
      </>}
      {status && <p role="status">{status}</p>}
      {error && <p role="alert">{error}</p>}
    </>}
  </section>;
}
