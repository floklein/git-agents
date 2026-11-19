import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
import { byCodeUnit, isAtOrInside, pathKey } from "../utils/pathKey";
import { getLocalSyncPath, getRemoteSyncPath } from "../utils/config";
import {
  compareSyncPathSnapshots,
  mirrorSyncPath,
  removeExcludedEntries,
  snapshotSyncPath,
} from "../utils/agents";
import {
  EXCLUDES_FILE,
  excludesWithin,
  parseExcludes,
  readUserExcludes,
  unionOfExcludes,
  withBuiltInExcludes,
  type ExcludeMatcher,
} from "../utils/excludes";
import { InternalCommandError, invalidInputError } from "./errors";
import { NUL, git, isInWorktreeOrTracked, requireClone } from "./git";
import {
  applyResolution,
  autoResolveConflicts,
  conflictPaths,
  describeConflict,
  readConflicts,
  readUnmerged,
  resolutionProblem,
  type Conflict,
  type ConflictFile,
  type Resolution,
} from "./conflicts";
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
  mergedDeclarationProblems,
  readBaseAndRemoteSets,
  remoteDeclarationChanges,
  removedListing,
  fileAt,
  applyDeclarationsResolution,
  planDeclarationsResolution,
  type DeclarationsPlan,
  restoreDeclarations,
  sizeAt,
  type FirstSyncPath,
  type RemovedDeclarations,
} from "./transportDeclarations";
import type { InternalDeps } from "./commands";

// CANONICAL_DIR rides in the commit scope so the unify flow's regeneration
// travels with the same primitives; bare sync itself never reads or writes
// canonical content, it only commits whatever already sits in the clone.
// The declarations and excludes files ride in it so a declaration or an
// exclude reaches every machine.
function commitScope(syncPaths: string[]): string[] {
  return [
    ...syncPaths,
    SYNC_MANIFEST_FILE,
    CANONICAL_DIR,
    HARNESS_DECLARATIONS_FILE,
    EXCLUDES_FILE,
  ];
}

export type { ConflictFile } from "./conflicts";

const TRANSPORT_STATE_FILE = ".git-agents-transport.json";

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
  // The user exclude patterns begin applied: this machine's and the remote's.
  // Commit applies them too, beside the merged file's, so a pattern either
  // side drops in this run still holds until the next run has sent what it
  // used to hide; mirroring home can then never delete those files.
  excludes?: string[];
  // Begin completed the merge itself, because every conflict settled on its
  // own; commit reports it as the merge it completed.
  mergeCompletedByBegin?: boolean;
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
      ...(Array.isArray(state.excludes)
        ? {
            excludes: state.excludes.filter(
              (pattern: unknown): pattern is string => typeof pattern === "string",
            ),
          }
        : {}),
      ...(state.mergeCompletedByBegin === true
        ? { mergeCompletedByBegin: true }
        : {}),
    };
  } catch {
    return null;
  }
}

function clearTransportState(configDir: string): void {
  rmSync(statePath(configDir), { force: true });
}

type PathChange = { path: string; status: string };

// The sync paths mirroring works on: an excluded path is not synced at all.
function mirroredPaths(
  syncPaths: readonly string[],
  excludes: ExcludeMatcher,
): string[] {
  return syncPaths.filter((path) => !excludes(path));
}

function diffAgainstClone(
  deps: InternalDeps,
  direction: "outgoing" | "incoming",
  syncPaths: string[],
  excludes: ExcludeMatcher,
): PathChange[] {
  // A missing source counts as a deletion only when this machine's home
  // actually held the path after its last sync; otherwise the other side
  // simply has content this machine never had.
  const lastSynced = readLastSyncedPaths(deps.configDir);
  const changes: PathChange[] = [];
  for (const syncPath of mirroredPaths(syncPaths, excludes)) {
    const localPath = getLocalSyncPath(syncPath, deps.homeDir);
    const remotePath = getRemoteSyncPath(syncPath, deps.configDir);
    const exclude = excludesWithin(excludes, syncPath);
    const local = snapshotSyncPath(localPath, exclude);
    const remote = snapshotSyncPath(remotePath, exclude);
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

// Excluded entries never travel, and mirroring leaves them where they are
// on either side.
function mirrorChanged(
  deps: InternalDeps,
  direction: "outgoing" | "incoming",
  syncPaths: string[],
  excludes: ExcludeMatcher,
): PathChange[] {
  const changes = diffAgainstClone(deps, direction, syncPaths, excludes);
  for (const change of changes) {
    const localPath = getLocalSyncPath(change.path, deps.homeDir);
    const remotePath = getRemoteSyncPath(change.path, deps.configDir);
    const exclude = excludesWithin(excludes, change.path);
    if (direction === "outgoing") {
      mirrorSyncPath(localPath, remotePath, deps.homeDir, deps.configDir, undefined, exclude);
    } else {
      mirrorSyncPath(remotePath, localPath, deps.configDir, deps.homeDir, undefined, exclude);
    }
  }
  return changes;
}

// The migration for excludes: whatever the sync repo holds at an excluded
// path, committed by an earlier version or before the exclude was added,
// leaves the clone, and the commit of local state carries its deletion. The
// home directory is never touched. Returns the excluded paths that were
// committed, outermost only.
async function dropExcludedFromClone(
  configDir: string,
  syncPaths: readonly string[],
  excludes: ExcludeMatcher,
): Promise<string[]> {
  const removed: string[] = [];
  for (const syncPath of syncPaths) {
    const clonePath = getRemoteSyncPath(syncPath, configDir);
    if (excludes(syncPath)) {
      if (existsSync(clonePath)) {
        rmSync(clonePath, { recursive: true, force: true });
        removed.push(syncPath);
      }
      continue;
    }
    removed.push(
      ...removeExcludedEntries(clonePath, excludesWithin(excludes, syncPath)).map(
        (path) => `${syncPath}/${path}`,
      ),
    );
  }
  const committed: string[] = [];
  for (const path of removed) {
    const tracked = await git(configDir, "ls-files", "-z", "--", path);
    if (tracked.ok && tracked.output !== "") committed.push(path);
  }
  return committed;
}

async function stageScope(
  configDir: string,
  syncPaths: string[],
): Promise<void> {
  for (const scopePath of commitScope(syncPaths)) {
    if (!(await isInWorktreeOrTracked(configDir, scopePath))) continue;
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
// invalid. The caller settles the ones nobody needs to look at first.
async function conflictFiles(configDir: string): Promise<ConflictFile[]> {
  const unmerged = await readUnmerged(configDir);
  const conflicts: ConflictFile[] = [];
  for (const conflict of await readConflicts(configDir, unmerged)) {
    conflicts.push(await describeConflict(configDir, conflict));
  }
  const problems = mergedDeclarationProblems(configDir, unmerged);
  if (problems !== null) {
    conflicts.push(await invalidDeclarationsConflict(configDir, problems));
  }
  return conflicts.sort((a, b) => byCodeUnit(a.path, b.path));
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
// excluded names the excluded paths this run drops from the sync repo, and is
// present only then. The files stay in every home directory. autoResolved
// names the conflicts settled without anyone looking (deleted on both sides,
// or excluded), and is present only then.
export type TransportBeginResult =
  | {
      state: "clean";
      outgoing: PathChange[];
      incoming: PathChange[];
      firstSync: FirstSyncPath[];
      removed?: RemovedDeclarations;
      excluded?: string[];
      autoResolved?: string[];
    }
  | {
      state: "conflicts";
      outgoing: PathChange[];
      incoming: string[];
      conflicts: ConflictFile[];
      firstSync: FirstSyncPath[];
      removed?: RemovedDeclarations;
      excluded?: string[];
      autoResolved?: string[];
    };

// The optional `excluded` field of a begin result, present only when this
// run drops something from the sync repo.
function excludedIfAny(excluded: string[]): { excluded?: string[] } {
  return excluded.length === 0 ? {} : { excluded };
}

function autoResolvedIfAny(paths: readonly string[]): { autoResolved?: string[] } {
  return paths.length === 0 ? {} : { autoResolved: [...paths].sort(byCodeUnit) };
}

// The optional `removed` field of a begin result, present only when there
// is something to name.
function removedIfAny(removed: RemovedDeclarations | undefined): {
  removed?: RemovedDeclarations;
} {
  return removed === undefined ? {} : { removed };
}

export async function runTransportBegin(
  deps: InternalDeps,
): Promise<TransportBeginResult> {
  requireClone(deps.configDir);
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
  // Either side's excludes hold for this run: one the remote just added
  // keeps this machine from sending what it hides and settles the conflicts
  // its removal causes, and one it just dropped hides nothing from this
  // machine before its own files have gone out.
  const excludePatterns = unionOfExcludes(
    readUserExcludes(deps.configDir),
    remoteTip === null
      ? []
      : parseExcludes((await fileAt(deps.configDir, remoteTip, EXCLUDES_FILE)) ?? ""),
  );
  writeTransportState(deps.configDir, {
    ...readTransportState(deps.configDir)!,
    excludes: excludePatterns,
    mergeCompletedByBegin: false,
  });
  const excludes = withBuiltInExcludes(excludePatterns);
  const baseAndRemote = await readBaseAndRemoteSets(deps.configDir, remoteTip);
  const changes = remoteDeclarationChanges(baseAndRemote);
  // And a path the remote removed is not mirrored at all: its files stay in
  // the home directory, unsynced, and never meet the remote's deletion.
  const unmanaged = new Set(changes.removed.map(({ path }) => pathKey(path)));
  const syncPaths = uniquePaths([...declaredPaths(local), ...changes.declared])
    .map(({ path }) => path)
    .filter((path) => !unmanaged.has(pathKey(path)));
  // Their repo copies are about to go. Should the merge keep one of them
  // declared after all, that must not read as a deletion to carry home.
  forgetLastSyncedPaths(
    deps.configDir,
    changes.removed.map(({ path }) => path),
  );

  // The harness set this machine has synced before, for the gate listing: on
  // a machine that never completed a sync, every custom path is a first sync.
  const syncedBefore = existsSync(join(deps.configDir, LAST_SYNC_FILE))
    ? baseAndRemote.base
    : [...BUILT_IN_HARNESSES];

  const excluded = await dropExcludedFromClone(deps.configDir, syncPaths, excludes);
  const outgoing = mirrorChanged(deps, "outgoing", syncPaths, excludes);
  const outgoingSize = changedPathSize(
    outgoing,
    (path) => getLocalSyncPath(path, deps.homeDir),
    excludes,
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
  const autoResolved: string[] = [];
  const reportConflicts = async (): Promise<TransportBeginResult> => {
    autoResolved.push(...(await autoResolveConflicts(deps.configDir, excludes)));
    const conflicts = await conflictFiles(deps.configDir);
    // No merged declarations file to go by yet: the listing takes what either
    // side newly declares, and sizes the incoming side as the remote holds it.
    const incoming = (await mergedPaths(deps.configDir)).filter(
      (path) => !excludes(path),
    );
    const declared = uniquePaths([
      ...pathsOnlyIn(local, syncedBefore),
      ...(baseAndRemote.remote === null
        ? []
        : pathsOnlyIn(baseAndRemote.remote, syncedBefore)),
    ]);
    return {
      state: "conflicts",
      outgoing,
      incoming,
      conflicts,
      firstSync: await firstSyncListing(declared, outgoingSize, (path) => {
        // The remote may spell the path in another case: git reads its tree
        // under the remote's spelling.
        const file = incoming.find((file) => isAtOrInside(file, path));
        return file === undefined
          ? null
          : sizeAt(deps.configDir, "MERGE_HEAD", file.slice(0, path.length), excludes);
      }),
      ...removedIfAny(removedListing(baseAndRemote, null, deps.homeDir, excludes)),
      ...excludedIfAny(excluded),
      ...autoResolvedIfAny(autoResolved),
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
    const conflicted = await readUnmerged(deps.configDir);
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
    // Conflicts nobody needs to see may be all there is: the merge then
    // completes as if git had seen none.
    autoResolved.push(...(await autoResolveConflicts(deps.configDir, excludes)));
    if ((await readUnmerged(deps.configDir)).size > 0) return reportConflicts();
    const completed = await git(deps.configDir, "commit", "--no-edit");
    if (!completed.ok) {
      throw new InternalCommandError(
        "transport-failed",
        `Could not complete the merge: ${completed.error ?? "unknown error"}. ${MID_TRANSPORT}`,
      );
    }
    writeTransportState(deps.configDir, {
      ...readTransportState(deps.configDir)!,
      mergeCompletedByBegin: true,
    });
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
    excludes,
  );
  return {
    state: "clean",
    outgoing,
    incoming,
    firstSync: await firstSyncListing(
      pathsOnlyIn(mergedSet, syncedBefore),
      outgoingSize,
      changedPathSize(
        incoming,
        (path) => getRemoteSyncPath(path, deps.configDir),
        excludes,
      ),
    ),
    ...removedIfAny(removedListing(baseAndRemote, mergedSet, deps.homeDir, excludes)),
    ...excludedIfAny(excluded),
    ...autoResolvedIfAny(autoResolved),
  };
}

const ResolveFileSchema = z
  .object({
    path: z.string().min(1),
    content: z.string().optional(),
    side: z.enum(["local", "remote"]).optional(),
    delete: z.boolean().optional(),
  })
  .refine(
    (file) =>
      [file.content !== undefined, file.side !== undefined, file.delete === true]
        .filter(Boolean).length === 1,
    { message: "provide exactly one of content, side, or delete: true" },
  );

const ResolveInputSchema = z.object({
  files: z.array(ResolveFileSchema).min(1),
});

type ResolveFile = z.infer<typeof ResolveFileSchema>;

export type TransportResolveResult = {
  resolved: string[];
  remaining: string[];
};

function resolutionOf(file: ResolveFile): Resolution {
  if (file.delete === true) return { delete: true };
  if (file.side !== undefined) return { side: file.side };
  return { content: file.content! };
}

type PlannedResolution =
  | { kind: "declarations"; plan: DeclarationsPlan }
  | { kind: "conflict"; conflict: Conflict; resolution: Resolution };

// The conflict a submitted path settles. A file/directory conflict answers to
// the name git parked its file side under too.
function conflictFor(conflicts: readonly Conflict[], path: string): Conflict {
  const conflict = conflicts.find(
    (candidate) =>
      candidate.path === path ||
      (candidate.kind === "file-directory" && candidate.parked === path),
  );
  if (conflict !== undefined) return conflict;
  const enclosing = conflicts.find(
    (candidate) =>
      candidate.kind === "file-directory" &&
      path.startsWith(`${candidate.path}/`),
  );
  throw new InternalCommandError(
    "not-conflicted",
    enclosing === undefined
      ? `${path} is not a conflicted file in this merge.`
      : `${path} is inside the file/directory conflict on ${enclosing.path}; resolve ${enclosing.path} instead.`,
  );
}

// Every resolution of the batch is checked before any is applied, so an entry
// that names no conflict, repeats one, or cannot settle its conflict refuses
// the batch and leaves the merge as it was. A git failure while applying is
// not undone: the error names what was already resolved.
export async function runTransportResolve(
  deps: InternalDeps,
  rawInput: unknown,
): Promise<TransportResolveResult> {
  requireClone(deps.configDir);
  if (!mergeInProgress(deps.configDir)) {
    throw new InternalCommandError(
      "no-transport",
      "No transport merge is in progress. Run transport-begin first.",
    );
  }
  const parsed = ResolveInputSchema.safeParse(rawInput);
  if (!parsed.success) throw invalidInputError("transport-resolve", parsed.error);

  const unmerged = await readUnmerged(deps.configDir);
  const conflicts = await readConflicts(deps.configDir, unmerged);
  const planned: PlannedResolution[] = [];
  const seen = new Set<string>();
  for (const file of parsed.data.files) {
    let entry: PlannedResolution;
    if (file.path === HARNESS_DECLARATIONS_FILE) {
      entry = {
        kind: "declarations",
        plan: await planDeclarationsResolution(deps.configDir, file, unmerged),
      };
    } else {
      const conflict = conflictFor(conflicts, file.path);
      const resolution = resolutionOf(file);
      const problem = resolutionProblem(conflict, resolution);
      if (problem !== null) {
        throw new InternalCommandError(
          "invalid-resolution",
          `${problem} Nothing was resolved.`,
        );
      }
      entry = { kind: "conflict", conflict, resolution };
    }
    const path = entry.kind === "declarations" ? file.path : entry.conflict.path;
    if (seen.has(path)) {
      throw new InternalCommandError(
        "invalid-input",
        `${path} appears more than once in transport-resolve input. Nothing was resolved.`,
      );
    }
    seen.add(path);
    planned.push(entry);
  }

  const resolved: string[] = [];
  for (const entry of planned) {
    try {
      if (entry.kind === "declarations") {
        await applyDeclarationsResolution(deps.configDir, entry.plan);
      } else {
        await applyResolution(deps.configDir, entry.conflict, entry.resolution);
      }
    } catch (error) {
      if (!(error instanceof InternalCommandError) || resolved.length === 0) {
        throw error;
      }
      throw new InternalCommandError(
        error.code,
        `${error.message}. Already resolved in this batch: ${resolved.join(", ")}; ` +
          "the entries after the failing one were not applied. Resubmit the unresolved ones.",
      );
    }
    resolved.push(
      entry.kind === "declarations" ? HARNESS_DECLARATIONS_FILE : entry.conflict.path,
    );
  }

  return {
    resolved,
    remaining: await conflictPaths(deps.configDir),
  };
}

const CommitInputSchema = z
  .object({ deferPush: z.boolean().optional() })
  .optional();

export type TransportCommitResult = {
  // A merge commit was made in this transport: by commit, or by begin when
  // every conflict settled on its own.
  mergeCompleted: boolean;
  // Excluded paths the merge brought into the repo, dropped again.
  excluded?: string[];
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
  requireClone(deps.configDir);
  const parsed = CommitInputSchema.safeParse(rawInput);
  if (!parsed.success) throw invalidInputError("transport-commit", parsed.error);
  const deferPush = parsed.data?.deferPush === true;

  const state = readTransportState(deps.configDir);
  if (state === null) {
    throw new InternalCommandError(
      "no-transport",
      "No transport is in progress. Run transport-begin first.",
    );
  }

  const merging = mergeInProgress(deps.configDir);
  if (merging) {
    const remaining = await conflictPaths(deps.configDir);
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

  // Begin's patterns and the merged file's: an exclude another machine added
  // holds from here on, and one it dropped still holds in this run (see
  // TransportState.excludes).
  const excludes = withBuiltInExcludes(
    unionOfExcludes(state.excludes ?? [], readUserExcludes(deps.configDir)),
  );

  // The merge may have brought excluded paths from a machine that still
  // commits them: they leave the repo with the merge commit, or a commit of
  // their own.
  const excluded = await dropExcludedFromClone(deps.configDir, syncPaths, excludes);
  if (excluded.length > 0) {
    const unstaged = await git(
      deps.configDir,
      "rm",
      "-r",
      "-q",
      "--cached",
      "--ignore-unmatch",
      "--",
      ...excluded,
    );
    if (!unstaged.ok) {
      throw new InternalCommandError(
        "transport-failed",
        `Could not drop excluded paths: ${unstaged.error ?? "unknown error"}`,
      );
    }
    if (!merging) {
      const committed = await git(
        deps.configDir,
        "commit",
        "-m",
        "sync: drop excluded paths",
      );
      if (!committed.ok) {
        throw new InternalCommandError(
          "transport-failed",
          `Could not commit the excluded paths' removal: ${committed.error ?? "unknown error"}`,
        );
      }
    }
  }

  let mergeCompleted = state.mergeCompletedByBegin === true;
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

  const mirroredBack = mirrorChanged(deps, "incoming", syncPaths, excludes);

  writeLastSyncedPaths(deps, mirroredPaths(syncPaths, excludes), excludes);
  clearTransportState(deps.configDir);
  return {
    mergeCompleted,
    mirroredBack,
    pushed,
    pushDeferred: deferPush,
    ...excludedIfAny(excluded),
  };
}

export type TransportAbortResult = { aborted: boolean; message: string };

export async function runTransportAbort(
  deps: InternalDeps,
): Promise<TransportAbortResult> {
  requireClone(deps.configDir);
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
