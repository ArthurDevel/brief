/**
 * Audits Composio Gmail and Outlook tools for agent-context payload blowup risk.
 *
 * Responsibilities:
 * - Load the local testscript environment
 * - Inspect live raw Composio tool schemas for Gmail and Outlook
 * - Rank tools that are likely to overfill model context
 * - Write JSON and Markdown reports with recommended post-processing
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

// ============================================================================
// CONSTANTS
// ============================================================================

const TESTSCRIPT_DIRECTORY = path.dirname(new URL(import.meta.url).pathname);
const TESTSCRIPT_ENV_PATH = path.join(TESTSCRIPT_DIRECTORY, ".env");
const OUTPUT_DIRECTORY = path.join(TESTSCRIPT_DIRECTORY, "output");
const JSON_REPORT_PATH = path.join(OUTPUT_DIRECTORY, "payload-risk-report.json");
const MARKDOWN_REPORT_PATH = path.join(OUTPUT_DIRECTORY, "payload-risk-summary.md");
const WHATSAPP_AGENT_PACKAGE_PATH = path.join(
  TESTSCRIPT_DIRECTORY,
  "..",
  "..",
  "apps",
  "whatsapp-agent",
  "package.json"
);
const DEFAULT_RAW_TOOL_LIMIT = 500;
const TOOLKITS_TO_AUDIT = ["gmail", "outlook"];
const RISK_THRESHOLD = 45;
const MAX_CANDIDATES_PER_TOOLKIT = 12;

const RISK_SIGNAL_RULES = [
  {
    score: 55,
    reason: "Raw MIME content can be extremely large and duplicates structure the agent does not need.",
    test: (context) =>
      /MIME_CONTENT|RAW/.test(context.slug) ||
      context.description.includes("raw mime") ||
      context.description.includes("rfc 2822"),
  },
  {
    score: 45,
    reason: "Attachment bytes or download payloads should never be replayed into agent context.",
    test: (context) =>
      /ATTACHMENT|DOWNLOAD/.test(context.slug) ||
      context.description.includes("contentbytes") ||
      context.description.includes("binary data") ||
      context.description.includes("base64url-encoded binary data"),
  },
  {
    score: 40,
    reason: "Single-message fetch can include full body, headers, and other heavy metadata.",
    test: (context) =>
      /FETCH_MESSAGE_BY_MESSAGE_ID|GET_MESSAGE|GET_MAIL_FOLDER_MESSAGE|GET_CHILD_FOLDER_MESSAGE|GET_DRAFT/.test(
        context.slug
      ),
  },
  {
    score: 35,
    reason: "Thread or conversation expansion can fan out into many messages at once.",
    test: (context) =>
      /THREAD|CONVERSATION/.test(context.slug) ||
      context.description.includes("retrieve all messages in a thread"),
  },
  {
    score: 30,
    reason: "List or search responses can page through large result sets.",
    test: (context) =>
      /LIST_MESSAGES|SEARCH_MESSAGES|FETCH_EMAILS|LIST_THREADS|LIST_DRAFTS|LIST_HISTORY|GET_MAIL_DELTA|LIST_SENT_ITEMS_MESSAGES/.test(
        context.slug
      ),
  },
  {
    score: 25,
    reason: "Schema exposes a full or raw format option.",
    test: (context) =>
      context.serializedSchema.includes("\"format\"") &&
      (context.serializedSchema.includes("full") || context.serializedSchema.includes("raw")),
  },
  {
    score: 25,
    reason: "Schema exposes payload/body selection controls that can pull large content.",
    test: (context) =>
      context.serializedSchema.includes("include_payload") ||
      context.serializedSchema.includes("verbose") ||
      context.serializedSchema.includes("bodyPreview") ||
      context.serializedSchema.includes("\"body\"") ||
      context.serializedSchema.includes("internetMessageHeaders"),
  },
  {
    score: 20,
    reason: "Schema allows large page sizes or bulk result windows.",
    test: (context) =>
      context.serializedSchema.includes("max_results") ||
      context.serializedSchema.includes("\"top\"") ||
      context.serializedSchema.includes("page_token") ||
      context.serializedSchema.includes("@odata.nextlink"),
  },
];

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

async function main() {
  loadEnvironmentFile(TESTSCRIPT_ENV_PATH);

  const composioApiKey = requireEnvironmentVariable("COMPOSIO_API_KEY");
  const rawToolLimit = getRawToolLimit();
  const { Composio } = loadComposioSdk();
  const composio = new Composio({ apiKey: composioApiKey });

  const toolkitReports = {};
  for (const toolkit of TOOLKITS_TO_AUDIT) {
    const rawTools = await listRawTools(composio, toolkit, rawToolLimit);
    const scopedTools = rawTools.filter((tool) => isInScopeTool(toolkit, tool));
    const candidates = scopedTools
      .map((tool) => analyzeTool(toolkit, tool))
      .filter((candidate) => candidate.riskScore >= RISK_THRESHOLD)
      .sort((left, right) => right.riskScore - left.riskScore || left.slug.localeCompare(right.slug))
      .slice(0, MAX_CANDIDATES_PER_TOOLKIT);

    toolkitReports[toolkit] = {
      candidateCount: candidates.length,
      candidates,
      inScopeToolCount: scopedTools.length,
      rawToolCount: rawTools.length,
    };
  }

  const report = {
    generatedAt: new Date().toISOString(),
    rawToolLimit,
    threshold: RISK_THRESHOLD,
    toolkitReports,
  };

  fs.writeFileSync(JSON_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.writeFileSync(MARKDOWN_REPORT_PATH, buildMarkdownSummary(report), "utf8");

  console.log(JSON.stringify(report, null, 2));
  console.error(`Wrote ${JSON_REPORT_PATH}`);
  console.error(`Wrote ${MARKDOWN_REPORT_PATH}`);
}

await main();

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Loads key-value pairs from the local .env file into process.env.
 * @param {string} envFilePath - Absolute path to the local .env file
 * @returns {void}
 */
function loadEnvironmentFile(envFilePath) {
  if (!fs.existsSync(envFilePath)) {
    throw new Error(`Missing .env file: ${envFilePath}`);
  }

  const fileContents = fs.readFileSync(envFilePath, "utf8");
  for (const rawLine of fileContents.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

/**
 * Returns one required environment variable.
 * @param {string} name - Environment variable name
 * @returns {string}
 */
function requireEnvironmentVariable(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required in ${TESTSCRIPT_ENV_PATH}`);
  }

  return value;
}

/**
 * Returns the configured raw-tool fetch limit.
 * @returns {number}
 */
function getRawToolLimit() {
  const rawValue = process.env.RAW_TOOL_LIMIT?.trim();
  if (!rawValue) {
    return DEFAULT_RAW_TOOL_LIMIT;
  }

  const parsedValue = Number(rawValue);
  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    throw new Error(`RAW_TOOL_LIMIT must be a positive integer. Received: ${rawValue}`);
  }

  return parsedValue;
}

/**
 * Loads the Composio SDK from the installed WhatsApp agent workspace dependency.
 * @returns {{ Composio: new (...args: unknown[]) => import("@composio/core").Composio }}
 */
function loadComposioSdk() {
  const require = createRequire(WHATSAPP_AGENT_PACKAGE_PATH);
  return require("@composio/core");
}

/**
 * Lists raw Composio tools for one toolkit.
 * @param {import("@composio/core").Composio} composio - Configured Composio client
 * @param {string} toolkit - Toolkit slug
 * @param {number} limit - Maximum tool count to request
 * @returns {Promise<Array<{ slug: string; description?: string | null; inputParameters?: unknown; outputParameters?: unknown }>>}
 */
async function listRawTools(composio, toolkit, limit) {
  const response = await composio.tools.getRawComposioTools({
    toolkits: [toolkit],
    limit,
  });

  const rawTools = Array.isArray(response)
    ? response
    : Array.isArray(response.items)
      ? response.items
      : [];

  return rawTools.filter((tool) => typeof tool.slug === "string");
}

/**
 * Analyzes one tool for payload blowup risk.
 * @param {string} toolkit - Toolkit slug
 * @param {{ slug: string; description?: string | null; inputParameters?: unknown; outputParameters?: unknown }} tool - Raw tool definition
 * @returns {{
 *   toolkit: string;
 *   slug: string;
 *   description: string;
 *   riskLevel: string;
 *   riskScore: number;
 *   reasons: string[];
 *   suggestedPostProcessing: {
 *     strategy: string;
 *     keep: string[];
 *     drop: string[];
 *   };
 * }}
 */
function analyzeTool(toolkit, tool) {
  const description = typeof tool.description === "string" ? tool.description.trim() : "";
  const serializedSchema = JSON.stringify({
    inputParameters: tool.inputParameters ?? null,
    outputParameters: tool.outputParameters ?? null,
  }).toLowerCase();

  const context = {
    description: description.toLowerCase(),
    serializedSchema,
    slug: tool.slug,
  };

  const reasons = [];
  let riskScore = 0;

  for (const rule of RISK_SIGNAL_RULES) {
    if (!rule.test(context)) {
      continue;
    }

    riskScore += rule.score;
    reasons.push(rule.reason);
  }

  return {
    description,
    reasons,
    riskLevel: mapRiskLevel(riskScore),
    riskScore,
    slug: tool.slug,
    suggestedPostProcessing: buildSuggestedPostProcessing(toolkit, tool.slug),
    toolkit,
  };
}

/**
 * Returns whether one raw tool is in scope for this mail-focused audit.
 * @param {string} toolkit - Toolkit slug
 * @param {{ slug: string; description?: string | null }} tool - Raw tool definition
 * @returns {boolean}
 */
function isInScopeTool(toolkit, tool) {
  const slug = tool.slug.toUpperCase();
  const description = (tool.description ?? "").toUpperCase();

  if (toolkit === "gmail") {
    return /FETCH|GET|LIST|SEARCH/.test(slug);
  }

  const mailSignals = /GET|LIST|SEARCH|DOWNLOAD|DELTA|QUERY/;
  const nonMailSignals = /CALENDAR|EVENT|CHAT|TEAM/;

  return mailSignals.test(slug) && !nonMailSignals.test(slug) && !nonMailSignals.test(description);
}

/**
 * Maps one numeric risk score into a text label.
 * @param {number} riskScore - Aggregate risk score
 * @returns {string}
 */
function mapRiskLevel(riskScore) {
  if (riskScore >= 100) {
    return "critical";
  }

  if (riskScore >= 70) {
    return "high";
  }

  if (riskScore >= RISK_THRESHOLD) {
    return "medium";
  }

  return "low";
}

/**
 * Returns a concrete post-processing strategy for one risky tool.
 * @param {string} toolkit - Toolkit slug
 * @param {string} slug - Tool slug
 * @returns {{ strategy: string; keep: string[]; drop: string[] }}
 */
function buildSuggestedPostProcessing(toolkit, slug) {
  if (/GET_ATTACHMENT|DOWNLOAD.*ATTACHMENT/.test(slug)) {
    return {
      strategy: "attachment-ref-only",
      keep: [
        "messageId",
        "attachmentId",
        "fileName",
        "mimeType",
        "sizeBytes",
        "downloadUrlOrS3Url",
      ],
      drop: ["attachment bytes", "base64 payload", "inline binary content"],
    };
  }

  if (/MIME_CONTENT|RAW/.test(slug)) {
    return {
      strategy: "decoded-full-text-only",
      keep: ["messageId", "subject", "from", "receivedAt", "textBody"],
      drop: ["raw MIME", "multipart boundaries", "base64 body", "duplicated HTML"],
    };
  }

  if (/FETCH_MESSAGE_BY_MESSAGE_ID|GET_MESSAGE|GET_MAIL_FOLDER_MESSAGE|GET_CHILD_FOLDER_MESSAGE|GET_DRAFT/.test(slug)) {
    return {
      strategy: "single-message-text",
      keep: [
        "id",
        "threadIdOrConversationId",
        "parentFolderId",
        "subject",
        "from",
        "to",
        "cc",
        "receivedAt",
        "hasAttachments",
        "bodyText",
        "bodyPreview",
        "webLink",
      ],
      drop: ["full headers", "raw body HTML", "payload parts", "inline images", "base64 content"],
    };
  }

  if (/THREAD|CONVERSATION/.test(slug)) {
    return {
      strategy: "thread-summary",
      keep: [
        "threadIdOrConversationId",
        "messageCount",
        "participants",
        "latestReceivedAt",
        "messages[id,sender,subject,receivedAt,unread,hasAttachments,preview]",
      ],
      drop: ["full bodies for every message", "raw payloads", "duplicated thread metadata"],
    };
  }

  if (/LIST_HISTORY|GET_MAIL_DELTA/.test(slug)) {
    return {
      strategy: "change-summary",
      keep: [
        "checkpointIdOrDeltaLink",
        "changes[id,messageId,threadIdOrConversationId,changeType,labelsOrFlags,preview]",
        "nextPageTokenOrNextLink",
      ],
      drop: ["full message bodies", "unbounded event wrappers"],
    };
  }

  if (/LIST_.*ATTACHMENT|LIST_OUTLOOK_ATTACHMENTS/.test(slug)) {
    return {
      strategy: "attachment-metadata-list",
      keep: ["messageId", "attachments[id,name,contentType,size,isInline,downloadable]"],
      drop: ["contentBytes", "file bytes", "embedded binary payloads"],
    };
  }

  return {
    strategy: "message-summary-list",
    keep: [
      "messages[id,threadIdOrConversationId,subject,from,receivedAt,isReadOrUnread,hasAttachments,preview,webLink]",
      "nextPageTokenOrNextLink",
      "resultSizeEstimateOrTotalEstimate",
    ],
    drop: ["full bodies", "payload parts", "raw headers", "attachment bytes"],
  };
}

/**
 * Builds a Markdown summary for the audit output folder.
 * @param {{
 *   generatedAt: string;
 *   rawToolLimit: number;
 *   threshold: number;
 *   toolkitReports: Record<string, { rawToolCount: number; inScopeToolCount: number; candidateCount: number; candidates: Array<{
 *     slug: string;
 *     riskLevel: string;
 *     riskScore: number;
 *     reasons: string[];
 *     suggestedPostProcessing: { strategy: string; keep: string[]; drop: string[] };
 *   }> }>;
 * }} report - Final audit report
 * @returns {string}
 */
function buildMarkdownSummary(report) {
  const lines = [
    "# Tool Payload Risk Summary",
    "",
    `Generated at: ${report.generatedAt}`,
    `Raw tool limit: ${report.rawToolLimit}`,
    `Risk threshold: ${report.threshold}`,
    "",
  ];

  for (const toolkit of TOOLKITS_TO_AUDIT) {
    const toolkitReport = report.toolkitReports[toolkit];
    lines.push(`## ${toolkit}`);
    lines.push("");
    lines.push(`- Raw tools scanned: ${toolkitReport.rawToolCount}`);
    lines.push(`- In-scope mail tools: ${toolkitReport.inScopeToolCount}`);
    lines.push(`- Risk candidates: ${toolkitReport.candidateCount}`);
    lines.push("");

    for (const candidate of toolkitReport.candidates) {
      lines.push(`### ${candidate.slug}`);
      lines.push("");
      lines.push(`- Risk: ${candidate.riskLevel} (${candidate.riskScore})`);
      lines.push(`- Why: ${candidate.reasons.join(" ")}`);
      lines.push(`- Strategy: ${candidate.suggestedPostProcessing.strategy}`);
      lines.push(`- Keep: ${candidate.suggestedPostProcessing.keep.join(", ")}`);
      lines.push(`- Drop: ${candidate.suggestedPostProcessing.drop.join(", ")}`);
      lines.push("");
    }
  }

  return `${lines.join("\n")}\n`;
}
