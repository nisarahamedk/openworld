// The world host: runs inside the time-skipping gVisor sandbox. It boots the product, wires its outbound calls to the
// twins, fires its crons on world time, plays the scenario, checks the team's invariants every world day, and writes
// what it saw to the run's out directory. Usage: node host/main.ts <plan.json>
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { durationMs, HostPlan, type HostSummary } from "../contract.ts";
import { TWINS } from "../twins/index.ts";
import { hostCloudflareWorker } from "./adapters/cloudflare-worker.ts";
import { nextCron } from "./cron.ts";
import { inspectData } from "./data.ts";
import { isErrorLog, Observations, signature } from "./observe.ts";
import { DAY, holdClock, type HostedApp, type Scenario, type Twin, World } from "./world.ts";

const plan = HostPlan.parse(JSON.parse(readFileSync(process.argv[2] as string, "utf8")));
const obs = new Observations(plan.outDir);
const notes: string[] = [];
const summary: HostSummary = { ok: false, error: null, bootMs: 0, worldStart: new Date().toISOString(), worldEnd: "", simDaysDone: 0, scenarioErrors: [], notes };

const twinsByHost = new Map<string, Twin>();
async function outbound(req: Request): Promise<Response> {
  const release = holdClock();
  try {
    return await routeOutbound(req);
  } finally {
    release();
  }
}
async function routeOutbound(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const twin = twinsByHost.get(url.hostname) ?? null;
  let res: Response;
  try {
    res = twin
      ? await twin.handle(req)
      : Response.json({ error: `OpenWorld: nothing in this world answers ${url.hostname} (add a twin to the world file)` }, { status: 502 });
  } catch (e) {
    res = Response.json({ error: `twin ${twin?.name} crashed: ${String(e)}` }, { status: 500 });
  }
  obs.add("egress", { t: Date.now(), method: req.method, host: url.hostname, path: url.pathname, twin: twin?.name ?? null, status: res.status });
  return res;
}

function log(level: string, text: string) {
  obs.add("logs", { t: Date.now(), level, text: text.slice(0, 4000), signature: signature(text), error: isErrorLog(level, text) });
}

async function runInvariants(world: World, app: HostedApp) {
  for (const inv of plan.world.invariants) {
    try {
      const rows = await app.sql(inv.db, inv.sql);
      obs.add("invariants", { t: Date.now(), day: world.day(), name: inv.name, violations: rows.length, sample: rows.slice(0, 3), error: null });
    } catch (e) {
      obs.add("invariants", { t: Date.now(), day: world.day(), name: inv.name, violations: 0, sample: [], error: String(e) });
    }
  }
}

async function main() {
  const t0 = performance.now();
  const app = await hostCloudflareWorker({ appDir: plan.appDir, app: plan.world.app, stateDir: plan.stateDir, outbound, log, notes });
  summary.bootMs = Math.round(performance.now() - t0);
  const world = new World(app, plan.world.app.origin, obs, plan.world.seed, plan.simDays, plan.world.app.vars);
  summary.worldStart = new Date(world.start).toISOString();
  for (const [host, name] of Object.entries(plan.world.twins)) {
    const make = TWINS[name];
    if (!make) throw new Error(`world file names twin "${name}" for ${host}; known twins: ${Object.keys(TWINS).join(", ")}`);
    let twin = [...twinsByHost.values()].find((t) => t.name === name);
    if (!twin || name === "sink") twin = make(world, { host });
    twinsByHost.set(host, twin);
    world.twins.set(twin.name, twin);
  }
  obs.add("timeline", { t: Date.now(), day: 0, what: "world_started", bootMs: summary.bootMs });

  // Crons on world time. A time profile can run a busy cron less often (world file app.cronEvery).
  for (const cron of [...new Set([...app.crons(), ...plan.world.app.extraCrons])]) {
    const every = plan.world.app.cronEvery[cron];
    if (every) notes.push(`Cron "${cron}" ran every ${every} of world time instead of as written (time profile).`);
    world.spawn(`cron ${cron}`, async () => {
      let next = every ? Date.now() + durationMs(every) : nextCron(cron, Date.now());
      while (next < world.end) {
        await world.until(next);
        if (world.over) return;
        const c0 = performance.now();
        const release = holdClock();
        let outcome: string;
        try {
          outcome = await app.scheduled(cron, new Date(next));
        } catch (e) {
          outcome = `exception: ${String(e)}`;
        } finally {
          release();
        }
        obs.add("crons", { t: Date.now(), cron, outcome, ms: Math.round(performance.now() - c0) });
        next = every ? next + durationMs(every) : nextCron(cron, Math.max(next, Date.now()));
      }
    });
  }

  // The team's invariants, at the end of every world day.
  world.spawn("invariants", async () => {
    for (let d = 1; d <= plan.simDays; d++) {
      // A little before the day ends: a skip can land up to one quantum late.
      await world.until(world.start + d * DAY - 5 * 60_000);
      await runInvariants(world, app);
      obs.add("timeline", { t: Date.now(), day: d, what: "day_ended" });
      summary.simDaysDone = d;
      obs.flush();
    }
  });

  if (plan.world.scenario) {
    const path = resolve(dirname(plan.worldFile), plan.world.scenario);
    const mod = (await import(pathToFileURL(path).href)) as { default?: Scenario };
    if (typeof mod.default !== "function") throw new Error(`${plan.world.scenario} must export a default function (world) => Promise<void>`);
    const scenario = mod.default;
    world.spawn("scenario", () => scenario(world));
  }

  await world.until(world.end);
  world.stop();
  // Let in-flight requests settle (on world time) before the final look.
  await world.sleep(60_000);
  await runInvariants(world, app);
  obs.write("data.json", await inspectData(app, plan.world.checks));
  summary.worldEnd = new Date().toISOString();
  summary.scenarioErrors = world.errors;
  summary.ok = true;
  await app.dispose().catch(() => {});
}

main()
  .catch((e: unknown) => {
    summary.error = e instanceof Error ? (e.stack ?? e.message) : String(e);
    log("error", `OpenWorld host: ${summary.error}`);
  })
  .finally(() => {
    obs.write("summary.json", summary);
    process.exit(0);
  });
