import {
  spawn,
  spawnSync,
  type ChildProcessByStdio,
} from "node:child_process";
import type { Readable } from "node:stream";
import type { ShellResult } from "../types";

const MAX_CAPTURED_OUTPUT_LENGTH = 64 * 1024;
const PENDING_SYNC_REF = "refs/git-agents/pending-sync";

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
  paths: string[],
  signal?: AbortSignal,
): Promise<ShellResult> {
  const repository = await runCommand(
    "git",
    ["-C", dir, "rev-parse", "--git-dir"],
    signal,
  );
  if (!repository.ok) return repository;

  const headResult = await runCommand(
    "git",
    ["-C", dir, "rev-parse", "--verify", "HEAD^{commit}"],
    signal,
  );
  let head = headResult.ok ? headResult.output?.trim() : undefined;
  if (!head) {
    const symbolicHead = await runCommand(
      "git",
      ["-C", dir, "symbolic-ref", "-q", "HEAD"],
      signal,
    );
    if (!symbolicHead.ok) return headResult;
  }

  const outgoingCommitGroups: string[][] = [];
  let pendingCommit: string | undefined;
  if (head) {
    const branch = await runCommand(
      "git",
      ["-C", dir, "symbolic-ref", "--quiet", "--short", "HEAD"],
      signal,
    );
    const branchName = branch.ok ? branch.output?.trim() : undefined;
    if (!branchName) {
      return {
        ok: false,
        error: "Refusing to sync from a detached Git HEAD.",
      };
    }

    const pushUrlsResult = await runCommand(
      "git",
      [
        "-C",
        dir,
        "remote",
        "get-url",
        "--push",
        "--all",
        "origin",
      ],
      signal,
    );
    if (!pushUrlsResult.ok) return pushUrlsResult;
    const pushUrls = pushUrlsResult.output
      ? pushUrlsResult.output.split(/\r?\n/).filter(Boolean)
      : [];
    if (pushUrls.length === 0) {
      return {
        ok: false,
        error: "Origin has no configured Git push destination.",
      };
    }

    for (const pushUrl of pushUrls) {
      let comparisonBase: string | undefined;
      const remoteHead = await runCommand(
        "git",
        [
          "-C",
          dir,
          "ls-remote",
          "--heads",
          pushUrl,
          `refs/heads/${branchName}`,
        ],
        signal,
      );
      if (!remoteHead.ok) {
        return {
          ok: false,
          error:
            "Failed to verify an origin push destination before syncing: " +
            (remoteHead.error ?? "unknown error"),
        };
      }
      const remoteHeadLine = remoteHead.output?.trim();
      if (remoteHeadLine) {
        const remoteCommit = remoteHeadLine.split(/\s+/)[0];
        if (
          !remoteCommit ||
          !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(remoteCommit)
        ) {
          return {
            ok: false,
            error:
              `Git returned an invalid origin/${branchName} commit identifier.`,
          };
        }
        comparisonBase = remoteCommit;
        const localRemoteCommit = await runCommand(
          "git",
          ["-C", dir, "cat-file", "-e", `${comparisonBase}^{commit}`],
          signal,
        );
        if (!localRemoteCommit.ok) {
          return {
            ok: false,
            error:
              `origin/${branchName} changed since the last pull. ` +
              "Pull and review the changes again before syncing.",
          };
        }
        const remoteIsAncestor = await runCommand(
          "git",
          ["-C", dir, "merge-base", "--is-ancestor", comparisonBase, head],
          signal,
        );
        if (!remoteIsAncestor.ok) {
          if (remoteIsAncestor.exitCode !== 1) return remoteIsAncestor;
          return {
            ok: false,
            error:
              `origin/${branchName} is ahead of or has diverged from the local branch. ` +
              "Pull and review the changes again before syncing.",
          };
        }
      }

      const outgoing = await runCommand(
        "git",
        [
          "-C",
          dir,
          "rev-list",
          "--reverse",
          comparisonBase ? `${comparisonBase}..${head}` : head,
        ],
        signal,
      );
      if (!outgoing.ok) return outgoing;
      outgoingCommitGroups.push(
        outgoing.output
          ? outgoing.output.split(/\r?\n/).filter(Boolean)
          : [],
      );
    }

    const pending = await runCommand(
      "git",
      ["-C", dir, "rev-parse", "--verify", `${PENDING_SYNC_REF}^{commit}`],
      signal,
    );
    pendingCommit = pending.ok ? pending.output?.trim() : undefined;
  }

  const outgoingCommitCount = Math.max(
    0,
    ...outgoingCommitGroups.map((commits) => commits.length),
  );
  const isKnownRetry = Boolean(
    head &&
      pendingCommit === head &&
      outgoingCommitGroups.every(
        (commits) =>
          commits.length === 0 ||
          (commits.length === 1 && commits[0] === head),
      ),
  );
  if (outgoingCommitCount > 0 && !isKnownRetry) {
    const noun = outgoingCommitCount === 1 ? "commit" : "commits";
    return {
      ok: false,
      error:
        `Refusing to push ${outgoingCommitCount} unreviewed local ${noun}. ` +
        "Push or reconcile them manually before syncing.",
    };
  }

  if (isKnownRetry) {
    if (!head) {
      return { ok: false, error: "Git returned an empty commit identifier" };
    }

    const changed = await runCommand(
      "git",
      [
        "-C",
        dir,
        "-c",
        "core.quotePath=false",
        "diff-tree",
        "--no-commit-id",
        "--name-only",
        "-r",
        "--root",
        head,
      ],
      signal,
    );
    if (!changed.ok) return changed;

    const changedPaths = changed.output
      ? changed.output.split(/\r?\n/).filter(Boolean)
      : [];
    if (changedPaths.length === 0) {
      return {
        ok: false,
        error: "Refusing to retry a pending sync commit with no changed paths.",
      };
    }

    const retryPaths = paths.length > 0 ? paths : changedPaths;
    const status = await runCommand(
      "git",
      [
        "-C",
        dir,
        "status",
        "--porcelain",
        "--untracked-files=all",
        "--ignored=matching",
        "--",
        ...retryPaths,
      ],
      signal,
    );
    if (!status.ok) return status;
    const hasNewReviewedChanges = Boolean(status.output?.trim());
    if (hasNewReviewedChanges && paths.length === 0) {
      return {
        ok: false,
        error:
          "Refusing to retry the pending sync commit because a managed path changed and no reviewed paths were provided.",
      };
    }

    const retryPush = await runCommand(
      "git",
      ["-C", dir, "push", "-u", "origin", "HEAD"],
      signal,
    );
    if (!retryPush.ok) return retryPush;
    await runCommand(
      "git",
      ["-C", dir, "update-ref", "-d", PENDING_SYNC_REF],
      signal,
    );
    if (!hasNewReviewedChanges) return retryPush;
  }

  if (paths.length === 0) {
    return { ok: true, output: "Nothing to commit" };
  }

  const add = await runCommand(
    "git",
    ["-C", dir, "add", "-A", "-f", "--", ...paths],
    signal,
  );
  if (!add.ok) return add;

  const status = await runCommand(
    "git",
    ["-C", dir, "status", "--porcelain", "--", ...paths],
    signal,
  );
  if (!status.ok) return status;
  if (!status.output?.trim()) {
    await runCommand(
      "git",
      ["-C", dir, "update-ref", "-d", PENDING_SYNC_REF],
      signal,
    );
    return { ok: true, output: "Nothing to commit" };
  }

  const commit = await runCommand(
    "git",
    ["-C", dir, "commit", "-m", message, "--only", "--", ...paths],
    signal,
  );
  if (!commit.ok) return commit;

  const committedHead = await runCommand(
    "git",
    ["-C", dir, "rev-parse", "--verify", "HEAD^{commit}"],
    signal,
  );
  if (!committedHead.ok) return committedHead;
  head = committedHead.output?.trim();
  if (!head) {
    return { ok: false, error: "Git returned an empty commit identifier" };
  }

  const markPending = await runCommand(
    "git",
    ["-C", dir, "update-ref", PENDING_SYNC_REF, head],
    signal,
  );
  if (!markPending.ok) return markPending;

  const push = await runCommand(
    "git",
    ["-C", dir, "push", "-u", "origin", "HEAD"],
    signal,
  );
  if (!push.ok) return push;
  await runCommand(
    "git",
    ["-C", dir, "update-ref", "-d", PENDING_SYNC_REF],
    signal,
  );
  return push;
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
