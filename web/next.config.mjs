/** @type {import('next').NextConfig} */
const nextConfig = {
  devIndicators: false,
  // Lets a production build write somewhere other than the dev server's .next,
  // so the two do not clobber each other mid-run. Nothing else reads it.
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
