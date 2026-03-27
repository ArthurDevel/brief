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

## 11. SmartTurn 16kHz Guard -- Possibly removable

Our `pipeline.py:208` disables SmartTurn for Twilio (sample rate < 16kHz). Pipecat PR #3857 added automatic resampling to 16kHz before SmartTurn inference. If our pipecat version includes this fix (>= 0.0.103), we can remove the guard and enable SmartTurn for Twilio calls too.

---

## 12. STT Task Cleanup -- Necessary hack, no public API

Our `cancel_stt_tasks()` accesses `stt._task_manager` (private API) to force-cancel dangling Deepgram tasks. There is no public API for this. Pipecat's built-in lifecycle (`stop`/`cancel`/`cleanup`) is insufficient because the 1s timeout in `cancel_task` is too short for Deepgram's websocket close handshake. This is a known gap.

**Verdict:** Keep it, but be aware it may break on pipecat upgrades.

---

## Summary: Priority Actions

**Replace (clear wins, less custom code):**
1. Twilio transport + transcoder -> `TwilioFrameSerializer` + `WebSocketServerTransport`
2. Markdown stripper -> `MarkdownTextFilter` on TTS service
3. Audio watchdog -> `IdleFrameProcessor`
4. Tool call timeouts -> built-in `timeout_secs` on `register_function()`

**Update (deprecated APIs):**
5. `OpenAILLMContext` -> `LLMContext`
6. `llm.create_context_aggregator()` -> `LLMContextAggregatorPair`
7. `allow_interruptions` -> start strategy `enable_interruptions`

**Evaluate:**
8. Audio recording -> `AudioBufferProcessor` (needs investigation for upload flow)
9. `TrackedDeepgramTTSService` -> native `TTSUsageMetricsData` via observer
10. SmartTurn 16kHz guard -> check pipecat version, possibly remove

**Keep as-is (legitimately custom):**
11. WSOLA speed processor
12. RMS normalizer
13. `TrackedOpenAILLMService` (OpenRouter generation ID capture)
14. Cost tracker
15. Langfuse observer
16. STT task cleanup hack
