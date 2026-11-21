#!/usr/bin/env node
import { canonical, digest, validateScope, targetDigest, collectSnapshot } from './snapshot.mjs';
export { canonical, digest, validateScope, targetDigest, collectSnapshot, readQuery, MAX_ACCOUNTS, MAX_OPERATIONS } from './snapshot.mjs';
import { readFile, open } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE_HEAD = '4346e3d023c32d50fda6673f56a981f10df3a349';
const ACCOUNT = /^0x[0-9a-f]{40}$/i;
const SLUG = /^[0-9abcdefghjkmnpqrstvwxyz]{16}$/;
const HASH = /^0x[0-9a-f]{64}$/i;
const GAS_FIELDS = ['gas_wei', 'sponsored_gas_wei', 'gas_units', 'gas_usdg', 'gas_recorded_at'];
export const HELP = `Receipt gas recovery — PREVIEW ONLY. There is no apply, commit, migration, or schema-changing capability.

node --import tsx scripts/receipt-gas-preview/preview.mjs --agent PUBLIC_SLUG=0xACCOUNT [--agent PUBLIC_SLUG=0xACCOUNT] --output /absolute/new-preview.json

Required environment: DATABASE_URL. Optional: MERRYMEN_RECEIPT_RPC (defaults to public Robinhood mainnet).
Requires Node 22.13+, the repository dependencies, and the external runtime pg driver. Named slug/address scope is required and limited to 256 pairs and 1500 settled records. Both must match the current canonical database identity.
The output is created once with owner-only file permissions. Existing files are never overwritten.
Only confirmed chain 4663 receipts are examined. Missing owner gas prices stay unknown.
No DATABASE_URL, RPC credentials, balances, holdings, trading amounts, or signed grant are printed or saved.
No database backup, write approval, portfolio reconciliation, or trading resumption is implied by a preview.
`;

export function parseArgs(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const scope = []; let output;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i], value = args[++i];
    if (flag === '--agent' && value) {
      const [slug, account, extra] = value.split('=');
      if (!SLUG.test(slug ?? '') || !ACCOUNT.test(account ?? '') || extra !== undefined) throw new Error('invalid-arguments');
      scope.push({ slug, account: account.toLowerCase() });
    }
    else if (flag === '--output' && !output && value && value.startsWith('/')) output = value;
    else throw new Error('invalid-arguments');
  }
  if (!output) throw new Error('invalid-arguments');
  return { scope: validateScope(scope), output };
}
export function intendedDelta(row, proof, schema) {
  const values = { gas_wei: proof.payer === 'owner' ? proof.gasWei : null,
    sponsored_gas_wei: proof.payer === 'sponsor' ? proof.gasWei : null,
    gas_units: proof.gasUnits, gas_usdg: proof.usdg, gas_recorded_at: proof.at };
  return Object.fromEntries(GAS_FIELDS.filter(k => row[k] === null && values[k] !== null &&
    (k !== 'gas_recorded_at' || schema?.gasRecordedAtPresent === true)).map(k => [k, values[k]]));
}

/** Count source rows separately from executions. No source row or expense is rewritten. */
export function executionSummary(operations) {
  const groups = new Map(); let rowsWithoutExecutionIdentity = 0;
  for (const operation of operations) {
    const { row } = operation;
    if (!ACCOUNT.test(row.agent_id ?? '') || !Number.isSafeInteger(row.epoch) || row.epoch < 1 || !HASH.test(row.user_op_hash ?? '')) {
      rowsWithoutExecutionIdentity++; continue;
    }
    const key = canonical([row.agent_id.toLowerCase(), row.epoch, row.user_op_hash.toLowerCase()]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(operation);
  }
  const states = Object.fromEntries(['eligible', 'already-complete', 'unknown', 'ineligible', 'mixed'].map(k => [k, 0]));
  let duplicateExecutionGroups = 0, extraRowsForDuplicateExecutions = 0, conflictingEvidenceExecutionGroups = 0;
  for (const rows of groups.values()) {
    if (rows.length > 1) { duplicateExecutionGroups++; extraRowsForDuplicateExecutions += rows.length - 1; }
    const distinctStates = new Set(rows.map(o => o.state));
    const receipts = new Set(), transactions = new Set(), proposed = new Map(); let conflict = false;
    for (const o of rows) {
      if (HASH.test(o.row.tx_hash ?? '')) transactions.add(o.row.tx_hash.toLowerCase());
      if (o.proof?.recoveredGas) {
        const p = { ...o.proof.recoveredGas };
        for (const field of ['account', 'userOpHash', 'txHash', 'blockHash']) if (typeof p[field] === 'string') p[field] = p[field].toLowerCase();
        if (p.price) p.price = { ...p.price, feed: p.price.feed.toLowerCase() };
        receipts.add(canonical(p));
      }
      for (const [field, value] of Object.entries(o.intendedMissingFieldDelta ?? {})) {
        const encoded = canonical(value);
        if (proposed.has(field) && proposed.get(field) !== encoded) conflict = true;
        proposed.set(field, encoded);
      }
    }
    conflict ||= receipts.size > 1 || transactions.size > 1;
    if (conflict) conflictingEvidenceExecutionGroups++;
    states[distinctStates.size === 1 && !conflict ? rows[0].state : 'mixed']++;
  }
  return { identity: ['lower-account', 'epoch', 'lower-user-op-hash'], distinctExecutions: groups.size,
    duplicateExecutionGroups, extraRowsForDuplicateExecutions, conflictingEvidenceExecutionGroups, rowsWithoutExecutionIdentity, states };
}

export async function buildPreview({ snapshot, scope, chain, recoverGasProof, target, source, capturedAt = new Date().toISOString() }) {
  scope = validateScope(scope);
  const chainId = await chain.chainId();
  if (chainId !== 4663) throw new Error('rpc-is-not-robinhood-mainnet');
  const head = await chain.head();
  const scopeStates = scope.map(request => snapshot.bindings.find(b => b.slug === request.slug && b.account === request.account)
    ?? { ...request, state: 'named-account-binding-not-proven', canonicalAgent: null });
  const operations = [];
  for (const item of snapshot.snapshots) {
    const { row } = item;
    const scopeState = scopeStates.find(a => a.account === row.agent_id.toLowerCase());
    let state, why, proof = null, delta = {};
    const observations = { receiptEnvelope: null, receiptGasEvents: [], canonicalBlock: null, latestRound: null, roundReads: [] };
    const observedChain = { ...chain,
      receipt: async hash => { const receipt = await chain.receipt(hash); observations.receiptEnvelope = { transactionHash: receipt.transactionHash, blockHash: receipt.blockHash, blockNumber: receipt.blockNumber.toString(), status: receipt.status }; observations.receiptGasEvents = receipt.logs
        .filter(log => log.address.toLowerCase() === '0x0000000071727de22e5e9d8baf0edac6f37da032' && log.topics[1]?.toLowerCase() === row.user_op_hash?.toLowerCase())
        .map(log => ({ address: log.address, topics: [...log.topics], data: log.data })); return receipt; },
      block: async n => { const block = await chain.block(n); observations.canonicalBlock = { number: n.toString(), hash: block.hash, timestamp: block.timestamp.toString() }; return block; },
      latestRound: async () => { const round = await chain.latestRound(); observations.latestRound = round; return round; },
      round: async id => { const round = await chain.round(id); observations.roundReads.push({ requestedRoundId: id.toString(), round }); return round; },
    };
    if (!scopeState || scopeState.state !== 'bound-current-named-account' || row.epoch !== scopeState.canonicalAgent.epoch) {
      state = 'ineligible'; why = 'current-account-chain-or-epoch-mismatch';
    } else if (!HASH.test(row.tx_hash ?? '') || !HASH.test(row.user_op_hash ?? '')) {
      state = 'ineligible'; why = 'no-exact-on-chain-transaction-and-operation-identity';
    } else if (!/^[1-9][0-9]*$/.test(String(row.id)) || !Number.isSafeInteger(Number(row.id)) ||
      !Number.isSafeInteger(row.epoch) || row.epoch < 1 ||
      (row.gas_usdg !== null && (!Number.isFinite(row.gas_usdg) || row.gas_usdg < 0))) {
      state = 'ineligible'; why = 'invalid-recorded-accounting-value';
    } else {
      try { proof = await recoverGasProof({ ...row, id: Number(row.id), gas_usdg: null }, observedChain, chainId, head); }
      catch { why = 'receipt-or-canonical-block-read-unavailable'; }
      if (!proof) { state = 'unknown'; why ??= 'receipt-identity-verdict-nonce-finality-or-existing-evidence-not-proven'; }
      else if (proof.usdg === null) {
        state = 'unknown'; why = 'owner-gas-historical-price-unavailable-exact-expense-refused';
      } else if (row.gas_usdg !== null && (Math.abs(row.gas_usdg * 1e6 - Math.round(row.gas_usdg * 1e6)) > 0.00001 ||
        !Number.isSafeInteger(Math.round(row.gas_usdg * 1e6)) || Math.round(row.gas_usdg * 1e6) !== Math.round(proof.usdg * 1e6))) {
        state = 'unknown'; why = 'recorded-expense-does-not-match-independent-historical-price';
      } else {
        delta = intendedDelta(row, proof, snapshot.schema);
        state = Object.keys(delta).length ? 'eligible' : 'already-complete';
        why = state === 'eligible' ? 'confirmed-missing-expense-evidence' : 'confirmed-existing-expense-evidence';
      }
    }
    const fullProof = proof ? { recoveredGas: proof, observations } : null;
    const proofDigest = fullProof ? digest(fullProof) : null;
    const operation = { ...item, state, why, proof: fullProof, proofDigest, intendedMissingFieldDelta: delta };
    operations.push({ ...operation, operationDigest: digest(operation) });
  }
  const counts = Object.fromEntries(['eligible', 'already-complete', 'unknown', 'ineligible'].map(k => [k, operations.filter(o => o.state === k).length]));
  const intendedFieldCounts = Object.fromEntries(GAS_FIELDS.map(field => [field,
    operations.filter(o => Object.hasOwn(o.intendedMissingFieldDelta, field)).length]));
  const executions = executionSummary(operations);
  const preview = { format: 'merrymen.receipt-gas-preview.v1', mode: 'preview-only', source,
    databaseTargetDigest: target, capture: { capturedAt, isolation: 'repeatable read read only',
      schema: snapshot.schema, rpcChainId: chainId, confirmationDepth: 64, head: head.toString() }, scope: scopeStates,
    operations, summary: { accountsRequested: scope.length, accountsIneligible: scopeStates.filter(s => s.state !== 'bound-current-named-account').length,
      // v1 compatibility fields and operations[] describe source rows, not distinct expenses.
      countUnit: 'source-rows', recordedSettledRows: operations.length,
      recordedSettledOperations: operations.length, ...counts, intendedFieldCounts,
      executions,
      historicalRowNonceCoverage: { recorded: operations.filter(o => o.row.user_op_nonce !== null && o.row.user_op_nonce !== '').length,
        absent: operations.filter(o => o.row.user_op_nonce === null || o.row.user_op_nonce === '').length },
      unknownOwnerGasPrices: operations.filter(o => o.why === 'owner-gas-historical-price-unavailable-exact-expense-refused').length,
      allRecordedOperationsHaveProvenExactOwnerExpense: scopeStates.every(s => s.state === 'bound-current-named-account') && operations.length > 0 &&
        executions.rowsWithoutExecutionIdentity === 0 && executions.states.mixed === 0 &&
        operations.every(o => ['eligible', 'already-complete'].includes(o.state)),
      recordedExpenseCoverage: snapshot.schema.complete === false ? 'unavailable-trade-schema' :
        operations.length ? 'recorded-settled-operations-only' : 'no-recorded-settled-operations',
      writesPerformed: 0, ddlPerformed: 0 } };
  return JSON.parse(canonical({ ...preview, previewDigest: digest(preview) }));
}

export function plainSummary(preview) {
  const s = preview.summary;
  const executions = s.executions ?? executionSummary(preview.operations);
  const nonceRows = s.historicalRowNonceCoverage ?? {
    recorded: preview.operations.filter(o => o.row.user_op_nonce !== null && o.row.user_op_nonce !== '').length,
    absent: preview.operations.filter(o => o.row.user_op_nonce === null || o.row.user_op_nonce === '').length,
  };
  return `PREVIEW ONLY — 0 database writes; 0 schema changes.\n` +
    `Accounts: ${s.accountsRequested}; ineligible accounts: ${s.accountsIneligible}; coverage: ${s.recordedExpenseCoverage}.\n` +
    `Settled source rows: ${s.recordedSettledOperations}; eligible rows: ${s.eligible}; already complete rows: ${s['already-complete']}; unknown rows: ${s.unknown}; ineligible rows: ${s.ineligible}.\n` +
    `Distinct executions: ${executions.distinctExecutions}; duplicate groups: ${executions.duplicateExecutionGroups}; extra repeated rows: ${executions.extraRowsForDuplicateExecutions}; rows without exact identity: ${executions.rowsWithoutExecutionIdentity}.\n` +
    `Execution groups by row state: ${Object.entries(executions.states).map(([k,v]) => `${k}=${v}`).join(', ')}; evidence conflicts: ${executions.conflictingEvidenceExecutionGroups}. Mixed groups are unresolved; repeated row costs must not be summed.\n` +
    `Historical nonce fields: recorded=${nonceRows.recorded}, absent=${nonceRows.absent}. Receipt nonces are observations; absent historical nonces are not independently matched or proposed for filling.\n` +
    `Unknown historical owner gas prices refused (source rows): ${s.unknownOwnerGasPrices}.\n` +
    `Intended NULL-field fills (source rows): ${Object.entries(s.intendedFieldCounts).map(([k,v]) => `${k}=${v}`).join(', ')}.\n` +
    `Preview SHA256: ${preview.previewDigest}\n` +
    `This preview does not establish portfolio valuation, contribution completeness, or permission to write.\n`;
}

/** Fingerprint the executable sources for an independently reproducible preview. */
export async function sourceFingerprint(here = HERE) {
  const paths = ['preview.mjs', 'snapshot.mjs', 'runtime.ts', 'receipt-proof.ts',
    '../../worker/src/gas-backfill.ts', '../../packages/core/src/chain.ts',
    '../../packages/core/src/tokens.ts', '../../packages/core/src/abis.ts'];
  const files = {};
  for (const path of paths) files[path] = digest(await readFile(resolve(here, path)));
  return { baseHead: BASE_HEAD, splitFromPullRequest: 252, files };
}

export async function savePreview(output, preview) {
  const file = await open(output, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(JSON.parse(canonical(preview)), null, 2) + '\n'); await file.sync(); }
  finally { await file.close(); }
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const options = parseArgs(args);
  if (options.help) { process.stdout.write(HELP); return; }
  if (!env.DATABASE_URL) throw new Error('database-url-required');
  const target = targetDigest(env.DATABASE_URL);
  const source = await sourceFingerprint();
  // Nothing from an unverified preview file can be applied: this executable only reads.
  const { createReadOnlyChain, recoverGasProof } = await import('./runtime.ts');
  const pg = await import('pg');
  const Client = pg.Client ?? pg.default?.Client;
  if (typeof Client !== 'function') throw new Error('postgres-read-driver-unavailable');
  const client = new Client({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 10000,
    statement_timeout: 10000, application_name: 'merrymen-receipt-preview-readonly',
    options: '-c default_transaction_read_only=on' });
  try {
    await client.connect();
    const snapshot = await collectSnapshot(client, options.scope);
    const preview = await buildPreview({ snapshot, scope: options.scope, target,
      chain: createReadOnlyChain(env.MERRYMEN_RECEIPT_RPC || 'https://rpc.mainnet.chain.robinhood.com'), recoverGasProof,
      source });
    await savePreview(options.output, preview);
    process.stdout.write(plainSummary(preview));
  } finally { await client.end().catch(() => {}); }
}
function invokedDirectly() {
  try { return !!process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url); }
  catch { return false; }
}
if (invokedDirectly()) {
  main().catch(error => {
    // Driver/RPC messages may contain credential-bearing URLs. Print only runner-owned fixed codes.
    const allowed = new Set(['invalid-arguments', 'database-url-required', 'invalid-database-url',
      'unsupported-trade-schema', 'scope-exceeds-preview-row-bound',
      'read-only-snapshot-not-established', 'rpc-is-not-robinhood-mainnet']);
    const code = allowed.has(error?.message) ? error.message : 'preview-failed-no-writes-performed';
    process.stderr.write(`${code}. Use --help for invocation.\n`); process.exitCode = 1;
  });
}
