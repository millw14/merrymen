import fs from 'node:fs';
let raw = fs.readFileSync(process.argv[2],'utf8').replace(/^\uFEFF/,'');
const recs = raw.split(/\r?\n/).filter(l=>l.trim()).map(l=>JSON.parse(l));
const RPC=/\[rpc:(read|bundler)\] (\d+) calls in (\d+)s \(([0-9.]+)\/s\) . (\d+) err . (\d+) rate-limited . peak concurrency (\d+)(.*)$/;
const TAG=/^\[([0-9a-fx]{8})\] /;
const rows=[];
for(const r of recs){const m=(r.message||'').match(RPC); if(!m||m[1]!=='read')continue;
  const t=(r.message||'').match(TAG);
  rows.push({ts:r.timestamp,tenant:t?t[1]:'?',calls:+m[2],secs:+m[3],err:+m[5],rl:+m[6],peak:+m[7],top:m[8],msg:r.message});}
rows.sort((a,b)=>a.ts.localeCompare(b.ts));
const byT={}; for(const r of rows){(byT[r.tenant] ??= []).push(r);}
const GL=/eth_getLogs (\d+)(?:\/(\d+)err)? avg(\d+)ms(?: \[([^\]]*)\])?/;
console.log('=== FIRST rpc:read line per tenant (arm window) ===');
console.log('tenant   ts            secs calls peak getLogs');
let firstGl=[],firstCalls=[],firstPeak=[];
for(const t of Object.keys(byT).sort()){const r=byT[t][0];const g=r.top.match(GL);
  const gl=g?+g[1]:0; firstGl.push(gl); firstCalls.push(r.calls); firstPeak.push(r.peak);
  console.log(`${t} ${r.ts.slice(11,23)} ${String(r.secs).padStart(4)} ${String(r.calls).padStart(5)} ${String(r.peak).padStart(4)} ${gl}`);}
const sum=a=>a.reduce((x,y)=>x+y,0);
console.log(`\nFIRST-TICK TOTALS across ${firstGl.length} children: getLogs=${sum(firstGl)} rpcCalls=${sum(firstCalls)} sum-of-peaks=${sum(firstPeak)}`);
console.log(`first-tick getLogs: min=${Math.min(...firstGl)} max=${Math.max(...firstGl)}`);

console.log('\n=== lines that hit the 6-method cap (tail truncated) ===');
for(const r of rows){const n=r.top.split(' \u00b7 ').filter(s=>s.trim()).length;
  if(n>=6) console.log(`  ${r.ts.slice(11,23)} ${r.tenant} nMethods=${n} hasGetLogs=${GL.test(r.top)}  ${r.top.trim().slice(0,220)}`);}

console.log('\n=== lines with ANY getLogs error ===');
for(const r of rows){const g=r.top.match(GL); if(g&&g[2]) console.log(`  ${r.ts} ${r.tenant}\n     ${r.msg}`);}

console.log('\n=== lines with nonzero total err or rate-limited ===');
for(const r of rows){if(r.err||r.rl) console.log(`  ${r.ts.slice(11,23)} ${r.tenant} err=${r.err} rl=${r.rl}\n     ${r.msg}`);}
