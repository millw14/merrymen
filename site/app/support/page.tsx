import type { Metadata } from "next";

const title = "Merrymen support";
const description = "Get help with Merrymen, its hosted app, and AI assistant connections.";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/support" },
  openGraph: { title, description, url: "https://merrymen.dev/support", siteName: "merrymen", type: "website" },
};

export default function Support() {
  return (
    <div className="wrap" style={{ maxWidth: 760, padding: "40px 24px 80px" }}>
      <article className="doc-body">
        <h1>Merrymen support</h1>
        <p className="doc-lead">For help with an agent, the hosted app, or an AI assistant connection, email <a className="link" href="mailto:support@merrymen.dev">support@merrymen.dev</a>.</p>

        <h2>Connection help</h2>
        <p>Use the <a className="link" href="https://app.merrymen.dev/connect/mcp">assistant connection page</a> for setup links. There are separate guides for <a className="link" href="/chatgpt">ChatGPT</a> and <a className="link" href="/claude">Claude</a>. If sign-in succeeds but the assistant cannot see an agent, review the agents and permissions you shared, then check <a className="link" href="https://app.merrymen.dev/connect/apps">Connected apps</a>.</p>

        <h2>What to include</h2>
        <p>Tell us which assistant you use, the step that failed, and the time and wording of the error. You can also <a className="link" href="https://github.com/millw14/merrymen/issues">open a GitHub issue</a>. Keep passwords, API tokens, wallet keys, recovery phrases, and private portfolio details out of messages and issues.</p>

        <p>See the <a className="link" href="/privacy">privacy policy</a> and <a className="link" href="/terms">terms</a> for data handling and service information.</p>
      </article>
    </div>
  );
}
