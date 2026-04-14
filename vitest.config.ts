import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./apps/web", import.meta.url)),
    },
  },
  test: {
    testTimeout: 15_000,
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.e2e.ts"],
  },
});
