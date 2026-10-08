import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { freezeModeScene, type FrozenModeScene } from "./mode-transition-snapshot";

/** The server owns the once-only claim; browser storage never decides for another device. */
export function perpsEntranceOwner(session: { hosted: boolean; address: string | null } | null): string | null {
  if (!session) return null;
  return session.hosted ? session.address?.toLowerCase() ?? null : "local";
}

type ModeTransition = {
  owner: string | null;
  direction: "spot" | "perps";
  dramatic: boolean;
  fromPath: string;
  targetPath: string;
  scene: FrozenModeScene;
};

/** Freeze only the outgoing pixels' DOM; the destination remains the one live app. */
export function usePerpsEntrance(owner: string | null, pathname: string, source: RefObject<HTMLDivElement | null>) {
  const currentOwner = useRef(owner);
  const currentPath = useRef(pathname);
  const request = useRef<AbortController | null>(null);
  const active = useRef<ModeTransition | null>(null);
  const deadline = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
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
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current?.abort();
      request.current = null;
      releaseScene();
    };
  }, [releaseScene]);

  const switchMode = useCallback((direction: "spot" | "perps", dramatic: boolean, navigate: () => void) => {
    if (active.current) return;
    if (!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches && source.current) {
      try {
        const next: ModeTransition = {
          owner, direction, dramatic, fromPath: currentPath.current,
          targetPath: direction === "perps" ? "/perps" : "/",
          scene: freezeModeScene(source.current),
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
    if (!owner) { switchMode("perps", false, navigate); return; }
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
    switchMode("perps", dramatic, navigate);
  }, [owner, switchMode]);

  const leave = useCallback((navigate: () => void) => {
    cancelPending();
    switchMode("spot", false, navigate);
  }, [cancelPending, switchMode]);

  const visible = transition?.owner === owner ? transition : null;
  return {
    enter, leave, pending, transition: visible,
    ready: visible !== null && pathname === visible.targetPath,
    finish, cancelPending,
  };
}
