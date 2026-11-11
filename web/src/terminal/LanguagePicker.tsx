"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Languages } from "lucide-react";

import { SUPPORTED, currentLocale, setLocale, type LocaleTag } from "@/lib/locale";
import { useT } from "@/lib/i18n";

/**
 * THE CONTROL THAT HAS TO BE FINDABLE WITHOUT READING THE APP.
 *
 * A language picker labelled "Language" is no use to the person who needs it:
 * the whole premise is that they cannot read the interface it sits in. So the
 * trigger is an ICON, the list is written in EACH LANGUAGE'S OWN NAME, and
 * nothing in either depends on knowing English.
 *
 * Endonyms rather than English names for the same reason. "Russian" is a word
 * in a language the reader is trying to leave; "Русский" is the one they are
 * looking for, and they can find it without knowing what the list is for.
 *
 * It sits in the persistent chrome beside the tour relaunch rather than inside
 * Settings, which is five taps in behind an English label — and a reader who
 * cannot navigate there is precisely the reader this is for.
 *
 * WHAT THIS COVERS: choosing a language switches the typeface and the document
 * language at once, and every string the message catalogue holds follows. What
 * the catalogue does not hold yet stays in English — see `web/src/lib/messages`
 * for the per-locale count.
 *
 * WHY THE MENU IS A PORTAL. The list used to render inside this div, positioned
 * absolute. Both of its homes — the tour card and the relaunch strip — sit in
 * scroll boxes, and `overflow` clips absolutely-positioned children whatever
 * their z-index, so on wide screens the list opened into nothing: it rendered
 * above the card's top edge and the card cut it off. The list now renders into
 * `document.body`, pinned to the viewport beside its trigger, which no ancestor
 * can clip.
 */
export function LanguagePicker() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [tag, setTag] = useState<LocaleTag>("en");
  // Viewport-pinned position of the floating list, measured from the trigger
  // at open time. Null until the first open so server and first client paint
  // agree (no `document` read during render).
  const [menuPos, setMenuPos] = useState<{ top?: number; bottom?: number; left: number; maxHeight: number } | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const menu = useRef<HTMLUListElement | null>(null);

  // Read after mount: the boot script in the layout has already corrected
  // `html[lang]` by now, and reading it during render would disagree with what
  // the server sent.
  useEffect(() => setTag(currentLocale()), []);

  const toggle = () => {
    if (!open && trigger.current) {
      // Anchor to the trigger's viewport box, flipping to whichever side has
      // room. The tour header sits at the card's top edge, so on desktop the
      // list opens upward into free viewport; near the viewport bottom it
      // opens downward instead of running off-screen.
      const r = trigger.current.getBoundingClientRect();
      const openUp = r.top >= window.innerHeight - r.bottom;
      const gap = 8;
      const avail = Math.max(160, (openUp ? r.top : window.innerHeight - r.bottom) - gap - 8);
      setMenuPos({
        ...(openUp ? { bottom: window.innerHeight - r.top + gap } : { top: r.bottom + gap }),
        left: Math.max(8, Math.min(r.left, window.innerWidth - 226)),
        maxHeight: Math.min(Math.round(avail), Math.round(window.innerHeight * 0.6)),
      });
    }
    setOpen((o) => !o);
  };

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      // The list lives in a portal, outside `box` — both count as inside.
      const el = e.target as Node;
      if (box.current?.contains(el)) return;
      if (menu.current?.contains(el)) return;
      setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open ]);

  const choose = (next: LocaleTag) => {
    setLocale(next);
    setTag(next);
    setOpen(false);
  };

  const current = SUPPORTED.find((l) => l.tag === tag) ?? SUPPORTED[0];

  return (
    <div className="lang-picker" ref={box}>
      <button
        type="button"
        ref={trigger}
        className="lang-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        // The accessible name, which a screen reader announces rather than the
        // eye reading it. Translated like everything else — a blind reader in
        // Bangkok has the same problem as a sighted one and fewer ways round it.
        aria-label={t("lang.choose")}
        onClick={toggle}
      >
        <Languages size={14} aria-hidden />
        <span>{current.endonym}</span>
      </button>
      {open &&
        menuPos &&
        typeof document !== "undefined" &&
        createPortal(
          // The wrapper re-enters the terminal scope so the list keeps its
          // card styling outside the component tree it visually escaped.
          <div className="terminal-host">
            <ul
              className="lang-menu lang-menu-floating"
              role="listbox"
              aria-label="Language"
              ref={menu}
              style={{
                top: menuPos.top,
                bottom: menuPos.bottom,
                left: menuPos.left,
                maxHeight: menuPos.maxHeight,
              }}
            >
              {SUPPORTED.map((l) => (
                <li key={l.tag}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={l.tag === tag}
                    // `lang` on each row so the browser picks that language's face
                    // for its own name — otherwise 中文 and Русский render in the
                    // stack of whatever language the reader is currently in.
                    lang={l.tag}
                    className={l.tag === tag ? "on" : undefined}
                    onClick={() => choose(l.tag)}
                  >
                    <span className="lang-endonym">{l.endonym}</span>
                    <span className="lang-english">{l.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>,
          document.body,
        )}
    </div>
  );
}
