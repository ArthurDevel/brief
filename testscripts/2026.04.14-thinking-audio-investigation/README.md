# Thinking Audio Investigation

Goal: investigate why the server-side "thinking" audio sounds stuttery in the WebRTC voice pipeline.

## What we tested

We built a standalone simulation of the current approach:

- producer generates short PCM chunks for a continuous thinking tone
- producer sleeps between chunks, like the current `ThinkingCueProcessor`
- consumer drains audio in 10ms frames, like `SmallWebRTC`'s `RawAudioTrack`
- if the queue is empty, consumer outputs silence, which is what causes audible stutter

The script also writes comparison WAVs:

- `ideal_continuous.wav`: uninterrupted reference tone
- `chunked_no_jitter.wav`: chunked producer with no scheduling delay
- `chunked_with_jitter.wav`: chunked producer with realistic scheduling jitter
- `prebuffered_long_frame.wav`: larger prebuffered writes instead of tiny sleeps

## What we found

The main problem is not the waveform shape itself. The main problem is transport underrun:

- `RawAudioTrack` emits audio every 10ms
- our indicator task pushes a chunk, then `await asyncio.sleep(...)`
- if that task wakes up a little late, the output queue runs empty
- when the queue is empty, `RawAudioTrack` emits silence
- those tiny silence insertions are heard as stutter or choppiness

This matches the production code path:

- `SmallWebRTCOutputTransport.write_audio_frame()` writes bytes as they arrive
- `RawAudioTrack.recv()` clock-pulls 10ms frames continuously
- queue starvation becomes audible immediately

Measured with the standalone simulation:

- `chunked_no_jitter`: `1/400` underrun frames
- `chunked_with_jitter`: `40/400` underrun frames
- `prebuffered_long_frame`: `0/400` underrun frames

## Recommended fix

Do not stream the waiting bed by sleeping between tiny `TTSAudioRawFrame`s.

Safer options:

1. Prebuffer a longer bed and enqueue larger frames ahead of time.
2. Better: move the waiting sound to the client/browser and loop it locally based on agent state.
3. If it must stay server-side, feed a dedicated continuous audio source/mixer instead of ad hoc frame pushes.

## What we tried and rejected

- Short discrete beeps: too noticeable and still timing-sensitive.
- Short continuous chunks with `asyncio.sleep`: sounded more natural than beeps, but still underruns under jitter.

## How to run

```bash
python3 testscripts/2026.04.14-thinking-audio-investigation/investigate.py
```

Outputs are written to `output/`.
