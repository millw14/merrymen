#!/usr/bin/env node
/**
 * IN-KIND CAPITAL PREVIEW — READ ONLY, FOR A HUMAN TO CLASSIFY.
 *
 * Lists every non-USDG movement across the named accounts' books, says who
 * authorised each one (read from the UserOperation, never from the trades
 * table), and values the ones a reviewer must look at two ways: V1, the
 * Chainlink round in force, reported as a candidate; V2, the equity step,
 * labelled "estimate, never bookable".
 *
 * It has no apply mode. It cannot write a flow, move a peak, change a risk
 * period or touch a trade: the database half is one REPEATABLE READ READ ONLY
 * snapshot rolled back before the chain is read, and the chain half admits a
 * fixed list of read methods. The only file it writes is its own report,
 * created once with mode 0600.
 */
import { canonical, digest, validateScope, targetDigest, collectSnapshot } from './snapshot.mjs';
export { canonical, digest, validateScope, targetDigest, collectSnapshot, readQuery, MAX_ACCOUNTS, MAX_MARKS, MAX_TRADE_ROWS } from './snapshot.mjs';
import { readFile, open } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE_HEAD = '4346e3d023c32d50fda6673f56a981f10df3a349';
const ACCOUNT = /^0x[0-9a-f]{40}$/i;
const ZERO = '0x0000000000000000000000000000000000000000';
export const CHAIN_ID = 4663;
/** Only blocks this deep are read, as in the receipt gas preview. */
export const CONFIRMATIONS = 64n;

export const HELP = `In-kind capital preview — PREVIEW ONLY. There is no apply, commit, migration, or schema-changing capability.

node --import tsx scripts/in-kind-preview/preview.mjs --account 0xFULL_ACCOUNT [--account 0xFULL_ACCOUNT] [--from-block N] --output /absolute/new-preview.json

Required environment: DATABASE_URL. Optional: MERRYMEN_IN_KIND_RPC (defaults to public Robinhood mainnet).
Requires Node 22.13+, the repository dependencies, and the external runtime pg driver. 1-32 full account addresses; prefixes are refused.
The output is created once with owner-only file permissions (0600). Existing files are never overwritten.
Provenance is read from each UserOperation's nonce, never from whether a trades row exists.
V1 values are candidates at the Chainlink round in force. V2 equity steps are estimates and never bookable.
No DATABASE_URL, RPC URL, amounts or addresses are printed; the console shows aggregate counts and the preview digest only.
No database write, booking, peak change, backup or trading resumption is implied by a preview.
`;

export function parseArgs(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const accounts = []; let output; let fromBlock = 0n; let sawFrom = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i], value = args[++i];
    if (flag === '--account' && value && ACCOUNT.test(value)) accounts.push(value.toLowerCase());
    else if (flag === '--output' && !output && value && value.startsWith('/')) output = value;
    else if (flag === '--from-block' && !sawFrom && value && /^(0|[1-9][0-9]{0,11})$/.test(value)) { fromBlock = BigInt(value); sawFrom = true; }
    else throw new Error('invalid-arguments');
  }
  if (!output) throw new Error('invalid-arguments');
  return { accounts: validateScope(accounts), output, fromBlock };
}

/** The TypeScript halves, loaded only when a preview actually runs. */
export async function loadDeps() {
  const [scanner, value, custody, core] = await Promise.all([
    import('../../worker/src/asset-movements.ts'),
    import('./value.ts'),
    import('../../worker/src/custody.ts'),
    import('../../packages/core/src/index.ts'),
  ]);
  return { scanner, value, custody, core };
}

/**
 * Who each requested account is, from the snapshot alone.
 *
 * Ineligible accounts are reported, not scanned: one registered on another
 * chain, one whose rows disagree about the chain, and one two tenants' grants
 * both claim — whose owner wallet would then be whichever one was guessed.
 */
export function bindScope(snapshot, custodyAddressesOf) {
  return snapshot.accounts.map(({ account, registrations, grants }) => {
    const base = { account, chainId: null, owners: [], custody: [], epochs: [] };
    if (!snapshot.schema.complete) return { ...base, state: 'unsupported-schema' };
    if (!registrations.length) return { ...base, state: 'account-not-registered' };
    const chains = new Set([...registrations.map(r => r.chainId), ...grants.map(g => g.chainId)]);
    if (chains.size !== 1) return { ...base, state: 'conflicting-chain' };
    const [chainId] = chains;
    if (chainId !== CHAIN_ID) return { ...base, chainId, state: 'ineligible-chain' };
    const tenants = new Set(grants.map(g => String(g.tenant ?? '').toLowerCase()));
    if (tenants.size > 1) return { ...base, chainId, state: 'ambiguous-grant' };
    const owners = new Map();
    for (const r of registrations) if (ACCOUNT.test(r.ownerAddress ?? '')) owners.set(r.ownerAddress.toLowerCase(), 'owner-key');
    for (const g of grants) {
      if (ACCOUNT.test(g.owner ?? '')) owners.set(g.owner.toLowerCase(), 'owner-key');
      if (ACCOUNT.test(g.tenant ?? '')) owners.set(g.tenant.toLowerCase(), 'tenant-wallet');
    }
    const custody = [...new Set(grants.flatMap(g => custodyAddressesOf(g)).map(a => a.toLowerCase()))].sort();
    return {
      ...base, chainId, state: 'bound',
      owners: [...owners].map(([address, role]) => ({ address, role })).sort((a, b) => a.address.localeCompare(b.address)),
      custody,
      epochs: [...new Set(registrations.map(r => r.epoch))].sort((a, b) => a - b),
      grantRead: grants.length > 0,
    };
  });
}

export async function buildPreview({ snapshot, accounts, rpc, deps, target, source, fromBlock = 0n, capturedAt = new Date().toISOString() }) {
  accounts = validateScope(accounts);
  const { scanner, value, custody, core } = deps;
  const chainId = Number(BigInt(await rpc('eth_chainId', [])));
  if (chainId !== CHAIN_ID) throw new Error('rpc-is-not-robinhood-mainnet');
  const head = BigInt(await rpc('eth_blockNumber', []));
  const confirmedTo = head - CONFIRMATIONS;
  if (confirmedTo < fromBlock) throw new Error('invalid-arguments');

  const scope = bindScope(snapshot, custody.custodyAddressesOf);
  const bound = scope.filter(s => s.state === 'bound');
  const scanned = bound.length ? await scanner.scanAssetMovements(rpc, {
    accounts: bound.map(s => ({ account: s.account, custody: s.custody, owners: s.owners.map(o => o.address) })),
    usdgToken: core.CASH.USDG,
    fromBlock,
    toBlock: confirmedTo,
    reserveTokens: core.energyReserveTokens(CHAIN_ID),
    // Venues are a weak signal and only ever make a verdict MORE ambiguous:
    // WETH (a wrap is not a deposit) and the zero address (a mint or a burn).
    protocolAddresses: [core.CASH.WETH, ZERO],
    systemAddresses: [...Object.values(core.ENTRYPOINT), ...Object.values(core.INFRA)],
    knownAccounts: bound.map(s => s.account),
    includeReviewTimestamps: true,
  }) : new Map();

  const reads = value.valuationReads(rpc);
  const out = [];
  for (const s of bound) {
    const r = scanned.get(s.account);
    const marks = snapshot.marks.filter(m => m.account === s.account);
    const tradeKeys = new Set(snapshot.tradeHashes.filter(t => t.account === s.account)
      .flatMap(t => [t.userOpHash, t.txHash].filter(Boolean)));
    const movements = [];
    for (const m of r.movements) {
      const review = scanner.REVIEW_KINDS.includes(m.classification.kind);
      movements.push({
        ...m,
        // AN OBSERVATION, NEVER AN INPUT. Shown so a reviewer can see the
        // Shogun shape — an op of ours the ledger has no row for — but the
        // classification above was decided before this was looked up.
        recordedTradeRow: (m.userOpHash && tradeKeys.has(m.userOpHash)) || tradeKeys.has(m.txHash),
        valuation: review ? {
          v1: await value.valueAtRoundInForce({ asset: m.asset, amountRaw: m.amountRaw, at: m.at, reads }),
          v2: value.equityStepEstimate(marks, m.at),
        } : null,
      });
    }
    // NO GRANT, NO CUSTODY. The class and Trencher vaults come only from the
    // grants row, and grants are keyed by tenant: a replaced account loses its
    // row, and the kill switch deletes it — exactly the accounts whose owners
    // most plausibly swept. Scanned without its vaults, a sweep FROM a vault
    // is never swept at all and a sweep back INTO the account reads as a
    // deposit. So the answer is incomplete, and says why, rather than clean.
    const notes = s.grantRead ? r.notes : [...r.notes,
      'no grant was read for this account, so the vaults holding its assets are unknown — a sweep out of a vault is not ' +
      'scanned at all, and a sweep from a vault back into the account can read as a deposit'];
    out.push({ account: s.account, complete: r.complete && s.grantRead, notes, operations: r.operations, counts: r.counts, movements });
  }

  const every = out.flatMap(a => a.movements);
  const count = kind => every.filter(m => m.classification.kind === kind).length;
  const preview = {
    format: 'merrymen.in-kind-preview.v1',
    mode: 'preview-only',
    source,
    databaseTargetDigest: target,
    capture: { capturedAt, isolation: 'repeatable read read only', schema: snapshot.schema, rpcChainId: chainId,
      head: head.toString(), fromBlock: fromBlock.toString(), confirmedTo: confirmedTo.toString(),
      confirmationDepth: Number(CONFIRMATIONS) },
    scope,
    accounts: out,
    summary: {
      accountsRequested: accounts.length,
      accountsScanned: bound.length,
      accountsIneligible: scope.length - bound.length,
      accountsIncomplete: out.filter(a => !a.complete).length,
      movements: every.length,
      capitalCandidates: { 'asset-in': count('asset-in'), 'asset-out': count('asset-out') },
      ambiguous: count('ambiguous'),
      internal: count('internal'),
      tradeLegs: count('trade-leg'),
      excluded: { reserve: count('reserve'), fuel: count('fuel'), custody: count('custody'), protocol: count('protocol') },
      candidatesWithoutTradeRow: every.filter(m => m.classification.capitalCandidate && !m.recordedTradeRow).length,
      ownOpMovementsWithoutTradeRow: every.filter(m => m.userOpHash && !m.recordedTradeRow).length,
      v1Candidates: every.filter(m => m.valuation?.v1.status === 'candidate').length,
      v2Estimates: every.filter(m => m.valuation?.v2.status === 'estimate').length,
      bookable: 0,
      writesPerformed: 0,
      ddlPerformed: 0,
    },
  };
  return JSON.parse(canonical({ ...preview, previewDigest: digest(preview) }));
}

export function plainSummary(preview) {
  const s = preview.summary;
  return `PREVIEW ONLY — 0 database writes; 0 schema changes; nothing bookable.\n` +
    `Accounts: ${s.accountsRequested} requested; ${s.accountsScanned} scanned; ${s.accountsIneligible} ineligible; ${s.accountsIncomplete} with incomplete coverage.\n` +
    `Non-USDG movements: ${s.movements}; capital candidates: in=${s.capitalCandidates['asset-in']}, out=${s.capitalCandidates['asset-out']}; ambiguous: ${s.ambiguous}; internal: ${s.internal}.\n` +
    `Trade legs: ${s.tradeLegs}; excluded: reserve=${s.excluded.reserve}, fuel (native ETH)=${s.excluded.fuel}, custody=${s.excluded.custody}, protocol=${s.excluded.protocol}.\n` +
    `Movements from an account's own operations with no trades row (observation only): ${s.ownOpMovementsWithoutTradeRow}.\n` +
    `V1 candidates (Chainlink round in force): ${s.v1Candidates}; V2 estimates (never bookable): ${s.v2Estimates}.\n` +
    `Preview SHA256: ${preview.previewDigest}\n` +
    `A candidate is a movement for review, not a contribution or a withdrawal. Nothing here may be booked without a separate, reviewed step.\n`;
}

/** Fingerprint the executable sources so a preview can be reproduced and compared. */
export async function sourceFingerprint(here = HERE) {
  const paths = ['preview.mjs', 'snapshot.mjs', 'value.ts',
    '../../worker/src/asset-movements.ts', '../../worker/src/chain-capital.ts', '../../worker/src/gas-backfill.ts',
    '../../worker/src/custody.ts', '../../packages/core/src/capital-classify.ts', '../../packages/core/src/tokens.ts',
    '../../packages/core/src/chain.ts', '../../packages/core/src/energy.ts', '../../packages/core/src/abis.ts'];
  const files = {};
  for (const path of paths) files[path] = digest(await readFile(resolve(here, path)));
  return { baseHead: BASE_HEAD, files };
}

/** Created once, owner-only, fsynced. An existing path — file or symlink — is refused. */
export async function savePreview(output, preview) {
  const file = await open(output, 'wx', 0o600);
  try {
    await file.chmod(0o600);
    await file.writeFile(JSON.stringify(JSON.parse(canonical(preview)), null, 2) + '\n');
    await file.sync();
  } finally { await file.close(); }
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const options = parseArgs(args);
  if (options.help) { process.stdout.write(HELP); return; }
  if (!env.DATABASE_URL) throw new Error('database-url-required');
  const target = targetDigest(env.DATABASE_URL);
  const source = await sourceFingerprint();
  const deps = await loadDeps();
  const pg = await import('pg');
  const Client = pg.Client ?? pg.default?.Client;
  if (typeof Client !== 'function') throw new Error('postgres-read-driver-unavailable');
  const client = new Client({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 10000,
    statement_timeout: 30000, application_name: 'merrymen-in-kind-preview-readonly',
    options: '-c default_transaction_read_only=on' });
  let connected = false;
  try {
    await client.connect();
    connected = true;
    const snapshot = await collectSnapshot(client, options.accounts);
    // The snapshot is rolled back by now, and the connection is closed: no
    // session stays open across the slow public chain reads below.
    await client.end();
    connected = false;
    const rpc = deps.value.createReadOnlyRpc(env.MERRYMEN_IN_KIND_RPC || 'https://rpc.mainnet.chain.robinhood.com');
    const preview = await buildPreview({ snapshot, accounts: options.accounts, rpc, deps, target, source, fromBlock: options.fromBlock });
    await savePreview(options.output, preview);
    process.stdout.write(plainSummary(preview));
  } finally { if (connected) await client.end().catch(() => {}); }
}

function invokedDirectly() {
  try { return !!process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url); }
  catch { return false; }
}
if (invokedDirectly()) {
  main().catch(error => {
    // Driver and RPC messages may carry credential-bearing URLs. Only
    // runner-owned fixed codes are printed.
    const allowed = new Set(['invalid-arguments', 'database-url-required', 'invalid-database-url',
      'scope-exceeds-preview-mark-bound', 'scope-exceeds-preview-trade-bound', 'read-only-snapshot-not-established',
      'rpc-is-not-robinhood-mainnet', 'postgres-read-driver-unavailable']);
    const code = allowed.has(error?.message) ? error.message : 'preview-failed-no-writes-performed';
    process.stderr.write(`${code}. Use --help for invocation.\n`); process.exitCode = 1;
  });
}
