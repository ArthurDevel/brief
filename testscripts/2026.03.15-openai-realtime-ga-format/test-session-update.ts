/**
 * Test script to discover the correct session.update format
 * for gpt-4o-mini-realtime-preview via WebSocket.
 *
 * Run: npx tsx testscripts/2026.03.15-openai-realtime-ga-format/test-session-update.ts
 */

import WebSocket from "ws";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error("Set OPENAI_API_KEY env var");
  process.exit(1);
}

const MODEL = "gpt-4o-mini-realtime-preview-2024-12-17";
const URL = `wss://api.openai.com/v1/realtime?model=${MODEL}`;

async function testConfig(label: string, sessionConfig: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL, {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    });

    const timeout = setTimeout(() => {
      console.log(`[${label}] Timeout - no response`);
      ws.close();
      resolve();
    }, 5000);

    ws.on("open", () => {
      console.log(`\n[${label}] Connected, sending session.update...`);
      ws.send(JSON.stringify({
        type: "session.update",
        session: sessionConfig,
      }));
    });

    ws.on("message", (data) => {
      const event = JSON.parse(data.toString());
      if (event.type === "error") {
        console.log(`[${label}] ERROR: ${event.error.message} (param: ${event.error.param})`);
      } else if (event.type === "session.updated") {
        console.log(`[${label}] SUCCESS! Full session config:`);
        console.log(JSON.stringify(event.session, null, 2));
        clearTimeout(timeout);
        ws.close();
        resolve();
      } else if (event.type === "session.created") {
        console.log(`[${label}] session.created - default config:`);
        console.log(JSON.stringify(event.session, null, 2));
      }
    });

    ws.on("error", (err) => {
      console.log(`[${label}] WS error: ${err.message}`);
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function main() {
  // Test 1: Minimal - just see what the default session looks like
  await testConfig("test1-minimal", {
    type: "realtime",
    instructions: "Say hello.",
  });

  // Test 2: With tools only
  await testConfig("test2-tools", {
    type: "realtime",
    instructions: "Say hello.",
    tools: [{
      type: "function",
      name: "test_tool",
      description: "A test tool",
      parameters: { type: "object", properties: {} },
    }],
  });
}

main().then(() => {
  console.log("\nDone.");
  process.exit(0);
});
