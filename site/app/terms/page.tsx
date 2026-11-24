import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms of Use",
  description: "Terms of use for the hosted Merrymen service and its MCP connector for AI assistants, the open-source merrymen software, and this website.",
  alternates: { canonical: "/terms" },
};

/**
 * Two sets of terms on one page: the HOSTED service (sections 1-12), which
 * runs an agent with a session key the owner delegated, and the MIT-licensed
 * SELF-HOSTED software and this website (13-17). They differ on the one thing
 * that matters most, who runs the agent, so each says so plainly.
 *
 * The fee paragraph describes worker/src/fees.ts as it is: both fees are
 * ACCRUED in the ledger and nothing collects them, because collection needs a
 * transfer permission no grant carries (packages/core/src/wall.ts
 * withdrawalAddresses). Rates are the defaults in packages/core/src/settings.ts.
 * If either changes, this page changes with it.
 *
 * Section 1 splits the limits the way packages/core/src/wall.ts does: the
 * account contract checks tokens and venues, the per-trade amount, the expiry
 * and the absence of any transfer permission; maxOpsPerDay and the daily
 * budget are worker-enforced only (buildWallPolicies). A launchpad trade's
 * curve is caller-supplied and unpinnable (the Pons adapter and class vault
 * permissions), so it is named rather than hidden.
 *
 * Section 8 splits withdrawal by owner, as the code does: a Privy-owned account
 * (web/src/terminal/Providers.tsx loginMethods, CreateAgent.tsx) has no
 * exportable key and withdraws only through the hosted app's relay
 * (web/src/lib/recover-client.ts, RecoverPanel.tsx); a browser-key account can
 * also run `merrymen recover` (cli/bin.mjs), which refuses without a bundler key.
 * Never promise withdrawal "when the hosted service is down" to the first kind.
 *
 * The date is fixed, not `new Date()`: it says when these words last changed.
 */
const LAST_UPDATED = "September 26, 2026";

const CONNECTED_APPS = "https://app.merrymen.dev/connect/apps";

export default function Terms() {
  return (
    <div className="wrap" style={{ maxWidth: 760, padding: "40px 24px 80px" }}>
      <article className="doc-body">
        <h1>Terms of Use</h1>
        <p className="doc-lead">Last updated: {LAST_UPDATED}</p>

        <p>
          Merrymen comes in two forms, and these terms cover both. The <strong>hosted
          service</strong> at app.merrymen.dev runs an autonomous trading agent for you, and its MCP
          server at mcp.merrymen.dev lets AI assistants you connect work with it (sections 1–12).
          The <strong>merrymen software</strong> is free, open-source software under the MIT License
          that you run yourself, and <strong>merrymen.dev</strong> is its website (sections 13–17).
          Sections 18 and 19 apply to everything. By using the hosted service, connecting an AI
          assistant to it, or installing or using the software, you agree to these terms. If you
          don&apos;t agree, don&apos;t use them.
        </p>

        <div className="callout danger">
          <strong>Trading digital assets carries a high risk of total loss.</strong> Prices are
          volatile, smart contracts can fail, keys can be lost or stolen, and automated agents can
          behave in unexpected ways. Never trade with funds you cannot afford to lose. Start on
          paper, then start small.
        </div>

        <h2 id="hosted-service">1 · What the hosted service does</h2>
        {/*
          "NO POWER TO TRANSFER OR WITHDRAW" (here, below, and section 6) is
          true for the HOSTED service, traced 2026-09-26 at 3ed3486e:
          - packages/core/src/wall.ts buildCallPermissions emits a USDG
            `transfer` permission only when `withdrawalAddresses` is non-empty.
          - No signer can pass one. web/src/lib/session.ts builds `wallOpts`
            without it and MintOptions has no such field; ios-native/Signing/
            engine.ts and sdk/browser.ts sign through that file, and
            mobile/src/crypto/signGrant.ts omits it too. Partner enrollment
            rebuilds the canonical wall (web/src/lib/partner-enrollment.ts
            validGrant, grantWallOptions) and refuses different bytes.
            worker/src/transfer-mirror.test.ts pins the default wall.
          - Only grants signed before WITHDRAWAL_ALLOWLIST_LANDED_AT
            (packages/core/src/grant.ts, 2026-08-02) carry one, with any
            recipient. The hosted route (web/src/app/api/grants/route.ts)
            refuses a grant without a binding over a single-use server nonce
            (web/src/lib/auth.ts verifyGrantBinding), and bindings exist only
            since 2026-08-28, so no such grant reaches it through the app.
          SCOPE: self-hosted, a pre-2026-08-02 grant can still be unexpired
          (its grant page offered 90-day keys and did not clamp a typed
          expiry), so section 14 must not repeat this. And
          /api/grants does not re-check the policy bytes the way partner
          enrollment does: this holds for every permission Merrymen mints, not
          one an owner hand-builds and posts. If a signer ever registers a
          withdrawal address, change these words and PrivacyPolicyDoc first.
        */}
        <p>
          The hosted service runs a trading agent for you on Robinhood Chain. You create an agent
          with its own account on the chain, fund it, choose a strategy, and sign a trading
          permission. The account&apos;s contract checks every transaction against that
          permission&apos;s hard limits: which tokens and trading venues it may use, how much it
          may spend per trade, and when the permission expires. The permission carries no power to
          transfer or withdraw your funds.
        </p>
        <p>
          Our hosted worker holds that permission&apos;s session key and uses it to trade on its
          own within your signed limits, without asking you each time. The copy in our database is
          encrypted; while your agent runs, the worker keeps a decrypted working copy so it can
          trade. The session key cannot transfer or withdraw your funds; only the key that owns
          your account can withdraw. It can trade, though, and if you turn on launchpad (Pons)
          memecoin trading, each launchpad trade pays the curve contract that trade names, up to
          your per-trade limit, and the chain cannot check that the contract is a genuine launchpad
          curve. Other limits, such as how many operations your agent may make per day, its daily
          budget and stop-losses, are enforced by our software rather than on the chain.
        </p>

        <h2 id="eligibility">2 · Who may use it</h2>
        <p>
          You must be at least 18 (or the age of majority where you live) and able to agree to these
          terms. Use the hosted service only where using it, and trading the tokens it trades, is
          lawful for you, and not if you are the subject of sanctions or in a place where that is
          prohibited. You are responsible for any taxes on your trading. Do not use the service to
          break the law, manipulate markets, launder money, attack the service or other users, or
          get around its limits.
        </p>

        <h2 id="not-advice">3 · Not investment advice</h2>
        <p>
          Nothing the hosted service, your agent, a connected AI assistant, the software or this
          website says is financial, investment, legal or tax advice, or a recommendation to buy or
          sell anything. Strategies, agent messages, leaderboards, backtests and other agents&apos;
          theses are information, not advice. We are not a broker, exchange, adviser or fiduciary,
          and we never hold your funds. You are responsible for your trading decisions, including
          the decision to let an agent trade for you.
        </p>

        <h2 id="risk">4 · Risk of loss</h2>
        <p>
          <strong>You can lose everything you put in an agent&apos;s account.</strong> Token prices
          can fall to zero. A token named after or tracking a stock is not that stock, and its price
          can differ from the stock&apos;s. Launchpad coins can be abandoned or manipulated. Pools can
          be thin and fills far worse than quoted. Smart contracts, the chain, transaction services,
          price feeds and our own software can fail or behave unexpectedly, and an agent can make
          many losing trades quickly while staying inside its limits. Backtests and paper results do
          not predict live results.
        </p>

        <h2 id="paper-live">5 · Paper and live trading</h2>
        <p>
          A new agent trades on paper: simulated money at live prices, with no real orders. It
          trades real funds only after you fund its account and turn on <strong>Live
          trading</strong> in Settings; funding the account or re-signing the permission does not
          turn it on. Paper and live results are always reported separately and never added
          together. Paper trades pay no fees or gas, so paper results can look better than the same
          trades would do live.
        </p>

        <h2 id="fees">6 · Fees</h2>
        <ul>
          <li>
            <strong>Per-trade fee:</strong> each live trade accrues a platform fee of 0.5% of the
            trade&apos;s size (50 basis points of its amount in USDG, rounded down), whether the
            trade makes or loses money. Moving your own money is not a trade and accrues nothing.
          </li>
          <li>
            <strong>Performance fee:</strong> a live agent accrues 10% of any profit above its
            previous high-water mark. There is no fee on losses or on recovering to a previous peak.
            Holding $MERRYMEN can lower it (the Merry Circle).
          </li>
        </ul>
        {/* "a transfer permission that the permission you signed does not
            contain": the evidence is the comment under section 1's heading. */}
        <p>
          Both are recorded in your agent&apos;s ledger, where you can see them.{" "}
          <strong>Today neither is collected:</strong> no money moves to us, because collecting
          would need a transfer permission that the permission you signed does not contain. Before
          we start collecting any fee we will update these terms, and you would have to sign a new
          permission that names where the fee goes. Network fees (gas) for live trades are paid from
          your account in ETH unless your account is sponsored. Paper trades accrue no fees.
        </p>

        <h2 id="ai-assistants">7 · AI assistant connections</h2>
        <p>
          You can connect AI assistants, such as Claude, to your account through our MCP server. On
          a Merrymen page, signed in as yourself, you choose which agents an assistant may see and
          what it may do, and you can disconnect it at any time on{" "}
          <a className="link" href={CONNECTED_APPS}>Connected apps</a>.
        </p>
        <ul>
          <li>
            Depending on what you allow, an assistant can read your agent&apos;s status, portfolio,
            trades and decisions, research tokens, talk with your agent, manage your watchlist and
            alerts, run backtests and create exports.
          </li>
          <li>
            With permissions that start unticked, it can also follow agents for research and
            prepare trades, setting changes and posts. Nothing is traded, changed or posted until
            you approve each one on a Merrymen page while signed in, and your agent&apos;s limits and
            signed permission still apply after that. The listing in Claude&apos;s connector
            directory does not offer these at all.
          </li>
          <li>
            An assistant can never move funds, see keys, sign transactions, turn on live trading,
            loosen your signed limits, or act on another owner&apos;s agent.
          </li>
        </ul>
        <p>
          The assistant is provided by a third party under its own terms. What it says may be wrong,
          and you are responsible for what you ask it to do and for what you approve.
        </p>

        <h2 id="keys-funds">8 · Your account, keys and funds</h2>
        <p>
          Your agent&apos;s account is yours. The key that owns it stays with the wallet behind your
          sign-in, or in the browser that created it; we never hold it. So we cannot recover it,
          reverse a transaction, or move your funds out for you. Keep your sign-in and any recovery
          key safe: whoever controls them controls the account. How you withdraw depends on how the
          account was made:
        </p>
        <ul>
          <li>
            <strong>Signed in with X or email.</strong> The account is owned by the wallet Privy
            provides for that login, and its key is never exported. You withdraw on
            app.merrymen.dev, from Withdraw, signed in with that same login. Withdrawing therefore depends on
            app.merrymen.dev and Privy being available, and on you keeping access to that X account
            or email address.
          </li>
          <li>
            <strong>Made with a key generated in your browser.</strong> You can withdraw on
            app.merrymen.dev with that key, or use your recovery key with the self-hosted
            software&apos;s <code className="inline">merrymen recover</code> command, which needs a
            bundler key of your own (such as a free Pimlico key) and works even when the hosted
            service is unavailable.
          </li>
        </ul>

        <h2 id="availability">9 · Availability and no warranty</h2>
        <p>
          The hosted service is provided “as is” and “as available”. We do not promise that it will
          be uninterrupted, timely, secure or free of errors, that your agent will trade, that a
          trade will fill at a particular price, or that the data it shows is complete or current. We
          may change, pause or stop the service or any part of it, for example switching off AI
          assistant connections in an emergency. To the extent the law allows, we disclaim all
          warranties, express or implied, including merchantability, fitness for a particular
          purpose and non-infringement.
        </p>

        <h2 id="robinhood">10 · Not affiliated with Robinhood</h2>
        <p>
          Merrymen is independent. It is not affiliated with, endorsed by or sponsored by Robinhood
          Markets, Inc. or its affiliates. “Robinhood Chain” is the public blockchain the agents
          trade on. Token and company names belong to their owners.
        </p>

        <h2 id="ending">11 · Ending your use</h2>
        <p>You can stop whenever you like:</p>
        <ul>
          <li>disconnect AI assistants on <a className="link" href={CONNECTED_APPS}>Connected apps</a>;</li>
          <li>
            on Wallet &amp; permissions, “discard &amp; start over” deletes the copy of your trading
            permission the hosted worker uses (or send <code className="inline">/kill</code>, then{" "}
            <code className="inline">/confirm</code>, to your Telegram bot). The signed permission
            stays valid on the chain until the expiry you signed, but the hosted worker no longer
            has it;
          </li>
          <li>withdraw your funds as section 8 describes; and</li>
          <li>email <a className="link" href="mailto:support@merrymen.dev">support@merrymen.dev</a> to have your account data deleted.</li>
        </ul>
        <p>
          We may suspend or end your access to the hosted service if you break these terms, if the
          law requires it, or to protect the service or its users. Your funds stay in your account
          either way.
        </p>

        <h2 id="liability">12 · Limitation of liability</h2>
        <p>
          To the fullest extent the law allows, we are not liable for any indirect, incidental,
          special, consequential or punitive damages, or for lost profits, lost funds, trading losses
          or lost data, arising from the hosted service, your agent&apos;s trades, a connected
          assistant or these terms. Where liability cannot be excluded, our total liability is
          limited to the fees you have actually paid us in the 12 months before the claim. Some
          places do not allow these limits, so they may not all apply to you.
        </p>

        <h2 id="software">13 · The software is provided “as is”</h2>
        <p>
          The merrymen software is provided under the MIT License, without warranty of any kind,
          express or implied, including merchantability, fitness for a particular purpose, and
          non-infringement. To the maximum extent permitted by law, the authors and contributors are
          not liable for any claim, damages, loss, or other liability arising from the software or
          its use, including any loss of funds. Section 3 (not advice) applies to it too.
        </p>

        <h2 id="self-hosted-keys">14 · Self-hosted: you control your own keys and funds</h2>
        <p>
          <strong>For on-chain trading</strong>, the self-hosted software is non-custodial. It runs
          on your machine, generates and stores keys locally in
          your <code className="inline">~/.merrymen</code> directory, and interacts with public blockchains directly.
          We never take custody of your private keys or on-chain funds, and we cannot access, freeze,
          reverse, or recover them. You are responsible for:
        </p>
        <ul>
          <li>Securing the machine merrymen runs on and backing up your keys.</li>
          <li>The permission caps and capabilities you enable, including trading, transfers, and PC control.</li>
          <li>Any transactions your configured agents submit on your behalf.</li>
        </ul>
        <p>
          <strong>Connected brokerage accounts are different, and we say so plainly.</strong> If
          merrymen adds support for a brokerage venue (such as a Robinhood Agentic account) and you
          choose to connect one: the brokerage — not merrymen — is the custodian of that account
          and its funds. Connecting authorizes merrymen to hold a revocable OAuth trading token for
          that account. That token can place trades within the budget you configured at the
          brokerage; the brokerage&apos;s permission model does not offer a read-only grant, so any
          &quot;monitor only&quot; behavior is a feature of merrymen&apos;s software, not a technical
          restriction on the token. Your brokerage login credentials are never seen or stored by
          merrymen — authorization happens on the brokerage&apos;s own pages — and you can revoke
          the connection at the brokerage at any time, independently of us.
        </p>

        <h2 id="third-party">15 · Third-party services</h2>
        <p>
          merrymen can connect to third-party services you configure, such as blockchain RPC and
          bundler providers, language-model providers, Telegram, and transcription providers. Your
          use of those services is governed by their own terms and prices. We are not responsible
          for their availability, conduct, or fees, and API keys you provide are used only to call
          the services you point them at.
        </p>

        <h2 id="acceptable-use">16 · Acceptable use</h2>
        <p>
          Use merrymen lawfully. Do not use it to violate any law or regulation, to infringe others&apos;
          rights, or to interfere with networks or services you are not authorized to use. The PC
          remote-control features are intended for the machine you own and operate; do not use them
          against systems you don&apos;t control.
        </p>

        <h2 id="website">17 · The website</h2>
        <p>
          This website is provided for information about Merrymen. It may link to third-party sites
          (such as GitHub and npm) that we don&apos;t control. We may update or remove content at any
          time.
        </p>

        <h2 id="changes">18 · Changes</h2>
        <p>
          We may update these terms; the date at the top shows the latest version. Material changes
          to the hosted service terms will be posted here before they take effect. Continued use
          after a change means you accept the updated terms.
        </p>

        <h2 id="contact">19 · Contact</h2>
        <p>
          Questions or issues? Email{" "}
          <a className="link" href="mailto:support@merrymen.dev">support@merrymen.dev</a> or open an issue on{" "}
          <a className="link" href="https://github.com/millw14/merrymen" target="_blank" rel="noreferrer">
            GitHub
          </a>
          . Our <a className="link" href="/privacy">privacy policy</a> explains what we store and why.
        </p>

        <div className="callout" style={{ marginTop: 40 }}>
          These terms are written in plain language and are not a substitute for legal advice.
        </div>
      </article>
    </div>
  );
}
