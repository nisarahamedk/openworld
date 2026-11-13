#!/usr/bin/env bash
# Test 3: run Postgres to day 12, checkpoint, restore three forks, change each
# fork differently, let them run on, and check they stay separate.
set -u
DEV=${DEV:?dir with patched runsc}
HERE=$(cd "$(dirname "$0")" && pwd)
W=$(mktemp -d); R=$W/root; IMG=$W/image; mkdir -p $R $IMG
G="--root=$R --network=none --overlay2=root:memory --ignore-cgroups"   # restore does not support --rootless
export TESS_SKIP=1 TESS_QUANTUM_MS=${TESS_QUANTUM_MS:-60000} TESS_GRACE_US=500
$HERE/../bundle.sh $W/b --netns -- /bin/sh $HERE/world.sh
q() { $DEV/runsc $G exec $1 runuser -u postgres -- psql -h 127.0.0.1 -Atc "$2"; }

s=$(date +%s.%N)
$DEV/runsc $G run --bundle $W/b orig > $W/orig.out 2>&1 &
until grep -q '^DAY 12' $W/orig.out; do sleep 0.1; done
$DEV/runsc $G checkpoint --image-path $IMG orig
echo "reached day 12 and checkpointed in $(echo "$(date +%s.%N) - $s" | bc) s host time"
echo "original's last line: $(tail -1 $W/orig.out)"
for n in 1 2 3; do
  $DEV/runsc $G restore --image-path $IMG --bundle $W/b --detach fork$n || exit 1
done
for n in 1 2 3; do
  echo "fork$n resumes at world time $(q fork$n "select now()")"
  q fork$n "insert into orders(note) select 'fork $n order ' || g from generate_series(1,$n) g" >/dev/null
done
sleep ${RUN_ON:-15}
for n in 1 2 3; do
  echo "fork$n after running on: now=$(q fork$n "select now()")  orders=[$(q fork$n "select string_agg(note, ', ' order by id) from orders")]  hourly ticks=$(q fork$n "select count(*) from ticks")"
done
echo "checkpoint image: $(du -sh $IMG | cut -f1)"
for id in fork1 fork2 fork3 orig; do $DEV/runsc $G kill $id KILL >/dev/null 2>&1; $DEV/runsc $G delete -force $id >/dev/null 2>&1; done
