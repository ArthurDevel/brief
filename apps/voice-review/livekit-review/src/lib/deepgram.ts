import { SAMPLE_RATE } from "../shared/constants.js";

export async function callDeepgramTts(
  text: string,
  voice: string,
  apiKey: string,
  sampleRate = SAMPLE_RATE
): Promise<Int16Array> {
  const url = new URL("https://api.deepgram.com/v1/speak");
  url.searchParams.set("model", voice);
  url.searchParams.set("encoding", "linear16");
  url.searchParams.set("sample_rate", String(sampleRate));
  url.searchParams.set("container", "none");

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Token ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ text })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Deepgram TTS failed (${response.status}): ${errorText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return new Int16Array(arrayBuffer.slice(0));
}
