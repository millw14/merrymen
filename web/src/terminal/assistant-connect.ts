/**
 * THE WAY INTO /connect/mcp, AND WHETHER TO OFFER IT.
 *
 * Connecting an AI assistant is a hosted feature: a self-hosted install has no
 * login, so its MCP server is always off (web/src/mcp/config.ts), and a
 * "Connect to Claude" row there would lead to a page saying so. The terminal
 * learns which one it is from GET /api/auth/session's `hosted`, the same
 * runtime answer Settings reads (process.env is not in the browser bundle, so
 * isHostedMode() cannot be asked here).
 *
 * Asked once per page and shared, like the group chat's support probe: the
 * profile row and the desktop account menu read one answer, not two fetches.
 * TRUE WHILE UNKNOWN, and a failure leaves it true: the hosted product is the
 * common case, and only an install that says `hosted: false` hides the entry.
 *
 * `.ts`, not `.tsx`, so the test runner can import it without a component tree.
 */
import { useEffect, useSyncExternalStore } from "react";

/** The connect hub, where every assistant's one-click install lives. */
export const CONNECT_ASSISTANT_HREF = "/connect/mcp";

let offered = true;
let probed = false;
const listeners = new Set<() => void>();

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

async function probe(): Promise<void> {
  if (probed) return;
  probed = true;
  try {
    const response = await fetch("/api/auth/session", { cache: "no-store", credentials: "same-origin" });
    const body = response.ok ? await response.json() as { hosted?: unknown } : null;
    if (body?.hosted === false) {
      offered = false;
      for (const fn of listeners) fn();
    }
  } catch {
    // Unknown stays offered; the hub itself says when connections are off.
  }
}

/** Whether to show "Connect to Claude". False only once this install has said it is self-hosted. */
export function useConnectAssistantOffered(): boolean {
  const value = useSyncExternalStore(subscribe, () => offered, () => true);
  useEffect(() => {
    void probe();
  }, []);
  return value;
}
