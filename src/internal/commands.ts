import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { AGENT_DEFS } from "../utils/agentDefs";
import { snapshotSyncPath } from "../utils/agents";
import { CONFIG_DIR, CONFIG_FILE, getLocalSyncPath, readConfig } from "../utils/config";
import type { SyncPathSnapshot } from "../types";

export type InternalDeps = {
  homeDir: string;
  configDir: string;
  configFile: string;
};

export function defaultInternalDeps(): InternalDeps {
  return { homeDir: homedir(), configDir: CONFIG_DIR, configFile: CONFIG_FILE };
}

export type InternalError = { code: string; message: string };

export type InternalOutcome =
  | { ok: true; result: unknown }
  | { ok: false; error: InternalError };

type SyncPathReport = {
  syncPath: string;
  path: string;
  present: boolean;
  kind?: SyncPathSnapshot["kind"];
  fileCount?: number;
  contentHash?: string;
};

type HarnessReport = {
  id: string;
  name: string;
  syncPaths: SyncPathReport[];
};

export type StatusReport = {
  configured: boolean;
  config: ReturnType<typeof readConfig>;
  clonePresent: boolean;
  canonicalVersion: null;
  harnesses: HarnessReport[];
  drift: { available: false; reason: string };
};

function runStatus(deps: InternalDeps): StatusReport {
  const config = readConfig(deps.configFile);
  const clonePresent = existsSync(join(deps.configDir, ".git"));

  const harnesses = AGENT_DEFS.map((def): HarnessReport => ({
    id: def.id,
    name: def.name,
    syncPaths: def.syncPaths.map((syncPath): SyncPathReport => {
      const path = getLocalSyncPath(syncPath, deps.homeDir);
      const snapshot = snapshotSyncPath(path);
      return snapshot
        ? {
            syncPath,
            path,
            present: true,
            kind: snapshot.kind,
            fileCount: snapshot.fileCount,
            contentHash: snapshot.contentHash,
          }
        : { syncPath, path, present: false };
    }),
  }));

  return {
    configured: config !== null,
    config,
    clonePresent,
    canonicalVersion: null,
    harnesses,
    drift: { available: false, reason: "Canonical model not implemented yet" },
  };
}

const COMMANDS: Record<string, (deps: InternalDeps, input: unknown) => unknown> = {
  status: runStatus,
};

export function runInternalCommand(
  name: string,
  input: unknown,
  deps: InternalDeps,
): InternalOutcome {
  const command = COMMANDS[name];
  if (!command) {
    return {
      ok: false,
      error: {
        code: "unknown-command",
        message: `Unknown internal command: ${name}. Known commands: ${Object.keys(COMMANDS).join(", ")}`,
      },
    };
  }
  try {
    return { ok: true, result: command(deps, input) };
  } catch (error: any) {
    return {
      ok: false,
      error: {
        code: "command-failed",
        message: error?.message ?? String(error),
      },
    };
  }
}
