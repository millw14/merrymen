/** @type {import('next').NextConfig} */
const nextConfig = {
  devIndicators: false,
  // A production build can be sent somewhere other than the dev server's
  // `.next`, so the two do not clobber each other mid-run — which is a real
  // problem here, because `npm run build` and `npm run dev:web` in the same
  // checkout will fight over the directory and leave the dev server serving
  // half-written chunks.
  //
  // IT IS A LOCAL CONVENIENCE AND NOTHING MORE. `package.json#files` ships
  // `web/` with `!web/.next/cache`, the CLI serves from `.next`, and nothing in
  // the image or the packaging reads NEXT_DIST_DIR — so setting it for a
  // release build produces an artifact none of them can find. Use it for a
  // concurrent local build; never for one you intend to ship.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // THERE ARE NO REWRITES HERE, AND THAT IS LOAD-BEARING.
  //
  // Three arrived with the terminal redesign, proxying /robinhood/:path*,
  // /yahoo/:path* and /blockscout/:path* straight to those hosts. Because a
  // rewrite is same-origin, the browser attached the reader's session cookie —
  // `httpOnly, secure, sameSite:"strict", path:"/"` — to every one of those
  // requests, and Next forwarded it upstream: a live merrymen session posted to
  // Yahoo on every chart view. `sameSite:"strict"` offers nothing here, because
  // this IS the site. They were also unauthenticated open proxies at any path
  // the caller chose, outside middleware.ts, which guards only /api/.
  //
  // The replacement is `app/api/venue/route.ts` plus `lib/venue.ts`: an
  // allow-list of documents, symbols and windows, a request BUILT rather than
  // forwarded, a timeout, a byte cap and an edge cache. `web/src/lib/venue.test.ts`
  // fails if a rewrite is ever added back.
  // core lives outside the web/ dir (packages/core, resolved via tsconfig
  // paths) — externalDir lets Next compile it. No workspace dep needed, which
  // is what makes `npm install -g merrymen` possible.
  // ── URLS PEOPLE ALREADY HAVE ────────────────────────────────────────
  //
  // The board tab retired onto Home, and /leaderboard is a link testers have
  // open and have shared. `screenForPath` already resolves it to Home, so it
  // renders correctly either way; this normalises the address bar so nobody is
  // left looking at a URL for a screen that no longer exists.
  //
  // NOT `redirect()` inside the page. `(app)/layout.tsx` mounts the terminal
  // and never renders `children`, so a redirect written there may never run —
  // it would look right in review and do nothing.
  //
  // A REDIRECT IS NOT A REWRITE. venue.test.ts bans `rewrites(` and gives the
  // reason: a rewrite is same-origin, so the browser attaches the reader's
  // session cookie and Next forwards it upstream. A redirect sends the browser
  // somewhere with no such thing attached, and the destination here is our own.
  async redirects() {
    return [{ source: "/leaderboard", destination: "/", permanent: false }];
  },
  experimental: {
    externalDir: true,
  },
  // We typecheck + lint separately (`npm run typecheck`), and the published
  // package ships the dashboard prebuilt. If a fallback build ever runs on a
  // user's machine (`npm i -g` installs runtime deps only, not the @types /
  // eslint dev toolchain), it must not fail on type or lint checks it can't
  // run. Correctness is guarded by our own typecheck in dev/CI, not here.
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
