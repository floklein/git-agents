import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The file of the sync repo where users add their own excludes. It is
 * committed and merged like the declarations file, so every machine applies
 * the same list: an exclude that held on one machine only would have the
 * others put the excluded files back.
 */
export const EXCLUDES_FILE = ".git-agents-excludes";

/**
 * What no sync ever carries: folders and files that a tool manages per
 * machine and regenerates on its own. Patterns follow the syntax of
 * `compileExcludes`.
 */
export const BUILT_IN_EXCLUDES: readonly string[] = [
  // Claude Code's claude.ai skill sync: its manifest, its staging area and
  // its copies of the synced skills, which each machine's app rebuilds.
  ".claude/skills/synced",
  // Trash folders, such as Claude Code's `.claude/skills/.trash`.
  ".trash",
  // Staging areas of tools that write in steps.
  ".staging",
  // Codex's bundled system skills, which Codex rewrites on every update.
  ".codex/skills/.system",
  // What a skill installs or builds where it runs: dependencies and caches
  // tied to one machine's platform and runtime, never portable content.
  "node_modules",
  "__pycache__",
  ".venv",
  // A skill cloned with git: its repository metadata is per machine, and git
  // cannot commit a repository inside the sync repo anyway.
  ".git",
  // Files the operating system leaves in folders.
  ".DS_Store",
  "._*",
  "Thumbs.db",
  "desktop.ini",
  // The temporary names mirroring itself uses beside a path it replaces.
  ".*.git-agents-incoming-*",
  ".*.git-agents-backup-*",
];

/**
 * Whether a path relative to the home directory, `/`-separated, is excluded:
 * matched by a pattern, or inside a path that is.
 */
export type ExcludeMatcher = (homePath: string) => boolean;

/**
 * Whether a path relative to some root, `/`-separated, is excluded. What
 * snapshotting and mirroring take: they only know the paths below the sync
 * path they work on.
 */
export type PathFilter = (relativePath: string) => boolean;

function escapeRegExp(text: string): string {
  return text.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

function globToRegExpSource(glob: string): string {
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    if (char === "*") {
      if (glob[index + 1] === "*") {
        // `**/` is any number of whole segments, a trailing `**` anything.
        if (glob[index + 2] === "/") {
          source += "(?:[^/]+/)*";
          index += 2;
        } else {
          source += ".*";
          index += 1;
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += escapeRegExp(char);
    }
  }
  return source;
}

/**
 * Compiles exclude patterns, a subset of the gitignore syntax:
 *
 * - A pattern without a `/` matches a file or folder of that name at any
 *   depth, e.g. `.DS_Store`.
 * - A pattern with a `/` matches from the home directory, e.g.
 *   `.claude/skills/synced`; a leading `/` only marks it as such.
 * - `*` matches within one path segment, `?` one character, `**` any number
 *   of segments.
 *
 * A match excludes the path and everything inside it. Matching ignores case,
 * as path comparisons do everywhere else.
 */
export function compileExcludes(patterns: readonly string[]): ExcludeMatcher {
  const expressions = patterns
    .map((pattern) => pattern.trim().replace(/\\/g, "/").replace(/\/+$/, ""))
    .filter((pattern) => pattern !== "" && pattern !== "/")
    .map((pattern) => {
      const anchored = pattern.includes("/");
      const body = globToRegExpSource(pattern.replace(/^\/+/, ""));
      return new RegExp(anchored ? `^${body}$` : `(?:^|/)${body}$`, "i");
    });
  return (homePath) => {
    const segments = homePath.split("/").filter(Boolean);
    for (let length = 1; length <= segments.length; length += 1) {
      const prefix = segments.slice(0, length).join("/");
      if (expressions.some((expression) => expression.test(prefix))) {
        return true;
      }
    }
    return false;
  };
}

/** The patterns of an excludes file: one per line, `#` starts a comment. */
export function parseExcludes(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

/** The user's own excludes from the sync repo, none when it has no file. */
export function readUserExcludes(configDir: string): string[] {
  try {
    return parseExcludes(readFileSync(join(configDir, EXCLUDES_FILE), "utf8"));
  } catch {
    return [];
  }
}

/** The built-in excludes plus the given user patterns. */
export function withBuiltInExcludes(userPatterns: readonly string[]): ExcludeMatcher {
  return compileExcludes([...BUILT_IN_EXCLUDES, ...userPatterns]);
}

/** The built-in excludes plus the user's own, from the sync repo. */
export function loadExcludes(configDir: string): ExcludeMatcher {
  return withBuiltInExcludes(readUserExcludes(configDir));
}

/** Patterns of several lists, each once, in first-seen order. */
export function unionOfExcludes(...lists: readonly (readonly string[])[]): string[] {
  return [...new Set(lists.flat())];
}

/** The matcher seen from inside a sync path. */
export function excludesWithin(
  excludes: ExcludeMatcher,
  syncPath: string,
): PathFilter {
  return (relativePath) => excludes(`${syncPath}/${relativePath}`);
}
