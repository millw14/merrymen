"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

const RELEASE = "merrymen:trencher-fast:v2";
const TITLE = "Trencher mode is here";
const MESSAGE = "Trencher now screens high-volume memecoins and asks Brain to approve trades, with 15-second execution checks and independent automatic exits. Review and opt in from Settings. Trading limits still apply.";

/** A release notice, not a command to activate a user's trading strategy. */
export function TrencherAnnouncement() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    try {
      setVisible(localStorage.getItem(RELEASE + ":dismissed") !== "yes");
      if (typeof Notification !== "undefined" && Notification.permission === "granted" &&
          localStorage.getItem(RELEASE + ":notified") !== "yes") {
        const notification = new Notification(TITLE, { body: MESSAGE, tag: RELEASE, icon: "/favicon.ico" });
        localStorage.setItem(RELEASE + ":notified", "yes");
        notification.onclick = () => { window.focus(); window.location.assign("/settings#trencher-mode"); notification.close(); };
      }
    } catch {
      // Storage or desktop notifications may be unavailable; keep the in-app notice.
      setVisible(true);
    }
  }, []);
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
