import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { ManualClock } from "../src/clock.ts";
import { Twin } from "../src/twin.ts";
import { verify, type NotificationItem } from "../src/webhooks.ts";
import { addBusinessDays } from "../src/adyen.ts";

const DAY = 86400_000;

/** A merchant webhook endpoint that records what it receives. */
async function receiver(behaviour: (n: number) => "accept" | "fail" = () => "accept") {
  const got: NotificationItem[] = [];
  let n = 0;
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    if (behaviour(n++) === "fail") return res.writeHead(500).end("boom");
    for (const w of JSON.parse(body).notificationItems) got.push(w.NotificationRequestItem);
    res.writeHead(200).end("[accepted]");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as any).port}/webhooks`;
  return { got, url, close: () => server.close() };
}

async function setup(behaviour?: (n: number) => "accept" | "fail") {
  const hook = await receiver(behaviour);
  const clock = new ManualClock(Date.parse("2026-01-05T09:00:00Z")); // a Monday
  const twin = new Twin({ db: ":memory:", clock, webhooks: { url: hook.url } });
  const port = await twin.listen(0);
  const call = async (path: string, body: object = {}, method = "POST") => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: { "content-type": "application/json", "x-api-key": "test" },
      body: method === "GET" ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() as any };
  };
  const done = () => { twin.close(); hook.close(); };
  return { twin, hook, call, done, codes: () => hook.got.map((w) => w.eventCode) };
}

const card = (holderName = "Test Shopper", extra: object = {}) => ({
  merchantAccount: "TesseractECOM", reference: "order-1", amount: { currency: "EUR", value: 10000 },
  paymentMethod: { type: "scheme", brand: "visa", holderName }, ...extra,
});

test("card: authorise, capture, settle, chargeback, defense window lapses", async () => {
  const { call, done, codes, hook, twin } = await setup();
  const pay = await call("/v71/payments", card("Chargeback:10.4 10000 EUR"));
  assert.equal(pay.body.resultCode, "Authorised");
  const psp = pay.body.pspReference;
  assert.equal((await call(`/v71/payments/${psp}/captures`, { amount: { currency: "EUR", value: 10000 } })).status, 200);

  await call("/__tesseract/advance", { by: "60d" });
  assert.deepEqual(codes(), ["AUTHORISATION", "CAPTURE", "NOTIFICATION_OF_CHARGEBACK", "CHARGEBACK", "DISPUTE_DEFENSE_PERIOD_ENDED"]);

  // Each webhook carries its own virtual timestamp and a valid signature.
  const at = Object.fromEntries(hook.got.map((w) => [w.eventCode, Date.parse(w.eventDate)]));
  const t0 = Date.parse("2026-01-05T09:00:00Z");
  assert.equal(at.CAPTURE - t0, 2 * 60_000);
  const settled = addBusinessDays(t0 + 2 * 60_000, 2);
  assert.equal(at.NOTIFICATION_OF_CHARGEBACK, settled + 14 * DAY);
  assert.equal(at.DISPUTE_DEFENSE_PERIOD_ENDED, at.NOTIFICATION_OF_CHARGEBACK + 7 * DAY);
  const key = twin.webhooks.cfg.hmacKeyHex;
  assert.ok(hook.got.every((w) => verify(w, key)));

  const tl = (await call(`/__tesseract/timeline/${psp}`, {}, "GET")).body;
  assert.equal(tl.state, "chargeback_lost");
  done();
});

test("dispute defended: reversed, then a second chargeback", async () => {
  const { call, done, codes } = await setup();
  const psp = (await call("/v71/payments", card("Chargeback:4837 second"))).body.pspReference;
  await call(`/v71/payments/${psp}/captures`, {});
  const r = await call("/__tesseract/advance", { by: "30d", until: "NOTIFICATION_OF_CHARGEBACK" });
  assert.equal(codes().at(-1), "NOTIFICATION_OF_CHARGEBACK", JSON.stringify(r.body));

  // The agent can see the provider's future before acting on it.
  const pending = (await call("/__tesseract/pending", {}, "GET")).body.map((p: any) => p.kind);
  assert.deepEqual(pending, ["dispute.book", "dispute.window"]);

  assert.equal((await call("/ca/services/DisputeService/v30/defendDispute", { disputePspReference: psp })).status, 200);
  await call("/__tesseract/advance", { by: "30d" });
  assert.deepEqual(codes().slice(2), ["NOTIFICATION_OF_CHARGEBACK", "CHARGEBACK", "CHARGEBACK_REVERSED", "SECOND_CHARGEBACK"]);
  done();
});

test("SEPA direct debit: pending now, authorised on the 5th business day", async () => {
  const { call, done, hook } = await setup();
  // Friday afternoon: the weekend must not count.
  await call("/__tesseract/advance", { by: "4d" });
  await call("/v71/payments", { merchantAccount: "M", amount: { currency: "EUR", value: 2500 },
    paymentMethod: { type: "sepadirectdebit", ownerName: "A Shopper", iban: "NL13TEST0123456789" } });
  await call("/__tesseract/advance", { by: "10d" });
  const [pending, auth] = hook.got;
  assert.equal(pending.eventCode, "PENDING");
  assert.equal(auth.eventCode, "AUTHORISATION");
  assert.equal(new Date(pending.eventDate).getUTCDay(), 5);
  assert.equal(auth.eventDate.slice(0, 10), "2026-01-16"); // Fri 9th + 5 business days
  done();
});

test("uncaptured authorisation expires", async () => {
  const { call, done, codes } = await setup();
  const psp = (await call("/v71/payments", card())).body.pspReference;
  await call("/__tesseract/advance", { by: "8d" });
  assert.deepEqual(codes(), ["AUTHORISATION", "EXPIRE"]);
  assert.equal((await call(`/v71/payments/${psp}/captures`, {})).status, 422);
  done();
});

test("refunds cannot exceed the capture, even when requested together", async () => {
  const { call, done, codes } = await setup();
  const psp = (await call("/v71/payments", card())).body.pspReference;
  await call(`/v71/payments/${psp}/captures`, {});
  await call("/__tesseract/advance", { by: "1h" });
  const half = { amount: { currency: "EUR", value: 6000 } };
  const [a, b] = await Promise.all([call(`/v71/payments/${psp}/refunds`, half), call(`/v71/payments/${psp}/refunds`, half)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 422]);
  await call("/__tesseract/advance", { by: "1d" });
  assert.deepEqual(codes(), ["AUTHORISATION", "CAPTURE", "REFUND"]);
  done();
});

test("webhook endpoint down: Adyen-style retries in virtual time", async () => {
  // Fail the first 5 attempts of anything.
  const { call, done, twin } = await setup((n) => (n < 5 ? "fail" : "accept"));
  const psp = (await call("/v71/payments", card())).body.pspReference;
  await call("/__tesseract/advance", { by: "1h" });
  const attempts = twin.engine.timeline(psp).filter((h) => h.what === "webhook.attempt");
  assert.deepEqual(attempts.map((a) => a.ok), [false, false, false, false, false, true]);
  // 3 immediate retries, then 2 and 5 minutes.
  assert.equal(attempts[5].at_ms - attempts[0].at_ms, 7 * 60_000);
  done();
});

test("fork: snapshot an expensive state and branch from it", async () => {
  const { call, done, twin } = await setup();
  const psp = (await call("/v71/payments", card("Chargeback:10.4"))).body.pspReference;
  await call(`/v71/payments/${psp}/captures`, {});
  await call("/__tesseract/advance", { by: "30d", until: "NOTIFICATION_OF_CHARGEBACK" });
  const path = `/tmp/adyen-fork-${process.pid}.sqlite`;
  await call("/__tesseract/snapshot", { path });
  const fork = new Twin({ db: path, clock: new ManualClock(twin.clock.startUnixMs, twin.clock.nowMs()), webhooks: {} });
  assert.deepEqual(fork.engine.pending().map((t) => t.kind), ["dispute.book", "dispute.window"]);
  fork.close();
  done();
});
