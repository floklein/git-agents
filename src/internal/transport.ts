import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { AGENT_DEFS } from "../utils/agentDefs";
import { CANONICAL_DIR } from "../canonical/canonical";
import { SYNC_MANIFEST_FILE } from "../utils/manifest";
import { getLocalSyncPath, getRemoteSyncPath } from "../utils/config";
import {
  compareSyncPathSnapshots,
  mirrorSyncPath,
  snapshotSyncPath,
} from "../utils/agents";
import { InternalCommandError, invalidInputError } from "./errors";
import type { InternalDeps } from "./commands";

const ALL_SYNC_PATHS = AGENT_DEFS.flatMap((def) => def.syncPaths);
// CANONICAL_DIR rides in the commit scope so the unify flow's regeneration
// travels with the same primitives; bare sync itself never reads or writes
// canonical content, it only commits whatever already sits in the clone.
const COMMIT_SCOPE = [...ALL_SYNC_PATHS, SYNC_MANIFEST_FILE, CANONICAL_DIR];

const TRANSPORT_STATE_FILE = ".git-agents-transport.json";
// What the home directory held after this machine's last completed sync.
// Deletion detection needs exactly this per-machine memory: the home dir
// is not git-tracked, so the clone's history cannot answer "did this
// machine ever have that file", and without it a fresh machine's empty
// home would read as a mass deletion.
const LAST_SYNC_FILE = ".git-agents-last-sync.json";
const MAX_CAPTURE_BYTES = 10 * 1024 * 1024;
const NUL = String.fromCharCode(0);

type GitResult = {
  ok: boolean;
  output: string;
  error?: string;
  exitCode?: number;
  oversized?: boolean;
};

// Own runner instead of shell.runCommand: conflict contents must not be
// tail-truncated, and error sniffing needs untranslated git messages.
function git(dir: string, ...args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("git", ["-C", dir, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: { ...process.env, LC_ALL: "C", LANG: "C" },
      });
    } catch (error) {
      resolve({
        ok: false,
        output: "",
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let oversized = false;
    const stderr: Buffer[] = [];
    let stderrBytes = 0;

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= MAX_CAPTURE_BYTES) stdout.push(chunk);
      else oversized = true;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= 64 * 1024) stderr.push(chunk);
    });
    child.on("error", (error) => {
      resolve({ ok: false, output: "", error: error.message });
    });
    child.on("close", (exitCode) => {
      const output = Buffer.concat(stdout).toString("utf8");
      const errText = Buffer.concat(stderr).toString("utf8").trim();
      resolve({
        ok: exitCode === 0,
        output,
        error:
          exitCode === 0
            ? undefined
            : errText || `git exited with code ${exitCode ?? "unknown (terminated)"}`,
        exitCode: exitCode ?? undefined,
        oversized: oversized || undefined,
      });
    });
  });
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

type TransportState = { version: 1; preHead: string | null };

function statePath(configDir: string): string {
  return join(configDir, TRANSPORT_STATE_FILE);
}

function readTransportState(configDir: string): TransportState | null {
  const path = statePath(configDir);
  if (!existsSync(path)) return null;
  try {
    const state = JSON.parse(readFileSync(path, "utf8"));
    if (state?.version !== 1) return null;
    return {
      version: 1,
      preHead: typeof state.preHead === "string" ? state.preHead : null,
    };
  } catch {
    return null;
  }
}

function clearTransportState(configDir: string): void {
  rmSync(statePath(configDir), { force: true });
}

function readLastSyncedPaths(configDir: string): Set<string> {
  const path = join(configDir, LAST_SYNC_FILE);
  if (!existsSync(path)) return new Set();
  try {
    const state = JSON.parse(readFileSync(path, "utf8"));
    if (state?.version !== 1 || !Array.isArray(state.paths)) return new Set();
    return new Set(state.paths.filter((p: unknown) => typeof p === "string"));
  } catch {
    return new Set();
  }
}

function writeLastSyncedPaths(deps: InternalDeps): void {
  const paths = ALL_SYNC_PATHS.filter(
    (syncPath) =>
      snapshotSyncPath(getLocalSyncPath(syncPath, deps.homeDir)) !== null,
  );
  writeFileSync(
    join(deps.configDir, LAST_SYNC_FILE),
    `${JSON.stringify({ version: 1, paths }, null, 2)}\n`,
    "utf8",
  );
}

async function conflictedEntries(
  configDir: string,
): Promise<Map<string, Set<number>>> {
  const result = await git(configDir, "ls-files", "-u", "-z");
  if (!result.ok) {
    throw new InternalCommandError(
      "transport-failed",
      `Could not list conflicted files: ${result.error ?? "unknown error"}`,
    );
  }
  const entries = new Map<string, Set<number>>();
  for (const entry of result.output.split(NUL)) {
    const tab = entry.indexOf("\t");
    if (tab === -1) continue;
    const path = entry.slice(tab + 1);
    const stage = Number(entry.slice(0, tab).split(" ")[2]);
    if (!path || !stage) continue;
    if (!entries.has(path)) entries.set(path, new Set());
    entries.get(path)!.add(stage);
  }
  return entries;
}

async function conflictedPaths(configDir: string): Promise<string[]> {
  return [...(await conflictedEntries(configDir)).keys()].sort();
}

type StageRead = { content: string | null; opaque: boolean };

async function stageContent(
  configDir: string,
  stage: 1 | 2 | 3,
  path: string,
  presentStages: Set<number>,
): Promise<StageRead> {
  if (!presentStages.has(stage)) return { content: null, opaque: false };
  const result = await git(configDir, "show", `:${stage}:${path}`);
  if (!result.ok) {
    throw new InternalCommandError(
      "transport-failed",
      `Could not read stage ${stage} of ${path}: ${result.error ?? "unknown error"}`,
    );
  }
  if (result.oversized || result.output.includes(NUL)) {
    return { content: null, opaque: true };
  }
  return { content: result.output, opaque: false };
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
  // A missing source counts as a deletion only when this machine's home
  // actually held the path after its last sync; otherwise the other side
  // simply has content this machine never had.
  const lastSynced = readLastSyncedPaths(deps.configDir);
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
      !(destination !== null && lastSynced.has(syncPath))
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
    if (!inWorktree && !(tracked.ok && tracked.output.trim())) continue;
    const added = await git(configDir, "add", "-A", "--", scopePath);
    if (!added.ok) {
      throw new InternalCommandError(
        "transport-failed",
        `Could not stage ${scopePath}: ${added.error ?? "unknown error"}`,
      );
    }
  }
}

// Three-dot: only what the remote side changed since the merge base, so
// this machine's own outgoing commits never masquerade as incoming.
async function mergedPaths(configDir: string): Promise<string[]> {
  const result = await git(
    configDir,
    "diff",
    "--name-only",
    "-z",
    "HEAD...MERGE_HEAD",
  );
  if (!result.ok) return [];
  return result.output.split(NUL).filter(Boolean).sort();
}

export type TransportBeginResult =
  | { state: "clean"; outgoing: PathChange[]; incoming: PathChange[] }
  | {
      state: "conflicts";
      outgoing: PathChange[];
      incoming: string[];
      conflicts: ConflictFile[];
    };

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

  // An existing marker means an earlier run never completed (push failure,
  // crash, or decline path): keep its pre-sync point so abort can always
  // reach the state the user last confirmed.
  if (readTransportState(deps.configDir) === null) {
    const head = await git(
      deps.configDir,
      "rev-parse",
      "--verify",
      "HEAD^{commit}",
    );
    const state: TransportState = {
      version: 1,
      preHead: head.ok ? head.output.trim() : null,
    };
    writeFileSync(
      statePath(deps.configDir),
      `${JSON.stringify(state, null, 2)}\n`,
      "utf8",
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
      const conflicted = await conflictedEntries(deps.configDir);
      if (conflicted.size === 0) {
        if (error.includes("refusing to merge unrelated histories")) {
          throw new InternalCommandError(
            "unrelated-histories",
            "The remote history was rewritten and no longer shares a base with the local clone. " +
              "Run transport-abort to restore the pre-sync state, then re-clone with setup force:true, " +
              "then run the sync again. Local harness files are not affected.",
          );
        }
        throw new InternalCommandError(
          "transport-failed",
          `Could not merge from origin: ${error || "unknown error"}. ` +
            "The clone is mid-transport; run transport-abort to restore the pre-sync state.",
        );
      }
      const conflicts: ConflictFile[] = [];
      for (const [path, stages] of [...conflicted.entries()].sort()) {
        const [base, local, remote] = await Promise.all([
          stageContent(deps.configDir, 1, path, stages),
          stageContent(deps.configDir, 2, path, stages),
          stageContent(deps.configDir, 3, path, stages),
        ]);
        const binary = base.opaque || local.opaque || remote.opaque;
        conflicts.push({
          path,
          binary,
          base: binary ? null : base.content,
          local: binary ? null : local.content,
          remote: binary ? null : remote.content,
        });
      }
      return {
        state: "conflicts",
        outgoing,
        incoming: await mergedPaths(deps.configDir),
        conflicts,
      };
    }
  }

  return {
    state: "clean",
    outgoing,
    incoming: diffAgainstClone(deps, "incoming"),
  };
}

const ResolveFileSchema = z
  .object({
    path: z.string().min(1),
    content: z.string().optional(),
    side: z.enum(["local", "remote"]).optional(),
  })
  .refine((file) => (file.content !== undefined) !== (file.side !== undefined), {
    message: "provide exactly one of content or side",
  });

const ResolveInputSchema = z.object({
  files: z.array(ResolveFileSchema).min(1),
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
    if (file.side !== undefined) {
      const checkedOut = await git(
        deps.configDir,
        "checkout",
        file.side === "local" ? "--ours" : "--theirs",
        "--",
        file.path,
      );
      if (!checkedOut.ok) {
        throw new InternalCommandError(
          "transport-failed",
          `Could not pick the ${file.side} side of ${file.path}: ${checkedOut.error ?? "unknown error"}`,
        );
      }
    } else {
      const target = getRemoteSyncPath(file.path, deps.configDir);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.content!, "utf8");
    }
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
  // True only when the caller asked for deferPush: distinguishes a
  // deliberately skipped push from one that never happened.
  pushDeferred: boolean;
};

export async function runTransportCommit(
  deps: InternalDeps,
  rawInput: unknown,
): Promise<TransportCommitResult> {
  requireClone(deps);
  const parsed = CommitInputSchema.safeParse(rawInput);
  if (!parsed.success) throw invalidInputError("transport-commit", parsed.error);
  const deferPush = parsed.data?.deferPush === true;

  if (readTransportState(deps.configDir) === null) {
    throw new InternalCommandError(
      "no-transport",
      "No transport is in progress. Run transport-begin first.",
    );
  }

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

  // Push before touching the home directory: a rejected push must leave
  // local files exactly as they were.
  let pushed = false;
  if (!deferPush) {
    const pushResult = await git(deps.configDir, "push", "-u", "origin", "HEAD");
    if (!pushResult.ok) {
      const error = pushResult.error ?? "";
      const rejected =
        error.includes("[rejected]") ||
        error.includes("non-fast-forward") ||
        error.includes("fetch first");
      if (rejected) {
        throw new InternalCommandError(
          "push-rejected",
          "Origin advanced since transport-begin. Run transport-begin again to merge the new changes, then transport-commit.",
        );
      }
      throw new InternalCommandError(
        "push-failed",
        `Could not push to origin: ${error || "unknown error"}. The merge is committed locally; re-running transport-commit retries the push.`,
      );
    }
    pushed = true;
  }

  const mirroredBack = mirrorChanged(deps, "incoming");

  writeLastSyncedPaths(deps);
  clearTransportState(deps.configDir);
  return { mergeCompleted, mirroredBack, pushed, pushDeferred: deferPush };
}

export type TransportAbortResult = { aborted: boolean; message: string };

export async function runTransportAbort(
  deps: InternalDeps,
): Promise<TransportAbortResult> {
  requireClone(deps);
  const state = readTransportState(deps.configDir);
  const merging = mergeInProgress(deps.configDir);

  if (!merging && state === null) {
    return { aborted: false, message: "No transport is in progress." };
  }

  if (merging) {
    const aborted = await git(deps.configDir, "merge", "--abort");
    if (!aborted.ok) {
      throw new InternalCommandError(
        "transport-failed",
        `Could not abort the merge: ${aborted.error ?? "unknown error"}`,
      );
    }
  }

  if (state !== null) {
    if (state.preHead !== null) {
      const reset = await git(deps.configDir, "reset", "--hard", state.preHead);
      if (!reset.ok) {
        throw new InternalCommandError(
          "transport-failed",
          `Could not restore the pre-sync state: ${reset.error ?? "unknown error"}`,
        );
      }
    } else {
      // Unborn pre-sync state: drop the branch ref if one was created
      // (tolerated when none exists) and unstage everything.
      await git(deps.configDir, "update-ref", "-d", "HEAD");
      const unstaged = await git(deps.configDir, "reset");
      if (!unstaged.ok) {
        throw new InternalCommandError(
          "transport-failed",
          `Could not restore the pre-sync state: ${unstaged.error ?? "unknown error"}`,
        );
      }
    }
    clearTransportState(deps.configDir);
  }

  return { aborted: true, message: "Transport aborted; pre-sync state restored." };
}
