/**
 * Investigates the WhatsApp agent's Notion tool visibility for one user.
 *
 * Responsibilities:
 * - Load Composio credentials from the local testscript .env file
 * - Reproduce the WhatsApp agent's active-connection selection logic
 * - Print the connected toolkits and the available Notion tool inventory
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

// ============================================================================
// CONSTANTS
// ============================================================================

const TESTSCRIPT_DIRECTORY = path.dirname(new URL(import.meta.url).pathname);
const TESTSCRIPT_ENV_PATH = path.join(TESTSCRIPT_DIRECTORY, ".env");
const WHATSAPP_AGENT_PACKAGE_PATH = path.join(
  TESTSCRIPT_DIRECTORY,
  "..",
  "..",
  "apps",
  "whatsapp-agent",
  "package.json"
);

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

async function main() {
  loadEnvironmentFile(TESTSCRIPT_ENV_PATH);

  const userId = process.argv[2]?.trim();
  if (!userId) {
    throw new Error("Usage: node inspectNotionTools.mjs <supabase-user-id>");
  }

  const composioApiKey = process.env.COMPOSIO_API_KEY?.trim();
  if (!composioApiKey) {
    throw new Error("COMPOSIO_API_KEY is required in testscripts/.../.env");
  }

  const { Composio } = loadComposioSdk();
  const composio = new Composio({ apiKey: composioApiKey });

  const connectedAccounts = await listConnectedAccounts(composio, userId);
  const connectedAccountsByToolkit = selectActiveConnectedAccounts(connectedAccounts);
  const notionTools = await listNotionTools(composio);

  const report = {
    userId,
    connectedAccounts: connectedAccounts.map((account) => ({
      id: account.id,
      toolkit: account.toolkit?.slug ?? null,
      status: account.status ?? null,
      statusReason: account.statusReason ?? null,
      updatedAt: account.updatedAt ?? null,
    })),
    connectedAccountsByToolkit,
    notionToolCount: notionTools.length,
    notionToolSlugs: notionTools.map((tool) => tool.slug),
    notableNotionTools: notionTools
      .filter((tool) => hasInterestingKeyword(tool))
      .map((tool) => ({
        slug: tool.slug,
        name: tool.name,
        description: tool.description,
      })),
  };

  console.log(JSON.stringify(report, null, 2));
}

await main();

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Loads key-value pairs from a local .env file into process.env.
 * @param {string} envFilePath - Absolute path to the .env file
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
 * Loads the Composio SDK from the WhatsApp agent package context.
 * @returns {{ Composio: new (...args: unknown[]) => import("@composio/core").Composio }}
 */
function loadComposioSdk() {
  const require = createRequire(WHATSAPP_AGENT_PACKAGE_PATH);
  return require("@composio/core");
}

/**
 * Lists all Composio connected accounts for a user.
 * @param {import("@composio/core").Composio} composio - Configured Composio SDK client
 * @param {string} userId - Supabase user ID used as external Composio user ID
 * @returns {Promise<Array<{ id: string; status: string; statusReason?: string | null; updatedAt: string; toolkit?: { slug?: string } }>>}
 */
async function listConnectedAccounts(composio, userId) {
  const response = await composio.connectedAccounts.list({
    userIds: [userId],
    limit: 100,
  });

  return Array.isArray(response.items) ? response.items : [];
}

/**
 * Reproduces the WhatsApp agent's active-account selection logic.
 * @param {Array<{ id: string; status: string; updatedAt: string; toolkit?: { slug?: string } }>} connectedAccounts - Raw Composio connected accounts
 * @returns {Record<string, string>}
 */
function selectActiveConnectedAccounts(connectedAccounts) {
  const connectedAccountsByToolkit = {};
  const latestUpdatedAtByToolkit = new Map();

  for (const connectedAccount of connectedAccounts) {
    const toolkit = connectedAccount.toolkit?.slug?.trim().toLowerCase();
    if (!toolkit || connectedAccount.status !== "ACTIVE") {
      continue;
    }

    const updatedAt = new Date(connectedAccount.updatedAt).getTime();
    const latestUpdatedAt =
      latestUpdatedAtByToolkit.get(toolkit) ?? Number.NEGATIVE_INFINITY;

    if (updatedAt >= latestUpdatedAt) {
      connectedAccountsByToolkit[toolkit] = connectedAccount.id;
      latestUpdatedAtByToolkit.set(toolkit, updatedAt);
    }
  }

  return connectedAccountsByToolkit;
}

/**
 * Lists raw Notion tools currently exposed by Composio.
 * @param {import("@composio/core").Composio} composio - Configured Composio SDK client
 * @returns {Promise<Array<{ slug: string; name?: string | null; description?: string | null }>>}
 */
async function listNotionTools(composio) {
  const response = await composio.tools.getRawComposioTools({
    toolkits: ["notion"],
    limit: 100,
  });

  const rawTools = Array.isArray(response)
    ? response
    : Array.isArray(response.items)
      ? response.items
      : [];

  return rawTools
    .filter((tool) => typeof tool.slug === "string" && tool.slug.startsWith("NOTION_"))
    .map((tool) => ({
      slug: tool.slug,
      name: typeof tool.name === "string" ? tool.name : null,
      description: typeof tool.description === "string" ? tool.description : null,
    }));
}

/**
 * Flags a subset of Notion tools that are relevant to a vague "check notion" request.
 * @param {{ slug: string; name?: string | null; description?: string | null }} tool - Raw Notion tool summary
 * @returns {boolean}
 */
function hasInterestingKeyword(tool) {
  const haystack = `${tool.slug} ${tool.name ?? ""} ${tool.description ?? ""}`.toLowerCase();

  return (
    haystack.includes("fetch") ||
    haystack.includes("query") ||
    haystack.includes("search") ||
    haystack.includes("page") ||
    haystack.includes("database")
  );
}
