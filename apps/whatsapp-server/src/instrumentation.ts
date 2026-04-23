/**
 * Langfuse instrumentation bootstrap for the WhatsApp server.
 *
 * Responsibilities:
 * - Initialize the OpenTelemetry Node SDK with the Langfuse span processor
 * - Validate required Langfuse environment variables at startup
 * - Flush Langfuse spans during graceful shutdown
 */

import { LangfuseSpanProcessor } from "@langfuse/otel";
import { setLangfuseTracerProvider } from "@langfuse/tracing";
import { trace } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { maskTracingData } from "./tracing.js";

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

const sdk = createNodeSdk();
sdk.start();
setLangfuseTracerProvider(trace.getTracerProvider());
registerShutdownHandlers(sdk);

console.info("[whatsapp-server] Langfuse instrumentation started");

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Creates the Node SDK configured for Langfuse export.
 * @returns Configured OpenTelemetry Node SDK
 */
function createNodeSdk(): NodeSDK {
  return new NodeSDK({
    spanProcessors: [
      new LangfuseSpanProcessor({
        baseUrl: requireEnv("LANGFUSE_BASE_URL"),
        publicKey: requireEnv("LANGFUSE_PUBLIC_KEY"),
        secretKey: requireEnv("LANGFUSE_SECRET_KEY"),
        mask: ({ data }) => maskTracingData(data),
      }),
    ],
  });
}

/**
 * Registers graceful shutdown handlers for telemetry flushing.
 * @param nodeSdk - Running OpenTelemetry Node SDK
 * @returns Void
 */
function registerShutdownHandlers(nodeSdk: NodeSDK): void {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void shutdownNodeSdk(nodeSdk, signal);
    });
  }
}

/**
 * Shuts down the OpenTelemetry SDK and exits the process.
 * @param nodeSdk - Running OpenTelemetry Node SDK
 * @param signal - Process signal that triggered shutdown
 * @returns Promise that resolves when shutdown work is done
 */
async function shutdownNodeSdk(nodeSdk: NodeSDK, signal: string): Promise<void> {
  try {
    await nodeSdk.shutdown();
    console.info("[whatsapp-server] Langfuse instrumentation stopped", {
      signal,
    });
    process.exit(0);
  } catch (error) {
    console.error("[whatsapp-server] failed to stop Langfuse instrumentation", {
      error: error instanceof Error ? error.message : String(error),
      signal,
    });
    process.exit(1);
  }
}

/**
 * Reads one required environment variable.
 * @param name - Environment variable name
 * @returns Trimmed environment value
 */
function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} environment variable is required for Langfuse tracing`);
  }

  return value;
}
