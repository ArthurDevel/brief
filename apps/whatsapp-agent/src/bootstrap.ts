/**
 * WhatsApp agent bootstrap.
 *
 * Responsibilities:
 * - Load environment variables before any traced runtime code starts
 * - Start Langfuse instrumentation before the agent module is imported
 * - Start the LiveKit worker after bootstrap setup is complete
 */

import { config as loadDotEnv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

const currentDir = path.dirname(fileURLToPath(import.meta.url));
loadDotEnv({ path: path.resolve(currentDir, "../.env") });
loadDotEnv({ path: path.resolve(currentDir, "../.env.local") });

await import("./instrumentation.js");

const { runWorkerApp } = await import("./agent.js");
runWorkerApp();
