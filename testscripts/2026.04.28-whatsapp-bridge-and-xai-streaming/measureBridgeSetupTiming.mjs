/**
 * Measures the local WebRTC setup phases used before the WhatsApp LiveKit bridge starts.
 *
 * Responsibilities:
 * - Time werift RTP source and RTCPeerConnection setup.
 * - Time SDP offer handling, answer creation, local description, and ICE gathering wait.
 * - Write a JSON report and print a concise phase summary.
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MediaStreamTrackFactory, RTCPeerConnection } from "werift";

// ============================================================================
// CONSTANTS
// ============================================================================

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const INPUT_DIR = path.join(SCRIPT_DIR, "input");
const OUTPUT_DIR = path.join(SCRIPT_DIR, "output");
const SAMPLE_OFFER_PATH = path.join(INPUT_DIR, "sample-offer.sdp");

const DEFAULT_ICE_GATHERING_TIMEOUT_MS = 3000;
const DEFAULT_CONNECTION_TIMEOUT_MS = 0;
const PRODUCTION_ICE_POLL_INTERVAL_MS = 100;
const PRODUCTION_INCOMING_TRACK_TIMEOUT_MS = 10_000;

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

await main();

/**
 * Runs the bridge setup timing script.
 *
 * @returns {Promise<void>}
 */
async function main() {
  const config = readConfig();
  const report = await measureBridgeSetup(config);
  const reportPath = await writeReport(report);

  printReport(report);
  console.log(`\nReport written to ${reportPath}`);
}

// ============================================================================
// MAIN LOGIC
// ============================================================================

/**
 * Measures the local setup sequence that production performs before starting the LiveKit bridge.
 *
 * @param {object} config Runtime configuration.
 * @param {number} config.iceGatheringTimeoutMs Maximum wait for ICE gathering.
 * @param {number} config.connectionTimeoutMs Optional production-style connection wait.
 * @returns {Promise<object>} Timing report.
 */
async function measureBridgeSetup(config) {
  await mkdir(INPUT_DIR, { recursive: true });
  await mkdir(OUTPUT_DIR, { recursive: true });

  const phases = [];
  const startedAt = performance.now();
  let peerConnection = null;
  let disposeAudioTrack = null;
  let audioPortCreated = false;

  try {
    const rtpSourceResult = await measurePhase("rtp_source_create", async () => {
      const [audioTrack, audioPort, dispose] = await MediaStreamTrackFactory.rtpSource({ kind: "audio" });
      audioPortCreated = Boolean(audioPort);
      disposeAudioTrack = dispose;
      return { audioTrack };
    });
    phases.push(rtpSourceResult.phase);

    const audioTrack = rtpSourceResult.value.audioTrack;

    const peerConnectionResult = await measurePhase("peer_connection_create", async () => {
      return new RTCPeerConnection({ iceServers: [] });
    });
    phases.push(peerConnectionResult.phase);
    peerConnection = peerConnectionResult.value;

    const addTrackResult = await measurePhase("add_outbound_audio_track", async () => {
      peerConnection.addTrack(audioTrack);
    });
    phases.push(addTrackResult.phase);

    const offerSdp = readSampleOfferSdp();
    if (!offerSdp) {
      phases.push(createSkippedPhase("set_remote_description", "input/sample-offer.sdp is missing."));
      phases.push(createSkippedPhase("create_answer", "input/sample-offer.sdp is missing."));
      phases.push(createSkippedPhase("set_local_description", "input/sample-offer.sdp is missing."));
      phases.push(createSkippedPhase("wait_for_ice_gathering", "input/sample-offer.sdp is missing."));

      return buildReport({
        startedAt,
        config,
        phases,
        audioPortCreated,
        offer: null,
        localAnswer: null,
        incomingTrack: {
          found: false,
          source: "skipped_no_offer"
        },
        notes: [
          "Place a real WhatsApp offer SDP at input/sample-offer.sdp to measure SDP and ICE phases.",
          "Without an offer, this run only proves local werift source and peer connection creation timing."
        ]
      });
    }

    const offerSummary = summarizeSdp(offerSdp);
    const incomingTrackPromise = waitForIncomingAudioTrack(peerConnection, PRODUCTION_INCOMING_TRACK_TIMEOUT_MS);

    const setRemoteDescriptionResult = await measurePhase("set_remote_description", async () => {
      await peerConnection.setRemoteDescription({ type: "offer", sdp: offerSdp });
    });
    phases.push(setRemoteDescriptionResult.phase);

    const createAnswerResult = await measurePhase("create_answer", async () => {
      return await peerConnection.createAnswer();
    });
    phases.push(createAnswerResult.phase);

    const answer = createAnswerResult.value;
    const setLocalDescriptionResult = await measurePhase("set_local_description", async () => {
      await peerConnection.setLocalDescription({ type: "answer", sdp: answer.sdp });
    });
    phases.push(setLocalDescriptionResult.phase);

    const iceGatheringResult = await measurePhase("wait_for_ice_gathering", async () => {
      const startedState = peerConnection.iceGatheringState;
      await waitForIceGathering(peerConnection, config.iceGatheringTimeoutMs);
      return {
        startedState,
        endedState: peerConnection.iceGatheringState,
        timedOut: peerConnection.iceGatheringState !== "complete"
      };
    });
    phases.push({
      ...iceGatheringResult.phase,
      details: iceGatheringResult.value
    });

    if (config.connectionTimeoutMs > 0) {
      const connectionResult = await measurePhase("wait_for_connection", async () => {
        return await waitForConnection(peerConnection, config.connectionTimeoutMs);
      });
      phases.push({
        ...connectionResult.phase,
        details: connectionResult.value
      });
    }

    return buildReport({
      startedAt,
      config,
      phases,
      audioPortCreated,
      offer: offerSummary,
      localAnswer: summarizeSdp(peerConnection.localDescription?.sdp ?? ""),
      incomingTrack: await settleIncomingTrack(incomingTrackPromise),
      notes: [
        "bridge_start_ready_after_webrtc_ms is the local werift setup time through the production ICE wait.",
        "Production also performs LiveKit room creation, WhatsApp preAccept/accept HTTP calls, and incoming track/connection waits before bridge.start()."
      ]
    });
  } finally {
    if (disposeAudioTrack) {
      disposeAudioTrack();
    }

    if (peerConnection) {
      await peerConnection.close().catch(() => undefined);
    }
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Reads script configuration from CLI flags.
 *
 * @returns {{ iceGatheringTimeoutMs: number, connectionTimeoutMs: number }} Runtime configuration.
 */
function readConfig() {
  return {
    iceGatheringTimeoutMs: readNumberFlag("--ice-timeout-ms", DEFAULT_ICE_GATHERING_TIMEOUT_MS),
    connectionTimeoutMs: readNumberFlag("--connection-timeout-ms", DEFAULT_CONNECTION_TIMEOUT_MS)
  };
}

/**
 * Reads a positive numeric CLI flag.
 *
 * @param {string} flagName CLI flag name.
 * @param {number} defaultValue Default when the flag is absent.
 * @returns {number} Parsed flag value.
 */
function readNumberFlag(flagName, defaultValue) {
  const rawValue = process.argv.find((value) => value.startsWith(`${flagName}=`));
  if (!rawValue) {
    return defaultValue;
  }

  const parsedValue = Number(rawValue.split("=")[1]);
  if (!Number.isFinite(parsedValue) || parsedValue < 0) {
    throw new Error(`${flagName} must be a non-negative number.`);
  }

  return parsedValue;
}

/**
 * Reads the sample offer SDP if it exists.
 *
 * @returns {string | null} SDP text or null when missing.
 */
function readSampleOfferSdp() {
  if (!existsSync(SAMPLE_OFFER_PATH)) {
    return null;
  }

  const sdp = readFileSync(SAMPLE_OFFER_PATH, "utf8").trim();
  if (!sdp) {
    throw new Error("input/sample-offer.sdp exists but is empty.");
  }

  return sdp;
}

/**
 * Measures one async phase.
 *
 * @param {string} name Phase name.
 * @param {() => Promise<unknown> | unknown} callback Work to measure.
 * @returns {Promise<{ phase: object, value: unknown }>} Phase result and callback return value.
 */
async function measurePhase(name, callback) {
  const startedAt = performance.now();
  const value = await callback();
  const endedAt = performance.now();

  return {
    phase: {
      name,
      status: "ok",
      elapsedMs: roundMs(endedAt - startedAt)
    },
    value
  };
}

/**
 * Builds a skipped phase object.
 *
 * @param {string} name Phase name.
 * @param {string} reason Skip reason.
 * @returns {object} Skipped phase.
 */
function createSkippedPhase(name, reason) {
  return {
    name,
    status: "skipped",
    elapsedMs: null,
    reason
  };
}

/**
 * Waits for werift ICE gathering using the same polling shape as production.
 *
 * @param {RTCPeerConnection} peerConnection Peer connection.
 * @param {number} timeoutMs Maximum wait time.
 * @returns {Promise<void>}
 */
async function waitForIceGathering(peerConnection, timeoutMs) {
  const startedAt = performance.now();

  while (peerConnection.iceGatheringState !== "complete" && performance.now() - startedAt < timeoutMs) {
    await delay(PRODUCTION_ICE_POLL_INTERVAL_MS);
  }
}

/**
 * Optionally waits for connection state using the same polling shape as production.
 *
 * @param {RTCPeerConnection} peerConnection Peer connection.
 * @param {number} timeoutMs Maximum wait time.
 * @returns {Promise<object>} Connection wait result.
 */
async function waitForConnection(peerConnection, timeoutMs) {
  const startedAt = performance.now();

  while (performance.now() - startedAt < timeoutMs) {
    if (peerConnection.connectionState === "connected") {
      return {
        endedState: peerConnection.connectionState,
        timedOut: false
      };
    }

    if (peerConnection.connectionState === "failed" || peerConnection.connectionState === "closed") {
      return {
        endedState: peerConnection.connectionState,
        timedOut: false
      };
    }

    await delay(PRODUCTION_ICE_POLL_INTERVAL_MS);
  }

  return {
    endedState: peerConnection.connectionState,
    timedOut: true
  };
}

/**
 * Waits briefly for an incoming audio track created by setRemoteDescription.
 *
 * @param {RTCPeerConnection} peerConnection Peer connection.
 * @param {number} timeoutMs Maximum wait time.
 * @returns {Promise<object>} Incoming track result.
 */
async function waitForIncomingAudioTrack(peerConnection, timeoutMs) {
  const existingTrack = peerConnection.getReceivers().find((receiver) => receiver.track.kind === "audio")?.track;
  if (existingTrack) {
    return {
      found: true,
      kind: existingTrack.kind,
      source: "existing_receiver"
    };
  }

  return await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve({
        found: false,
        kind: null,
        source: "timeout"
      });
    }, timeoutMs);

    peerConnection.onTrack.subscribe((track) => {
      if (track.kind !== "audio") {
        return;
      }

      clearTimeout(timeout);
      resolve({
        found: true,
        kind: track.kind,
        source: "on_track"
      });
    });
  });
}

/**
 * Converts an incoming-track promise into a safe report object.
 *
 * @param {Promise<object>} incomingTrackPromise Incoming track promise.
 * @returns {Promise<object>} Incoming track report.
 */
async function settleIncomingTrack(incomingTrackPromise) {
  try {
    return await incomingTrackPromise;
  } catch (error) {
    return {
      found: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Summarizes SDP content without writing the full SDP into console output.
 *
 * @param {string} sdp SDP text.
 * @returns {object | null} SDP summary.
 */
function summarizeSdp(sdp) {
  if (!sdp) {
    return null;
  }

  const lines = sdp.split(/\r?\n/);
  const mediaLines = lines.filter((line) => line.startsWith("m="));

  return {
    bytes: Buffer.byteLength(sdp),
    lines: lines.length,
    mediaLines,
    hasAudio: mediaLines.some((line) => line.startsWith("m=audio")),
    hasTrickleIce: lines.some((line) => line === "a=ice-options:trickle")
  };
}

/**
 * Builds the final JSON report.
 *
 * @param {object} params Report parameters.
 * @returns {object} JSON-safe report.
 */
function buildReport(params) {
  const totalElapsedMs = roundMs(performance.now() - params.startedAt);
  const bridgeReadyPhaseNames = [
    "rtp_source_create",
    "peer_connection_create",
    "add_outbound_audio_track",
    "set_remote_description",
    "create_answer",
    "set_local_description",
    "wait_for_ice_gathering"
  ];

  return {
    createdAt: new Date().toISOString(),
    config: params.config,
    productionReference: {
      iceGatheringTimeoutMs: DEFAULT_ICE_GATHERING_TIMEOUT_MS,
      icePollIntervalMs: PRODUCTION_ICE_POLL_INTERVAL_MS,
      connectionWaitBeforeBridgeStartMs: 8000,
      sequence:
        "rtpSource -> RTCPeerConnection -> create LiveKit room -> addTrack -> setRemoteDescription -> createAnswer -> setLocalDescription -> waitForIceGathering -> preAccept/accept -> waitForConnection -> waitForIncomingAudioTrack -> bridge.start"
    },
    audioPortCreated: params.audioPortCreated,
    offer: params.offer,
    localAnswer: params.localAnswer,
    incomingTrack: params.incomingTrack,
    phases: params.phases,
    summary: {
      totalElapsedMs,
      bridgeStartReadyAfterWebrtcMs: sumPhaseElapsedMs(params.phases, bridgeReadyPhaseNames),
      iceGatheringElapsedMs: findPhaseElapsedMs(params.phases, "wait_for_ice_gathering")
    },
    notes: params.notes
  };
}

/**
 * Writes the JSON report to the output folder.
 *
 * @param {object} report JSON report.
 * @returns {Promise<string>} Written file path.
 */
async function writeReport(report) {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const reportPath = path.join(OUTPUT_DIR, `bridge-setup-timing-${timestamp}.json`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  return reportPath;
}

/**
 * Prints a concise human-readable report.
 *
 * @param {object} report Timing report.
 * @returns {void}
 */
function printReport(report) {
  console.log("WhatsApp bridge setup timing");
  console.log("");

  for (const phase of report.phases) {
    if (phase.status === "skipped") {
      console.log(`${phase.name.padEnd(28)} skipped  ${phase.reason}`);
      continue;
    }

    const details = phase.details ? `  ${JSON.stringify(phase.details)}` : "";
    console.log(`${phase.name.padEnd(28)} ${String(phase.elapsedMs).padStart(8)}ms${details}`);
  }

  console.log("");
  console.log(`bridge_start_ready_after_webrtc_ms: ${report.summary.bridgeStartReadyAfterWebrtcMs}`);
  console.log(`ice_gathering_elapsed_ms:          ${report.summary.iceGatheringElapsedMs}`);

  if (!report.offer) {
    console.log("");
    console.log("No input/sample-offer.sdp found.");
    console.log("To measure SDP handling, capture a real WhatsApp call offer SDP and save only the SDP text at:");
    console.log(SAMPLE_OFFER_PATH);
  }
}

/**
 * Adds elapsed times for selected phases.
 *
 * @param {object[]} phases Measured phases.
 * @param {string[]} phaseNames Names to include.
 * @returns {number | null} Sum or null when any selected phase is missing/skipped.
 */
function sumPhaseElapsedMs(phases, phaseNames) {
  let total = 0;

  for (const phaseName of phaseNames) {
    const elapsedMs = findPhaseElapsedMs(phases, phaseName);
    if (elapsedMs === null) {
      return null;
    }

    total += elapsedMs;
  }

  return roundMs(total);
}

/**
 * Finds one phase elapsed time.
 *
 * @param {object[]} phases Measured phases.
 * @param {string} phaseName Phase name.
 * @returns {number | null} Elapsed milliseconds.
 */
function findPhaseElapsedMs(phases, phaseName) {
  const phase = phases.find((item) => item.name === phaseName);
  if (!phase || typeof phase.elapsedMs !== "number") {
    return null;
  }

  return phase.elapsedMs;
}

/**
 * Waits for the requested duration.
 *
 * @param {number} ms Milliseconds.
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Rounds a millisecond value for stable report output.
 *
 * @param {number} value Millisecond value.
 * @returns {number} Rounded value.
 */
function roundMs(value) {
  return Math.round(value * 100) / 100;
}
