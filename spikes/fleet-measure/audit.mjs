import fs from 'fs';
const files = process.argv.slice(2);
const seen = new Set(); const lines = [];
for (const f of files) {
  for (const raw of fs.readFileSync(f,'utf8').split('\n')) {
    if (!raw.trim()) continue;
    let o; try { o = JSON.parse(raw); } catch { continue; }
    const k = o.timestamp + '|' + o.message;
    if (seen.has(k)) continue; seen.add(k);
    lines.push(o);
  }
}
lines.sort((a,b)=>a.timestamp<b.timestamp?-1:1);
console.log(`TOTAL deduped lines: ${lines.length}`);
console.log(`WINDOW: ${lines[0].timestamp} -> ${lines[lines.length-1].timestamp}`);

const DOT = '·';
const HDR = /^\[(0x[0-9a-fA-F]+)\] \[rpc:(read|bundler)\] (\d+) calls in (\d+)s \(([0-9.]+)\/s\) · (\d+) err · (\d+) rate-limited · peak concurrency (\d+) · (.*)$/;
const SEG = /^(\w+) (\d+)(?:\/(\d+)err)? avg(\d+)ms(?: \[(.*)\])?$/;

const rows=[]; let unparsed=0, bundlerLines=0;
for (const o of lines) {
  const msg = o.message;
  if (!msg.includes('[rpc:')) continue;
  const m = HDR.exec(msg);
  if (!m) { unparsed++; console.log('UNPARSED: '+msg.slice(0,200)); continue; }
  if (m[2]==='bundler') bundlerLines++;
  const segs = m[9].split(' '+DOT+' ').map(s=>{
    const g = SEG.exec(s.trim());
    if (!g) { console.log('BADSEG: '+s); return null; }
    return {method:g[1],calls:+g[2],errs:g[3]?+g[3]:0,avg:+g[4],kinds:g[5]||''};
  }).filter(Boolean);
  rows.push({ts:o.timestamp,tenant:m[1],label:m[2],calls:+m[3],secs:+m[4],rate:+m[5],err:+m[6],rl:+m[7],peak:+m[8],segs,nseg:segs.length});
}
console.log(`\nrpc lines parsed: ${rows.length} (bundler: ${bundlerLines}, unparsed: ${unparsed})`);

let mismatch=0, segTotal=0, hdrTotal=0, maxSeg=0;
for (const r of rows){ const s=r.segs.reduce((n,x)=>n+x.calls,0); segTotal+=s; hdrTotal+=r.calls; if(s!==r.calls) mismatch++; if(r.nseg>maxSeg) maxSeg=r.nseg; }
console.log(`header calls total=${hdrTotal}  segment sum=${segTotal}  mismatched lines=${mismatch}  max methods on any line=${maxSeg} (cap is 6)`);

const byM={};
for(const r of rows) for(const s of r.segs){ const e=byM[s.method]??={calls:0,errs:0,wms:0,lines:0,kinds:{}}; e.calls+=s.calls; e.errs+=s.errs; e.wms+=s.avg*s.calls; e.lines++;
  if(s.kinds) for(const kv of s.kinds.split(',')){ const [k,n]=kv.split(':'); e.kinds[k]=(e.kinds[k]||0)+ +n; } }
console.log('\nMETHOD TABLE');
for(const [k,v] of Object.entries(byM).sort((a,b)=>b[1].calls-a[1].calls))
  console.log(`  ${k.padEnd(22)} calls=${String(v.calls).padStart(7)} (${(100*v.calls/hdrTotal).toFixed(2)}%) err=${v.errs} wavg=${(v.wms/v.calls).toFixed(1)}ms kinds=${JSON.stringify(v.kinds)} on=${v.lines}/${rows.length}`);

const hdrErr=rows.reduce((n,r)=>n+r.err,0), hdrRl=rows.reduce((n,r)=>n+r.rl,0);
const segErr=Object.values(byM).reduce((n,v)=>n+v.errs,0);
const allKinds={}; for(const v of Object.values(byM)) for(const [k,n] of Object.entries(v.kinds)) allKinds[k]=(allKinds[k]||0)+n;
console.log(`\nERR RECONCILE: header err=${hdrErr}  segment err=${segErr}  gap=${hdrErr-segErr}`);
console.log(`RL RECONCILE : header rl=${hdrRl}   bracket kinds=${JSON.stringify(allKinds)}`);

const peaks=rows.map(r=>r.peak).sort((a,b)=>a-b);
const hist={}; for(const p of peaks) hist[p]=(hist[p]||0)+1;
console.log(`\nPEAK per-child-tick: max=${peaks[peaks.length-1]} mean=${(peaks.reduce((a,b)=>a+b,0)/peaks.length).toFixed(2)} hist=${JSON.stringify(hist)}`);
const mx=peaks[peaks.length-1];
const peakMax=rows.filter(r=>r.peak===mx).map(r=>r.tenant); console.log(`  peak==${mx} tenants: ${JSON.stringify([...new Set(peakMax)])} (${peakMax.length} ticks)`);

const tenants=[...new Set(rows.map(r=>r.tenant))];
console.log(`\nDISTINCT TENANTS: ${tenants.length}`);
const perT={}; for(const r of rows) perT[r.tenant]=(perT[r.tenant]||0)+1;
const mxT=Math.max(...Object.values(perT));
console.log(`  ticks per tenant: min=${Math.min(...Object.values(perT))} max=${mxT}`);
console.log(`  short tenants: ${JSON.stringify(Object.entries(perT).filter(([,n])=>n!==mxT))}`);

const sorted=[...rows].sort((a,b)=>new Date(a.ts)-new Date(b.ts));
let groups=[[sorted[0]]];
for(let i=1;i<sorted.length;i++){ const gap=(new Date(sorted[i].ts)-new Date(sorted[i-1].ts))/1000; if(gap>60) groups.push([]); groups[groups.length-1].push(sorted[i]); }
console.log(`\nCYCLES (split at >60s gap): ${groups.length}`);
groups.forEach((g,i)=>{ const sp=(new Date(g[g.length-1].ts)-new Date(g[0].ts))/1000; const c=g.reduce((n,r)=>n+r.calls,0); const pk=g.reduce((n,r)=>n+r.peak,0);
  console.log(`  cycle ${i}: n=${String(g.length).padStart(2)} calls=${String(c).padStart(5)} spread=${sp.toFixed(1)}s sumPeaks=${pk} rl=${g.reduce((n,r)=>n+r.rl,0)} start=${g[0].ts.slice(11,23)}`); });

const secs=rows.map(r=>r.secs).sort((a,b)=>a-b);
console.log(`\nMETER WINDOW 'in Ns': min=${secs[0]} median=${secs[Math.floor(secs.length/2)]} max=${secs[secs.length-1]}`);

// getLogs distribution
const gl=rows.map(r=>{const s=r.segs.find(x=>x.method==='eth_getLogs'); return s?s.calls:0;});
const glh={}; for(const v of gl) glh[v]=(glh[v]||0)+1;
console.log(`\neth_getLogs per child-tick histogram: ${JSON.stringify(glh)}  total=${gl.reduce((a,b)=>a+b,0)}`);

// non-rpc markers
const marks=['[exec]','[gas]','[quote]','[rpc:bundler]','spawned (pid','] exited (','heartbeat stale','rallying','getLogs gave up','retrying the same span','sequencer DOWN','[tick] ','fleet:'];
console.log('\nMARKER COUNTS in this window:');
for(const k of marks) console.log(`  ${JSON.stringify(k).padEnd(26)} ${lines.filter(l=>l.message.includes(k)).length}`);
