/**
 * Measures whether xAI's HTTP TTS endpoint delivers audio bytes incrementally.
 *
 * Responsibilities:
 * - Reads XAI_API_KEY from process.env or a local .env file
 * - Calls POST https://api.x.ai/v1/tts with PCM output
 * - Measures response headers, first streamed chunk, full body, and byte counts
 * - Optionally compares stream-reader timing with arrayBuffer-style buffering
 * - Writes a JSON report under output/
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

// ============================================================================
// CONSTANTS
// ============================================================================

const TTS_URL = "https://api.x.ai/v1/tts";
const ENV_FILE_PATH = ".env";
const OUTPUT_FOLDER_PATH = "output";
const DEFAULT_MODE = "both";
const DEFAULT_TEXT =
  "This is a short xAI text to speech streaming timing check. It has enough words to make chunk timing observable.";
const DEFAULT_VOICE_ID = "eve";
const DEFAULT_LANGUAGE = "en";
const DEFAULT_SAMPLE_RATE = 24000;
const DEFAULT_OPTIMIZE_STREAMING_LATENCY = 1;

// ============================================================================
// ENTRY POINT
// ============================================================================

/**
 * Runs the timing investigation and writes the JSON report.
 *
 * @returns {Promise<void>}
 */
async function main() {
  const options = parseCommandLineOptions(process.argv.slice(2));
  const localEnv = readLocalEnvFile(ENV_FILE_PATH);
  const env = {
    ...localEnv,
    XAI_API_KEY: process.env.XAI_API_KEY || localEnv.XAI_API_KEY,
  };
  const apiKey = getRequiredEnvValue(env, "XAI_API_KEY");

  mkdirSync(OUTPUT_FOLDER_PATH, { recursive: true });

  const requestBody = buildRequestBody(options);
  const report = {
    script: "xai-tts-http-streaming",
    createdAt: new Date().toISOString(),
    endpoint: TTS_URL,
    mode: options.mode,
    request: redactRequestForReport(requestBody),
    results: {},
    comparison: null,
    interpretation: null,
  };

  if (options.mode === "stream" || options.mode === "both") {
    report.results.stream = await measureReaderStreaming(apiKey, requestBody);
  }

  if (options.mode === "buffered" || options.mode === "both") {
    report.results.buffered = await measureArrayBufferStyle(apiKey, requestBody);
  }

  report.comparison = buildComparison(report.results);
  report.interpretation = buildInterpretation(report.results, report.comparison);

  const outputPath = writeReport(report);
  printSummary(report, outputPath);
}

// ============================================================================
// MEASUREMENT LOGIC
// ============================================================================

/**
 * Reads the response body through response.body.getReader().
 *
 * @param {string} apiKey - xAI API key.
 * @param {Record<string, unknown>} requestBody - JSON request body sent to xAI.
 * @returns {Promise<Record<string, unknown>>} Streaming timing result.
 */
async function measureReaderStreaming(apiKey, requestBody) {
  const startedAtMs = performance.now();
  const response = await postTtsRequest(apiKey, requestBody);
  const headersReceivedAtMs = performance.now();
  const responseMetadata = buildResponseMetadata(response, startedAtMs, headersReceivedAtMs);

  if (!response.ok) {
    return await buildFailedResponseResult(response, responseMetadata, startedAtMs);
  }

  if (!response.body) {
    throw new Error("xAI TTS response did not include a readable body.");
  }

  const reader = response.body.getReader();
  const chunkEvents = [];
  let totalBytes = 0;
  let firstChunkAtMs = null;

  while (true) {
    const readResult = await reader.read();

    if (readResult.done) {
      break;
    }

    const chunk = readResult.value;
    if (!chunk) {
      throw new Error("ReadableStream returned an empty chunk value.");
    }

    const nowMs = performance.now();
    totalBytes += chunk.byteLength;

    if (firstChunkAtMs === null) {
      firstChunkAtMs = nowMs;
    }

    chunkEvents.push({
      index: chunkEvents.length + 1,
      elapsedMs: roundMs(nowMs - startedAtMs),
      bytes: chunk.byteLength,
      cumulativeBytes: totalBytes,
    });
  }

  const completedAtMs = performance.now();

  return {
    mode: "stream",
    ok: true,
    ...responseMetadata,
    firstChunkElapsedMs: firstChunkAtMs === null ? null : roundMs(firstChunkAtMs - startedAtMs),
    fullBodyElapsedMs: roundMs(completedAtMs - startedAtMs),
    firstChunkEarlierThanFullBodyMs:
      firstChunkAtMs === null ? null : roundMs(completedAtMs - firstChunkAtMs),
    byteCount: totalBytes,
    chunkCount: chunkEvents.length,
    firstChunkBytes: chunkEvents.length === 0 ? 0 : chunkEvents[0].bytes,
    streamedMultipleChunks: chunkEvents.length > 1,
    chunkEvents,
  };
}

/**
 * Reads the response body using arrayBuffer(), matching buffered production behavior.
 *
 * @param {string} apiKey - xAI API key.
 * @param {Record<string, unknown>} requestBody - JSON request body sent to xAI.
 * @returns {Promise<Record<string, unknown>>} Buffered timing result.
 */
async function measureArrayBufferStyle(apiKey, requestBody) {
  const startedAtMs = performance.now();
  const response = await postTtsRequest(apiKey, requestBody);
  const headersReceivedAtMs = performance.now();
  const responseMetadata = buildResponseMetadata(response, startedAtMs, headersReceivedAtMs);

  if (!response.ok) {
    return await buildFailedResponseResult(response, responseMetadata, startedAtMs);
  }

  const buffer = await response.arrayBuffer();
  const completedAtMs = performance.now();

  return {
    mode: "buffered",
    ok: true,
    ...responseMetadata,
    firstUsableAudioElapsedMs: roundMs(completedAtMs - startedAtMs),
    fullBodyElapsedMs: roundMs(completedAtMs - startedAtMs),
    byteCount: buffer.byteLength,
    note: "arrayBuffer() exposes audio only after the full response body has been buffered.",
  };
}

/**
 * Sends the xAI TTS POST request.
 *
 * @param {string} apiKey - xAI API key.
 * @param {Record<string, unknown>} requestBody - JSON request body sent to xAI.
 * @returns {Promise<Response>} Fetch response.
 */
async function postTtsRequest(apiKey, requestBody) {
  return await fetch(TTS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "audio/pcm, application/octet-stream, */*",
    },
    body: JSON.stringify(requestBody),
  });
}

// ============================================================================
// REPORTING
// ============================================================================

/**
 * Builds a concise comparison between streaming and buffered modes.
 *
 * @param {Record<string, unknown>} results - Measurement results by mode.
 * @returns {Record<string, unknown> | null} Comparison summary.
 */
function buildComparison(results) {
  if (!results.stream || !results.buffered) {
    return null;
  }

  if (!results.stream.ok || !results.buffered.ok) {
    return {
      comparable: false,
      reason: "At least one request failed. Compare error details before drawing timing conclusions.",
    };
  }

  return {
    comparable: true,
    streamedFirstChunkElapsedMs: results.stream.firstChunkElapsedMs,
    streamedFullBodyElapsedMs: results.stream.fullBodyElapsedMs,
    bufferedFirstUsableAudioElapsedMs: results.buffered.firstUsableAudioElapsedMs,
    streamedFirstChunkEarlierThanStreamedFullBodyMs:
      results.stream.firstChunkEarlierThanFullBodyMs,
    streamedFirstChunkEarlierThanBufferedUsableAudioMs: roundMs(
      results.buffered.firstUsableAudioElapsedMs - results.stream.firstChunkElapsedMs
    ),
    streamedMultipleChunks: results.stream.streamedMultipleChunks,
    streamedChunkCount: results.stream.chunkCount,
  };
}

/**
 * Builds a plain-English interpretation of the measured result.
 *
 * @param {Record<string, unknown>} results - Measurement results by mode.
 * @param {Record<string, unknown> | null} comparison - Optional mode comparison.
 * @returns {string} Interpretation text.
 */
function buildInterpretation(results, comparison) {
  if (results.stream && !results.stream.ok) {
    return "The streaming reader request failed. The HTTP response details show whether xAI rejected the payload or returned another error.";
  }

  if (!results.stream) {
    return "Buffered mode does not prove whether the server streams chunks because arrayBuffer() hides chunk timing.";
  }

  if (results.stream.chunkCount <= 1) {
    return "The HTTP response was not observably chunked in this run. A reader did not expose audio earlier than the full body.";
  }

  if (comparison?.comparable) {
    return `The HTTP response was observably chunked. The first streamed chunk arrived ${comparison.streamedFirstChunkEarlierThanStreamedFullBodyMs} ms before the streamed full body completed.`;
  }

  return `The HTTP response was observably chunked. The first streamed chunk arrived ${results.stream.firstChunkEarlierThanFullBodyMs} ms before the full body completed.`;
}

/**
 * Writes the JSON report to the output folder.
 *
 * @param {Record<string, unknown>} report - Full measurement report.
 * @returns {string} Output file path.
 */
function writeReport(report) {
  const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const outputPath = join(OUTPUT_FOLDER_PATH, `xai-tts-http-streaming-${timestamp}.json`);
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return outputPath;
}

/**
 * Prints the important timing values to stdout.
 *
 * @param {Record<string, unknown>} report - Full measurement report.
 * @param {string} outputPath - JSON output path.
 * @returns {void}
 */
function printSummary(report, outputPath) {
  console.log(`Wrote ${outputPath}`);
  console.log(report.interpretation);

  if (report.results.stream?.ok) {
    console.log(
      `stream: headers=${report.results.stream.headersElapsedMs}ms firstChunk=${report.results.stream.firstChunkElapsedMs}ms fullBody=${report.results.stream.fullBodyElapsedMs}ms chunks=${report.results.stream.chunkCount} bytes=${report.results.stream.byteCount}`
    );
  }

  if (report.results.buffered?.ok) {
    console.log(
      `buffered: headers=${report.results.buffered.headersElapsedMs}ms usableAudio=${report.results.buffered.firstUsableAudioElapsedMs}ms bytes=${report.results.buffered.byteCount}`
    );
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Parses supported command-line options.
 *
 * @param {string[]} args - Command-line arguments after the script name.
 * @returns {{mode: string, text: string, voiceId: string, language: string, sampleRate: number, optimizeStreamingLatency: number, includeStreamFlag: boolean}} Parsed options.
 */
function parseCommandLineOptions(args) {
  const options = {
    mode: DEFAULT_MODE,
    text: DEFAULT_TEXT,
    voiceId: DEFAULT_VOICE_ID,
    language: DEFAULT_LANGUAGE,
    sampleRate: DEFAULT_SAMPLE_RATE,
    optimizeStreamingLatency: DEFAULT_OPTIMIZE_STREAMING_LATENCY,
    includeStreamFlag: true,
  };

  for (const arg of args.filter((value) => value !== "--")) {
    if (arg === "--help") {
      printHelpAndExit();
    }

    if (arg === "--no-stream-flag") {
      options.includeStreamFlag = false;
      continue;
    }

    const [name, value] = splitOption(arg);

    if (name === "--mode") {
      options.mode = value;
      continue;
    }

    if (name === "--text") {
      options.text = value;
      continue;
    }

    if (name === "--voice") {
      options.voiceId = value;
      continue;
    }

    if (name === "--language") {
      options.language = value;
      continue;
    }

    if (name === "--sample-rate") {
      options.sampleRate = parseIntegerOption(name, value);
      continue;
    }

    if (name === "--optimize-streaming-latency") {
      options.optimizeStreamingLatency = parseIntegerOption(name, value);
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  validateOptions(options);
  return options;
}

/**
 * Builds the xAI TTS request body.
 *
 * @param {{text: string, voiceId: string, language: string, sampleRate: number, optimizeStreamingLatency: number, includeStreamFlag: boolean}} options - Runtime options.
 * @returns {Record<string, unknown>} xAI request body.
 */
function buildRequestBody(options) {
  const requestBody = {
    text: options.text,
    voice_id: options.voiceId,
    language: options.language,
    output_format: {
      codec: "pcm",
      sample_rate: options.sampleRate,
    },
    optimize_streaming_latency: options.optimizeStreamingLatency,
  };

  if (options.includeStreamFlag) {
    requestBody.stream = true;
  }

  return requestBody;
}

/**
 * Reads a local .env file into key-value pairs.
 *
 * @param {string} envFilePath - Path to the local .env file.
 * @returns {Record<string, string>} Parsed environment values.
 */
function readLocalEnvFile(envFilePath) {
  if (!existsSync(envFilePath)) {
    throw new Error(`Missing ${envFilePath}. Create it from .env.example and set XAI_API_KEY.`);
  }

  const envText = readFileSync(envFilePath, "utf8");
  const env = {};

  for (const line of envText.split(/\r?\n/)) {
    const trimmedLine = line.trim();

    if (!trimmedLine || trimmedLine.startsWith("#")) {
      continue;
    }

    const equalsIndex = trimmedLine.indexOf("=");
    if (equalsIndex === -1) {
      throw new Error(`Invalid .env line: ${line}`);
    }

    const key = trimmedLine.slice(0, equalsIndex).trim();
    const value = trimmedLine.slice(equalsIndex + 1).trim();
    env[key] = stripMatchingQuotes(value);
  }

  return env;
}

/**
 * Gets a required environment value.
 *
 * @param {Record<string, string>} env - Parsed environment values.
 * @param {string} key - Required key name.
 * @returns {string} Required value.
 */
function getRequiredEnvValue(env, key) {
  const value = env[key];

  if (!value) {
    throw new Error(`Missing required ${key} in ${ENV_FILE_PATH}.`);
  }

  return value;
}

/**
 * Builds response metadata that is useful for streaming diagnostics.
 *
 * @param {Response} response - Fetch response.
 * @param {number} startedAtMs - Request start timestamp from performance.now().
 * @param {number} headersReceivedAtMs - Headers received timestamp from performance.now().
 * @returns {Record<string, unknown>} Response metadata.
 */
function buildResponseMetadata(response, startedAtMs, headersReceivedAtMs) {
  return {
    status: response.status,
    statusText: response.statusText,
    headersElapsedMs: roundMs(headersReceivedAtMs - startedAtMs),
    headers: Object.fromEntries(response.headers.entries()),
    contentType: response.headers.get("content-type"),
    contentLength: response.headers.get("content-length"),
    transferEncoding: response.headers.get("transfer-encoding"),
  };
}

/**
 * Builds a failed response result and includes a short error body.
 *
 * @param {Response} response - Fetch response.
 * @param {Record<string, unknown>} responseMetadata - Response metadata.
 * @param {number} startedAtMs - Request start timestamp from performance.now().
 * @returns {Promise<Record<string, unknown>>} Failed result.
 */
async function buildFailedResponseResult(response, responseMetadata, startedAtMs) {
  const errorText = await response.text();
  const completedAtMs = performance.now();

  return {
    ok: false,
    ...responseMetadata,
    fullBodyElapsedMs: roundMs(completedAtMs - startedAtMs),
    errorBody: errorText.slice(0, 2000),
  };
}

/**
 * Redacts fields that should not be written to reports.
 *
 * @param {Record<string, unknown>} requestBody - Request body.
 * @returns {Record<string, unknown>} Redacted request body.
 */
function redactRequestForReport(requestBody) {
  return {
    voice_id: requestBody.voice_id,
    language: requestBody.language,
    output_format: requestBody.output_format,
    optimize_streaming_latency: requestBody.optimize_streaming_latency,
    stream: requestBody.stream,
    textCharacterCount: String(requestBody.text).length,
    textPreview: `${String(requestBody.text).slice(0, 80)}...`,
  };
}

/**
 * Splits a --name=value option.
 *
 * @param {string} arg - Raw command-line option.
 * @returns {[string, string]} Option name and value.
 */
function splitOption(arg) {
  const equalsIndex = arg.indexOf("=");

  if (!arg.startsWith("--") || equalsIndex === -1) {
    throw new Error(`Expected --name=value option, got: ${arg}`);
  }

  return [arg.slice(0, equalsIndex), arg.slice(equalsIndex + 1)];
}

/**
 * Parses an integer command-line option.
 *
 * @param {string} name - Option name.
 * @param {string} value - Option value.
 * @returns {number} Parsed integer.
 */
function parseIntegerOption(name, value) {
  const parsedValue = Number.parseInt(value, 10);

  if (!Number.isInteger(parsedValue)) {
    throw new Error(`${name} must be an integer.`);
  }

  return parsedValue;
}

/**
 * Validates command-line options.
 *
 * @param {{mode: string, text: string, sampleRate: number, optimizeStreamingLatency: number}} options - Runtime options.
 * @returns {void}
 */
function validateOptions(options) {
  if (!["stream", "buffered", "both"].includes(options.mode)) {
    throw new Error("--mode must be one of: stream, buffered, both.");
  }

  if (!options.text.trim()) {
    throw new Error("--text must not be empty.");
  }

  if (![8000, 16000, 22050, 24000, 44100, 48000].includes(options.sampleRate)) {
    throw new Error("--sample-rate must be one of: 8000, 16000, 22050, 24000, 44100, 48000.");
  }

  if (![0, 1].includes(options.optimizeStreamingLatency)) {
    throw new Error("--optimize-streaming-latency must be 0 or 1.");
  }
}

/**
 * Removes matching single or double quotes around a value.
 *
 * @param {string} value - Raw .env value.
 * @returns {string} Unquoted value.
 */
function stripMatchingQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

/**
 * Rounds a duration to one decimal place.
 *
 * @param {number} value - Millisecond duration.
 * @returns {number} Rounded duration.
 */
function roundMs(value) {
  return Math.round(value * 10) / 10;
}

/**
 * Prints CLI help and exits.
 *
 * @returns {never}
 */
function printHelpAndExit() {
  console.log(`Usage: node xai-tts-http-streaming.mjs [options]

Options:
  --mode=both|stream|buffered
  --text="Text to synthesize"
  --voice=eve|ara|rex|sal|leo
  --language=en
  --sample-rate=24000
  --optimize-streaming-latency=0|1
  --no-stream-flag

Default behavior includes stream: true in the POST body to mirror the production question.`);
  process.exit(0);
}

await main();
