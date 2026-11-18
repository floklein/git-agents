import { harnessPaths, type Harness } from "./harnessSet";

/** One transported path and the harness that declares it. */
export type DeclaredPath = {
  /** The harness id. */
  harness: string;
  name: string;
  path: string;
};

// One owner per path is judged case-insensitively, so identity is too.
function pathKey(path: string): string {
  return path.toLowerCase();
}

/** Every path a harness set transports, in set order. */
export function declaredPaths(set: readonly Harness[]): DeclaredPath[] {
  return set.flatMap((harness) =>
    harnessPaths(harness).map((path) => ({
      harness: harness.id,
      name: harness.name,
      path,
    })),
  );
}

/**
 * The paths `set` declares and `other` does not. With the remote's set and the
 * merge base's, these are the paths the remote newly declares; with the
 * arguments swapped, the paths it removed.
 */
export function pathsOnlyIn(
  set: readonly Harness[],
  other: readonly Harness[],
): DeclaredPath[] {
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
