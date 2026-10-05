/**
 * THE PREVIEW END TO END, WITH NO PRODUCTION CONNECTION ANYWHERE.
 *
 * A fake Postgres client that records every statement, and a fake node that
 * honours log filters and answers Chainlink reads. What is proved here: the
 * database half only ever reads inside one read-only transaction it rolls
 * back; the report is created once with mode 0600; the four in-kind shapes
 * come out classified from the operation, never from the trades rows; and the
 * two valuations carry the labels the review depends on.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtemp, readFile, stat, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { concatHex, decodeFunctionData, encodeFunctionData, encodeFunctionResult, pad, parseAbi, toHex } from 'viem';
import {
  bindScope, buildPreview, canonical, collectSnapshot, digest, HELP, loadDeps, main, parseArgs, plainSummary, readQuery,
  savePreview, validateScope,
} from './preview.mjs';

const deps = await loadDeps();
const { core, scanner } = deps;

const EP = core.ENTRYPOINT.v07.toLowerCase();
const ME = '0x00000000000000000000000000000000000000a1';
const OWNER_KEY = '0x00000000000000000000000000000000000000a2';
const TENANT = '0x00000000000000000000000000000000000000a3';
const VAULT = '0x00000000000000000000000000000000000000c0';
const CURVE = '0x00000000000000000000000000000000000000c3';
const POOL = '0x00000000000000000000000000000000000000b1';
const BUNDLER = '0x00000000000000000000000000000000000000e1';
const PEPE = '0x0000000000000000000000000000000000000ee0';
const USDG = core.CASH.USDG.toLowerCase();
const TSLA = core.STOCK_TOKENS.find(t => t.symbol === 'TSLA');
const MERRYMEN = core.energyReserveTokens(4663)[0];
const ECDSA_VALIDATOR = '0x845adb2c711129d4f3966735ed98a9f09fc4ce57';
const GRANT_PONS_CLASS = core.GRANT_PONS_CLASS;

const rootNonce = seq => (BigInt(ECDSA_VALIDATOR) << 80n) | seq;
const sessionNonce = seq => (0x02n << 240n) | (0x3ca1cec8n << 208n) | seq;

// ── calldata and logs, as in worker/src/asset-movements.test.ts ─────────
const HANDLE_OPS = parseAbi([
  'struct PackedUserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }',
  'function handleOps(PackedUserOperation[] ops, address beneficiary)',
]);
const EXECUTE = parseAbi(['function execute(bytes32 execMode, bytes executionCalldata)']);
const single = (target, value, data = '0x') => encodeFunctionData({ abi: EXECUTE, functionName: 'execute',
  args: ['0x' + '0'.repeat(64), concatHex([target, toHex(value, { size: 32 }), data])] });
const handleOps = ops => encodeFunctionData({ abi: HANDLE_OPS, functionName: 'handleOps', args: [ops.map(o => ({
  sender: o.sender, nonce: o.nonce, initCode: '0x', callData: o.callData, accountGasLimits: pad('0x0', { size: 32 }),
  preVerificationGas: 0n, gasFees: pad('0x0', { size: 32 }), paymasterAndData: '0x', signature: '0x' })), BUNDLER] });
const pad32 = a => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const word = n => BigInt(n).toString(16).padStart(64, '0');
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const transfer = (token, from, to, amount) => ({ address: token, topics: [TRANSFER_TOPIC, pad32(from), pad32(to)], data: '0x' + word(amount) });
const before = () => ({ address: EP, topics: [scanner.BEFORE_EXECUTION_TOPIC], data: '0x' });
let n = 0;
const opEvent = (sender, nonce, success = true) => ({ address: EP,
  topics: [scanner.USER_OPERATION_EVENT_TOPIC, '0x' + word(++n + 0xfeed), pad32(sender), pad32('0x0')],
  data: '0x' + word(nonce) + word(success ? 1 : 0) + word(0) + word(0) });

const TIME = block => 1_790_000_000 + block;

// ── the four shapes, plus one movement nobody needs to review ───────────
const SWEEP = { hash: '0x' + '51'.repeat(32), block: 100,
  input: handleOps([{ sender: ME, nonce: rootNonce(4n), callData: single(TSLA.address, 0n, '0xa9059cbb') }]),
  logs: [before(), transfer(TSLA.address, ME, TENANT, 13n * 10n ** 18n), opEvent(ME, rootNonce(4n))] };
const SHOGUN = { hash: '0x' + '52'.repeat(32), block: 200,
  input: handleOps([{ sender: ME, nonce: sessionNonce(9n), callData: single(POOL, 0n, '0x12345678') }]),
  logs: [before(), transfer(USDG, ME, POOL, 25_000_000n), transfer(PEPE, POOL, ME, 400n * 10n ** 18n), opEvent(ME, sessionNonce(9n))] };
const CURVE_BUY = { hash: '0x' + '53'.repeat(32), block: 300,
  input: handleOps([{ sender: ME, nonce: sessionNonce(10n), callData: single(CURVE, 10n ** 16n, '0xd96a094a') }]),
  logs: [before(), transfer(PEPE, CURVE, ME, 400n * 10n ** 18n), opEvent(ME, sessionNonce(10n))] };
const ENERGY = { hash: '0x' + '54'.repeat(32), block: 400,
  input: handleOps([{ sender: ME, nonce: sessionNonce(11n), callData: single(POOL, 0n) }]),
  logs: [before(), transfer(USDG, ME, POOL, 42_000_000n), transfer(MERRYMEN, POOL, ME, 98_000n * 10n ** 18n), opEvent(ME, sessionNonce(11n))] };
const VAULT_SWEEP = { hash: '0x' + '55'.repeat(32), block: 401,
  input: handleOps([{ sender: ME, nonce: rootNonce(5n), callData: single(VAULT, 0n, '0x01') }]),
  logs: [before(), transfer(PEPE, VAULT, ME, 400n * 10n ** 18n), opEvent(ME, rootNonce(5n))] };
const TXS = [SWEEP, SHOGUN, CURVE_BUY, ENERGY, VAULT_SWEEP];

const finish = tx => tx.logs.map((l, i) => ({ ...l, blockNumber: '0x' + tx.block.toString(16), transactionHash: tx.hash, logIndex: '0x' + i.toString(16) }));

// ── a Chainlink TSLA feed with round 99 in force at the sweep ───────────
const CHAINLINK = core.CHAINLINK_ABI;
const PHASE = 1n << 64n;
const roundAt = agg => ({ roundId: PHASE | agg, answer: 250_00000000n,
  updatedAt: BigInt(TIME(SWEEP.block) - 600 - Number(99n - agg) * 1200) });

const fakeNode = (txs = TXS) => {
  const calls = [];
  const rpc = async (method, params) => {
    calls.push(method);
    switch (method) {
      case 'eth_chainId': return '0x1237';
      case 'eth_blockNumber': return '0x2710';
      case 'eth_getLogs': {
        const f = params[0];
        const [from, to] = [Number(BigInt(f.fromBlock)), Number(BigInt(f.toBlock))];
        return txs.flatMap(tx => tx.block < from || tx.block > to ? [] : finish(tx).filter(l =>
          (!f.address || l.address.toLowerCase() === f.address.toLowerCase()) &&
          f.topics.every((want, i) => want == null || (Array.isArray(want) ? want : [want])
            .some(w => w.toLowerCase() === String(l.topics[i] ?? '').toLowerCase()))));
      }
      case 'eth_getTransactionReceipt': {
        const tx = txs.find(t => t.hash === params[0]);
        return tx && { status: '0x1', blockNumber: '0x' + tx.block.toString(16), blockHash: '0x' + word(tx.block), from: BUNDLER, to: EP, logs: finish(tx) };
      }
      case 'eth_getTransactionByHash': {
        const tx = txs.find(t => t.hash === params[0]);
        return tx && { input: tx.input };
      }
      case 'eth_getBlockByNumber': {
        const b = Number(BigInt(params[0]));
        return { number: params[0], hash: '0x' + word(b), timestamp: '0x' + TIME(b).toString(16) };
      }
      case 'eth_call': {
        const { to, data } = params[0];
        if (to.toLowerCase() === TSLA.address.toLowerCase()) {
          return encodeFunctionResult({ abi: core.STOCK_ABI, functionName: 'uiMultiplier', result: 10n ** 18n });
        }
        if (to.toLowerCase() !== TSLA.chainlinkFeed.toLowerCase()) throw new Error('execution reverted');
        const d = decodeFunctionData({ abi: CHAINLINK, data });
        if (d.functionName === 'decimals') return encodeFunctionResult({ abi: CHAINLINK, functionName: 'decimals', result: 8 });
        const agg = d.functionName === 'latestRoundData' ? 100n : d.args[0] & ((1n << 64n) - 1n);
        if (agg < 1n || agg > 100n) throw new Error('execution reverted: No data present');
        const r = roundAt(agg);
        return encodeFunctionResult({ abi: CHAINLINK, functionName: d.functionName, result: [r.roundId, r.answer, r.updatedAt, r.updatedAt, r.roundId] });
      }
      default: throw new Error(`unexpected ${method}`);
    }
  };
  return { rpc, calls };
};

const SNAPSHOT = {
  schema: { complete: true, missingRequiredColumns: [], grantsPresent: true },
  accounts: [{
    account: ME,
    registrations: [{ smartAccount: ME, ownerAddress: OWNER_KEY, chainId: 4663, epoch: 1 }],
    grants: [{ tenant: TENANT, chainId: 4663, smartAccount: ME, owner: OWNER_KEY, grantFeatures: [GRANT_PONS_CLASS],
      ponsClassVaultAddress: VAULT, trencherVaultAddress: null, trencherFactoryAddress: null }],
  }],
  marks: [
    { account: ME, at: TIME(SWEEP.block) - 300, equityUsdg: 5000, epoch: 1, mode: 'live' },
    { account: ME, at: TIME(SWEEP.block) + 300, equityUsdg: 1750, epoch: 1, mode: 'live' },
  ],
  // No row for the Shogun swap: the ledger lost it. The sweep has a row only
  // to show the observation is reported and not used.
  tradeHashes: [{ account: ME, userOpHash: null, txHash: SWEEP.hash, status: 'landed' }],
};

const preview = async (snapshot = SNAPSHOT, txs = TXS) => {
  const { rpc, calls } = fakeNode(txs);
  const p = await buildPreview({ snapshot, accounts: [ME], rpc, deps, target: 'target-digest',
    source: { baseHead: 'test', files: {} }, capturedAt: '2026-10-05T00:00:00.000Z' });
  return { p, calls };
};

describe('arguments', () => {
  it('takes full accounts and an absolute output, and nothing else', () => {
    const o = parseArgs(['--account', ME.toUpperCase().replace('0X', '0x'), '--output', '/tmp/x.json', '--from-block', '12']);
    assert.deepEqual(o, { accounts: [ME], output: '/tmp/x.json', fromBlock: 12n });
    assert.deepEqual(parseArgs(['--help']), { help: true });
    for (const bad of [
      ['--account', '0x00000000000000000000000000000000000000', '--output', '/tmp/x.json'], // a prefix
      ['--account', ME, '--account', ME, '--output', '/tmp/x.json'], // a duplicate
      ['--account', ME, '--output', 'relative.json'],
      ['--account', ME],
      ['--account', ME, '--output', '/tmp/x.json', '--apply'],
      ['--account', ME, '--output', '/tmp/x.json', '--from-block', '-1'],
    ]) assert.throws(() => parseArgs(bad), /invalid-arguments/, bad.join(' '));
    assert.throws(() => validateScope([]), /invalid-arguments/);
    assert.match(HELP, /PREVIEW ONLY/);
  });

  it('refuses before connecting to anything when DATABASE_URL is absent or not Postgres', async () => {
    await assert.rejects(main(['--account', ME, '--output', '/nonexistent/x.json'], {}), /database-url-required/);
    await assert.rejects(main(['--account', ME, '--output', '/nonexistent/x.json'], { DATABASE_URL: 'mysql://h/db' }), /invalid-database-url/);
  });
});

describe('the database half reads, inside one read-only transaction, and rolls back', () => {
  const fakePg = ({ readOnly = 'on', marks = [], trades = [] } = {}) => {
    const statements = [];
    const columns = [
      ...['smart_account', 'owner_address', 'chain_id', 'epoch'].map(c => ({ table_name: 'agents', column_name: c })),
      ...['agent_id', 'equity_usdg', 'at', 'epoch', 'mode'].map(c => ({ table_name: 'equity', column_name: c })),
      ...['agent_id', 'user_op_hash', 'tx_hash', 'status'].map(c => ({ table_name: 'trades', column_name: c })),
      ...['tenant', 'grant_json', 'sealed_session_key'].map(c => ({ table_name: 'grants', column_name: c })),
    ];
    return { statements, query: async (sql, params) => {
      statements.push({ sql, params });
      if (/current_setting/.test(sql)) return { rows: [{ read_only: readOnly, isolation: 'repeatable read' }] };
      if (/information_schema/.test(sql)) return { rows: columns };
      if (/FROM agents/.test(sql)) return { rows: [{ smart_account: ME, owner_address: OWNER_KEY, chain_id: 4663, epoch: 1 }] };
      if (/FROM grants/.test(sql)) return { rows: [{ tenant: TENANT, chain_id: 4663, smart_account: ME, owner: OWNER_KEY,
        grant_features: JSON.stringify([GRANT_PONS_CLASS]), pons_class_vault_address: VAULT, trencher_vault_address: null, trencher_factory_address: null }] };
      if (/FROM equity/.test(sql)) return { rows: marks };
      if (/FROM trades/.test(sql)) return { rows: trades };
      return { rows: [] };
    } };
  };

  it('opens REPEATABLE READ READ ONLY, issues only SELECTs, and ends with ROLLBACK', async () => {
    const pg = fakePg({ marks: [{ account: ME, at: 1, equity_usdg: '5', epoch: 1, mode: 'live' }] });
    const s = await collectSnapshot(pg, [ME]);
    assert.equal(pg.statements[0].sql, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    assert.equal(pg.statements.at(-1).sql, 'ROLLBACK');
    for (const { sql } of pg.statements.slice(1, -1)) assert.match(sql, /^\s*(SELECT|WITH)\b/i);
    assert.equal(s.accounts[0].grants[0].ponsClassVaultAddress, VAULT);
    assert.deepEqual(s.accounts[0].grants[0].grantFeatures, [GRANT_PONS_CLASS]);
    assert.equal(s.marks[0].equityUsdg, 5);
  });

  it('never selects the sealed session key or the whole grant document', async () => {
    const pg = fakePg();
    await collectSnapshot(pg, [ME]);
    const grantsSql = pg.statements.find(s => /FROM grants/.test(s.sql)).sql;
    assert.doesNotMatch(grantsSql, /sealed_session_key/);
    assert.doesNotMatch(grantsSql, /grant_json\s*(,|\bAS\b|FROM)/i, 'only ->> / -> projections of named fields');
    assert.doesNotMatch(grantsSql, /serialized/);
  });

  it('refuses when the transaction is not read-only — and still rolls back', async () => {
    const pg = fakePg({ readOnly: 'off' });
    await assert.rejects(collectSnapshot(pg, [ME]), /read-only-snapshot-not-established/);
    assert.equal(pg.statements.at(-1).sql, 'ROLLBACK');
  });

  it('refuses a scope larger than its bound rather than truncating it', async () => {
    const pg = fakePg({ marks: [{}, {}, {}] });
    await assert.rejects(collectSnapshot(pg, [ME], { maxMarks: 2 }), /scope-exceeds-preview-mark-bound/);
    assert.equal(pg.statements.at(-1).sql, 'ROLLBACK');
  });

  it('the statement gate refuses anything that writes', async () => {
    const client = { query: async () => ({ rows: [] }) };
    for (const sql of ['UPDATE trades SET status = 1', 'INSERT INTO flows VALUES (1)', 'WITH x AS (DELETE FROM equity RETURNING *) SELECT 1',
      'SELECT 1; DROP TABLE trades', 'CREATE TABLE x (a int)', 'SELECT set_config(1); SET x = 1']) {
      await assert.rejects(readQuery(client, sql), /non-read-query-refused/, sql);
    }
  });
});

describe('who each account is', () => {
  const custodyAddressesOf = deps.custody.custodyAddressesOf;
  it('binds owner key, tenant wallet and class vault from the snapshot', () => {
    const [s] = bindScope(SNAPSHOT, custodyAddressesOf);
    assert.equal(s.state, 'bound');
    assert.deepEqual(s.owners, [{ address: OWNER_KEY, role: 'owner-key' }, { address: TENANT, role: 'tenant-wallet' }]);
    assert.deepEqual(s.custody, [VAULT]);
  });

  it('refuses another chain, a chain conflict, two tenants and an unregistered account', () => {
    const one = acc => bindScope({ ...SNAPSHOT, accounts: [{ ...SNAPSHOT.accounts[0], ...acc }] }, custodyAddressesOf)[0].state;
    assert.equal(one({ registrations: [{ ...SNAPSHOT.accounts[0].registrations[0], chainId: 46630 }], grants: [] }), 'ineligible-chain');
    assert.equal(one({ grants: [{ ...SNAPSHOT.accounts[0].grants[0], chainId: 1 }] }), 'conflicting-chain');
    assert.equal(one({ grants: [SNAPSHOT.accounts[0].grants[0], { ...SNAPSHOT.accounts[0].grants[0], tenant: POOL }] }), 'ambiguous-grant');
    assert.equal(one({ registrations: [] }), 'account-not-registered');
    assert.equal(bindScope({ ...SNAPSHOT, schema: { complete: false } }, custodyAddressesOf)[0].state, 'unsupported-schema');
  });
});

describe('the preview', () => {
  it('classifies the four shapes from the operation and never from the trades rows', async () => {
    const { p } = await preview();
    const moves = p.accounts[0].movements.map(m => [m.txHash, m.asset, m.classification.kind]);
    assert.deepEqual(moves, [
      [SWEEP.hash, TSLA.address.toLowerCase(), 'asset-out'], // an owner sudo sweep
      [SHOGUN.hash, PEPE, 'trade-leg'], // a session-key swap with no trades row
      [CURVE_BUY.hash, PEPE, 'trade-leg'], // a native-ETH curve buy…
      [CURVE_BUY.hash, 'native', 'fuel'], // …and the ETH that paid for it, which sits outside the book
      [ENERGY.hash, MERRYMEN, 'reserve'], // excluded
      [VAULT_SWEEP.hash, PEPE, 'custody'], // excluded
    ]);
    const shogun = p.accounts[0].movements.find(m => m.txHash === SHOGUN.hash);
    assert.equal(shogun.recordedTradeRow, false, 'the missing row is shown…');
    assert.equal(shogun.classification.capitalCandidate, false, '…and changed nothing');
  });

  it('values the candidate two ways: V1 a candidate at the round in force, V2 an estimate never bookable', async () => {
    const { p } = await preview();
    const sweep = p.accounts[0].movements.find(m => m.txHash === SWEEP.hash);
    assert.equal(sweep.at, TIME(SWEEP.block));
    assert.equal(sweep.valuation.v1.status, 'candidate');
    assert.equal(sweep.valuation.v1.label, 'candidate');
    assert.equal(sweep.valuation.v1.valueUsdgRaw, '3250000000');
    assert.equal(sweep.valuation.v1.roundId, (PHASE | 99n).toString());
    assert.equal(sweep.valuation.v2.label, 'estimate, never bookable');
    assert.equal(sweep.valuation.v2.bookable, false);
    assert.equal(sweep.valuation.v2.stepUsdg, -3250);
    // Nothing that needs no review is valued.
    for (const m of p.accounts[0].movements.filter(m => !m.classification.capitalCandidate)) assert.equal(m.valuation, null);
  });

  it('summarises with nothing bookable and nothing written, and binds itself by digest', async () => {
    const { p } = await preview();
    assert.equal(p.mode, 'preview-only');
    assert.deepEqual(p.summary.capitalCandidates, { 'asset-in': 0, 'asset-out': 1 });
    assert.deepEqual(p.summary.excluded, { reserve: 1, fuel: 1, custody: 1, protocol: 0 });
    assert.equal(p.summary.tradeLegs, 2);
    assert.equal(p.summary.bookable, 0);
    assert.equal(p.summary.writesPerformed, 0);
    assert.equal(p.summary.ddlPerformed, 0);
    assert.equal(p.capture.confirmedTo, String(0x2710 - 64));
    const { previewDigest, ...rest } = p;
    assert.equal(previewDigest, digest(rest));
    const again = (await preview()).p;
    assert.equal(again.previewDigest, previewDigest, 'reproducible from the same chain and snapshot');
  });

  it('reads the chain only through the read methods', async () => {
    const { calls } = await preview();
    for (const m of new Set(calls)) {
      assert.ok(['eth_chainId', 'eth_blockNumber', 'eth_getLogs', 'eth_getTransactionReceipt', 'eth_getTransactionByHash',
        'eth_getBlockByNumber', 'eth_call'].includes(m), m);
    }
  });

  it('refuses a node that is not Robinhood mainnet', async () => {
    const { rpc } = fakeNode();
    await assert.rejects(buildPreview({ snapshot: SNAPSHOT, accounts: [ME], deps, target: 't', source: {},
      rpc: async (m, p) => (m === 'eth_chainId' ? '0x1' : rpc(m, p)) }), /rpc-is-not-robinhood-mainnet/);
  });

  it('an ineligible account is reported and not scanned', async () => {
    const { p, calls } = await preview({ ...SNAPSHOT, accounts: [{ ...SNAPSHOT.accounts[0], registrations: [] }] });
    assert.equal(p.scope[0].state, 'account-not-registered');
    assert.equal(p.accounts.length, 0);
    assert.ok(!calls.includes('eth_getLogs'));
  });

  it('the console summary carries counts and the digest — no address, no amount', async () => {
    const { p } = await preview();
    const text = plainSummary(p);
    assert.doesNotMatch(text, /0x[0-9a-f]{40}/i);
    assert.doesNotMatch(text, /3250/);
    assert.match(text, new RegExp(p.previewDigest));
    assert.match(text, /never bookable/);
  });
});

describe('the report file', () => {
  it('is created once, owner-only (0600), and never overwrites or follows a link', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'in-kind-preview-'));
    try {
      const out = join(dir, 'preview.json');
      await savePreview(out, { a: 1n, b: 'x' });
      assert.equal((await stat(out)).mode & 0o777, 0o600);
      assert.deepEqual(JSON.parse(await readFile(out, 'utf8')), JSON.parse(canonical({ a: 1n, b: 'x' })));
      await assert.rejects(savePreview(out, { a: 2 }), /EEXIST/);
      const target = join(dir, 'elsewhere.json');
      await writeFile(target, 'untouched');
      const link = join(dir, 'link.json');
      await symlink(target, link);
      await assert.rejects(savePreview(link, { a: 3 }), /EEXIST/);
      assert.equal(await readFile(target, 'utf8'), 'untouched');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
