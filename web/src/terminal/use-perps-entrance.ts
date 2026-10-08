import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/** The server owns the once-only claim; browser storage never decides for another device. */
export function perpsEntranceOwner(session: { hosted: boolean; address: string | null } | null): string | null {
  if (!session) return null;
  return session.hosted ? session.address?.toLowerCase() ?? null : "local";
}

export function usePerpsEntrance(owner: string | null) {
  const currentOwner = useRef(owner);
  const request = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const [pending, setPending] = useState(false);
  const [playingFor, setPlayingFor] = useState<string | null>(null);

  useLayoutEffect(() => {
    currentOwner.current = owner;
    request.current?.abort();
    request.current = null;
    setPending(false);
    setPlayingFor(null);
  }, [owner]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; request.current?.abort(); request.current = null; };
  }, []);

  const cancelPending = useCallback(() => {
    request.current?.abort();
    request.current = null;
    setPending(false);
  }, []);
  const finish = useCallback(() => setPlayingFor(null), []);
  const enter = useCallback(async (navigate: () => void) => {
    if (request.current) return;
    // A visitor/loading session has no durable identity. Navigation still works.
    if (!owner) { navigate(); return; }
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    const timeout = globalThis.setTimeout(() => controller.abort(), 1800);
    let play = false;
    try {
      const response = await fetch("/api/perps/intro", {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ owner }), signal: controller.signal,
      });
      const claim: unknown = response.ok ? await response.json() : null;
      play = !!claim && typeof claim === "object" && "owner" in claim && claim.owner === owner && "play" in claim && claim.play === true;
    } catch { /* An unavailable preference must never trap the user on Spot. */ }
    finally { globalThis.clearTimeout(timeout); }
    if (!mounted.current || currentOwner.current !== owner || request.current !== controller) return;
    request.current = null;
    setPending(false);
    if (play && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) setPlayingFor(owner);
    navigate();
  }, [owner]);

  return { enter, pending, playing: playingFor !== null && playingFor === owner, finish, cancelPending };
}
