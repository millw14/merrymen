/** Version 3 recovery stream. Memory is bounded by one record, never total history. */
import { createHash } from "node:crypto";
import type { Db } from "../db";
import { JOURNAL_GENESIS, journalHash } from "../store";
import { FINANCIAL_CAPSULE_TABLES, validateFinancialCapsule } from "./hosted-financial-capsule";
import { STANDDOWN_TABLES, validateCompleteJournal } from "./hosted-standdown-ledger";

export type FinancialScope = "financial" | "standdown";
export type FinancialRow = Record<string, string | number | null>;
export type FinancialChunks = Iterable<Buffer> | AsyncIterable<Buffer>;
export type FinancialStreamRecord = {type:"header";v:3;scope:FinancialScope;account:string} | {type:"table";name:string} | {type:"row";value:FinancialRow} | {type:"end"};
export interface JournalProof { count:number; digest:string }
export interface FinancialStreamSummary { scope:FinancialScope; tableCounts:Record<string,number>; journalProof:JournalProof }
export interface FinancialStreamOptions {
 scope?:FinancialScope; priorJournalProof?:JournalProof;
 onRow?:(table:string,row:FinancialRow)=>void|Promise<void>;
 onComplete?:(summary:FinancialStreamSummary)=>void|Promise<void>;
}
export const STANDDOWN_STREAM_TABLES = ["agents","journal",...STANDDOWN_TABLES] as const;
export const PUBLIC_AGENT_COLUMNS = ["smart_account","name","owner_address","session_key_address","chain_id","caps","granted_at","expires_at","epoch"] as const;
const tablesOf = (scope:FinancialScope):readonly string[] => scope === "financial" ? FINANCIAL_CAPSULE_TABLES : STANDDOWN_STREAM_TABLES;
const identity = (table:string) => table === "agents" ? "smart_account" : "agent_id";
export const JOURNAL_KEYS = ["seq","agent_id","epoch","kind","payload_json","prev_hash","hash","at"];
// This is a per-row bound, independent of the number of committed facts. It also
// bounds malformed IPC input lacking a newline. Legacy adapters alone allow32MiB.
const MAX_RECORD_BYTES = 8 * 1024 * 1024;
const MAX_LEGACY_BYTES = 32 * 1024 * 1024;
export function encodeFinancialRecord(record:FinancialStreamRecord):Buffer { return Buffer.from(JSON.stringify(record)+"\n"); }
function boundAccount(account:string):string {
 const bound=account.toLowerCase(); if(!/^0x[0-9a-f]{40}$/.test(bound)) throw new Error("financial stream account refused"); return bound;
}

/** Decode v3 incrementally. The bounded v1/v2 adapter is only for old persisted checkpoints. */
export async function* decodeFinancialRecords(chunks:FinancialChunks):AsyncGenerator<FinancialStreamRecord> {
 const decoder=new TextDecoder("utf-8",{fatal:true}); let text="", format:"stream"|"legacy"|null=null, bytes=0;
 for await(const chunk of chunks) {
  if(!Buffer.isBuffer(chunk)) throw new Error("financial stream chunk refused");
  // Slice huge caller chunks too, so no extra whole-history string is allocated.
  for(let offset=0;offset<chunk.length;offset+=64*1024) {
   const slice=chunk.subarray(offset,offset+64*1024); bytes+=slice.length; text+=decoder.decode(slice,{stream:true});
   if(!format && text.trimStart().length >= 16) format=/^\s*\{\s*"v"\s*:\s*[12]\s*[,}]/.test(text)?"legacy":"stream";
   if(format==="legacy") { if(bytes>MAX_LEGACY_BYTES) throw new Error("legacy financial checkpoint requires bounded migration"); continue; }
   let newline:number;
   while((newline=text.indexOf("\n"))>=0) {
    const line=text.slice(0,newline); text=text.slice(newline+1);
    if(Buffer.byteLength(line)>MAX_RECORD_BYTES || !line) throw new Error("financial stream record bound");
    yield JSON.parse(line) as FinancialStreamRecord;
   }
   if(Buffer.byteLength(text)>MAX_RECORD_BYTES) throw new Error("financial stream record bound");
  }
 }
 text+=decoder.decode();
 if(format==="legacy") {
  const legacy=JSON.parse(text) as {v:number;account:string};
  if(legacy.v===2) {
   const x=validateFinancialCapsule(Buffer.from(text),legacy.account);
   yield {type:"header",v:3,scope:"financial",account:x.account};
   for(const name of FINANCIAL_CAPSULE_TABLES) { yield {type:"table",name}; for(const value of x.tables[name]!) yield {type:"row",value:value as FinancialRow}; }
  } else {
   const x=validateCompleteJournal(Buffer.from(text),legacy.account);
   yield {type:"header",v:3,scope:"standdown",account:x.account};
   for(const name of STANDDOWN_STREAM_TABLES) { yield {type:"table",name}; for(const value of name==="agents"?(x.agent?[x.agent]:[]):name==="journal"?x.journal:x.tables[name]!) yield {type:"row",value:value as FinancialRow}; }
  }
  yield {type:"end"}; return;
 }
 if(text.length) throw new Error("financial stream ended mid-record");
}

/** Caller holds a read transaction until this iterator is exhausted. */
export async function* captureFinancialStream(db:Db,account:string,opts:{scope?:FinancialScope}={}):AsyncGenerator<Buffer> {
 const bound=boundAccount(account),scope=opts.scope??"financial";
 yield encodeFinancialRecord({type:"header",v:3,scope,account:bound});
 for(const name of tablesOf(scope)) {
  yield encodeFinancialRecord({type:"table",name}); let last=0;
  for(;;) {
   const select=scope==="standdown"&&name==="agents"?PUBLIC_AGENT_COLUMNS.join(","):"*";
   const live=scope==="standdown"&&(STANDDOWN_TABLES as readonly string[]).includes(name)?" AND mode = 'live'":"";
   const rows=await db.prepare(`SELECT rowid AS _capsule_rowid_, ${select} FROM ${name} WHERE lower(${identity(name)}) = ?${live} AND rowid > ? ORDER BY rowid LIMIT 128`).all(bound,last) as (FinancialRow & {_capsule_rowid_:number})[];
   if(!rows.length) break;
   for(const row of rows) { last=row._capsule_rowid_; const {_capsule_rowid_:_,...value}=row; yield encodeFinancialRecord({type:"row",value}); }
  }
 }
 yield encodeFinancialRecord({type:"end"});
}

/** Validated bytes may be staged, but must never be published before exhaustion. */
export async function* validateFinancialStream(chunks:FinancialChunks,account:string,opts:FinancialStreamOptions={}):AsyncGenerator<Buffer> {
 const bound=boundAccount(account); let scope:FinancialScope|undefined, tables:readonly string[]=[],tableIndex=-1,ended=false;
 const counts:Record<string,number>={}; const heads=new Map<number,string>(); const hash=createHash("sha256"); let seq=0;
 const prior=opts.priorJournalProof;
 if(prior && (!Number.isSafeInteger(prior.count)||prior.count<0||!/^([0-9a-f]{64})$/.test(prior.digest))) throw new Error("financial stream prior proof refused");
 if(prior?.count===0 && hash.copy().digest("hex")!==prior.digest) throw new Error("financial journal prefix replaced");
 for await(const raw of decodeFinancialRecords(chunks)) {
  if(!raw||typeof raw!=="object"||Array.isArray(raw)||ended) throw new Error("financial stream record order refused");
  if(raw.type==="header") {
   if(scope||raw.v!==3||raw.account!==bound||!["financial","standdown"].includes(raw.scope)||Object.keys(raw).some(k=>!["type","v","scope","account"].includes(k))||opts.scope&&opts.scope!==raw.scope) throw new Error("financial stream binding refused");
   scope=raw.scope; tables=tablesOf(scope); for(const t of tables) counts[t]=0;
  } else if(raw.type==="table") {
   if(!scope||raw.name!==tables[++tableIndex]||Object.keys(raw).some(k=>!["type","name"].includes(k))) throw new Error("financial stream table order refused");
  } else if(raw.type==="row") {
   const table=tables[tableIndex],row=raw.value;
   if(!scope||!table||Object.keys(raw).some(k=>!["type","value"].includes(k))||!row||typeof row!=="object"||Array.isArray(row)||String(row[identity(table)]).toLowerCase()!==bound||Object.keys(row).some(k=>!/^[_a-z]+$/.test(k))||Object.values(row).some(v=>v!==null&&typeof v!=="string"&&(typeof v!=="number"||!Number.isFinite(v)))) throw new Error("financial stream foreign or malformed row");
   if(table==="agents" && (++counts[table]!>1||scope==="standdown"&&Object.keys(row).some(k=>!(PUBLIC_AGENT_COLUMNS as readonly string[]).includes(k)))) throw new Error("financial stream agent refused");
   if(table!=="agents") counts[table]!++;
   if(scope==="standdown"&&(STANDDOWN_TABLES as readonly string[]).includes(table)&&row.mode!=="live") throw new Error("standdown financial stream paper row refused");
   if(table==="journal") {
    const epoch=Number(row.epoch),n=Number(row.seq);
    if(!Number.isSafeInteger(epoch)||epoch<1||!Number.isSafeInteger(n)||n!==seq+1||typeof row.payload_json!=="string"||typeof row.kind!=="string"||!Number.isSafeInteger(row.at)) throw new Error("financial journal sequence incomplete");
    const prev=heads.get(epoch)??JOURNAL_GENESIS;
    if(row.prev_hash!==prev||row.hash!==journalHash(prev,row.payload_json)) throw new Error("financial journal chain does not verify");
    heads.set(epoch,String(row.hash));seq=n; hash.update(JSON.stringify(JOURNAL_KEYS.map(k=>row[k]))+"\n");
    if(prior&&seq===prior.count&&hash.copy().digest("hex")!==prior.digest) throw new Error("financial journal prefix replaced");
   }
   await opts.onRow?.(table,row);
  } else if(raw.type==="end") {
   if(!scope||tableIndex!==tables.length-1||Object.keys(raw).length!==1||prior&&seq<prior.count) throw new Error("financial stream incomplete");
   ended=true;
  } else throw new Error("financial stream record refused");
  yield encodeFinancialRecord(raw);
 }
 if(!scope||!ended) throw new Error("financial stream incomplete");
 await opts.onComplete?.({scope,tableCounts:counts,journalProof:{count:seq,digest:hash.digest("hex")}});
}
export async function inspectFinancialStream(chunks:FinancialChunks,account:string,opts:FinancialStreamOptions={}):Promise<FinancialStreamSummary> {
 let summary:FinancialStreamSummary|undefined;
 for await(const _ of validateFinancialStream(chunks,account,{...opts,onComplete:async s=>{summary=s;await opts.onComplete?.(s);}})) {}
 return summary!;
}
export async function* transformFinancialStream(chunks:FinancialChunks,account:string,opts:{scope:FinancialScope;stripReplay?:boolean}):AsyncGenerator<Buffer> {
 let table="",keep=false;
 for await(const record of decodeFinancialRecords(validateFinancialStream(chunks,account))) {
  if(record.type==="header") {
   if(record.scope==="standdown"&&opts.scope==="financial") throw new Error("narrow stream cannot fabricate full financial book");
   yield encodeFinancialRecord({...record,scope:opts.scope});
  } else if(record.type==="table") {table=record.name;keep=tablesOf(opts.scope).includes(table);if(keep)yield encodeFinancialRecord(record);}
  else if(record.type==="row") {
   if(!keep||opts.scope==="standdown"&&(STANDDOWN_TABLES as readonly string[]).includes(table)&&record.value.mode!=="live")continue;
   let value=record.value;
   if(opts.scope==="standdown"&&table==="agents")value=Object.fromEntries(PUBLIC_AGENT_COLUMNS.filter(k=>k in value).map(k=>[k,value[k]!])) as FinancialRow;
   if(opts.stripReplay&&table==="perp_orders")value={...value,tx_info:null};
   yield encodeFinancialRecord({type:"row",value});
  } else yield encodeFinancialRecord(record);
 }
}
export async function restoreFinancialStream(db:Db,chunks:FinancialChunks,account:string,opts:{scope?:FinancialScope}={}):Promise<void> {
 await db.tx(tx=>restoreFinancialStreamInTx(tx,chunks,account,opts));
}
/** Internal transaction seam: caller must roll back if this rejects or is interrupted. */
export async function restoreFinancialStreamInTx(db:Db,chunks:FinancialChunks,account:string,opts:{scope?:FinancialScope}={}):Promise<void> {
 const bound=boundAccount(account); let table="",scope:FinancialScope="financial",allowed=new Set<string>();
 for await(const record of decodeFinancialRecords(validateFinancialStream(chunks,account,opts))) {
  if(record.type==="header") scope=record.scope;
  else if(record.type==="table") {
   table=record.name;
   allowed=new Set((await db.prepare(`PRAGMA table_info(${table})`).all() as {name:string}[]).map(c=>c.name));
   if(await db.prepare(`SELECT 1 FROM ${table} WHERE lower(${identity(table)}) <> ? LIMIT 1`).get(bound))throw new Error("financial recovery found a foreign tenant row");
   await db.prepare(`DELETE FROM ${table} WHERE lower(${identity(table)}) = ?${scope==="standdown"&&(STANDDOWN_TABLES as readonly string[]).includes(table)?" AND mode = 'live'":""}`).run(bound);
  } else if(record.type==="row") {
   const keys=Object.keys(record.value);
   if(!keys.length||keys.some(k=>!allowed.has(k)))throw new Error("financial stream schema refused");
   await db.prepare(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(()=>"?").join(",")})`).run(...keys.map(k=>record.value[k]));
  }
 }
}
