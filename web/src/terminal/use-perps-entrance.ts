import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { freezeModeScene, type FrozenModeScene } from "./mode-transition-snapshot";

/** The server owns the once-only claim; browser storage never decides for another device. */
export function perpsEntranceOwner(session: { hosted: boolean; address: string | null } | null): string | null {
  if (!session) return null;
  return session.hosted ? session.address?.toLowerCase() ?? null : "local";
}

type Point = { x: number; y: number };

type ModeTransition = {
  owner: string | null;
  direction: "spot" | "perps";
  dramatic: boolean;
  fromPath: string;
  targetPath: string;
  scene: FrozenModeScene;
  /** Where the switch was asked for, in viewport pixels; the armour pours from here. */
  origin: Point | null;
};

/** A press older than this did not ask for the switch. */
const PRESS_WINDOW_MS = 1500;

/** Freeze only the outgoing pixels' DOM; the destination remains the one live app. */
export function usePerpsEntrance(owner: string | null, pathname: string, source: RefObject<HTMLDivElement | null>) {
  const currentOwner = useRef(owner);
  const currentPath = useRef(pathname);
  const request = useRef<AbortController | null>(null);
  const active = useRef<ModeTransition | null>(null);
  const deadline = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  const lastPress = useRef<{ x: number; y: number; at: number } | null>(null);
  const [pending, setPending] = useState(false);
  const [transition, setTransition] = useState<ModeTransition | null>(null);

  const releaseScene = useCallback(() => {
    if (deadline.current !== null) globalThis.clearTimeout(deadline.current);
    deadline.current = null;
    active.current?.scene.dispose();
    active.current = null;
  }, []);
  const finish = useCallback(() => {
    releaseScene();
    setTransition(null);
  }, [releaseScene]);
  const cancelPending = useCallback(() => {
    request.current?.abort();
    request.current = null;
    setPending(false);
  }, []);

  useLayoutEffect(() => {
    currentOwner.current = owner;
    cancelPending();
    finish();
  }, [owner, cancelPending, finish]);
  useLayoutEffect(() => {
    const previous = currentPath.current;
    currentPath.current = pathname;
    if (previous === pathname) return;
    cancelPending();
    // A different navigation or browser Back wins over the frozen scene.
    const scene = active.current;
    if (scene && pathname !== scene.targetPath) finish();
    else if (scene && deadline.current !== null) {
      // Once the real destination commits, its playback timer owns completion.
      // A slow route must still receive the entire first-visit reveal.
      globalThis.clearTimeout(deadline.current);
      deadline.current = null;
    }
  }, [pathname, cancelPending, finish]);
  useEffect(() => {
    // Capture phase: a toggle that stops propagation still tells us where it was pressed.
    const press = (event: PointerEvent) => { lastPress.current = { x: event.clientX, y: event.clientY, at: performance.now() }; };
    window.addEventListener("pointerdown", press, true);
    return () => window.removeEventListener("pointerdown", press, true);
  }, []);
  /** Read at the moment of the request, before any claim is awaited. */
  const switchOrigin = useCallback((): Point | null => {
    const recent = lastPress.current;
    if (recent && performance.now() - recent.at < PRESS_WINDOW_MS && Number.isFinite(recent.x) && Number.isFinite(recent.y)) return { x: recent.x, y: recent.y };
    // A keyboard switch: pour from the focused toggle button.
    const focused = document.activeElement;
    if (focused?.closest(".trading-mode-toggle")) {
      const box = focused.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    }
    return null;
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current?.abort();
      request.current = null;
      releaseScene();
    };
  }, [releaseScene]);

  const switchMode = useCallback((direction: "spot" | "perps", dramatic: boolean, origin: Point | null, navigate: () => void) => {
    if (active.current) return;
    if (!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches && source.current) {
      try {
        const next: ModeTransition = {
          owner, direction, dramatic, fromPath: currentPath.current,
          targetPath: direction === "perps" ? "/perps" : "/",
          scene: freezeModeScene(source.current),
          origin,
        };
        active.current = next;
        setTransition(next);
        // A stalled route must never leave a frozen trading screen covering the app.
        deadline.current = globalThis.setTimeout(finish, 7000);
      } catch (error) {
        // Visual effects are optional; navigation must still work.
        if (process.env.NODE_ENV === "development") console.warn("Mode transition unavailable", error);
      }
    }
    try { navigate(); } catch (error) { finish(); throw error; }
  }, [owner, source, finish]);

  const enter = useCallback(async (navigate: () => void) => {
    if (request.current || active.current) return;
    const origin = switchOrigin();
    if (!owner) { switchMode("perps", false, origin, navigate); return; }
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    const timeout = globalThis.setTimeout(() => controller.abort(), 1800);
    let dramatic = false;
    try {
      const response = await fetch("/api/perps/intro", {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ owner }), signal: controller.signal,
      });
      const claim: unknown = response.ok ? await response.json() : null;
      dramatic = !!claim && typeof claim === "object" && "owner" in claim && claim.owner === owner && "play" in claim && claim.play === true;
    } catch { /* An unavailable preference must never trap the user on Spot. */ }
    finally { globalThis.clearTimeout(timeout); }
    if (!mounted.current || currentOwner.current !== owner || request.current !== controller) return;
    request.current = null;
    setPending(false);
    switchMode("perps", dramatic, origin, navigate);
  }, [owner, switchMode, switchOrigin]);

  const leave = useCallback((navigate: () => void) => {
    const origin = switchOrigin();
    cancelPending();
    switchMode("spot", false, origin, navigate);
  }, [cancelPending, switchMode, switchOrigin]);

  const visible = transition?.owner === owner ? transition : null;
  return {
    enter, leave, pending, transition: visible,
    ready: visible !== null && pathname === visible.targetPath,
    finish, cancelPending,
  };
}
