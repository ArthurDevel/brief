"""
Standalone investigation for stuttery server-side thinking audio.

Simulates the current architecture:
- producer emits short PCM chunks at a target cadence
- consumer drains 10ms frames continuously, like RawAudioTrack
- queue underruns become inserted silence
"""

from __future__ import annotations

import math
import os
import random
import wave
from array import array
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parent
OUTPUT_DIR = ROOT / "output"

SAMPLE_RATE = 24000
INT16_MAX = 32767
CONSUMER_FRAME_SECS = 0.01
CONSUMER_FRAME_SAMPLES = int(SAMPLE_RATE * CONSUMER_FRAME_SECS)
CHUNK_SECS = 0.08
CHUNK_SAMPLES = int(SAMPLE_RATE * CHUNK_SECS)
LONG_FRAME_SECS = 1.2
LONG_FRAME_SAMPLES = int(SAMPLE_RATE * LONG_FRAME_SECS)
TOTAL_SECS = 4.0
TOTAL_SAMPLES = int(SAMPLE_RATE * TOTAL_SECS)

BASE_FREQUENCY_HZ = 300.0
SWEEP_RANGE_HZ = 70.0
SWEEP_HZ = 0.9
TREMOLO_HZ = 1.8
AMPLITUDE = 0.045


@dataclass
class SimulationResult:
    audio: array
    underrun_frames: int
    total_frames: int


def synthesize(start_sample: int, sample_count: int) -> array:
    """Generate a phase-continuous thinking tone."""
    samples = array("h")
    for offset in range(sample_count):
        i = start_sample + offset
        t = i / SAMPLE_RATE
        sweep_phase = 2.0 * math.pi * SWEEP_HZ * t
        phase = (
            2.0 * math.pi * BASE_FREQUENCY_HZ * t
            + (SWEEP_RANGE_HZ / SWEEP_HZ) * (1.0 - math.cos(sweep_phase))
        )
        tremolo = 0.75 + 0.25 * math.sin(2.0 * math.pi * TREMOLO_HZ * t - (math.pi / 2.0))
        value = AMPLITUDE * tremolo * math.sin(phase)
        samples.append(int(max(-1.0, min(1.0, value)) * INT16_MAX))
    return samples


def write_wav(path: Path, pcm: array) -> None:
    with wave.open(str(path), "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(SAMPLE_RATE)
        wav_file.writeframes(pcm.tobytes())


def simulate_chunked(*, jitter_secs: float) -> SimulationResult:
    """Simulate short writes plus scheduler jitter against a 10ms consumer clock."""
    buffer = array("h")
    output = array("h")
    underrun_frames = 0
    total_frames = TOTAL_SAMPLES // CONSUMER_FRAME_SAMPLES

    next_chunk_time = 0.0
    produced_samples = 0

    for frame_index in range(total_frames):
        now = frame_index * CONSUMER_FRAME_SECS

        while produced_samples < TOTAL_SAMPLES and now >= next_chunk_time:
            chunk_size = min(CHUNK_SAMPLES, TOTAL_SAMPLES - produced_samples)
            buffer.extend(synthesize(produced_samples, chunk_size))
            produced_samples += chunk_size
            next_chunk_time += CHUNK_SECS + random.uniform(0.0, jitter_secs)

        if len(buffer) >= CONSUMER_FRAME_SAMPLES:
            output.extend(buffer[:CONSUMER_FRAME_SAMPLES])
            del buffer[:CONSUMER_FRAME_SAMPLES]
        else:
            missing = CONSUMER_FRAME_SAMPLES - len(buffer)
            if buffer:
                output.extend(buffer)
                buffer = array("h")
            output.extend(array("h", [0] * missing))
            underrun_frames += 1

    return SimulationResult(audio=output, underrun_frames=underrun_frames, total_frames=total_frames)


def simulate_prebuffered_long_frame() -> SimulationResult:
    """Simulate larger buffered writes to keep the queue ahead of the consumer."""
    buffer = array("h")
    output = array("h")
    underrun_frames = 0
    total_frames = TOTAL_SAMPLES // CONSUMER_FRAME_SAMPLES
    produced_samples = 0

    for frame_index in range(total_frames):
        if len(buffer) < LONG_FRAME_SAMPLES and produced_samples < TOTAL_SAMPLES:
            chunk_size = min(LONG_FRAME_SAMPLES, TOTAL_SAMPLES - produced_samples)
            buffer.extend(synthesize(produced_samples, chunk_size))
            produced_samples += chunk_size

        if len(buffer) >= CONSUMER_FRAME_SAMPLES:
            output.extend(buffer[:CONSUMER_FRAME_SAMPLES])
            del buffer[:CONSUMER_FRAME_SAMPLES]
        else:
            output.extend(array("h", [0] * CONSUMER_FRAME_SAMPLES))
            underrun_frames += 1

    return SimulationResult(audio=output, underrun_frames=underrun_frames, total_frames=total_frames)


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    random.seed(42)

    ideal = synthesize(0, TOTAL_SAMPLES)
    no_jitter = simulate_chunked(jitter_secs=0.0)
    with_jitter = simulate_chunked(jitter_secs=0.018)
    prebuffered = simulate_prebuffered_long_frame()

    write_wav(OUTPUT_DIR / "ideal_continuous.wav", ideal)
    write_wav(OUTPUT_DIR / "chunked_no_jitter.wav", no_jitter.audio)
    write_wav(OUTPUT_DIR / "chunked_with_jitter.wav", with_jitter.audio)
    write_wav(OUTPUT_DIR / "prebuffered_long_frame.wav", prebuffered.audio)

    print("Investigation outputs written to:", OUTPUT_DIR)
    print(
        "chunked_no_jitter underruns:",
        f"{no_jitter.underrun_frames}/{no_jitter.total_frames}",
    )
    print(
        "chunked_with_jitter underruns:",
        f"{with_jitter.underrun_frames}/{with_jitter.total_frames}",
    )
    print(
        "prebuffered_long_frame underruns:",
        f"{prebuffered.underrun_frames}/{prebuffered.total_frames}",
    )


if __name__ == "__main__":
    main()
