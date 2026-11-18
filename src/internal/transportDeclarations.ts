import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  HARNESS_DECLARATIONS_FILE,
  parseHarnessDeclarations,
  readHarnessDeclarations,
  type DeclarationProblem,
} from "../utils/harnessDeclarations";
import {
  BUILT_IN_HARNESSES,
  INVALID_HARNESS_DECLARATIONS,
  buildHarnessSet,
  listDeclarationProblems,
  type Harness,
} from "../utils/harnessSet";
import { pathsOnlyIn, type DeclaredPath } from "../utils/declaredPaths";
import { measureSyncPath, type SyncPathSize } from "../utils/pathSize";
import { InternalCommandError } from "./errors";
import { NUL, git, type GitResult } from "./git";
import type { ConflictFile } from "./transport";

// What transport does about the declarations file: committing a pending
// change, comparing the remote's file with the merge base's, listing the
// paths synced for the first time, and reporting and resolving a merged file
// that is invalid.

// The paths git reports unmerged, as a set or as the map of their stages.
type UnmergedPaths = { has(path: string): boolean };

// A change to the declarations file that is not committed yet, written by
// harness-apply or by hand, gets a commit of its own. Returns that commit, or
// null when the file has no pending change.
export async function commitPendingDeclarations(
  configDir: string,
): Promise<string | null> {
  const file = HARNESS_DECLARATIONS_FILE;
  const inWorktree = existsSync(join(configDir, file));
  const tracked = await git(configDir, "ls-files", "--", file);
  if (!inWorktree && !(tracked.ok && tracked.output.trim())) return null;

  const added = await git(configDir, "add", "-A", "--", file);
  const staged = added.ok
    ? await git(configDir, "diff", "--cached", "--quiet", "--", file)
    : added;
  if (staged.ok) return null;
  // Path-limited, so nothing else that happens to be staged rides along.
  const committed =
    staged.exitCode === 1
      ? await git(
          configDir,
          "commit",
          "-m",
          `sync: harness declarations (${new Date().toISOString().slice(0, 10)})`,
          "--",
          file,
        )
      : staged;
  const head = committed.ok
    ? await git(configDir, "rev-parse", "--verify", "HEAD^{commit}")
    : committed;
  if (!head.ok) {
    throw new InternalCommandError(
      "transport-failed",
      `Could not commit the change to ${file}: ${head.error ?? "unknown error"}`,
    );
  }
  return head.output.trim();
}

// Puts the declarations file back as a commit holds it and commits that, on
// top of a pre-sync point that predates the declaration.
export async function restoreDeclarations(
  configDir: string,
  commit: string,
): Promise<void> {
  const file = HARNESS_DECLARATIONS_FILE;
  if ((await fileAt(configDir, commit, file)) === null) {
    rmSync(join(configDir, file), { force: true });
  } else {
    const restored = await git(configDir, "checkout", commit, "--", file);
    if (!restored.ok) {
      throw new InternalCommandError(
        "transport-failed",
        `Could not keep the change to ${file}: ${restored.error ?? "unknown error"}`,
      );
    }
  }
  await commitPendingDeclarations(configDir);
}

// A file as a revision holds it, or null when the revision has no such file.
async function fileAt(
  configDir: string,
  rev: string,
  path: string,
): Promise<string | null> {
  const listed = await git(configDir, "ls-tree", "-z", rev, "--", path);
  const shown =
    listed.ok && listed.output
      ? await git(configDir, "show", `${rev}:${path}`)
      : listed;
  if (!shown.ok) {
    throw new InternalCommandError(
      "transport-failed",
      `Could not read ${path} at ${rev}: ${shown.error ?? "unknown error"}`,
    );
  }
  return listed.output ? shown.output : null;
}

// The harness set a revision declares, or null when its declarations file is
// invalid.
async function harnessSetAt(
  configDir: string,
  rev: string,
): Promise<Harness[] | null> {
  const text = await fileAt(configDir, rev, HARNESS_DECLARATIONS_FILE);
  if (text === null) return [...BUILT_IN_HARNESSES];
  const declared = parseHarnessDeclarations(text);
  return declared.ok ? buildHarnessSet(declared.harnesses) : null;
}

// What the fetch shows of the declarations, before anything is mirrored.
export type DeclarationsLook = {
  // The set both sides started from. Without a merge base, or with an invalid
  // file there, nothing custom counts as already declared.
  base: Harness[];
  // The set the remote declares. Null when the remote has no branch yet, or
  // when its file is invalid: that is left for the merge result to report.
  remote: Harness[] | null;
};

export async function lookAtDeclarations(
  configDir: string,
  remoteTip: string | null,
): Promise<DeclarationsLook> {
  if (remoteTip === null) return { base: [...BUILT_IN_HARNESSES], remote: null };
  const mergeBase = await git(configDir, "merge-base", "HEAD", remoteTip);
  const base = mergeBase.ok
    ? await harnessSetAt(configDir, mergeBase.output.trim())
    : null;
  return {
    base: base ?? [...BUILT_IN_HARNESSES],
    remote: await harnessSetAt(configDir, remoteTip),
  };
}

type RemoteDeclarationChanges = {
  // Paths the remote declares and the merge base does not. They join the
  // mirror set, so a file this machine already holds there is committed first
  // and meets the remote's as a both-added conflict.
  declared: DeclaredPath[];
};

// The remote's declarations against the merge base's. The base is the
// reference, not this machine's file, so a path this machine removed and the
// remote still declares is not taken for a new one.
export function remoteDeclarationChanges(
  look: DeclarationsLook,
): RemoteDeclarationChanges {
  if (look.remote === null) return { declared: [] };
  return { declared: pathsOnlyIn(look.remote, look.base) };
}

export type FirstSyncPath = DeclaredPath &
  SyncPathSize & { direction: "outgoing" | "incoming" };

type SizeOf = (path: string) => SyncPathSize | null | Promise<SyncPathSize | null>;

// The gate listing: each newly declared path, once per direction in which it
// has something to sync.
export async function firstSyncListing(
  declared: DeclaredPath[],
  outgoingSize: SizeOf,
  incomingSize: SizeOf,
): Promise<FirstSyncPath[]> {
  const listing: FirstSyncPath[] = [];
  for (const entry of declared) {
    const outgoing = await outgoingSize(entry.path);
    if (outgoing !== null) {
      listing.push({ ...entry, direction: "outgoing", ...outgoing });
    }
    const incoming = await incomingSize(entry.path);
    if (incoming !== null) {
      listing.push({ ...entry, direction: "incoming", ...incoming });
    }
  }
  return listing;
}

// The size of a path the change list carries, measured where its content is.
export function changedPathSize(
  changes: readonly { path: string; status: string }[],
  locate: (path: string) => string,
): SizeOf {
  const changed = new Set(
    changes
      .filter(({ status }) => status !== "removed")
      .map(({ path }) => path),
  );
  return (path) => (changed.has(path) ? measureSyncPath(locate(path)) : null);
}

// The size of a path as a revision holds it, or null when it holds nothing
// there.
export async function sizeAt(
  configDir: string,
  rev: string,
  path: string,
): Promise<SyncPathSize | null> {
  const listed = await git(configDir, "ls-tree", "-r", "-l", "-z", rev, "--", path);
  if (!listed.ok) return null;
  // Each entry: "<mode> <type> <object> <size>\t<path>".
  const sizes = listed.output
    .split(NUL)
    .filter(Boolean)
    .map((entry) => Number(entry.split("\t")[0]!.split(/ +/)[3]) || 0);
  if (sizes.length === 0) return null;
  return {
    fileCount: sizes.length,
    totalBytes: sizes.reduce((total, size) => total + size, 0),
  };
}

// What makes the merged declarations file invalid, or null when it needs no
// resolution of this kind: it is valid, or git itself reports it conflicted.
export function mergedDeclarationProblems(
  configDir: string,
  unmerged: UnmergedPaths,
): DeclarationProblem[] | null {
  if (unmerged.has(HARNESS_DECLARATIONS_FILE)) return null;
  const declared = readHarnessDeclarations(configDir);
  return declared.ok ? null : declared.problems;
}

// Its entry in the conflicts list: the three sides, as for a git conflict,
// plus the merged text and what makes it invalid.
export async function invalidDeclarationsConflict(
  configDir: string,
  problems: DeclarationProblem[],
): Promise<ConflictFile> {
  const path = HARNESS_DECLARATIONS_FILE;
  const mergeBase = await git(configDir, "merge-base", "HEAD", "MERGE_HEAD");
  const [base, local, remote] = await Promise.all([
    mergeBase.ok ? fileAt(configDir, mergeBase.output.trim(), path) : null,
    fileAt(configDir, "HEAD", path),
    fileAt(configDir, "MERGE_HEAD", path),
  ]);
  let merged: string | null;
  try {
    merged = readFileSync(join(configDir, path), "utf8");
  } catch {
    merged = null;
  }
  return { path, binary: false, base, local, remote, merged, problems };
}

// The refusal while a merge is open on an invalid declarations file. It names
// the way out of the merge, which the general refusal does not.
export function invalidMergedDeclarationsError(
  problems: readonly DeclarationProblem[],
  subject = `The merged ${HARNESS_DECLARATIONS_FILE} is invalid`,
): InternalCommandError {
  return new InternalCommandError(
    INVALID_HARNESS_DECLARATIONS,
    `${subject}. Problems:\n${listDeclarationProblems(problems)}\n` +
      `Remedy: submit corrected full contents for ${HARNESS_DECLARATIONS_FILE} with transport-resolve, ` +
      "or run transport-abort to restore the pre-sync state.",
  );
}

// The declarations file is the one resolution that is validated, and the one
// path accepted without a git conflict: while the merged file is invalid.
// Nothing is written unless the resolution is valid.
export async function resolveDeclarations(
  configDir: string,
  file: { content?: string; side?: "local" | "remote" },
  unmerged: UnmergedPaths,
): Promise<void> {
  const path = HARNESS_DECLARATIONS_FILE;
  if (
    !unmerged.has(path) &&
    mergedDeclarationProblems(configDir, unmerged) === null
  ) {
    throw new InternalCommandError(
      "not-conflicted",
      `${path} is not a conflicted file in this merge.`,
    );
  }

  // A side is that side's whole file, which may be no file at all.
  const rev =
    file.side === undefined ? null : file.side === "local" ? "HEAD" : "MERGE_HEAD";
  const content =
    rev === null ? file.content! : await fileAt(configDir, rev, path);
  if (content !== null) {
    const declared = parseHarnessDeclarations(content);
    if (!declared.ok) {
      throw invalidMergedDeclarationsError(
        declared.problems,
        file.side === undefined
          ? `The contents submitted for ${path} are invalid, and nothing was written`
          : `The ${file.side} side of ${path} is invalid, and nothing was written`,
      );
    }
  }

  let staged: GitResult;
  if (content === null) {
    staged = await git(configDir, "rm", "-f", "-q", "--ignore-unmatch", "--", path);
  } else if (rev !== null) {
    staged = await git(configDir, "checkout", rev, "--", path);
  } else {
    writeFileSync(join(configDir, path), content, "utf8");
    staged = await git(configDir, "add", "--", path);
  }
  if (!staged.ok) {
    throw new InternalCommandError(
      "transport-failed",
      `Could not mark ${path} resolved: ${staged.error ?? "unknown error"}`,
    );
  }
}
