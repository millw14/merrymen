import type { Metadata } from "next";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Icon } from "@/components/Icon";

const title = "Set up the Merrymen MCP server in Claude";
const description =
  "Tell Claude to set up Merrymen, or add it in one click. Connect claude.ai, Claude Desktop, Claude mobile or Claude Code to your hosted Merrymen agent. No API key needed.";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/claude" },
  openGraph: { title, description, url: "https://merrymen.dev/claude", siteName: "merrymen", type: "website" },
  twitter: { card: "summary", title, description, site: "@MerrymenAI", creator: "@MerrymenAI" },
};

/**
 * Copied byte for byte from public/llms.txt, the setup text an AI assistant
 * reads, which is generated from the hosted app's install links
 * (scripts/llms-txt.ts). A person on this page and an assistant reading
 * llms.txt must be handed the same address and the same commands: a fresh
 * Claude once got lost between an old address and two clashing routes.
 */
const CLAUDE_LINK = "https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Merrymen&connectorUrl=https%3A%2F%2Fmcp.merrymen.dev%2Fmcp";
const CLAUDE_ORG_LINK = "https://claude.ai/admin-settings/connectors?modal=add-custom-connector&connectorName=Merrymen&connectorUrl=https%3A%2F%2Fmcp.merrymen.dev%2Fmcp";
const MCP_ADD = "claude mcp add --transport http --scope user merrymen https://mcp.merrymen.dev/mcp";
const PLUGIN_MARKETPLACE_ADD = "claude plugin marketplace add https://github.com/millw14/merrymen.git";
const PLUGIN_INSTALL = "claude plugin install merrymen@merrymen";
const CONNECT_HUB = "https://app.merrymen.dev/connect/mcp";
const CONNECTED_APPS = "https://app.merrymen.dev/connect/apps";

/**
 * Fails the build when llms.txt has moved on (a new address, a new command)
 * and this page has not, instead of quietly publishing stale steps. The page
 * is static, so this runs once, at build time.
 */
function assertCopiedFromLlmsTxt() {
  const llms = readFileSync(join(process.cwd(), "public", "llms.txt"), "utf8");
  const stale = [CLAUDE_LINK, CLAUDE_ORG_LINK, MCP_ADD, PLUGIN_MARKETPLACE_ADD, PLUGIN_INSTALL, CONNECT_HUB, CONNECTED_APPS].filter((s) => !llms.includes(s));
  if (stale.length) throw new Error(`app/claude/page.tsx no longer matches public/llms.txt; copy these again: ${stale.join(" | ")}`);
}

export default function ClaudeSetup() {
  assertCopiedFromLlmsTxt();
  return (
    <div className="wrap" style={{ maxWidth: 760, padding: "40px 24px 80px" }}>
      <article className="doc-body">
        <h1>Set up Merrymen in Claude</h1>
        <p className="doc-lead">
          The quickest way: tell Claude “set up merrymen mcp”. Or add it yourself in one click.
        </p>

        <div style={{ margin: "0 0 18px" }}>
          <a href={CLAUDE_LINK} className="btn btn-primary btn-lg has-box" target="_blank" rel="noreferrer">
            Add to Claude <span className="box"><Icon name="arrow" size={16} /></span>
          </a>
        </div>
        <p>
          The button opens Claude&apos;s <strong>Add custom connector</strong> dialog with Merrymen
          filled in. Click <strong>Continue</strong>, then <strong>Connect</strong>, then{" "}
          <strong>Allow</strong> on the Merrymen page that opens. Add it once: it then works in
          claude.ai, Claude Desktop and Claude mobile, and in Claude Code when it is signed in with the
          same claude.ai account. Then ask Claude “Why hasn&apos;t my agent traded?”
        </p>
        <p>
          This connects to hosted Merrymen (app.merrymen.dev). You sign in to Merrymen in your own
          browser and choose what to allow; there is no API key, token or password to paste
          anywhere. On a Team or Enterprise plan, an organisation owner{" "}
          <a className="link" href={CLAUDE_ORG_LINK} target="_blank" rel="noreferrer">adds it once</a>{" "}
          for everyone.
        </p>

        <h2 id="tell-claude">Telling Claude to do it</h2>
        <ul>
          <li>
            <strong>In Claude Code</strong>, Claude can run the setup command for you. The last step
            is yours: type <code className="inline">/mcp</code>, choose the Merrymen entry, choose{" "}
            <strong>Authenticate</strong> and click <strong>Allow</strong>.
          </li>
          <li>
            <strong>In claude.ai, Claude Desktop or Claude mobile</strong>, Claude can&apos;t add a
            connector from a chat, so it gives you the same link as the button above.
          </li>
        </ul>
        <p>
          Claude looks the steps up on the web. If it can&apos;t find them, give it{" "}
          <a className="link" href="/llms.txt" style={{ overflowWrap: "anywhere" }}>https://merrymen.dev/llms.txt</a>.
        </p>

        <h2 id="claude-code">Claude Code</h2>
        <p>
          Already added Merrymen on claude.ai? Claude Code signed in with the same claude.ai account
          has it too. <code className="inline">claude mcp list</code> shows it (as{" "}
          <code className="inline">merrymen</code>, <code className="inline">plugin:merrymen:merrymen</code> or{" "}
          <code className="inline">claude.ai Merrymen</code>) at https://mcp.merrymen.dev/mcp when it
          is set up. An entry named <code className="inline">merrymen</code> at any other address is
          an old one: remove it with <code className="inline">claude mcp remove merrymen -s user</code>.
          Otherwise, in a terminal:
        </p>
        <pre className="code">{MCP_ADD}</pre>
        <p>
          Then, in Claude Code, type <code className="inline">/mcp</code>, choose{" "}
          <code className="inline">merrymen</code>, choose <strong>Authenticate</strong>, sign in to
          Merrymen if asked, and click <strong>Allow</strong>. If it isn&apos;t listed yet, restart
          Claude Code (<code className="inline">claude --continue</code> keeps the conversation).
        </p>
        <h3>Or the plugin, for slash commands</h3>
        <p>
          The Merrymen plugin includes the server and adds{" "}
          <code className="inline">/merrymen:status</code>, <code className="inline">/merrymen:why</code>,{" "}
          <code className="inline">/merrymen:portfolio</code> and more. Install it{" "}
          <strong>instead of</strong> the command above: choose one route, not both.
        </p>
        <pre className="code">{`${PLUGIN_MARKETPLACE_ADD}
${PLUGIN_INSTALL}`}</pre>
        <p>
          Then type <code className="inline">/reload-plugins</code> and sign in from{" "}
          <code className="inline">/mcp</code>: choose <code className="inline">plugin:merrymen:merrymen</code>,
          choose <strong>Authenticate</strong> and click <strong>Allow</strong>.
        </p>

        <h2 id="other-assistants">Other assistants</h2>
        <p>
          Codex, Cursor, VS Code, Kiro, LM Studio, Goose, Gemini CLI, Windsurf and ChatGPT connect to
          the same server. One-click links and steps for each:{" "}
          <a className="link" href={CONNECT_HUB} style={{ overflowWrap: "anywhere" }}>{CONNECT_HUB}</a>
        </p>

        <h2 id="can-and-cannot">What it can and cannot do</h2>
        <ul>
          <li>
            It sees only the agent and the permissions you allow when you sign in, and you can
            disconnect it at any time on{" "}
            <a className="link" href={CONNECTED_APPS}>Connected apps</a>.
          </li>
          <li>
            It can suggest trades or setting changes only if you allowed that, and nothing happens
            until you approve each one in Merrymen.
          </li>
          <li>It can never move funds, see keys, turn on live trading or loosen your limits.</li>
          <li>Paper (practice) and live money are always reported separately.</li>
        </ul>

        <div className="callout" style={{ marginTop: 40 }}>
          <strong>For AI assistants:</strong> the setup instructions written for you are at{" "}
          <a className="link" href="/llms.txt" style={{ overflowWrap: "anywhere" }}>https://merrymen.dev/llms.txt</a>. Follow them, and use
          the server address exactly as written there.
        </div>
      </article>
    </div>
  );
}
