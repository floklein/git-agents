import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { getLocalSyncPath } from "../utils/config";
import { pathsOnlyIn, type HarnessPath } from "../utils/declaredPaths";
import {
  DECLARATIONS_VERSION,
  HARNESS_DECLARATIONS_FILE,
  parseHarnessDeclarations,
  readDeclarationsFile,
  validateHarnessDeclarations,
  type CustomHarness,
  type DeclarationProblem,
} from "../utils/harnessDeclarations";
import { buildHarnessSet, listDeclarationProblems } from "../utils/harnessSet";
import { measureSyncPath } from "../utils/pathSize";
import { unifiedDiff } from "../utils/textdiff";
import {
  applyRemoval,
  planRemoval,
  removesNothing,
  type RemovalPlan,
} from "./declarationRemoval";
import { InternalCommandError, invalidInputError } from "./errors";
import { requireClone } from "./git";
import type { InternalDeps } from "./commands";

/** Machine-local, like the canonical stage file: never in the commit scope. */
export const HARNESS_STAGE_FILE = ".git-agents-harness-stage.json";

/** A path that stops syncing, and where in its declaration it was. */
export type StopSyncingPath = Omit<HarnessPath, "name">;

/** A path that starts syncing, with what the home directory holds there. */
export type StartSyncingPath = StopSyncingPath & {
  present: boolean;
  fileCount: number;
  totalBytes: number;
};

/**
 * What a removal deletes from the sync repo, and only from there: previewed
 * by `harness-stage`, reported again by `harness-apply` once it is done.
 */
export type RemovalReport = Pick<
  RemovalPlan,
  | "harnesses"
  | "repoFiles"
  | "overlays"
  | "manifest"
  | "canonicalVersionChanges"
>;

export type RemovalPreview = RemovalReport & {
  /** The statement that goes with every removal. */
  homeFiles: string;
};

const HOME_FILES_STAY =
  "Files in the home directory are left untouched, on this machine and on every machine that pulls the removal.";

export type HarnessStageResult = {
  /** The exact diff of the declarations file `harness-apply` would write. */
  file: { path: string; changed: boolean; diff: string };
  startSyncing: StartSyncingPath[];
  stopSyncing: StopSyncingPath[];
  /**
   * The repo cleanup `harness-apply` would make, when the proposal removes a
   * harness or a path. Absent when the current file is invalid: there is no
   * known set to clean up from.
   */
  removal?: RemovalPreview;
  /**
   * What makes the current file invalid, when it is: the proposal replaces
   * it whole. An invalid file counts as declaring nothing for the two lists.
   */
  currentProblems: DeclarationProblem[];
};

// The complete proposed set, `{"harnesses": {...}}`, as any JSON object: what
// it holds is judged by the declarations validator, which names every problem.
const StageInputSchema = z.object({}).passthrough();

const StageFileSchema = z.object({
  version: z.literal(1),
  /** The exact text to write; null when no file is to be created. */
  content: z.string().nullable(),
  /** The hash of the declarations file at staging; null when it was absent. */
  baseHash: z.string().nullable(),
});

type StageFileContent = z.infer<typeof StageFileSchema>;

/**
 * The raw declarations file of the clone, or null when there is none. A link
 * or a directory at its place is refused: writing through a link could land
 * outside the clone.
 */
function readCurrentFile(configDir: string): Buffer | null {
  const file = readDeclarationsFile(configDir);
  if (file.state === "not-regular") {
    throw new InternalCommandError(
      "harness-file-not-regular",
      `${HARNESS_DECLARATIONS_FILE} in the sync repo is a link or a directory, not a regular file. ` +
        `Remedy: remove ${join(configDir, HARNESS_DECLARATIONS_FILE)} by hand, then run harness-stage again.`,
    );
  }
  return file.state === "present" ? file.bytes : null;
}

// The custom harnesses the current file declares. An absent file declares
// none; an invalid one gives its problems.
function parseCurrentFile(
  file: Buffer | null,
): ReturnType<typeof parseHarnessDeclarations> {
  return file === null
    ? { ok: true, harnesses: [] }
    : parseHarnessDeclarations(file.toString("utf8"));
}

function hashOf(file: Buffer | null): string | null {
  return file === null ? null : createHash("sha256").update(file).digest("hex");
}

// Normalized like the canonical stage: a CRLF checkout is not a content change.
function textOf(file: Buffer | null): string {
  return file === null ? "" : file.toString("utf8").replace(/\r\n/g, "\n");
}

/**
 * The declarations file for a validated proposal: `version` first, harnesses
 * sorted by id, each with its fields in a fixed order, so the same set always
 * yields the same file.
 */
function renderDeclarationsFile(harnesses: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {};
  for (const id of Object.keys(harnesses).sort()) {
    const { name, instructionsFile, syncPaths } = harnesses[id] as Record<
      string,
      unknown
    >;
    sorted[id] = {
      ...(name !== undefined ? { name } : {}),
      ...(instructionsFile !== undefined ? { instructionsFile } : {}),
      ...(syncPaths !== undefined ? { syncPaths } : {}),
    };
  }
  return `${JSON.stringify({ version: DECLARATIONS_VERSION, harnesses: sorted }, null, 2)}\n`;
}

// The paths `harnesses` declares and `others` does not, whoever declares them
// there, as `harness-stage` reports them.
function pathsNotIn(
  harnesses: readonly CustomHarness[],
  others: readonly CustomHarness[],
): StopSyncingPath[] {
  return pathsOnlyIn(buildHarnessSet(harnesses), buildHarnessSet(others)).map(
    ({ harness, field, path }) => ({ harness, field, path }),
  );
}

// The cleanup that goes with replacing one set of declarations by another, or
// null when the sync repo keeps everything.
function removalBetween(
  configDir: string,
  before: readonly CustomHarness[],
  after: readonly CustomHarness[],
): { report: RemovalReport; apply: () => void } | null {
  const kept = buildHarnessSet(after);
  const plan = planRemoval(configDir, buildHarnessSet(before), kept);
  if (removesNothing(plan)) return null;
  const { harnesses, repoFiles, overlays, manifest, canonicalVersionChanges } =
    plan;
  return {
    report: { harnesses, repoFiles, overlays, manifest, canonicalVersionChanges },
    apply: () => applyRemoval(configDir, plan, kept),
  };
}

/**
 * Validates the complete proposed set of custom harness declarations and
 * previews the declarations file `harness-apply` would write. Writes only
 * its own staged state, in the clone.
 */
export function runHarnessStage(
  deps: InternalDeps,
  rawInput: unknown,
): HarnessStageResult {
  requireClone(deps.configDir);
  // A rejected proposal must not leave an earlier one for harness-apply.
  rmSync(join(deps.configDir, HARNESS_STAGE_FILE), { force: true });
  const parsed = StageInputSchema.safeParse(rawInput);
  if (!parsed.success) throw invalidInputError("harness-stage", parsed.error);
  const input = parsed.data;

  // The scripts own `version`: a proposal carries the harnesses alone.
  const proposed = validateHarnessDeclarations({
    version: DECLARATIONS_VERSION,
    ...input,
  });
  if (!proposed.ok) {
    throw new InternalCommandError(
      "invalid-harness-proposal",
      "The proposed harness declarations are invalid; nothing was written. " +
        `Problems:\n${listDeclarationProblems(proposed.problems)}\n` +
        "Remedy: correct the proposal and run harness-stage again.",
    );
  }

  const currentFile = readCurrentFile(deps.configDir);
  const current = parseCurrentFile(currentFile);
  const currentHarnesses = current.ok ? current.harnesses : [];

  // The scripts never create the file before the first declaration.
  const content =
    currentFile === null && proposed.harnesses.length === 0
      ? null
      : renderDeclarationsFile(input.harnesses as Record<string, unknown>);

  const before = textOf(currentFile);
  const after = content ?? "";
  const removal = current.ok
    ? removalBetween(deps.configDir, current.harnesses, proposed.harnesses)
    : null;

  const result: HarnessStageResult = {
    file: {
      path: HARNESS_DECLARATIONS_FILE,
      changed: before !== after,
      diff: unifiedDiff(before, after, HARNESS_DECLARATIONS_FILE),
    },
    startSyncing: pathsNotIn(proposed.harnesses, currentHarnesses).map(
      (entry) => {
        const size = measureSyncPath(getLocalSyncPath(entry.path, deps.homeDir));
        return {
          ...entry,
          present: size !== null,
          fileCount: size?.fileCount ?? 0,
          totalBytes: size?.totalBytes ?? 0,
        };
      },
    ),
    stopSyncing: pathsNotIn(currentHarnesses, proposed.harnesses),
    ...(removal !== null
      ? { removal: { ...removal.report, homeFiles: HOME_FILES_STAY } }
      : {}),
    currentProblems: current.ok ? [] : current.problems,
  };

  // Last, so a failed preview leaves nothing staged.
  const stageFile: StageFileContent = {
    version: 1,
    content,
    baseHash: hashOf(currentFile),
  };
  writeFileSync(
    join(deps.configDir, HARNESS_STAGE_FILE),
    `${JSON.stringify(stageFile, null, 2)}\n`,
    "utf8",
  );

  return result;
}

export type HarnessApplyResult = {
  path: string;
  written: boolean;
  /**
   * What the write removed from the sync repo clone, when it removed a
   * harness or a path: what `harness-stage` previewed. Nothing is committed:
   * the next `transport-begin` commits it with the declarations file.
   */
  removed?: RemovalReport;
};

function readStageFile(configDir: string): StageFileContent {
  const stagePath = join(configDir, HARNESS_STAGE_FILE);
  if (!existsSync(stagePath)) {
    throw new InternalCommandError(
      "no-harness-stage",
      "Nothing is staged. Run harness-stage with a proposal before harness-apply.",
    );
  }
  let staged: unknown;
  try {
    staged = JSON.parse(readFileSync(stagePath, "utf8"));
  } catch {
    staged = undefined;
  }
  const parsed = StageFileSchema.safeParse(staged);
  // What is written is checked again: the staged state is a plain file.
  if (
    !parsed.success ||
    (parsed.data.content !== null &&
      !parseHarnessDeclarations(parsed.data.content).ok)
  ) {
    throw new InternalCommandError(
      "invalid-harness-stage",
      `${HARNESS_STAGE_FILE} is not a staged proposal this git-agents can apply. Run harness-stage again.`,
    );
  }
  return parsed.data;
}

/**
 * Writes the staged declarations file in the clone. When that removes a
 * harness or a path, it also makes the repo cleanup there: the mirrored
 * files, the overlay and the manifest entries. It never touches the home
 * directory. Refuses when nothing is staged or the file changed since staging.
 */
export function runHarnessApply(deps: InternalDeps): HarnessApplyResult {
  requireClone(deps.configDir);
  const staged = readStageFile(deps.configDir);

  const currentFile = readCurrentFile(deps.configDir);
  if (hashOf(currentFile) !== staged.baseHash) {
    throw new InternalCommandError(
      "stale-harness-stage",
      `${HARNESS_DECLARATIONS_FILE} changed since it was staged. Run harness-stage again and review the new diff.`,
    );
  }

  const written =
    staged.content !== null &&
    (currentFile === null || textOf(currentFile) !== staged.content);
  let removal: ReturnType<typeof removalBetween> = null;
  if (written) {
    // Planned from the file being replaced, before it is gone. An invalid one
    // gives no set to clean up from.
    const before = parseCurrentFile(currentFile);
    const after = parseHarnessDeclarations(staged.content!);
    if (before.ok && after.ok) {
      removal = removalBetween(deps.configDir, before.harnesses, after.harnesses);
    }
    writeFileSync(
      join(deps.configDir, HARNESS_DECLARATIONS_FILE),
      staged.content!,
      "utf8",
    );
    removal?.apply();
  }
  rmSync(join(deps.configDir, HARNESS_STAGE_FILE), { force: true });

  return {
    path: HARNESS_DECLARATIONS_FILE,
    written,
    ...(removal !== null ? { removed: removal.report } : {}),
  };
}
