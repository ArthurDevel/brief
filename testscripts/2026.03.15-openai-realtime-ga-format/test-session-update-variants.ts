/**
 * Test which session.update fields break audio buffering.
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

async function testVariant(label: string, sessionConfig: Record<string, unknown>): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL, {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    });

    let gotSpeechStarted = false;
    let gotUpdated = false;

    const timeout = setTimeout(() => {
      console.log(`  [${label}] TIMEOUT - speech_started: ${gotSpeechStarted}`);
      ws.close();
      resolve(gotSpeechStarted);
    }, 10000);

    ws.on("message", (data) => {
      const event = JSON.parse(data.toString());

      if (event.type === "session.created") {
        // Send session.update
        ws.send(JSON.stringify({ type: "session.update", session: sessionConfig }));
      } else if (event.type === "session.updated") {
        gotUpdated = true;
        // Now send audio
        const audio = generate1sAudio();
        const chunkSize = 480 * 2;
        for (let offset = 0; offset < audio.length; offset += chunkSize) {
          ws.send(JSON.stringify({
            type: "input_audio_buffer.append",
            audio: audio.subarray(offset, offset + chunkSize).toString("base64"),
          }));
        }
      } else if (event.type === "error") {
        console.log(`  [${label}] ERROR: ${event.error.message}`);
        if (!gotUpdated) {
          // session.update failed, skip
          clearTimeout(timeout);
          ws.close();
          resolve(false);
        }
      } else if (event.type === "input_audio_buffer.speech_started") {
        gotSpeechStarted = true;
        console.log(`  [${label}] SPEECH_STARTED!`);
        clearTimeout(timeout);
        ws.close();
        resolve(true);
      }
    });

    ws.on("error", () => resolve(false));
    ws.on("close", () => {});
  });
}

async function main() {
  const tests: [string, Record<string, unknown>][] = [
    ["no-type", { instructions: "Say hello." }],
    ["with-type", { type: "realtime", instructions: "Say hello." }],
    ["with-tools", { instructions: "Say hello.", tools: [{ type: "function", name: "test", description: "test", parameters: { type: "object", properties: {} } }] }],
    ["type+tools", { type: "realtime", instructions: "Say hello.", tools: [{ type: "function", name: "test", description: "test", parameters: { type: "object", properties: {} } }] }],
  ];

  for (const [label, config] of tests) {
    console.log(`Testing: ${label}`);
    const result = await testVariant(label, config);
    console.log(`  Result: ${result ? "PASS" : "FAIL"}\n`);
  }
}

main().then(() => process.exit(0));
