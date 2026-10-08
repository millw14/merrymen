"use client";
import type { ComponentProps } from "react";
import type { LocalAccount } from "viem";
import { PerpsAccount } from "./PerpsAccount";
import type { AccountState } from "./HostedControls";
import { privyEnabled } from "@/lib/privy-client";
import { usePrivyOwner } from "./usePrivyOwner";
import { loadGrant } from "@/lib/session";
import { transferPerpsFunding } from "@/lib/perps-funding";

type Props = ComponentProps<typeof PerpsAccount> & { spotAccount: AccountState | null };
export function PerpsFundingAccount(props: Props) {
  return privyEnabled() ? <PrivyFunding {...props}/> : <Funding {...props} signer={null}/>;
}
function PrivyFunding(props: Props) {
  const owner = usePrivyOwner();
  return <Funding {...props} signer={owner?.account ?? null}/>;
}
function Funding({ spotAccount, signer, ...props }: Props & { signer: LocalAccount | null }) {
  const source = spotAccount?.status.grant;
  const local = typeof window === "undefined" ? null : loadGrant("spot");
  const sameSession = !!spotAccount && !!props.account && spotAccount.session.hosted === props.account.session.hosted &&
    spotAccount.session.address?.toLowerCase() === props.account.session.address?.toLowerCase();
  const available = sameSession && spotAccount?.status.exists && source?.chainId === 4663 &&
    (signer || (local?.demoOwnerPrivateKey && local.smartAccount.toLowerCase() === source.smartAccount.toLowerCase()));
  return <PerpsAccount {...props} fundingSource={available && source ? { address: source.smartAccount, kind: "spot" } : null}
    onTransfer={available && source ? request => transferPerpsFunding({ ...request, expectedSource: source.smartAccount,
      chainId: source.chainId, privyOwnerAccount: signer }) : undefined}/>;
}
