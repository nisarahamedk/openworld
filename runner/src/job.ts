// One run: fetch the change and its base, build each in a sandbox, run each through the same world in the
// time-skipping sandbox, compare, and write the report. Base results are cached, so a PR's later pushes only pay for
// their own world.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { evaluate, readObs, type Obs } from "./checks.ts";
import { type HostPlan, type Run, WorldFile } from "./contract.ts";
import type { Git } from "./git.ts";
import { renderReport } from "./report.ts";
import { runInSandbox } from "./sandbox.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER_ROOT = resolve(HERE, "..");
const BUNDLED_WORLDS = resolve(RUNNER_ROOT, "..", "worlds");
// Bump when the host or checks change in a way that makes cached base results stale.
const ENGINE_VERSION = "1";

export type JobEnv = {
  dataDir: string;
  runsc: string;
  git: Git;
  publicUrl: string;
  /** Host time allowed per world run. */
  worldTimeoutMs: number;
  buildTimeoutMs: number;
};

export type Progress = (patch: Partial<Run>) => void;

type World = { file: string; spec: WorldFile; source: "repo" | "bundled"; hash: string };

function findWorld(checkout: string, repo: string, name: string): World {
  const candidates: [string, World["source"]][] = [
    [join(checkout, ".openworld", `${name}.yaml`), "repo"],
    [join(BUNDLED_WORLDS, repo, `${name}.yaml`), "bundled"],
  ];
  for (const [file, source] of candidates) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    const spec = WorldFile.parse(YAML.parse(text));
    const h = createHash("sha256").update(text);
    if (spec.scenario) h.update(readFileSync(resolve(dirname(file), spec.scenario)));
    return { file, spec, source, hash: h.digest("hex").slice(0, 16) };
  }
  throw new Error(`no world "${name}" for ${repo}: add .openworld/${name}.yaml to the repo`);
}

// Proxy and CA settings the runner itself was given, so a build behind an egress proxy can reach the registry.
function passThrough(): Record<string, string> {
  const keys = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"];
  const out: Record<string, string> = {};
  for (const k of keys) if (process.env[k]) out[k] = process.env[k] as string;
  if (process.env.NODE_EXTRA_CA_CERTS) out.npm_config_cafile = process.env.NODE_EXTRA_CA_CERTS;
  return out;
}

async function build(env: JobEnv, runDir: string, label: string, appDir: string, world: World, log: string): Promise<void> {
  if (!world.spec.app.prepare.length) return;
  const cache = join(env.dataDir, "cache");
  mkdirSync(join(cache, "pnpm-store"), { recursive: true });
  mkdirSync(join(cache, "npm"), { recursive: true });
  const script = ["set -e", ...world.spec.app.prepare].join("\n");
  const r = await runInSandbox({
    runsc: env.runsc,
    workDir: join(runDir, "sandbox"),
    stateRoot: join(env.dataDir, "runsc"),
    id: `ow-build-${label}-${Date.now()}`,
    args: ["/bin/sh", "-c", script],
    cwd: appDir,
    env: { ...passThrough(), CI: "1", npm_config_store_dir: join(cache, "pnpm-store"), npm_config_cache: join(cache, "npm"), COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" },
    mounts: { [runDir]: runDir, [cache]: cache },
    mode: "build",
    timeoutMs: env.buildTimeoutMs,
    logFile: log,
  });
  if (r.timedOut) throw new Error(`building ${label} took longer than ${Math.round(env.buildTimeoutMs / 60000)} min`);
  if (r.code !== 0) {
    const tail = readFileSync(log, "utf8").split("\n").slice(-15).join("\n");
    throw new Error(`building ${label} failed (exit ${r.code}):\n${tail}`);
  }
}

async function runWorld(env: JobEnv, runDir: string, label: "head" | "base", appDir: string, world: World, simDays: number): Promise<Obs> {
  const dir = join(runDir, label);
  const plan: HostPlan = { appDir, worldFile: world.file, world: world.spec, simDays, outDir: join(dir, "out"), stateDir: join(dir, "state"), label };
  mkdirSync(plan.outDir, { recursive: true });
  mkdirSync(plan.stateDir, { recursive: true });
  writeFileSync(join(dir, "plan.json"), JSON.stringify(plan));
  // The world file may live outside the run dir (bundled with the runner); the sandbox sees the runner's own files
  // read-only through its root filesystem.
  const r = await runInSandbox({
    runsc: env.runsc,
    workDir: join(runDir, "sandbox"),
    stateRoot: join(env.dataDir, "runsc"),
    id: `ow-world-${label}-${Date.now()}`,
    args: [process.execPath, "--no-warnings", join(HERE, "host", "main.ts"), join(dir, "plan.json")],
    cwd: appDir,
    env: { NODE_ENV: "production" },
    mounts: { [runDir]: runDir },
    mode: "world",
    timeoutMs: env.worldTimeoutMs,
    logFile: join(dir, "host.log"),
  });
  const obs = readObs(plan.outDir, r.ms);
  if (r.timedOut) {
    obs.summary.ok = false;
    obs.summary.error = `the world ran out of host time (${Math.round(env.worldTimeoutMs / 60000)} min) at day ${obs.summary.simDaysDone}`;
  }
  return obs;
}

export async function runJob(env: JobEnv, run: Run, progress: Progress): Promise<void> {
  const runDir = join(env.dataDir, "runs", run.id);
  mkdirSync(runDir, { recursive: true });
  const log = join(runDir, "build.log");

  progress({ phase: "fetching the commits" });
  const { dir: repoDir, defaultBranch } = await env.git.fetch(run.repo, [run.sha, ...(run.baseSha ? [run.baseSha] : [])]);
  const headSha = await env.git.resolve(repoDir, run.sha);
  const baseSha = run.baseSha ? await env.git.resolve(repoDir, run.baseSha) : await env.git.mergeBase(repoDir, headSha, `refs/remotes/origin/${defaultBranch}`);
  const compare = baseSha && baseSha !== headSha ? baseSha : null;
  progress({ sha: headSha, baseSha: compare });

  const headDir = join(runDir, "head", "app");
  await env.git.export(repoDir, headSha, headDir);
  const world = findWorld(headDir, run.repo, run.world);

  // Base: the same world, the same seed, cached by (base, world, days).
  let base: Obs | null = null;
  if (compare) {
    const key = createHash("sha256").update([ENGINE_VERSION, run.repo, compare, world.hash, run.simDays].join("|")).digest("hex").slice(0, 24);
    const cached = join(env.dataDir, "baselines", key);
    if (existsSync(join(cached, "out", "summary.json"))) {
      progress({ phase: "reusing the base's world run" });
      base = readObs(join(cached, "out"), Number(readFileSync(join(cached, "host-ms"), "utf8")));
    } else {
      const baseDir = join(runDir, "base", "app");
      await env.git.export(repoDir, compare, baseDir);
      progress({ phase: `building base ${compare.slice(0, 7)}` });
      try {
        await build(env, runDir, "base", baseDir, world, log);
        progress({ phase: `running base through ${run.simDays} world days` });
        base = await runWorld(env, runDir, "base", baseDir, world, run.simDays);
        if (base.summary.ok) {
          mkdirSync(cached, { recursive: true });
          cpSync(join(runDir, "base", "out"), join(cached, "out"), { recursive: true });
          writeFileSync(join(cached, "host-ms"), String(base.hostMs));
        }
      } catch (e) {
        // A base that doesn't build or run leaves the change judged on its own.
        base = null;
        writeFileSync(join(runDir, "base-error.txt"), String(e));
      }
      rmSync(join(runDir, "base", "app"), { recursive: true, force: true });
      rmSync(join(runDir, "base", "state"), { recursive: true, force: true });
    }
  }

  progress({ phase: `building ${headSha.slice(0, 7)}` });
  await build(env, runDir, "head", headDir, world, log);
  progress({ phase: `running ${headSha.slice(0, 7)} through ${run.simDays} world days` });
  const head = await runWorld(env, runDir, "head", headDir, world, run.simDays);
  rmSync(headDir, { recursive: true, force: true });
  rmSync(join(runDir, "head", "state"), { recursive: true, force: true });
  rmSync(join(runDir, "sandbox"), { recursive: true, force: true });

  const result = evaluate(world.spec, run.simDays, head, base);
  const status = !head.summary.ok ? "error" : result.invariants.every((i) => i.ok) ? "passed" : "failed";
  const finished: Partial<Run> = {
    status,
    phase: null,
    invariants: result.invariants,
    metrics: result.metrics,
    reportUrl: `${env.publicUrl.replace(/\/$/, "")}/v1/runs/${run.id}/report`,
    error: head.summary.ok ? null : (head.summary.error ?? "the world failed").split("\n")[0] ?? null,
  };
  writeFileSync(
    join(runDir, "report.html"),
    renderReport({ run: { ...run, ...finished, sha: headSha, baseSha: compare } as Run, world: world.spec, worldSource: world.source, head, base, details: result.details, baseError: existsSync(join(runDir, "base-error.txt")) ? readFileSync(join(runDir, "base-error.txt"), "utf8") : null }),
  );
  progress(finished);
}
