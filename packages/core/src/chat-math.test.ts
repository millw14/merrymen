import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateChatMath, chatPeriodStart, parseChatMath } from "./chat-math";

test("trade arithmetic is exact decimal arithmetic and bounded",()=> {
  assert.equal(calculateChatMath({operation:"add",a:"0.1",b:"0.2"}).ok && (calculateChatMath({operation:"add",a:"0.1",b:"0.2"}) as {result:string}).result,"0.3");
  const pnl=calculateChatMath({operation:"pnl",a:"5",b:"6.25",fees:"0.25"});
  assert.equal(pnl.ok,true);if(pnl.ok){assert.equal(pnl.result,"1");assert.match(pnl.text,/20%/);assert.match(pnl.text,/not a verified trade/);}
  const loss=calculateChatMath({operation:"percent_change",a:"200",b:"50"});
  assert.equal(loss.ok,true);if(loss.ok)assert.equal(loss.result,"-75");
  assert.equal(calculateChatMath({operation:"divide",a:"1",b:"0"}).ok,false);
  assert.equal(calculateChatMath({operation:"add",a:Infinity,b:"1"}).ok,false);
  assert.equal(calculateChatMath({operation:"add",a:"1e9",b:"1"}).ok,false);
  assert.equal(calculateChatMath({operation:"add",a:"9".repeat(10000),b:"1"}).ok,false);
  assert.equal(calculateChatMath({operation:"pnl",a:"0",b:"10"}).ok,false);
  assert.equal(calculateChatMath({operation:"pnl",a:"5",b:"6",fees:"-1"}).ok,false);
});
test("only literal arithmetic is parsed, never instructions or arbitrary code",()=> {
  assert.deepEqual(parseChatMath("what's 0.1 + 0.2?"),{operation:"add",a:"0.1",b:"0.2"});
  assert.deepEqual(parseChatMath("25% of $12"),{operation:"percent_of",a:"25",b:"12"});
  assert.deepEqual(parseChatMath("percent change from $5 to $6"),{operation:"percent_change",a:"5",b:"6"});
  assert.deepEqual(parseChatMath("P&L cost 5 proceeds 6.25 fees 0.25"),{operation:"pnl",a:"5",b:"6.25",fees:"0.25"});
  assert.deepEqual(parseChatMath("I bought for $5 and sold for $6, what is my profit?"),{operation:"pnl",a:"5",b:"6"});
  assert.equal(parseChatMath("1+2; process.exit()"),null);
  assert.equal(parseChatMath("how much money do I have + 2"),null);
});
test("today is a declared calendar day and handles timezone DST boundaries",()=> {
  const now=Date.parse("2026-10-02T00:30:00Z")/1000;
  assert.deepEqual(chatPeriodStart("today",now),{since:Date.parse("2026-10-02T00:00:00Z")/1000,label:"today (since 00:00 UTC)"});
  assert.equal(chatPeriodStart("today",now,"Africa/Lagos").since,Date.parse("2026-10-01T23:00:00Z")/1000);
  assert.equal(chatPeriodStart("today",Date.parse("2026-03-08T15:00:00Z")/1000,"America/New_York").since,Date.parse("2026-03-08T05:00:00Z")/1000);
  assert.equal(chatPeriodStart("today",Date.parse("2026-11-01T15:00:00Z")/1000,"America/New_York").since,Date.parse("2026-11-01T04:00:00Z")/1000);
  assert.throws(()=>chatPeriodStart("today",now,"made/up"));
});

test("a DST jump at midnight never puts yesterday's trades into today",()=> {
  for(const [zone,now,expected] of [
    ["America/Havana","2026-03-08T15:00:00Z","2026-03-08T05:00:00Z"],
    ["America/Santiago","2026-09-06T15:00:00Z","2026-09-06T04:00:00Z"],
  ]) {
    const result=chatPeriodStart("today",Date.parse(now!)/1000,zone!);
    assert.equal(result.since,Date.parse(expected!)/1000,zone);
    assert.equal(result.label,`today (since 01:00 ${zone})`);
    const date=new Intl.DateTimeFormat("en-CA",{timeZone:zone,year:"numeric",month:"2-digit",day:"2-digit"});
    assert.equal(date.format(new Date(result.since*1000)),date.format(new Date(now!)));
    assert.notEqual(date.format(new Date((result.since-1)*1000)),date.format(new Date(now!)));
  }
});

test("yesterday uses actual adjacent boundaries across short and long DST days",()=> {
  const stamp=(s:string)=>Date.parse(s)/1000;
  const short=chatPeriodStart("yesterday",stamp("2026-03-09T15:00:00Z"),"America/Havana");
  assert.deepEqual(short,{since:stamp("2026-03-08T05:00:00Z"),until:stamp("2026-03-09T04:00:00Z")-1,label:"yesterday (01:00 to 00:00 America/Havana)"});
  assert.equal(short.until!-short.since+1,23*3600);
  const beforeGap=chatPeriodStart("yesterday",stamp("2026-03-08T15:00:00Z"),"America/Havana");
  assert.deepEqual(beforeGap,{since:stamp("2026-03-07T05:00:00Z"),until:stamp("2026-03-08T05:00:00Z")-1,label:"yesterday (00:00 to 01:00 America/Havana)"});
  const long=chatPeriodStart("yesterday",stamp("2026-11-02T15:00:00Z"),"America/New_York");
  assert.equal(long.since,stamp("2026-11-01T04:00:00Z"));
  assert.equal(long.until,stamp("2026-11-02T05:00:00Z")-1);
  assert.equal(long.until!-long.since+1,25*3600);
  assert.throws(()=>chatPeriodStart("yesterday",stamp("2026-10-02T00:30:00Z"),"made/up"));
});

test("repeated midnight uses its first occurrence, including historical brief date reversals",()=> {
  const stamp=(s:string)=>Date.parse(s)/1000;
  assert.equal(chatPeriodStart("today",stamp("2026-11-01T15:00:00Z"),"America/Havana").since,stamp("2026-11-01T04:00:00Z"));
  assert.equal(chatPeriodStart("today",stamp("2009-11-01T05:00:00Z"),"America/Goose_Bay").since,stamp("2009-11-01T03:00:00Z"));
});
