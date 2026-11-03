import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { goTo } from "./navigate";
import type { FrozenModeScene } from "./mode-transition-snapshot";

type Mode = "spot" | "perps";
type Point = { x: number; y: number };
type Visuals = typeof import("./PerpsEntrance");
const loadVisuals = () => import("./PerpsEntrance");
export const MODE_LOAD_TIMEOUT = 1800;
export const MODE_TRANSITION_TIMEOUT = 7000;

/** Compare query values using App's URLSearchParams encoding, not URL spelling. */
function comparableRoute(route: string): string {
  const queryAt = route.indexOf("?");
  if (queryAt < 0) return route;
  const pathname = route.slice(0, queryAt);
  const query = new URLSearchParams(route.slice(queryAt + 1)).toString();
  return `${pathname}${query ? `?${query}` : ""}`;
}

type Transition = {
  Entrance: Visuals["PerpsEntrance"];
  scene: FrozenModeScene | null;
  direction: Mode;
  origin: Point | null;
  targetPath: string;
  finish: () => void;
};

/** Visual navigation only. No account request, intro claim, permission or trade. */
export function useTradingModeTransition({ identity, route, mode, offered, source, load = loadVisuals, navigate = goTo }: {
  identity: string;
  route: string;
  mode: Mode;
  offered: boolean;
  source: RefObject<HTMLDivElement | null>;
  load?: () => Promise<Visuals>;
  navigate?: (path: string) => void;
}) {
  const routeKey = comparableRoute(route);
  const mounted = useRef(false);
  const generation = useRef(0);
  const current = useRef({ identity, route: routeKey, mode, offered });
  const active = useRef<Transition | null>(null);
  const request = useRef<object | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pending, setPending] = useState(false);
  const [transition, setTransition] = useState<Transition | null>(null);

  const clearTimer = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const cancel = useCallback(() => {
    generation.current++;
    request.current = null;
    clearTimer();
    active.current?.scene?.dispose();
    active.current = null;
    if (mounted.current) { setPending(false); setTransition(null); }
  }, [clearTimer]);

  useLayoutEffect(() => {
    mounted.current = true;
    const back = () => cancel();
    window.addEventListener("popstate", back);
    return () => {
      mounted.current = false;
      window.removeEventListener("popstate", back);
      cancel();
    };
  }, [cancel]);
  useLayoutEffect(() => {
    const previous = current.current;
    current.current = { identity, route: routeKey, mode, offered };
    if (previous.identity !== identity || !offered ||
      (previous.route !== routeKey && (!active.current || active.current.targetPath !== routeKey))) cancel();
  }, [identity, routeKey, mode, offered, cancel]);

  const change = useCallback((direction: Mode, origin: Point | null = null) => {
    if (!mounted.current || !current.current.offered || direction === current.current.mode || request.current || active.current) return;
    const targetPath = direction === "perps" ? "/perps" : "/home";
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) { navigate(targetPath); return; }
    const turn = generation.current;
    const from = current.current.route;
    const token = {};
    request.current = token;
    setPending(true);
    const valid = () => mounted.current && generation.current === turn && request.current === token &&
      current.current.offered && current.current.route === from && comparableRoute(`${window.location.pathname}${window.location.search}`) === from;
    const fallback = () => {
      const mayNavigate = valid();
      if (request.current !== token) return;
      cancel();
      if (mayNavigate) { try { navigate(targetPath); } catch { /* Leave the current view usable. */ } }
    };
    // A blocked chunk cannot trap navigation, nor later resurrect an old press.
    timer.current = setTimeout(fallback, MODE_LOAD_TIMEOUT);
    void Promise.resolve().then(load).then(visuals => {
      if (!valid()) { fallback(); return; }
      if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || !source.current) { fallback(); return; }
      let scene: FrozenModeScene | null = null;
      // Never duplicate recovery material, permission reviews or typed forms.
      const snapshotSafe = ["/", "/home", "/perps"].includes(from.split("?", 1)[0]!);
      try { if (snapshotSafe) scene = visuals.freezeModeScene(source.current); }
      catch { fallback(); return; }
      clearTimer();
      request.current = null;
      const next: Transition = {
        Entrance: visuals.PerpsEntrance, scene, direction, origin, targetPath,
        finish: () => { if (active.current === next) cancel(); },
      };
      active.current = next;
      setPending(false);
      setTransition(next);
      // Kept even if the destination commits: a failed canvas or stalled route
      // can never leave the app frozen indefinitely.
      timer.current = setTimeout(next.finish, MODE_TRANSITION_TIMEOUT);
      try { navigate(targetPath); } catch { next.finish(); }
    }, fallback);
  }, [cancel, clearTimer, load, navigate, source]);

  return { change, cancel, pending, transition, ready: transition !== null && routeKey === transition.targetPath };
}
