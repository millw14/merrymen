/**
 * FUNDING AN AGENT FROM A PRIVATE GLOAM BALANCE. See docs/gloam-private-funding.md.
 *
 * Gloam (gloam.trade) keeps stablecoin balances in a shielded pool on Robinhood
 * Chain. An owner with a private balance there can pay any 0x address from it,
 * and Gloam's relay submits the payment, so the USDG reaches the agent account
 * from the pool and not from the owner's wallet.
 *
 * NOTHING HERE MOVES MONEY OR TOUCHES THE AGENT'S AUTHORITY. This module only
 * says where to send the owner. The agent account, its signed permission, its
 * caps and its recovery are exactly what they were: the payment lands as an
 * ordinary USDG transfer into the same address the panel already shows, and the
 * deposit scanner books it like any other (capital-classify.ts, `no-pair-external`).
 *
 * ROBINHOOD CHAIN MAINNET ONLY. Gloam runs on several networks and the agent's
 * address exists on all of them, but only USDG on chain 4663 reaches the agent.
 * Every other chain gets no link at all rather than one that strands funds.
 *
 * THE LINK CARRIES NOTHING ABOUT THE AGENT. Gloam's payment links today take a
 * Gloam receive address (`gloamr1.`) as the recipient, not a 0x one: a link
 * naming the agent's address would open with that field rejected. So this opens
 * Pay on its own and the owner pastes the address the panel copies for them.
 * When Gloam accepts a 0x recipient in its links, the recipient, token and
 * network can ride in the URL fragment (after `#`, which browsers never send to
 * a server), and this function is the one place that changes.
 */
export const GLOAM_FUNDING_CHAIN_ID = 4663;

export const GLOAM_PAY_URL = "https://gloam.trade/app/vault?tab=move&mode=pay";

/** Where to send an owner funding an agent on `chainId` from Gloam, or null where it would not reach the agent. */
export function gloamFundingLink(chainId: number): string | null {
  return chainId === GLOAM_FUNDING_CHAIN_ID ? GLOAM_PAY_URL : null;
}
