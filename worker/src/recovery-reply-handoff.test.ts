import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, linkSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { wrapSqlite } from "./db";
import { handoffRecoveryReplyOffset, mergeRecoveryReplyOffset, recoveryReplyPrivacyAllowsFork } from "./recovery-reply-handoff";
import { RECOVERY_REPLY_SCHEMA, sealRecoveryReplyState, type ReplyPrivacyOp } from "./recovery-reply-state";
import { openSecret, sealSecret } from "./store-crypto";
import { publishTgGroups, restoreTgGroups, TG_GROUPS_TABLE_SQL } from "./tg-groups-ferry";
import { publishPersonalMemory, restorePersonalMemory, PERSONAL_MEMORY_TABLE_SQL } from "./personal-memory-ferry";
const tenant=`0x${"1".repeat(40)}`,smartAccount=`0x${"2".repeat(40)}`,dek=Buffer.alloc(32,7);
const op:ReplyPrivacyOp={id:"00000000-0000-4000-8000-000000000001",atMs:1000,kind:"person",chatId:-11,userId:7};
function fixture(t:{after(fn:()=>void):void}){
 const home=realpathSync(mkdtempSync(path.join(os.tmpdir(),"mm-reply-handoff-")));t.after(()=>rmSync(home,{recursive:true,force:true}));
 const raw=new DatabaseSync(":memory:"),shared=wrapSqlite(raw);t.after(()=>raw.close());raw.exec(RECOVERY_REPLY_SCHEMA+TG_GROUPS_TABLE_SQL+PERSONAL_MEMORY_TABLE_SQL);
 return{home,raw,shared};
}
function journal(raw:DatabaseSync,ops:ReplyPrivacyOp[]){const row=sealRecoveryReplyState(tenant,{version:1,privacy:ops,turns:[]},dek);raw.prepare("INSERT INTO tenant_recovery_reply_state VALUES(?,?,?,1000)").run(tenant,row.sealed,row.bytes);}
const group=()=>({version:1,rooms:{"-11":{chatId:-11,status:"approved",title:"room",summary:"old mixed summary",sinceSummary:1,lines:[{messageId:1,fromId:7,text:"forgotten",atMs:50},{messageId:2,fromId:8,text:"unrelated",atMs:60},{messageId:3,fromId:7,text:"new valid",atMs:2000}],people:[],coins:[],claims:{"original:execution":50}}},llm:{day:"original",used:12},nominations:{day:"original",n:4,entries:2}});
test("ordinary offset merge preserves primary, prior-bot and token-rotation high waters",()=>{
 assert.deepEqual(mergeRecoveryReplyOffset({offset:90,botId:"801",linkCode:"private-link"},"801",100),{offset:100,botId:"801",linkCode:"private-link"});
 assert.equal(mergeRecoveryReplyOffset({offset:110,botId:null},"801",100).offset,110);
 const state=mergeRecoveryReplyOffset({offset:200,botId:"802",priorBots:[{botId:"801",offset:120}],linkCode:"same"},"801",100);
 assert.equal(state.offset,200);assert.deepEqual(state.priorBots,[{botId:"801",offset:120}]);assert.equal(state.linkCode,"same");
 for(const bad of [null,{offset:null},{offset:0,botId:12},{offset:0,botId:"802",priorBots:[{botId:"801",offset:-1}]}])assert.throws(()=>mergeRecoveryReplyOffset(bad,"801",100));
});
test("real durable handoff requires current scope/writer proof, preserves financial files and rejects symlink",async t=>{
 const f=fixture(t);f.raw.prepare("INSERT INTO recovery_reply_offsets VALUES(?,?,?,?,?,200,101,100,1000)").run("801",tenant,smartAccount,4663,"a".repeat(16));
 const file=path.join(f.home,"telegram.json"),book=path.join(f.home,"merrymen.db");writeFileSync(book,"original nonce/basis/risk/source",{mode:0o600});writeFileSync(file,JSON.stringify({offset:10,botId:"801",ownerId:7}),{mode:0o600});
 const o={tenant,smartAccount,chainId:4663,token:"801:rotated_fixture",home:f.home,shared:f.shared,mayWrite:()=>true};
 await handoffRecoveryReplyOffset(o);assert.equal(JSON.parse(readFileSync(file,"utf8")).offset,101);assert.equal(readFileSync(book,"utf8"),"original nonce/basis/risk/source");
 const before=readFileSync(file);await assert.rejects(handoffRecoveryReplyOffset({...o,mayWrite:()=>false}));await assert.rejects(handoffRecoveryReplyOffset({...o,smartAccount:`0x${"3".repeat(40)}`}));assert.deepEqual(readFileSync(file),before);
 rmSync(file);symlinkSync(book,file);await assert.rejects(handoffRecoveryReplyOffset(o));assert.equal(readFileSync(book,"utf8"),"original nonce/basis/risk/source");
});
test("every refusal names its check by a fixed code, never a value, and the text is the same for all",async t=>{
 const code=(fn:()=>unknown)=>{try{fn();}catch(e){assert.equal((e as Error).message,"Reply poll handoff refused; original holds remain intact.");return (e as {code?:string}).code;}return "accepted";};
 assert.equal(code(()=>mergeRecoveryReplyOffset(null,"801",1)),"HANDOFF_SHAPE");
 assert.equal(code(()=>mergeRecoveryReplyOffset([],"801",1)),"HANDOFF_SHAPE");
 assert.equal(code(()=>mergeRecoveryReplyOffset({offset:1},"801",-1)),"HANDOFF_ROW");
 // The orchestrator's restored link (restoredTelegramFile) never carries an offset.
 assert.equal(code(()=>mergeRecoveryReplyOffset({linkCode:"K7M2QX",ownerId:7,linkedAt:5},"801",1)),"HANDOFF_OFFSET");
 assert.equal(code(()=>mergeRecoveryReplyOffset({offset:null},"801",1)),"HANDOFF_OFFSET");
 assert.equal(code(()=>mergeRecoveryReplyOffset({offset:1.5},"801",1)),"HANDOFF_OFFSET");
 assert.equal(code(()=>mergeRecoveryReplyOffset({offset:0,botId:801},"801",1)),"HANDOFF_BOT");
 assert.equal(code(()=>mergeRecoveryReplyOffset({offset:0,botId:"802",priorBots:{}},"801",1)),"HANDOFF_PRIOR_BOTS");
 assert.equal(code(()=>mergeRecoveryReplyOffset({offset:0,botId:"802",priorBots:[{botId:"801",offset:-1}]},"801",1)),"HANDOFF_PRIOR_BOTS");
 assert.equal(code(()=>mergeRecoveryReplyOffset({offset:0,botId:"802",priorBots:[{botId:"9",offset:1},{botId:"9",offset:2}]},"801",1)),"HANDOFF_PRIOR_BOTS");
 const f=fixture(t),file=path.join(f.home,"telegram.json");
 f.raw.prepare("INSERT INTO recovery_reply_offsets VALUES(?,?,?,?,?,200,101,100,1000)").run("801",tenant,smartAccount,4663,"a".repeat(16));
 const o={tenant,smartAccount,chainId:4663,token:"801:rotated_fixture",home:f.home,shared:f.shared,mayWrite:()=>true};
 const handoff=async(over:Partial<typeof o>={})=>{try{await handoffRecoveryReplyOffset({...o,...over});return "accepted";}catch(e){assert.equal((e as Error).message,"Reply poll handoff refused; original holds remain intact.");return (e as {code?:string}).code;}};
 const put=(body:string,mode=0o600)=>{rmSync(file,{recursive:true,force:true});writeFileSync(file,body);chmodSync(file,mode);};
 assert.equal(await handoff({mayWrite:()=>false}),"HANDOFF_WRITER");
 assert.equal(await handoff({token:"not-a-token"}),"HANDOFF_TOKEN");
 assert.equal(await handoff({smartAccount:`0x${"3".repeat(40)}`}),"HANDOFF_ROW");
 put(JSON.stringify({offset:10,botId:"801"}),0o644);assert.equal(await handoff(),"HANDOFF_MODE");
 put(JSON.stringify({offset:10,botId:"801"}));linkSync(file,path.join(f.home,"second-name"));assert.equal(await handoff(),"HANDOFF_LINKS");rmSync(path.join(f.home,"second-name"));
 rmSync(file);writeFileSync(path.join(f.home,"elsewhere.json"),JSON.stringify({offset:10}),{mode:0o600});symlinkSync(path.join(f.home,"elsewhere.json"),file);assert.equal(await handoff(),"HANDOFF_SYMLINK");
 rmSync(file);mkdirSync(file);assert.equal(await handoff(),"HANDOFF_NOT_FILE");
 put(" ".repeat(256*1024+1));assert.equal(await handoff(),"HANDOFF_SIZE");
 put("{not json");assert.equal(await handoff(),"HANDOFF_PARSE");
 put(String.fromCharCode(0xfeff)+JSON.stringify({offset:10,botId:"801"}));assert.equal(await handoff(),"HANDOFF_PARSE");
 put(JSON.stringify({linkCode:"K7M2QX",ownerId:7}));assert.equal(await handoff(),"HANDOFF_OFFSET");
 put(JSON.stringify({offset:10,botId:801}));assert.equal(await handoff(),"HANDOFF_BOT");
 put(JSON.stringify({offset:10,botId:"801"}));assert.equal(await handoff(),"accepted");assert.equal(JSON.parse(readFileSync(file,"utf8")).offset,101);
});
test("retained group privacy blocks local reads, transforms future publish/import and preserves execution claims/budgets",async t=>{
 const f=fixture(t),state=group(),text=JSON.stringify(state),file=path.join(f.home,"tg-groups.json"),seen=new Map<string,string>();writeFileSync(file,text,{mode:0o600});
 assert.equal(await publishTgGroups({...f,tenant,dek,seen,log:()=>{}}),"published");journal(f.raw,[op]);
 assert.equal(await restoreTgGroups({...f,tenant,dek,log:()=>{}}),"failed");assert.equal(await recoveryReplyPrivacyAllowsFork({...f,tenant,dek,mayRead:()=>true}),false);assert.equal(readFileSync(file,"utf8"),text);
 assert.equal(await publishTgGroups({...f,tenant,dek,seen,log:()=>{}}),"published","new tombstone invalidates seen shortcut");
 const row=f.raw.prepare("SELECT sealed FROM tenant_tg_groups WHERE tenant=?").get(tenant)!;const value=JSON.parse(openSecret(String(row.sealed),dek).split("\n").slice(1).join("\n"));
 assert.deepEqual(value.rooms["-11"].lines.map((l:{text:string})=>l.text),["unrelated","new valid"]);assert.deepEqual(value.rooms["-11"].claims,state.rooms["-11"].claims);assert.deepEqual(value.llm,state.llm);assert.deepEqual(value.nominations,state.nominations);
 rmSync(file);assert.equal(await restoreTgGroups({...f,tenant,dek,log:()=>{}}),"restored");assert.deepEqual(JSON.parse(readFileSync(file,"utf8")),value);assert.equal(await restoreTgGroups({...f,tenant,dek,log:()=>{}}),"present");assert.equal(await recoveryReplyPrivacyAllowsFork({...f,tenant,dek,mayRead:()=>true}),true);
 // Even an authenticated stale backup is filtered on a later missing-home restore.
 f.raw.prepare("UPDATE tenant_tg_groups SET sealed=? WHERE tenant=?").run(sealSecret(`tg-groups/v1 ${tenant}\n${text}`,dek),tenant);rmSync(file);assert.equal(await restoreTgGroups({...f,tenant,dek,log:()=>{}}),"restored");assert.deepEqual(JSON.parse(readFileSync(file,"utf8")).rooms["-11"].lines.map((l:{text:string})=>l.text),["unrelated","new valid"]);
});
test("personal privacy refuses retained stale DM and owner facts while fresh restore honors durable tombstones",async t=>{
 const f=fixture(t);journal(f.raw,[{...op,kind:"personal-chat",chatId:7,userId:undefined}]);
 const local=new DatabaseSync(path.join(f.home,"merrymen.db"));t.after(()=>local.close());local.exec("CREATE TABLE chat_turns(id INTEGER PRIMARY KEY,chat_id INTEGER,role TEXT,content TEXT,memory_ids TEXT,at INTEGER);CREATE TABLE trades(id INTEGER PRIMARY KEY,nonce TEXT);INSERT INTO trades VALUES(73,'original');INSERT INTO chat_turns VALUES(1,7,'user','forgotten',NULL,50)");
 assert.equal(await restorePersonalMemory({...f,tenant,dek,log:()=>{}}),"failed");assert.equal(local.prepare("SELECT nonce FROM trades WHERE id=73").get()!.nonce,"original");
 const snapshot={version:1,soul:{},chats:[{chatId:7,turns:[{role:"user",content:"forgotten",at:50}]},{chatId:8,turns:[{role:"user",content:"retained",at:50}]}],forgets:[],applied:{}};
 const sealed=sealSecret(`personal-memory/v1 ${tenant}\n${JSON.stringify(snapshot)}`,dek);f.raw.prepare("INSERT INTO tenant_personal_memory VALUES(?,?,?,50)").run(tenant,sealed,JSON.stringify(snapshot).length);
 const dest=path.join(f.home,"fresh");mkdirSync(dest,{mode:0o700});assert.equal(await restorePersonalMemory({tenant,home:dest,shared:f.shared,dek,log:()=>{}}),"restored");
 const db=new DatabaseSync(path.join(dest,"merrymen.db"));assert.deepEqual(db.prepare("SELECT chat_id FROM chat_turns").all().map(r=>r.chat_id),[8]);db.close();
 assert.equal(await publishPersonalMemory({tenant,home:dest,shared:f.shared,dek,seen:new Map(),log:()=>{}}),"published");const row=f.raw.prepare("SELECT sealed FROM tenant_personal_memory WHERE tenant=?").get(tenant)!;assert.equal(JSON.parse(openSecret(String(row.sealed),dek).split("\n").slice(1).join("\n")).applied["chat:7"],op.id);
});
