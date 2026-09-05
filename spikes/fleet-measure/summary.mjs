import fs from 'fs';
const files = process.argv.slice(2);
const seen=new Set(); const lines=[];
for(const f of files) for(const raw of fs.readFileSync(f,'utf8').split('\n')){
  if(!raw.trim())continue; let o; try{o=JSON.parse(raw)}catch{continue}
  const k=o.timestamp+'|'+o.message; if(seen.has(k))continue; seen.add(k); lines.push(o);
}
lines.sort((a,b)=>a.timestamp<b.timestamp?-1:1);
const HDR=/^\[(0x[0-9a-fA-F]+)\] \[rpc:(read|bundler)\] (\d+) calls in (\d+)s \(([0-9.]+)\/s\) · (\d+) err · (\d+) rate-limited · peak concurrency (\d+) · (.*)$/;
const SEG=/^(\w+) (\d+)(?:\/(\d+)err)? avg(\d+)ms(?: \[(.*)\])?$/;
const rows=[];
for(const o of lines){ const m=HDR.exec(o.message); if(!m)continue;
  const segs=m[9].split(' · ').map(s=>{const g=SEG.exec(s.trim()); return g?{method:g[1],calls:+g[2],errs:g[3]?+g[3]:0,avg:+g[4],kinds:g[5]||''}:null}).filter(Boolean);
  rows.push({ts:o.timestamp,tenant:m[1],calls:+m[3],secs:+m[4],err:+m[6],rl:+m[7],peak:+m[8],segs});
}
// PER HOUR
console.log('HOUR | lines | calls   | rate-limited | rl%    | maxPeak | ticks w/ rl');
const byH={};
for(const r of rows){ const h=r.ts.slice(11,13); (byH[h] ??= []).push(r); }
for(const h of Object.keys(byH).sort()){ const g=byH[h];
  const c=g.reduce((n,x)=>n+x.calls,0), rl=g.reduce((n,x)=>n+x.rl,0);
  console.log(` ${h}  | ${String(g.length).padStart(5)} | ${String(c).padStart(7)} | ${String(rl).padStart(12)} | ${(100*rl/c).toFixed(3).padStart(6)} | ${String(Math.max(...g.map(x=>x.peak))).padStart(7)} | ${g.filter(x=>x.rl>0).length}`);
}
// GETLOGS
const gl=rows.map(r=>{const s=r.segs.find(x=>x.method==='eth_getLogs'); return s?s.calls:0;});
const glh={}; for(const v of gl) glh[v]=(glh[v]||0)+1;
console.log(`\neth_getLogs per child-tick histogram: ${JSON.stringify(glh)}`);
console.log(`eth_getLogs total=${gl.reduce((a,b)=>a+b,0)} over ${rows.length} child-ticks = ${(gl.reduce((a,b)=>a+b,0)/rows.length).toFixed(3)}/tick`);
const first={}; for(const r of rows) if(!first[r.tenant]) first[r.tenant]=r;
const fg=Object.values(first).map(r=>{const s=r.segs.find(x=>x.method==='eth_getLogs'); return s?s.calls:0;});
console.log(`ARM tick getLogs per child: min=${Math.min(...fg)} max=${Math.max(...fg)} sum=${fg.reduce((a,b)=>a+b,0)} n=${fg.length}`);
console.log(`ARM tick calls per child: sum=${Object.values(first).reduce((n,r)=>n+r.calls,0)} secs=${[...new Set(Object.values(first).map(r=>r.secs))].sort((a,b)=>a-b).join(',')}`);
// PEAK detail
const byTenPeak={}; for(const r of rows){ const e=byTenPeak[r.tenant] ??= {max:0,calls:0,n:0}; if(r.peak>e.max)e.max=r.peak; e.calls+=r.calls; e.n++; }
console.log('\nPER-TENANT max peak / mean calls per tick:');
for(const [t,v] of Object.entries(byTenPeak).sort((a,b)=>b[1].max-a[1].max||b[1].calls-a[1].calls))
  console.log(`  ${t} maxPeak=${String(v.max).padStart(2)} ticks=${v.n} meanCalls/tick=${(v.calls/v.n).toFixed(1)}`);
// LATENCY clean vs rl
let ce=0,cw=0,de=0,dw=0;
for(const r of rows) for(const s of r.segs) if(s.method==='eth_call'){ if(r.rl>0){de+=s.calls;dw+=s.avg*s.calls;} else {ce+=s.calls;cw+=s.avg*s.calls;} }
console.log(`\neth_call weighted latency: clean ticks ${(cw/ce).toFixed(1)}ms (n=${ce}) | rate-limited ticks ${(dw/de).toFixed(1)}ms (n=${de})`);
// CYCLE spread over time
const sorted=[...rows]; let groups=[[sorted[0]]];
for(let i=1;i<sorted.length;i++){ if((new Date(sorted[i].ts)-new Date(sorted[i-1].ts))/1000>60) groups.push([]); groups[groups.length-1].push(sorted[i]); }
console.log(`\ncycles=${groups.length}; burst spread first5 vs last5:`);
const sp=g=>((new Date(g[g.length-1].ts)-new Date(g[0].ts))/1000).toFixed(1);
console.log('  first5: '+groups.slice(0,5).map(sp).join(', '));
console.log('  last5 : '+groups.slice(-5).map(sp).join(', '));
const full=groups.filter(g=>g.length===22);
console.log(`  cycles with all 22 children: ${full.length}/${groups.length}`);
const cc=full.map(g=>g.reduce((n,r)=>n+r.calls,0));
console.log(`  calls per full cycle: min=${Math.min(...cc)} mean=${(cc.reduce((a,b)=>a+b,0)/cc.length).toFixed(0)} max=${Math.max(...cc)}`);
const sums=full.map(g=>g.reduce((n,r)=>n+r.peak,0));
console.log(`  sum-of-per-child-peaks per full cycle: min=${Math.min(...sums)} mean=${(sums.reduce((a,b)=>a+b,0)/sums.length).toFixed(0)} max=${Math.max(...sums)}`);
