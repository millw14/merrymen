/**
 * WHERE AN OWNER'S CHOICE OF OUTFIT LIVES.
 *
 * In this browser, keyed by the agent's public slug — a cosmetic, so it does
 * not go through the settings PUT that carries an agent's trading rules, and a
 * wardrobe click can never be what wedges a save of those. Every other agent
 * wears its seeded look (outfit.ts `seededOutfit`), which is deterministic, so
 * a viewer who has never dressed anybody still sees the same Sherwood as
 * everyone else.
 *
 * `draft` is the merryman being dressed before an agent exists: the create
 * flow dresses it first and `adoptDraft` hands it to the new slug once there is
 * one.
 *
 * Every read and write is wrapped: storage can be disabled, full, or throw in a
 * private window, and a wardrobe that cannot save still has to dress.
 */
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { parseOutfit, seededOutfit, type Outfit } from "./outfit";

export const DRAFT = "draft";
const PREFIX = "merryman.outfit.v1:";
const EVENT = "merryman-outfit";

const keyOf = (id: string) => `${PREFIX}${id}`;

function read(id: string): string | null {
  try {
    return window.localStorage.getItem(keyOf(id));
  } catch {
    return null;
  }
}

export function loadOutfit(id: string): Outfit | null {
  if (typeof window === "undefined") return null;
  const raw = read(id);
  if (!raw) return null;
  try {
    return parseOutfit(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function saveOutfit(id: string, outfit: Outfit): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(keyOf(id), JSON.stringify(parseOutfit(outfit)));
    window.dispatchEvent(new CustomEvent(EVENT, { detail: id }));
    return true;
  } catch {
    return false;
  }
}

export function clearOutfit(id: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(keyOf(id));
    window.dispatchEvent(new CustomEvent(EVENT, { detail: id }));
  } catch {
    /* nothing to clear */
  }
}

/** The draft from the create flow becomes this agent's look, if it has none yet. */
export function adoptDraft(slug: string): void {
  const draft = loadOutfit(DRAFT);
  if (draft && !loadOutfit(slug)) saveOutfit(slug, draft);
}

function subscribe(onChange: () => void) {
  const on = () => onChange();
  window.addEventListener("storage", on);
  window.addEventListener(EVENT, on);
  return () => {
    window.removeEventListener("storage", on);
    window.removeEventListener(EVENT, on);
  };
}

/**
 * The outfit for an agent, and a setter that saves it.
 *
 * `id` is whose wardrobe this is (a slug, or DRAFT); `seed` is what to seed the
 * default look on when nothing has been saved — usually the same slug, or the
 * name for an agent that has none. `custom` says whether the owner chose it.
 */
export function useOutfit(id: string | null, seed: string): { outfit: Outfit; custom: boolean; save(o: Outfit): boolean; reset(): void } {
  const raw = useSyncExternalStore(
    subscribe,
    () => (id ? read(id) : null),
    () => null,
  );
  const outfit = useMemo(() => {
    if (raw) {
      try {
        return parseOutfit(JSON.parse(raw));
      } catch {
        /* fall through to the seeded look */
      }
    }
    return seededOutfit(seed);
  }, [raw, seed]);
  const save = useCallback((o: Outfit) => (id ? saveOutfit(id, o) : false), [id]);
  const reset = useCallback(() => { if (id) clearOutfit(id); }, [id]);
  return { outfit, custom: raw !== null, save, reset };
}
