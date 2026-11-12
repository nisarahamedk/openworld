#!/bin/sh
export PGDATA=/tmp/pg
mkdir -p $PGDATA && chown postgres $PGDATA
runuser -u postgres -- /usr/lib/postgresql/16/bin/initdb -D $PGDATA -A trust >/dev/null
runuser -u postgres -- /usr/lib/postgresql/16/bin/pg_ctl -D $PGDATA -l /tmp/pg.log -w -o "-c listen_addresses=127.0.0.1 -c unix_socket_directories=/tmp $PGOPTS" start >/dev/null
echo started; sleep 86400; echo "one day done $(date -u +%FT%TZ)"
