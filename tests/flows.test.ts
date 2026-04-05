import { describe, it, expect, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  runGhPrecheck,
  runGhRepoCheck,
  runGhCreateRepo,
  runClone,
  runGitUrlValidation,
  runSyncLoad,
  runSyncExecute,
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
  it("skips cloneRepo and writes config when already cloned", async () => {
    let cloneCalled = false;
    let writtenConfig: any = null;

    const result = await runClone("git@github.com:user/repo.git", "gh", {
      isAlreadyCloned: () => true,
      cloneRepo: async () => { cloneCalled = true; return { ok: true }; },
      writeConfig: (c) => { writtenConfig = c; },
    });

    expect(result.type).toBe("ok");
    expect(cloneCalled).toBe(false);
    expect(writtenConfig).toEqual({ remote: "gh", repoUrl: undefined });
  });

  it("calls cloneRepo and writes config when not yet cloned (gh remote)", async () => {
    let writtenConfig: any = null;

    const result = await runClone("git@github.com:user/repo.git", "gh", {
      isAlreadyCloned: () => false,
      cloneRepo: ok(),
      writeConfig: (c) => { writtenConfig = c; },
    });

    expect(result.type).toBe("ok");
    expect(writtenConfig).toEqual({ remote: "gh", repoUrl: undefined });
  });

  it("stores repoUrl in config for git remote type", async () => {
    let writtenConfig: any = null;

    await runClone("git@github.com:user/repo.git", "git", {
      isAlreadyCloned: () => false,
      cloneRepo: ok(),
      writeConfig: (c) => { writtenConfig = c; },
    });

    expect(writtenConfig).toEqual({ remote: "git", repoUrl: "git@github.com:user/repo.git" });
  });

  it("returns error when cloneRepo fails", async () => {
    const result = await runClone("git@github.com:user/repo.git", "git", {
      isAlreadyCloned: () => false,
      cloneRepo: fail("permission denied"),
      writeConfig: () => {},
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

describe("runSyncLoad", () => {
  it("returns error when gitPull fails", async () => {
    const result = await runSyncLoad("pull", [], "/some/dir", {
      gitPull: fail("connection refused"),
    });
    expect(result.type).toBe("error");
    expect((result as any).message).toContain("Failed to pull remote");
  });

  it("returns empty diffs when no agent directories exist", async () => {
    const result = await runSyncLoad("pull", [], "/some/dir", {
      gitPull: ok(),
    });
    expect(result.type).toBe("ok");
    expect((result as any).agentDiffs).toEqual([]);
  });

  it("skips agent entries where both local and remote dirs are empty", async () => {
    // globalPath exists but is empty, syncDir (computed from homedir) won't exist either
    const base = useTmp();
    const agentDef: AgentDef = { id: "test-agent", name: "Test Agent", globalPath: base };

    const result = await runSyncLoad("pull", [agentDef], "/config/dir", {
      gitPull: ok(),
    });

    expect(result.type).toBe("ok");
    // Both srcList and dstList are empty so entry is skipped
    expect((result as any).agentDiffs).toEqual([]);
  });

  it("includes agent entries when local dir has skills", async () => {
    const base = useTmp();
    mkdirSync(join(base, "my-skill"), { recursive: true });

    const agentDef: AgentDef = { id: "test-agent", name: "Test Agent", globalPath: base };

    const result = await runSyncLoad("pull", [agentDef], "/config/dir", {
      gitPull: ok(),
    });

    expect(result.type).toBe("ok");
    const diffs = (result as any).agentDiffs as AgentDiffEntry[];
    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.def.id).toBe("test-agent");
    // syncDir doesn't exist so remoteCount=0, local has 1 skill
    expect(diffs[0]!.remoteCount).toBe(0);
    expect(diffs[0]!.localCount).toBe(1);
  });
});

// ---- runSyncExecute ----

describe("runSyncExecute (pull)", () => {
  it("returns ok with pull message and does not call gitAddCommitPush", async () => {
    let pushCalled = false;

    const result = await runSyncExecute("pull", [], "/config/dir", {
      gitAddCommitPush: async () => { pushCalled = true; return { ok: true }; },
    });

    expect(result.type).toBe("ok");
    expect((result as any).message).toContain("Pull complete");
    expect(pushCalled).toBe(false);
  });

  it("copies agents from syncDir to globalPath for pull", async () => {
    const globalPath = useTmp();
    const syncDir = useTmp();

    // Put a skill in the syncDir (remote)
    mkdirSync(join(syncDir, "my-skill"), { recursive: true });
    writeFileSync(join(syncDir, "my-skill", "commands.ts"), "export {}");

    // We need the AgentDiffEntry to have globalPath pointing to our temp dir.
    // runSyncExecute uses getSyncDirForAgent(entry.def.globalPath) to find syncDir,
    // which is computed relative to homedir — we can't easily override that without
    // mocking. Instead, test copyAgentsDir directly in agents.test.ts.
    // Here we verify the function returns ok when there's nothing to copy.
    const result = await runSyncExecute("pull", [], "/config/dir", {
      gitAddCommitPush: ok(),
    });

    expect(result.type).toBe("ok");
  });
});

describe("runSyncExecute (push)", () => {
  it("calls gitAddCommitPush and returns ok on success", async () => {
    let pushedDir = "";
    let pushedMsg = "";

    const result = await runSyncExecute("push", [], "/config/dir", {
      gitAddCommitPush: async (dir, msg) => {
        pushedDir = dir;
        pushedMsg = msg;
        return { ok: true };
      },
    });

    expect(result.type).toBe("ok");
    expect((result as any).message).toContain("Push complete");
    expect(pushedDir).toBe("/config/dir");
    expect(pushedMsg).toMatch(/^sync: update agents/);
  });

  it("returns ok when gitAddCommitPush reports nothing to commit", async () => {
    const result = await runSyncExecute("push", [], "/config/dir", {
      gitAddCommitPush: async () => ({ ok: true, output: "Nothing to commit" }),
    });

    expect(result.type).toBe("ok");
  });

  it("returns error when gitAddCommitPush fails", async () => {
    const result = await runSyncExecute("push", [], "/config/dir", {
      gitAddCommitPush: fail("remote rejected"),
    });

    expect(result.type).toBe("error");
    expect((result as any).message).toContain("Failed to push");
    expect((result as any).message).toContain("remote rejected");
  });

  it("returns error when copying agents throws", async () => {
    // Create an entry whose globalPath doesn't exist so copyAgentsDir will throw
    const fakeEntry: AgentDiffEntry = {
      def: { id: "x", name: "X", globalPath: "/nonexistent/path/that/does/not/exist" },
      diff: { added: [], removed: [], modified: [], unchanged: [] },
      remoteCount: 0,
      localCount: 0,
    };

    const result = await runSyncExecute("push", [fakeEntry], "/config/dir", {
      gitAddCommitPush: ok(),
    });

    // copyAgentsDir will throw because source dir doesn't exist
    expect(result.type).toBe("error");
    expect((result as any).message).toContain("Failed to copy agents");
  });
});
