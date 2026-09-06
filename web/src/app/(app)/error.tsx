"use client";
export default function PageError({reset}:{reset:()=>void}) {
  return <div className="terminal-host terminal-standalone"><main><h1>Couldn’t load this page.</h1><p>Try again, or head back to the markets.</p><button onClick={reset}>Try again</button><p><a href="/">Back to markets</a></p></main></div>;
}
