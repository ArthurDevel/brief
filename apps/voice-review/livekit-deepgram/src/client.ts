import {
  DisconnectReason,
  Room,
  RoomEvent,
  Track
} from "livekit-client";

interface VoiceOption {
  id: string;
  name: string;
  accent: string;
  gender: string;
}

interface LiveKitSessionResponse {
  roomName: string;
  token: string;
  url: string;
}

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

let selectedVoice = "aura-2-andromeda-en";
let voices: VoiceOption[] = [];
let room: Room | null = null;
let callTimerInterval: number | null = null;
let callStartTime = 0;

async function loadVoices(): Promise<void> {
  const response = await fetch("/api/voices");
  voices = await response.json() as VoiceOption[];
  renderVoiceGrid();
}

function renderVoiceGrid(): void {
  voiceGrid.innerHTML = "";

  for (const voice of voices) {
    const option = document.createElement("div");
    option.className = `voice-option${voice.id === selectedVoice ? " selected" : ""}`;
    option.dataset.voiceId = voice.id;
    option.innerHTML = `
      <input type="radio" name="voice" value="${voice.id}" />
      <div>
        <div class="voice-name">${voice.name}</div>
        <div class="voice-meta">${voice.accent} · ${voice.gender}</div>
      </div>
    `;
    option.addEventListener("click", () => selectVoice(voice.id));
    voiceGrid.appendChild(option);
  }
}

function selectVoice(voiceId: string): void {
  selectedVoice = voiceId;
  document.querySelectorAll<HTMLElement>(".voice-option").forEach((element) => {
    element.classList.toggle("selected", element.dataset.voiceId === voiceId);
  });
}

function getSpeed(): number {
  return Number.parseFloat(speedSlider.value);
}

function setGenerateStatus(message: string, isError = false): void {
  generateStatus.textContent = message;
  generateStatus.className = isError ? "status error" : "status";
}

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
    setGenerateStatus(`${voiceName} at ${getSpeed().toFixed(2)}x`);
  } catch (error) {
    setGenerateStatus(`Error: ${(error as Error).message}`, true);
  } finally {
    generateButton.disabled = false;
  }
}

function updateCallTimer(): void {
  const elapsedSeconds = Math.floor((Date.now() - callStartTime) / 1000);
  const minutes = String(Math.floor(elapsedSeconds / 60)).padStart(2, "0");
  const seconds = String(elapsedSeconds % 60).padStart(2, "0");
  callTimer.textContent = `${minutes}:${seconds}`;
}

function clearRemoteAudio(): void {
  remoteAudioContainer.querySelectorAll("audio").forEach((element) => element.remove());
}

function resetCallUi(statusText = "Ready", isError = false): void {
  startCallButton.style.display = "inline-flex";
  startCallButton.disabled = false;
  endCallButton.style.display = "none";
  callTimer.style.display = "none";
  callTimer.textContent = "00:00";
  callStatus.textContent = statusText;
  callStatus.className = isError ? "call-status error" : "call-status";
}

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
        voice: selectedVoice,
        speed: getSpeed()
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

async function endCall(): Promise<void> {
  await cleanupCall();
}

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

speedSlider.addEventListener("input", () => {
  speedValue.textContent = `${getSpeed().toFixed(2)}x`;
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

void loadVoices();
