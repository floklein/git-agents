import { join } from "node:path";
import { InternalCommandError } from "../internal/errors";
import { AGENT_DEFS, BUILT_IN_CONVERGENCE } from "./agentDefs";
import {
  HARNESS_DECLARATIONS_FILE,
  readHarnessDeclarations,
  type CustomHarness,
  type DeclarationProblem,
} from "./harnessDeclarations";
import { byCodeUnit } from "./pathKey";

/**
 * One harness of the set, built-in or custom, in the declaration shape:
 * `syncPaths` never repeats `instructionsFile`. Use `harnessPaths` for
 * everything a harness transports.
 */
export type Harness = {
  /** The id used by transport and reports. */
  id: string;
  name: string;
  builtIn: boolean;
  /**
   * The id used for the overlay file, the `harness=` marker and the manifest
   * keys. It differs from `id` only for built-ins (`claude-code` is `claude`).
   */
  overlayId: string;
  instructionsFile?: string;
  syncPaths: string[];
};

export type HarnessSetResult =
  | { ok: true; harnesses: Harness[] }
  | { ok: false; problems: DeclarationProblem[] };

export const INVALID_HARNESS_DECLARATIONS = "invalid-harness-declarations";

/** The built-in harnesses, in their fixed order. */
export const BUILT_IN_HARNESSES: readonly Harness[] = AGENT_DEFS.map((def) => {
  const convergence: { overlayId?: string; instructionsFile?: string } =
    BUILT_IN_CONVERGENCE.find(({ harness }) => harness === def.id) ?? {};
  const { overlayId = def.id, instructionsFile } = convergence;
  const harness: Harness = {
    id: def.id,
    name: def.name,
    builtIn: true,
    overlayId,
    syncPaths: def.syncPaths.filter((path) => path !== instructionsFile),
  };
  if (instructionsFile !== undefined) harness.instructionsFile = instructionsFile;
  return harness;
});

/** The full ordered set: built-ins first, then custom harnesses sorted by id. */
export function buildHarnessSet(custom: readonly CustomHarness[]): Harness[] {
  return [
    ...BUILT_IN_HARNESSES,
    ...[...custom]
      .sort((a, b) => byCodeUnit(a.id, b.id))
      .map((harness): Harness => ({
        id: harness.id,
        name: harness.name,
        builtIn: false,
        overlayId: harness.id,
        ...(harness.instructionsFile !== undefined
          ? { instructionsFile: harness.instructionsFile }
          : {}),
        syncPaths: harness.syncPaths,
      })),
  ];
}

/**
 * The harness set of a sync repo clone: the built-ins plus the harnesses its
 * declarations file declares, or the problems that make that file invalid.
 * An invalid file yields no set at all, never the built-ins alone. Never
 * throws.
 */
export function readHarnessSet(configDir: string): HarnessSetResult {
  const declared = readHarnessDeclarations(configDir);
  if (!declared.ok) return declared;
  return { ok: true, harnesses: buildHarnessSet(declared.harnesses) };
}

/** Every path a harness transports: its instructions file, then its sync paths. */
export function harnessPaths(harness: Harness): string[] {
  return harness.instructionsFile !== undefined
    ? [harness.instructionsFile, ...harness.syncPaths]
    : [...harness.syncPaths];
}

/** One line per problem, for an error or a caveat message. */
export function listDeclarationProblems(
  problems: readonly DeclarationProblem[],
): string {
  return problems.map((problem) => `- ${problem.message}`).join("\n");
}

/** The refusal every command gives while the declarations file is invalid. */
export function invalidHarnessDeclarationsError(
  problems: readonly DeclarationProblem[],
  configDir: string,
): InternalCommandError {
  return new InternalCommandError(
    INVALID_HARNESS_DECLARATIONS,
    `${HARNESS_DECLARATIONS_FILE} is invalid: no harness is processed until it is fixed, ` +
      "the built-in ones included. " +
      `Problems:\n${listDeclarationProblems(problems)}\n` +
      `Remedy: fix the file with /git-agents harness, or edit ${join(configDir, HARNESS_DECLARATIONS_FILE)} ` +
      "in the sync repo, then run this again.",
  );
}

/** The harness set, or the `invalid-harness-declarations` refusal. */
export function requireHarnessSet(configDir: string): Harness[] {
  const set = readHarnessSet(configDir);
  if (!set.ok) throw invalidHarnessDeclarationsError(set.problems, configDir);
  return set.harnesses;
}
