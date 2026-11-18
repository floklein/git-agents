import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { getLocalSyncPath } from "../utils/config";
import {
  HARNESS_DECLARATIONS_FILE,
  parseHarnessDeclarations,
  validateHarnessDeclarations,
  type CustomHarness,
  type DeclarationProblem,
} from "../utils/harnessDeclarations";
import { listDeclarationProblems } from "../utils/harnessSet";
import { measureSyncPath } from "../utils/pathSize";
import { unifiedDiff } from "../utils/textdiff";
import { InternalCommandError } from "./errors";
import type { InternalDeps } from "./commands";

/** Machine-local, like the canonical stage file: never in the commit scope. */
export const HARNESS_STAGE_FILE = ".git-agents-harness-stage.json";

const DECLARATIONS_VERSION = 1;

export type HarnessPathField = "instructionsFile" | "syncPaths";

/** One path a custom harness declares, and where in its declaration. */
export type DeclaredPath = {
  harness: string;
  field: HarnessPathField;
  path: string;
};

/** A path that starts syncing, with what the home directory holds there. */
export type StartSyncingPath = DeclaredPath & {
  present: boolean;
  fileCount: number;
  totalBytes: number;
};

export type HarnessStageResult = {
  /** The exact diff of the declarations file `harness-apply` would write. */
  file: { path: string; changed: boolean; diff: string };
  startSyncing: StartSyncingPath[];
  stopSyncing: DeclaredPath[];
  /**
   * What makes the current file invalid, when it is: the proposal replaces
   * it whole. An invalid file counts as declaring nothing for the two lists.
   */
  currentProblems: DeclarationProblem[];
};

const StageFileSchema = z.object({
  version: z.literal(1),
  /** The exact text to write; null when no file is to be created. */
  content: z.string().nullable(),
  /** The hash of the declarations file at staging; null when it was absent. */
  baseHash: z.string().nullable(),
});

type StageFileContent = z.infer<typeof StageFileSchema>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireClone(configDir: string): void {
  if (!existsSync(join(configDir, ".git"))) {
    throw new InternalCommandError(
      "not-configured",
      "No sync repository found. Run the setup subcommand first.",
    );
  }
}

/**
 * The raw declarations file of the clone, or null when there is none. A link
 * or a directory at its place is refused: writing through a link could land
 * outside the clone.
 */
function readCurrentFile(configDir: string): Buffer | null {
  const filePath = join(configDir, HARNESS_DECLARATIONS_FILE);
  let stat;
  try {
    stat = lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new InternalCommandError(
      "harness-file-not-regular",
      `${HARNESS_DECLARATIONS_FILE} in the sync repo is a link or a directory, not a regular file. ` +
        `Remedy: remove ${filePath} by hand, then run harness-stage again.`,
    );
  }
  return readFileSync(filePath);
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

function declaredPaths(harnesses: readonly CustomHarness[]): DeclaredPath[] {
  return harnesses.flatMap((harness): DeclaredPath[] => [
    ...(harness.instructionsFile !== undefined
      ? [
          {
            harness: harness.id,
            field: "instructionsFile" as const,
            path: harness.instructionsFile,
          },
        ]
      : []),
    ...harness.syncPaths.map((path) => ({
      harness: harness.id,
      field: "syncPaths" as const,
      path,
    })),
  ]);
}

/** The entries of `paths` whose path is not among `others`. */
function pathsNotIn(
  paths: readonly DeclaredPath[],
  others: readonly DeclaredPath[],
): DeclaredPath[] {
  const known = new Set(others.map((other) => other.path));
  return paths.filter((entry) => !known.has(entry.path));
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
  if (!isPlainObject(rawInput)) {
    throw new InternalCommandError(
      "invalid-input",
      'harness-stage input must be the complete proposed set: {"harnesses": {...}}',
    );
  }

  // The scripts own `version`: a proposal carries the harnesses alone.
  const proposed = validateHarnessDeclarations({
    version: DECLARATIONS_VERSION,
    ...rawInput,
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
  const current =
    currentFile === null
      ? { ok: true as const, harnesses: [] }
      : parseHarnessDeclarations(currentFile.toString("utf8"));

  // The scripts never create the file before the first declaration.
  const content =
    currentFile === null && proposed.harnesses.length === 0
      ? null
      : renderDeclarationsFile(rawInput.harnesses as Record<string, unknown>);

  const before = textOf(currentFile);
  const after = content ?? "";
  const proposedPaths = declaredPaths(proposed.harnesses);
  const currentPaths = declaredPaths(current.ok ? current.harnesses : []);

  const result: HarnessStageResult = {
    file: {
      path: HARNESS_DECLARATIONS_FILE,
      changed: before !== after,
      diff: unifiedDiff(before, after, HARNESS_DECLARATIONS_FILE),
    },
    startSyncing: pathsNotIn(proposedPaths, currentPaths).map((entry) => {
      const size = measureSyncPath(getLocalSyncPath(entry.path, deps.homeDir));
      return {
        ...entry,
        present: size !== null,
        fileCount: size?.fileCount ?? 0,
        totalBytes: size?.totalBytes ?? 0,
      };
    }),
    stopSyncing: pathsNotIn(currentPaths, proposedPaths),
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
 * Writes the staged declarations file in the clone, and nothing else.
 * Refuses when nothing is staged or the file changed since staging.
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
  if (written) {
    writeFileSync(
      join(deps.configDir, HARNESS_DECLARATIONS_FILE),
      staged.content!,
      "utf8",
    );
  }
  rmSync(join(deps.configDir, HARNESS_STAGE_FILE), { force: true });

  return { path: HARNESS_DECLARATIONS_FILE, written };
}
