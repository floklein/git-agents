import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  compareSyncPathSnapshots,
  mirrorSyncPath,
  snapshotSyncPath,
} from "../src/utils/agents";

const tmpDirs: string[] = [];

function useTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "git-agents-test-"));
  tmpDirs.push(dir);
  return dir;
}

function writeFixture(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function requiredSnapshot(path: string) {
  const snapshot = snapshotSyncPath(path);
  expect(snapshot).not.toBeNull();
  return snapshot!;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

describe("snapshotSyncPath", () => {
  it("returns null for a missing path", () => {
    const missing = join(useTmp(), "missing");

    expect(snapshotSyncPath(missing)).toBeNull();
  });

  it("snapshots a file using its content", () => {
    const file = join(useTmp(), "AGENTS.md");
    writeFixture(file, "Use focused tests.\n");

    const snapshot = requiredSnapshot(file);

    expect(snapshot.kind).toBe("file");
    expect(snapshot.fileCount).toBe(1);
    expect(snapshot.contentHash).toHaveLength(64);
  });

  it("includes direct files, nested files, and empty directories", () => {
    const source = useTmp();
    const identical = useTmp();

    writeFixture(join(source, "direct.md"), "direct");
    writeFixture(join(source, "nested", "deep.md"), "nested");
    mkdirSync(join(source, "empty"), { recursive: true });

    writeFixture(join(identical, "direct.md"), "direct");
    writeFixture(join(identical, "nested", "deep.md"), "nested");
    mkdirSync(join(identical, "empty"), { recursive: true });

    const sourceSnapshot = requiredSnapshot(source);
    const identicalSnapshot = requiredSnapshot(identical);

    expect(sourceSnapshot.kind).toBe("directory");
    expect(sourceSnapshot.fileCount).toBe(2);
    expect(compareSyncPathSnapshots(sourceSnapshot, identicalSnapshot)).toBe(
      "unchanged",
    );

    rmSync(join(identical, "empty"), { recursive: true });
    expect(
      compareSyncPathSnapshots(sourceSnapshot, requiredSnapshot(identical)),
    ).toBe("modified");
  });

  it("detects same-size content changes", () => {
    const file = join(useTmp(), "prompt.md");
    writeFixture(file, "alpha");
    const before = requiredSnapshot(file);

    writeFixture(file, "bravo");
    const after = requiredSnapshot(file);

    expect(before.contentHash).not.toBe(after.contentHash);
    expect(compareSyncPathSnapshots(before, after)).toBe("modified");
  });

  it("detects path and type changes", () => {
    const left = useTmp();
    const right = useTmp();
    writeFixture(join(left, "first.md"), "same");
    writeFixture(join(right, "second.md"), "same");

    expect(
      compareSyncPathSnapshots(
        requiredSnapshot(left),
        requiredSnapshot(right),
      ),
    ).toBe("modified");

    const file = join(useTmp(), "target");
    const directory = join(useTmp(), "target");
    writeFixture(file, "content");
    mkdirSync(directory, { recursive: true });

    expect(
      compareSyncPathSnapshots(
        requiredSnapshot(file),
        requiredSnapshot(directory),
      ),
    ).toBe("modified");
  });
});

describe("compareSyncPathSnapshots", () => {
  it("classifies missing and identical paths", () => {
    const file = join(useTmp(), "skill.md");
    writeFixture(file, "skill");
    const snapshot = requiredSnapshot(file);

    expect(compareSyncPathSnapshots(snapshot, null)).toBe("added");
    expect(compareSyncPathSnapshots(null, snapshot)).toBe("removed");
    expect(compareSyncPathSnapshots(null, null)).toBe("unchanged");
    expect(compareSyncPathSnapshots(snapshot, snapshot)).toBe("unchanged");
  });
});

describe("mirrorSyncPath", () => {
  it("replaces a destination directory with a source file", () => {
    const source = join(useTmp(), "AGENTS.md");
    const destination = join(useTmp(), "config", "AGENTS.md");
    writeFixture(source, "portable instructions");
    writeFixture(join(destination, "stale.md"), "stale");

    mirrorSyncPath(source, destination);

    expect(lstatSync(destination).isFile()).toBe(true);
    expect(readFileSync(destination, "utf8")).toBe("portable instructions");
  });

  it("exactly replaces a destination directory and removes stale entries", () => {
    const source = join(useTmp(), "skills");
    const destination = join(useTmp(), "skills");

    writeFixture(join(source, "direct.md"), "source direct");
    writeFixture(join(source, "nested", "deep.md"), "source nested");
    mkdirSync(join(source, "empty"), { recursive: true });

    writeFixture(join(destination, "direct.md"), "old direct");
    writeFixture(join(destination, "stale.md"), "stale direct");
    writeFixture(join(destination, "nested", "stale.md"), "stale nested");
    writeFixture(join(destination, "obsolete", "old.md"), "obsolete");

    mirrorSyncPath(source, destination);

    expect(lstatSync(destination).isDirectory()).toBe(true);
    expect(readFileSync(join(destination, "direct.md"), "utf8")).toBe(
      "source direct",
    );
    expect(readFileSync(join(destination, "nested", "deep.md"), "utf8")).toBe(
      "source nested",
    );
    expect(lstatSync(join(destination, "empty")).isDirectory()).toBe(true);
    expect(existsSync(join(destination, "stale.md"))).toBe(false);
    expect(existsSync(join(destination, "nested", "stale.md"))).toBe(false);
    expect(existsSync(join(destination, "obsolete"))).toBe(false);
    expect(
      readdirSync(dirname(destination)).some((name) =>
        name.includes(".git-agents-")
      ),
    ).toBe(false);
    expect(
      compareSyncPathSnapshots(
        requiredSnapshot(source),
        requiredSnapshot(destination),
      ),
    ).toBe("unchanged");
  });

  it("replaces a destination file with a source directory", () => {
    const source = join(useTmp(), "agents");
    const destination = join(useTmp(), "agents");
    writeFixture(join(source, "reviewer.md"), "Review carefully.");
    writeFixture(destination, "old file");

    mirrorSyncPath(source, destination);

    expect(lstatSync(destination).isDirectory()).toBe(true);
    expect(readFileSync(join(destination, "reviewer.md"), "utf8")).toBe(
      "Review carefully.",
    );
  });

  it("deletes the entire destination when the source is absent", () => {
    const root = useTmp();
    const missingFile = join(root, "missing-file");
    const missingDirectory = join(root, "missing-directory");
    const destinationFile = join(useTmp(), "AGENTS.md");
    const destinationDirectory = join(useTmp(), "skills");

    writeFixture(destinationFile, "stale");
    writeFixture(join(destinationDirectory, "nested", "stale.md"), "stale");

    mirrorSyncPath(missingFile, destinationFile);
    mirrorSyncPath(missingDirectory, destinationDirectory);

    expect(existsSync(destinationFile)).toBe(false);
    expect(existsSync(destinationDirectory)).toBe(false);
  });

  it("is a no-op when source and destination resolve to the same path", () => {
    const directory = join(useTmp(), "skills");
    writeFixture(join(directory, "direct.md"), "keep me");
    writeFixture(join(directory, "nested", "deep.md"), "keep me too");
    mkdirSync(join(directory, "empty"), { recursive: true });
    const before = requiredSnapshot(directory);

    mirrorSyncPath(directory, join(directory, "."));

    expect(readFileSync(join(directory, "direct.md"), "utf8")).toBe("keep me");
    expect(readFileSync(join(directory, "nested", "deep.md"), "utf8")).toBe(
      "keep me too",
    );
    expect(lstatSync(join(directory, "empty")).isDirectory()).toBe(true);
    expect(requiredSnapshot(directory)).toEqual(before);
  });

  it("rejects a destination outside its declared base", () => {
    const root = useTmp();
    const sourceBase = join(root, "source");
    const destinationBase = join(root, "destination");
    const source = join(sourceBase, "AGENTS.md");
    const destination = join(root, "outside", "AGENTS.md");
    writeFixture(source, "new instructions");
    writeFixture(destination, "keep existing instructions");
    mkdirSync(destinationBase, { recursive: true });

    expect(() =>
      mirrorSyncPath(source, destination, sourceBase, destinationBase)
    ).toThrow("outside its base");
    expect(readFileSync(destination, "utf8")).toBe(
      "keep existing instructions",
    );
  });

  it("rejects a symlinked destination ancestor", () => {
    const root = useTmp();
    const sourceBase = join(root, "source");
    const destinationBase = join(root, "destination");
    const outside = join(root, "outside");
    const source = join(sourceBase, "AGENTS.md");
    const linkedDirectory = join(destinationBase, "linked");
    const outsideDestination = join(outside, "AGENTS.md");
    writeFixture(source, "new instructions");
    writeFixture(outsideDestination, "keep existing instructions");
    mkdirSync(destinationBase, { recursive: true });
    symlinkSync(
      outside,
      linkedDirectory,
      process.platform === "win32" ? "junction" : "dir",
    );

    expect(() =>
      mirrorSyncPath(
        source,
        join(linkedDirectory, "AGENTS.md"),
        sourceBase,
        destinationBase,
      )
    ).toThrow("symlink ancestor");
    expect(readFileSync(outsideDestination, "utf8")).toBe(
      "keep existing instructions",
    );
  });

  it("rejects a leaf alias instead of reporting a false success", () => {
    const root = useTmp();
    const source = join(root, "source");
    const destination = join(root, "destination");
    writeFixture(join(source, "agent.md"), "instructions");
    symlinkSync(
      source,
      destination,
      process.platform === "win32" ? "junction" : "dir",
    );

    const before = compareSyncPathSnapshots(
      requiredSnapshot(source),
      requiredSnapshot(destination),
    );
    expect(before).toBe("modified");

    expect(() => mirrorSyncPath(source, destination)).toThrow(
      "aliased source and destination",
    );
    expect(
      compareSyncPathSnapshots(
        requiredSnapshot(source),
        requiredSnapshot(destination),
      ),
    ).toBe("modified");
  });
});
