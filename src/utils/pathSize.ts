import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { isLeftOut, snapshotSyncPath } from "./agents";
import type { PathFilter } from "./excludes";

export type SyncPathSize = {
  /** Files and links, counted the way `snapshotSyncPath` counts them. */
  fileCount: number;
  /** The bytes of every regular file; a link adds none. */
  totalBytes: number;
};

/**
 * The file count and total size of a sync path, a file or a directory, or
 * null when nothing is there. Links are not followed, except a Windows
 * directory link or junction, which mirroring copies as the directory it
 * points at. With `exclude`, excluded entries are left out the way
 * `snapshotSyncPath` leaves them out.
 */
export function measureSyncPath(
  path: string,
  exclude?: PathFilter,
): SyncPathSize | null {
  if (exclude && snapshotSyncPath(path, exclude) === null) return null;
  const size: SyncPathSize = { fileCount: 0, totalBytes: 0 };
  return measure(path, path, size, new Set(), exclude) ? size : null;
}

function measure(
  root: string,
  path: string,
  size: SyncPathSize,
  ancestors: Set<string>,
  exclude: PathFilter | undefined,
): boolean {
  let stat;
  try {
    stat = lstatSync(path);
    if (stat.isSymbolicLink() && process.platform === "win32") {
      const target = statSync(path, { throwIfNoEntry: false });
      if (target?.isDirectory()) stat = target;
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }

  if (!stat.isDirectory()) {
    if (stat.isFile()) size.totalBytes += stat.size;
    if (stat.isFile() || stat.isSymbolicLink()) size.fileCount += 1;
    return true;
  }

  // A directory link whose target contains the link would never end.
  const real = realpathSync(path);
  const key = process.platform === "win32" ? real.toLowerCase() : real;
  if (ancestors.has(key)) return true;
  ancestors.add(key);
  for (const name of readdirSync(path)) {
    const child = resolve(path, name);
    if (isLeftOut(root, child, exclude)) continue;
    measure(root, child, size, ancestors, exclude);
  }
  ancestors.delete(key);
  return true;
}
