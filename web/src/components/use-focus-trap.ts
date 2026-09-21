import { useEffect } from "react";

/**
 * Keyboard containment for modal overlays that declare aria-modal.
 * Same behavior as FirstVisit's tour card, extracted so it is unit-testable
 * (and so the next dialog doesn't reinvent it a third time):
 * focus moves inside on open, Tab/Shift+Tab cycles the dialog's controls,
 * stray focus is pulled back, Escape dismisses, and the previously focused
 * element is restored on close. Without this, keyboard users operate
 * obscured controls behind the backdrop.
 */
export function useFocusTrap(
  rootRef: { current: HTMLElement | null },
  active: boolean,
  onDismiss: () => void,
  selector = "button:not(:disabled), a[href]",
): void {
  useEffect(() => {
    if (!active || typeof document === "undefined") return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const controls = () =>
      Array.from(rootRef.current?.querySelectorAll<HTMLElement>(selector) ?? []);
    rootRef.current?.focus({ preventScroll: true });
    const keepFocus = (e: FocusEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        controls()[0]?.focus({ preventScroll: true });
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onDismiss();
        return;
      }
      if (e.key === "Tab") {
        const items = controls();
        if (items.length === 0) return;
        const index = items.indexOf(document.activeElement as HTMLElement);
        e.preventDefault();
        items[(index + (e.shiftKey ? -1 : 1) + items.length) % items.length]?.focus({ preventScroll: true });
      }
    };
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("focusin", keepFocus);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("focusin", keepFocus);
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [active, onDismiss, rootRef, selector]);
}
