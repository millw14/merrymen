/**
 * One-click install links and copy-paste commands for the assistants that can
 * reach Merrymen's MCP server.
 *
 * Every assistant wants the same thing, the server address, but each takes it
 * in its own wrapper: a claude.ai dialog pre-filled from query parameters, a
 * base64 JSON blob for Cursor and LM Studio, plain JSON for VS Code and Kiro, a
 * custom-scheme URL for Goose. One module builds them all, so the connect hub,
 * Connected apps and the docs cannot drift apart, and so the test can pin every
 * byte. The formats follow each vendor's documentation as of 2026-09-25; only
 * the claude.ai link was opened live.
 *
 * WHAT A LINK CANNOT DO: grant anything. It only puts the address into the
 * assistant's own "add a server" screen. The assistant then sends the owner to
 * Merrymen's consent page, and nothing is allowed until the owner clicks Allow
 * there.
 *
 * Pure and isomorphic: it runs in the browser (the hub's buttons) and in Node
 * (tests), so no Buffer. The address is the configured resource URL, never
 * anything a visitor typed.
 */

/** The name an assistant shows for the connection. */
export const CONNECTOR_NAME = "Merrymen";

/** The key a server is stored under in an assistant's config (`claude mcp add … merrymen`). */
export const SERVER_KEY = "merrymen";

/** One line an assistant may show under the name (Goose asks for it). */
const DESCRIPTION = "Your Merrymen trading agent";

export interface InstallLinks {
  /** claude.ai's "Add custom connector" dialog, pre-filled. Syncs to Claude Desktop, mobile and Claude Code on the same account. */
  claude: string;
  /** The same dialog in organisation settings, for a Team or Enterprise owner adding it for everyone. */
  claudeOrg: string;
  cursor: string;
  vscode: string;
  vscodeInsiders: string;
  kiro: string;
  /** Custom scheme: opens the LM Studio app. */
  lmstudio: string;
  /** Custom scheme: opens the Goose app. */
  goose: string;
  /** ChatGPT has no install link; this is where developer-mode apps are created. */
  chatgpt: string;
}

/**
 * The Claude Code plugin (plugins/merrymen in this repository, listed by the
 * marketplace in .claude-plugin/marketplace.json). Its .mcp.json names this
 * production address, so the plugin is offered only by a page that serves it:
 * a staging or self-hosted server would be handed a plugin pointing elsewhere.
 */
export const PLUGIN_SERVER_URL = "https://mcp.merrymen.dev/mcp";
/**
 * The HTTPS clone URL, never the `millw14/merrymen` shorthand: Claude Code
 * clones the shorthand over SSH, which fails on any machine without a GitHub
 * SSH setup ("SSH host key is not in your known_hosts file"). Seen with Claude
 * Code 2.1.281 on 2026-09-25; the HTTPS URL installed cleanly from the same
 * machine.
 */
export const PLUGIN_MARKETPLACE_URL = "https://github.com/millw14/merrymen.git";
export const PLUGIN_ID = "merrymen@merrymen";

/**
 * Slash commands to type inside Claude Code, ONE AT A TIME (pasted together
 * they would be sent as one message), or null when this server is not the one
 * the plugin points at.
 */
export function claudeCodePluginCommands(serverUrl: string): [string, string] | null {
  return serverUrl === PLUGIN_SERVER_URL ? [`/plugin marketplace add ${PLUGIN_MARKETPLACE_URL}`, `/plugin install ${PLUGIN_ID}`] : null;
}

export interface InstallCommands {
  /** Without the plugin: add, then sign in (`claude mcp login` opens the browser). */
  claudeCode: string[];
  /** Codex starts the sign-in by itself after `add`. */
  codex: string[];
  /** Then `/mcp auth merrymen` inside Gemini CLI. */
  gemini: string[];
  /** Devin's CLI, which Windsurf also uses. */
  devin: string[];
}

const enc = encodeURIComponent;

/**
 * Base64 of the UTF-8 bytes, without Buffer. btoa alone takes Latin-1 and
 * throws on anything wider; the configured address is ASCII today, but a link
 * builder that throws on an unusual address would take the whole page down.
 */
function base64(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function installLinks(serverUrl: string): InstallLinks {
  const url = enc(serverUrl);
  const claudeQuery = `modal=add-custom-connector&connectorName=${enc(CONNECTOR_NAME)}&connectorUrl=${url}`;
  const vscode = `https://vscode.dev/redirect/mcp/install?name=${SERVER_KEY}&config=${enc(JSON.stringify({ type: "http", url: serverUrl }))}`;
  return {
    claude: `https://claude.ai/customize/connectors?${claudeQuery}`,
    claudeOrg: `https://claude.ai/admin-settings/connectors?${claudeQuery}`,
    cursor: `https://cursor.com/en/install-mcp?name=${SERVER_KEY}&config=${enc(base64(JSON.stringify({ url: serverUrl })))}`,
    vscode,
    vscodeInsiders: `${vscode}&quality=insiders`,
    kiro: `https://kiro.dev/launch/mcp/add?name=${SERVER_KEY}&config=${enc(JSON.stringify({ url: serverUrl }))}`,
    lmstudio: `lmstudio://add_mcp?name=${SERVER_KEY}&config=${enc(base64(JSON.stringify({ url: serverUrl })))}`,
    goose: `goose://extension?url=${url}&type=streamable_http&id=${SERVER_KEY}&name=${enc(CONNECTOR_NAME)}&description=${enc(DESCRIPTION)}&timeout=300`,
    chatgpt: "https://chatgpt.com/plugins",
  };
}

/**
 * The address as a shell word. The configured address is a plain https URL
 * and goes in bare, which is what the docs show. Anything with a character a
 * shell would act on (a query's `&`, a `#`, a space) is single-quoted, so a
 * pasted command adds the server instead of doing something else.
 */
function shellWord(value: string): string {
  return /^[A-Za-z0-9:/._~%+=@,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

export function installCommands(serverUrl: string): InstallCommands {
  const url = shellWord(serverUrl);
  return {
    claudeCode: [`claude mcp add --transport http --scope user ${SERVER_KEY} ${url}`, `claude mcp login ${SERVER_KEY}`],
    codex: [`codex mcp add ${SERVER_KEY} --url ${url}`],
    gemini: [`gemini mcp add -s user -t http ${SERVER_KEY} ${url}`],
    devin: [`devin mcp add -s user ${SERVER_KEY} ${url}`, `devin mcp login ${SERVER_KEY}`],
  };
}
