"use client";

import { useEffect, useRef, useState } from "react";
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
 * WHAT THIS DOES NOT DO YET, and says so: choosing a language switches the
 * TYPEFACE and the document language. The interface copy is still English
 * until the message catalogue lands. Showing the list now is deliberate — the
 * fonts are what a reader cannot fix for themselves, and a picker that admits
 * what it covers is better than one that implies more than it does.
 */
export function LanguagePicker() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [tag, setTag] = useState<LocaleTag>("en");
  const box = useRef<HTMLDivElement | null>(null);

  // Read after mount: the boot script in the layout has already corrected
  // `html[lang]` by now, and reading it during render would disagree with what
  // the server sent.
  useEffect(() => setTag(currentLocale()), []);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
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
  }, [open]);

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
        className="lang-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        // The accessible name, which a screen reader announces rather than the
        // eye reading it. Translated like everything else — a blind reader in
        // Bangkok has the same problem as a sighted one and fewer ways round it.
        aria-label={t("lang.choose")}
        onClick={() => setOpen((o) => !o)}
      >
        <Languages size={14} aria-hidden />
        <span>{current.endonym}</span>
      </button>
      {open && (
        <ul className="lang-menu" role="listbox" aria-label="Language">
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
      )}
    </div>
  );
}
