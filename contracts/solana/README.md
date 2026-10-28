# Bounded Solana custody (source, build and release)

This directory contains an actual Anchor 0.32.1 custody program and a shared ABI
in `packages/core/src/solana-live.ts`. It is **not deployed**. The declared public
program ID, `EUzYVniKtgNNgFweMtRA9vciTWtE8MDTRfh6ai6VvXoU`, is a local test identity
only: the live runtime refuses it, and CI never names a build that declares it a
release. A live runtime must explicitly configure an immutable deployment, verify its
executable bytes on two RPC providers against the reviewed SBF binary hash, check that
the binary declares the configured ID, and verify the finalized owner/session state
before enabling trades. The runtime hash covers the entire ProgramData executable
region after its 45-byte loader metadata, including allocation padding. The `.so` hash
is the same only for an exact-sized allocation; otherwise hash the artifact followed by
its zero padding. The source includes no deployment wallet or owner/session private key.

The wider plan, runtime behaviour and release gates are in
[`docs/solana-integration.md`](../../docs/solana-integration.md).

## Authority and execution

The vault PDA is derived from `["vault", owner]`. Only the owner can initialize,
replace a session, revoke all sessions, clear the breaker or withdraw custody
assets. `withdraw_sol` also recovers native SOL sent to the vault, while preserving
its rent reserve and permanent sequence/history. Token withdrawals require the
owner's canonical token account, remain available when paused/expired/revoked and
increment the sequence to invalidate prepared swaps. `OwnerWithdrawal` identifies the
amount, mint and consumed sequence. Withdraw does not refuse an owner token account
that has a delegate or close authority (an accepted limitation; the app tells the
owner to remove them). There is no close instruction: about 0.0165 SOL of vault and
token-account rent per owner stays locked once the program is deployed immutable.

A session is a signing public key with a positive per-trade cap, a rolling 24-hour
USDG cap, a positive per-trade and rolling 24-hour **WSOL input** cap (lamports,
per-trade ≤ daily), at most 96 operations per rolling day, and an expiry at most 7
days ahead (`MAX_SESSION`, plus a 15-minute `SESSION_CLOCK_ALLOWANCE` for clock
skew; the server grants at most 168 hours). All of these are owner-signed in
`create_session`. Replacing a session increments its epoch; it preserves the
sequence, debit history and breaker. Revocation removes session authority and sets
the breaker. The session can set the sticky breaker but only the owner can clear
it. A breaker blocks buys; exits remain subject to all caps, expiry, sequence and
output checks, and share the USDG daily cap and operation budget with buys. There is
no on-chain portfolio price oracle: drawdown valuation is a worker responsibility and
must fail closed when marks are stale or unproven.

Every swap binds the expected sequence and session epoch. A distinct fee payer
pays the transaction and temporary-account rent; it never receives custody
signing authority. The program transfers exactly the authorized amount to the
input ATA of a per-sequence PDA `["swap", vault, seq_le_u64]`. That PDA is the
**only** signer forwarded to a Jupiter CPI. Vault state, owner, session, fee payer,
source custody ATA, any token account owned by the vault owner (including the
owner refund ATA, whether or not it was passed), and other custody-owned token
accounts are forbidden in the CPI account list. The single allowed custody token
account is the destination ATA, which Jupiter can credit but cannot debit
without the vault signer.

The program pins Jupiter's v6 program ID (`JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4`)
and accepts only its ExactIn `sharedAccountsRoute` discriminator, bound input, output
floor, zero platform fee and at most 100 bps slippage, with at most 64 route accounts
counting repeats. Jupiter validates the remainder of the route data. The input amount
exposed to CPI is bounded independently of route internals. Output is measured from
actual custody balance deltas. Unspent input returns to the vault, the temporary ATA
closes and refunds its rent to the fee payer. Prior unsolicited deposits to the
temporary ATA are refunded to the owner's canonical input ATA before measuring input,
so a publicly predictable address does not create a donation denial of service and a
donation never counts as trade input. The owner refund ATA is an optional account
(the client passes the program ID to leave it out): it is needed only when such a
donation is waiting. An owner who closes their own USDG or WSOL account, for example
by unwrapping WSOL in a wallet, therefore no longer blocks buys or exits. If a
donation is waiting and the refund account is absent, the swap fails closed with
`RefundAccount` (6010); the fee payer never creates owner accounts. Jupiter's own
error codes share the 6000+ range (its `InvalidRoutePlan` is also 6010), so read the
innermost `failed:` log line to know which program failed. Success increments the
sequence and emits `SwapExecuted`; any failed check rolls back the CPI, balances,
debit history and sequence atomically.

Buy budgets conservatively charge the full authorized USDG input even when dust
returns. Sells are bounded on input: the full authorized WSOL input is charged
against the WSOL caps, so a session-chosen dust quote cannot sell more than the
owner signed for, whatever it is priced at (the 2026-10-18 audit's VAULT-1, where
one sell emptied the position for 1 micro-USDG). Sell proceeds are still charged
against the USDG caps too, with a preflight check of the guaranteed minimum and a
final atomic check of actual proceeds. Both directions consume the global
operation budget. Session replacement never replenishes any of them.

Account layout version 2 (2441 bytes) carries the WSOL caps and a `wsol` field on
every debit. The program refuses to execute against a version 1 vault, and the
TypeScript decoder refuses to read one. Every artifact hash recorded before the
current source describes a binary that will never ship: `9bb352ad…`, `53c9a7ba…`,
`ee04ea0e…` and `dfb7617c…` (before layout version 2 and the `lto` removal) and
`34b4fe22…` (before the on-chain 7-day session cap).

## Initial live asset scope

This first live version supports **USDG ↔ wrapped SOL only**. USDG is pinned to
its mainnet Token-2022 mint (`2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH`) with six
decimals. Wrapped SOL is pinned to the classic SPL token mint with nine decimals. It
does not authorize arbitrary memecoins or other SPL/Token-2022 assets. General-token
support requires a new reviewed program version and matching runtime checks.

USDG's issuer-controlled mint, freeze, permanent-delegate and confidential
configuration authorities are an explicit cash-token trust assumption. `check_mint`
accepts exactly the extensions the live mint carries: MintCloseAuthority,
PermanentDelegate, TransferFeeConfig (zero fee now and scheduled), ConfidentialTransferMint,
ConfidentialTransferFeeConfig, TransferHook (no program), MetadataPointer and
TokenMetadata. An active or scheduled nonzero transfer fee, a hook program or any
other extension fails every swap, exits included (`Mint`, 6005); withdraw does not
check the mint. Withdraw forwards its remaining accounts to Token-2022's transfer
(`spl_token_2022::onchain::invoke_transfer_checked`), so once the issuer sets a hook
program, a withdrawal that carries the hook program, its `extra-account-metas`
validation account and the extra accounts it lists still releases custody. A remaining
account that signs is refused (`Authority`), so the owner's signature never reaches a
hook. The owner signs every withdrawal, so this also refuses the owner's wallet where a
hook's list names it read-only and not as a signer, and leaving it out fails in
Token-2022 (`IncorrectAccount`). Any hook whose extra accounts include the owner's wallet
therefore holds USDG in the vault until the issuer changes the hook (owner decision;
WSOL and SOL withdrawals are unaffected). This assumption does not extend to other
token issuers.
Custody/source/output accounts must be unfrozen and have no delegate or close
authority. The mainnet mint's bytes, read on 2026-10-20 at slot 459,259,885, are
`runtime-tests/fixtures/usdg-mainnet-mint.json`; `custody.rs` runs `check_mint` on
them and on variants, and the worker applies the same verdict
(`solanaVaultUsdgMintRefusal` in `packages/core/src/solana-live.ts`) to the RPC's
`jsonParsed` form. `usdg-mainnet-mint.jsonparsed.json` is Agave 2.3.13's own decoder
output for those bytes, written offline by
`node contracts/solana/scripts/usdg-jsonparsed.mjs <agave release bin dir>` (local
genesis plus `agave-ledger-tool`; no network, keys or transactions); regenerate it
only with that script and only when `usdg-mainnet-mint.json` changes. The production
provider's own `jsonParsed` answer is a release gate:
`node contracts/solana/scripts/usdg-rpc-jsonparsed.mjs --provider NAME --rpc URL`
makes exactly one read-only `getAccountInfo`, never records the URL, and writes
`usdg-mainnet-mint.rpc-jsonparsed.json` for `worker/src/solana-usdg-mint.test.ts`
(run it only with Milla's OK).

## Local verification

```
PATH="<agave 2.3.13>/bin:$PATH" CARGO_HOME="$(realpath <cargo home>)" contracts/solana/test.sh   # add --offline without network
node --import tsx --test packages/core/src/solana-live.test.ts
```

`test.sh` runs the native unit tests, then `build.sh`, then the runtime tests against
the artifact it just built: `custody.rs` (custody invariants, and the TypeScript ABI's
own bytes), `recovery.rs` (the owner recovery tool's own signed transactions) and,
when the third-party program copies are supplied, `jupiter_fork.rs` (below). Without
them it prints `jupiter_fork: skipped, set MERRYMEN_JUPITER_FORK_PROGRAMS (release
gate)` and runs every other target, and CI accepts that line for this target alone.
`build.sh` is the only supported build recipe:

- It requires `cargo-build-sbf` 2.3.13 and platform-tools v1.48 (rustc 1.84.1-dev, LLVM
  19.1.7, anza-xyz/rust `293a1b6c`) and always passes `--tools-version v1.48 --arch v0`
  and `--locked`. Any other toolchain, an `lto` setting, or ambient `RUSTFLAGS`,
  `CARGO_PROFILE_*` or `CARGO_TARGET_*` overrides stop the build. So does a
  `.cargo/config.toml` (or legacy `.cargo/config`) in the program's directory, in any
  directory above it, or above the directory `build.sh` runs from, other than
  `CARGO_HOME`'s own: cargo applies such a file to the vault build (a `[profile.release]`
  table there overrides the workspace's `overflow-checks`), and the source digest does
  not cover it. A pull request that adds one at the repository root or in `contracts/`
  starts the vault jobs (`scripts/ci/solana-paths.mjs`), so CI meets this refusal on the
  pull request itself.
- It resolves `CARGO_HOME` and the source directory to physical paths. cargo-build-sbf
  remaps rustc's canonical working directory, so a symlinked `CARGO_HOME` (macOS `/tmp`)
  left absolute registry paths in the binary and changed its hash (audit GAP4-2).
- It compares the artifact with `build-manifests/<uname -s>-<uname -m>.json`. Same source
  and a different artifact is an error. `build.sh --record` builds a second copy of the
  source in another directory, requires identical bytes, and writes that host's
  manifest: source digest, declared program ID, toolchain, artifact bytes and sha256.
  Platform-tools embeds its own build paths, so macOS and Linux artifacts differ; the
  release artifact must come from the pinned Linux CI build and its own manifest.
- `build.sh --source-digest` prints the digest of the reviewed inputs (workspace and
  program manifests, `Cargo.lock`, `build.sh` and the program sources). The TypeScript
  suite recomputes it and fails while any recorded manifest is stale, so any change to
  the program source, `Cargo.toml`, `Cargo.lock` or `build.sh` needs a reviewed
  re-record.

The committed `build-manifests/Darwin-arm64.json` (artifact `ce7d2544…`, 410,472 bytes,
source digest `1d02ff3e…`, the local test ID) is for local verification only. It was
re-recorded on 2026-10-20 after `withdraw` began forwarding transfer-hook accounts; the
record's second build from a copy in another directory gave identical bytes, and the
runtime tests (custody, recovery and the Jupiter fork test) passed against it. No Linux manifest is committed yet.

The TypeScript suite writes `runtime-tests/fixtures/ts-instructions.json` from the
shared ABI builders (`MERRYMEN_WRITE_SOLANA_ABI_FIXTURE=1 npx tsx --test
packages/core/src/solana-live.test.ts` rewrites it) and fails while it is stale.
`custody.rs` executes those exact bytes and account metas against the compiled
program, so the TypeScript ABI is tested against the real program, not only Anchor's
Rust client. Likewise `runtime-tests/fixtures/recovery-transactions.txt` holds the
recovery tool's exact signed transactions (`MERRYMEN_WRITE_SOLANA_RECOVERY_FIXTURE=1
npx tsx --test worker/src/solana-recover.test.ts` rewrites it), which `recovery.rs`
runs. Both fixtures take the program ID from `lib.rs`'s `declare_id!`. After
regenerating either, rerun `test.sh`.

The runtime tests are explicitly ignored by plain `cargo test` because Anchor 0.32.1
cannot run its CPIs in the native processor. The separate runtime-tests workspace keeps
the current host SVM dependencies out of the SBF Rust 1.84 build. `test.sh` passes
`--include-ignored`, so a dropped `#[ignore]` can never make one skip, and CI counts
that every one ran (`scripts/ci/solana-runtime-tests.mjs`). A missing artifact is an
error.

`custody.rs` uses generated or fixed-seed, unfunded local identities, synthetic token
accounts (including real Token-2022 mints with extensions and the mainnet USDG mint's
bytes), ProgramTest's bundled SPL/Token-2022/ATA programs and a pinned mock Jupiter
processor. It exercises SPL/Token-2022 CPIs, authority exclusion, atomic rollback,
sequence replay, session replacement and a non-zero residual return (which a real
ExactIn route never leaves).

## The Jupiter fork test

`runtime-tests/tests/jupiter_fork.rs` runs the compiled vault's `execute_swap` against
the mainnet binaries of Jupiter v6, Orca Whirlpool, SPL Token (p-token on mainnet),
Token-2022 and the ATA program, and a real Jupiter `/swap/v1` `sharedAccountsRoute`
(1 USDG → WSOL, one Whirlpool hop) with the route's mainnet accounts, recorded at slot
459,261,789 (2026-10-20 14:23 UTC). Nothing reaches a network. It holds the executor's
compute budget (simulate at 1.4M, sign at `ceil(units × 1.2)`) under a 250,000 CU
ceiling, a 64-account lock limit, the 1,232-byte packet, a free CPI level and the
64-entry trace, the route-size caps, and the custody checks. Measured on 2026-10-20:
buy 162,314 CU, derived exit 154,593 CU, buy refunding a donation 149,929 CU; 29 of 64
locks, 948 of 1,232 bytes, 29 of 64 route accounts; each further Whirlpool leg 76,735
CU; at most 3 legs (a 4th is refused before Jupiter runs); CPI depth 4 of 5. It is
evidence for one direct route, not for multi-hop routes or live fills; the exit and
the split routes are derived from the one recorded answer. The canary remains the
authority on live fills.

**Supplying the third-party programs.** Only the three Apache-2.0 SPL programs are
committed in `runtime-tests/fixtures/jupiter/`. Jupiter v6 (no licence granted) and
Whirlpool (licence not checked) are supplied out of band and are in no commit
(`fixtures/jupiter/NOTICE.md`, option (c)). `programs.json` pins all five by SHA-256,
so a missing or different file fails the test once it runs. Either:

- put `jupiter_v6.so` and `whirlpool.so` in `runtime-tests/fixtures/jupiter/` (git
  ignores them) and run `test.sh`; or
- keep a directory with all five files (the two copies plus the three SPL files from
  the fixtures directory) outside the repository and run
  `MERRYMEN_JUPITER_FORK_PROGRAMS=<that directory> contracts/solana/test.sh`
  (`test.sh` resolves it to an absolute path and fails if it is not a directory).

Keep the copies in private storage keyed by `sha256OnChain`: an RPC serves only a
program's current bytes, so once an upgradeable program changes on chain a lost copy
cannot be fetched again and the fixtures must be refreshed. CI is not given the
copies and always skips this target, so run it before every vault release and
whenever the executor's route or quote parameters change.

**Refreshing.** `node runtime-tests/fixtures/jupiter/refresh.mjs fetch <empty dir
outside the repo>` then `build <that dir>` (Node 22 or later; keyless read-only
requests: one Jupiter quote and one `swap-instructions` build at `lite-api.jup.ag`,
and `getMultipleAccounts`, `getBlockTime` and `getAccountInfo` on a public RPC). A
refresh is needed only to test newer on-chain program bytes, another route, or changed
executor quote parameters (`QUOTE` and `BUILD` in `refresh.mjs`); a new `declare_id`
does not need one, because the test moves the recorded vault accounts to its own
build's program ID (checked with a changed `declare_id` on 2026-10-20). Refreshing
the SPL copies adds a file to history: delete the old one in the same commit.

## CI and the release artifact

`solana · test` in `.github/workflows/ci.yml` first names the runner image (ImageOS and
ImageVersion; GitHub's `ubuntu-24.04` image is updated in place and has no digest),
installs agave 2.3.13 and platform-tools v1.48, each checked against the size and
SHA-256 in `scripts/ci/solana-toolchain.env` before it is unpacked, runs `test.sh`,
checks that every runtime test ran, and records the artifact
(`merrymen_vault.build.json`: program ID, the local test ID and whether the build
declares it, SHA-256, toolchain, runner image and the run that built it, with its
provenance). `solana · rebuild` names its image too and builds the same source again
from `git archive` on another runner with a fresh `CARGO_HOME`, and `app` requires the
two hashes to be equal; it prints `vault artifact: tested X, rebuilt X` before it
checks any result. Both jobs build only when a pull request changes a Solana-relevant
path (`scripts/ci/solana-paths.mjs`; it counts `.cargo/`, `rust-toolchain` and
`.gitattributes` at the repository root and in `contracts/` too, because cargo and git
apply them to the vault's build and source); pushes to main and manual runs always do.
The platform-tools pin is corroborated only by three independent Nix pins: the first
run's checked download is the first check of the file itself (or run `curl -fsSL
https://github.com/anza-xyz/platform-tools/releases/download/v1.48/platform-tools-linux-x86_64.tar.bz2 | sha256sum`
on a trusted machine; expected `a9d3157f…7597`). Change `solana-toolchain.env` and
`test.sh`'s flags together, or the rebuild comparison fails.

`solana · test` then runs `build.sh --record` (one more SBF build, about 4 minutes) and
checks that the manifest it writes, `build-manifests/Linux-x86_64.json`, is for the
artifact the runtime tests ran against. Before the upload it compares that manifest
with the committed one (`scripts/ci/solana-linux-manifest.mjs report`), writes the
outcome into the record, and names the artifact from it (below). The job's last step
fails on the outcome, after the upload, so a run whose manifest differs still hands it
over. It fails when a committed Linux manifest exists and differs from that pinned
Linux build in any field, and when the commit under test deleted the manifest its
first parent has (a pull request's base, or the commit before a push): once committed,
it is replaced by the next reviewed one, never deleted. While none is committed on
either side it only reports the recorded values. One case fails earlier: a committed
Linux manifest with this build's source digest but another artifact. `build.sh`, run
by `test.sh` in the Test step, stops on it ("same source, different artifact"), so the
job fails before the comparison and the upload. The reviewed source did not change, so
the toolchain or the build environment did: compare the runner image the run names
with the one in the `Vault-Linux-Manifest:` line of the commit that added the
committed manifest (`git log -1 -- contracts/solana/build-manifests/Linux-x86_64.json`)
and investigate the image and toolchain. Never commit a new manifest just to make the
comparison pass.

**Committing the Linux manifest.** For the first one, and for every later one:

1. Pick a run whose `app` check passed (a push to main is best; any green run of the
   same source works).
2. Download its vault artifact and open `build-manifests/Linux-x86_64.json`.
3. Check that `toolchain.host` is `Linux-x86_64`, that `source.digest` equals
   `bash contracts/solana/build.sh --source-digest` at that commit, and that
   `artifact.sha256` equals both hashes in `app`'s log line `vault artifact: tested X,
   rebuilt X` (the `solana · test` and `solana · rebuild` step summaries carry them too).
4. Copy the file unchanged to `contracts/solana/build-manifests/Linux-x86_64.json` and
   commit it, ending the commit message with the `Vault-Linux-Manifest:` line from that
   run's "Linux build manifest" step summary (also in `merrymen_vault.build.json` as
   `linuxManifest.commitTrailer`). It names the run, the runner image, the artifact
   and the source digest; the run's own artifact and summary expire (90 days by
   default). CI does not enforce the trailer.
5. The next run's last `solana · test` step must say the manifest matches.

From then on every change to the program source, Cargo files or `build.sh` needs two
pushes: the first run fails (this comparison and the TypeScript manifest test) but
uploads the new Linux manifest; check its sha256 against `solana · rebuild`'s hash,
re-record Darwin locally with `build.sh --record`, commit both, and the next run must
pass. A manifest of today's local-test-ID source is a reproducibility baseline only.

**Release marking.** A release comes only from a CI run on `refs/heads/main` of
`millw14/merrymen` (a push to main, or a manual run on main) whose pinned Linux build
matched the committed Linux manifest, whose `app` check passed, and whose `lib.rs` does
not declare `SOLANA_VAULT_LOCAL_TEST_PROGRAM`. `solana · test` uploads before `app` has
compared the rebuild's hash, and before the rest of the run has passed or a newer push
has cancelled it, so it names such a run's bytes
`merrymen-vault-sbf-candidate-unconfirmed-<commit>-run<id>.<attempt>`, never a release.
`solana · release` needs `app` and runs only when it passed; for a candidate it uploads
`merrymen-vault-release-<commit>-run<id>.<attempt>`, a record
(`merrymen_vault.release.json`) naming the candidate artifact, its program ID and the
SHA-256 that `solana · test` tested and `solana · rebuild` reproduced. That record is
the release verdict: take the bytes from the artifact it names
(`target/deploy/merrymen_vault.so`) and check that they hash to its `sha256`. A
candidate without a release record in the same run is not a release, and
`solana · release` refuses a build that declares the local test ID whatever its
manifest says. Every other artifact is named `merrymen-vault-sbf-not-a-release-…`:
every pull request's, every one whose build differs from the committed manifest or
whose commit deleted it, every local-test-ID build, a run on main included. The build
record's `release` and `linuxManifest` fields say why. CI never runs on a tag push, and
a manual run on a tag or another branch is not a release. The names and records are
written by the run itself, so confirm the run's event, branch and commit on GitHub,
and that its `app` check passed, before using it. On a pull request `solana · release`
only prints a notice and succeeds, so the Kaka gate's every-job rule still holds.

## Release procedure

Nothing below has been done for a production ID. Steps 1 to 4 were proven on
2026-10-20 in a scratch copy with a throwaway ID (`test.sh` passed; the TypeScript
suites were not run on such a commit). Steps 7 onwards need Milla's authorization.

1. **Choose the deploy keypair** offline and take only its public key
   (`solana-keygen pubkey <keypair>`). Nothing in this repository ever reads the
   keypair.
2. **Set the ID.** Put the public key in `declare_id!` in
   `programs/merrymen-vault/src/lib.rs` and in every `[programs.*]` entry of
   `Anchor.toml`. Leave `SOLANA_VAULT_LOCAL_TEST_PROGRAM` in
   `packages/core/src/solana-live.ts` as it is: it names the test identity.
3. **Regenerate the ID-bound fixtures**:
   `MERRYMEN_WRITE_SOLANA_ABI_FIXTURE=1 npx tsx --test packages/core/src/solana-live.test.ts`
   and
   `MERRYMEN_WRITE_SOLANA_RECOVERY_FIXTURE=1 npx tsx --test worker/src/solana-recover.test.ts`.
   Update `worker/src/solana-release-id.test.ts`, whose first test asserts that
   `lib.rs` declares the local test ID today.
4. **Build and test locally**: `contracts/solana/test.sh` with the Jupiter and
   Whirlpool copies supplied (the fork test must run, not skip), then
   `build.sh --record` for the Darwin manifest, then
   `node contracts/solana/scripts/check-release-id.mjs <public key> --so target/deploy/merrymen_vault.so`.
   The script checks that `declare_id!` is exactly that key and that the `.so` holds
   its 32 bytes, prints the `.so` SHA-256, refuses anything that looks like a keypair
   and never echoes its argument. CI has no deploy keypair, so it checks only `lib.rs`
   against `Anchor.toml` and the ID's bytes against the `.so` it built.
5. **Pull request, two pushes**: the first run uploads the Linux manifest of the new
   source; commit it as above with its trailer; the next run passes.
6. **Merge and take the release record** from a CI run on main: download
   `merrymen-vault-release-…`, then the candidate artifact it names, check the `.so`
   against the record's `sha256`, and run `check-release-id.mjs <public key> --so
   <that .so>` on it.
7. **Rehearse on devnet** the `--final` deployment and the region-hash check below.
8. **Deploy to mainnet** exactly those bytes, immutable: `solana program deploy
   <merrymen_vault.so> --program-id <keypair> --final` (no upgrade authority; the
   deployer pays about 2.5 SOL of rent that cannot be recovered). Keep `--max-len`
   at its default (the artifact's size); if it differs, the region hash is the
   artifact followed by `max-len - bytes` zero bytes.
9. **Verify on two providers** that the program account is owned by the upgradeable
   loader, its ProgramData has no upgrade authority, and the SHA-256 of the
   ProgramData bytes after the 45-byte header equals the expected region hash. The
   runtime makes the same check on both providers before any live use.
10. **Pin the release**: add `{ programId, sha256 }` to `SOLANA_VAULT_RELEASES` in
    `packages/core/src/solana-live.ts` (keep every earlier release, so funded vaults
    stay usable) and publish the `merrymen` CLI, so `solana-recover --send` trusts
    it. Then set `MERRYMEN_SOLANA_VAULT_PROGRAM` and `MERRYMEN_SOLANA_VAULT_SHA256`
    (the region hash) on web and worker. Once the list is non-empty, any other pair
    is refused as configuration.

An actual mainnet deployment, an external security review, the production RPC's
`jsonParsed` USDG read and an owner-authorized funded canary remain separate release
gates (`docs/solana-integration.md`, "Release gates").
