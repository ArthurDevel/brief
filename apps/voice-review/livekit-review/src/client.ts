import {
  DisconnectReason,
  Room,
  RoomEvent,
  Track
} from "livekit-client";

// ============================================================================
// TYPES
// ============================================================================

interface ProviderOption {
  id: string;
  label: string;
}

interface VoiceOption {
  id: string;
  provider: string;
  name: string;
  accent: string | null;
  gender: string | null;
}

interface OptionsResponse {
  ttsProviders: ProviderOption[];
  sttProviders: ProviderOption[];
  voices: VoiceOption[];
}

interface LiveKitSessionResponse {
  roomName: string;
  token: string;
  url: string;
}

type ConversationMode = "chat" | "demo";

// ============================================================================
// ELEMENTS
// ============================================================================

const ttsProviderSelect = document.getElementById("ttsProviderSelect") as HTMLSelectElement;
const sttProviderSelect = document.getElementById("sttProviderSelect") as HTMLSelectElement;
const voiceGrid = document.getElementById("voiceGrid") as HTMLDivElement;
const speedSlider = document.getElementById("speedSlider") as HTMLInputElement;
const speedValue = document.getElementById("speedValue") as HTMLSpanElement;
const sampleText = document.getElementById("sampleText") as HTMLTextAreaElement;
const generateButton = document.getElementById("generateBtn") as HTMLButtonElement;
const generateStatus = document.getElementById("generateStatus") as HTMLSpanElement;
const playerSection = document.getElementById("playerSection") as HTMLDivElement;
const audioPlayer = document.getElementById("audioPlayer") as HTMLAudioElement;
const startCallButton = document.getElementById("startCallBtn") as HTMLButtonElement;
const endCallButton = document.getElementById("endCallBtn") as HTMLButtonElement;
const callStatus = document.getElementById("callStatus") as HTMLSpanElement;
const callTimer = document.getElementById("callTimer") as HTMLSpanElement;
const remoteAudioContainer = document.getElementById("remoteAudioContainer") as HTMLDivElement;
const modeSelect = document.getElementById("modeSelect") as HTMLSelectElement;
const demoBriefSection = document.getElementById("demoBriefSection") as HTMLDivElement;
const demoBriefInput = document.getElementById("demoBrief") as HTMLTextAreaElement;

// ============================================================================
// STATE
// ============================================================================

let selectedTtsProvider = "deepgram";
let selectedSttProvider = "deepgram";
let selectedVoice = "";
let ttsProviders: ProviderOption[] = [];
let sttProviders: ProviderOption[] = [];
let voices: VoiceOption[] = [];
let room: Room | null = null;
let callTimerInterval: number | null = null;
let callStartTime = 0;

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Returns the currently selected conversation mode.
 * @returns Chat or demo mode
 */
function getConversationMode(): ConversationMode {
  return modeSelect.value === "demo" ? "demo" : "chat";
}

/**
 * Returns the active voices for the selected TTS provider.
 * @returns Provider-specific voice list
 */
function getVisibleVoices(): VoiceOption[] {
  return voices.filter((voice) => {
    return voice.provider === selectedTtsProvider;
  });
}

/**
 * Returns the current playback speed.
 * @returns Speed multiplier
 */
function getSpeed(): number {
  return Number.parseFloat(speedSlider.value);
}

/**
 * Renders the demo brief section for the selected mode.
 * @returns Nothing
 */
function updateModeUi(): void {
  demoBriefSection.style.display = getConversationMode() === "demo" ? "block" : "none";
}

/**
 * Writes one preview status message.
 * @param message - Status copy
 * @param isError - Whether this is an error state
 * @returns Nothing
 */
function setGenerateStatus(message: string, isError = false): void {
  generateStatus.textContent = message;
  generateStatus.className = isError ? "status error" : "status";
}

/**
 * Populates a provider select element.
 * @param element - Target select element
 * @param options - Provider options
 * @param selectedValue - Selected provider ID
 * @returns Nothing
 */
function populateProviderSelect(
  element: HTMLSelectElement,
  options: ProviderOption[],
  selectedValue: string
): void {
  element.innerHTML = "";

  for (const option of options) {
    const elementOption = document.createElement("option");
    elementOption.value = option.id;
    elementOption.textContent = option.label;
    elementOption.selected = option.id === selectedValue;
    element.appendChild(elementOption);
  }
}

/**
 * Ensures the selected voice belongs to the selected provider.
 * @returns Nothing
 */
function syncSelectedVoice(): void {
  const visibleVoices = getVisibleVoices();
  const hasSelectedVoice = visibleVoices.some((voice) => voice.id === selectedVoice);

  if (hasSelectedVoice) {
    return;
  }

  selectedVoice = visibleVoices[0]?.id ?? "";
}

/**
 * Renders the voice selection grid.
 * @returns Nothing
 */
function renderVoiceGrid(): void {
  voiceGrid.innerHTML = "";

  for (const voice of getVisibleVoices()) {
    const option = document.createElement("div");
    option.className = `voice-option${voice.id === selectedVoice ? " selected" : ""}`;
    option.dataset.voiceId = voice.id;

    const metaParts = [voice.accent, voice.gender].filter(Boolean);
    const metaText = metaParts.length > 0 ? metaParts.join(" · ") : voice.provider.toUpperCase();

    option.innerHTML = `
      <input type="radio" name="voice" value="${voice.id}" />
      <div>
        <div class="voice-name">${voice.name}</div>
        <div class="voice-meta">${metaText}</div>
      </div>
    `;

    option.addEventListener("click", () => {
      selectVoice(voice.id);
    });

    voiceGrid.appendChild(option);
  }
}

/**
 * Updates the selected voice and grid state.
 * @param voiceId - Selected voice ID
 * @returns Nothing
 */
function selectVoice(voiceId: string): void {
  selectedVoice = voiceId;
  document.querySelectorAll<HTMLElement>(".voice-option").forEach((element) => {
    element.classList.toggle("selected", element.dataset.voiceId === voiceId);
  });
}

/**
 * Applies the selected TTS provider to the UI.
 * @param providerId - Selected provider ID
 * @returns Nothing
 */
function selectTtsProvider(providerId: string): void {
  selectedTtsProvider = providerId;
  syncSelectedVoice();
  renderVoiceGrid();
}

/**
 * Clears hidden remote audio elements.
 * @returns Nothing
 */
function clearRemoteAudio(): void {
  remoteAudioContainer.querySelectorAll("audio").forEach((element) => element.remove());
}

/**
 * Updates the on-screen call timer.
 * @returns Nothing
 */
function updateCallTimer(): void {
  const elapsedSeconds = Math.floor((Date.now() - callStartTime) / 1000);
  const minutes = String(Math.floor(elapsedSeconds / 60)).padStart(2, "0");
  const seconds = String(elapsedSeconds % 60).padStart(2, "0");
  callTimer.textContent = `${minutes}:${seconds}`;
}

/**
 * Resets the call UI to an idle state.
 * @param statusText - Status message to show
 * @param isError - Whether this is an error state
 * @returns Nothing
 */
function resetCallUi(statusText = "Ready", isError = false): void {
  startCallButton.style.display = "inline-flex";
  startCallButton.disabled = false;
  endCallButton.style.display = "none";
  callTimer.style.display = "none";
  callTimer.textContent = "00:00";
  callStatus.textContent = statusText;
  callStatus.className = isError ? "call-status error" : "call-status";
}

/**
 * Disconnects the active call and resets the UI.
 * @param statusText - Status message to show
 * @param isError - Whether this is an error state
 * @returns Nothing
 */
async function cleanupCall(statusText = "Ready", isError = false): Promise<void> {
  if (callTimerInterval !== null) {
    window.clearInterval(callTimerInterval);
    callTimerInterval = null;
  }

  if (room) {
    room.removeAllListeners();
    room.localParticipant.trackPublications.forEach((publication) => {
      publication.track?.stop();
    });
    await room.disconnect(true);
    room = null;
  }

  clearRemoteAudio();
  resetCallUi(statusText, isError);
}

/**
 * Loads provider and voice options from the server.
 * @returns Nothing
 */
async function loadOptions(): Promise<void> {
  const response = await fetch("/api/options");
  const data = await response.json() as OptionsResponse;

  ttsProviders = data.ttsProviders;
  sttProviders = data.sttProviders;
  voices = data.voices;

  selectedTtsProvider = ttsProviders[0]?.id ?? "deepgram";
  selectedSttProvider = sttProviders[0]?.id ?? "deepgram";

  populateProviderSelect(ttsProviderSelect, ttsProviders, selectedTtsProvider);
  populateProviderSelect(sttProviderSelect, sttProviders, selectedSttProvider);
  syncSelectedVoice();
  renderVoiceGrid();
}

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Generates one preview clip for the selected TTS provider.
 * @returns Nothing
 */
async function generatePreview(): Promise<void> {
  const text = sampleText.value.trim();
  if (!text) {
    setGenerateStatus("Please enter some text.", true);
    return;
  }

  generateButton.disabled = true;
  setGenerateStatus("Generating...");
  playerSection.classList.remove("visible");

  try {
    const response = await fetch("/generate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        ttsProvider: selectedTtsProvider,
        voice: selectedVoice,
        speed: getSpeed(),
        text
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(errorText);
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    if (audioPlayer.src.startsWith("blob:")) {
      URL.revokeObjectURL(audioPlayer.src);
    }

    audioPlayer.src = url;
    playerSection.classList.add("visible");
    await audioPlayer.play().catch(() => undefined);

    const voiceName = voices.find((voice) => voice.id === selectedVoice)?.name ?? selectedVoice;
    const providerLabel = ttsProviders.find((provider) => provider.id === selectedTtsProvider)?.label ?? selectedTtsProvider;
    setGenerateStatus(`${providerLabel} · ${voiceName} · ${getSpeed().toFixed(2)}x`);
  } catch (error) {
    setGenerateStatus(`Error: ${(error as Error).message}`, true);
  } finally {
    generateButton.disabled = false;
  }
}

/**
 * Starts one LiveKit review call.
 * @returns Nothing
 */
async function startCall(): Promise<void> {
  startCallButton.disabled = true;
  callStatus.textContent = "Connecting...";
  callStatus.className = "call-status";

  try {
    const response = await fetch("/api/livekit/session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        ttsProvider: selectedTtsProvider,
        sttProvider: selectedSttProvider,
        voice: selectedVoice,
        speed: getSpeed(),
        mode: getConversationMode(),
        demoBrief: demoBriefInput.value.trim()
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(errorText);
    }

    const session = await response.json() as LiveKitSessionResponse;
    room = new Room({
      adaptiveStream: true,
      dynacast: true
    });

    room
      .on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind !== Track.Kind.Audio) {
          return;
        }

        const element = track.attach();
        element.autoplay = true;
        remoteAudioContainer.appendChild(element);
        void element.play().catch(() => undefined);
      })
      .on(RoomEvent.TrackUnsubscribed, (track) => {
        track.detach().forEach((element) => element.remove());
      })
      .on(RoomEvent.Disconnected, (reason) => {
        const isExpected = reason === DisconnectReason.CLIENT_INITIATED;
        void cleanupCall(isExpected ? "Ready" : "Disconnected", !isExpected);
      });

    await room.connect(session.url, session.token);
    await room.localParticipant.setMicrophoneEnabled(true);

    startCallButton.style.display = "none";
    endCallButton.style.display = "inline-flex";
    callTimer.style.display = "inline";
    callStatus.textContent = "Connected";
    callStatus.className = "call-status active";
    callStartTime = Date.now();
    callTimerInterval = window.setInterval(updateCallTimer, 1000);
  } catch (error) {
    await cleanupCall(`Error: ${(error as Error).message}`, true);
  }
}

/**
 * Ends the active LiveKit review call.
 * @returns Nothing
 */
async function endCall(): Promise<void> {
  await cleanupCall();
}

/**
 * Loads initial state and binds the UI.
 * @returns Nothing
 */
async function init(): Promise<void> {
  await loadOptions();
  updateModeUi();
}

// ============================================================================
// EVENT BINDINGS
// ============================================================================

document.querySelectorAll<HTMLElement>(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll<HTMLElement>(".tab").forEach((element) => {
      element.classList.remove("active");
    });
    document.querySelectorAll<HTMLElement>(".tab-content").forEach((element) => {
      element.classList.remove("active");
    });
    tab.classList.add("active");
    document.getElementById(`tab-${tab.dataset.tab}`)?.classList.add("active");
  });
});

ttsProviderSelect.addEventListener("change", () => {
  selectTtsProvider(ttsProviderSelect.value);
});

sttProviderSelect.addEventListener("change", () => {
  selectedSttProvider = sttProviderSelect.value;
});

speedSlider.addEventListener("input", () => {
  speedValue.textContent = `${getSpeed().toFixed(2)}x`;
});

modeSelect.addEventListener("change", () => {
  updateModeUi();
});

generateButton.addEventListener("click", () => {
  void generatePreview();
});

startCallButton.addEventListener("click", () => {
  void startCall();
});

endCallButton.addEventListener("click", () => {
  void endCall();
});

void init();
