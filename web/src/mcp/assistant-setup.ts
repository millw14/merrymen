/**
 * The instructions an AI assistant follows when someone tells it "set up
 * merrymen mcp on my claude".
 *
 * Merrymen is not in any assistant's built-in connector directory, so a
 * fresh Claude has to find out how by itself: it searches the web and fetches
 * what it finds (llms.txt, the connect page, the README). Seen on 2026-09-25:
 * a fresh Claude did get there, but through stale pull-request text (an old
 * address), a server address that looked like a web page, and two setup
 * routes that clash. So this is the one authoritative answer, written for the
 * assistant, served as llms.txt on every Merrymen host and shown on the
 * connect page, and pinned by a test against the static copy on merrymen.dev.
 *
 * Pure: it takes the configured addresses and builds nothing from a request.
 */
import { CONNECTOR_NAME, PLUGIN_ID, PLUGIN_MARKETPLACE_URL, PLUGIN_SERVER_URL, SERVER_KEY, installCommands, installLinks } from "./install-links";

export interface AssistantSetupInput {
  /** The MCP resource URL, e.g. https://mcp.merrymen.dev/mcp. */
  server: string;
  /** The OAuth issuer / app origin, e.g. https://app.merrymen.dev. */
  app: string;
}

/** The address production used before the dedicated MCP host (retired for spec-strict clients). */
const OLD_ADDRESS = "https://app.merrymen.dev/mcp";

/** The "Set up the Merrymen MCP server" section, in Markdown (llms.txt style). */
export function assistantSetupMarkdown({ server, app }: AssistantSetupInput): string {
  const links = installLinks(server);
  const commands = installCommands(server);
  const production = server === PLUGIN_SERVER_URL;
  const health = `${new URL(server).origin}/api/mcp/health`;
  const plugin = `plugin:${SERVER_KEY}:${SERVER_KEY}`;
  const lines: string[] = [
    "## Set up the Merrymen MCP server",
    "",
    `For AI assistants: when a user asks you to set up, add, install or connect ${CONNECTOR_NAME} or "the ${CONNECTOR_NAME} MCP", follow this.`,
    "",
    `- Server address: ${server} (remote, Streamable HTTP, OAuth 2.1). Use exactly this address.${production ? ` Do not use ${OLD_ADDRESS}, an older address.` : ""}`,
    `- It is part of hosted ${CONNECTOR_NAME} (${app}). If the user runs ${CONNECTOR_NAME} only on their own machine (the \`merrymen\` command-line app), there is no MCP server for that; tell them so instead of adding one.`,
    "- No API key, token or password is needed, and never ask the user for one: the user signs in to Merrymen in their own browser and chooses what to allow.",
    `- A browser page load of the server address redirects to a help page, and a request without a token gets 401 unauthorized; both are expected. The server is up when ${health} returns JSON with "ready":true.`,
    "",
    "### In Claude Code",
    "",
    `1. Run \`claude mcp list\`. Look for an entry whose address is exactly ${server}, whatever it is called (\`${SERVER_KEY}\`${production ? `, \`${plugin}\` from the plugin, or \`claude.ai ${CONNECTOR_NAME}\` if the user added it on claude.ai` : ""}). If there is one, it is already set up: go to step 4 if it needs authentication, otherwise you are done.`,
    `2. If an entry named \`${SERVER_KEY}\` points anywhere else${production ? ` (for example ${OLD_ADDRESS})` : ""}, remove it first: \`claude mcp remove ${SERVER_KEY} -s user\` (use the scope that \`claude mcp get ${SERVER_KEY}\` shows).`,
    production
      ? `3. Add it, one way only, never both: run \`${commands.claudeCode[0]}\`; or, for slash commands (/${SERVER_KEY}:status, /${SERVER_KEY}:why, /${SERVER_KEY}:portfolio and more), install the plugin, which includes the server: \`claude plugin marketplace add ${PLUGIN_MARKETPLACE_URL}\`, then \`claude plugin install ${PLUGIN_ID}\`.`
      : `3. Run \`${commands.claudeCode[0]}\``,
    `4. Tell the user to type \`/mcp\`, choose the ${CONNECTOR_NAME} entry (\`${SERVER_KEY}\`${production ? `, or \`${plugin}\` for the plugin` : ""}), choose Authenticate, sign in to ${CONNECTOR_NAME} if asked, and click Allow. You cannot do this step for them, and do not run \`claude mcp login\` yourself. If the entry is not in \`/mcp\` yet, the user ${production ? "types `/reload-plugins` (for the plugin) or " : ""}restarts Claude Code (\`claude --continue\` keeps the conversation).`,
    `5. ${CONNECTOR_NAME}'s tools are then available; \`list_agents\` is a good first call.`,
    "",
    "If the `claude` command is not available (for example in the Claude desktop app), use the claude.ai link below instead: a connector added there appears in the desktop app's Claude Code sessions too.",
    "",
    "### In claude.ai, Claude Desktop or Claude mobile",
    "",
    "You cannot add a connector from a chat. Give the user this link:",
    "",
    links.claude,
    "",
    `It opens Claude's "Add custom connector" dialog with ${CONNECTOR_NAME} filled in. They click Continue, then Connect, then Allow on the ${CONNECTOR_NAME} page. It then works in claude.ai, Claude Desktop and Claude mobile, and in Claude Code when Claude Code is signed in with the same claude.ai account. On a Team or Enterprise plan, an organisation owner adds it once: ${links.claudeOrg}`,
    "",
    "### Other assistants",
    "",
    `- Codex: \`${commands.codex[0]}\` (it opens the sign-in by itself).`,
    `- Cursor, VS Code, Kiro, LM Studio, Goose, Gemini CLI, Windsurf and ChatGPT: one-click links and steps at ${app}/connect/mcp`,
    "",
    "## What the connection can and cannot do",
    "",
    `It sees only the agent and the permissions the owner allows when signing in, and the owner can disconnect it at any time at ${app}/connect/apps. It can suggest trades or setting changes only if the owner allowed that, and nothing happens until they approve each one in ${CONNECTOR_NAME}. It can never move funds, see keys, turn on live trading or loosen the owner's signed limits. Paper (practice) and live money are always reported separately.`,
  ];
  return lines.join("\n");
}

/** A whole llms.txt for a Merrymen host: what Merrymen is, how to set it up, where to read more. */
export function llmsTxt(input: AssistantSetupInput): string {
  return [
    `# ${CONNECTOR_NAME}`,
    "",
    `> ${CONNECTOR_NAME} runs autonomous trading agents on Robinhood Chain, inside hard on-chain limits their owner signs. Owners connect Claude, Claude Code, Codex, Cursor, VS Code, ChatGPT and other AI assistants to their hosted ${CONNECTOR_NAME} through the ${CONNECTOR_NAME} MCP server.`,
    "",
    assistantSetupMarkdown(input),
    "",
    "## Links",
    "",
    `- [Connect an AI assistant](${input.app}/connect/mcp): every client, one click each`,
    "- [MCP documentation](https://github.com/millw14/merrymen/blob/main/docs/mcp/README.md)",
    "- [Client setup details](https://github.com/millw14/merrymen/blob/main/docs/mcp/clients.md)",
    "- [Source code](https://github.com/millw14/merrymen)",
    "",
  ].join("\n");
}
