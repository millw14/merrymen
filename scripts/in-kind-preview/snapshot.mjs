/**
 * THE DATABASE HALF OF THE IN-KIND PREVIEW: ONE READ-ONLY SNAPSHOT, THEN ROLLBACK.
 *
 * What it reads, and why each is needed:
 *   agents   the account's owner key and chain, from every registration row.
 *   grants   ONLY the named JSON fields the classifier needs — the owner key,
 *            the tenant wallet (the grants row's key), and the vault addresses
 *            custody.ts derives a book from. The sealed session key and the
 *            serialized permission are never selected, so they never enter
 *            this process.
 *   equity   the funded book's marks (paper excluded), for V2 only.
 *   trades   hashes and status, nothing else — an OBSERVATION shown beside a
 *            movement ("a trades row exists for this op"), never an input to
 *            its classification. The Shogun case is why.
 *
 * The connection is opened with default_transaction_read_only=on, the
 * snapshot runs REPEATABLE READ READ ONLY and verifies both, every statement
 * passes a SELECT-only gate, and the transaction is rolled back before any
 * chain read starts. Nothing here can write, and nothing here tries.
 */
import { createHash } from 'node:crypto';

const ACCOUNT = /^0x[0-9a-f]{40}$/i;
export const MAX_ACCOUNTS = 32;
/** Funded-book marks across the whole scope. A larger scope is divided, never truncated. */
export const MAX_MARKS = 250000;
/** Trade hash rows across the whole scope, under the same rule. */
export const MAX_TRADE_ROWS = 100000;

export function canonical(value) {
  const normalize = x => {
    if (typeof x === 'bigint') return x.toString();
    if (typeof x === 'number' && !Number.isFinite(x)) return { invalidNumber: String(x) };
    if (Array.isArray(x)) return x.map(normalize);
    if (x && typeof x === 'object') return Object.fromEntries(Object.keys(x).sort().filter(k => x[k] !== undefined).map(k => [k, normalize(x[k])]));
    return x;
  };
  return JSON.stringify(normalize(value));
}
export const digest = value => createHash('sha256')
  .update(typeof value === 'string' || value instanceof Uint8Array ? value : canonical(value)).digest('hex');

/** 1–32 full, distinct account addresses. A prefix is not an account. */
export function validateScope(accounts) {
  if (!Array.isArray(accounts) || !accounts.length || accounts.length > MAX_ACCOUNTS ||
    accounts.some(a => typeof a !== 'string' || !ACCOUNT.test(a)) ||
    new Set(accounts.map(a => a.toLowerCase())).size !== accounts.length) throw new Error('invalid-arguments');
  return accounts.map(a => a.toLowerCase()).sort();
}

/** Which database, without the user, password, query or URL entering the artifact. */
export function targetDigest(databaseUrl) {
  const url = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('invalid-database-url');
  return digest({ protocol: url.protocol, hostname: url.hostname, port: url.port || '5432', database: url.pathname });
}

/** The gate every statement passes. A write keyword anywhere refuses the whole statement. */
export async function readQuery(client, sql, params = []) {
  if (!/^\s*(SELECT|WITH)\b/i.test(sql) ||
    /\b(INSERT|UPDATE|DELETE|MERGE|ALTER|CREATE|DROP|TRUNCATE|GRANT|REVOKE|CALL|DO|COPY|LOCK|VACUUM|REINDEX|SET|NOTIFY)\b/i.test(sql)) {
    throw new Error('non-read-query-refused');
  }
  return client.query(sql, params);
}

const REQUIRED = {
  agents: ['smart_account', 'owner_address', 'chain_id', 'epoch'],
  equity: ['agent_id', 'equity_usdg', 'at', 'epoch', 'mode'],
  trades: ['agent_id', 'user_op_hash', 'tx_hash', 'status'],
};

export async function collectSnapshot(client, accounts, bounds = {}) {
  accounts = validateScope(accounts);
  const maxMarks = bounds.maxMarks ?? MAX_MARKS;
  const maxTradeRows = bounds.maxTradeRows ?? MAX_TRADE_ROWS;
  if (!Number.isSafeInteger(maxMarks) || maxMarks < 1 || maxMarks > MAX_MARKS ||
    !Number.isSafeInteger(maxTradeRows) || maxTradeRows < 1 || maxTradeRows > MAX_TRADE_ROWS) throw new Error('invalid-arguments');
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const state = await readQuery(client, `SELECT current_setting('transaction_read_only') AS read_only,
      current_setting('transaction_isolation') AS isolation`);
    if (state.rows[0]?.read_only !== 'on' || state.rows[0]?.isolation !== 'repeatable read') throw new Error('read-only-snapshot-not-established');

    const columns = await readQuery(client, `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = ANY($1::text[])`, [['agents', 'equity', 'trades', 'grants']]);
    const has = new Set(columns.rows.map(r => `${r.table_name}.${r.column_name}`));
    const missingRequiredColumns = Object.entries(REQUIRED).flatMap(([t, cols]) => cols.filter(c => !has.has(`${t}.${c}`)).map(c => `${t}.${c}`));
    const grantsPresent = has.has('grants.tenant') && has.has('grants.grant_json');
    const schema = { complete: missingRequiredColumns.length === 0, missingRequiredColumns, grantsPresent };
    if (!schema.complete) return { schema, accounts: accounts.map(account => ({ account, registrations: [], grants: [] })), marks: [], tradeHashes: [] };

    const agents = await readQuery(client, `SELECT smart_account, owner_address, chain_id, epoch FROM agents
      WHERE LOWER(smart_account) = ANY($1::text[]) ORDER BY LOWER(smart_account), epoch DESC, smart_account`, [accounts]);
    // NAMED FIELDS ONLY. grant_json also holds the serialized permission and
    // the hosted pairing signatures; selecting the whole document would bring
    // them into this process for no reason.
    const grants = grantsPresent ? await readQuery(client, `SELECT tenant, chain_id,
        grant_json->>'smartAccount' AS smart_account, grant_json->>'owner' AS owner,
        grant_json->'grantFeatures' AS grant_features,
        grant_json->>'ponsClassVaultAddress' AS pons_class_vault_address,
        grant_json->>'trencherVaultAddress' AS trencher_vault_address,
        grant_json->>'trencherFactoryAddress' AS trencher_factory_address
      FROM grants WHERE LOWER(grant_json->>'smartAccount') = ANY($1::text[]) ORDER BY tenant`, [accounts]) : { rows: [] };
    const marks = await readQuery(client, `SELECT LOWER(agent_id) AS account, at, equity_usdg, epoch, mode FROM equity
      WHERE LOWER(agent_id) = ANY($1::text[]) AND (mode IS NULL OR mode <> 'paper')
      ORDER BY LOWER(agent_id), at, epoch, equity_usdg LIMIT $2`, [accounts, maxMarks + 1]);
    if (marks.rows.length > maxMarks) throw new Error('scope-exceeds-preview-mark-bound');
    const trades = await readQuery(client, `SELECT LOWER(agent_id) AS account, LOWER(user_op_hash) AS user_op_hash,
        LOWER(tx_hash) AS tx_hash, status FROM trades
      WHERE LOWER(agent_id) = ANY($1::text[]) AND (user_op_hash IS NOT NULL OR tx_hash IS NOT NULL)
      ORDER BY LOWER(agent_id), LOWER(user_op_hash), LOWER(tx_hash), status LIMIT $2`, [accounts, maxTradeRows + 1]);
    if (trades.rows.length > maxTradeRows) throw new Error('scope-exceeds-preview-trade-bound');

    const str = v => (v === null || v === undefined ? null : String(v));
    const features = v => {
      const parsed = typeof v === 'string' ? (() => { try { return JSON.parse(v); } catch { return null; } })() : v;
      return Array.isArray(parsed) ? parsed.filter(f => typeof f === 'string') : [];
    };
    return {
      schema,
      accounts: accounts.map(account => ({
        account,
        registrations: agents.rows.filter(r => String(r.smart_account).toLowerCase() === account).map(r => ({
          smartAccount: String(r.smart_account), ownerAddress: str(r.owner_address), chainId: Number(r.chain_id), epoch: Number(r.epoch),
        })),
        grants: grants.rows.filter(r => String(r.smart_account ?? '').toLowerCase() === account).map(r => ({
          tenant: str(r.tenant), chainId: Number(r.chain_id), smartAccount: str(r.smart_account), owner: str(r.owner),
          grantFeatures: features(r.grant_features), ponsClassVaultAddress: str(r.pons_class_vault_address),
          trencherVaultAddress: str(r.trencher_vault_address), trencherFactoryAddress: str(r.trencher_factory_address),
        })),
      })),
      marks: marks.rows.map(r => ({ account: String(r.account), at: Number(r.at), equityUsdg: Number(r.equity_usdg),
        epoch: Number(r.epoch), mode: str(r.mode) })),
      tradeHashes: trades.rows.map(r => ({ account: String(r.account), userOpHash: str(r.user_op_hash), txHash: str(r.tx_hash), status: str(r.status) })),
    };
  } finally {
    await client.query('ROLLBACK');
  }
}
