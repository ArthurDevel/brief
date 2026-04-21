/**
 * Browser UI for the WhatsApp emulator.
 *
 * Responsibilities:
 * - Start and end browser-based LiveKit calls
 * - Send emulator text messages through the backend
 * - Poll and render outbound WhatsApp replies and typing state
 */

const callerPhoneInput = document.getElementById("callerPhone");
const startCallButton = document.getElementById("startCallButton");
const muteButton = document.getElementById("muteButton");
const endCallButton = document.getElementById("endCallButton");
const sendChatButton = document.getElementById("sendChatButton");
const chatInput = document.getElementById("chatInput");
const chatMessages = document.getElementById("chatMessages");
const typingIndicator = document.getElementById("typingIndicator");
const statusText = document.getElementById("statusText");
const callIdText = document.getElementById("callIdText");
const roomNameText = document.getElementById("roomNameText");
const errorBanner = document.getElementById("errorBanner");
const audioMount = document.getElementById("audioMount");

let room = null;
let activeCall = null;
let isMuted = false;
let pollTimer = null;
let lastLoadedPhone = "";

startCallButton.addEventListener("click", async () => {
  clearError();
  setStatus("Starting");
  setButtons({
    canEnd: false,
    canMute: false,
    canSendChat: false,
    canStart: false
  });

  try {
    const callerPhone = getCallerPhone();
    if (!callerPhone) {
      showError("Enter a caller phone number.");
      resetCallButtons();
      setStatus("Idle");
      return;
    }

    const response = await fetch("/api/dev-call/start", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ callerPhone })
    });

    const payload = await response.json();
    if (!response.ok) {
      console.error("[whatsapp-emulator] start call failed", payload);
      showError(payload.error || "Unable to start the emulator call.");
      resetCallButtons();
      setStatus("Idle");
      return;
    }

    activeCall = payload;
    callIdText.textContent = payload.callId;
    roomNameText.textContent = payload.roomName;

    await joinRoom(payload.url, payload.token);

    setStatus("Connected");
    setButtons({
      canEnd: true,
      canMute: true,
      canSendChat: true,
      canStart: false
    });
  } catch (error) {
    console.error("[whatsapp-emulator] start call error", error);
    showError("Unable to start the emulator call.");
    await cleanupActiveCallRoom();
    await disconnectRoom();
    resetUiAfterDisconnect("Idle");
  }
});

muteButton.addEventListener("click", async () => {
  if (!room) {
    return;
  }

  isMuted = !isMuted;
  await room.localParticipant.setMicrophoneEnabled(!isMuted);
  muteButton.textContent = isMuted ? "Unmute mic" : "Mute mic";
});

endCallButton.addEventListener("click", async () => {
  await endCall();
});

sendChatButton.addEventListener("click", async () => {
  await sendChatMessage();
});

chatInput.addEventListener("keydown", async (event) => {
  if (event.key !== "Enter" || event.shiftKey) {
    return;
  }

  event.preventDefault();
  await sendChatMessage();
});

callerPhoneInput.addEventListener("input", () => {
  const callerPhone = getCallerPhone();
  if (!callerPhone) {
    lastLoadedPhone = "";
    renderMessages([]);
    setTypingIndicator(false);
    setButtons({
      canEnd: Boolean(activeCall),
      canMute: Boolean(activeCall),
      canSendChat: false,
      canStart: !activeCall
    });
    return;
  }

  setButtons({
    canEnd: Boolean(activeCall),
    canMute: Boolean(activeCall),
    canSendChat: true,
    canStart: !activeCall
  });
});

startPolling();
void loadMessages();

/**
 * Connects the browser to the LiveKit room and enables the microphone.
 * @param {string} url
 * @param {string} token
 * @returns {Promise<void>}
 */
async function joinRoom(url, token) {
  const { Room, RoomEvent, Track } = window.LivekitClient;

  room = new Room();
  room.on(RoomEvent.TrackSubscribed, (track) => {
    if (track.kind !== Track.Kind.Audio) {
      return;
    }

    mountAudioTrack(track);
  });
  room.on(RoomEvent.Disconnected, () => {
    resetUiAfterDisconnect("Ended");
  });

  setStatus("Connecting");
  await room.connect(url, token);
  await room.localParticipant.setMicrophoneEnabled(true);
}

/**
 * Mounts a remote audio track into the page.
 * @param {import("livekit-client").RemoteAudioTrack} track
 * @returns {void}
 */
function mountAudioTrack(track) {
  const audioElement = track.attach();
  audioElement.autoplay = true;
  audioElement.controls = true;
  audioMount.replaceChildren(audioElement);
  void audioElement.play().catch(() => undefined);
}

/**
 * Ends the current emulator call and disconnects the room.
 * @returns {Promise<void>}
 */
async function endCall() {
  clearError();
  setStatus("Ending");
  setButtons({
    canEnd: false,
    canMute: false,
    canSendChat: Boolean(getCallerPhone()),
    canStart: false
  });

  try {
    await cleanupActiveCallRoom();
  } catch (error) {
    console.error("[whatsapp-emulator] end call error", error);
    showError("Unable to end the emulator call.");
  } finally {
    await disconnectRoom();
    resetUiAfterDisconnect("Ended");
  }
}

/**
 * Sends one inbound emulator text message.
 * @returns {Promise<void>}
 */
async function sendChatMessage() {
  clearError();

  const callerPhone = getCallerPhone();
  const body = chatInput.value.trim();

  if (!callerPhone) {
    showError("Enter a caller phone number.");
    return;
  }

  if (!body) {
    showError("Enter a message before sending.");
    return;
  }

  sendChatButton.disabled = true;

  try {
    const response = await fetch("/api/emulator/chat/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        body,
        from: callerPhone
      })
    });

    const payload = await response.json();
    if (!response.ok) {
      console.error("[whatsapp-emulator] chat send failed", payload);
      showError(payload.error || "Unable to send the emulator message.");
      return;
    }

    chatInput.value = "";
    renderMessages(payload.messages || []);
    setTypingIndicator(Boolean(payload.isTyping));
  } catch (error) {
    console.error("[whatsapp-emulator] chat send error", error);
    showError("Unable to send the emulator message.");
  } finally {
    sendChatButton.disabled = false;
  }
}

/**
 * Loads the current chat history for the entered phone.
 * @returns {Promise<void>}
 */
async function loadMessages() {
  const callerPhone = getCallerPhone();
  if (!callerPhone) {
    if (lastLoadedPhone) {
      renderMessages([]);
      setTypingIndicator(false);
      lastLoadedPhone = "";
    }
    return;
  }

  try {
    const url = new URL("/api/emulator/chat/messages", window.location.origin);
    url.searchParams.set("phone", callerPhone);

    const response = await fetch(url);
    const payload = await response.json();
    if (!response.ok) {
      console.error("[whatsapp-emulator] chat load failed", payload);
      return;
    }

    lastLoadedPhone = callerPhone;
    renderMessages(payload.messages || []);
    setTypingIndicator(Boolean(payload.isTyping));
  } catch (error) {
    console.error("[whatsapp-emulator] chat load error", error);
  }
}

/**
 * Starts the background chat polling loop.
 * @returns {void}
 */
function startPolling() {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
  }

  pollTimer = window.setInterval(() => {
    void loadMessages();
  }, 1500);
}

/**
 * Disconnects the active LiveKit room if one exists.
 * @returns {Promise<void>}
 */
async function disconnectRoom() {
  if (!room) {
    return;
  }

  room.disconnect();
  room = null;
}

/**
 * Deletes the active room through the backend API.
 * @returns {Promise<void>}
 */
async function cleanupActiveCallRoom() {
  if (!activeCall?.roomName) {
    return;
  }

  const response = await fetch("/api/dev-call/end", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ roomName: activeCall.roomName })
  });

  if (!response.ok) {
    const payload = await response.json();
    console.error("[whatsapp-emulator] end call failed", payload);
    throw new Error(payload.error || "Unable to end the emulator call.");
  }
}

/**
 * Restores the call UI state after a room disconnects.
 * @param {string} nextStatus
 * @returns {void}
 */
function resetUiAfterDisconnect(nextStatus) {
  activeCall = null;
  isMuted = false;
  muteButton.textContent = "Mute mic";
  setStatus(nextStatus);
  callIdText.textContent = "-";
  roomNameText.textContent = "-";
  audioMount.replaceChildren(createAudioPlaceholder());
  resetCallButtons();
}

/**
 * Resets button states outside of an active call.
 * @returns {void}
 */
function resetCallButtons() {
  setButtons({
    canEnd: false,
    canMute: false,
    canSendChat: Boolean(getCallerPhone()),
    canStart: true
  });
}

/**
 * Creates the empty-state element for the audio panel.
 * @returns {HTMLDivElement}
 */
function createAudioPlaceholder() {
  const placeholder = document.createElement("div");
  placeholder.className = "audio-placeholder";
  placeholder.textContent = "Waiting for remote audio";
  return placeholder;
}

/**
 * Renders the current emulator message list.
 * @param {Array<{ body: string; direction: "inbound" | "outbound"; id: string; }>} messages
 * @returns {void}
 */
function renderMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    const placeholder = document.createElement("div");
    placeholder.className = "chat-placeholder";
    placeholder.textContent = getCallerPhone()
      ? "No messages yet for this phone number."
      : "Enter a caller phone number to load messages.";
    chatMessages.replaceChildren(placeholder);
    return;
  }

  const fragments = messages.map((message) => {
    const bubble = document.createElement("div");
    bubble.className = `chat-bubble ${
      message.direction === "inbound" ? "chat-bubble-inbound" : "chat-bubble-outbound"
    }`;
    bubble.textContent = message.body;
    return bubble;
  });

  chatMessages.replaceChildren(...fragments);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

/**
 * Toggles the visible typing indicator.
 * @param {boolean} isVisible
 * @returns {void}
 */
function setTypingIndicator(isVisible) {
  typingIndicator.hidden = !isVisible;
}

/**
 * Returns the trimmed caller phone value.
 * @returns {string}
 */
function getCallerPhone() {
  return callerPhoneInput.value.trim();
}

/**
 * Toggles button enabled states.
 * @param {{ canStart: boolean; canMute: boolean; canEnd: boolean; canSendChat: boolean; }} state
 * @returns {void}
 */
function setButtons({ canStart, canMute, canEnd, canSendChat }) {
  startCallButton.disabled = !canStart;
  muteButton.disabled = !canMute;
  endCallButton.disabled = !canEnd;
  sendChatButton.disabled = !canSendChat;
}

/**
 * Updates the visible call status.
 * @param {string} value
 * @returns {void}
 */
function setStatus(value) {
  statusText.textContent = value;
}

/**
 * Shows a safe error message to the user.
 * @param {string} message
 * @returns {void}
 */
function showError(message) {
  errorBanner.hidden = false;
  errorBanner.textContent = message;
}

/**
 * Clears the visible error state.
 * @returns {void}
 */
function clearError() {
  errorBanner.hidden = true;
  errorBanner.textContent = "";
}
