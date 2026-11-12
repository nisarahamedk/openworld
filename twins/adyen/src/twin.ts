// The Adyen twin as a process: the Adyen-shaped API, a control API for
// agents (/__tesseract/...), and the glue that keeps the twin's timers on
// the world clock.

import http from "node:http";
import { Engine } from "./engine.ts";
import { Webhooks, type WebhookConfig } from "./webhooks.ts";
import { Adyen, ApiError, DEFAULT_TIMINGS } from "./adyen.ts";
import { ManualClock, SystemClock, WorldClock, type Clock } from "./clock.ts";

export interface TwinOptions {
  db: string;
  clock: Clock;
  webhooks: Partial<WebhookConfig>;
  rand?: () => number;
}

const DAY = 86400_000;

export function parseDuration(s: string | number): number {
  if (typeof s === "number") return s;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)?$/.exec(s.trim());
  if (!m) throw new ApiError(400, "000", `bad duration ${s}`);
  const mul = { ms: 1, s: 1000, m: 60_000, h: 3600_000, d: DAY, w: 7 * DAY }[(m[2] ?? "ms") as "ms"];
  return Math.round(Number(m[1]) * mul);
}

export class Twin {
  engine: Engine;
  webhooks: Webhooks;
  adyen: Adyen;
  clock: Clock;
  server: http.Server;
  private reportQueued = false;

  constructor(opts: TwinOptions) {
    this.clock = opts.clock;
    this.engine = new Engine(opts.db, opts.clock);
    const key = this.engine.meta("hmac_key") ?? Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex").toUpperCase();
    this.engine.setMeta("hmac_key", key);
    this.webhooks = new Webhooks(this.engine, {
      url: null, hmacKeyHex: key, duplicate: 0, reorderMaxMs: 0, failFirst: 0, ...opts.webhooks,
    }, opts.rand);
    this.adyen = new Adyen(this.engine, this.webhooks, DEFAULT_TIMINGS);
    this.server = http.createServer((req, res) => this.handle(req, res));

    if (this.clock instanceof WorldClock) {
      const wc = this.clock;
      wc.onTick = () => {
        this.engine.runDue();
        this.queueReport();
      };
      this.engine.onChange = () => this.queueReport();
    } else if (this.clock instanceof SystemClock) {
      // One OS timer for the earliest pending event; re-armed on every change.
      let timer: NodeJS.Timeout | null = null;
      const arm = () => {
        if (timer) clearTimeout(timer);
        timer = null;
        const next = this.engine.nextDeadline();
        if (next === null) return;
        timer = setTimeout(() => this.engine.runDue(), Math.max(0, next - this.clock.nowMs()));
      };
      this.engine.onChange = () => setImmediate(arm);
    }
  }

  /** Tell the coordinator our state, once per turn of the event loop. */
  private queueReport(): void {
    if (this.reportQueued || !(this.clock instanceof WorldClock)) return;
    this.reportQueued = true;
    setImmediate(() => {
      this.reportQueued = false;
      const wc = this.clock as WorldClock;
      const next = this.engine.nextDeadline();
      if (next !== null && next <= wc.nowMs() && !this.engine.busy()) {
        this.engine.runDue();
        return; // runDue's onChange queues the next report
      }
      wc.report({ busy: this.engine.busy(), deadlineMs: next });
    });
  }

  /** Manual clock only: move time forward, firing everything due on the way. */
  async advance(byMs: number, until?: (fired: string[]) => boolean): Promise<{ now: string; fired: string[] }> {
    const clock = this.clock;
    if (!(clock instanceof ManualClock)) throw new ApiError(409, "000", "time is owned by the Tesseract world clock; it advances on its own");
    const target = clock.nowMs() + byMs;
    const fired: string[] = [];
    for (;;) {
      const d = this.engine.nextDeadline();
      if (d === null || d > target) break;
      clock.set(Math.max(d, clock.nowMs()));
      const before = this.engine.pending().filter((t) => t.due_ms <= clock.nowMs()).map((t) => `${t.kind}:${t.ref}`);
      this.engine.runDue();
      await this.engine.settle();
      fired.push(...before);
      if (until?.(fired)) return { now: this.engine.iso(), fired };
    }
    clock.set(target);
    return { now: this.engine.iso(), fired };
  }

  private async body(req: http.IncomingMessage): Promise<any> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const s = Buffer.concat(chunks).toString("utf8");
    if (!s) return {};
    try {
      return JSON.parse(s);
    } catch {
      throw new ApiError(400, "702", "Unexpected input: invalid JSON");
    }
  }

  private async route(method: string, path: string, body: any): Promise<any> {
    const a = this.adyen;
    let m: RegExpExecArray | null;
    if (method === "POST" && /^\/v\d+\/payments$/.test(path)) return a.payments(body);
    if (method === "POST" && (m = /^\/v\d+\/payments\/([A-Z0-9]+)\/(captures|refunds|cancels|reversals)$/.exec(path))) {
      const [, ref, op] = m;
      if (op === "captures") return a.capture(ref, body);
      if (op === "refunds") return a.refund(ref, body);
      return a.cancel(ref, body, op === "reversals");
    }
    if (method === "POST" && (m = /\/DisputeService\/v\d+\/(defendDispute|acceptDispute)$/.exec(path))) {
      const ref = body.disputePspReference;
      return m[1] === "defendDispute" ? a.defend(ref) : a.accept(ref);
    }

    // ---- control API for agents and tests ----
    const e = this.engine;
    if (method === "GET" && path === "/__tesseract/now") return { now: e.iso(), world_ms: e.now(), clock: this.clock.constructor.name };
    if (method === "GET" && path === "/__tesseract/pending") {
      return e.pending().map((t) => ({ due: e.iso(t.due_ms), in: fmt(t.due_ms - e.now()), kind: t.kind, ref: t.ref,
        ...(t.kind === "deliver" ? { eventCode: t.payload.item.eventCode, attempt: t.payload.attempt } : {}) }));
    }
    if (method === "GET" && (m = /^\/__tesseract\/timeline\/([A-Z0-9]+)$/.exec(path))) {
      const p = e.get(m[1]);
      if (!p) throw new ApiError(404, "000", "unknown pspReference");
      return { pspReference: m[1], state: p.state, timeline: e.timeline(m[1]) };
    }
    if (method === "POST" && path === "/__tesseract/advance") {
      const by = parseDuration(body.by ?? 0);
      const untilCode: string | undefined = body.until;
      return this.advance(by, untilCode ? () => this.lastEmitted() === untilCode : undefined);
    }
    if (method === "POST" && path === "/__tesseract/force") return { forced: a.force(body.ref, body.kind ?? "next") };
    if (method === "POST" && path === "/__tesseract/snapshot") {
      e.snapshot(body.path);
      return { snapshot: body.path };
    }
    if (path === "/__tesseract/webhooks") {
      if (method === "POST") Object.assign(this.webhooks.cfg, body);
      const { hmacKeyHex, ...cfg } = this.webhooks.cfg;
      return { ...cfg, hmacKeyHex };
    }
    throw new ApiError(404, "000", `no route for ${method} ${path}`);
  }

  private lastEmitted(): string | undefined {
    const row = this.engine.db.prepare("select data from history where what = 'webhook.emitted' order by id desc limit 1").get() as any;
    return row ? JSON.parse(row.data).eventCode : undefined;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const done = this.engine.beginRequest();
    try {
      const url = new URL(req.url ?? "/", "http://twin");
      const out = await this.route(req.method ?? "GET", url.pathname, await this.body(req));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
    } catch (err: any) {
      const status = err instanceof ApiError ? err.status : 500;
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({
        status, errorCode: err.errorCode ?? "000", message: err.message, errorType: status >= 500 ? "internal" : "validation",
      }));
    } finally {
      done();
    }
  }

  listen(port: number, host = "127.0.0.1"): Promise<number> {
    return new Promise((resolve) => this.server.listen(port, host, () => resolve((this.server.address() as any).port)));
  }

  close(): void {
    this.server.close();
    this.engine.db.close();
  }
}

function fmt(ms: number): string {
  if (ms >= DAY) return `${(ms / DAY).toFixed(2)}d`;
  if (ms >= 3600_000) return `${(ms / 3600_000).toFixed(1)}h`;
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 1000).toFixed(1)}s`;
}
