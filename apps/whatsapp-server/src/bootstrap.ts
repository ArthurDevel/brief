/**
 * WhatsApp server bootstrap.
 *
 * Responsibilities:
 * - Load environment variables before any traced runtime code starts
 * - Start Langfuse instrumentation before the server module is imported
 * - Import the server entrypoint after bootstrap setup is complete
 */

import { config as loadDotEnv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

const currentDir = path.dirname(fileURLToPath(import.meta.url));
loadDotEnv({ path: path.resolve(currentDir, "../.env") });

await import("./instrumentation.js");
await import("./server.js");
