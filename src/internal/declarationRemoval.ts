import {
  lstatSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
} from "node:fs";
import { join } from "node:path";
import {
  CANONICAL_DIR,
  CANONICAL_OVERLAYS_DIR,
  canonicalManifestSection,
  canonicalOverlayPath,
  readCanonical,
} from "../canonical/canonical";
import { getRemoteSyncPath } from "../utils/config";
import {
  declaredPaths,
  pathsOnlyIn,
  type HarnessPath,
} from "../utils/declaredPaths";
import { isAtOrInside } from "../utils/pathKey";
import type { Harness } from "../utils/harnessSet";
import {
  SYNC_MANIFEST_FILE,
  readSyncManifest,
  writeSyncManifest,
  type SyncManifest,
} from "../utils/manifest";
import { forgetLastSyncedPaths } from "./lastSync";

// Removing a declaration, or part of one, means git-agents stops managing
// those paths: the sync repo is cleaned up, and no home directory is touched.
// One plan serves the preview of harness-stage, the cleanup harness-apply
// makes in the clone, and the one transport-begin makes for a hand-edited file.

export type RemovedHarness = {
  /** The harness id. */
  harness: string;
  name: string;
};

export type RemovedOverlay = {
  harness: string;
  /** The overlay file, as a path in the sync repo. */
  path: string;
  content: string;
};

export type RemovalPlan = {
  /** Harnesses that are no longer declared at all. */
  harnesses: RemovedHarness[];
  /** Paths no harness declares any more, whichever harness declared them. */
  paths: HarnessPath[];
  /** The mirrored files to delete, as paths in the sync repo. */
  repoFiles: string[];
  /** The overlays of the removed harnesses, with the content that goes. */
  overlays: RemovedOverlay[];
  /** The manifest entries to delete, by harness id. */
  manifest: { generated: string[]; overlays: string[] };
  /**
   * Whether the canonical version changes, which makes the generated files
   * that remain read as stale until the next `sync unify`.
   */
  canonicalVersionChanges: boolean;
  /**
   * Every path of the sync repo the cleanup may touch. It depends on the two
   * sets alone, so it is the same whether or not the cleanup already ran.
   */
  scope: string[];
};

function overlayRepoPath(harness: string): string {
  return `${CANONICAL_DIR}/${CANONICAL_OVERLAYS_DIR}/${harness}.md`;
}

// The files the sync repo holds at a sync path, a file or a directory. A link
// counts as one file and is never followed.
function repoFilesAt(configDir: string, syncPath: string): string[] {
  // Resolved through the same check as mirroring: never outside the clone.
  getRemoteSyncPath(syncPath, configDir);
  const files: string[] = [];
  const visit = (repoPath: string): void => {
    const absolute = join(configDir, ...repoPath.split("/"));
    let stat;
    try {
      stat = lstatSync(absolute);
    } catch {
      return;
    }
    if (!stat.isDirectory()) {
      files.push(repoPath);
      return;
    }
    for (const name of readdirSync(absolute).sort()) {
      visit(`${repoPath}/${name}`);
    }
  };
  visit(syncPath);
  return files;
}

// The manifest is bookkeeping: one that cannot be read has no entry to delete.
function readManifest(configDir: string): SyncManifest | null {
  try {
    return readSyncManifest(configDir);
  } catch {
    return null;
  }
}

/**
 * What the sync repo loses when the harness set goes from `before` to
 * `after`. Changes are taken piece by piece: a path is removed when no
 * harness of `after` declares it, so a path that moves to another harness or
 * field stays; a harness is removed when its id is gone, and its overlay goes
 * with it; a moved or dropped instructions file loses its `generated` entry
 * and keeps its overlay.
 */
export function planRemoval(
  configDir: string,
  before: readonly Harness[],
  after: readonly Harness[],
): RemovalPlan {
  const custom = before.filter((harness) => !harness.builtIn);
  const kept = new Map(after.map((harness) => [harness.id, harness]));

  const harnesses = custom
    .filter((harness) => !kept.has(harness.id))
    .map(({ id, name }): RemovedHarness => ({ harness: id, name }));
  const paths = pathsOnlyIn(before, after);

  // A file a remaining declaration covers stays, as when a declared directory
  // is narrowed to one of its subdirectories.
  const stillDeclared = declaredPaths(after).map(({ path }) => path);
  const repoFiles = paths
    .flatMap(({ path }) => repoFilesAt(configDir, path))
    .filter((file) => !stillDeclared.some((path) => isAtOrInside(file, path)));

  const overlays = harnesses.flatMap(({ harness }): RemovedOverlay[] => {
    try {
      const content = readFileSync(
        canonicalOverlayPath(configDir, harness),
        "utf8",
      );
      return [{ harness, path: overlayRepoPath(harness), content }];
    } catch {
      return [];
    }
  });

  // The generated entry records one instructions file: it goes when that file
  // is no longer the harness's.
  const regenerated = custom
    .filter(
      (harness) =>
        harness.instructionsFile !== undefined &&
        kept.get(harness.id)?.instructionsFile !== harness.instructionsFile,
    )
    .map((harness) => harness.id);
  const manifest = readManifest(configDir);

  return {
    harnesses,
    paths,
    repoFiles,
    overlays,
    manifest: {
      generated: regenerated.filter(
        (id) => manifest?.generated?.[id] !== undefined,
      ),
      overlays: harnesses
        .map(({ harness }) => harness)
        .filter((id) => manifest?.canonical?.overlays[id] !== undefined),
    },
    canonicalVersionChanges:
      readCanonical(configDir, before)?.version !==
      readCanonical(configDir, after)?.version,
    scope: [
      ...paths.map(({ path }) => path),
      ...harnesses.map(({ harness }) => overlayRepoPath(harness)),
      ...(harnesses.length > 0 || regenerated.length > 0
        ? [SYNC_MANIFEST_FILE]
        : []),
    ],
  };
}

/** Whether the plan has nothing to delete, and so nothing to preview. */
export function removesNothing(plan: RemovalPlan): boolean {
  return (
    plan.harnesses.length === 0 &&
    plan.paths.length === 0 &&
    plan.manifest.generated.length === 0
  );
}

// Removes a directory when nothing but empty directories is left in it.
function pruneEmptyDirectories(directory: string): boolean {
  let stat;
  try {
    stat = lstatSync(directory);
  } catch {
    return true;
  }
  if (!stat.isDirectory()) return false;
  let empty = true;
  for (const name of readdirSync(directory)) {
    if (!pruneEmptyDirectories(join(directory, name))) empty = false;
  }
  if (empty) rmdirSync(directory);
  return empty;
}

// Git tracks no directory: the ones a cleanup empties go with their files.
function pruneRepoPath(configDir: string, syncPath: string): void {
  const segments = syncPath.split("/");
  if (!pruneEmptyDirectories(join(configDir, ...segments))) return;
  for (let depth = segments.length - 1; depth > 0; depth -= 1) {
    const parent = join(configDir, ...segments.slice(0, depth));
    try {
      if (readdirSync(parent).length > 0) return;
      rmdirSync(parent);
    } catch {
      return;
    }
  }
}

/**
 * Carries a removal plan out in the clone: deletes the mirrored files and the
 * overlays, deletes the manifest entries and recomputes the canonical version
 * there. It commits nothing, and running it again changes nothing more.
 *
 * It never reads or writes the home directory. The removed paths also leave
 * this machine's last-sync record: should a later merge keep one of them
 * declared, its missing repo copy must not read as a deletion to carry home.
 */
export function applyRemoval(
  configDir: string,
  plan: RemovalPlan,
  after: readonly Harness[],
): void {
  for (const file of plan.repoFiles) {
    rmSync(join(configDir, ...file.split("/")), {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  }
  for (const { path } of plan.paths) pruneRepoPath(configDir, path);

  for (const { harness } of plan.overlays) {
    rmSync(canonicalOverlayPath(configDir, harness), { force: true });
  }

  const manifest =
    plan.manifest.generated.length > 0 || plan.manifest.overlays.length > 0
      ? readManifest(configDir)
      : null;
  if (manifest !== null) {
    const generated = new Set(plan.manifest.generated);
    const overlays = new Set(plan.manifest.overlays);
    // After the overlays are deleted, so the version is the one of what is left.
    const canonical = readCanonical(configDir, after);
    writeSyncManifest(configDir, {
      paths: manifest.paths,
      canonical:
        manifest.canonical === undefined
          ? undefined
          : canonical !== null
            ? canonicalManifestSection(canonical, after)
            : {
                ...manifest.canonical,
                overlays: Object.fromEntries(
                  Object.entries(manifest.canonical.overlays).filter(
                    ([id]) => !overlays.has(id),
                  ),
                ),
              },
      generated:
        manifest.generated === undefined
          ? undefined
          : Object.fromEntries(
              Object.entries(manifest.generated).filter(
                ([id]) => !generated.has(id),
              ),
            ),
    });
  }

  forgetLastSyncedPaths(
    configDir,
    plan.paths.map(({ path }) => path),
  );
}
