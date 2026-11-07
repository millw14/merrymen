import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { it } from 'node:test';
import { collectSnapshot, canonical, readQuery } from './preview.mjs';

// Opt-in only. This endpoint is a disposable fixture, never DATABASE_URL.
const LOCAL = 'postgresql://receipt_fixture@127.0.0.1:55973/postgres';

it('actual loopback Postgres keeps every seeded field unchanged and rejects writes inside the preview snapshot', {
  skip: process.env.MERRYMEN_RECEIPT_PREVIEW_LOCAL_PG !== '1',
}, async () => {
  const { Client } = await import('pg');
  const schema = `receipt_preview_${randomBytes(8).toString('hex')}`;
  const fixture = new Client({ connectionString: LOCAL });
  const reader = new Client({ connectionString: LOCAL,
    options: `-c default_transaction_read_only=on -c search_path=${schema}` });
  const account = `0x${'a'.repeat(40)}`;
  const slug = 'bm74qsj64fygkhjh';
  const commands = [];
  await fixture.connect();
  try {
    await fixture.query(`CREATE SCHEMA ${schema}`);
    await fixture.query(`SET search_path TO ${schema}`);
    await fixture.query(`CREATE TABLE agents (smart_account text, epoch int, chain_id int,
      beat_at int, created_at int, owner_address text);
      CREATE TABLE agent_identity (slug text, accounts jsonb);
      CREATE TABLE trades (id bigint, agent_id text, epoch int, status text,
        user_op_hash text, tx_hash text, user_op_nonce text, gas_wei text,
        sponsored_gas_wei text, gas_units text, gas_usdg numeric,
        at int, budget_settled_at int, amount_usdg numeric, decision_id text, fill_cash_usdg numeric);`);
    await fixture.query('INSERT INTO agents VALUES ($1,2,4663,100,1,$1)', [account]);
    await fixture.query('INSERT INTO agent_identity VALUES ($1,$2::jsonb)', [slug, JSON.stringify([account])]);
    await fixture.query(`INSERT INTO trades VALUES
      (1,$1,2,'landed',$2,$3,'7',NULL,NULL,NULL,NULL,1789999990,1789999991,9,'decision',8)`,
      [account, `0x${'2'.repeat(64)}`, `0x${'1'.repeat(64)}`]);
    const before = await fixture.query('SELECT to_jsonb(t)::text AS row FROM trades t ORDER BY id');
    const columnsBefore = await fixture.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema=$1 AND table_name='trades' ORDER BY ordinal_position`, [schema]);
    await reader.connect();
    const guarded = { query: async (sql, params) => { commands.push(sql); return reader.query(sql, params); } };
    const snapshot = await collectSnapshot(guarded, [{ slug, account }]);
    assert.equal(snapshot.bindings[0].state, 'bound-current-named-account');
    assert.equal(snapshot.snapshots.length, 1);
    assert.equal(snapshot.schema.gasRecordedAtPresent, false);
    assert.equal(snapshot.snapshots[0].row.gas_usdg, null);
    assert.equal(commands[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    assert.equal(commands.at(-1), 'ROLLBACK');
    assert.doesNotMatch(canonical(snapshot), /amount_usdg|decision_id|budget_settled_at|fill_cash_usdg/);
    assert.equal(commands.filter(sql => /^\s*(INSERT|UPDATE|ALTER|CREATE|DELETE|DROP)/i.test(sql)).length, 0);
    await assert.rejects(readQuery(reader, 'UPDATE trades SET gas_usdg=0'), /non-read-query-refused/);
    // Prove the database itself is a second barrier, beyond the fixed SELECT gate.
    await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await assert.rejects(reader.query('UPDATE trades SET gas_usdg=0'), error => error.code === '25006');
    await reader.query('ROLLBACK');
    const after = await fixture.query('SELECT to_jsonb(t)::text AS row FROM trades t ORDER BY id');
    const columnsAfter = await fixture.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema=$1 AND table_name='trades' ORDER BY ordinal_position`, [schema]);
    assert.deepEqual(after.rows, before.rows);
    assert.deepEqual(columnsAfter.rows, columnsBefore.rows);
  } finally {
    await reader.end().catch(() => {});
    await fixture.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await fixture.end();
  }
});
