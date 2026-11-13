// Turns what the host saw into the run's invariants and metrics. Generic checks compare the change (head) with the
// commit it is based on (base), run through the same world with the same seed, so a PR is judged on what it changed,
// not on problems it inherited. Team invariants from the world file are absolute rules, but one that also fails on
// base is reported as inherited rather than failing the PR.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { CronObs, DataObs, EgressObs, HostSummary, Invariant, InvariantObs, LogObs, Metric, RequestObs, WorldFile } from "./contract.ts";

export type Obs = {
  summary: HostSummary;
  requests: RequestObs[];
  logs: LogObs[];
  egress: EgressObs[];
  crons: CronObs[];
  invariants: InvariantObs[];
  timeline: { t: number; day: number; what: string; [k: string]: unknown }[];
  data: DataObs;
  hostMs: number;
};

function jsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T);
}

export function readObs(dir: string, hostMs: number): Obs {
  const summaryFile = join(dir, "summary.json");
  const summary: HostSummary = existsSync(summaryFile)
    ? (JSON.parse(readFileSync(summaryFile, "utf8")) as HostSummary)
    : { ok: false, error: "the world host wrote no summary (it was killed or crashed)", bootMs: 0, worldStart: "", worldEnd: "", simDaysDone: 0, scenarioErrors: [], notes: [] };
  const dataFile = join(dir, "data.json");
  return {
    summary,
    requests: jsonl(join(dir, "requests.jsonl")),
    logs: jsonl(join(dir, "logs.jsonl")),
    egress: jsonl(join(dir, "egress.jsonl")),
    crons: jsonl(join(dir, "crons.jsonl")),
    invariants: jsonl(join(dir, "invariants.jsonl")),
    timeline: jsonl(join(dir, "timeline.jsonl")),
    data: existsSync(dataFile) ? (JSON.parse(readFileSync(dataFile, "utf8")) as DataObs) : { tables: [], duplicates: [], orphans: [] },
    hostMs,
  };
}

export function p95(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)] as number;
}

const countBy = <T>(xs: T[], key: (x: T) => string) => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
  return m;
};
// More than base, beyond the noise concurrency adds (the same seed still interleaves a little differently).
const worse = (head: number, base: number) => head > base + Math.max(1, Math.ceil(base * 0.1));
const list = (xs: string[], n = 3) => xs.slice(0, n).join("; ") + (xs.length > n ? `; and ${xs.length - n} more` : "");

export type RouteRow = { route: string; head: { n: number; p95: number; errors: number }; base: { n: number; p95: number; errors: number } | null };
export type CheckDetails = { routes: RouteRow[]; newErrorSignatures: { signature: string; count: number; example: string }[] };

export function evaluate(world: WorldFile, simDays: number, head: Obs, base: Obs | null): { invariants: Invariant[]; metrics: Metric[]; details: CheckDetails } {
  const inv: Invariant[] = [];
  const s = head.summary;
  

  // 1. The world ran.
  inv.push({
    name: "world: app boots and runs every simulated day",
    ok: s.ok && s.simDaysDone >= simDays,
    detail: s.ok ? `ran ${s.simDaysDone} of ${simDays} days (${s.worldStart.slice(0, 10)} → ${s.worldEnd.slice(0, 10)} world time) in ${Math.round(head.hostMs / 1000)} s` : `the world stopped: ${(s.error ?? "").split("\n")[0]}`,
  });

  // 2. New error logs, by signature.
  const errSig = (o: Obs) => countBy(o.logs.filter((l) => l.error), (l) => l.signature);
  const headErr = errSig(head);
  const baseErr = base ? errSig(base) : new Map<string, number>();
  const newErrors = [...headErr].filter(([sig, n]) => (base ? !baseErr.has(sig) || worse(n, baseErr.get(sig) ?? 0) : true));
  const examples = new Map<string, string>();
  for (const l of head.logs) if (l.error && !examples.has(l.signature)) examples.set(l.signature, l.text);
  inv.push({
    name: "world: no new error logs",
    ok: newErrors.length === 0,
    detail: newErrors.length
      ? `${newErrors.length} error kind(s) ${base ? "new or more frequent" : "seen"}: ${list(newErrors.map(([sig, n]) => `${n}× ${sig.slice(0, 140)}`))}`
      : `${[...headErr.values()].reduce((a, b) => a + b, 0)} error lines, none new${base ? " compared with base" : ""}`,
  });

  // 3. Server errors by route.
  const fivexx = (o: Obs) => countBy(o.requests.filter((r) => r.status >= 500), (r) => `${r.method} ${r.route}`);
  const head5 = fivexx(head);
  const base5 = base ? fivexx(base) : new Map<string, number>();
  const bad5 = [...head5].filter(([k, n]) => worse(n, base5.get(k) ?? 0));
  inv.push({
    name: "world: no new server errors",
    ok: bad5.length === 0,
    detail: bad5.length ? list(bad5.map(([k, n]) => `${k}: ${n}× 5xx${base ? ` (base ${base5.get(k) ?? 0})` : ""}`)) : `${[...head5.values()].reduce((a, b) => a + b, 0)} 5xx of ${head.requests.length} requests, none new${base ? " compared with base" : ""}`,
  });

  // 4. Slow requests, per route.
  const byRoute = (o: Obs) => {
    const m = new Map<string, RequestObs[]>();
    for (const r of o.requests) {
      const k = `${r.method} ${r.route}`;
      const a = m.get(k) ?? [];
      a.push(r);
      m.set(k, a);
    }
    return m;
  };
  const hr = byRoute(head);
  const br = base ? byRoute(base) : new Map<string, RequestObs[]>();
  const routes: RouteRow[] = [...hr]
    .map(([route, rs]) => {
      const b = br.get(route);
      return {
        route,
        head: { n: rs.length, p95: p95(rs.map((r) => r.ms)), errors: rs.filter((r) => r.status >= 500).length },
        base: b ? { n: b.length, p95: p95(b.map((r) => r.ms)), errors: b.filter((r) => r.status >= 500).length } : null,
      };
    })
    .sort((a, b) => b.head.n - a.head.n);
  const limit = world.checks.slowRequestMs;
  const slow = routes.filter((r) => {
    if (r.head.n < 5) return false;
    if (!r.base || r.base.n < 5) return r.head.p95 > limit;
    return (r.head.p95 > limit && r.base.p95 <= limit) || (r.head.p95 > 2 * r.base.p95 && r.head.p95 - r.base.p95 > 200);
  });
  inv.push({
    name: "world: no slow requests",
    ok: slow.length === 0,
    detail: slow.length
      ? list(slow.map((r) => `${r.route} p95 ${Math.round(r.head.p95)} ms${r.base ? ` (base ${Math.round(r.base.p95)} ms)` : ""}`))
      : `every route's p95 under ${limit} ms and not doubled${base ? " compared with base" : ""} (slowest: ${routes.filter((r) => r.head.n >= 5).sort((a, b) => b.head.p95 - a.head.p95)[0]?.route ?? "none"})`,
  });

  // 5. Duplicate rows.
  const dupKey = (d: DataObs["duplicates"][number]) => d.table;
  const baseDup = new Map((base?.data.duplicates ?? []).map((d) => [dupKey(d), d.extraRows]));
  const newDup = head.data.duplicates.filter((d) => worse(d.extraRows, baseDup.get(dupKey(d)) ?? 0));
  inv.push({
    name: "world: no new duplicate rows",
    ok: newDup.length === 0,
    detail: newDup.length
      ? list(newDup.map((d) => `${d.table}: ${d.extraRows} duplicate row(s)${base ? ` (base ${baseDup.get(d.table) ?? 0})` : ""}, e.g. ${JSON.stringify(d.sample[0]).slice(0, 160)}`))
      : `${head.data.duplicates.reduce((a, d) => a + d.extraRows, 0)} duplicate rows, none new${base ? " compared with base" : ""}`,
  });

  // 6. Orphans.
  const orphanKey = (o: DataObs["orphans"][number]) => `${o.table}.${o.column} → ${o.parent}`;
  const baseOrph = new Map((base?.data.orphans ?? []).map((o) => [orphanKey(o), o.rows]));
  const newOrph = head.data.orphans.filter((o) => worse(o.rows, baseOrph.get(orphanKey(o)) ?? 0));
  inv.push({
    name: "world: no new orphan rows",
    ok: newOrph.length === 0,
    detail: newOrph.length
      ? list(newOrph.map((o) => `${o.rows} ${orphanKey(o)} row(s) point at nothing${base ? ` (base ${baseOrph.get(orphanKey(o)) ?? 0})` : ""}`))
      : `${head.data.orphans.reduce((a, o) => a + o.rows, 0)} orphan rows, none new${base ? " compared with base" : ""}`,
  });

  // 7. Calls to services the world doesn't know.
  const unknown = (o: Obs) => new Set(o.egress.filter((e) => !e.twin).map((e) => e.host));
  const baseUnknown = base ? unknown(base) : new Set<string>();
  const newUnknown = [...unknown(head)].filter((h) => !baseUnknown.has(h));
  inv.push({
    name: "world: no calls to unknown services",
    ok: newUnknown.length === 0,
    detail: newUnknown.length ? `the change calls ${list(newUnknown)}, which nothing in this world answers (add a twin to the world file if it's intended)` : `${head.egress.length} outbound calls, all to known services`,
  });

  // 8. Scheduled jobs.
  const cronFails = (o: Obs) => o.crons.filter((c) => c.outcome !== "ok").length;
  const hc = cronFails(head);
  const bc = base ? cronFails(base) : 0;
  inv.push({
    name: "world: scheduled jobs succeed",
    ok: !worse(hc, bc) || hc === 0,
    detail: `${head.crons.length - hc} of ${head.crons.length} cron runs ok${hc ? `; ${hc} failed${base ? ` (base ${bc})` : ""}: ${list([...new Set(head.crons.filter((c) => c.outcome !== "ok").map((c) => `${c.cron} → ${c.outcome.slice(0, 100)}`))])}` : ""}`,
  });

  // 9. The world's people get through their journeys (a crash means the product answered something they can't use).
  const crashes = (o: Obs) => o.summary.scenarioErrors.map((e) => e.split("\n")[0] ?? e);
  const hcr = crashes(head);
  const bcr = new Set(base ? crashes(base).map((e) => e.replace(/^[\w-]+?-\d+: /, "")) : []);
  const newCr = hcr.filter((e) => !bcr.has(e.replace(/^[\w-]+?-\d+: /, "")));
  inv.push({
    name: "world: people's journeys complete",
    ok: newCr.length === 0,
    detail: newCr.length ? `${newCr.length} journey(s) broke: ${list(newCr)}` : `${hcr.length} broken journeys, none new${base ? " compared with base" : ""}`,
  });

  // Team invariants: violated on any world day.
  for (const rule of world.invariants) {
    const worst = (o: Obs | null) => {
      const rows = (o?.invariants ?? []).filter((x) => x.name === rule.name);
      const bad = rows.filter((x) => x.violations > 0 || x.error);
      return { checks: rows.length, bad, first: bad[0] ?? null };
    };
    const h = worst(head);
    const b = base ? worst(base) : null;
    const failing = h.bad.length > 0;
    const inherited = failing && b !== null && b.bad.length > 0;
    inv.push({
      name: rule.name,
      ok: !failing || inherited,
      detail: !failing
        ? `held on all ${h.checks} daily checks`
        : h.first?.error
          ? `the rule's SQL failed: ${h.first.error.slice(0, 200)}`
          : `broken on ${h.bad.length} of ${h.checks} checks, first on day ${h.first?.day}: ${JSON.stringify(h.first?.sample[0] ?? {}).slice(0, 160)}${inherited ? " (also broken on base, so not this change)" : ""}`,
    });
  }

  const allMs = head.requests.map((r) => r.ms);
  const metrics: Metric[] = [
    { name: "sim_days", value: s.simDaysDone, unit: "days" },
    { name: "world_host_seconds", value: Math.round(head.hostMs / 100) / 10, unit: "s" },
    ...(base ? [{ name: "base_world_host_seconds", value: Math.round(base.hostMs / 100) / 10, unit: "s" }] : []),
    { name: "requests", value: head.requests.length, unit: "count" },
    { name: "request_p95", value: Math.round(p95(allMs)), unit: "ms" },
    { name: "server_errors", value: head.requests.filter((r) => r.status >= 500).length, unit: "count" },
    { name: "error_logs", value: head.logs.filter((l) => l.error).length, unit: "count" },
    { name: "cron_runs", value: head.crons.length, unit: "count" },
    { name: "outbound_calls", value: head.egress.length, unit: "count" },
    { name: "rows", value: head.data.tables.reduce((a, t) => a + t.rows, 0), unit: "count" },
    { name: "duplicate_rows", value: head.data.duplicates.reduce((a, d) => a + d.extraRows, 0), unit: "count" },
    { name: "orphan_rows", value: head.data.orphans.reduce((a, o) => a + o.rows, 0), unit: "count" },
  ];
  return {
    invariants: inv,
    metrics,
    details: {
      routes,
      newErrorSignatures: newErrors.map(([signature, count]) => ({ signature, count, example: examples.get(signature) ?? signature })),
    },
  };
}
