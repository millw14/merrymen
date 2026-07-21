import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "How the merrymen software and website handle your data — short version: the software runs entirely on your machine and keeps nothing on our servers.",
};

export default function Privacy() {
  return (
    <div className="wrap" style={{ maxWidth: 760, padding: "40px 24px 80px" }}>
      <article className="doc-body">
        <h1>Privacy Policy</h1>
        <p className="doc-lead">Last updated: {new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}</p>

        <div className="callout">
          <strong>The short version:</strong> merrymen is self-hosted. The software runs entirely on
          your own machine, your keys and data live in <code className="inline">~/.merrymen</code> and never leave
          it, and we operate no backend that receives them. This website collects no personal
          information about you.
        </div>

        <h2>1 · The software</h2>
        <p>
          merrymen runs locally on your computer. It stores its settings, keys, ledger, strategies,
          and your agent&apos;s “soul” files in a directory on your machine
          (<code className="inline">~/.merrymen</code> by default). This data:
        </p>
        <ul>
          <li>Stays on your machine. We have no server that receives or stores it.</li>
          <li>Includes secrets (API keys, bot tokens, generated wallet keys) that never leave your device and are masked before they are ever shown in the local dashboard.</li>
          <li>Is under your control — you can read, edit, or delete it at any time.</li>
        </ul>
        <p>
          When you configure third-party services, merrymen sends requests <em>directly from your
          machine</em> to those providers using the keys you supply:
        </p>
        <ul>
          <li><strong>Blockchain RPC / bundler providers</strong> — to read chain state and submit transactions.</li>
          <li><strong>Anthropic</strong> — if you set an Anthropic key, for the LLM strategist, chat, and vision. Message content you send is processed under Anthropic&apos;s terms.</li>
          <li><strong>Telegram</strong> — if you connect a bot, messages flow between you and your bot through Telegram under Telegram&apos;s terms.</li>
          <li><strong>Transcription provider</strong> — if you enable voice, your voice notes are sent to the endpoint you configure.</li>
        </ul>
        <p>
          We are not a party to those exchanges and do not receive copies of them. Each provider&apos;s
          own privacy policy governs the data it receives.
        </p>

        <h2>2 · This website</h2>
        <p>
          merrymen.dev is a static informational site. It does not ask you to sign in, does not use
          advertising or cross-site tracking cookies, and does not collect personal information you
          provide. Like most sites, our host (Vercel) may process basic, non-identifying request
          logs (such as IP address and user agent) for security and reliability; that processing is
          governed by the host&apos;s privacy policy. Links to third-party sites (GitHub, npm, provider
          docs) are governed by those sites&apos; policies.
        </p>

        <h2>3 · No sale or sharing of personal data</h2>
        <p>
          We don&apos;t collect personal data through the software or the site, so there is nothing for
          us to sell, rent, or share.
        </p>

        <h2>4 · Children</h2>
        <p>merrymen is not directed to children under 13 (or the minimum age in your jurisdiction), and we do not knowingly collect their data.</p>

        <h2>5 · Changes</h2>
        <p>We may update this policy; the “last updated” date above reflects the latest version.</p>

        <h2>6 · Contact</h2>
        <p>
          Questions? Email{" "}
          <a className="link" href="mailto:support@merrymen.dev">support@merrymen.dev</a> or open an issue on{" "}
          <a className="link" href="https://github.com/millw14/merrymen" target="_blank" rel="noreferrer">
            GitHub
          </a>
          .
        </p>

        <div className="callout" style={{ marginTop: 40 }}>
          This policy describes an open-source, self-hosted project in plain language and is not legal
          advice.
        </div>
      </article>
    </div>
  );
}
