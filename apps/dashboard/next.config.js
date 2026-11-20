/** @type {import("next").NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@forge/auth', '@forge/database', '@forge/shared'],
  webpack: (config) => {
    // Workspace packages use NodeNext-style `.js` specifiers for `.ts` sources
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
    }
    return config
  },
}
module.exports = nextConfig
