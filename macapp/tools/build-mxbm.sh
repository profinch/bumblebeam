#!/bin/bash
# Builds mxbm for the app, per architecture, for macOS 12 and later, into vendor/<arch>/mxbm.
#
#   tools/build-mxbm.sh <MXBM source checkout> [arm64|x86_64 ...]
#
# The checkout is MXBM with our patches (vendor/patches/): the macOS build fixes, the Metal load
# limit and the Metal language/deployment-target switch. OpenSSL is built static from the official
# release (checked against its published SHA-256), so mxbm loads no Homebrew library; the Metal
# kernels are compiled for Metal 2.4 (macOS 12). Needs Xcode with the Metal toolchain and CMake.
set -euo pipefail
cd "$(dirname "$0")/.."
SRC=$(cd "$1" && pwd); shift
ARCHS=${*:-arm64 x86_64}
export DEVELOPER_DIR=${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}
OSSL=3.5.9
OSSL_SHA=603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a
W=$PWD/build/mxbm-work
mkdir -p "$W"

tar="$W/openssl-$OSSL.tar.gz"
if [ ! -f "$tar" ]; then
  curl -sSfL -o "$tar" "https://github.com/openssl/openssl/releases/download/openssl-$OSSL/openssl-$OSSL.tar.gz"
fi
echo "$OSSL_SHA  $tar" | shasum -a 256 -c - >/dev/null

for A in $ARCHS; do
  T=$([ "$A" = arm64 ] && echo darwin64-arm64-cc || echo darwin64-x86_64-cc)
  O=$W/openssl-$A
  if [ ! -f "$O/lib/libssl.a" ]; then
    rm -rf "$W/openssl-src-$A"; mkdir -p "$W/openssl-src-$A"
    (cd "$W/openssl-src-$A" && tar xzf "$tar" --strip-components 1 &&
     MACOSX_DEPLOYMENT_TARGET=12.0 ./Configure "$T" no-shared no-tests no-docs no-apps --prefix="$O" \
       --openssldir=/etc/ssl -mmacosx-version-min=12.0 > configure.log 2>&1 &&
     make -j"$(sysctl -n hw.ncpu)" > make.log 2>&1 && make install_sw > install.log 2>&1)
  fi
  B=$W/mxbm-$A
  rm -rf "$B"; mkdir -p "$B/generated"
  (cd "$B" &&
   cmake "$SRC" -DCMAKE_BUILD_TYPE=Release -DMXBM_METAL_ABL_DERIVE=0 \
     -DCMAKE_OSX_ARCHITECTURES="$A" -DCMAKE_OSX_DEPLOYMENT_TARGET=12.0 -DMXBM_METAL_STD=macos-metal2.4 \
     -DOPENSSL_ROOT_DIR="$O" -DOPENSSL_USE_STATIC_LIBS=TRUE > cmake.log 2>&1 &&
   make -j"$(sysctl -n hw.ncpu)" mxbm > make.log 2>&1)
  mkdir -p "vendor/$A"
  cp "$B/mxbm" "vendor/$A/mxbm"
  echo "vendor/$A/mxbm: $(lipo -archs "vendor/$A/mxbm"), macOS $(otool -l "vendor/$A/mxbm" | awk '/LC_BUILD_VERSION/{f=1} f&&/minos/{print $2; exit}')+"
done
