// twin-adyen [--port 8080] [--db adyen.sqlite] [--webhook-url URL]
//            [--tesseract /tmp/tesseract-participants.sock]
//            [--chaos-duplicate P] [--chaos-reorder DUR] [--chaos-fail-first P]

import { parseArgs } from "node:util";
import { ManualClock, SystemClock, WorldClock } from "./clock.ts";
import { Twin, parseDuration } from "./twin.ts";

const { values: v } = parseArgs({
  options: {
    port: { type: "string", default: "8080" },
    db: { type: "string", default: "adyen.sqlite" },
    "webhook-url": { type: "string" },
    tesseract: { type: "string" },
    "system-clock": { type: "boolean", default: false },
    "chaos-duplicate": { type: "string", default: "0" },
    "chaos-reorder": { type: "string", default: "0" },
    "chaos-fail-first": { type: "string", default: "0" },
  },
});

let clock;
if (v.tesseract) {
  const wc = new WorldClock(v.tesseract, "adyen");
  await wc.whenReady();
  clock = wc;
} else if (v["system-clock"]) {
  clock = new SystemClock();
} else {
  clock = new ManualClock();
}

const twin = new Twin({
  db: v.db!,
  clock,
  webhooks: {
    url: v["webhook-url"] ?? null,
    duplicate: Number(v["chaos-duplicate"]),
    reorderMaxMs: parseDuration(v["chaos-reorder"]!),
    failFirst: Number(v["chaos-fail-first"]),
  },
});
const port = await twin.listen(Number(v.port));
console.error(`adyen twin on http://127.0.0.1:${port} (${v.tesseract ? "world clock" : v["system-clock"] ? "system clock" : "manual clock"}, db ${v.db})`);
// Report initial state so the coordinator knows our future.
twin.engine.onChange();
