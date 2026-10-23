#!/bin/bash
# render.sh <kind> <html> <w,h> <G>: one frame to <G>/png/<kind>/<name>.png with its own Chrome profile (parallel-safe)
kind=$1; f=$2; size=$3; G=$4; n=$(basename "$f" .html); p="$G/prof/$kind-$n"
mkdir -p "$p"
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars --user-data-dir="$p" \
  --window-size="$size" --screenshot="$G/png/$kind/$n.png" "file://$f" >/dev/null 2>&1
rm -rf "$p"
