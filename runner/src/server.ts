// The runner's HTTP service, the protocol openfactory's plugins/world-openworld speaks:
//   POST /v1/runs        { repo, sha, world, simDays, baseSha? } → 202 { id }
//   GET  /v1/runs/:id    → Run
//   GET  /v1/runs/:id/report → the HTML report (unguessable id; no token, so it can be linked from a PR)
//   GET  /healthz
// Bearer OPENWORLD_TOKEN guards the API. Runs go one at a time (worlds are CPU and memory heavy); the rest queue.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { type Run, StartRun } from "./contract.ts";
import { Git } from "./git.ts";
import { type JobEnv, runJob } from "./job.ts";

export type Config = {
  port: number;
  token: string | null;
  dataDir: string;
  runsc: string;
  publicUrl: string;
  githubToken: string | null;
  /** Repos this runner will run ("owner/name"); empty = any. */
  allowRepos: string[];
  maxQueue: number;
  worldTimeoutMs: number;
  buildTimeoutMs: number;
};

export function configFromEnv(env = process.env): Config {
  return {
    port: Number(env.PORT ?? 8080),
    token: env.OPENWORLD_TOKEN || null,
    dataDir: env.OPENWORLD_DATA ?? "/data",
    runsc: env.OPENWORLD_RUNSC ?? "/usr/local/bin/runsc",
    publicUrl: env.OPENWORLD_PUBLIC_URL ?? `http://localhost:${env.PORT ?? 8080}`,
    githubToken: env.GITHUB_TOKEN || null,
    allowRepos: (env.OPENWORLD_ALLOW_REPOS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    maxQueue: Number(env.OPENWORLD_MAX_QUEUE ?? 20),
    worldTimeoutMs: Number(env.OPENWORLD_WORLD_TIMEOUT_MIN ?? 25) * 60_000,
    buildTimeoutMs: Number(env.OPENWORLD_BUILD_TIMEOUT_MIN ?? 15) * 60_000,
  };
}

export class Runs {
  private readonly runs = new Map<string, Run>();
  private readonly queue: string[] = [];
  private busy = false;
  private readonly cfg: Config;
  private readonly env: JobEnv;

  constructor(cfg: Config, env?: JobEnv) {
    this.cfg = cfg;
    this.env = env ?? {
      dataDir: cfg.dataDir,
      runsc: cfg.runsc,
      git: new Git(join(cfg.dataDir, "repos"), cfg.githubToken),
      publicUrl: cfg.publicUrl,
      worldTimeoutMs: cfg.worldTimeoutMs,
      buildTimeoutMs: cfg.buildTimeoutMs,
    };
    mkdirSync(join(cfg.dataDir, "runs"), { recursive: true });
    // Runs survive a restart; one that was mid-flight is marked as an error (its sandbox died with the process).
    for (const id of readdirSync(join(cfg.dataDir, "runs"))) {
      const f = join(cfg.dataDir, "runs", id, "run.json");
      if (!existsSync(f)) continue;
      const run = JSON.parse(readFileSync(f, "utf8")) as Run;
      if (run.status === "queued" || run.status === "running") {
        Object.assign(run, { status: "error", phase: null, error: "the runner restarted during this run", finishedAt: new Date().toISOString() });
        this.save(run);
      }
      this.runs.set(id, run);
    }
  }

  private save(run: Run) {
    const dir = join(this.cfg.dataDir, "runs", run.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "run.json"), JSON.stringify(run, null, 2));
  }

  get(id: string): Run | undefined {
    return this.runs.get(id);
  }

  start(input: StartRun): Run | { rejected: string; code: 403 | 429 } {
    if (this.cfg.allowRepos.length && !this.cfg.allowRepos.includes(input.repo)) return { rejected: `this runner doesn't run ${input.repo}`, code: 403 };
    if (this.queue.length >= this.cfg.maxQueue) return { rejected: "the queue is full; try again later", code: 429 };
    const run: Run = {
      id: randomBytes(16).toString("hex"),
      status: "queued",
      repo: input.repo,
      sha: input.sha,
      baseSha: input.baseSha ?? null,
      world: input.world,
      simDays: input.simDays,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      phase: "waiting for a free world",
      invariants: [],
      metrics: [],
      reportUrl: null,
      error: null,
    };
    this.runs.set(run.id, run);
    this.save(run);
    this.queue.push(run.id);
    void this.next();
    return run;
  }

  private async next() {
    if (this.busy) return;
    const id = this.queue.shift();
    if (!id) return;
    const run = this.runs.get(id);
    if (!run) return void this.next();
    this.busy = true;
    const update = (patch: Partial<Run>) => {
      Object.assign(run, patch);
      this.save(run);
    };
    update({ status: "running", startedAt: new Date().toISOString(), phase: "starting" });
    try {
      await runJob(this.env, run, update);
    } catch (e) {
      update({ status: "error", phase: null, error: e instanceof Error ? e.message : String(e) });
    } finally {
      update({ finishedAt: new Date().toISOString() });
      this.busy = false;
      void this.next();
    }
  }
}

function sameToken(given: string, want: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function app(cfg: Config, runs: Runs): Hono {
  const h = new Hono();
  h.get("/healthz", (c) => c.json({ ok: true }));
  h.get("/v1/runs/:id/report", (c) => {
    const id = c.req.param("id");
    if (!/^[0-9a-f]{32}$/.test(id)) return c.text("not found", 404);
    const f = join(cfg.dataDir, "runs", id, "report.html");
    if (!existsSync(f)) return c.text(runs.get(id) ? "the report isn't ready yet" : "not found", 404);
    return c.html(readFileSync(f, "utf8"), 200, { "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:" });
  });
  h.use("/v1/*", async (c, next) => {
    if (cfg.token) {
      const auth = c.req.header("authorization") ?? "";
      if (!auth.startsWith("Bearer ") || !sameToken(auth.slice(7), cfg.token)) return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });
  h.post("/v1/runs", async (c) => {
    const parsed = StartRun.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad request", issues: parsed.error.issues }, 400);
    const r = runs.start(parsed.data);
    if ("rejected" in r) return c.json({ error: r.rejected }, r.code);
    return c.json({ id: r.id }, 202);
  });
  h.get("/v1/runs/:id", (c) => {
    const run = runs.get(c.req.param("id"));
    return run ? c.json(run) : c.json({ error: "not found" }, 404);
  });
  return h;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = configFromEnv();
  if (!cfg.token) console.warn("OPENWORLD_TOKEN is not set: the API is open");
  const runs = new Runs(cfg);
  serve({ fetch: app(cfg, runs).fetch, port: cfg.port }, (i) => console.log(`openworld runner on :${i.port}, data in ${cfg.dataDir}`));
}
