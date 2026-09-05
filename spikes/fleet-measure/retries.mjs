import fs from 'fs';
const seen=new Set(); const lines=[];
for(const f of process.argv.slice(2)) for(const raw of fs.readFileSync(f,'utf8').split('\n')){
  if(!raw.trim())continue; let o; try{o=JSON.parse(raw)}catch{continue}
  const k=o.timestamp+'|'+o.message; if(seen.has(k))continue; seen.add(k); lines.push(o);
}
const HDR=/^\[(0x[0-9a-fA-F]+)\] \[rpc:(read|bundler)\] (\d+) calls in (\d+)s .*? · (\d+) err · (\d+) rate-limited · peak concurrency (\d+) · (.*)$/;
const SEG=/^(\w+) (\d+)(?:\/(\d+)err)? avg(\d+)ms(?: \[(.*)\])?$/;
const pure=[];   // segments where every call failed -> avg IS the failure latency
const cleanBy={};// per-method baseline from zero-error segments
for(const o of lines){ const m=HDR.exec(o.message); if(!m)continue;
  for(const s of m[8].split(' · ')){ const g=SEG.exec(s.trim()); if(!g)continue;
    const calls=+g[2], errs=g[3]?+g[3]:0, avg=+g[4];
    if(errs>0 && errs===calls) pure.push({ts:o.timestamp,ten:m[1],method:g[1],calls,avg,kinds:g[5]||''});
    if(errs===0){ const e=cleanBy[g[1]] ??= {c:0,w:0}; e.c+=calls; e.w+=avg*calls; }
  }
}
console.log(`PURE-FAILURE segments (calls===errs): ${pure.length}`);
const one=pure.filter(p=>p.calls===1);
console.log(`  of which exactly 1 call / 1 err: ${one.length}`);
const av=one.map(p=>p.avg).sort((a,b)=>a-b);
if(av.length) console.log(`  1-call failure latency ms: min=${av[0]} p25=${av[Math.floor(av.length*0.25)]} p50=${av[Math.floor(av.length/2)]} p75=${av[Math.floor(av.length*0.75)]} max=${av[av.length-1]} mean=${(av.reduce((a,b)=>a+b,0)/av.length).toFixed(1)}`);
const bym={};
for(const p of one){ (bym[p.method] ??= []).push(p.avg); }
console.log('\n  by method (1-call pure failures):');
for(const [k,v] of Object.entries(bym)){ v.sort((a,b)=>a-b); console.log(`    ${k.padEnd(22)} n=${String(v.length).padStart(3)} min=${v[0]} median=${v[Math.floor(v.length/2)]} max=${v[v.length-1]}`); }
console.log('\n  CLEAN per-method baseline (zero-error segments), call-weighted:');
for(const [k,v] of Object.entries(cleanBy)) console.log(`    ${k.padEnd(22)} n=${String(v.c).padStart(7)} avg=${(v.w/v.c).toFixed(1)}ms`);
console.log('\n  viem backoff arithmetic: retryDelay=150, delay=(1<<count)*150 -> attempt sleeps 150,300,600 = 1050ms for 3 retries (4 attempts)');
const below=av.filter(x=>x<1050).length;
console.log(`  1-call pure failures FASTER than the 1050ms retry floor: ${below}/${av.length}`);
console.log('\n  sample pure-failure segments:');
for(const p of pure.slice(0,10)) console.log(`    ${p.ts.slice(11,23)} ${p.ten} ${p.method} ${p.calls}/${p.calls}err avg${p.avg}ms [${p.kinds}]`);
