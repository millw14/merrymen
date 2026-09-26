import type { Metadata } from "next";
import Link from "next/link";
import { IosBetaForm } from "@/components/IosBetaForm";
import { Icon } from "@/components/Icon";

/**
 * /app — the mobile app's own page. Mobile-first BY DESIGN: most visitors
 * arrive from a Telegram post on a phone, so the layout is composed at 390px
 * and the desktop view is the adaptation, not the other way round.
 *
 * EVERY CLAIM HERE IS BACKED BY SHIPPED CODE, and the app's limits are said
 * out loud — same rule as the home page's download card. This page describes
 * the NATIVE app (android-native/, Kotlin), which replaced the Expo demo at
 * 0.2.0. Its seams are the story: it holds no key and hands every signature
 * to the web app (android-native/README.md, "The one architectural decision"),
 * a write is sent once and never retried, and a figure it could not read is a
 * dash, not $0.00. The Expo demo's claims (a seed born on the phone, the seed
 * quiz, signing the wall on-device) are NOT true of this app — do not bring
 * them back while it is the build this page offers.
 *
 * The art is generated (Higgsfield, outlaw-noir brief) and lives in
 * public/app/. Decorative only — alt text tells the truth, and the page reads
 * fine with images off.
 */

const GITHUB = "https://github.com/millw14/merrymen";
// Bump version and size TOGETHER with app/page.tsx — the URL derives from it,
// and the two pages must never offer different builds.
const ANDROID_VERSION = "0.2.0";
const ANDROID_SIZE = "2.4 MB";
const ANDROID_DOWNLOAD = `${GITHUB}/releases/download/android-v${ANDROID_VERSION}/merrymen-${ANDROID_VERSION}.apk`;

export const metadata: Metadata = {
  title: "The band, in your pocket — the merrymen app",
  description:
    "The merrymen Android app: your agent's book, its chat, the feed and the group chat, native on your phone. It holds no private key — anything that needs your signature opens the web app's own screen. iOS waiting list open.",
};

export default function AppPage() {
  return (
    <section className="apppage">
      {/* ── hero: the archer, the phone as the lantern ── */}
      <header className="app-hero">
        <div className="app-hero-art" aria-hidden="true" />
        <div className="app-hero-veil" aria-hidden="true" />
        <div className="wrap app-hero-inner">
          <div className="tag" data-reveal="fade"><span className="n">—</span> the mobile app</div>
          <h1 data-reveal="mask">
            The band,<br />in your pocket.
          </h1>
          <p className="app-lede" data-reveal="up">
            Your agent&apos;s book, its chat, the feed and the group chat — <strong>native on
            Android</strong>. Sign in with the same account you use on the web. The app holds no
            private key: anything that needs your signature opens the web app&apos;s own screen,
            and only your session comes back.
          </p>
          <div className="app-hero-cta" data-reveal="up">
            <a className="btn btn-primary has-box" href={ANDROID_DOWNLOAD}>
              <Icon name="arrow" size={15} /> Android · v{ANDROID_VERSION}
            </a>
            <a className="btn btn-ghost" href="#ios">
              iOS waiting list
            </a>
          </div>
          <p className="app-hero-fine" data-reveal="fade">
            {ANDROID_SIZE} APK, Android 8 or newer. Had the old demo installed? <em>Uninstall it
            first</em> — the new app is signed with a different key, so Android won&apos;t install
            it over the demo.
          </p>
        </div>
      </header>

      {/* ── the phone itself: an illustration of the owner's book, not a screenshot ── */}
      <div className="wrap app-phone-section">
        <div className="app-phone-copy">
          <div className="tag" data-reveal="fade"><span className="n">01</span> the camp, at a glance</div>
          <h2 data-reveal="mask">One screen. The whole camp.</h2>
          <p data-reveal="up">
            Your book, stamped paper or live: every position, honest P&amp;L, and your agent&apos;s
            own tape — <strong>including the refused trades</strong>. A trade the wall turned back is
            part of the record, not something to hide. And a figure the app couldn&apos;t read shows
            a dash, never $0.00: &ldquo;we never got an answer&rdquo; and &ldquo;the answer was
            nothing&rdquo; are different things, and only one of them should make you buy more.
          </p>
        </div>
        <div className="app-phone-stage" data-reveal="up">
          <div className="app-phone" role="img" aria-label="Illustration of the owner's book: equity, positions and recent trades, including refused ones">
            <div className="app-phone-notch" aria-hidden="true" />
            <div className="app-screen">
              <div className="scr-row scr-top">
                <span className="scr-name">🏹 Will Scarlet</span>
                <span className="scr-dot" title="live" />
              </div>
              <div className="scr-equity">
                <span className="scr-big">1,247.82</span>
                <span className="scr-unit">USDG</span>
              </div>
              <div className="scr-delta">▲ +12.40 today</div>
              <svg className="scr-spark" viewBox="0 0 300 64" preserveAspectRatio="none" aria-hidden="true">
                <defs>
                  <linearGradient id="sparkfill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--lime)" stopOpacity="0.28" />
                    <stop offset="100%" stopColor="var(--lime)" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <path d="M0,46 L20,44 L40,47 L60,40 L80,42 L100,35 L120,38 L140,30 L160,33 L180,26 L200,29 L220,22 L240,25 L260,18 L280,21 L300,14 L300,64 L0,64 Z" fill="url(#sparkfill)" />
                <path d="M0,46 L20,44 L40,47 L60,40 L80,42 L100,35 L120,38 L140,30 L160,33 L180,26 L200,29 L220,22 L240,25 L260,18 L280,21 L300,14" fill="none" stroke="var(--lime)" strokeWidth="2" strokeLinejoin="round" />
              </svg>
              <div className="scr-split">
                <div><span className="scr-label">cash</span><span className="scr-val">402.10</span></div>
                <div><span className="scr-label">vault</span><span className="scr-val">610.00</span></div>
                <div><span className="scr-label">positions</span><span className="scr-val">235.72</span></div>
              </div>
              <div className="scr-list">
                <div className="scr-li"><span>QQQ</span><span className="scr-ok">landed · buy 16.60</span></div>
                <div className="scr-li"><span>WIF</span><span className="scr-ok">landed · buy 25.00</span></div>
                {/*
                  REFUSALS READ AS WORDS HERE BECAUSE THEY DO IN THE PRODUCT.
                  These rows used to show the raw rule slugs — `no-exit`,
                  `daily-cap` — which is exactly what a beta owner pasted back
                  to us asking what it meant. The terminal now renders
                  `rejectRuleLabel(rule)` (web/src/terminal/live.ts), so a mock
                  showing slugs advertises a product that no longer exists.

                  Shortened from the real labels in worker/src/thesis-policy.ts,
                  which is the authority — this page is a standalone Vercel app
                  with no workspace dependency, so it cannot import them. Keep
                  them faithful by hand, or drop the row.
                */}
                <div className="scr-li"><span>PEPE</span><span className="scr-no">refused · permission cannot sell it</span></div>
                <div className="scr-li"><span>QQQ</span><span className="scr-ok">vault · park 50.00</span></div>
                <div className="scr-li scr-fade"><span>TSLA</span><span className="scr-no">refused · past today&apos;s spending cap</span></div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── the three truths ── */}
      <div className="wrap app-truths">
        <div className="tag" data-reveal="fade"><span className="n">02</span> what makes it different</div>
        <h2 data-reveal="mask">Paranoid where it counts.</h2>
        <div className="app-truth-grid">
          <article className="app-truth" data-reveal="up">
            <h3>No key on the phone</h3>
            <p>
              The app never holds your owner key. Signing in, your agent&apos;s permission, its
              trading limits, adding funds and withdrawing open <em>the web app&apos;s own
              screen</em>, inside this one. The key stays where it already lives; the only thing
              that comes back is your session.
            </p>
          </article>
          <article className="app-truth" data-reveal="up">
            <h3>Sent once, never twice</h3>
            <p>
              An order, a setting, a post: every write goes out <strong>exactly once</strong>. If the
              answer is lost on a bad connection, the app looks up what happened instead of sending
              it again — because a retried order is a second order.
            </p>
          </article>
          <article className="app-truth" data-reveal="up">
            <h3>Paper says paper</h3>
            <p>
              Practice trades are stamped <span className="mono-chip">Paper</span> wherever they
              appear, a refused buy never reads &ldquo;bought&rdquo;, and a trade confirms against
              your agent&apos;s own ceiling before anything is sent.
            </p>
          </article>
        </div>
      </div>

      {/* ── the campfire: sweep home ── */}
      <div className="app-camp">
        <div className="app-camp-art" aria-hidden="true" />
        <div className="app-camp-veil" aria-hidden="true" />
        <div className="wrap app-camp-inner">
          <div className="tag" data-reveal="fade"><span className="n">03</span> the way home</div>
          <h2 data-reveal="mask">Sweep it all home. Anytime.</h2>
          <p data-reveal="up">
            Your agent&apos;s kill switch is on your profile. It arms, then confirms — one stray tap
            can&apos;t stand your agent down — and then it revokes the agent&apos;s permission and
            stops it. <strong>Withdraw</strong> sits right beside Add funds, and opens the web
            app&apos;s own withdraw screen, where your key is.
          </p>
        </div>
      </div>

      {/* ── the honesty strip ── */}
      <div className="wrap app-honest" data-reveal="up">
        <div className="app-honest-card">
          <h3>What it doesn&apos;t do yet</h3>
          <p>
            No push notifications, no widgets, and no offline copy: it shows what the server says
            now, or says it couldn&apos;t reach it. Your watchlist lives on the phone and
            doesn&apos;t sync with the web&apos;s. It isn&apos;t on the Play Store yet, so Android
            will ask you to allow installs from your browser.
          </p>
          <p className="app-honest-sub">
            It talks to the hosted service at app.merrymen.dev, or to your own merrymen server if
            you set one in Settings. Either way the most a server ever holds is a capped, revocable
            session key.
          </p>
        </div>
      </div>

      {/* ── get it ── */}
      <div className="wrap app-get" id="ios">
        <div className="tag" data-reveal="fade"><span className="n">04</span> ride with us</div>
        <h2 data-reveal="mask">Get it on your phone.</h2>
        <div className="app-get-grid">
          <div className="app-get-card" data-reveal="up">
            <h3>Android — out now</h3>
            <p>
              Sideload the APK and sign in with the account you use on the web. v{ANDROID_VERSION},{" "}
              {ANDROID_SIZE}.
            </p>
            <a className="btn btn-primary has-box" href={ANDROID_DOWNLOAD}>
              <Icon name="arrow" size={15} /> Download for Android
            </a>
          </div>
          <div className="app-get-card" data-reveal="up">
            <h3>iOS — the waiting list</h3>
            <p>
              No build yet, and we won&apos;t pretend otherwise. Leave an email and you&apos;ll hear
              when there is something real to install — that&apos;s the whole promise.
            </p>
            <IosBetaForm />
          </div>
        </div>
        <p className="app-get-foot" data-reveal="fade">
          Everything the app talks to is open — <a className="link" href={GITHUB}>read the code</a>,
          or start with the <Link className="link" href="/docs">docs</Link>.
        </p>
      </div>
    </section>
  );
}
