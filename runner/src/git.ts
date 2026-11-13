// Fetches commits from GitHub into a cached partial clone (history, no blobs until needed) and exports trees.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export class Git {
  private readonly cacheDir: string;
  private readonly token: string | null;
  constructor(cacheDir: string, token: string | null) {
    this.cacheDir = cacheDir;
    this.token = token;
  }

  // The token goes to git through its environment (GIT_CONFIG_*), never argv or a config file on disk, and reaches
  // the lazy blob fetches `git archive` makes in a partial clone too.
  private env(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    if (this.token) {
      env.GIT_CONFIG_COUNT = "1";
      env.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraHeader";
      env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(`x-access-token:${this.token}`).toString("base64")}`;
    }
    return env;
  }

  private async git(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await exec("git", args, { cwd, maxBuffer: 64 * 1024 * 1024, env: this.env() });
    return stdout.trim();
  }

  /** The repo's cached clone, with `shas` and the default branch fetched. Returns its dir and default branch. */
  async fetch(repo: string, shas: string[]): Promise<{ dir: string; defaultBranch: string }> {
    const dir = join(this.cacheDir, `${repo.replace("/", "__")}.git`);
    const url = `https://github.com/${repo}.git`;
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      await this.git(dir, ["init", "--bare", "-q"]);
      await this.git(dir, ["remote", "add", "origin", url]);
      await this.git(dir, ["config", "remote.origin.promisor", "true"]);
      await this.git(dir, ["config", "remote.origin.partialclonefilter", "blob:none"]);
    }
    const head = await this.git(dir, ["ls-remote", "--symref", "origin", "HEAD"]);
    const defaultBranch = /ref: refs\/heads\/(\S+)\s+HEAD/.exec(head)?.[1] ?? "main";
    await this.git(dir, ["fetch", "-q", "--filter=blob:none", "origin", `+refs/heads/${defaultBranch}:refs/remotes/origin/${defaultBranch}`, ...shas]);
    return { dir, defaultBranch };
  }

  async resolve(dir: string, rev: string): Promise<string> {
    return this.git(dir, ["rev-parse", "--verify", `${rev}^{commit}`]);
  }

  async mergeBase(dir: string, a: string, b: string): Promise<string | null> {
    try {
      return await this.git(dir, ["merge-base", a, b]);
    } catch {
      return null;
    }
  }

  /** Writes the tree at `sha` into `dest` (no .git). */
  async export(dir: string, sha: string, dest: string): Promise<void> {
    mkdirSync(dest, { recursive: true });
    await exec("sh", ["-c", `git archive --format=tar "$1" | tar -x -C "$2"`, "sh", sha, dest], { cwd: dir, maxBuffer: 1024 * 1024 * 1024, env: this.env() });
  }
}
