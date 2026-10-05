# Receipt gas preview

This standalone tool compares recorded Postgres rows with confirmed chain
receipts. It reports missing gas evidence that could be filled in a later,
separately reviewed change. It has no apply mode, database writer, migration,
orchestrator hook, signer, or transaction broadcast. Postgres and the chain are
the records it examines; no continuity of a previous SQLite book is required.

Run it from the repository root with Node 22.13+ and the repository dependencies.
The external runtime `pg` driver must already be available, as for the existing
Postgres backend. There is no production startup or deployment change here.

```sh
node --import tsx scripts/receipt-gas-preview/preview.mjs --help
node --import tsx scripts/receipt-gas-preview/preview.mjs \
  --agent PUBLIC_SLUG=0xFULL_CURRENT_ACCOUNT \
  --output /absolute/private-directory/new-preview.json
```

Provide `DATABASE_URL` through the existing private credential mechanism. An
optional `MERRYMEN_RECEIPT_RPC` selects a receipt-read endpoint; the default is
the public Robinhood Chain mainnet RPC. Never paste either value into a PR,
terminal command, preview, or chat. Each invocation requires 1–256 explicit,
unique public slug/current account pairs. Historical accounts and ambiguous
registrations are reported as ineligible. The current account is the first
address in the identity's account history, never inferred from registration
timestamps. An account prefix is insufficient.
The snapshot is bounded to 1,500 recorded settled rows. A larger scope
must be divided explicitly; it is refused rather than silently truncated.

The connection starts with `default_transaction_read_only=on`. The snapshot
uses `REPEATABLE READ READ ONLY`, verifies both settings, issues only fixed
SELECT queries, then rolls back before chain reads. Missing required trade
columns are reported as unavailable evidence; optional nonce/gas-time columns
remain absent. It never adds a column. The preview binds the selected current
account/epoch and all recorded row fields by digest; it exposes gas fields and
public transaction proofs, without private trading amounts or signed grants.

The RPC client exposes only chain ID, head, receipt, block and feed reads. It
requires chain 4663, at least 64 confirmations, a matching canonical block,
exact EntryPoint v0.7 UserOperation identity, sender and verdict. A nonce is
compared to the historical row only when that row recorded one; otherwise the
receipt nonce is an observation, not an independent historical match. Sponsor
payment establishes zero owner gas expense without a price assumption. Owner
expense requires the historical registered ETH/USD round, its publication
boundary, and a maximum six-hour lag. Missing prices, inconsistent existing
money, malformed identities and unavailable reads stay unresolved. The tool
does not convert unknown expense to zero.

The JSON includes source hashes, scope and schema observations, a digest of each
protected row, receipt/price evidence, and proposed fills of NULL gas fields
that exist in the captured schema. If gas_recorded_at is absent, the receipt
timestamp remains proof evidence without a proposed column fill.
Existing monetary values are never proposed for overwrite. Proposed receipt
timestamps are separate from trade/budget timestamps; no risk period, spend,
pause state, anchor, position floor, permission or command cutoff is changed.
The output is created once with mode 0600 and fsynced; existing or symlink
targets are refused. Keep its parent directory private. Console output contains
aggregate counts and the preview digest only; credential-bearing errors are
replaced with fixed error codes.

All entries in operations and legacy summary counters are source rows.
The summary separately counts distinct executions by lowercased account,
epoch and lowercased UserOp hash, duplicate groups and extra repeated rows.
Invalid execution identities remain ungrouped. Mixed row states or conflicting
receipt/delta evidence remain unresolved; differences in RPC observation
traces alone are not conflicting execution evidence. Source rows are never
removed, and neither row counts nor grouped counts are a deduplicated expense
total. Any future writer or budget import must preserve execution identity
and must not sum repeated row costs.

Coverage is limited to recorded landed/reverted rows in the named
current epochs. A gas preview is not a complete portfolio PnL calculation,
proof of contribution completeness, permission to write, or permission to
resume trading. A production Postgres backup and a separate approved plan are
required before any subsequent writer is considered. This tool cannot perform
that write even if supplied an approval file or `--apply` flag.

## Local verification

```sh
node --import tsx --test scripts/receipt-gas-preview/*.test.*
```

The synthetic tests use no production connection. The opt-in actual Postgres
test requires a disposable loopback fixture at
`postgresql://receipt_fixture@127.0.0.1:55973/postgres` and
`MERRYMEN_RECEIPT_PREVIEW_LOCAL_PG=1`. It creates a random local schema, compares
all seeded trade fields and schema before/after the preview, and proves an
attempted update is refused by Postgres. Fixture setup/cleanup performs local
DDL; `DATABASE_URL` is never read by the test.
