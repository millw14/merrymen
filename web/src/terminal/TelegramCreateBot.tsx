"use client";

import { useEffect, useRef, useState } from "react";
import { RequestError, requestJson } from "./request-json";

type IntentStatus = "waiting_telegram" | "waiting_bot" | "confirm" | "connected" | "expired" | "cancelled" | "error";
export interface TelegramCreateIntent {
  id: string;
  status: IntentStatus;
  expiresAt: number;
  botUsername: string | null;
  botId: string | null;
}
interface Props {
  owner: string | null;
  hasBot: boolean;
  disabled?: boolean;
  onActiveChange?: (active: boolean) => void;
  /** False once the server says creation can't start here, so Settings can put the manual path first. */
  onAvailableChange?: (available: boolean | null) => void;
  onConnected: (owner: string, signal: AbortSignal, botUsername: string) => Promise<void> | void;
  onIntentMissing: (owner: string, signal: AbortSignal, botUsername: string | null) => Promise<void> | void;
  /**
   * HOME'S ONE BUTTON: the same flow, drawn as a single primary control whose
   * label and action follow the setup (create, open Telegram, connect this
   * bot), with cancel as a quiet link beside it. The logic is this file's,
   * unchanged; only the drawing differs. When creation can't start here it
   * becomes a way to the manual path in Settings instead of a dead button.
   */
  compact?: boolean;
}
interface View {
  owner: string;
  available: boolean | null;
  intent: TelegramCreateIntent | null;
  telegramUrl: string | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
  refreshed: boolean;
  confirmationAttempted: boolean;
  needsReconciliation: boolean;
}
const POLL_MS = 3000;
/** The server's setup window (MANAGED_INTENT_TTL_MS), which also bounds a longer expiry the server might send. */
const MAX_PENDING_MS = 30 * 60_000;
const ID = /^[A-Za-z0-9_-]{16,64}$/;
const storageKey = (owner: string) => `merrymen.telegram.create.v1:${owner}`;
const initial = (owner: string): View => ({ owner, available: null, intent: null, telegramUrl: null, loading: true, busy: false, error: null, refreshed: false, confirmationAttempted: false, needsReconciliation: false });
const pending = (intent: TelegramCreateIntent | null) => !!intent && ["waiting_telegram", "waiting_bot", "confirm"].includes(intent.status);

function intentFrom(value: unknown): TelegramCreateIntent {
  if (!value || typeof value !== "object") throw new Error("Invalid setup");
  const i = value as Record<string, unknown>;
  if (typeof i.id !== "string" || !ID.test(i.id) || !["waiting_telegram", "waiting_bot", "confirm", "connected", "expired", "cancelled", "error"].includes(String(i.status)) || !Number.isSafeInteger(i.expiresAt) || Number(i.expiresAt) <= 0 || (i.botUsername !== null && (typeof i.botUsername !== "string" || !/^[A-Za-z0-9_]{2,29}bot$/i.test(i.botUsername))) || (i.botId !== null && (typeof i.botId !== "string" || !/^\d{1,20}$/.test(i.botId)))) throw new Error("Invalid setup");
  if ((i.status === "confirm" || i.status === "connected") && (!i.botUsername || !i.botId)) throw new Error("Missing bot identity");
  return { id: i.id, status: i.status as IntentStatus, expiresAt: Number(i.expiresAt), botUsername: i.botUsername as string | null, botId: i.botId as string | null };
}

/** Only the official Telegram manager deep link is opened; the browser never receives a bot token. */
function telegramLink(value: unknown): string {
  if (typeof value !== "string") throw new Error("Missing Telegram link");
  const url = new URL(value);
  const keys = [...url.searchParams.keys()];
  if (url.protocol !== "https:" || url.hostname !== "t.me" || url.port || url.username || url.password || url.hash || !/^\/[A-Za-z0-9_]{2,29}bot$/i.test(url.pathname) || keys.length !== 1 || keys[0] !== "start" || !/^[A-Za-z0-9_-]{1,64}$/.test(url.searchParams.get("start") ?? "")) throw new Error("Invalid Telegram link");
  return url.href;
}

function failure(error: unknown): string {
  if (error instanceof RequestError) {
    if (error.status === 401) return "Sign in again to create a Telegram bot.";
    if (error.status === 403) return "Your signed-in account changed. Reload Settings before continuing.";
    if (error.status === 409) return "This setup changed. Refresh Settings before trying again.";
    if (error.status === 503) return "Bot creation isn't available right now. You can connect an existing bot below.";
  }
  return "Couldn't check Telegram setup. Try again.";
}

export function TelegramCreateBot({ owner: suppliedOwner, hasBot, disabled = false, onActiveChange, onAvailableChange, onConnected, onIntentMissing, compact = false }: Props) {
  const owner = /^0x[0-9a-f]{40}$/i.test(suppliedOwner ?? "") ? suppliedOwner!.toLowerCase() : "";
  const [view, setView] = useState<View>(() => initial(owner));
  const [attempt, setAttempt] = useState(0);
  const [refreshAttempt, setRefreshAttempt] = useState(0);
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const viewRef = useRef(view);
  viewRef.current = view;
  const callbacks = useRef({ onActiveChange, onAvailableChange, onConnected, onIntentMissing });
  callbacks.current = { onActiveChange, onAvailableChange, onConnected, onIntentMissing };
  const controllers = useRef(new Set<AbortController>());
  const popups = useRef(new Set<Window>());
  const priorOwner = useRef(owner);
  const deadline = useRef<{ id: string; at: number } | null>(null);
  const current = view.owner === owner ? view : initial(owner);
  const active = current.loading || current.busy || current.needsReconciliation || pending(current.intent) || (current.confirmationAttempted && !current.refreshed) || (current.intent?.status === "connected" && !current.refreshed);

  function controller() { const ctl = new AbortController(); controllers.current.add(ctl); return ctl; }
  function valid(ctl: AbortController, scope: string) { return !ctl.signal.aborted && ownerRef.current === scope; }
  function patch(scope: string, changes: Partial<View>) { if (ownerRef.current === scope) setView(previous => previous.owner === scope ? { ...previous, ...changes } : previous); }
  function remember(scope: string, id: string | null) {
    try { if (id) localStorage.setItem(storageKey(scope), id); else localStorage.removeItem(storageKey(scope)); } catch { /* The current flow still works without browser storage. */ }
  }
  function remembered(scope: string): string | null {
    try { return localStorage.getItem(storageKey(scope)); } catch { return null; }
  }
  function until(intent: TelegramCreateIntent) {
    if (deadline.current?.id !== intent.id) deadline.current = { id: intent.id, at: Math.min(intent.expiresAt, Date.now() + MAX_PENDING_MS) };
    return Math.min(deadline.current.at, intent.expiresAt);
  }
  /**
   * READ THIS BROWSER'S SETUP, AND LET GO OF IT ONLY ONCE SETTINGS SAYS WHAT
   * WAS SAVED.
   *
   * A setup the server no longer offers is gone in one of three ways: its row
   * is missing (404), creation has been switched off or is not ready, so the
   * server answers without it, or it reads back expired or cancelled. #284
   * handled only the first. The second threw "Setup changed" and left Save
   * disabled for good, retry or not, in any browser holding an id from before
   * the switch; the third kept the dead id in storage, to be read again on
   * every visit.
   *
   * A row that is gone, or one that ended after this tab asked to confirm, may
   * still have saved a bot (the row can expire after a confirmation commits,
   * and a lost response says nothing either way). So Settings is read back
   * first (onIntentMissing), which also drops an older manual token draft that
   * would overwrite that bot, and only then is the id forgotten and Save
   * released. A failed readback keeps both. An end this tab never confirmed
   * cannot have saved anything: it is forgotten at once.
   */
  async function read(scope: string, id: string | null, ctl: AbortController) {
    const ask = async (withId: string | null) => {
      const params = new URLSearchParams({ owner: scope });
      if (withId) params.set("intent", withId);
      const data = await requestJson<{ available: unknown; intent?: unknown }>(`/api/telegram/create?${params}`, { signal: ctl.signal });
      if (typeof data.available !== "boolean") throw new Error("Invalid availability");
      const found = withId && data.intent ? intentFrom(data.intent) : null;
      if (found && found.id !== withId) throw new Error("Setup changed");
      return { available: data.available, intent: found };
    };
    let answer: Awaited<ReturnType<typeof ask>> | null = null;
    try { answer = await ask(id); }
    catch (error) { if (!valid(ctl, scope) || !id || !(error instanceof RequestError) || error.status !== 404) throw error; }
    if (!valid(ctl, scope)) return;
    const prior = viewRef.current.owner === scope ? viewRef.current : null;
    const intent = answer?.intent ?? null;
    const ended = intent?.status === "expired" || intent?.status === "cancelled";
    if (id && (!intent || (ended && prior?.confirmationAttempted))) {
      patch(scope, { needsReconciliation: true, busy: true });
      await callbacks.current.onIntentMissing(scope, ctl.signal, intent?.botUsername ?? prior?.intent?.botUsername ?? null);
      if (!valid(ctl, scope)) return;
      if (!answer) { answer = await ask(null); if (!valid(ctl, scope)) return; }
      remember(scope, null); deadline.current = null;
      patch(scope, { available: answer.available, intent, loading: false, busy: false, needsReconciliation: false, error: null, telegramUrl: null, confirmationAttempted: false });
      return;
    }
    if (ended) { remember(scope, null); deadline.current = null; }
    else if (intent) remember(scope, intent.id);
    patch(scope, { available: answer!.available, intent, loading: false, needsReconciliation: false, error: null });
  }

  useEffect(() => {
    if (priorOwner.current !== owner) { remember(priorOwner.current, null); deadline.current = null; priorOwner.current = owner; }
    const old = viewRef.current.owner === owner ? viewRef.current : initial(owner);
    setView({ ...old, owner, loading: true, error: null });
    if (!owner) { setView({ ...initial(owner), loading: false }); return; }
    let id = old.intent?.id ?? null;
    try { const saved = localStorage.getItem(storageKey(owner)); if (!id && saved) { if (ID.test(saved)) id = saved; else remember(owner, null); } } catch { /* No stored intent. */ }
    if (hasBot && !id) { setView({ ...initial(owner), loading: false }); return; }
    if (id) { patch(owner, { needsReconciliation: true }); callbacks.current.onActiveChange?.(true); }
    const ctl = controller();
    // A check that failed outright cannot vouch for creation either: report
    // it unavailable so Settings opens the manual path beside "Try again".
    void read(owner, id, ctl).catch(error => { if (valid(ctl, owner)) patch(owner, { loading: false, busy: false, error: failure(error), available: false }); }).finally(() => controllers.current.delete(ctl));
    return () => { for (const active of controllers.current) active.abort(); controllers.current.clear(); for (const popup of popups.current) popup.close(); popups.current.clear(); };
  }, [owner, attempt]);

  useEffect(() => {
    callbacks.current.onActiveChange?.(!!active);
  }, [active]);
  const availability = owner ? current.available : false;
  useEffect(() => {
    callbacks.current.onAvailableChange?.(availability);
  }, [availability]);
  useEffect(() => () => { for (const ctl of controllers.current) ctl.abort(); controllers.current.clear(); for (const popup of popups.current) popup.close(); popups.current.clear(); callbacks.current.onActiveChange?.(false); }, []);

  const intent = current.intent;
  /**
   * POLLED UNTIL IT ENDS, "confirm" INCLUDED. The bot can now be connected,
   * or turned down, from the manager's own buttons in Telegram, so a page
   * showing Connect keeps reading too: a connection made there reads back
   * "connected" and Settings is refreshed as for one made here. confirm()
   * stops this loop before it asks, so a read from before its answer cannot
   * put "confirm" back over "connected".
   */
  useEffect(() => {
    if (!intent || !pending(intent) || !owner || current.loading) return;
    const ctl = controller();
    let timer: ReturnType<typeof setTimeout>;
    const expire = setTimeout(() => { if (!valid(ctl, owner)) return; ctl.abort(); patch(owner, { intent: { ...intent, status: "expired" }, error: null, busy: false }); }, Math.max(0, until(intent) - Date.now()));
    if (!current.error) {
      const poll = async () => {
        try { await read(owner, intent.id, ctl); if (valid(ctl, owner)) timer = setTimeout(poll, POLL_MS); }
        catch (error) { if (valid(ctl, owner)) patch(owner, { busy: false, error: failure(error) }); }
      };
      timer = setTimeout(poll, POLL_MS);
    }
    return () => { ctl.abort(); controllers.current.delete(ctl); clearTimeout(timer); clearTimeout(expire); };
  }, [owner, intent?.id, intent?.status, intent?.expiresAt, current.error, current.loading]);

  /**
   * BACK FROM TELEGRAM. A phone puts this tab to sleep while its owner is in
   * Telegram, making and maybe connecting the bot there, and a sleeping tab's
   * timers fire late: the next poll up to a minute after it wakes, or this
   * tab's own deadline first, which would say "expired" over a bot that was
   * connected. So coming back into view reads the setup at once: one still
   * underway, or one this tab marked expired by its own clock (its id is
   * still stored: an expiry the server reported is forgotten, and not asked
   * about again).
   */
  useEffect(() => {
    if (!owner) return;
    const wake = () => {
      if (document.visibilityState === "hidden") return;
      const seen = viewRef.current, it = seen.intent;
      if (seen.owner !== owner || !it || seen.loading || seen.busy || seen.needsReconciliation || seen.error) return;
      if (!pending(it) && !(it.status === "expired" && remembered(owner) === it.id)) return;
      const ctl = controller();
      void read(owner, it.id, ctl).catch(error => { if (valid(ctl, owner)) patch(owner, { busy: false, error: failure(error) }); }).finally(() => controllers.current.delete(ctl));
    };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("pageshow", wake);
    return () => { document.removeEventListener("visibilitychange", wake); window.removeEventListener("pageshow", wake); };
  }, [owner]);

  useEffect(() => {
    if (!intent || intent.status !== "connected" || current.refreshed || !owner) return;
    const ctl = controller();
    patch(owner, { busy: true, error: null });
    void Promise.resolve().then(() => callbacks.current.onConnected(owner, ctl.signal, intent.botUsername!)).then(() => {
      if (!valid(ctl, owner)) return;
      remember(owner, null);
      patch(owner, { busy: false, refreshed: true, confirmationAttempted: false, error: null });
    }).catch(() => { if (valid(ctl, owner)) patch(owner, { busy: false, error: "The bot was connected, but Settings couldn't refresh. Refresh Settings before saving other changes." }); }).finally(() => controllers.current.delete(ctl));
    return () => { ctl.abort(); controllers.current.delete(ctl); };
  }, [owner, intent?.id, intent?.status, refreshAttempt]);

  async function begin() {
    if (!owner || disabled || current.busy || current.needsReconciliation || current.confirmationAttempted || current.available !== true || hasBot) return;
    // Open during the click's user activation, before the request awaits. A
    // blocked popup still gets the ordinary validated Open Telegram link.
    let popup: Window | null = null;
    try { popup = window.open("about:blank", "_blank"); if (popup) { popup.opener = null; popups.current.add(popup); } } catch { popup = null; }
    const ctl = controller();
    callbacks.current.onActiveChange?.(true);
    patch(owner, { busy: true, error: null });
    try {
      const data = await requestJson<{ intent: unknown; telegramUrl: unknown }>("/api/telegram/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "begin", owner }), signal: ctl.signal });
      if (!valid(ctl, owner)) return;
      const next = intentFrom(data.intent), url = telegramLink(data.telegramUrl);
      if (!pending(next) || next.expiresAt <= Date.now()) throw new Error("Expired setup");
      remember(owner, next.id);
      patch(owner, { intent: next, telegramUrl: url, refreshed: false, confirmationAttempted: false });
      if (popup) { try { popup.location.replace(url); } catch { popup.close(); } popups.current.delete(popup); popup = null; }
    } catch (error) { if (valid(ctl, owner)) patch(owner, { error: failure(error) }); }
    finally { if (popup) { popup.close(); popups.current.delete(popup); } controllers.current.delete(ctl); if (valid(ctl, owner)) patch(owner, { busy: false }); }
  }
  async function confirm() {
    if (!owner || disabled || current.busy || !intent || intent.status !== "confirm" || !intent.botId || hasBot || until(intent) <= Date.now()) return;
    // No read from before this answer may land after it (the poll above).
    for (const ctl of controllers.current) ctl.abort();
    controllers.current.clear();
    const ctl = controller();
    patch(owner, { busy: true, error: null, confirmationAttempted: true });
    try {
      const data = await requestJson<{ intent: unknown }>("/api/telegram/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "confirm", owner, intentId: intent.id, botId: intent.botId }), signal: ctl.signal });
      if (!valid(ctl, owner)) return;
      const next = intentFrom(data.intent);
      if (next.id !== intent.id || next.botId !== intent.botId || next.status !== "connected") throw new Error("Setup changed");
      patch(owner, { intent: next, telegramUrl: null });
    } catch (error) { if (valid(ctl, owner)) patch(owner, { error: failure(error) }); }
    finally { controllers.current.delete(ctl); if (valid(ctl, owner)) patch(owner, { busy: false }); }
  }
  async function cancel() {
    if (!owner || disabled || current.busy || !intent) return;
    for (const ctl of controllers.current) ctl.abort();
    controllers.current.clear();
    const ctl = controller();
    patch(owner, { busy: true, error: null });
    try {
      const data = await requestJson<{ intent: unknown }>("/api/telegram/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "cancel", owner, intentId: intent.id }), signal: ctl.signal });
      if (!valid(ctl, owner)) return;
      const next = intentFrom(data.intent);
      if (next.id !== intent.id || !["connected", "cancelled", "expired"].includes(next.status)) throw new Error("Setup changed");
      if (next.status === "connected") patch(owner, { intent: next, telegramUrl: null });
      else { remember(owner, null); patch(owner, { intent: null, telegramUrl: null, confirmationAttempted: false }); }
    } catch (error) { if (valid(ctl, owner)) patch(owner, { error: failure(error) }); }
    finally { controllers.current.delete(ctl); if (valid(ctl, owner)) patch(owner, { busy: false }); }
  }

  if (!owner) return <p className="mm-hint">Sign in to create a Telegram bot.</p>;
  if (hasBot && !intent && !current.needsReconciliation) return null;
  const ended = intent && ["expired", "cancelled", "error"].includes(intent.status);
  if (compact) {
    const quietCancel = <button type="button" className="tg-one-cancel" disabled={disabled || current.busy} onClick={() => void cancel()}>Cancel</button>;
    let primary: React.ReactNode;
    let note: string | null = null;
    let secondary: React.ReactNode = null;
    if (current.loading) primary = <button type="button" className="mm-btn primary" disabled>Checking Telegram…</button>;
    else if (current.error) { note = current.error; primary = <button type="button" className="mm-btn primary" disabled={disabled || current.busy} onClick={() => intent?.status === "connected" ? setRefreshAttempt(n => n + 1) : setAttempt(n => n + 1)}>Try again</button>; }
    else if (ended && (current.confirmationAttempted || current.needsReconciliation)) { note = "Checking whether your bot was saved."; primary = <button type="button" className="mm-btn primary" disabled={disabled || current.busy} onClick={() => setAttempt(n => n + 1)}>Check setup</button>; secondary = quietCancel; }
    else if (current.needsReconciliation) primary = <button type="button" className="mm-btn primary" disabled>Checking Telegram…</button>;
    else if (intent && ["waiting_telegram", "waiting_bot"].includes(intent.status)) {
      note = intent.status === "waiting_bot" ? "Pick a name for your bot in Telegram. This updates by itself." : "Approve the new bot in Telegram, then come back here.";
      primary = current.telegramUrl ? <a className="mm-btn primary" href={current.telegramUrl} target="_blank" rel="noopener noreferrer">Open Telegram</a> : <button type="button" className="mm-btn primary" disabled>Waiting for Telegram…</button>;
      secondary = quietCancel;
    } else if (intent?.status === "confirm") {
      note = "Telegram made your bot. Connect it to your agent.";
      primary = <button type="button" className="mm-btn primary" disabled={disabled || current.busy || until(intent) <= Date.now() || hasBot} onClick={() => void confirm()}>{current.busy ? "Connecting…" : `Connect @${intent.botUsername}`}</button>;
      secondary = quietCancel;
    } else if (intent?.status === "connected") primary = <button type="button" className="mm-btn primary" disabled>Bot saved, starting it…</button>;
    else if (current.available === true) {
      if (ended) note = intent.status === "expired" ? "That setup expired. Start again when you're ready." : "That setup didn't finish. You can start again.";
      primary = <button type="button" className="mm-btn primary" disabled={disabled || current.busy} onClick={() => void begin()}>{current.busy ? "Opening Telegram…" : "Set up Telegram"}</button>;
    } else primary = <a className="mm-btn primary" href="/settings#telegram">Connect Telegram</a>;
    return <div className="tg-one" aria-label="Set up Telegram" aria-busy={current.loading || current.busy}>
      {primary}{secondary}
      {note ? <p className={current.error ? "mm-danger" : "mm-hint"} role={current.error ? "alert" : "status"}>{note}</p> : null}
    </div>;
  }
  return <div className="mm-field" aria-label="Create Telegram bot" aria-busy={current.loading || current.busy}>
    {current.loading ? <p className="mm-hint" role="status">Checking Telegram setup…</p> : null}
    {current.error ? <p className="mm-danger" role="alert">{current.error}</p> : null}
    {!current.loading && current.available === false && (!intent || ended) && !current.needsReconciliation && !hasBot ? <p className="mm-hint">Bot creation isn&apos;t available right now. You can connect an existing bot below.</p> : null}
    {!current.loading && current.available === true && (!intent || ended) && !current.needsReconciliation && !current.confirmationAttempted && !hasBot ? <>
      {ended ? <p className="mm-hint" role="status">{intent.status === "expired" ? "This Telegram setup expired. Start again when you're ready." : "This Telegram setup didn't finish. You can start again."}</p> : null}
      <p className="mm-hint">Create your bot in Telegram, then confirm its username here. No bot token to copy.</p>
      <button type="button" className="mm-btn primary" disabled={disabled || current.busy} onClick={() => void begin()}>{current.busy ? "Preparing Telegram…" : "Create Telegram bot"}</button>
    </> : null}
    {intent && ["waiting_telegram", "waiting_bot"].includes(intent.status) ? <>
      <p className="mm-hint" role="status">{intent.status === "waiting_bot" ? "Choose a name and username for your bot in Telegram. This page will update automatically." : "Open Telegram and approve bot creation. Then come back here to confirm your bot."}</p>
      {current.telegramUrl ? <a className="mm-btn primary" href={current.telegramUrl} target="_blank" rel="noopener noreferrer">Open Telegram</a> : <p className="mm-hint">Continue in the Telegram chat you opened, or cancel this setup and start again.</p>}
      <button type="button" className="mm-btn" disabled={disabled || current.busy} onClick={() => void cancel()}>Cancel setup</button>
    </> : null}
    {intent?.status === "confirm" ? <>
      <p className="mm-hint">Telegram created <strong>@{intent.botUsername}</strong>. Check that this is the bot you just created.</p>
      <button type="button" className="mm-btn primary" disabled={disabled || current.busy || until(intent) <= Date.now() || hasBot} onClick={() => void confirm()}>{current.busy ? "Connecting…" : "Connect this bot"}</button>
      <button type="button" className="mm-btn" disabled={disabled || current.busy} onClick={() => void cancel()}>Cancel setup</button>
    </> : null}
    {/* SAVED, NOT LISTENING. The token is in Settings; the bot answers only
        once this agent's worker runs and picks it up, and only that worker
        mints the link code "Open my bot" needs. A new agent can wait for
        that, so nothing here says the bot is live. */}
    {intent?.status === "connected" ? <p className="mm-hint" role="status">{current.refreshed ? <>Bot saved as <strong>@{intent.botUsername}</strong>. It answers once your agent is running; its link to open it appears below then.</> : "Bot saved. Refreshing Settings…"}</p> : null}
    {ended && (current.confirmationAttempted || current.needsReconciliation) ? <>
      <p className="mm-hint" role="status">The connection hasn&apos;t been checked yet. Check setup or cancel before saving other settings.</p>
      <button type="button" className="mm-btn" disabled={disabled || current.busy} onClick={() => setAttempt(n => n + 1)}>Check setup</button>
      <button type="button" className="mm-btn" disabled={disabled || current.busy} onClick={() => void cancel()}>Cancel setup</button>
    </> : null}
    {current.error ? <button type="button" className="mm-btn" disabled={disabled || current.busy} onClick={() => intent?.status === "connected" ? setRefreshAttempt(n => n + 1) : setAttempt(n => n + 1)}>{intent?.status === "connected" ? "Refresh Settings" : "Try again"}</button> : null}
  </div>;
}
