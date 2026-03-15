/**
 * Express + WebSocket server for the voice email assistant.
 *
 * Handles Twilio voice webhooks for caller authentication and starts
 * bidirectional media streams over WebSocket for real-time voice AI.
 * Each media stream connection opens an IMAP connection, creates a
 * session, and relays audio between Twilio and OpenAI.
 *
 * Responsibilities:
 * - Twilio webhook endpoints for incoming calls and PIN verification
 * - WebSocket handling for Twilio media streams at /media-stream
 * - IMAP connection lifecycle: open on call start, close on disconnect
 * - Session lifecycle: start on connect, end on disconnect
 * - Forward audio between Twilio and OpenAI relay
 */

import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "http";
import { createClient } from "@supabase/supabase-js";
import { createImapConnection, closeImapConnection } from "@dublin/email";
import { createOpenAIRelay } from "./openai-relay.js";
import type { RelayConfig } from "./openai-relay.js";
import { createServiceClient } from "./supabase.js";
import { handleIncomingCall, handleVerifyPin } from "./twilio-handler.js";
import { startSession, endSession, loadUserContext } from "./session-manager.js";

// ============================================================================
// CONSTANTS
// ============================================================================

const PORT = parseInt(process.env.PORT ?? "3000", 10);

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey || apiKey === "your-api-key-here") {
  throw new Error("OPENAI_API_KEY is not set in .env");
}

const supabase = createServiceClient();

// Derive the WebSocket URL for Twilio media streams from PUBLIC_URL
const publicUrl = process.env.PUBLIC_URL ?? `http://localhost:${PORT}`;
const streamBaseUrl = publicUrl.replace(/^http/, "ws");

const app = express();

// Parse Twilio form POST bodies
app.use(express.urlencoded({ extended: false }));

// Twilio webhook routes
app.post("/twilio/voice", handleIncomingCall(supabase));
app.post("/twilio/verify-pin", handleVerifyPin(supabase, streamBaseUrl));

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

const server = createServer(app);

// WebSocket servers (noServer mode -- upgrades routed manually below)
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", async (ws: WebSocket, req: IncomingMessage) => {
  // Extract userId from query params
  const url = new URL(req.url ?? "", `http://${req.headers.host}`);
  const userId = url.searchParams.get("userId");

  if (!userId) {
    console.error("[server] Media stream connection missing userId param");
    ws.close();
    return;
  }

  console.log(`[server] Media stream connected for user ${userId}`);

  let relay: ReturnType<typeof createOpenAIRelay> | null = null;
  let sessionTracker: Awaited<ReturnType<typeof startSession>> | null = null;
  let imapClient: Awaited<ReturnType<typeof createImapConnection>> | null = null;

  try {
    // Load user context (settings, memory, credentials from Vault)
    const userContext = await loadUserContext(userId, supabase);

    // Open IMAP connection for this call session
    imapClient = await createImapConnection(userContext.imapConfig);

    // Start a new session in the database
    sessionTracker = await startSession(userId, supabase);
    console.log(`[server] Session ${sessionTracker.sessionId} started for user ${userId}`);

    // Create OpenAI relay with full user context
    const relayConfig: RelayConfig = {
      apiKey: apiKey!,
      session: sessionTracker,
      imapClient,
      smtpConfig: userContext.smtpConfig,
      supabase,
      toolApprovalConfig: userContext.toolApprovalConfig,
      memoryEntries: userContext.memoryEntries,
      voicePreference: userContext.voicePreference,
    };

    relay = createOpenAIRelay(
      relayConfig,
      (base64Audio) => {
        // Send transcoded audio back to Twilio as a media event
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              event: "media",
              media: { payload: base64Audio },
            })
          );
        }
      },
      () => {
        // OpenAI connection closed -- close the Twilio WebSocket
        if (ws.readyState === WebSocket.OPEN) {
          ws.close();
        }
      }
    );
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Unknown error";
    console.error(`[server] Failed to set up session for user ${userId}: ${errorMsg}`);
    ws.close();
    return;
  }

  // Handle incoming Twilio media events
  ws.on("message", (data) => {
    let message: { event: string; media?: { payload?: string }; [key: string]: unknown };
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (message.event === "media" && message.media?.payload && relay) {
      relay.sendAudio(message.media.payload);
    }
  });

  // Clean up on disconnect
  ws.on("close", async () => {
    console.log(`[server] Media stream disconnected for user ${userId}`);

    // Close OpenAI relay
    if (relay) {
      relay.close();
    }

    // End session in database
    if (sessionTracker) {
      try {
        await endSession(sessionTracker, supabase);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : "Unknown error";
        console.error(`[server] Failed to end session: ${errorMsg}`);
      }
    }

    // Close IMAP connection
    if (imapClient) {
      try {
        await closeImapConnection(imapClient);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : "Unknown error";
        console.error(`[server] Failed to close IMAP connection: ${errorMsg}`);
      }
    }
  });

  ws.on("error", (err) => {
    console.error(`[server] Media stream WebSocket error for user ${userId}:`, err.message);
  });
});

// ============================================================================
// BROWSER STREAM (direct WebSocket, no Twilio)
// ============================================================================

const browserWss = new WebSocketServer({ noServer: true });

// Route HTTP upgrade requests to the correct WebSocket server by path
server.on("upgrade", (request, socket, head) => {
  const pathname = new URL(request.url ?? "", `http://${request.headers.host}`).pathname;

  if (pathname === "/media-stream") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else if (pathname === "/browser-stream") {
    browserWss.handleUpgrade(request, socket, head, (ws) => {
      browserWss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

/**
 * Verifies a Supabase JWT token and returns the user ID.
 * Uses a lightweight anon-key client to call getUser() with the token.
 * @param token - The Supabase access token from the browser
 * @returns The authenticated user ID, or null if invalid
 */
async function verifySupabaseToken(token: string): Promise<string | null> {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return null;

  const client = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user.id;
}

browserWss.on("connection", async (ws: WebSocket, req: IncomingMessage) => {
  // Extract token from query params
  const url = new URL(req.url ?? "", `http://${req.headers.host}`);
  const token = url.searchParams.get("token");

  if (!token) {
    console.error("[browser-stream] Connection missing token param");
    ws.close(4001, "Missing token");
    return;
  }

  // Verify the token and get userId
  const userId = await verifySupabaseToken(token);
  if (!userId) {
    console.error("[browser-stream] Invalid or expired token");
    ws.close(4003, "Invalid token");
    return;
  }

  console.log(`[browser-stream] Connected for user ${userId}`);

  let relay: ReturnType<typeof createOpenAIRelay> | null = null;
  let sessionTracker: Awaited<ReturnType<typeof startSession>> | null = null;
  let imapClient: Awaited<ReturnType<typeof createImapConnection>> | null = null;

  try {
    const userContext = await loadUserContext(userId, supabase);

    imapClient = await createImapConnection(userContext.imapConfig);

    sessionTracker = await startSession(userId, supabase);
    console.log(`[browser-stream] Session ${sessionTracker.sessionId} started for user ${userId}`);

    const relayConfig: RelayConfig = {
      apiKey: apiKey!,
      session: sessionTracker,
      imapClient,
      smtpConfig: userContext.smtpConfig,
      supabase,
      toolApprovalConfig: userContext.toolApprovalConfig,
      memoryEntries: userContext.memoryEntries,
      voicePreference: userContext.voicePreference,
      skipTranscoding: true,
    };

    relay = createOpenAIRelay(
      relayConfig,
      (base64Audio) => {
        // Send PCM16 24kHz audio directly to browser
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "audio", data: base64Audio }));
        }
      },
      () => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.close();
        }
      }
    );
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Unknown error";
    console.error(`[browser-stream] Failed to set up session for user ${userId}: ${errorMsg}`);
    ws.close();
    return;
  }

  // Handle incoming browser audio (PCM16 24kHz base64)
  let audioLogCount = 0;
  ws.on("message", (data) => {
    let message: { type: string; data?: string };
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (message.type === "audio" && message.data && relay) {
      if (audioLogCount < 3) {
        console.log(`[browser-stream] Receiving audio (${message.data.length} chars base64)`);
        audioLogCount++;
      }
      relay.sendAudio(message.data);
    } else if (message.type !== "audio") {
      console.log(`[browser-stream] Received non-audio message: ${message.type}`);
    }
  });

  // Clean up on disconnect
  ws.on("close", async () => {
    console.log(`[browser-stream] Disconnected for user ${userId}`);

    if (relay) relay.close();

    if (sessionTracker) {
      try {
        await endSession(sessionTracker, supabase);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : "Unknown error";
        console.error(`[browser-stream] Failed to end session: ${errorMsg}`);
      }
    }

    if (imapClient) {
      try {
        await closeImapConnection(imapClient);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : "Unknown error";
        console.error(`[browser-stream] Failed to close IMAP connection: ${errorMsg}`);
      }
    }
  });

  ws.on("error", (err) => {
    console.error(`[browser-stream] WebSocket error for user ${userId}:`, err.message);
  });
});

server.listen(PORT, () => {
  console.log(`[server] Voice email assistant running on port ${PORT}`);
  console.log(`[server] Twilio webhook:   POST /twilio/voice`);
  console.log(`[server] Media stream:     ${streamBaseUrl}/media-stream`);
  console.log(`[server] Browser stream:   ${streamBaseUrl}/browser-stream`);
});
