#!/bin/bash
# bench.sh run <dp> <range> <blocks> <layouts...>  -> K benchmarks one layout after another, logs bench_L<L>.log
# bench.sh status
cd "$(dirname "$0")"
case "$1" in
  run)
    dp=$2; range=$3; blocks=$4; shift 4
    setsid nohup bash -c "for L in $*; do timeout 3000 stdbuf -o0 ./bbkangaroo -dp $dp -range $range -blocks $blocks -layout \$L > bench_L\$L.log 2>&1; done" < /dev/null > /dev/null 2>&1 &
    disown; sleep 2; echo "launched: $(pgrep -x bbkangaroo | wc -l) process(es)";;
  status)
    for f in bench_L*.log; do echo "== $f"; tr '\r' '\n' < "$f" | grep -E "Points|Speed|kangaroos|overhead|rror" | tail -2; done;;
esac
