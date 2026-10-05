/** Opt-in disposable LOCAL PostgreSQL only; never reads DATABASE_URL or a signing key. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { makePgDb, rootDb } from "./db";
import { readFleetCommandRefusal, readFleetRecoveryView, recordFleetRecoveryHold, recordFleetSourceVerified,
  withFleetRecoveryLock } from "./fleet-recovery";
import { placeRecoveryCheckedOrder } from "../../web/src/lib/recovery-orders";
import { ensureBotClaims } from "./telegram-claims";
import { commandDir } from "./command-files";
import { ferryOrders, ferryForChild } from "./orchestrator";

const url = process.env.MERRYMEN_TEST_PG_URL;
const address = (n: number) => `0x${n.toString(16).padStart(40,"0")}`;
test("Postgres: recovery reports and financial queues serialize across separate pools", { skip: !url, timeout: 40_000 }, async t => {
  const target = new URL(url!);
  assert.ok(["127.0.0.1","localhost","[::1]"].includes(target.hostname), "disposable LOCAL PostgreSQL only");
  const pg = createRequire(import.meta.url)("pg");
  const admin = new pg.Client({connectionString:target.toString()}); await admin.connect();
  const schema = `mm_fleet_recovery_${randomBytes(8).toString("hex")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const scoped = (name:string) => { const u=new URL(target); u.searchParams.set("options",`-c search_path=${schema} -c statement_timeout=10000`);
    u.searchParams.set("application_name",name); return u.toString(); };
  const a=await makePgDb(scoped("recovery-a")), b=await makePgDb(scoped("recovery-b"));
  const home=mkdtempSync(path.join(os.tmpdir(),"mm-recovery-ferry-pg-"));
  const tenant=address(0x901),account=address(0x902),scope={tenant,smartAccount:account,chainId:4663};
  const at=Math.floor(Date.now()/1000);
  const order=(id:string,agent=account,now=at*1000)=>({id,agent,args:{side:"buy",symbol:"TSLA",usdgAmount:1},now,expiresAt:now+300_000});
  try {
    await a.exec(`CREATE TABLE agent_commands(id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,kind TEXT NOT NULL,args TEXT,
      created_at BIGINT NOT NULL,claimed_at BIGINT,done_at BIGINT,result TEXT,receipt TEXT);
      CREATE TABLE trades(agent_id TEXT); CREATE TABLE posts(agent_id TEXT); CREATE TABLE flows(agent_id TEXT);`);
    await t.test("an old missing optional table does not poison order admission's transaction",async()=>{
      assert.deepEqual(await placeRecoveryCheckedOrder(a,order("old-server",address(0x903))),{ok:true});
    });
    await t.test("session-owned transactions commit, roll back and reject nested or concurrent work",async()=>{
      await withFleetRecoveryLock(a,account,async locked=>{
        await locked.tx(async tx=>{ await tx.prepare("INSERT INTO trades(agent_id) VALUES(?)").run(account);
          await assert.rejects(tx.tx(async()=>undefined),/nested/); });
        await assert.rejects(locked.tx(async tx=>{ await tx.prepare("INSERT INTO trades(agent_id) VALUES(?)").run("rollback"); throw new Error("rollback injected"); }),/rollback injected/);
        let release!:()=>void,entered!:()=>void;
        const waiting=new Promise<void>(r=>{entered=r;}),go=new Promise<void>(r=>{release=r;});
        const running=locked.tx(async()=>{entered();await go;});
        await waiting; await assert.rejects(locked.tx(async()=>undefined),/concurrent/);
        release();await running;
      });
      assert.equal(Number((await a.prepare("SELECT COUNT(*) AS n FROM trades WHERE agent_id='rollback'").get() as {n:unknown}).n),0);
    });
    await t.test("rolled-back transaction DDL cannot poison a pool-wide schema memo",async()=>{
      await assert.rejects(withFleetRecoveryLock(a,account,locked=>locked.tx(async tx=>{
        assert.notEqual(rootDb(tx),a); await ensureBotClaims(tx); throw new Error("DDL rollback fixture");
      })),/DDL rollback fixture/);
      assert.equal((await admin.query("SELECT to_regclass($1) AS name",[`${schema}.telegram_bot_claims`])).rows[0].name,null);
      await ensureBotClaims(a);
      assert.ok((await admin.query("SELECT to_regclass($1) AS name",[`${schema}.telegram_bot_claims`])).rows[0].name);
    });
    await t.test("publication waits for an admitted request, then the request cannot cross delivery",async()=>{
      let release!:()=>void,entered!:()=>void;
      const waiting=new Promise<void>(r=>{entered=r;}),go=new Promise<void>(r=>{release=r;});
      const admission=withFleetRecoveryLock(a,account,async locked=>{
        assert.equal(await readFleetCommandRefusal(locked,account,at*1000),false);
        entered();await go;
        await locked.prepare("INSERT INTO agent_commands(id,agent_id,kind,args,created_at) VALUES(?,?,'trade','{}',?)").run("racing",account,at*1000);
      });
      await waiting;
      let published=false;
      const hold=recordFleetRecoveryHold(b,scope,"source-continuity",at,()=>true).then(()=>{published=true;});
      await delay(30);assert.equal(published,false,"a second pool cannot publish across the held admission lock");
      release();await Promise.all([admission,hold]);
      assert.deepEqual(await placeRecoveryCheckedOrder(a,order("refused")),{ok:false,why:"recovery"});
      await ferryOrders(a,[{home,smartAccount:account,tag:tenant}]);
      assert.equal((await a.prepare("SELECT claimed_at FROM agent_commands WHERE id='racing'").get() as {claimed_at:unknown}).claimed_at,null);
      assert.deepEqual(readdirSync(home),[]);
    });
    await t.test("expired legacy intents stay unresolved through the old stale sweep",async()=>{
      await a.prepare("INSERT INTO agent_commands(id,agent_id,kind,args,created_at) VALUES(?,?,'trade',?,?)")
        .run("legacy-expired",account,JSON.stringify({expiresAt:(at-5000)*1000}),(at-6000)*1000);
      await ferryForChild(a,{home,smartAccount:account,tag:tenant});
      const row=await a.prepare("SELECT claimed_at,done_at,result FROM agent_commands WHERE id='legacy-expired'").get();
      assert.deepEqual(row,{claimed_at:null,done_at:null,result:null});
    });
    await t.test("a stale source check cannot clear a newer hold or report a successful release",async()=>{
      await recordFleetRecoveryHold(b,scope,"source-barrier",at+20,()=>true);
      assert.equal(await recordFleetSourceVerified(a,scope,at+10,()=>true),false);
      assert.equal((await readFleetRecoveryView(a,scope,at-1))?.tradingPaused,true);
    });
    await t.test("a healthy source check retains the cutoff; only fresh requests can be delivered",async()=>{
      assert.equal(await recordFleetSourceVerified(a,scope,at+30,()=>true),true);
      const now=(at+31)*1000+1;
      assert.deepEqual(await placeRecoveryCheckedOrder(b,order("new",account,now)),{ok:false,why:"in-flight"},"legacy unresolved open slots are preserved");
      // Fixture-only receipt closure, never a recovery writer. The next new request is independent.
      await a.prepare("UPDATE agent_commands SET done_at=? WHERE agent_id=?").run(now,account);
      assert.deepEqual(await placeRecoveryCheckedOrder(b,order("fresh",account,now)),{ok:true});
      await ferryOrders(a,[{home,smartAccount:account,tag:tenant}]);
      assert.deepEqual(readdirSync(commandDir(home)),["fresh.json"]);
      assert.equal((await a.prepare("SELECT claimed_at FROM agent_commands WHERE id='racing'").get() as {claimed_at:unknown}).claimed_at,null);
    });
    await t.test("retained windows cannot starve later fresh trades, probes or resets",async()=>{
      const preserved=address(0xc01),scope2={tenant:address(0xc02),smartAccount:preserved,chainId:4663};
      await recordFleetRecoveryHold(a,scope2,"source-continuity",at,()=>true);
      const old=(at-6000)*1000,fresh=(at+51)*1000+1;
      for(let i=0;i<60;i++) await a.prepare("INSERT INTO agent_commands(id,agent_id,kind,args,created_at) VALUES(?,?,'trade',?,?)")
        .run(`preserved-${i}`,preserved,JSON.stringify({expiresAt:old+30_000}),old+i);
      for(const kind of ["selftest","paper-reset"]) await a.prepare("INSERT INTO agent_commands(id,agent_id,kind,created_at) VALUES(?,?,?,?)")
        .run(`old-${kind}`,preserved,kind,old);
      await recordFleetSourceVerified(a,scope2,at+50,()=>true);
      await a.prepare("INSERT INTO agent_commands(id,agent_id,kind,args,created_at) VALUES(?,?,'trade',?,?)")
        .run("after-window",preserved,JSON.stringify({expiresAt:fresh+300_000}),fresh);
      await ferryOrders(b,[{home,smartAccount:preserved,tag:scope2.tenant}]);
      assert.ok(readdirSync(commandDir(home)).includes("after-window.json"));
      await a.prepare("INSERT INTO agent_commands(id,agent_id,kind,created_at) VALUES(?,?,?,?)").run("new-probe",preserved,"selftest",fresh);
      await ferryForChild(b,{home,smartAccount:preserved,tag:scope2.tenant});
      assert.ok(readdirSync(commandDir(home)).includes("new-probe.json"));
      assert.equal(Number((await a.prepare("SELECT COUNT(*) AS n FROM agent_commands WHERE agent_id=? AND id<>'after-window' AND id<>'new-probe' AND (claimed_at IS NOT NULL OR done_at IS NOT NULL)").get(preserved) as {n:unknown}).n),0);
    });
    await t.test("parallel reports retain per-account isolation",async()=>{
      await Promise.all(Array.from({length:6},(_,i)=>recordFleetRecoveryHold(i%2?a:b,
        {tenant:address(0xa00+i),smartAccount:address(0xb00+i),chainId:4663},"persistent-source",at,()=>true)));
      assert.equal(Number((await a.prepare("SELECT COUNT(*) AS n FROM fleet_recovery_health").get() as {n:unknown}).n),8);
    });
  } finally { await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();rmSync(home,{recursive:true,force:true}); }
});
