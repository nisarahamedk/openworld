#!/bin/sh
# Runs INSIDE the sandbox: Postgres plus an hourly job that records the world time.
export PGDATA=/tmp/pg PGHOST=127.0.0.1 PGUSER=postgres
mkdir -p $PGDATA && chown postgres $PGDATA
runuser -u postgres -- /usr/lib/postgresql/16/bin/initdb -D $PGDATA -A trust >/dev/null
runuser -u postgres -- /usr/lib/postgresql/16/bin/pg_ctl -D $PGDATA -l /tmp/pg.log -w \
  -o "-c listen_addresses=127.0.0.1 -c unix_socket_directories=/tmp -c autovacuum_naptime=600" start >/dev/null
psql -qc "create table ticks(at timestamptz default now(), who text default 'original')"
psql -qc "create table orders(id serial, note text, at timestamptz default now())"
h=0
while true; do
  sleep 3600; h=$((h+1))
  psql -qc "insert into ticks default values"
  [ $((h % 24)) -eq 0 ] && echo "DAY $((h/24)) $(date -u +%FT%TZ)"
done
