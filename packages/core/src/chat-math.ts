/** Bounded decimal arithmetic for conversational answers. No evaluation or floating-point money math. */
export type ChatMathOperation = "add" | "subtract" | "multiply" | "divide" | "percent_of" | "percent_change" | "pnl";
export interface ChatMathInput { operation: ChatMathOperation; a: string | number; b: string | number; fees?: string | number }
export type ChatMathResult = {ok:true;result:string;text:string} | {ok:false;error:string};
const SCALE = 100_000_000n;
function decimal(v:string|number):bigint|null {
  if (typeof v === "number" && !Number.isFinite(v)) return null;
  const s = String(v).trim();
  if (!/^[+-]?\d{1,16}(?:\.\d{1,8})?$/.test(s)) return null;
  const neg = s.startsWith("-");
  const [whole,frac=""] = s.replace(/^[+-]/, "").split(".");
  const n = BigInt(whole!) * SCALE + BigInt(frac.padEnd(8,"0"));
  return neg ? -n : n;
}
function roundRatio(n:bigint,d:bigint):bigint {
  const neg = (n<0n)!==(d<0n), a=n<0n?-n:n, b=d<0n?-d:d;
  const out = a / b + (a % b * 2n >= b ? 1n : 0n);
  return neg ? -out : out;
}
function render(n:bigint):string {
  const a=n<0n?-n:n, whole=a/SCALE, frac=String(a%SCALE).padStart(8,"0").replace(/0+$/, "");
  return `${n<0n?"-":""}${whole}${frac?`.${frac}`:""}`;
}
export function calculateChatMath(input:ChatMathInput):ChatMathResult {
  const a=decimal(input.a), b=decimal(input.b), fee=input.fees===undefined?0n:decimal(input.fees);
  if(a===null||b===null||fee===null) return {ok:false,error:"Use finite decimal numbers with at most 16 whole digits and 8 decimal places."};
  let n:bigint; let text:string;
  const av=render(a),bv=render(b);
  switch(input.operation) {
    case "add": n=a+b;text=`${av} + ${bv} = `;break;
    case "subtract": n=a-b;text=`${av} - ${bv} = `;break;
    case "multiply": n=roundRatio(a*b,SCALE);text=`${av} × ${bv} = `;break;
    case "divide": if(b===0n)return {ok:false,error:"Division by zero is undefined."};n=roundRatio(a*SCALE,b);text=`${av} ÷ ${bv} = `;break;
    case "percent_of": n=roundRatio(a*b,SCALE*100n);text=`${av}% of ${bv} = `;break;
    case "percent_change":
      if(a<=0n)return {ok:false,error:"Percentage change needs a positive starting amount."};
      n=roundRatio((b-a)*100n*SCALE,a);text=`Change from ${av} to ${bv} = `;break;
    case "pnl": {
      if(a<=0n||b<0n||fee<0n)return {ok:false,error:"P&L needs positive cost, nonnegative proceeds, and nonnegative fees."};
      n=b-a-fee;
      const pct=render(roundRatio(n*100n*SCALE,a));
      return {ok:true,result:render(n),text:`Proceeds ${bv} − cost ${av}${fee!==0n?` − fees ${render(fee)}`:""} = ${render(n)} P&L (${pct}% of cost). Based only on the supplied figures; not a verified trade result. Percentages rounded to at most 8 decimal places.`};
    }
    default:return {ok:false,error:"That arithmetic operation is not supported."};
  }
  const result=render(n);
  return {ok:true,result,text:`${text}${result}${input.operation==="percent_change"?"%":""}. Rounded to at most 8 decimal places.`};
}

/** Only explicit two-number expressions are parsed. Other questions require a fact lookup. */
export function parseChatMath(text:string):ChatMathInput|null {
  if(text.length>500)return null;
  const n="([+-]?\\d{1,16}(?:\\.\\d{1,8})?)";
  const normalized=text.trim().replace(/^(?:what(?:'s| is)|calculate|work out)\s+/i,"").replace(/[?=]\s*$/,"").trim();
  const change=new RegExp(`^(?:percent(?:age)? change|return) from \\$?${n} to \\$?${n}$`,"i").exec(normalized);
  if(change)return {operation:"percent_change",a:change[1]!,b:change[2]!};
  const pnl=new RegExp(`^(?:p&l|pnl|profit|return)\\s*[:,]?\\s*cost\\s+\\$?${n}\\s*[,;]?\\s*proceeds\\s+\\$?${n}(?:\\s*[,;]?\\s*fees?\\s+\\$?${n})?$`,"i").exec(normalized);
  if(pnl)return {operation:"pnl",a:pnl[1]!,b:pnl[2]!,...(pnl[3]!==undefined?{fees:pnl[3]}:{})};
  const roundtrip=new RegExp(`^(?:if\\s+)?(?:i\\s+)?(?:bought|buy)\\s+(?:it\\s+)?for\\s+\\$?${n}\\s*(?:,|and)?\\s*(?:i\\s+)?(?:sold|sell)\\s+(?:it\\s+)?for\\s+\\$?${n}(?:\\s*[,;]?\\s*(?:with\\s+)?fees?\\s+\\$?${n})?(?:\\s*[,;]?\\s*(?:what(?:'s| is)\\s+)?(?:my\\s+)?(?:p&l|pnl|profit|return))?$`,"i").exec(normalized);
  if(roundtrip)return {operation:"pnl",a:roundtrip[1]!,b:roundtrip[2]!,...(roundtrip[3]!==undefined?{fees:roundtrip[3]}:{})};
  const percent=new RegExp(`^${n}\\s*%\\s*(?:of|×|\\*)\\s*\\$?${n}$`,"i").exec(normalized);
  if(percent)return {operation:"percent_of",a:percent[1]!,b:percent[2]!};
  const expr=new RegExp(`^\\$?${n}\\s*(plus|minus|times|divided by|[+\\-*/×÷])\\s*\\$?${n}$`,"i").exec(normalized);
  if(!expr)return null;
  const op=expr[2]!.toLowerCase();
  return {operation:op==="+"||op==="plus"?"add":op==="-"||op==="minus"?"subtract":op==="*"||op==="×"||op==="times"?"multiply":"divide",a:expr[1]!,b:expr[3]!};
}

/** First real instant of the local day, including a skipped or repeated midnight. */
function calendarDayStart(now:number,timeZone:string):{since:number;clock:string} {
  const fmt=new Intl.DateTimeFormat("en-CA",{timeZone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"});
  const parts=(sec:number)=>Object.fromEntries(fmt.formatToParts(new Date(sec*1000)).filter(p=>p.type!=="literal").map(p=>[p.type,Number(p.value)]));
  const dayOf=(p:Record<string,number>)=>Date.UTC(p.year!,p.month!-1,p.day!)/1000;
  const dateAt=(sec:number)=>dayOf(parts(sec));
  const day=dayOf(parts(now));
  // IANA offsets fit inside this fixed four-day bracket. Search seconds rather
  // than guessing an offset at a midnight that the clock may have skipped.
  const earliest=day-2*86400;
  let low=earliest,high=Math.floor(now);
  if(dateAt(low)>=day||dateAt(high)!==day)throw new RangeError("calendar day unavailable");
  while(high-low>1) {
    const middle=Math.floor((low+high)/2);
    if(dateAt(middle)<day)low=middle;else high=middle;
  }
  let since=high;
  // Older IANA rules sometimes briefly reached midnight before moving back
  // into yesterday (Goose Bay, for example). A date-only binary search can
  // find the second midnight; check both surrounding offsets for the first.
  for(let sample=earliest;sample<=day+2*86400;sample+=6*3600) {
    const p=parts(sample);
    const offset=Date.UTC(p.year!,p.month!-1,p.day!,p.hour!,p.minute!,p.second!)/1000-sample;
    const candidate=day-offset;
    if(candidate<earliest||candidate>Math.floor(now)||candidate>=since)continue;
    if(dateAt(candidate)===day&&dateAt(candidate-1)<day)since=candidate;
  }
  if(dateAt(since)!==day||dateAt(since-1)>=day)throw new RangeError("calendar day unavailable");
  const first=parts(since);
  return {since,clock:`${String(first.hour).padStart(2,"0")}:${String(first.minute).padStart(2,"0")}`};
}

/** UTC by default; a user's explicitly supplied IANA timezone defines their calendar day. */
export function chatPeriodStart(period:string,now:number,timeZone="UTC"):{since:number;label:string;until?:number} {
  if(period==="yesterday") {
    const today=calendarDayStart(now,timeZone),prior=calendarDayStart(today.since-1,timeZone);
    return {since:prior.since,until:today.since-1,label:`yesterday (${prior.clock} to ${today.clock} ${timeZone})`};
  }
  if(period==="24h")return {since:now-86400,label:"in the last 24 hours"};
  if(period==="7d")return {since:now-7*86400,label:"in the last 7 days"};
  if(period==="all")return {since:0,label:"since the current run's records start"};
  const start=calendarDayStart(now,timeZone);
  return {since:start.since,label:`today (since ${start.clock} ${timeZone})`};
}
