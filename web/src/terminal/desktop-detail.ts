import { useEffect, useMemo, useState } from "react";
import type { Screen } from "./live";

type Detail = Extract<Screen, { kind: "token" | "profile" }>;
const KEY = "merrymen.desktop-detail.v1";

function isDetail(value: unknown): value is Detail {
  if (!value || typeof value !== "object") return false;
  const detail = value as Partial<Detail> & { id?: unknown; slug?: unknown };
  return (detail.kind === "token" && typeof detail.id === "string" && detail.id.length > 0)
    || (detail.kind === "profile" && typeof detail.slug === "string" && detail.slug.length > 0);
}

/** Keep the last opened public detail in this browser tab across page reloads. */
export function useDesktopDetail(
  desktop: boolean,
  requested: Screen,
  firstTokenId?: string,
  firstAgentSlug?: string,
): Screen {
  const [lastDetail, setLastDetail] = useState<Detail | null>(null);

  useEffect(() => {
    if (!desktop) return;
    if (isDetail(requested)) {
      setLastDetail(requested);
      try { sessionStorage.setItem(KEY, JSON.stringify(requested)); } catch {}
      return;
    }
    try {
      const saved: unknown = JSON.parse(sessionStorage.getItem(KEY) ?? "null");
      if (isDetail(saved)) setLastDetail(saved);
    } catch {}
  }, [desktop, requested]);

  return useMemo(() => {
    if (lastDetail) return lastDetail;
    if (firstTokenId) return { kind: "token", id: firstTokenId };
    if (firstAgentSlug) return { kind: "profile", slug: firstAgentSlug };
    return { kind: "search" };
  }, [lastDetail, firstTokenId, firstAgentSlug]);
}
