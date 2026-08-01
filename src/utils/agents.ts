import {
  cpSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from "fs";
import { createHash, randomUUID, type Hash } from "crypto";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "path";
import type { SyncPathSnapshot, SyncPathStatus } from "../types";
import { errorMessage } from "./errors";

function normalizedRelativePath(root: string, path: string): string {
  const value = relative(root, path);
  return value ? value.split(sep).join("/") : ".";
}

function hashPath(
  root: string,
  path: string,
  hash: Hash,
  count: { files: number },
  followDirectoryLink = false,
  ancestorDirectories = new Set<string>(),
): void {
  const linkStat = lstatSync(path);
  const directoryLinkTarget = windowsDirectoryLinkTarget(path, linkStat);
  const stat = followDirectoryLink || directoryLinkTarget
    ? statSync(path)
    : linkStat;
  const relativePath = normalizedRelativePath(root, path);

  if (stat.isSymbolicLink()) {
    hash.update("symlink\0");
    hash.update(relativePath);
    hash.update("\0");
    hash.update(readlinkSync(path));
    hash.update("\0");
    count.files += 1;
    return;
  }

  if (stat.isFile()) {
    hash.update("file\0");
    hash.update(relativePath);
    hash.update("\0");
    hash.update(stat.mode & 0o100 ? "executable" : "non-executable");
    hash.update("\0");
    hash.update(readFileSync(path));
    hash.update("\0");
    count.files += 1;
    return;
  }

  if (stat.isDirectory()) {
    const canonicalDirectory = comparablePath(realpathSync(path));
    if (ancestorDirectories.has(canonicalDirectory)) {
      throw new Error(
        `Refusing to snapshot a directory link whose target contains the link: ${path}`,
      );
    }
    ancestorDirectories.add(canonicalDirectory);
    hash.update("directory\0");
    hash.update(relativePath);
    hash.update("\0");
    try {
      const children = readdirSync(path)
        .sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
        .map((name) => resolve(path, name));
      for (const child of children) {
        hashPath(root, child, hash, count, false, ancestorDirectories);
      }
    } finally {
      ancestorDirectories.delete(canonicalDirectory);
    }
    return;
  }

  hash.update("other\0");
  hash.update(relativePath);
  hash.update("\0");
}

function windowsDirectoryLinkTarget(
  path: string,
  linkStat = lstatSync(path),
): string | null {
  if (process.platform !== "win32" || !linkStat.isSymbolicLink()) return null;

  try {
    if (!statSync(path).isDirectory()) return null;
    return realpathSync(path);
  } catch (error: any) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
}

export function snapshotSyncPath(path: string): SyncPathSnapshot | null {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }

  const directoryLinkTarget = windowsDirectoryLinkTarget(path, stat);
  const hash = createHash("sha256");
  const count = { files: 0 };
  hashPath(path, path, hash, count, directoryLinkTarget !== null);

  const kind = directoryLinkTarget
    ? "directory"
    : stat.isSymbolicLink()
      ? "symlink"
      : stat.isDirectory()
        ? "directory"
        : "file";

  return {
    kind,
    fileCount: count.files,
    contentHash: hash.digest("hex"),
  };
}

export function compareSyncPathSnapshots(
  source: SyncPathSnapshot | null,
  destination: SyncPathSnapshot | null,
): SyncPathStatus {
  if (source && !destination) return "added";
  if (!source && destination) return "removed";
  if (!source && !destination) return "unchanged";
  if (
    source!.kind !== destination!.kind ||
    source!.contentHash !== destination!.contentHash
  ) {
    return "modified";
  }
  return "unchanged";
}

function comparablePath(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isSameOrDescendant(basePath: string, targetPath: string): boolean {
  const pathFromBase = relative(
    comparablePath(basePath),
    comparablePath(targetPath),
  );
  return pathFromBase === "" ||
    (!pathFromBase.startsWith(`..${sep}`) &&
      pathFromBase !== ".." &&
      !isAbsolute(pathFromBase));
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error: any) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw error;
  }
}

function resolvedExistingPath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch (error: any) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
}

function resolvedPathWithExistingAncestor(path: string): string {
  const missingParts: string[] = [];
  let current = resolve(path);

  while (!pathExists(current)) {
    const parent = dirname(current);
    if (parent === current) return current;
    missingParts.unshift(basename(current));
    current = parent;
  }

  return resolve(resolvedExistingPath(current) ?? current, ...missingParts);
}

function assertDirectoryLinkTargetDoesNotContainLink(
  linkPath: string,
  canonicalTargetPath: string,
): void {
  const canonicalLinkPath = resolve(
    resolvedPathWithExistingAncestor(dirname(linkPath)),
    basename(linkPath),
  );
  if (isSameOrDescendant(canonicalTargetPath, canonicalLinkPath)) {
    throw new Error(
      `Refusing to mirror a directory link whose target contains the link: ${linkPath}`,
    );
  }
}

function assertNoSelfContainingDirectoryLinks(rootPath: string): void {
  if (process.platform !== "win32") return;

  const visit = (path: string): void => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      const directoryTarget = windowsDirectoryLinkTarget(path, stat);
      if (directoryTarget) {
        assertDirectoryLinkTargetDoesNotContainLink(path, directoryTarget);
      }
      return;
    }
    if (!stat.isDirectory()) return;

    for (const child of readdirSync(path)) {
      visit(resolve(path, child));
    }
  };

  visit(rootPath);
}

function assertSafeSyncPath(basePath: string, targetPath: string): void {
  const base = resolve(basePath);
  const target = resolve(targetPath);
  const pathFromBase = relative(base, target);

  if (
    pathFromBase === "" ||
    pathFromBase === ".." ||
    pathFromBase.startsWith(`..${sep}`) ||
    isAbsolute(pathFromBase)
  ) {
    throw new Error(`Refusing to sync path outside its base: ${targetPath}`);
  }

  const canonicalBase = resolvedExistingPath(base);
  let current = base;
  const ancestors = pathFromBase.split(sep).slice(0, -1);

  for (const part of ancestors) {
    current = join(current, part);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error: any) {
      if (error?.code === "ENOENT") break;
      if (error?.code === "ENOTDIR") {
        throw new Error(`Sync path ancestor is not a directory: ${current}`);
      }
      throw error;
    }

    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to traverse symlink ancestor: ${current}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Sync path ancestor is not a directory: ${current}`);
    }

    if (canonicalBase) {
      const canonicalCurrent = realpathSync(current);
      if (!isSameOrDescendant(canonicalBase, canonicalCurrent)) {
        throw new Error(`Sync path escapes its canonical base: ${targetPath}`);
      }
    }
  }
}

function uniqueSiblingPath(path: string, label: string): string {
  const parent = dirname(path);
  const name = basename(path);

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = join(
      parent,
      `.${name}.git-agents-${label}-${randomUUID()}`,
    );
    if (!pathExists(candidate)) return candidate;
  }

  throw new Error(`Could not reserve a temporary path beside ${path}`);
}

function removePath(path: string): void {
  rmSync(path, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
}

export function mirrorSyncPath(
  fromPath: string,
  toPath: string,
  fromBasePath?: string,
  toBasePath?: string,
  reviewedSnapshots?: {
    source: SyncPathSnapshot | null;
    destination: SyncPathSnapshot | null;
  },
): void {
  if (comparablePath(fromPath) === comparablePath(toPath)) return;

  if (fromBasePath) assertSafeSyncPath(fromBasePath, fromPath);
  if (toBasePath) assertSafeSyncPath(toBasePath, toPath);

  const source = snapshotSyncPath(fromPath);
  const destination = snapshotSyncPath(toPath);
  if (
    reviewedSnapshots &&
    compareSyncPathSnapshots(reviewedSnapshots.source, source) !== "unchanged"
  ) {
    throw new Error(`Source changed since review: ${fromPath}`);
  }
  if (
    reviewedSnapshots &&
    compareSyncPathSnapshots(reviewedSnapshots.destination, destination) !==
      "unchanged"
  ) {
    throw new Error(`Destination changed since review: ${toPath}`);
  }
  const existingSource = resolvedExistingPath(fromPath);
  const existingDestination = resolvedExistingPath(toPath);
  if (
    existingSource &&
    existingDestination &&
    comparablePath(existingSource) === comparablePath(existingDestination)
  ) {
    if (
      compareSyncPathSnapshots(source, destination) === "unchanged"
    ) {
      return;
    }
    throw new Error(
      "Refusing to mirror aliased source and destination paths",
    );
  }

  if (
    isSameOrDescendant(fromPath, toPath) ||
    isSameOrDescendant(toPath, fromPath)
  ) {
    throw new Error("Refusing to mirror overlapping source and destination paths");
  }

  if (!source) {
    if (
      compareSyncPathSnapshots(source, snapshotSyncPath(fromPath)) !==
      "unchanged"
    ) {
      throw new Error(`Source changed while syncing: ${fromPath}`);
    }
    if (
      compareSyncPathSnapshots(destination, snapshotSyncPath(toPath)) !==
      "unchanged"
    ) {
      throw new Error(`Destination changed while syncing: ${toPath}`);
    }
    if (toBasePath) assertSafeSyncPath(toBasePath, toPath);
    removePath(toPath);
    return;
  }

  const sourceDirectoryLinkTarget = windowsDirectoryLinkTarget(fromPath);
  const destinationDirectoryLinkTarget =
    source.kind === "directory" && destination?.kind === "directory"
      ? windowsDirectoryLinkTarget(toPath)
      : null;
  const copySourcePath = sourceDirectoryLinkTarget ?? fromPath;
  const installPath = destinationDirectoryLinkTarget ?? toPath;
  const canonicalCopySource = resolvedPathWithExistingAncestor(copySourcePath);
  const canonicalInstallPath = resolvedPathWithExistingAncestor(installPath);

  if (sourceDirectoryLinkTarget) {
    assertDirectoryLinkTargetDoesNotContainLink(fromPath, canonicalCopySource);
  }
  if (destinationDirectoryLinkTarget) {
    assertDirectoryLinkTargetDoesNotContainLink(toPath, canonicalInstallPath);
  }
  if (source.kind === "directory") {
    assertNoSelfContainingDirectoryLinks(copySourcePath);
  }

  if (
    isSameOrDescendant(canonicalCopySource, canonicalInstallPath) ||
    isSameOrDescendant(canonicalInstallPath, canonicalCopySource)
  ) {
    throw new Error("Refusing to mirror overlapping source and destination paths");
  }

  mkdirSync(dirname(installPath), { recursive: true });
  if (toBasePath) assertSafeSyncPath(toBasePath, toPath);

  const temporaryPath = uniqueSiblingPath(installPath, "incoming");
  let backupPath: string | null = null;
  let temporaryExists = false;
  let destinationMoved = false;
  let destinationInstalled = false;

  try {
    temporaryExists = true;
    cpSync(copySourcePath, temporaryPath, {
      recursive: source.kind === "directory",
      force: true,
      dereference: false,
      verbatimSymlinks: true,
    });

    const copiedSource = snapshotSyncPath(temporaryPath);
    const currentSource = snapshotSyncPath(fromPath);
    const currentDestination = snapshotSyncPath(toPath);
    if (
      compareSyncPathSnapshots(source, copiedSource) !== "unchanged" ||
      compareSyncPathSnapshots(source, currentSource) !== "unchanged"
    ) {
      throw new Error(`Source changed while syncing: ${fromPath}`);
    }
    if (
      compareSyncPathSnapshots(destination, currentDestination) !== "unchanged"
    ) {
      throw new Error(`Destination changed while syncing: ${toPath}`);
    }

    const currentSourceDirectoryLinkTarget =
      source.kind === "directory" && currentSource?.kind === "directory"
        ? windowsDirectoryLinkTarget(fromPath)
        : null;
    const currentDestinationDirectoryLinkTarget =
      source.kind === "directory" && currentDestination?.kind === "directory"
        ? windowsDirectoryLinkTarget(toPath)
        : null;
    if (
      (sourceDirectoryLinkTarget === null) !==
        (currentSourceDirectoryLinkTarget === null) ||
      (sourceDirectoryLinkTarget &&
        currentSourceDirectoryLinkTarget &&
        comparablePath(sourceDirectoryLinkTarget) !==
          comparablePath(currentSourceDirectoryLinkTarget))
    ) {
      throw new Error(`Source directory link changed while syncing: ${fromPath}`);
    }
    if (
      (destinationDirectoryLinkTarget === null) !==
        (currentDestinationDirectoryLinkTarget === null) ||
      (destinationDirectoryLinkTarget &&
        currentDestinationDirectoryLinkTarget &&
        comparablePath(destinationDirectoryLinkTarget) !==
          comparablePath(currentDestinationDirectoryLinkTarget))
    ) {
      throw new Error(
        `Destination directory link changed while syncing: ${toPath}`,
      );
    }

    if (toBasePath) assertSafeSyncPath(toBasePath, toPath);
    if (destinationDirectoryLinkTarget) {
      const currentTarget = windowsDirectoryLinkTarget(toPath);
      if (
        !currentTarget ||
        comparablePath(currentTarget) !==
          comparablePath(destinationDirectoryLinkTarget)
      ) {
        throw new Error(`Destination junction changed while syncing: ${toPath}`);
      }
    }
    if (pathExists(installPath)) {
      backupPath = uniqueSiblingPath(installPath, "backup");
      renameSync(installPath, backupPath);
      destinationMoved = true;
    }

    renameSync(temporaryPath, installPath);
    temporaryExists = false;
    destinationInstalled = true;

    if (backupPath) {
      removePath(backupPath);
      destinationMoved = false;
      backupPath = null;
    }
  } catch (error) {
    let recoveryError: unknown;
    let cleanupError: unknown;

    if (
      destinationMoved &&
      backupPath &&
      !destinationInstalled
    ) {
      try {
        if (pathExists(installPath)) {
          throw new Error(
            `Cannot restore backup because the destination now exists: ${installPath}`,
          );
        }
        renameSync(backupPath, installPath);
      } catch (caughtRecoveryError) {
        recoveryError = caughtRecoveryError;
      }
    }

    if (temporaryExists) {
      try {
        removePath(temporaryPath);
      } catch (caughtCleanupError) {
        cleanupError = caughtCleanupError;
      }
    }

    if (recoveryError || cleanupError) {
      const details = [
        recoveryError
          ? `Recovery also failed: ${errorMessage(recoveryError)}`
          : null,
        cleanupError
          ? `Temporary cleanup also failed: ${errorMessage(cleanupError)}`
          : null,
      ].filter((detail): detail is string => detail !== null);
      throw new Error(
        `Failed to mirror synced path: ${errorMessage(error)}. ` +
        details.join(". "),
      );
    }

    throw error;
  }
}
