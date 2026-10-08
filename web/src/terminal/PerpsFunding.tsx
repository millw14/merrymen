import { useEffect, useRef, useState } from "react";
import { LIGHTER_ROUTE_V1 } from "@merrymen/core";
import { FundingPreparationError } from "@/lib/perps-funding-intent";

export type PerpsFundingSource = { address: string; kind: "spot" | "owner" };
export type PerpsTransfer = (request: { amountMicro: string; expectedAccount: string; expectedOwner: string | null }) => Promise<{ hash: string; status: "confirmed" | "submitted" }>;
export function perpsFundingMicro(value: string): string | null {
  const text = value.trim();
  if (!/^\d{1,72}(?:\.\d{1,6})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  const micro = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  return micro > 0n && micro < (1n << 256n) ? micro.toString() : null;
}
function exactUsdg(micro: string): string {
  const amount = BigInt(micro);
  const fraction = String(amount % 1_000_000n).padStart(6, "0").replace(/0+$/, "");
  return `${amount / 1_000_000n}${fraction ? `.${fraction}` : ""}`;
}
type Props = {
  account: string; chainId: number; owner: string | null; source: PerpsFundingSource | null;
  onTransfer?: PerpsTransfer; onClose: () => void; onConfirmed?: () => void;
};
export function PerpsFunding(props: Props) {
  return <Funding key={`${props.owner}:${props.account}:${props.chainId}:${props.source?.address}:${props.source?.kind}`} {...props}/>;
}
function Funding({ account, chainId, owner, source, onTransfer, onClose, onConfirmed }: Props) {
  const [draft, setDraft] = useState("");
  const [review, setReview] = useState<string | null>(null);
  const [result, setResult] = useState<{ hash: string; status: "confirmed" | "submitted" } | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const attempted = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const validAddress = /^0x[a-fA-F0-9]{40}$/.test(account);
  const supported = validAddress && chainId === LIGHTER_ROUTE_V1.chainId;
  const available = supported && !!source && /^0x[a-fA-F0-9]{40}$/.test(source.address) && source.address.toLowerCase() !== account.toLowerCase() && !!onTransfer;
  async function transfer() {
    if (!available || !review || attempted.current || !onTransfer) return;
    attempted.current = true; setBusy(true); setNote("");
    try {
      const next = await onTransfer({ amountMicro: review, expectedAccount: account, expectedOwner: owner });
      if (!/^0x[a-fA-F0-9]{64}$/.test(next.hash) || !["confirmed", "submitted"].includes(next.status)) throw new Error("unreadable transfer response");
      if (!mounted.current) return;
      setResult(next);
      if (next.status === "confirmed") onConfirmed?.();
    } catch (error) {
      if (mounted.current && error instanceof FundingPreparationError) {
        attempted.current = false;
        setNote(`${error.message} No new transfer was submitted.`);
      } else if (mounted.current) setNote("Transfer outcome is not confirmed. Check the source wallet and transaction history before starting another transfer. This request will not be retried automatically.");
    } finally { if (mounted.current) setBusy(false); }
  }
  return <section className="hosted-funding" aria-label="Fund your Perps wallet">
    <header className="flow-top"><h2>Add USDG to Perps</h2><button type="button" disabled={busy} onClick={onClose}>Close funding</button></header>
    {!supported ? <p>Funding is unavailable for this account’s network.</p> : <>
      <p>Destination: your dedicated Perps wallet on Robinhood Chain (4663).</p><p className="funding-address">{account}</p>
      {!available ? <><p>No supported signing source is connected. You can send USDG to this address from your wallet on Robinhood Chain.</p><button type="button" onClick={() => { void navigator.clipboard.writeText(account).then(() => setNote("Perps address copied.")).catch(() => setNote("Could not copy. Select the address above.")); }}>Copy Perps deposit address</button></> : <>
        <p>Transfers from a Spot wallet use its ETH for network fees.</p>
        <p>Source: {source!.kind === "spot" ? "your Spot agent wallet" : "your signed-in owner wallet"}.</p><p className="funding-address">{source!.address}</p>
        {!review ? <form onSubmit={event => { event.preventDefault(); const parsed = perpsFundingMicro(draft); if (!parsed) { setNote("Enter a positive USDG amount with at most six decimal places."); return; } setNote(""); setReview(parsed); }}>
          <label htmlFor="perps-funding-amount">USDG to transfer</label><input id="perps-funding-amount" inputMode="decimal" autoComplete="off" value={draft} onInput={event => setDraft(event.currentTarget.value)}/><button type="submit">Review transfer</button>
        </form> : <>
          <p>Transfer exactly <strong>{exactUsdg(review)} USDG</strong> to your Perps wallet. This moves real funds; it does not change the collateral ceiling or enable trading.</p>
          {!attempted.current && <><button type="button" onClick={() => setReview(null)}>Change amount</button><button type="button" onClick={() => void transfer()}>Confirm USDG transfer</button></>}
          {busy && <p role="status">Waiting for your signature and transfer result…</p>}
          {result && <p role="status">{result.status === "confirmed" ? "Transfer confirmed." : "Confirmation is pending or the submission outcome is unknown. Do not send it again."} Operation hash: <code>{result.hash}</code></p>}
        </>}
      </>}
    </>}
    {note && <p role="status">{note}</p>}
  </section>;
}
