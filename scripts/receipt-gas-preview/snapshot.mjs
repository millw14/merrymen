import { createHash } from 'node:crypto';

const ACCOUNT = /^0x[0-9a-f]{40}$/i;
const SLUG = /^[0-9abcdefghjkmnpqrstvwxyz]{16}$/;
export const MAX_ACCOUNTS = 256;
export const MAX_OPERATIONS = 1500;

export function canonical(value) {
  const normalize = x => {
    if (typeof x === 'bigint') return x.toString();
    if (typeof x === 'number' && !Number.isFinite(x)) return { invalidNumber: String(x) };
    if (Array.isArray(x)) return x.map(normalize);
    if (x && typeof x === 'object') return Object.fromEntries(Object.keys(x).sort().map(k => [k, normalize(x[k])]));
    return x;
  };
  return JSON.stringify(normalize(value));
}
export const digest = value => createHash('sha256').update(typeof value === 'string' || value instanceof Uint8Array ? value : canonical(value)).digest('hex');
export function validateScope(scope) {
  if (!Array.isArray(scope) || !scope.length || scope.length > MAX_ACCOUNTS ||
    scope.some(s => !SLUG.test(s?.slug ?? '') || !ACCOUNT.test(s?.account ?? '')) ||
    new Set(scope.map(s => s.account.toLowerCase())).size !== scope.length ||
    new Set(scope.map(s => s.slug)).size !== scope.length) throw new Error('invalid-arguments');
  return scope.map(s => ({ slug: s.slug, account: s.account.toLowerCase() }))
    .sort((a,b) => a.slug.localeCompare(b.slug));
}
export function targetDigest(databaseUrl) {
  const url = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('invalid-database-url');
  // No username, password, query parameters, or connection URL enters the artifact.
  return digest({ protocol: url.protocol, hostname: url.hostname, port: url.port || '5432', database: url.pathname });
}

export async function readQuery(client, sql, params = []) {
  if (!/^\s*(SELECT|WITH)\b/i.test(sql) || /\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|GRANT|REVOKE|CALL|DO|COPY|LOCK)\b/i.test(sql)) {
    throw new Error('non-read-query-refused');
  }
  return client.query(sql, params);
}

/** One read-only MVCC snapshot is released before potentially slow public receipt reads. */
export async function collectSnapshot(client, scope, maxRows = MAX_OPERATIONS) {
  scope = validateScope(scope);
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > MAX_OPERATIONS) throw new Error('invalid-arguments');
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const state = await readQuery(client, `SELECT current_setting('transaction_read_only') AS read_only,
      current_setting('transaction_isolation') AS isolation`);
    if (state.rows[0]?.read_only !== 'on' || state.rows[0]?.isolation !== 'repeatable read') throw new Error('read-only-snapshot-not-established');
    const columns = await readQuery(client, `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'trades'`);
    const names = new Set(columns.rows.map(r => r.column_name));
    const required = ['id', 'agent_id', 'epoch', 'status', 'user_op_hash', 'tx_hash', 'gas_wei', 'sponsored_gas_wei', 'gas_units', 'gas_usdg'];
    const missingRequiredColumns = required.filter(c => !names.has(c));
    if (missingRequiredColumns.length) return {
      schema: { complete: false, missingRequiredColumns,
        gasRecordedAtPresent: names.has('gas_recorded_at'), userOpNoncePresent: names.has('user_op_nonce') },
      bindings: scope.map(request => ({ ...request, state: 'unsupported-trade-schema', canonicalAgent: null })),
      snapshots: [],
    };
    const hasTime = names.has('gas_recorded_at'), hasNonce = names.has('user_op_nonce');
    const requestedAccounts = scope.map(s => s.account);
    const identities = await readQuery(client, `SELECT slug, accounts FROM agent_identity
      WHERE slug = ANY($1::text[]) OR EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(accounts) = 'array' THEN accounts ELSE '[]'::jsonb END) AS x(account)
        WHERE LOWER(x.account) = ANY($2::text[])
      ) ORDER BY slug`, [scope.map(s => s.slug), requestedAccounts]);
    const identityRows = identities.rows.map(r => ({ slug: String(r.slug),
      accounts: Array.isArray(r.accounts) ? r.accounts : typeof r.accounts === 'string' ? JSON.parse(r.accounts) : null }));
    const lookupAccounts = [...new Set([...requestedAccounts, ...identityRows.flatMap(r => Array.isArray(r.accounts)
      ? r.accounts.filter(a => typeof a === 'string' && ACCOUNT.test(a)).map(a => a.toLowerCase()) : [])])];
    const agents = await readQuery(client, `SELECT smart_account, epoch, chain_id, beat_at, created_at, owner_address
      FROM agents WHERE LOWER(smart_account) = ANY($1::text[])
      ORDER BY LOWER(smart_account), epoch DESC, COALESCE(beat_at, 0) DESC, created_at DESC, smart_account`, [lookupAccounts]);
    const registrations = new Map();
    for (const raw of agents.rows) {
      const key = String(raw.smart_account).toLowerCase();
      if (!registrations.has(key)) registrations.set(key, []);
      registrations.get(key).push(raw);
    }
    const canonicalAgents = [];
    for (const [key, aliases] of registrations) {
      const first = aliases[0];
      const rank = r => [Number(r.epoch), Number(r.beat_at ?? 0), Number(r.created_at)];
      const topRank = canonical(rank(first));
      const equalRank = aliases.filter(r => canonical(rank(r)) === topRank);
      const authority = r => canonical([Number(r.epoch), Number(r.chain_id), String(r.owner_address ?? '').toLowerCase()]);
      const ambiguous = new Set(equalRank.map(authority)).size > 1;
      const invalid = !ACCOUNT.test(String(first.smart_account)) || !Number.isSafeInteger(Number(first.epoch)) || Number(first.epoch) < 1 ||
        !Number.isSafeInteger(Number(first.chain_id)) || Number(first.chain_id) < 1 || !Number.isSafeInteger(Number(first.created_at)) || !ACCOUNT.test(String(first.owner_address ?? ''));
      canonicalAgents.push({ account: key, canonicalAddress: String(first.smart_account), epoch: Number(first.epoch),
        chainId: Number(first.chain_id), createdAt: Number(first.created_at), ambiguous, invalid,
        registrationDigest: digest({ smart_account: String(first.smart_account), epoch: first.epoch, chain_id: first.chain_id,
          owner_address: String(first.owner_address ?? '').toLowerCase(), created_at: first.created_at }) });
    }
    const bindings = scope.map(request => {
      const matches = identityRows.filter(r => r.slug === request.slug);
      let state = 'bound-current-named-account'; let canonicalAgent = null;
      if (matches.length !== 1) state = matches.length ? 'ambiguous-public-slug' : 'public-slug-not-found';
      else if (!Array.isArray(matches[0].accounts) || !matches[0].accounts.length || matches[0].accounts.some(a => typeof a !== 'string' || !ACCOUNT.test(a)) ||
        new Set(matches[0].accounts.map(a => a.toLowerCase())).size !== matches[0].accounts.length) state = 'invalid-identity-account-list';
      else {
        const accounts = matches[0].accounts.map(a => a.toLowerCase());
        const claimants = identityRows.filter(r => Array.isArray(r.accounts) && r.accounts.some(a => typeof a === 'string' && a.toLowerCase() === request.account));
        if (!accounts.includes(request.account)) state = 'slug-address-mismatch';
        else if (new Set(claimants.map(r => r.slug)).size !== 1) state = 'ambiguous-account-identity';
        else {
          // identity-store keeps the current account first. Imports/restarts can
          // give historical registrations newer timestamps; they are not authority.
          canonicalAgent = canonicalAgents.find(a => a.account === accounts[0]) ?? null;
          if (!canonicalAgent) state = 'account-not-found';
          else if (canonicalAgent.invalid) state = 'invalid-canonical-registration';
          else if (canonicalAgent.ambiguous) state = 'ambiguous-current-registration';
          else if (canonicalAgent.account !== request.account) state = 'address-is-not-current-for-public-slug';
          else if (canonicalAgent.chainId !== 4663) state = 'ineligible-chain';
        }
      }
      return { ...request, state, canonicalAgent };
    });
    const rows = await readQuery(client, `WITH ranked AS (
      SELECT smart_account, epoch, ROW_NUMBER() OVER (
        PARTITION BY LOWER(smart_account) ORDER BY epoch DESC, COALESCE(beat_at, 0) DESC, created_at DESC, smart_account
      ) AS alias_rank FROM agents WHERE LOWER(smart_account) = ANY($1::text[])
    ) SELECT CAST(t.id AS TEXT) AS id, t.agent_id, t.epoch, t.status, t.user_op_hash, t.tx_hash,
      ${hasNonce ? 't.user_op_nonce' : 'NULL::text AS user_op_nonce'}, t.gas_wei, t.sponsored_gas_wei, t.gas_units, t.gas_usdg,
      ${hasTime ? 't.gas_recorded_at' : 'NULL::integer AS gas_recorded_at'},
      (to_jsonb(t) - 'gas_recorded_at')::text AS protected_snapshot_text
      FROM trades t JOIN ranked a ON LOWER(t.agent_id) = LOWER(a.smart_account) AND t.epoch = a.epoch AND a.alias_rank = 1
      WHERE t.status IN ('landed', 'reverted')
      ORDER BY LOWER(t.agent_id), t.epoch, t.id LIMIT $2`, [requestedAccounts, maxRows + 1]);
    if (rows.rows.length > maxRows) throw new Error('scope-exceeds-preview-row-bound');
    const snapshots = rows.rows.map(raw => {
      const row = { id: String(raw.id), agent_id: String(raw.agent_id), epoch: Number(raw.epoch), status: String(raw.status),
        user_op_hash: raw.user_op_hash ?? null, tx_hash: raw.tx_hash ?? null, user_op_nonce: raw.user_op_nonce ?? null,
        gas_wei: raw.gas_wei ?? null, sponsored_gas_wei: raw.sponsored_gas_wei ?? null, gas_units: raw.gas_units ?? null,
        gas_usdg: raw.gas_usdg === null || raw.gas_usdg === undefined ? null : Number(raw.gas_usdg),
        gas_recorded_at: raw.gas_recorded_at === null || raw.gas_recorded_at === undefined ? null : Number(raw.gas_recorded_at) };
      // The full protected source row is bound by a digest, without disclosing its trading amounts or other private fields.
      const protectedSnapshotDigest = digest(String(raw.protected_snapshot_text));
      return { row, protectedSnapshotDigest, snapshotDigest: digest({ row, protectedSnapshotDigest }) };
    });
    return { schema: { complete: true, missingRequiredColumns: [],
      gasRecordedAtPresent: hasTime, userOpNoncePresent: hasNonce }, bindings, snapshots };
  } finally {
    await client.query('ROLLBACK');
  }
}
