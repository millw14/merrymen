import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { wrapSqlite, type Db } from "../db";
import { applyLedgerSchema } from "../store";
import { captureFinancialCapsule, restoreFinancialCapsule } from "./hosted-financial-capsule";
import { captureFinancialStream, restoreFinancialStream, transformFinancialStream } from "./hosted-financial-stream";
import { OrderDeadlineFloor } from "./restore-order-deadline";

const ACCOUNT = "0x00000000000000000000000000000000000000a1";
const OTHER = "0x00000000000000000000000000000000000000b1";
async function fixture() { const raw=new DatabaseSync(":memory:"),db=wrapSqlite(raw);await applyLedgerSchema(db);return {raw,db}; }
async function order(db:Db,id:string,deadline:number|null,nonce=7) {
  await db.prepare("INSERT INTO perp_orders(id,agent_id,mode,epoch,status,effect,reduce_only,worst_notional_micro,account_index,api_key_index,nonce,tx_hash,send_not_after_ms) VALUES (?,?,'live',1,'submitted','close',1,'0',123,16,?,?,?)").run(id,ACCOUNT,nonce,`tx-${nonce}`,deadline);
}
async function cutoff(db:Db) { return (await db.prepare("SELECT send_not_after_ms FROM perp_orders WHERE mode='live'").get() as {send_not_after_ms:number|null}).send_not_after_ms; }

describe("owner command deadlines survive checkpoint replacement",()=>{
  for(const format of ["full-stream","standdown-stream","legacy-capsule","legacy-stream"] as const) {
    it(`${format} retains the minimum cutoff for the same signed identity`,async()=>{
      const source=await fixture(),destination=await fixture();
      try {
        await order(source.db,"restored-alias",3000);await order(destination.db,"existing-id",2000);
        const restore=async()=>{
          if(format==="legacy-capsule")return restoreFinancialCapsule(destination.db,await captureFinancialCapsule(source.db,ACCOUNT),ACCOUNT);
          if(format==="legacy-stream") {
            const legacy=JSON.parse((await captureFinancialCapsule(source.db,ACCOUNT)).toString());
            if(legacy.tables.perp_orders[0].send_not_after_ms===null)delete legacy.tables.perp_orders[0].send_not_after_ms;
            return restoreFinancialStream(destination.db,[Buffer.from(JSON.stringify(legacy))],ACCOUNT);
          }
          return restoreFinancialStream(destination.db,format==="standdown-stream"?transformFinancialStream(captureFinancialStream(source.db,ACCOUNT),ACCOUNT,{scope:"standdown"}):captureFinancialStream(source.db,ACCOUNT),ACCOUNT);
        };
        await restore();assert.equal(await cutoff(destination.db),2000,"a later incoming bound cannot extend authority");
        await source.db.prepare("UPDATE perp_orders SET send_not_after_ms=NULL").run();await restore();assert.equal(await cutoff(destination.db),2000,"null or absent legacy bound cannot erase known authority");
        await source.db.prepare("UPDATE perp_orders SET send_not_after_ms=1500").run();await restore();assert.equal(await cutoff(destination.db),1500,"an earlier incoming bound tightens authority");
        assert.equal((await destination.db.prepare("SELECT COUNT(*) AS n FROM sqlite_temp_master WHERE name LIKE 'perp_deadline_floor_%'").get() as {n:number}).n,0);
      } finally {source.raw.close();destination.raw.close();}
    });
  }
  it("genuinely legacy rows stay unbounded and known limits never cross account or paper scope",async()=>{
    const f=await fixture();
    try {
      const floor=await OrderDeadlineFloor.create(f.db);
      const row={id:"order",agent_id:ACCOUNT,mode:"live",account_index:123,api_key_index:16,nonce:7,send_not_after_ms:null};
      await floor.remember({...row,agent_id:OTHER,send_not_after_ms:100});
      await floor.remember({...row,mode:"paper",send_not_after_ms:100});
      assert.equal((await floor.apply(row)).send_not_after_ms,null);
      await floor.remember({...row,send_not_after_ms:2000});
      assert.equal((await floor.apply({...row,id:"alias",send_not_after_ms:3000})).send_not_after_ms,2000);
      await floor.close();
    }finally{f.raw.close();}
  });
});
