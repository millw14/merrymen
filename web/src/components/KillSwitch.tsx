"use client";

import { useState } from "react";
import { clearGrant } from "@/lib/session";

/**
 * The kill switch — trust artifact #1. Two-step arm/confirm so a stray click
 * can't fire it, but confirmation is one press, not a modal maze.
 *
 * What "kill" does today (counterfactual accounts, testnet demo): destroys the
 * grant server-side and the session key client-side; the worker halts on its
 * next tick. The on-chain hard expiry remains the backstop. On-chain nonce
 * revocation ships with the funded-account flow.
 */
export function KillSwitch({ expectedTenant, ready = true }: { expectedTenant?: string | null; ready?: boolean }) {
  const [arming, setArming] = useState(false);
  const [state, setState] = useState<"idle" | "killing" | "done" | "kept">("idle");
  const [kept, setKept] = useState("");

  async function kill() {
    setState("killing");
    try {
      const res = await fetch("/api/grants", {
        method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ purpose: "delete-agent", expectedTenant: expectedTenant ?? undefined }),
      });
      // THE SERVER KEPT THE GRANT: it could not archive the owner key first,
      // so deleting it would have lost that key for good (grants route DELETE).
      // It paused trading instead. Say so, and leave everything here as it is —
      // "all agents killed" would be untrue, and the owner has to act.
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setKept(body?.error ?? "The service did not confirm deletion. Your recovery key was kept; try again.");
        setState("kept");
        return;
      }
    } catch {
      setKept("The service did not confirm deletion. Your recovery key was kept; try again.");
      setState("kept");
      return;
    }
    clearGrant();
    setState("done");
    setTimeout(() => window.location.reload(), 900);
  }

  if (state === "kept") {
    return (
      <>
        <button className="killall" onClick={() => void kill()}>
          ◉ try the kill again
        </button>
        <div className="killall-note" role="alert">
          {kept}
        </div>
      </>
    );
  }

  if (state === "done") {
    return (
      <>
        <button className="killall" disabled>
          ✓ agent permission deleted
        </button>
        {/* Says what actually happened to the money, because the previous
            wording implied the wallet was gone and the truth is the opposite. */}
        <div className="killall-note">
          service permission deleted · worker stops and memory cleanup follows · your recovery key is kept, so you
          can still withdraw. Copied permissions need separate on-chain revocation.
        </div>
      </>
    );
  }

  return (
    <>
      <button
        className={`killall${arming ? " armed" : ""}`}
        disabled={!ready || state === "killing"}
        onClick={() => {
          if (!arming) {
            setArming(true);
            setTimeout(() => setArming(false), 4000);
            return;
          }
          void kill();
        }}
      >
        {state === "killing" ? "killing…" : arming ? "◉ press again to confirm" : "◉ kill all agents"}
      </button>
      <div className="killall-note">
        {arming
          ? "deletes the permission and agent memory · worker halts on its next tick"
          : "deletes this agent's permission and memory · positions untouched"}
      </div>
    </>
  );
}
