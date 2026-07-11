/** @type {import('next').NextConfig} */
const nextConfig = {
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
