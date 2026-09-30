import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, beforeEach, afterEach, describe, it } from 'node:test';
import { mintSession } from '@/lib/auth';
import { getGrantStore, resetGrantStoreForTest } from '@merrymen/grant-store';
import type { StoredGrant } from '@merrymen/core';
import { POST } from './route';
const TENANT=`0x${'aa'.repeat(20)}` as const, OTHER=`0x${'bb'.repeat(20)}` as const;
const env=['MERRYMEN_HOME','MERRYMEN_HOSTED','MERRYMEN_SESSION_SECRET','DATABASE_URL'] as const;
const old=Object.fromEntries(env.map(k=>[k,process.env[k]])); let dir:string;
beforeEach(()=>{dir=mkdtempSync(path.join(tmpdir(),'mm-recovery-route-'));process.env.MERRYMEN_HOME=dir;process.env.MERRYMEN_SESSION_SECRET=randomBytes(32).toString('hex');delete process.env.DATABASE_URL;delete process.env.MERRYMEN_HOSTED;resetGrantStoreForTest();writeFileSync(path.join(dir,'grant.json'),JSON.stringify({smartAccount:TENANT,chainId:4663}));});
afterEach(()=>{resetGrantStoreForTest();rmSync(dir,{recursive:true,force:true});});
after(()=>{for(const k of env) {if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];}});
const body={confirm:true,txHash:`0x${'11'.repeat(32)}`,userOpHash:`0x${'22'.repeat(32)}`};
const request=(value:unknown,tenant?:typeof TENANT)=>new Request('https://app.test/api/perps/recovery',{method:'POST',headers:{'content-type':'application/json',...(tenant?{cookie:`mm_session=${mintSession(tenant)}`}:{})},body:JSON.stringify(value)});
describe('owner recovery preparation authentication',()=>{
 it('requires an authenticated current owner on hosted service before any venue read',async()=>{
  process.env.MERRYMEN_HOSTED='1';await getGrantStore().put(TENANT,{smartAccount:TENANT,chainId:4663} as StoredGrant);
  assert.equal((await POST(request({...body,owner:TENANT}))).status,401);
  for(const owner of [undefined,OTHER,false]) assert.equal((await POST(request({...body,owner},TENANT))).status,409);
 });
 it('requires explicit acknowledgement and complete receipt identities',async()=>{
  for(const value of [null,{}, {...body,confirm:false},{...body,txHash:'untrusted'},{...body,userOpHash:null}]) assert.equal((await POST(request(value))).status,400);
 });
 it('does not treat a receipt alone as permission to create a trading grant',async()=>{
  const answer=await POST(request(body));assert.equal(answer.status,409);assert.match((await answer.json()).error,/armed perpetual permission/);
 });
});
