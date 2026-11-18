import {
  lstatSync,
  readdirSync,
  realpathSync,
  statSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";

export type PathSize = { fileCount: number; totalBytes: number };

/**
 * How many files a file or directory holds and their total size in bytes, or
 * null when nothing is there. Counts what a sync path snapshot counts: a
 * symlink is one file, except a Windows directory link, which is walked.
 */
export function measurePath(path: string): PathSize | null {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const size: PathSize = { fileCount: 0, totalBytes: 0 };
  addPath(path, stat, size, new Set());
  return size;
}

function addPath(
  path: string,
  linkStat: Stats,
  size: PathSize,
  ancestors: Set<string>,
): void {
  const stat = isWindowsDirectoryLink(path, linkStat)
    ? statSync(path)
    : linkStat;
  if (!stat.isDirectory()) {
    if (stat.isFile() || stat.isSymbolicLink()) {
      size.fileCount += 1;
      size.totalBytes += stat.size;
    }
    return;
  }

  // A directory link whose target contains the link would never end.
  const real = realpathSync(path).toLowerCase();
  if (ancestors.has(real)) return;
  ancestors.add(real);
  for (const name of readdirSync(path)) {
    const child = join(path, name);
    addPath(child, lstatSync(child), size, ancestors);
  }
  ancestors.delete(real);
}

function isWindowsDirectoryLink(path: string, linkStat: Stats): boolean {
  if (process.platform !== "win32" || !linkStat.isSymbolicLink()) return false;
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
