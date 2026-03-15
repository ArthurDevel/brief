/**
 * Minimal test: connect, skip session.update, just send audio immediately.
 */
import WebSocket from "ws";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
const MODEL = "gpt-4o-mini-realtime-preview-2024-12-17";
const URL = `wss://api.openai.com/v1/realtime?model=${MODEL}`;
const SAMPLE_RATE = 24000;

function generate1sAudio(): Buffer {
  const buf = Buffer.alloc(SAMPLE_RATE * 2);
  for (let i = 0; i < SAMPLE_RATE; i++) {
    const t = i / SAMPLE_RATE;
    const sample = Math.round(
      4000 * Math.sin(2 * Math.PI * 200 * t) +
      3000 * Math.sin(2 * Math.PI * 400 * t) +
      1000 * (Math.random() * 2 - 1)
    );
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2);
  }
  return buf;
}

const ws = new WebSocket(URL, {
  headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
});

ws.on("open", () => {
  console.log("Connected. Waiting for session.created...");
});

ws.on("message", (data) => {
  const event = JSON.parse(data.toString());

  if (event.type === "session.created") {
    console.log("session.created. Sending audio directly (no session.update)...");

    const audio = generate1sAudio();
    console.log(`Audio: ${audio.length} bytes, base64: ${audio.toString("base64").length} chars`);

    // Send in small chunks like browser would
    const chunkSize = 480 * 2; // 480 samples = 20ms
    for (let offset = 0; offset < audio.length; offset += chunkSize) {
      const chunk = audio.subarray(offset, offset + chunkSize);
      ws.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: chunk.toString("base64"),
      }));
    }
    console.log(`Sent ${Math.ceil(audio.length / chunkSize)} chunks`);

    // Try committing
    setTimeout(() => {
      console.log("Committing buffer...");
      ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    }, 200);

    // Force response
    setTimeout(() => {
      console.log("Creating response...");
      ws.send(JSON.stringify({ type: "response.create" }));
    }, 500);
  } else if (event.type === "error") {
    console.log(`ERROR: ${event.error.message} (code: ${event.error.code}, param: ${event.error.param})`);
  } else if (event.type === "input_audio_buffer.speech_started") {
    console.log(">>> SPEECH_STARTED");
  } else if (event.type === "input_audio_buffer.committed") {
    console.log(">>> BUFFER COMMITTED");
  } else if (event.type === "response.output_audio_transcript.done") {
    console.log(`>>> Transcript: "${event.transcript}"`);
    ws.close();
  } else if (event.type === "response.output_audio.done") {
    console.log(">>> Audio response done");
  } else {
    // Log all events
    console.log(`Event: ${event.type}`);
  }
});

ws.on("error", (e) => console.error("WS error:", e.message));
ws.on("close", () => { console.log("Closed"); process.exit(0); });

setTimeout(() => { console.log("TIMEOUT"); process.exit(1); }, 15000);
