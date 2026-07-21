/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Dev-only: lets the dev server's HMR/webpack requests through when the
  // app is opened from a phone/tablet on the same LAN (e.g. testing the
  // mobile-width photo viewer) instead of localhost.
  allowedDevOrigins: ["192.168.1.11"],
};

module.exports = nextConfig;
