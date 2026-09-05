import fs from 'node:fs';
const RPC=/\[rpc:(read|bundler)\] (\d+) calls in (\d+)s \(([0-9.]+)\/s\) . (\d+) err . (\d+) rate-limited . peak concurrency (\d+)(.*)$/;
const TAG=/^\[([0-9a-fx]{8})\] /;
const GL=/eth_getLogs (\d+)(?:\/(\d+)err)? avg(\d+)ms(?: \[([^\]]*)\])?/;
for (const p of process.argv.slice(2)) {
  const recs = fs.readFileSync(p,'utf8').replace(/^\uFEFF/,'').split(/\r?\n/).filter(l=>l.trim()).map(l=>JSON.parse(l));
  const rows=[];
  for(const r of recs){const m=(r.message||'').match(RPC); if(!m||m[1]!=='read')continue;
    const t=(r.message||'').match(TAG); const g=m[8].match(GL);
    rows.push({ts:r.timestamp,tenant:t?t[1]:'?',calls:+m[2],secs:+m[3],err:+m[5],rl:+m[6],peak:+m[7],gl:g?+g[1]:0,glerr:g&&g[2]?+g[2]:0});}
  const S=(k)=>rows.reduce((a,b)=>a+b[k],0);
  const ts=rows.map(r=>r.ts).sort();
  console.log(`\n### ${p.split(/[\/]/).pop()}`);
  console.log(`  rpc:read lines=${rows.length}  tenants=${new Set(rows.map(r=>r.tenant)).size}  span ${ts[0]} .. ${ts[ts.length-1]}`);
  console.log(`  TOTAL calls=${S('calls')}  errors=${S('err')}  rate-limited=${S('rl')}  (${(100*S('rl')/S('calls')).toFixed(3)}% of calls)`);
  console.log(`  TOTAL eth_getLogs=${S('gl')}  getLogs errors=${S('glerr')}  (getLogs = ${(100*S('gl')/S('calls')).toFixed(2)}% of all calls)`);
  console.log(`  peak concurrency: max=${Math.max(...rows.map(r=>r.peak))} sum-of-per-child-peaks=${S('peak')} mean=${(S('peak')/rows.length).toFixed(2)}`);
  const withRl = rows.filter(r=>r.rl>0).length;
  console.log(`  ticks with >=1 rate-limited: ${withRl}/${rows.length} (${(100*withRl/rows.length).toFixed(1)}%)  worst single tick rl=${Math.max(...rows.map(r=>r.rl))}`);
  // blocks scanned lower bound: gl calls * span. arm chunks are 10000; steady chunks unknown -> report both
  console.log(`  BLOCKS (if every getLogs were a full 10,000-block chunk): ${S('gl')*10000}`);
}
