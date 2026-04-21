/**
 * xAI speech helpers used by the voice review app.
 *
 * Responsibilities:
 * - Call the xAI TTS REST API
 * - Return raw PCM16 audio for downstream post-processing
 */

import { SAMPLE_RATE } from "../shared/constants.js";

// ============================================================================
// CONSTANTS
// ============================================================================

const XAI_TTS_URL = "https://api.x.ai/v1/tts";

// ============================================================================
// MAIN HELPERS
// ============================================================================

/**
 * Synthesizes speech with xAI and returns raw PCM16 audio.
 * @param text - Input text to synthesize
 * @param voiceId - xAI voice ID
 * @param apiKey - xAI API key
 * @param sampleRate - Output sample rate in Hz
 * @returns PCM16 audio samples
 */
export async function callXaiTts(
  text: string,
  voiceId: string,
  apiKey: string,
  sampleRate = SAMPLE_RATE
): Promise<Int16Array> {
  const response = await fetch(XAI_TTS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      voice_id: voiceId,
      language: "en",
      output_format: {
        codec: "pcm",
        sample_rate: sampleRate,
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`xAI TTS failed (${response.status}): ${errorText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return new Int16Array(arrayBuffer.slice(0));
}
