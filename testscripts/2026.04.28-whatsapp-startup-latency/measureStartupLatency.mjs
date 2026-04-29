/**
 * Measures startup phases for the WhatsApp initial greeting path.
 *
 * Responsibilities:
 * - Measure optional OpenRouter tool-call greeting latency.
 * - Measure xAI and optional Deepgram TTS response timing.
 * - Write a JSON report and print a concise phase table.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import path from "node:path";

// ============================================================================
// CONSTANTS
// ============================================================================

const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const OUTPUT_DIR = path.join(SCRIPT_DIR, "output");
const ENV_FILE_PATH = path.join(SCRIPT_DIR, ".env");

const DEFAULT_OPENROUTER_MODEL = "google/gemini-3-flash-preview";
const DEFAULT_XAI_VOICE = "ara";
const DEFAULT_XAI_SAMPLE_RATE = 24000;
const DEFAULT_GREETING_TEXT = "Hi, this is Brief. How can I help?";
const DEFAULT_DEEPGRAM_MODEL = "aura-2-andromeda-en";

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const XAI_TTS_URL = "https://api.x.ai/v1/tts";
const DEEPGRAM_SPEAK_URL = "https://api.deepgram.com/v1/speak";

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

await main();

/**
 * Runs the selected measurements and writes the report.
 *
 * @returns {Promise<void>}
 */
async function main() {
  loadEnvFile();

  const config = readConfig();
  validateConfig(config);

  const report = {
    createdAt: new Date().toISOString(),
    config: sanitizeConfig(config),
    phases: [],
  };

  if (config.runOpenRouter) {
    report.phases.push(await measureOpenRouter(config));
  }

  if (config.runXaiTts) {
    report.phases.push(await measureStreamingFetch({
      phaseName: "xai_tts",
      url: XAI_TTS_URL,
      headers: {
        Authorization: `Bearer ${config.xaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: {
        text: config.greetingText,
        voice_id: config.xaiVoice,
        language: "en",
        output_format: {
          codec: "pcm",
          sample_rate: config.xaiSampleRate,
        },
      },
    }));
  }

  if (config.runDeepgramTts) {
    const url = new URL(DEEPGRAM_SPEAK_URL);
    url.searchParams.set("model", config.deepgramModel);

    report.phases.push(await measureStreamingFetch({
      phaseName: "deepgram_tts",
      url: url.toString(),
      headers: {
        Authorization: `Token ${config.deepgramApiKey}`,
        "Content-Type": "application/json",
      },
      body: {
        text: config.greetingText,
      },
    }));
  }

  const reportPath = await writeReport(report);
  printPhaseTable(report.phases);
  printStartupEstimate(report.phases);
  console.log(`\nReport written to ${reportPath}`);
}

// ============================================================================
// MEASUREMENT FUNCTIONS
// ============================================================================

/**
 * Measures OpenRouter chat completion latency with a greeting tool schema.
 *
 * @param {object} config Runtime configuration.
 * @returns {Promise<object>} Phase result.
 */
async function measureOpenRouter(config) {
  const startedAt = performance.now();

  const response = await fetch(OPENROUTER_CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openRouterApiKey}`,
      "Content-Type": "application/json",
      "X-OpenRouter-Title": "WhatsApp Startup Latency Testscript",
    },
    body: JSON.stringify({
      model: config.openRouterModel,
      messages: [
        {
          role: "system",
          content: "You are measuring initial greeting latency. Call the provided tool with the greeting text.",
        },
        {
          role: "user",
          content: `Send this exact greeting to the user: ${config.greetingText}`,
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "send_message_to_user",
            description: "Send the initial WhatsApp greeting to the user.",
            parameters: {
              type: "object",
              additionalProperties: false,
              properties: {
                message: {
                  type: "string",
                  description: "The greeting message to send to the user.",
                },
              },
              required: ["message"],
            },
          },
        },
      ],
      tool_choice: {
        type: "function",
        function: {
          name: "send_message_to_user",
        },
      },
      temperature: 0,
      max_tokens: 120,
    }),
  });

  const headersReceivedAt = performance.now();
  const responseText = await response.text();
  const completedAt = performance.now();

  if (!response.ok) {
    throw new Error(`OpenRouter failed with ${response.status}: ${responseText}`);
  }

  const responseJson = JSON.parse(responseText);
  const toolCall = responseJson.choices?.[0]?.message?.tool_calls?.[0] ?? null;

  return {
    name: "openrouter_chat_completion",
    ok: true,
    status: response.status,
    headersMs: roundMs(headersReceivedAt - startedAt),
    firstChunkMs: null,
    fullResponseMs: roundMs(completedAt - startedAt),
    bytes: Buffer.byteLength(responseText),
    details: {
      model: responseJson.model,
      usage: responseJson.usage ?? null,
      toolCallName: toolCall?.function?.name ?? null,
    },
  };
}

/**
 * Measures response header, first audio chunk, and full response latency.
 *
 * @param {object} params Fetch measurement parameters.
 * @param {string} params.phaseName Phase name.
 * @param {string} params.url Request URL.
 * @param {Record<string, string>} params.headers Request headers.
 * @param {object} params.body JSON request body.
 * @returns {Promise<object>} Phase result.
 */
async function measureStreamingFetch(params) {
  const startedAt = performance.now();

  const response = await fetch(params.url, {
    method: "POST",
    headers: params.headers,
    body: JSON.stringify(params.body),
  });

  const headersReceivedAt = performance.now();

  if (!response.body) {
    throw new Error(`${params.phaseName} response did not include a readable body.`);
  }

  const reader = response.body.getReader();
  let firstChunkAt = null;
  let totalBytes = 0;
  const chunks = [];

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    if (firstChunkAt === null) {
      firstChunkAt = performance.now();
    }

    totalBytes += value.byteLength;
    chunks.push(value);
  }

  const completedAt = performance.now();

  if (!response.ok) {
    const errorBody = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
    throw new Error(`${params.phaseName} failed with ${response.status}: ${errorBody}`);
  }

  return {
    name: params.phaseName,
    ok: true,
    status: response.status,
    headersMs: roundMs(headersReceivedAt - startedAt),
    firstChunkMs: firstChunkAt === null ? null : roundMs(firstChunkAt - startedAt),
    fullResponseMs: roundMs(completedAt - startedAt),
    bytes: totalBytes,
    details: {
      contentType: response.headers.get("content-type"),
    },
  };
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Loads `.env` values into process.env without overwriting existing variables.
 *
 * @returns {void}
 */
function loadEnvFile() {
  if (!existsSync(ENV_FILE_PATH)) {
    return;
  }

  const envText = readFileSyncUtf8(ENV_FILE_PATH);
  const lines = envText.split("\n");

  for (const line of lines) {
    const trimmedLine = line.trim();

    if (trimmedLine === "" || trimmedLine.startsWith("#")) {
      continue;
    }

    const equalsIndex = trimmedLine.indexOf("=");

    if (equalsIndex === -1) {
      throw new Error(`Invalid .env line: ${line}`);
    }

    const key = trimmedLine.slice(0, equalsIndex).trim();
    const rawValue = trimmedLine.slice(equalsIndex + 1).trim();
    const value = stripEnvQuotes(rawValue);

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

/**
 * Reads runtime configuration from environment variables.
 *
 * @returns {object} Runtime configuration.
 */
function readConfig() {
  return {
    openRouterApiKey: readOptionalEnv("OPENROUTER_API_KEY"),
    openRouterModel: readOptionalEnv("OPENROUTER_MODEL") || DEFAULT_OPENROUTER_MODEL,
    xaiApiKey: readOptionalEnv("XAI_API_KEY"),
    xaiVoice: readOptionalEnv("XAI_VOICE") || DEFAULT_XAI_VOICE,
    xaiSampleRate: readNumberEnv("XAI_SAMPLE_RATE", DEFAULT_XAI_SAMPLE_RATE),
    greetingText: readOptionalEnv("GREETING_TEXT") || DEFAULT_GREETING_TEXT,
    runOpenRouter: readBooleanEnv("RUN_OPENROUTER", true),
    runXaiTts: readBooleanEnv("RUN_XAI_TTS", true),
    runDeepgramTts: readBooleanEnv("RUN_DEEPGRAM_TTS", false),
    deepgramApiKey: readOptionalEnv("DEEPGRAM_API_KEY"),
    deepgramModel: readOptionalEnv("DEEPGRAM_MODEL") || DEFAULT_DEEPGRAM_MODEL,
  };
}

/**
 * Validates selected tests and provider credentials.
 *
 * @param {object} config Runtime configuration.
 * @returns {void}
 */
function validateConfig(config) {
  if (!config.runOpenRouter && !config.runXaiTts && !config.runDeepgramTts) {
    throw new Error("At least one measurement must be enabled.");
  }

  if (config.runOpenRouter && !config.openRouterApiKey) {
    throw new Error("OPENROUTER_API_KEY is required when RUN_OPENROUTER=true.");
  }

  if (config.runXaiTts && !config.xaiApiKey) {
    throw new Error("XAI_API_KEY is required when RUN_XAI_TTS=true.");
  }

  if (config.runDeepgramTts && !config.deepgramApiKey) {
    throw new Error("DEEPGRAM_API_KEY is required when RUN_DEEPGRAM_TTS=true.");
  }
}

/**
 * Writes the JSON report to the output folder.
 *
 * @param {object} report Measurement report.
 * @returns {Promise<string>} Absolute report path.
 */
async function writeReport(report) {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const safeTimestamp = report.createdAt.replaceAll(":", "-").replaceAll(".", "-");
  const reportPath = path.join(OUTPUT_DIR, `startup-latency-${safeTimestamp}.json`);

  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  return reportPath;
}

/**
 * Prints a concise table for the measured phases.
 *
 * @param {object[]} phases Phase results.
 * @returns {void}
 */
function printPhaseTable(phases) {
  console.log("\nPhase                       Headers   First Chunk   Full      Bytes");
  console.log("-----------------------------------------------------------------------");

  for (const phase of phases) {
    console.log([
      phase.name.padEnd(27),
      formatMs(phase.headersMs).padStart(8),
      formatMs(phase.firstChunkMs).padStart(13),
      formatMs(phase.fullResponseMs).padStart(8),
      String(phase.bytes).padStart(10),
    ].join("  "));
  }
}

/**
 * Prints an estimated startup greeting path from measured phases.
 *
 * @param {object[]} phases Phase results.
 * @returns {void}
 */
function printStartupEstimate(phases) {
  const openRouter = phases.find((phase) => phase.name === "openrouter_chat_completion");
  const xaiTts = phases.find((phase) => phase.name === "xai_tts");
  const deepgramTts = phases.find((phase) => phase.name === "deepgram_tts");

  console.log("\nEstimated greeting path");
  console.log("-----------------------");

  if (openRouter && xaiTts) {
    console.log(`OpenRouter full response + xAI first audio chunk: ${formatMs(roundMs(openRouter.fullResponseMs + xaiTts.firstChunkMs))}`);
    console.log(`OpenRouter full response + xAI full audio:        ${formatMs(roundMs(openRouter.fullResponseMs + xaiTts.fullResponseMs))}`);
  }

  if (openRouter && deepgramTts) {
    console.log(`OpenRouter full response + Deepgram first audio: ${formatMs(roundMs(openRouter.fullResponseMs + deepgramTts.firstChunkMs))}`);
    console.log(`OpenRouter full response + Deepgram full audio:  ${formatMs(roundMs(openRouter.fullResponseMs + deepgramTts.fullResponseMs))}`);
  }

  if (!openRouter) {
    console.log("OpenRouter disabled, so this run only measures TTS provider latency.");
  }
}

/**
 * Returns a version of config safe to write in reports.
 *
 * @param {object} config Runtime configuration.
 * @returns {object} Sanitized configuration.
 */
function sanitizeConfig(config) {
  return {
    openRouterModel: config.openRouterModel,
    xaiVoice: config.xaiVoice,
    xaiSampleRate: config.xaiSampleRate,
    greetingText: config.greetingText,
    runOpenRouter: config.runOpenRouter,
    runXaiTts: config.runXaiTts,
    runDeepgramTts: config.runDeepgramTts,
    deepgramModel: config.deepgramModel,
  };
}

/**
 * Reads a file as UTF-8.
 *
 * @param {string} filePath File path to read.
 * @returns {string} File contents.
 */
function readFileSyncUtf8(filePath) {
  return existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
}

/**
 * Reads an optional environment variable.
 *
 * @param {string} name Environment variable name.
 * @returns {string} Environment value or an empty string.
 */
function readOptionalEnv(name) {
  return process.env[name]?.trim() ?? "";
}

/**
 * Reads a boolean environment variable.
 *
 * @param {string} name Environment variable name.
 * @param {boolean} defaultValue Default value when unset.
 * @returns {boolean} Parsed boolean value.
 */
function readBooleanEnv(name, defaultValue) {
  const value = readOptionalEnv(name);

  if (value === "") {
    return defaultValue;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  throw new Error(`${name} must be "true" or "false".`);
}

/**
 * Reads a numeric environment variable.
 *
 * @param {string} name Environment variable name.
 * @param {number} defaultValue Default value when unset.
 * @returns {number} Parsed number.
 */
function readNumberEnv(name, defaultValue) {
  const value = readOptionalEnv(name);

  if (value === "") {
    return defaultValue;
  }

  const parsedValue = Number(value);

  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsedValue;
}

/**
 * Removes simple wrapping quotes from an env value.
 *
 * @param {string} value Raw env value.
 * @returns {string} Unquoted value.
 */
function stripEnvQuotes(value) {
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }

  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }

  return value;
}

/**
 * Rounds a millisecond value to two decimal places.
 *
 * @param {number} value Milliseconds.
 * @returns {number} Rounded milliseconds.
 */
function roundMs(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Formats a nullable millisecond value for the terminal table.
 *
 * @param {number | null} value Milliseconds or null.
 * @returns {string} Display value.
 */
function formatMs(value) {
  if (value === null) {
    return "-";
  }

  return `${value}ms`;
}
