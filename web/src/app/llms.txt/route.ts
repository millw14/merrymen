/**
 * /llms.txt: how an AI assistant sets up this server's MCP connection, as
 * plain text (mcp/assistant-setup.ts has the why and the wording).
 *
 * Served on every host this app answers on. On the dedicated MCP host
 * (mcp.merrymen.dev) a path with a file extension is never redirected
 * (mcp/landing.ts), so an assistant that fetched the server address and
 * landed on a help page can try /llms.txt on the same domain and get this.
 *
 * The addresses come from configuration at request time, never from the
 * request; with connections off the text says so and gives nothing to install.
 */
import { llmsTxt } from "@/mcp/assistant-setup";
import { mcpConfig } from "@/mcp/config";

// Never prerender it inside the image build, where the variables do not exist.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(): Response {
  const cfg = mcpConfig();
  const body = cfg.enabled
    ? llmsTxt({ server: cfg.resource, app: cfg.issuer, directory: cfg.directoryResource })
    : [
      "# Merrymen",
      "",
      "Assistant connections are switched off on this server, so there is no MCP server here to set up.",
      ...(cfg.disabledWhy ? ["", `Reason: ${cfg.disabledWhy}.`] : []),
      "",
    ].join("\n");
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=300" },
  });
}
