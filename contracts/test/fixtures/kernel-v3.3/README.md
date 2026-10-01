# Kernel v3.3 revocation fixture

`runtime.json` contains deployed runtime bytecode, not a mock of the validation
logic. It was retrieved on 2026-10-01 using read-only `eth_getCode` at Robinhood
Chain mainnet (chain ID 4663), block **77570973** (`0x49fa39d`), hash
`0xa65d5936875b26c74d5ac33e0d8d40e92f18e9b399b67802594645b58e37030e`.
The RPC endpoint and source addresses are recorded in the JSON. No transactions
were sent to that network. The tests never contact it or require any credentials.

The addresses match the installed ZeroDev SDK's Kernel 0.3.3 implementation,
ECDSA root validator, and permissions ECDSA signer constants:

| Module | Address | SHA-256 of decoded runtime bytes |
| --- | --- | --- |
| Kernel | `0xd6CEDDe84be40893d153Be9d467CD6aD37875b28` | `e735a2ba41fb2530beff30eab937fdf8d4670683f884569dab5d1c0ca15272f6` |
| ECDSAValidator | `0x845ADb2C711129d4f3966735eD98a9F09fC4cE57` | `c040057b4c52462b3a85d4e8bbe8ca66bc608984583621ceffcda591cf42eee2` |
| ECDSASigner | `0x6A6F069E2a08c2468e7724Ab3250CdBFBA14D4FF` | `62dafb26f7ee4297080292fd0b77706b8e09e7b36dc9857666c17fc4a09acfeb` |

Reviewed upstream Kernel source is tag `v3.3`, commit
[`cd697c7e21715d015e0643af22310a99aa17433b`](https://github.com/zerodevapp/kernel/tree/cd697c7e21715d015e0643af22310a99aa17433b):

- [`ValidationManager.sol`](https://github.com/zerodevapp/kernel/blob/cd697c7e21715d015e0643af22310a99aa17433b/src/core/ValidationManager.sol): `_invalidateNonce`, `_enableDigest`, `_verifyEnableSig` and permission installation.
- [`Kernel.sol`](https://github.com/zerodevapp/kernel/blob/cd697c7e21715d015e0643af22310a99aa17433b/src/Kernel.sol): `initialize`, `validateUserOp`, root exemption, and `invalidateNonce` access control.

These are snapshots of the deployed addresses; they were not rebuilt locally
from upstream Solidity. Hashes detect accidental fixture changes. Any update
requires reviewing its chain/block provenance and upstream implementation again.

Run from `contracts` after installing its own dependencies:

```sh
npm test -- --no-compile test/kernel-revocation.test.ts
```

The test installs this code with Hardhat `setCode` on an isolated local EVM and
calls the actual Kernel `initialize`. Test ECDSA keys sign real EIP-712 enable
authorizations and ERC-4337 operation hashes. The EntryPoint address is locally
impersonated; validation must succeed before the harness executes the owner's
self-call to `invalidateNonce`. No storage slot is edited to simulate revocation.
The app's actual `nextRevocationNonce` determines the cutoff.

Coverage proves installed permissions and unused enable authorizations worked
before invalidation and fail with the specific Kernel errors afterward. It also
covers an authorization signed while the account has no code, then deployment
and revocation, root-owner validity, and fresh-grant validity after revocation.
Permissions use the real ECDSA signer without trading policies to isolate the
account-wide nonce boundary. This is not a factory/CREATE2, bundler, full
EntryPoint gas/nonce, policy, or public-chain end-to-end test; those boundaries
are not replaced by this fixture.
