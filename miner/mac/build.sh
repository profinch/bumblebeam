#!/bin/bash
# Builds the BumbleBeam Miner app for macOS 12 and later, one install per kind of Mac:
#   build/BumbleBeam-Miner-<version>-macOS-AppleSilicon.dmg
#   build/BumbleBeam-Miner-<version>-macOS-Intel.dmg
# The version is the console miner's (../Cargo.toml): one product, one version.
# The apps themselves are put together under build/apps.noindex/: Spotlight skips a folder named
# *.noindex, so the build copies never show up as more apps next to the installed one.
#
#   ./build.sh [arm64|x86_64 ...]     (both by default)
#
# Inside each app (Contents/MacOS): the menu bar app, mxbm (GPU, Metal; MXBM with our patches,
# vendor/<arch>/mxbm, built by tools/build-mxbm.sh with OpenSSL linked in) and bumblebeam-miner
# (CPU, the console miner, built here from ..). The apps are ad-hoc signed: on another Mac the first launch is
# right-click > Open (or System Settings > Privacy & Security > Open Anyway).
set -euo pipefail
cd "$(dirname "$0")"
export DEVELOPER_DIR=${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}
VERSION=${VERSION:-$(sed -nE 's/^version = "(.*)"/\1/p' ../Cargo.toml | head -1)}
MIN_OS=12.0
ARCHS=${*:-arm64 x86_64}

for A in $ARCHS; do
  case $A in
    arm64)  KIND=AppleSilicon; DIR=apple-silicon; RUST=aarch64-apple-darwin ;;
    x86_64) KIND=Intel;        DIR=intel;         RUST=x86_64-apple-darwin ;;
    *) echo "unknown arch $A"; exit 1 ;;
  esac
  [ -x "vendor/$A/mxbm" ] || { echo "vendor/$A/mxbm missing: run tools/build-mxbm.sh <MXBM checkout> $A"; exit 1; }

  swift build -c release --arch "$A"
  BIN=$(swift build -c release --arch "$A" --show-bin-path)/BumbleBeamMiner
  (cd .. && MACOSX_DEPLOYMENT_TARGET=$MIN_OS cargo build --release --target "$RUST" -q)
  CPU=../target/$RUST/release/bumblebeam-miner

  APP="build/apps.noindex/$DIR/BumbleBeam Miner.app"
  C="$APP/Contents"
  rm -rf "build/apps.noindex/$DIR"
  mkdir -p "$C/MacOS" "$C/Resources/MXBM"
  cp "$BIN" "$C/MacOS/BumbleBeamMiner"
  cp "vendor/$A/mxbm" "$C/MacOS/mxbm"
  cp "$CPU" "$C/MacOS/bumblebeam-miner"
  strip -x "$C/MacOS/bumblebeam-miner"
  cp vendor/LICENSE vendor/NOTICE "$C/Resources/MXBM/"
  cp ../mxbm-patches/*.patch "$C/Resources/MXBM/"
  cp ../../LICENSE "$C/Resources/LICENSE"

  # nothing inside may need a newer macOS than the app says, nor a library outside the system
  for f in "$C"/MacOS/*; do
    minos=$(otool -l "$f" | awk '/LC_BUILD_VERSION/{f=1} f&&/minos/{print $2; exit}')
    [ "$(printf '%s\n%s\n' "$minos" "$MIN_OS" | sort -V | tail -1)" = "$MIN_OS" ] || { echo "$f needs macOS $minos"; exit 1; }
    [ "$(lipo -archs "$f")" = "$A" ] || { echo "$f is $(lipo -archs "$f"), not $A"; exit 1; }
    if otool -L "$f" | tail -n +2 | grep -vE '^\s+/(usr/lib|System/Library)/' | grep -q .; then
      echo "$f links a library outside the system:"; otool -L "$f"; exit 1
    fi
  done

  # icon
  swift tools/icon.swift ../../pool/web/favicon.svg build/AppIcon.iconset
  iconutil -c icns build/AppIcon.iconset -o "$C/Resources/AppIcon.icns"

  cat > "$C/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>BumbleBeam Miner</string>
  <key>CFBundleDisplayName</key><string>BumbleBeam Miner</string>
  <key>CFBundleIdentifier</key><string>org.bumblebeam.miner</string>
  <key>CFBundleExecutable</key><string>BumbleBeamMiner</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>$MIN_OS</string>
  <key>LSUIElement</key><true/>
  <key>LSApplicationCategoryType</key><string>public.app-category.utilities</string>
  <key>NSHumanReadableCopyright</key><string>BumbleBeam pool. MXBM by maxnflaxl, Apache-2.0.</string>
</dict>
</plist>
EOF

  # ad-hoc signature, inside out
  for f in "$C/MacOS/mxbm" "$C/MacOS/bumblebeam-miner" "$C/MacOS/BumbleBeamMiner"; do
    codesign --force --sign - --timestamp=none "$f"
  done
  codesign --force --sign - --timestamp=none "$APP"
  codesign --verify --deep --strict "$APP"

  # dmg: the app and a link to /Applications
  DMG="build/BumbleBeam-Miner-$VERSION-macOS-$KIND.dmg"
  STAGE="build/apps.noindex/dmg-$DIR"
  rm -rf "$STAGE" "$DMG"
  mkdir -p "$STAGE"
  cp -R "$APP" "$STAGE/"
  ln -s /Applications "$STAGE/Applications"
  hdiutil create -volname "BumbleBeam Miner" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
  # the build copies are not installed apps: keep them out of Launchpad and "Open With"
  LSR=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
  "$LSR" -u "$PWD/$STAGE/BumbleBeam Miner.app" 2>/dev/null || true
  "$LSR" -u "$PWD/$APP" 2>/dev/null || true
  rm -rf "$STAGE"
  echo "$DMG ($(du -h "$DMG" | cut -f1))"
done
