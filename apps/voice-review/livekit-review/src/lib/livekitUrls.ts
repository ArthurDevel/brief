export function toWebSocketUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("LIVEKIT_URL is required");
  }

  if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) {
    return trimmed;
  }

  if (trimmed.startsWith("http://")) {
    return `ws://${trimmed.slice("http://".length)}`;
  }

  if (trimmed.startsWith("https://")) {
    return `wss://${trimmed.slice("https://".length)}`;
  }

  throw new Error("LIVEKIT_URL must start with ws://, wss://, http://, or https://");
}

export function toHttpUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("LIVEKIT_URL is required");
  }

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed;
  }

  if (trimmed.startsWith("ws://")) {
    return `http://${trimmed.slice("ws://".length)}`;
  }

  if (trimmed.startsWith("wss://")) {
    return `https://${trimmed.slice("wss://".length)}`;
  }

  throw new Error("LIVEKIT_URL must start with ws://, wss://, http://, or https://");
}
