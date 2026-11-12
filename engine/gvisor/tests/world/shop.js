// A small shop backend for the 30-day world test. It talks to Postgres,
// Redis and the fake Adyen exactly as a real service would, and uses only
// ordinary timers. Nothing in here knows that time is being skipped.
import http from "node:http";
import pg from "pg";
import Redis from "ioredis";

const ADYEN = "http://127.0.0.1:8081";
const DAY = 86400e3;
const t0 = performance.now();
const day = () => (performance.now() - t0) / DAY;
const db = new pg.Pool({ host: "127.0.0.1", user: "postgres", database: "postgres", max: 4,
  connectionTimeoutMillis: 5000, idleTimeoutMillis: 600e3 });
const redis = new Redis({ host: "127.0.0.1", port: 6379, lazyConnect: false });
const errors = [];
db.on("error", (e) => errors.push(`pool: ${e.message}`));
redis.on("error", (e) => errors.push(`redis: ${e.message}`));

await db.query(`create table if not exists hooks (code text, psp text, at_day float8, at timestamptz default now())`);
await db.query(`create table if not exists cron (run int, at_day float8, at timestamptz default now())`);
await db.query(`create table if not exists churn (id serial primary key, v text)`);

// Webhook endpoint for the fake Adyen.
http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    const items = JSON.parse(body).notificationItems ?? [];
    for (const { NotificationRequestItem: n } of items) {
      await db.query("insert into hooks(code, psp, at_day) values ($1, $2, $3)", [n.eventCode, n.pspReference, day()]);
      console.log(`day ${day().toFixed(3)}  webhook ${n.eventCode}`);
    }
    res.end("[accepted]");
  });
}).listen(9000, "127.0.0.1");

async function adyen(path, body) {
  const r = await fetch(ADYEN + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
}

// A session token that must expire after 7 days (Redis TTL on world time).
await redis.set("session:alice", "ok", "EX", 7 * 86400);

const pay = await adyen("/v71/payments", { merchantAccount: "ShopECOM", reference: "order-42",
  amount: { currency: "EUR", value: 10000 },
  paymentMethod: { type: "scheme", brand: "visa", holderName: "Chargeback:10.4 10000 EUR" } });
await adyen(`/v71/payments/${pay.pspReference}/captures`, { amount: { currency: "EUR", value: 10000 } });
console.log(`day ${day().toFixed(3)}  paid and captured ${pay.pspReference}`);

// Hourly reconciliation cron for 30 days; it also churns rows so autovacuum has work.
let run = 0, sessionGoneDay = null;
const cron = setInterval(async () => {
  run++;
  await db.query("insert into cron(run, at_day) values ($1, $2)", [run, day()]);
  await db.query("insert into churn(v) select md5(random()::text) from generate_series(1, 200)");
  await db.query("delete from churn where id % 2 = 0");
  await redis.incr("cron:runs");
  if (sessionGoneDay === null && !(await redis.exists("session:alice"))) sessionGoneDay = day();
  if (run === 720) { clearInterval(cron); await report(); }
}, 3600e3);

async function report() {
  const hooks = (await db.query("select code, round(at_day::numeric, 3) d from hooks order by at_day")).rows;
  const c = (await db.query("select count(*)::int n, max(at_day) last from cron")).rows[0];
  const late = (await db.query("select max(at_day*24 - run) h from cron")).rows[0].h;
  const av = (await db.query("select autovacuum_count::int n, last_autovacuum from pg_stat_user_tables where relname = 'churn'")).rows[0];
  const dbNow = (await db.query("select now() n")).rows[0].n;
  console.log("RESULT " + JSON.stringify({
    cronRuns: c.n, lastCronDay: +c.last.toFixed(4), maxCronLateHours: +late.toFixed(5),
    webhooks: hooks.map((h) => `${h.code}@${h.d}`),
    sessionExpiredBetweenDay: sessionGoneDay, redisCronRuns: +(await redis.get("cron:runs")),
    autovacuumRunsOnChurn: av.n, lastAutovacuum: av.last, postgresNow: dbNow, errors,
  }, null, 1));
  await db.end(); redis.disconnect(); process.exit(0);
}
