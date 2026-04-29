# WhatsApp Bridge and xAI Streaming Testscripts

## Bridge Setup Timing Goal

Verify question #4 for the WhatsApp bridge work: why production currently spends about 2.6 seconds from WhatsApp webhook received to LiveKit bridge start.

`measureBridgeSetupTiming.mjs` isolates the local `werift` setup phases used before `WhatsAppLiveKitBridge.start()`:

- RTP audio source creation with `MediaStreamTrackFactory.rtpSource({ kind: "audio" })`.
- `RTCPeerConnection` construction.
- Adding the outbound audio track.
- `setRemoteDescription` from `input/sample-offer.sdp`, when present.
- `createAnswer`.
- `setLocalDescription`.
- Production-shaped ICE gathering wait: poll every 100ms until `iceGatheringState === "complete"` or 3000ms.

It does not import app source and does not call WhatsApp or LiveKit.

## Bridge Setup Timing Result

Run with a real WhatsApp offer SDP captured from the last production call:

```text
rtp_source_create                3.22ms
peer_connection_create           0.34ms
add_outbound_audio_track         1.21ms
set_remote_description           1.69ms
create_answer                   10.84ms
set_local_description           66.43ms
wait_for_ice_gathering           0.04ms

bridge_start_ready_after_webrtc_ms: 83.77
ice_gathering_elapsed_ms:          0.04
```

Conclusion: the observed ~2.6s production gap is not explained by local `werift` RTP source creation, SDP handling, answer creation, or ICE gathering. The remaining unmeasured production work before `bridge.start()` is LiveKit room/dispatch creation, WhatsApp `preAcceptCall`/`acceptCall`, `waitForConnection`, and waiting for the incoming WhatsApp audio track.

What we tried and failed: the first run had no `input/sample-offer.sdp`, so it skipped the SDP-dependent phases. After adding a captured offer SDP to ignored input, the full local WebRTC sequence still measured under 100ms.

# LiveKit Dispatch Timing Testscript

## LiveKit Dispatch Timing Goal

Zoom deeper into the bridge setup work that happens before `WhatsAppLiveKitBridge.start()`. The local WebRTC setup was fast, so this script measures LiveKit control-plane work:

- Current production shape: `createRoom` -> `createDispatch` -> bridge token.
- Dispatch-only shape: `createDispatch` and let LiveKit create the room.
- Token-dispatch shape: embed agent dispatch in the bridge participant token.

Docs checked:

- LiveKit agent dispatch docs: https://docs.livekit.io/agents/server/agent-dispatch/
- LiveKit AgentDispatchService API: https://docs.livekit.io/reference/agents/agent-dispatch-service-api/

Important doc findings:

- LiveKit says `CreateDispatch` creates the room automatically if it does not exist.
- LiveKit supports dispatch via access token, applied when the first participant connects and creates the room.
- Token dispatch only applies on room creation, so this requires unique room names per call.

## LiveKit Dispatch Timing Result

Run against the configured LiveKit project:

```text
current: 1669.24ms
  create_room                 1227.28ms
  create_dispatch              441.31ms
  create_bridge_token            0.54ms

dispatch-only: 789.75ms
  create_dispatch_auto_room    789.12ms
  create_bridge_token            0.60ms

token-dispatch: 0.71ms
  create_bridge_token_with_agent_dispatch 0.70ms
```

Repeat runs:

```text
current:       1366.52ms, 1226.01ms, 1186.37ms
dispatch-only:  764.53ms,  633.92ms,  838.72ms
token-dispatch:   0.57ms,    1.12ms,    0.43ms
```

Conclusion: LiveKit room creation plus explicit dispatch is a confirmed pre-bridge latency source. Dispatch-only saved roughly 0.35s to 0.88s in these runs. Token-dispatch removes the LiveKit control-plane HTTP calls from the pre-accept path, but the agent dispatch then happens when the bridge joins the room, so it must be tested in a real call before treating it as a guaranteed end-to-end win.

What we tried and failed: the script cannot safely measure Meta `preAcceptCall`/`acceptCall` without an active inbound call. The Calling API docs say pre-accept establishes the media connection before accept, and warn that sending media too early clips audio while sending too late creates silence.

## LiveKit Dispatch Timing Run

```bash
cd testscripts/2026.04.28-whatsapp-bridge-and-xai-streaming
pnpm install --ignore-workspace
pnpm measure:livekit
```

Required environment variables can be set in `.env` or passed via `process.env`:

```text
LIVEKIT_URL=
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=
LIVEKIT_AGENT_NAME=whatsapp-composio-agent
```

Useful options:

```bash
pnpm measure:livekit -- --mode=current
pnpm measure:livekit -- --mode=dispatch-only
pnpm measure:livekit -- --mode=token-dispatch
```

## Bridge Setup Timing Run

```bash
cd testscripts/2026.04.28-whatsapp-bridge-and-xai-streaming
pnpm install --ignore-workspace
pnpm measure:bridge
```

Optional flags:

```bash
pnpm measure:bridge -- --ice-timeout-ms=3000
pnpm measure:bridge -- --connection-timeout-ms=8000
```

`--connection-timeout-ms=8000` models the production connection wait that happens before `bridge.start()`. It is off by default because this isolated script usually has no real remote peer completing the connection.

## Bridge Setup Timing Input

If `input/sample-offer.sdp` exists, the script uses it as the remote WhatsApp offer. If the file is missing, the script still measures RTP source creation, peer connection construction, and `addTrack`, then skips the SDP-dependent phases.

To test the full sequence, capture a real WhatsApp call offer SDP and save only the SDP text here:

```text
input/sample-offer.sdp
```

Do not commit real captured SDP if it contains sensitive network details. The folder `.gitignore` ignores `input/*` except `.gitkeep`.

## Bridge Setup Timing Output

The script writes timestamped JSON files under `output/`.

Important fields:

- `summary.bridgeStartReadyAfterWebrtcMs`: local setup time through the production-shaped ICE wait.
- `summary.iceGatheringElapsedMs`: elapsed time spent in the ICE gathering wait.
- `phases`: per-step timing for RTP source creation, peer connection creation, SDP handling, answer creation, local description, and ICE wait.

If `summary.iceGatheringElapsedMs` is close to 2600ms to 3000ms, the local ICE gathering wait is a likely contributor to the production gap.

## Bridge Setup Timing Limits

This script can show whether local `werift` offer/answer handling and the production ICE gathering wait are large enough to explain the observed pre-bridge delay.

It cannot measure WhatsApp webhook parsing, LiveKit room/token creation, WhatsApp `preAcceptCall` or `acceptCall` HTTP latency, real remote ICE connectivity, time waiting for the incoming WhatsApp audio track, or actual `WhatsAppLiveKitBridge.start()` connection and publication latency.

# xAI TTS HTTP Streaming Testscript

## Goal

Verify question #5 for the WhatsApp bridge work: production sets `streaming=true` for xAI TTS, but currently consumes the response with `response.arrayBuffer()`.

This script checks whether `POST https://api.x.ai/v1/tts` with PCM output exposes HTTP response chunks through `response.body.getReader()`, and how much earlier the first chunk arrives than the full body.

## What this tests

- Sends a standalone xAI TTS request with `output_format.codec = "pcm"`.
- Includes `stream: true` in the request body by default to mirror the production question.
- Measures time to response headers.
- Measures time to first streamed chunk.
- Measures time to full body completion.
- Records total byte count, chunk count, first chunk size, and response headers.
- Writes a JSON report to `output/`.
- Optionally compares reader streaming against `response.arrayBuffer()` style buffered consumption.

## xAI TTS Streaming Result

Run with the same short greeting text used in the call:

```text
Hi, I'm BrewDock. How can I help you?
```

With `stream: true` in the request body:

```text
stream:   headers=539.1ms firstChunk=540.4ms fullBody=1289.3ms chunks=62 bytes=132000
buffered: headers=470.8ms usableAudio=1083.9ms bytes=118560
```

Without the `stream` flag, matching production more closely:

```text
stream:   headers=485.7ms firstChunk=486.6ms fullBody=1305.3ms chunks=67 bytes=145440
buffered: headers=502.8ms usableAudio=1362.4ms bytes=141600
```

Conclusion: xAI's HTTP TTS response is observably chunked in Node for this request. Production currently calls `response.arrayBuffer()` in `ProcessedXaiTTS`, so it cannot use the first chunk and waits for the full response body before post-processing and emitting audio frames. For this greeting, streamed first audio bytes arrived roughly 0.8s before the streamed full body completed.

What we tried and failed: setting LiveKit `streaming: true` on the custom TTS wrapper does not make xAI streaming happen by itself. Our provider still buffers because it reads the response with `arrayBuffer()`.

## How to run

```bash
cd testscripts/2026.04.28-whatsapp-bridge-and-xai-streaming
cp .env.example .env
# Set XAI_API_KEY in .env
pnpm measure:xai
```

Useful options:

```bash
node xai-tts-http-streaming.mjs --mode=stream
node xai-tts-http-streaming.mjs --mode=buffered
node xai-tts-http-streaming.mjs --mode=both
node xai-tts-http-streaming.mjs --text="Longer text gives chunking more room to show up."
node xai-tts-http-streaming.mjs --no-stream-flag
```

## Output

The script writes timestamped JSON files under `output/`.

Important fields:

- `results.stream.headersElapsedMs`: time until HTTP headers are available.
- `results.stream.firstChunkElapsedMs`: time until the first `ReadableStream` chunk arrives.
- `results.stream.fullBodyElapsedMs`: time until all bytes are read.
- `results.stream.firstChunkEarlierThanFullBodyMs`: direct answer for how much earlier streaming could start than full buffering.
- `results.stream.chunkCount`: whether Node observed more than one body chunk.
- `results.buffered.firstUsableAudioElapsedMs`: when `arrayBuffer()` makes audio bytes available to production-style buffered code.

## What it can prove

If `chunkCount > 1` and `firstChunkElapsedMs < fullBodyElapsedMs`, the HTTP response is observably chunked in Node for this request. In that case, production code using `arrayBuffer()` is leaving latency on the table because it waits for the full body before audio bytes are usable.

If `chunkCount === 1`, this run did not observe useful HTTP chunk streaming. Re-run with longer text before concluding the endpoint never chunks, because short audio can fit in one delivered body chunk.

## What it cannot prove

- It does not test the WebSocket TTS endpoint. xAI documents real-time TTS streaming separately at `wss://api.x.ai/v1/tts`.
- It does not import or exercise app production code.
- It does not prove browser behavior. This is a Node fetch and stream-reader measurement.
- It does not prove all xAI voices, languages, sample rates, or text lengths behave the same.
- It does not validate playback quality. PCM bytes are measured, not played.

## Notes

Reference docs checked while drafting:

- xAI TTS guide: https://docs.x.ai/developers/model-capabilities/audio/text-to-speech
- xAI voice API reference: https://docs.x.ai/developers/rest-api-reference/inference/voice

The default mode is `both`, which sends two requests:

- `stream`: reads the HTTP body with `response.body.getReader()` and records chunk timings.
- `buffered`: reads the HTTP body with `response.arrayBuffer()` and records when audio becomes usable with the current buffered style.

The comparison is directional, not perfectly controlled, because it uses two separate network requests.
