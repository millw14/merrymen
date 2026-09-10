# Owner runbook — letting an agent buy tokens you never named

Everything the software can do is done and committed. This file is the part only
you can do. Like the Pons runbook it opens with reasons you might decide NOT to,
and here they are heavier than they are for either adapter, because this is the
only permission in the wall that lets an agent reach an asset nobody chose.

## Read this before you deploy anything

**The chain does not vouch for the token, and cannot.** Every other venue can
only trade assets you named in `/settings` and sealed by re-signing. The class
route buys tokens that did not exist when you signed. The wall pins the vault,
the funding asset and the size — it cannot pin the *curve*, because there is a
new curve address per launch, about 475 an hour. A curve self-reports its
`factory()` and a hostile contract can too; the Pons factory publishes no
registry view. So provenance lives entirely in the worker's factory-filtered
launch feed. **For this permission the chain is LOOSER than the off-chain
mirror** — the reverse of how everything else here works, and it is the price of
the capability.

**Your assets stop living in your account.** A class token is held by a
`PonsClassVault` deployed for your account alone. That is the mechanism, not a
side effect: a token your *account* holds cannot be sold, because selling needs a
per-token `approve` and the wall carries no permission for an address nobody
enumerated. The vault has one owner, set at construction, immutable; no
recipient argument anywhere; no admin, no pause, no upgrade, no rescue. What an
attacker with your session key gets is the same exposure the other curve venues
already carry — they can convert capped USDG into a worthless token — plus the
fact that the junk sits in the vault rather than your account. `merrymen recover`
sweeps it back out with your owner key.

**A round trip costs 199 bps in curve fees alone**, before gas. That number is
measured, not estimated, and it is the same one the Pons runbook opens with. A
strategy has to beat 2% before it breaks even, and class tokens are the least
liquid things on the chain.

**It reaches a minority of launches.** Native-ETH-quoted curves are 53.6% and the
vault refuses all of them by name — every wall permission carries `valueLimit: 0`,
so the account cannot send native value at all. Curves quoted in anything but
USDG are skipped too, because reaching them needs a second hop. What is left is
the USDG-quoted slice.

**The drawdown breaker cannot protect this money.** A class position is carried
at COST, because there is no price anyone should trust. A position carried at
cost does not move — if it goes to zero, equity will not show it and the breaker
will not fire. The **scout budget** is the real risk control for this money, not
the breaker. Treat `scoutBudgetUsdg` as money you have decided you can lose.

If those five paragraphs do not change your mind, the rest is the procedure.

## Already done for you (no action)

- `PonsClassVault` + `PonsClassVaultFactory` written and tested (10 contract
  tests), including the one the whole design rests on: *sells without the owner
  ever approving the token*.
- Wall permissions (`buy`, `sell`, `deploy`), the grant marker, both signers,
  the worker mirror, custody accounting, the execution path, the producer, and
  the recovery sweep — all committed with tests.
- The wall REFUSES to seal a vault without a factory. Two of three class
  permissions would be a key that can reach a vault it can never create, and a
  call to a contract that does not exist *succeeds silently* — so that grant
  would book purchases that bought nothing.
- Nothing is on by default. `classSnipeEnabled` is false, `classPerEntryUsdg` is
  0, and no factory address is configured on any chain.

## Step 1 — deploy the factory

Testnet first. The two runs produce two different addresses.

```bash
cd contracts && npx hardhat run scripts/deploy-ponsclassvaultfactory.ts --network robinhoodTestnet
```

The deployer key comes from `MERRYMEN_DEPLOYER_PRIVATE_KEY` in the shell that
runs it, is never logged, and should be unset afterwards. The script refuses any
chain that is not 46630 or 4663, refuses to run with no balance, and post-verifies
that `vaultFor` answers a real address — the property the wall depends on, since
the grant pins a vault before it exists.

**You do not deploy a vault.** `deploy(owner)` is permissionless and the session
key carries a permission to call it pinned to its own account, so the first class
buy creates the vault in the same operation.

## Step 2 — settings

Paste the factory address into `/settings` as **"Class vault factory contract"**.

This is a HINT, not the authority — the worker uses whatever the grant was sealed
against, and warns you if the two have drifted.

## Step 3 — re-sign

`/grant` → renew. The re-sign is what seals the factory, derives *your* vault
address from it, and mints the `pons-class` marker. The setting alone changes
nothing.

Afterwards `/grant` should show **Class route — this key may buy tokens you never
named, held in your vault at 0x…**. If it says "not granted", the settings save
and the signature crossed; hard-reload and sign again.

## Step 4 — turn the route on, and size it

Two switches, both required, both off by default:

- `classSnipeEnabled` — the decision to actually go and do it. Sealing a vault
  says the key *could*; this says it *should*.
- `classPerEntryUsdg` — how much per entry. Zero means nothing happens.

Optional: `classMaxPositions` (0 = bounded only by the scout budget) and
`classMinDepthUsdg` (defaults to 250, the venue's own floor — trencher's $25,000
is a *pool* figure and sits 2.4× above the most a curve can ever hold).

And the one that actually bounds the loss: `scoutEnabled` + `scoutBudgetUsdg` +
`scoutPerTokenUsdg`. A class buy is treated as unpriceable unconditionally, so
the scout ceiling gates every one of them.

## Step 5 — verify before funding

- `/grant` shows the class line, with your vault address.
- The feed says *"your class vault … hasn't been created yet — the first class
  buy creates it in the same operation"*. That is the ordinary state, not a
  problem.
- If it instead warns that the vault *cannot be created*, the factory has no code
  on that chain — you deployed to the other one.

## What is still not true after all five steps

- **Nothing has ever landed a class trade.** No factory is deployed on any chain
  and no grant has ever carried the marker. The first one will be the first.
- **`contracts/deployments.json` does not exist**, so neither `PonsSelfTrade` nor
  `V4SelfSwap` has been deployed from this checkout either — and
  `docs/owner-runbook-pons.md` still records that no agent has landed a live
  trade of any kind. A bonding curve is a poor place to discover that something
  upstream is broken, and a token nobody vouched for is a worse one.
- **The launch feed is the only provenance.** If discovery is off or its key is
  missing, the mirror refuses every class trade rather than guessing — which is
  correct, and will read as "nothing happens".
