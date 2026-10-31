"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { requestJson } from "../terminal/request-json";
import { PILOT_URL, parsePilotAccess, pilotError, readPilotSession, type PilotAccess } from "./pilot-client";

/** All private replies identify the login. A mutation also rechecks the session
 * immediately before its POST; the server checks expectedTenant independently. */
export function usePilotAccess() {
  const [view, setView] = useState<{ state: "loading" | "signed-out" | "ready" | "error"; access: PilotAccess | null; error: string }>({ state: "loading", access: null, error: "" });
  const mounted = useRef(false), generation = useRef(0), serial = useRef(0);
  const current = useRef<PilotAccess | null>(null), controller = useRef<AbortController | null>(null);
  const invalidate = useCallback(() => {
    generation.current++; serial.current++; controller.current?.abort(); current.current = null;
    if (mounted.current) setView({ state: "loading", access: null, error: "" });
  }, []);
  const load = useCallback(async () => {
    const id = ++serial.current;
    controller.current?.abort(); const pending = new AbortController(); controller.current = pending;
    const live = () => mounted.current && id === serial.current && !pending.signal.aborted;
    try {
      const tenant = await readPilotSession(pending.signal);
      if (!live()) return;
      if (tenant !== current.current?.tenant) { generation.current++; current.current = null; setView({ state: "loading", access: null, error: "" }); }
      if (!tenant) { setView({ state: "signed-out", access: null, error: "" }); return; }
      const access = parsePilotAccess(await requestJson(PILOT_URL, { signal: pending.signal }));
      const after = await readPilotSession(pending.signal);
      if (!live()) return;
      if (after !== tenant || access.tenant !== tenant) throw new Error("Your signed-in account changed. Refresh before continuing.");
      if (current.current && (current.current.status !== access.status || current.current.admin !== access.admin)) generation.current++;
      current.current = access; setView({ state: "ready", access, error: "" });
    } catch (error) {
      if (!live()) return;
      generation.current++; current.current = null;
      setView({ state: "error", access: null, error: pilotError(error) });
    }
  }, []);
  const refresh = useCallback(() => { invalidate(); void load(); }, [invalidate, load]);
  useEffect(() => {
    mounted.current = true; void load();
    const focus = () => refresh();
    const visible = () => { if (!document.hidden) refresh(); };
    window.addEventListener("focus", focus); document.addEventListener("visibilitychange", visible);
    const timer = setInterval(() => { if (!document.hidden) void load(); }, 15_000);
    return () => { mounted.current = false; generation.current++; controller.current?.abort(); clearInterval(timer); window.removeEventListener("focus", focus); document.removeEventListener("visibilitychange", visible); };
  }, [load, refresh]);
  const guard = useCallback((tenant: string) => {
    const started = generation.current;
    const assertCurrent = () => {
      if (!mounted.current || started !== generation.current || current.current?.tenant !== tenant) throw new Error("Your account changed. Nothing further was submitted; refresh before continuing.");
    };
    return { assertCurrent, verify: async () => {
      assertCurrent(); const fresh = await readPilotSession(); assertCurrent();
      if (fresh !== tenant) { invalidate(); void load(); throw new Error("Your signed-in account changed. Review the current account before continuing."); }
    } };
  }, [invalidate, load]);
  return { ...view, refresh, invalidate, guard };
}
