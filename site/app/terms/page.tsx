import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms of Use",
  description: "Terms of use for the merrymen open-source software and website.",
};

export default function Terms() {
  return (
    <div className="wrap" style={{ maxWidth: 760, padding: "40px 24px 80px" }}>
      <article className="doc-body">
        <h1>Terms of Use</h1>
        <p className="doc-lead">Last updated: {new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}</p>

        <p>
          merrymen is free, open-source software published under the MIT License. This page explains
          the terms on which you use the software and this website (<strong>merrymen.dev</strong>).
          By installing or using the software, you agree to these terms. If you don&apos;t agree,
          don&apos;t use it.
        </p>

        <h2>1 · The software is provided “as is”</h2>
        <p>
          merrymen is provided under the MIT License, without warranty of any kind — express or
          implied — including merchantability, fitness for a particular purpose, and
          non-infringement. To the maximum extent permitted by law, the authors and contributors are
          not liable for any claim, damages, loss, or other liability arising from the software or
          its use, including any loss of funds.
        </p>

        <h2>2 · Not financial advice</h2>
        <p>
          merrymen is a tool for building and running automated trading strategies. It is{" "}
          <strong>not</strong> financial, investment, legal, or tax advice, and nothing it outputs —
          including any strategy, suggestion, or agent message — is a recommendation to buy or sell
          anything. The authors are not brokers, advisers, or fiduciaries. You are solely responsible
          for your trading decisions and for complying with the laws and regulations that apply to
          you.
        </p>

        <div className="callout danger">
          <strong>Trading digital assets carries a high risk of total loss.</strong> Prices are
          volatile, smart contracts can fail, keys can be lost or stolen, and automated systems can
          behave in unexpected ways. Never trade with funds you cannot afford to lose. Start on
          testnet, then start small.
        </div>

        <h2>3 · You control your own keys and funds</h2>
        <p>
          merrymen is self-hosted. It runs on your machine, generates and stores keys locally in
          your <code className="inline">~/.merrymen</code> directory, and interacts with public blockchains directly.
          We never take custody of your keys, funds, or accounts, and we cannot access, freeze,
          reverse, or recover them. You are responsible for:
        </p>
        <ul>
          <li>Securing the machine merrymen runs on and backing up your keys.</li>
          <li>The permission caps and capabilities you enable, including trading, transfers, and PC control.</li>
          <li>Any transactions your configured agents submit on your behalf.</li>
        </ul>

        <h2>4 · Third-party services</h2>
        <p>
          merrymen can connect to third-party services you configure — such as blockchain RPC and
          bundler providers, Anthropic, Telegram, and transcription providers. Your use of those
          services is governed by their own terms and prices. We are not responsible for their
          availability, conduct, or fees, and API keys you provide are used only to call the services
          you point them at.
        </p>

        <h2>5 · Acceptable use</h2>
        <p>
          Use merrymen lawfully. Do not use it to violate any law or regulation, to infringe others&apos;
          rights, or to interfere with networks or services you are not authorized to use. The PC
          remote-control features are intended for the machine you own and operate; do not use them
          against systems you don&apos;t control.
        </p>

        <h2>6 · The website</h2>
        <p>
          This website is provided for information about the software. It may link to third-party
          sites (such as GitHub and npm) that we don&apos;t control. We may update or remove content at
          any time.
        </p>

        <h2>7 · Changes</h2>
        <p>
          We may update these terms. Material changes will be reflected by the “last updated” date
          above. Continued use after a change means you accept the updated terms.
        </p>

        <h2>8 · Contact</h2>
        <p>
          Questions or issues? Open an issue on{" "}
          <a className="link" href="https://github.com/millw14/merrymen" target="_blank" rel="noreferrer">
            GitHub
          </a>
          .
        </p>

        <div className="callout" style={{ marginTop: 40 }}>
          These terms are written in plain language for an open-source project and are not a
          substitute for legal advice. If you operate merrymen commercially or at scale, consult a
          lawyer.
        </div>
      </article>
    </div>
  );
}
