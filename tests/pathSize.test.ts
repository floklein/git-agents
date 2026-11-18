import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { measureSyncPath } from "../src/utils/pathSize";

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
  for (const dir of tempDirs) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

describe("measureSyncPath", () => {
  it("returns null when nothing is at the path", () => {
    expect(measureSyncPath(join(makeTmpDir(), "missing"))).toBeNull();
  });

  it("measures a single file in bytes", () => {
    const file = join(makeTmpDir(), "AGENTS.md");
    writeFileSync(file, "héllo", "utf8");

    expect(measureSyncPath(file)).toEqual({ fileCount: 1, totalBytes: 6 });
  });

  it("measures every file under a directory", () => {
    const dir = makeTmpDir();
    mkdirSync(join(dir, "a", "b"), { recursive: true });
    mkdirSync(join(dir, "empty"));
    writeFileSync(join(dir, "top.txt"), "12345", "utf8");
    writeFileSync(join(dir, "a", "one.txt"), "123", "utf8");
    writeFileSync(join(dir, "a", "b", "two.txt"), "1234567", "utf8");

    expect(measureSyncPath(dir)).toEqual({ fileCount: 3, totalBytes: 15 });
  });

  it("reports an empty directory as present and empty", () => {
    expect(measureSyncPath(makeTmpDir())).toEqual({
      fileCount: 0,
      totalBytes: 0,
    });
  });
});
