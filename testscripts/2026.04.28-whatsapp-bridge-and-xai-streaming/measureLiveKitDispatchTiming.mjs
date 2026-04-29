/**
 * Measures LiveKit control-plane phases in the WhatsApp bridge startup path.
 *
 * Responsibilities:
 * - Time the current createRoom -> createDispatch -> token flow.
 * - Time LiveKit's dispatch-auto-creates-room flow described in the docs.
 * - Time token generation with RoomConfiguration agent dispatch.
 * - Write a JSON report with per-phase timings.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AccessToken, AgentDispatchClient, RoomServiceClient } from "livekit-server-sdk";
import { RoomAgentDispatch, RoomConfiguration } from "@livekit/protocol";

// ============================================================================
// CONSTANTS
// ============================================================================

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(SCRIPT_DIR, "output");
const ENV_FILE_PATH = path.join(SCRIPT_DIR, ".env");
const DEFAULT_AGENT_NAME = "whatsapp-composio-agent";
const DEFAULT_CALLER = "+10000000000";
const DEFAULT_MODE = "all";

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

await main();

/**
 * Runs the LiveKit dispatch timing notebook.
 * @returns {Promise<void>}
 */
async function main() {
  const options = readOptions();
  const env = readLiveKitEnv();
  const report = await measureLiveKitStartup(env, options);
  const reportPath = await writeReport(report);

  printReport(report);
  console.log(`\nReport written to ${reportPath}`);
}

// ============================================================================
// MAIN LOGIC
// ============================================================================

/**
 * Measures selected LiveKit startup variants.
 * @param {{ httpUrl: string, wsUrl: string, apiKey: string, apiSecret: string, agentName: string }} env LiveKit environment values.
 * @param {{ mode: string, caller: string }} options Runtime options.
 * @returns {Promise<object>} Full timing report.
 */
async function measureLiveKitStartup(env, options) {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const roomClient = new RoomServiceClient(env.httpUrl, env.apiKey, env.apiSecret);
  const dispatchClient = new AgentDispatchClient(env.httpUrl, env.apiKey, env.apiSecret);
  const report = {
    script: "measureLiveKitDispatchTiming",
    createdAt: new Date().toISOString(),
    docsChecked: [
      "https://docs.livekit.io/agents/server/agent-dispatch/",
      "https://docs.livekit.io/reference/agents/agent-dispatch-service-api/",
    ],
    liveKitHost: redactUrl(env.httpUrl),
    options,
    variants: [],
    interpretation: [],
  };

  if (options.mode === "all" || options.mode === "current") {
    report.variants.push(await measureCurrentFlow(roomClient, dispatchClient, env, options));
  }

  if (options.mode === "all" || options.mode === "dispatch-only") {
    report.variants.push(await measureDispatchOnlyFlow(roomClient, dispatchClient, env, options));
  }

  if (options.mode === "all" || options.mode === "token-dispatch") {
    report.variants.push(await measureTokenDispatchFlow(env, options));
  }

  report.interpretation = buildInterpretation(report.variants);
  return report;
}

/**
 * Measures the current production-shaped LiveKit path.
 * @param {RoomServiceClient} roomClient LiveKit room client.
 * @param {AgentDispatchClient} dispatchClient LiveKit dispatch client.
 * @param {{ apiKey: string, apiSecret: string, agentName: string }} env LiveKit environment values.
 * @param {{ caller: string }} options Runtime options.
 * @returns {Promise<object>} Variant report.
 */
async function measureCurrentFlow(roomClient, dispatchClient, env, options) {
  const roomName = buildRoomName("current");
  const metadata = buildMetadata(options);
  const phases = [];
  const startedAt = performance.now();

  try {
    phases.push((await measurePhase("create_room", async () => {
      await roomClient.createRoom({
        name: roomName,
        emptyTimeout: 30,
        departureTimeout: 15,
        maxParticipants: 3,
      });
    })).phase);

    phases.push((await measurePhase("create_dispatch", async () => {
      await dispatchClient.createDispatch(roomName, env.agentName, { metadata });
    })).phase);

    phases.push((await measurePhase("create_bridge_token", async () => {
      await createBridgeToken(env, roomName, metadata, false);
    })).phase);

    return buildVariantReport("current", roomName, startedAt, phases, [
      "Matches current production shape: createRoom, then createDispatch, then bridge token.",
    ]);
  } finally {
    await roomClient.deleteRoom(roomName).catch(() => undefined);
  }
}

/**
 * Measures relying on CreateDispatch to create the room.
 * @param {RoomServiceClient} roomClient LiveKit room client.
 * @param {AgentDispatchClient} dispatchClient LiveKit dispatch client.
 * @param {{ apiKey: string, apiSecret: string, agentName: string }} env LiveKit environment values.
 * @param {{ caller: string }} options Runtime options.
 * @returns {Promise<object>} Variant report.
 */
async function measureDispatchOnlyFlow(roomClient, dispatchClient, env, options) {
  const roomName = buildRoomName("dispatch-only");
  const metadata = buildMetadata(options);
  const phases = [];
  const startedAt = performance.now();

  try {
    phases.push((await measurePhase("create_dispatch_auto_room", async () => {
      await dispatchClient.createDispatch(roomName, env.agentName, { metadata });
    })).phase);

    phases.push((await measurePhase("create_bridge_token", async () => {
      await createBridgeToken(env, roomName, metadata, false);
    })).phase);

    return buildVariantReport("dispatch-only", roomName, startedAt, phases, [
      "LiveKit docs state CreateDispatch creates the room automatically when it does not exist.",
      "This removes one LiveKit control-plane round trip from the pre-accept path.",
    ]);
  } finally {
    await roomClient.deleteRoom(roomName).catch(() => undefined);
  }
}

/**
 * Measures bridge token creation with embedded agent dispatch config.
 * @param {{ apiKey: string, apiSecret: string, agentName: string }} env LiveKit environment values.
 * @param {{ caller: string }} options Runtime options.
 * @returns {Promise<object>} Variant report.
 */
async function measureTokenDispatchFlow(env, options) {
  const roomName = buildRoomName("token-dispatch");
  const metadata = buildMetadata(options);
  const phases = [];
  const startedAt = performance.now();

  phases.push((await measurePhase("create_bridge_token_with_agent_dispatch", async () => {
    await createBridgeToken(env, roomName, metadata, true);
  })).phase);

  return buildVariantReport("token-dispatch", roomName, startedAt, phases, [
    "LiveKit docs state token agent dispatch runs when the first participant connects and creates the room.",
    "This removes createRoom and createDispatch HTTP calls from the pre-accept path.",
    "This script does not connect a LiveKit participant, so it measures only local token creation.",
  ]);
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Reads CLI options.
 * @returns {{ mode: string, caller: string }} Runtime options.
 */
function readOptions() {
  return {
    mode: readStringFlag("--mode", DEFAULT_MODE),
    caller: readStringFlag("--caller", DEFAULT_CALLER),
  };
}

/**
 * Reads a string CLI flag.
 * @param {string} flagName CLI flag name.
 * @param {string} defaultValue Default value.
 * @returns {string} Parsed value.
 */
function readStringFlag(flagName, defaultValue) {
  const arg = process.argv
    .filter((value) => value !== "--")
    .find((value) => value.startsWith(`${flagName}=`));
  if (!arg) {
    return defaultValue;
  }

  const value = arg.slice(flagName.length + 1).trim();
  if (!value) {
    throw new Error(`${flagName} cannot be empty.`);
  }

  return value;
}

/**
 * Reads LiveKit environment values from process.env or local .env.
 * @returns {{ httpUrl: string, wsUrl: string, apiKey: string, apiSecret: string, agentName: string }} LiveKit environment values.
 */
function readLiveKitEnv() {
  const localEnv = readDotEnv(ENV_FILE_PATH);
  const livekitUrl = requireEnvValue("LIVEKIT_URL", localEnv);

  return {
    httpUrl: toHttpUrl(livekitUrl),
    wsUrl: toWebSocketUrl(livekitUrl),
    apiKey: requireEnvValue("LIVEKIT_API_KEY", localEnv),
    apiSecret: requireEnvValue("LIVEKIT_API_SECRET", localEnv),
    agentName: process.env.LIVEKIT_AGENT_NAME || localEnv.LIVEKIT_AGENT_NAME || DEFAULT_AGENT_NAME,
  };
}

/**
 * Reads a .env file into an object.
 * @param {string} filePath .env path.
 * @returns {Record<string, string>} Parsed values.
 */
function readDotEnv(filePath) {
  if (!existsSync(filePath)) {
    return {};
  }

  const values = {};
  for (const rawLine of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      continue;
    }

    values[match[1]] = stripQuotes(match[2].trim());
  }

  return values;
}

/**
 * Returns one required environment value.
 * @param {string} name Environment variable name.
 * @param {Record<string, string>} localEnv Local .env values.
 * @returns {string} Required value.
 */
function requireEnvValue(name, localEnv) {
  const value = process.env[name] || localEnv[name];
  if (!value?.trim()) {
    throw new Error(`${name} is required. Set it in process.env or this test folder's .env.`);
  }

  return value.trim();
}

/**
 * Removes matching wrapping quotes.
 * @param {string} value Raw value.
 * @returns {string} Unquoted value.
 */
function stripQuotes(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }

  return value;
}

/**
 * Creates a LiveKit participant token.
 * @param {{ apiKey: string, apiSecret: string, agentName: string }} env LiveKit environment values.
 * @param {string} roomName LiveKit room name.
 * @param {string} metadata Job/participant metadata.
 * @param {boolean} includeAgentDispatch Whether to embed agent dispatch in the token.
 * @returns {Promise<string>} JWT token.
 */
async function createBridgeToken(env, roomName, metadata, includeAgentDispatch) {
  const token = new AccessToken(env.apiKey, env.apiSecret, {
    identity: `bridge-${randomUUID()}`,
    name: "WhatsApp Bridge",
    metadata,
  });

  token.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
    canPublishData: false,
  });

  if (includeAgentDispatch) {
    token.roomConfig = new RoomConfiguration({
      agents: [
        new RoomAgentDispatch({
          agentName: env.agentName,
          metadata,
        }),
      ],
    });
  }

  return await token.toJwt();
}

/**
 * Builds test metadata matching production shape.
 * @param {{ caller: string }} options Runtime options.
 * @returns {string} JSON metadata.
 */
function buildMetadata(options) {
  return JSON.stringify({
    callId: `test-${randomUUID()}`,
    caller: options.caller,
    transport: "whatsapp",
  });
}

/**
 * Builds a unique room name for one variant run.
 * @param {string} prefix Variant prefix.
 * @returns {string} Room name.
 */
function buildRoomName(prefix) {
  return `wa-latency-${prefix}-${randomUUID()}`;
}

/**
 * Measures one phase.
 * @param {string} name Phase name.
 * @param {() => Promise<unknown>} callback Work to measure.
 * @returns {Promise<{ phase: object, value: unknown }>} Phase timing.
 */
async function measurePhase(name, callback) {
  const startedAt = performance.now();
  const value = await callback();
  const elapsedMs = roundMs(performance.now() - startedAt);

  return {
    phase: {
      name,
      elapsedMs,
      status: "ok",
    },
    value,
  };
}

/**
 * Builds a variant report.
 * @param {string} name Variant name.
 * @param {string} roomName LiveKit room name.
 * @param {number} startedAt Start timestamp from performance.now().
 * @param {object[]} phases Phase timings.
 * @param {string[]} notes Notes.
 * @returns {object} Variant report.
 */
function buildVariantReport(name, roomName, startedAt, phases, notes) {
  return {
    name,
    roomName,
    totalElapsedMs: roundMs(performance.now() - startedAt),
    phases,
    notes,
  };
}

/**
 * Builds summary interpretation.
 * @param {object[]} variants Variant reports.
 * @returns {string[]} Interpretation lines.
 */
function buildInterpretation(variants) {
  const current = variants.find((variant) => variant.name === "current");
  const dispatchOnly = variants.find((variant) => variant.name === "dispatch-only");
  const tokenDispatch = variants.find((variant) => variant.name === "token-dispatch");
  const lines = [];

  if (current && dispatchOnly) {
    lines.push(`dispatch-only saved ${roundMs(current.totalElapsedMs - dispatchOnly.totalElapsedMs)}ms versus current in this run.`);
  }

  if (current && tokenDispatch) {
    lines.push(`token-dispatch removes ${roundMs(current.totalElapsedMs - tokenDispatch.totalElapsedMs)}ms of pre-accept LiveKit control-plane work in this run, but dispatch occurs when the bridge connects.`);
  }

  lines.push("Meta preAccept/accept and incoming WhatsApp media readiness are not measured here because they require an active call.");
  return lines;
}

/**
 * Converts LiveKit URL to HTTP URL.
 * @param {string} livekitUrl Configured LiveKit URL.
 * @returns {string} HTTP URL.
 */
function toHttpUrl(livekitUrl) {
  if (livekitUrl.startsWith("wss://")) {
    return `https://${livekitUrl.slice("wss://".length)}`;
  }

  if (livekitUrl.startsWith("ws://")) {
    return `http://${livekitUrl.slice("ws://".length)}`;
  }

  return livekitUrl;
}

/**
 * Converts LiveKit URL to websocket URL.
 * @param {string} livekitUrl Configured LiveKit URL.
 * @returns {string} WebSocket URL.
 */
function toWebSocketUrl(livekitUrl) {
  if (livekitUrl.startsWith("https://")) {
    return `wss://${livekitUrl.slice("https://".length)}`;
  }

  if (livekitUrl.startsWith("http://")) {
    return `ws://${livekitUrl.slice("http://".length)}`;
  }

  return livekitUrl;
}

/**
 * Redacts URL path/query.
 * @param {string} url Raw URL.
 * @returns {string} Redacted URL.
 */
function redactUrl(url) {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.hostname}`;
}

/**
 * Rounds milliseconds.
 * @param {number} value Milliseconds.
 * @returns {number} Rounded value.
 */
function roundMs(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Writes the report.
 * @param {object} report Full report.
 * @returns {Promise<string>} Report path.
 */
async function writeReport(report) {
  const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const outputPath = path.join(OUTPUT_DIR, `livekit-dispatch-timing-${timestamp}.json`);
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return outputPath;
}

/**
 * Prints concise timing summary.
 * @param {object} report Full report.
 * @returns {void}
 */
function printReport(report) {
  console.log("LiveKit dispatch timing");
  for (const variant of report.variants) {
    console.log(`\n${variant.name}: ${variant.totalElapsedMs}ms`);
    for (const phase of variant.phases) {
      console.log(`  ${phase.name.padEnd(42)} ${String(phase.elapsedMs).padStart(8)}ms`);
    }
  }

  console.log("\nInterpretation:");
  for (const line of report.interpretation) {
    console.log(`- ${line}`);
  }
}
