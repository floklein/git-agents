import type { HarnessPathField } from "./harnessDeclarations";
import type { Harness } from "./harnessSet";
import { pathKey } from "./pathKey";

/**
 * One transported path, with the harness that declares it (id and name) and
 * the field of the declaration that holds it. Results report the parts they
 * need: the gate names the harness, `harness-stage` gives the field.
 */
export type HarnessPath = {
  /** The harness id. */
  harness: string;
  name: string;
  field: HarnessPathField;
  path: string;
};

/** Every path a harness set transports, in set order, instructions file first. */
export function declaredPaths(set: readonly Harness[]): HarnessPath[] {
  return set.flatMap((harness): HarnessPath[] => {
    const owner = { harness: harness.id, name: harness.name };
    return [
      ...(harness.instructionsFile !== undefined
        ? [{ ...owner, field: "instructionsFile" as const, path: harness.instructionsFile }]
        : []),
      ...harness.syncPaths.map((path) => ({ ...owner, field: "syncPaths" as const, path })),
    ];
  });
}

/**
 * The paths `set` declares and `other` does not, whoever declares them. With
 * the remote's set and the merge base's, these are the paths the remote newly
 * declares; with the arguments swapped, the paths it removed. A path that
 * moves to another harness or field is in neither direction.
 */
export function pathsOnlyIn(
  set: readonly Harness[],
  other: readonly Harness[],
): HarnessPath[] {
  const known = new Set(declaredPaths(other).map(({ path }) => pathKey(path)));
  return declaredPaths(set).filter(({ path }) => !known.has(pathKey(path)));
}

/** The first of each path, compared the way ownership is. */
export function uniquePaths<T extends { path: string }>(
  entries: readonly T[],
): T[] {
  const seen = new Set<string>();
  return entries.filter(({ path }) => {
    const key = pathKey(path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** A path as the gate lists it: the harness by id and name. */
export function namedPath({
  harness,
  name,
  path,
}: HarnessPath): Omit<HarnessPath, "field"> {
  return { harness, name, path };
}
