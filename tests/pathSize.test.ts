import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { measurePath } from "../src/utils/pathSize";

const tempDirs: string[] = [];

function makeTmpDir(): string {
  const dir = join(
    tmpdir(),
    `ga-path-size-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

describe("measurePath", () => {
  it("reports nothing where no file or directory exists", () => {
    expect(measurePath(join(makeTmpDir(), "missing"))).toBeNull();
  });

  it("measures a single file", () => {
    const file = join(makeTmpDir(), "AGENTS.md");
    writeFileSync(file, "12345");

    expect(measurePath(file)).toEqual({ fileCount: 1, totalBytes: 5 });
  });

  it("counts every file under a directory and sums their bytes", () => {
    const dir = makeTmpDir();
    mkdirSync(join(dir, "review", "notes"), { recursive: true });
    mkdirSync(join(dir, "empty"));
    writeFileSync(join(dir, "top.md"), "abc");
    writeFileSync(join(dir, "review", "SKILL.md"), "1234567");
    writeFileSync(join(dir, "review", "notes", "a.bin"), Buffer.alloc(1000));

    expect(measurePath(dir)).toEqual({ fileCount: 3, totalBytes: 1010 });
  });

  it("measures an empty directory as holding nothing", () => {
    expect(measurePath(makeTmpDir())).toEqual({ fileCount: 0, totalBytes: 0 });
  });
});
