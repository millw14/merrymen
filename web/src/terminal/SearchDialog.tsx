"use client";
import { useEffect, useRef, type KeyboardEvent } from "react";
import type { LiveAgent, LiveToken } from "./live";
import { Search } from "./screens/Search";

/**
 * SEARCH AS A POP-UP, OVER WHATEVER IS ON SCREEN.
 *
 * The search screen is unchanged (screens/Search.tsx) and /search still
 * renders it full-page; this wraps the same component in a dialog so the
 * header's search, the "/" key and the phone's search icon open it in place,
 * with the page the reader was on still under it. Picking a result closes it
 * and enters that screen (App.tsx), so Back returns to where they were.
 *
 * Keys: Escape closes; Up and Down move between results; Enter opens the
 * focused one, which is the button's own behaviour. A click on the backdrop
 * closes it too.
 */
export function SearchDialog({
  tokens,
  agents,
  onClose,
  onToken,
  onProfile,
}: {
  tokens: LiveToken[];
  agents: LiveAgent[];
  onClose: () => void;
  onToken: (id: string) => void;
  onProfile: (slug: string) => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  // The page under it must not scroll while it is open.
  useEffect(() => {
    const was = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = was; };
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const root = panel.current;
    if (!root) return;
    const items = [...root.querySelectorAll<HTMLElement>(".tok, input.search")];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "ArrowDown" ? Math.min(items.length - 1, at + 1) : Math.max(0, at - 1);
    items[next]?.focus();
    event.preventDefault();
  };
  return (
    <div className="search-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={panel} className="search-dialog" role="dialog" aria-modal="true" aria-label="Search tokens or agents" onKeyDown={onKeyDown}>
        <Search tokens={tokens} agents={agents} onBack={onClose} onToken={onToken} onProfile={onProfile} />
        <p className="search-dialog-keys" aria-hidden="true">
          <kbd>↑↓</kbd> move <kbd>↵</kbd> open <kbd>esc</kbd> close
        </p>
      </div>
    </div>
  );
}
