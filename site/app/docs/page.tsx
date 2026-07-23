import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Docs",
  description: "Install merrymen, create and fund a wallet, run it, set up Telegram, enable PC control, and understand the safety model.",
};

const TOC = [
  ["Getting started", [["install", "Install"], ["wallet", "Create & fund a wallet"], ["run", "Run it"]]],
  ["Telegram", [["telegram", "Set up Telegram"], ["commands", "Commands"], ["transfers", "Transfers"], ["pc-control", "PC remote control"], ["voice", "Voice & vision"], ["soul", "The soul"]]],
  ["Trading", [["strategies", "Strategies"], ["custom", "Write your own bot"], ["virtuals", "Stream to Virtuals"]]],
  ["Reference", [["safety", "Safety model"], ["config", "Configuration"], ["troubleshooting", "Troubleshooting"], ["faq", "FAQ"]]],
] as const;

const GITHUB = "https://github.com/millw14/merrymen";

export default function Docs() {
  return (
    <div className="wrap doc-shell">
      <aside className="doc-side">
        <nav className="doc-toc">
          {TOC.map(([group, items]) => (
            <div key={group}>
              <h6>{group}</h6>
              {items.map(([id, label]) => (
                <a key={id} href={`#${id}`}>
                  {label}
                </a>
              ))}
            </div>
          ))}
        </nav>
      </aside>

      <article className="doc-body">
        <h1>Documentation</h1>
        <p className="doc-lead">
          merrymen is a self-hosted band of autonomous trading agents for Robinhood Chain. Everything
          runs on your machine; your keys never leave it. This guide takes you from install to a
          named agent you chat with on Telegram.
        </p>

        {/* ── install ── */}
        <h2 id="install">Install</h2>
        <p>
          Runs on <strong>Linux, macOS, and Windows</strong> — one Node package, no Docker, no clone.
          Requires <strong>Node 22.12+</strong> (for the built-in SQLite); no Node yet? The one-line
          installer sets it up and puts merrymen on your PATH.
        </p>
        <pre className="code">
{`# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/millw14/merrymen/main/install.sh | bash

# Windows (PowerShell)
irm https://raw.githubusercontent.com/millw14/merrymen/main/install.ps1 | iex`}
        </pre>
        <p>Already have Node 22.12+? This works on any OS:</p>
        <pre className="code">
{`npm install -g merrymen
merrymen setup      # checks node / npm / PATH, prints exact fixes
merrymen start      # dashboard at localhost:3100 + the worker
merrymen update     # upgrade later (stops the band, installs, restarts)`}
        </pre>
        <p>
          On a headless Linux box the dashboard won&apos;t auto-open — it prints{" "}
          <code className="inline">localhost:3100</code>; set{" "}
          <code className="inline">MERRYMEN_HOST=0.0.0.0</code> to reach it across a trusted LAN.
          Verify a fresh box with <code className="inline">merrymen doctor</code> — it checks Node,
          SQLite, RPC reach, keys, and paper/live mode, no wallet needed.
        </p>
        <div className="callout">
          <strong>“merrymen: command not found”?</strong> npm&apos;s global-bin folder isn&apos;t on your PATH.
          Use <code className="inline">npx merrymen start</code>, or run <code className="inline">merrymen setup</code> for the
          exact one-time fix for your OS.
        </div>
        <p>
          All your data lives in <code className="inline">~/.merrymen</code> (settings, grant, ledger, your
          strategies, your agent&apos;s soul). The install is disposable — upgrades never touch your data.
          The dashboard binds to <strong>localhost only</strong>; to reach it from your phone on a
          trusted network, start with <code className="inline">MERRYMEN_HOST=0.0.0.0 merrymen start</code>.
        </p>

        {/* ── wallet ── */}
        <h2 id="wallet">Create &amp; fund a wallet</h2>
        <p>
          Open <code className="inline">localhost:3100/grant</code>. There is nothing to connect — merrymen
          generates a fresh account, shows you the owner key to <strong>back up</strong>, and lets you
          fund it. Pick your ground:
        </p>
        <table>
          <thead>
            <tr><th>chain</th><th>what it is</th></tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>testnet · 46630</strong></td>
              <td>The sandbox (default). Free <strong>gas</strong> from the faucet, and the grant, caps, policy checks, live prices and journal all run for real. The trading venues aren&apos;t deployed there, so swaps simulate and no-route by design. <strong>Send gas, not capital:</strong> merrymen only knows the mainnet token addresses, so USDG sent to testnet reads 0 and is never traded — the band trades a simulated 1,000 USDG paper book at live prices instead.</td>
            </tr>
            <tr>
              <td><strong>mainnet · 4663</strong></td>
              <td>Real funds. Real USDG, real Stock Tokens, real execution. Keys are stored in plain text on your machine, so treat the account like a hot wallet — your caps are the seatbelt, start small. No faucet: send ETH (gas) + USDG (capital) from your own wallet or an exchange.</td>
            </tr>
          </tbody>
        </table>
        <div className="callout danger">
          <strong>Back up the owner key.</strong> It controls the account and every dollar in it. Lose
          it and the funds are gone — there is no recovery service.
        </div>
        <p>
          The caps you set — per-trade, daily, ops/day, drawdown breaker, key expiry — are enforced{" "}
          <strong>by the account contract on every operation</strong>. The worker can tighten within
          them but never widen them without a new signed grant.
        </p>
        <div className="callout">
          <strong>Going live is one key.</strong> To sign real trades, paste a free{" "}
          <a href="https://dashboard.pimlico.io" target="_blank" rel="noreferrer">Pimlico</a> API key in
          settings — merrymen builds the bundler URL for your wallet&apos;s chain automatically, so it can
          never point at the wrong one. No key? The band runs in <strong>practice mode</strong>: real
          market, full policy + simulation, no signing. Advanced users can still paste a full bundler
          URL (Alchemy or self-hosted) instead.
        </div>

        {/* ── run ── */}
        <h2 id="run">Run it</h2>
        <pre className="code">
{`merrymen start      # dashboard (localhost:3100) + the 24/7 worker
merrymen doctor     # node / keys / RPC / bundler / grant / db checks
merrymen status     # heartbeat, grant, trades, equity
merrymen selftest   # one policy-legal no-op through the full pipeline
merrymen kill       # kill switch — destroys the grant`}
        </pre>
        <p>
          Each tick the worker runs: <strong>grant sync → market safety → strategy proposes → policy
          check → quote simulation → execute → record</strong>. It re-reads your settings every tick,
          so dashboard changes apply within one tick — no restart.
        </p>

        {/* ── telegram ── */}
        <h2 id="telegram">Set up Telegram</h2>
        <ol>
          <li>Message <strong>@BotFather</strong> → <code className="inline">/newbot</code> → copy the token.</li>
          <li>Dashboard → <strong>Settings → Telegram</strong> → paste the token, hit <strong>test connection</strong> (it shows your <code className="inline">@botname</code>), enable.</li>
          <li>Message your bot <code className="inline">/link &lt;code&gt;</code> — the one-time code is shown in settings. You become the owner; only allowlisted chats are obeyed.</li>
        </ol>
        <p>
          There&apos;s a <strong>Chat on Telegram</strong> button on the dashboard too. Commands work
          bare; with an Anthropic key set, plain English works — “how are we doing?”, “pause
          everything”, “why did you buy that?”.
        </p>

        {/* ── commands ── */}
        <h2 id="commands">Commands</h2>
        <table>
          <tbody>
            <tr><td><code className="inline">/status /positions /pnl /trades</code></td><td>read the live book</td></tr>
            <tr><td><code className="inline">/report · /brag · /why</code></td><td>daily report · shareable scorecard · explain the last trade</td></tr>
            <tr><td><code className="inline">/buy &lt;SYM&gt; &lt;usdg&gt; · /sell …</code></td><td>trade (passes the policy wall)</td></tr>
            <tr><td><code className="inline">/transfer &lt;0x…&gt; &lt;usdg&gt;</code></td><td>send USDG out — always asks to /confirm</td></tr>
            <tr><td><code className="inline">/alert &lt;SYM&gt; &gt; &lt;price&gt;</code></td><td>one-shot price alerts · /alerts · /unalert</td></tr>
            <tr><td><code className="inline">/pause /resume · /strategy · /cap</code></td><td>steer the worker (cap only tightens)</td></tr>
            <tr><td><code className="inline">/name · /soul · /remember</code></td><td>name it, see who it is, teach it about you</td></tr>
            <tr><td><code className="inline">/kill</code></td><td>destroy the grant, stand the band down</td></tr>
          </tbody>
        </table>
        <p>
          <strong>It speaks first too</strong> (toggle in settings): a ping the moment a trade lands
          or the wall turns one back, warnings for grant expiry / drawdown / low gas, your price
          alerts, and a daily campfire report at the hour you pick.
        </p>

        {/* ── transfers ── */}
        <h2 id="transfers">Transfers</h2>
        <p>Sending USDG out of the account is triple-guarded:</p>
        <ul>
          <li><strong>Off by default</strong> — enable “allow transfers” in settings.</li>
          <li><strong>Amount-capped on-chain</strong> — the grant&apos;s call policy caps the per-transfer amount.</li>
          <li><strong>Always confirmed</strong> — every transfer echoes the full recipient address and waits for an explicit <code className="inline">/confirm</code> (90s), plus a daily transfer budget.</li>
        </ul>
        <p>
          A prompt-injected “send everything to 0xevil” can at worst produce a confirmation card you
          will see and <code className="inline">/cancel</code>. Transfers need a wallet created with the transfer
          permission; a pre-transfer grant gets a “re-create your wallet” reply instead.
        </p>

        {/* ── pc control ── */}
        <h2 id="pc-control">PC remote control</h2>
        <p>
          Enable the <strong>remote control</strong> section in settings and your merryman can act on
          the machine it runs on, from Telegram. It is a hot wallet for your desktop, so the whole
          design is safety-first:
        </p>
        <table>
          <tbody>
            <tr><td>📸 screen · 👁️ vision</td><td><code className="inline">/shot</code>; “what am I looking at? / read this error”</td></tr>
            <tr><td>🚀 apps &amp; web</td><td><code className="inline">/open spotify</code>, <code className="inline">/open github.com</code></td></tr>
            <tr><td>⚙️ system</td><td><code className="inline">/sys</code>, volume, media, <code className="inline">/notify</code>, <code className="inline">/lock</code>, sleep/shutdown</td></tr>
            <tr><td>📂 files · 📋 clipboard</td><td><code className="inline">/ls</code>, <code className="inline">/get</code> inside one folder you pick; clipboard</td></tr>
            <tr><td>🖥️ shell · ⌨️ keyboard</td><td><code className="inline">/run</code> allowlisted commands; <code className="inline">/type</code>, <code className="inline">/key ctrl+s</code></td></tr>
            <tr><td>👀 watchers</td><td><code className="inline">/remind 20m …</code>, <code className="inline">/watch cpu&gt;80</code>, watch a file or process</td></tr>
          </tbody>
        </table>
        <ul>
          <li><strong>Off by default</strong>, then one capability at a time. <code className="inline">/pc</code> shows what&apos;s on; the master switch off kills all of it.</li>
          <li><strong>Allowlists for the sharp edges</strong>: shell runs only your exact pre-approved commands (chaining/redirects refused); files are confined to one root (no <code className="inline">..</code> escape); apps to a name list.</li>
          <li><strong>Confirm gate</strong>: shell, keyboard, file-send, and power never fire until you <code className="inline">/confirm</code> the exact action echoed back.</li>
        </ul>
        <div className="callout">Windows is fully supported; macOS/Linux use the standard tools and say so where one isn&apos;t present.</div>

        {/* ── voice ── */}
        <h2 id="voice">Voice &amp; vision</h2>
        <p>
          Send a Telegram <strong>voice note</strong> and it&apos;s transcribed and run as a command
          (needs an OpenAI-compatible transcription key, set in the dashboard). <strong>Vision</strong>{" "}
          (“what am I looking at?”) screenshots your screen and answers with Claude — powered by your
          own Anthropic key.
        </p>

        {/* ── soul ── */}
        <h2 id="soul">The soul</h2>
        <p>
          Every merryman is an individual. Its soul lives as plain markdown in{" "}
          <code className="inline">~/.merrymen/soul/</code>:
        </p>
        <table>
          <tbody>
            <tr><td><code className="inline">IDENTITY.md</code></td><td>who it is — its name (<code className="inline">/name Will Scarlet</code>), born date</td></tr>
            <tr><td><code className="inline">OWNER.md</code></td><td>what it&apos;s learned about you, one dated line at a time</td></tr>
            <tr><td><code className="inline">JOURNAL.md</code></td><td>a first-person entry it writes at campfire time</td></tr>
          </tbody>
        </table>
        <p>
          The bond deepens over time — new companion → trusted companion (a week) → old friend (a
          month) → sworn brother-in-arms (100 days), with milestone messages and a tone that warms to
          match. Memory is <strong>context, never capability</strong>: soul files flavor chat only,
          and the sanitizer refuses anything address-, key-, or code-shaped.
        </p>

        {/* ── strategies ── */}
        <h2 id="strategies">Strategies</h2>
        <p>Pick one in settings (or <code className="inline">/strategy &lt;name&gt;</code> from Telegram):</p>
        <table>
          <tbody>
            <tr><td><code className="inline">steady-basket</code></td><td>DCA a weighted stock basket per tick; idle cash sweeps to the Morpho vault (default).</td></tr>
            <tr><td><code className="inline">weekend-gap</code></td><td>Enter each leg when its Chainlink feed goes stale (market close), exit when it refreshes (open).</td></tr>
            <tr><td><code className="inline">llm-strategist</code></td><td>Claude proposes typed buy/sell/hold; deterministic code disposes. Needs an Anthropic key.</td></tr>
          </tbody>
        </table>

        {/* ── custom ── */}
        <h2 id="custom">Write your own bot</h2>
        <p>Your strategies live in <code className="inline">~/.merrymen/strategies/</code> — hot-reloaded, crash-isolated, and unable to exceed the caps you signed.</p>
        <pre className="code">
{`merrymen strategy new my-bot   # commented template
# edit it, select "my-bot" in settings — done`}
        </pre>
        <p>
          Default-export <code className="inline">{`{ name, tick(snapshot, ctx) }`}</code>. <code className="inline">ctx</code> injects the
          verified registry (<code className="inline">ctx.tokenBySymbol.QQQ</code>, <code className="inline">ctx.usdg(10)</code>). Every
          intent still passes shape validation → the policy wall → quote simulation → the on-chain
          session key.
        </p>

        {/* ── virtuals ── */}
        <h2 id="virtuals">Stream to Virtuals</h2>
        <p>
          Put your merryman&apos;s activity live on its page at <strong>app.virtuals.io</strong>. When
          you turn it on, every <strong>landed trade</strong> and the <strong>daily campfire
          report</strong> are posted to your agent&apos;s public Virtuals Terminal — a running,
          verifiable trading journal (rejections aren&apos;t posted one-by-one; the daily report
          summarizes them).
        </p>
        <ol>
          <li>Grab your <strong>Virtuals API key</strong> from your agent&apos;s page on app.virtuals.io.</li>
          <li>In merrymen <strong>settings → virtuals terminal</strong>, paste the key and flip <strong>stream to Virtuals</strong> on.</li>
        </ol>
        <div className="callout">
          <strong>Outbound &amp; public, and off by default.</strong> Nothing is streamed until you
          enable it. The key is used <em>only</em> to post activity logs — it can never trade or move
          funds — and it stays on your machine like every other key. Turn it off anytime and the
          stream stops.
        </div>

        {/* ── safety ── */}
        <h2 id="safety">Safety model</h2>
        <p>
          One rule: <strong>the model proposes, deterministic code disposes.</strong> No strategist,
          Telegram message, or voice note ever constructs calldata, moves funds, or touches your PC
          without passing a closed, typed command set and — for money — the on-chain policy wall.
        </p>
        <ul>
          <li><strong>Trades</strong> pass caps enforced by the account contract; every swap is simulated first.</li>
          <li><strong>Transfers</strong> are amount-capped on-chain, off by default, and confirm-gated.</li>
          <li><strong>PC actions</strong> are off by default, per-capability, allowlisted, and the sharp ones are confirmed.</li>
          <li><strong>Secrets</strong> live only in <code className="inline">~/.merrymen</code> and are masked before they ever reach the browser.</li>
          <li><strong>The kill switch</strong> destroys the grant; hard on-chain key expiry is the backstop.</li>
        </ul>
        <div className="callout warn">
          Keys are stored in plain text locally today (production TEE custody is on the roadmap).
          Treat the account like a hot wallet — small amounts, back up the owner key.
        </div>
        <h3>Why not a platform&apos;s own agent?</h3>
        <p>
          A first-party agent is custodial by construction — their servers, their keys, their
          discretion; the safety story is a terms-of-service. merrymen inverts the trust: the agent
          runs on <em>your</em> machine, the keys never leave it, and the caps live in your account
          contract on-chain, so even a fully compromised agent cannot spend past the wall. And you
          can check, not believe: the dashboard links the account contract, session key, and every
          cap to the block explorer, and its <strong>prove the wall</strong> button fires malicious
          intents — an oversized trade, a &ldquo;send everything to 0xevil&rdquo; transfer, an
          expired key — through the live policy so you can watch each one bounce.
        </p>

        {/* ── config ── */}
        <h2 id="config">Configuration</h2>
        <p>
          The dashboard <strong>Settings</strong> is the source of truth — Essentials up front, everything
          else under Advanced. Saved to <code className="inline">~/.merrymen/settings.json</code>; secrets are masked
          and never echo back. Precedence: <strong>settings file → env var → default</strong>. Env vars
          are the headless fallback (<code className="inline">MERRYMEN_BUNDLER_URL</code>, <code className="inline">ANTHROPIC_API_KEY</code>,{" "}
          <code className="inline">MERRYMEN_TELEGRAM_BOT_TOKEN</code>, <code className="inline">MERRYMEN_HOST</code>, …). See the{" "}
          <a className="link" href={`${GITHUB}#readme`} target="_blank" rel="noreferrer">README</a> for the full table.
        </p>

        {/* ── troubleshooting ── */}
        <h2 id="troubleshooting">Troubleshooting</h2>
        <h3>Windows: “running scripts is disabled on this system”</h3>
        <p>
          Windows PowerShell ships locked to <code className="inline">Restricted</code>, which blocks npm&apos;s
          and merrymen&apos;s <code className="inline">.ps1</code> command shims (you&apos;ll see{" "}
          <code className="inline">PSSecurityException</code>). The installer fixes this for you now; if you
          installed earlier, run this once — no admin needed, current user only:
        </p>
        <pre className="code">{`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`}</pre>
        <p>
          Then <code className="inline">merrymen setup</code> works. Or skip the policy entirely and call it
          as <code className="inline">merrymen.cmd setup</code> (or run from cmd.exe / Git Bash).
        </p>
        <h3>The dashboard won&apos;t open</h3>
        <p>Run <code className="inline">merrymen doctor</code>. The prebuilt dashboard ships with the package, so a missing build usually means an interrupted install — reinstall with <code className="inline">npm i -g merrymen@latest</code>.</p>
        <h3>Trades never land</h3>
        <p>Live trading needs three things together: the wallet on <strong>mainnet · 4663</strong>, a <strong>Pimlico API key</strong> in settings (or a full bundler URL), and the smart account funded with <strong>ETH for gas and USDG for capital</strong>. Without a bundler key the agent stays in practice mode — it simulates but never signs. On testnet no trade can land by design: the stock-token venues aren&apos;t deployed, so swaps no-route, and any USDG you sent there reads 0 because merrymen only knows the mainnet token addresses. Switch to mainnet for real fills.</p>
        <h3>Telegram says “not authorized”</h3>
        <p>Only allowlisted chats are obeyed. Send <code className="inline">/link &lt;code&gt;</code> with the code from settings to claim ownership.</p>
        <h3>A PC command is refused</h3>
        <p>Enable <strong>remote control</strong> and the specific capability in settings. Shell/apps also need the exact command/app on their allowlist; <code className="inline">/pc</code> shows what&apos;s on.</p>
        <h3>Still stuck?</h3>
        <p>Email <a className="link" href="mailto:support@merrymen.dev">support@merrymen.dev</a> or open an issue on <a className="link" href="https://github.com/millw14/merrymen" target="_blank" rel="noreferrer">GitHub</a> — include your OS and what <code className="inline">merrymen doctor</code> prints.</p>

        {/* ── faq ── */}
        <h2 id="faq">FAQ</h2>
        <h3>My session key expired — do I pay to renew it? Do I have to redeploy?</h3>
        <p>
          <strong>No and no.</strong> The expiry is a safety timer, not a subscription. A grant is a
          signature your owner key makes <em>locally</em> — nothing goes on-chain to create one, so
          renewing costs <strong>zero gas and zero fees</strong>, and your wallet, funds, and history
          stay exactly where they are. When the key is close to expiring (or already dead), the{" "}
          <code className="inline">/grant</code> page shows a <strong>“renew the key (free)”</strong>{" "}
          button — one click re-signs the same wallet with a fresh key under the same caps. Your
          merryman also pings you on Telegram before it expires.
        </p>
        <h3>Does the expiry apply in paper mode too?</h3>
        <p>
          Yes — expiry applies in <strong>every</strong> mode, paper and live. It&apos;s the guarantee
          that a forgotten agent can&apos;t run forever, and it&apos;s enforced twice: the worker retires
          the agent, and on-chain the account contract refuses the dead key regardless. Renewal is
          the same free one-click either way.
        </p>
        <h3>This feels built for devs — is easier onboarding coming? A desktop app?</h3>
        <p>
          Heard, and yes. Today the easiest path is the <a className="link" href="#install">one-line
          installer</a> — it checks Node, installs merrymen, and <code className="inline">merrymen
          start</code> opens the dashboard in your browser; you never need to write code (strategies
          are optional, presets cover the rest). A <strong>1-click desktop app</strong> (.exe/.dmg
          — no terminal at all) is on the roadmap; self-hosting is non-negotiable — your keys stay
          on your machine — so the app will be exactly this stack in a wrapper, not a hosted
          service. Follow progress on <a className="link" href={GITHUB} target="_blank" rel="noreferrer">GitHub</a>.
        </p>

        <div className="callout" style={{ marginTop: 40 }}>
          Still stuck? Open an issue on <a className="link" href={GITHUB} target="_blank" rel="noreferrer">GitHub</a>.
        </div>
      </article>
    </div>
  );
}
