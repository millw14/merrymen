/** Opt-in disposable LOCAL PostgreSQL only; never reads DATABASE_URL. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { translateQuery, translateSchema, type Db } from './db';
import {
  completePersonalMemoryForget, deletePersonalMemory, ensurePersonalMemorySchema,
  forgetStoredPersonalMemory, forgetUnwantedPersonalMemory, publishPersonalMemory,
  recordPersonalMemoryForget, restorePersonalMemory,
} from './personal-memory-ferry';
interface Client { connect():Promise<void>; end():Promise<void>; query(sql:string,params?:unknown[]):Promise<{rows:Record<string,unknown>[];rowCount:number|null}> }
const url=process.env.MERRYMEN_TEST_PG_URL;
const pg=url ? createRequire(import.meta.url)('pg') as {Client:new(config:{connectionString:string})=>Client}:null;
const A=`0x${'ab'.repeat(20)}`, B=`0x${'cd'.repeat(20)}`;
function adapter(client:Client):Db {
  const db:Db={
    prepare(sql){const text=translateQuery(sql);return {
      async run(...params){const r=await client.query(text,params);return {changes:r.rowCount??0,lastInsertRowid:0};},
      async get(...params){return (await client.query(text,params)).rows[0];},
      async all(...params){return (await client.query(text,params)).rows;},
    };},
    async exec(sql){await client.query(translateSchema(sql));},
    async tx(fn){await client.query('BEGIN');try{const r=await fn(db);await client.query('COMMIT');return r;}catch(e){await client.query('ROLLBACK');throw e;}},
  };return db;
}
test('Postgres personal-memory schema, ciphertext, forget CAS, restore and deletion', {skip:!url,timeout:30_000},async(t)=>{
  const target=new URL(url!);assert.ok(['127.0.0.1','localhost','[::1]'].includes(target.hostname),'only a disposable local database');
  const schema=`mm_personal_${randomBytes(8).toString('hex')}`;const admin=new pg!.Client({connectionString:url!});await admin.connect();
  const homes:string[]=[];const home=()=>{const h=mkdtempSync(path.join(os.tmpdir(),'mm-personal-pg-'));homes.push(h);return h;};
  const clients:Client[]=[];await admin.query(`CREATE SCHEMA ${schema}`);
  t.after(async()=>{for(const h of homes)rmSync(h,{recursive:true,force:true});await Promise.allSettled(clients.map(c=>c.end()));try{await admin.query(`DROP SCHEMA ${schema} CASCADE`);}finally{await admin.end();}});
  const scoped=new URL(target);scoped.searchParams.set('options',`-c search_path=${schema} -c statement_timeout=5000 -c lock_timeout=3000`);
  for(let i=0;i<2;i++){const c=new pg!.Client({connectionString:scoped.toString()});await c.connect();clients.push(c);}
  const one=adapter(clients[0]!),two=adapter(clients[1]!);await Promise.all([ensurePersonalMemorySchema(one,'postgres'),ensurePersonalMemorySchema(two,'postgres')]);
  const src=home();mkdirSync(path.join(src,'soul'));writeFileSync(path.join(src,'soul','OWNER.md'),'private owner fact');writeFileSync(path.join(src,'soul','ARCHIVE.md'),'old owner fact');
  const dek=randomBytes(32),seen=new Map<string,string>();
  assert.equal(await publishPersonalMemory({tenant:A,home:src,shared:one,dek,seen,log:()=>{}}),'published');
  const row=(await clients[0]!.query('SELECT sealed, bytes FROM tenant_personal_memory WHERE tenant=$1',[A])).rows[0]!;
  assert.equal(typeof row.sealed,'string');assert.ok(!String(row.sealed).includes('private owner fact'));assert.ok(Number(row.bytes)>0);
  await clients[0]!.query('INSERT INTO tenant_personal_memory SELECT $1, sealed, bytes, updated_at_ms FROM tenant_personal_memory WHERE tenant=$2',[B,A]);
  assert.equal(await restorePersonalMemory({tenant:B,home:home(),shared:two,dek,log:()=>{}}),'unreadable');
  const op=recordPersonalMemoryForget({kind:'owner'},src);
  assert.equal(await forgetStoredPersonalMemory({tenant:A,home:src,shared:two,dek,log:()=>{}}),'applied');
  assert.equal(await forgetStoredPersonalMemory({tenant:A,home:src,shared:two,dek,log:()=>{}}),'unchanged');
  const dest=home();assert.equal(await restorePersonalMemory({tenant:A,home:dest,shared:one,dek,log:()=>{}}),'restored');
  assert.equal(readFileSync(path.join(dest,'soul','OWNER.md'),'utf8'),'');assert.equal(readFileSync(path.join(dest,'soul','ARCHIVE.md'),'utf8'),'');
  writeFileSync(path.join(src,'soul','OWNER.md'),'new fact after forget');writeFileSync(path.join(src,'soul','ARCHIVE.md'),'');completePersonalMemoryForget(op,src);
  assert.equal(await publishPersonalMemory({tenant:A,home:src,shared:one,dek,seen,log:()=>{}}),'published');
  await clients[0]!.query('UPDATE tenant_personal_memory SET updated_at_ms=1 WHERE tenant=$1',[B]);
  assert.equal(await forgetUnwantedPersonalMemory({shared:two,wanted:new Set([A]),listedAtMs:2,log:()=>{}}),1);
  await deletePersonalMemory(A,one,()=>{});assert.equal(Number((await clients[0]!.query('SELECT count(*) n FROM tenant_personal_memory')).rows[0]!.n),0);
});
