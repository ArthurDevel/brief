/**
 * Fetches and parses LiveKit public pricing pages for WhatsApp session costing.
 *
 * Responsibilities:
 * - Fetch inference pricing and agent-session-minute pricing from LiveKit
 * - Cache parsed pricing for a short TTL
 * - Calculate a session cost from stored LiveKit model usage
 */

// ============================================================================
// CONSTANTS
// ============================================================================

const AGENT_PRICING_URL = "https://livekit.com/products/agent-cloud-deployment";
const BASIC_PRICING_TIER = "build";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const INFERENCE_PRICING_URL = "https://livekit.com/pricing/inference";

// ============================================================================
// TYPES
// ============================================================================

export interface SessionModelUsage {
  audioDurationMs?: number;
  charactersCount?: number;
  inputCachedTokens?: number;
  inputTokens?: number;
  model?: string;
  outputTokens?: number;
  provider?: string;
  type?: string;
}

interface CachedPricing {
  expiresAt: number;
  pricing: LiveKitPricing;
}

interface LiveKitPricing {
  agentSessionUsdPerMinute: number;
  gpt41MiniCachedInputUsdPerMillion: number;
  gpt41MiniInputUsdPerMillion: number;
  gpt41MiniOutputUsdPerMillion: number;
  nova3MonolingualUsdPerMinute: number;
  pricingTier: LiveKitPricingTier;
  sonic3UsdPerMillionChars: number;
}

type LiveKitPricingTier = "build" | "scale";

// ============================================================================
// MODULE STATE
// ============================================================================

let cachedPricing: CachedPricing | null = null;

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Loads the current LiveKit pricing snapshot with a simple in-memory cache.
 * @returns Parsed pricing values used for WhatsApp session cost calculation
 */
export async function getLiveKitPricing(): Promise<LiveKitPricing> {
  if (cachedPricing && cachedPricing.expiresAt > Date.now()) {
    return cachedPricing.pricing;
  }

  const [inferenceHtml, agentHtml] = await Promise.all([
    fetchPricingPage(INFERENCE_PRICING_URL),
    fetchPricingPage(AGENT_PRICING_URL),
  ]);

  const llmPrices = extractLlmPricing(inferenceHtml, "GPT-4.1 mini", "OpenAI");
  const nova3Prices = extractTieredPricing(inferenceHtml, "Nova-3 (Monolingual)");
  const sonic3Prices = extractTieredPricing(inferenceHtml, "Sonic 3");
  const agentSessionUsdPerMinute = extractAgentMinutePricing(agentHtml);

  const pricing: LiveKitPricing = {
    agentSessionUsdPerMinute,
    gpt41MiniCachedInputUsdPerMillion: llmPrices.cachedInputUsdPerMillion,
    gpt41MiniInputUsdPerMillion: llmPrices.inputUsdPerMillion,
    gpt41MiniOutputUsdPerMillion: llmPrices.outputUsdPerMillion,
    nova3MonolingualUsdPerMinute: BASIC_PRICING_TIER === "build"
      ? nova3Prices.buildUsd
      : nova3Prices.scaleUsd,
    pricingTier: BASIC_PRICING_TIER,
    sonic3UsdPerMillionChars: BASIC_PRICING_TIER === "build"
      ? sonic3Prices.buildUsd
      : sonic3Prices.scaleUsd,
  };

  cachedPricing = {
    expiresAt: Date.now() + CACHE_TTL_MS,
    pricing,
  };

  return pricing;
}

/**
 * Calculates the total session cost in USD from stored usage and duration.
 * @param modelUsage - Raw LiveKit model usage records from the session row
 * @param durationSeconds - Session duration in seconds
 * @param pricing - Parsed LiveKit pricing snapshot
 * @returns Session cost rounded to four decimals
 */
export function calculateSessionCostUsd(
  modelUsage: SessionModelUsage[],
  durationSeconds: number,
  pricing: LiveKitPricing
): number {
  let totalCostUsd = 0;

  totalCostUsd += (durationSeconds / 60) * pricing.agentSessionUsdPerMinute;

  for (const usage of modelUsage) {
    if (usage.type === "llm_usage") {
      totalCostUsd += calculateLlmUsageCost(usage, pricing);
      continue;
    }

    if (usage.type === "stt_usage") {
      totalCostUsd += calculateSttUsageCost(usage, pricing);
      continue;
    }

    if (usage.type === "tts_usage") {
      totalCostUsd += calculateTtsUsageCost(usage, pricing);
    }
  }

  return roundUsd(totalCostUsd);
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Fetches a public LiveKit pricing page.
 * @param url - Public page URL to fetch
 * @returns Page HTML with preserved inline data
 */
async function fetchPricingPage(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "brief-whatsapp-cost-fetcher/1.0",
    },
    next: { revalidate: 0 },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch LiveKit pricing page (${response.status}): ${url}`);
  }

  return response.text();
}

/**
 * Extracts the LLM row prices for a specific model/provider pair.
 * @param html - Inference pricing page HTML
 * @param modelLabel - Visible model label on the pricing page
 * @param providerLabel - Visible provider label on the pricing page
 * @returns Parsed input, cached input, and output prices
 */
function extractLlmPricing(
  html: string,
  modelLabel: string,
  providerLabel: string
): {
  cachedInputUsdPerMillion: number;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
} {
  const normalizedHtml = normalizeHtml(html);
  const pattern = new RegExp(
    `${escapeRegex(modelLabel)}[\\s\\S]*?<\\/div><\\/td><td>${escapeRegex(providerLabel)}<\\/td><td class="text-right font-mono">\\$([0-9.]+)<\\/td><td class="text-right font-mono">\\$([0-9.]+)<\\/td><td class="text-right font-mono">\\$([0-9.]+)<\\/td>`
  );
  const match = normalizedHtml.match(pattern);

  if (!match) {
    throw new Error(`Could not parse LLM pricing for ${modelLabel} (${providerLabel}).`);
  }

  return {
    inputUsdPerMillion: parseUsd(match[1]),
    cachedInputUsdPerMillion: parseUsd(match[2]),
    outputUsdPerMillion: parseUsd(match[3]),
  };
}

/**
 * Extracts a row with build and scale prices from the inference pricing page.
 * @param html - Inference pricing page HTML
 * @param modelLabel - Visible model label on the pricing page
 * @returns Parsed build and scale prices
 */
function extractTieredPricing(
  html: string,
  modelLabel: string
): { buildUsd: number; scaleUsd: number } {
  const normalizedHtml = normalizeHtml(html);
  const pattern = new RegExp(
    `${escapeRegex(modelLabel)}[\\s\\S]*?<\\/div><\\/td><td class="text-right font-mono">\\$([0-9.]+)<\\/td><td class="text-right font-mono">\\$([0-9.]+)<\\/td>`
  );
  const match = normalizedHtml.match(pattern);

  if (!match) {
    throw new Error(`Could not parse tiered pricing for ${modelLabel}.`);
  }

  return {
    buildUsd: parseUsd(match[1]),
    scaleUsd: parseUsd(match[2]),
  };
}

/**
 * Extracts the public agent-session-minute price from the agent pricing page.
 * @param html - Agent Cloud deployment page HTML
 * @returns Price in USD per minute
 */
function extractAgentMinutePricing(html: string): number {
  const match = html.match(/billed at \$([0-9.]+)\/minute/i);
  if (!match) {
    throw new Error("Could not parse LiveKit agent session minute pricing.");
  }

  return parseUsd(match[1]);
}

/**
 * Computes LLM cost for a single usage record.
 * @param usage - Stored LLM usage record
 * @param pricing - Parsed LiveKit pricing snapshot
 * @returns Cost contribution in USD
 */
function calculateLlmUsageCost(
  usage: SessionModelUsage,
  pricing: LiveKitPricing
): number {
  const provider = resolveUsageProvider(usage);
  const model = normalizeModelKey(usage.model);

  if (provider !== "openai" || model !== "gpt-4.1-mini") {
    throw new Error(`Unsupported LLM usage for cost calculation: ${usage.provider}/${usage.model}`);
  }

  const inputTokens = usage.inputTokens ?? 0;
  const cachedInputTokens = usage.inputCachedTokens ?? 0;
  const nonCachedInputTokens = Math.max(0, inputTokens - cachedInputTokens);
  const outputTokens = usage.outputTokens ?? 0;

  return (
    (nonCachedInputTokens / 1_000_000) * pricing.gpt41MiniInputUsdPerMillion
    + (cachedInputTokens / 1_000_000) * pricing.gpt41MiniCachedInputUsdPerMillion
    + (outputTokens / 1_000_000) * pricing.gpt41MiniOutputUsdPerMillion
  );
}

/**
 * Computes STT cost for a single usage record.
 * @param usage - Stored STT usage record
 * @param pricing - Parsed LiveKit pricing snapshot
 * @returns Cost contribution in USD
 */
function calculateSttUsageCost(
  usage: SessionModelUsage,
  pricing: LiveKitPricing
): number {
  const provider = resolveUsageProvider(usage);
  const model = normalizeModelKey(usage.model);

  if (provider !== "deepgram" || (model !== "nova-3:en" && model !== "nova-3")) {
    throw new Error(`Unsupported STT usage for cost calculation: ${usage.provider}/${usage.model}`);
  }

  return ((usage.audioDurationMs ?? 0) / 60_000) * pricing.nova3MonolingualUsdPerMinute;
}

/**
 * Computes TTS cost for a single usage record.
 * @param usage - Stored TTS usage record
 * @param pricing - Parsed LiveKit pricing snapshot
 * @returns Cost contribution in USD
 */
function calculateTtsUsageCost(
  usage: SessionModelUsage,
  pricing: LiveKitPricing
): number {
  const provider = resolveUsageProvider(usage);
  const model = normalizeModelKey(usage.model);

  if (provider !== "cartesia" || !model.startsWith("sonic-3")) {
    throw new Error(`Unsupported TTS usage for cost calculation: ${usage.provider}/${usage.model}`);
  }

  return ((usage.charactersCount ?? 0) / 1_000_000) * pricing.sonic3UsdPerMillionChars;
}

/**
 * Normalizes a provider or model identifier for comparison.
 * @param value - Raw provider or model string
 * @returns Lowercased normalized string
 */
function normalizeKey(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

/**
 * Normalizes a provider key and strips an optional LiveKit namespace prefix.
 * @param value - Raw provider string, for example "openai" or "livekit/openai"
 * @returns Normalized provider slug
 */
function normalizeProviderKey(value: string | undefined): string {
  const normalizedValue = normalizeKey(value);
  if (!normalizedValue) {
    return "";
  }

  const segments = normalizedValue.split("/");
  return segments[segments.length - 1] ?? "";
}

/**
 * Normalizes a model key and strips an optional vendor prefix.
 * @param value - Raw model string, for example "gpt-4.1-mini" or "openai/gpt-4.1-mini"
 * @returns Normalized model slug
 */
function normalizeModelKey(value: string | undefined): string {
  const normalizedValue = normalizeKey(value);
  if (!normalizedValue) {
    return "";
  }

  const segments = normalizedValue.split("/");
  return segments[segments.length - 1] ?? "";
}

/**
 * Resolves the effective provider for one usage row.
 * @param usage - Stored usage row
 * @returns Normalized provider slug
 */
function resolveUsageProvider(usage: SessionModelUsage): string {
  const provider = normalizeProviderKey(usage.provider);
  if (provider && provider !== "livekit") {
    return provider;
  }

  const normalizedModel = normalizeKey(usage.model);
  const modelSegments = normalizedModel.split("/");
  if (modelSegments.length > 1) {
    return modelSegments[0] ?? "";
  }

  return provider;
}

/**
 * Removes line breaks and HTML comment separators so regex parsing is stable.
 * @param html - Raw HTML response
 * @returns Normalized HTML string
 */
function normalizeHtml(html: string): string {
  return html.replaceAll("<!-- -->", "").replace(/\s+/g, " ");
}

/**
 * Escapes regex control characters in a plain-text label.
 * @param value - Raw label text
 * @returns Regex-safe string
 */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Parses a USD string into a finite number.
 * @param value - Raw numeric string
 * @returns Parsed USD number
 */
function parseUsd(value: string): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid USD value: ${value}`);
  }

  return parsed;
}

/**
 * Rounds a USD amount to four decimal places for storage.
 * @param value - Raw USD value
 * @returns Rounded USD amount
 */
function roundUsd(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
