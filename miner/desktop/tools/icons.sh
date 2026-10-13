#!/bin/bash
# Regenerates src-tauri/icons (run on a Mac): PNGs from tools/icons.swift, then icon.ico from
# its 16-256 px frames (PNG-compressed entries, which every Windows since Vista reads).
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=src-tauri/icons
swift tools/icons.swift ../../pool/web/favicon.svg "$OUT"
python3 - "$OUT" <<'EOF'
import struct, sys, os
d = sys.argv[1]
sizes = [16, 24, 32, 48, 64, 256]
frames = [open(os.path.join(d, f"ico-{s}.png"), "rb").read() for s in sizes]
head = struct.pack("<HHH", 0, 1, len(frames))
offset = 6 + 16 * len(frames)
dirs, data = b"", b""
for s, f in zip(sizes, frames):
    dirs += struct.pack("<BBBBHHII", s % 256, s % 256, 0, 0, 1, 32, len(f), offset + len(data))
    data += f
open(os.path.join(d, "icon.ico"), "wb").write(head + dirs + data)
for s in sizes:
    os.remove(os.path.join(d, f"ico-{s}.png"))
EOF
ls "$OUT"
