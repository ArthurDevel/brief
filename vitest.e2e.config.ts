import { defineConfig } from "vitest/config";
import dotenv from "dotenv";

dotenv.config({ path: ".env.test.local" });

export default defineConfig({
  test: {
    include: ["**/*.e2e.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
