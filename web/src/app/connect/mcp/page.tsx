import type { Metadata } from "next";
import { mcpConfig } from "@/mcp/config";
import "../connect.css";
import "../mcp-connect.css";
import { BrandLockup } from "../BrandLockup";

export const metadata: Metadata = {
  title: "Connect Merrymen to your AI assistant · merrymen",
  description: "Use your Merrymen agent from Claude, Codex and other MCP clients.",
  referrer: "no-referrer",
};

// The server address comes from configuration at request time; never prerender
// it inside the image build, where the variables do not exist.
export const dynamic = "force-dynamic";

export default function ConnectMcpPage() {
  const cfg = mcpConfig();
  const url = cfg.resource || "https://mcp.merrymen.dev/mcp";
  return (
    <div className="terminal-host partner-connect mcp-connect">
      <header className="connect-header">
        <BrandLockup />
        <span className="connect-header-label">Connect an AI assistant</span>
      </header>
      <main className="connect-main">
        <div className="connect-context">
          <span className="connect-eyebrow">MCP</span>
          <h1>Your Merryman,<br />in your assistant.</h1>
          <p>Ask Claude, Codex or any MCP-compatible assistant about your agent: its portfolio, why it did or didn’t trade, the market, and what to do next. Merrymen stays in charge of your agent, your limits and your money.</p>
          <p className="mcp-note">Server address: <code>{url}</code></p>
          {!cfg.enabled && <p className="mcp-note">MCP is not enabled on this server{cfg.disabledWhy ? ` (${cfg.disabledWhy})` : ""}.</p>}
        </div>
        <section className="connect-panel mcp-docs">
          <h2>Connect</h2>
          <h3>Claude (web, desktop, mobile)</h3>
          <p>Settings → Connectors → <b>Add custom connector</b>. Name it Merrymen and paste the server address. Click Connect, sign in to Merrymen, choose what Claude may do, and approve.</p>
          <h3>Claude Code</h3>
          <pre>{`claude mcp add --transport http merrymen ${url}\nclaude mcp login merrymen`}</pre>
          <h3>Codex (CLI and IDE)</h3>
          <pre>{`# ~/.codex/config.toml\n[mcp_servers.merrymen]\nurl = "${url}"`}</pre>
          <pre>{`codex mcp login merrymen`}</pre>
          <h3>Other MCP clients</h3>
          <p>Use the server address with Streamable HTTP and OAuth. Clients that cannot sign in through a browser can use a personal access token from <a href="/connect/apps">Connected apps</a> as a Bearer token.</p>

          <h2>What an assistant can and cannot do</h2>
          <ul>
            <li>It sees only the agents and permissions you choose when you connect, and you can disconnect it at any time on <a href="/connect/apps">Connected apps</a>.</li>
            <li>It can read your agent’s status, portfolio, trades, decisions and the market; explain why your agent hasn’t traded; talk with your agent; run backtests; and manage your watchlist and alerts — each only if you allowed it.</li>
            <li>It can <b>prepare</b> trades and setting changes, but nothing happens until you approve them here in Merrymen. Your agent’s own limits and its on-chain permission still apply after that.</li>
            <li>It can never move your funds, see your keys, turn on live trading or loosen your signed limits.</li>
            <li>Paper (practice) results are always shown separately from real money. A proposal is not a trade; a trade is confirmed only after its on-chain receipt.</li>
            <li>Your agent keeps trading and protecting its positions whether or not an assistant is connected.</li>
          </ul>
        </section>
      </main>
      <footer className="connect-footer">Merrymen · <a href="/connect/apps">Connected apps</a></footer>
    </div>
  );
}
