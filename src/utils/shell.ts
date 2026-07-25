import {
  spawn,
  spawnSync,
  type ChildProcessByStdio,
} from "node:child_process";
import type { Readable } from "node:stream";
import type { ShellResult } from "../types";

const MAX_CAPTURED_OUTPUT_LENGTH = 64 * 1024;

type CommandResult = ShellResult & {
  exitCode?: number;
};

type CommandChild = ChildProcessByStdio<null, Readable, Readable>;

function appendOutputTail(current: string, chunk: string): string {
  const output = current + chunk;
  return output.length > MAX_CAPTURED_OUTPUT_LENGTH
    ? output.slice(-MAX_CAPTURED_OUTPUT_LENGTH)
    : output;
}

function terminateProcessTree(child: CommandChild): void {
  if (!child.pid) {
    child.kill("SIGKILL");
    return;
  }

  if (process.platform === "win32") {
    const result = spawnSync(
      "taskkill.exe",
      ["/PID", String(child.pid), "/T", "/F"],
      {
        stdio: "ignore",
        windowsHide: true,
      },
    );
    if (result.status !== 0) child.kill("SIGKILL");
    return;
  }

  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

export async function runCommand(
  command: string,
  args: string[],
  signal?: AbortSignal,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ ok: false, error: "Command aborted" });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    let child: CommandChild;
    const abortCommand = () => {
      terminateProcessTree(child);
      finish({
        ok: false,
        output: stdout || undefined,
        error: "Command aborted",
      });
    };
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abortCommand);
      resolve(result);
    };

    try {
      child = spawn(command, args, {
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      finish({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    signal?.addEventListener("abort", abortCommand, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = appendOutputTail(stdout, chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = appendOutputTail(stderr, chunk);
    });

    child.on("error", (error) => {
      finish({
        ok: false,
        output: stdout || undefined,
        error: error.message,
      });
    });

    child.on("close", (exitCode) => {
      if (exitCode === 0 && !signal?.aborted) {
        finish({ ok: true, output: stdout, exitCode });
        return;
      }

      finish({
        ok: false,
        output: stdout || undefined,
        exitCode: exitCode ?? undefined,
        error:
          stderr.trim() ||
          stdout.trim() ||
          (signal?.aborted
            ? "Command aborted"
            : `Command exited with code ${exitCode ?? "unknown"}`),
      });
    });
  });
}

export async function checkGhInstalled(
  signal?: AbortSignal,
): Promise<ShellResult> {
  return runCommand("gh", ["--version"], signal);
}

export async function checkGhAuth(signal?: AbortSignal): Promise<ShellResult> {
  const result = await runCommand("gh", ["auth", "status"], signal);
  return result.ok
    ? { ok: true }
    : { ok: false, error: "Not authenticated. Run: gh auth login" };
}

export async function ghRepoExists(
  name: string,
  signal?: AbortSignal,
): Promise<ShellResult> {
  return runCommand("gh", ["repo", "view", name], signal);
}

export async function ghCreateRepo(
  name: string,
  signal?: AbortSignal,
): Promise<ShellResult> {
  return runCommand("gh", ["repo", "create", name, "--private"], signal);
}

export async function ghGetRepoCloneUrl(
  name: string,
  signal?: AbortSignal,
): Promise<ShellResult> {
  const result = await runCommand(
    "gh",
    [
      "repo",
      "view",
      name,
      "--json",
      "sshUrl",
      "--jq",
      ".sshUrl",
    ],
    signal,
  );
  if (!result.ok) return result;

  const url = result.output?.trim() ?? "";
  return url
    ? { ok: true, output: url }
    : { ok: false, error: "GitHub CLI returned an empty repository URL" };
}

export async function checkGitRepoExists(
  url: string,
  signal?: AbortSignal,
): Promise<ShellResult> {
  const result = await runCommand("git", ["ls-remote", url], signal);
  return result.ok
    ? { ok: true }
    : { ok: false, error: result.error ?? "Cannot reach repository" };
}

export async function cloneRepo(
  url: string,
  dest: string,
  signal?: AbortSignal,
): Promise<ShellResult> {
  return runCommand("git", ["clone", url, dest], signal);
}

export async function gitPull(
  dir: string,
  signal?: AbortSignal,
): Promise<ShellResult> {
  const result = await runCommand("git", ["-C", dir, "pull"], signal);
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
  signal?: AbortSignal,
): Promise<ShellResult> {
  const add = await runCommand("git", ["-C", dir, "add", "-A"], signal);
  if (!add.ok) return add;

  const stagedChanges = await runCommand(
    "git",
    ["-C", dir, "diff", "--cached", "--quiet", "--exit-code"],
    signal,
  );
  if (stagedChanges.exitCode === 0) {
    return { ok: true, output: "Nothing to commit" };
  }
  if (stagedChanges.exitCode !== 1) return stagedChanges;

  const commit = await runCommand(
    "git",
    ["-C", dir, "commit", "-m", message],
    signal,
  );
  if (!commit.ok) return commit;

  return runCommand(
    "git",
    ["-C", dir, "push", "-u", "origin", "HEAD"],
    signal,
  );
}

export async function initRepo(
  dir: string,
  signal?: AbortSignal,
): Promise<ShellResult> {
  return runCommand("git", ["-C", dir, "init"], signal);
}

export async function gitSetRemoteUrl(
  dir: string,
  url: string,
  signal?: AbortSignal,
): Promise<ShellResult> {
  return runCommand(
    "git",
    ["-C", dir, "remote", "set-url", "origin", url],
    signal,
  );
}
