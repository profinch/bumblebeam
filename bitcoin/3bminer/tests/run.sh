#!/bin/bash
# host tests: tests/run.sh (gcc and python3)
set -e
cd "$(dirname "$0")"; M=../firmware/main
mkdir -p ../build && python3 vectors.py
gcc -std=gnu17 -O1 -Wall -Wextra -Wno-unused-parameter -fsanitize=address,undefined -I$M -I. -o ../build/test_host test_host.c $M/addr.c $M/netcheck.c $M/sha256.c $M/job.c -lm
../build/test_host
