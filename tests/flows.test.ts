import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import {
  runGhPrecheck,
  runGhRepoCheck,
  runGhCreateRepo,
  runClone,
  runGitUrlValidation,
  runSyncLoad,
  runSyncExecute,
  SYNC_MANIFEST_FILE,
  type AgentDiffEntry,
} from "../src/utils/flows";
import type { AgentDef } from "../src/utils/agentDefs";

// ---- helpers ----

const ok = (output?: string) => async () => ({ ok: true, output });
const fail = (error?: string) => async () => ({ ok: false, error });

function tmpDir(): string {
  const dir = join(tmpdir(), `flows-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const cleanups: string[] = [];
function useTmp(): string {
  const d = tmpDir();
  cleanups.push(d);
  return d;
}

afterEach(() => {
  for (const d of cleanups.splice(0)) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});

// ---- runGhPrecheck ----

describe("runGhPrecheck", () => {
  it("returns gh-not-installed when gh is missing", async () => {
    const result = await runGhPrecheck({
      checkGhInstalled: fail("gh not found"),
      checkGhAuth: ok(),
    });
    expect(result.type).toBe("gh-not-installed");
  });

  it("returns needs-auth when gh is installed but not authenticated", async () => {
    const result = await runGhPrecheck({
      checkGhInstalled: ok("gh version 2.0"),
      checkGhAuth: fail("not authed"),
    });
    expect(result.type).toBe("needs-auth");
  });

  it("returns ok when gh is installed and authenticated", async () => {
    const result = await runGhPrecheck({
      checkGhInstalled: ok("gh version 2.0"),
      checkGhAuth: ok(),
    });
    expect(result.type).toBe("ok");
  });
});

// ---- runGhRepoCheck ----

describe("runGhRepoCheck", () => {
  it("returns not-found when repo does not exist", async () => {
    const result = await runGhRepoCheck("git-agents-remote", {
      ghRepoExists: fail(),
      ghGetRepoCloneUrl: ok(),
    });
    expect(result.type).toBe("not-found");
  });

  it("returns found with url when repo exists", async () => {
    const result = await runGhRepoCheck("git-agents-remote", {
      ghRepoExists: ok(),
      ghGetRepoCloneUrl: ok("git@github.com:user/git-agents-remote.git\n"),
    });
    expect(result).toEqual({ type: "found", url: "git@github.com:user/git-agents-remote.git" });
  });

  it("returns error when repo exists but URL fetch fails", async () => {
    const result = await runGhRepoCheck("git-agents-remote", {
      ghRepoExists: ok(),
      ghGetRepoCloneUrl: fail("no output"),
    });
    expect(result.type).toBe("error");
  });

  it("returns error when repo exists but URL is empty string", async () => {
    const result = await runGhRepoCheck("git-agents-remote", {
      ghRepoExists: ok(),
      ghGetRepoCloneUrl: ok(""),
    });
    expect(result.type).toBe("error");
  });
});

// ---- runGhCreateRepo ----

describe("runGhCreateRepo", () => {
  it("returns error when create fails", async () => {
    const result = await runGhCreateRepo("git-agents-remote", {
      ghCreateRepo: fail("already exists"),
      ghGetRepoCloneUrl: ok("git@github.com:user/repo.git"),
    });
    expect(result.type).toBe("error");
    expect((result as any).message).toContain("Failed to create repo");
  });

  it("returns ok with url when create and URL fetch succeed", async () => {
    const result = await runGhCreateRepo("git-agents-remote", {
      ghCreateRepo: ok(),
      ghGetRepoCloneUrl: ok("git@github.com:user/git-agents-remote.git\n"),
    });
    expect(result).toEqual({ type: "ok", url: "git@github.com:user/git-agents-remote.git" });
  });

  it("returns error when create succeeds but URL fetch fails", async () => {
    const result = await runGhCreateRepo("git-agents-remote", {
      ghCreateRepo: ok(),
      ghGetRepoCloneUrl: fail(),
    });
    expect(result.type).toBe("error");
    expect((result as any).message).toContain("Could not get repo URL");
  });
});

// ---- runClone ----

describe("runClone", () => {
  it("calls gitSetRemoteUrl and writes config when already cloned", async () => {
    let cloneCalled = false;
    let writtenConfig: any = null;
    let setUrlDir = "";
    let setUrlUrl = "";

    const result = await runClone("git@github.com:user/repo.git", "gh", "/my/config", {
      isAlreadyCloned: () => true,
      cloneRepo: async () => { cloneCalled = true; return { ok: true }; },
      writeConfig: (c) => { writtenConfig = c; },
      gitSetRemoteUrl: async (dir, url) => { setUrlDir = dir; setUrlUrl = url; return { ok: true }; },
    });

    expect(result.type).toBe("ok");
    expect(cloneCalled).toBe(false);
    expect(writtenConfig).toEqual({ remote: "gh", repoUrl: undefined });
    expect(setUrlDir).toBe("/my/config");
    expect(setUrlUrl).toBe("git@github.com:user/repo.git");
  });

  it("returns error when gitSetRemoteUrl fails (already cloned)", async () => {
    const result = await runClone("git@github.com:user/repo.git", "git", "/config", {
      isAlreadyCloned: () => true,
      cloneRepo: ok(),
      writeConfig: () => {},
      gitSetRemoteUrl: fail("remote not found"),
    });

    expect(result.type).toBe("error");
    expect((result as any).message).toContain("Failed to update remote URL");
  });

  it("calls cloneRepo and writes config when not yet cloned (gh remote)", async () => {
    let writtenConfig: any = null;

    const result = await runClone("git@github.com:user/repo.git", "gh", "/config", {
      isAlreadyCloned: () => false,
      cloneRepo: ok(),
      writeConfig: (c) => { writtenConfig = c; },
      gitSetRemoteUrl: ok(),
    });

    expect(result.type).toBe("ok");
    expect(writtenConfig).toEqual({ remote: "gh", repoUrl: undefined });
  });

  it("stores repoUrl in config for git remote type", async () => {
    let writtenConfig: any = null;

    await runClone("git@github.com:user/repo.git", "git", "/config", {
      isAlreadyCloned: () => false,
      cloneRepo: ok(),
      writeConfig: (c) => { writtenConfig = c; },
      gitSetRemoteUrl: ok(),
    });

    expect(writtenConfig).toEqual({ remote: "git", repoUrl: "git@github.com:user/repo.git" });
  });

  it("returns error when cloneRepo fails", async () => {
    const result = await runClone("git@github.com:user/repo.git", "git", "/config", {
      isAlreadyCloned: () => false,
      cloneRepo: fail("permission denied"),
      writeConfig: () => {},
      gitSetRemoteUrl: ok(),
    });

    expect(result.type).toBe("error");
    expect((result as any).message).toContain("Failed to clone");
  });
});

// ---- runGitUrlValidation ----

describe("runGitUrlValidation", () => {
  it("returns error when URL is unreachable", async () => {
    const result = await runGitUrlValidation("git@github.com:user/nonexistent.git", {
      checkGitRepoExists: fail("no route to host"),
    });
    expect(result.type).toBe("error");
    expect((result as any).message).toContain("git@github.com:user/nonexistent.git");
  });

  it("returns ok when URL is reachable", async () => {
    const result = await runGitUrlValidation("git@github.com:user/repo.git", {
      checkGitRepoExists: ok(),
    });
    expect(result.type).toBe("ok");
  });
});

// ---- runSyncLoad ----

function fixtureFile(root: string, relativePath: string, content: string): string {
  const target = join(root, ...relativePath.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  return target;
}

function testAgent(syncPaths: string[]): AgentDef {
  return {
    id: "test-agent",
    name: "Test Agent",
    syncPaths,
  };
}

function fixtureManifest(root: string, paths: string[]): string {
  return fixtureFile(
    root,
    SYNC_MANIFEST_FILE,
    `${JSON.stringify({ version: 1, paths }, null, 2)}\n`,
  );
}

function loadedDiffs(
  result: Awaited<ReturnType<typeof runSyncLoad>>,
): AgentDiffEntry[] {
  expect(result.type).toBe("ok");
  if (result.type !== "ok") {
    throw new Error(result.message);
  }
  return result.agentDiffs;
}

describe("runSyncLoad", () => {
  it("returns error when gitPull fails", async () => {
    const configDir = useTmp();
    const homeDir = useTmp();
    const result = await runSyncLoad("pull", [], configDir, {
      gitPull: fail("connection refused"),
    }, homeDir);

    expect(result.type).toBe("error");
    if (result.type === "error") {
      expect(result.message).toContain("Failed to pull remote");
    }
  });

  it("returns empty diffs when no harnesses are configured", async () => {
    const configDir = useTmp();
    const homeDir = useTmp();
    const result = await runSyncLoad("pull", [], configDir, {
      gitPull: ok(),
    }, homeDir);

    expect(loadedDiffs(result)).toEqual([]);
  });

  it("detects a root file and direct files inside a selected directory", async () => {
    const configDir = useTmp();
    const homeDir = useTmp();
    const def = testAgent([
      ".claude/CLAUDE.md",
      ".claude/agents",
    ]);
    fixtureFile(configDir, ".claude/CLAUDE.md", "remote instructions");
    fixtureFile(configDir, ".claude/agents/reviewer.md", "review agent");

    const result = await runSyncLoad("pull", [def], configDir, {
      gitPull: ok(),
    }, homeDir);
    const diffs = loadedDiffs(result);

    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.def).toEqual(def);
    expect(diffs[0]!.remoteCount).toBe(2);
    expect(diffs[0]!.localCount).toBe(0);
    expect(diffs[0]!.pathDiffs.map((diff) => ({
      path: diff.path,
      status: diff.status,
      kind: diff.remote?.kind,
      fileCount: diff.remote?.fileCount,
    }))).toEqual([
      {
        path: ".claude/CLAUDE.md",
        status: "added",
        kind: "file",
        fileCount: 1,
      },
      {
        path: ".claude/agents",
        status: "added",
        kind: "directory",
        fileCount: 1,
      },
    ]);
  });

  it("detects equal-size content modifications", async () => {
    const configDir = useTmp();
    const homeDir = useTmp();
    const def = testAgent([".gemini/GEMINI.md"]);
    fixtureFile(homeDir, ".gemini/GEMINI.md", "fresh");
    fixtureFile(configDir, ".gemini/GEMINI.md", "stale");

    const result = await runSyncLoad("push", [def], configDir, {
      gitPull: ok(),
    }, homeDir);
    const diffs = loadedDiffs(result);

    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.pathDiffs).toHaveLength(1);
    expect(diffs[0]!.pathDiffs[0]!.status).toBe("modified");
    expect(diffs[0]!.localCount).toBe(1);
    expect(diffs[0]!.remoteCount).toBe(1);
    expect(diffs[0]!.pathDiffs[0]!.local!.contentHash)
      .not.toBe(diffs[0]!.pathDiffs[0]!.remote!.contentHash);
  });

  it("ignores paths that are not selected by the harness", async () => {
    const configDir = useTmp();
    const homeDir = useTmp();
    const def = testAgent([".claude/skills"]);
    fixtureFile(homeDir, ".claude/skills/review/SKILL.md", "review");
    fixtureFile(homeDir, ".claude/cache/session.json", "private state");

    const result = await runSyncLoad("push", [def], configDir, {
      gitPull: ok(),
    }, homeDir);
    const diffs = loadedDiffs(result);

    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.pathDiffs.map((diff) => diff.path)).toEqual([
      ".claude/skills",
    ]);
    expect(diffs[0]!.localCount).toBe(1);
  });

  it.each([
    {
      harness: "Claude Code",
      legacyPath: ".claude/skills/review/SKILL.md",
      currentPath: ".claude/CLAUDE.md",
      syncPaths: [
        ".claude/CLAUDE.md",
        ".claude/agents",
        ".claude/rules",
        ".claude/skills",
        ".claude/commands",
      ],
    },
    {
      harness: "Gemini CLI",
      legacyPath: ".gemini/commands/review.toml",
      currentPath: ".gemini/GEMINI.md",
      syncPaths: [
        ".gemini/GEMINI.md",
        ".gemini/agents",
        ".gemini/commands",
        ".gemini/skills",
      ],
    },
    {
      harness: "OpenCode",
      legacyPath: ".config/opencode/commands/review.md",
      currentPath: ".config/opencode/AGENTS.md",
      syncPaths: [
        ".config/opencode/AGENTS.md",
        ".config/opencode/agents",
        ".config/opencode/commands",
        ".config/opencode/skills",
      ],
    },
  ])(
    "preserves newly selected local $harness paths when pulling a legacy remote",
    async ({ legacyPath, currentPath, syncPaths }) => {
      const configDir = useTmp();
      const homeDir = useTmp();
      const def = testAgent(syncPaths);
      fixtureFile(configDir, legacyPath, "legacy remote");
      const localCurrent = fixtureFile(homeDir, currentPath, "keep local");

      const loadResult = await runSyncLoad("pull", [def], configDir, {
        gitPull: ok(),
      }, homeDir);
      const diffs = loadedDiffs(loadResult);

      expect(diffs).toHaveLength(1);
      expect(diffs[0]!.pathDiffs.map((diff) => diff.path))
        .not.toContain(currentPath);

      const executeResult = await runSyncExecute(
        "pull",
        diffs,
        configDir,
        { gitAddCommitPush: ok() },
      );

      expect(executeResult.type).toBe("ok");
      expect(readFileSync(localCurrent, "utf8")).toBe("keep local");
    },
  );

  it("treats an initialized missing path as an explicit tombstone", async () => {
    const configDir = useTmp();
    const homeDir = useTmp();
    const syncPaths = [
      ".claude/CLAUDE.md",
      ".claude/skills",
    ];
    const def = testAgent(syncPaths);
    fixtureManifest(configDir, syncPaths);
    fixtureFile(configDir, ".claude/skills/review/SKILL.md", "review");
    const localInstructions = fixtureFile(
      homeDir,
      ".claude/CLAUDE.md",
      "delete after initialization",
    );

    const loadResult = await runSyncLoad("pull", [def], configDir, {
      gitPull: ok(),
    }, homeDir);
    const diffs = loadedDiffs(loadResult);

    expect(diffs[0]!.pathDiffs.map((diff) => [diff.path, diff.status]))
      .toEqual([
        [".claude/CLAUDE.md", "removed"],
        [".claude/skills", "added"],
      ]);

    const executeResult = await runSyncExecute(
      "pull",
      diffs,
      configDir,
      { gitAddCommitPush: ok() },
    );

    expect(executeResult.type).toBe("ok");
    expect(existsSync(localInstructions)).toBe(false);
  });
});

// ---- runSyncExecute ----

describe("runSyncExecute (pull)", () => {
  it("copies a root file and directory exactly, including stale deletion", async () => {
    const configDir = useTmp();
    const homeDir = useTmp();
    const def = testAgent([
      ".claude/CLAUDE.md",
      ".claude/agents",
    ]);
    const localInstructions = fixtureFile(
      homeDir,
      ".claude/CLAUDE.md",
      "local instructions",
    );
    const localStaleAgent = fixtureFile(
      homeDir,
      ".claude/agents/stale.md",
      "stale",
    );
    fixtureFile(configDir, ".claude/CLAUDE.md", "remote instructions");
    fixtureFile(configDir, ".claude/agents/reviewer.md", "review agent");

    const loadResult = await runSyncLoad("pull", [def], configDir, {
      gitPull: ok(),
    }, homeDir);
    const diffs = loadedDiffs(loadResult);
    let pushCalled = false;
    const result = await runSyncExecute("pull", diffs, configDir, {
      gitAddCommitPush: async () => { pushCalled = true; return { ok: true }; },
    });

    expect(result.type).toBe("ok");
    if (result.type === "ok") {
      expect(result.message).toContain("Pull complete");
    }
    expect(pushCalled).toBe(false);
    expect(readFileSync(localInstructions, "utf8")).toBe("remote instructions");
    expect(existsSync(localStaleAgent)).toBe(false);
    expect(
      readFileSync(
        join(homeDir, ".claude", "agents", "reviewer.md"),
        "utf8",
      ),
    ).toBe("review agent");
  });
});

describe("runSyncExecute (push)", () => {
  it("copies selected root and direct files without copying ignored state", async () => {
    const configDir = useTmp();
    const homeDir = useTmp();
    const def = testAgent([
      ".gemini/GEMINI.md",
      ".gemini/commands",
    ]);
    fixtureFile(homeDir, ".gemini/GEMINI.md", "fresh");
    fixtureFile(homeDir, ".gemini/commands/review.toml", "prompt = 'review'");
    fixtureFile(homeDir, ".gemini/cache/session.json", "private state");
    fixtureFile(configDir, ".gemini/GEMINI.md", "stale");
    fixtureFile(configDir, ".gemini/commands/obsolete.toml", "obsolete");

    const loadResult = await runSyncLoad("push", [def], configDir, {
      gitPull: ok(),
    }, homeDir);
    const diffs = loadedDiffs(loadResult);
    let pushedDir = "";
    let pushedMsg = "";
    let pushedPaths: string[] = [];
    const result = await runSyncExecute("push", [...diffs, ...diffs], configDir, {
      gitAddCommitPush: async (dir, msg, paths) => {
        pushedDir = dir;
        pushedMsg = msg;
        pushedPaths = paths;
        return { ok: true };
      },
    });

    expect(result.type).toBe("ok");
    if (result.type === "ok") {
      expect(result.message).toContain("Push complete");
    }
    expect(pushedDir).toBe(configDir);
    expect(pushedMsg).toMatch(/^sync: update harness files/);
    expect(pushedPaths).toEqual([
      ".gemini/GEMINI.md",
      ".gemini/commands",
      SYNC_MANIFEST_FILE,
    ]);
    expect(
      readFileSync(join(configDir, ".gemini", "GEMINI.md"), "utf8"),
    ).toBe("fresh");
    expect(
      readFileSync(
        join(configDir, ".gemini", "commands", "review.toml"),
        "utf8",
      ),
    ).toBe("prompt = 'review'");
    expect(
      existsSync(join(configDir, ".gemini", "commands", "obsolete.toml")),
    ).toBe(false);
    expect(existsSync(join(configDir, ".gemini", "cache"))).toBe(false);
  });

  it("deletes a destination-only target when the source has another selected path", async () => {
    const configDir = useTmp();
    const homeDir = useTmp();
    const def = testAgent([
      ".codex/AGENTS.md",
      ".codex/agents",
    ]);
    fixtureFile(homeDir, ".codex/AGENTS.md", "shared instructions");
    fixtureFile(configDir, ".codex/AGENTS.md", "shared instructions");
    const staleRemoteAgents = join(configDir, ".codex", "agents");
    fixtureFile(configDir, ".codex/agents/legacy.md", "legacy");
    fixtureManifest(configDir, def.syncPaths);

    const loadResult = await runSyncLoad("push", [def], configDir, {
      gitPull: ok(),
    }, homeDir);
    const diffs = loadedDiffs(loadResult);

    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.pathDiffs.map((diff) => [diff.path, diff.status]))
      .toEqual([
        [".codex/AGENTS.md", "unchanged"],
        [".codex/agents", "removed"],
      ]);

    let pushedPaths: string[] = [];
    const result = await runSyncExecute("push", diffs, configDir, {
      gitAddCommitPush: async (_dir, _message, paths) => {
        pushedPaths = paths;
        return { ok: true };
      },
    });

    expect(result.type).toBe("ok");
    expect(pushedPaths).toEqual([
      ".codex/AGENTS.md",
      ".codex/agents",
      SYNC_MANIFEST_FILE,
    ]);
    expect(existsSync(join(configDir, ".codex", "AGENTS.md"))).toBe(true);
    expect(existsSync(staleRemoteAgents)).toBe(false);
  });

  it("does not let shared skills activate deletions in the Codex root", async () => {
    const configDir = useTmp();
    const homeDir = useTmp();
    const def = testAgent([
      ".codex/AGENTS.md",
      ".codex/agents",
      ".agents/skills",
    ]);
    fixtureFile(homeDir, ".agents/skills/review/SKILL.md", "review");
    const remoteInstructions = fixtureFile(
      configDir,
      ".codex/AGENTS.md",
      "remote only",
    );

    const loadResult = await runSyncLoad("push", [def], configDir, {
      gitPull: ok(),
    }, homeDir);
    const diffs = loadedDiffs(loadResult);

    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.pathDiffs.map((diff) => diff.path)).toEqual([
      ".agents/skills",
    ]);

    const result = await runSyncExecute("push", diffs, configDir, {
      gitAddCommitPush: ok(),
    });

    expect(result.type).toBe("ok");
    expect(existsSync(remoteInstructions)).toBe(true);
  });

  it("records only reviewed paths in the manifest on the first successful push", async () => {
    const configDir = useTmp();
    const homeDir = useTmp();
    const def = testAgent([
      ".claude/CLAUDE.md",
      ".claude/agents",
      ".claude/rules",
    ]);
    fixtureFile(homeDir, ".claude/CLAUDE.md", "instructions");

    const loadResult = await runSyncLoad("push", [def], configDir, {
      gitPull: ok(),
    }, homeDir);
    const diffs = loadedDiffs(loadResult);
    let pushedPaths: string[] = [];

    const executeResult = await runSyncExecute(
      "push",
      diffs,
      configDir,
      {
        gitAddCommitPush: async (_dir, _message, paths) => {
          pushedPaths = paths;
          return { ok: true };
        },
      },
    );

    expect(executeResult.type).toBe("ok");
    expect(pushedPaths).toEqual([
      ".claude/CLAUDE.md",
      SYNC_MANIFEST_FILE,
    ]);
    expect(
      JSON.parse(
        readFileSync(join(configDir, SYNC_MANIFEST_FILE), "utf8"),
      ),
    ).toEqual({
      version: 1,
      paths: [
        ".claude/CLAUDE.md",
      ],
    });
  });

  it("rejects a symlinked manifest without writing through it", async () => {
    const configDir = useTmp();
    const homeDir = useTmp();
    const outsideDir = useTmp();
    const outsideManifest = join(outsideDir, "outside.json");
    const def = testAgent([".claude/CLAUDE.md"]);
    fixtureFile(homeDir, ".claude/CLAUDE.md", "instructions");
    const loadResult = await runSyncLoad("push", [def], configDir, {
      gitPull: ok(),
    }, homeDir);
    const diffs = loadedDiffs(loadResult);
    symlinkSync(
      outsideManifest,
      join(configDir, SYNC_MANIFEST_FILE),
      "file",
    );
    let pushCalled = false;

    const executeResult = await runSyncExecute(
      "push",
      diffs,
      configDir,
      {
        gitAddCommitPush: async () => {
          pushCalled = true;
          return { ok: true };
        },
      },
    );

    expect(executeResult.type).toBe("error");
    if (executeResult.type === "error") {
      expect(executeResult.message).toContain("must be a regular file");
    }
    expect(pushCalled).toBe(false);
    expect(existsSync(outsideManifest)).toBe(false);
    expect(
      existsSync(join(configDir, ".claude", "CLAUDE.md")),
    ).toBe(false);
  });

  it("returns ok when gitAddCommitPush reports nothing to commit", async () => {
    const configDir = useTmp();
    let pushedPaths = ["not-called"];
    const result = await runSyncExecute("push", [], configDir, {
      gitAddCommitPush: async (_dir, _message, paths) => {
        pushedPaths = paths;
        return { ok: true, output: "Nothing to commit" };
      },
    });

    expect(result.type).toBe("ok");
    expect(pushedPaths).toEqual([]);
  });

  it("returns error when gitAddCommitPush fails", async () => {
    const configDir = useTmp();
    const result = await runSyncExecute("push", [], configDir, {
      gitAddCommitPush: fail("remote rejected"),
    });

    expect(result.type).toBe("error");
    if (result.type === "error") {
      expect(result.message).toContain("Failed to push");
      expect(result.message).toContain("remote rejected");
    }
  });

  it("returns error when mirroring a selected path throws", async () => {
    const temp = useTmp();
    const source = fixtureFile(temp, "source.md", "source");
    const blockingFile = fixtureFile(temp, "blocking-file", "blocker");
    let pushCalled = false;
    const fakeEntry: AgentDiffEntry = {
      def: testAgent([".claude/CLAUDE.md"]),
      pathDiffs: [{
        path: ".claude/CLAUDE.md",
        localBasePath: temp,
        remoteBasePath: temp,
        localPath: source,
        remotePath: join(blockingFile, "CLAUDE.md"),
        status: "added",
        local: {
          kind: "file",
          fileCount: 1,
          contentHash: "local",
        },
        remote: null,
      }],
      remoteCount: 0,
      localCount: 1,
    };

    const result = await runSyncExecute("push", [fakeEntry], temp, {
      gitAddCommitPush: async () => {
        pushCalled = true;
        return { ok: true };
      },
    });

    expect(result.type).toBe("error");
    if (result.type === "error") {
      expect(result.message).toContain("Failed to sync paths");
    }
    expect(pushCalled).toBe(false);
  });
});

describe("runSyncExecute stale review safety", () => {
  it.each([
    { mode: "pull" as const, changedSide: "source" as const },
    { mode: "pull" as const, changedSide: "destination" as const },
    { mode: "push" as const, changedSide: "source" as const },
    { mode: "push" as const, changedSide: "destination" as const },
  ])(
    "does not mutate any path when the $changedSide changes before $mode",
    async ({ mode, changedSide }) => {
      const configDir = useTmp();
      const homeDir = useTmp();
      const def = testAgent([
        ".claude/CLAUDE.md",
        ".claude/agents",
      ]);
      const localInstructions = fixtureFile(
        homeDir,
        ".claude/CLAUDE.md",
        "local instructions",
      );
      const remoteInstructions = fixtureFile(
        configDir,
        ".claude/CLAUDE.md",
        "remote instructions",
      );
      const localAgent = fixtureFile(
        homeDir,
        ".claude/agents/reviewer.md",
        "local agent",
      );
      const remoteAgent = fixtureFile(
        configDir,
        ".claude/agents/reviewer.md",
        "remote agent",
      );

      const loadResult = await runSyncLoad(mode, [def], configDir, {
        gitPull: ok(),
      }, homeDir);
      const diffs = loadedDiffs(loadResult);
      const changedPath = changedSide === "source"
        ? mode === "pull" ? remoteAgent : localAgent
        : mode === "pull" ? localAgent : remoteAgent;
      writeFileSync(changedPath, "changed after review");

      let pushCalled = false;
      const executeResult = await runSyncExecute(
        mode,
        diffs,
        configDir,
        {
          gitAddCommitPush: async () => {
            pushCalled = true;
            return { ok: true };
          },
        },
      );

      expect(executeResult.type).toBe("error");
      if (executeResult.type === "error") {
        expect(executeResult.message).toContain("changed since review");
      }
      expect(pushCalled).toBe(false);
      expect(readFileSync(localInstructions, "utf8"))
        .toBe("local instructions");
      expect(readFileSync(remoteInstructions, "utf8"))
        .toBe("remote instructions");
      expect(readFileSync(changedPath, "utf8"))
        .toBe("changed after review");
    },
  );
});

for (const mode of ["pull", "push"] as const) {
  describe(`runSyncExecute (${mode} empty-source safety)`, () => {
    it("does not delete destination-only content when the harness source is empty", async () => {
      const configDir = useTmp();
      const homeDir = useTmp();
      const def = testAgent([".codex/AGENTS.md"]);
      const destination = mode === "pull"
        ? fixtureFile(homeDir, ".codex/AGENTS.md", "local only")
        : fixtureFile(configDir, ".codex/AGENTS.md", "remote only");

      const loadResult = await runSyncLoad(mode, [def], configDir, {
        gitPull: ok(),
      }, homeDir);
      const diffs = loadedDiffs(loadResult);

      expect(diffs).toEqual([]);

      const executeResult = await runSyncExecute(mode, diffs, configDir, {
        gitAddCommitPush: ok(),
      });

      expect(executeResult.type).toBe("ok");
      expect(existsSync(destination)).toBe(true);
    });
  });
}
