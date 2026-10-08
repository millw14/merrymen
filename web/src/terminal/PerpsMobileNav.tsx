import { useRef, useSyncExternalStore } from "react";

export type PerpsMobileView = "trade" | "positions" | "feed" | "account";
const VIEWS = ["trade", "positions", "feed", "account"] as const;
const LABELS = { trade: "Trade", positions: "Positions", feed: "Feed", account: "Account" };
const MOBILE_QUERY = "(max-width: 1099px)";
const mobileSnapshot = () => typeof window.matchMedia === "function" && window.matchMedia(MOBILE_QUERY).matches;
function subscribeMobile(notify: () => void) {
  if (typeof window.matchMedia !== "function") return () => {};
  const media = window.matchMedia(MOBILE_QUERY);
  media.addEventListener("change", notify);
  return () => media.removeEventListener("change", notify);
}
export function usePerpsMobile() {
  return useSyncExternalStore(subscribeMobile, mobileSnapshot, () => false);
}

function DockSymbol({ view }: { view: PerpsMobileView }) {
  return <svg width="23" height="23" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
    {view === "trade" ? <><circle cx="14" cy="14" r="9" /><circle cx="14" cy="14" r="3" /><path d="M14 1v5m0 16v5M1 14h5m16 0h5m-8-8 7-7" /><circle cx="20.5" cy="7.5" r="2" fill="currentColor" stroke="none" /></> : view === "positions" ? <><path d="M3 22h22M7 17V8m7 11V3m7 14V9" /><path d="M4 11h6v6H4zm7-4h6v7h-6zm7 5h6v5h-6z" fill="currentColor" stroke="none" /></> : view === "account" ? <><circle cx="14" cy="9" r="4"/><path d="M5 25v-3a9 9 0 0 1 18 0v3M3 3h4M21 3h4"/></> : <><path d="m4 6 9-2 11 3v18l-11-3-9 2V6Z" /><path d="M13 4v18M7 10l3-1m-3 5 3-1m6-4 5 2m-5 3 5 2" /><path d="m16 19 2-2 3 1" /></>}
  </svg>;
}

/** Display navigation only: no trading actions, account reads or persisted state. */
export function PerpsMobileNav({ view, onChange, idPrefix, positionCount, positionStatus, attention }: {
  view: PerpsMobileView; onChange: (view: PerpsMobileView) => void; idPrefix: string;
  positionCount: number | null; positionStatus: string; attention: boolean;
}) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  return <nav className="perps-mobile-dock" aria-label="Perpetuals desk sections">
    <div className="perps-dock-tabs" role="tablist" aria-label="Desk view" data-active={view}>
      <span className="perps-dock-glass" aria-hidden="true" />
      {VIEWS.map((item, index) => <button key={item} ref={(button) => { buttons.current[index] = button; }} type="button" role="tab" id={`${idPrefix}-tab-${item}`} aria-controls={`${idPrefix}-panel-${item}`} aria-selected={view === item} aria-label={item === "positions" ? `Positions · ${positionStatus}` : LABELS[item]} tabIndex={view === item ? 0 : -1} onClick={() => onChange(item)} onKeyDown={(event) => {
        const next = event.key === "ArrowRight" ? (index + 1) % VIEWS.length : event.key === "ArrowLeft" ? (index + VIEWS.length - 1) % VIEWS.length : event.key === "Home" ? 0 : event.key === "End" ? VIEWS.length - 1 : null;
        if (next === null) return;
        event.preventDefault();
        onChange(VIEWS[next]!);
        buttons.current[next]?.focus();
      }}>
        <span className="perps-dock-symbol"><DockSymbol view={item} />{item === "positions" ? <span className={`perps-dock-count${attention ? " needs-attention" : ""}`} aria-hidden="true">{positionCount ?? "?"}</span> : null}</span>
        <span>{LABELS[item]}</span>
      </button>)}
    </div>
  </nav>;
}
