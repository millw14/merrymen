import Link from "next/link";
import { Icon, type IconName } from "@/components/Icon";
import { Parallax } from "@/components/Parallax";
import { Marquee } from "@/components/Marquee";

const MARQUEE = [
  "Self-hosted", "Your keys, your caps", "On-chain permission wall", "LLM proposes, code disposes",
  "Telegram control", "Voice & vision", "Simulated before signed", "Fees only on profit",
  "Kill switch", "Open source · MIT",
];

const GITHUB = "https://github.com/millw14/merrymen";

function Wordmark() {
  return (
    <div className="wordmark-wrap" aria-hidden>
      <Parallax speed={0.32}>
        <div className="wordmark">MERRYMEN</div>
      </Parallax>
    </div>
  );
}

const PROMISES: [IconName, string][] = [
  ["key", "Your keys, your caps"],
  ["shield", "Bounded worst case"],
  ["beaker", "Every trade simulated"],
  ["chart", "Fees only on profit"],
  ["ledger", "An honest scoreboard"],
];

const CAPS: [IconName, string, string][] = [
  ["cpu", "LLM strategist", "Claude proposes typed buy/sell/hold at decision windows; deterministic code validates and disposes. The model never sees an address."],
  ["calendar", "Built-in strategies", "steady-basket DCA, weekend-gap that trades the close→open gap, or a hot-reloaded bot you write yourself."],
  ["shield", "On-chain caps", "Per-trade, daily, ops/day, drawdown breaker, key expiry — enforced by the account contract on every operation."],
  ["beaker", "Simulate first", "Every swap gets a live quote before it is signed. Minimum-out is met, or nothing moves."],
  ["transfer", "Chat transfers", "Send USDG out from Telegram — off by default, amount-capped on-chain, and always behind an explicit confirm."],
  ["ledger", "Honest scoreboard", "Rejections shown with the same weight as wins. A simulation receipt attached to every trade."],
  ["bell", "Proactive pings", "Trades landing, drawdown, gas and expiry warnings, your price alerts, a daily report at your hour."],
  ["eye", "Voice & vision", "Send a voice note; ask what is on your screen. Powered by your own Anthropic key."],
  ["power", "Kill switch", "One command destroys the grant; the worker stands down next tick. On-chain expiry is the backstop."],
];

const STEPS: [string, string, string][] = [
  ["01", "Install & start", "One install, then merrymen start opens the dashboard and looses the worker."],
  ["02", "Create a wallet", "At /grant — nothing to connect. Pick testnet or mainnet, set the caps the contract enforces."],
  ["03", "Fund it", "Faucet gas on testnet, or send ETH + USDG on mainnet. The worker arms on its next tick."],
  ["04", "Link Telegram", "Paste a bot token in settings, link the code, run the band from your phone."],
  ["05", "Name it & ride", "“I'll call you Little John.” Watch it trade, chat with it, let it grow."],
];

export default function Home() {
  return (
    <>
      {/* ── hero ─────────────────────────────────────────────────────────── */}
      <section className="hero">
        <div className="wrap">
          <div className="hero-motif" data-reveal="fade">
            <Icon name="globe" size={46} />
          </div>
          <h1 className="hero-statement" data-reveal="mask">
            Trading agents you never have to trust.
          </h1>
          <p className="hero-sub" data-reveal="up" style={{ ["--d" as string]: "90ms" }}>
            merrymen is a self-hosted band of agents for Robinhood Chain. Your keys never leave your
            machine, and every cap you set is enforced by the account contract on-chain — not by
            promises. Inside that wall, your band works the market 24/7 while you name them, chat
            with them, and steer them from Telegram.
          </p>
          <div className="hero-cta" data-reveal="up" style={{ ["--d" as string]: "170ms" }}>
            <span className="mag" data-magnetic>
              <Link href="/docs" className="btn btn-primary btn-lg has-box">
                Get started <span className="box"><Icon name="arrow" size={16} /></span>
              </Link>
            </span>
            <a href={GITHUB} target="_blank" rel="noreferrer" className="btn btn-ghost btn-lg">
              View on GitHub
            </a>
          </div>
          <div className="hero-meta" data-reveal="up" style={{ ["--d" as string]: "240ms" }}>MIT-licensed · runs on your machine · no account, no cloud</div>
        </div>
        <Wordmark />
      </section>

      {/* ── promises ─────────────────────────────────────────────────────── */}
      <section style={{ paddingTop: 44, paddingBottom: 44 }}>
        <div className="wrap">
          <div className="grid" style={{ gridTemplateColumns: "repeat(5, 1fr)" }}>
            {PROMISES.map(([, label], i) => (
              <div key={label} className="cell promise" data-reveal="up" style={{ ["--d" as string]: `${i * 70}ms` }}>
                <span className="promise-n">{String(i + 1).padStart(2, "0")}</span>
                <h4>{label}</h4>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── marquee band ─────────────────────────────────────────────────── */}
      <Marquee items={MARQUEE} />

      {/* ── the trust layer — load-bearing, everything rests on it ────────── */}
      <section id="safety">
        <div className="wrap">
          <div className="section-head">
            <div className="tag" data-reveal="fade"><span className="n">01</span> — the trust layer</div>
            <h2 data-reveal="mask">The wall is the product.</h2>
            <p data-reveal="up" style={{ ["--d" as string]: "80ms" }}>
              Anyone can ship a trading agent. The hard thing — the thing merrymen is — is an agent
              you don&apos;t have to trust: it runs on your machine, holds keys that never leave it,
              and trades inside caps the chain itself enforces. Everything else on this page is
              built on top of that wall.
            </p>
          </div>

          <div className="safety" data-reveal="up">
            <div className="quote">
              The rule of the house: <b>the model proposes, deterministic code disposes.</b>
            </div>
            <p>
              No strategist, Telegram message, or voice note ever constructs calldata, moves funds,
              or touches your PC without passing a closed, typed command set and — for money — the
              on-chain policy wall. Trades pass caps enforced by the account contract. Transfers are
              amount-capped and confirm-gated. PC actions are off by default, allowlisted, and
              confirmed. A prompt-injected “send everything to 0xevil” can at worst produce a
              confirmation card you will see and cancel.
            </p>
            <p>
              And you don&apos;t take our word for it: your dashboard shows the account contract,
              the session key, and every cap with explorer links — and a <b>prove the wall</b>{" "}
              button that fires malicious intents through the live policy so you can watch each one
              bounce.
            </p>
          </div>

          <div className="grid moat-grid">
            <div className="cell" data-reveal="up">
              <h4>Why not wait for a platform&apos;s own agent?</h4>
              <p>
                A first-party agent is custodial by construction: their servers, their keys, their
                discretion — the safety story is a terms-of-service. If the platform, its model, or
                its prompt gets compromised, so does your account. You trust; it trades.
              </p>
            </div>
            <div className="cell" data-reveal="up" style={{ ["--d" as string]: "80ms" }}>
              <h4>merrymen inverts it</h4>
              <p>
                The agent lives on your machine and holds a session key whose caps — per-trade,
                daily, ops/day, drawdown, expiry — are enforced by your account contract on-chain,
                verifiable in the explorer. Even a fully compromised agent cannot spend past the
                wall. You verify; it trades.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── features ─────────────────────────────────────────────────────── */}
      <section id="features">
        <div className="wrap">
          <div className="section-head">
            <div className="tag" data-reveal="fade"><span className="n">02</span> — what it is</div>
            <h2 data-reveal="mask">An agent that works Sherwood while you sleep.</h2>
            <p data-reveal="up" style={{ ["--d" as string]: "80ms" }}>
              The strategist proposes; deterministic code disposes. Nothing the model outputs — a
              trade, a transfer, a command — reaches your funds or your machine without passing a
              typed, closed command set and the on-chain policy wall.
            </p>
          </div>

          <div className="feature-row">
            <div className="feature-copy" data-reveal="up">
              <div className="feature-kicker">Self-hosted</div>
              <h3>Runs on your machine. Full stop.</h3>
              <p>
                One <code className="inline">npm install</code>, a local dashboard, and a worker that
                trades on a schedule. No servers, no sign-up — your data and your keys live in
                <code className="inline">~/.merrymen</code> and never leave it.
              </p>
              <ul className="feature-list">
                {["Create a wallet in-browser — nothing to connect", "Caps enforced by the account contract on every op", "Testnet sandbox or real mainnet, you choose", "Kill switch destroys the grant, halts the band"].map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </div>
            <div className="mock" data-reveal="up" style={{ ["--d" as string]: "120ms" }}>
              <pre className="code" style={{ border: "none", borderRadius: 0, background: "transparent" }}>
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
            <div className="feature-copy" data-reveal="up">
              <div className="feature-kicker">Telegram</div>
              <h3>Run the whole band from your phone.</h3>
              <p>
                Link a bot and chat with your merryman in plain English or slash commands. Check the
                book, trade, transfer with a confirm, set price alerts, get a daily report — all
                inside the same permission walls. It even speaks first.
              </p>
              <ul className="feature-list">
                {["“how are we doing?” · “pause everything”", "Trade pings, drawdown & gas warnings, daily digest", "Transfers are triple-guarded and always confirmed", "Voice notes work too"].map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </div>
            <div className="mock chat" data-reveal="up" style={{ ["--d" as string]: "120ms" }}>
              <div className="msg me">how are we doing today?</div>
              <div className="msg bot">Up <b>+$14.20</b> (+2.1%) · QQQ is your best holding. Two arrows loosed, both landed. Quiet and green.</div>
              <div className="msg me">buy 20 usdg of msft</div>
              <div className="msg bot">Submitted buy 20 USDG MSFT — watch <span className="mono">/trades</span>. Passed the policy wall.</div>
            </div>
          </div>

          <div className="feature-row">
            <div className="feature-copy" data-reveal="up">
              <div className="feature-kicker">Remote control</div>
              <h3>It can run your PC, too.</h3>
              <p>
                Screenshots, “what am I looking at?”, open apps, browse files, allowlisted shell,
                keystrokes, reminders and watchers — from Telegram. Off by default, one capability at
                a time, sharp edges always behind a confirm.
              </p>
              <ul className="feature-list">
                {["Screenshot & vision · open apps and URLs", "Allowlisted shell · type & hotkeys", "“ping me when my build finishes”", "Every sharp action needs an explicit confirm"].map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </div>
            <div className="mock chat" data-reveal="up" style={{ ["--d" as string]: "120ms" }}>
              <div className="msg me">what am I looking at?</div>
              <div className="msg bot">A failing test in <span className="mono">policy.test.ts</span> — the daily-cap assertion expected 500 but got 525. Off-by-one in the reserve.</div>
              <div className="msg me">run npm test</div>
              <div className="msg bot">Confirm run <span className="mono">npm test</span> — /confirm or /cancel.</div>
            </div>
          </div>

          <div className="feature-row flip">
            <div className="feature-copy" data-reveal="up">
              <div className="feature-kicker">The soul</div>
              <h3>Every merryman is an individual.</h3>
              <p>
                Give it a name. It keeps its own markdown files, learns who you are, writes a journal
                at campfire time, and grows attached the longer you ride together — from new
                companion to sworn brother-in-arms. Memory is context, never capability.
              </p>
              <ul className="feature-list">
                {["“I'll call you Will Scarlet” — it's named", "It remembers your preferences from conversation", "Milestones at a week, a month, a hundred days", "Read or edit its soul with any editor"].map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </div>
            <div className="mock chat" data-reveal="up" style={{ ["--d" as string]: "120ms" }}>
              <div className="msg me">/soul</div>
              <div className="msg bot">
                <b>Little John</b> of the merrymen · old friend · 34 days riding with you, 210
                messages shared. I know you trade small and check in before work. My soul lives in
                <span className="mono"> ~/.merrymen/soul/</span>.
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── capability grid ──────────────────────────────────────────────── */}
      <section style={{ paddingTop: 40 }}>
        <div className="wrap">
          <div className="section-head center">
            <div className="tag" style={{ justifyContent: "center" }} data-reveal="fade"><span className="n">03</span> — the toolkit</div>
            <h2 data-reveal="mask">Everything, gated by design.</h2>
          </div>
          <div className="grid">
            {CAPS.map(([ic, t, d], i) => (
              <div key={t} className="cell" data-reveal="up" style={{ ["--d" as string]: `${(i % 3) * 80}ms` }}>
                <div className="cell-ic"><Icon name={ic} size={26} /></div>
                <h4>{t}</h4>
                <p>{d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── install ──────────────────────────────────────────────────────── */}
      <section id="install">
        <div className="wrap">
          <div className="section-head center">
            <div className="tag" style={{ justifyContent: "center" }} data-reveal="fade"><span className="n">04</span> — quickstart</div>
            <h2 data-reveal="mask">Riding in five steps.</h2>
            <p data-reveal="up" style={{ ["--d" as string]: "80ms" }}>No Node yet? The one-line installer sets it up for you.</p>
          </div>

          <div style={{ maxWidth: 780, margin: "0 auto 34px" }}>
            <pre className="code">
{`# Windows (PowerShell)
irm https://raw.githubusercontent.com/millw14/merrymen/main/install.ps1 | iex

# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/millw14/merrymen/main/install.sh | bash

# already have Node 22.12+ ?
npm install -g merrymen && merrymen start`}
            </pre>
          </div>

          <div className="steps">
            {STEPS.map(([n, t, d], i) => (
              <div key={n} className="step" data-reveal="up" style={{ ["--d" as string]: `${i * 70}ms` }}>
                <div className="num">{n}</div>
                <h4>{t}</h4>
                <p>{d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── telegram walkthrough ─────────────────────────────────────────── */}
      <section id="telegram" style={{ paddingTop: 40 }}>
        <div className="wrap">
          <div className="feature-row" style={{ borderTop: "none", paddingTop: 0 }}>
            <div className="feature-copy" data-reveal="up">
              <div className="tag"><span className="n">05</span> — two minutes</div>
              <h3 style={{ marginTop: 18 }}>Set up Telegram</h3>
              <ol style={{ paddingLeft: 20, color: "var(--text-dim)", marginTop: 18, lineHeight: 1.9, fontSize: 15.5 }}>
                <li>Message <strong>@BotFather</strong> → <code className="inline">/newbot</code> → copy the token</li>
                <li>Dashboard → <strong>Settings → Telegram</strong> → paste, test, enable</li>
                <li>Message your bot <code className="inline">/link &lt;code&gt;</code> — you&apos;re the owner</li>
                <li>Say “how are we doing?” — you&apos;re chatting with your band</li>
              </ol>
              <p style={{ marginTop: 22 }}>
                <Link href="/docs#telegram" className="btn btn-ghost has-box">
                  Full Telegram guide <span className="box"><Icon name="arrow" size={15} /></span>
                </Link>
              </p>
            </div>
            <div className="mock chat" data-reveal="up" style={{ ["--d" as string]: "120ms" }}>
              <div className="msg me">/link 5HDE9E</div>
              <div className="msg bot">You&apos;re linked — you now command this merryman. Try /status.</div>
              <div className="msg me">/status</div>
              <div className="msg bot">
                <b>Little John — status</b><br />
                • worker: alive · chain: testnet 46630<br />
                • strategy: steady-basket · venue: uniswap<br />
                • caps: 50/trade · 500/day · breaker 10%
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── final CTA ────────────────────────────────────────────────────── */}
      <section className="cta">
        <div className="wrap">
          <h2 data-reveal="mask">Muster your band.</h2>
          <p data-reveal="up" style={{ ["--d" as string]: "80ms" }}>Free, open source, and yours. Install it, name your merryman, loose the first arrow.</p>
          <div className="hero-cta" data-reveal="up" style={{ marginTop: 30, ["--d" as string]: "150ms" }}>
            <span className="mag" data-magnetic>
              <Link href="/docs" className="btn btn-primary btn-lg has-box">
                Read the docs <span className="box"><Icon name="arrow" size={16} /></span>
              </Link>
            </span>
            <a href={GITHUB} target="_blank" rel="noreferrer" className="btn btn-ghost btn-lg">
              GitHub
            </a>
          </div>
        </div>
        <Wordmark />
      </section>
    </>
  );
}
