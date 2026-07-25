import { homedir } from "os";
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import { randomUUID } from "crypto";
import { isAbsolute, join } from "path";
import { getLocalSyncPath, getRemoteSyncPath } from "./config";
import {
  compareSyncPathSnapshots,
  mirrorSyncPath,
  snapshotSyncPath,
} from "./agents";
import type { AgentDef } from "./agentDefs";
import type {
  Config,
  RemoteType,
  ShellResult,
  SyncPathSnapshot,
  SyncPathStatus,
} from "../types";

export type FlowDeps = {
  checkGhInstalled: () => Promise<ShellResult>;
  checkGhAuth: () => Promise<ShellResult>;
  ghRepoExists: (name: string) => Promise<ShellResult>;
  ghCreateRepo: (name: string) => Promise<ShellResult>;
  ghGetRepoCloneUrl: (name: string) => Promise<ShellResult>;
  checkGitRepoExists: (url: string) => Promise<ShellResult>;
  cloneRepo: (url: string) => Promise<ShellResult>;
  isAlreadyCloned: () => boolean;
  writeConfig: (config: Config) => void;
  gitPull: (dir: string) => Promise<ShellResult>;
  gitAddCommitPush: (
    dir: string,
    message: string,
    paths: string[],
  ) => Promise<ShellResult>;
  gitSetRemoteUrl: (dir: string, url: string) => Promise<ShellResult>;
};

export type GhPrecheckResult =
  | { type: "ok" }
  | { type: "gh-not-installed" }
  | { type: "needs-auth" };

export async function runGhPrecheck(
  deps: Pick<FlowDeps, "checkGhInstalled" | "checkGhAuth">
): Promise<GhPrecheckResult> {
  const installed = await deps.checkGhInstalled();
  if (!installed.ok) return { type: "gh-not-installed" };

  const auth = await deps.checkGhAuth();
  if (!auth.ok) return { type: "needs-auth" };

  return { type: "ok" };
}

export type GhRepoCheckResult =
  | { type: "found"; url: string }
  | { type: "not-found" }
  | { type: "error"; message: string };

export async function runGhRepoCheck(
  repoName: string,
  deps: Pick<FlowDeps, "ghRepoExists" | "ghGetRepoCloneUrl">
): Promise<GhRepoCheckResult> {
  const exists = await deps.ghRepoExists(repoName);
  if (!exists.ok) return { type: "not-found" };

  const urlResult = await deps.ghGetRepoCloneUrl(repoName);
  if (!urlResult.ok || !urlResult.output) {
    return { type: "error", message: "Could not get repo URL from gh CLI." };
  }
  return { type: "found", url: urlResult.output.trim() };
}

export type GhCreateRepoResult =
  | { type: "ok"; url: string }
  | { type: "error"; message: string };

export async function runGhCreateRepo(
  repoName: string,
  deps: Pick<FlowDeps, "ghCreateRepo" | "ghGetRepoCloneUrl">
): Promise<GhCreateRepoResult> {
  const created = await deps.ghCreateRepo(repoName);
  if (!created.ok) {
    return { type: "error", message: `Failed to create repo: ${created.error ?? "unknown error"}` };
  }

  const urlResult = await deps.ghGetRepoCloneUrl(repoName);
  if (!urlResult.ok || !urlResult.output) {
    return { type: "error", message: "Could not get repo URL after creating it." };
  }
  return { type: "ok", url: urlResult.output.trim() };
}

export type CloneResult =
  | { type: "ok"; config: Config }
  | { type: "error"; message: string };

export async function runClone(
  url: string,
  remote: RemoteType,
  configDir: string,
  deps: Pick<FlowDeps, "cloneRepo" | "isAlreadyCloned" | "writeConfig" | "gitSetRemoteUrl">
): Promise<CloneResult> {
  const config: Config = { remote, repoUrl: remote === "git" ? url : undefined };

  if (deps.isAlreadyCloned()) {
    const setUrlResult = await deps.gitSetRemoteUrl(configDir, url);
    if (!setUrlResult.ok) {
      return { type: "error", message: `Failed to update remote URL: ${setUrlResult.error ?? "unknown error"}` };
    }
    deps.writeConfig(config);
    return { type: "ok", config };
  }

  const result = await deps.cloneRepo(url);
  if (!result.ok) {
    return { type: "error", message: `Failed to clone: ${result.error ?? "unknown error"}` };
  }

  deps.writeConfig(config);
  return { type: "ok", config };
}

export type GitUrlValidationResult =
  | { type: "ok" }
  | { type: "error"; message: string };

export async function runGitUrlValidation(
  url: string,
  deps: Pick<FlowDeps, "checkGitRepoExists">
): Promise<GitUrlValidationResult> {
  const exists = await deps.checkGitRepoExists(url);
  if (!exists.ok) {
    return { type: "error", message: `Cannot reach repository: ${url}` };
  }
  return { type: "ok" };
}

export type AgentDiffEntry = {
  def: AgentDef;
  pathDiffs: SyncPathDiff[];
  remoteCount: number;
  localCount: number;
};

export type SyncPathDiff = {
  path: string;
  localBasePath: string;
  remoteBasePath: string;
  localPath: string;
  remotePath: string;
  status: SyncPathStatus;
  local: SyncPathSnapshot | null;
  remote: SyncPathSnapshot | null;
};

export type SyncLoadResult =
  | { type: "ok"; agentDiffs: AgentDiffEntry[] }
  | { type: "error"; message: string };

export const SYNC_MANIFEST_FILE = ".git-agents-sync.json";

type SyncManifest = {
  version: 1;
  paths: string[];
};

function isSafeManifestPath(path: unknown): path is string {
  if (
    typeof path !== "string" ||
    !path ||
    path.trim() !== path ||
    path.includes("\\") ||
    isAbsolute(path) ||
    /^[A-Za-z]:\//.test(path)
  ) {
    return false;
  }

  return path
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function readSyncManifest(configDir: string): SyncManifest | null {
  const manifestPath = join(configDir, SYNC_MANIFEST_FILE);
  let manifestStat;
  try {
    manifestStat = lstatSync(manifestPath);
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) {
    throw new Error(`${SYNC_MANIFEST_FILE} must be a regular file`);
  }

  let descriptor: number | undefined;
  let text: string;
  try {
    descriptor = openSync(manifestPath, "r");
    const openedStat = fstatSync(descriptor);
    if (
      !openedStat.isFile() ||
      openedStat.dev !== manifestStat.dev ||
      openedStat.ino !== manifestStat.ino
    ) {
      throw new Error(`${SYNC_MANIFEST_FILE} changed while it was being read`);
    }
    text = readFileSync(descriptor, "utf8");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${SYNC_MANIFEST_FILE} is not valid JSON`);
  }

  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== 1 ||
    !("paths" in value) ||
    !Array.isArray(value.paths) ||
    !value.paths.every(isSafeManifestPath)
  ) {
    throw new Error(`${SYNC_MANIFEST_FILE} has an unsupported format`);
  }

  return {
    version: 1,
    paths: [...new Set(value.paths)],
  };
}

function writeSyncManifest(configDir: string, paths: Iterable<string>): void {
  const manifest: SyncManifest = {
    version: 1,
    paths: [...new Set(paths)].sort(),
  };
  const manifestPath = join(configDir, SYNC_MANIFEST_FILE);
  try {
    const existing = lstatSync(manifestPath);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error(`${SYNC_MANIFEST_FILE} must be a regular file`);
    }
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }

  const temporaryPath = join(
    configDir,
    `.${SYNC_MANIFEST_FILE}.git-agents-${randomUUID()}`,
  );
  try {
    writeFileSync(
      temporaryPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    renameSync(temporaryPath, manifestPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function snapshotsMatch(
  first: SyncPathSnapshot | null,
  second: SyncPathSnapshot | null,
): boolean {
  return compareSyncPathSnapshots(first, second) === "unchanged";
}

export async function runSyncLoad(
  mode: "pull" | "push",
  agentDefs: AgentDef[],
  configDir: string,
  deps: Pick<FlowDeps, "gitPull">,
  homeDir: string = homedir(),
): Promise<SyncLoadResult> {
  const pullResult = await deps.gitPull(configDir);
  if (!pullResult.ok) {
    return { type: "error", message: `Failed to pull remote: ${pullResult.error ?? "unknown error"}` };
  }

  const entries: AgentDiffEntry[] = [];
  try {
    const initializedPaths = new Set(readSyncManifest(configDir)?.paths ?? []);

    for (const def of agentDefs) {
      const pathDiffs = def.syncPaths.map((path): SyncPathDiff => {
        const localPath = getLocalSyncPath(path, homeDir);
        const remotePath = getRemoteSyncPath(path, configDir);
        const local = snapshotSyncPath(localPath);
        const remote = snapshotSyncPath(remotePath);
        const source = mode === "pull" ? remote : local;
        const destination = mode === "pull" ? local : remote;
        return {
          path,
          localBasePath: homeDir,
          remoteBasePath: configDir,
          localPath,
          remotePath,
          status: compareSyncPathSnapshots(source, destination),
          local,
          remote,
        };
      });

      const existingPathDiffs = pathDiffs.filter((diff) => {
        const source = mode === "pull" ? diff.remote : diff.local;
        const destination = mode === "pull" ? diff.local : diff.remote;
        return source !== null ||
          (destination !== null && initializedPaths.has(diff.path));
      });
      if (existingPathDiffs.length === 0) continue;

      entries.push({
        def,
        pathDiffs: existingPathDiffs,
        remoteCount: existingPathDiffs.reduce(
          (total, diff) => total + (diff.remote?.fileCount ?? 0),
          0,
        ),
        localCount: existingPathDiffs.reduce(
          (total, diff) => total + (diff.local?.fileCount ?? 0),
          0,
        ),
      });
    }
  } catch (error: any) {
    return {
      type: "error",
      message: `Failed to compare synced paths: ${error.message}`,
    };
  }

  return { type: "ok", agentDiffs: entries };
}

export type SyncExecuteResult =
  | { type: "ok"; message: string }
  | { type: "error"; message: string };

export async function runSyncExecute(
  mode: "pull" | "push",
  agentDiffs: AgentDiffEntry[],
  configDir: string,
  deps: Pick<FlowDeps, "gitAddCommitPush">
): Promise<SyncExecuteResult> {
  const copied = new Set<string>();
  let manifest: SyncManifest | null = null;
  try {
    if (mode === "push") {
      manifest = readSyncManifest(configDir);
    }

    for (const entry of agentDiffs) {
      for (const pathDiff of entry.pathDiffs) {
        const reviewedSides = mode === "pull"
          ? [
              ["Remote", pathDiff.remotePath, pathDiff.remote] as const,
              ["Local", pathDiff.localPath, pathDiff.local] as const,
            ]
          : [
              ["Local", pathDiff.localPath, pathDiff.local] as const,
              ["Remote", pathDiff.remotePath, pathDiff.remote] as const,
            ];

        for (const [side, path, reviewedSnapshot] of reviewedSides) {
          const currentSnapshot = snapshotSyncPath(path);
          if (!snapshotsMatch(currentSnapshot, reviewedSnapshot)) {
            throw new Error(
              `${side} path changed since review: ${pathDiff.path}. ` +
              "Review the changes again before syncing.",
            );
          }
        }
      }
    }

    for (const entry of agentDiffs) {
      for (const pathDiff of entry.pathDiffs) {
        if (pathDiff.status === "unchanged") continue;
        const sourcePath = mode === "pull"
          ? pathDiff.remotePath
          : pathDiff.localPath;
        const sourceBasePath = mode === "pull"
          ? pathDiff.remoteBasePath
          : pathDiff.localBasePath;
        const sourceSnapshot = mode === "pull"
          ? pathDiff.remote
          : pathDiff.local;
        const destinationPath = mode === "pull"
          ? pathDiff.localPath
          : pathDiff.remotePath;
        const destinationBasePath = mode === "pull"
          ? pathDiff.localBasePath
          : pathDiff.remoteBasePath;
        const destinationSnapshot = mode === "pull"
          ? pathDiff.local
          : pathDiff.remote;
        const copyKey = `${sourcePath}\0${destinationPath}`;
        if (copied.has(copyKey)) continue;
        copied.add(copyKey);
        mirrorSyncPath(
          sourcePath,
          destinationPath,
          sourceBasePath,
          destinationBasePath,
          {
            source: sourceSnapshot,
            destination: destinationSnapshot,
          },
        );
      }
    }

    for (const entry of agentDiffs) {
      for (const pathDiff of entry.pathDiffs) {
        const sourcePath = mode === "pull"
          ? pathDiff.remotePath
          : pathDiff.localPath;
        const sourceSnapshot = mode === "pull"
          ? pathDiff.remote
          : pathDiff.local;
        const destinationPath = mode === "pull"
          ? pathDiff.localPath
          : pathDiff.remotePath;
        const currentSource = snapshotSyncPath(sourcePath);
        const currentDestination = snapshotSyncPath(destinationPath);
        if (!snapshotsMatch(currentSource, sourceSnapshot)) {
          throw new Error(
            `Source path changed during sync: ${pathDiff.path}. ` +
            "Review the changes again before syncing.",
          );
        }
        if (!snapshotsMatch(currentDestination, sourceSnapshot)) {
          throw new Error(
            `Destination path changed during sync: ${pathDiff.path}. ` +
            "Review the changes again before syncing.",
          );
        }
      }
    }
  } catch (e: any) {
    return { type: "error", message: `Failed to sync paths: ${e.message}` };
  }

  if (mode === "push") {
    const initializedPaths = new Set(manifest?.paths ?? []);
    for (const entry of agentDiffs) {
      for (const pathDiff of entry.pathDiffs) {
        initializedPaths.add(pathDiff.path);
      }
    }
    const wroteManifest = agentDiffs.length > 0;
    if (wroteManifest) {
      try {
        writeSyncManifest(configDir, initializedPaths);
      } catch (e: any) {
        return {
          type: "error",
          message: `Failed to write sync manifest: ${e.message}`,
        };
      }
    }

    const managedPaths = [
      ...new Set(
        agentDiffs.flatMap((entry) =>
          entry.pathDiffs.map((pathDiff) => pathDiff.path)
        ),
      ),
    ];
    if (wroteManifest) {
      managedPaths.push(SYNC_MANIFEST_FILE);
    }
    const pushResult = await deps.gitAddCommitPush(
      configDir,
      `sync: update harness files from local (${new Date().toISOString().slice(0, 10)})`,
      managedPaths,
    );
    if (!pushResult.ok) {
      return { type: "error", message: `Failed to push: ${pushResult.error ?? "unknown error"}` };
    }
  }

  return {
    type: "ok",
    message: mode === "pull"
      ? "Pull complete! Local files updated."
      : "Push complete! Remote files updated.",
  };
}
