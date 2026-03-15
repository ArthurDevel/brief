/**
 * Next.js configuration for the web dashboard.
 *
 * Minimal config -- Phase 2 will add specific settings as needed.
 */

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@dublin/tools", "@dublin/email"],
};

export default nextConfig;
