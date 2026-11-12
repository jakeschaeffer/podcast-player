#!/usr/bin/env python3
"""Make Snip/Sounds/ad-skip.wav, the sound of an ad break skipped on its own: a quick upward glide with a breath of
air that lands on a short ping, about a third of a second. It shares the snip chime's top note (E6, 1320 Hz) and its
level, so the app's sounds read as one family, but glides where the chime steps.

    python3 ios/scripts/ad-skip-sound.py        # rewrites the file; no packages needed
"""
import math
import random
import struct
import wave
from pathlib import Path

RATE = 44_100
LENGTH_S = 0.32
GLIDE_S = 0.12  # the rise, after which the note holds and rings out
LOW_HZ, HIGH_HZ = 500.0, 1320.0
PEAK = 0.37  # snip-created.wav's peak

random.seed(7)  # the same file every run
out, phase, low, high_in, high_out = [], 0.0, 0.0, 0.0, 0.0
for i in range(int(RATE * LENGTH_S)):
    t = i / RATE
    # Exponential glide (even in pitch), then the held note.
    hz = LOW_HZ * (HIGH_HZ / LOW_HZ) ** min(t / GLIDE_S, 1.0)
    phase += 2 * math.pi * hz / RATE
    tone = math.sin(phase) + 0.18 * math.sin(2 * phase)
    # Swells through the glide, then rings out like a struck note.
    if t < 0.012:
        env = 0.55 * (1 - math.cos(math.pi * t / 0.012)) / 2
    elif t < GLIDE_S:
        env = 0.55 + 0.45 * (t - 0.012) / (GLIDE_S - 0.012)
    else:
        env = math.exp(-(t - GLIDE_S) / 0.045)
    # Air: white noise kept between about 1.5 and 5 kHz, under the glide only.
    noise = random.uniform(-1, 1)
    low += 0.5 * (noise - low)  # one-pole low-pass, about 5 kHz
    high_out = 0.81 * (high_out + low - high_in)  # one-pole high-pass, about 1.5 kHz
    high_in = low
    air_env = math.sin(math.pi * min(t / 0.16, 1.0)) if t < 0.16 else 0.0
    sample = 0.8 * env * tone + 0.35 * air_env * high_out
    # The last 10 ms fade to silence, so the file ends without a click.
    sample *= min(1.0, (LENGTH_S - t) / 0.010)
    out.append(sample)

scale = PEAK / max(abs(s) for s in out)
path = Path(__file__).resolve().parent.parent / "Snip" / "Sounds" / "ad-skip.wav"
with wave.open(str(path), "wb") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(RATE)
    w.writeframes(b"".join(struct.pack("<h", round(s * scale * 32767)) for s in out))
print(f"wrote {path} ({LENGTH_S:.2f} s)")
