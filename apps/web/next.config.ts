/**
 * Next.js configuration for the web dashboard.
 *
 * Minimal config -- Phase 2 will add specific settings as needed.
 */

import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { NextConfig } from "next";

const __dirname = dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  transpilePackages: ["@dublin/tools", "@dublin/email"],
  serverExternalPackages: ["imapflow", "nodemailer"],
  outputFileTracingRoot: join(__dirname, "../../"),
};

export default nextConfig;
