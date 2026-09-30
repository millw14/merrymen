"use client";

/**
 * "THE APP UPDATED — YOUR TRADING PERMISSION DID NOT."
 *
 * ── WHY THIS HAS TO EXIST ────────────────────────────────────────────────
 *
 * A signature is a permanent artefact of whatever the signing client believed
 * when it was made. When a release changes the wall, every grant already out
 * there keeps the old one, nothing on chain complains, and the agent goes on
 * looking armed and healthy while being unable to make the trade the owner is
 * waiting for. `grant-installable.ts` records the worst case in full: three
 * re-signs were spent before anyone suspected the client rather than the chain.
 *
 * Every existing re-sign prompt in the product answers a question the WORKER
 * asked — an expired grant, a token the wall does not cover, a dead policy the
 * chain rejected. None of them can see this one, because a wall that is merely
 * OLD is not yet a wall that has failed. This is the only prompt that fires
 * before the first refusal instead of after it.
 *
 * ── WHAT IT WILL NOT DO ──────────────────────────────────────────────────
 *
 * IT DOES NOT SIGN. There is exactly one signing control in this product and
 * it is `<div id="resign">` on the grant screen. Wallet.tsx records what
 * happened when a banner called `renewKey()` itself with `disabled={renewing}`
 * as its only guard: an owner could tick "move to real money" further down the
 * page, scroll back up, press the banner's button, and re-sign onto another
 * chain under a banner promising "same wallet, same caps". This navigates.
 *
 * It navigates by full page load, which is also load-bearing: the wall is built
 * by THIS bundle, so a tab opened before the deploy would seal the old wall
 * again — the exact trap `POST /api/grants` refuses with "the page was open
 * from before an update: reload and sign again". A fresh document is how the
 * signer becomes current before it signs.
 *
 * ── AND WHO NEVER SEES IT ────────────────────────────────────────────────
 *
 * Somebody who has not created an agent has nothing to re-sign, and sending
 * them to /grant is actively harmful: with no grant the screen falls to its
 * first phase, which defaults to "Restore your funded wallet" and asks for an
 * owner key they have never had. The product already has a name for that —
 * advice that cannot be followed.
 *
 * The gate is the SERVER's answer, `exists === true`, and never the absence of
 * a local one. `mine` in the shell is falsy while the account is still loading,
 * so gating on it would hide this from real owners for the length of the first
 * fetch and then pop it in on top of whatever they had started reading.
 */

import { useEffect, useRef, useState } from "react";
/**
 * The constant and the fingerprint test that enforces it live together in
 * core, so this imports the date rather than keeping a second copy — a second
 * copy is a second thing to forget to bump.
 */
import { WALL_CHANGED_AT as WALL_RELEASE } from "@merrymen/core";
import { isPrivyOwned, loadGrant } from "@/lib/session";
import { usePrivyOwner } from "@/terminal/usePrivyOwner";
/**
 * THE DECISION LIVES NEXT DOOR, and is executed by a test rather than read.
 * The runner globs `*.test.ts`, so nothing inside this file is reachable from
 * it — and the conditions below decide whether a real owner is interrupted
 * about their money, which is not a rule to leave unexecutable.
 */
import { resignPromptApplies, resignPromptState } from "./resign-prompt-state";

/**
 * One key per tenant per wall release.
 *
 * PER TENANT, because a shared browser is a real case and the tour already
 * learned it: one person dismissing a notice must not silence it for the next
 * account signed in here. PER RELEASE, because the next wall change has to be
 * able to ask again — the same reason TOUR_VERSION namespaces its own record.
 */
const seenKey = (tenant: string | null, changedAt: number) =>
  `merrymen.resign.wall.v${changedAt}${tenant ? `:${tenant.toLowerCase()}` : ""}`;

export function ResignPrompt({
  exists,
  grantedAt,
  tenant,
  href,
}: {
  /**
   * Has the SERVER said this owner has an agent? `null` means not yet read.
   *
   * Three states, not two. "We have not asked yet" is not "there is no agent",
   * and collapsing them is what makes a prompt flash on for existing owners.
   */
  exists: boolean | null;
  /** From the public grant. `null` when unread — never defaulted to 0. */
  grantedAt: number | null;
  /** Hosted tenant address, for the per-account dismissal record. */
  tenant: string | null;
  /** Where the one signing control lives. Supplied by the shell, not built here. */
  href: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [acknowledged, setAcknowledged] = useState<boolean | null>(null);
  const privyOwner = usePrivyOwner();

  /**
   * CAN THIS BROWSER ACTUALLY SIGN? Same two owners as the grant screen.
   *
   * A legacy agent re-signs from the owner key in this browser's storage; a
   * Privy agent re-signs from the embedded wallet. Gating on the owner key
   * alone is a mistake this codebase has already made and fixed — it hid the
   * coverage banner from the entire Privy cohort, which is the cohort the
   * create flow mints by default.
   */
  const local = typeof window === "undefined" ? null : loadGrant();
  const canSign = Boolean(local?.demoOwnerPrivateKey) || (isPrivyOwned(local) && Boolean(privyOwner));

  const applies = resignPromptApplies({ exists, grantedAt, canSign });
  const shown = resignPromptState({ exists, grantedAt, canSign, acknowledged });

  useEffect(() => {
    if (!applies) return;
    try {
      setAcknowledged(localStorage.getItem(seenKey(tenant, WALL_RELEASE)) === "yes");
    } catch {
      // Private window, blocked site data. FAIL LOUD, not open: an unreadable
      // dismissal record is not a dismissal, and the cost of asking twice is a
      // dialog somebody closes — against an agent that silently cannot trade.
      setAcknowledged(false);
    }
  }, [applies, tenant]);

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (shown === "dialog" && !node.open) node.showModal();
    if (shown !== "dialog" && node.open) node.close();
  }, [shown]);

  if (shown === "hidden") return null;

  const dismiss = () => {
    try {
      localStorage.setItem(seenKey(tenant, WALL_RELEASE), "yes");
    } catch {
      // Dismissal still works for this session even when it cannot be stored.
    }
    setAcknowledged(true);
  };
  const go = () => {
    // A FULL LOAD, DELIBERATELY. See the note above: a stale bundle re-seals
    // the stale wall, and the grant API refuses exactly that.
    window.location.href = href;
  };

  return (
    <>
      <dialog ref={dialog} className="portfolio-dialog resign-dialog" aria-labelledby="resign-prompt-title"
        onCancel={(event) => { event.preventDefault(); dismiss(); }}>
        <div className="portfolio-dialog-header">
          <div>
            <h2 id="resign-prompt-title">Your trading permission is out of date</h2>
            <p>It was signed before the last update, so your agent may refuse trades it looks able to make.</p>
          </div>
          <button type="button" className="mm-btn" onClick={dismiss} aria-label="Close">✕</button>
        </div>
        <div className="portfolio-body">
          {/* WHAT IT COSTS AND WHAT IT CHANGES, because re-signing is not
              nothing: it re-seals the permission around today's settings and
              today's wall. The grant screen shows the diff before signing —
              this says enough to decide to go there, and no more. */}
          <p>Re-signing is free, takes one signature and moves nothing on-chain. Your wallet, your funds and your balance all stay exactly where they are.</p>
          <p className="mm-hint">The new permission is sealed around today’s settings, so anything you have changed since you last signed takes effect at the same time. You will see what changes before you sign.</p>
          <div className="resign-actions">
            <button type="button" className="mm-btn primary" onClick={go}>Re-sign my permission →</button>
            <button type="button" className="mm-btn" onClick={dismiss}>Not now</button>
          </div>
        </div>
      </dialog>

      {/* THE PART THAT DOES NOT GO AWAY.
          Proposals.tsx refuses a dismiss button outright, on the grounds that
          "a banner somebody closed is a fact nobody ever acts on" — and it is
          right, for a condition the owner has to act on before the agent works.
          The dialog can be closed, because a modal that reopens every visit is
          one people learn to click through. What is left behind is this: quiet,
          inline, and present for as long as the permission is actually old. */}
      {shown === "strip" && (
        <aside className="desk-notice resign-strip" aria-label="Trading permission out of date">
          <strong>Trading permission is out of date</strong>
          <p>Signed before the last update. Your agent may refuse trades it looks able to make.</p>
          <button type="button" className="mm-btn" onClick={go}>Re-sign — free, one signature →</button>
        </aside>
      )}
    </>
  );
}
