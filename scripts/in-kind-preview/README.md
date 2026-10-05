# In-kind capital preview

This standalone tool lists every non-USDG movement across the books of the
accounts you name. For each movement it shows who authorised it, and it
values the movements that need a reviewer's attention. It exists so a person
can classify the balance changes that no trade explains. Examples are an owner
sending TSLA to an account, or sweeping a memecoin out with the owner key.

The tool has no apply mode. It has no database writer, migration,
orchestrator hook, signer or transaction broadcast. It books nothing, moves no
peak and changes no risk period. A candidate it reports is something to
review. It is not a contribution or a withdrawal.

```sh
node --import tsx scripts/in-kind-preview/preview.mjs --help
node --import tsx scripts/in-kind-preview/preview.mjs \
  --account 0xFULL_ACCOUNT [--account 0xFULL_ACCOUNT] \
  [--from-block N] \
  --output /absolute/private-directory/new-preview.json
```

Run it from the repository root with Node 22.13+ and the repository
dependencies. The external runtime `pg` driver must already be available, as
it is for the existing Postgres backend. Supply `DATABASE_URL` through the
existing private credential mechanism. An optional `MERRYMEN_IN_KIND_RPC`
selects the read endpoint. The default is the public Robinhood Chain mainnet
RPC. Never paste either value into a PR, a terminal command, a preview or a
chat.

Each run takes 1 to 32 full account addresses. A prefix is refused.

## Who authorised a movement

The signer is read from the operation itself. It is never inferred from
whether a `trades` row exists. A session-key swap whose row went missing (the
Shogun case) is still a swap.

- **The UserOperationEvent nonce.** EntryPoint v0.7 records every operation's
  nonce in its own event. Kernel v3 packs the authorising validator into the
  nonce key: `0x00` is root (the owner's key), `0x01` is a secondary
  validator and `0x02` is a permission (the session key). A contract cannot
  forge a log at the EntryPoint's address. Any mode or validator type this
  tool has not measured is refused, not read as the nearest match.
- **The handleOps calldata.** Kernel's `execute` encodes the ETH each call
  sent. This is the only place a curve buy paid in native ETH shows its other
  half. Only a plain execute in the default exec type is read. A TRY batch or
  a delegatecall is reported as unread.
- **Which operation produced which log.** Receipts are split at each
  operation's own event. In a bundle that holds an owner sweep beside an
  agent swap, the sweep is never paired with the swap's legs.

## Classification

| Kind | Meaning |
| --- | --- |
| `asset-out`, `asset-in` | **Capital candidates.** An `asset-out` is the owner's root key sweeping with nothing coming back. An `asset-in` is the root key bringing an asset in, or the owner's own wallet (the owner key or the signed-in tenant wallet) sending it in or sending the transaction that delivered it. |
| `trade-leg` | A different asset crossed the book's edge the other way in the same operation. Native ETH sent by the execution counts as that other asset. |
| `ambiguous` | The movement could not be decided, and the reason is given in words. Examples: a session key's movement with nothing paired, an unsolicited inbound transfer, an allowance spent without an operation, an unread signer, or root-key executions that were not decoded. A session key's movement is never a candidate. |
| `reserve` | The energy reserve token. Excluded, because it sits outside the trading book. |
| `custody` | Between the account and its own class or Trencher vault. Excluded. |
| `internal`, `protocol` | Another scanned account, or chain infrastructure (an EntryPoint, Permit2, the operation's own paymaster). |

USDG legs are not classified here. They belong to `classifyUsdgMovement` and
chain-capital, and they are used here only as the other half of a swap.

## Valuation

Valuation runs only for the kinds a reviewer must read: the candidates,
`ambiguous` and `internal`.

- **V1: the Chainlink round in force.** V1 uses the round in force when the
  movement's block was sealed. It applies the same six-hour staleness bound
  and successor-round proof as the receipt gas preview. It is reported as a
  **candidate**. Only ETH, WETH and the registered stock tokens have a feed.
  A stock token uses today's ERC-8056 multiplier, and the report says so. A
  weekend-stale stock round gives no V1.
- **V2: the equity step.** V2 compares the funded book's last mark before the
  movement with its first mark after it. Paper marks are ignored. It is
  labelled **"estimate, never bookable"**. That interval also contains price
  moves, trades and gas. When the marks were written from the very flows
  under review, the figure is circular.

## Database and chain

The connection starts with `default_transaction_read_only=on`. The snapshot
uses `REPEATABLE READ READ ONLY` and checks both settings. Every statement
passes a gate that admits SELECT only. The transaction is rolled back, and
the connection closed, before any chain read starts.

The tool reads the following:

- `agents`: owner key, chain and epoch.
- `grants`: named JSON fields only. These are the owner key, the tenant
  wallet, the grant features and the vault addresses. The sealed session key
  and the serialized permission are never selected.
- `equity`: non-paper marks, at most 250,000.
- `trades`: hashes and status only, at most 100,000.

A scope larger than these bounds is refused, never truncated. A `trades` row
is shown next to a movement as an observation. It is never an input to the
classification.

The RPC transport admits `eth_chainId`, `eth_blockNumber`, `eth_getLogs`,
`eth_getTransactionReceipt`, `eth_getTransactionByHash`,
`eth_getBlockByNumber` and `eth_call`. It refuses everything else before a
request leaves the process. Node error text is replaced with fixed codes.

The tool requires chain 4663 and reads only blocks with at least 64
confirmations. It sweeps every ERC-20 Transfer touching a book address, for
any token, and every UserOperationEvent each account sent. Anything that
cannot be read is marked: an unread window, receipt, calldata or block time
leaves the account `complete: false`, and the movements it touched are
`ambiguous`.

Native ETH arriving outside an operation of the account emits no log, and
this node has no traces. Every account's notes say this explicitly, rather
than reporting "none".

## Output

The JSON includes:

- source hashes, the database target digest (no credentials) and the capture
  block range
- each account's binding: its state, owner wallets and custody
- every movement with its provenance, classification, trade-row observation
  and valuations
- a summary in which `bookable`, `writesPerformed` and `ddlPerformed` are
  always 0
- a `previewDigest` over everything else.

The file is created once with mode 0600 and fsynced. An existing path, or a
symlink, is refused. The report holds account addresses and amounts, so keep
its parent directory private. The console prints aggregate counts and the
digest only.

## Local verification

```sh
node --import tsx --test scripts/in-kind-preview/*.test.*
node --import tsx --test packages/core/src/capital-classify.test.ts worker/src/asset-movements.test.ts
```

The synthetic tests use no production connection. A fake Postgres client
records every statement, and a fake node honours log filters and answers
Chainlink reads.
