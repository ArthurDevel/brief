function normalize(url: string): URL {
  try {
    return new URL(url);
  } catch {
    throw new Error("LIVEKIT_URL must be a valid ws://, wss://, http://, or https:// URL");
  }
}

export function toWebSocketUrl(rawUrl: string): string {
  const url = normalize(rawUrl);
  if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("LIVEKIT_URL must start with ws://, wss://, http://, or https://");
  }
  return url.toString().replace(/\/$/, "");
}

export function toHttpUrl(rawUrl: string): string {
  const url = normalize(rawUrl);
  if (url.protocol === "wss:") {
    url.protocol = "https:";
  } else if (url.protocol === "ws:") {
    url.protocol = "http:";
  } else if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("LIVEKIT_URL must start with ws://, wss://, http://, or https://");
  }
  return url.toString().replace(/\/$/, "");
}
