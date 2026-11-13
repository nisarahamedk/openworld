#!/usr/bin/env bash
# Test 5: two sandboxes, one world clock. Coordinator skips only when both are
# idle and no bytes are in flight between them.
set -u
DEV=${DEV:?dir with runsc and tesscoord}
HERE=$(cd "$(dirname "$0")" && pwd)
R=$(mktemp -d)
G="--root=$R --rootless --network=host --overlay2=root:memory"
export TESS_SKIP=coord
$HERE/../bundle.sh $R/ba -- python3 $HERE/ledger.py
$HERE/../bundle.sh $R/bb -- env DAYS=${DAYS:-30} python3 $HERE/client.py
$DEV/runsc $G run --bundle $R/ba ledger > $R/a.out 2>&1 &
sleep 1
$DEV/runsc $G run --bundle $R/bb client > $R/b.out 2>&1 &
B=$!
sleep 1
s=$(date +%s.%N)
IDS="ledger client"
$DEV/tesscoord -root $R -quantum ${QUANTUM:-60s} -stats ${STATS:-5000} ${COORD_FLAGS:-} $IDS &
C=$!
until [ -s $R/b.out ]; do sleep 0.05; done
echo "host wall: $(echo "$(date +%s.%N) - $s" | bc) s"
echo "client: $(cat $R/b.out)"
kill $C 2>/dev/null; for id in $IDS; do $DEV/runsc --root=$R kill $id KILL 2>/dev/null; $DEV/runsc --root=$R delete -force $id 2>/dev/null; done; wait 2>/dev/null
