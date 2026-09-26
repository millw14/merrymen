import type { Metadata } from "next";

const title = "Connect Merrymen MCP to ChatGPT";
const description =
  "How to connect an unfamiliar ChatGPT to your hosted Merrymen agent using the Merrymen MCP server, with OAuth sign-in and owner-approved access.";
const server = "https://mcp.merrymen.dev/mcp";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/chatgpt" },
  openGraph: { title, description, url: "https://merrymen.dev/chatgpt", siteName: "merrymen", type: "website" },
  twitter: { card: "summary", title, description, site: "@MerrymenAI", creator: "@MerrymenAI" },
};

export default function ChatGptSetup() {
  return (
    <div className="wrap" style={{ maxWidth: 760, padding: "40px 24px 80px" }}>
      <article className="doc-body">
        <h1>Connect Merrymen MCP to ChatGPT</h1>
        <p className="doc-lead">
          If you told a new ChatGPT chat “connect to Merrymen MCP”, this is the setup page it needs.
          Merrymen&apos;s hosted server address is <code className="inline">{server}</code>.
        </p>
        <p>
          ChatGPT needs the server added to your account before it can use its tools. You then sign
          in to Merrymen and choose which agent and permissions to share. A chat message alone
          cannot grant that access.
        </p>
        <p>
          If Merrymen is already installed in ChatGPT, select it in a new chat, complete any sign-in
          prompt, and ask it to call <code className="inline">list_agents</code>. Continue with the steps
          below if it is not installed.
        </p>

        <h2 id="steps">Set it up</h2>
        <ol>
          <li>In ChatGPT, open <strong>Settings → Security and login</strong> and turn on <strong>Developer mode</strong>. Availability depends on your account and workspace.</li>
          <li>Open <a className="link" href="https://chatgpt.com/plugins">ChatGPT Plugins</a>, select <strong>+</strong>, name the connection <strong>Merrymen</strong>, and enter <code className="inline">{server}</code> as the public MCP URL. Create the connection and review the tools ChatGPT discovers.</li>
          <li>Install or enable the new plugin when ChatGPT prompts you. When Merrymen opens, sign in, choose the agent and access you want to share, and click <strong>Allow</strong>.</li>
          <li>Start a new chat, select Merrymen from the plugins menu if needed, and ask it to call <code className="inline">list_agents</code> to confirm the connection.</li>
        </ol>
        <p>
          If Developer mode is unavailable, ChatGPT cannot use this manual setup route on that
          account. The <a className="link" href="https://app.merrymen.dev/connect/mcp">connection page</a> has
          setup options for other assistants.
        </p>

        <h2 id="for-assistants">For an unfamiliar ChatGPT</h2>
        <p>
          Merrymen is a hosted trading-agent service with a remote MCP server. Use the exact server
          address above and guide the user through ChatGPT&apos;s install screen. Let the user complete
          Merrymen sign-in and consent in their own browser. Never ask them to paste an API key,
          access token, password, or wallet key into the chat.
        </p>
        <p>
          The server URL is an MCP endpoint. A browser visit leads to the
          <a className="link" href="https://app.merrymen.dev/connect/mcp"> setup guide</a>; an MCP
          request without a token receives an OAuth challenge. You can check whether the endpoint
          is available at <a className="link" href="https://mcp.merrymen.dev/api/mcp/health">MCP health</a>.
        </p>

        <h2 id="access">What the connection allows</h2>
        <p>
          Merrymen shows the requested permissions before access is granted. The assistant sees
          only agents the owner shares. It can prepare a trade or setting change only with the
          owner&apos;s additional permission, and those proposals still need approval in Merrymen.
          It cannot move funds, see keys, or loosen signed trading limits. Connections can be
          revoked on <a className="link" href="https://app.merrymen.dev/connect/apps">Connected apps</a>.
        </p>
        <p>
          The MCP server is part of hosted Merrymen. The self-hosted command-line installation
          does not offer this connection. See the <a className="link" href="/privacy">privacy policy</a> for
          data handling.
        </p>
      </article>
    </div>
  );
}
