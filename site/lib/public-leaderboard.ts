export const PUBLIC_LEADERBOARD = "https://app.merrymen.dev/api/leaderboard";

export interface PublicAgent {
  slug: string;
  name: string;
  mode: string;
  pnlBps: number | null;
  paperPnlBps: number | null;
  landed: number;
  refused: number;
  curve: number[];
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function readPublicAgents(body: unknown): PublicAgent[] | null {
  if (!body || typeof body !== "object" || !Array.isArray((body as { agents?: unknown }).agents)) {
    return null;
  }

  const rows: PublicAgent[] = [];
  for (const value of (body as { agents: unknown[] }).agents) {
    if (!value || typeof value !== "object") continue;
    const row = value as Record<string, unknown>;
    if (
      typeof row.slug !== "string"
      || typeof row.name !== "string"
      || typeof row.mode !== "string"
      || typeof row.landed !== "number"
      || typeof row.refused !== "number"
    ) continue;

    rows.push({
      slug: row.slug,
      name: row.name,
      mode: row.mode,
      pnlBps: finiteOrNull(row.pnlBps),
      paperPnlBps: finiteOrNull(row.paperPnlBps),
      landed: row.landed,
      refused: row.refused,
      curve: Array.isArray(row.curve)
        ? row.curve
          .filter((point): point is number => typeof point === "number" && Number.isFinite(point))
          .slice(-60)
        : [],
    });
  }
  return rows;
}
