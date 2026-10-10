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
 * ONE EXCEPTION, TELEGRAM'S SETUP. The owner later asked for "a single button
 * on home that takes care of telegram completely", so the Telegram row carries
 * the next step's button (see TelegramLine). It sets up, connects, turns on
 * and links the bot; it is not a second copy of any setting, and everything
 * else about Telegram is still changed in Settings.
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

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useT } from "@/lib/i18n";
import { shortDateTime } from "@/lib/format";
import { heldNotice, telegramRow, trencherRow, type AgentDown, type TelegramRow, type TrencherRow } from "./agent-status";
import type { TelegramStatus } from "@/app/api/telegram/route";
import type { FleetRecoveryView } from "../../../worker/src/fleet-recovery";
import { RecoveryNotice } from "./RecoveryNotice";
import { TelegramCreateBot } from "./TelegramCreateBot";
import { pausedRecovery, recoveryTelegram, type RecoveryFunds } from "./recovery-view";

interface SettingsShape {
  /** Hosted: the signed-in tenant the values were read for. Null self-hosted. */
  owner?: string | null;
  values?: { strategy?: string | null; trencherLiveEnabled?: boolean | null; assetMode?: string | null };
}

/** How often Home re-reads Telegram while a step is waiting on the agent or on Telegram. */
const TG_POLL_MS = 4000;
/** And for how long, so a tab left open does not poll forever. */
const TG_POLL_FOR_MS = 15 * 60_000;

export function AgentStrip({ hasAgent, recovery, funds, agentDown = null }: {
  hasAgent: boolean;
  recovery?: FleetRecoveryView | null;
  funds?: RecoveryFunds | null;
  /** Why nothing will mint a link code now, from /api/grants (App.tsx, agent-status.ts agentDownOf). */
  agentDown?: AgentDown | null;
}) {
  const t = useT();
  const [tg, setTg] = useState<TelegramStatus | null>(null);
  const [settings, setSettings] = useState<SettingsShape["values"] | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  /**
   * Has /api/settings answered, so `owner` is a reading and not a default?
   * Null before then means "not read"; after, it means self-hosted. The one
   * write here, Turn on Telegram, waits for it: sent without an owner, the
   * route would apply it to whichever wallet the session holds by then.
   */
  const [ownerRead, setOwnerRead] = useState(false);
  /** True while Home's one Telegram button is mid-setup (TelegramCreateBot's onActiveChange). */
  const [creating, setCreating] = useState(false);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  /**
   * RE-READ TELEGRAM. Resolves true only when a status landed, so the one
   * button's "bot connected" step can tell a refresh that worked from one
   * that didn't. A failure leaves the last reading in place.
   */
  const refreshTg = useCallback(async (): Promise<boolean> => {
    try {
      const r = await fetch("/api/telegram");
      if (!r.ok) return false;
      const s = (await r.json()) as TelegramStatus;
      if (live.current && s) setTg(s);
      return !!s;
    } catch { return false; }
  }, []);

  useEffect(() => {
    if (!hasAgent) return;
    // BEST EFFORT, BOTH OF THEM. A rejected promise or a non-ok response
    // leaves the state null, which reads as "unread" and prints "checking…".
    // Nothing here may throw into the home screen's render.
    void refreshTg();
    void fetch("/api/settings")
      .then((r) => (r.ok ? (r.json() as Promise<SettingsShape>) : null))
      .then((s) => {
        if (!live.current || !s) return;
        if (s.values) setSettings(s.values);
        setOwner(typeof s.owner === "string" && /^0x[0-9a-f]{40}$/i.test(s.owner) ? s.owner : null);
        setOwnerRead(true);
      })
      .catch(() => {});
  }, [hasAgent, refreshTg]);

  const row = telegramRow(tg);
  const recovering = pausedRecovery(recovery);

  /**
   * THE ONE BUTTON'S LATER STEPS WAIT ON SOMEBODY ELSE: the agent picking the
   * bot up and minting its link code, then the owner pressing Start in
   * Telegram. Re-read while either is pending, and when the owner comes back
   * to this tab from Telegram, so the button moves on without a reload.
   *
   * NOT WHILE THE AGENT IS DOWN WITH NO CODE: nothing will mint one, so there
   * is nothing to wait for. App re-reads /api/grants on its own clock, and
   * when the agent runs `agentDown` clears and this starts again. A recovery
   * hold is such a time whatever `agentDown` says: the held tenant runs no
   * worker, and the recovery listener links no new chat. Each re-read here is
   * a live getMe with the owner's token, for a code that would never come.
   */
  const waiting = hasAgent && row.kind === "unlinked" && !((agentDown !== null || recovering !== null) && row.linkCode === null);
  useEffect(() => {
    if (!waiting) return;
    const until = Date.now() + TG_POLL_FOR_MS;
    const timer = setInterval(() => { if (Date.now() > until) clearInterval(timer); else void refreshTg(); }, TG_POLL_MS);
    const back = () => { if (document.visibilityState === "visible") void refreshTg(); };
    document.addEventListener("visibilitychange", back);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", back); };
  }, [waiting, refreshTg]);

  if (!hasAgent) return null;

  const held = heldNotice(tg, row);
  const bot = recoveryTelegram(tg);
  // A bot saved while held that nobody has linked: it has no code, and none
  // comes until the agent resumes (see `waiting`). Said, not left at "Replies
  // are not confirmed", which reads as a fault to look into.
  const savedUnlinked = (row.kind === "unlinked" || (row.kind === "held" && !row.linked)) && row.linkCode === null
    ? (row.botUsername ? `@${row.botUsername}` : "Your bot") : null;
  return (
    <section className="agent-strip" aria-label={t("strip.aria")}>
      {recovering ? <>
        <RecoveryNotice recovery={recovering} funds={funds}/>
        {/* SETTING UP A BOT IS NOT TRADING, so a held account gets the same
            one button for the two steps that only save it: create one, or
            turn a saved one on. Every other state keeps the recovery wording,
            which says honestly what a held agent does with its bot. */}
        {owner && (row.kind === "no-token" || creating)
          ? <TelegramLine row={row} owner={owner} ownerRead={ownerRead} creating={creating} onCreating={setCreating} refresh={refreshTg} />
          : <Row tone="warn" label="Telegram" value={bot.label}
              action={row.kind === "off" && ownerRead ? <TurnOnTelegram owner={owner} refresh={refreshTg} />
                : savedUnlinked !== null ? <span className="mm-hint">{t("strip.tg.recoveryWhy", { bot: savedUnlinked })}</span>
                : bot.detail ? <span className="mm-hint">{bot.detail}</span> : undefined}/>}
        <Row tone="quiet" label="Trencher" value="Trading paused"/>
      </> : <>
        {held !== null ? <HeldLine reason={held} /> : null}
        <TelegramLine row={row} owner={owner} ownerRead={ownerRead} creating={creating} onCreating={setCreating} refresh={refreshTg} agentDown={agentDown} />
        <TrencherLine row={trencherRow(settings)} />
      </>}
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

/**
 * ONE BUTTON THAT TAKES CARE OF TELEGRAM. The owner's words: "I need a single
 * button on home that takes care of telegram completely."
 *
 * So the step the owner is on is a single primary control on this row, and it
 * moves on by itself: Set up Telegram (creates the bot in Telegram, no token
 * to copy) → Connect @bot → Open my bot (carries the link code, so pressing
 * Start in Telegram links the chat) → connected. A bot that is saved but
 * switched off gets Turn on Telegram. Where one press can't fix it (another
 * agent holds the bot, the token was refused), the row still says why and
 * links to Settings, which stays the one place to change everything else.
 *
 * The create step is TelegramCreateBot itself, drawn compact: the same
 * server flow and checks as Settings, not a second implementation. It stays
 * mounted while a setup is in flight even after the token lands, so it can
 * finish and forget its stored setup before the row moves on.
 */
function TelegramLine({ row, owner, ownerRead, creating, onCreating, refresh, agentDown = null }: {
  row: TelegramRow;
  owner: string | null;
  /** See AgentStrip's ownerRead: Turn on Telegram waits for it. */
  ownerRead: boolean;
  creating: boolean;
  onCreating: (active: boolean) => void;
  refresh: () => Promise<boolean>;
  /** See AgentStrip's agentDown: only the unlinked row with no code reads it. */
  agentDown?: AgentDown | null;
}) {
  const t = useT();
  if (owner && (row.kind === "no-token" || creating)) {
    const reread = async () => { if (!(await refresh())) throw new Error("Telegram status unavailable"); };
    return (
      <Row tone="quiet" label="Telegram" value={row.kind === "no-token" ? t("strip.tg.notSetUp") : t("strip.tg.startingUp")}
        action={<TelegramCreateBot compact owner={owner} hasBot={row.kind !== "no-token" && row.kind !== "unread"}
          onActiveChange={onCreating} onConnected={reread} onIntentMissing={reread} />}
      />
    );
  }
  switch (row.kind) {
    case "unread":
      return <Row tone="quiet" label="Telegram" value={t("strip.checking")} />;
    case "no-token":
      // Self-hosted (no signed-in owner to create for): the manual path.
      return (
        <Row tone="quiet" label="Telegram" value={t("strip.tg.notSetUp")}
          action={<Link className="mm-btn primary" href="/settings#telegram">Connect Telegram</Link>}
        />
      );
    case "off":
      return (
        <Row tone="warn" label="Telegram" value={t("strip.tg.off")}
          action={ownerRead ? <TurnOnTelegram owner={owner} refresh={refresh} /> : undefined}
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
       *
       * UNLESS NOTHING WILL MAKE THAT PASS. An agent the fleet holds, one
       * never started, or one whose key expired has no worker and no hold
       * process, so "check back shortly" was a promise of a pass that never
       * comes, and "Starting your bot…" a step that never finishes. It says
       * what the bot waits for instead, and where renewal is the remedy,
       * links to it.
       */
      if (!row.linkCode && agentDown !== null) {
        const bot = row.botUsername ? `@${row.botUsername}` : "Your bot";
        const why = agentDown === "expired" ? "strip.tg.expiredWhy" : agentDown === "stopped" ? "strip.tg.notRunningWhy" : agentDown === "recovery" ? "strip.tg.recoveryWhy" : "strip.tg.notStartedWhy";
        return (
          <Row tone="warn" label="Telegram" value={t("strip.tg.savedNotRunning")}
            action={
              <>
                <span className="mm-hint">{t(why, { bot })}</span>
                {agentDown === "expired" ? <Link href="/grant#resign">{t("strip.tg.renew")}</Link> : null}
              </>
            }
          />
        );
      }
      return (
        <Row tone="warn" label="Telegram" value={row.linkCode ? t("strip.tg.ready") : t("strip.tg.startingUp")}
          action={
            row.linkCode ? (
              <LinkCode code={row.linkCode} botUsername={row.botUsername} primary />
            ) : (
              <>
                <button type="button" className="mm-btn primary" disabled>Starting your bot…</button>
                <span className="mm-hint">{row.linkPending ? t("strip.tg.pickingUp") : t("strip.tg.noCodeYet")}</span>
              </>
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

/**
 * The code, the way to send it, and the warning that goes with it. Shared by
 * every row that shows one. `primary`: the row's one button (unlinked), so
 * the deep link is drawn as it; pressing Start in Telegram sends the code.
 */
function LinkCode({ code, botUsername, primary = false }: { code: string; botUsername: string | null; primary?: boolean }) {
  const t = useT();
  return (
    <>
      {botUsername ? (
        // Carries the code into the chat instead of asking somebody
        // to retype it, the way the mobile client already does.
        <a className={primary ? "mm-btn primary" : undefined} href={`https://t.me/${botUsername}?start=${code}`} target="_blank" rel="noreferrer">
          {primary ? "Open my bot" : t("strip.tg.open")}
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

/**
 * A SAVED BOT THAT IS SWITCHED OFF, turned on from here: the one setting this
 * press changes, for the owner Settings was read for (the route refuses a
 * different signed-in wallet), then the row re-reads what the server says.
 */
function TurnOnTelegram({ owner, refresh }: { owner: string | null; refresh: () => Promise<boolean> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function turnOn() {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const r = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(owner ? { telegramEnabled: true, owner } : { telegramEnabled: true }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => null)) as { errors?: unknown } | null;
        const first = Array.isArray(body?.errors) && typeof body.errors[0] === "string" ? body.errors[0] : null;
        throw new Error(first ?? "Couldn't turn Telegram on. Try again.");
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "Couldn't turn Telegram on. Try again.");
    } finally { setBusy(false); }
  }
  return (
    <>
      <button type="button" className="mm-btn primary" disabled={busy} onClick={() => void turnOn()}>{busy ? "Turning on…" : "Turn on Telegram"}</button>
      {error ? <span className="mm-danger" role="alert">{error}</span> : null}
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
