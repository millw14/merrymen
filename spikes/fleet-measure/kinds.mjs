import fs from 'node:fs';
const RPC=/\[rpc:(read|bundler)\] (\d+) calls in (\d+)s \(([0-9.]+)\/s\) . (\d+) err . (\d+) rate-limited . peak concurrency (\d+)(.*)$/;
const SEG=/(\w+) (\d+)(?:\/(\d+)err)? avg(\d+)ms(?: \[([^\]]*)\])?/g;
const kinds={}, methodCalls={}, methodErr={};
let lines=0, calls=0, err=0, rl=0, gl=0, ticks=0, files=0;
const seen=new Set();
for (const p of process.argv.slice(2)) {
  files++;
  for (const l of fs.readFileSync(p,'utf8').replace(/^\uFEFF/,'').split(/\r?\n/)) {
    if(!l.trim())continue; const r=JSON.parse(l); const m=(r.message||'').match(RPC); if(!m||m[1]!=='read')continue;
    const key=r.timestamp+'|'+r.message; if(seen.has(key))continue; seen.add(key);
    lines++; calls+=+m[2]; err+=+m[5]; rl+=+m[6];
    let s; SEG.lastIndex=0;
    while((s=SEG.exec(m[8]))){ methodCalls[s[1]]=(methodCalls[s[1]]||0)+ +s[2]; if(s[3])methodErr[s[1]]=(methodErr[s[1]]||0)+ +s[3];
      if(s[1]==='eth_getLogs') gl+=+s[2];
      if(s[5]) for(const kv of s[5].split(',')){const[k,v]=kv.split(':'); kinds[k]=(kinds[k]||0)+ +v;} }
  }
}
console.log(`files=${files}  DEDUPED rpc:read lines=${lines}`);
console.log(`TOTAL calls=${calls}  errors=${err}  rate-limited=${rl}  (${(100*rl/calls).toFixed(3)}%)`);
console.log(`TOTAL eth_getLogs=${gl}`);
console.log(`ERROR KINDS across every method bracket: ${JSON.stringify(kinds)}`);
console.log(`\nper-method calls: ${JSON.stringify(methodCalls)}`);
console.log(`per-method errors: ${JSON.stringify(methodErr)}`);
