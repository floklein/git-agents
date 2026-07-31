import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { AGENT_DEFS } from "../utils/agentDefs";
import { snapshotSyncPath } from "../utils/agents";
import { CONFIG_DIR, CONFIG_FILE, getLocalSyncPath, readConfig } from "../utils/config";
import { readSyncManifest, type SyncManifest } from "../utils/manifest";
import {
  GENERATED_TARGETS,
  hashContent,
  propagateCanonical,
  readCanonical,
  type GeneratedTarget,
} from "../canonical/canonical";
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

export type GeneratedFileState =
  | "no-canonical"
  | "missing"
  | "untracked"
  | "modified"
  | "stale"
  | "current";

export type GeneratedFileReport = {
  harness: GeneratedTarget["harness"];
  syncPath: string;
  path: string;
  present: boolean;
  state: GeneratedFileState;
};

export type StatusReport = {
  configured: boolean;
  config: ReturnType<typeof readConfig>;
  clonePresent: boolean;
  canonicalVersion: string | null;
  generated: GeneratedFileReport[];
  manifestError?: string;
  harnesses: HarnessReport[];
  drift: { available: false; reason: string };
};

function generatedFileState(
  canonicalVersion: string | null,
  present: boolean,
  fileHash: string | null,
  manifestEntry: { hash: string; canonicalVersion: string } | undefined,
): GeneratedFileState {
  if (canonicalVersion === null) return "no-canonical";
  if (!present) return "missing";
  if (!manifestEntry) return "untracked";
  if (fileHash !== manifestEntry.hash) return "modified";
  if (manifestEntry.canonicalVersion !== canonicalVersion) return "stale";
  return "current";
}

function runStatus(deps: InternalDeps): StatusReport {
  const config = readConfig(deps.configFile);
  const clonePresent = existsSync(join(deps.configDir, ".git"));

  const canonical = readCanonical(deps.configDir);
  const canonicalVersion = canonical?.version ?? null;

  let manifest: SyncManifest | null = null;
  let manifestError: string | undefined;
  try {
    manifest = readSyncManifest(deps.configDir);
  } catch (error: any) {
    manifestError = error?.message ?? String(error);
  }

  const generated = GENERATED_TARGETS.map((target): GeneratedFileReport => {
    const path = getLocalSyncPath(target.syncPath, deps.homeDir);
    const present = existsSync(path);
    const fileHash = present ? hashContent(readFileSync(path, "utf8")) : null;
    return {
      harness: target.harness,
      syncPath: target.syncPath,
      path,
      present,
      state: generatedFileState(
        canonicalVersion,
        present,
        fileHash,
        manifest?.generated?.[target.harness],
      ),
    };
  });

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
    canonicalVersion,
    generated,
    ...(manifestError !== undefined ? { manifestError } : {}),
    harnesses,
    drift: { available: false, reason: "Drift detection not implemented yet" },
  };
}

const COMMANDS: Record<string, (deps: InternalDeps, input: unknown) => unknown> = {
  status: runStatus,
  propagate: (deps) => propagateCanonical(deps.configDir, deps.homeDir),
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
