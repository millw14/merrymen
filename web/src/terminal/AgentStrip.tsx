"use client";

/**
 * TWO THINGS ABOUT YOUR AGENT, ON THE SCREEN YOU ACTUALLY OPEN.
 *
 * The owner's words: "make sure telegram connection is more visible in the
 * home screen not ugly but not hidden, with all trencher mode settings as
 * well."
 *
 * ── WHY A STRIP AND NOT A PANEL OF CONTROLS ──────────────────────────────
 *
 * The obvious reading is "put the settings on Home". That would be the wrong
 * shape twice over. A toggle in two places is two places to disagree — this
 * product already carries the "one signing control" rule for exactly that
 * reason — and money behaviour with two front doors is how an owner turns
 * something on in one and finds it off in the other.
 *
 * So this is a READING with a way through to the real control. It answers the
 * question the buried settings were failing to answer ("is this actually on,
 * and if not, what do I do?") and leaves the changing where it already is.
 *
 * ── WHY IT FETCHES ITS OWN DATA ──────────────────────────────────────────
 *
 * `SetupChecklist` — the existing quiet status strip — does the same, and it
 * keeps `Home` a pure presentational component fed by the shell. Threading two
 * more request shapes through `App` to reach one card would spread knowledge
 * of Telegram across three files to save a request the screen makes once.
 *
 * NEITHER FETCH IS ALLOWED TO BREAK THE SCREEN. A failure leaves the row
 * unread, which renders as "checking…" and never as "not connected" — the
 * distinction the settings screen currently gets wrong, and the reason
 * `agent-status.ts` exists.
 *
 * ── AND WHY NEW VISITORS NEVER SEE IT ────────────────────────────────────
 *
 * `hasAgent` comes from the server's `exists`. Somebody who has not created an
 * agent has no bot to connect and no strategy to run, and a status card about
 * an agent that does not exist is noise on the one screen that should be
 * telling them to make one — which Home already does, in its own empty state.
 *
 * ── THE WORDS ────────────────────────────────────────────────────────────
 *
 * Keyed under the `strip.*` namespace and translated in every shipped locale.
 * Two things stay literal on purpose: `Telegram` and `Trencher` are product
 * names, and the link command is a LITERAL somebody retypes into a chat —
 * translating either would be translating an identifier.
 *
 * That command is also why the unlinked row reads the way it does. It needs a
 * `<code>` element (monospace, non-breaking, select-all), and there are only
 * bad ways to put markup inside a sentence a translator owns: tags in the
 * message make them responsible for HTML, and splitting the sentence around
 * the code forces English word order on every language. So the code is its own
 * element under a lead-in line, and every message here stays plain text.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useT } from "@/lib/i18n";
import { shortDateTime } from "@/lib/format";
import { heldNotice, telegramRow, trencherRow, type TelegramRow, type TrencherRow } from "./agent-status";
import type { TelegramStatus } from "@/app/api/telegram/route";

interface SettingsShape {
  values?: { strategy?: string | null; trencherLiveEnabled?: boolean | null; assetMode?: string | null };
}

export function AgentStrip({ hasAgent }: { hasAgent: boolean }) {
  const t = useT();
  const [tg, setTg] = useState<TelegramStatus | null>(null);
  const [settings, setSettings] = useState<SettingsShape["values"] | null>(null);

  useEffect(() => {
    if (!hasAgent) return;
    let live = true;
    // BEST EFFORT, BOTH OF THEM. A rejected promise or a non-ok response
    // leaves the state null, which reads as "unread" and prints "checking…".
    // Nothing here may throw into the home screen's render.
    void fetch("/api/telegram")
      .then((r) => (r.ok ? (r.json() as Promise<TelegramStatus>) : null))
      .then((s) => { if (live && s) setTg(s); })
      .catch(() => {});
    void fetch("/api/settings")
      .then((r) => (r.ok ? (r.json() as Promise<SettingsShape>) : null))
      .then((s) => { if (live && s?.values) setSettings(s.values); })
      .catch(() => {});
    return () => { live = false; };
  }, [hasAgent]);

  if (!hasAgent) return null;

  const row = telegramRow(tg);
  const held = heldNotice(tg, row);
  return (
    <section className="agent-strip" aria-label={t("strip.aria")}>
      {held !== null ? <HeldLine reason={held} /> : null}
      <TelegramLine row={row} />
      <TrencherLine row={trencherRow(settings)} />
    </section>
  );
}

/**
 * TRADING IS HELD, said whatever the Telegram row says. The row can say it
 * only over a working bot; an owner with none, or with one switched off, is
 * told nowhere else (agent-status.ts heldNotice). First, because it is the
 * thing on this strip that matters most while it lasts.
 */
function HeldLine({ reason }: { reason: string }) {
  const t = useT();
  return (
    <Row tone="warn" label={t("strip.held.label")} value={t("strip.held.value")}
      action={<span className="mm-hint">{t("strip.held.why", { reason })}</span>}
    />
  );
}

function TelegramLine({ row }: { row: TelegramRow }) {
  const t = useT();
  switch (row.kind) {
    case "unread":
      return <Row tone="quiet" label="Telegram" value={t("strip.checking")} />;
    case "no-token":
      return (
        <Row tone="quiet" label="Telegram" value={t("strip.tg.notSetUp")}
          action={<Link href="/settings#telegram">{t("strip.tg.connect")}</Link>}
        />
      );
    case "off":
      return (
        <Row tone="warn" label="Telegram" value={t("strip.tg.off")}
          action={<Link href="/settings#telegram">{t("strip.tg.turnOn")}</Link>}
        />
      );
    case "unverified":
      return (
        <Row tone="warn" label="Telegram" value={t("strip.tg.unverified")}
          action={<Link href="/settings#telegram">{t("strip.tg.checkIt")}</Link>}
        />
      );
    case "elsewhere":
      /**
       * ANOTHER AGENT HAS THIS BOT. No code: the one this agent last had is
       * for a bot that now answers to another agent's code, and five sends of
       * it lock the owner's chat out there. Saving the token again in
       * Settings offers the move.
       */
      return (
        <Row tone="warn" label="Telegram" value={t("strip.tg.elsewhere")}
          action={
            <>
              <span className="mm-hint">{t("strip.tg.elsewhereWhy")}</span>
              <Link href="/settings#telegram">{t("strip.tg.moveHere")}</Link>
            </>
          }
        />
      );
    case "unlinked":
      /**
       * THE ONE CARD THAT CARRIES THE CODE.
       *
       * In Settings the instruction and the code are in two different closed
       * drawers, and two beta testers stopped right there. Putting them in one
       * place is the single change that unsticks them.
       *
       * A null code is a WAIT, not an absence: the agent mints one on its next
       * pass after a token is saved, so saying "no code" would be a claim we
       * cannot make about a code that is simply not minted yet. Or, when a
       * new bot was saved, the agent has not picked it up yet: the code on
       * file was the old bot's and would not link this one, so none is shown.
       */
      return (
        <Row tone="warn" label="Telegram" value={row.linkCode ? t("strip.tg.ready") : t("strip.tg.startingUp")}
          action={
            row.linkCode ? (
              <LinkCode code={row.linkCode} botUsername={row.botUsername} />
            ) : (
              <span className="mm-hint">{row.linkPending ? t("strip.tg.pickingUp") : t("strip.tg.noCodeYet")}</span>
            )
          }
        />
      );
    case "held":
      /**
       * TRADING IS HELD, which is not what "connected" means. In the incident
       * behind this row the practice book would not restore, no worker ran,
       * and this card said "✓ connected" for days. The class is the phrase
       * the owner is told in chat too, never the restore's figures. A code
       * stays: the hold process links chats.
       */
      return (
        <Row tone="warn" label="Telegram" value={t("strip.tg.held")}
          action={
            <>
              <span className="mm-hint">{t("strip.tg.heldWhy", { reason: row.reason ?? "restore error" })}</span>
              {!row.linked && row.linkCode ? <LinkCode code={row.linkCode} botUsername={row.botUsername} /> : null}
            </>
          }
        />
      );
    case "not-listening": {
      /**
       * NOTHING IS HEARING THE BOT, measured by the process meant to poll it.
       * Each of the three has its own remedy: wait (or tell us), stop the
       * other program, paste a new token. The code stays on an unlinked bot,
       * with the warning: it works once the bot is heard again, and taking
       * it away would only send the owner looking for another.
       */
      const value =
        row.why === "revoked" ? t("strip.tg.revoked") : row.why === "conflict" ? t("strip.tg.conflict") : t("strip.tg.notListening");
      const why =
        row.why === "revoked"
          ? t("strip.tg.revokedWhy")
          : row.why === "conflict"
            ? t("strip.tg.conflictWhy")
            : row.lastOkAt !== null
              ? t("strip.tg.notListeningSince", { when: shortDateTime(row.lastOkAt * 1000) })
              : t("strip.tg.notListeningNever");
      return (
        <Row tone="warn" label="Telegram" value={value}
          action={
            <>
              <span className="mm-hint">{why}</span>
              {row.why === "revoked" ? <Link href="/settings#telegram">{t("strip.tg.newToken")}</Link> : null}
              {!row.linked && row.linkCode ? (
                <>
                  <LinkCode code={row.linkCode} botUsername={row.botUsername} />
                  <span className="mm-hint">{t("strip.tg.codeWhenBack")}</span>
                </>
              ) : null}
            </>
          }
        />
      );
    }
    case "linked":
      return (
        <Row tone="ok" label="Telegram"
          value={row.botUsername ? t("strip.tg.connectedAs", { bot: row.botUsername }) : t("strip.tg.connected")}
          action={<Link href="/settings#telegram">{t("strip.tg.manage")}</Link>}
        />
      );
  }
}

/** The code, the way to send it, and the warning that goes with it. Shared by every row that shows one. */
function LinkCode({ code, botUsername }: { code: string; botUsername: string | null }) {
  const t = useT();
  return (
    <>
      {botUsername ? (
        // Carries the code into the chat instead of asking somebody
        // to retype it, the way the mobile client already does.
        <a href={`https://t.me/${botUsername}?start=${code}`} target="_blank" rel="noreferrer">
          {t("strip.tg.open")}
        </a>
      ) : null}
      <span className="mm-hint">{t("strip.tg.sendThis")}</span>
      {/* A LITERAL, NOT A SENTENCE. The command is retyped verbatim
          into a chat, so it stays out of the translated copy and out
          of reach of a translator's autocorrect. */}
      <code>/link {code}</code>
      <span className="mm-hint">{t("strip.tg.codeWarning")}</span>
    </>
  );
}

function TrencherLine({ row }: { row: TrencherRow }) {
  const t = useT();
  switch (row.kind) {
    case "unread":
      return <Row tone="quiet" label="Trencher" value={t("strip.checking")} />;
    case "off":
      return (
        <Row tone="quiet" label="Trencher" value={t("strip.trencher.off")}
          action={<Link href="/settings#trencher-mode">{t("strip.trencher.whatIsThis")}</Link>}
        />
      );
    case "no-crypto":
      /**
       * The refusal nothing else in the product shows. See agent-status.ts:
       * the worker logs it at event level "ok" and the desk only renders
       * warn/err, so an owner can cause this from a dropdown and never find
       * out why nothing is happening.
       */
      return (
        <Row tone="warn" label="Trencher" value={t("strip.trencher.noCrypto")}
          action={<Link href="/settings#trencher-mode">{t("strip.trencher.changeIt")}</Link>}
        />
      );
    case "paper":
      return (
        <Row tone="quiet" label="Trencher" value={t("strip.trencher.paper")}
          action={<Link href="/settings#trencher-mode">{t("strip.trencher.settings")}</Link>}
        />
      );
    case "live":
      return (
        <Row tone="ok" label="Trencher" value={t("strip.trencher.live")}
          action={<Link href="/settings#trencher-mode">{t("strip.trencher.settings")}</Link>}
        />
      );
  }
}

function Row({
  label,
  value,
  action,
  tone,
}: {
  /** A product name — `Telegram`, `Trencher`, never translated — or the translated `strip.held.label`. */
  label: string;
  value: string;
  action?: React.ReactNode;
  /** `warn` is amber, never red — red is reserved for a fault, and none of
      these are one. An owner once concluded the product was broken because a
      non-fault state wore the red box. */
  tone: "ok" | "warn" | "quiet";
}) {
  return (
    <div className={`agent-strip-row is-${tone}`}>
      <span className="agent-strip-label">{label}</span>
      <span className="agent-strip-value">{value}</span>
      {action ? <span className="agent-strip-action">{action}</span> : null}
    </div>
  );
}
