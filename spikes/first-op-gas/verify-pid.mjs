// READ-ONLY verifier: eth_call + eth_getCode only. No SDK, no overrides, no bundler.
const RPC="https://rpc.mainnet.chain.robinhood.com"; let id=1;
async function rpc(m,p){for(let a=0;a<6;a++){try{
  const r=await fetch(RPC,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:id++,method:m,params:p})});
  if(r.status===429){await new Promise(s=>setTimeout(s,800*(a+1)));continue;}
  const j=await r.json(); if(j.error) return {ERR:j.error.message}; return j.result;
}catch(e){await new Promise(s=>setTimeout(s,700*(a+1)));}} return "UNREAD";}
const SEL="0xc3e58978"; // permissionConfig(bytes4)
const M="0x032Da6A0Ccf866474e45854E7fDEF9afd1509036"; // merrymen's live account
const A="0xa48cE91e2F3237E69660C1543042c007B8D33e75"; // has an installed permission validator
const cases=[
  [A,"0x3ca1cec8","POSITIVE CONTROL — pId provably installed on THIS account"],
  [A,"0xdeadbeef","NEGATIVE CONTROL — bogus pId, same account"],
  [M,"0x3ca1cec8","merrymen live acct, a pId installed on a DIFFERENT account"],
];
for(let i=0;i<5;i++){
  const r="0x"+[...crypto.getRandomValues(new Uint8Array(4))].map(x=>x.toString(16).padStart(2,"0")).join("");
  cases.push([M,r,"FRESH pId (what a RENEWAL mints) #"+(i+1)]);
}
for(const [acct,pid,label] of cases){
  const code=await rpc("eth_getCode",[acct,"latest"]);
  const res=await rpc("eth_call",[{to:acct,data:SEL+pid.slice(2).padEnd(64,"0")},"latest"]);
  if(res==="UNREAD"||res?.ERR||!res){console.log(`UNREAD ${acct} ${pid} -> ${JSON.stringify(res)}`);continue;}
  const w=i=>res.slice(2+i*64,2+(i+1)*64);
  const signer="0x"+w(2).slice(24), flag="0x"+w(1).slice(60);
  const installed=BigInt("0x"+w(2))!==0n;
  console.log(`${acct.slice(0,12)}… code ${(code.length-2)/2}B  pId ${pid}  flag ${flag}  signer ${signer}  INSTALLED=${installed?"YES":"NO "}   ${label}`);
}
