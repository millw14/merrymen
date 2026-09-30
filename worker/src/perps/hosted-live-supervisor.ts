/** Parent half of ordinary hosted durability. Histories are streamed, never retained in RAM. */
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import type { Db } from "../db";
import { wrapSqlite } from "../db";
import { applyLedgerSchema } from "../store";
import { PERP_TRANSFER_RANK, PERP_LEG_RANK } from "../perp-ledger-rules";
import { HostedLiveCheckpointStore, STANDDOWN_CHECKPOINT_MAX, type HostedLiveCheckpoint } from "./hosted-standdown-store";
import { captureFinancialStream, inspectFinancialStream, restoreFinancialStream, validateFinancialStream, type FinancialChunks, type FinancialRow, type FinancialStreamSummary, type JournalProof } from "./hosted-financial-stream";
import { CheckpointFrameReceiver } from "./hosted-checkpoint-ipc";

const APPEND_TABLES = new Set(["trades", "flows", "fee_accruals", "perp_orders", "perp_fills", "perp_funding", "perp_carries", "perp_transfers", "perp_order_legs"]);
const EXACT_WITHOUT_JOURNAL = new Set(["paper_book", "cost_basis", "position_floors", "trench_positions", "class_positions", "flows_quarantine"]);
const MIGRATION_TABLES = ["trades", "flows", "fee_accruals", "perp_orders", "perp_fills", "perp_funding", "perp_transfers", "perp_payouts"];
async function primaryKeys(db:Db,table:string):Promise<string[]> {
 const schema=await db.prepare(`PRAGMA table_info(${table})`).all() as {name:string;pk:number}[];
 const keys=schema.filter(c=>c.pk>0).sort((a,b)=>a.pk-b.pk).map(c=>c.name);
 if(!keys.length)throw new Error("financial recovery table has no identity");return keys;
}
async function matchingRow(db:Db,table:string,row:FinancialRow,keys:string[]):Promise<FinancialRow|undefined> {
 const present=keys.filter(k=>row[k]!==null),nulls=keys.filter(k=>row[k]===null);
 return await db.prepare(`SELECT * FROM ${table} WHERE ${[...present.map(k=>`${k} = ?`),...nulls.map(k=>`${k} IS NULL`)].join(" AND ")} LIMIT 1`).get(...present.map(k=>row[k])) as FinancialRow|undefined;
}
async function checkMigration(shared:Db,local:Db,account:string,journalCount:number):Promise<void> {
 for(const table of MIGRATION_TABLES) {
  const order=await primaryKeys(local,table);let after:FinancialRow|null=null;
  for(;;) {
   const rows=await shared.prepare(`SELECT * FROM ${table} WHERE lower(agent_id) = ?${after?` AND (${order.join(",")}) > (${order.map(()=>"?").join(",")})`:""} ORDER BY ${order.join(",")} LIMIT 128`).all(account.toLowerCase(),...(after?order.map(k=>after![k]):[])) as FinancialRow[];
   if(!rows.length)break;
   if(!journalCount)throw new Error("existing hosted financial history has no exact local journal checkpoint");
   for(const row of rows) {
    const keys=Object.keys(row).filter(k=>k!=="tx_info"&&!(k==="id"&&!table.startsWith("perp_")));
    if(!await matchingRow(local,table,row,keys))throw new Error("shared financial history diverges from the exact local journal book");
   }
   after=rows[rows.length-1]!;
  }
 }
}

export class HostedLiveCheckpointBridge {
 private previous: JournalProof;
 private tail = Promise.resolve();
 private frames: CheckpointFrameReceiver;
 private constructor(private store: HostedLiveCheckpointStore, private row: HostedLiveCheckpoint, previous: JournalProof, private healthy: () => boolean, home: string) { this.previous = previous; this.frames = new CheckpointFrameReceiver(home); }
 static async prepare(o: { shared: Db; dek: Buffer; tenant: string; account: string; publicKey: string; home: string; healthy: () => boolean }): Promise<HostedLiveCheckpointBridge> {
  const store = new HostedLiveCheckpointStore(o.shared, o.dek);
  const prior = await store.latest(o.tenant, o.account);
  const raw = new DatabaseSync(path.join(o.home, "merrymen.db"));
  try {
   const local=wrapSqlite(raw);await applyLedgerSchema(local);
   let current:FinancialStreamSummary|null=null;
   try {current=await local.tx(tx=>inspectFinancialStream(captureFinancialStream(tx,o.account),o.account,{scope:"financial"}));}
   catch(error){if(!prior?.checkpoint)throw error;}
   if(prior?.checkpoint) {
    const pk=new Map<string,string[]>();let mismatch=false;
    const old=await inspectFinancialStream(store.loadStream(prior),o.account,{scope:"financial",onRow:async(table,row)=>{
     if(!current||(!APPEND_TABLES.has(table)&&!EXACT_WITHOUT_JOURNAL.has(table)&&!["perp_accounts","perp_payouts"].includes(table)))return;
     if(!pk.has(table))pk.set(table,await primaryKeys(local,table));
     const found=await matchingRow(local,table,row,pk.get(table)!);
     if(!found){mismatch=true;return;}
     let immutable:string[]=[];
     if(table==="perp_orders")immutable=["mode","epoch","effect","reduce_only","nonce","tx_hash","tx_info","account_index","api_key_index","market_id","client_order_index","worst_notional_micro"];
     else if(table==="trades")immutable=["kind","target","sell_token","buy_token","amount_usdg","user_op_hash","tx_hash","decision_id","epoch","mode"];
     else if(table==="perp_transfers"||table==="perp_order_legs") {
      const status=table==="perp_transfers"?"state":"status";
      const ranks:Readonly<Record<string,number>>=table==="perp_transfers"?PERP_TRANSFER_RANK:PERP_LEG_RANK;
      if(ranks[String(found[status])]===undefined||ranks[String(found[status])]!<ranks[String(row[status])]!)mismatch=true;
      const changing=new Set([status,"venue_status","updated_at"]);
      immutable=Object.keys(row).filter(k=>!changing.has(k)&&row[k]!==null);
     }
     else if(APPEND_TABLES.has(table))immutable=Object.keys(row);
     else if(table==="perp_payouts") {immutable=Object.keys(row).filter(k=>!["remaining_micro","updated_at"].includes(k));if(BigInt(String(found.remaining_micro))>BigInt(String(row.remaining_micro)))mismatch=true;}
     if(immutable.some(k=>found[k]!==row[k]))mismatch=true;
     if(table==="perp_accounts"&&BigInt(String(found.nonce_high_water??"0"))<BigInt(String(row.nonce_high_water??"0")))mismatch=true;
    }});
    const hasLocalBook=current&&Object.entries(current.tableCounts).some(([t,n])=>t!=="agents"&&n>0);
    if(!current||!hasLocalBook)await restoreFinancialStream(local,store.loadStream(prior),o.account,{scope:"financial"});
    else {
     try {await local.tx(tx=>inspectFinancialStream(captureFinancialStream(tx,o.account),o.account,{scope:"financial",priorJournalProof:old.journalProof}));}
     catch {throw new Error("warm financial journal diverges from authenticated recovery history");}
     for(const table of ["paper_book","energy_days","risk_periods"])if(current.tableCounts[table]!<old.tableCounts[table]!)mismatch=true;
     if(current.journalProof.count===old.journalProof.count) {
      for(const table of EXACT_WITHOUT_JOURNAL)if(current.tableCounts[table]!==old.tableCounts[table])mismatch=true;
      await inspectFinancialStream(store.loadStream(prior),o.account,{scope:"financial",onRow:async(table,row)=>{
       if(!EXACT_WITHOUT_JOURNAL.has(table))return;
       const found=await matchingRow(local,table,row,Object.keys(row));if(!found)mismatch=true;
      }});
     }
     if(mismatch)throw new Error("warm financial state diverges without complete audit facts");
    }
   } else {
    if(!current)throw new Error("local financial capsule incomplete");
    await checkMigration(o.shared,local,o.account,current.journalProof.count);
   }
   if(!o.healthy())throw new Error("hosted perps lease lost before recovery");
   const row=await store.claim(o.tenant,o.account,o.publicKey,randomUUID());let summary:FinancialStreamSummary|undefined;
   await local.tx(tx=>store.saveStream(row,validateFinancialStream(captureFinancialStream(tx,o.account),o.account,{scope:"financial",onComplete:s=>{summary=s;}})));
   if(!o.healthy()||!(await store.fence(row)))throw new Error("hosted perps recovery was fenced");
   return new HostedLiveCheckpointBridge(store,row,summary!.journalProof,o.healthy,o.home);
  }finally{raw.close();}
 }
 attach(proc: ChildProcess): void {
  proc.on("message", raw => { this.tail = this.tail.then(() => this.message(proc, raw)).catch(() => {}); });
  proc.on("exit", () => this.frames.close());
  proc.on("disconnect", () => this.frames.close());
 }
 /** Periodic/final parent mirror preserves intervening journal appends too. */
 mirrorSnapshot<T>(db: Db, mirror: (snapshot: Db) => Promise<T>): Promise<T> {
  const run = this.tail.then(() => db.tx(async snapshot => {
   if (!this.healthy()) throw new Error("hosted perps mirror fenced");
   let summary: FinancialStreamSummary | undefined;
   const chunks = validateFinancialStream(captureFinancialStream(snapshot, this.row.smartAccount), this.row.smartAccount, { scope: "financial", priorJournalProof: this.previous, onComplete: s => { summary = s; } });
   if (await this.store.fence(this.row)) await this.store.saveStream(this.row, chunks);
   else await this.store.saveRetiredStream(this.row, chunks);
   this.previous = summary!.journalProof;
   // Existing mirror helpers request their own read transaction. Reuse this
   // already-pinned read view so their rows remain at the capsule's instant.
   const readView: Db = {
    prepare(sql) { if (!/^\s*(SELECT|PRAGMA)\b/i.test(sql)) throw new Error("financial mirror view is read-only"); return snapshot.prepare(sql); },
    exec: async () => { throw new Error("financial mirror view is read-only"); },
    tx: fn => fn(readView),
   };
   return mirror(readView);
  }));
  this.tail = run.then(() => {}, () => {}); return run;
 }
 private async message(proc: ChildProcess, raw: unknown): Promise<void> {
  if (!raw || typeof raw !== "object") return;
  const msg = raw as { kind?: string; id?: number; account?: string; payload?: string };
  if (msg.kind !== "perp-checkpoint" && msg.kind !== "perp-fence" && !["perp-checkpoint-begin", "perp-checkpoint-page", "perp-checkpoint-commit"].includes(String(msg.kind))) return;
  if (!Number.isSafeInteger(msg.id)) return;
  let ok = false;
  try {
   if (msg.account !== this.row.smartAccount || !this.healthy() || !(await this.store.fence(this.row))) throw new Error("hosted perps send fenced");
   const persist = async (chunks: FinancialChunks) => {
    let summary: FinancialStreamSummary | undefined;
    await this.store.saveStream(this.row, validateFinancialStream(chunks, this.row.smartAccount, { scope: "financial", priorJournalProof: this.previous, onComplete: s => { summary = s; } }));
    this.previous = summary!.journalProof;
   };
   if (msg.kind?.startsWith("perp-checkpoint-")) {
    await this.frames.acceptStream(msg.kind.slice("perp-checkpoint-".length), msg.payload, persist);
   } else if (msg.kind === "perp-checkpoint") {
    if (typeof msg.payload !== "string" || msg.payload.length > STANDDOWN_CHECKPOINT_MAX * 1.4) throw new Error("hosted perps checkpoint bound");
    await persist([Buffer.from(msg.payload, "base64")]);
   }
   ok = this.healthy() && await this.store.fence(this.row);
  } catch { this.frames.close(); ok = false; }
  if (proc.connected) proc.send({ kind: "perp-ack", id: msg.id, ok });
 }
}
