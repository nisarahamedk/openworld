// The world a scenario plays in. Everything here runs on world time: the sandbox's clock skips forward whenever every
// program in it is waiting, so `sleep(3 * DAY)` returns as soon as nothing else is due.
import type { Observations } from "./observe.ts";
import { routeOf } from "./observe.ts";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export type AppFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  /** Sent as JSON with content-type application/json. */
  json?: unknown;
  body?: string;
  /** Who is making the request, for the report ("owner-3", "stripe"). */
  actor?: string;
};

/** The product as the world reaches it: its front door, its crons and its data. */
export interface HostedApp {
  fetch(req: Request): Promise<Response>;
  scheduled(cron: string, at: Date): Promise<string>;
  crons(): string[];
  /** Runs SQL against one of the app's databases (read-only use: checks). */
  sql(db: string, query: string): Promise<Record<string, unknown>[]>;
  databases(): string[];
  dispose(): Promise<void>;
}

/** A provider stand-in: answers the app's calls to one host, and can call the app back (webhooks). */
export interface Twin {
  readonly name: string;
  handle(req: Request): Promise<Response>;
}
export type TwinFactory = (world: World, options: { host: string }) => Twin;

// While a request is in flight between programs inside the sandbox, the engine can't see the bytes (it counts only
// host sockets), so a quiet moment mid-request could skip time and expire a token or a timeout. Holding the clock
// keeps a 1 ms timer armed while anything is in flight: the next deadline is never more than 1 ms away, so a skip
// can move time by at most that. Between requests nothing is held and the world skips freely.
let held = 0;
let ticker: ReturnType<typeof setInterval> | null = null;
export function holdClock(): () => void {
  if (held++ === 0) ticker = setInterval(() => {}, 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (--held === 0 && ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  };
}

export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 1;
  }
  float(): number {
    // mulberry32
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.float() * (max - min + 1));
  }
  chance(p: number): boolean {
    return this.float() < p;
  }
  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.float() * xs.length)] as T;
  }
  /** Time to the next event of a Poisson process with `perDay` events a day, in ms. */
  nextGap(perDay: number): number {
    return (-Math.log(1 - this.float()) / perDay) * DAY;
  }
  /** A child stream, so one actor's choices don't shift another's. */
  fork(label: string): Rng {
    let h = this.s;
    for (const c of label) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
    return new Rng(h);
  }
}

export class World {
  /** Time units, so a scenario needs no value imports from the runner (only `import type`). */
  readonly units = { MINUTE, HOUR, DAY } as const;
  readonly start: number;
  readonly end: number;
  readonly rng: Rng;
  readonly twins = new Map<string, Twin>();
  readonly errors: string[] = [];
  private stopped = false;

  readonly app: HostedApp;
  readonly origin: string;
  readonly obs: Observations;
  /** The world's own fake secrets, readable by twins (e.g. to sign webhooks with the key the app checks). */
  readonly vars: Record<string, string>;

  constructor(app: HostedApp, origin: string, obs: Observations, seed: number, simDays: number, vars: Record<string, string>) {
    this.app = app;
    this.origin = origin;
    this.obs = obs;
    this.vars = vars;
    this.start = Date.now();
    this.end = this.start + simDays * DAY;
    this.rng = new Rng(seed);
  }

  now(): number {
    return Date.now();
  }
  /** Whole world days since day 0. */
  day(): number {
    return Math.floor((Date.now() - this.start) / DAY);
  }
  get over(): boolean {
    return this.stopped || Date.now() >= this.end;
  }
  stop(): void {
    this.stopped = true;
  }

  sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, Math.max(0, ms)));
  }
  until(t: number): Promise<void> {
    return this.sleep(t - Date.now());
  }

  twin<T extends Twin>(name: string): T {
    const t = this.twins.get(name);
    if (!t) throw new Error(`no twin named ${name} in this world (world file: twins)`);
    return t as T;
  }

  /** A request to the app's front door, recorded for the generic checks. */
  async fetch(path: string, init: AppFetchInit = {}): Promise<Response> {
    const headers = new Headers(init.headers ?? {});
    let body = init.body;
    if (init.json !== undefined) {
      body = JSON.stringify(init.json);
      headers.set("content-type", "application/json");
    }
    const method = init.method ?? (body === undefined ? "GET" : "POST");
    if (!headers.has("origin") && method !== "GET") headers.set("origin", this.origin);
    const t0 = performance.now();
    const release = holdClock();
    let res: Response;
    let text: string;
    try {
      const request = () => this.app.fetch(new Request(new URL(path, this.origin), { method, headers, body: body ?? null }));
      try {
        res = await request();
      } catch (e) {
        // A pooled keep-alive connection can go stale across a time skip (the server side timed it out in world
        // time). That is the world's artifact, not the product's: retry once on a fresh connection, and count it.
        if (!(e instanceof TypeError) || !String(e.message).includes("fetch failed")) throw e;
        this.obs.add("timeline", { t: Date.now(), day: this.day(), what: "transport_retry", path: routeOf(path) });
        res = await request();
      }
      // Read the body before timing, so the time covers the whole response.
      text = await res.text();
    } catch (e) {
      this.obs.add("requests", { t: Date.now(), method, route: routeOf(path), status: 599, ms: performance.now() - t0, actor: init.actor ?? "world" });
      throw e;
    } finally {
      release();
    }
    const ms = performance.now() - t0;
    this.obs.add("requests", { t: Date.now(), method, route: routeOf(path), status: res.status, ms: Math.round(ms * 10) / 10, actor: init.actor ?? "world" });
    return new Response([101, 204, 205, 304].includes(res.status) ? null : text, { status: res.status, headers: res.headers });
  }

  /** Rules written in code (they can read twins' state too): each returns the things that break it. */
  readonly rules: { name: string; check: () => Promise<unknown[]> }[] = [];
  rule(name: string, check: () => Promise<unknown[]>): void {
    this.rules.push({ name, check });
  }

  /** Records something the scenario did, for the report's timeline. */
  note(what: string, data: Record<string, unknown> = {}): void {
    this.obs.add("timeline", { t: Date.now(), day: this.day(), what, ...data });
  }

  /** Runs `fn` as an independent actor; a crash is recorded, never stops the world. */
  spawn(name: string, fn: () => Promise<void>): void {
    fn().catch((e: unknown) => {
      const msg = `${name}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`;
      if (this.errors.length < 50) this.errors.push(msg);
      this.note("actor_crashed", { actor: name, error: String(e) });
    });
  }

  /** Calls `fn` every `ms` of world time until the world ends. */
  every(name: string, ms: number, fn: () => Promise<void>): void {
    this.spawn(name, async () => {
      while (!this.over) {
        await this.sleep(ms);
        if (this.over) return;
        await fn();
      }
    });
  }
}

/** What a scenario module exports. */
export type Scenario = (world: World) => Promise<void>;
