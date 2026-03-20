"""
Test script for the RMS-based audio normalizer.

Reads raw Deepgram TTS WAV files from the previous audio-level-analysis test,
processes them through the RMS normalizer at various target levels, and reports
before/after metrics. Also validates streaming consistency.

Responsibilities:
- Load raw WAV files from the previous test
- Process through RMSNormalizer and measure before/after levels
- Test multiple target RMS levels (-12, -10, -8 dBFS)
- Validate streaming mode by comparing chunk-by-chunk vs whole-phrase processing
- Save normalized WAVs to output/
"""

import os
import sys
import wave
import shutil

import numpy as np

from rms_normalizer import RMSNormalizer

# ============================================================================
# CONSTANTS
# ============================================================================

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
INPUT_DIR = os.path.join(SCRIPT_DIR, "input")
OUTPUT_DIR = os.path.join(SCRIPT_DIR, "output")
PREVIOUS_TEST_OUTPUT = os.path.join(SCRIPT_DIR, "..", "2026.03.20-audio-level-analysis", "output")

PHRASE_FILES = ["raw_phrase_1.wav", "raw_phrase_2.wav", "raw_phrase_3.wav"]
TARGET_RMS_LEVELS = [-12.0, -10.0, -8.0]
SAMPLE_RATE = 16000
STREAMING_CHUNK_MS = 20  # 20ms chunks for streaming test


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

def _read_wav(filepath: str) -> bytes:
    """Read a WAV file and return the raw PCM bytes.

    Args:
        filepath: Path to the WAV file.

    Returns:
        Raw int16 PCM bytes.
    """
    with wave.open(filepath, "rb") as wf:
        if wf.getsampwidth() != 2:
            raise ValueError(f"Expected 16-bit WAV, got {wf.getsampwidth() * 8}-bit: {filepath}")
        if wf.getnchannels() != 1:
            raise ValueError(f"Expected mono WAV, got {wf.getnchannels()} channels: {filepath}")
        return wf.readframes(wf.getnframes())


def _write_wav(filepath: str, audio_bytes: bytes, sample_rate: int) -> None:
    """Write raw int16 PCM bytes to a WAV file.

    Args:
        filepath: Output file path.
        audio_bytes: Raw int16 PCM bytes.
        sample_rate: Sample rate in Hz.
    """
    with wave.open(filepath, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(audio_bytes)


def _measure_levels(audio_bytes: bytes) -> dict:
    """Measure audio levels from int16 PCM bytes.

    Args:
        audio_bytes: Raw int16 PCM bytes.

    Returns:
        Dict with peak_sample, peak_dbfs, rms_dbfs, headroom_db.
    """
    samples = np.frombuffer(audio_bytes, dtype=np.int16).astype(np.float32)

    peak_sample = int(np.max(np.abs(samples)))
    peak_linear = peak_sample / 32768.0
    peak_dbfs = 20.0 * np.log10(peak_linear) if peak_linear > 0 else -120.0

    rms_linear = np.sqrt(np.mean((samples / 32768.0) ** 2))
    rms_dbfs = 20.0 * np.log10(rms_linear) if rms_linear > 0 else -120.0

    headroom_db = 0.0 - peak_dbfs  # dB below full scale

    return {
        "peak_sample": peak_sample,
        "peak_dbfs": peak_dbfs,
        "rms_dbfs": rms_dbfs,
        "headroom_db": headroom_db,
    }


def _copy_input_files() -> None:
    """Copy raw WAV files from the previous test into input/.

    Raises:
        SystemExit: If the previous test output directory or files do not exist.
    """
    if not os.path.isdir(PREVIOUS_TEST_OUTPUT):
        print(f"ERROR: Previous test output not found at: {PREVIOUS_TEST_OUTPUT}")
        print("Please run the audio-level-analysis test first:")
        print("  cd ../2026.03.20-audio-level-analysis && python3 test_audio_levels.py")
        sys.exit(1)

    for filename in PHRASE_FILES:
        src = os.path.join(PREVIOUS_TEST_OUTPUT, filename)
        dst = os.path.join(INPUT_DIR, filename)

        if not os.path.isfile(src):
            print(f"ERROR: Missing file: {src}")
            print("Please run the audio-level-analysis test first:")
            print("  cd ../2026.03.20-audio-level-analysis && python3 test_audio_levels.py")
            sys.exit(1)

        shutil.copy2(src, dst)

    print(f"Copied {len(PHRASE_FILES)} WAV files from previous test.\n")


def _print_comparison_table(results: list[dict]) -> None:
    """Print a formatted comparison table of before/after levels.

    Args:
        results: List of dicts with phrase, target, before/after metrics.
    """
    header = f"{'Phrase':<12} {'Target':>8} {'RMS Before':>12} {'RMS After':>11} {'Peak Before':>13} {'Peak After':>12} {'Headroom':>10}"
    separator = "-" * len(header)

    print(separator)
    print(header)
    print(separator)

    for r in results:
        print(
            f"{r['phrase']:<12} "
            f"{r['target']:>7.1f} "
            f"{r['before']['rms_dbfs']:>11.1f} "
            f"{r['after']['rms_dbfs']:>11.1f} "
            f"{r['before']['peak_dbfs']:>12.1f} "
            f"{r['after']['peak_dbfs']:>11.1f} "
            f"{r['after']['headroom_db']:>9.1f}"
        )

    print(separator)


# ============================================================================
# MAIN TEST FUNCTIONS
# ============================================================================

def _test_normalization() -> None:
    """Test normalization at different target RMS levels and print results."""
    print("=" * 70)
    print("NORMALIZATION TEST")
    print("=" * 70)

    all_results = []

    for target_dbfs in TARGET_RMS_LEVELS:
        print(f"\n--- Target RMS: {target_dbfs} dBFS ---\n")

        normalizer = RMSNormalizer(target_rms_dbfs=target_dbfs)

        for i, filename in enumerate(PHRASE_FILES, start=1):
            filepath = os.path.join(INPUT_DIR, filename)
            audio_bytes = _read_wav(filepath)

            before = _measure_levels(audio_bytes)

            # Reset normalizer for each phrase (independent processing)
            normalizer.reset()
            normalized_bytes = normalizer.process(audio_bytes)

            after = _measure_levels(normalized_bytes)

            # Save output for the default target level (-12 dBFS)
            target_suffix = str(int(abs(target_dbfs)))
            output_filename = f"normalized_phrase_{i}_target_{target_suffix}.wav"
            _write_wav(os.path.join(OUTPUT_DIR, output_filename), normalized_bytes, SAMPLE_RATE)

            # Also save without target suffix for the -12 dBFS case
            if target_dbfs == -12.0:
                _write_wav(
                    os.path.join(OUTPUT_DIR, f"normalized_phrase_{i}.wav"),
                    normalized_bytes,
                    SAMPLE_RATE,
                )

            all_results.append({
                "phrase": f"Phrase {i}",
                "target": target_dbfs,
                "before": before,
                "after": after,
            })

    _print_comparison_table(all_results)
    print()


def _test_streaming_consistency() -> None:
    """Test that chunk-by-chunk processing gives similar results to whole-phrase."""
    print("=" * 70)
    print("STREAMING CONSISTENCY TEST")
    print("=" * 70)

    # Use phrase 2 (typically the longest)
    filepath = os.path.join(INPUT_DIR, PHRASE_FILES[1])
    audio_bytes = _read_wav(filepath)

    # Process whole phrase at once
    normalizer_whole = RMSNormalizer(target_rms_dbfs=-12.0)
    whole_result = normalizer_whole.process(audio_bytes)
    whole_levels = _measure_levels(whole_result)

    # Process in 20ms streaming chunks
    chunk_size_samples = int(SAMPLE_RATE * STREAMING_CHUNK_MS / 1000)
    chunk_size_bytes = chunk_size_samples * 2  # int16 = 2 bytes per sample

    normalizer_stream = RMSNormalizer(target_rms_dbfs=-12.0)
    stream_chunks = []

    for offset in range(0, len(audio_bytes), chunk_size_bytes):
        chunk = audio_bytes[offset:offset + chunk_size_bytes]
        normalized_chunk = normalizer_stream.process(chunk)
        stream_chunks.append(normalized_chunk)

    stream_result = b"".join(stream_chunks)
    stream_levels = _measure_levels(stream_result)

    # Save streaming result for comparison
    _write_wav(os.path.join(OUTPUT_DIR, "streaming_phrase_2.wav"), stream_result, SAMPLE_RATE)

    print(f"\nPhrase 2 - Whole vs Streaming ({STREAMING_CHUNK_MS}ms chunks)")
    print(f"  Whole  -> RMS: {whole_levels['rms_dbfs']:>7.2f} dBFS, Peak: {whole_levels['peak_dbfs']:>7.2f} dBFS")
    print(f"  Stream -> RMS: {stream_levels['rms_dbfs']:>7.2f} dBFS, Peak: {stream_levels['peak_dbfs']:>7.2f} dBFS")

    rms_diff = abs(whole_levels["rms_dbfs"] - stream_levels["rms_dbfs"])
    peak_diff = abs(whole_levels["peak_dbfs"] - stream_levels["peak_dbfs"])
    print(f"  Diff   -> RMS: {rms_diff:>7.2f} dB,   Peak: {peak_diff:>7.2f} dB")

    if rms_diff < 3.0 and peak_diff < 3.0:
        print("  Result: OK - differences are within acceptable range")
    else:
        print("  Result: WARNING - significant differences between whole and streaming")

    print()


# ============================================================================
# ENTRY POINT
# ============================================================================

if __name__ == "__main__":
    _copy_input_files()
    _test_normalization()
    _test_streaming_consistency()
    print("Done. Output files saved to output/")
