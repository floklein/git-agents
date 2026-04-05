import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

type ShellResult = { ok: boolean; output?: string; error?: string };

async function run(cmd: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args);
    return { exitCode: 0, stdout, stderr };
  } catch (e: any) {
    return { exitCode: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? e.message ?? "" };
  }
}

export async function checkGhInstalled(): Promise<ShellResult> {
  const r = await run("gh", ["--version"]);
  return { ok: r.exitCode === 0, output: r.stdout };
}

export async function checkGhAuth(): Promise<ShellResult> {
  const r = await run("gh", ["auth", "status"]);
  return r.exitCode === 0 ? { ok: true } : { ok: false, error: "Not authenticated. Run: gh auth login" };
}

export async function ghRepoExists(name: string): Promise<ShellResult> {
  const r = await run("gh", ["repo", "view", name]);
  return { ok: r.exitCode === 0 };
}

export async function ghCreateRepo(name: string): Promise<ShellResult> {
  const r = await run("gh", ["repo", "create", name, "--private"]);
  return { ok: r.exitCode === 0, output: r.stdout, error: r.stderr };
}

export async function ghGetRepoCloneUrl(name: string): Promise<ShellResult> {
  const r = await run("gh", ["repo", "view", name, "--json", "sshUrl", "--jq", ".sshUrl"]);
  const url = r.stdout.trim();
  return { ok: !!url, output: url };
}

export async function checkGitRepoExists(url: string): Promise<ShellResult> {
  const r = await run("git", ["ls-remote", url]);
  return r.exitCode === 0 ? { ok: true } : { ok: false, error: "Cannot reach repository" };
}

export async function cloneRepo(url: string, dest: string): Promise<ShellResult> {
  const r = await run("git", ["clone", url, dest]);
  return { ok: r.exitCode === 0, error: r.stderr };
}

export async function gitPull(dir: string): Promise<ShellResult> {
  const r = await run("git", ["-C", dir, "pull"]);
  return { ok: r.exitCode === 0, output: r.stdout, error: r.stderr };
}

export async function gitAddCommitPush(dir: string, message: string): Promise<ShellResult> {
  await run("git", ["-C", dir, "add", "-A"]);
  const status = await run("git", ["-C", dir, "status", "--porcelain"]);
  if (!status.stdout.trim()) {
    return { ok: true, output: "Nothing to commit" };
  }
  await run("git", ["-C", dir, "commit", "-m", message]);
  const push = await run("git", ["-C", dir, "push"]);
  return { ok: push.exitCode === 0, error: push.stderr };
}

export async function initRepo(dir: string): Promise<ShellResult> {
  const r = await run("git", ["-C", dir, "init"]);
  return { ok: r.exitCode === 0, error: r.stderr };
}
