export type CallPhase =
  | "ready"
  | "requesting-microphone"
  | "connecting"
  | "active"
  | "ended"
  | "error";

export interface CallUiState {
  callActive: boolean;
  phase: CallPhase;
  status: string;
}

export type CallUiEvent =
  | { type: "reset" }
  | { type: "connecting" }
  | { type: "requesting-microphone" }
  | { type: "transport-connected" }
  | { type: "assistant-audio-started" }
  | { type: "ended" }
  | { type: "error" };

export const INITIAL_CALL_UI_STATE: CallUiState = {
  callActive: false,
  phase: "ready",
  status: "Ready",
};

export function transitionCallUiState(
  state: CallUiState,
  event: CallUiEvent
): CallUiState {
  switch (event.type) {
    case "connecting":
      return { callActive: false, phase: "connecting", status: "Connecting..." };
    case "requesting-microphone":
      return {
        callActive: false,
        phase: "requesting-microphone",
        status: "Setting up audio...",
      };
    case "transport-connected":
      return { ...state, status: "Connected" };
    case "assistant-audio-started":
      return { callActive: true, phase: "active", status: "Call active" };
    case "ended":
      return { callActive: false, phase: "ended", status: "Ready" };
    case "error":
      return { callActive: false, phase: "error", status: "Ready" };
    case "reset":
    default:
      return INITIAL_CALL_UI_STATE;
  }
}
