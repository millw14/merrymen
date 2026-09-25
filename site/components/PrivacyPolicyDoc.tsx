import type { ReactNode } from "react";

/**
 * The privacy policy itself, kept in one place because it is served at two
 * URLs: `/privacy` (the canonical one, linked from the footer) and
 * `/privacypolicy` (the spelling app stores and OAuth consoles ask for). One
 * component means the two can never drift into saying different things about
 * what we store.
 *
 * It describes the HOSTED service (app.merrymen.dev) and its MCP connector
 * (mcp.merrymen.dev) as the code actually behaves. Every retention period is
 * copied from the code that enforces it, so change them together:
 * worker/src/mcp/maintenance.ts (MCP tables, hourly), docs/mcp/oauth.md and
 * docs/mcp/operations.md (token lifetimes), worker/src/store.ts
 * CHAT_TURNS_KEPT (Telegram chat), worker/src/groupchat/conductor.ts
 * retentionDays (group chat), web/src/lib/auth.ts SESSION_TTL_MS (cookie),
 * worker/src/soul.ts MAX_OWNER_FACTS / MAX_JOURNAL_CHARS (what a hosted agent
 * notes in Telegram, kept in its child home, which worker/src/orchestrator.ts
 * deletes with the grant and a redeploy discards).
 *
 * Other facts it states, and where they live: the public leaderboard's curve is
 * raw equity_usdg for every ranked live agent, whatever publicBook says
 * (web/src/lib/read-leaderboard.ts); in-app chat and assistant conversations
 * always use the web tier's own model key (web/src/lib/agent-chat.ts
 * resolveLlm(resolveConfig())), while an owner's key reaches only the worker
 * (packages/core/src/settings.ts HOUSE_KEY_FIELDS); the orchestrator writes the
 * decrypted grant and settings into the child home (writeGrantForChild,
 * writeSettingsForChild); the OAuth limiter's bucket holds the caller's IP
 * (web/src/mcp/oauth/deps.ts clientIp); and which limits the chain enforces is
 * packages/core/src/wall.ts buildWallPolicies.
 *
 * The date is fixed, not `new Date()`: a policy's date says when its words
 * last changed, and a build-time date claimed a new policy on every deploy.
 */
const LAST_UPDATED = "September 26, 2026";

const CONNECTED_APPS = "https://app.merrymen.dev/connect/apps";

/**
 * A two-column table that scrolls inside its own box on a phone rather than
 * widening the page. Two columns, not three: at phone width a third column
 * squeezed the one that matters to a word per line.
 */
function Table({ head, rows }: { head: [string, string]; rows: Array<[ReactNode, ReactNode]> }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table>
        <thead>
          <tr>
            <th scope="col" style={{ width: "40%" }}>{head[0]}</th>
            <th scope="col">{head[1]}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, i) => (
            <tr key={i}>{cells.map((c, j) => <td key={j}>{c}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A provider's name with what we use it for underneath, for the first column of section 5. */
function provider(name: string, purpose: string) {
  return <><strong>{name}</strong><br />{purpose}</>;
}

export function PrivacyPolicyDoc() {
  return (
    <div className="wrap" style={{ maxWidth: 760, padding: "40px 24px 80px" }}>
      <article className="doc-body">
        <h1>Privacy Policy</h1>
        <p className="doc-lead">Last updated: {LAST_UPDATED}</p>

        <div className="callout">
          <strong>The short version:</strong> Merrymen comes in two forms. The{" "}
          <strong>hosted service</strong> (app.merrymen.dev, and its connector for AI assistants at
          mcp.merrymen.dev) runs your trading agent for you, so it stores what that takes: who you
          are when you sign in, your agent&apos;s settings and the trading permission you signed
          (its key encrypted in our database), your agent&apos;s trading record, and the
          conversations, alerts and assistant connections you set up. The key that owns your
          account never reaches us. The{" "}
          <strong>self-hosted software</strong> runs on your own machine and sends us nothing. We do
          not sell personal data, and there is no advertising or tracking in any of it.
        </div>

        <h2 id="who-we-are">1 · Who we are</h2>
        <p>
          “Merrymen”, “we” and “us” mean the team that runs the hosted Merrymen service and
          publishes the open-source project at{" "}
          <a className="link" href="https://github.com/millw14/merrymen" target="_blank" rel="noreferrer">github.com/millw14/merrymen</a>.
          This policy covers the hosted service at app.merrymen.dev, the Merrymen MCP server that AI
          assistants connect to at mcp.merrymen.dev, this website (merrymen.dev) and the self-hosted
          software. For questions, requests or complaints, email{" "}
          <a className="link" href="mailto:support@merrymen.dev">support@merrymen.dev</a>.
        </p>

        <h2 id="what-we-collect">2 · What the hosted service stores, and why</h2>
        <p>
          We store what running your agent needs, and nothing for advertising or profiling. All of
          it is tied to your Merrymen account, which is identified by a wallet address.
        </p>

        <h3>Your sign-in</h3>
        <ul>
          <li>
            <strong>X or an email one-time code</strong> is handled by Privy. Privy tells us a Privy
            user id and the address of the wallet Privy provides for your login; that address is
            your Merrymen account. If you use X, we also keep your X user id, handle, display name
            and profile picture link. If you use email, Privy keeps your email address; we store
            only that you signed in by email.
          </li>
          <li>
            <strong>A wallet</strong>: we keep the wallet&apos;s address and check a signature from
            it. We never receive its private key.
          </li>
          <li>A sign-in cookie keeps you signed in for up to 7 days.</li>
        </ul>
        <p><em>Why:</em> to know which agent is yours and to let only you control it.</p>

        <h3>Your agent and its trading permission</h3>
        <ul>
          <li>
            Your agent&apos;s name, the picture and banner you upload, and its settings: strategy,
            tokens, limits, paper or live, alerts and Telegram, and any API key you add for your own
            language-model provider (section 5 says what it is used for).
          </li>
          <li>
            The trading permission you sign. It contains a session key that lets our hosted worker
            trade for you within the limits you signed. The copy in our database is encrypted; while
            your agent runs, the hosted worker keeps a decrypted working copy (section 7). The
            session key has no permission to transfer or withdraw your funds, but it can trade: if
            you turn on launchpad (Pons) memecoin trading, each launchpad trade pays the curve
            contract that trade names, up to your per-trade limit.
          </li>
          <li>
            Your agent&apos;s account address on Robinhood Chain, and a holder wallet address if you
            link one for the Merry Circle.
          </li>
        </ul>
        <p><em>Why:</em> to run your agent the way you set it up.</p>

        <h3>Your trading record</h3>
        <ul>
          <li>
            Trades with their on-chain receipts, your agent&apos;s decisions and the reasons it
            gave, refused trades, positions, cost basis, balances and equity over time, deposits and
            withdrawals it saw, and the fees accrued. Paper (practice) and live records are kept
            apart.
          </li>
        </ul>
        <p><em>Why:</em> so you can see what your agent did and why, and so it can keep to its limits and budget.</p>

        <h3>Conversations and research</h3>
        <ul>
          <li>Messages you send your agent through an AI assistant, and its replies.</li>
          <li>Messages you exchange with your agent through your Telegram bot: the latest 40 in each chat.</li>
          <li>
            Chat in the Merrymen app itself is kept in your browser, not on our servers. Each
            message is still sent to the language-model provider that writes the reply (section 5).
          </li>
          <li>Research notes you or an assistant give your agent, and the lines you and your agent post in the group chat room.</li>
          <li>
            What your agent notes about you in Telegram chats: short facts it picks up or you ask it
            to <code className="inline">/remember</code>, such as your Telegram handle (up to 60 at
            a time, older ones moved to an archive), and a short daily journal of its day with you.
            These live in your agent&apos;s working files on the hosted worker, not in our database
            (section 4).
          </li>
        </ul>
        <p><em>Why:</em> so your agent&apos;s replies can follow the conversation.</p>

        <h3>Watchlist, alerts and Telegram</h3>
        <ul>
          <li>The tokens on your watchlist, the alerts you subscribe to, and a record of each alert we sent or tried to send.</li>
          <li>
            If you connect a Telegram bot: its bot token (encrypted), and the Telegram user and chat
            ids your bot talks to.
          </li>
        </ul>
        <p><em>Why:</em> to deliver the alerts and chats you asked for, through your own bot.</p>

        <h3>AI assistant connections (MCP)</h3>
        <ul>
          <li>
            Each app you connect: its name and where it signs in from, the permissions you ticked,
            the agents you shared, and when the connection was made, last used and ended.
          </li>
          <li>Access tokens, refresh tokens, sign-in codes and personal access tokens, stored only as one-way hashes.</li>
          <li>
            A record of every call an app makes: the tool&apos;s name, the permission it used,
            whether it worked, how long it took, a trace id, and the names of its arguments with
            short ids. Not the text you or the assistant wrote.
          </li>
          <li>Trades, setting changes and posts an app prepared for your approval, and whether you approved or declined them.</li>
          <li>Exports you ask for, and backtests you run with their settings and results.</li>
          <li>
            The IP address that requests to our public sign-in (OAuth) endpoints come from, kept in
            a counter that limits repeated requests. It is deleted about 3 days later.
          </li>
        </ul>
        <p>
          <em>Why:</em> to let in only the apps you approved, to show you on{" "}
          <a className="link" href={CONNECTED_APPS}>Connected apps</a> what each one did, and to
          stop misuse.
        </p>

        <h3>Server logs</h3>
        <p>
          Our hosting providers keep basic request logs (such as IP address, time and the page or
          API called) for security and reliability. Our own MCP logs identify an owner or a
          connection only by a short one-way hash, and leave out addresses, tokens, message text and
          balances.
        </p>

        <h3>What is public</h3>
        <p>
          Some things are public by design: your agent&apos;s name, picture and public page, its
          posts and theses in the feed, its returns, drawdown, trade counts and per-trade
          percentages, and an X handle if you add one to its profile. Some dollar figures are
          public too, whatever your book setting: for each live agent it ranks, the public
          leaderboard publishes its equity curve, which is the value of its account in dollars over
          its current run, and a live agent&apos;s public page shows the gas its trades cost. Trade
          sizes, dollar profit and loss, and what your agent holds and how much are published only
          if you turn on publishing your book in your profile, which is off by default. Everything
          your agent does on chain is public in any case (section 6).
        </p>

        <h2 id="stays-with-you">3 · What stays with you</h2>
        <ul>
          <li>
            <strong>The key that owns your agent&apos;s account.</strong> If you signed in with X or
            email, it belongs to the wallet Privy provides for that login. If your account was made
            with a key generated in your browser, that key is in that browser. It never reaches our
            servers, so we cannot withdraw your funds from your account (the session key we hold can
            only trade; section 7), and we cannot recover the key for you.
          </li>
          <li><strong>Your chat in the Merrymen app</strong>, which your browser keeps.</li>
        </ul>

        <h2 id="retention">4 · How long we keep it</h2>
        <Table
          head={["What", "How long"]}
          rows={[
            ["Your sign-in identity, agent settings and trading record", "As long as your account exists. Nothing deletes them automatically; ask and we will delete them (records on the blockchain excepted)."],
            ["Your trading permission (the encrypted session key)", "Until you discard it on Wallet & permissions or stop your agent with Telegram /kill; the hosted worker's decrypted working copy is deleted then too. On chain, it stops working at the expiry date you signed."],
            ["Telegram bot token and ids", "Until you remove them from your settings or ask us to delete them."],
            ["Telegram chat with your agent", "The latest 40 messages in each chat."],
            ["What your agent notes about you in Telegram, and its journal", "Up to 60 facts at a time (older ones move to an archive file beside them) and about 40,000 characters of journal, in your agent's working files on the hosted worker. Deleted with those files when you discard the trading permission or stop your agent with /kill; a redeploy of the hosted worker also clears them."],
            ["Conversations through an AI assistant", "1 year."],
            ["Research notes", "Shown to your agent for 7 days, then deleted 30 days later."],
            ["Group chat room lines", "14 days."],
            ["Watchlist and alert subscriptions", "Until you remove them."],
            ["Alert delivery records", "90 days after they were created, once sent, skipped or given up on."],
            ["Exports", "24 hours."],
            ["Backtest jobs", "30 days after they finish."],
            ["Assistant connections and proposals (which app, which permissions, what you approved)", "Kept with your account history."],
            ["Access and refresh tokens", "Access tokens work for 1 hour. Refresh tokens stop working after 30 days unused, and a connection lasts at most 90 days before you approve it again. Their hashes are deleted 30 days after they expire or are revoked."],
            ["Sign-in codes and consent requests", "Codes work for 5 minutes. Both are deleted a day after they expire."],
            ["Records of assistant calls", "180 days."],
            ["Rate-limit counters, including the IP addresses of requests to our sign-in (OAuth) endpoints", "3 days."],
            ["Apps that registered themselves but no active connection uses", "30 days after registration."],
            ["Cached app metadata documents", "Deleted once they expire (at most a day later if a connection is using one)."],
            ["Sign-in cookie", "7 days."],
            ["Hosting providers' request logs", "As long as our hosting providers keep them."],
          ]}
        />

        <h2 id="third-parties">5 · Who else receives data</h2>
        <p>
          We use these providers to run the service. Each receives only what its job needs and
          handles it under its own privacy policy.
        </p>
        <Table
          head={["Provider, and what for", "What it receives"]}
          rows={[
            [provider("Privy", "Sign-in with X or email, and the wallet behind it"), "Your X account or email address and sign-in details."],
            [provider("Groq", "Merrymen's language model: it writes your agent's replies, and makes decisions for strategies that use one"), "Your messages to your agent and recent conversation, research notes, what your agent has noted about you, and your agent's state: its name, settings, balances, positions, recent trades and decisions. Chat in the Merrymen app, conversations through an AI assistant and the group chat room always use Merrymen's Groq account. If you add your own API key for a model provider in Settings, that provider receives what your agent's Telegram chat and messages and its trading decisions send, instead of Groq."],
            [provider("CoinGecko, GeckoTerminal, Blockscout, HEY Research and other public market-data sources", "Prices, charts, liquidity and token research"), "Token addresses and symbols, and pool and chain queries. Not who you are or what you wrote."],
            [provider("Alchemy", "Access to Robinhood Chain"), "Chain reads and transactions, including your agent's public account address."],
            [provider("Pimlico", "Submitting your agent's transactions to the chain"), "Your agent's signed transactions, which become public on the chain."],
            [provider("Railway", "Hosting the app, the trading worker and the database"), "Everything the hosted service stores, as our infrastructure provider."],
            [provider("Vercel", "Hosting this website"), "Standard request logs."],
            [provider("Telegram", "Alerts and chat through your own bot"), "The messages between you and your bot, sent with the bot token you gave us."],
            [provider("X", "Only if you prove your X handle"), "Nothing from us: we read the public post you made."],
            [provider("Zoho", "Our support@merrymen.dev mailbox"), "The emails you send us."],
            [provider("AI assistants you connect (such as Claude)", "Using Merrymen from your assistant"), "Only what the permissions you ticked allow, for the agents you shared. The assistant's provider handles it under its own policies."],
          ]}
        />
        <p>
          We may also disclose information when the law requires it, or to protect the service and
          its users from fraud or abuse. Our providers may process data outside your country.
        </p>

        <h2 id="on-chain">6 · On-chain data is public</h2>
        <p>
          Your agent&apos;s account address, its balances and every transaction it makes are
          recorded on Robinhood Chain, a public blockchain. Anyone can read them, and neither we nor
          anyone else can delete them.
        </p>

        <h2 id="security">7 · Security</h2>
        <ul>
          <li>
            The session key in your trading permission is encrypted with AES-256-GCM under a key
            that is kept in the service&apos;s environment, never in the database beside it. Your
            settings, including a Telegram bot token or model API key, are encrypted the same way.
          </li>
          <li>
            While your agent runs, the hosted worker decrypts the session key and your settings and
            keeps a working copy in your agent&apos;s own directory on the worker, with owner-only
            file permissions, so it can trade and run your Telegram bot. That copy is deleted when
            you discard the trading permission or stop your agent with /kill.
          </li>
          <li>
            The account contract checks every transaction the session key makes against the tokens
            and trading venues, the per-trade amount and the expiry you signed, and the session key
            has no permission to transfer or withdraw your funds. It can trade, though: if you turn
            on launchpad (Pons) memecoin trading, each launchpad trade pays the curve contract that
            trade names, up to your per-trade limit, and the chain cannot check that the contract
            is a genuine launchpad curve. Your daily operations limit and daily budget are enforced
            by our software, not by the contract.
          </li>
          <li>OAuth codes, access and refresh tokens and client secrets are stored only as SHA-256 hashes.</li>
          <li>Everything travels over HTTPS.</li>
        </ul>
        <p>No system is perfectly secure. If we learn of a breach that affects you, we will tell you.</p>

        <h2 id="your-choices">8 · Your choices</h2>
        <ul>
          <li>
            <strong>Disconnect an AI assistant</strong> on{" "}
            <a className="link" href={CONNECTED_APPS}>Connected apps</a>. Its tokens stop working on
            its next request.
          </li>
          <li>
            <strong>Stop your agent</strong>: on Wallet &amp; permissions, “discard &amp; start
            over” deletes the copy of your trading permission the hosted worker uses (or send{" "}
            <code className="inline">/kill</code>, then <code className="inline">/confirm</code>, to
            your Telegram bot). The signed permission itself stops working on chain at the expiry
            date you signed, and your owner key can move your funds out at any time.
          </li>
          <li><strong>Remove</strong> your Telegram bot, watchlist tokens or alerts in Merrymen or from a connected assistant.</li>
          <li>
            <strong>Keep your book private</strong> (the default) or publish it, from your profile.
            A private book still shows the figures listed as public in section 2, including a
            ranked live agent&apos;s equity curve on the leaderboard.
          </li>
          <li>
            <strong>Ask for a copy of your data, a correction, or deletion</strong> by emailing{" "}
            <a className="link" href="mailto:support@merrymen.dev">support@merrymen.dev</a>. We may
            need to confirm the request comes from the account holder. We cannot delete what is on
            the blockchain, and deleting your account data stops your hosted agent.
          </li>
        </ul>

        <h2 id="self-hosted">9 · The self-hosted software</h2>
        <p>
          If you run merrymen yourself, it runs on your computer. It stores its settings, keys,
          ledger, strategies and your agent&apos;s “soul” files in a directory on your machine
          (<code className="inline">~/.merrymen</code> by default). This data:
        </p>
        <ul>
          <li>Stays on your machine. We have no server that receives or stores any of it.</li>
          <li>Includes secrets (API keys, bot tokens, generated wallet keys) that never leave your device and are masked before they are ever shown in the local dashboard.</li>
          <li>Is under your control: you can read, edit or delete it at any time.</li>
        </ul>
        <p>
          When you configure third-party services, merrymen sends requests <em>directly from your
          machine</em> to those providers using the keys you supply:
        </p>
        <ul>
          <li><strong>Blockchain RPC / bundler providers</strong>, to read chain state and submit transactions.</li>
          <li><strong>The language-model provider you choose</strong> (such as Groq, Anthropic or OpenAI), for the strategist, chat and vision. The messages you send are processed under that provider&apos;s terms.</li>
          <li><strong>Telegram</strong>, if you connect a bot: messages flow between you and your bot through Telegram under Telegram&apos;s terms.</li>
          <li><strong>A transcription provider</strong>, if you enable voice: your voice notes are sent to the endpoint you configure.</li>
        </ul>
        <p>
          We are not a party to those exchanges and do not receive copies of them. Each provider&apos;s
          own privacy policy governs the data it receives.
        </p>

        <h2 id="website">10 · This website</h2>
        <p>
          merrymen.dev is an informational site. It uses no advertising or cross-site tracking
          cookies, and asks for nothing about you except in two places: the iOS beta form (section
          11) and the developer page, where developers sign in with a wallet signature to create
          partner API keys. For those we keep the wallet&apos;s address and each key&apos;s name,
          permissions and status; the key itself is shown once and stored only as a hash, and your
          IP address is used briefly to limit repeated sign-in attempts. Like most sites, our host
          (Vercel) may process basic request logs (such as IP address and user agent) for security
          and reliability. Links to third-party sites (GitHub, npm, provider docs) are governed by
          those sites&apos; policies.
        </p>

        <h2 id="ios-beta">11 · The iOS beta list</h2>
        <p>
          If you enter your email address into the iOS beta form on this site, we store that address
          so we can tell you when there is a build to install.
        </p>
        <ul>
          <li>
            <strong>What is stored:</strong> your email address, the word “ios”, and the date you
            signed up. Nothing else: no IP address, no browser or device details, no referrer, no
            tracking identifier and no time of day.
          </li>
          <li>
            <strong>Where:</strong> a file on a private disk attached to our own server. It is not in
            a third-party mailing-list product, and it is not in the public repository.
          </li>
          <li>
            <strong>What we do with it:</strong> email you about the iOS beta. Nothing else: no
            newsletter, no product marketing.
          </li>
          <li>
            <strong>How long:</strong> until the beta ships or you ask us to remove you, whichever is
            first. Ask and it is deleted, with no account needed and no confirmation loop.
          </li>
        </ul>
        <p>
          The public page shows how many people are waiting. That number reveals no one; the list of
          addresses is never served over the internet.
        </p>

        <h2 id="no-sale">12 · No sale of personal data</h2>
        <p>
          We do not sell or rent personal data, and we do not use it for advertising. It goes only to
          the providers in section 5, for the purposes described there, and to anyone you choose to
          connect.
        </p>

        <h2 id="children">13 · Children</h2>
        <p>
          The hosted service is only for adults (18 or older, or the age of majority where you live).
          The website and the self-hosted software are not directed to children under 13 (or the
          minimum age in your jurisdiction), and we do not knowingly collect children&apos;s data.
        </p>

        <h2 id="changes">14 · Changes</h2>
        <p>
          We will update this policy when what we collect, how long we keep it, or who receives it
          changes, and change the date at the top. For significant changes to the hosted service we
          will also tell signed-in users in the app.
        </p>

        <h2 id="contact">15 · Contact</h2>
        <p>
          Questions or requests? Email{" "}
          <a className="link" href="mailto:support@merrymen.dev">support@merrymen.dev</a> or open an issue on{" "}
          <a className="link" href="https://github.com/millw14/merrymen" target="_blank" rel="noreferrer">
            GitHub
          </a>
          . Please never send keys, recovery phrases or tokens.
        </p>

        <div className="callout" style={{ marginTop: 40 }}>
          This policy describes in plain language what the Merrymen service and software do with
          your data. It is not legal advice.
        </div>
      </article>
    </div>
  );
}
