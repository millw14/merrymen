"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { TelegramStatus } from "@/app/api/telegram/route";

/**
 * Global first-link onboarding popup. Appears on any dashboard/settings page as
 * soon as the user has a valid Telegram token AND the bot is reachable, but has
 * not linked an owner chat yet. It guides them to the one-time /link code and
 * auto-closes the moment the worker confirms a link (ownerId appears).
 *
 * Deliberately NOT persisted: dismissal lasts only for the lifetime of the open
 * page. A fresh visit re-shows the popup until the bot is actually linked, so
 * the "I can't see the code" gap can't be dismissed away forever.
 */
export function TelegramLinkModal() {
  const [tg, setTg] = useState<TelegramStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch("/api/telegram");
        if (alive && r.ok) setTg((await r.json()) as TelegramStatus);
      } catch {
        /* keep last */
      }
    };
    load();
    const id = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const open = !!tg && tg.hasToken && tg.connected && tg.ownerId === null && !dismissed;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDismissed(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open || !tg) return null;

  const botLink = tg.botUsername ? `https://t.me/${tg.botUsername}` : null;
  const code = tg.linkCode;
  const preparing = !!tg.enabled && !code;
  const needsTurnOn = !tg.enabled && !code;

  const copyCode = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = code;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div
      className="tg-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) setDismissed(true);
      }}
    >
      <div className="tg-modal" role="dialog" aria-modal="true" aria-label="Link your Telegram bot">
        <button type="button" className="tg-modal-close" aria-label="Dismiss" onClick={() => setDismissed(true)}>
          ×
        </button>
        <div className="tg-card-title">💬 Link your Telegram</div>

        {code ? (
          <>
            <p className="tg-card-sub">
              Open <b>{tg.botUsername ? `@${tg.botUsername}` : "your bot"}</b> and send{" "}
              <code>/link {code}</code> — the first message that claims it makes you its owner.
            </p>
            <div className="tg-code-row">
              <code className="tg-code">{code}</code>
              <button type="button" className="tg-copy-btn" onClick={copyCode}>
                {copied ? "Copied ✓" : "Copy"}
              </button>
            </div>
            {botLink && (
              <a href={botLink} target="_blank" rel="noreferrer" className="tg-cta-btn">
                Open @{tg.botUsername} →
              </a>
            )}
            <p className="tg-card-sub tg-modal-note">
              One-time code — it auto-rotates once used, and re-shows here if the bot is ever unlinked.
            </p>
          </>
        ) : preparing ? (
          <>
            <p className="tg-card-sub">
              Preparing your one-time link code — make sure merrymen is <b>running</b>, and this popup
              will fill it in automatically.
            </p>
            <Link href="/settings#telegram" className="tg-cta-btn">
              Check settings →
            </Link>
          </>
        ) : (
          <>
            <p className="tg-card-sub">
              Almost there — <b>turn Telegram on</b> in settings and save, and your one-time{" "}
              <code>/link</code> code shows up right here.
            </p>
            <Link href="/settings#telegram" className="tg-cta-btn">
              Turn on Telegram →
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
