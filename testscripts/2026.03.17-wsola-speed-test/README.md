# WSOLA Speed Test

Validates a pure-numpy WSOLA (Waveform Similarity Overlap-Add) implementation
as a replacement for SoundTouch in the voice pipeline. SoundTouch has no pip
package, so WSOLA gives us pitch-preserving tempo control with zero native deps.

## What it tests

- WSOLA time-stretching at tempos 0.8x, 1.0x, 1.2x, 1.5x
- Duration ratio correctness (output duration should be ~1/tempo of input)
- Streaming mode with small 20ms chunks (matching Pipecat frame size)
- Writes WAV files to `output/` for manual listening verification

## How to run

```bash
pip install -r requirements.txt
python test_wsola.py
```

Check the console output for duration ratios and listen to the WAV files in `output/`.
