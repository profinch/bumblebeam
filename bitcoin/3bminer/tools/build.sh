#!/bin/bash
# usage: tools/build.sh <board> [idf.py args...]   boards: the folders in boards/
# one source tree, one version; per-board sdkconfig in build-<board>/, images in dist/
set -e
cd "$(dirname "$0")/.."
B=${1:?board}; shift || true
[ -f boards/$B/sdkconfig.defaults ] || { echo "unknown board $B"; exit 1; }
. ~/esp/esp-idf/export.sh >/dev/null 2>&1
idf.py -B build-$B -DSDKCONFIG=build-$B/sdkconfig -DSDKCONFIG_DEFAULTS="sdkconfig.defaults;boards/$B/sdkconfig.defaults" "${@:-build}"
V=$(grep -m1 'FW_VERSION "' main/version.h | cut -d'"' -f2)
mkdir -p dist && cp build-$B/3bminer.bin dist/3bminer-$B-$V.bin
cp build-$B/bootloader/bootloader.bin dist/bootloader-$B.bin; cp build-$B/partition_table/partition-table.bin dist/partition-table.bin; cp build-$B/ota_data_initial.bin dist/ota_data_initial.bin
ls -la dist/3bminer-$B-$V.bin
