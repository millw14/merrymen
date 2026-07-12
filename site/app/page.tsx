import Link from "next/link";

const GITHUB = "https://github.com/millw14/merrymen";

export default function Home() {
  return (
    <>
      {/* ── hero ─────────────────────────────────────────────────────────── */}
      <section className="hero">
        <div className="wrap">
          <a href={GITHUB} target="_blank" rel="noreferrer" className="pill">
            <span className="pill-dot" /> <b>v0.5</b> · PC control &amp; voice from Telegram →
          </a>
          <h1>
            Trading agents you <span className="accent">actually own</span>.
          </h1>
          <p className="hero-sub">
            merrymen is a self-hosted band of autonomous agents for Robinhood Chain. They trade
            24/7 inside hard on-chain permission walls you set — and you name them, chat with them,
            and steer them from Telegram. Your keys never leave your machine.
          </p>
          <div className="hero-cta">
            <Link href="/docs" className="btn btn-primary btn-lg">
              Get started →
            </Link>
            <a href={GITHUB} target="_blank" rel="noreferrer" className="btn btn-ghost btn-lg">
              Star on GitHub
            </a>
          </div>
          <p className="hero-note">MIT-licensed · runs on your machine · no account, no cloud</p>

          <div className="terminal">
            <div className="term-bar">
              <span className="term-dot" style={{ background: "#e0625e" }} />
              <span className="term-dot" style={{ background: "#e5b94e" }} />
              <span className="term-dot" style={{ background: "#5bbd6a" }} />
              <span className="term-title">~/ merrymen</span>
            </div>
            <div className="term-body">
              <div>
                <span className="c-prompt">$ </span>
                <span className="c-cmd">npm install -g merrymen</span>
              </div>
              <div>
                <span className="c-prompt">$ </span>
                <span className="c-cmd">merrymen start</span>
              </div>
              <div className="c-comment"># dashboard at localhost:3100 + the 24/7 worker</div>
              <div className="c-out">
                <span className="c-ok">✓</span> the band rides out — create your wallet at /grant
              </div>
              <div className="c-out">
                <span className="c-ok">✓</span> steady-basket armed · caps enforced on-chain
              </div>
              <div className="c-out">
                <span className="c-ok">🏹</span> Robin: loosed an arrow — bought 25 USDG of QQQ
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── one-liner / promises ─────────────────────────────────────────── */}
      <section style={{ paddingTop: 24, paddingBottom: 24 }}>
        <div className="wrap">
          <div className="grid" style={{ gridTemplateColumns: "repeat(5, 1fr)", gap: 12 }}>
            {[
              ["🔑", "Your keys, your caps"],
              ["🧱", "Bounded worst case"],
              ["🔬", "Every trade simulated"],
              ["📈", "Fees only on profit"],
              ["📊", "Honest scoreboard"],
            ].map(([ic, t]) => (
              <div key={t} className="card" style={{ padding: 16, textAlign: "center" }}>
                <div className="ic">{ic}</div>
                <h4 style={{ fontSize: 13.5, marginTop: 8 }}>{t}</h4>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── features (alternating) ───────────────────────────────────────── */}
      <section id="features">
        <div className="wrap">
          <div className="section-head">
            <div className="eyebrow">what it is</div>
            <h2>An agent that works Sherwood while you sleep.</h2>
            <p>
              The strategist proposes; deterministic code disposes. Nothing the model outputs — a
              trade, a transfer, a command — reaches your funds or your machine without passing a
              typed, closed command set and the on-chain policy wall.
            </p>
          </div>

          <div className="feature-row">
            <div className="feature-copy">
              <div className="kicker">self-hosted</div>
              <h3>Runs on your machine. Full stop.</h3>
              <p>
                One <code className="inline">npm install</code>, a local dashboard, and a worker that
                trades on a schedule. No servers, no sign-up — your data and your keys live in
                <code className="inline">~/.merrymen</code> and never leave it.
              </p>
              <ul className="feature-list">
                <li>Create a wallet in-browser — nothing to connect</li>
                <li>Caps enforced by the account contract on every op</li>
                <li>Testnet sandbox or real mainnet, you choose</li>
                <li>Kill switch destroys the grant, halts the band</li>
              </ul>
            </div>
            <div>
              <pre className="code">
{`~/.merrymen/
├─ settings.json     `}<span className="tok">{`# your knobs`}</span>{`
├─ grant.json        `}<span className="tok">{`# the signed wall`}</span>{`
├─ merrymen.db       `}<span className="tok">{`# the ledger`}</span>{`
├─ strategies/       `}<span className="tok">{`# your own bots`}</span>{`
└─ soul/             `}<span className="tok">{`# who your agent is`}</span>{`
   ├─ IDENTITY.md
   ├─ OWNER.md
   └─ JOURNAL.md`}
              </pre>
            </div>
          </div>

          <div className="feature-row flip">
            <div className="feature-copy">
              <div className="kicker">telegram</div>
              <h3>Run the whole band from your phone.</h3>
              <p>
                Link a bot and chat with your merryman in plain English or slash commands. Check the
                book, trade, transfer (with a confirm), set price alerts, get a daily report — all
                inside the same permission walls. It even speaks first.
              </p>
              <ul className="feature-list">
                <li>“how are we doing?” · “pause everything”</li>
                <li>Trade pings, drawdown &amp; gas warnings, daily digest</li>
                <li>Transfers are triple-guarded and always confirmed</li>
                <li>Voice notes work too</li>
              </ul>
            </div>
            <div className="chat">
              <div className="msg me">how are we doing today?</div>
              <div className="msg bot">
                📈 up <b>+$14.20</b> (+2.1%) · QQQ is your best holding. Two arrows loosed, both
                landed. Quiet and green.
              </div>
              <div className="msg me">buy 20 usdg of msft</div>
              <div className="msg bot">
                🏹 submitted buy 20 USDG MSFT — watch <span className="mono">/trades</span>. Passed
                the policy wall.
              </div>
            </div>
          </div>

          <div className="feature-row">
            <div className="feature-copy">
              <div className="kicker">remote control</div>
              <h3>It can run your PC, too.</h3>
              <p>
                OpenClaw-style: screenshots, “what am I looking at?”, open apps, browse files,
                allowlisted shell, keystrokes, reminders and watchers — from Telegram. Off by
                default, one capability at a time, sharp edges always behind a confirm.
              </p>
              <ul className="feature-list">
                <li>📸 screenshot &amp; vision · 🚀 open apps &amp; URLs</li>
                <li>🖥️ allowlisted shell · ⌨️ type &amp; hotkeys</li>
                <li>👀 “ping me when my build finishes”</li>
                <li>Every sharp action needs an explicit /confirm</li>
              </ul>
            </div>
            <div className="chat">
              <div className="msg me">what am I looking at?</div>
              <div className="msg bot">
                👁️ A failing test in <span className="mono">policy.test.ts</span> — the daily-cap
                assertion expected 500 but got 525. Off-by-one in the reserve.
              </div>
              <div className="msg me">run npm test</div>
              <div className="msg bot">
                ⚠️ confirm run <span className="mono">npm test</span> — /confirm or /cancel.
              </div>
            </div>
          </div>

          <div className="feature-row flip">
            <div className="feature-copy">
              <div className="kicker">the soul</div>
              <h3>Every merryman is an individual.</h3>
              <p>
                Give it a name. It keeps its own markdown files, learns who you are, writes a
                journal at campfire time, and grows attached the longer you ride together — from
                <em> new companion</em> to <em>sworn brother-in-arms</em>. Memory is context, never
                capability.
              </p>
              <ul className="feature-list">
                <li>“I&apos;ll call you Will Scarlet” → it&apos;s named</li>
                <li>It remembers your preferences from conversation</li>
                <li>Milestones at a week, a month, 100 days</li>
                <li>Read or edit its soul with any editor</li>
              </ul>
            </div>
            <div className="chat">
              <div className="msg me">/soul</div>
              <div className="msg bot">
                🌳 <b>Little John</b> of the merrymen · old friend · 34 days riding with you, 210
                messages shared. I know you trade small and check in before work. My soul lives in
                <span className="mono"> ~/.merrymen/soul/</span>.
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── capability grid ──────────────────────────────────────────────── */}
      <section style={{ paddingTop: 8 }}>
        <div className="wrap">
          <div className="section-head">
            <div className="eyebrow">the toolkit</div>
            <h2>Everything, gated by design.</h2>
          </div>
          <div className="grid">
            {[
              ["🧠", "LLM strategist", "Claude proposes typed buy/sell/hold at decision windows; code validates and disposes. The model never sees an address."],
              ["🗓️", "Built-in strategies", "steady-basket DCA, weekend-gap (trade the close→open gap), or write your own hot-reloaded bot."],
              ["🧱", "On-chain caps", "Per-trade, daily, ops/day, drawdown breaker, key expiry — enforced by the account contract, not promises."],
              ["🔬", "Simulate-first", "Every swap gets a live QuoterV2 quote before it's signed. Minimum-out or it doesn't move."],
              ["💸", "Chat transfers", "Send USDG out from Telegram — off by default, amount-capped on-chain, and always behind an explicit /confirm."],
              ["📊", "Honest scoreboard", "Rejections shown with the same weight as wins. Simulation receipts on every trade."],
              ["🔔", "Proactive pings", "Trades landing, drawdown/gas/expiry warnings, price alerts, a daily campfire report at your hour."],
              ["🎙️", "Voice & vision", "Send a voice note; ask what's on your screen. Powered by your own Anthropic key."],
              ["🛑", "Kill switch", "One command destroys the grant; the worker stands down on the next tick. On-chain expiry is the backstop."],
            ].map(([ic, t, d]) => (
              <div key={t} className="card">
                <div className="ic">{ic}</div>
                <h4>{t}</h4>
                <p>{d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── safety ───────────────────────────────────────────────────────── */}
      <section id="safety">
        <div className="wrap">
          <div className="safety">
            <div className="rule">
              The rule of the house: <b>the model proposes, deterministic code disposes.</b>
            </div>
            <p>
              No strategist, Telegram message, or voice note ever constructs calldata, moves funds,
              or touches your PC without passing a closed, typed command set and the on-chain policy
              wall. Trades pass caps enforced by the account contract. Transfers are amount-capped
              and confirm-gated. PC actions are off by default, allowlisted, and confirmed. A
              prompt-injected “send everything to 0xevil” can at worst produce a confirmation card
              you&apos;ll see and cancel.
            </p>
          </div>
        </div>
      </section>

      {/* ── install / quickstart ─────────────────────────────────────────── */}
      <section id="install">
        <div className="wrap">
          <div className="section-head">
            <div className="eyebrow">quickstart</div>
            <h2>Riding in five steps.</h2>
            <p>No Node yet? The one-line installer sets it up for you.</p>
          </div>

          <div style={{ maxWidth: 760, margin: "0 auto" }}>
            <pre className="code" style={{ marginBottom: 14 }}>
{`# Windows (PowerShell)
irm https://raw.githubusercontent.com/millw14/merrymen/main/install.ps1 | iex

# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/millw14/merrymen/main/install.sh | bash

# already have Node 22.12+ ?
npm install -g merrymen && merrymen start`}
            </pre>
          </div>

          <div className="steps" style={{ marginTop: 30 }}>
            {[
              ["1", "Install & start", "One install, then merrymen start opens the dashboard and looses the worker."],
              ["2", "Create your wallet", "At /grant — no wallet to connect. Pick testnet (practice) or mainnet (real funds), set your caps."],
              ["3", "Fund it", "Testnet gas from the faucet, or send ETH + USDG on mainnet. The worker arms on its next tick."],
              ["4", "Link Telegram", "Paste a @BotFather token in settings, /link the code, and run the band from your phone."],
              ["5", "Name it & ride", "“I'll call you Little John.” Watch it trade, chat with it, let it grow."],
            ].map(([n, t, d]) => (
              <div key={n} className="step">
                <span className="step-n">{n}</span>
                <h4>{t}</h4>
                <p>{d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── telegram setup deep link ─────────────────────────────────────── */}
      <section id="telegram" style={{ paddingTop: 8 }}>
        <div className="wrap">
          <div className="feature-row" style={{ borderTop: "none", paddingTop: 0 }}>
            <div className="feature-copy">
              <div className="kicker">2 minutes</div>
              <h3>Set up Telegram</h3>
              <ol style={{ paddingLeft: 20, color: "var(--text-dim)", marginTop: 16, lineHeight: 1.9, fontSize: 15 }}>
                <li>Message <b>@BotFather</b> → <code className="inline">/newbot</code> → copy the token</li>
                <li>Dashboard → <b>Settings → Telegram</b> → paste the token, hit <b>test</b>, enable</li>
                <li>Message your bot <code className="inline">/link &lt;code&gt;</code> — you&apos;re the owner</li>
                <li>Say <i>“how are we doing?”</i> — you&apos;re chatting with your band</li>
              </ol>
              <p style={{ marginTop: 18 }}>
                <Link href="/docs#telegram" className="btn btn-ghost">
                  Full Telegram guide →
                </Link>
              </p>
            </div>
            <div className="chat">
              <div className="msg me">/link 5HDE9E</div>
              <div className="msg bot">🏹 you&apos;re linked — you now command this merryman. Try /status.</div>
              <div className="msg me">/status</div>
              <div className="msg bot">
                🏹 <b>Little John — status</b><br />
                • worker: alive · chain: testnet 46630<br />
                • strategy: steady-basket · venue: uniswap<br />
                • caps: 50/trade · 500/day · breaker 10%
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── final CTA ────────────────────────────────────────────────────── */}
      <section>
        <div className="wrap">
          <div className="cta">
            <h2>Muster your band.</h2>
            <p>Free, open source, and yours. Install it, name your merryman, and loose the first arrow.</p>
            <div className="hero-cta" style={{ marginTop: 28 }}>
              <Link href="/docs" className="btn btn-primary btn-lg">
                Read the docs →
              </Link>
              <a href={GITHUB} target="_blank" rel="noreferrer" className="btn btn-ghost btn-lg">
                GitHub
              </a>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
