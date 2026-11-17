/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Fix C: standalone output so the Docker image can run the admin with
  // just `node server.js` (no next CLI / full node_modules at runtime).
  // The admin listens on port 3001 (see Dockerfile, PORT=3001).
  output: 'standalone',
};
module.exports = nextConfig;
