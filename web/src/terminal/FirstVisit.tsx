"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Compass } from "lucide-react";
import type { Screen } from "./live";
import { TOUR_VERSION } from "@/lib/tour-version";
import { tourCardPosition, visibleTourTarget, type TourRect } from "./tour-layout";
import { LanguagePicker } from "./LanguagePicker";
import { useT } from "@/lib/i18n";
import type { MessageKey } from "@/lib/messages/en";

/** Guided topics, available before sign-in. Anonymous dismissal can be claimed
 * by one account; explicit replay is separate from permanent dismissal. */

type Stop = {
  /**
   * THE STOP'S WORDS LIVE IN THE CATALOGUE, not here.
   *
   * Typed as `MessageKey`, so a stop pointing at a key that does not exist is
   * a compile error rather than a blank card in front of a new reader.
   */
  titleKey: MessageKey;
  copyKey: MessageKey;
  explore?: "markets" | "agents" | "feed" | "board";
  /**
   * What this stop is about, as selectors tried in order — or null for a stop
   * about the product rather than a control.
   *
   * A LIST, BECAUSE THIS APP HAS TWO NAVIGATIONS. The floating tab bar is
   * `display:none` on desktop, where a sidebar takes over, so a single selector
   * would spotlight correctly on a phone and point at nothing on a laptop. The
   * first candidate that resolves to a box WITH SIZE wins, which makes the
   * choice a fact about what is on screen rather than a guess about viewport
   * width.
   *
   * All of them missing degrades to a centred card with no spotlight, which is
   * right for the stops that have no single control to point at, and is also
   * the honest fallback for a layout nobody anticipated.
   */
  target: string[] | null;
  /** Where the app should be while this stop is shown. */
  screen: Screen | null;
};

export const STOPS: Stop[] = [
  {
    titleKey: "tour.stop01.title",
    copyKey: "tour.stop01.copy",
    target: null,
    screen: null,
  },
  {
    titleKey: "tour.stop02.title",
    copyKey: "tour.stop02.copy",
    target: ['[data-tour="tab-home"]', "#explore-tab-markets"],
    screen: { kind: "tab", tab: "home" },
  },
  {
    titleKey: "tour.stop03.title",
    copyKey: "tour.stop03.copy",
    target: ['[data-tour="tab-agent"]', '[data-tour="your-agent"]', "#explore-tab-agents"],
    screen: { kind: "tab", tab: "agent" },
  },
  {
    titleKey: "tour.stop04.title",
    copyKey: "tour.stop04.copy",
    target: ['[data-tour="chat-input"]', '[data-tour="tab-agent"]', '[data-tour="your-agent"]', "#explore-tab-agents"],
    screen: { kind: "tab", tab: "agent" },
  },
  {
    titleKey: "tour.stop05.title",
    copyKey: "tour.stop05.copy",
    target: ['[data-tour="tab-you"]', ".desktop-portfolio"],
    screen: { kind: "tab", tab: "you" },
  },
  {
    titleKey: "tour.stop06.title",
    copyKey: "tour.stop06.copy",
    target: null,
    screen: null,
  },
  {
    titleKey: "tour.stop07.title",
    copyKey: "tour.stop07.copy",
    target: ['[data-tour="tab-feed"]', "#explore-tab-feed"],
    screen: { kind: "tab", tab: "feed" },
  },
{titleKey: "tour.stop08.title", copyKey: "tour.stop08.copy", "target": [".find"], "screen": {"kind": "search"}},
{titleKey: "tour.stop09.title", copyKey: "tour.stop09.copy", "target": [".create-agent"], "screen": {"kind": "create"}},
{titleKey: "tour.stop10.title", copyKey: "tour.stop10.copy", "target": [".mm-wrap"], "screen": {"kind": "settings"}},
{titleKey: "tour.stop11.title", copyKey: "tour.stop11.copy", "target": null, "screen": {"kind": "limits"}},
{titleKey: "tour.stop12.title", copyKey: "tour.stop12.copy", "target": null, "screen": {"kind": "grant"}},
{titleKey: "tour.stop13.title", copyKey: "tour.stop13.copy", "target": null, "screen": {"kind": "deposit"}},
{titleKey: "tour.stop14.title", copyKey: "tour.stop14.copy", "target": null, "screen": {"kind": "withdraw"}},
{titleKey: "tour.stop15.title", copyKey: "tour.stop15.copy", "target": [".desktop-portfolio"], "screen": {"kind": "tab", "tab": "you"}},
{titleKey: "tour.stop16.title", copyKey: "tour.stop16.copy", "target": ["#explore-tab-agents"], "screen": {"kind": "tab", "tab": "home"}, "explore": "agents"},
{titleKey: "tour.stop17.title", copyKey: "tour.stop17.copy", "target": ["#explore-tab-board"], "screen": {"kind": "tab", "tab": "home"}, "explore": "board"},
{titleKey: "tour.stop18.title", copyKey: "tour.stop18.copy", "target": ["#explore-panel-board"], "screen": {"kind": "tab", "tab": "home"}, "explore": "board"},
{titleKey: "tour.stop19.title", copyKey: "tour.stop19.copy", "target": ["#explore-panel-board"], "screen": {"kind": "tab", "tab": "home"}, "explore": "board"},
{titleKey: "tour.stop20.title", copyKey: "tour.stop20.copy", "target": ["#explore-tab-feed"], "screen": {"kind": "tab", "tab": "feed"}, "explore": "feed"},
{titleKey: "tour.stop21.title", copyKey: "tour.stop21.copy", "target": ["#explore-tab-feed"], "screen": {"kind": "tab", "tab": "feed"}, "explore": "feed"},
{titleKey: "tour.stop22.title", copyKey: "tour.stop22.copy", "target": ["#explore-tab-feed"], "screen": {"kind": "tab", "tab": "feed"}, "explore": "feed"},
{titleKey: "tour.stop23.title", copyKey: "tour.stop23.copy", "target": [".alpha-page"], "screen": {"kind": "tab", "tab": "alpha"}},
{titleKey: "tour.stop24.title", copyKey: "tour.stop24.copy", "target": [".mm-wrap"], "screen": {"kind": "settings"}},
{titleKey: "tour.stop25.title", copyKey: "tour.stop25.copy", "target": [".mm-wrap"], "screen": {"kind": "settings"}},
{titleKey: "tour.stop26.title", copyKey: "tour.stop26.copy", "target": ["[data-tour=\"chat-input\"]"], "screen": {"kind": "tab", "tab": "agent"}}
];

const KEY = `merrymen.tour.v${TOUR_VERSION}`;
type Saved = { done: boolean; step: number; pending?: boolean; replay?: boolean; claimed?: string };

function readLocal(key: string): Saved | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Saved>;
    if (typeof v.done !== "boolean") return null;
    const step = Number.isInteger(v.step) && v.step! >= 0 && v.step! < STOPS.length ? v.step! : 0;
    return { done: v.done, step, pending: v.pending === true, replay: v.replay === true, claimed: typeof v.claimed === "string" ? v.claimed : undefined };
  } catch {
    // Storage can be unavailable (private windows, blocked cookies). The tour
    // still works; it simply cannot remember, which is the safe direction.
    return null;
  }
}

function writeLocal(key: string, v: Saved): void {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* see readLocal */
  }
}

/** Where the card sits, in viewport coordinates. */
type Layout = { step: number; spot: TourRect | null; top: number; left: number; width: number; maxHeight: number };

export function FirstVisit({
  tenant = null,
  ...props
}: {
  tenant?: string | null;
  layoutKey?: string;
  onScreen: (screen: Screen) => void;
  onQuestion: () => void;
  onExplore?: (section: "markets" | "agents" | "feed" | "board") => void;
}) {
  const owner = tenant?.toLowerCase() ?? null;
  return <AccountTour key={owner ?? "anonymous"} tenant={owner} {...props} />;
}

function AccountTour({
  tenant,
  layoutKey,
  onScreen,
  onQuestion,
  onExplore,
}: {
  tenant: string | null;
  layoutKey?: string;
  onScreen: (screen: Screen) => void;
  onQuestion: () => void;
  onExplore?: (section: "markets" | "agents" | "feed" | "board") => void;
}) {
  const t = useT();
  const [topicsOpen, setTopicsOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const key = tenant ? `${KEY}:${tenant}` : KEY;
  const [saved, setSaved] = useState<Saved>({ done: true, step: 0 });
  const [syncFailed, setSyncFailed] = useState(false);
  const [layout, setLayout] = useState<Layout | null>(null);
  const cardRef = useRef<HTMLElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const askedRef = useRef(false);
  const state = useRef(saved);
  const alive = useRef(true);
  const posting = useRef(false);
  const callbacks = useRef({ onScreen, onQuestion, onExplore });
  callbacks.current = { onScreen, onQuestion, onExplore };
  const done = saved.done && !saved.replay;
  const step = saved.step;
  const save = useCallback((next: Saved) => {
    state.current = next;
    writeLocal(key, next);
    setSaved(next);
  }, [key]);

  // A failed write stays pending across reloads. Retry on mount, reconnect, or
  // an explicit click, never a timer loop.
  const sync = useCallback(async () => {
    if (!tenant || !state.current.pending || posting.current) return;
    posting.current = true;
    try {
      const response = await fetch("/api/tour", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: TOUR_VERSION, tenant }),
      });
      const result = await response.json();
      if (!response.ok || !result.signedIn || !result.done || result.tenant !== tenant || result.version !== TOUR_VERSION) throw new Error("Tour not saved");
      if (alive.current) {
        save({ ...state.current, pending: false });
        setSyncFailed(false);
      }
    } catch {
      if (alive.current) setSyncFailed(true);
    } finally {
      posting.current = false;
    }
  }, [tenant, save]);

  // ── WHAT DOES THIS BROWSER ALREADY KNOW ───────────────────────────────────
  //
  // Synchronously, before the first paint that could show anything. `done`
  // starts TRUE so the tour cannot flash for a returning visitor between mount
  // and this effect — the failure the old panel had, and the one the owner
  // asked to stop.
  useEffect(() => {
    alive.current = true;
    let local = readLocal(key);
    if (tenant) {
      const anonymous = readLocal(KEY);
      // One anonymous dismissal may be claimed by one account, not every
      // subsequent person signing in on a shared browser.
      if (anonymous?.done && !anonymous.claimed) {
        local = { ...(local ?? anonymous), done: true, pending: true, claimed: undefined };
        writeLocal(KEY, { ...anonymous, claimed: tenant });
      }
    }
    save(local ?? { done: false, step: 0 });
    setReady(true);
    void sync();
    const retry = () => { void sync(); };
    window.addEventListener("online", retry);
    return () => {
      alive.current = false;
      window.removeEventListener("online", retry);
    };
  }, [key, tenant, save, sync]);

  // ── AND WHAT DOES THE SERVER KNOW ─────────────────────────────────────────
  //
  // Only ever used to ADD a dismissal, never to take one away: `signedIn:false`
  // means "no opinion", and a store that will not answer says the same. Neither
  // may reopen a tour somebody already closed.
  useEffect(() => {
    if (!tenant) return;
    let current = true;
    fetch(`/api/tour?version=${TOUR_VERSION}&tenant=${encodeURIComponent(tenant)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((s: { done?: boolean; signedIn?: boolean; tenant?: string; version?: number } | null) => {
        if (!current || !s?.signedIn || !s.done || s.tenant !== tenant || s.version !== TOUR_VERSION) return;
        // Preserve replay: a late server dismissal must not close a tour the
        // viewer explicitly reopened.
        save({ ...state.current, done: true, pending: false });
        setSyncFailed(false);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [tenant, save]);

  const finish = useCallback(() => {
    save({ ...state.current, done: true, replay: false, pending: !!tenant });
    // Close immediately; acknowledgement is tracked separately for retry.
    void sync();
  }, [tenant, save, sync]);

  const goto = (next: number) => {
    save({ ...state.current, step: Math.max(0, Math.min(next, STOPS.length - 1)) });
  };

  // Resuming a stop after reload must navigate too. Callback changes from App
  // renders must not repeatedly navigate or overwrite the reader's draft.
  useEffect(() => {
      if (!ready || done) return;
      const stop = STOPS[step]!;
      if (stop.screen) callbacks.current.onScreen(stop.screen);
      if (stop.explore) callbacks.current.onExplore?.(stop.explore);
      // The chat draft is prepared ONCE, when the conversation stop is first
      // reached, so stepping back and forth does not overwrite something the
      // reader has since typed.
      if (step === 3 && !askedRef.current) {
        askedRef.current = true;
        callbacks.current.onQuestion();
      }
  }, [ready, done, step, layoutKey]);

  // ── MEASURE THE THING BEING POINTED AT ────────────────────────────────────
  //
  // After paint, and again on anything that can move it. A stop whose target is
  // missing or has no box — the tab bar is hidden on desktop — reports null and
  // the card centres itself instead.
  const target = ready && !done ? STOPS[step]?.target ?? null : null;
  // Serialised so the effect re-runs when the LIST changes, not when a new array
  // with the same contents is built by a re-render.
  const targetKey = target ? target.join("|") : "";
  useEffect(() => {
    if (!ready || done) return;
    let raf = 0;
    let previous = "";
    const measure = () => {
      const card = cardRef.current;
      if (card) {
        const vv = window.visualViewport;
        const viewport = { top: vv?.offsetTop ?? 0, left: vv?.offsetLeft ?? 0, width: vv?.width ?? window.innerWidth, height: vv?.height ?? window.innerHeight };
        const width = Math.min(380, Math.max(0, viewport.width - 24));
        const maxHeight = Math.max(0, viewport.height - 24);
        const spot = target ? visibleTourTarget(target, viewport) : null;
        const position = tourCardPosition(spot, { width, height: Math.min(card.offsetHeight, maxHeight) }, viewport);
        const next = { step, spot, ...position, width, maxHeight };
        const signature = JSON.stringify(next);
        if (signature !== previous) { previous = signature; setLayout(next); }
      }
      // Follow late mounts, font/data reflow and CSS animations as well as
      // scroll/resize. No React update occurs while geometry stays unchanged.
      raf = requestAnimationFrame(measure);
    };
    raf = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey, step, ready, done]);

  // Escape closes it, because a full-screen overlay that traps you is a bug.
  useEffect(() => {
    if (!ready || done) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const root = rootRef.current;
    const buttons = () => Array.from(root?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
    root?.focus({ preventScroll: true });
    const keepFocus = (e: FocusEvent) => {
      if (root && !root.contains(e.target as Node)) buttons()[0]?.focus({ preventScroll: true });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(); }
      if (e.key === "Tab") {
        const controls = buttons();
        const index = controls.indexOf(document.activeElement as HTMLButtonElement);
        e.preventDefault();
        controls[(index + (e.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus({ preventScroll: true });
      }
    };
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("focusin", keepFocus);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("focusin", keepFocus);
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [ready, done, finish]);

  if (!ready) return null;

  if (done) {
    return (
      <div className="tour-relaunch">
        {/*
          Beside the tour rather than inside Settings, which is five taps in
          behind an English label. A reader who cannot navigate there is exactly
          the reader the picker is for.
        */}
        <LanguagePicker />
        <button
          type="button"
          onClick={() => {
            askedRef.current = false;
            save({ ...state.current, replay: true, step: 0 });
          }}
        >
          <Compass size={14} />
          {t("tour.relaunch")}
        </button>
        {syncFailed && <span role="status">{t("tour.savedLocally")} <button type="button" onClick={() => void sync()}>{t("tour.retrySync")}</button></span>}
      </div>
    );
  }

  const stop = STOPS[step]!;
  const last = step === STOPS.length - 1;
  // Below the target when there is room, above it otherwise; centred with no
  // target at all. Clamped so the card can never sit off-screen on a phone.
  const measured = layout?.step === step ? layout : null;
  const spot = measured?.spot ?? null;
  const style: React.CSSProperties = measured
    ? { top: measured.top, left: measured.left, width: measured.width, maxHeight: measured.maxHeight }
    : { visibility: "hidden" };

  return (
    <div ref={rootRef} tabIndex={-1} className="tour-root" role="dialog" aria-modal="true" aria-label={t("tour.dialogLabel")}>
      {spot ? (
        <div
          className="tour-spot"
          style={{ top: spot.top - 6, left: spot.left - 6, width: spot.width + 12, height: spot.height + 12 }}
        />
      ) : (
        <div className="tour-scrim" />
      )}
      <section ref={cardRef} className="tour-card" style={style}>
        <header>
          {/*
            ON THE FIRST SCREEN, not behind it. The picker used to live only in
            the dismissed state, so the one reader it exists for had to get past
            twenty-six stops of English prose to reach the control that would
            have let them read any of it.
          */}
          <LanguagePicker />
          <span className="tour-count">
            {step + 1} / {STOPS.length}
          </span>
          <button type="button" className="tour-skip" onClick={finish}>
            {t("tour.skip")}
          </button>
        </header>
        <h2>{t(stop.titleKey)}</h2>
        <p>{t(stop.copyKey)}</p>
        <button type="button" className="tour-back" aria-expanded={topicsOpen} onClick={() => setTopicsOpen(v => !v)}>{t("tour.topics")}</button>
        {topicsOpen && <nav className="tour-topics" aria-label="Tutorial topics">{STOPS.map((topic, i) => <button type="button" key={topic.titleKey} aria-current={i === step ? "step" : undefined} onClick={() => { goto(i); setTopicsOpen(false); }}>{i + 1}. {t(topic.titleKey)}</button>)}</nav>}
        <footer>
          <span className="tour-buttons">
            <button type="button" className="tour-back" onClick={() => goto(step - 1)} disabled={step === 0}>
              {t("tour.back")}
            </button>
            <button type="button" className="tour-next" onClick={() => (last ? finish() : goto(step + 1))}>
              {last ? t("tour.finish") : t("tour.next")}
            </button>
          </span>
        </footer>
      </section>
    </div>
  );
}
