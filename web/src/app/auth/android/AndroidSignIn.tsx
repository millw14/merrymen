"use client";

import { useState } from "react";
import { PrivySignIn } from "@/terminal/PrivySignIn";

/** The existing token + embedded-owner proof, without loading the market dashboard or tour. */
export function AndroidSignIn() {
  const [done, setDone] = useState(false);
  return <main style={{ maxWidth: 480, margin: "0 auto", padding: "32px 24px" }}>
    <img src="/mcp-icon-512.png" alt="" width={64} height={64} />
    <h1>Sign in to Merrymen</h1>
    <p>Use the same email or X account to return to your agents.</p>
    {done ? <p role="status">Signed in. Returning to Merrymen…</p> : <PrivySignIn directX onDone={() => setDone(true)} />}
  </main>;
}
