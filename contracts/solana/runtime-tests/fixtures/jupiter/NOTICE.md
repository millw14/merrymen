# Third-party programs for the Jupiter fork test

`tests/jupiter_fork.rs` loads five programs deployed on Solana mainnet-beta, copied
with read-only `getAccountInfo` calls on 2026-10-20 and stored without their
on-chain zero padding. `programs.json` records each read's RPC, slot and UTC time,
the program and programdata addresses, the upgrade authority and the sha256 of
both the file and the on-chain bytes. They are test fixtures only: the test checks
those hashes and loads the programs into a local solana-program-test bank. Nothing
in this repository builds, links, modifies or deploys them, and no Merrymen service
uses them. The main `Dockerfile` copies its whole build context, so `.dockerignore`
lists `contracts/solana/runtime-tests/fixtures` (only tests read that directory) to
keep these copies out of the image.

Only the three Apache-2.0 SPL programs are in this repository. The Jupiter v6 and
Whirlpool copies are not: `.gitignore` lists both file names here, and they are
supplied out of band (see "Where the program copies live" below).

| File | Program | Source | Licence | In this repository |
| --- | --- | --- | --- | --- |
| `jupiter_v6.so` | Jupiter Aggregator v6, `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4` (upgradeable) | Not published with the program | None granted. This repository has no source or licence for it; its authors keep their rights in it. | No: supplied out of band |
| `whirlpool.so` | Orca Whirlpools, `whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc` (upgradeable) | https://github.com/orca-so/whirlpools | Not checked when this copy was made. | No: supplied out of band |
| `spl_token.so` | SPL Token, `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` (no upgrade authority) | https://github.com/solana-program/token | Apache-2.0 (the `spl-token` 8.0.0 crate), see `LICENSE-Apache-2.0.txt` | Yes |
| `spl_token_2022.so` | SPL Token-2022, `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` (upgradeable) | https://github.com/solana-program/token-2022 | Apache-2.0 (the `spl-token-2022` 8.0.1 crate), see `LICENSE-Apache-2.0.txt` | Yes |
| `spl_associated_token_account.so` | SPL Associated Token Account, `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL` (loader v2) | https://github.com/solana-program/associated-token-account | Apache-2.0 (the `spl-associated-token-account` 7.0.0 crate), see `LICENSE-Apache-2.0.txt` | Yes |

The Apache-2.0 licences are those of the crates published from the same source
repositories; the source revision each deployed binary was built from was not
identified. The SPL Memo program the route also calls is not copied here: the test
uses the copy bundled with solana-program-test, whose sha256 equals the mainnet
program's (`accounts.json` provenance).

## Where the program copies live: option (c), decided

Before this directory was first pushed, option (c) was chosen of the three
considered: keep the Apache-2.0 SPL programs here and supply Jupiter's and
Whirlpool's out of band. (Option (a) would have published Jupiter's binary, for which
no licence is granted, and Whirlpool's, whose licence was not checked; option (b)
would have moved the SPL copies out too.) Neither third-party file is in this
repository's history: deleting one later would have left it there.

`programs.json` stays here and pins every byte, wherever the copies live: once the
fork test runs, a missing or different file fails it, never skips it (only `test.sh`
decides whether it runs, below). The test reads all five ELFs from
the directory `MERRYMEN_JUPITER_FORK_PROGRAMS` names, or from this one when it is
unset or empty. To supply them, either:

- put `jupiter_v6.so` and `whirlpool.so` in this directory (git ignores them) and run
  `contracts/solana/test.sh` as usual; or
- keep a directory holding all five files (the two third-party copies plus the three
  SPL files from here) outside the repository, and run
  `MERRYMEN_JUPITER_FORK_PROGRAMS=<that directory> contracts/solana/test.sh`.
  `test.sh` resolves it to an absolute path and fails if it is not a directory.

The bytes are the ones `programs.json` records (`sha256File`, and `sha256OnChain`
once padded to `onChainLen`). Keep them in private storage keyed by `sha256OnChain`.
`refresh.mjs fetch` then `build --elf-out <dir>` writes such a directory, but an RPC
serves only a program's current bytes, so once an upgradeable program changes on
chain these copies cannot be fetched again: a lost copy means refreshing the
fixtures against the new bytes.

Without the two copies, `test.sh` prints the one line

    jupiter_fork: skipped, set MERRYMEN_JUPITER_FORK_PROGRAMS (release gate)

and still runs every other target. `scripts/ci/solana-runtime-tests.mjs` accepts that
line in place of this target alone (with a `::warning::`); custody, recovery and any
other target must still run in full. CI is not given the copies, so it always skips
this test: the fork test is a release gate, run with the copies before a vault release
and whenever the executor's route or quote parameters change.

Refreshing the SPL fixtures after an upgrade adds another copy to the history: delete
the old file in the same commit and record the new read in `programs.json`.

## Refreshing

`refresh.mjs` (Node 22 or later, built-ins only) writes every file here. `fetch`
makes only keyless, read-only requests (a Jupiter quote and swap-instructions build
at lite-api.jup.ag, nothing signed or sent; `getMultipleAccounts`, `getBlockTime` and
`getAccountInfo` on a public RPC) into an empty directory outside the repository;
`build` turns that directory into `route.json`, `accounts.json`, `programs.json` and
the trimmed ELFs (here unless `--elf-out` names another directory; git ignores the
Jupiter and Whirlpool ones here), and refuses an answer that does not name the requested vault
accounts, a program deployed at or after the route's slot, or a Memo program that is
not solana-program-test's bundled copy:

    node refresh.mjs fetch /tmp/jupiter-raw
    node refresh.mjs build /tmp/jupiter-raw

Both derive the test vault's addresses from the vault program (default: `declare_id!`
in `programs/merrymen-vault/src/lib.rs`) and the test's owner seed, and `route.json`
records them as `provenance.builtFor`. The test checks those against the answer and
moves the three vault accounts to its own build's program ID, so a new `declare_id`
needs no refresh. A refresh is needed to test against a program's newer on-chain
bytes (the hashes in `programs.json` pin what the test runs, so an upgrade on chain
changes nothing here until then), another route, or a change to the executor's quote
parameters (`QUOTE` and `BUILD` in `refresh.mjs`).
