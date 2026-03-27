# Test: Built-in Twilio Transport (TwilioFrameSerializer)

## Goal

Test whether pipecat's built-in `TwilioFrameSerializer` + `FastAPIWebsocketTransport` can replace our custom `TwilioTransport` (~400 lines across `src/transports/twilio.py` and `src/audio/transcoder.py`).

## What we tested

1. `parse_telephony_websocket()` for extracting `stream_sid`, `call_sid`, `userId` from Twilio's handshake messages
2. `TwilioFrameSerializer` for mulaw 8kHz <-> PCM16 transcoding
3. `FastAPIWebsocketTransport` for WebSocket lifecycle (connect, receive, disconnect)
4. Full pipeline: STT (Deepgram) -> LLM (OpenRouter/Gemini) -> TTS (Deepgram) -> mulaw back to client
5. Disconnect handling via `on_client_disconnected` event

## Results

**It works.** The built-in approach handles the full lifecycle:

- `parse_telephony_websocket()` reads the "connected" and "start" messages, extracting metadata. Subsequent messages flow through the transport's receive loop naturally -- no "buffered_messages" pattern needed.
- `TwilioFrameSerializer` handles mulaw transcoding using SOXR (better quality than our linear interpolation in `src/audio/transcoder.py`).
- `FastAPIWebsocketTransport` fires `on_client_disconnected` when the WebSocket closes, allowing us to cancel the pipeline -- replaces our custom `set_pipeline_task()` pattern.
- Audio flows bidirectionally: the simulated client received ~30 mulaw media frames from the TTS greeting.

## Key differences from custom transport

| Aspect | Custom (`src/transports/twilio.py`) | Built-in (this test) |
|--------|--------------------------------------|----------------------|
| Lines of code | ~400 (transport + transcoder) | ~50 (serializer setup) |
| Mulaw transcoding | Manual ITU-T G.711 + linear interpolation | pipecat's `pcm_to_ulaw`/`ulaw_to_pcm` with SOXR |
| "clear" on interruption | Manual `send_clear()` method | Serializer auto-sends on `InterruptionFrame` |
| Disconnect handling | `set_pipeline_task()` + cancel in read loop | `on_client_disconnected` event handler |
| userId extraction | Custom buffered_messages pattern | `parse_telephony_websocket()` utility |
| DTMF support | Not implemented | Built-in via `InputDTMFFrame` |
| Auto hangup | Not implemented | Built-in via Twilio REST API (optional) |

## Issues found

1. **Deepgram STT keepalive error**: `AsyncV1SocketClient.send_keep_alive() missing 1 required positional argument` -- this is a Deepgram SDK version mismatch, not related to the transport change. Also present in current production code.

2. **Dangling STT tasks**: Same as current codebase -- the `cancel_stt_tasks()` hack would still be needed.

3. **Deprecation warnings**: Several deprecated pipecat APIs used in this test (OpenAILLMContext, vad_enabled, LLMMessagesFrame). These are also present in our main codebase and should be updated separately.

## How to run

```bash
# From this directory
cp .env.example .env
# Fill in DEEPGRAM_API_KEY and OPENROUTER_API_KEY

# Use the voice-pipeline venv
source ../../apps/voice-pipeline/.venv/bin/activate

# Terminal 1: start the server
python test_builtin_twilio.py

# Terminal 2: run the simulated client
python test_twilio_client.py --url ws://localhost:8765/twilio-stream --user-id test-user-42
```

## Conclusion

The built-in approach is a viable replacement. Migration would:
- Delete `src/transports/twilio.py` (~394 lines)
- Delete `src/audio/transcoder.py` (~190 lines)
- Replace the `twilio_stream_ws` handler in `server.py` with ~50 lines using the built-in transport
- Get better audio quality (SOXR vs linear interpolation)
- Get DTMF and auto-hangup support for free
