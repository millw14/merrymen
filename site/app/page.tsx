import Link from "next/link";
import { AgentPreview } from "@/components/AgentPreview";
import { Icon, type IconName } from "@/components/Icon";
import { Parallax } from "@/components/Parallax";
import { Marquee } from "@/components/Marquee";
import { IosBetaForm } from "@/components/IosBetaForm";

const MARQUEE = [
  "Self-hosted", "Your keys, your caps", "On-chain permission wall", "LLM proposes, code disposes",
  "Telegram control", "Voice & vision", "Simulated before signed", "Fees only on profit",
  "Kill switch", "Open source · MIT",
];

const GITHUB = "https://github.com/millw14/merrymen";

/**
 * The hosted product.
 *
 * This page described merrymen for months without ever linking to it. The
 * primary button went to /docs and the quickstart was `npm install -g`, so the
 * only people who reached app.merrymen.dev were the ones already told the
 * subdomain — while the hero copy two lines below says "self-host it or run it
 * hosted", offering exactly one of those.
 */
const HOSTED_APP = "https://app.merrymen.dev";
/** The MCP server address, as public/llms.txt and /claude give it. */
const MCP_SERVER = "https://mcp.merrymen.dev/mcp";

/**
 * The beta testers' room — an open Telegram invite. Anyone with the link joins,
 * which is the point while the band is still being tuned.
 *
 * NOT the same thing as the Telegram section further down the page. That one is
 * about connecting YOUR bot to YOUR agent: the token is a credential and the
 * chat is yours alone. This is a shared room with strangers in it. The two must
 * never read as the same feature, because the failure mode is someone pasting a
 * bot token or a grant link into a group chat to get help debugging — which is
 * why the caution sits next to the button rather than buried in the docs.
 */
const TELEGRAM_BETA = "https://t.me/+oL-7xzghFwA4OTc8";

/**
 * The Windows installer, pinned to an exact asset.
 *
 * Deliberately NOT a link to the releases page. A misnamed release — tagged for
 * the merrymen version it was built against but titled like a desktop version —
 * once sat there offering a pre-security-fix binary; it has been deleted, and
 * the remaining releases are all correctly named. Keep pinning the exact file
 * anyway: this link is right or it is broken, and a broken link is the failure
 * mode you want, not a silent download of the wrong build.
 *
 * Bump all three together when a new desktop build ships — a stale version label
 * beside a fresh binary is worse than no label. 0.1.7 is less than half the size
 * of 0.1.6 because that build was packaging the previous installer inside itself;
 * see desktop/stage-bundle.mjs.
 */
const DESKTOP_VERSION = "0.1.7";
const DESKTOP_SIZE = "147 MB";
const WINDOWS_DOWNLOAD = `${GITHUB}/releases/download/desktop-v${DESKTOP_VERSION}/merrymen.Setup.${DESKTOP_VERSION}.exe`;

/**
 * The Android build, and it is NOT the desktop app's equal — do not let the copy
 * imply it is.
 *
 * This is the `demo` EAS profile: it ships with no feed origin, so every balance,
 * position and trade it shows is generated on the phone. It also refuses to sign
 * a permission wall (mobile/src/crypto/signGrant.ts throws when isMock), because
 * signing one would mint a real Robinhood Chain account that real money could be
 * sent to while the app reported fiction about it. So the honest label is "demo",
 * the size line says the numbers are invented, and the button never sits under a
 * heading that promises a working agent.
 *
 * Hosted as a RELEASE ASSET, not in the repo: at 108 MB the APK is over GitHub's
 * 100 MiB per-file limit and a push carrying it is rejected outright.
 *
 * Same rule as the Windows link — bump version and size together, and deep-link
 * the exact artifact rather than the releases page.
 */
// 0.1.0 and 0.1.1 both aborted on launch on Android 14+ — blocking
// DETECT_SCREEN_CAPTURE while expo-screen-capture was installed, which registers
// a callback at module creation with no permission check. Both release pages now
// say so rather than quietly serving a dead build. Bumping this constant is the
// whole fix on the site's side, because the URL is derived from it.
const ANDROID_VERSION = "0.1.2";
const ANDROID_SIZE = "108 MB";
const ANDROID_DOWNLOAD = `${GITHUB}/releases/download/mobile-v${ANDROID_VERSION}/merrymen-demo-${ANDROID_VERSION}.apk`;

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
  ["transfer", "Chat transfers", "Refused. A wallet signed today registers no withdrawal address, so its wall carries no transfer permission — nothing leaves through chat. Money comes home with your owner key."],
  ["ledger", "Honest scoreboard", "Rejections shown with the same weight as wins. A simulation receipt attached to every trade."],
  ["bell", "Proactive pings", "Trades landing, drawdown, gas and expiry warnings, your price alerts, a daily report at your hour."],
  ["eye", "Voice & vision", "Send a voice note; ask what is on your screen. Powered by your own Anthropic key."],
  ["power", "Kill switch", "One command destroys the grant; the worker stands down next tick. On-chain expiry is the backstop."],
];

/*
  These described the SELF-HOSTED path exclusively — install a package, paste a
  bundler key — while the button above them now opens the hosted app, where
  neither step exists. Rewritten for the path the primary CTA actually takes.

  Step 2 deliberately does NOT promise paper trading. It used to say the agent
  "trades on paper instantly", and hosted cannot do that today: paperActive()
  requires no executor, and hosted always injects the house bundler key. Put
  that sentence back when the worker keys paper on capability instead.
*/
const STEPS: [string, string, string][] = [
  ["1", "Open it and connect a wallet", "No install, nothing to run, no card. Your wallet signs to prove it is you — it never moves anything, and merrymen never sees a private key of yours."],
  ["2", "Sign the wall", "Choose what your agent may spend and how long its key lives, then sign once. That signature IS the limit: your account contract checks it on every operation, so the agent cannot exceed it even if our software is compromised."],
  ["3", "Fund it and it trades", "Send it some money and it starts working the market. Change the limits whenever you like — re-signing is free and instant. Steer it from Telegram if you prefer, or take everything back out with your own key."],
];

export default function Home() {
  return (
    <>
      <section className="hero home-hero">
        <div className="wrap hero-layout">
          <div className="hero-copy">
            <div className="hero-eyebrow"><span /> THE AGENT IS YOURS.</div>
            <h1 className="hero-statement">Your agent.<br /><span className="accent">Your rules.</span></h1>
            <p className="hero-sub">Meet your Merryman. A trading agent you can name, chat with, and put to work — with limits enforced on-chain and an owner key that stays yours.</p>
            <div className="hero-cta">
              <a href={HOSTED_APP} className="btn btn-primary btn-lg">Meet your agent <Icon name="arrow" size={18}/></a>
              <Link href="/api" className="btn btn-ghost btn-lg">Build with Merrymen <Icon name="arrow" size={16}/></Link>
            </div>
            <p className="hero-meta">RUN IT HOSTED. SELF-HOST IT. MAKE IT YOURS.</p>
            <div className="hero-bottom-links" style={{ flexWrap: "wrap", rowGap: 10 }}><Link href="/docs">Read the docs ↗</Link><Link href="/claude">Use it in Claude ↗</Link><a href={GITHUB}>Explore the source ↗</a></div>
            {/* Plain words on purpose: an assistant asked to "connect merrymen mcp" reads this page first, and a link title alone did not tell it there is an MCP server. */}
            <p className="hero-mcp">
              <strong>Merrymen MCP server:</strong> connect Claude, Claude Code, ChatGPT, Cursor and other AI assistants to your agent at <code>{MCP_SERVER}</code>. <Link href="/claude">Set it up in one click</Link> · <a href="/llms.txt">instructions for AI assistants</a>
            </p>
          </div>
          <AgentPreview />
        </div>
        <div className="wrap">
          <details className="download-panel">
            <summary>More ways to use Merrymen <span>Desktop & mobile beta</span></summary>
            <div className="download-options">
              <div><h3>On your desktop</h3><a href={WINDOWS_DOWNLOAD} className="btn btn-ghost">Download for Windows <Icon name="arrow" size={15}/></a><p>Windows {DESKTOP_VERSION} · {DESKTOP_SIZE}<br/>macOS and Linux: <a className="link" href="#install">the one-line install</a></p></div>
              <div><h3>Explore the Android demo</h3><a href={ANDROID_DOWNLOAD} className="btn btn-ghost">Download Android demo <Icon name="arrow" size={15}/></a><p>Android {ANDROID_VERSION} · {ANDROID_SIZE}<br/>The mobile beta doesn&apos;t trade yet — it shows generated data, and it won&apos;t sign a permission wall.</p></div>
              <div><h3>On iPhone?</h3><p>There&apos;s no iOS build yet. Leave your email for one message when there is something to install.</p><IosBetaForm/></div>
            </div>
          </details>
        </div>
      </section>

      {/* ── promises ─────────────────────────────────────────────────────── */}
      <section style={{ paddingTop: 44, paddingBottom: 44 }}>
        <div className="wrap">
          <div className="grid promises-grid" style={{ gridTemplateColumns: "repeat(5, 1fr)" }}>
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
              you don&apos;t have to trust: your owner key never leaves you, and it trades inside caps
              the chain itself enforces — a leaked session key is value-churn, never theft. Everything
              else on this page is built on top of that wall.
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
                The agent holds only a session key whose limits — how much per trade, how often, how
                long it lives, and <em>where value may land</em> — are enforced by your account
                contract on-chain, verifiable in the explorer. The owner key that could lift those
                limits never leaves you. A
                compromised agent can trade inside that wall. It cannot send your funds to an
                address you never registered, and it cannot sign anything. You verify; it trades.
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
              <div className="feature-kicker">Your machine, or ours</div>
              <h3>Self-host it, or run it hosted.</h3>
              <p>
                One <code className="inline">npm install</code> for a local dashboard and a worker on
                your own machine — or run it hosted from a URL, no install. Either way your{" "}
                <strong>owner key</strong> is generated on your device and never leaves it; a hosted
                server only ever holds a capped, revocable session key the chain keeps on a leash.
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
            <h2 data-reveal="mask">Up and running in three steps.</h2>
            <p data-reveal="up" style={{ ["--d" as string]: "80ms" }}>Install, create an agent, watch it trade on paper. Real money is optional and comes later. No Node yet? The one-line installer handles it.</p>
          </div>

          <div data-reveal="up" style={{ maxWidth: 780, margin: "0 auto 22px", textAlign: "center" }}>
            <span className="mag" data-magnetic>
              <a href={WINDOWS_DOWNLOAD} className="btn btn-primary btn-lg has-box">
                Download for Windows <span className="box"><Icon name="arrow" size={16} /></span>
              </a>
            </span>
            <p className="install-note" style={{ marginTop: 12 }}>
              <b>The one-click app</b> — double-click to install, no terminal, no Node. Same dashboard +
              agent, with a tray icon to pause or quit. Windows {DESKTOP_VERSION} · {DESKTOP_SIZE}.{" "}
              <span style={{ opacity: 0.72 }}>
                Unsigned for now, so Windows SmartScreen shows a warning → <b>More info → Run anyway</b>.
                On macOS / Linux, use the command-line install below.
              </span>
            </p>
          </div>

          <div style={{ maxWidth: 780, margin: "0 auto 20px" }}>
            <pre className="code">
{`# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/millw14/merrymen/main/install.sh | bash

# Windows (PowerShell)
irm https://raw.githubusercontent.com/millw14/merrymen/main/install.ps1 | iex

# already have Node 22.12+ ? (any OS)
npm install -g merrymen && merrymen start`}
            </pre>
          </div>
          <p className="install-note" data-reveal="up">
            Runs on <b>Linux, macOS, and Windows</b> — one Node package, no Docker, no clone. The
            installers set up Node for you; with Node 22.12+ already, <code className="inline">npm i -g merrymen</code>{" "}
            works anywhere. Your band starts in <b>paper mode</b> (live prices, simulated fills, zero
            funds), so you can watch it trade in a couple of minutes. Upgrade any time with{" "}
            <code className="inline">merrymen update</code>.
          </p>

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

      {/* ── word from the woods — real quotes, verifiable receipts ───────── */}
      <section id="words">
        <div className="wrap">
          <div className="section-head center">
            <div className="tag" style={{ justifyContent: "center" }} data-reveal="fade"><span className="n">06</span> — word from the woods</div>
            <h2 data-reveal="mask">Early words. Honest receipts.</h2>
          </div>

          <div className="safety words-quote" data-reveal="up">
            <div className="quote">
              “The on-chain permission wall is good — smart. <b>The trust layer makes the moat.</b>”
            </div>
            <p className="words-attr">— an early code reviewer, unprompted, after reading the source</p>
          </div>

          <div className="receipts" data-reveal="up" style={{ ["--d" as string]: "80ms" }}>
            <span>MIT open source — read every line</span>
            <span>200+ tests on the policy wall &amp; pipeline</span>
            <span>caps enforced by the account contract, verifiable in the explorer</span>
            <span>your owner key never leaves your device — self-hosted or hosted</span>
          </div>

          <p className="words-invite" data-reveal="up" style={{ ["--d" as string]: "140ms" }}>
            Riding with the band? Tell us what broke and what sang — the{" "}
            <a href={TELEGRAM_BETA} target="_blank" rel="noreferrer">beta group on Telegram</a>,{" "}
            <a href="https://x.com/MerrymenAI" target="_blank" rel="noreferrer">@MerrymenAI</a>, or a{" "}
            <a href={GITHUB + "/issues"} target="_blank" rel="noreferrer">GitHub issue</a>. Real words
            from real riders end up here.
          </p>
        </div>
      </section>

      {/* ── final CTA ────────────────────────────────────────────────────── */}
      <section className="cta">
        <div className="wrap">
          <h2 data-reveal="mask">Muster your band.</h2>
          <p data-reveal="up" style={{ ["--d" as string]: "80ms" }}>Free, open source, and yours. Install it, name your merryman, loose the first arrow.</p>
          <div className="hero-cta" data-reveal="up" style={{ marginTop: 30, ["--d" as string]: "150ms" }}>
            <span className="mag" data-magnetic>
              <a href={HOSTED_APP} className="btn btn-primary btn-lg has-box">
                Start trading <span className="box"><Icon name="arrow" size={16} /></span>
              </a>
            </span>
            <Link href="/docs" className="btn btn-ghost btn-lg">
              Read the docs
            </Link>
            <a href={TELEGRAM_BETA} target="_blank" rel="noreferrer" className="btn btn-ghost btn-lg">
              <Icon name="chat" size={15} /> Join the beta
            </a>
            <a href={GITHUB} target="_blank" rel="noreferrer" className="btn btn-ghost btn-lg">
              GitHub
            </a>
          </div>
          {/* The caution belongs HERE, beside the invite, not in the docs. A beta
              support room is exactly where someone pastes a token to get help. */}
          <p className="cta-note" data-reveal="up" style={{ ["--d" as string]: "220ms" }}>
            The beta group is open — early builds, rough edges, and a direct line to whoever broke it.
            It&apos;s a room with other riders in it, so keep your bot token, grant link and private
            key out of it. Nobody there ever needs them.
          </p>
        </div>
        <Wordmark />
      </section>
    </>
  );
}
