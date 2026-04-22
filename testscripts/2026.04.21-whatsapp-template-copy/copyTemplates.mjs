/**
 * Standalone script to copy WhatsApp message templates between WABAs.
 *
 * Responsibilities:
 * - Load source and destination templates from the Meta Graph API
 * - Build a safe copy plan that skips existing destination template names
 * - Recreate missing templates on the destination WABA when explicitly applied
 * - Write plan and result files to disk for review
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ============================================================================
// CONSTANTS
// ============================================================================

const SOURCE_TEMPLATE_PAGE_LIMIT = 100;
const DEFAULT_INCLUDED_STATUSES = ["APPROVED"];
const PLAN_OUTPUT_FILE_NAME = "copy-plan.json";
const RESULT_OUTPUT_FILE_NAME = "copy-result.json";
const ALLOWED_SUB_CATEGORIES = new Set([
  "ORDER_DETAILS",
  "ORDER_STATUS",
  "RICH_ORDER_STATUS",
]);

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

/**
 * Runs the template copy script.
 * @returns {Promise<void>} Promise that resolves when the plan and result files have been written
 */
async function main() {
  await loadDotEnvFile();

  const config = getScriptConfig();
  const options = getScriptOptions(process.argv.slice(2));

  const [sourceTemplates, destinationTemplates] = await Promise.all([
    listAllTemplates(config.sourceWabaId, config.sourceAccessToken, config.apiVersion),
    listAllTemplates(config.destinationWabaId, config.destinationAccessToken, config.apiVersion),
  ]);

  const planItems = buildCopyPlan(sourceTemplates, destinationTemplates, options);
  const planOutput = {
    applyChanges: options.applyChanges,
    destinationWabaId: config.destinationWabaId,
    generatedAt: new Date().toISOString(),
    includedStatuses: options.includedStatuses,
    itemCount: planItems.length,
    items: planItems,
    onlyNames: options.onlyNames,
    sourceWabaId: config.sourceWabaId,
  };

  const planOutputPath = await writeOutputFile(PLAN_OUTPUT_FILE_NAME, planOutput);
  console.info(`[whatsapp-template-copy] wrote plan to ${planOutputPath}`);

  const executionResults = await executeCopyPlan(planItems, config, options.applyChanges);
  const resultOutput = {
    applied: options.applyChanges,
    createdCount: executionResults.filter((result) => result.action === "created").length,
    dryRunCount: executionResults.filter((result) => result.action === "dry-run").length,
    generatedAt: new Date().toISOString(),
    results: executionResults,
    skippedCount: executionResults.filter((result) => result.action === "skipped").length,
  };

  const resultOutputPath = await writeOutputFile(RESULT_OUTPUT_FILE_NAME, resultOutput);
  console.info(`[whatsapp-template-copy] wrote result to ${resultOutputPath}`);
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[whatsapp-template-copy] ${message}`);
  process.exitCode = 1;
});

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Loads and validates the required env vars.
 * @returns {{
 *   apiVersion: string;
 *   destinationAccessToken: string;
 *   destinationWabaId: string;
 *   sourceAccessToken: string;
 *   sourceWabaId: string;
 * }} Validated script config
 */
function getScriptConfig() {
  const apiVersion = getRequiredEnv("WHATSAPP_API_VERSION");

  return {
    apiVersion: normalizeApiVersion(apiVersion),
    destinationAccessToken: getRequiredEnv("WHATSAPP_DESTINATION_ACCESS_TOKEN"),
    destinationWabaId: getRequiredEnv("WHATSAPP_DESTINATION_WABA_ID"),
    sourceAccessToken: getRequiredEnv("WHATSAPP_SOURCE_ACCESS_TOKEN"),
    sourceWabaId: getRequiredEnv("WHATSAPP_SOURCE_WABA_ID"),
  };
}

/**
 * Parses the supported script flags.
 * @param {string[]} rawArgs - Raw CLI args after the script name
 * @returns {{
 *   applyChanges: boolean;
 *   includedStatuses: string[];
 *   onlyNames: string[] | null;
 * }} Parsed script options
 */
function getScriptOptions(rawArgs) {
  let applyChanges = false;
  let includedStatuses = [...DEFAULT_INCLUDED_STATUSES];
  let onlyNames = null;

  for (const argument of rawArgs) {
    if (argument === "--apply") {
      applyChanges = true;
      continue;
    }

    if (argument.startsWith("--include-statuses=")) {
      const rawStatuses = argument.slice("--include-statuses=".length);
      includedStatuses = parseCommaSeparatedList(rawStatuses, "include statuses");
      continue;
    }

    if (argument.startsWith("--only-names=")) {
      const rawNames = argument.slice("--only-names=".length);
      onlyNames = parseCommaSeparatedList(rawNames, "template names");
      continue;
    }

    throw new Error(
      `Unsupported argument "${argument}". Supported flags: --apply, --include-statuses=..., --only-names=...`
    );
  }

  return {
    applyChanges,
    includedStatuses: includedStatuses.map((status) => status.toUpperCase()),
    onlyNames: onlyNames ? onlyNames.map((name) => name.toLowerCase()) : null,
  };
}

/**
 * Loads all templates for one WABA.
 * @param {string} wabaId - WhatsApp Business Account ID
 * @param {string} accessToken - Access token with template read access
 * @param {string} apiVersion - Graph API version
 * @returns {Promise<Array<Record<string, unknown>>>} All templates returned by the Graph API
 */
async function listAllTemplates(wabaId, accessToken, apiVersion) {
  const templates = [];
  let afterCursor = null;

  while (true) {
    const response = await fetchTemplatePage(wabaId, accessToken, apiVersion, afterCursor);
    const pageTemplates = Array.isArray(response.data) ? response.data : [];
    templates.push(...pageTemplates);

    const nextCursor = response.paging?.cursors?.after?.trim();
    if (!nextCursor) {
      return templates;
    }

    afterCursor = nextCursor;
  }
}

/**
 * Builds the copy plan from the source and destination template catalogs.
 * @param {Array<Record<string, unknown>>} sourceTemplates - Templates loaded from the source WABA
 * @param {Array<Record<string, unknown>>} destinationTemplates - Templates loaded from the destination WABA
 * @param {{
 *   applyChanges: boolean;
 *   includedStatuses: string[];
 *   onlyNames: string[] | null;
 * }} options - Script options
 * @returns {Array<Record<string, unknown>>} Copy plan items
 */
function buildCopyPlan(sourceTemplates, destinationTemplates, options) {
  const filteredSourceTemplates = sourceTemplates
    .filter((template) => shouldIncludeTemplate(template, options))
    .sort((left, right) => {
      const leftKey = buildTemplateKey(left);
      const rightKey = buildTemplateKey(right);
      return leftKey.localeCompare(rightKey);
    });
  const relevantDestinationKeys = new Set(filteredSourceTemplates.map((template) => buildTemplateKey(template)));
  const destinationTemplatesByKey = buildTemplateMapByKey(destinationTemplates, relevantDestinationKeys);

  return filteredSourceTemplates.map((template) => {
    const name = getRequiredTemplateName(template);
    const destinationTemplate = destinationTemplatesByKey.get(buildTemplateKey(template)) ?? null;

    if (destinationTemplate) {
      return {
        action: "skip-existing",
        category: getRequiredTemplateCategory(template),
        language: getRequiredTemplateLanguage(template),
        name,
        payload: null,
        reason: "Destination WABA already has a template with this name and language.",
        sourceTemplateId: normalizeOptionalString(template.id),
        status: getRequiredTemplateStatus(template),
      };
    }

    return {
      action: "create",
      category: getRequiredTemplateCategory(template),
      language: getRequiredTemplateLanguage(template),
      name,
      payload: sanitizeTemplateForCreate(template),
      reason: "Template does not exist on the destination WABA.",
      sourceTemplateId: normalizeOptionalString(template.id),
      status: getRequiredTemplateStatus(template),
    };
  });
}

/**
 * Executes the copy plan.
 * @param {Array<Record<string, unknown>>} planItems - Built copy plan
 * @param {{
 *   apiVersion: string;
 *   destinationAccessToken: string;
 *   destinationWabaId: string;
 * }} config - Script config
 * @param {boolean} applyChanges - True when the script should create templates
 * @returns {Promise<Array<Record<string, unknown>>>} Per-template execution results
 */
async function executeCopyPlan(planItems, config, applyChanges) {
  const results = [];

  for (const item of planItems) {
    if (item.action === "skip-existing") {
      results.push({
        action: "skipped",
        destinationTemplateId: null,
        error: null,
        name: item.name,
      });
      continue;
    }

    if (!applyChanges) {
      results.push({
        action: "dry-run",
        destinationTemplateId: null,
        error: null,
        name: item.name,
      });
      continue;
    }

    const payload = item.payload;
    if (!payload || typeof payload !== "object") {
      throw new Error(`Missing create payload for template "${item.name}".`);
    }

    const createdTemplateId = await createTemplate(
      config.destinationWabaId,
      config.destinationAccessToken,
      config.apiVersion,
      payload
    );

    results.push({
      action: "created",
      destinationTemplateId: createdTemplateId,
      error: null,
      name: item.name,
    });

    console.info(`[whatsapp-template-copy] created template "${item.name}"`);
  }

  return results;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Loads env vars from a local `.env` file when present.
 * @returns {Promise<void>} Promise that resolves when the env file has been processed
 */
async function loadDotEnvFile() {
  const currentFilePath = fileURLToPath(import.meta.url);
  const currentDirectoryPath = path.dirname(currentFilePath);
  const envFilePath = path.join(currentDirectoryPath, ".env");

  try {
    const envFileContent = await readFile(envFilePath, "utf8");
    const envLines = envFileContent.split(/\r?\n/);

    for (const rawLine of envLines) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) {
        continue;
      }

      const separatorIndex = line.indexOf("=");
      if (separatorIndex === -1) {
        continue;
      }

      const envName = line.slice(0, separatorIndex).trim();
      const envValue = line.slice(separatorIndex + 1).trim();

      if (!process.env[envName]) {
        process.env[envName] = stripWrappingQuotes(envValue);
      }
    }
  } catch (error) {
    const errorCode = error && typeof error === "object" ? error.code : null;
    if (errorCode !== "ENOENT") {
      throw error;
    }
  }
}

/**
 * Fetches one page of templates from the Graph API.
 * @param {string} wabaId - WhatsApp Business Account ID
 * @param {string} accessToken - Access token with template read access
 * @param {string} apiVersion - Graph API version
 * @param {string | null} afterCursor - Pagination cursor, or null for the first page
 * @returns {Promise<Record<string, unknown>>} Parsed Graph API response
 */
async function fetchTemplatePage(wabaId, accessToken, apiVersion, afterCursor) {
  const endpoint = new URL(`https://graph.facebook.com/${apiVersion}/${wabaId}/message_templates`);
  endpoint.searchParams.set(
    "fields",
    [
      "id",
      "name",
      "language",
      "status",
      "category",
      "sub_category",
      "parameter_format",
      "message_send_ttl_seconds",
      "components",
    ].join(",")
  );
  endpoint.searchParams.set("limit", String(SOURCE_TEMPLATE_PAGE_LIMIT));

  if (afterCursor) {
    endpoint.searchParams.set("after", afterCursor);
  }

  const response = await fetch(endpoint, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  const payload = /** @type {Record<string, unknown>} */ (await response.json());
  if (!response.ok) {
    const errorMessage = payload.error?.message ?? `Graph API request failed with ${response.status}.`;
    throw new Error(String(errorMessage));
  }

  return payload;
}

/**
 * Creates one template on the destination WABA.
 * @param {string} wabaId - Destination WABA ID
 * @param {string} accessToken - Destination access token
 * @param {string} apiVersion - Graph API version
 * @param {Record<string, unknown>} payload - Sanitized template create payload
 * @returns {Promise<string | null>} The created template ID when returned by Graph
 */
async function createTemplate(wabaId, accessToken, apiVersion, payload) {
  const endpoint = `https://graph.facebook.com/${apiVersion}/${wabaId}/message_templates`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const rawBody = await response.text();
  const parsedBody = tryParseJson(rawBody);

  if (!response.ok) {
    const errorMessage =
      parsedBody?.error?.message
      ?? rawBody
      ?? `Template create failed with ${response.status}.`;
    throw new Error(String(errorMessage));
  }

  return typeof parsedBody?.id === "string" && parsedBody.id.trim().length > 0
    ? parsedBody.id.trim()
    : null;
}

/**
 * Returns whether a source template should be included in the plan.
 * @param {Record<string, unknown>} template - Source template candidate
 * @param {{
 *   includedStatuses: string[];
 *   onlyNames: string[] | null;
 * }} options - Script options
 * @returns {boolean} True when the template should be included
 */
function shouldIncludeTemplate(template, options) {
  const status = getRequiredTemplateStatus(template);
  if (!options.includedStatuses.includes(status)) {
    return false;
  }

  if (!options.onlyNames) {
    return true;
  }

  return options.onlyNames.includes(getRequiredTemplateName(template).toLowerCase());
}

/**
 * Builds a destination template lookup keyed by lowercased template name and language.
 * @param {Array<Record<string, unknown>>} templates - Destination templates
 * @param {Set<string>} allowedKeys - Only keys relevant to the current copy operation
 * @returns {Map<string, Record<string, unknown>>} Map keyed by lowercased template name
 */
function buildTemplateMapByKey(templates, allowedKeys) {
  const templatesByKey = new Map();

  for (const template of templates) {
    const templateKey = buildTemplateKey(template);
    if (!allowedKeys.has(templateKey)) {
      continue;
    }

    const templateName = getRequiredTemplateName(template);
    const templateLanguage = getRequiredTemplateLanguage(template);

    if (templatesByKey.has(templateKey)) {
      throw new Error(
        `Destination WABA has multiple templates for "${templateName}" in "${templateLanguage}". Resolve that before copying.`
      );
    }

    templatesByKey.set(templateKey, template);
  }

  return templatesByKey;
}

/**
 * Sanitizes one source template into a create payload.
 * @param {Record<string, unknown>} template - Source template
 * @returns {Record<string, unknown>} Sanitized create payload
 */
function sanitizeTemplateForCreate(template) {
  const payload = {
    category: getRequiredTemplateCategory(template),
    components: sanitizeTemplateComponents(template),
    language: getRequiredTemplateLanguage(template),
    name: getRequiredTemplateName(template),
  };

  const subCategory = normalizeOptionalString(template.sub_category);
  if (subCategory && ALLOWED_SUB_CATEGORIES.has(subCategory)) {
    payload.sub_category = subCategory;
  }

  const parameterFormat = normalizeOptionalString(template.parameter_format);
  if (parameterFormat) {
    payload.parameter_format = parameterFormat;
  }

  if (typeof template.message_send_ttl_seconds === "number") {
    payload.message_send_ttl_seconds = template.message_send_ttl_seconds;
  }

  return payload;
}

/**
 * Sanitizes the template components for create requests.
 * @param {Record<string, unknown>} template - Raw source template
 * @returns {Array<Record<string, unknown>>} Sanitized components
 */
function sanitizeTemplateComponents(template) {
  const components = template.components;
  if (!Array.isArray(components) || components.length === 0) {
    throw new Error("Template is missing components.");
  }

  if (getRequiredTemplateCategory(template) === "AUTHENTICATION") {
    return sanitizeAuthenticationTemplateComponents(components, getRequiredTemplateName(template));
  }

  return components.map((component) => {
    return /** @type {Record<string, unknown>} */ (sanitizeUnknownObject(component));
  });
}

/**
 * Converts the fetched AUTHENTICATION template shape into the create shape Meta expects.
 * @param {Array<Record<string, unknown>>} components - Raw fetched auth-template components
 * @param {string} templateName - Template name for error context
 * @returns {Array<Record<string, unknown>>} Sanitized auth-template components
 */
function sanitizeAuthenticationTemplateComponents(components, templateName) {
  return components.map((component) => {
    const componentType = normalizeOptionalString(component.type)?.toUpperCase();

    if (!componentType) {
      throw new Error(`Authentication template "${templateName}" has a component without type.`);
    }

    if (componentType === "BODY") {
      const sanitizedBody = { type: "BODY" };
      if (typeof component.add_security_recommendation === "boolean") {
        sanitizedBody.add_security_recommendation = component.add_security_recommendation;
      }
      return sanitizedBody;
    }

    if (componentType === "FOOTER") {
      const sanitizedFooter = { type: "FOOTER" };
      if (typeof component.code_expiration_minutes === "number") {
        sanitizedFooter.code_expiration_minutes = component.code_expiration_minutes;
      }
      return sanitizedFooter;
    }

    if (componentType === "BUTTONS") {
      const buttons = Array.isArray(component.buttons) ? component.buttons : [];
      if (buttons.length !== 1) {
        throw new Error(
          `Authentication template "${templateName}" must have exactly one button.`
        );
      }

      return {
        type: "BUTTONS",
        buttons: [sanitizeAuthenticationButton(buttons[0], templateName)],
      };
    }

    throw new Error(
      `Authentication template "${templateName}" contains unsupported component type "${componentType}".`
    );
  });
}

/**
 * Converts the fetched auth button shape into the create shape Meta expects.
 * @param {Record<string, unknown>} button - Raw fetched button
 * @param {string} templateName - Template name for error context
 * @returns {Record<string, unknown>} Sanitized auth button
 */
function sanitizeAuthenticationButton(button, templateName) {
  const sourceButtonType = normalizeOptionalString(button.type)?.toUpperCase() ?? null;
  const sourceButtonText = normalizeOptionalString(button.text);
  const sourceButtonOtpType = normalizeOptionalString(button.otp_type)?.toUpperCase() ?? null;
  const sourceButtonUrl = normalizeOptionalString(button.url);

  let otpType = sourceButtonOtpType;
  if (!otpType && sourceButtonUrl) {
    const normalizedUrl = sourceButtonUrl.toLowerCase();
    if (normalizedUrl.includes("otp_type=copy_code")) {
      otpType = "COPY_CODE";
    } else if (normalizedUrl.includes("otp_type=zero_tap")) {
      otpType = "ZERO_TAP";
    } else if (normalizedUrl.includes("otp_type=one_tap")) {
      otpType = "ONE_TAP";
    }
  }

  if (!otpType) {
    throw new Error(
      `Authentication template "${templateName}" has a button without a supported OTP type.`
    );
  }

  if (sourceButtonType && sourceButtonType !== "OTP" && sourceButtonType !== "URL") {
    throw new Error(
      `Authentication template "${templateName}" has unsupported button type "${sourceButtonType}".`
    );
  }

  const sanitizedButton = {
    type: "OTP",
    otp_type: otpType,
  };

  if (sourceButtonText) {
    sanitizedButton.text = sourceButtonText;
  }

  return sanitizedButton;
}

/**
 * Deep-sanitizes an object by dropping null and undefined values.
 * @param {unknown} value - Unknown JSON-like value
 * @returns {unknown} Sanitized copy
 */
function sanitizeUnknownObject(value) {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeUnknownObject(item));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const sanitizedEntries = Object.entries(value).flatMap(([key, entryValue]) => {
    if (entryValue === undefined || entryValue === null) {
      return [];
    }

    return [[key, sanitizeUnknownObject(entryValue)]];
  });

  return Object.fromEntries(sanitizedEntries);
}

/**
 * Parses a comma-separated argument value.
 * @param {string} rawValue - Raw comma-separated value
 * @param {string} label - Error label
 * @returns {string[]} Parsed non-empty items
 */
function parseCommaSeparatedList(rawValue, label) {
  const parsedItems = rawValue
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  if (parsedItems.length === 0) {
    throw new Error(`No ${label} were provided.`);
  }

  return parsedItems;
}

/**
 * Writes one JSON output file.
 * @param {string} fileName - Output file name
 * @param {Record<string, unknown>} payload - JSON payload to write
 * @returns {Promise<string>} Absolute output path
 */
async function writeOutputFile(fileName, payload) {
  const currentFilePath = fileURLToPath(import.meta.url);
  const currentDirectoryPath = path.dirname(currentFilePath);
  const outputDirectoryPath = path.join(currentDirectoryPath, "output");
  const outputFilePath = path.join(outputDirectoryPath, fileName);

  await mkdir(outputDirectoryPath, { recursive: true });
  await writeFile(outputFilePath, JSON.stringify(payload, null, 2), "utf8");

  return outputFilePath;
}

/**
 * Returns a required env var value.
 * @param {string} envName - Env var name
 * @returns {string} Trimmed env var value
 */
function getRequiredEnv(envName) {
  const envValue = process.env[envName]?.trim();
  if (!envValue) {
    throw new Error(`${envName} is required.`);
  }

  return envValue;
}

/**
 * Normalizes the Graph API version into the `vNN.0` format.
 * @param {string} rawApiVersion - Raw env var value
 * @returns {string} Normalized API version
 */
function normalizeApiVersion(rawApiVersion) {
  const normalizedVersion = rawApiVersion.trim().replace(/^v/i, "");
  if (!/^\d+(\.\d+)?$/.test(normalizedVersion)) {
    throw new Error(`WHATSAPP_API_VERSION must look like 23 or 23.0. Received "${rawApiVersion}".`);
  }

  if (normalizedVersion.includes(".")) {
    return `v${normalizedVersion}`;
  }

  return `v${normalizedVersion}.0`;
}

/**
 * Returns the required template name.
 * @param {Record<string, unknown>} template - Template candidate
 * @returns {string} Valid template name
 */
function getRequiredTemplateName(template) {
  const templateName = normalizeOptionalString(template.name);
  if (!templateName) {
    throw new Error("Template is missing name.");
  }

  return templateName;
}

/**
 * Returns the required template language.
 * @param {Record<string, unknown>} template - Template candidate
 * @returns {string} Valid template language
 */
function getRequiredTemplateLanguage(template) {
  const templateLanguage = normalizeOptionalString(template.language);
  if (!templateLanguage) {
    throw new Error(`Template "${getRequiredTemplateName(template)}" is missing language.`);
  }

  return templateLanguage;
}

/**
 * Returns the required template category.
 * @param {Record<string, unknown>} template - Template candidate
 * @returns {string} Valid template category
 */
function getRequiredTemplateCategory(template) {
  const templateCategory = normalizeOptionalString(template.category);
  if (!templateCategory) {
    throw new Error(`Template "${getRequiredTemplateName(template)}" is missing category.`);
  }

  return templateCategory;
}

/**
 * Returns the required template status.
 * @param {Record<string, unknown>} template - Template candidate
 * @returns {string} Uppercased status
 */
function getRequiredTemplateStatus(template) {
  const templateStatus = normalizeOptionalString(template.status);
  if (!templateStatus) {
    throw new Error(`Template "${getRequiredTemplateName(template)}" is missing status.`);
  }

  return templateStatus.toUpperCase();
}

/**
 * Normalizes a string-like value.
 * @param {unknown} value - Unknown value
 * @returns {string | null} Trimmed string, or null
 */
function normalizeOptionalString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Builds the lookup key for a template.
 * @param {Record<string, unknown>} template - Template candidate
 * @returns {string} Lowercased name + language key
 */
function buildTemplateKey(template) {
  return `${getRequiredTemplateName(template).toLowerCase()}::${getRequiredTemplateLanguage(template).toLowerCase()}`;
}

/**
 * Removes wrapping single or double quotes from an env value.
 * @param {string} value - Raw env value
 * @returns {string} Unwrapped env value
 */
function stripWrappingQuotes(value) {
  if (
    (value.startsWith("\"") && value.endsWith("\""))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

/**
 * Parses JSON when possible.
 * @param {string} rawValue - Raw JSON string
 * @returns {Record<string, unknown> | null} Parsed value, or null when parsing fails
 */
function tryParseJson(rawValue) {
  try {
    return /** @type {Record<string, unknown>} */ (JSON.parse(rawValue));
  } catch {
    return null;
  }
}
