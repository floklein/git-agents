import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { AGENT_DEFS } from "../utils/agentDefs";
import { CANONICAL_DIR } from "../canonical/canonical";
import { SYNC_MANIFEST_FILE, readSyncManifest } from "../utils/manifest";
import { getLocalSyncPath, getRemoteSyncPath } from "../utils/config";
import {
  compareSyncPathSnapshots,
  mirrorSyncPath,
  snapshotSyncPath,
} from "../utils/agents";
import { runCommand } from "../utils/shell";
import { InternalCommandError, invalidInputError } from "./errors";
import type { ShellResult } from "../types";
import type { InternalDeps } from "./commands";

const ALL_SYNC_PATHS = AGENT_DEFS.flatMap((def) => def.syncPaths);
const COMMIT_SCOPE = [...ALL_SYNC_PATHS, SYNC_MANIFEST_FILE, CANONICAL_DIR];

const NUL = String.fromCharCode(0);

type GitResult = ShellResult & { exitCode?: number };

function git(dir: string, ...args: string[]): Promise<GitResult> {
  return runCommand("git", ["-C", dir, ...args]);
}

function requireClone(deps: InternalDeps): void {
  if (!existsSync(join(deps.configDir, ".git"))) {
    throw new InternalCommandError(
      "not-configured",
      "No sync repository found. Run the setup subcommand first.",
    );
  }
}

function mergeInProgress(configDir: string): boolean {
  return existsSync(join(configDir, ".git", "MERGE_HEAD"));
}

async function conflictedPaths(configDir: string): Promise<string[]> {
  const result = await git(configDir, "ls-files", "-u");
  if (!result.ok) {
    throw new InternalCommandError(
      "transport-failed",
      `Could not list conflicted files: ${result.error ?? "unknown error"}`,
    );
  }
  const paths = new Set<string>();
  for (const line of (result.output ?? "").split("\n")) {
    const path = line.split("\t")[1];
    if (path) paths.add(path);
  }
  return [...paths].sort();
}

async function stageContent(
  configDir: string,
  stage: 1 | 2 | 3,
  path: string,
): Promise<string | null> {
  const result = await git(configDir, "show", `:${stage}:${path}`);
  return result.ok ? (result.output ?? "") : null;
}

function isBinary(content: string | null): boolean {
  return content !== null && content.includes(NUL);
}

export type ConflictFile = {
  path: string;
  binary: boolean;
  base: string | null;
  local: string | null;
  remote: string | null;
};

type PathChange = { path: string; status: string };

function diffAgainstClone(
  deps: InternalDeps,
  direction: "outgoing" | "incoming",
): PathChange[] {
  const initialized = new Set(readSyncManifest(deps.configDir)?.paths ?? []);
  const changes: PathChange[] = [];
  for (const syncPath of ALL_SYNC_PATHS) {
    const localPath = getLocalSyncPath(syncPath, deps.homeDir);
    const remotePath = getRemoteSyncPath(syncPath, deps.configDir);
    const local = snapshotSyncPath(localPath);
    const remote = snapshotSyncPath(remotePath);
    const source = direction === "outgoing" ? local : remote;
    const destination = direction === "outgoing" ? remote : local;
    if (
      source === null &&
      !(destination !== null && initialized.has(syncPath))
    ) {
      continue;
    }
    const status = compareSyncPathSnapshots(source, destination);
    if (status !== "unchanged") changes.push({ path: syncPath, status });
  }
  return changes;
}

function mirrorChanged(
  deps: InternalDeps,
  direction: "outgoing" | "incoming",
): PathChange[] {
  const changes = diffAgainstClone(deps, direction);
  for (const change of changes) {
    const localPath = getLocalSyncPath(change.path, deps.homeDir);
    const remotePath = getRemoteSyncPath(change.path, deps.configDir);
    if (direction === "outgoing") {
      mirrorSyncPath(localPath, remotePath, deps.homeDir, deps.configDir);
    } else {
      mirrorSyncPath(remotePath, localPath, deps.configDir, deps.homeDir);
    }
  }
  return changes;
}

async function stageScope(configDir: string): Promise<void> {
  for (const scopePath of COMMIT_SCOPE) {
    const inWorktree = existsSync(join(configDir, ...scopePath.split("/")));
    const tracked = await git(configDir, "ls-files", "--", scopePath);
    if (!inWorktree && !(tracked.ok && tracked.output?.trim())) continue;
    const added = await git(configDir, "add", "-A", "--", scopePath);
    if (!added.ok) {
      throw new InternalCommandError(
        "transport-failed",
        `Could not stage ${scopePath}: ${added.error ?? "unknown error"}`,
      );
    }
  }
}

export type TransportBeginResult =
  | { state: "clean"; outgoing: PathChange[]; incoming: PathChange[] }
  | { state: "conflicts"; outgoing: PathChange[]; conflicts: ConflictFile[] };

export async function runTransportBegin(
  deps: InternalDeps,
): Promise<TransportBeginResult> {
  requireClone(deps);
  if (mergeInProgress(deps.configDir)) {
    throw new InternalCommandError(
      "transport-in-progress",
      "A transport merge is already in progress. Resolve it (transport-resolve, transport-commit) or abort it (transport-abort) first.",
    );
  }

  const outgoing = mirrorChanged(deps, "outgoing");

  await stageScope(deps.configDir);
  const staged = await git(deps.configDir, "diff", "--cached", "--quiet");
  if (!staged.ok) {
    if (staged.exitCode !== 1) {
      throw new InternalCommandError(
        "transport-failed",
        `Could not inspect staged changes: ${staged.error ?? "unknown error"}`,
      );
    }
    const committed = await git(
      deps.configDir,
      "commit",
      "-m",
      `sync: local harness state (${new Date().toISOString().slice(0, 10)})`,
    );
    if (!committed.ok) {
      throw new InternalCommandError(
        "transport-failed",
        `Could not commit local state: ${committed.error ?? "unknown error"}`,
      );
    }
  }

  const pulled = await git(deps.configDir, "pull", "--no-rebase", "--no-edit");
  if (!pulled.ok) {
    const error = pulled.error ?? "";
    const emptyRemote =
      error.includes("no such ref was fetched") ||
      error.includes("couldn't find remote ref");
    if (!emptyRemote) {
      const conflicted = await conflictedPaths(deps.configDir);
      if (conflicted.length === 0) {
        throw new InternalCommandError(
          "transport-failed",
          `Could not merge from origin: ${error || "unknown error"}`,
        );
      }
      const conflicts: ConflictFile[] = [];
      for (const path of conflicted) {
        const [base, local, remote] = await Promise.all([
          stageContent(deps.configDir, 1, path),
          stageContent(deps.configDir, 2, path),
          stageContent(deps.configDir, 3, path),
        ]);
        const binary = isBinary(base) || isBinary(local) || isBinary(remote);
        conflicts.push({
          path,
          binary,
          base: binary ? null : base,
          local: binary ? null : local,
          remote: binary ? null : remote,
        });
      }
      return { state: "conflicts", outgoing, conflicts };
    }
  }

  return {
    state: "clean",
    outgoing,
    incoming: diffAgainstClone(deps, "incoming"),
  };
}

const ResolveInputSchema = z.object({
  files: z
    .array(z.object({ path: z.string().min(1), content: z.string() }))
    .min(1),
});

export type TransportResolveResult = {
  resolved: string[];
  remaining: string[];
};

export async function runTransportResolve(
  deps: InternalDeps,
  rawInput: unknown,
): Promise<TransportResolveResult> {
  requireClone(deps);
  if (!mergeInProgress(deps.configDir)) {
    throw new InternalCommandError(
      "no-transport",
      "No transport merge is in progress. Run transport-begin first.",
    );
  }
  const parsed = ResolveInputSchema.safeParse(rawInput);
  if (!parsed.success) throw invalidInputError("transport-resolve", parsed.error);

  const conflicted = new Set(await conflictedPaths(deps.configDir));
  const resolved: string[] = [];
  for (const file of parsed.data.files) {
    if (!conflicted.has(file.path)) {
      throw new InternalCommandError(
        "not-conflicted",
        `${file.path} is not a conflicted file in this merge.`,
      );
    }
    const target = getRemoteSyncPath(file.path, deps.configDir);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content, "utf8");
    const added = await git(deps.configDir, "add", "--", file.path);
    if (!added.ok) {
      throw new InternalCommandError(
        "transport-failed",
        `Could not mark ${file.path} resolved: ${added.error ?? "unknown error"}`,
      );
    }
    resolved.push(file.path);
  }

  return {
    resolved,
    remaining: await conflictedPaths(deps.configDir),
  };
}

const CommitInputSchema = z
  .object({ deferPush: z.boolean().optional() })
  .optional();

export type TransportCommitResult = {
  mergeCompleted: boolean;
  mirroredBack: PathChange[];
  pushed: boolean;
};

export async function runTransportCommit(
  deps: InternalDeps,
  rawInput: unknown,
): Promise<TransportCommitResult> {
  requireClone(deps);
  const parsed = CommitInputSchema.safeParse(rawInput);
  if (!parsed.success) throw invalidInputError("transport-commit", parsed.error);
  const deferPush = parsed.data?.deferPush === true;

  let mergeCompleted = false;
  if (mergeInProgress(deps.configDir)) {
    const remaining = await conflictedPaths(deps.configDir);
    if (remaining.length > 0) {
      throw new InternalCommandError(
        "unresolved-conflicts",
        `Conflicts remain unresolved: ${remaining.join(", ")}. Resolve them with transport-resolve first.`,
      );
    }
    const committed = await git(deps.configDir, "commit", "--no-edit");
    if (!committed.ok) {
      throw new InternalCommandError(
        "transport-failed",
        `Could not complete the merge commit: ${committed.error ?? "unknown error"}`,
      );
    }
    mergeCompleted = true;
  }

  const mirroredBack = mirrorChanged(deps, "incoming");

  let pushed = false;
  if (!deferPush) {
    const pushResult = await git(deps.configDir, "push", "-u", "origin", "HEAD");
    if (!pushResult.ok) {
      throw new InternalCommandError(
        "push-failed",
        `Could not push to origin: ${pushResult.error ?? "unknown error"}. The merge is committed locally; re-running transport-commit retries the push.`,
      );
    }
    pushed = true;
  }

  return { mergeCompleted, mirroredBack, pushed };
}

export type TransportAbortResult = { aborted: boolean; message: string };

export async function runTransportAbort(
  deps: InternalDeps,
): Promise<TransportAbortResult> {
  requireClone(deps);
  if (!mergeInProgress(deps.configDir)) {
    return { aborted: false, message: "No transport merge is in progress." };
  }
  const aborted = await git(deps.configDir, "merge", "--abort");
  if (!aborted.ok) {
    throw new InternalCommandError(
      "transport-failed",
      `Could not abort the merge: ${aborted.error ?? "unknown error"}`,
    );
  }
  return { aborted: true, message: "Merge aborted; pre-sync state restored." };
}
