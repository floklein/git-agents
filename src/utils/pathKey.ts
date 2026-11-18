// How declared paths compare. The home directory is case-insensitive on
// Windows and macOS, so `.SSH` is `.ssh` there: one owner per path is judged
// case-insensitively, and so is every other comparison of declared paths.

/** The identity of a declared path, for sets and equality. */
export function pathKey(path: string): string {
  return path.toLowerCase();
}

/** Whether `path` is `parent` or lies inside it, compared by `pathKey`. */
export function isAtOrInside(path: string, parent: string): boolean {
  const key = pathKey(path);
  const parentKey = pathKey(parent);
  return key === parentKey || key.startsWith(`${parentKey}/`);
}

/**
 * The one sort order of ids and paths in results: by UTF-16 code unit, as
 * `Array.prototype.sort` orders strings, so it is the same on every machine.
 */
export function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
