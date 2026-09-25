/**
 * OAuth authorization endpoint. Validates the request, parks it, and sends the
 * browser to the Merrymen consent page. The owner signs in there with their own
 * Merrymen session; nothing is granted by visiting this URL.
 */
import { mcpConfig } from "@/mcp/config";
import { ipLimited, oauthDeps, rawRequestUrl } from "@/mcp/oauth/deps";
import { startAuthorization } from "@/mcp/oauth/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function errorPage(status: number, error: string, description: string): Response {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connection problem · Merrymen</title>` +
      `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5">` +
      `<h1 style="font-size:1.4rem">This app could not start a Merrymen connection</h1><p>${esc(description)}</p>` +
      `<p style="color:#666;font-size:.9rem">Error: ${esc(error)}. Nothing was shared. Go back to the app and try connecting again.</p></body>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" } },
  );
}

export async function GET(req: Request): Promise<Response> {
  if (!mcpConfig().enabled) return new Response("Not found", { status: 404 });
  const deps = await oauthDeps();
  const limited = await ipLimited(deps, req, "authorize", 60, 60);
  if (limited) return limited;
  // The query as sent: NextRequest.url rewrites 127.0.0.1 in it to localhost (see rawRequestUrl).
  const outcome = await startAuthorization(deps, new URL(rawRequestUrl(req)).searchParams);
  if (outcome.kind === "page_error") return errorPage(outcome.status, outcome.error, outcome.description);
  return new Response(null, { status: 302, headers: { Location: outcome.location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}
