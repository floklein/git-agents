import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkGitRepoExists,
  cloneRepo,
  gitAddCommitPush,
  gitSetRemoteUrl,
  initRepo,
  runCommand,
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

  it("commits an unborn repository and detects a later no-op", async () => {
    const remote = useTempDir("push remote.git");
    const repo = useTempDir("push working copy");
    execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
    execFileSync("git", ["init", repo], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test User"]);
    execFileSync("git", ["-C", repo, "remote", "add", "origin", remote]);
    writeFileSync(join(repo, "skill.md"), "content", "utf8");

    const pushed = await gitAddCommitPush(repo, "test commit");
    const noOp = await gitAddCommitPush(repo, "test no-op");

    expect(pushed.ok).toBe(true);
    expect(noOp).toEqual({ ok: true, output: "Nothing to commit" });
  });

  it("streams command output beyond the previous buffer limit", async () => {
    const marker = "OUTPUT_COMPLETE";
    const result = await runCommand(process.execPath, [
      "-e",
      `process.stdout.write("x".repeat(11 * 1024 * 1024)); process.stdout.write("${marker}")`,
    ]);

    expect(result.ok).toBe(true);
    expect(result.output).toContain(marker);
    expect(result.output!.length).toBeLessThanOrEqual(64 * 1024);
  });

  it("keeps the final diagnostic from a large stderr stream", async () => {
    const marker = "FINAL_DIAGNOSTIC";
    const result = await runCommand(process.execPath, [
      "-e",
      `process.stderr.write("x".repeat(11 * 1024 * 1024)); process.stderr.write("${marker}"); process.exitCode = 7`,
    ]);

    expect(result.ok).toBe(false);
    expect(result.error).toContain(marker);
    expect(result.error).not.toMatch(/maxBuffer|ENOBUFS/i);
  });

  it("cancels a command tree and blocks later commands on the same signal", async () => {
    const dir = useTempDir("cancellation");
    const readyMarker = join(dir, "ready");
    const lateMarker = join(dir, "late");
    const blockedMarker = join(dir, "blocked");
    const grandchildScript = [
      "const { writeFileSync } = require('node:fs');",
      `setTimeout(() => writeFileSync(${JSON.stringify(lateMarker)}, 'late'), 500);`,
      "setTimeout(() => {}, 5000);",
    ].join(" ");
    const parentScript = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      `spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { stdio: 'ignore' });`,
      `writeFileSync(${JSON.stringify(readyMarker)}, 'ready');`,
      "setTimeout(() => {}, 10000);",
    ].join(" ");
    const controller = new AbortController();
    const command = runCommand(
      process.execPath,
      ["-e", parentScript],
      controller.signal,
    );

    await vi.waitFor(() => {
      expect(existsSync(readyMarker)).toBe(true);
    });
    controller.abort();

    const result = await command;
    const blocked = await runCommand(
      process.execPath,
      [
        "-e",
        `require('node:fs').writeFileSync(${JSON.stringify(blockedMarker)}, 'blocked')`,
      ],
      controller.signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 700));

    expect(result).toMatchObject({ ok: false, error: "Command aborted" });
    expect(blocked).toMatchObject({ ok: false, error: "Command aborted" });
    expect(existsSync(lateMarker)).toBe(false);
    expect(existsSync(blockedMarker)).toBe(false);
  });
});
