#!/bin/sh
# Builds hdrdump against a Beam core source tree and its CMake build (macOS/Homebrew paths by default).
#   BEAM_SRC=~/git/beam BEAM_BUILD=~/git/beam-build tools/hdrdump/build.sh
set -eu
BEAM_SRC=${BEAM_SRC:-$HOME/git/beam}
BEAM_BUILD=${BEAM_BUILD:-$HOME/git/beam-build}
BOOST=${BOOST:-$(brew --prefix boost)}
OPENSSL=${OPENSSL:-$(brew --prefix openssl@3)}
OUT=${OUT:-$(dirname "$0")/hdrdump}
B=$BEAM_BUILD

c++ -std=gnu++17 -O2 -pthread -DNDEBUG -DLOG_VERBOSE_ENABLED=0 -DBEAM_LELANTUS_SUPPORT -DBEAM_CONFIDENTIAL_ASSETS_SUPPORT \
  -Wno-overloaded-virtual -Wno-deprecated-literal-operator -Wno-vla-cxx-extension -Wno-enum-constexpr-conversion \
  -I"$BEAM_SRC" -I"$BEAM_SRC/3rdparty" -I"$BEAM_BUILD/core" -I"$BEAM_SRC/3rdparty/libuv/include" -I"$BEAM_SRC/bvm" \
  -I"$BEAM_SRC/3rdparty/secp256k1/include" -isystem "$BOOST/include" -isystem "$OPENSSL/include" \
  "$(dirname "$0")/hdrdump.cpp" -o "$OUT" \
  "$B/node/libnode.a" "$B/bvm/libbvm.a" "$B/core/libcore.a" "$B/pow/libpow.a" "$B/core/libcore.a" "$B/pow/libpow.a" \
  "$B/p2p/libp2p.a" "$B/3rdparty/libpbkdf.a" "$B/3rdparty/secp256k1/src/libsecp256k1.a" "$B/3rdparty/crypto/blake/libblake2b.a" \
  "$B/3rdparty/ethash/lib/ethash/libethash.a" "$B/3rdparty/ethash/lib/keccak/libkeccak.a" "$B/3rdparty/sqlite/libsqlite.a" \
  "$B/keykeeper/libkeykeeper.a" "$B/utility/libutility.a" "$B/3rdparty/libuv/libuv_a.a" \
  -L"$BOOST/lib" -lboost_filesystem -lboost_atomic -lboost_program_options -lboost_container -lboost_thread -lboost_log \
  -L"$OPENSSL/lib" -lssl -lcrypto -framework IOKit -framework CoreFoundation
echo "built $OUT"
