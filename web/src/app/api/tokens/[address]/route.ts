import { NextResponse } from "next/server";
import { readToken } from "@/lib/read-token";
import { readTokenMarket } from "@/lib/read-token-market";
import { readCandles } from "@/lib/read-candles";
export const dynamic = "force-dynamic";
export async function GET(req:Request,{params}:{params:Promise<{address:string}>}) {
  const {address}=await params;
  if(!/^0x[0-9a-fA-F]{40}$/.test(address)) return NextResponse.json({error:"Invalid token"},{status:400});
  const ledger=await readToken(address);
  const market=await readTokenMarket(address,ledger.symbol);
  const requested=new URL(req.url).searchParams.get("window");
  const window=requested==="15m" || requested==="4h" || requested==="1d" ? requested : "1h";
  const candles=market.coin ? await readCandles(market.coin.poolId,address,window) : null;
  return NextResponse.json({ledger,market,candles});
}
