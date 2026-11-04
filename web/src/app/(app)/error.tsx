"use client";
export default function PageError({reset}:{reset:()=>void}) {
  return <div className="terminal-host terminal-standalone"><main><h1>Couldn’t load this page.</h1><p>Try again, or head back home.</p><button onClick={reset}>Try again</button><p><a href="/">Back to Home</a></p></main></div>;
}
