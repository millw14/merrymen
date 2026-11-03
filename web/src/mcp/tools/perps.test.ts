import assert from "node:assert/strict";
import {afterEach,test} from "node:test";
import {PERPS_TOOLS} from "./perps";
import {runTool,type ToolDef} from "../tool";
import {OWNER_A,OWNER_B,ACCOUNT_A,SLUG_A,SLUG_B,connectAs,installFixtures,makeDeps,makeTestDb,type TestDb} from "../testing";
import {resetMetricsForTest} from "../observe";
const NOW=1_800_000_000, ACCOUNT="0x1111111111111111111111111111111111111111";
const report={v:1,mode:"paper",blocker:null,venueReadAt:NOW*1000,protectAt:NOW*1000,accountIndex:null,positions:[{market:"BTC-PERP",side:"long",baseAmount:"0.1",entryPrice:"60000",markPrice:"61000",leverage:2,marginMicro:"3000000000",liqPrice:"30000",unrealizedMicro:"100000000",stopTrigger:"55000",fundingMicro:"-123"}],openNotionalMicro:"6100000000",collateralMicro:"10000000000",inTransitMicro:"0",minLiqDistanceBps:5000,stopsMissing:0,incident:false};
let d:TestDb, restore:(()=>void)|undefined;
const previous=process.env.MERRYMEN_PERPS;
afterEach(()=>{restore?.();restore=undefined;d?.raw.close();resetMetricsForTest();if(previous===undefined)delete process.env.MERRYMEN_PERPS;else process.env.MERRYMEN_PERPS=previous;});
async function setup(scopes=["portfolio:read"],shared=[SLUG_A]) {
 process.env.MERRYMEN_PERPS="paper";d=await makeTestDb();restore=installFixtures(d);
 d.raw.exec("CREATE TABLE perps_grants (tenant TEXT PRIMARY KEY, grant_json TEXT NOT NULL)");
 d.raw.prepare("INSERT INTO perps_grants VALUES (?,?)").run(OWNER_A,JSON.stringify({purpose:"perps",owner:OWNER_A,smartAccount:ACCOUNT,expiresAt:NOW+1000,serialized:"SECRET",demoSessionPrivateKey:"SECRET"}));
 d.raw.prepare("INSERT INTO agents (smart_account,owner_address,chain_id,caps,granted_at,expires_at,session_key_address,mode,perps) VALUES (?,?,?,?,?,?,?,?,?)").run(ACCOUNT,OWNER_A,4663,"{}",NOW-100,NOW+1000,"0x00","paper",JSON.stringify({...report,privateKey:"REPORT_SECRET"}));
 const {principal}=await connectAs(makeDeps(d),OWNER_A,{scopes,agents:shared});
 const call=(args:Record<string,unknown>={})=>runTool(PERPS_TOOLS[0] as unknown as ToolDef,args,principal,"perps-test",{now:()=>NOW,ledger:async()=>{throw Error("Spot ledger touched");},perpsLedger:fn=>fn(d.db)});
 return {call,principal};
}
test("reads only authenticated Perps account and allowlisted paper fields, never Spot or secrets",async()=>{
 const {call}=await setup(); const result=await call(); assert.equal(result.isError,undefined,result.content[0]?.text);
 const out=result.structuredContent!;assert.equal(out.account,ACCOUNT);assert.equal(out.book,"paper");assert.equal(out.money,"simulated");assert.equal(out.fresh,true);assert.equal(out.collateral_micro,"10000000000");
 assert.equal((out.positions as unknown[]).length,1);assert.ok(!JSON.stringify(result).includes("SECRET"));assert.ok(!JSON.stringify(result).includes(ACCOUNT_A));
 assert.equal((await call({agent:SLUG_B})).isError,true);assert.equal((await call({account:ACCOUNT})).isError,true);
});
test("no shared agent or portfolio scope refuses before reading a private book",async()=>{
 const {call,principal}=await setup();
 principal.agentSlugs=[];assert.equal((await call()).isError,true);
 principal.agentSlugs=[SLUG_A];principal.scopes=new Set(["agents:read"]);assert.equal((await call()).isError,true);
});
test("wrong tenant owner, Spot alias, live book and malformed report never become empty success",async()=>{
 const {call}=await setup();
 for(const grant of [{owner:OWNER_B,smartAccount:ACCOUNT},{owner:OWNER_A,smartAccount:ACCOUNT_A}]){
 d.raw.prepare("UPDATE perps_grants SET grant_json=?").run(JSON.stringify({purpose:"perps",expiresAt:NOW+100,...grant})); assert.equal((await call()).isError,true);
 }
 d.raw.prepare("UPDATE perps_grants SET grant_json=?").run(JSON.stringify({purpose:"perps",owner:OWNER_A,smartAccount:ACCOUNT,expiresAt:NOW+100}));
 for(const value of ["broken",JSON.stringify({...report,mode:"live"}),JSON.stringify({...report,positions:[{}]})]){
 d.raw.prepare("UPDATE agents SET perps=? WHERE smart_account=?").run(value,ACCOUNT);
 const out=(await call()).structuredContent!;assert.equal(out.state,"unreadable");assert.equal(out.positions,null);assert.equal(out.collateral_micro,null);
 }
});
test("absent report, expired permission, stale feed and missing stop are explicit evidence",async()=>{
 const {call}=await setup();
 d.raw.prepare("UPDATE agents SET perps=NULL WHERE smart_account=?").run(ACCOUNT);
 let out=(await call()).structuredContent!;assert.equal(out.state,"not-said");assert.equal(out.positions,null);
 d.raw.prepare("UPDATE agents SET perps=? WHERE smart_account=?").run(JSON.stringify({...report,venueReadAt:(NOW-200)*1000,stopsMissing:1,positions:[{...report.positions[0],stopTrigger:null}]}),ACCOUNT);
 d.raw.prepare("UPDATE perps_grants SET grant_json=?").run(JSON.stringify({purpose:"perps",owner:OWNER_A,smartAccount:ACCOUNT,expiresAt:NOW-1}));
 out=(await call()).structuredContent!;assert.equal(out.fresh,false);assert.match(JSON.stringify(out.attention),/expired/);assert.match(JSON.stringify(out.attention),/protective stop/);
 process.env.MERRYMEN_PERPS="off";assert.equal((await call()).isError,true);
});
