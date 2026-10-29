# Funding an agent privately with Gloam

**Status: implemented behind default-off flags; not approved for a live rollout**
(issue #348, following draft PR #366). Phase 1 lets an owner fund their agent from
Gloam. Phase 2 lets the owner approve a withdrawal of available USDG into a payment
they can claim in Gloam. It does not calculate profits, sell investments, or let the
agent withdraw autonomously. Gloam is beta software; its external audit is pending.

**Provider.** [Gloam](https://gloam.trade) keeps stablecoin balances in a shielded pool
(zero-knowledge proofs) on Robinhood Chain and a few other networks. On Robinhood Chain
mainnet the pool is `ShieldPoolPayments` at `0x39e28cde55cab798874746ac52cb4b5cc99a0194`
and it holds USDG at `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`, the same token the agent
trades with (`packages/core/src/ids.ts`).

## What changes in merrymen

One block in the Add funds panel (`FundingPanel` in `web/src/terminal/HostedControls.tsx`),
under the agent account address:

- **Shown** only when `NEXT_PUBLIC_GLOAM_FUNDING_ENABLED=1`, for a grant on Robinhood Chain mainnet (4663), and not while the agent is
  paused for recovery (the same rule the energy note follows).
- **Copy address**, then **Open Gloam**: separate controls copy the agent account address
  and open `https://gloam.trade/app/vault?tab=move&mode=pay` in a new tab, with
  `rel="noopener noreferrer"` so Gloam is not told which merrymen page sent the owner.
- Clipboard failure leaves the address visible with instructions to copy it manually.
- The URL carries nothing about the agent. See "Gloam side" below for why.

The component (`web/src/terminal/GloamFunding.tsx`) reads no session, grant or wallet,
signs nothing and calls no API. The copy is in `web/src/lib/messages/en.ts` under
`fund.gloam.*`, English only until the rest of the funding panel is extracted (the
namespace rule in `web/src/lib/i18n.tsx`). `web/src/terminal/gloam-funding.test.ts` pins
these properties.

## The flow

1. The owner has a private USDG balance on Gloam, on Robinhood Chain. They got it by
   adding USDG to Gloam from any wallet (beta limits today: 500 USDG per deposit, 25,000 in
   the pool), or by being paid privately by someone else.
2. In merrymen, Add funds, copy the agent address and open Gloam.
3. In Gloam: choose Robinhood Chain, open Pay, paste the address, enter an amount of USDG.
   Pay sees a 0x address and hands it to Cash out, which sends from the private balance to
   that address. With **Hide my wallet** on (the default wherever Gloam's relay is up), the
   relay submits the transaction, so the owner's wallet is not its sender. The owner can
   also choose to send it in a few pieces at random times over a window they pick.
4. On chain: a USDG `Transfer` from the Gloam pool to the agent account.
5. In merrymen nothing new runs. The deposit scanner (`worker/src/deposit-log.ts`) reads
   the transfer and `classifyUsdgMovement` (`packages/core/src/capital-classify.ts`)
   decides it: an inbound USDG leg, nothing else moving the other way, from an address that
   is not one of ours, not chain infrastructure and not a trading venue, so `capital-in`
   by `no-pair-external`. It is booked as a deposit with its transaction hash and the
   high-water mark moves with it, exactly like a transfer from the owner's wallet. A
   payment sent in pieces is several deposits.

Gloam's own fees apply on its side. The agent is credited with what arrives.

## What stays private, and what does not

| Private with this flow | Still public |
| --- | --- |
| Which wallet the money came from: the transfer comes from the pool, and the relay sends it | The agent account address, its USDG balance and every trade it makes |
| The owner's balance and other activity inside Gloam | Every deposit into the agent: amount, time, and that it came from the Gloam pool |
| | The wallet that owns the agent account (its Kernel sudo validator, see `web/src/lib/derive-account.ts`) |
| | The owner's own deposit into Gloam: that wallet added that amount to the pool |

**Where the link can still be drawn.** Timing and amounts. Adding 250 USDG to Gloam and
paying 250 USDG to the agent a minute later is easy to match. Waiting, paying a different
amount, or letting Gloam send it in pieces over time all make that harder. The copy says so.

**The owner wallet matters.** The Kernel owner remains visible. Privy embedded wallets
may be reused; an embedded wallet is not a promise of a fresh identity. An agent owned by
the owner's main wallet is already linked to it. This feature changes the funding route,
not the account's ownership history.

**Who sees what in phase 1.** merrymen sees nothing new: there is no call from merrymen to Gloam, and
Gloam is not told which merrymen account the owner has. Gloam's relay sees the
transactions it submits, which are public once they land, and the connection they arrive on.

The panel never calls this anonymous or untraceable, and must not.

## Phase 1 permissions and recovery

- **The trust wall, the session key and the signed caps** are not read or written. The
  payment is a plain ERC-20 transfer into the same address the panel already shows, which
  needs no permission from the account.
- **Live trading** is unaffected. Funding does not turn it on, by this route or any other
  (`docs/live-trading-consent.md`).
- **Recovery** is unaffected. While an agent is paused for recovery the Gloam block is
  hidden, and the funds notice and plain address stay as they are.
- **Wrong network.** Gloam runs on several networks and the agent's address exists on all of
  them, but only USDG on Robinhood Chain reaches the agent. The link is offered on 4663 only
  and the copy says "Robinhood Chain only".

## Gloam side

Gloam already has payment request links:

```
https://gloam.trade/app/vault?tab=move&mode=pay#to=gloamr1.…&amount=…&asset=0x…&chain=robinhood-mainnet
```

The details ride in the fragment, which browsers never send to a server. The source
reviewed after the original draft supports public-address request links, but that behavior
has not been verified on the deployed site. This implementation therefore keeps the manual
paste flow. After checking the deployed Cash out handoff, token, amount and network,
`gloamFundingLink` in `web/src/lib/gloam-funding.ts` could build:

```
https://gloam.trade/app/vault?tab=move&mode=pay#to=<agent account>&asset=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168&chain=robinhood-mainnet
```

Note the network key: on Gloam, `robinhood` is the testnet and `robinhood-mainnet` is 4663.

**Not chosen for this step.** A heavier route, already proven with another integration,
gives each agent its own Gloam receive address: a merrymen service finds incoming payments
(`scanIncomingPayments` in `@gloamtrade/sdk`), secures them (`sweepReceivedNote`) and cashes
them out to the agent account. It needs no paste step, but it puts Gloam keys on a merrymen
server, which is more than funding needs.

## Phase 2: owner-approved withdrawal to Gloam

In plain words: choose how much available USDG to take out of the agent, paste your
Gloam receive address, review it, and approve with the wallet that owns the agent.
After confirmation, open Gloam to find and claim the payment into your private balance.
The agent-to-pool amount and time remain public.

`GloamWithdrawal` appears alongside the existing recovery panel on Robinhood mainnet.
The browser requires `NEXT_PUBLIC_GLOAM_WITHDRAWALS_ENABLED=1`; the bundler relay
independently requires `MERRYMEN_GLOAM_WITHDRAWALS_ENABLED=1`. Both default off.
These are separate from the funding flag. Public flags must be set at build time.

1. The owner enters an amount, limited to 500 USDG per operation, and their public
   `gloamr1.` receive address. Private keys and recovery phrases stay in Gloam.
2. The browser checks the owner account and available USDG, creates the note and proof
   locally, encrypts the note to the receive address, and estimates the ETH fee.
   It pins SDK 0.4.1 and SHA-256 hashes of the final proving files before use.
3. The review shows the account, amount, full receive address, network and maximum
   network fee. Approval requires the owner to confirm they can access that address.
4. The owner signs one atomic Kernel batch: approve exactly the amount to the pinned
   pool, call `shieldBound`, post the encrypted memo to the pinned payment board, then
   reset the USDG approval to zero. A failure reverts the entire batch.
5. Merrymen verifies the real chain receipt, including the matching EntryPoint
   operation hash, sender and nonce, the USDG transfer, pool commitment and exact memo
   within that operation. Gloam then discovers and secures the received note through
   its existing claim flow. A confirmed deposit does not mean that claim has happened.

The relay retains its account-bound recovery ticket, permits only the default owner
nonce namespace, rejects sponsorship, and accepts only this exact canonical batch
on the pinned mainnet contracts. The session key, trust-wall grant, agent permissions,
budgets and trading engine are unchanged. This is an explicit owner action, not an
additional tool the agent can call. The proof binds the note, asset and amount; it does
not attest that a receive address belongs to the owner. The owner reviews that address.

### Recovery and accounting

Before submission, the browser saves the signed operation and encrypted memo in a
per-account journal. Web Locks prevent competing tabs. A timeout keeps the record;
checking again looks for its receipt and can only resubmit the identical signed bytes.
A used nonce, existing commitment, unavailable receipt, failed storage write or uncertain
RPC result blocks a new payment. A pending signed operation cannot be discarded in the
UI. An unsigned plan may be canceled; a terminal result is checked on-chain before clearing.

The owner can download an encrypted receipt. The browser journal is local to that
browser/profile; do not clear site data while a payment is pending. There is no automatic
cross-device restore or backup-import UI in this beta. If the bundler loses its receipt
history, manual investigation may be needed; the client fails closed. No plaintext note
or Gloam private receive key is persisted by this feature. The temporary note secret is
created in browser memory, so the owner should complete Gloam's claim flow.

The scanner accounts for inbound payments as capital-in and owner withdrawals as
capital-out, adjusting the high-water mark rather than treating them as trading profit
or loss. Receipt-to-ledger tests cover net received amounts, split deposits, deduplication,
restart recovery and withdrawals. Do not register the Gloam pool as a trading venue:
without an opposite asset leg that would intentionally make these transfers ambiguous.

### Validation and rollout

Local coverage includes mounted funding/withdrawal views, amount and calldata validation,
owner-only relay authorization, receipt isolation within a bundle, journal crash/retry
behavior, accounting, and real SDK encryption/proof construction. No real funds have been
sent as part of development. A production build is not evidence of a mainnet payout.

Chrome verification also executed the production Next.js proof bundle under the actual
document CSP, downloaded the hash-verified final artifacts, produced a 256-byte proof
and 852-byte encrypted memo, and independently decrypted the note using WebCrypto.
Mobile and desktop form/review/pending views were checked for overflow. Wallet signing,
deployed relay submission and the final Gloam claim remain outside that local check.

Dependencies are pinned for the SDK/prover. A scoped `jsonpath` override keeps the
prover's CLI-only Underscore dependency on its patched release. The SDK's
`circomlibjs`/Ethers dependency still reports the low-severity Elliptic signing advisory
`GHSA-848j-6mx2-7j84`; this integration uses WebCrypto P-256 for receipt encryption and
does not use the Ethers signing path. This does not replace an upstream crypto audit.

Before enabling this beta, Milla and Duke should review the pinned contracts/proving
artifacts and recipient claim flow, assess the pending external audit, and authorize a
small end-to-end mainnet test through the deployed relay and Gloam. Verify funding net
fees and the later private cash-out costs. Keep both flags off until that review. Broader
automatic withdrawals/private trading are a separate design and permission decision.

The launch remains limited to these panels. Chat/MCP wording and translations can follow
after the flow is verified. Energy-wallet linking should never be described as anonymous:
public token holdings and on-chain ownership can still link identities.

For a rollback, disable the server withdrawal flag first. Keep the browser withdrawal
flag enabled while owners check or download pending records: receipt reads remain
available, but new Gloam submissions are refused. Turning off the browser flag hides
this panel and its local journal. Gloam's on-chain encrypted memo remains discoverable
in Gloam even if Merrymen is unavailable.
