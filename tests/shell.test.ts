import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkGitRepoExists,
  cloneRepo,
  gitAddCommitPush,
  gitPull,
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

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
  }).trim();
}

function installRejectingPushHook(remote: string): string {
  const hook = join(remote, "hooks", "pre-receive");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n", "utf8");
  chmodSync(hook, 0o755);
  return hook;
}

afterEach(() => {
  for (const dir of tempDirs) {
    if (existsSync(dir)) {
      rmSync(dir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
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

  it("commits an unborn repository and accepts a later no-op", async () => {
    const remote = useTempDir("push remote.git");
    const repo = useTempDir("push working copy");
    execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
    execFileSync("git", ["init", repo], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Test User"]);
    execFileSync("git", ["-C", repo, "remote", "add", "origin", remote]);
    writeFileSync(join(repo, "skill.md"), "content", "utf8");

    const pushed = await gitAddCommitPush(repo, "test commit", ["skill.md"]);
    const noOp = await gitAddCommitPush(repo, "test no-op", ["skill.md"]);

    expect(pushed.ok).toBe(true);
    expect(noOp.ok).toBe(true);
  });

  it("reports an invalid repository when no managed paths are selected", async () => {
    const result = await gitAddCommitPush("/not/a/repository", "sync", []);

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("returns nothing to commit for an unborn repository", async () => {
    const repo = useTempDir("unborn repository");
    execFileSync("git", ["init", repo], { stdio: "ignore" });

    const result = await gitAddCommitPush(repo, "sync", []);

    expect(result).toEqual({ ok: true, output: "Nothing to commit" });
  });

  it("commits and pushes only selected harness paths", async () => {
    const root = useTempDir("scoped push");
    const repo = join(root, "repo");
    const remote = join(root, "remote.git");
    const managed = join(repo, ".claude", "CLAUDE.md");
    const config = join(repo, "config.json");

    mkdirSync(join(repo, ".claude"), { recursive: true });
    execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
    execFileSync("git", ["init", repo], { stdio: "ignore" });
    git(repo, "config", "user.name", "git-agents tests");
    git(repo, "config", "user.email", "tests@example.com");
    git(repo, "remote", "add", "origin", remote);

    writeFileSync(managed, "first", "utf8");
    writeFileSync(config, "first config", "utf8");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "initial");
    git(repo, "push", "-u", "origin", "HEAD");

    writeFileSync(managed, "second", "utf8");
    writeFileSync(config, "second config", "utf8");

    const result = await gitAddCommitPush(
      repo,
      "sync managed path",
      [".claude/CLAUDE.md"],
    );

    expect(result.ok).toBe(true);
    expect(git(repo, "show", "HEAD:.claude/CLAUDE.md")).toBe("second");
    expect(git(repo, "show", "HEAD:config.json")).toBe("first config");
    expect(readFileSync(config, "utf8")).toBe("second config");
    expect(git(repo, "status", "--porcelain", "--", "config.json")).toContain(
      "config.json",
    );
    expect(git(repo, "rev-parse", "HEAD")).toBe(
      git(remote, "rev-parse", "HEAD"),
    );

    rmSync(managed);
    const deleteResult = await gitAddCommitPush(
      repo,
      "remove managed path",
      [".claude/CLAUDE.md"],
    );

    expect(deleteResult.ok).toBe(true);
    expect(git(repo, "ls-tree", "-r", "--name-only", "HEAD")).not.toContain(
      ".claude/CLAUDE.md",
    );
    expect(git(repo, "show", "HEAD:config.json")).toBe("first config");
    expect(git(repo, "rev-parse", "HEAD")).toBe(
      git(remote, "rev-parse", "HEAD"),
    );

    writeFileSync(managed, "third", "utf8");
    git(repo, "add", "--", ".claude/CLAUDE.md");
    git(repo, "commit", "-m", "local commit after interrupted push");
    const remoteHead = git(remote, "rev-parse", "HEAD");
    expect(git(repo, "rev-parse", "HEAD")).not.toBe(remoteHead);

    const retryResult = await gitAddCommitPush(repo, "retry push", []);

    expect(retryResult).toMatchObject({
      ok: false,
      error: expect.stringContaining("unreviewed local commit"),
    });
    expect(git(remote, "rev-parse", "HEAD")).toBe(remoteHead);
    expect(git(remote, "ls-tree", "-r", "--name-only", "HEAD")).not.toContain(
      ".claude/CLAUDE.md",
    );
  }, 20_000);

  it("checks outgoing commits against the branch pushed to origin", async () => {
    const root = useTempDir("origin branch safety");
    const repo = join(root, "repo");
    const remote = join(root, "remote.git");
    const managed = join(repo, "skill.md");
    const unreviewed = join(repo, "unreviewed.txt");

    execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
    execFileSync("git", ["init", repo], { stdio: "ignore" });
    git(repo, "config", "user.name", "git-agents tests");
    git(repo, "config", "user.email", "tests@example.com");
    git(repo, "remote", "add", "origin", remote);
    writeFileSync(managed, "first", "utf8");
    git(repo, "add", "--", "skill.md");
    git(repo, "commit", "-m", "initial");
    git(repo, "push", "-u", "origin", "HEAD");
    const branch = git(repo, "branch", "--show-current");
    const remoteBranchHead = git(remote, "rev-parse", branch);

    writeFileSync(unreviewed, "do not push", "utf8");
    git(repo, "add", "--", "unreviewed.txt");
    git(repo, "commit", "-m", "unreviewed local commit");
    git(repo, "push", "origin", "HEAD:refs/heads/other");
    git(repo, "branch", "--set-upstream-to=origin/other", branch);
    writeFileSync(managed, "second", "utf8");

    const result = await gitAddCommitPush(repo, "sync managed path", [
      "skill.md",
    ]);

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("unreviewed local commit"),
    });
    expect(git(remote, "rev-parse", branch)).toBe(remoteBranchHead);
    expect(git(remote, "show", `${branch}:skill.md`)).toBe("first");
    expect(git(remote, "ls-tree", "-r", "--name-only", branch)).not.toContain(
      "unreviewed.txt",
    );
  }, 20_000);

  it("does not trust stale tracking refs after the origin URL changes", async () => {
    const root = useTempDir("changed origin safety");
    const repo = join(root, "repo");
    const oldRemote = join(root, "old-remote.git");
    const emptyRemote = join(root, "empty-remote.git");
    const managed = join(repo, "managed.md");

    execFileSync("git", ["init", "--bare", oldRemote], { stdio: "ignore" });
    execFileSync("git", ["init", "--bare", emptyRemote], { stdio: "ignore" });
    execFileSync("git", ["init", repo], { stdio: "ignore" });
    git(repo, "config", "user.name", "git-agents tests");
    git(repo, "config", "user.email", "tests@example.com");
    git(repo, "remote", "add", "origin", oldRemote);
    writeFileSync(managed, "first", "utf8");
    writeFileSync(join(repo, "unreviewed.txt"), "do not seed", "utf8");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "old origin history");
    git(repo, "push", "-u", "origin", "HEAD");
    const localHead = git(repo, "rev-parse", "HEAD");

    git(repo, "remote", "set-url", "origin", emptyRemote);
    const pull = await gitPull(repo);
    expect(pull.ok).toBe(true);
    writeFileSync(managed, "second", "utf8");

    const result = await gitAddCommitPush(repo, "sync managed path", [
      "managed.md",
    ]);
    const emptyRemoteHeads = execFileSync(
      "git",
      ["ls-remote", "--heads", emptyRemote],
      { encoding: "utf8" },
    ).trim();

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("unreviewed local commit"),
    });
    expect(git(repo, "rev-parse", "HEAD")).toBe(localHead);
    expect(emptyRemoteHeads).toBe("");
  }, 20_000);

  it("checks every configured origin push URL", async () => {
    const root = useTempDir("multiple push URL safety");
    const repo = join(root, "repo");
    const fetchRemote = join(root, "fetch-remote.git");
    const emptyPushRemote = join(root, "empty-push-remote.git");
    const managed = join(repo, "managed.md");

    execFileSync("git", ["init", "--bare", fetchRemote], { stdio: "ignore" });
    execFileSync("git", ["init", "--bare", emptyPushRemote], {
      stdio: "ignore",
    });
    execFileSync("git", ["init", repo], { stdio: "ignore" });
    git(repo, "config", "user.name", "git-agents tests");
    git(repo, "config", "user.email", "tests@example.com");
    git(repo, "remote", "add", "origin", fetchRemote);
    writeFileSync(managed, "first", "utf8");
    writeFileSync(join(repo, "unreviewed.txt"), "do not seed", "utf8");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "existing history");
    git(repo, "push", "-u", "origin", "HEAD");
    git(repo, "remote", "set-url", "--add", "--push", "origin", fetchRemote);
    git(
      repo,
      "remote",
      "set-url",
      "--add",
      "--push",
      "origin",
      emptyPushRemote,
    );
    writeFileSync(managed, "second", "utf8");

    const result = await gitAddCommitPush(repo, "sync managed path", [
      "managed.md",
    ]);
    const emptyRemoteHeads = execFileSync(
      "git",
      ["ls-remote", "--heads", emptyPushRemote],
      { encoding: "utf8" },
    ).trim();

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("unreviewed local commit"),
    });
    expect(git(fetchRemote, "show", "HEAD:managed.md")).toBe("first");
    expect(emptyRemoteHeads).toBe("");
  }, 20_000);

  it("force-adds ignored selected files and includes them in a fresh clone", async () => {
    const root = useTempDir("ignored selected paths");
    const repo = join(root, "repo");
    const remote = join(root, "remote.git");
    const freshClone = join(root, "fresh clone");
    const managedDir = join(repo, ".claude", "skills");
    const repositoryIgnored = join(managedDir, "repository-ignored.md");
    const globallyIgnored = join(managedDir, "globally-ignored.md");
    const excludesFile = join(root, "global-ignore");

    mkdirSync(managedDir, { recursive: true });
    execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
    execFileSync("git", ["init", repo], { stdio: "ignore" });
    git(repo, "config", "user.name", "git-agents tests");
    git(repo, "config", "user.email", "tests@example.com");
    git(repo, "remote", "add", "origin", remote);
    writeFileSync(
      join(repo, ".gitignore"),
      ".claude/skills/repository-ignored.md\n",
      "utf8",
    );
    writeFileSync(
      excludesFile,
      ".claude/skills/globally-ignored.md\n",
      "utf8",
    );
    git(repo, "config", "core.excludesFile", excludesFile);
    git(repo, "add", "--", ".gitignore");
    git(repo, "commit", "-m", "initial");
    git(repo, "push", "-u", "origin", "HEAD");

    writeFileSync(repositoryIgnored, "repository ignore content", "utf8");
    writeFileSync(globallyIgnored, "global ignore content", "utf8");
    expect(() =>
      git(repo, "check-ignore", "--quiet", repositoryIgnored)
    ).not.toThrow();
    expect(() =>
      git(repo, "check-ignore", "--quiet", globallyIgnored)
    ).not.toThrow();

    const result = await gitAddCommitPush(
      repo,
      "sync ignored managed paths",
      [".claude/skills"],
    );
    execFileSync("git", ["clone", remote, freshClone], { stdio: "ignore" });

    expect(result.ok).toBe(true);
    expect(
      readFileSync(
        join(freshClone, ".claude", "skills", "repository-ignored.md"),
        "utf8",
      ),
    ).toBe("repository ignore content");
    expect(
      readFileSync(
        join(freshClone, ".claude", "skills", "globally-ignored.md"),
        "utf8",
      ),
    ).toBe("global ignore content");
  }, 20_000);

  it("retries only a pending scoped commit created by the sync helper", async () => {
    const root = useTempDir("safe push retry");
    const repo = join(root, "repo");
    const remote = join(root, "remote.git");
    const managed = join(repo, ".claude", "CLAUDE.md");

    mkdirSync(join(repo, ".claude"), { recursive: true });
    execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
    execFileSync("git", ["init", repo], { stdio: "ignore" });
    git(repo, "config", "user.name", "git-agents tests");
    git(repo, "config", "user.email", "tests@example.com");
    git(repo, "remote", "add", "origin", remote);
    writeFileSync(managed, "first", "utf8");
    git(repo, "add", "--", ".claude/CLAUDE.md");
    git(repo, "commit", "-m", "initial");
    git(repo, "push", "-u", "origin", "HEAD");

    writeFileSync(managed, "second", "utf8");
    const rejectingHook = installRejectingPushHook(remote);
    const failedPush = await gitAddCommitPush(
      repo,
      "sync managed path",
      [".claude/CLAUDE.md"],
    );
    rmSync(rejectingHook);
    const pendingHead = git(repo, "rev-parse", "HEAD");

    expect(failedPush.ok).toBe(false);
    expect(git(repo, "rev-parse", "refs/git-agents/pending-sync")).toBe(
      pendingHead,
    );

    const retry = await gitAddCommitPush(
      repo,
      "sync managed path",
      [".claude/CLAUDE.md"],
    );

    expect(retry.ok).toBe(true);
    expect(git(remote, "rev-parse", "HEAD")).toBe(pendingHead);
    expect(git(remote, "show", "HEAD:.claude/CLAUDE.md")).toBe("second");
    expect(() =>
      git(repo, "show-ref", "--verify", "--quiet", "refs/git-agents/pending-sync")
    ).toThrow();
  }, 20_000);

  it("pushes a pending commit before committing a newer reviewed state", async () => {
    const root = useTempDir("safe push retry with newer state");
    const repo = join(root, "repo");
    const remote = join(root, "remote.git");
    const managed = join(repo, ".claude", "CLAUDE.md");

    mkdirSync(join(repo, ".claude"), { recursive: true });
    execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
    execFileSync("git", ["init", repo], { stdio: "ignore" });
    git(repo, "config", "user.name", "git-agents tests");
    git(repo, "config", "user.email", "tests@example.com");
    git(repo, "remote", "add", "origin", remote);
    writeFileSync(managed, "first", "utf8");
    git(repo, "add", "--", ".claude/CLAUDE.md");
    git(repo, "commit", "-m", "initial");
    git(repo, "push", "-u", "origin", "HEAD");

    writeFileSync(managed, "second", "utf8");
    const rejectingHook = installRejectingPushHook(remote);
    const failedPush = await gitAddCommitPush(
      repo,
      "sync second state",
      [".claude/CLAUDE.md"],
    );
    rmSync(rejectingHook);
    const pendingHead = git(repo, "rev-parse", "HEAD");

    expect(failedPush.ok).toBe(false);
    expect(git(repo, "rev-parse", "refs/git-agents/pending-sync")).toBe(
      pendingHead,
    );

    writeFileSync(managed, "third", "utf8");
    const retry = await gitAddCommitPush(
      repo,
      "sync third state",
      [".claude/CLAUDE.md"],
    );

    expect(retry.ok).toBe(true);
    expect(git(remote, "show", "HEAD:.claude/CLAUDE.md")).toBe("third");
    expect(git(remote, "rev-parse", "HEAD")).toBe(git(repo, "rev-parse", "HEAD"));
    expect(git(repo, "rev-list", "--count", "HEAD")).toBe("3");
    expect(() =>
      git(repo, "show-ref", "--verify", "--quiet", "refs/git-agents/pending-sync")
    ).toThrow();
  }, 20_000);

  it("retries a pending deletion when no managed paths remain", async () => {
    const root = useTempDir("safe deletion retry");
    const repo = join(root, "repo");
    const remote = join(root, "remote.git");
    const managed = join(repo, ".claude", "CLAUDE.md");

    mkdirSync(join(repo, ".claude"), { recursive: true });
    execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
    execFileSync("git", ["init", repo], { stdio: "ignore" });
    git(repo, "config", "user.name", "git-agents tests");
    git(repo, "config", "user.email", "tests@example.com");
    git(repo, "remote", "add", "origin", remote);
    writeFileSync(managed, "content to delete", "utf8");
    git(repo, "add", "--", ".claude/CLAUDE.md");
    git(repo, "commit", "-m", "initial");
    git(repo, "push", "-u", "origin", "HEAD");

    rmSync(managed);
    const rejectingHook = installRejectingPushHook(remote);
    const failedPush = await gitAddCommitPush(
      repo,
      "remove managed path",
      [".claude/CLAUDE.md"],
    );
    rmSync(rejectingHook);
    const pendingHead = git(repo, "rev-parse", "HEAD");

    expect(failedPush.ok).toBe(false);
    expect(git(repo, "rev-parse", "refs/git-agents/pending-sync")).toBe(
      pendingHead,
    );

    const retry = await gitAddCommitPush(repo, "retry deletion", []);

    expect(retry.ok).toBe(true);
    expect(git(remote, "rev-parse", "HEAD")).toBe(pendingHead);
    expect(git(remote, "ls-tree", "-r", "--name-only", "HEAD")).not.toContain(
      ".claude/CLAUDE.md",
    );
  }, 20_000);

  it("retries a pending deletion after the deleted path leaves the review scope", async () => {
    const root = useTempDir("pending deletion reduced scope");
    const repo = join(root, "repo");
    const remote = join(root, "remote.git");
    const retained = join(repo, "retained.md");
    const deleted = join(repo, "deleted.md");
    const manifest = join(repo, ".git-agents-sync.json");

    execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
    execFileSync("git", ["init", repo], { stdio: "ignore" });
    git(repo, "config", "user.name", "git-agents tests");
    git(repo, "config", "user.email", "tests@example.com");
    git(repo, "remote", "add", "origin", remote);
    writeFileSync(retained, "retained", "utf8");
    writeFileSync(deleted, "delete me", "utf8");
    writeFileSync(manifest, '{"version":1}', "utf8");
    git(repo, "add", "--", "retained.md", "deleted.md", ".git-agents-sync.json");
    git(repo, "commit", "-m", "initial");
    git(repo, "push", "-u", "origin", "HEAD");

    rmSync(deleted);
    const rejectingHook = installRejectingPushHook(remote);
    const failedPush = await gitAddCommitPush(repo, "delete managed path", [
      "retained.md",
      "deleted.md",
      ".git-agents-sync.json",
    ]);
    rmSync(rejectingHook);
    const pendingHead = git(repo, "rev-parse", "HEAD");

    expect(failedPush.ok).toBe(false);
    expect(git(repo, "rev-parse", "refs/git-agents/pending-sync")).toBe(
      pendingHead,
    );

    const retry = await gitAddCommitPush(repo, "retry reduced scope", [
      "retained.md",
      ".git-agents-sync.json",
    ]);

    expect(retry.ok).toBe(true);
    expect(git(remote, "rev-parse", "HEAD")).toBe(pendingHead);
    expect(git(remote, "show", "HEAD:retained.md")).toBe("retained");
    expect(git(remote, "ls-tree", "-r", "--name-only", "HEAD")).not.toContain(
      "deleted.md",
    );
    expect(() =>
      git(repo, "show-ref", "--verify", "--quiet", "refs/git-agents/pending-sync")
    ).toThrow();
  }, 20_000);

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
