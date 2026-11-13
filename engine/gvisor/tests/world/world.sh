#!/bin/sh
# Runs INSIDE the sandbox: Postgres + Redis + fake Adyen + shop, one shared clock.
set -e
HERE=$(dirname "$0"); TWIN=$1
export PGDATA=/tmp/pg
mkdir -p $PGDATA && chown postgres $PGDATA
runuser -u postgres -- /usr/lib/postgresql/16/bin/initdb -D $PGDATA -A trust >/dev/null
runuser -u postgres -- /usr/lib/postgresql/16/bin/pg_ctl -D $PGDATA -l /tmp/pg.log -w \
  -o "-c listen_addresses=127.0.0.1 -c autovacuum_naptime=60 -c unix_socket_directories=/tmp" start >/dev/null
redis-server --daemonize yes --save '' --logfile /tmp/redis.log ${REDIS_HZ:+--hz $REDIS_HZ}
node --no-warnings $TWIN/src/main.ts --system-clock --port 8081 --db /tmp/adyen.sqlite \
  --webhook-url http://127.0.0.1:9000/webhooks/adyen 2>/tmp/twin.log &
sleep 1
echo "world up at $(date -u +%FT%TZ)"
node $HERE/shop.js
echo "world done at $(date -u +%FT%TZ)"
