/**
 * Express + WebSocket server for the voice email assistant prototype.
 *
 * Serves the static frontend and upgrades browser connections to WebSocket.
 * Each browser connection gets its own OpenAI Realtime relay.
 *
 * Responsibilities:
 * - Serves public/ as static files
 * - Upgrades HTTP to WebSocket for browser audio connections
 * - Creates an OpenAI relay per browser connection
 * - Forwards audio between browser and relay
 * - Cleans up on disconnect
 */

import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { createOpenAIRelay } from "./openai-relay.js";

const PORT = 3000;

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey || apiKey === "your-api-key-here") {
  throw new Error("OPENAI_API_KEY is not set in .env");
}

const app = express();
app.use(express.static("public"));

const server = createServer(app);
const wss = new WebSocketServer({ server });

wss.on("connection", (browserWs) => {
  console.log("[server] Browser connected");

  const relay = createOpenAIRelay(
    apiKey,
    (event) => {
      if (browserWs.readyState === WebSocket.OPEN) {
        browserWs.send(event);
      }
    },
    () => {
      if (browserWs.readyState === WebSocket.OPEN) {
        browserWs.close();
      }
    }
  );

  browserWs.on("message", (data) => {
    relay.send(data.toString());
  });

  browserWs.on("close", () => {
    console.log("[server] Browser disconnected");
    relay.close();
  });

  browserWs.on("error", (err) => {
    console.error("[server] Browser WebSocket error:", err.message);
    relay.close();
  });
});

server.listen(PORT, () => {
  console.log(`[server] Voice email assistant running at http://localhost:${PORT}`);
});
