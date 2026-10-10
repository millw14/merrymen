"use client";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
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
 * focused one, which is the button's own behaviour. Tab stays inside the
 * dialog. A click that starts and finishes on the backdrop closes it too.
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
  const dialog = useRef<HTMLDialogElement>(null);
  const backdropPress = useRef<"none" | "pressed" | "released">("none");
  // Capture before Search's autofocus runs during the commit. Capturing in
  // the effect can mistake the search input for the button that opened it.
  const [opener] = useState(() => typeof document === "undefined" ? null : document.activeElement);
  useEffect(() => {
    const node = dialog.current!;
    const was = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // A real modal makes the rest of the document inert, including controls
    // in the portfolio and wallet beneath this overlay.
    node.showModal();
    node.querySelector<HTMLInputElement>("input.search")?.focus({ preventScroll: true });
    return () => {
      node.close();
      document.body.style.overflow = was;
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, [opener]);
  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    const root = dialog.current;
    if (!root) return;
    if (event.key === "Tab") {
      // Search's full-page Back button is hidden in this presentation. The
      // visible close control remains reachable even when there are no hits.
      const controls = [...root.querySelectorAll<HTMLElement>(".search-dialog-close, input.search, button.tok")];
      const at = controls.indexOf(document.activeElement as HTMLElement);
      const next = at < 0 ? (event.shiftKey ? controls.length - 1 : 0)
        : (at + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
      controls[next]?.focus();
      event.preventDefault();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = [...root.querySelectorAll<HTMLElement>(".tok, input.search")];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    const next = event.key === "ArrowDown" ? Math.min(items.length - 1, at + 1) : Math.max(0, at - 1);
    items[next]?.focus();
    event.preventDefault();
  };
  return (
    <dialog ref={dialog} className="search-dialog-backdrop" aria-label="Search tokens or agents" onKeyDown={onKeyDown}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onPointerDown={(event) => { backdropPress.current = event.target === event.currentTarget ? "pressed" : "none"; }}
      onPointerUp={(event) => {
        backdropPress.current = backdropPress.current === "pressed" && event.target === event.currentTarget ? "released" : "none";
      }}
      onPointerCancel={() => { backdropPress.current = "none"; }}
      onClick={(event) => {
        const dismiss = backdropPress.current === "released" && event.target === event.currentTarget;
        backdropPress.current = "none";
        if (dismiss) onClose();
      }}>
      <div className="search-dialog">
        <button type="button" className="search-dialog-close" onClick={onClose}>Close search</button>
        <Search tokens={tokens} agents={agents} onBack={onClose} onToken={onToken} onProfile={onProfile} />
        <p className="search-dialog-keys" aria-hidden="true">
          <kbd>↑↓</kbd> move <kbd>↵</kbd> open <kbd>esc</kbd> close
        </p>
      </div>
    </dialog>
  );
}
