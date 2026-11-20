/** @type {import("next").NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: [],
  experimental: {
    // Enables src/instrumentation.ts, which validates NEXTAUTH_SECRET at startup
    instrumentationHook: true,
  },
}
module.exports = nextConfig
