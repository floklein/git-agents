import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  BUILT_IN_EXCLUDES,
  EXCLUDES_FILE,
  compileExcludes,
  excludesWithin,
  loadExcludes,
  parseExcludes,
} from "../src/utils/excludes";
import {
  mirrorSyncPath,
  removeExcludedEntries,
  snapshotSyncPath,
} from "../src/utils/agents";
import { measureSyncPath } from "../src/utils/pathSize";

const tmpDirs: string[] = [];

function useTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "git-agents-excludes-"));
  tmpDirs.push(dir);
  return dir;
}

function write(root: string, path: string, content: string): void {
  const target = join(root, ...path.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
}

function read(root: string, path: string): string {
  return readFileSync(join(root, ...path.split("/")), "utf8");
}

function has(root: string, path: string): boolean {
  return existsSync(join(root, ...path.split("/")));
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

const builtIn = compileExcludes(BUILT_IN_EXCLUDES);
const SKILLS = ".claude/skills";
const skillsExclude = excludesWithin(builtIn, SKILLS);

describe("the built-in excludes", () => {
  it.each([
    ".claude/skills/.trash",
    ".claude/skills/.trash/old-skill/SKILL.md",
    ".claude/skills/synced",
    ".claude/skills/synced/manifest.json",
    ".claude/skills/synced/.last-complete-round",
    ".claude/skills/synced/.staging/4242/SKILL.md",
    ".claude/skills/synced/some-skill/SKILL.md",
    ".agents/skills/.staging/tmp",
    ".claude/skills/review/.DS_Store",
    ".claude/skills/review/._SKILL.md",
    ".agents/skills/pdf/Thumbs.db",
    ".agents/skills/pdf/desktop.ini",
    ".agents/skills/pdf/node_modules/pdf-lib/index.js",
    ".agents/skills/pdf/scripts/__pycache__/fill.cpython-312.pyc",
    ".agents/skills/pdf/.venv/bin/python",
    ".agents/skills/cloned/.git/HEAD",
    ".codex/skills/.system/skill-creator/SKILL.md",
    ".claude/skills/.review.git-agents-incoming-0b8f7a4e-0000-4000-8000-000000000000",
    ".claude/.skills.git-agents-backup-0b8f7a4e-0000-4000-8000-000000000000/x",
  ])("exclude %s", (path) => {
    expect(builtIn(path)).toBe(true);
  });

  it.each([
    ".claude/skills/review/SKILL.md",
    ".claude/skills/synced-notes/SKILL.md",
    ".agents/skills/synced/SKILL.md",
    ".claude/CLAUDE.md",
    ".git-agents-harnesses.json",
    ".claude/skills/trash/SKILL.md",
    ".claude/skills/git-agents/SKILL.md",
    ".claude/skills/review/.gitignore",
    ".codex/skills/system/SKILL.md",
  ])("keep %s", (path) => {
    expect(builtIn(path)).toBe(false);
  });
});

describe("compileExcludes", () => {
  it("matches a name at any depth, and a path with a slash from the home directory", () => {
    const matches = compileExcludes(["notes", ".cursor/skills/local-only", "/scratch"]);
    expect(matches(".claude/skills/a/notes")).toBe(true);
    expect(matches(".claude/skills/a/notes/x.md")).toBe(true);
    expect(matches(".cursor/skills/local-only/SKILL.md")).toBe(true);
    expect(matches(".claude/.cursor/skills/local-only")).toBe(false);
    expect(matches("scratch/a")).toBe(true);
    expect(matches(".claude/scratch")).toBe(false);
  });

  it("supports *, ? and **, and ignores case", () => {
    const matches = compileExcludes(["*.log", ".claude/skills/**/cache", "tmp?"]);
    expect(matches(".claude/skills/a/run.log")).toBe(true);
    expect(matches(".claude/skills/a/b/cache/x")).toBe(true);
    expect(matches(".claude/skills/cache")).toBe(true);
    expect(matches(".claude/skills/a/tmp1")).toBe(true);
    expect(matches(".claude/skills/a/tmp12")).toBe(false);
    expect(matches(".claude/skills/a/RUN.LOG")).toBe(true);
  });
});

describe("user excludes", () => {
  it("reads one pattern per line, skipping blanks and comments", () => {
    expect(parseExcludes("# mine\n\n  notes  \r\n.cursor/skills/x\n")).toEqual([
      "notes",
      ".cursor/skills/x",
    ]);
  });

  it("adds the sync repo's excludes file to the built-in list", () => {
    const configDir = useTmp();
    expect(loadExcludes(configDir)(".claude/skills/a/notes")).toBe(false);
    writeFileSync(join(configDir, EXCLUDES_FILE), "notes\n", "utf8");
    const excludes = loadExcludes(configDir);
    expect(excludes(".claude/skills/a/notes")).toBe(true);
    expect(excludes(".claude/skills/synced")).toBe(true);
  });
});

describe("snapshots with excludes", () => {
  it("leave excluded entries out of the content and the count", () => {
    const clean = join(useTmp(), "skills");
    write(clean, "review/SKILL.md", "review\n");
    const cluttered = join(useTmp(), "skills");
    write(cluttered, "review/SKILL.md", "review\n");
    write(cluttered, "review/.DS_Store", "finder\n");
    write(cluttered, ".trash/old/SKILL.md", "old\n");
    write(cluttered, "synced/manifest.json", "{}\n");

    const snapshot = snapshotSyncPath(cluttered, skillsExclude);
    expect(snapshot).toEqual(snapshotSyncPath(clean, skillsExclude));
    expect(snapshot!.fileCount).toBe(1);
    expect(snapshotSyncPath(cluttered)!.fileCount).toBe(4);
    expect(measureSyncPath(cluttered, skillsExclude)).toEqual({
      fileCount: 1,
      totalBytes: "review\n".length,
    });
  });

  it("read a directory holding only excluded entries as absent", () => {
    const skills = join(useTmp(), "skills");
    write(skills, ".trash/old/SKILL.md", "old\n");
    write(skills, "synced/manifest.json", "{}\n");
    write(skills, "review/.DS_Store", "finder\n");
    expect(snapshotSyncPath(skills, skillsExclude)).toBeNull();
    expect(measureSyncPath(skills, skillsExclude)).toBeNull();

    const empty = join(useTmp(), "empty");
    mkdirSync(empty);
    expect(snapshotSyncPath(empty, skillsExclude)).not.toBeNull();
  });
});

describe("mirroring with excludes", () => {
  it("never copies excluded entries from the source", () => {
    const home = join(useTmp(), "skills");
    write(home, "review/SKILL.md", "review\n");
    write(home, ".trash/old/SKILL.md", "old\n");
    write(home, "synced/.staging/77/SKILL.md", "staging\n");
    const clone = join(useTmp(), "skills");

    mirrorSyncPath(home, clone, undefined, undefined, undefined, skillsExclude);
    expect(readdirSync(clone)).toEqual(["review"]);
    expect(read(clone, "review/SKILL.md")).toBe("review\n");
  });

  it("keeps the destination's excluded entries when it replaces the directory", () => {
    const clone = join(useTmp(), "skills");
    write(clone, "review/SKILL.md", "review from the repo\n");
    write(clone, "added/SKILL.md", "added\n");
    const home = join(useTmp(), "skills");
    write(home, "review/SKILL.md", "review\n");
    write(home, "review/.DS_Store", "finder\n");
    write(home, "gone/SKILL.md", "gone\n");
    write(home, "gone/.DS_Store", "finder in gone\n");
    write(home, ".trash/old/SKILL.md", "old\n");
    write(home, "synced/manifest.json", "{\"a\":1}\n");

    mirrorSyncPath(clone, home, undefined, undefined, undefined, skillsExclude);
    expect(read(home, "review/SKILL.md")).toBe("review from the repo\n");
    expect(read(home, "added/SKILL.md")).toBe("added\n");
    expect(has(home, "gone/SKILL.md")).toBe(false);
    expect(read(home, "review/.DS_Store")).toBe("finder\n");
    expect(read(home, "gone/.DS_Store")).toBe("finder in gone\n");
    expect(read(home, ".trash/old/SKILL.md")).toBe("old\n");
    expect(read(home, "synced/manifest.json")).toBe("{\"a\":1}\n");
    expect(snapshotSyncPath(home, skillsExclude)).toEqual(
      snapshotSyncPath(clone, skillsExclude),
    );
  });

  it("deletes only what is not excluded when the source is gone", () => {
    const clone = join(useTmp(), "skills");
    const home = join(useTmp(), "skills");
    write(home, "review/SKILL.md", "review\n");
    write(home, ".trash/old/SKILL.md", "old\n");
    write(home, "synced/manifest.json", "{}\n");

    mirrorSyncPath(clone, home, undefined, undefined, undefined, skillsExclude);
    expect(readdirSync(home).sort()).toEqual([".trash", "synced"]);
    expect(snapshotSyncPath(home, skillsExclude)).toBeNull();
  });
});

describe("removeExcludedEntries", () => {
  it("deletes the outermost excluded entries and names them", () => {
    const clone = join(useTmp(), "skills");
    write(clone, "review/SKILL.md", "review\n");
    write(clone, "review/.DS_Store", "finder\n");
    write(clone, "synced/manifest.json", "{}\n");
    write(clone, "synced/a/SKILL.md", "a\n");

    expect(removeExcludedEntries(clone, skillsExclude)).toEqual([
      "review/.DS_Store",
      "synced",
    ]);
    expect(readdirSync(clone)).toEqual(["review"]);
    expect(readdirSync(join(clone, "review"))).toEqual(["SKILL.md"]);
  });
});
