#!/bin/sh
# Copies the shared look (the repo's ui/) into the extension, which cannot load files from outside its own
# folder. Run after a ui/ change; the copy is committed so "Load unpacked" works straight from the clone.
set -e
here=$(cd "$(dirname "$0")" && pwd)
ui="$here/../../ui"
dst="$here/extension/ui"
mkdir -p "$dst/components"
cp "$ui/tokens.css" "$ui/base.css" "$ui/components.css" "$dst/"
cp "$ui/components/bb.js" "$ui/components/dd.js" "$ui/components/tips.js" "$dst/components/"
echo "ui/ -> $dst"
