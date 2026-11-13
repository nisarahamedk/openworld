// The runner's two contracts: the HTTP protocol the factory speaks (openfactory plugins/world-openworld), and the
// world file a team writes to describe its world.
import { z } from "zod";

// ───────────────────────────── HTTP protocol ─────────────────────────────

export const StartRun = z.object({
  /** "owner/name" on GitHub. */
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  /** Full 40-character commit SHA (GitHub serves only full SHAs to fetch). */
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  /** The world's name: the world file `.openworld/<world>.yaml` in the repo (or the runner's bundled copy). */
  world: z.string().regex(/^[\w.-]+$/),
  simDays: z.number().int().min(1).max(90),
  /** Compare against this commit instead of the merge base with the default branch. */
  baseSha: z.string().regex(/^[0-9a-f]{40}$/).optional(),
});
export type StartRun = z.infer<typeof StartRun>;

export const RunStatus = z.enum(["queued", "running", "passed", "failed", "error"]);
export type RunStatus = z.infer<typeof RunStatus>;

export const Invariant = z.object({ name: z.string(), ok: z.boolean(), detail: z.string() });
export type Invariant = z.infer<typeof Invariant>;
export const Metric = z.object({ name: z.string(), value: z.number(), unit: z.string() });
export type Metric = z.infer<typeof Metric>;

export const Run = z.object({
  id: z.string(),
  status: RunStatus,
  repo: z.string(),
  sha: z.string(),
  baseSha: z.string().nullable(),
  world: z.string(),
  simDays: z.number(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  /** What the runner is doing now, for people watching a running run. */
  phase: z.string().nullable(),
  invariants: z.array(Invariant),
  metrics: z.array(Metric),
  reportUrl: z.string().nullable(),
  error: z.string().nullable(),
});
export type Run = z.infer<typeof Run>;

// ───────────────────────────── world file ─────────────────────────────

const Duration = z.string().regex(/^\d+(ms|s|m|h|d)$/);

export const WorldFile = z.object({
  name: z.string(),
  description: z.string().default(""),
  /** How the product is built and hosted inside the world. */
  app: z.object({
    /** Host adapter. Only Cloudflare Workers today; containers next. */
    adapter: z.literal("cloudflare-worker"),
    /** Shell commands run in the checkout, inside a sandbox with network, before the world starts. */
    prepare: z.array(z.string()).default([]),
    /** The built Worker's config, as `vite build` with @cloudflare/vite-plugin writes it. */
    config: z.string().default("dist/server/wrangler.json"),
    /** D1 binding → migrations directory, applied in file-name order before day 0. */
    d1Migrations: z.record(z.string(), z.string()).default({}),
    /** The origin the world's people use to reach the app. */
    origin: z.string().url().default("https://app.world.test"),
    /** Plain vars and the world's own fake secrets (never real ones: the world can't reach real services). */
    vars: z.record(z.string(), z.string()).default({}),
    /**
     * Time profile for crons: run a cron less often than written ("* * * * *": "10m"). Like Postgres's autovacuum
     * naptime in the gVisor spike, this changes when housekeeping runs, not what it does; the report lists it.
     */
    cronEvery: z.record(z.string(), Duration).default({}),
    /** Crons production runs that the built config doesn't list (e.g. added by the deploy script). */
    extraCrons: z.array(z.string()).default([]),
  }),
  /** Outbound host → stand-in. Any other host gets a 502 and shows up as unexpected egress. */
  twins: z.record(z.string(), z.string()).default({}),
  /** A TS module (relative to the world file) that plays the world's people and providers. */
  scenario: z.string().optional(),
  /** Seed for every random choice the scenario makes, so the base and the change see the same world. */
  seed: z.number().int().default(1),
  /** Settings for the generic checks every world gets. */
  checks: z
    .object({
      /** A route's p95 above this fails "slow requests" (and so does doubling the base's p95 when above 200 ms). */
      slowRequestMs: z.number().default(1000),
      /** Tables the duplicate check skips (e.g. append-only logs where repeats are normal). */
      duplicatesIgnore: z.array(z.string()).default([]),
      /** Columns that never count when comparing rows for duplicates (ids and timestamps are always ignored). */
      duplicatesIgnoreColumns: z.array(z.string()).default([]),
    })
    .default({ slowRequestMs: 1000, duplicatesIgnore: [], duplicatesIgnoreColumns: [] }),
  /** The team's own rules: each SQL query returns the rows that break it; checked every world day and at the end. */
  invariants: z
    .array(
      z.object({
        name: z.string(),
        description: z.string().default(""),
        db: z.string().default("DB"),
        sql: z.string(),
      }),
    )
    .default([]),
});
export type WorldFile = z.infer<typeof WorldFile>;

export function durationMs(d: string): number {
  const m = /^(\d+)(ms|s|m|h|d)$/.exec(d);
  if (!m) throw new Error(`bad duration ${d}`);
  const n = Number(m[1]);
  return n * { ms: 1, s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 }[m[2] as "ms"];
}

// ───────────────────────────── host plan and observations ─────────────────────────────

/** What the runner hands the host inside the sandbox. */
export const HostPlan = z.object({
  appDir: z.string(),
  worldFile: z.string(),
  world: WorldFile,
  simDays: z.number(),
  outDir: z.string(),
  stateDir: z.string(),
  label: z.enum(["head", "base"]),
});
export type HostPlan = z.infer<typeof HostPlan>;

export type RequestObs = { t: number; method: string; route: string; status: number; ms: number; actor: string };
export type LogObs = { t: number; level: string; text: string; signature: string; error: boolean };
export type EgressObs = { t: number; method: string; host: string; path: string; twin: string | null; status: number };
export type CronObs = { t: number; cron: string; outcome: string; ms: number };
export type InvariantObs = { t: number; day: number; name: string; violations: number; sample: unknown[]; error: string | null };
export type DataObs = {
  tables: { name: string; rows: number }[];
  duplicates: { table: string; groups: number; extraRows: number; sample: unknown[] }[];
  orphans: { table: string; column: string; parent: string; rows: number; sample: unknown[] }[];
};
export type HostSummary = {
  ok: boolean;
  error: string | null;
  /** World time the boot took (the clock skips while the app waits during boot). */
  bootMs: number;
  worldStart: string;
  worldEnd: string;
  simDaysDone: number;
  scenarioErrors: string[];
  notes: string[];
};
