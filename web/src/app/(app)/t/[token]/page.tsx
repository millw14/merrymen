import { readTokenMarket } from "@/lib/read-token-market";
export async function generateMetadata({params}:{params:Promise<{token:string}>}) {
  const {token}=await params;
  if(!/^0x[0-9a-fA-F]{40}$/.test(token)) return {title:"Token unavailable — merrymen"};
  const market=await readTokenMarket(token);
  return {title:`${market.symbol ?? market.coin?.name ?? "Token"} — merrymen`};
}
export default function TokenRoute() {return null;}
export const dynamic = "force-dynamic";
