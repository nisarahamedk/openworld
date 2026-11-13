// Runs a command in a gVisor sandbox: the image's own root filesystem, read-only with a private in-memory overlay,
// plus the run's directories bind-mounted read-write. Everything a PR brings (install scripts, build, the app itself)
// runs in here, never in the runner's own process.
//   build mode: network on (the package registry), real time
//   world mode: no network at all, and the patched Sentry skips time whenever every program in it is waiting
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type SandboxOptions = {
  runsc: string;
  /** Scratch for the OCI bundle. */
  workDir: string;
  /** runsc's state root; long-lived (it holds a netns bind mount that can't be deleted while mounted). */
  stateRoot: string;
  id: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** host path → path inside; read-write. */
  mounts: Record<string, string>;
  mode: "build" | "world";
  timeoutMs: number;
  logFile: string;
  /** World mode: round skips up to this quantum, so chatty timers share wake-ups (see engine/gvisor/README.md). */
  quantumMs?: number;
};

export type SandboxResult = { code: number | null; timedOut: boolean; ms: number };

const CAPS = ["CAP_CHOWN", "CAP_DAC_OVERRIDE", "CAP_FOWNER", "CAP_FSETID", "CAP_SETUID", "CAP_SETGID", "CAP_KILL", "CAP_NET_BIND_SERVICE"];

export async function runInSandbox(o: SandboxOptions): Promise<SandboxResult> {
  const bundle = join(o.workDir, `bundle-${o.id}`);
  const root = o.stateRoot;
  mkdirSync(bundle, { recursive: true });
  mkdirSync(root, { recursive: true });
  const env = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp/home", LANG: "C.UTF-8", ...o.env };
  const config = {
    ociVersion: "1.0.0",
    process: {
      user: { uid: 0, gid: 0 },
      args: o.args,
      env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
      cwd: o.cwd,
      capabilities: { bounding: CAPS, effective: CAPS, permitted: CAPS },
      noNewPrivileges: true,
    },
    root: { path: "/", readonly: false },
    hostname: o.mode === "world" ? "world" : "build",
    mounts: [
      { destination: "/proc", type: "proc", source: "proc" },
      { destination: "/tmp", type: "tmpfs", source: "tmpfs" },
      { destination: "/dev/shm", type: "tmpfs", source: "tmpfs" },
      ...Object.entries(o.mounts).map(([src, dst]) => ({ destination: dst, type: "bind", source: src, options: ["rbind", "rw"] })),
    ],
    linux: { namespaces: [{ type: "pid" }, { type: "ipc" }, { type: "uts" }, { type: "mount" }, ...(o.mode === "world" ? [{ type: "network" }] : [])] },
  };
  writeFileSync(join(bundle, "config.json"), JSON.stringify(config));

  const flags = [`--root=${root}`, `--network=${o.mode === "world" ? "none" : "host"}`, "--overlay2=root:memory", "--ignore-cgroups", ...(process.getuid?.() === 0 ? [] : ["--rootless"])];
  const tess: Record<string, string> =
    o.mode === "world" ? { TESS_SKIP: "1", TESS_QUANTUM_MS: String(o.quantumMs ?? 60_000), TESS_GRACE_US: "500" } : {};
  const log = createWriteStream(o.logFile, { flags: "a" });
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn(o.runsc, [...flags, "run", "--bundle", bundle, o.id], { env: { ...process.env, ...tess }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      spawn(o.runsc, [...flags, "kill", o.id, "KILL"]).on("exit", () => child.kill("SIGKILL"));
    }, o.timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      spawn(o.runsc, [...flags, "delete", "-force", o.id]).on("exit", () => {
        log.end();
        resolve({ code, timedOut, ms: Date.now() - t0 });
      });
    });
  });
}
