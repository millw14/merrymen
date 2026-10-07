# Gas repair

The board withholds an agent's P&L for a run ("Gas accounting unavailable") while any landed or reverted trade in it has no gas on record, or gas in wei with no dollar price. Until October 2026, several writers produced such rows:

- reverted trades
- the orphan sweep
- the stranded-op resolver
- any tick on which the ETH price was refused

Those writers now record and price gas. `worker/src/gas-repair-cli.ts` completes the rows that were already written.

## What it writes

It writes only NULL gas columns of rows the board counts as missing. The values come only from two sources:

- **The row's own UserOperationEvent.** The tool finds it in the transaction's receipt by the row's user-op hash, with the row's account as sender. It takes the actual gas cost, the gas used and the paymaster from that event. Its success must match the row's status.
- **The Chainlink ETH/USD round in force at that receipt's block.** This is the price the live path would have used. If no round was published, or the newest one is over six hours old, the row gets wei only and stays unpriced.

It leaves some rows alone and lists them as unresolved:

- a row whose recorded wei or units disagree with its receipt
- a row the receipt says a sponsor paid for, but which books the cost to the owner

Correcting who paid changes a record rather than completing it, and is for a person to decide.

## Running it

Postgres is reachable only inside Railway, so run the tool in the orchestrator container. Container `/tmp` is lost on redeploy, so copy the reports out.

1. Preview. This makes no writes. It prints every row it would complete and the preview digest.

   ```bash
   railway ssh --service orchestrator -- sh -c 'cd /app && node --import tsx worker/src/gas-repair-cli.ts --output /tmp/gas-preview.json'
   ```

   Add `--tenant 0xACCOUNT` to narrow it to one account, or `--max-receipts N` to read more than 500 transactions in one run.

2. Take a backup, for example `railway postgres pitr backup create`, and note its id.

3. Apply the same preview. The tool recomputes it and refuses unless the digest matches. It writes every row and its receipt in one SERIALIZABLE transaction, all or nothing.

   ```bash
   railway ssh --service orchestrator -- sh -c 'cd /app && node --import tsx worker/src/gas-repair-cli.ts --apply --confirm <previewDigest> --backup-ref <backup id> --output /tmp/gas-apply.json'
   ```

4. Copy `/tmp/gas-apply.json` out of the container. It is what `--check` and `--revert` take.

If the apply's COMMIT answer is lost, `--check /tmp/gas-apply.json --output /tmp/gas-check.json` reads the receipts and reports whether it committed. To undo an apply, run `--revert /tmp/gas-apply.json --output /tmp/gas-revert.json`. It restores each row only if the row still holds exactly what the apply wrote.

The ledger mirror never rewrites a settled row's gas, so a completed row stays complete. A child's own SQLite ledger and its hash-chained journal keep what they recorded. The `gas_repairs` receipts table, with its backup reference, is the record of the repair.
