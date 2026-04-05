import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { listAgents, diffAgents, copyAgentsDir } from "../src/utils/agents";

function mkTmp(): string {
  const dir = join(tmpdir(), `git-agents-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function mkAgent(base: string, name: string, files: string[] = []): void {
  const agentDir = join(base, name);
  mkdirSync(agentDir, { recursive: true });
  for (const f of files) {
    writeFileSync(join(agentDir, f), "");
  }
}

let tmpDirs: string[] = [];

function useTmp(): string {
  const dir = mkTmp();
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe("listAgents", () => {
  it("returns [] for non-existent directory", () => {
    expect(listAgents("/this/does/not/exist")).toEqual([]);
  });

  it("returns [] for empty directory", () => {
    const dir = useTmp();
    expect(listAgents(dir)).toEqual([]);
  });

  it("returns sorted entries with correct fileCount", () => {
    const dir = useTmp();
    mkAgent(dir, "zebra", ["a.ts", "b.ts"]);
    mkAgent(dir, "alpha", ["x.ts"]);
    mkAgent(dir, "middle", []);

    const result = listAgents(dir);
    expect(result).toEqual([
      { name: "alpha", fileCount: 1 },
      { name: "middle", fileCount: 0 },
      { name: "zebra", fileCount: 2 },
    ]);
  });

  it("ignores files (non-directories)", () => {
    const dir = useTmp();
    writeFileSync(join(dir, "not-a-dir.txt"), "hello");
    mkAgent(dir, "real-agent", ["file.ts"]);

    const result = listAgents(dir);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("real-agent");
  });
});

describe("diffAgents", () => {
  it("returns all empty for two empty dirs", () => {
    const src = useTmp();
    const dst = useTmp();
    expect(diffAgents(src, dst)).toEqual({ added: [], removed: [], modified: [], unchanged: [] });
  });

  it("marks agents only in source as added", () => {
    const src = useTmp();
    const dst = useTmp();
    mkAgent(src, "new-agent", ["file.ts"]);

    const { added, removed, modified, unchanged } = diffAgents(src, dst);
    expect(added).toHaveLength(1);
    expect(added[0]!.name).toBe("new-agent");
    expect(removed).toHaveLength(0);
    expect(modified).toHaveLength(0);
    expect(unchanged).toHaveLength(0);
  });

  it("marks agents only in dest as removed", () => {
    const src = useTmp();
    const dst = useTmp();
    mkAgent(dst, "old-agent", ["file.ts"]);

    const { added, removed, modified, unchanged } = diffAgents(src, dst);
    expect(removed).toHaveLength(1);
    expect(removed[0]!.name).toBe("old-agent");
    expect(added).toHaveLength(0);
    expect(modified).toHaveLength(0);
    expect(unchanged).toHaveLength(0);
  });

  it("marks agents with same file count as unchanged", () => {
    const src = useTmp();
    const dst = useTmp();
    mkAgent(src, "agent", ["a.ts", "b.ts"]);
    mkAgent(dst, "agent", ["c.ts", "d.ts"]);

    const { unchanged, added, removed, modified } = diffAgents(src, dst);
    expect(unchanged).toHaveLength(1);
    expect(unchanged[0]!.name).toBe("agent");
    expect(added).toHaveLength(0);
    expect(removed).toHaveLength(0);
    expect(modified).toHaveLength(0);
  });

  it("marks agents with different file count as modified", () => {
    const src = useTmp();
    const dst = useTmp();
    mkAgent(src, "agent", ["a.ts", "b.ts", "c.ts"]);
    mkAgent(dst, "agent", ["a.ts"]);

    const { modified, added, removed, unchanged } = diffAgents(src, dst);
    expect(modified).toHaveLength(1);
    expect(modified[0]!.name).toBe("agent");
    expect(added).toHaveLength(0);
    expect(removed).toHaveLength(0);
    expect(unchanged).toHaveLength(0);
  });

  it("handles mixed scenario across all categories", () => {
    const src = useTmp();
    const dst = useTmp();
    mkAgent(src, "will-add", ["x.ts"]);
    mkAgent(src, "will-modify", ["a.ts", "b.ts"]);
    mkAgent(src, "will-stay", ["a.ts"]);
    mkAgent(dst, "will-remove", ["y.ts"]);
    mkAgent(dst, "will-modify", ["a.ts"]);
    mkAgent(dst, "will-stay", ["b.ts"]);

    const diff = diffAgents(src, dst);
    expect(diff.added.map((e) => e.name)).toEqual(["will-add"]);
    expect(diff.removed.map((e) => e.name)).toEqual(["will-remove"]);
    expect(diff.modified.map((e) => e.name)).toEqual(["will-modify"]);
    expect(diff.unchanged.map((e) => e.name)).toEqual(["will-stay"]);
  });
});

describe("copyAgentsDir", () => {
  it("copies files from source to destination", () => {
    const src = useTmp();
    const dst = useTmp();
    mkAgent(src, "my-agent", ["commands.ts", "settings.json"]);

    copyAgentsDir(src, dst);

    const result = listAgents(dst);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("my-agent");
    expect(result[0]!.fileCount).toBe(2);
  });

  it("creates destination directory if it doesn't exist", () => {
    const src = useTmp();
    const dst = join(useTmp(), "nested", "path");
    mkAgent(src, "agent", ["file.ts"]);

    expect(existsSync(dst)).toBe(false);
    copyAgentsDir(src, dst);
    expect(existsSync(dst)).toBe(true);
  });
});
