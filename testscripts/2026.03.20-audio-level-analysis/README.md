# Audio Level Analysis

Measure TTS audio levels from Deepgram to determine if there is headroom for adding a gain stage in the voice pipeline.

## Goal

The voice assistant is too quiet on both phone and web. This script measures the actual peak and RMS levels of Deepgram TTS output, both before and after WSOLA speed processing (1.5x), to confirm there is unused headroom and calculate how much gain can safely be applied.

## How to run

```bash
pip install -r requirements.txt
python analyze_levels.py
```

## What it measures

For each test phrase, the script reports:

- **Peak sample value** -- the highest absolute sample value (out of 32768 for 16-bit audio)
- **Peak dBFS** -- peak level in decibels relative to full scale (0 dBFS = maximum possible level)
- **RMS dBFS** -- root mean square level in dBFS (average loudness)
- **Headroom** -- how many dB of gain can be applied before clipping occurs
- **Crest factor** -- peak-to-RMS ratio in dB (indicates how "peaky" vs "loud" the signal is)
- **Recommended gain** -- the multiplier needed to bring the peak to -3 dBFS

## Output files

WAV files are saved to `output/` for manual listening:
- `raw_phrase_N.wav` -- direct Deepgram TTS output
- `wsola_1.5x_phrase_N.wav` -- after WSOLA at 1.5x speed
- `wsola_1.0x_phrase_N.wav` -- after WSOLA at 1.0x (control/passthrough)
