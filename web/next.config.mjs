/** @type {import('next').NextConfig} */
const nextConfig = {
  // core lives outside the web/ dir (packages/core, resolved via tsconfig
  // paths) — externalDir lets Next compile it. No workspace dep needed, which
  // is what makes `npm install -g merrymen` possible.
  experimental: {
    externalDir: true,
  },
};

export default nextConfig;
