import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { CANONICAL_DIR } from "../canonical/canonical";
import { SYNC_MANIFEST_FILE } from "../utils/manifest";
import {
  HARNESS_DECLARATIONS_FILE,
  type DeclarationProblem,
} from "../utils/harnessDeclarations";
import {
  BUILT_IN_HARNESSES,
  harnessPaths,
  invalidHarnessDeclarationsError,
  readHarnessSet,
  requireHarnessSet,
} from "../utils/harnessSet";
import { declaredPaths, pathsOnlyIn, uniquePaths } from "../utils/declaredPaths";
import { getLocalSyncPath, getRemoteSyncPath } from "../utils/config";
import {
  compareSyncPathSnapshots,
  mirrorSyncPath,
  snapshotSyncPath,
} from "../utils/agents";
import { InternalCommandError, invalidInputError } from "./errors";
import { NUL, git } from "./git";
import {
  LAST_SYNC_FILE,
  forgetLastSyncedPaths,
  readLastSyncedPaths,
  writeLastSyncedPaths,
} from "./lastSync";
import {
  changedPathSize,
  commitPendingDeclarations,
  firstSyncListing,
  invalidDeclarationsConflict,
  invalidMergedDeclarationsError,
  lookAtDeclarations,
  mergedDeclarationProblems,
  remoteDeclarationChanges,
  removedListing,
  resolveDeclarations,
  restoreDeclarations,
  sizeAt,
  type FirstSyncPath,
  type RemovedDeclarations,
} from "./transportDeclarations";
import type { InternalDeps } from "./commands";

// CANONICAL_DIR rides in the commit scope so the unify flow's regeneration
// travels with the same primitives; bare sync itself never reads or writes
// canonical content, it only commits whatever already sits in the clone.
// The declarations file rides in it so a declaration reaches every machine.
function commitScope(syncPaths: string[]): string[] {
  return [
    ...syncPaths,
    SYNC_MANIFEST_FILE,
    CANONICAL_DIR,
    HARNESS_DECLARATIONS_FILE,
  ];
}

const TRANSPORT_STATE_FILE = ".git-agents-transport.json";
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

type TransportState = {
  version: 1;
  preHead: string | null;
  // A commit of the declarations file made after the pre-sync point, because
  // an earlier run had already recorded that point. Abort restores the file
  // from it, so the declaration is kept all the same.
  declarations?: string;
};

function writeTransportState(configDir: string, state: TransportState): void {
  writeFileSync(
    statePath(configDir),
    `${JSON.stringify(state, null, 2)}\n`,
    "utf8",
  );
}

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
      ...(typeof state.declarations === "string"
        ? { declarations: state.declarations }
        : {}),
    };
  } catch {
    return null;
  }
}

function clearTransportState(configDir: string): void {
  rmSync(statePath(configDir), { force: true });
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
  // Only on the declarations file when git merged it without a conflict and
  // the result is invalid: what makes it invalid, and the merged text to fix.
  problems?: DeclarationProblem[];
  merged?: string | null;
};

type PathChange = { path: string; status: string };

function diffAgainstClone(
  deps: InternalDeps,
  direction: "outgoing" | "incoming",
  syncPaths: string[],
): PathChange[] {
  // A missing source counts as a deletion only when this machine's home
  // actually held the path after its last sync; otherwise the other side
  // simply has content this machine never had.
  const lastSynced = readLastSyncedPaths(deps.configDir);
  const changes: PathChange[] = [];
  for (const syncPath of syncPaths) {
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
  syncPaths: string[],
): PathChange[] {
  const changes = diffAgainstClone(deps, direction, syncPaths);
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

async function stageScope(
  configDir: string,
  syncPaths: string[],
): Promise<void> {
  for (const scopePath of commitScope(syncPaths)) {
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

const MID_TRANSPORT =
  "The clone is mid-transport; run transport-abort to restore the pre-sync state.";

// Fetches, then names the commit the merge will bring: the upstream of the
// current branch. Null when the remote does not have that branch yet.
async function fetchRemoteTip(configDir: string): Promise<string | null> {
  const fetched = await git(configDir, "fetch");
  if (!fetched.ok) {
    throw new InternalCommandError(
      "transport-failed",
      `Could not fetch from origin: ${fetched.error ?? "unknown error"}. ${MID_TRANSPORT}`,
    );
  }
  const tip = await git(
    configDir,
    "rev-parse",
    "--verify",
    "--quiet",
    "@{upstream}^{commit}",
  );
  if (tip.ok) return tip.output.trim();

  // No such commit: either the remote is still empty, or the branch tracks
  // nothing, which is a failure as it was for the pull this replaces.
  const branch = await git(configDir, "symbolic-ref", "-q", "--short", "HEAD");
  const tracking = branch.ok
    ? await git(configDir, "config", "--get", `branch.${branch.output.trim()}.merge`)
    : branch;
  if (tracking.ok) return null;
  throw new InternalCommandError(
    "transport-failed",
    `Could not merge from origin: the current branch tracks no remote branch. ${MID_TRANSPORT}`,
  );
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

// Every file of the merge in progress that needs a resolution: the ones git
// could not merge, and the declarations file when it merged into something
// invalid.
async function conflictFiles(configDir: string): Promise<ConflictFile[]> {
  const conflicted = await conflictedEntries(configDir);
  const conflicts: ConflictFile[] = [];
  for (const [path, stages] of conflicted) {
    const [base, local, remote] = await Promise.all([
      stageContent(configDir, 1, path, stages),
      stageContent(configDir, 2, path, stages),
      stageContent(configDir, 3, path, stages),
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
  const problems = mergedDeclarationProblems(configDir, conflicted);
  if (problems !== null) {
    conflicts.push(await invalidDeclarationsConflict(configDir, problems));
  }
  return conflicts.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// A merge git completed although its declarations file is invalid is taken
// back and left open, so the fix goes through transport-resolve like any
// conflict and transport-commit completes the merge once it is in.
async function reopenMerge(configDir: string, localHead: string): Promise<void> {
  const reset = await git(configDir, "reset", "--hard", localHead);
  const reopened = reset.ok
    ? await git(configDir, "merge", "--no-ff", "--no-commit", "@{upstream}")
    : reset;
  if (!reopened.ok || !mergeInProgress(configDir)) {
    throw new InternalCommandError(
      "transport-failed",
      `Could not reopen the merge to fix ${HARNESS_DECLARATIONS_FILE}: ` +
        `${reopened.error ?? "unknown error"}. ${MID_TRANSPORT}`,
    );
  }
}

// firstSync is the gate listing for newly declared paths. It adds to the
// outgoing and incoming lists, which still carry those paths, so a caller
// that does not know the field loses nothing but the counts.
// removed names what another machine removed, and is present only then. Those
// paths are in neither list: nothing is synced there any more, and the files
// in the home directory stay.
export type TransportBeginResult =
  | {
      state: "clean";
      outgoing: PathChange[];
      incoming: PathChange[];
      firstSync: FirstSyncPath[];
      removed?: RemovedDeclarations;
    }
  | {
      state: "conflicts";
      outgoing: PathChange[];
      incoming: string[];
      conflicts: ConflictFile[];
      firstSync: FirstSyncPath[];
      removed?: RemovedDeclarations;
    };

function removedField(removed: RemovedDeclarations | undefined): {
  removed?: RemovedDeclarations;
} {
  return removed === undefined ? {} : { removed };
}

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

  // Before anything is written: an invalid declarations file stops the sync
  // for every harness, with the clone and the home directory untouched.
  const local = requireHarnessSet(deps.configDir);

  // Ahead of the pre-sync point, so declining the sync keeps the declaration.
  const declarationsCommit = await commitPendingDeclarations(deps.configDir);

  // An existing marker means an earlier run never completed (push failure,
  // crash, or decline path): keep its pre-sync point so abort can always
  // reach the state the user last confirmed.
  const unfinished = readTransportState(deps.configDir);
  if (unfinished === null) {
    const head = await git(
      deps.configDir,
      "rev-parse",
      "--verify",
      "HEAD^{commit}",
    );
    writeTransportState(deps.configDir, {
      version: 1,
      preHead: head.ok ? head.output.trim() : null,
    });
  } else if (declarationsCommit !== null) {
    // The declaration could not go ahead of a point recorded earlier.
    writeTransportState(deps.configDir, {
      ...unfinished,
      declarations: declarationsCommit,
    });
  }

  // Look before mirroring: a path the remote newly declares is mirrored in
  // this run, not the next one.
  const remoteTip = await fetchRemoteTip(deps.configDir);
  const look = await lookAtDeclarations(deps.configDir, remoteTip);
  const changes = remoteDeclarationChanges(look);
  // And a path the remote removed is not mirrored at all: its files stay in
  // the home directory, unsynced, and never meet the remote's deletion.
  const unmanaged = new Set(
    changes.removed.map(({ path }) => path.toLowerCase()),
  );
  const syncPaths = uniquePaths([...declaredPaths(local), ...changes.declared])
    .map(({ path }) => path)
    .filter((path) => !unmanaged.has(path.toLowerCase()));
  // Their repo copies are about to go. Should the merge keep one of them
  // declared after all, that must not read as a deletion to carry home.
  forgetLastSyncedPaths(
    deps.configDir,
    changes.removed.map(({ path }) => path),
  );

  // What this machine has synced before, for the gate listing: on a machine
  // that never completed a sync, every custom path is a first sync.
  const known = existsSync(join(deps.configDir, LAST_SYNC_FILE))
    ? look.base
    : [...BUILT_IN_HARNESSES];

  const outgoing = mirrorChanged(deps, "outgoing", syncPaths);
  const outgoingSize = changedPathSize(outgoing, (path) =>
    getLocalSyncPath(path, deps.homeDir),
  );

  await stageScope(deps.configDir, syncPaths);
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

  // The conflicts state: a merge is in progress, and it needs resolutions
  // before transport-commit can complete it.
  const reportConflicts = async (): Promise<TransportBeginResult> => {
    const conflicts = await conflictFiles(deps.configDir);
    // No merged declarations file to go by yet: the listing takes what either
    // side newly declares, and sizes the incoming side as the remote holds it.
    const incoming = await mergedPaths(deps.configDir);
    const declared = uniquePaths([
      ...pathsOnlyIn(local, known),
      ...(look.remote === null ? [] : pathsOnlyIn(look.remote, known)),
    ]);
    return {
      state: "conflicts",
      outgoing,
      incoming,
      conflicts,
      firstSync: await firstSyncListing(declared, outgoingSize, (path) =>
        incoming.some((file) => file === path || file.startsWith(`${path}/`))
          ? sizeAt(deps.configDir, "MERGE_HEAD", path)
          : null,
      ),
      ...removedField(removedListing(look, null, deps.homeDir)),
    };
  };

  const head = await git(deps.configDir, "rev-parse", "--verify", "HEAD^{commit}");
  const localHead = head.ok ? head.output.trim() : null;

  // The fetched tip, by the name that gives the merge commit a readable
  // message; nothing fetches in between, so it is the commit looked at above.
  const merged =
    remoteTip === null
      ? null
      : await git(deps.configDir, "merge", "--no-edit", "@{upstream}");
  if (merged !== null && !merged.ok) {
    const error = merged.error ?? "";
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
        `Could not merge from origin: ${error || "unknown error"}. ${MID_TRANSPORT}`,
      );
    }
    return reportConflicts();
  }

  // The merge may have brought a changed declarations file. From here the
  // merged set is authoritative: it decides what comes home, what the gate
  // lists, and what transport-commit will mirror and record.
  const mergedRead = readHarnessSet(deps.configDir);
  if (!mergedRead.ok) {
    // Git saw no conflict, so the merge is already complete. Without a commit
    // of this machine's to reopen it from, the plain refusal is all there is.
    if (localHead === null) {
      throw invalidHarnessDeclarationsError(mergedRead.problems, deps.configDir);
    }
    await reopenMerge(deps.configDir, localHead);
    return reportConflicts();
  }
  const mergedSet = mergedRead.harnesses;
  const incoming = diffAgainstClone(
    deps,
    "incoming",
    mergedSet.flatMap(harnessPaths),
  );
  return {
    state: "clean",
    outgoing,
    incoming,
    firstSync: await firstSyncListing(
      pathsOnlyIn(mergedSet, known),
      outgoingSize,
      changedPathSize(incoming, (path) =>
        getRemoteSyncPath(path, deps.configDir),
      ),
    ),
    ...removedField(removedListing(look, mergedSet, deps.homeDir)),
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
    if (file.path === HARNESS_DECLARATIONS_FILE) {
      await resolveDeclarations(deps.configDir, file, conflicted);
      resolved.push(file.path);
      continue;
    }
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

  const merging = mergeInProgress(deps.configDir);
  if (merging) {
    const remaining = await conflictedPaths(deps.configDir);
    if (remaining.length > 0) {
      throw new InternalCommandError(
        "unresolved-conflicts",
        `Conflicts remain unresolved: ${remaining.join(", ")}. Resolve them with transport-resolve first.`,
      );
    }
  }

  // After the conflict check, so a conflicted declarations file reads as a
  // conflict; before the merge commit and the push, so an invalid one
  // reaches neither the remote nor the home directory.
  const set = readHarnessSet(deps.configDir);
  if (!set.ok) {
    throw merging
      ? invalidMergedDeclarationsError(set.problems)
      : invalidHarnessDeclarationsError(set.problems, deps.configDir);
  }
  const syncPaths = set.harnesses.flatMap(harnessPaths);

  let mergeCompleted = false;
  if (merging) {
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

  const mirroredBack = mirrorChanged(deps, "incoming", syncPaths);

  writeLastSyncedPaths(deps, syncPaths);
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
      if (state.declarations !== undefined) {
        await restoreDeclarations(deps.configDir, state.declarations);
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
