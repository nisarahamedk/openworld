// Where the twin's "now" comes from.
//
// ManualClock: time moves only when someone calls advance(). Good for unit
// tests and for using the twin on its own.
//
// WorldClock: time is the Tesseract world clock. The twin never moves it; it
// tells the coordinator when it is busy and when its next timer is due, and
// the coordinator either lets that moment arrive in real time or skips to it
// when the whole world is idle.

import net from "node:net";

export interface Clock {
  /** Milliseconds since the world began. */
  nowMs(): number;
  /** Unix epoch milliseconds at nowMs() == 0. */
  readonly startUnixMs: number;
}

export class ManualClock implements Clock {
  private now = 0;
  readonly startUnixMs: number;

  constructor(startUnixMs = Date.parse("2026-01-05T09:00:00Z"), nowMs = 0) {
    this.startUnixMs = startUnixMs;
    this.now = nowMs;
  }

  nowMs(): number {
    return this.now;
  }

  set(ms: number): void {
    if (ms < this.now) throw new Error("time only moves forward");
    this.now = ms;
  }
}

/** What the twin tells the coordinator about itself. */
export interface ParticipantState {
  busy: boolean;
  deadlineMs: number | null;
}

/**
 * A participant connection to tesseractd. World time is host
 * CLOCK_MONOTONIC plus a skew the coordinator broadcasts after each skip;
 * process.hrtime is CLOCK_MONOTONIC on Linux, so reading it costs nothing.
 */
export class WorldClock implements Clock {
  private skewNs = 0n;
  private epoch = 0;
  startUnixMs = 0;
  private sock: net.Socket;
  private ready: Promise<void>;
  /** Called after a skip or when our deadline is due; run timers, then report(). */
  onTick: () => void = () => {};

  constructor(socketPath: string, name: string) {
    this.sock = net.createConnection(socketPath);
    let resolveReady!: () => void;
    this.ready = new Promise((r) => (resolveReady = r));
    let buf = "";
    this.sock.setEncoding("utf8");
    this.sock.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const msg = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (msg.clock) {
          this.skewNs = BigInt(msg.clock.skew_ns);
          this.epoch = msg.clock.epoch;
          this.startUnixMs = Math.floor(Number(BigInt(msg.clock.start_unix_ns) / 1_000_000n));
          resolveReady();
          this.onTick();
        } else if (msg.due) {
          this.onTick();
        }
      }
    });
    this.sock.on("error", (e) => {
      console.error(`tesseract: coordinator connection failed: ${e.message}`);
      process.exit(1);
    });
    this.sock.write(JSON.stringify({ hello: name }) + "\n");
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  nowMs(): number {
    return Number((process.hrtime.bigint() + this.skewNs) / 1_000_000n);
  }

  report(state: ParticipantState): void {
    // Written by hand so a deadline past 2^53 ns (about 104 days) stays exact.
    const deadline =
      state.deadlineMs === null ? "null" : (BigInt(Math.max(0, Math.floor(state.deadlineMs))) * 1_000_000n).toString();
    this.sock.write(`{"state":{"busy":${state.busy},"deadline_ns":${deadline},"epoch":${this.epoch}}}\n`);
  }
}

/**
 * The operating system's own clock. Use this when the twin runs *inside* a
 * time-controlled world (for example a gVisor sandbox with Tesseract time
 * skipping): there the OS clock already is the world clock, so the twin just
 * sets ordinary timers and the engine below skips to them when everyone is idle.
 */
export class SystemClock implements Clock {
  readonly startUnixMs: number;
  private readonly t0 = process.hrtime.bigint();

  constructor() {
    this.startUnixMs = Date.now();
  }

  nowMs(): number {
    return Number((process.hrtime.bigint() - this.t0) / 1_000_000n);
  }
}
