/** @type {import('next').NextConfig} */
const nextConfig = {
  // We run our own typecheck; the marketing site shouldn't block a deploy on it.
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
