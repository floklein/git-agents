import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ShellResult } from "../types";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

type CommandError = Error & {
  stdout?: string | Buffer;
  stderr?: string | Buffer;
};

function outputText(value: string | Buffer | undefined): string {
  return typeof value === "string" ? value : value?.toString() ?? "";
}

async function runCommand(
  command: string,
  args: string[],
): Promise<ShellResult> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    return { ok: true, output: outputText(stdout) };
  } catch (error) {
    const commandError = error as CommandError;
    const stdout = outputText(commandError.stdout);
    const stderr = outputText(commandError.stderr).trim();
    return {
      ok: false,
      output: stdout || undefined,
      error: stderr || commandError.message,
    };
  }
}

export async function checkGhInstalled(): Promise<ShellResult> {
  return runCommand("gh", ["--version"]);
}

export async function checkGhAuth(): Promise<ShellResult> {
  const result = await runCommand("gh", ["auth", "status"]);
  return result.ok
    ? { ok: true }
    : { ok: false, error: "Not authenticated. Run: gh auth login" };
}

export async function ghRepoExists(name: string): Promise<ShellResult> {
  return runCommand("gh", ["repo", "view", name]);
}

export async function ghCreateRepo(name: string): Promise<ShellResult> {
  return runCommand("gh", ["repo", "create", name, "--private"]);
}

export async function ghGetRepoCloneUrl(name: string): Promise<ShellResult> {
  const result = await runCommand("gh", [
    "repo",
    "view",
    name,
    "--json",
    "sshUrl",
    "--jq",
    ".sshUrl",
  ]);
  if (!result.ok) return result;

  const url = result.output?.trim() ?? "";
  return url
    ? { ok: true, output: url }
    : { ok: false, error: "GitHub CLI returned an empty repository URL" };
}

export async function checkGitRepoExists(url: string): Promise<ShellResult> {
  const result = await runCommand("git", ["ls-remote", url]);
  return result.ok
    ? { ok: true }
    : { ok: false, error: result.error ?? "Cannot reach repository" };
}

export async function cloneRepo(url: string, dest: string): Promise<ShellResult> {
  return runCommand("git", ["clone", url, dest]);
}

export async function gitPull(dir: string): Promise<ShellResult> {
  const result = await runCommand("git", ["-C", dir, "pull"]);
  if (result.ok) return result;

  const error = result.error ?? "";
  // A newly created remote can be empty, which is a successful no-op for sync.
  if (
    error.includes("no such ref was fetched") ||
    error.includes("couldn't find remote ref")
  ) {
    return { ok: true, output: "Remote is empty" };
  }
  return result;
}

export async function gitAddCommitPush(
  dir: string,
  message: string,
): Promise<ShellResult> {
  const add = await runCommand("git", ["-C", dir, "add", "-A"]);
  if (!add.ok) return add;

  const status = await runCommand("git", ["-C", dir, "status", "--porcelain"]);
  if (!status.ok) return status;
  if (!status.output?.trim()) {
    return { ok: true, output: "Nothing to commit" };
  }

  const commit = await runCommand("git", ["-C", dir, "commit", "-m", message]);
  if (!commit.ok) return commit;

  return runCommand("git", ["-C", dir, "push", "-u", "origin", "HEAD"]);
}

export async function initRepo(dir: string): Promise<ShellResult> {
  return runCommand("git", ["-C", dir, "init"]);
}

export async function gitSetRemoteUrl(
  dir: string,
  url: string,
): Promise<ShellResult> {
  return runCommand("git", ["-C", dir, "remote", "set-url", "origin", url]);
}
