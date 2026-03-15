/**
 * Test script: send a sine wave to OpenAI Realtime API and verify
 * we get speech_started + audio back.
 *
 * Run: export $(grep OPENAI_API_KEY apps/voice-gateway/.env) && \
 *      npx tsx testscripts/2026.03.15-openai-realtime-ga-format/test-audio-roundtrip.ts
 */

import WebSocket from "ws";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error("Set OPENAI_API_KEY env var");
  process.exit(1);
}

const MODEL = "gpt-4o-mini-realtime-preview-2024-12-17";
const URL = `wss://api.openai.com/v1/realtime?model=${MODEL}`;

const SAMPLE_RATE = 24000;
const DURATION_MS = 3000; // 3 seconds of audio
const CHUNK_MS = 20; // 20ms chunks (like browser would send)
const SAMPLES_PER_CHUNK = (SAMPLE_RATE * CHUNK_MS) / 1000; // 480 samples

/**
 * Generate a PCM16 sine wave chunk (simulates speech-like audio).
 * Uses 440Hz tone at moderate amplitude.
 */
function generateSineChunk(chunkIndex: number): Buffer {
  const buf = Buffer.alloc(SAMPLES_PER_CHUNK * 2); // 2 bytes per sample
  const freq = 440;
  const amplitude = 8000; // moderate amplitude
  for (let i = 0; i < SAMPLES_PER_CHUNK; i++) {
    const t = (chunkIndex * SAMPLES_PER_CHUNK + i) / SAMPLE_RATE;
    const sample = Math.round(amplitude * Math.sin(2 * Math.PI * freq * t));
    buf.writeInt16LE(sample, i * 2);
  }
  return buf;
}

async function main(): Promise<void> {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL, {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    });

    let sessionReady = false;
    let audioChunksSent = 0;
    let audioChunksReceived = 0;
    let sendInterval: NodeJS.Timeout | null = null;
    const eventsReceived: string[] = [];

    const timeout = setTimeout(() => {
      console.log("\n--- TIMEOUT after 15s ---");
      console.log(`Audio chunks sent: ${audioChunksSent}`);
      console.log(`Audio chunks received: ${audioChunksReceived}`);
      console.log(`Events received: ${[...new Set(eventsReceived)].join(", ")}`);
      ws.close();
      resolve();
    }, 15000);

    ws.on("open", () => {
      console.log("Connected to OpenAI Realtime API");

      // Send session.update with just instructions
      ws.send(JSON.stringify({
        type: "session.update",
        session: {
          type: "realtime",
          instructions: "You are a test assistant. Just say hello back when you hear audio.",
          tools: [],
        },
      }));
    });

    ws.on("message", (data) => {
      const event = JSON.parse(data.toString());
      eventsReceived.push(event.type);

      switch (event.type) {
        case "session.created":
          console.log("session.created received");
          break;

        case "session.updated":
          console.log("session.updated received - starting audio stream");
          sessionReady = true;

          // Send one big chunk of 1 second of audio
          const totalSamples = SAMPLE_RATE; // 1 second
          const bigBuf = Buffer.alloc(totalSamples * 2);
          for (let i = 0; i < totalSamples; i++) {
            const t = i / SAMPLE_RATE;
            // Mix multiple frequencies to sound more speech-like
            const sample = Math.round(
              4000 * Math.sin(2 * Math.PI * 200 * t) +
              3000 * Math.sin(2 * Math.PI * 400 * t) +
              2000 * Math.sin(2 * Math.PI * 800 * t) +
              1000 * Math.random() * 2 - 500 // noise
            );
            bigBuf.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2);
          }
          const base64 = bigBuf.toString("base64");
          console.log(`Sending 1s of audio: ${base64.length} chars base64, ${totalSamples} samples, ${bigBuf.length} bytes`);

          ws.send(JSON.stringify({
            type: "input_audio_buffer.append",
            audio: base64,
          }));
          audioChunksSent = 1;

          console.log("Committing buffer...");
          ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));

          setTimeout(() => {
            console.log("Creating response...");
            ws.send(JSON.stringify({ type: "response.create" }));
          }, 500);
          break;

        case "error":
          console.log(`ERROR: ${event.error.message} (param: ${event.error.param})`);
          break;

        case "input_audio_buffer.speech_started":
          console.log(">>> SPEECH STARTED detected!");
          break;

        case "input_audio_buffer.speech_stopped":
          console.log(">>> SPEECH STOPPED detected!");
          break;

        case "input_audio_buffer.committed":
          console.log(">>> Audio buffer committed");
          break;

        case "response.audio.delta":
          audioChunksReceived++;
          if (audioChunksReceived === 1) {
            console.log(">>> First audio response received!");
          }
          break;

        case "response.audio.done":
          console.log(`>>> Audio response complete (${audioChunksReceived} chunks received)`);
          break;

        case "response.audio_transcript.delta":
        case "response.output_audio_transcript.delta":
          if (event.delta) {
            process.stdout.write(event.delta);
          }
          break;

        case "response.audio_transcript.done":
        case "response.output_audio_transcript.done":
          console.log(`\n>>> Transcript: "${event.transcript}"`);
          clearTimeout(timeout);
          setTimeout(() => {
            ws.close();
            resolve();
          }, 1000);
          break;

        case "conversation.item.added":
        case "conversation.item.done":
        case "response.created":
        case "response.output_item.added":
        case "response.content_part.added":
        case "response.done":
        case "response.output_item.done":
        case "response.content_part.done":
          // Expected events, don't log individually
          break;

        default:
          console.log(`Event: ${event.type}`);
          break;
      }
    });

    ws.on("error", (err) => {
      console.error(`WebSocket error: ${err.message}`);
      clearTimeout(timeout);
      resolve();
    });

    ws.on("close", () => {
      if (sendInterval) clearInterval(sendInterval);
      console.log("\nConnection closed.");
    });
  });
}

main().then(() => {
  console.log("\n--- Test complete ---");
  process.exit(0);
});
