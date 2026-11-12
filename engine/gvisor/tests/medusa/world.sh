#!/bin/sh
# Runs INSIDE the sandbox: a stock Medusa v2 backend with Postgres and Redis,
# plus one hourly scheduled job. Checks time-dependent behaviour over 3 days.
APP=${1:?medusa backend dir}
export PGDATA=/tmp/pg
mkdir -p $PGDATA && chown postgres $PGDATA
runuser -u postgres -- /usr/lib/postgresql/16/bin/initdb -D $PGDATA -A trust >/dev/null
runuser -u postgres -- /usr/lib/postgresql/16/bin/pg_ctl -D $PGDATA -l /tmp/pg.log -w \
  -o "-c listen_addresses=127.0.0.1 -c unix_socket_directories=/tmp ${PGOPTS:-}" start >/dev/null
redis-server --daemonize yes --save '' --logfile /tmp/redis.log
runuser -u postgres -- psql -h 127.0.0.1 -qc "create database medusa"
cd $APP   # runs in place; gVisor gives the sandbox a private in-memory overlay, so the host copy is untouched
export DATABASE_URL=postgres://postgres@127.0.0.1:5432/medusa NODE_ENV=development
npx medusa db:migrate > /tmp/migrate.log 2>&1 || { tail -20 /tmp/migrate.log; exit 1; }
npx medusa user -e admin@world.test -p world-pass-123 > /tmp/user.log 2>&1 || { tail -5 /tmp/user.log; exit 1; }
npx medusa develop > /tmp/medusa.log 2>&1 &
until curl -sf http://127.0.0.1:9000/health >/dev/null; do sleep 1; done
day() { echo "$(( ($(date +%s) - T0) / 86400 )).$(( ( ($(date +%s) - T0) % 86400) * 100 / 86400 ))"; }
T0=$(date +%s)
echo "medusa up at $(date -u +%FT%TZ)"
TOKEN=$(curl -s -X POST http://127.0.0.1:9000/auth/user/emailpass -H 'content-type: application/json' \
  -d '{"email":"admin@world.test","password":"world-pass-123"}' | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
me() { curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:9000/admin/users/me -H "authorization: Bearer $TOKEN"; }
echo "day $(day): admin token works? HTTP $(me)"
sleep 43200; echo "day $(day): admin token after 12 hours: HTTP $(me)"
sleep 86400; echo "day $(day): admin token after 1.5 days: HTTP $(me)"
sleep 129600
echo "day $(day): hourly job runs logged: $(grep -c TESSJOB /tmp/medusa.log)"
grep TESSJOB /tmp/medusa.log | sed -n '1p;$p' | sed 's/.*TESSJOB/  first\/last: TESSJOB/'
echo "medusa errors in log: $(grep -ci 'error' /tmp/medusa.log)"
