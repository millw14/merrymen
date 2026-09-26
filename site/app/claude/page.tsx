import type { Metadata } from "next";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Icon } from "@/components/Icon";

const title = "Set up the Merrymen MCP server in Claude";
const description =
  "Connect claude.ai, Claude Desktop, Claude mobile or Claude Code to your hosted Merrymen agent: setup, what each permission allows, example prompts, troubleshooting and data handling. No API key needed.";

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
 * The two server addresses. The full one is what every link above installs.
 * The directory one is what the listing in Claude's connector directory
 * points at: the same server without any tool behind the three unticked
 * scopes (drafts:write, trade:propose, social:write), so without suggesting a
 * trade, a setting change or a post, and without following or unfollowing an
 * agent. Both are checked against llms.txt, whose first Claude Code step counts
 * an entry at either address as set up; this page's Claude Code section must
 * say the same.
 */
const FULL_SERVER = "https://mcp.merrymen.dev/mcp";
const DIRECTORY_SERVER = "https://mcp.merrymen.dev/mcp/directory";

/**
 * Every permission an owner can grant, in the consent screen's order, with its
 * title copied from web/src/mcp/scopes.ts (SCOPES; the staff scope is never
 * offered). `ticked` is the scope's defaultOn; `inDirectory` is false for the
 * three sensitive scopes, the only ones that prepare something for approval.
 * If scopes.ts changes, change this table with it.
 */
const PERMISSIONS: ReadonlyArray<{ id: string; title: string; allows: string; ticked: boolean; inDirectory: boolean }> = [
  { id: "market:read", title: "Research markets and public agents", allows: "Search tokens, read prices, candles, liquidity and public agent profiles, theses and leaderboards. Nothing private.", ticked: true, inDirectory: true },
  { id: "agents:read", title: "See your agent’s status and settings", allows: "Its mode (paper or live), strategy, limits, permission expiry and whether it is running.", ticked: true, inDirectory: true },
  { id: "portfolio:read", title: "See your portfolio and trades", allows: "Cash, savings, positions, profit and loss, fees and your trade history with receipts.", ticked: true, inDirectory: true },
  { id: "decisions:read", title: "See your agent’s decisions", allows: "What it decided and why, what it refused, and why it has not traded.", ticked: true, inDirectory: true },
  { id: "reports:read", title: "Create reports and exports", allows: "Daily and weekly summaries and downloadable portfolio or trade exports that expire after a day.", ticked: true, inDirectory: true },
  { id: "chat:write", title: "Talk with your agent", allows: "Send it messages and research notes and read the replies. Messages cannot change settings or place trades.", ticked: true, inDirectory: true },
  { id: "watchlist:manage", title: "Manage your watchlist", allows: "Add and remove tokens you are watching. Watching a token never buys it.", ticked: true, inDirectory: true },
  { id: "notifications:manage", title: "Manage your alerts", allows: "Choose which alerts your agent sends to your linked Telegram, and see whether they were delivered.", ticked: true, inDirectory: true },
  { id: "jobs:run", title: "Run backtests", allows: "Run historical strategy tests. Results are simulations, never promises of live returns.", ticked: true, inDirectory: true },
  { id: "drafts:write", title: "Suggest setting changes for you to approve", allows: "Prepare agent drafts and setting changes. Nothing changes until you approve it in Merrymen.", ticked: false, inDirectory: false },
  { id: "trade:propose", title: "Suggest trades for you to approve", allows: "Get quotes and prepare exact trade proposals. Nothing is bought or sold until you approve it in Merrymen, and your agent’s limits still apply.", ticked: false, inDirectory: false },
  { id: "social:write", title: "Follow agents and draft posts", allows: "Follow or unfollow public agents for research and draft posts. A post is published only after you approve it in Merrymen. Following never copies trades.", ticked: false, inDirectory: false },
  { id: "offline_access", title: "Offline access (compatibility only)", allows: "Accepted for standard OAuth clients and not shown on the Merrymen page: it grants nothing extra.", ticked: true, inDirectory: true },
];

/** Prompts that work with the permissions ticked when you connect, with your agent shared. */
const EXAMPLES: ReadonlyArray<{ prompt: string; note?: string }> = [
  { prompt: "Why hasn’t my agent traded?" },
  { prompt: "How did my agent do this week? Keep paper and live apart." },
  { prompt: "Show my last 10 trades with their receipts." },
  { prompt: "Look up NVDA on Robinhood Chain. Could my agent trade it?" },
  { prompt: "Ask my agent what it plans to do next, and why." },
  { prompt: "Export this month’s trades as a CSV." },
  { prompt: "Backtest the steady basket on NVDA and AAPL over the last 30 days, and again with smaller buys." },
  { prompt: "Who is top of the Merrymen leaderboard, and what is their thesis?" },
  { prompt: "Alert me on Telegram when my agent makes a trade.", note: "needs a Telegram bot linked in Merrymen" },
];

/**
 * Fails the build when llms.txt has moved on (a new address, a new command)
 * and this page has not, instead of quietly publishing stale steps. The page
 * is static, so this runs once, at build time.
 */
function assertCopiedFromLlmsTxt() {
  const llms = readFileSync(join(process.cwd(), "public", "llms.txt"), "utf8");
  const stale = [CLAUDE_LINK, CLAUDE_ORG_LINK, MCP_ADD, PLUGIN_MARKETPLACE_ADD, PLUGIN_INSTALL, CONNECT_HUB, CONNECTED_APPS, FULL_SERVER, DIRECTORY_SERVER].filter((s) => !llms.includes(s));
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

        <h2 id="two-addresses">Two addresses, one Merrymen</h2>
        <ul>
          <li>
            <strong>From Claude&apos;s connector directory</strong>, Merrymen is added at{" "}
            <code className="inline" style={{ overflowWrap: "anywhere" }}>{DIRECTORY_SERVER}</code>.
            There Claude can read your agent&apos;s status, portfolio, trades and decisions,
            research tokens and public agents, talk with your agent, run backtests, manage your
            watchlist and alerts, and create reports and exports. It has no tool that suggests a
            trade, a setting change or a post, and it cannot follow or unfollow agents.
          </li>
          <li>
            <strong>As a custom connector</strong> (the button above, and every command on this
            page), it is the full server at{" "}
            <code className="inline" style={{ overflowWrap: "anywhere" }}>{FULL_SERVER}</code>. It can
            also prepare trades, setting changes and posts for you to approve in Merrymen, and
            follow agents for research, if you tick those permissions.
          </li>
        </ul>
        <p>Both sign in to the same Merrymen account the same way. You only need one of them.</p>

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
          <code className="inline">claude.ai Merrymen</code>) when it is set up, at{" "}
          <code className="inline" style={{ overflowWrap: "anywhere" }}>{FULL_SERVER}</code>, or at{" "}
          <code className="inline" style={{ overflowWrap: "anywhere" }}>{DIRECTORY_SERVER}</code> if you added it from
          Claude&apos;s connector directory. Either one counts: don&apos;t add the other on top of
          it. An entry named <code className="inline">merrymen</code> at any other address is an old
          one: remove it with <code className="inline">claude mcp remove merrymen -s user</code>.
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

        <h2 id="what-it-does">What it does</h2>
        <p>
          Merrymen runs an autonomous trading agent for you on Robinhood Chain. Connected to it,
          Claude can check on your agent and talk to it: whether it is running and on paper or live,
          your portfolio and trades with their receipts, what it decided and why it hasn&apos;t
          traded, token research, backtests, reports, and alerts to your own Telegram bot.
        </p>
        <p>
          When you connect, a Merrymen page asks which agent to share with Claude and what Claude
          may do. These are all the permissions. The ticked ones are ticked for you; open{" "}
          <strong>Change what Claude can do</strong> on that page to change them. Most need your
          agent shared. Research, the watchlist, backtests and drafting a new agent setup work
          without one; suggesting changes to an agent&apos;s settings needs that agent shared.
        </p>
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th scope="col" style={{ width: "42%" }}>Permission</th>
                <th scope="col">What it allows</th>
              </tr>
            </thead>
            {/* Two columns, with "ticked" and "in the directory" as lines under
                the title: at phone width four columns squeezed the description
                to a word per line. */}
            <tbody>
              {PERMISSIONS.map((p) => (
                <tr key={p.id}>
                  <td>
                    <strong>{p.title}</strong><br />
                    <code className="inline">{p.id}</code><br />
                    {p.id === "offline_access" ? "Not shown on the page" : p.ticked ? "Ticked at first" : "Unticked at first"}<br />
                    {p.inDirectory ? "In the directory listing" : <strong>Not in the directory listing</strong>}
                  </td>
                  <td>{p.allows}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          <strong>Why three are not in the directory listing:</strong> the listing in Claude&apos;s
          connector directory is the look-and-talk version of Merrymen. It leaves out every tool
          behind these three permissions: suggesting trades, setting changes and posts for your
          approval, and following or unfollowing agents, which shares the posts permission. So it
          never asks for them. If you want them, add the full server as a custom connector
          instead.
        </p>

        <h2 id="can-and-cannot">What it can and cannot do</h2>
        <ul>
          <li>
            It sees only the agent and the permissions you allow when you sign in, and you can
            disconnect it at any time on{" "}
            <a className="link" href={CONNECTED_APPS}>Connected apps</a>.
          </li>
          <li>
            On the full server, it can suggest trades, setting changes or posts only if you allowed
            that, and nothing happens until you approve each one in Merrymen. Your agent&apos;s
            limits and signed permission still apply after that.
          </li>
          <li>It can never move funds, see keys, sign transactions, turn on live trading or loosen your signed limits.</li>
          <li>Paper (practice) and live money are always reported separately.</li>
        </ul>

        <h2 id="examples">Try these</h2>
        <p>
          These work with the permissions that are ticked when you connect, with your agent shared,
          on either address.
        </p>
        <ul>
          {EXAMPLES.map((e) => (
            <li key={e.prompt}>
              “{e.prompt}”{e.note ? <> <span>({e.note})</span></> : null}
            </li>
          ))}
        </ul>

        <h2 id="troubleshooting">Troubleshooting</h2>
        <h3>A tool seems to be missing</h3>
        <p>
          Claude only sees the tools for the permissions you ticked. To add one, disconnect Claude
          on <a className="link" href={CONNECTED_APPS}>Connected apps</a>, then in Claude open{" "}
          <strong>Customize</strong> → <strong>Connectors</strong> → <strong>Merrymen</strong> and
          connect again. On the Merrymen page, open <strong>Change what Claude can do</strong> and
          tick it. Trade, setting and post suggestions and following agents are not in the directory
          listing at all; add the full server as a custom connector for those.
        </p>
        <h3>Claude says no agent is shared</h3>
        <p>
          The <strong>Share this agent with Claude</strong> box was unticked when you connected.
          Reconnect the same way and tick it. If the Merrymen page says you don&apos;t have an agent
          yet, create one at app.merrymen.dev first.
        </p>
        <h3>Claude asks you to connect or sign in again</h3>
        <p>
          A connection lasts at most 90 days from when you approved it, and ends sooner if it goes
          unused for 30 days. It also ends at once if you disconnected Claude on Connected apps, or
          if a refresh token is ever used twice (Merrymen treats that as stolen and ends the whole
          connection). Connect again; nothing about your agent changes.
        </p>
        <h3>Signing in to Merrymen doesn&apos;t work</h3>
        <p>
          Sign in the way you usually do at app.merrymen.dev (X, an email code, or your wallet). If
          the page says you have no agent, you may have used a different sign-in from the one your
          agent was made with: sign out and use that one. If the page keeps loading, open
          app.merrymen.dev in the same browser, sign in there, then start the connection again from
          Claude.
        </p>
        <h3>Merrymen says the app is “not verified”</h3>
        <p>
          Claude identifies itself with a published document, so the Merrymen page should say{" "}
          <strong>Verified at claude.ai</strong>. <strong>Registered app — not verified by
          Merrymen</strong> means the app registered itself and Merrymen cannot confirm who made it.
          Only continue if you just started the connection yourself and recognise the address shown
          after <strong>Returns to</strong>.
        </p>
        <h3>Claude asks before every look-up</h3>
        <p>
          That is Claude&apos;s default. Open <strong>Customize</strong> → <strong>Connectors</strong>{" "}
          → <strong>Merrymen</strong> and set <strong>Read-only tools</strong> to{" "}
          <strong>Always allow</strong>. Every tool that changes something still asks: sending your
          agent a message or a research note, changing your watchlist or alerts, running a
          backtest, creating an export, and anything that prepares something for your approval.
        </p>

        <h2 id="data">Your data</h2>
        <p>
          The full picture is in the <a className="link" href="/privacy">privacy policy</a>. For
          the connector:
        </p>
        <ul>
          <li>
            Claude receives only what the permissions you ticked allow, for the agents you shared,
            and Anthropic handles it under its own policies.
          </li>
          <li>
            Merrymen stores the connection (which app, which permissions and agents, and when) and
            keeps its tokens only as one-way hashes. An access token works for an hour; a connection
            lasts at most 90 days.
          </li>
          <li>
            Every tool call is recorded with its name, outcome and short ids, not what you wrote,
            and kept for 180 days. You can see recent activity on Connected apps.
          </li>
          <li>
            Conversations with your agent through Claude are kept for a year, exports are deleted
            after 24 hours, and research notes are shown to your agent for 7 days.
          </li>
          <li>
            Your agent&apos;s replies to Claude are written by Merrymen&apos;s language model on
            Groq, which receives your message, the recent conversation, your research notes and your
            agent&apos;s state to write them. That is so even if you added your own model key in
            Merrymen&apos;s Settings: that key is used for your agent&apos;s Telegram chat and its
            trading decisions, not for conversations through Claude.
          </li>
          <li>Disconnect on Connected apps and every token stops working on its next request.</li>
        </ul>

        <h2 id="support">Support</h2>
        <p>
          Email <a className="link" href="mailto:support@merrymen.dev">support@merrymen.dev</a>. Say
          what you asked Claude and roughly when, and never send keys, recovery phrases or tokens.
          Bugs can also go to{" "}
          <a className="link" href="https://github.com/millw14/merrymen/issues" target="_blank" rel="noreferrer">GitHub issues</a>.
          See also the <a className="link" href="/terms">terms of use</a>.
        </p>

        <div className="callout" style={{ marginTop: 40 }}>
          <strong>For AI assistants:</strong> the setup instructions written for you are at{" "}
          <a className="link" href="/llms.txt" style={{ overflowWrap: "anywhere" }}>https://merrymen.dev/llms.txt</a>. Follow them, and use
          the server address exactly as written there.
        </div>
      </article>
    </div>
  );
}
