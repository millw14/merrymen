/**
 * Public, credential-free setup material for Grok Bot's Cursor-compatible MCP
 * support. This is configuration and a user-initiated workflow, never a grant.
 * Keep staging/self-hosted addresses intact instead of installing production.
 */
import { PLUGIN_SERVER_URL, SERVER_KEY } from "./install-links";
import { SETUP_WORKFLOW } from "./instructions";

export function grokMcpConfig(server: string): string {
  return JSON.stringify({ mcpServers: { [SERVER_KEY]: { url: server } } }, null, 2);
}

export function grokBotSetupPrompt({ server, app }: { server: string; app: string }): string {
  const instructions = server === PLUGIN_SERVER_URL ? "https://merrymen.dev/llms.txt" : `${app}/llms.txt`;
  return [
    "Help me connect Merrymen to this Grok Bot and set up or check my hosted Merryman.",
    `Read the setup instructions at ${instructions}. Use only this remote MCP server: ${server}.`,
    "Check this Bot's installed MCP connections first. Reuse a working connection at that exact address; do not assume a Grok chat connector is installed in this Bot. If unavailable, guide me through adding the remote server using the supported connection settings. Do not claim it is connected until a tool call succeeds.",
    "Use OAuth. Send sign-in and consent links to me to open in the browser on my own device. Do not sign in to Merrymen, approve proposals, create wallets or sign permissions through the Bot's shared cloud computer. Never request keys, recovery phrases, passwords or bearer tokens in chat.",
    SETUP_WORKFLOW,
    "Use text and links if this host cannot render MCP Apps. Merrymen's hosted worker runs the agent; this Bot and chat do not need to stay open. Do not start a second worker or set up a trading loop here.",
    "For later requests, use only tools this connection grants. Keep practice and live results separate. Never weaken signed limits or retry a financial action whose outcome is unknown. A proposal or submitted order is not a confirmed trade.",
    "Do not create a monitoring routine unless I ask. If I do, use read-only status, portfolio and decision tools; notify me only of meaningful changes or required action. Do not create drafts, propose or approve trades, change settings or retry orders in a routine.",
  ].join("\n\n");
}
