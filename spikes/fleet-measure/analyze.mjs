import fs from 'node:fs';
const path = process.argv[2];
let raw = fs.readFileSync(path, 'utf8');
if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
const lines = raw.split(/\r?\n/).filter(l => l.trim().length);
const recs = [];
let bad = 0;
for (const l of lines) { try { recs.push(JSON.parse(l)); } catch { bad++; } }
console.log(`FILE ${path}`);
console.log(`raw lines=${lines.length} parsed=${recs.length} unparseable=${bad}`);
const ts = recs.map(r => r.timestamp).filter(Boolean).sort();
console.log(`span ${ts[0]} .. ${ts[ts.length-1]}`);
const spanS = (Date.parse(ts[ts.length-1]) - Date.parse(ts[0]))/1000;
console.log(`span seconds=${spanS.toFixed(1)}  minutes=${(spanS/60).toFixed(2)}`);

// ---- rpc:read summaries
const RPC = /\[rpc:(read|bundler)\] (\d+) calls in (\d+)s \(([0-9.]+)\/s\) . (\d+) err . (\d+) rate-limited . peak concurrency (\d+)(.*)$/;
const TAG = /^\[([0-9a-fx]{8})\] /;
const rpcRead = [], rpcBundler = [];
for (const r of recs) {
  const m = (r.message||'').match(RPC);
  if (!m) continue;
  const tagm = (r.message||'').match(TAG);
  const row = { ts:r.timestamp, tenant: tagm?tagm[1]:'?', label:m[1], calls:+m[2], secs:+m[3], rate:+m[4], err:+m[5], rl:+m[6], peak:+m[7], top:m[8] };
  (m[1]==='read'?rpcRead:rpcBundler).push(row);
}
console.log(`\n=== RPC SUMMARY LINES ===`);
console.log(`rpc:read lines=${rpcRead.length}  rpc:bundler lines=${rpcBundler.length}`);
const tenants = [...new Set(rpcRead.map(r=>r.tenant))].sort();
console.log(`distinct tenants in rpc:read=${tenants.length}`);

// ---- eth_getLogs extraction from method segments
// segment: eth_getLogs 6/1err avg1204ms [timeout:1]   OR  eth_getLogs 6 avg1204ms
const GL = /eth_getLogs (\d+)(?:\/(\d+)err)? avg(\d+)ms(?: \[([^\]]*)\])?/;
let glCalls=0, glErr=0, glLinesWith=0, glLinesWithout=0;
const glPerLine=[], glKinds={};
for (const r of rpcRead) {
  const m = r.top.match(GL);
  if (!m) { glLinesWithout++; continue; }
  glLinesWith++;
  const c=+m[1], e=m[2]?+m[2]:0;
  glCalls+=c; glErr+=e;
  glPerLine.push({tenant:r.tenant, ts:r.ts, calls:c, err:e, avg:+m[3], kinds:m[4]||''});
  if (m[4]) for (const kv of m[4].split(',')) { const [k,v]=kv.split(':'); glKinds[k]=(glKinds[k]||0)+ +v; }
}
console.log(`\n=== eth_getLogs (from rpc:read method segments) ===`);
console.log(`rpc:read lines WITH an eth_getLogs segment = ${glLinesWith}`);
console.log(`rpc:read lines WITHOUT one (zero calls OR pushed out of top-6) = ${glLinesWithout}`);
console.log(`total eth_getLogs calls counted = ${glCalls}`);
console.log(`total eth_getLogs errors = ${glErr}  kinds=${JSON.stringify(glKinds)}`);
const glc = glPerLine.map(x=>x.calls).sort((a,b)=>a-b);
if (glc.length) {
  const sum=glc.reduce((a,b)=>a+b,0);
  console.log(`per-tick getLogs calls: n=${glc.length} min=${glc[0]} max=${glc[glc.length-1]} mean=${(sum/glc.length).toFixed(2)} median=${glc[Math.floor(glc.length/2)]}`);
  const hist={}; for(const v of glc) hist[v]=(hist[v]||0)+1;
  console.log(`histogram(calls->ticks): ${JSON.stringify(hist)}`);
  const avgs = glPerLine.map(x=>x.avg).sort((a,b)=>a-b);
  console.log(`per-tick getLogs avg latency ms: min=${avgs[0]} max=${avgs[avgs.length-1]} median=${avgs[Math.floor(avgs.length/2)]} mean=${(avgs.reduce((a,b)=>a+b,0)/avgs.length).toFixed(0)}`);
}
// per-tenant getLogs
const byT={};
for (const r of rpcRead) { byT[r.tenant] ??= {ticks:0, glTicks:0, glCalls:0, calls:0}; byT[r.tenant].ticks++; byT[r.tenant].calls+=r.calls; }
for (const g of glPerLine) { byT[g.tenant].glTicks++; byT[g.tenant].glCalls+=g.calls; }
console.log(`\nper-tenant: tenant ticks rpcCalls glTicks glCalls`);
for (const t of tenants) { const v=byT[t]; console.log(`  ${t} ${v.ticks} ${v.calls} ${v.glTicks} ${v.glCalls}`); }

// ---- top-6 truncation check: how many methods listed per line, and was the 6th smaller than getLogs floor
let linesWith6=0;
for (const r of rpcRead) { const n = r.top.split(' \u00b7 ').filter(s=>s.trim()).length; if (n>=6) linesWith6++; }
console.log(`\nrpc:read lines listing 6 methods (i.e. tail possibly truncated) = ${linesWith6} / ${rpcRead.length}`);

// ---- getLogs adaptive lines
console.log(`\n=== getLogsAdaptive LOG LINES ===`);
const pats = {
  'getLogs ... retrying the same span': /getLogs \S+ at \d+\.\.\d+ . retrying the same span in (\d+)ms/,
  'getLogs gave up': /getLogs gave up at (\d+)/,
  'findOrphanOps covered only': /findOrphanOps covered only/,
  'chain scan skipped': /chain scan skipped/,
  'refusing to advance the cursor': /refusing to advance the cursor/,
  '[reconcile] prefix': /\[reconcile\]/,
  '[flows] prefix': /\[flows\]/,
};
for (const [name,re] of Object.entries(pats)) {
  const hits = recs.filter(r => re.test(r.message||''));
  console.log(`  ${name}: ${hits.length}`);
  for (const h of hits.slice(0,10)) console.log(`      ${h.timestamp} ${h.message}`);
}

// ---- lifecycle
console.log(`\n=== LIFECYCLE ===`);
const life = {
  spawned: /\[orchestrator\] (\S+) spawned \(pid (\d+)\) . tick (\d+)s, watchdog (\d+)s/,
  exited: /\[orchestrator\] (\S+) exited \(([^)]*)\)/,
  rallying: /rallying again in/,
  stale: /heartbeat stale \(([^)]*) > (\d+)s\)/,
  sigkill: /SIGKILL/,
  givingup: /keeps dying right after start/,
  nolease: /no healthy lease . not spawning/,
  nogrant: /no grant in the store . not spawning/,
};
for (const [name,re] of Object.entries(life)) {
  const hits = recs.filter(r => re.test(r.message||''));
  console.log(`  ${name}: ${hits.length}`);
  for (const h of hits.slice(0,25)) console.log(`      ${h.timestamp} ${h.message}`);
}

// ---- tick census
const TICK = /\[tick\] (\w+) block (\d+|unread)/;
const ticks = [];
for (const r of recs) { const m=(r.message||'').match(TICK); if(!m) continue; const t=(r.message||'').match(TAG); ticks.push({ts:r.timestamp, tenant:t?t[1]:'?', chain:m[1], block:m[2]}); }
console.log(`\n=== TICK CENSUS ===`);
console.log(`[tick] lines = ${ticks.length}, distinct tenants = ${new Set(ticks.map(t=>t.tenant)).size}`);
const unread = ticks.filter(t=>t.block==='unread');
console.log(`ticks with block=unread = ${unread.length}`);
const perT={}; for(const t of ticks) perT[t.tenant]=(perT[t.tenant]||0)+1;
console.log(`ticks per tenant: ${JSON.stringify(perT)}`);

// block progression: min/max mainnet block seen
const blocks = ticks.filter(t=>t.block!=='unread').map(t=>BigInt(t.block));
if (blocks.length) {
  let mn=blocks[0], mx=blocks[0];
  for (const b of blocks) { if(b<mn)mn=b; if(b>mx)mx=b; }
  console.log(`mainnet block range observed in [tick] lines: ${mn} .. ${mx}  (delta ${mx-mn} blocks over ${spanS.toFixed(0)}s)`);
}
// ---- gas lines
const gas = recs.filter(r=>/\[gas\]/.test(r.message||''));
console.log(`\n[gas] lines = ${gas.length}`);
