"use client";

import { useEffect, useState } from "react";
import { clearGrant } from "@/lib/session";
import { sendKill } from "@/lib/kill-answer";
import { readKillPerps, type KillPerps } from "@/lib/perps-exposure";
import { custodyText, killWarning } from "@/lib/perps-view";

/**
 * The kill switch — trust artifact #1. Two-step arm/confirm so a stray click
 * can't fire it, but confirmation is one press, not a modal maze.
 *
 * What "kill" does today (counterfactual accounts, testnet demo): destroys the
 * grant server-side and the session key client-side; the worker halts on its
 * next tick. The on-chain hard expiry remains the backstop. On-chain nonce
 * revocation ships with the funded-account flow.
 *
 * PERPETUALS, SAID AS THIS SERVER ACTUALLY TREATS THEM (rule 13). Self-hosted,
 * the kill stands them down: each position closed at market with a reduce-only
 * order — which can realize a loss — and free collateral withdrawn home. The
 * hosted kill does NOT yet (no sealed perp_standdown row, no stand-down-only
 * child): it removes the key and leaves positions open with only their resting
 * stops. Which one is the server's to say (`perpsStanddownOnKill`), and it is
 * said BEFORE the confirm, because an owner confirming a kill must know what it
 * does to leveraged money. What is said AFTER is where the money is, built by
 * core's custodySentence from the stand-down's own result when the server has
 * one (self-hosted), else from the agent's last report — never a constant, and
 * never "your funds stay in your smart account" while anything is, or may be,
 * on Lighter.
 */
export function KillSwitch() {
  const [arming, setArming] = useState(false);
  const [state, setState] = useState<"idle" | "killing" | "done">("idle");
  /** undefined: not read yet. */
  const [perps, setPerps] = useState<KillPerps | undefined>(undefined);
  const [custody, setCustody] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void readKillPerps().then((p) => {
      if (live) setPerps(p);
    });
    return () => {
      live = false;
    };
  }, []);

  const exposure = perps?.exposure ?? null;
  const standsDown = perps?.standsDown ?? null;
  const warning = exposure ? killWarning(exposure, standsDown) : null;

  async function kill() {
    setState("killing");
    setRefused(null);
    setNotice(null);
    // READ AGAIN AT THE CLICK: the sentence the owner is left with must be
    // about the account as it was when they pressed, not when the page loaded.
    const fresh = await readKillPerps();
    const before = fresh.exposure ?? exposure;
    const hosted = (fresh.standsDown ?? standsDown) === false;
    setPerps({ exposure: before, standsDown: fresh.standsDown ?? standsDown });
    const answer = await sendKill();
    if (answer.kind === "refused") {
      // THE SERVER SAID NOTHING WAS STOPPED (self-hosted: the stand-down
      // request could not be written, so the grant was kept on purpose).
      // Clearing this browser's copy now would show a killed agent that is
      // still trading, so nothing here changes and the owner is told why.
      setRefused(answer.error);
      setArming(false);
      setState("idle");
      return;
    }
    if (answer.kind === "unreachable") {
      // Server unreachable — still stand the agent down locally. The local
      // grant is ARCHIVED rather than destroyed (see clearGrant): killing is
      // about stopping the agent trading, not about forfeiting the balance.
      // Said, because the server may still hold the grant.
      setNotice("couldn't reach the server · this browser's key is cleared, but the server may still hold the grant — try again");
    } else if (answer.kind === "unconfirmed") {
      setNotice(`the server did not confirm the kill${answer.error ? ` (${answer.error})` : ""} · try again`);
    }
    clearGrant();
    const told =
      answer.kind === "done" && answer.custody ? answer.custody : before ? custodyText(before, { hosted }) : null;
    setCustody(told);
    setState("done");
    // A spot-only agent reloads as it always did. With anything on Lighter —
    // or a kill the server did not confirm — the sentence above IS the result,
    // so it stays until the owner has read it.
    if ((!before || before.kind === "none") && answer.kind === "done") setTimeout(() => window.location.reload(), 900);
  }

  if (state === "done") {
    return (
      <>
        <button className="killall" disabled>
          ✓ all agents killed
        </button>
        {/* Says what actually happened to the money, because the previous
            wording implied the wallet was gone and the truth is the opposite. */}
        <div className="killall-note">
          grant revoked · worker halts on its next tick · your recovery key is kept, so you
          can still withdraw
        </div>
        {notice && (
          <div className="killall-note" role="alert">
            {notice}
          </div>
        )}
        {custody && (
          <div className="killall-note" role="status">
            {custody}
          </div>
        )}
        {((exposure && exposure.kind !== "none") || notice) && (
          <button className="killall" onClick={() => window.location.reload()}>
            done
          </button>
        )}
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
          : warning
            ? standsDown === true
              ? "revokes every session key · stands perpetuals on Lighter down"
              : "revokes every session key · does NOT close perpetuals on Lighter"
            : "revokes every session key · nothing is sold"}
      </div>
      {/* BEFORE THE CONFIRM, what a kill does to leveraged money: said while
          arming, so the second press is made knowing it. */}
      {arming && warning && <div className="killall-note">{warning}</div>}
      {state === "killing" && warning && standsDown === true && (
        <div className="killall-note" role="status">
          asking your agent to close its perpetuals first — this can take a few seconds
        </div>
      )}
      {refused && (
        <div className="killall-note" role="alert">
          {refused}
        </div>
      )}
    </>
  );
}
