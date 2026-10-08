#!/bin/sh
# Builds coinbase_test, bb-finalizer and bb-coinbase against a Beam core source tree and its CMake build.
# The chain test and the finalizer need the node patch from profinch/beam, branch feat/foreign-coinbase
# (see README.md). macOS/Homebrew and Linux (apt: libboost-all-dev libssl-dev) are covered.
#   BEAM_SRC=~/git/beam-cb BEAM_BUILD=~/git/beam-cb-build tools/coinbase/build.sh [test|finalizer|miner|all]
set -eu
BEAM_SRC=${BEAM_SRC:-$HOME/git/beam-cb}
BEAM_BUILD=${BEAM_BUILD:-$HOME/git/beam-cb-build}
DIR=$(cd "$(dirname "$0")" && pwd)
OUTDIR=${OUTDIR:-$DIR}
B=$BEAM_BUILD
WHAT=${1:-all}

case "$(uname -s)" in
  Darwin)
    BOOST=${BOOST:-$(brew --prefix boost)}
    OPENSSL=${OPENSSL:-$(brew --prefix openssl@3)}
    SYS_INC="-isystem $BOOST/include -isystem $OPENSSL/include"
    SYS_LIB="-L$BOOST/lib -L$OPENSSL/lib -framework IOKit -framework CoreFoundation"
    WARN="-Wno-deprecated-literal-operator -Wno-vla-cxx-extension -Wno-enum-constexpr-conversion"
    ;;
  *)
    SYS_INC=""
    SYS_LIB="-ldl -lrt"
    WARN="-Wno-deprecated-declarations -Wno-maybe-uninitialized"
    ;;
esac

LIBS="$B/node/libnode.a $B/bvm/libbvm.a $B/core/libcore.a $B/pow/libpow.a $B/core/libcore.a $B/pow/libpow.a \
  $B/p2p/libp2p.a $B/3rdparty/libpbkdf.a $B/3rdparty/secp256k1/src/libsecp256k1.a $B/3rdparty/crypto/blake/libblake2b.a \
  $B/3rdparty/ethash/lib/ethash/libethash.a $B/3rdparty/ethash/lib/keccak/libkeccak.a $B/3rdparty/sqlite/libsqlite.a $B/3rdparty/re2/libre2.a \
  $B/utility/libutility.a $B/3rdparty/libuv/libuv_a.a"
MNEMONIC="$B/mnemonic/libmnemonic.a"
[ -f "$MNEMONIC" ] || { echo "need $MNEMONIC: build the wallet target too (ninja -C $B beam-wallet)"; exit 1; }
LIBS="$LIBS $MNEMONIC $B/utility/libcli.a $B/utility/libutility.a $B/core/libcore.a"
BOOSTLIBS="-lboost_filesystem -lboost_atomic -lboost_container -lboost_thread -lboost_log -lboost_program_options"

build() { # out, sources...
  out=$1; shift
  c++ -std=gnu++17 -O2 -pthread -DNDEBUG -DLOG_VERBOSE_ENABLED=0 -DBC_STATIC -DUV_INTERNAL \
    -Wno-overloaded-virtual $WARN \
    -I"$BEAM_SRC" -I"$BEAM_SRC/3rdparty" -I"$BEAM_BUILD/core" -I"$BEAM_SRC/3rdparty/libuv/include" -I"$BEAM_SRC/bvm" \
    -I"$BEAM_SRC/3rdparty/secp256k1/include" $SYS_INC \
    "$@" -o "$out" $LIBS $SYS_LIB $BOOSTLIBS -lssl -lcrypto
  echo "built $out"
}

case "$WHAT" in
  test)      build "$OUTDIR/coinbase_test" "$DIR/coinbase.cpp" "$DIR/coinbase_test.cpp" ;;
  finalizer) build "$OUTDIR/bb-finalizer" "$DIR/coinbase.cpp" "$DIR/finalizer.cpp" ;;
  miner)     build "$OUTDIR/bb-coinbase" "$DIR/coinbase.cpp" "$DIR/bb-coinbase.cpp" ;;
  all)
    build "$OUTDIR/coinbase_test" "$DIR/coinbase.cpp" "$DIR/coinbase_test.cpp"
    build "$OUTDIR/bb-finalizer" "$DIR/coinbase.cpp" "$DIR/finalizer.cpp"
    build "$OUTDIR/bb-coinbase" "$DIR/coinbase.cpp" "$DIR/bb-coinbase.cpp" ;;
  *) echo "usage: build.sh [test|finalizer|miner|all]"; exit 1 ;;
esac
