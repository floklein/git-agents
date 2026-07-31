import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { AGENT_DEFS } from "../utils/agentDefs";
import { snapshotSyncPath } from "../utils/agents";
import { CONFIG_DIR, CONFIG_FILE, getLocalSyncPath, readConfig } from "../utils/config";
import { readSyncManifest, type SyncManifest } from "../utils/manifest";
import {
  canonicalCorePath,
  canonicalOverlayPath,
  propagateCanonical,
  type GeneratedTarget,
} from "../canonical/canonical";
import { driftStateOf, gatherDrift, type DriftState } from "../canonical/gather";
import { runApply, runStage } from "../canonical/stage";
import {
  runTransportAbort,
  runTransportBegin,
  runTransportCommit,
  runTransportResolve,
} from "./transport";
import { defaultSetupFlowDeps, runSetup, type SetupFlowDeps } from "./setup";
import { runVersionCheck } from "./versionCheck";
import { detectCaveats, type Caveat } from "./caveats";
import { InternalCommandError } from "./errors";
import type { SyncPathSnapshot } from "../types";

export type InternalDeps = {
  homeDir: string;
  configDir: string;
  configFile: string;
  setup?: SetupFlowDeps;
  // Injectable for tests; version-check falls back to the package version.
  cliVersion?: string;
};

// GIT_AGENTS_HOME / GIT_AGENTS_CONFIG_DIR are unofficial overrides for
// sandboxed end-to-end testing; real runs never set them.
export function defaultInternalDeps(): InternalDeps {
  const homeDir = process.env.GIT_AGENTS_HOME || homedir();
  const configDir = process.env.GIT_AGENTS_CONFIG_DIR || CONFIG_DIR;
  const configFile =
    configDir === CONFIG_DIR ? CONFIG_FILE : join(configDir, "config.json");
  return { homeDir, configDir, configFile };
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
  drift: { files: Record<string, DriftState> };
  caveats: Caveat[];
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

  let manifest: SyncManifest | null = null;
  let manifestError: string | undefined;
  try {
    manifest = readSyncManifest(deps.configDir);
  } catch (error: any) {
    manifestError = error?.message ?? String(error);
  }

  // One gather pass feeds both the generated states and the drift summary,
  // so a single status report cannot disagree with itself.
  const gathered = gatherDrift(deps.configDir, deps.homeDir);
  const canonicalVersion = gathered.canonicalVersion;

  const generated = gathered.files.map((file): GeneratedFileReport => ({
    harness: file.harness,
    syncPath: file.syncPath,
    path: file.path,
    present: file.present,
    state: generatedFileState(
      canonicalVersion,
      file.present,
      gathered.inputs.fileHashes[file.harness] ?? null,
      manifest?.generated?.[file.harness],
    ),
  }));

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
    drift: {
      files: Object.fromEntries(
        gathered.files.map((file) => [file.harness, driftStateOf(file)]),
      ),
    },
    caveats: detectCaveats(deps),
  };
}

const COMMANDS: Record<
  string,
  (deps: InternalDeps, input: unknown) => unknown | Promise<unknown>
> = {
  status: runStatus,
  propagate: (deps) => propagateCanonical(deps.configDir, deps.homeDir),
  gather: (deps) => gatherDrift(deps.configDir, deps.homeDir),
  stage: (deps, input) => runStage(deps.configDir, deps.homeDir, input),
  apply: (deps) => runApply(deps.configDir, deps.homeDir),
  "transport-begin": (deps) => runTransportBegin(deps),
  "transport-resolve": (deps, input) => runTransportResolve(deps, input),
  "transport-commit": (deps, input) => runTransportCommit(deps, input),
  "transport-abort": (deps) => runTransportAbort(deps),
  setup: (deps, input) =>
    runSetup(deps, input, deps.setup ?? defaultSetupFlowDeps(deps)),
  "version-check": (deps, input) => runVersionCheck(deps, input),
  "install-pointer-docs": (deps) => ({
    settingsPath: "Cursor Settings > Rules > User Rules",
    rule:
      `At the start of each session, read the file ${canonicalCorePath(deps.configDir)} ` +
      `and follow its contents as global instructions. If ${canonicalOverlayPath(deps.configDir, "cursor")} ` +
      "exists, read and follow it as well.",
  }),
};

export async function runInternalCommand(
  name: string,
  input: unknown,
  deps: InternalDeps,
): Promise<InternalOutcome> {
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
    return { ok: true, result: await command(deps, input) };
  } catch (error: any) {
    return {
      ok: false,
      error: {
        code: error instanceof InternalCommandError ? error.code : "command-failed",
        message: error?.message ?? String(error),
      },
    };
  }
}
