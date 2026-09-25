import type { Metadata } from "next";
import { mcpConfig } from "@/mcp/config";
import "../connect.css";
import "../mcp-connect.css";
import { McpConnectClient } from "./McpConnectClient";

export const metadata: Metadata = {
  title: "Connect Merrymen to your AI assistant · merrymen",
  description: "Add your Merrymen agent to Claude in one click, or to ChatGPT, Codex, Cursor and other assistants.",
  referrer: "no-referrer",
};

// The server address comes from configuration at request time; never prerender
// it inside the image build, where the variables do not exist.
export const dynamic = "force-dynamic";

/**
 * The connect hub. A server component only so the address is read from
 * configuration here, never from the request or the browser; the page itself
 * (copy buttons, the "already connected" line) is the client component.
 */
export default function ConnectMcpPage() {
  const cfg = mcpConfig();
  const url = cfg.resource || "https://mcp.merrymen.dev/mcp";
  return <McpConnectClient url={url} enabled={cfg.enabled} disabledWhy={cfg.disabledWhy} />;
}
