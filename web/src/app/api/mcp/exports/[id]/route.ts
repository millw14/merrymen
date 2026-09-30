/**
 * Download an MCP export in the owner's browser.
 *
 * The export was created by a connected app on the owner's behalf; the file
 * itself is handed only to the owner's own signed-in session, never to a
 * bearer token, and never to anyone holding the link. Checks, in order:
 *   MCP off (404) → no session (401, nothing is looked up) → not this
 *   owner's export, or no such id (404, indistinguishable) → expired (410).
 *
 * It lives under /api, so the middleware's cross-site block applies: a link
 * clicked on another site is refused, while one pasted into the address bar
 * (Sec-Fetch-Site: none) or opened from Merrymen itself is served. The
 * response is an attachment the browser saves rather than renders. The link
 * the tools hand out is /connect/export/<id>, a page that asks `?info=1`
 * (the same checks, the file's details without its content) and then offers
 * a same-origin Download button pointing here.
 */
import { tenantOf } from "@/lib/auth";
import { EXPORT_ID, exportMimeType, readExport } from "@/lib/services/reports";
import { mcpConfig } from "@/mcp/config";
import { mcpDb } from "@/mcp/db";
import { jsonResponse } from "@/mcp/oauth/metadata";
import { writeAudit } from "@/mcp/observe";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const cfg = mcpConfig();
  if (!cfg.enabled) return jsonResponse({ error: "not_found" }, 404);
  const tenant = tenantOf(req);
  if (!tenant) return jsonResponse({ error: "login_required", error_description: "Sign in to Merrymen in this browser, then open the link again." }, 401);
  const { id } = await params;
  if (typeof id !== "string" || !EXPORT_ID.test(id)) return jsonResponse({ error: "not_found" }, 404);
  const infoOnly = new URL(req.url).searchParams.get("info") === "1";
  let d;
  let rec;
  try {
    d = await mcpDb();
    rec = await readExport(d.db, tenant, id, !infoOnly);
  } catch {
    return jsonResponse({ error: "temporarily_unavailable" }, 503, { "Retry-After": "15" });
  }
  const now = Math.floor(Date.now() / 1000);
  if (rec && infoOnly) {
    if (rec.expires_at <= now) return jsonResponse({ error: "expired", error_description: "This export has expired. Ask the connected app to create a new one." }, 410);
    return jsonResponse({ id: rec.id, kind: rec.kind, format: rec.format, filename: rec.filename, bytes: rec.bytes, created_at: rec.created_at, expires_at: rec.expires_at }, 200, { "Cache-Control": "no-store" });
  }
  if (!rec || typeof rec.content !== "string") {
    await writeAudit(d, { action: "owner.download_export", outcome: "not_found", tenant }, now);
    return jsonResponse({ error: "not_found" }, 404);
  }
  if (rec.expires_at <= now) {
    await writeAudit(d, { action: "owner.download_export", outcome: "expired", tenant, connectionId: rec.connection_id }, now);
    return jsonResponse({ error: "expired", error_description: "This export has expired. Ask the connected app to create a new one." }, 410);
  }
  await writeAudit(d, { action: "owner.download_export", outcome: "ok", tenant, connectionId: rec.connection_id, detail: { kind: rec.kind, bytes: rec.bytes } }, now);
  // The filename is ours (reports.ts builds it from a slug, a kind and a
  // timestamp), so it needs no escaping beyond the quotes.
  return new Response(rec.content, {
    status: 200,
    headers: {
      "Content-Type": exportMimeType(rec.format),
      "Content-Disposition": `attachment; filename="${rec.filename.replace(/["\\\r\n]/g, "")}"`,
      "Content-Length": String(Buffer.byteLength(rec.content)),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Referrer-Policy": "no-referrer",
    },
  });
}
