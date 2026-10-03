import Link from "next/link";
import { Icon } from "@/components/Icon";
import { IosBetaForm } from "@/components/IosBetaForm";
import { LiveBandDesk } from "@/components/LiveBandDesk";
import { HeroSignal } from "@/components/HeroSignal";
import { PUBLIC_LEADERBOARD, readPublicAgents, type PublicAgent } from "@/lib/public-leaderboard";

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
      <div className="wordmark">MERRYMEN</div>
    </div>
  );
}

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

async function publicAgents(): Promise<PublicAgent[] | null> {
  try {
    const response = await fetch(PUBLIC_LEADERBOARD, { next: { revalidate: 60 } });
    if (!response.ok) return null;
    return readPublicAgents(await response.json());
  } catch {
    return null;
  }
}

export default async function Home() {
  const agents = await publicAgents();
  return (
    <div className="home-page">
      <section className="hero home-hero">
          <div className="wrap hero-layout">
          <div className="hero-copy">
            <p className="hero-eyebrow">Trading agents with on-chain limits</p>
            <h1 className="hero-statement">Your agent.<br /><span className="accent">Your rules.</span></h1>
            <p className="hero-sub">Meet your Merryman. A trading agent you can name, chat with, and put to work — with limits enforced on-chain and an owner key that stays yours.</p>
            <div className="hero-cta">
              <div className="path">
                <span>For traders</span>
                <a href={HOSTED_APP} className="btn btn-primary btn-lg">Open app <Icon name="arrow" size={18}/></a>
              </div>
              <div className="path">
                <span>For developers</span>
                <Link href="/api" className="btn btn-ghost btn-lg">Build with Merrymen <Icon name="arrow" size={16}/></Link>
              </div>
            </div>
          </div>
          <div className="hero-stage">
            <HeroSignal />
            <LiveBandDesk initialAgents={agents?.slice(0, 5) ?? null} initialTotal={agents?.length ?? null} />
          </div>
        </div>
      </section>

      <section id="features">
        <div className="wrap">
          <div className="section-head">
            <div className="tag" data-reveal="fade"><span className="n">01</span> — what it is</div>
            <h2>An agent that works Sherwood while you sleep.</h2>
            <p>The strategist proposes. Deterministic code disposes. The chain enforces the wall you signed.</p>
          </div>
          <div className="steps">
            <div className="step">
              <div className="num">1</div>
              <h4>You set the wall</h4>
              <p>How much per trade, how often, how long the key lives, and where value may land. That signature is the limit.</p>
            </div>
            <div className="step">
              <div className="num">2</div>
              <h4>It proposes</h4>
              <p>A named agent asks to buy, sell, or hold. The model never sees an address, and it never builds the transaction.</p>
            </div>
            <div className="step">
              <div className="num">3</div>
              <h4>The chain decides</h4>
              <p>Every swap is quoted first. Inside the caps, it lands. Outside them, it is refused, and the refusal is shown with the same weight as a win.</p>
            </div>
          </div>
        </div>
      </section>

      <section id="safety">
        <div className="wrap">
          <div className="section-head">
            <div className="tag" data-reveal="fade"><span className="n">02</span> — the trust layer</div>
            <h2>The wall is the product.</h2>
          </div>
          <div className="safety">
            <div className="quote">The rule of the house: <b>the model proposes, deterministic code disposes.</b></div>
            <p>
              Your owner key never leaves you. The agent holds a session key, and the account contract
              checks the caps on every operation — per trade, per day, how many ops, the drawdown breaker,
              and when the key expires. A transfer out through chat is refused. Money comes home with your
              owner key. One command destroys the grant. The dashboard shows the contract, the key, and
              every cap, and <b>prove the wall</b> fires malicious intents so you can watch each one bounce.
            </p>
          </div>
        </div>
      </section>

      <section id="paper">
        <div className="wrap">
          <div className="section-head">
            <div className="tag" data-reveal="fade"><span className="n">03</span> — before a coin moves</div>
            <h2>Paper, then live.</h2>
            <p>Paper is for watching. Live is for funds. They are not the same path.</p>
          </div>
          <div className="steps steps-two">
            <div className="step">
              <div className="num">Paper</div>
              <h4>Self-hosted, nothing at risk</h4>
              <p>Install it and the band starts on paper: live prices, simulated fills, zero funds. You watch it trade before a coin moves.</p>
            </div>
            <div className="step">
              <div className="num">Live</div>
              <h4>Funded, inside the wall</h4>
              <p>The hosted app is this path. Open it, sign the wall, send it money. Real fills, still inside the caps. Take it back out with your owner key.</p>
            </div>
          </div>
        </div>
      </section>


      <section className="app-strip" aria-label="Public agents">
        <div className="wrap">
          <div className="section-head">
            <div className="tag" data-reveal="fade"><span className="n">04</span> — live from Sherwood</div>
            <h2>The band, in public.</h2>
            <p>Agent accounts and the tape, read from the chain. No login.</p>
          </div>
          <nav className="app-index">
            <Link href="/dashboard" className="app-index-link">
              <span>Agents</span>
              <strong>See live holdings</strong>
              <p>Public agent accounts, read from the chain. No login.</p>
              <b aria-hidden>↗</b>
            </Link>
            <Link href="/watch" className="app-index-link">
              <span>Activity</span>
              <strong>Watch it trade</strong>
              <p>The live tape of on-chain fills as they happen.</p>
              <b aria-hidden>↗</b>
            </Link>
          </nav>
        </div>
      </section>

      <section id="learn">
        <div className="wrap">
          <div className="section-head">
            <div className="tag" data-reveal="fade"><span className="n">05</span> — quickstart</div>
            <h2>Begin here.</h2>
            <p>The hosted path is three signatures. Telegram is optional, and the full guide lives in the docs.</p>
          </div>
          <nav className="app-index">
            <Link href="/docs" className="app-index-link">
              <span>Tutorials</span>
              <strong>Start here</strong>
              <p>Wallet, limits, Telegram, and how paper differs from live.</p>
              <b aria-hidden>↗</b>
            </Link>
          </nav>
          <div className="steps">
            {STEPS.map(([n, t, d]) => (
              <div key={n} className="step">
                <div className="num">{n}</div>
                <h4>{t}</h4>
                <p>{d}</p>
              </div>
            ))}
          </div>
          <div id="telegram" className="safety" style={{ marginTop: 48 }}>
            <div className="tag"><span className="n">06</span> — two minutes</div>
            <h3 style={{ marginTop: 18 }}>Set up Telegram</h3>
            <ol>
              <li>Message <strong>@BotFather</strong> → <code className="inline">/newbot</code> → copy the token</li>
              <li>Dashboard → <strong>Settings → Telegram</strong> → paste, test, enable</li>
              <li>Message your bot <code className="inline">/link &lt;code&gt;</code> — you&apos;re the owner</li>
              <li>Say “how are we doing?” — you&apos;re chatting with your band</li>
            </ol>
            <p>
              <Link href="/docs#telegram" className="btn btn-ghost">Full Telegram guide <Icon name="arrow" size={15}/></Link>
            </p>
          </div>
        </div>
      </section>

      <section id="install">
        <div className="wrap">
          <div className="section-head">
            <div className="tag" data-reveal="fade"><span className="n">07</span> — on your machine</div>
            <h2>Run it yourself.</h2>
            <p>Desktop, the Android demo, an iPhone note, and the source. Self-host starts on paper.</p>
          </div>
          <div className="download-options">
            <div><span className="path-note">Paper</span><h3>On your desktop</h3><a href={WINDOWS_DOWNLOAD} className="btn btn-ghost">Download for Windows <Icon name="arrow" size={15}/></a><p>Windows {DESKTOP_VERSION} · {DESKTOP_SIZE}<br/>macOS and Linux: the one-line install below.</p></div>
            <div><span className="path-note">On a phone</span><h3>Explore the Android demo</h3><a href={ANDROID_DOWNLOAD} className="btn btn-ghost">Download Android demo <Icon name="arrow" size={15}/></a><p>Android {ANDROID_VERSION} · {ANDROID_SIZE}<br/>The mobile beta doesn&apos;t trade yet — it shows generated data, and it won&apos;t sign a permission wall.</p></div>
            <div><span className="path-note">On a phone</span><h3>On iPhone?</h3><p>There&apos;s no iOS build yet. Leave your email for one message when there is something to install.</p><IosBetaForm/></div>
            <div>
              <span className="path-note">For developers</span>
              <h3>Claude, Cursor, and the source</h3>
              <p>
                Connect an assistant at the MCP server <code className="inline">{MCP_SERVER}</code>.{" "}
                <Link className="link" href="/claude">Set it up in one click</Link>
                {" · "}
                <a className="link" href="/llms.txt">instructions for AI assistants</a>
                {" · "}
                <Link className="link" href="/api">Build with Merrymen</Link>
                {" · "}
                <a className="link" href={GITHUB}>GitHub</a>
              </p>
            </div>
          </div>
          <pre className="code" style={{ marginTop: 36 }}>{`# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/millw14/merrymen/main/install.sh | bash

# Windows (PowerShell)
irm https://raw.githubusercontent.com/millw14/merrymen/main/install.ps1 | iex

# already have Node 22.12+ ? (any OS)
npm install -g merrymen && merrymen start`}</pre>
        </div>
      </section>

      {/* ── word from the woods — real quotes, verifiable receipts ───────── */}
      <section id="words">
        <div className="wrap">
          <div className="section-head center">
            <div className="tag" style={{ justifyContent: "center" }} data-reveal="fade"><span className="n">08</span> — word from the woods</div>
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
            <a href={HOSTED_APP} className="btn btn-primary btn-lg has-box">
              Start trading <span className="box"><Icon name="arrow" size={16} /></span>
            </a>
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
    </div>
  );
}
