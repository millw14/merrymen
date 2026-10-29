# Funding an agent privately with Gloam

**Status: draft for discussion** (issue #348). The first piece is funding: an owner pays
their agent's account from a private Gloam balance. Paying profits back into the owner's
Gloam balance is phase 2, and only sketched at the end.

**Provider.** [Gloam](https://gloam.trade) keeps stablecoin balances in a shielded pool
(zero-knowledge proofs) on Robinhood Chain and a few other networks. On Robinhood Chain
mainnet the pool is `ShieldPoolPayments` at `0x39e28cde55cab798874746ac52cb4b5cc99a0194`
and it holds USDG at `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`, the same token the agent
trades with (`packages/core/src/ids.ts`).

## What changes in merrymen

One block in the Add funds panel (`FundingPanel` in `web/src/terminal/HostedControls.tsx`),
under the agent account address:

- **Shown** only for a grant on Robinhood Chain mainnet (4663), and not while the agent is
  paused for recovery (the same rule the energy note follows).
- **"Copy address and open Gloam"** copies the agent account address that is already on
  screen and opens `https://gloam.trade/app/vault?tab=move&mode=pay` in a new tab, with
  `rel="noopener noreferrer"` so Gloam is not told which merrymen page sent the owner.
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
2. In merrymen, Add funds, "Copy address and open Gloam".
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

**The owner wallet matters.** Gloam hides the funding route, not the owner. A Privy
embedded wallet is a fresh address, so for those owners funding through Gloam keeps their
main wallet out of the agent's history. An owner whose agent is owned by their main wallet
is already tied to it by the account itself, and Gloam only hides where the money came from.

**Who sees what.** merrymen sees nothing new: there is no call from merrymen to Gloam, and
Gloam is not told which merrymen account the owner has. Gloam's relay sees the
transactions it submits, which are public once they land, and the connection they arrive on.

The panel never calls this anonymous or untraceable, and must not.

## Permissions and recovery: unchanged

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

The details ride in the fragment, which browsers never send to a server. But `to` must be a
Gloam receive address (`gloamr1.`); a 0x address is dropped with "The Gloam address in this
link is not complete". So this draft opens Pay without a request and the owner pastes the
address. The Gloam change needed is small: accept a 0x address or ENS name in a request
link's `to`, and hand it to Cash out with the amount, token and network filled in, the way
Pay already does for a typed address. Then `gloamFundingLink` in `web/src/lib/gloam-funding.ts`
can build:

```
https://gloam.trade/app/vault?tab=move&mode=pay#to=<agent account>&asset=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168&chain=robinhood-mainnet
```

Note the network key: on Gloam, `robinhood` is the testnet and `robinhood-mainnet` is 4663.

**Not chosen for this step.** A heavier route, already proven with another integration,
gives each agent its own Gloam receive address: a merrymen service finds incoming payments
(`scanIncomingPayments` in `@gloamtrade/sdk`), secures them (`sweepReceivedNote`) and cashes
them out to the agent account. It needs no paste step, but it puts Gloam keys on a merrymen
server, which is more than funding needs.

## Phase 2: profits back into the owner's Gloam balance (open notes)

Not built. Withdrawal today goes through the owner key (`RecoverPanel`), which sends to an
address. The questions are where that address comes from and what it reveals.

- **Simplest:** the owner withdraws to a fresh one-time Gloam deposit address and adds it to
  their private balance from there. No merrymen change, but the withdrawal leg is public and
  the deposit into Gloam that follows it is easy to match.
- **Better:** Gloam receive addresses (`gloamr1.`) are keys, not 0x accounts, so the agent
  cannot `transfer` to one. Paying one from a public account is a deposit into the pool
  (`approve` then `shieldBound`, with a proof made in the browser by `@gloamtrade/sdk`)
  whose note is sealed to the owner's receive address and posted to Gloam's payment board;
  the owner's Gloam app then finds it and moves it into a note only they know. The owner
  key (not the session key) would sign that batch from the agent account. It is two new
  call targets, so it needs a deliberate decision about the wall, never a quiet widening of
  the session key's permissions. Gloam's per-deposit beta limit applies.
- **Accounting:** a payout into the pool is `capital-out` by the same classifier, unless the
  pool ever appears in a venue list, which would make it ambiguous. Worth a test before
  phase 2 ships.

## Open questions

- Should the option sit behind a deployment flag until we announce it together?
- Are owner wallets mostly Privy embedded ones today? That decides how much the
  owner-wallet caveat matters in practice.
- Is a wallet linked for $MERRYMEN energy visible anywhere public? If so it belongs in the
  "still public" column.
- Should the funding panel, chat's open-deposit and the MCP deposit answer all mention
  Gloam, or only this panel?
- Translations: ship `fund.*` with the rest of the funding panel once it is extracted.
