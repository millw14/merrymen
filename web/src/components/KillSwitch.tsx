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
export function KillSwitch() {
  const [arming, setArming] = useState(false);
  const [state, setState] = useState<"idle" | "killing" | "done">("idle");

  async function kill() {
    setState("killing");
    try {
      await fetch("/api/grants", { method: "DELETE" });
    } catch {
      // server unreachable — still destroy the local key below
    }
    clearGrant();
    setState("done");
    setTimeout(() => window.location.reload(), 900);
  }

  if (state === "done") {
    return (
      <>
        <button className="killall" disabled>
          ✓ all agents killed
        </button>
        <div className="killall-note">grant destroyed · worker halts on its next tick</div>
      </>
    );
  }

  return (
    <>
      <button
        className={`killall${arming ? " armed" : ""}`}
        disabled={state === "killing"}
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
          ? "destroys the grant + session key · worker halts on its next tick"
          : "revokes every session key · positions untouched"}
      </div>
    </>
  );
}
