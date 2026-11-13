// The run's report: one self-contained HTML page a reviewer opens from the PR. It answers, in order: did the change
// survive the world, what broke and since when, and what the world did (so a pass means something).
import type { CheckDetails, Obs } from "./checks.ts";
import type { Run, WorldFile } from "./contract.ts";

const esc = (s: unknown) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const fmt = (n: number) => (Number.isInteger(n) ? n.toLocaleString("en-US") : n.toFixed(1));

function timelineCounts(o: Obs) {
  const m = new Map<string, number>();
  for (const t of o.timeline) if (t.what !== "day_ended") m.set(t.what, (m.get(t.what) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]);
}

function perDay(o: Obs, days: number) {
  const start = Date.parse(o.summary.worldStart);
  const req = new Array<number>(days).fill(0);
  const err = new Array<number>(days).fill(0);
  for (const r of o.requests) {
    const d = Math.floor((r.t - start) / 86400e3);
    if (d >= 0 && d < days) {
      req[d] = (req[d] ?? 0) + 1;
      if (r.status >= 500) err[d] = (err[d] ?? 0) + 1;
    }
  }
  return { req, err };
}

function bars(o: Obs, days: number): string {
  const { req, err } = perDay(o, days);
  const max = Math.max(1, ...req);
  const w = 100 / days;
  const cols = req
    .map((n, i) => {
      const h = (n / max) * 100;
      const e = ((err[i] ?? 0) / max) * 100;
      return `<rect x="${i * w + w * 0.15}" y="${100 - h}" width="${w * 0.7}" height="${h}" class="bar"><title>Day ${i + 1}: ${n} requests, ${err[i]} 5xx</title></rect>${e ? `<rect x="${i * w + w * 0.15}" y="${100 - e}" width="${w * 0.7}" height="${e}" class="bar-err" />` : ""}`;
    })
    .join("");
  return `<svg viewBox="0 0 100 100" preserveAspectRatio="none" class="chart" role="img" aria-label="Requests per world day">${cols}</svg>
  <div class="axis"><span>day 1</span><span>day ${days}</span></div>`;
}

export function renderReport(r: { run: Run; world: WorldFile; worldSource: "repo" | "bundled"; head: Obs; base: Obs | null; details: CheckDetails; baseError: string | null }): string {
  const { run, head, base, details } = r;
  const failed = run.invariants.filter((i) => !i.ok);
  const verdict =
    run.status === "passed"
      ? `Survived ${run.simDays} world days`
      : run.status === "failed"
        ? `${failed.length} rule${failed.length === 1 ? "" : "s"} broken in ${run.simDays} world days`
        : "The world couldn't run this change";
  const repoLink = `https://github.com/${run.repo}`;
  const shaLink = (sha: string | null) => (sha ? `<a href="${repoLink}/commit/${esc(sha)}"><code>${esc(sha.slice(0, 7))}</code></a>` : "none");
  const metric = (name: string) => run.metrics.find((m) => m.name === name)?.value ?? 0;
  const tables = new Map((base?.data.tables ?? []).map((t) => [t.name, t.rows]));

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>World run ${esc(run.id.slice(0, 8))}</title>
<style>
:root{--bg:#fbfaf7;--fg:#1d1d1b;--muted:#6b6a64;--line:#e4e1d8;--card:#ffffff;--ok:#2f6f3e;--bad:#b3261e;--warn:#8a5a00;--accent:#3b4cca;--bar:#8f96c9;--bar-err:#b3261e}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#141413;--fg:#ecebe6;--muted:#9a988f;--line:#2c2b28;--card:#1b1b19;--ok:#7fc48f;--bad:#f2867d;--warn:#e0b25a;--accent:#9aa6ff;--bar:#5a6199;--bar-err:#f2867d}}
:root[data-theme="dark"]{--bg:#141413;--fg:#ecebe6;--muted:#9a988f;--line:#2c2b28;--card:#1b1b19;--ok:#7fc48f;--bad:#f2867d;--warn:#e0b25a;--accent:#9aa6ff;--bar:#5a6199;--bar-err:#f2867d}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,-apple-system,"Segoe UI",system-ui,sans-serif}
main{max-width:980px;margin:0 auto;padding:32px 16px 64px}
a{color:var(--accent)}code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace}
h1{font-size:28px;line-height:1.2;margin:4px 0 6px;font-weight:650;letter-spacing:-.01em}
h2{font-size:17px;margin:36px 0 10px;font-weight:620}
.meta{color:var(--muted);margin:0}.meta span+span:before{content:"·";margin:0 8px}
.status{display:inline-block;padding:2px 10px;border-radius:999px;font-size:13px;font-weight:600;border:1px solid currentColor}
.passed{color:var(--ok)}.failed,.error{color:var(--bad)}
.figures{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:1px;background:var(--line);border:1px solid var(--line);border-radius:10px;overflow:hidden;margin-top:20px}
.figures div{background:var(--card);padding:12px 14px}.figures b{display:block;font-size:20px;font-variant-numeric:tabular-nums}.figures small{color:var(--muted)}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-weight:600;color:var(--muted);font-size:13px}td.n,th.n{text-align:right;white-space:nowrap}
.rule td:first-child{width:34%}.mark{font-weight:700;margin-right:6px}
.wrap{overflow-x:auto;border:1px solid var(--line);border-radius:10px;background:var(--card)}
.chart{width:100%;height:120px;display:block}.bar{fill:var(--bar)}.bar-err{fill:var(--bar-err)}
.axis{display:flex;justify-content:space-between;color:var(--muted);font-size:12px}
pre{white-space:pre-wrap;word-break:break-word;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px;font:12px/1.45 ui-monospace,Menlo,monospace;margin:6px 0 0}
.note{color:var(--muted);font-size:14px}ul{padding-left:20px}
</style></head><body><main>
<p class="meta"><span><a href="${repoLink}">${esc(run.repo)}</a></span><span>world <b>${esc(run.world)}</b> (${r.worldSource === "repo" ? "from the repo" : "bundled with the runner"})</span></p>
<h1>${esc(verdict)}</h1>
<p class="meta"><span class="status ${esc(run.status)}">${esc(run.status)}</span> <span>change ${shaLink(run.sha)}</span><span>compared with base ${shaLink(run.baseSha)}</span><span>${esc(run.finishedAt?.slice(0, 16).replace("T", " ") ?? "")} UTC</span></p>
${run.error ? `<pre>${esc(run.error)}</pre>` : ""}
<div class="figures">
<div><b>${fmt(metric("sim_days"))}</b><small>world days</small></div>
<div><b>${fmt(metric("world_host_seconds"))} s</b><small>host time</small></div>
<div><b>${fmt(metric("requests"))}</b><small>requests</small></div>
<div><b>${fmt(metric("request_p95"))} ms</b><small>p95 latency</small></div>
<div><b>${fmt(metric("cron_runs"))}</b><small>cron runs</small></div>
<div><b>${fmt(metric("outbound_calls"))}</b><small>calls to providers</small></div>
</div>

<h2>Rules</h2>
<div class="wrap"><table>
<thead><tr><th>Rule</th><th>Result</th></tr></thead><tbody>
${run.invariants.map((i) => `<tr class="rule"><td><span class="mark ${i.ok ? "passed" : "failed"}">${i.ok ? "✓" : "✕"}</span>${esc(i.name)}</td><td>${esc(i.detail)}</td></tr>`).join("\n")}
</tbody></table></div>
<p class="note">Rules starting with “world:” run in every world. The others are this team's own, from its world file, checked at the end of every world day. Generic rules compare the change with its base run through the same world and seed${base ? "" : "; this run had no base to compare with, so they judge the change alone"}.</p>

${
  details.newErrorSignatures.length
    ? `<h2>New errors</h2>${details.newErrorSignatures
        .slice(0, 12)
        .map((e) => `<p><b>${e.count}×</b></p><pre>${esc(e.example.slice(0, 1500))}</pre>`)
        .join("")}`
    : ""
}

<h2>Traffic per world day</h2>
${bars(head, run.simDays)}

<h2>Routes</h2>
<div class="wrap"><table>
<thead><tr><th>Route</th><th class="n">Requests</th><th class="n">p95</th><th class="n">Base p95</th><th class="n">5xx</th></tr></thead><tbody>
${details.routes
  .slice(0, 40)
  .map((x) => `<tr><td><code>${esc(x.route)}</code></td><td class="n">${fmt(x.head.n)}</td><td class="n">${fmt(Math.round(x.head.p95))} ms</td><td class="n">${x.base ? `${fmt(Math.round(x.base.p95))} ms` : "–"}</td><td class="n">${x.head.errors ? `<span class="failed">${x.head.errors}</span>` : 0}${x.base ? ` / ${x.base.errors}` : ""}</td></tr>`)
  .join("\n")}
</tbody></table></div>

<h2>What happened in the world</h2>
<div class="wrap"><table><thead><tr><th>Event</th><th class="n">Times</th></tr></thead><tbody>
${timelineCounts(head)
  .map(([k, v]) => `<tr><td>${esc(k.replace(/_/g, " "))}</td><td class="n">${fmt(v)}</td></tr>`)
  .join("")}
</tbody></table></div>

<h2>Data at the end</h2>
<div class="wrap"><table><thead><tr><th>Table</th><th class="n">Rows</th><th class="n">Base rows</th></tr></thead><tbody>
${head.data.tables.map((t) => `<tr><td><code>${esc(t.name)}</code></td><td class="n">${fmt(t.rows)}</td><td class="n">${base ? fmt(tables.get(t.name) ?? 0) : "–"}</td></tr>`).join("")}
</tbody></table></div>

<h2>About this world</h2>
<p>${esc(r.world.description || r.world.name)}. The world's clock skips forward whenever every program in it is waiting, so ${run.simDays} days ran in ${fmt(metric("world_host_seconds"))} s. Providers are stand-ins (${esc(Object.entries(r.world.twins).map(([h, t]) => `${h} → ${t}`).join(", "))}); nothing reaches a real service.</p>
${head.summary.notes.length || r.baseError ? `<ul>${head.summary.notes.map((n) => `<li>${esc(n)}</li>`).join("")}${r.baseError ? `<li>The base couldn't run, so this change was judged alone: ${esc(r.baseError.slice(0, 400))}</li>` : ""}</ul>` : ""}
${head.summary.scenarioErrors.length ? `<h2>Broken journeys</h2>${head.summary.scenarioErrors.slice(0, 8).map((e) => `<pre>${esc(e.slice(0, 1200))}</pre>`).join("")}` : ""}
<p class="note">Run <code>${esc(run.id)}</code> · OpenWorld runner</p>
</main></body></html>`;
}
