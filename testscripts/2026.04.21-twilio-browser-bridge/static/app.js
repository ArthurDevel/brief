const browserStatusElement = document.getElementById("browser-status");
const callStatusElement = document.getElementById("call-status");
const callMetaElement = document.getElementById("call-meta");
const eventLogElement = document.getElementById("event-log");
const connectAudioButton = document.getElementById("connect-audio");
const pickupCallButton = document.getElementById("pickup-call");
const hangupCallButton = document.getElementById("hangup-call");

const state = {
  audioReady: false,
  callStatus: "idle",
  browserJoined: false,
  reconnectEnabled: true,
  socket: null,
  audioContext: null,
  microphoneStream: null,
  playerNode: null,
  captureNode: null,
  sourceNode: null,
};

function getErrorMessage(error) {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  return String(error);
}

function logEvent(message) {
  const timestamp = new Date().toLocaleTimeString();
  eventLogElement.textContent = `[${timestamp}] ${message}\n${eventLogElement.textContent}`.trim();
}

function buildWebSocketUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/browser-ws`;
}

function renderState(bridgeState) {
  state.callStatus = bridgeState.call.status;
  state.browserJoined = bridgeState.call.browserJoined;

  browserStatusElement.textContent = state.audioReady
    ? "Audio ready"
    : "Browser audio not connected";

  if (bridgeState.call.status === "idle") {
    callStatusElement.textContent = "Waiting for call";
    callMetaElement.textContent = "No active Twilio call.";
  } else if (bridgeState.call.status === "ringing") {
    callStatusElement.textContent = "Phone call incoming";
    callMetaElement.textContent = `From ${bridgeState.call.fromNumber || "unknown number"}`;
  } else {
    callStatusElement.textContent = bridgeState.call.browserJoined ? "Call live" : "Call connected";
    callMetaElement.textContent = `From ${bridgeState.call.fromNumber || "unknown number"}`;
  }

  pickupCallButton.disabled = !state.audioReady || bridgeState.call.status === "idle";
  hangupCallButton.disabled = bridgeState.call.status === "idle";
}

function connectControlSocket() {
  state.reconnectEnabled = true;
  const socket = new WebSocket(buildWebSocketUrl());
  socket.binaryType = "arraybuffer";

  socket.addEventListener("open", () => {
    state.socket = socket;
    logEvent("Browser control socket connected.");
  });

  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") {
      if (!state.playerNode) {
        return;
      }
      state.playerNode.port.postMessage(event.data, [event.data]);
      return;
    }

    const message = JSON.parse(event.data);

    if (message.type === "bridge_state") {
      renderState(message);
      return;
    }

    if (message.type === "error") {
      logEvent(message.message);
      if (message.code === "BROWSER_ALREADY_CONNECTED") {
        state.reconnectEnabled = false;
      }
      return;
    }
  });

  socket.addEventListener("close", (event) => {
    state.socket = null;
    browserStatusElement.textContent = "Control socket disconnected";
    logEvent("Browser control socket disconnected.");

    if (event.code === 1008) {
      state.reconnectEnabled = false;
    }

    if (!state.reconnectEnabled) {
      logEvent("Reconnect stopped. Close other bridge tabs or restart the bridge server.");
      return;
    }

    window.setTimeout(connectControlSocket, 1000);
  });

  socket.addEventListener("error", () => {
    logEvent("Browser control socket hit an error.");
  });
}

async function checkBrowserAudioSupport() {
  if (!window.isSecureContext) {
    throw new Error("Microphone access requires a secure context. Open this page on localhost or HTTPS.");
  }

  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
    throw new Error("This browser does not expose navigator.mediaDevices.getUserMedia.");
  }

  if (!window.AudioContext) {
    throw new Error("This browser does not support AudioContext.");
  }

  if (!window.AudioWorkletNode) {
    throw new Error("This browser does not support AudioWorkletNode.");
  }

  if (!navigator.permissions || typeof navigator.permissions.query !== "function") {
    return;
  }

  try {
    const permissionStatus = await navigator.permissions.query({ name: "microphone" });
    if (permissionStatus.state === "denied") {
      throw new Error("Microphone access is blocked in the browser settings for this page.");
    }
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
  }
}

async function ensureBrowserAudio() {
  if (state.audioReady) {
    return;
  }

  await checkBrowserAudioSupport();

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  const audioContext = new AudioContext({ sampleRate: 48000 });
  await audioContext.audioWorklet.addModule("/static/pcm-capture-worklet.js");
  await audioContext.audioWorklet.addModule("/static/pcm-player-worklet.js");

  const sourceNode = audioContext.createMediaStreamSource(stream);
  const captureNode = new AudioWorkletNode(audioContext, "pcm-capture-processor");
  const playerNode = new AudioWorkletNode(audioContext, "pcm-player-processor");
  const zeroGainNode = audioContext.createGain();
  zeroGainNode.gain.value = 0;

  captureNode.port.onmessage = (event) => {
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    if (state.callStatus !== "live" || !state.browserJoined) {
      return;
    }
    state.socket.send(event.data);
  };

  sourceNode.connect(captureNode);
  playerNode.connect(audioContext.destination);
  sourceNode.connect(zeroGainNode);
  zeroGainNode.connect(audioContext.destination);

  state.audioContext = audioContext;
  state.microphoneStream = stream;
  state.captureNode = captureNode;
  state.playerNode = playerNode;
  state.sourceNode = sourceNode;
  state.audioReady = true;

  browserStatusElement.textContent = "Audio ready";
  connectAudioButton.disabled = true;
  logEvent("Browser mic and speaker are ready.");
}

connectAudioButton.addEventListener("click", async () => {
  connectAudioButton.disabled = true;
  try {
    await ensureBrowserAudio();
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
      connectControlSocket();
    }
  } catch (error) {
    console.error(error);
    connectAudioButton.disabled = false;
    logEvent(`Could not access browser audio: ${getErrorMessage(error)}`);
  }
});

pickupCallButton.addEventListener("click", () => {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    logEvent("Browser socket is not connected.");
    return;
  }

  state.socket.send(JSON.stringify({ type: "pickup" }));
  logEvent("Pick up requested.");
});

hangupCallButton.addEventListener("click", () => {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    logEvent("Browser socket is not connected.");
    return;
  }

  state.socket.send(JSON.stringify({ type: "hangup" }));
  logEvent("Hang up requested.");
});

connectControlSocket();
