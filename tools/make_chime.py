"""IG Doorbell chime: original, synthesized here from sine partials (no samples, no third-party audio).

    python tools/make_chime.py && ffmpeg -i ig-doorbell-chime.wav -codec:a libmp3lame -b:a 128k -ac 1 \n        custom_components/ig_doorbell/sounds/ig-doorbell-chime.mp3

Three bell strikes E6 - C6 - G5 (a descending major arpeggio, 'ding-dong-dang'), bell timbre from
inharmonic partials with exponential decay, a soft attack to avoid clicks."""
import math, struct, wave
SR = 44100
def bell(f, t0, dur, amp, out):
    partials = [(1.0, 1.0, 1.0), (2.0, 0.45, 1.4), (2.76, 0.30, 1.9), (5.40, 0.12, 2.8), (0.5, 0.20, 0.8)]
    n0 = int(t0 * SR)
    for i in range(int(dur * SR)):
        t = i / SR
        env = (1 - math.exp(-t / 0.004)) * math.exp(-t * 2.2)
        s = sum(a * math.exp(-t * (d - 1) * 1.5) * math.sin(2 * math.pi * f * r * t) for r, a, d in partials)
        if n0 + i < len(out): out[n0 + i] += amp * env * s
total = 3.2
out = [0.0] * int(total * SR)
bell(1318.5, 0.00, 2.6, 0.30, out)   # E6
bell(1046.5, 0.45, 2.6, 0.30, out)   # C6
bell(784.0,  0.90, 2.3, 0.32, out)   # G5
peak = max(abs(x) for x in out)
out = [x / peak * 0.85 for x in out]
fade = int(0.15 * SR)
for i in range(fade): out[-1 - i] *= i / fade
with wave.open("ig-doorbell-chime.wav", "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes(b"".join(struct.pack("<h", int(x * 32767)) for x in out))
print("ok")
