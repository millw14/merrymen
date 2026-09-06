import { useSyncExternalStore } from "react";

const KEY = "merrymen.watchlist";
const EVENT = "merrymen-watchlist-change";
function snapshot() {
  try { return localStorage.getItem(KEY) ?? "[]"; } catch { return "[]"; }
}
function subscribe(update: () => void) {
  window.addEventListener("storage", update);
  window.addEventListener(EVENT, update);
  return () => { window.removeEventListener("storage", update); window.removeEventListener(EVENT, update); };
}
export function useWatchlist() {
  const raw = useSyncExternalStore(subscribe, snapshot, () => "[]");
  let ids: string[] = [];
  try { const parsed: unknown = JSON.parse(raw); if(Array.isArray(parsed)) ids = parsed.filter((id): id is string => typeof id === "string"); } catch {}
  return { ids, toggle(id: string) {
    localStorage.setItem(KEY, JSON.stringify(ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id]));
    window.dispatchEvent(new Event(EVENT));
  }};
}
