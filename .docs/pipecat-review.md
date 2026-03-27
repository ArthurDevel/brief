# Pipecat Implementation Review

Review of our custom pipecat code vs what the framework provides natively. Voice pipeline lives in `apps/voice-pipeline/src/`.

---

## 1. Custom Twilio Transport -- Replace with built-in

**What we built:** `src/transports/twilio.py` -- a full custom `BaseTransport` subclass with `TwilioInputTransport` and `TwilioOutputTransport`, plus `src/audio/transcoder.py` with hand-rolled mulaw encode/decode and linear interpolation resampling. ~400 lines across two files.

**What pipecat provides:** `TwilioFrameSerializer` (`pipecat.serializers.twilio`) -- a serializer that plugs into the generic `WebSocketServerTransport`. It handles:
- Bidirectional mulaw 8kHz <-> PCM16 transcoding (using `pipecat.audio.utils` with audioop + SOXR resampling)
- media events (in/out), clear on interruption, dtmf input
- start event parsing via `pipecat.runner.utils.parse_telephony_websocket()`

**Verdict:** Our custom transport reimplements what the serializer does natively. The built-in uses proper SOXR resampling rather than manual linear interpolation (better audio quality). A dedicated Twilio transport PR was explicitly closed upstream with the note that the serializer approach is "very stable."

**Caveat:** Our transport has a custom `set_pipeline_task()` pattern for canceling the pipeline on disconnect. Need to verify `WebSocketServerTransport` handles connection close properly, or handle it at the WebSocket level.

**Test:** `testscripts/2026.03.27-builtin-twilio-transport/` validates the built-in approach.

---

## 2. Markdown Stripper -- Replace with built-in

**What we built:** `src/audio/markdown_stripper.py` -- a custom `FrameProcessor` that intercepts `LLMTextFrame` and strips `*_~#>`` characters plus list markers.

**What pipecat provides:** `MarkdownTextFilter` (`pipecat.utils.text.markdown_text_filter`) -- a text filter that integrates directly with TTS services:
```python
from pipecat.utils.text.markdown_text_filter import MarkdownTextFilter
tts = DeepgramTTSService(..., text_filter=MarkdownTextFilter())
```

**Verdict:** Direct replacement. The built-in handles more cases (code blocks, tables, HTML tags) and integrates at the TTS service level rather than as a separate pipeline processor. No separate processor needed in the chain.

---

## 3. Audio Watchdog -- Replace with built-in

**What we built:** `src/audio/watchdog.py` -- a custom `FrameProcessor` that monitors `InputAudioRawFrame` arrival and cancels the pipeline after 10s of silence.

**What pipecat provides:** `IdleFrameProcessor` (`pipecat.processors.idle_frame_processor`):
```python
from pipecat.processors.idle_frame_processor import IdleFrameProcessor

async def on_idle(processor):
    await task.cancel()

watchdog = IdleFrameProcessor(callback=on_idle, timeout=10.0, types=[InputAudioRawFrame])
```

**Verdict:** Direct replacement. Same functionality, less custom code.

---

## 4. Audio Recording -- Evaluate replacing with built-in

**What we built:** `src/audio/recorder.py` -- two `AudioRecorder` instances (user + assistant) that capture frames into buffers, then combine into a single WAV and upload to Supabase.

**What pipecat provides:** `AudioBufferProcessor` (`pipecat.processors.audio.audio_buffer_processor`) -- supports mono/stereo recording, separate user/bot tracks, per-turn recording, and event-driven audio capture.

**Verdict:** The built-in handles the capture part. Our custom `combine_wav_buffers()` mixing and `upload_recording()` to Supabase would still be needed. Worth evaluating whether the built-in gives cleaner code, but less clear-cut since our upload/mixing logic is specific.

---

## 5. Tool Call Handlers -- Simplify with built-in timeout + handler signature

**What we built:** `_register_tool_handler()` in `pipeline.py` wraps each tool call with:
- Manual `asyncio.wait_for()` with 8s timeout
- Manual `asyncio.Lock` for IMAP serialization
- Custom handler signature: `(function_name, tool_call_id, args, llm_instance, context, result_callback)`
- Manual narration via HTTP TTS before execution

**What pipecat provides:**
- Built-in `timeout_secs` parameter on `register_function()` (per-function or global `function_call_timeout_secs`)
- Built-in `cancel_on_interruption` parameter
- Newer `FunctionCallParams` dataclass as handler signature

**Verdict:** The `asyncio.wait_for()` wrapper is unnecessary -- pass `timeout_secs=8.0` to `register_function()`. The handler signature could use the newer `FunctionCallParams` pattern. The IMAP lock and narration logic are legitimately custom.

**FRAMEWORK GAP #1 (2026-03-27, pipecat v0.0.107): Tool call error handling is broken.** If a handler raises an exception, pipecat's `_run_function_call` catches it and pushes a non-fatal `ErrorFrame`, but never calls `result_callback`. The function call stays stuck in `_function_calls_in_progress` forever and the pipeline freezes. Our existing try/except + `result_callback(error_string)` pattern in `_register_tool_handler` is the only working approach -- it must be preserved during migration. Every handler must catch its own errors and return them via `result_callback`. See [#1735](https://github.com/pipecat-ai/pipecat/issues/1735), [#2179](https://github.com/pipecat-ai/pipecat/issues/2179).

**FRAMEWORK GAP #2 (2026-03-27, pipecat v0.0.107): Instant tool handlers cause a race condition.** The `FunctionCallResultFrame` (pushed from a concurrent task) can arrive at the assistant aggregator before the `FunctionCallsStartedFrame` (which must travel through the full pipeline: LLM -> TTS -> transport -> audio_buffer -> aggregator). When this happens, the aggregator drops the result (`tool_call_id is not running`) and the pipeline freezes. Workaround: yield to the event loop (`await asyncio.sleep(0)`) at the start of any handler that may complete instantly. Our IMAP tool handlers are not affected because they always do blocking I/O, but this is relevant for any fast/cached/mock tool responses. See [#3661](https://github.com/pipecat-ai/pipecat/issues/3661).

**FRAMEWORK GAP #3 (2026-03-27, pipecat v0.0.107): `TTSSpeakFrame` in `on_function_calls_started` breaks the TTS.** The official pipecat example uses `tts.queue_frame(TTSSpeakFrame("Let me check on that."))` to speak filler while a tool executes. This breaks the Deepgram websocket TTS context -- the context gets cleaned up immediately after creation, all audio frames fail with "unable to append audio to context", and the TTS gets stuck, blocking subsequent frames (including `FunctionCallResultFrame`) from passing through the pipeline. Our existing HTTP TTS narration approach in `_register_tool_handler` sidesteps this entirely. Do not use `TTSSpeakFrame` via `tts.queue_frame()` during function calls.

---

## 6. Audio Speed Processor (WSOLA) -- Keep, legitimately custom

**What we built:** `src/audio/speed.py` -- a pure-numpy WSOLA time-stretcher for pitch-preserving speed control.

**What pipecat provides:** Nothing equivalent. Some TTS providers (OpenAI) have a `speed` parameter at the API level, but Deepgram TTS does not. No post-processing audio speed processor exists.

---

## 7. Audio Normalizer (RMS) -- Keep, legitimately custom

**What we built:** `src/audio/normalizer.py` -- RMS normalization with attack/release envelope and tanh soft limiting.

**What pipecat provides:** Utility functions in `pipecat.audio.utils` (EBU R128 loudness calculation, silence detection), but no pipeline processor for normalization.

---

## 8. Tracked Services (Usage Tracking) -- Partially replaceable

**What we built:** `TrackedOpenAILLMService` captures OpenRouter generation IDs from streaming chunks. `TrackedDeepgramTTSService` counts TTS characters.

**What pipecat provides:** Native `TTSUsageMetricsData` and `LLMUsageMetricsData` emitted when `enable_usage_metrics=True` (which we already set). However:
- LLM token counts from streaming are typically 0 for OpenRouter/Gemini -- our generation ID capture is needed for post-hoc cost fetching
- No STT usage metrics exist in pipecat

**Verdict:** `TrackedDeepgramTTSService` is likely unnecessary -- pipecat emits `TTSUsageMetricsData` natively. Could capture TTS character counts via an observer instead of subclassing. `TrackedOpenAILLMService` is legitimately needed for the OpenRouter generation ID capture pattern.

---

## 9. Cost Tracker & Langfuse Observer -- Keep, legitimately custom

**What pipecat provides:** No built-in dollar-cost tracking. Langfuse integration exists only via OpenTelemetry tracing (not a native observer). No STT usage metrics.

**Verdict:** Both are legitimately custom. The OpenTelemetry/Langfuse path would give traces but not the same level of control we have with direct Langfuse SDK v4 integration.

---

## 10. Deprecated API Usage -- Should update

Three deprecated patterns in `pipeline.py`:

| Line | Current (deprecated) | Replacement |
|------|---------------------|-------------|
| 204 | `OpenAILLMContext` | `LLMContext` (from `pipecat.processors.aggregators.llm_response`) |
| 222 | `llm.create_context_aggregator(context)` | `LLMContextAggregatorPair(context)` |
| 277 | `allow_interruptions=True` in `PipelineParams` | `enable_interruptions` on start strategy in `UserTurnStrategies` |

---

## 11. SmartTurn 16kHz Guard -- Removable (two paths)

Our `pipeline.py:208` disables SmartTurn for Twilio (sample rate < 16kHz). Pipecat PR #3857 added automatic resampling to 16kHz before SmartTurn inference. The fix landed in **v0.0.104** (not v0.0.103 -- the PR merged March 2, after 0.0.103's Feb 21 release).

**Path A (keep SmartTurn):** If pipecat >= 0.0.104, remove the guard. SmartTurn auto-resamples 8kHz to 16kHz via SOXR.

**Path B (switch to Flux):** DeepgramFluxSTTService completely replaces SmartTurn. Flux handles turn detection natively (including at 8kHz), so SmartTurn, SileroVAD, and the guard can all be removed. This is validated in `testscripts/2026.03.27-builtin-twilio-transport/`.

---

## 12. STT Task Cleanup -- Necessary hack, no public API

Our `cancel_stt_tasks()` accesses `stt._task_manager` (private API) to force-cancel dangling Deepgram tasks. There is no public API for this. Pipecat's built-in lifecycle (`stop`/`cancel`/`cleanup`) is insufficient because the 1s timeout in `cancel_task` is too short for Deepgram's websocket close handshake. This is a known gap.

**Verdict:** Keep it, but be aware it may break on pipecat upgrades.

---

## Summary: Priority Actions

**Replace (clear wins, validated in test script):**
1. Twilio transport + transcoder -> `TwilioFrameSerializer` + `FastAPIWebsocketTransport`
2. Markdown stripper -> `MarkdownTextFilter` on TTS service
3. Audio watchdog -> `IdleFrameProcessor`
4. Tool call timeouts -> built-in `timeout_secs` on `register_function()`
5. Audio recording -> `AudioBufferProcessor` (capture + mixing replaced; WAV wrapping is ~10 lines with `wave` module; Supabase upload stays custom)
6. SmartTurn + SileroVAD -> `DeepgramFluxSTTService` (handles turn detection natively, removes 16kHz guard)

**Update (deprecated APIs, validated in test script):**
7. `OpenAILLMContext` -> `LLMContext`
8. `llm.create_context_aggregator()` -> `LLMContextAggregatorPair`
9. `allow_interruptions` -> removed (Flux manages turns externally)
10. `LLMMessagesFrame` -> `context.add_message()` + `LLMRunFrame()`

**Keep as-is (legitimately custom):**
11. WSOLA speed processor
12. RMS normalizer
13. `TrackedOpenAILLMService` (OpenRouter generation ID capture)
14. `TrackedDeepgramTTSService` (websocket DeepgramTTSService in SENTENCE mode does NOT emit `TTSUsageMetricsData` -- framework gap in v0.0.107)
15. Cost tracker
16. Langfuse observer
17. STT task cleanup hack
