"use client";

export default function GlobalError({reset}:{reset:()=>void}) {
  // This replaces the root layout, so it must not rely on its stylesheet loading.
  return <html lang="en"><body style={{margin:0,background:"#080905",color:"#e9e9e1",fontFamily:"system-ui, sans-serif"}}><main style={{minHeight:"100svh",boxSizing:"border-box",display:"grid",placeItems:"center",padding:24}}><section style={{width:"100%",maxWidth:440}}><a href="/" style={{color:"inherit",fontSize:23,fontWeight:600,textDecoration:"none"}}>merrymen</a><h1 style={{fontSize:36,lineHeight:1.15,letterSpacing:"-.04em",margin:"28px 0 16px"}}>Something went wrong.</h1><p style={{fontSize:15,lineHeight:1.7,color:"#92958a"}}>The app couldn’t open this page. Try loading it again.</p><button onClick={reset} style={{marginTop:12,border:0,borderRadius:12,padding:"14px 20px",background:"#e9e9e1",color:"#080905",font:"inherit",fontWeight:600,cursor:"pointer"}}>Try again</button><a href="/" style={{marginLeft:20,color:"inherit",fontSize:14}}>Back to markets</a></section></main></body></html>;
}
