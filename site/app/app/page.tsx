import type { Metadata } from "next";
import Link from "next/link";
import { IosBetaForm } from "@/components/IosBetaForm";
import { Icon } from "@/components/Icon";

/**
 * /app — the mobile app's own page. Mobile-first BY DESIGN: most visitors
 * arrive from a Telegram post on a phone, so the layout is composed at 390px
 * and the desktop view is the adaptation, not the other way round.
 *
 * EVERY CLAIM HERE IS BACKED BY SHIPPED CODE, and the demo's limits are said
 * out loud — same rule as the home page's download card. The app's honest
 * seams (seed quiz before anything persists, FLAG_SECURE, the deliberate
 * absence of clipboard-copy for the phrase, demo build refusing to sign) are
 * the STORY, not the fine print: on this product, the paranoia is the pitch.
 *
 * The art is generated (Higgsfield, outlaw-noir brief) and lives in
 * public/app/. Decorative only — alt text tells the truth, and the page reads
 * fine with images off.
 */

const GITHUB = "https://github.com/millw14/merrymen";
// Bump version and size TOGETHER with app/page.tsx — the URL derives from it,
// and the two pages must never offer different builds.
const ANDROID_VERSION = "0.1.2";
const ANDROID_SIZE = "108 MB";
const ANDROID_DOWNLOAD = `${GITHUB}/releases/download/mobile-v${ANDROID_VERSION}/merrymen-demo-${ANDROID_VERSION}.apk`;

export const metadata: Metadata = {
  title: "The band, in your pocket — the merrymen app",
  description:
    "The merrymen mobile app: your agent's owner key is born on the phone, stored in the secure enclave, and never leaves. Sign the permission wall with your thumb. Android demo out now; iOS waiting list open.",
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
            Your agent&apos;s owner key is <strong>born on the phone</strong>, lives in the secure
            enclave, and never touches a server. The permission wall — the caps the chain itself
            enforces — gets signed by your thumb.
          </p>
          <div className="app-hero-cta" data-reveal="up">
            <a className="btn btn-primary has-box" href={ANDROID_DOWNLOAD}>
              <Icon name="arrow" size={15} /> Android demo · v{ANDROID_VERSION}
            </a>
            <a className="btn btn-ghost" href="#ios">
              iOS waiting list
            </a>
          </div>
          <p className="app-hero-fine" data-reveal="fade">
            {ANDROID_SIZE} APK · demo build — shows generated numbers and{" "}
            <em>refuses to sign a real wall</em>, on purpose. More on that below.
          </p>
        </div>
      </header>

      {/* ── the phone itself: a faithful mock of the home screen ── */}
      <div className="wrap app-phone-section">
        <div className="app-phone-copy">
          <div className="tag" data-reveal="fade"><span className="n">01</span> the camp, at a glance</div>
          <h2 data-reveal="mask">One screen. The whole camp.</h2>
          <p data-reveal="up">
            Equity and its day&apos;s move, the cash / vault split, every position, and the last
            fifteen decisions — <strong>including the refused ones</strong>. A trade the wall turned
            back is part of the record, not something to hide. If the feed drops, the app keeps the
            last good numbers and says how old they are, instead of pretending.
          </p>
        </div>
        <div className="app-phone-stage" data-reveal="up">
          <div className="app-phone" role="img" aria-label="The app's home screen: equity headline, sparkline, positions and recent decisions">
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
            <h3>Your key is born here</h3>
            <p>
              A fresh 12-word key is generated <em>on the device</em> and stored in the phone&apos;s
              secure storage, locked to this device only. It is never uploaded, never synced, never
              seen by us — there is no server it could even go to.
            </p>
          </article>
          <article className="app-truth" data-reveal="up">
            <h3>Prove it before it saves</h3>
            <p>
              The app makes you pass a three-question quiz on your own seed phrase — and{" "}
              <strong>nothing persists until you do</strong>. Screenshots are blocked while the
              phrase is up, it&apos;s wiped from memory if you background the app, and there is
              deliberately no copy button: a phrase in your clipboard is a phrase in the cloud.
            </p>
          </article>
          <article className="app-truth" data-reveal="up">
            <h3>The same wall, signed by thumb</h3>
            <p>
              The phone builds the <em>identical</em> permission wall as the dashboard — same code,
              same caps, same expiry — checks the account address didn&apos;t shift under it, and
              seals it on-device. Caps presets in the app&apos;s own words:{" "}
              <span className="mono-chip">the scout</span>, <span className="mono-chip">the outlaw</span>,{" "}
              <span className="mono-chip">the warlord</span>.
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
            Killed the agent? Lost the machine it ran on? The phone can rebuild your smart account
            from the seed phrase alone and sweep everything — cash, tokens, even the vault position —
            back to any wallet you control. The escape hatch works <strong>even after the kill
            switch</strong>, because that is what an escape hatch is for.
          </p>
        </div>
      </div>

      {/* ── the honesty strip ── */}
      <div className="wrap app-honest" data-reveal="up">
        <div className="app-honest-card">
          <h3>Why the demo won&apos;t sign a real wall</h3>
          <p>
            The current build shows <em>generated</em> numbers — and because a demo that could mint a
            fundable account would be a demo that lies about real money, the signing path{" "}
            <strong>refuses to run in demo builds</strong>. Not a greyed-out button: the code throws
            at the chokepoint, so even a deep link can&apos;t reach it. Recovery stays enabled,
            because blocking the exit is never a safety feature.
          </p>
          <p className="app-honest-sub">
            The real-data build connects to a merrymen worker — your own self-hosted one, or the
            hosted service. Your owner key never leaves the phone either way; the most a server ever
            holds is a capped, revocable session key.
          </p>
        </div>
      </div>

      {/* ── get it ── */}
      <div className="wrap app-get" id="ios">
        <div className="tag" data-reveal="fade"><span className="n">04</span> ride with us</div>
        <h2 data-reveal="mask">Get it on your phone.</h2>
        <div className="app-get-grid">
          <div className="app-get-card" data-reveal="up">
            <h3>Android — demo out now</h3>
            <p>
              Sideload the APK, meet the band, walk the onboarding with a throwaway key. v
              {ANDROID_VERSION}, {ANDROID_SIZE}.
            </p>
            <a className="btn btn-primary has-box" href={ANDROID_DOWNLOAD}>
              <Icon name="arrow" size={15} /> Download the demo
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
