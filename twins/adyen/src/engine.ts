// The provider-agnostic core: one SQLite file holds an environment's state,
// its timer queue (the provider's future), and its webhook log. Forking an
// environment is copying the file.

import { DatabaseSync } from "node:sqlite";
import type { Clock } from "./clock.ts";

export interface Timer {
  id: number;
  due_ms: number;
  kind: string;
  ref: string;
  payload: any;
}

export type TimerHandler = (t: Timer, now: number) => void | Promise<void>;

const SCHEMA = `
create table if not exists meta (key text primary key, value text not null);
create table if not exists entities (
  ref text primary key, kind text not null, state text not null,
  created_ms integer not null, data text not null);
create table if not exists timers (
  id integer primary key autoincrement, due_ms integer not null,
  kind text not null, ref text not null, payload text not null);
create index if not exists timers_due on timers (due_ms, id);
create table if not exists history (
  id integer primary key autoincrement, at_ms integer not null, ref text not null,
  what text not null, data text not null);
create index if not exists history_ref on history (ref, id);
`;

export class Engine {
  readonly db: DatabaseSync;
  readonly clock: Clock;
  private handlers = new Map<string, TimerHandler>();
  private inflight = new Set<Promise<void>>();
  private requests = 0;
  private running = false;
  /** Called whenever busy-ness or the next deadline may have changed. */
  onChange: () => void = () => {};

  constructor(path: string, clock: Clock) {
    this.db = new DatabaseSync(path);
    this.db.exec("pragma journal_mode = wal;" + SCHEMA);
    this.clock = clock;
  }

  on(kind: string, handler: TimerHandler): void {
    this.handlers.set(kind, handler);
  }

  now(): number {
    return this.clock.nowMs();
  }

  iso(ms = this.now()): string {
    return new Date(this.clock.startUnixMs + ms).toISOString().replace(/\.\d{3}Z$/, "+00:00");
  }

  meta(key: string): string | undefined {
    const row = this.db.prepare("select value from meta where key = ?").get(key) as any;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("insert into meta (key, value) values (?, ?) on conflict (key) do update set value = excluded.value").run(key, value);
  }

  // ---- entities ---------------------------------------------------------

  put(ref: string, kind: string, state: string, data: object): void {
    this.db.prepare(
      `insert into entities (ref, kind, state, created_ms, data) values (?, ?, ?, ?, ?)
       on conflict (ref) do update set state = excluded.state, data = excluded.data`,
    ).run(ref, kind, state, this.now(), JSON.stringify(data));
  }

  get<T = any>(ref: string): (T & { state: string; ref: string; created_ms: number }) | undefined {
    const row = this.db.prepare("select * from entities where ref = ?").get(ref) as any;
    return row ? { ...JSON.parse(row.data), state: row.state, ref: row.ref, created_ms: row.created_ms } : undefined;
  }

  record(ref: string, what: string, data: object = {}): void {
    this.db.prepare("insert into history (at_ms, ref, what, data) values (?, ?, ?, ?)").run(this.now(), ref, what, JSON.stringify(data));
  }

  timeline(ref: string): any[] {
    return (this.db.prepare("select * from history where ref = ? order by id").all(ref) as any[]).map((r) => ({
      at: this.iso(r.at_ms), at_ms: r.at_ms, what: r.what, ...JSON.parse(r.data),
    }));
  }

  // ---- the future -------------------------------------------------------

  schedule(dueMs: number, kind: string, ref: string, payload: object = {}): number {
    const r = this.db.prepare("insert into timers (due_ms, kind, ref, payload) values (?, ?, ?, ?)").run(
      Math.max(dueMs, this.now()), kind, ref, JSON.stringify(payload));
    this.onChange();
    return Number(r.lastInsertRowid);
  }

  cancel(where: { ref: string; kind?: string }): void {
    if (where.kind) this.db.prepare("delete from timers where ref = ? and kind = ?").run(where.ref, where.kind);
    else this.db.prepare("delete from timers where ref = ?").run(where.ref);
    this.onChange();
  }

  pending(): Timer[] {
    return (this.db.prepare("select * from timers order by due_ms, id").all() as any[]).map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
  }

  nextDeadline(): number | null {
    const row = this.db.prepare("select min(due_ms) as d from timers").get() as any;
    return row?.d ?? null;
  }

  busy(): boolean {
    return this.running || this.inflight.size > 0 || this.requests > 0;
  }

  /** An API request is being served: the world must not skip under it. */
  beginRequest(): () => void {
    this.requests++;
    this.onChange();
    return () => {
      this.requests--;
      this.onChange();
    };
  }

  /** Track async work (webhook deliveries) so the world does not skip past it. */
  track(p: Promise<void>): void {
    this.inflight.add(p);
    this.onChange();
    p.finally(() => {
      this.inflight.delete(p);
      this.onChange();
    });
  }

  async settle(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  /** Fire every timer that is due, in order. New timers due now also fire. */
  runDue(): void {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const row = this.db.prepare("select * from timers where due_ms <= ? order by due_ms, id limit 1").get(this.now()) as any;
        if (!row) break;
        this.db.prepare("delete from timers where id = ?").run(row.id);
        const t: Timer = { ...row, payload: JSON.parse(row.payload) };
        const h = this.handlers.get(t.kind);
        if (!h) throw new Error(`no handler for timer kind ${t.kind}`);
        const r = h(t, this.now());
        if (r) this.track(r);
      }
    } finally {
      this.running = false;
      this.onChange();
    }
  }

  snapshot(path: string): void {
    this.db.exec(`vacuum into '${path.replaceAll("'", "''")}'`);
  }
}
