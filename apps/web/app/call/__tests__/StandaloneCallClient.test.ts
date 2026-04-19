import { describe, expect, it } from "vitest";

import { transitionCallUiState } from "../callUiState";

describe("transitionCallUiState", () => {
  it("does not mark the call active when transport connects", () => {
    const connecting = transitionCallUiState(
      { callActive: false, phase: "connecting", status: "Connecting..." },
      { type: "transport-connected" }
    );

    expect(connecting.callActive).toBe(false);
    expect(connecting.phase).toBe("connecting");
    expect(connecting.status).toBe("Connected");
  });

  it("marks the call active only when assistant audio starts", () => {
    const active = transitionCallUiState(
      { callActive: false, phase: "connecting", status: "Connected" },
      { type: "assistant-audio-started" }
    );

    expect(active.callActive).toBe(true);
    expect(active.phase).toBe("active");
    expect(active.status).toBe("Call active");
  });
});
