/**
 * API route that proxies Deepgram's models endpoint to return available TTS voices.
 *
 * Fetches from GET https://api.deepgram.com/v1/models, filters to TTS models
 * in the aura-2 family, and returns a simplified list with preview sample URLs.
 *
 * Responsibilities:
 * - Proxy Deepgram API to avoid exposing the API key to the frontend
 * - Filter and simplify the response to only TTS voice data
 * - Cache the response for 1 hour (voices don't change often)
 */

import { NextResponse } from "next/server";

// ============================================================================
// TYPES
// ============================================================================

interface DeepgramModelMetadata {
  accent?: string;
  sample?: string;
  tags?: string[];
}

interface DeepgramModel {
  name: string;
  canonical_name: string;
  architecture: string;
  languages: string[];
  metadata: DeepgramModelMetadata;
}

interface DeepgramModelsResponse {
  tts: DeepgramModel[];
}

/** Simplified voice entry returned to the frontend. */
export interface DeepgramVoice {
  name: string;
  canonicalName: string;
  accent: string;
  language: string;
  sampleUrl: string | null;
}

// ============================================================================
// MAIN HANDLER
// ============================================================================

/**
 * Fetches available Deepgram TTS voices and returns a simplified list.
 * @returns JSON array of DeepgramVoice objects
 */
export async function GET(): Promise<NextResponse<DeepgramVoice[] | { error: string }>> {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    throw new Error("DEEPGRAM_API_KEY is not configured");
  }

  const response = await fetch("https://api.deepgram.com/v1/models", {
    headers: { Authorization: `Token ${apiKey}` },
    next: { revalidate: 3600 },
  });

  if (!response.ok) {
    throw new Error(`Deepgram API error: ${response.status} ${response.statusText}`);
  }

  const data: DeepgramModelsResponse = await response.json();

  // Filter to aura-2 voices only and map to simplified format
  const voices: DeepgramVoice[] = data.tts
    .filter((model) => model.architecture === "aura-2" && model.canonical_name.endsWith("-en"))
    .map((model) => ({
      name: model.name,
      canonicalName: model.canonical_name,
      accent: model.metadata.accent ?? "unknown",
      language: model.languages.find((l) => l.startsWith("en")) ?? model.languages[0] ?? "en",
      sampleUrl: model.metadata.sample ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (voices.length === 0) {
    throw new Error(
      `No aura-2 voices found. Deepgram returned ${data.tts?.length ?? 0} TTS models total. ` +
      `Check that the API key has access to aura-2 voices.`
    );
  }

  return NextResponse.json(voices);
}
