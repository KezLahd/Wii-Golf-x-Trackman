"""Parse ball_dump_*.bin and find floats that change like a velocity."""
import struct
import sys
import glob
import os

dumps = sorted(glob.glob(os.path.join(os.path.dirname(__file__), "ball_dump_*.bin")))
if not dumps:
    print("no dumps found"); sys.exit(1)

path = dumps[-1]
print(f"analyzing {os.path.basename(path)}\n")

with open(path, "rb") as f:
    data = f.read()

# Snapshots are separated by '=' x 64 + 'FRAME ... PTR ...\n' header.
SEP = b"=" * 64 + b"\n"
parts = data.split(SEP)
parts = [p for p in parts if p.strip()]

snapshots = []  # list of (frame_num, ball_addr, list-of-120-floats)
for p in parts:
    # First line: "FRAME nnnn PTR xxxxxxxx\n"
    nl = p.find(b"\n")
    header = p[:nl].decode("ascii", "replace")
    blob = p[nl+1:nl+1+0x1E0]  # 480 bytes
    if len(blob) != 0x1E0:
        continue

    parts2 = header.split()
    frame_num = int(parts2[1])
    ball_addr = int(parts2[3], 16)

    floats = []
    for i in range(0, 0x1E0, 4):
        floats.append(struct.unpack(">f", blob[i:i+4])[0])
    snapshots.append((frame_num, ball_addr, floats))

print(f"loaded {len(snapshots)} snapshots from frames "
      f"{[s[0] for s in snapshots]}")
print(f"ball ptr (frame 0): 0x{snapshots[0][1]:x}\n")

# Find offsets that:
#  - are non-zero in any snapshot
#  - change between snapshots (so they're dynamic, not static struct fields)
#  - magnitudes plausible for velocity in wu/frame (0.05 .. 30)
import math

def changes(offs, snaps):
    vals = [s[2][offs] for s in snaps]
    # Skip if all NaN or all same
    diffs = [abs(vals[i] - vals[i-1]) for i in range(1, len(vals))]
    return max(diffs) if diffs else 0.0

print("Offset   |  frame4    frame8    frame20   frame40   | max-delta")
print("-" * 76)
for off_idx in range(len(snapshots[0][2])):
    off = off_idx * 4
    vals = [s[2][off_idx] for s in snapshots]
    finite = [v for v in vals if not math.isnan(v) and not math.isinf(v)]
    if not finite:
        continue
    max_abs = max(abs(v) for v in finite)
    if max_abs > 1e6:
        continue
    delta = changes(off_idx, snapshots)

    # Show EVERY non-zero or changing offset — no filtering except tiny static.
    if max_abs < 1e-7 and delta < 1e-7:
        continue

    fmtvals = "  ".join(f"{v:>10.4f}" for v in vals)
    flag = ""
    if delta > 1e-4 and 0.05 < max_abs < 30:
        flag = " <-- DYNAMIC, velocity-magnitude"
    elif delta > 1e-4 and max_abs >= 30:
        flag = " <-- DYNAMIC, position-magnitude"
    elif delta < 1e-7 and max_abs < 30:
        flag = " (static, small)"
    elif delta < 1e-7:
        flag = " (static, large)"
    else:
        flag = " (slow decay)"
    print(f"+0x{off:03x}    | {fmtvals}  | delta={delta:>8.5f}{flag}")
