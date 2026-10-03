/**
 * ASK BRAIN TO THINK OVER A DESK BRIEF — `POST /v1/analyze`.
 *
 * Separate from brain-client.ts on purpose. That client carries a portfolio
 * snapshot to the endpoint that decides trades; this one carries public market
 * measurements to an endpoint that only writes a read. Nothing it sends or
 * receives can size, place or authorise anything, and it never sends the
 * owner's ledger, positions or limits — it is never given them.
 *
 * Brain's answer is untrusted text until the group gate has checked it
 * (tg-groups/desk.ts): every figure in it must be one the brief contained.
 */
import { randomUUID } from "node:crypto";
import type { TgDeskStance, TgDeskThinkRequest, TgDeskThought } from "../telegram/tg-groups/types";

export interface BrainDeskConfig {
  url: string;
  token: string;
  agentId: string;
  timeoutMs?: number;
}

const MAX_BYTES = 64 * 1024;
const STANCES: ReadonlySet<string> = new Set(["constructive", "neutral", "cautious", "avoid"]);
const FORBIDDEN = /0x[0-9a-fA-F]{16,}|https?:\/\/|www\.|t\.me\//i;

async function readBounded(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new Error("brain answer too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const text = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.trim().length <= max && !FORBIDDEN.test(v) ? v.replace(/\s+/g, " ").trim() : null;

/** Brain's analysis, shape-checked. Null for anything that is not one. */
export function parseDeskAnalysis(raw: unknown): TgDeskThought | null {
  const a = (raw ?? {}) as Record<string, unknown>;
  const read = text(a.read, 900);
  const watch = text(a.watch ?? "", 260);
  const invalidation = text(a.invalidation ?? "", 260);
  if (!read || read.length < 20 || watch === null || invalidation === null) return null;
  if (typeof a.stance !== "string" || !STANCES.has(a.stance)) return null;
  const confidence = typeof a.confidence === "number" && Number.isFinite(a.confidence) ? Math.min(1, Math.max(0, a.confidence)) : undefined;
  return { read, stance: a.stance as TgDeskStance, watch, invalidation, ...(confidence !== undefined ? { confidence } : {}) };
}

/** One call, no retry: a slow or refusing Brain is answered by the floor, not waited on. */
export async function askBrainDesk(cfg: BrainDeskConfig, req: TgDeskThinkRequest): Promise<TgDeskThought | null> {
  if (!cfg.url || !cfg.token) return null;
  const body = {
    schema_version: "1.0.0",
    run_id: `desk-${randomUUID()}`,
    agent_id: cfg.agentId.slice(0, 80) || "agent",
    kind: req.kind,
    subject: req.subject.slice(0, 40),
    question: req.question.slice(0, 400),
    evidence: req.brief.slice(0, 14_000),
    voice: req.voice.slice(0, 500),
  };
  try {
    const res = await fetch(`${cfg.url.replace(/\/$/, "")}/v1/analyze`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(cfg.timeoutMs ?? 25_000),
    });
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const payload = JSON.parse(await readBounded(res, MAX_BYTES)) as { ok?: unknown; analysis?: unknown };
    return payload.ok === true ? parseDeskAnalysis(payload.analysis) : null;
  } catch {
    return null;
  }
}
