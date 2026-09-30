"use client";

/**
 * POSTING ON X — the Settings section where an owner connects an X account and
 * decides whether their Merryman may post from it (docs/x-posting.md).
 *
 * ── THE ONE RULE THIS SCREEN EXISTS TO KEEP ──────────────────────────────
 *
 * The Merryman posts from WHICHEVER X ACCOUNT IS CONNECTED — the one that was
 * signed in on X when the owner approved, which may not be the one they think.
 * So turning posting on goes through a warning that says exactly that and
 * NAMES the account (@handle, as X itself reported it), and the confirm sends
 * that account's immutable X user id. If a different account is connected by
 * the time the confirm lands, the server changes nothing and says so, and the
 * owner is shown the new account before anything can post from it.
 *
 * ── WHAT IT WILL NOT DO ──────────────────────────────────────────────────
 *
 * IT SENDS NOTHING WHEN THE SWITCH IS PRESSED ON. Pressing it opens the
 * warning; only the warning's primary button writes. Pressing it OFF writes at
 * once — stopping must never need a second step.
 *
 * THE SWITCH NEVER SHOWS A STATE THE SERVER HAS NOT CONFIRMED. No optimistic
 * flip: it moves when an answer says it moved (the BookSwitch pattern in
 * screens/Profile.tsx), because a switch that reads "on" for a write that
 * failed is an owner who believes their Merryman is posting, or has stopped.
 *
 * AN UNREAD STATUS IS NOT "NOT CONNECTED". A failed or refused read says it
 * could not check, with a retry — never "Connect X account", which would tell
 * an owner whose Merryman is posting right now that nothing is connected. The
 * same mistake once told Telegram owners they had never saved their token
 * (see "AN UNREAD BRIDGE IS NOT A MISSING TOKEN" in screens/Settings.tsx).
 *
 * "UNAVAILABLE" ONLY STOPS WHAT NEEDS THIS SERVER'S X APP. `available` is
 * the web's own configuration; the orchestrator posts on its own, so an
 * owner connected on a web that lost (say) its public origin may still have a
 * Merryman posting. Unavailable hides Connect and Reconnect and refuses
 * turning posting ON; the off switch, Coming up with its Skip, Posted and
 * Disconnect stay, because every one of them works without the X app.
 *
 * IT NEVER SEES A TOKEN. GET /api/x/account has no field that could hold one
 * (lib/x-connect.ts accountBody). Handles render only through xHandleTag, and
 * a "View on X" link only when it is exactly an x.com status URL.
 *
 * ── "COMING UP" IS A PROMISE, SO IT IS KEPT CURRENT ──────────────────────
 *
 * The warning tells the owner every post waits under Coming up for at least
 * ten minutes (the planner's MIN_LEAD_MS) and can be skipped there. That is
 * only true of a list that shows what the server has: nothing tells an owner
 * a draft was written, and the orchestrator drafts on its own, at most once a
 * minute. So while the section is open and posting is on, it re-reads quietly
 * every POLL_MS (a hidden tab skips its turn and re-reads when it is shown
 * again), and once more AFTER_ENABLE_MS after the owner turns posting on —
 * by then the next plan pass has drafted the hello, which is due ten minutes
 * after the consent. A list read once and left open would show "Nothing
 * waiting" while the hello was queued, and a Skip on a post that already went.
 *
 * Hosted only: renders nothing anywhere else. Literal English, like the rest
 * of the Settings screen, which is not in the translated set.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { shortDateTime } from "@/lib/format";
import type { XAccountBody, XRecentPost, XUpcomingPost } from "@/lib/x-connect";
import { xHandleTag } from "@/lib/x-handle";
import { Switch } from "./ui";

// ── the words, shared with iOS (docs/x-posting.md "What an owner should know") ──

const COPY = {
  blurb:
    "Let your Merryman post on X in its own words — a hello when it starts, the odd casual thought, and now and then a coin it bought and why. No trade alerts, no error messages, no numbers.",
  connect: "Connect X account",
  reconnect: "Reconnect X account",
  caption:
    "You'll approve it on X. Your Merryman will post from whichever X account you approve there, so check which account you're signed into on X first.",
  toggle: "Let my Merryman post on X",
  revoked: "X stopped accepting this connection. Reconnect to keep posting.",
  /** lib/x-connect.ts X_COPY.unavailable, word for word (the routes and iOS say it too). */
  unavailable: "Posting on X isn't available right now.",
  cannotTurnOn: "Turning posting on isn't available right now.",
  comingUp: "Coming up",
  nothingWaiting: "Nothing waiting to go out.",
  posted: "Posted",
  viewOnX: "View on X",
  skip: "Skip",
  notNow: "Not now",
  unread: "Couldn't check your X connection just now.",
  signedOut: "Sign in to connect an X account.",
} as const;

const connectedAs = (handle: string) => `Connected as ${handle}`;
const postingFrom = (handle: string) => `Posting from ${handle} — whichever X account is connected.`;
const disconnectAsk = (handle: string) =>
  `Disconnect ${handle}? Your Merryman stops posting and anything waiting to go out is cancelled.`;

/** THE WARNING. Every sentence is pinned by x-posting.test.ts; change them there too. */
const warningTitle = (handle: string) => `Post on X as ${handle}?`;
const warningLead = (handle: string) =>
  `Your Merryman will post from whichever X account is connected — right now that's ${handle}.`;
const WARNING_BODY = [
  "It writes its own posts: a hello first, then the odd casual thought and now and then a coin it bought and why. It never posts trade alerts, error messages, prices or amounts.",
  "Posts go out on their own, a few a day at most. Each one waits under Coming up for at least ten minutes first, and you can skip it there. Turn this off or disconnect X at any time.",
  "X may label accounts that post automatically, and may ask an account to verify itself the first time it posts about crypto.",
] as const;
const warningYes = (handle: string) => `Let it post as ${handle}`;

const KIND_LABEL: Record<XUpcomingPost["kind"], string> = { intro: "Hello post", casual: "Casual post", buy: "Buy post" };

/**
 * What a Skip button is called to assistive tech: which post it skips, by its
 * own words. Its kind and time are not enough — two drafts can share both —
 * and "Skip, button" said once per draft leaves a screen-reader user choosing
 * blind.
 */
function skipLabel(p: XUpcomingPost): string {
  const words = p.body.replace(/\s+/g, " ").trim();
  const excerpt = words.length <= 60 ? words : `${words.slice(0, 60).replace(/\s+\S*$/, "")}…`;
  return `Skip ${(KIND_LABEL[p.kind] ?? "Post").toLowerCase()}: ${excerpt}`;
}

/** Where X's authorize page lives. A start that answers anything else is not followed. */
const AUTHORIZE = "https://x.com/i/oauth2/authorize?";
/** The only link "View on X" may be. */
const STATUS_URL = /^https:\/\/x\.com\/[A-Za-z0-9_]{1,15}\/status\/\d{1,25}$/;

/**
 * How often an open section re-reads while posting is on. Well inside the
 * ten minutes every post waits, so a draft shows within a minute of being
 * written, and a post that went out stops offering a Skip.
 */
const POLL_MS = 45_000;
/** The one extra re-read after posting is turned on: past the orchestrator's next plan pass (once a minute), so the hello is on screen. */
const AFTER_ENABLE_MS = 70_000;

// ── talking to the routes ───────────────────────────────────────────────────

type Read =
  | { kind: "checking" }
  | { kind: "failed" }
  | { kind: "signed-out" }
  | { kind: "ready"; account: XAccountBody };

type Sent = { ok: true; data: Record<string, unknown> } | { ok: false; status: number; message: string };

const UNREACHABLE = "Couldn't reach merrymen just now. Try again in a moment.";
const REFRESH_FAILED = "Couldn't refresh this just now.";

/** A 200 is only an answer if it is the shape the route promises; anything else is unread. */
function accountOf(data: unknown): XAccountBody | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Partial<XAccountBody>;
  if (typeof d.available !== "boolean" || typeof d.connected !== "boolean" || typeof d.postingEnabled !== "boolean") return null;
  if (!Array.isArray(d.upcoming) || !Array.isArray(d.recent)) return null;
  return {
    available: d.available,
    connected: d.connected,
    username: typeof d.username === "string" ? d.username : null,
    xUserId: typeof d.xUserId === "string" ? d.xUserId : null,
    status: d.status === "ok" || d.status === "revoked" ? d.status : null,
    postingEnabled: d.postingEnabled,
    upcoming: d.upcoming.filter(
      (p): p is XUpcomingPost => !!p && typeof p.id === "number" && typeof p.body === "string" && typeof p.dueAt === "number",
    ),
    recent: d.recent.filter(
      (p): p is XRecentPost =>
        !!p && typeof p.id === "number" && typeof p.body === "string" && typeof p.sentAt === "number" && typeof p.url === "string",
    ),
  };
}

async function readAccount(): Promise<Read> {
  try {
    const res = await fetch("/api/x/account", { cache: "no-store", credentials: "same-origin", signal: AbortSignal.timeout(20_000) });
    if (res.status === 401) return { kind: "signed-out" };
    if (!res.ok) return { kind: "failed" };
    const account = accountOf(await res.json().catch(() => null));
    return account ? { kind: "ready", account } : { kind: "failed" };
  } catch {
    return { kind: "failed" };
  }
}

/**
 * The zone this browser says it is in, sent with the consent so the Merryman
 * keeps quiet hours even for an owner the room never met. The route checks it
 * and drops a placeless one (UTC, Reykjavik) a privacy browser reports for
 * everybody; null when the browser will not say.
 */
function deviceZone(): string | null {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof tz === "string" && tz !== "" ? tz : null;
  } catch {
    return null;
  }
}

async function send(method: "POST" | "DELETE", url: string, body: Record<string, unknown>): Promise<Sent> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      credentials: "same-origin",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return { ok: false, status: 0, message: UNREACHABLE };
  }
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (res.ok && data) return { ok: true, data };
  // The routes' sentences are written for owners: every 4xx, and a 5xx they marked.
  const said = typeof data?.error === "string" && data.error && (res.status < 500 || data.ownerFacing === true) ? data.error : null;
  return { ok: false, status: res.status, message: said ?? `merrymen answered with an error (${res.status}). Try again in a moment.` };
}

// ── the section ─────────────────────────────────────────────────────────────

export function XPosting({
  owner,
  hosted,
  navigate = (url: string) => window.location.assign(url),
  timing = { pollMs: POLL_MS, afterEnableMs: AFTER_ENABLE_MS },
}: {
  /** The signed-in owner, as the Settings answer named it (SettingsView.owner). Sent with every change. */
  owner: string | null;
  hosted: boolean | null;
  /** Where "Connect X account" sends the browser. A seam for tests; the default leaves for X. */
  navigate?: (url: string) => void;
  /** The re-read clocks. A seam for tests; the defaults are POLL_MS and AFTER_ENABLE_MS. */
  timing?: { pollMs: number; afterEnableMs: number };
}) {
  const [read, setRead] = useState<Read>({ kind: "checking" });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; alert: boolean } | null>(null);
  /** The account the open warning names, captured when the switch was pressed. */
  const [asking, setAsking] = useState<{ xUserId: string; handle: string } | null>(null);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  /** Whether the Settings group this sits in is open (true when it sits in none). */
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  /** The warning's lead sentence, where focus goes when the warning opens. */
  const lead = useRef<HTMLParagraphElement>(null);
  const afterEnable = useRef<ReturnType<typeof setTimeout> | null>(null);
  const on = hosted === true;
  const { pollMs, afterEnableMs } = timing;

  /**
   * Read the connection. `quiet` keeps what is on screen while it reads (after
   * a change the screen already shows what the server confirmed), and a quiet
   * failure says so rather than blanking it — until a later read works.
   */
  const load = useCallback(async (quiet = false) => {
    if (!quiet) setRead({ kind: "checking" });
    const next = await readAccount();
    if (quiet && next.kind === "failed") {
      setNote({ text: REFRESH_FAILED, alert: false });
      return;
    }
    if (quiet) setNote((n) => (n?.text === REFRESH_FAILED ? null : n));
    setRead(next);
  }, []);

  useEffect(() => {
    if (on) void load();
  }, [on, load]);

  // /settings#x-posting (where /connect/x sends an owner back) opens this
  // section, and re-reading whenever it is opened keeps "Coming up" current.
  useEffect(() => {
    const details = root.current?.closest("details");
    if (!details) {
      setOpen(on);
      return;
    }
    if (window.location.hash === "#x-posting") {
      details.open = true;
      details.scrollIntoView?.({ block: "start" });
    }
    setOpen(details.open);
    const reread = () => {
      setOpen(details.open);
      if (details.open) void load(true);
    };
    details.addEventListener("toggle", reread);
    return () => details.removeEventListener("toggle", reread);
  }, [load, on]);

  // KEEPING "COMING UP" TRUE: re-read while the owner can see the list and
  // something may be drafted into it. Not while a change of theirs is in
  // flight — that change re-reads when it lands.
  const polling =
    on && open && !busy && read.kind === "ready" && read.account.connected && read.account.postingEnabled;
  useEffect(() => {
    if (!polling) return;
    const tick = () => {
      if (document.visibilityState !== "hidden") void load(true);
    };
    const shown = () => {
      if (document.visibilityState === "visible") void load(true);
    };
    const timer = setInterval(tick, pollMs);
    document.addEventListener("visibilitychange", shown);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", shown);
    };
  }, [polling, pollMs, load]);

  useEffect(
    () => () => {
      if (afterEnable.current) clearTimeout(afterEnable.current);
    },
    [],
  );

  // The warning is a native modal: focus is held in it and Escape closes it.
  //
  // FOCUS GOES TO THE SENTENCE, NOT THE BUTTON. Left to itself, showModal
  // focuses the first button in the dialog — "Let it post as @h" — so an
  // Enter held a moment too long on the switch (key repeat), or pressed
  // twice, would consent without the warning being read, and a screen reader
  // would announce the button and skip the one sentence this flow exists to
  // say. The lead is focused instead (tabIndex -1: reachable by script, not
  // by Tab), and it is the dialog's description.
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (typeof node.showModal === "function") {
      if (!node.open) node.showModal();
    } else {
      node.setAttribute("open", "");
    }
    lead.current?.focus();
  }, [asking]);

  if (!on) return null;

  if (read.kind === "checking") {
    return <div className="xpost" ref={root}><p className="mm-hint" role="status">Checking your X connection…</p></div>;
  }
  if (read.kind === "signed-out" || !owner) {
    return <div className="xpost" ref={root}><p className="mm-hint">{COPY.signedOut}</p></div>;
  }
  if (read.kind === "failed") {
    return (
      <div className="xpost" ref={root}>
        <p className="mm-hint" role="alert">{COPY.unread}</p>
        <div className="xpost-row">
          <button type="button" className="mm-btn" onClick={() => void load()}>Try again</button>
        </div>
      </div>
    );
  }

  const account = read.account;
  const handle = xHandleTag(account.username);
  const patch = (change: Partial<XAccountBody>) =>
    setRead((r) => (r.kind === "ready" ? { kind: "ready", account: { ...r.account, ...change } } : r));

  const connect = async () => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    const r = await send("POST", "/api/x/connect", { action: "start", client: "web", owner });
    if (r.ok && typeof r.data.url === "string" && r.data.url.startsWith(AUTHORIZE)) {
      // Leaving for X; `busy` stays set so a second press cannot start a second connect.
      navigate(r.data.url);
      return;
    }
    setBusy(false);
    setNote({ text: r.ok ? "merrymen didn't send a way to X. Try again in a moment." : r.message, alert: true });
  };

  const onSwitch = (next: boolean) => {
    if (busy || !account.connected || account.status !== "ok" || !handle || !account.xUserId) return;
    setNote(null);
    if (next) {
      // Turning ON needs this server's X app (the route would refuse it too);
      // turning OFF never does, and must never be the switch that is missing.
      if (!account.available) {
        setNote({ text: COPY.cannotTurnOn, alert: true });
        return;
      }
      // NOTHING IS SENT HERE. The warning names the account; its button writes.
      setAsking({ xUserId: account.xUserId, handle });
      return;
    }
    void (async () => {
      setBusy(true);
      const r = await send("POST", "/api/x/account", { action: "disable", owner });
      setBusy(false);
      if (!r.ok || r.data.postingEnabled !== false) {
        setNote({ text: r.ok ? "merrymen didn't confirm that, so posting may still be on." : r.message, alert: true });
        return;
      }
      patch({ postingEnabled: false, upcoming: [] });
      void load(true);
    })();
  };

  const closeWarning = () => {
    const node = dialog.current;
    if (node && typeof node.close === "function" && node.open) node.close();
    setAsking(null);
  };

  const confirmWarning = async () => {
    if (!asking || busy) return;
    const named = asking;
    setBusy(true);
    const r = await send("POST", "/api/x/account", { action: "enable", xUserId: named.xUserId, owner, tz: deviceZone() });
    setBusy(false);
    closeWarning();
    if (r.ok && r.data.postingEnabled === true) {
      patch({ postingEnabled: true });
      void load(true);
      // The hello is drafted on the orchestrator's next plan pass, after this
      // read: read once more when it will be there, open section or not.
      if (afterEnable.current) clearTimeout(afterEnable.current);
      afterEnable.current = setTimeout(() => void load(true), afterEnableMs);
      return;
    }
    setNote({ text: r.ok ? "merrymen didn't confirm that, so posting is still off." : r.message, alert: true });
    // A 409 means the connected account is not the one the warning named: show the one that is.
    if (!r.ok && r.status === 409) void load(true);
  };

  const skip = async (id: number) => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    const r = await send("POST", "/api/x/account", { action: "skip", id, owner });
    setBusy(false);
    if (r.ok) patch({ upcoming: account.upcoming.filter((p) => p.id !== id) });
    else setNote({ text: r.message, alert: true });
    void load(true);
  };

  const disconnect = async () => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    const r = await send("DELETE", "/api/x/account", { owner });
    setBusy(false);
    setConfirmingDisconnect(false);
    if (!r.ok) {
      setNote({ text: r.message, alert: true });
      return;
    }
    patch({ connected: false, username: null, xUserId: null, status: null, postingEnabled: false, upcoming: [], recent: [] });
    void load(true);
  };

  const noteLine = note && (
    <p className={note.alert ? "mm-danger" : "mm-hint"} role={note.alert ? "alert" : "status"}>{note.text}</p>
  );

  const connectButton = (label: string) => (
    <div className="xpost-connect">
      <button type="button" className="mm-btn primary" disabled={busy} onClick={() => void connect()}>{label}</button>
      <p className="mm-hint">{COPY.caption}</p>
    </div>
  );

  const connectedRow = handle && (
    <div className="xpost-row">
      <span className="xpost-account">{connectedAs(handle)}</span>
      {!confirmingDisconnect && (
        <button type="button" className="mm-btn" disabled={busy} onClick={() => setConfirmingDisconnect(true)}>Disconnect</button>
      )}
    </div>
  );

  const disconnectConfirm = confirmingDisconnect && handle && (
    <div className="xpost-confirm" role="group" aria-label="Disconnect X">
      <p>{disconnectAsk(handle)}</p>
      <div className="xpost-row">
        <button type="button" className="mm-btn" disabled={busy} onClick={() => void disconnect()}>Yes, disconnect</button>
        <button type="button" className="mm-btn" disabled={busy} onClick={() => setConfirmingDisconnect(false)}>Keep it</button>
      </div>
    </div>
  );

  // ── nothing connected ──
  if (!account.connected) {
    // Nothing to stop, and nothing can be started here: one line.
    if (!account.available) {
      return (
        <div className="xpost" ref={root}>
          <p className="mm-hint">{COPY.unavailable}</p>
          {noteLine}
        </div>
      );
    }
    return (
      <div className="xpost" ref={root}>
        <p className="mm-hint" style={{ marginTop: 0 }}>{COPY.blurb}</p>
        {connectButton(COPY.connect)}
        {noteLine}
      </div>
    );
  }

  // ── connected, but to an account this screen cannot name ──
  // The warning must name the account, so without a handle there is no switch —
  // and it is still CONNECTED, never offered as "Connect X account".
  if (!handle || !account.xUserId) {
    return (
      <div className="xpost" ref={root}>
        <div className="xpost-row">
          <span className="xpost-account">An X account is connected, but merrymen can&apos;t show which one. Disconnect it and connect again.</span>
          <button type="button" className="mm-btn" disabled={busy} onClick={() => void disconnect()}>Disconnect</button>
        </div>
        {noteLine}
      </div>
    );
  }

  // ── connected, but X stopped honouring it ──
  if (account.status !== "ok") {
    return (
      <div className="xpost" ref={root}>
        {connectedRow}
        {disconnectConfirm}
        <p className="mm-danger" role="status">{COPY.revoked}</p>
        {account.available ? connectButton(COPY.reconnect) : <p className="mm-hint">{COPY.unavailable}</p>}
        {noteLine}
      </div>
    );
  }

  return (
    <div className="xpost" ref={root}>
      {connectedRow}
      {disconnectConfirm}
      <div className="xpost-switch">
        <div>
          <strong>{COPY.toggle}</strong>
          <small className="mm-hint">
            {account.postingEnabled ? postingFrom(handle) : "Off. Nothing is posted until you turn this on."}
          </small>
        </div>
        <Switch on={account.postingEnabled} onChange={onSwitch} label={COPY.toggle} />
      </div>
      {noteLine}

      {account.postingEnabled && (
        <section className="xpost-list-block" aria-label={COPY.comingUp}>
          <h3 className="xpost-list-title">{COPY.comingUp}</h3>
          {account.upcoming.length === 0 ? (
            <p className="mm-hint">{COPY.nothingWaiting}</p>
          ) : (
            <ul className="xpost-list">
              {account.upcoming.map((p) => (
                <li key={p.id} className="xpost-post">
                  <p>{p.body}</p>
                  <div className="xpost-meta">
                    <span>
                      {KIND_LABEL[p.kind] ?? "Post"} · {p.dueAt <= Date.now() ? "going out soon" : `goes out around ${shortDateTime(p.dueAt)}`}
                    </span>
                    <button type="button" className="mm-btn" disabled={busy} aria-label={skipLabel(p)} onClick={() => void skip(p.id)}>
                      {COPY.skip}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {account.recent.length > 0 && (
        <section className="xpost-list-block" aria-label={COPY.posted}>
          <h3 className="xpost-list-title">{COPY.posted}</h3>
          <ul className="xpost-list">
            {account.recent.map((p) => (
              <li key={p.id} className="xpost-post">
                <p>{p.body}</p>
                <div className="xpost-meta">
                  <span>{shortDateTime(p.sentAt)}</span>
                  {STATUS_URL.test(p.url) && (
                    <a href={p.url} target="_blank" rel="noreferrer noopener">{COPY.viewOnX}</a>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {asking && (
        <dialog
          ref={dialog}
          className="portfolio-dialog xpost-dialog"
          aria-labelledby="xpost-warning-title"
          aria-describedby="xpost-warning-lead"
          onCancel={(event) => {
            event.preventDefault();
            closeWarning();
          }}
        >
          <div className="portfolio-dialog-header">
            <h2 id="xpost-warning-title">{warningTitle(asking.handle)}</h2>
          </div>
          <div className="portfolio-body">
            <p id="xpost-warning-lead" ref={lead} tabIndex={-1}>
              <strong>{warningLead(asking.handle)}</strong>
            </p>
            {WARNING_BODY.map((line) => <p key={line}>{line}</p>)}
            <div className="resign-actions">
              <button type="button" className="mm-btn primary" disabled={busy} onClick={() => void confirmWarning()}>
                {warningYes(asking.handle)}
              </button>
              <button type="button" className="mm-btn" disabled={busy} onClick={closeWarning}>{COPY.notNow}</button>
            </div>
          </div>
        </dialog>
      )}
    </div>
  );
}
