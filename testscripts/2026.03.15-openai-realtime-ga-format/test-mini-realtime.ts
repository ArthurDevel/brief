/**
 * Test: why does gpt-4o-mini-realtime-preview return 0 audio chunks?
 * Log all events to see what's happening.
 */

import WebSocket from "ws";
import "dotenv/config";

const API_KEY = process.env.OPENAI_API_KEY;
if (!API_KEY) {
  console.error("Set OPENAI_API_KEY in env");
  process.exit(1);
}

const MODEL = "gpt-4o-mini-realtime-preview-2024-12-17";
const URL = `wss://api.openai.com/v1/realtime?model=${MODEL}`;

const ws = new WebSocket(URL, {
  headers: { Authorization: `Bearer ${API_KEY}` },
});

const timeout = setTimeout(() => {
  console.log("TIMEOUT after 20s");
  ws.close();
  process.exit(1);
}, 20000);

ws.on("open", () => {
  console.log("Connected\n");
  ws.send(JSON.stringify({
    type: "session.update",
    session: {
      type: "realtime",
      instructions: "Say exactly: Hello, testing.",
      output_modalities: ["audio"],
    },
  }));
});

ws.on("message", (data) => {
  const event = JSON.parse(data.toString());

  // Log every event type and key details
  if (event.type === "session.updated") {
    console.log("session.updated");
    console.log("  output_modalities:", event.session?.output_modalities);
    console.log("  output voice:", event.session?.audio?.output?.voice);
    console.log("  output format:", JSON.stringify(event.session?.audio?.output?.format));

    // Force a response
    console.log("\nSending response.create...\n");
    ws.send(JSON.stringify({ type: "response.create" }));
  } else if (event.type === "response.done") {
    console.log("response.done");
    console.log("  status:", event.response?.status);
    console.log("  output items:", event.response?.output?.length);
    if (event.response?.output) {
      for (const item of event.response.output) {
        console.log("  item type:", item.type);
        console.log("  item content:", JSON.stringify(item.content?.map((c: any) => ({
          type: c.type,
          hasAudio: !!c.audio,
          hasText: !!c.text,
          hasTranscript: !!c.transcript,
          textLength: c.text?.length,
          transcriptLength: c.transcript?.length,
        }))));
      }
    }
    console.log("  usage:", JSON.stringify(event.response?.usage));
    clearTimeout(timeout);
    ws.close();
  } else if (event.type === "error") {
    console.log("ERROR:", event.error?.message);
    clearTimeout(timeout);
    ws.close();
  } else {
    // Log all other events concisely
    console.log(event.type);
  }
});

ws.on("error", (err) => {
  console.log("WS error:", err.message);
  clearTimeout(timeout);
});
