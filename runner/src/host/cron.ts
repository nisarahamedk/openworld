// The next time a 5-field cron expression fires, in UTC (the way Cloudflare runs Worker crons).
// Supports *, numbers, lists, ranges and steps; that covers every cron Cloudflare accepts except L/W/#.

function field(spec: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const [range, stepS] = part.split("/");
    const step = stepS ? Number(stepS) : 1;
    let lo = min;
    let hi = max;
    if (range !== "*" && range !== undefined) {
      const [a, b] = range.split("-");
      lo = Number(a);
      hi = b === undefined ? (stepS ? max : lo) : Number(b);
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || !Number.isFinite(step) || step < 1) throw new Error(`bad cron field ${spec}`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function nextCron(expr: string, after: number): number {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron needs 5 fields: ${expr}`);
  const [mi, ho, dom, mo, dow] = parts as [string, string, string, string, string];
  const minutes = field(mi, 0, 59);
  const hours = field(ho, 0, 23);
  const days = field(dom, 1, 31);
  const months = field(mo, 1, 12);
  const weekdays = new Set([...field(dow, 0, 7)].map((d) => d % 7));
  const domAny = dom === "*";
  const dowAny = dow === "*";
  const t = new Date(Math.floor(after / 60_000) * 60_000 + 60_000);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    const dayOk = domAny && dowAny ? true : domAny ? weekdays.has(t.getUTCDay()) : dowAny ? days.has(t.getUTCDate()) : days.has(t.getUTCDate()) || weekdays.has(t.getUTCDay());
    if (months.has(t.getUTCMonth() + 1) && dayOk && hours.has(t.getUTCHours()) && minutes.has(t.getUTCMinutes())) return t.getTime();
    t.setTime(t.getTime() + 60_000);
  }
  throw new Error(`cron never fires: ${expr}`);
}
