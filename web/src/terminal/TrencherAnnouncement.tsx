"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
/**
 * WHO THIS IS FOR — executed by a test rather than read, because the runner
 * globs `*.test.ts` and nothing in this file is reachable from it.
 */
import { releaseNotice } from "./release-notice";

const RELEASE = "merrymen:trencher-fast:v2";
const TITLE = "Trencher mode is here";
const MESSAGE = "Trencher now screens high-volume memecoins and asks Brain to approve trades, with 15-second execution checks and independent automatic exits. Review and opt in from Settings. Trading limits still apply.";

/** A release notice, not a command to activate a user's trading strategy. */
export function TrencherAnnouncement({ hasAgent }: {
  /**
   * Does this reader have an agent to put into this mode?
   *
   * REQUIRED, not optional with a default. An optional flag would let a new
   * mount quietly inherit the old behaviour, which is the behaviour being
   * fixed: this was rendered inside the desk's own `if (!mine)` empty state,
   * announcing a trading mode to somebody with nothing to apply it to.
   */
  hasAgent: boolean;
}) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    try {
      // ── READ FIRST, THEN DECIDE, THEN WRITE ────────────────────────────
      //
      // The gate has to sit in front of the NOTIFICATION, not just the
      // render. That branch writes a `:notified` flag, and a one-shot spent
      // on somebody with no agent is the notification the real owner never
      // gets: they create an agent tomorrow, the flag already reads
      // "notified", and the release passes in silence with nothing to show
      // for it. Returning early from the render alone would have left that.
      const act = releaseNotice({
        hasAgent,
        dismissed: localStorage.getItem(RELEASE + ":dismissed") === "yes",
        alreadyNotified: localStorage.getItem(RELEASE + ":notified") === "yes",
        canNotify: typeof Notification !== "undefined" && Notification.permission === "granted",
      });
      setVisible(act.show);
      if (act.notify) {
        const notification = new Notification(TITLE, { body: MESSAGE, tag: RELEASE, icon: "/icon-192.png" });
        localStorage.setItem(RELEASE + ":notified", "yes");
        notification.onclick = () => { window.focus(); window.location.assign("/settings#trencher-mode"); notification.close(); };
      }
    } catch {
      // Storage or desktop notifications may be unavailable; keep the in-app
      // notice — but still never for somebody with no agent. Failing open on
      // the storage read must not fail open on who this is addressed to.
      setVisible(hasAgent);
    }
  }, [hasAgent]);
  if (!visible) return null;
  return <aside className="desk-notice" aria-label="What's new">
    <strong>{TITLE}</strong>
    <p>{MESSAGE}</p>
    <p>Fast exits: −10% stop, +20% take profit, or 30-minute holding limit. These are triggers, not guaranteed fill prices.</p>
    <Link href="/settings#trencher-mode">Explore Trencher mode →</Link>{" "}
    <button type="button" className="mm-btn" onClick={() => {
      try { localStorage.setItem(RELEASE + ":dismissed", "yes"); } catch { /* session dismissal still works */ }
      setVisible(false);
    }}>Dismiss</button>
  </aside>;
}
