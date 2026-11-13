// Hosts a built Cloudflare Worker inside the world with Miniflare, loaded from the product's own node_modules so the
// world runs the exact workerd the product pins. Every outbound fetch the Worker makes goes to `outbound`, which
// routes it to a twin; nothing leaves the sandbox (it has no network anyway).
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { WorldFile } from "../../contract.ts";
import type { HostedApp } from "../world.ts";

type Rule = { type: string; globs: string[] };
type BuiltConfig = {
  main: string;
  compatibility_date?: string;
  compatibility_flags?: string[];
  rules?: Rule[];
  triggers?: { crons?: string[] };
  assets?: { binding?: string; directory?: string };
  vars?: Record<string, string>;
  d1_databases?: { binding: string }[];
  kv_namespaces?: { binding: string }[];
  r2_buckets?: { bucket_name?: string; binding: string }[];
  durable_objects?: { bindings?: { name: string; class_name: string; script_name?: string }[] };
  migrations?: { new_sqlite_classes?: string[] }[];
};

// The slice of Miniflare's API the host uses (typed here so the runner needn't depend on one Miniflare version).
type D1 = { prepare(sql: string): { run(): Promise<unknown>; all(): Promise<{ results: unknown[] }> } };
type MF = {
  ready: Promise<unknown>;
  getD1Database(binding: string): Promise<D1>;
  getWorker(): Promise<{ scheduled(o: { cron: string; scheduledTime: Date }): Promise<{ outcome: string }> }>;
  dispatchFetch(url: string, init: unknown): Promise<unknown>;
  dispose(): Promise<void>;
};
type MiniflareModule = { Miniflare: new (o: Record<string, unknown>) => MF; Log: new (level: number) => unknown; LogLevel: { WARN: number } };

export type Outbound = (req: Request) => Promise<Response>;
export type LogSink = (level: string, text: string) => void;

export async function hostCloudflareWorker(opts: {
  appDir: string;
  app: WorldFile["app"];
  stateDir: string;
  outbound: Outbound;
  log: LogSink;
  notes: string[];
}): Promise<HostedApp> {
  const configPath = resolve(opts.appDir, opts.app.config);
  const root = dirname(configPath);
  const cfg = JSON.parse(readFileSync(configPath, "utf8")) as BuiltConfig;
  const req = createRequire(join(opts.appDir, "package.json"));
  const { Miniflare, Log, LogLevel } = req("miniflare") as MiniflareModule;

  const sqliteClasses = new Set((cfg.migrations ?? []).flatMap((m) => m.new_sqlite_classes ?? []));
  const durableObjects = Object.fromEntries(
    (cfg.durable_objects?.bindings ?? []).filter((b) => !b.script_name).map((b) => [b.name, { className: b.class_name, useSQLite: sqliteClasses.has(b.class_name) }]),
  );
  const d1 = (cfg.d1_databases ?? []).map((d) => d.binding);
  const unsupported = Object.keys(cfg).filter((k) => ["ai", "vectorize", "browser", "hyperdrive"].includes(k) && cfg[k as keyof BuiltConfig]);
  if (unsupported.length) opts.notes.push(`Bindings with no world stand-in yet (calls to them fail): ${unsupported.join(", ")}`);

  const mf = new Miniflare({
    rootPath: root,
    modules: true,
    modulesRoot: root,
    modulesRules: (cfg.rules ?? [{ type: "ESModule", globs: ["**/*.js", "**/*.mjs"] }]).map((r) => ({ type: r.type as "ESModule", include: r.globs })),
    scriptPath: join(root, cfg.main),
    compatibilityDate: cfg.compatibility_date ?? "2025-01-01",
    compatibilityFlags: cfg.compatibility_flags ?? [],
    d1Databases: d1,
    kvNamespaces: (cfg.kv_namespaces ?? []).map((k) => k.binding),
    r2Buckets: (cfg.r2_buckets ?? []).map((r) => r.binding),
    durableObjects,
    ...(cfg.assets?.directory
      ? { assets: { directory: resolve(root, cfg.assets.directory), ...(cfg.assets.binding ? { binding: cfg.assets.binding } : {}), routerConfig: { has_user_worker: true } } }
      : {}),
    bindings: { ...(cfg.vars ?? {}), ...opts.app.vars },
    defaultPersistRoot: opts.stateDir,
    outboundService: (r: Request) => opts.outbound(r),
    log: new Log(LogLevel.WARN),
    logRequests: false,
    structuredWorkerdLogs: true,
    handleStructuredLogs: ({ level, message }: { level: string; message: string }) => {
      for (const line of message.split("\n")) if (line.trim()) opts.log(level, line);
    },
    unsafeTriggerHandlers: true,
    cf: false,
  });
  await mf.ready;

  // Migrations, the way `wrangler d1 migrations apply --local` would.
  for (const [binding, dir] of Object.entries(opts.app.d1Migrations)) {
    const db = await mf.getD1Database(binding);
    const migrations = resolve(opts.appDir, dir);
    for (const file of readdirSync(migrations).filter((n) => n.endsWith(".sql")).sort()) {
      for (const statement of readFileSync(join(migrations, file), "utf8").split("--> statement-breakpoint")) {
        const sql = statement.replace(/^\s*--.*$/gm, "").trim();
        if (sql) await db.prepare(sql).run();
      }
    }
  }

  const worker = await mf.getWorker();
  return {
    fetch: (r) => mf.dispatchFetch(r.url, { method: r.method, headers: r.headers, body: r.body, duplex: "half", redirect: "manual" } as never) as unknown as Promise<Response>,
    scheduled: async (cron, at) => {
      const res = await worker.scheduled({ cron, scheduledTime: at });
      return res.outcome;
    },
    crons: () => cfg.triggers?.crons ?? [],
    databases: () => d1,
    sql: async (binding, query) => {
      const db = await mf.getD1Database(binding);
      const out = await db.prepare(query).all();
      return out.results as Record<string, unknown>[];
    },
    dispose: () => mf.dispose(),
  };
}
