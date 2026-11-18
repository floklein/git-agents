import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { snapshotSyncPath } from "../utils/agents";
import { getLocalSyncPath } from "../utils/config";

// What the home directory held after this machine's last completed sync.
// Deletion detection needs exactly this per-machine memory: the home dir
// is not git-tracked, so the clone's history cannot answer "did this
// machine ever have that file", and without it a fresh machine's empty
// home would read as a mass deletion.
export const LAST_SYNC_FILE = ".git-agents-last-sync.json";

export function readLastSyncedPaths(configDir: string): Set<string> {
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

function writeRecord(configDir: string, paths: string[]): void {
  writeFileSync(
    join(configDir, LAST_SYNC_FILE),
    `${JSON.stringify({ version: 1, paths }, null, 2)}\n`,
    "utf8",
  );
}

export function writeLastSyncedPaths(
  deps: { homeDir: string; configDir: string },
  syncPaths: string[],
): void {
  writeRecord(
    deps.configDir,
    syncPaths.filter(
      (syncPath) =>
        snapshotSyncPath(getLocalSyncPath(syncPath, deps.homeDir)) !== null,
    ),
  );
}

/**
 * Drops paths from the record, so that their files missing from the sync repo
 * are never read as a deletion to carry out in the home directory. For paths
 * whose repo copies a removed declaration deleted. A machine that never
 * completed a sync has no record, and none is created.
 */
export function forgetLastSyncedPaths(
  configDir: string,
  syncPaths: readonly string[],
): void {
  const recorded = readLastSyncedPaths(configDir);
  const forgotten = new Set(syncPaths.map((path) => path.toLowerCase()));
  const kept = [...recorded].filter(
    (path) => !forgotten.has(path.toLowerCase()),
  );
  if (kept.length !== recorded.size) writeRecord(configDir, kept);
}
