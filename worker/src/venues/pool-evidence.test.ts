import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTrades, parsePriceBars, summarizeEvidence, readPoolEvidence } from './pool-evidence';
const token = '0x' + '1'.repeat(40), quote = '0x' + '2'.repeat(40);
const now = 1800000000000;
const tx = '0x' + 'a'.repeat(64);
const trade = (id: string, from = quote, to = token, usd: unknown = '20') => ({ id, attributes: { tx_hash: tx, block_timestamp: new Date(now - 60000).toISOString(), from_token_address: from, to_token_address: to, kind: 'sell', volume_in_usd: usd, price_to_in_usd: '2', price_from_in_usd: '3' } });
test('trade direction follows the requested token, keeps distinct swaps within one tx, deduplicates IDs', () => {
  const buy = trade('buy');
  const data = parseTrades({data:[buy,buy,trade('sell',token,quote),trade('other',quote,quote),trade('self',token,token)]},token,now)!;
  assert.deepEqual(data.map(t=>t.side),['buy','sell']);
  assert.deepEqual(data.map(t=>t.priceUsd),[2,3]);
  assert.equal(data[0]!.tx,data[1]!.tx);
});
test('unreadable values are unknown and invalid/future/old trades excluded', () => {
  const future=trade('future');future.attributes.block_timestamp=new Date(now+120000).toISOString();
  const old=trade('old');old.attributes.block_timestamp=new Date(now-90000000).toISOString();
  const data=parseTrades({data:[trade('missing',quote,token,''),future,old]},token,now)!;
  assert.equal(data.length,1);assert.equal(data[0]!.usd,null);
  assert.equal(parseTrades({},token,now),null);
});
const candleBody = (rows: unknown[]) => ({data:{attributes:{ohlcv_list:rows}},meta:{base:{address:token}}});
test('candles reject wrong identity, incomplete bars and invalid ranges; sort and dedupe',()=>{
  const end=now/1000;
  const a=[end-900,1,2,1,2],b=[end-600,2,3,2,3];
  assert.equal(parsePriceBars(candleBody([a]),quote,now),null);
  const bars=parsePriceBars(candleBody([b,a,b,[end,1,2,1,2],[end-300,3,2,1,3]]),token,now)!;
  assert.equal(bars.length,2);assert.equal(bars[0]!.time,end-900);
});
test('summary measures contiguous returns and sampled flow, never uses missing amounts as zero',()=>{
  const bars=parsePriceBars(candleBody([[now/1000-900,1,2,1,2],[now/1000-600,2,3,2,3],[now/1000-300,3,4,3,4]]),token,now)!;
  const e={poolId:quote,token,candles:{failed:false,observedAt:now,data:bars},trades:{failed:false,observedAt:now,data:parseTrades({data:[trade('a'),trade('b',token,quote,'10')]},token,now)!}};
  const s=summarizeEvidence(e,now);assert.equal(s.measuredReturnPct,300);assert.ok(Math.abs(s.sampledBuySharePct5m! - 200/3) < 1e-10);assert.ok(s.fiveMinuteLogReturnStdDevPct!>0);
  e.trades.data[0]!.usd=null;assert.equal(summarizeEvidence(e,now).sampledBuySharePct5m,null);
  e.candles.data.splice(1,1);assert.equal(summarizeEvidence(e,now).measuredReturnPct,null);
  assert.equal(summarizeEvidence(e,now+121000).sampledTrades5m,null);
  assert.equal(summarizeEvidence(e,now+121000).latestFiveMinuteReturnPct,null);
});
test('detail reads authenticate only to fixed origin, coalesce callers and preserve partial failure',async()=>{
  const old=globalThis.fetch,key=process.env.MERRYMEN_COINGECKO_PRO_API_KEY,home=process.env.MERRYMEN_FLEET_HOME;
  process.env.MERRYMEN_COINGECKO_PRO_API_KEY='test-key';delete process.env.MERRYMEN_FLEET_HOME;
  const urls:string[]=[];
  globalThis.fetch=async(input,init)=>{const url=String(input);urls.push(url);assert.ok(url.startsWith('https://pro-api.coingecko.com/api/v3/onchain/'));assert.equal(init?.redirect,'error');assert.equal((init?.headers as Record<string,string>)['x-cg-pro-api-key'],'test-key');assert.ok(!url.includes('test-key'));return url.includes('/trades')?Response.json({data:[]}):new Response('',{status:429,headers:{'Retry-After':'60'}});};
  try{const [a,b]=await Promise.all([readPoolEvidence(quote,token),readPoolEvidence(quote,token)]);assert.equal(urls.length,2);assert.equal(a.candles.failure,'http-429');assert.equal(a.trades.failed,false);assert.deepEqual(a,b);await assert.rejects(readPoolEvidence('../evil',token));}
  finally{globalThis.fetch=old;if(key===undefined)delete process.env.MERRYMEN_COINGECKO_PRO_API_KEY;else process.env.MERRYMEN_COINGECKO_PRO_API_KEY=key;if(home!==undefined)process.env.MERRYMEN_FLEET_HOME=home;}
});
