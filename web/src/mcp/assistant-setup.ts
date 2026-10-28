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
import { grokBotSetupPrompt, grokMcpConfig } from "./grok";

export interface AssistantSetupInput {
  /** The MCP resource URL, e.g. https://mcp.merrymen.dev/mcp. */
  server: string;
  /** The OAuth issuer / app origin, e.g. https://app.merrymen.dev. */
  app: string;
  /**
   * The directory profile's address, e.g. https://mcp.merrymen.dev/mcp/directory
   * (config.ts directoryResource): what a connector added from Anthropic's
   * connector directory points at. Omitted or "" when that profile is off.
   */
  directory?: string;
}

/**
 * Production's directory address (MERRYMEN_MCP_DIRECTORY_RESOURCE_URL unset):
 * the directory's served path, config.ts DIRECTORY_ROUTE_PATH, on the
 * endpoint's origin. Spelled out rather than imported so this text module (run
 * by scripts/llms-txt.ts) stays free of server configuration; the test checks
 * the two agree.
 */
export const PRODUCTION_DIRECTORY_URL = `${new URL(PLUGIN_SERVER_URL).origin}/mcp/directory`;

/** The address production used before the dedicated MCP host (retired for spec-strict clients). */
const OLD_ADDRESS = "https://app.merrymen.dev/mcp";

/** The "Set up the Merrymen MCP server" section, in Markdown (llms.txt style). */
export function assistantSetupMarkdown({ server, app, directory }: AssistantSetupInput): string {
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
    `1. Run \`claude mcp list\`. Look for an entry whose address is exactly ${server}${directory ? ` or exactly ${directory}` : ""}, whatever it is called (\`${SERVER_KEY}\`${production ? `, \`${plugin}\` from the plugin, or \`claude.ai ${CONNECTOR_NAME}\` if the user added it on claude.ai` : ""}). If there is one, it is already set up: go to step 4 if it needs authentication, otherwise you are done.${directory ? ` An entry at ${directory} is ${CONNECTOR_NAME} from Anthropic's connector directory, which cannot suggest trades, setting changes or posts; it still counts, so do not add ${server} on top of it.` : ""}`,
    `2. If an entry named \`${SERVER_KEY}\` points anywhere else${production ? ` (for example ${OLD_ADDRESS})` : ""}, remove it first: \`claude mcp remove ${SERVER_KEY} -s user\` (use the scope that \`claude mcp get ${SERVER_KEY}\` shows).`,
    production
      ? `3. Add it, one way only, never both: run \`${commands.claudeCode[0]}\`; or, for slash commands (/${SERVER_KEY}:status, /${SERVER_KEY}:why, /${SERVER_KEY}:portfolio and more), install the plugin, which includes the server: \`claude plugin marketplace add ${PLUGIN_MARKETPLACE_URL}\`, then \`claude plugin install ${PLUGIN_ID}\`.`
      : `3. Run \`${commands.claudeCode[0]}\``,
    `4. Tell the user to type \`/mcp\`, choose the ${CONNECTOR_NAME} entry (\`${SERVER_KEY}\`${production ? `, or \`${plugin}\` for the plugin` : ""}), choose Authenticate, sign in to ${CONNECTOR_NAME} if asked, and click Allow. You cannot do this step for them, and do not run \`claude mcp login\` yourself. If the entry is not in \`/mcp\` yet, the user ${production ? "types `/reload-plugins` (for the plugin) or " : ""}restarts Claude Code (\`claude --continue\` keeps the conversation).`,
    `5. ${CONNECTOR_NAME}'s tools are then available; \`get_merryman_setup\` is a good first call.`,
    "",
    "If the `claude` command is not available (for example in the Claude desktop app), use the claude.ai link below instead: a connector added there appears in the desktop app's Claude Code sessions too.",
    "",
    "### In claude.ai, Claude Desktop or Claude mobile",
    "",
    ...(directory ? [`If the user already added ${CONNECTOR_NAME} from Anthropic's connector directory, it is set up; do not add the link below on top of it.`, ""] : []),
    "You cannot add a connector from a chat. Give the user this link:",
    "",
    links.claude,
    "",
    `It opens Claude's "Add custom connector" dialog with ${CONNECTOR_NAME} filled in. They click Continue, then Connect, then Allow on the ${CONNECTOR_NAME} page. It then works in claude.ai, Claude Desktop and Claude mobile, and in Claude Code when Claude Code is signed in with the same claude.ai account. On a Team or Enterprise plan, an organisation owner adds it once: ${links.claudeOrg}`,
    "",
    "### In ChatGPT and dots",
    "",
    `Add ${server} as an OAuth MCP server in ChatGPT's plugin setup, then connect your Merrymen account and enable the plugin for the chat. Availability depends on your ChatGPT workspace. No local terminal or worker is needed.`,
    "A dot can use supported plugins installed and enabled for its account. Confirm Merrymen is available to the dot; installing a Claude Code plugin does not install a ChatGPT plugin. Do not claim a public directory listing or dot access until that host actually offers it.",
    "Official setup: https://developers.openai.com/plugins/build/auth and https://learn.chatgpt.com/docs/dots/computers-and-apps.",
    "",
    "### In Grok (web or mobile)",
    "",
    `Open Plugins → Connectors → New Connector → Custom in Grok, or start at ${links.grok}. Set Name to Merrymen and Server URL to ${server}, then choose Add Connector, complete OAuth in Merrymen, and enable the connector for the conversation. This is a one-time manual setup; asking chat to connect Merrymen by name may only search the catalog and cannot install this unlisted custom connector. The URL is a settings link, not a pre-filled install or automatic connection. Business and Enterprise workspaces may need an admin to provision the connector first.`,
    "The owner signs in or creates their Merrymen account in their own browser and chooses access. To prepare a new Merryman in chat, enable the optional permission to suggest setting changes (drafts:write); it is off by default. Share the intended agent for private status and portfolio access. Never ask for a wallet key or an xAI API key.",
    "Verify by calling `get_merryman_setup`, then use the setup flow below. If rich MCP App views are unavailable, return the same tool results and owner approval links as text. Do not claim support for an interactive view without observing it in the host.",
    "Official custom connector setup: https://docs.x.ai/grok/connectors.",
    "",
    "### In Grok Bot",
    "",
    "Grok Bot is a separate product from Grok chat and Grok Build CLI. Its documentation supports Cursor-compatible MCP servers, plugins and skills. Do not assume connectors added in Grok chat automatically appear in a Bot, and do not use a Cursor install link as an undocumented Grok Bot deep link. If the Bot supports custom MCP configuration, the credential-free configuration is:",
    "",
    "```json",
    grokMcpConfig(server),
    "```",
    "",
    "The owner can give the Bot this setup request:",
    "",
    grokBotSetupPrompt({ server, app }),
    "",
    "Official Bot compatibility: https://x.ai/bot/guides/grok-bot-101. A packaged plugin is not proof of a public marketplace listing or an authenticated connection; verify tools in the actual Bot.",
    "",
    "### In Grok Build CLI",
    "",
    `Run \`grok mcp list\` first and reuse an entry at ${server}. Otherwise run \`${commands.grok[0]}\`. OAuth opens in the browser on first use; \`/mcps\` manages connections and authentication. \`grok mcp doctor ${SERVER_KEY}\` diagnoses connectivity. Then call \`get_merryman_setup\`. These CLI commands are not Grok Bot installation commands.`,
    "Official CLI setup: https://docs.x.ai/build/features/mcp-servers.",
    "",
    "### Create or manage a Merryman after connecting",
    "",
    "Call `get_merryman_setup` first, including for a new owner. It reports the next step and distinguishes a missing trading permission from an agent this connection cannot see. An empty list is not proof that no wallet exists.",
    "For an owner who wants a new agent, use `create_merryman` with their name, strategy, basket and risk choice when the connection permits drafting. Open the returned approval link: the owner reviews the setup and continues through a focused secure handoff for wallet creation and permission signing in Merrymen. The approved name and strategy are carried forward. A prepared or approved draft is not a running agent; return to the same chat and read setup again after signing and activation.",
    "When the host supports MCP Apps, setup opens an interactive home with naming, strategy, basket and risk choices, readiness, Portfolio, Activity, Settings, Approvals and Alerts. Only permitted actions appear. A host without rich views uses the same text answers and tools; research, trade proposals, reports and community continue in chat when allowed.",
    "For an existing agent, read its status, portfolio and `get_agent_settings` before preparing requested changes with `create_agent_draft` or `propose_settings_change`. Settings reads contain allowlisted configuration and input metadata, never secrets; saved configuration is not proof of worker adoption. Changes require owner approval. Use proposal status to follow a handoff, and cancel only when the user asks. If a tool is unavailable, explain the missing permission and the reconnect step; do not substitute a different account.",
    "Merrymen's hosted worker runs the agent after activation. The assistant chat, browser and local terminal do not need to stay open. Permission expiry, service health, funding and trading rules still apply.",
    "",
    "### Other assistants",
    "",
    `- Codex: \`${commands.codex[0]}\` (it opens the sign-in by itself).`,
    `- Cursor, VS Code, Kiro, LM Studio, Goose, Gemini CLI, Windsurf, ChatGPT, Grok and Grok Bot: links and steps at ${app}/connect/mcp`,
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
    `> ${CONNECTOR_NAME} runs autonomous trading agents on Robinhood Chain, inside hard on-chain limits their owner signs. Owners connect Claude, Claude Code, Codex, Cursor, VS Code, ChatGPT, Grok, Grok Bot and other AI assistants to their hosted ${CONNECTOR_NAME} through the ${CONNECTOR_NAME} MCP server.`,
    "",
    assistantSetupMarkdown(input),
    "",
    "## Links",
    "",
    `- [Connect an AI assistant](${input.app}/connect/mcp): setup links and instructions for each client`,
    "- [MCP documentation](https://github.com/millw14/merrymen/blob/main/docs/mcp/README.md)",
    "- [Client setup details](https://github.com/millw14/merrymen/blob/main/docs/mcp/clients.md)",
    "- [Source code](https://github.com/millw14/merrymen)",
    "",
  ].join("\n");
}
