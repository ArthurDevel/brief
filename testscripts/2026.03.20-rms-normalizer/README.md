# RMS-Based Audio Normalizer with Peak Limiting

## Goal

Prototype an RMS-based audio normalizer with peak limiting for use in the real-time voice pipeline. Deepgram TTS output is too quiet (RMS around -18 to -19.5 dBFS) and needs to be brought up to a consistent level without clipping.

The normalizer works in streaming mode (frame by frame) so it can be used in a real-time pipeline where audio arrives in small chunks.

## How to run

1. First run the audio-level-analysis test to generate the raw WAV files:
   ```
   cd ../2026.03.20-audio-level-analysis
   python3 test_audio_levels.py
   ```

2. Then run the normalizer test:
   ```
   python3 test_normalizer.py
   ```

## What it tests

- Processes raw Deepgram TTS phrases through the RMS normalizer
- Compares before/after levels (peak, RMS, headroom)
- Tests multiple target RMS levels (-12, -10, -8 dBFS)
- Validates streaming consistency by comparing chunk-by-chunk processing vs whole-phrase processing
