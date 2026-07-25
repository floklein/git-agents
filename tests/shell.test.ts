import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkGitRepoExists,
  cloneRepo,
  gitSetRemoteUrl,
  initRepo,
} from "../src/utils/shell";

const tempDirs: string[] = [];

function useTempDir(name: string): string {
  const root = join(
    tmpdir(),
    `git-agents-shell-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(root);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

describe("Node shell commands", () => {
  it("initializes a repository in a path with spaces", async () => {
    const repo = useTempDir("repo with spaces");

    const result = await initRepo(repo);

    expect(result.ok).toBe(true);
    expect(existsSync(join(repo, ".git"))).toBe(true);
  });

  it("checks and clones a local remote using argument-safe paths", async () => {
    const remote = useTempDir("remote with spaces.git");
    const cloneParent = useTempDir("clone parent");
    const destination = join(cloneParent, "working copy");
    execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });

    const exists = await checkGitRepoExists(remote);
    const cloned = await cloneRepo(remote, destination);

    expect(exists.ok).toBe(true);
    expect(cloned.ok).toBe(true);
    expect(existsSync(join(destination, ".git"))).toBe(true);
  });

  it("updates a remote URL containing spaces", async () => {
    const repo = useTempDir("working repo");
    const remote = useTempDir("new remote with spaces.git");
    execFileSync("git", ["init", repo], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "remote", "add", "origin", "old-url"], {
      stdio: "ignore",
    });

    const result = await gitSetRemoteUrl(repo, remote);
    const configuredUrl = execFileSync(
      "git",
      ["-C", repo, "remote", "get-url", "origin"],
      { encoding: "utf8" },
    ).trim();

    expect(result.ok).toBe(true);
    expect(configuredUrl).toBe(remote);
  });
});
