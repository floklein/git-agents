import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getRemoteSyncPath } from "../utils/config";
import type { DeclarationProblem } from "../utils/harnessDeclarations";
import type { ExcludeMatcher } from "../utils/excludes";
import { byCodeUnit } from "../utils/pathKey";
import { InternalCommandError } from "./errors";
import { NUL, git } from "./git";

// The conflicts of a merge in progress, as the transport presents them: one
// entry per path to settle, whichever side deleted it, with git's file/
// directory conflicts folded into one entry on the path they are about.

export type Side = "local" | "remote";

/** Index stage 2 is this machine's side of the merge, stage 3 the remote's. */
const STAGE_OF: Record<Side, 2 | 3> = { local: 2, remote: 3 };
const CHECKOUT_FLAG: Record<Side, string> = {
  local: "--ours",
  remote: "--theirs",
};
/** The commit each side of the merge in progress is. */
const REV_OF: Record<Side, string> = { local: "HEAD", remote: "MERGE_HEAD" };

function otherSide(side: Side): Side {
  return side === "local" ? "remote" : "local";
}

type StageEntry = { mode: string; sha: string };

/** Unmerged index entries, by path, then by stage (1 base, 2 local, 3 remote). */
export type UnmergedEntries = Map<string, Map<number, StageEntry>>;

export type ConflictFile = {
  path: string;
  binary: boolean;
  base: string | null;
  local: string | null;
  remote: string | null;
  /**
   * The side has no file at this path: it deleted the path, or never had it.
   * Its content is then null. A side pick of that side deletes the path.
   */
  localDeleted: boolean;
  remoteDeleted: boolean;
  /**
   * Only for a file/directory conflict: one side has a file or link at
   * `path`, the other a directory there. The file side's content is in
   * `local` or `remote`; `directoryFiles` lists what the directory holds.
   */
  fileDirectory?: {
    fileSide: Side;
    fileKind: "file" | "symlink";
    directorySide: Side;
    directoryFiles: string[];
  };
  // Only on the declarations file when git merged it without a conflict and
  // the result is invalid: what makes it invalid, and the merged text to fix.
  problems?: DeclarationProblem[];
  merged?: string | null;
};

type PathConflict = {
  kind: "path";
  path: string;
  stages: Map<number, StageEntry>;
};

// Git parks the file side of a file/directory conflict under another name,
// `<path>~<label>`, and leaves the directory at `<path>`.
type FileDirectoryConflict = {
  kind: "file-directory";
  path: string;
  parked: string;
  fileSide: Side;
  fileEntry: StageEntry;
  /** Unmerged paths inside the directory, settled with the conflict. */
  nested: string[];
  /** The files of the directory as its side holds it. */
  directoryFiles: string[];
};

export type Conflict = PathConflict | FileDirectoryConflict;

export type Resolution =
  | { side: Side }
  | { content: string }
  | { delete: true };

function failed(what: string, error: string | undefined): InternalCommandError {
  return new InternalCommandError(
    "transport-failed",
    `${what}: ${error ?? "unknown error"}`,
  );
}

export async function readUnmerged(configDir: string): Promise<UnmergedEntries> {
  const result = await git(configDir, "ls-files", "-u", "-z");
  if (!result.ok) throw failed("Could not list conflicted files", result.error);
  const entries: UnmergedEntries = new Map();
  for (const entry of result.output.split(NUL)) {
    const tab = entry.indexOf("\t");
    if (tab === -1) continue;
    const path = entry.slice(tab + 1);
    const [mode, sha, stageText] = entry.slice(0, tab).split(" ");
    const stage = Number(stageText);
    if (!path || !stage || !mode || !sha) continue;
    if (!entries.has(path)) entries.set(path, new Map());
    entries.get(path)!.set(stage, { mode, sha });
  }
  return entries;
}

async function pathsInside(
  configDir: string,
  directory: string,
  rev: string,
): Promise<string[]> {
  const result = await git(
    configDir,
    "ls-tree",
    "-r",
    "--name-only",
    "-z",
    rev,
    "--",
    `${directory}/`,
  );
  if (!result.ok) throw failed(`Could not list ${directory}`, result.error);
  return [...new Set(result.output.split(NUL).filter(Boolean))].sort(byCodeUnit);
}

// What a revision holds at a path: its object type and id, or null.
async function treeEntry(
  configDir: string,
  rev: string,
  path: string,
): Promise<{ type: string; sha: string } | null> {
  const result = await git(configDir, "ls-tree", "-z", rev, "--", path);
  if (!result.ok) throw failed(`Could not read ${path} at ${rev}`, result.error);
  for (const entry of result.output.split(NUL)) {
    const tab = entry.indexOf("\t");
    if (tab === -1 || entry.slice(tab + 1) !== path) continue;
    const [, type, sha] = entry.slice(0, tab).split(" ");
    if (type && sha) return { type, sha };
  }
  return null;
}

// Whether git parked one side's file at `parked` because the other side has a
// directory at `path`: that side's commit holds this very file at `path`, and
// the other side's commit a directory there. The name alone proves nothing,
// since any path may end in `~something`.
async function isParkedFile(
  configDir: string,
  path: string,
  fileSide: Side,
  entry: StageEntry,
): Promise<boolean> {
  const [file, directory] = await Promise.all([
    treeEntry(configDir, REV_OF[fileSide], path),
    treeEntry(configDir, REV_OF[otherSide(fileSide)], path),
  ]);
  return (
    file?.type === "blob" &&
    file.sha === entry.sha &&
    directory?.type === "tree"
  );
}

/** The conflicts of the merge in progress, sorted by path. */
export async function readConflicts(
  configDir: string,
  unmerged?: UnmergedEntries,
): Promise<Conflict[]> {
  const entries = unmerged ?? (await readUnmerged(configDir));
  const conflicts: Conflict[] = [];
  const absorbed = new Set<string>();

  for (const [parked, stages] of entries) {
    const match = /^(.+)~[^/]+$/.exec(parked);
    if (match === null || stages.size !== 1 || stages.has(1)) continue;
    const path = match[1]!;
    const fileSide: Side = stages.has(2) ? "local" : "remote";
    const fileEntry = stages.get(STAGE_OF[fileSide])!;
    if (!(await isParkedFile(configDir, path, fileSide, fileEntry))) continue;
    const nested = [...entries.keys()].filter((nestedPath) =>
      nestedPath.startsWith(`${path}/`),
    );
    const directoryFiles = await pathsInside(
      configDir,
      path,
      REV_OF[otherSide(fileSide)],
    );
    absorbed.add(parked);
    for (const nestedPath of nested) absorbed.add(nestedPath);
    conflicts.push({
      kind: "file-directory",
      path,
      parked,
      fileSide,
      fileEntry,
      nested,
      directoryFiles,
    });
  }

  for (const [path, stages] of entries) {
    if (!absorbed.has(path)) conflicts.push({ kind: "path", path, stages });
  }
  return conflicts.sort((a, b) => byCodeUnit(a.path, b.path));
}

/** The paths of the conflicts of the merge in progress. */
export async function conflictPaths(configDir: string): Promise<string[]> {
  return (await readConflicts(configDir)).map(({ path }) => path);
}

type BlobRead = { content: string | null; opaque: boolean };

async function blobContent(
  configDir: string,
  entry: StageEntry | undefined,
): Promise<BlobRead> {
  if (entry === undefined) return { content: null, opaque: false };
  const result = await git(configDir, "cat-file", "blob", entry.sha);
  if (!result.ok) throw failed(`Could not read blob ${entry.sha}`, result.error);
  if (result.oversized || result.output.includes(NUL)) {
    return { content: null, opaque: true };
  }
  return { content: result.output, opaque: false };
}

/** A conflict as begin reports it. */
export async function describeConflict(
  configDir: string,
  conflict: Conflict,
): Promise<ConflictFile> {
  if (conflict.kind === "file-directory") {
    const file = await blobContent(configDir, conflict.fileEntry);
    const directorySide = otherSide(conflict.fileSide);
    return {
      path: conflict.path,
      binary: file.opaque,
      base: null,
      local: conflict.fileSide === "local" ? file.content : null,
      remote: conflict.fileSide === "remote" ? file.content : null,
      localDeleted: false,
      remoteDeleted: false,
      fileDirectory: {
        fileSide: conflict.fileSide,
        fileKind: conflict.fileEntry.mode === "120000" ? "symlink" : "file",
        directorySide,
        directoryFiles: conflict.directoryFiles,
      },
    };
  }
  const [base, local, remote] = await Promise.all(
    [1, 2, 3].map((stage) => blobContent(configDir, conflict.stages.get(stage))),
  );
  const binary = base!.opaque || local!.opaque || remote!.opaque;
  return {
    path: conflict.path,
    binary,
    base: binary ? null : base!.content,
    local: binary ? null : local!.content,
    remote: binary ? null : remote!.content,
    localDeleted: !conflict.stages.has(2),
    remoteDeleted: !conflict.stages.has(3),
  };
}

/**
 * Why a resolution cannot settle a conflict, or null when it can. Checked
 * for a whole batch before any of it is applied.
 */
export function resolutionProblem(
  conflict: Conflict,
  resolution: Resolution,
): string | null {
  if (conflict.kind === "file-directory" && "content" in resolution) {
    return (
      `${conflict.path} is a file/directory conflict: the ${conflict.fileSide} side has a file there, ` +
      `the other side a directory. Pick a side, or delete it; contents cannot settle it.`
    );
  }
  return null;
}

async function removePaths(configDir: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const removed = await git(
    configDir,
    "rm",
    "-r",
    "-f",
    "-q",
    "--ignore-unmatch",
    "--",
    ...paths,
  );
  if (!removed.ok) {
    throw failed(`Could not delete ${paths.join(", ")}`, removed.error);
  }
}

// One path takes one side: that side's file, or its deletion when that side
// has no file there.
async function takeSide(
  configDir: string,
  path: string,
  stages: Map<number, StageEntry>,
  side: Side,
): Promise<void> {
  if (!stages.has(STAGE_OF[side])) {
    await removePaths(configDir, [path]);
    return;
  }
  const checkedOut = await git(configDir, "checkout", CHECKOUT_FLAG[side], "--", path);
  if (!checkedOut.ok) {
    throw failed(`Could not pick the ${side} side of ${path}`, checkedOut.error);
  }
  await markResolved(configDir, path);
}

async function markResolved(configDir: string, path: string): Promise<void> {
  const added = await git(configDir, "add", "--", path);
  if (!added.ok) throw failed(`Could not mark ${path} resolved`, added.error);
}

/** Applies one resolution; `resolutionProblem` has accepted it. */
export async function applyResolution(
  configDir: string,
  conflict: Conflict,
  resolution: Resolution,
): Promise<void> {
  if (conflict.kind === "path") {
    if ("delete" in resolution) {
      await removePaths(configDir, [conflict.path]);
    } else if ("side" in resolution) {
      await takeSide(configDir, conflict.path, conflict.stages, resolution.side);
    } else {
      const target = getRemoteSyncPath(conflict.path, configDir);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, resolution.content, "utf8");
      await markResolved(configDir, conflict.path);
    }
    return;
  }

  if ("delete" in resolution) {
    await removePaths(configDir, [conflict.path, conflict.parked]);
    return;
  }
  if (!("side" in resolution)) return;

  if (resolution.side === conflict.fileSide) {
    // The directory goes, and the parked file returns to its own name.
    await removePaths(configDir, [conflict.path, conflict.parked]);
    const { mode, sha } = conflict.fileEntry;
    const placed = await git(
      configDir,
      "update-index",
      "--add",
      "--cacheinfo",
      `${mode},${sha},${conflict.path}`,
    );
    const written = placed.ok
      ? await git(configDir, "checkout-index", "-f", "--", conflict.path)
      : placed;
    if (!written.ok) {
      throw failed(`Could not restore ${conflict.path}`, written.error);
    }
    return;
  }

  // The directory stays, whole, as its side holds it: the parked file goes,
  // and so does whatever the file side's deletions took from the directory.
  await removePaths(configDir, [conflict.path, conflict.parked]);
  const restored = await git(
    configDir,
    "checkout",
    REV_OF[resolution.side],
    "--",
    `${conflict.path}/`,
  );
  if (!restored.ok) {
    throw failed(`Could not restore ${conflict.path}`, restored.error);
  }
}

/**
 * Settles the conflicts no one needs to look at, and returns their paths:
 * a path both sides deleted is deleted, and an excluded path is dropped from
 * the sync repo whatever either side did to it.
 */
export async function autoResolveConflicts(
  configDir: string,
  excludes: ExcludeMatcher,
): Promise<string[]> {
  const settled: string[] = [];
  for (const conflict of await readConflicts(configDir)) {
    const bothDeleted =
      conflict.kind === "path" &&
      !conflict.stages.has(2) &&
      !conflict.stages.has(3);
    if (bothDeleted || excludes(conflict.path)) {
      await applyResolution(configDir, conflict, { delete: true });
      settled.push(conflict.path);
    }
  }
  return settled;
}
