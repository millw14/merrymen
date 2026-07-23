"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { TelegramStatus } from "@/app/api/telegram/route";

/**
 * The obvious "chat on Telegram" call-to-action — surfaced on the dashboard so
 * people find it without digging into settings. Three states:
 *   - no token       → "Set up Telegram control" → /settings#telegram
 *   - not linked yet → deep-link to the bot + the one-time /link code
 *   - linked         → deep-link to chat with the merryman
 */
export function TelegramCta({ variant = "card" }: { variant?: "card" | "pill" }) {
  const [tg, setTg] = useState<TelegramStatus | null>(null);

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
    const id = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const botLink = tg?.botUsername ? `https://t.me/${tg.botUsername}` : null;
  const linked = (tg?.ownerId ?? null) !== null;

  // ── pill (topbar) ─────────────────────────────────────────────────────────
  if (variant === "pill") {
    if (botLink) {
      return (
        <a href={botLink} target="_blank" rel="noreferrer" className="tg-pill" title={linked ? "Chat on Telegram" : "Open your bot and send the link code"}>
          💬 Telegram
        </a>
      );
    }
    return (
      <Link href="/settings#telegram" className="tg-pill">
        💬 Telegram
      </Link>
    );
  }

  // ── card (rail) ───────────────────────────────────────────────────────────
  if (!tg || !tg.hasToken) {
    return (
      <div className="panel tg-card">
        <div className="tg-card-title">💬 Chat with your merryman</div>
        <p className="tg-card-sub">
          Link a Telegram bot and run the band from your phone — check status, trade, get daily
          reports, even control your PC. Two minutes to set up.
        </p>
        <Link href="/settings#telegram" className="tg-cta-btn">
          📱 Set up Telegram →
        </Link>
      </div>
    );
  }

  if (!tg.connected) {
    return (
      <div className="panel tg-card">
        <div className="tg-card-title">💬 Telegram</div>
        <p className="tg-card-sub">Your bot token looks off — Telegram didn&apos;t answer. Re-check it in settings.</p>
        <Link href="/settings#telegram" className="tg-cta-btn">
          fix in settings →
        </Link>
      </div>
    );
  }

  // Not linked and no code yet: the token is valid (connected), but the worker
  // hasn't minted a code — either Telegram isn't switched on, or merrymen isn't
  // running. Say WHY, instead of a bare "…" that reads like a hidden code.
  const noCode = !linked && !tg.linkCode;

  return (
    <div className="panel tg-card">
      <div className="tg-card-title">💬 {linked ? "Chat with your merryman" : "Link your Telegram"}</div>
      {linked ? (
        <p className="tg-card-sub">
          Connected as <b>@{tg.botUsername}</b>. Message it anytime — try <code>/status</code> or just talk.
        </p>
      ) : tg.linkCode ? (
        <p className="tg-card-sub">
          Open <b>@{tg.botUsername}</b> and send{" "}
          <code>/link {tg.linkCode}</code> to claim it as its owner.
        </p>
      ) : tg.enabled ? (
        <p className="tg-card-sub">
          Generating your one-time link code — make sure merrymen is <b>running</b>, then refresh in a
          moment and it&apos;ll appear here.
        </p>
      ) : (
        <p className="tg-card-sub">
          Almost there — <b>turn Telegram on</b> in settings and save, and your one-time{" "}
          <code>/link</code> code shows up right here.
        </p>
      )}
      {noCode ? (
        <Link href="/settings#telegram" className="tg-cta-btn">
          {tg.enabled ? "Check settings →" : "Turn on Telegram →"}
        </Link>
      ) : (
        <a href={botLink!} target="_blank" rel="noreferrer" className="tg-cta-btn">
          {linked ? `Open @${tg.botUsername} →` : "Open the bot →"}
        </a>
      )}
    </div>
  );
}
