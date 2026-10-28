import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { translateQuery, translateSchema, wrapSqlite, type Db } from './db';
import { openSecret, sealSecret } from './store-crypto';
import {
  PERSONAL_MEMORY_FILES, PERSONAL_MEMORY_FORGET_FILE, PERSONAL_MEMORY_RESTORE_FILE, PERSONAL_MEMORY_ERASE_FILE,
  PERSONAL_MEMORY_MAX_BYTES, PERSONAL_MEMORY_TABLE_SQL,
  capturePersonalMemoryExport, completePersonalMemoryForget, deletePersonalMemory,
  ensurePersonalMemorySchema, forgetStoredPersonalMemory, forgetUnwantedPersonalMemory,
  forgetPersonalMemoryHome, forgetPersonalMemoryInHomes,
  publishPersonalMemory, recordPersonalMemoryForget, restorePersonalMemory,
} from './personal-memory-ferry';

const A = `0x${'ab'.repeat(20)}`;
const B = `0x${'cd'.repeat(20)}`;
const DEK = randomBytes(32);
const PRIVATE = 'My owner lives beside the purple cinema';
const CHAT = 'same-second fresh turn';
const CHAT_SCHEMA = `CREATE TABLE chat_turns (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, memory_ids TEXT, at INTEGER NOT NULL);`;
const quiet = () => { const lines: string[] = []; return { lines, log: (s: string) => lines.push(s) }; };
const home = (t: { after(fn: () => void): void }) => {
  const h = mkdtempSync(path.join(os.tmpdir(), 'merrymen-personal-ferry-'));
  t.after(() => rmSync(h, { recursive: true, force: true })); return h;
};
async function shared(t: { after(fn: () => void): void }) {
  const raw = new DatabaseSync(':memory:'); t.after(() => raw.close());
  const db = wrapSqlite(raw); await ensurePersonalMemorySchema(db, 'sqlite'); return { db, raw };
}
function soul(h: string, extra = false) {
  mkdirSync(path.join(h, 'soul'), { recursive: true });
  for (const name of PERSONAL_MEMORY_FILES) writeFileSync(path.join(h, 'soul', name), name + '\n' + PRIVATE);
  if (extra) {
    writeFileSync(path.join(h, 'soul', 'keys.json'), 'not a memory file');
    writeFileSync(path.join(h, 'grant.json'), 'private grant excluded');
    writeFileSync(path.join(h, 'settings.json'), 'settings excluded');
  }
}
function chats(h: string) {
  const raw = new DatabaseSync(path.join(h, 'merrymen.db')); raw.exec(CHAT_SCHEMA); return raw;
}
function insert(raw: DatabaseSync, chatId: number, content: string, at = 100) {
  raw.prepare('INSERT INTO chat_turns (chat_id, role, content, memory_ids, at) VALUES (?, ?, ?, ?, ?)')
    .run(chatId, 'user', content, JSON.stringify(['owner:1']), at);
}
const pub = (tenant: string, h: string, db: Db, seen = new Map<string, string>()) =>
  publishPersonalMemory({ tenant, home: h, shared: db, dek: DEK, seen, log: () => {} });
const restore = (tenant: string, h: string, db: Db) =>
  restorePersonalMemory({ tenant, home: h, shared: db, dek: DEK, log: () => {} });
function opened(raw: DatabaseSync, tenant = A) {
  const row = raw.prepare('SELECT sealed FROM tenant_personal_memory WHERE tenant = ?').get(tenant)!;
  const plain = openSecret(row.sealed as string, DEK);
  return JSON.parse(plain.slice(plain.indexOf('\n') + 1)) as { soul: Record<string,string>; chats: {chatId:number; turns:{content:string;at:number}[]}[]; forgets: unknown[] };
}

test('sealed whitelist restores soul and newest 40 DM turns, without keys, raw groups or financial tables', async (t) => {
  const { db, raw } = await shared(t); const src = home(t); const dest = home(t); soul(src, true);
  const local = chats(src);
  for (let i = 0; i < 45; i++) insert(local, 10, `turn ${i}`, i);
  insert(local, -100123, 'legacy group private line');
  local.exec('CREATE TABLE grants (secret TEXT); INSERT INTO grants VALUES (\'wallet secret excluded\')');
  local.close();
  assert.equal(await pub(A.toUpperCase().replace('0X','0x'), src, db), 'published');
  const sealed = raw.prepare('SELECT sealed FROM tenant_personal_memory WHERE tenant = ?').get(A)!.sealed as string;
  assert.ok(!sealed.includes(PRIVATE)); assert.ok(!sealed.includes('wallet secret'));
  const snapshot = opened(raw);
  assert.deepEqual(Object.keys(snapshot.soul).sort(), [...PERSONAL_MEMORY_FILES].sort());
  assert.deepEqual(snapshot.chats.map(c => c.chatId), [10]);
  assert.equal(snapshot.chats[0]!.turns.length, 40);
  assert.equal(snapshot.chats[0]!.turns[0]!.content, 'turn 5');
  assert.equal(await restore(A, dest, db), 'restored');
  for (const name of PERSONAL_MEMORY_FILES) {
    assert.equal(readFileSync(path.join(dest,'soul',name),'utf8'), name + '\n' + PRIVATE);
    assert.equal(lstatSync(path.join(dest,'soul',name)).mode & 0o777, 0o600);
  }
  assert.ok(!existsSync(path.join(dest,'grant.json')));
  const restored = new DatabaseSync(path.join(dest,'merrymen.db'));
  assert.equal(restored.prepare('SELECT count(*) n FROM chat_turns').get()!.n, 40);
  assert.equal(restored.prepare("SELECT count(*) n FROM sqlite_master WHERE name = 'grants'").get()!.n, 0);
  restored.close();
});

test('never overwrite existing soul file or an existing DM chat', async (t) => {
  const { db } = await shared(t); const src = home(t); const dest = home(t); soul(src);
  const s = chats(src); insert(s, 10, PRIVATE); insert(s, 11, 'another DM'); s.close();
  await pub(A, src, db); mkdirSync(path.join(dest,'soul')); writeFileSync(path.join(dest,'soul','OWNER.md'), 'new local owner');
  const d = chats(dest); insert(d, 10, 'new local DM'); d.close();
  assert.equal(await restore(A, dest, db), 'restored');
  assert.equal(readFileSync(path.join(dest,'soul','OWNER.md'),'utf8'), 'new local owner');
  const after = new DatabaseSync(path.join(dest,'merrymen.db'));
  assert.equal(after.prepare('SELECT content FROM chat_turns WHERE chat_id = 10').get()!.content, 'new local DM');
  assert.equal(after.prepare('SELECT content FROM chat_turns WHERE chat_id = 11').get()!.content, 'another DM'); after.close();
});

test('pending forget removes stored owner/archive and DM; restored post-forget same-second turns survive', async (t) => {
  const { db, raw } = await shared(t); const src = home(t); soul(src);
  const local = chats(src); insert(local, 10, PRIVATE, 100); local.close(); await pub(A, src, db);
  const owner = recordPersonalMemoryForget({kind:'owner'}, src);
  const chat = recordPersonalMemoryForget({kind:'chat',chatId:10}, src);
  assert.equal(await forgetStoredPersonalMemory({tenant:A,home:src,shared:db,dek:DEK,log:()=>{}}), 'applied');
  const old = opened(raw); assert.equal(old.soul['OWNER.md'], ''); assert.equal(old.soul['ARCHIVE.md'], '');
  assert.equal(old.soul['NOTES.md'], 'NOTES.md\n' + PRIVATE); assert.deepEqual(old.chats, []);
  writeFileSync(path.join(src,'soul','OWNER.md'), 'fresh owner fact');
  writeFileSync(path.join(src,'soul','ARCHIVE.md'), 'fresh archive'); completePersonalMemoryForget(owner, src);
  const next = new DatabaseSync(path.join(src,'merrymen.db')); next.exec('DELETE FROM chat_turns WHERE chat_id = 10');
  completePersonalMemoryForget(chat, src); insert(next, 10, CHAT, 100); next.close();
  assert.equal(await pub(A, src, db), 'published');
  assert.equal(opened(raw).chats[0]!.turns[0]!.content, CHAT);
  const dest = home(t); assert.equal(await restore(A, dest, db), 'restored');
  assert.equal(readFileSync(path.join(dest,'soul','OWNER.md'),'utf8'), 'fresh owner fact');
  assert.equal(await pub(A, dest, db), 'published');
  assert.equal(opened(raw).chats[0]!.turns[0]!.content, CHAT);
  assert.equal(readFileSync(path.join(src, PERSONAL_MEMORY_FORGET_FILE),'utf8').includes(PRIVATE), false);
});

test('pending write-ahead privacy request is applied even if the local wipe never ran', async (t) => {
  const { db, raw } = await shared(t); const src = home(t); soul(src); const local=chats(src);insert(local,10,PRIVATE);local.close();
  await pub(A, src, db); recordPersonalMemoryForget({kind:'owner'},src); recordPersonalMemoryForget({kind:'chat',chatId:10},src);
  assert.equal(await pub(A, src, db), 'published');
  assert.equal(opened(raw).soul['OWNER.md'],''); assert.equal(opened(raw).soul['ARCHIVE.md'],''); assert.equal(opened(raw).chats.length,0);
});

test('restore never completes a pending local forget over stale owner facts or DM turns', async (t) => {
  const { db, raw } = await shared(t); const src = home(t); soul(src);
  const local = chats(src); insert(local,10,PRIVATE); local.close(); await pub(A,src,db);
  recordPersonalMemoryForget({kind:'owner'},src);recordPersonalMemoryForget({kind:'chat',chatId:10},src);
  assert.equal(await restore(A,src,db),'failed');
  const ops=readFileSync(path.join(src,PERSONAL_MEMORY_FORGET_FILE),'utf8').trim().split('\n').map(s=>JSON.parse(s));
  assert.ok(ops.every(op=>op.completed===false));
  assert.equal(await pub(A,src,db),'published');
  assert.equal(opened(raw).soul['OWNER.md'],'');assert.equal(opened(raw).soul['ARCHIVE.md'],'');assert.equal(opened(raw).chats.length,0);
  assert.equal(await restore(A,src,db),'failed');
  assert.ok(readFileSync(path.join(src,'soul','OWNER.md'),'utf8').includes(PRIVATE));
});

test('no-row startup refuses an unfinished owner forget and retains its private files',async(t)=>{
  const {db}=await shared(t);const src=home(t);soul(src);recordPersonalMemoryForget({kind:'owner'},src);
  assert.equal(await restore(A,src,db),'failed');
  assert.ok(readFileSync(path.join(src,'soul','OWNER.md'),'utf8').includes(PRIVATE));
  assert.equal(JSON.parse(readFileSync(path.join(src,PERSONAL_MEMORY_FORGET_FILE),'utf8').trim()).completed,false);
});

test('no-row startup refuses an unfinished DM forget without completing its journal',async(t)=>{
  const {db}=await shared(t);const src=home(t);const local=chats(src);insert(local,10,PRIVATE);local.close();
  recordPersonalMemoryForget({kind:'chat',chatId:10},src);assert.equal(await restore(A,src,db),'failed');
  assert.equal(JSON.parse(readFileSync(path.join(src,PERSONAL_MEMORY_FORGET_FILE),'utf8').trim()).completed,false);
});

test('no-row startup validates journals, while completed and genuinely empty requests permit fresh memory',async(t)=>{
  const {db,raw}=await shared(t);const malformed=home(t);writeFileSync(path.join(malformed,PERSONAL_MEMORY_FORGET_FILE),'torn request');
  assert.equal(await restore(A,malformed,db),'failed');assert.equal(await restore(A,home(t),db),'none');
  const src=home(t);const op=recordPersonalMemoryForget({kind:'chat',chatId:10},src);
  assert.equal(await restore(A,src,db),'none');
  assert.equal(JSON.parse(readFileSync(path.join(src,PERSONAL_MEMORY_FORGET_FILE),'utf8').trim()).completed,true);
  const local=chats(src);insert(local,10,CHAT);local.close();
  assert.equal(await restore(A,src,db),'none');assert.equal(await pub(A,src,db),'published');
  assert.equal(opened(raw).chats[0]!.turns[0]!.content,CHAT);
  assert.ok(readFileSync(path.join(src,PERSONAL_MEMORY_FORGET_FILE),'utf8').includes(op.id));
});

test('tenant-swapped ciphertext, bad key and tampered ciphertext refuse restore and publishing', async (t) => {
  const { db, raw } = await shared(t); const src=home(t);soul(src);await pub(A,src,db);
  const row=raw.prepare('SELECT sealed FROM tenant_personal_memory WHERE tenant=?').get(A)!;
  raw.prepare('INSERT INTO tenant_personal_memory VALUES (?, ?, ?, ?)').run(B,row.sealed as string,1,1);
  const q=quiet(); const dest=home(t);
  assert.equal(await restorePersonalMemory({tenant:B,home:dest,shared:db,dek:DEK,log:q.log}),'unreadable');
  assert.equal(await restorePersonalMemory({tenant:A,home:dest,shared:db,dek:randomBytes(32),log:q.log}),'unreadable');
  assert.ok(!existsSync(path.join(dest,'soul')));
  raw.prepare('UPDATE tenant_personal_memory SET sealed=? WHERE tenant=?').run('broken', A);
  assert.equal(await pub(A,src,db),'failed');
  assert.ok(q.lines.every(line=>!line.includes(PRIVATE)));
});

test('malformed/capped journal and symlink sources preserve the last sealed copy', async (t) => {
  const {db,raw}=await shared(t); const src=home(t);soul(src);await pub(A,src,db);
  const before=raw.prepare('SELECT sealed FROM tenant_personal_memory').get()!.sealed;
  writeFileSync(path.join(src,PERSONAL_MEMORY_FORGET_FILE),'torn record');
  assert.equal(await pub(A,src,db),'failed'); assert.equal(await restore(A,home(t),db),'restored');
  assert.equal(raw.prepare('SELECT sealed FROM tenant_personal_memory').get()!.sealed,before);
  rmSync(path.join(src,PERSONAL_MEMORY_FORGET_FILE)); rmSync(path.join(src,'soul','OWNER.md'));
  const outside=path.join(home(t),'secret');writeFileSync(outside,PRIVATE);symlinkSync(outside,path.join(src,'soul','OWNER.md'));
  assert.equal(await pub(A,src,db),'failed');
  assert.throws(()=>capturePersonalMemoryExport({tenant:A,home:src,dek:DEK}), /export refused/);
});

test('oversized memory and excess DM chats never replace a good snapshot', async (t) => {
  const {db,raw}=await shared(t);const src=home(t);soul(src);await pub(A,src,db);
  const before=raw.prepare('SELECT sealed FROM tenant_personal_memory').get()!.sealed;
  writeFileSync(path.join(src,'soul','ARCHIVE.md'),'x'.repeat(PERSONAL_MEMORY_MAX_BYTES+1));
  assert.equal(await pub(A,src,db),'failed');
  writeFileSync(path.join(src,'soul','ARCHIVE.md'),'small');const local=chats(src);
  for(let i=1;i<=65;i++)insert(local,i,'small');local.close();
  assert.equal(await pub(A,src,db),'failed');
  assert.equal(raw.prepare('SELECT sealed FROM tenant_personal_memory').get()!.sealed,before);
});

test('partial restore retains a marker, blocks publish, and retries without overwriting', async (t) => {
  const {db}=await shared(t);const src=home(t);const dest=home(t);soul(src);const local=chats(src);insert(local,10,PRIVATE);local.close();await pub(A,src,db);
  const broken=new DatabaseSync(path.join(dest,'merrymen.db'));broken.exec('CREATE TABLE chat_turns (id INTEGER PRIMARY KEY, chat_id INTEGER, role TEXT, content TEXT, memory_ids TEXT, at INTEGER); CREATE TRIGGER block_restore BEFORE INSERT ON chat_turns BEGIN SELECT RAISE(ABORT,\'blocked\'); END;');broken.close();
  assert.equal(await restore(A,dest,db),'failed');assert.ok(existsSync(path.join(dest,PERSONAL_MEMORY_RESTORE_FILE)));
  assert.equal(readFileSync(path.join(dest,'soul','OWNER.md'),'utf8'),'OWNER.md\n'+PRIVATE);
  assert.equal(await pub(A,dest,db),'failed');
  const repaired=new DatabaseSync(path.join(dest,'merrymen.db'));repaired.exec('DROP TRIGGER block_restore');repaired.close();
  assert.equal(await restore(A,dest,db),'restored');assert.ok(!existsSync(path.join(dest,PERSONAL_MEMORY_RESTORE_FILE)));
});

test('a changed partial restore target is preserved and spawn remains held', async(t)=>{
  const {db}=await shared(t);const src=home(t);const dest=home(t);soul(src);await pub(A,src,db);
  // Simulate an interrupted restore using the digest and initial missing targets.
  const row=(await db.prepare('SELECT sealed FROM tenant_personal_memory WHERE tenant=?').get(A)) as {sealed:string};
  const plain=openSecret(row.sealed,DEK);const data=JSON.parse(plain.slice(plain.indexOf('\n')+1));
  const {createHash}=await import('node:crypto');
  writeFileSync(path.join(dest,PERSONAL_MEMORY_RESTORE_FILE),JSON.stringify({version:1,tenant:A,digest:createHash('sha256').update(JSON.stringify(data)).digest('hex'),files:['OWNER.md'],chats:[]}));
  mkdirSync(path.join(dest,'soul'));writeFileSync(path.join(dest,'soul','OWNER.md'),'changed locally');
  assert.equal(await restore(A,dest,db),'failed');assert.equal(readFileSync(path.join(dest,'soul','OWNER.md'),'utf8'),'changed locally');
});

test('export is sealed with content-free metadata and round-trips through the regular restore',async(t)=>{
  const {db}=await shared(t);const src=home(t);soul(src,true);const local=chats(src);insert(local,10,PRIVATE);local.close();
  const capsule=capturePersonalMemoryExport({tenant:A,home:src,dek:DEK})!;
  assert.equal(capsule.soulFiles,5);assert.equal(capsule.dmChats,1);assert.equal(capsule.dmTurns,1);assert.equal(capsule.sha256.length,64);
  assert.ok(!JSON.stringify(capsule).includes(PRIVATE));
  await db.prepare('INSERT INTO tenant_personal_memory VALUES (?, ?, ?, ?)').run(A,capsule.sealed,capsule.bytes,1);
  assert.equal(await restore(A,home(t),db),'restored');
});

test('explicit delete and bounded roster sweep preserve retained and newly published tenants',async(t)=>{
  const {db,raw}=await shared(t);const src=home(t);soul(src);await pub(A,src,db);await pub(B,src,db);
  raw.prepare('UPDATE tenant_personal_memory SET updated_at_ms=1 WHERE tenant=?').run(A);
  raw.prepare('UPDATE tenant_personal_memory SET updated_at_ms=3 WHERE tenant=?').run(B);
  assert.equal(await forgetUnwantedPersonalMemory({shared:db,wanted:new Set([A]),listedAtMs:2,log:()=>{}}),0);
  assert.equal(await forgetUnwantedPersonalMemory({shared:db,wanted:new Set(),listedAtMs:2,log:()=>{}}),1);
  assert.ok(raw.prepare('SELECT 1 FROM tenant_personal_memory WHERE tenant=?').get(B));
  await deletePersonalMemory(B,db,()=>{});assert.equal(raw.prepare('SELECT count(*) n FROM tenant_personal_memory').get()!.n,0);
});

test('explicit local removal prevents personal-memory resurrection while preserving finance/config',async(t)=>{
  const {db}=await shared(t);const src=home(t);soul(src,true);const local=chats(src);insert(local,10,PRIVATE);
  local.exec("CREATE TABLE equity (value TEXT); INSERT INTO equity VALUES ('durable finance');");local.close();
  recordPersonalMemoryForget({kind:'owner'},src);
  assert.ok(forgetPersonalMemoryHome(src,()=>{})>=7);
  assert.equal(await pub(A,src,db),'absent');
  assert.ok(existsSync(path.join(src,'grant.json')));assert.ok(existsSync(path.join(src,'settings.json')));
  assert.ok(existsSync(path.join(src,'soul','keys.json')));
  const after=new DatabaseSync(path.join(src,'merrymen.db'));
  assert.equal(after.prepare('SELECT count(*) n FROM chat_turns WHERE chat_id>0').get()!.n,0);
  assert.equal(after.prepare('SELECT value FROM equity').get()!.value,'durable finance');after.close();
});

test('local sweep keeps retained/running homes and files newer than its roster snapshot', t=>{
  const children=home(t);for(const tenant of [A,B]){mkdirSync(path.join(children,tenant));soul(path.join(children,tenant));}
  assert.equal(forgetPersonalMemoryInHomes({childrenDir:children,wanted:new Set([A]),running:new Set([B]),before:Date.now()+10_000,log:()=>{}}),0);
  assert.equal(forgetPersonalMemoryInHomes({childrenDir:children,wanted:new Set([A]),running:new Set(),before:1,log:()=>{}}),0);
  assert.equal(forgetPersonalMemoryInHomes({childrenDir:children,wanted:new Set([A]),running:new Set(),before:Date.now()+10_000,log:()=>{}}),1);
  assert.ok(existsSync(path.join(children,A,'soul','OWNER.md')));assert.ok(!existsSync(path.join(children,B,'soul','OWNER.md')));
});

test('failed explicit DM deletion keeps an erasure barrier so a regrant cannot resurrect it',async(t)=>{
  const {db}=await shared(t);const src=home(t);soul(src);const local=chats(src);insert(local,10,PRIVATE);
  local.exec("CREATE TRIGGER blocked_forget BEFORE DELETE ON chat_turns BEGIN SELECT RAISE(ABORT,'blocked'); END;");local.close();
  forgetPersonalMemoryHome(src,()=>{});assert.ok(existsSync(path.join(src,PERSONAL_MEMORY_ERASE_FILE)));
  assert.equal(await pub(A,src,db),'failed');assert.equal(await restore(A,src,db),'failed');
  const repaired=new DatabaseSync(path.join(src,'merrymen.db'));repaired.exec('DROP TRIGGER blocked_forget');repaired.close();
  assert.ok(forgetPersonalMemoryHome(src,()=>{})>=6);assert.ok(!existsSync(path.join(src,PERSONAL_MEMORY_ERASE_FILE)));
  assert.equal(await pub(A,src,db),'absent');
});

test('personal memory SQL is compatible with the Postgres translation',()=>{
  const schema=translateSchema(PERSONAL_MEMORY_TABLE_SQL);
  assert.match(schema,/bytes BIGINT/);assert.match(schema,/updated_at_ms BIGINT/);
  assert.equal(translateQuery('SELECT sealed FROM tenant_personal_memory WHERE tenant = ?'),'SELECT sealed FROM tenant_personal_memory WHERE tenant = $1');
});

test('owner forget wipes mixed archive and its durable journal; NOTES and JOURNAL remain', (t)=>{
  const h=home(t);
  const output=execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',`
    import { ensureSoul, forgetOwner, rememberOwnerFact } from './worker/src/soul.ts';
    import { writeFileSync, readFileSync } from 'node:fs';
    import path from 'node:path';
    const h=process.env.MERRYMEN_HOME;ensureSoul();rememberOwnerFact('favorite food is rice');
    writeFileSync(path.join(h,'soul','ARCHIVE.md'),'old private fact');
    writeFileSync(path.join(h,'soul','NOTES.md'),'keep note');
    writeFileSync(path.join(h,'soul','JOURNAL.md'),'keep journal');forgetOwner();
    console.log(JSON.stringify({owner:readFileSync(path.join(h,'soul','OWNER.md'),'utf8'),archive:readFileSync(path.join(h,'soul','ARCHIVE.md'),'utf8'),note:readFileSync(path.join(h,'soul','NOTES.md'),'utf8'),journal:readFileSync(path.join(h,'soul','JOURNAL.md'),'utf8')}));
  `],{cwd:process.cwd(),env:{...process.env,MERRYMEN_HOME:h},encoding:'utf8'});
  const result=JSON.parse(output);assert.ok(!result.owner.includes('favorite food'));assert.ok(!result.archive.includes('private fact'));
  assert.equal(result.note,'keep note');assert.equal(result.journal,'keep journal');
  assert.equal(JSON.parse(readFileSync(path.join(h,PERSONAL_MEMORY_FORGET_FILE),'utf8').trim()).completed,true);
});
