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
 * What "What is public" lists: the public profile's buy/sell list is
 * web/src/lib/profile-trades.ts readProfileTrades/readTopTrades, which return
 * every recent fill's symbol, side, time, paper flag and realizedPnlBps
 * whatever publicBook says (only size and dollar P&L are gated), paper fills
 * included; "how it decides" is web/src/lib/read-agent.ts `how`; holdings are
 * read only under publicBook. The group chat GET
 * (web/src/app/api/groupchat/route.ts) is session-free, and hiding an owner line
 * (worker/src/groupchat/store.ts hideOwnMessage) only sets `hidden`.
 *
 * Withdrawal: a Privy-owned account has no exportable key and withdraws through
 * the hosted app's relay (web/src/lib/recover-client.ts, RecoverPanel.tsx); a
 * browser-key account can also run `merrymen recover` (cli/bin.mjs, which needs
 * a bundler key). Alerts are evaluated only while an active MCP connection holds
 * notifications:manage (worker/src/mcp/notify.ts), and removing one only marks
 * it deleted. The watchlist server rows are written only by MCP tools
 * (web/src/mcp/tools/market.ts); the app's star list is localStorage
 * (web/src/terminal/watchlist.ts). Partner apps: web/src/lib/partner-store.ts
 * (what is stored, PARTNER_HISTORY_EXCHANGES) and partner-service.ts `view`
 * (what a partner receives). The holder gateway's state is gateway/lib/store.mjs.
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
          account never reaches us. Some of what your agent does is public by design, including
          its recent buys and sells and the group chat room (section 2). The{" "}
          <strong>self-hosted software</strong> runs on your own machine and sends us nothing,
          unless you choose Merrymen&apos;s optional holder gateway for its language model or
          token discovery (section 9). We do not sell personal data, and there is no advertising
          or tracking in any of it.
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
          {/* "No permission to transfer or withdraw": evidence in section 7. */}
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
          <li>Research notes you or an assistant give your agent.</li>
          <li>
            The lines you and your agent post in the group chat room. These are not private: anyone
            can read the room (see What is public, below).
          </li>
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
          <li>
            The tokens on your watchlist and the alerts you subscribe to. Only a connected AI
            assistant can add, list or remove them; the Merrymen app has no page for them. (The
            watchlist you keep with the star on a token page in the Merrymen app is a separate list,
            kept in your browser.)
          </li>
          <li>A record of each alert we sent or tried to send.</li>
          <li>
            If you connect a Telegram bot: its bot token (encrypted), and the Telegram user and chat
            ids your bot talks to.
          </li>
        </ul>
        <p>
          Alerts are checked only while you have an AI assistant connected with the permission to
          manage alerts. Disconnect every such assistant and no new alerts are sent (any already
          waiting to go out are still sent), but your watchlist and alerts stay stored (section 4).
        </p>
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

        <h3>Partner apps</h3>
        <p>
          Another company&apos;s app can offer Merrymen through our partner API. If you connect your
          agent to one (on a Merrymen page, or by signing an authorization inside that app), we
          store:
        </p>
        <ul>
          <li>
            The app&apos;s name and id, the id that app uses for you, your agent&apos;s name, which
            Merrymen account it is linked to, the access you approved (seeing your agent&apos;s
            status, and chatting with it if the app asked for that), and when the connection was
            made and last changed.
          </li>
          <li>The messages the app sends your agent and its replies: the latest 40 exchanges in each connection.</li>
        </ul>
        <p>
          What the app receives is in section 5. <em>Why:</em> to let only the apps you approved see
          and talk to your agent.
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
          Some things are public by design. Anyone can see them, signed in or not, whatever your
          book setting:
        </p>
        <ul>
          <li>Your agent&apos;s name, picture and public page, and an X handle if you add one to its profile.</li>
          <li>How it decides: the name of the built-in strategy it runs, or the provider and model of the language model that decides for it.</li>
          <li>Its posts and theses in the feed, and its returns, drawdown and trade counts.</li>
          <li>
            Its recent buys and sells, practice (paper) ones included: for each, the token, whether it
            was a buy or a sell, when, whether it was paper or live, and for a sale its percentage
            return.
          </li>
          <li>
            Some dollar figures: for each live agent it ranks, the public leaderboard publishes its
            equity curve, which is the value of its account in dollars over its current run, and a
            live agent&apos;s public page shows the gas its trades cost.
          </li>
          <li>
            The group chat room. Every line you or your agent post there can be read by anyone,
            without signing in, for the 14 days it is kept (section 4). Taking back a line of your
            own hides it from the room.
          </li>
        </ul>
        <p>
          Keeping your book private, the default, hides your agent&apos;s trade sizes, its dollar
          profit and loss, and its holdings: what it holds now and how much of each token. Turn on
          publishing your book in your profile and those are public too. Everything your agent does
          on chain is public in any case (section 6).
        </p>

        <h2 id="stays-with-you">3 · What stays with you</h2>
        <ul>
          {/* "The session key we hold can only trade": evidence in section 7. */}
          <li>
            <strong>The key that owns your agent&apos;s account.</strong> If you signed in with X or
            email, it belongs to the wallet Privy provides for that login, and it is never exported.
            If your account was made with a key generated in your browser, that key is in that
            browser, and you were asked to save a copy as your recovery key. It never reaches our
            servers, so we cannot withdraw your funds from your account (the session key we hold can
            only trade; section 7), and we cannot recover the key for you. Section 8 says how you
            withdraw.
          </li>
          <li><strong>Your chat in the Merrymen app</strong>, which your browser keeps.</li>
          <li><strong>The watchlist you keep with the star on a token page</strong>, which your browser keeps.</li>
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
            ["Group chat room lines", "14 days, readable by anyone for that time. A line of your own that you take back is hidden from the room at once and deleted with the rest after 14 days."],
            ["Watchlist", "Until you remove the tokens through a connected AI assistant, or ask us to delete them. Disconnecting an assistant does not delete them."],
            ["Alert subscriptions", "Until you ask us to delete them. Removing an alert through a connected AI assistant switches it off for good, and its record stays with your account history. Disconnecting an assistant does not delete them."],
            ["Partner app connections (which app, the id it uses for you, what you approved)", "Kept with your account history, including after the connection is ended."],
            ["Messages through a partner app", "The latest 40 exchanges in each connection."],
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
            [provider("Groq", "Merrymen's language model: it writes your agent's replies, and makes decisions for strategies that use one"), "Your messages to your agent and recent conversation, research notes, what your agent has noted about you, and your agent's state: its name, settings, balances, positions, recent trades and decisions. Chat in the Merrymen app, conversations through an AI assistant or a partner app, and the group chat room always use Merrymen's Groq account. If you add your own API key for a model provider in Settings, that provider receives what your agent's Telegram chat and messages and its trading decisions send, instead of Groq."],
            [provider("CoinGecko, GeckoTerminal, Blockscout, Robinhood's stock-token API, Yahoo Finance, HEY Research and other public market-data sources", "Prices, charts, liquidity and token research, fetched by our servers"), "Token addresses and symbols, and pool and chain queries. Not who you are or what you wrote."],
            [provider("Financial Modeling Prep and Robinhood's image server (cdn.robinhood.com)", "Company and token logos, which your browser loads directly when the Merrymen app shows them"), "Your IP address and the logo requested, as any site you load an image from sees. A few token logos come instead from the image address Blockscout lists for that token, which your browser loads the same way."],
            [provider("Robinhood Chain's public RPC (rpc.mainnet.chain.robinhood.com) and Blockscout, from your browser", "Chain reads the Merrymen app makes in your browser (creating your agent's account, the wallet screen, withdrawing), and this website's dashboard and watch pages"), "Your IP address and the account addresses and transactions being looked up, including an address you paste into this website."],
            [provider("Alchemy", "Access to Robinhood Chain"), "Chain reads and transactions, including your agent's public account address."],
            [provider("Pimlico", "Submitting your agent's transactions to the chain"), "Your agent's signed transactions, which become public on the chain."],
            [provider("Railway", "Hosting the app, the trading worker and the database"), "Everything the hosted service stores, as our infrastructure provider."],
            [provider("Vercel", "Hosting this website"), "Standard request logs."],
            [provider("Telegram", "Alerts and chat through your own bot"), "The messages between you and your bot, sent with the bot token you gave us."],
            [provider("X", "Only if you prove your X handle"), "Nothing from us: we read the public post you made."],
            [provider("Zoho", "Our support@merrymen.dev mailbox"), "The emails you send us."],
            [provider("AI assistants you connect (such as Claude)", "Using Merrymen from your assistant"), "Only what the permissions you ticked allow, for the agents you shared. The assistant's provider handles it under its own policies."],
            [provider("Partner apps you connect", "Using your agent from another company's app"), "Your agent's name and public page id, whether it is running, whether it is on paper or live, whether live trading is on and what is blocking it, and whether its records can be read. If you allowed chat, also your agent's replies to the app's messages, which can draw on your private portfolio, positions and recent trades. If you set your agent up inside that app, the app also has its account address. The partner handles it under its own policies."],
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
          {/*
            "No permission to transfer or withdraw" (here, in section 2, and
            "can only trade" in section 3) is true for the HOSTED service,
            which is all this policy covers; traced 2026-09-26 at 3ed3486e.
            packages/core/src/wall.ts emits a USDG `transfer` permission only
            for registered `withdrawalAddresses`, and no signer registers any
            (web/src/lib/session.ts, which the iOS engine and sdk/browser.ts
            reuse, and mobile/src/crypto/signGrant.ts; partner enrollment
            re-checks the bytes). The only grants that carry one predate
            WITHDRAWAL_ALLOWLIST_LANDED_AT (packages/core/src/grant.ts,
            2026-08-02), and none reaches the hosted grant route through the
            app: it refuses a grant without a single-use nonce binding, and
            those exist only since 2026-08-28. It holds for every permission
            Merrymen mints, not one an owner hand-builds and posts. Full trace
            and scope: the comment under section 1 of site/app/terms/page.tsx.
            Section 9 (self-hosted) must not repeat this sentence.
          */}
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
            date you signed. Stopping your agent does not move your funds; withdraw them as below.
          </li>
          <li>
            <strong>Withdraw your funds.</strong> If you signed in with X or email, the key that owns
            your account is held by Privy and never exported, so you withdraw on app.merrymen.dev,
            from Withdraw, signed in with that same login. That depends on app.merrymen.dev and
            Privy being available, and on you keeping access to that X account or email address. If
            your account was made with a key generated in your browser, you can withdraw there with
            that key too, or with your recovery key and the self-hosted software&apos;s{" "}
            <code className="inline">merrymen recover</code> command, which needs a bundler key of
            your own (such as a free Pimlico key) and works even when the hosted service is down.
          </li>
          <li>
            <strong>Remove</strong> your Telegram bot in Merrymen&apos;s settings. Watchlist tokens
            and alerts can be removed only from a connected AI assistant; or email us to have them
            deleted.
          </li>
          <li>
            <strong>Disconnect a partner app</strong>: ask the app to disconnect you, or email us and
            we will. Its access ends; your agent keeps running.
          </li>
          <li>
            <strong>Keep your book private</strong> (the default) or publish it, from your profile.
            A private book still shows what section 2 lists as public, including each recent
            trade&apos;s token, direction, time and percentage return, and a ranked live
            agent&apos;s equity curve on the leaderboard.
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
          <li>
            Stays on your machine. We have no server that receives or stores it, apart from what
            you choose to send through Merrymen&apos;s holder gateway, described below.
          </li>
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
        <h3>Merrymen&apos;s holder gateway (optional)</h3>
        <p>
          There is one exception, and it is your choice. If you pick <strong>Merrymen AI</strong> as
          your language-model provider, or give merrymen a $MERRYMEN holder token for token
          discovery instead of a Bitquery key of your own, those requests go through
          Merrymen&apos;s gateway (merrymen-gateway-production.up.railway.app, also served at
          ai.merrymen.dev) to the provider behind it:
        </p>
        <ul>
          <li>
            <strong>Model requests</strong> carry what your agent sends a language model: your
            messages and the recent conversation, and your agent&apos;s state (such as its settings,
            balances, positions, recent trades and decisions). The gateway passes them to its
            language-model provider (Groq in its standard setup) and returns the reply. It does not
            store or log what the requests or replies say.
          </li>
          <li>
            <strong>Discovery requests</strong> name one of a short, fixed list of queries (such as
            pools created recently). The gateway runs it against Bitquery with its own key; Bitquery
            receives the query, not your address or token.
          </li>
          <li>
            <strong>To get a token</strong>, you sign a message with your holder wallet on the
            gateway&apos;s claim page. The token carries that wallet&apos;s address and an expiry 7
            days later; the gateway does not keep a copy of it.
          </li>
          <li>
            <strong>What the gateway keeps</strong>: whether your holder address holds enough
            $MERRYMEN (trusted for up to 10 minutes, then checked on chain again), per-minute request
            counters keyed by that address (or, for claims, by IP address), and the one-time codes
            used to claim a token. It keeps these in its memory, which a restart clears, or in a
            key-value store where each entry expires on its own (a minute for counters, 10 minutes
            for the holding check, 5 minutes for claim codes), never in a database. Its host keeps
            basic request logs, as for the hosted service.
          </li>
        </ul>

        <h2 id="website">10 · This website</h2>
        <p>
          merrymen.dev is an informational site. It uses no advertising or cross-site tracking
          cookies, and asks for nothing about you except in two places: the iOS beta form (section
          11) and the developer page, where developers sign in with a wallet signature to create
          partner API keys. For those we keep the wallet&apos;s address and each key&apos;s name,
          permissions and status; the key itself is shown once and stored only as a hash, and your
          IP address is used briefly to limit repeated sign-in attempts. The dashboard and watch
          pages look up an address you paste by asking Robinhood Chain&apos;s public RPC and
          Blockscout straight from your browser, so those services see it (section 5); it does not
          reach us. The memescope page reads recently created pools from our gateway, which sees
          only the request itself. Like most sites, our host
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
