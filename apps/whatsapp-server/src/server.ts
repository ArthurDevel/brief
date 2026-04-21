import { config as loadDotEnv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Request, type Response } from "express";
import { WhatsAppBot, type WhatsAppWebhookBody } from "./whatsAppBot.js";
import {
  getMetaAppSecret,
  isJsonContentType,
  isValidMetaWebhookSignature,
} from "./webhookSecurity.js";

type IncomingEventKind =
  | "user-message"
  | "user-voice-note"
  | "user-image"
  | "voice-call"
  | "unknown";

interface WhatsAppMessage {
  type?: string;
}

interface WhatsAppValue {
  messages?: WhatsAppMessage[];
  calls?: unknown[];
}

interface WhatsAppChange {
  value?: WhatsAppValue;
}

interface WhatsAppEntry {
  changes?: WhatsAppChange[];
}

const DEFAULT_PORT = 3020;
const WEBHOOK_REQUEST_BODY_LIMIT = "256kb";
const currentDir = path.dirname(fileURLToPath(import.meta.url));
loadDotEnv({ path: path.resolve(currentDir, "../.env") });

const app = express();
const whatsAppBot = new WhatsAppBot();
const metaAppSecret = getMetaAppSecret();

interface RequestWithRawBody extends Request {
  rawBody?: Buffer;
}

const webhookJsonMiddleware = express.json({
  limit: WEBHOOK_REQUEST_BODY_LIMIT,
  type: "application/json",
  verify: (req, _res, buffer) => {
    (req as RequestWithRawBody).rawBody = Buffer.from(buffer);
  }
});

function getPort(): number {
  const rawPort = process.env.PORT ?? String(DEFAULT_PORT);
  const port = Number.parseInt(rawPort, 10);

  if (Number.isNaN(port)) {
    throw new Error(`Invalid PORT value: ${rawPort}`);
  }

  return port;
}

function classifyWebhookEvent(body: WhatsAppWebhookBody): IncomingEventKind {
  if (Array.isArray(body.calls) && body.calls.length > 0) {
    return "voice-call";
  }

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (Array.isArray(change.value?.calls) && change.value.calls.length > 0) {
        return "voice-call";
      }

      const messageType = change.value?.messages?.[0]?.type;
      if (messageType === "text") {
        return "user-message";
      }

      if (messageType === "audio") {
        return "user-voice-note";
      }

      if (messageType === "image") {
        return "user-image";
      }
    }
  }

  return "unknown";
}

function logWebhookRequest(kind: IncomingEventKind, req: Request): void {
  console.log(
    `[whatsapp-server] received ${kind}`,
    JSON.stringify(
      {
        path: req.path,
        query: req.query,
        body: req.body ?? null
      },
      null,
      2
    )
  );
}

function acknowledge(res: Response, kind: IncomingEventKind): void {
  res.status(200).json({
    ok: true,
    eventType: kind
  });
}

/**
 * Rejects webhook requests that are not JSON.
 * @param req - Incoming Express request
 * @param res - Express response
 * @param next - Express next callback
 * @returns Void
 */
function requireJsonContentType(
  req: Request,
  res: Response,
  next: express.NextFunction
): void {
  const contentType = req.get("content-type");

  if (!isJsonContentType(contentType)) {
    res.status(415).json({ error: "Webhook requests must use application/json" });
    return;
  }

  next();
}

/**
 * Rejects webhook requests with an invalid Meta signature.
 * @param req - Incoming Express request with a captured raw body
 * @param res - Express response
 * @param next - Express next callback
 * @returns Void
 */
function verifyMetaWebhookSignature(
  req: Request,
  res: Response,
  next: express.NextFunction
): void {
  const requestWithRawBody = req as RequestWithRawBody;
  const signatureHeader = req.get("x-hub-signature-256");

  if (!requestWithRawBody.rawBody) {
    res.status(400).json({ error: "Webhook request body is required" });
    return;
  }

  if (!isValidMetaWebhookSignature(requestWithRawBody.rawBody, signatureHeader, metaAppSecret)) {
    res.status(401).json({ error: "Invalid webhook signature" });
    return;
  }

  next();
}

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.get("/api/whatsapp/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  const expectedToken =
    process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN ?? process.env.WHATSAPP_VERIFY_TOKEN ?? "";

  if (mode !== "subscribe" || typeof challenge !== "string") {
    res.status(400).json({ error: "Invalid webhook verification request" });
    return;
  }

  if (!expectedToken || token !== expectedToken) {
    res.status(403).json({ error: "Webhook verification failed" });
    return;
  }

  console.log("[whatsapp-server] webhook verification succeeded");
  res.status(200).type("text/plain").send(challenge);
});

app.post(
  "/api/whatsapp/webhook",
  requireJsonContentType,
  webhookJsonMiddleware,
  verifyMetaWebhookSignature,
  (req, res) => {
    const eventKind = classifyWebhookEvent((req.body ?? {}) as WhatsAppWebhookBody);
    logWebhookRequest(eventKind, req);
    void whatsAppBot.handleWebhook((req.body ?? {}) as WhatsAppWebhookBody).catch((error) => {
      console.error("[whatsapp-server] failed to process whatsapp webhook", error);
    });
    acknowledge(res, eventKind);
  }
);

app.use((error: Error & { status?: number; type?: string }, _req: Request, res: Response, _next: express.NextFunction) => {
  if (error.type === "entity.too.large") {
    res.status(413).json({ error: "Webhook request body is too large" });
    return;
  }

  if (error.type === "entity.parse.failed") {
    res.status(400).json({ error: "Webhook request body must be valid JSON" });
    return;
  }

  console.error("[whatsapp-server] unhandled error", error);
  res.status(error.status ?? 500).json({ error: error.message || "Internal server error" });
});

const port = getPort();
app.listen(port, () => {
  console.log(`WhatsApp server listening on http://localhost:${port}`);
});
