import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { runInternalCommand, type InternalDeps } from "../src/internal/commands";
import { runSyncCommand, type SyncFlowDeps } from "../src/internal/sync";
import { InternalCommandError } from "../src/internal/errors";

let tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = join(
    tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

function makeDeps(sync?: SyncFlowDeps): InternalDeps {
  const homeDir = makeTmpDir("ga-sync-home");
  const configDir = makeTmpDir("ga-sync-config");
  return { homeDir, configDir, configFile: join(configDir, "config.json"), sync };
}

function fakeFlowDeps() {
  const pushes: string[][] = [];
  const deps: SyncFlowDeps = {
    gitPull: async () => ({ ok: true }),
    gitAddCommitPush: async (_dir, _message, paths) => {
      pushes.push(paths);
      return { ok: true };
    },
  };
  return { deps, pushes };
}

afterEach(() => {
  for (const dir of tmpDirs) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe("runSyncCommand", () => {
  it("previews a push without executing anything", async () => {
    const { deps: flowDeps, pushes } = fakeFlowDeps();
    const deps = makeDeps();
    mkdirSync(join(deps.homeDir, ".claude"), { recursive: true });
    writeFileSync(join(deps.homeDir, ".claude", "CLAUDE.md"), "# rules\n", "utf8");

    const result = await runSyncCommand("push", deps, undefined, flowDeps);

    expect(result.executed).toBe(false);
    const claude = result.agents.find((a) => a.agentId === "claude-code")!;
    const entry = claude.paths.find((p) => p.path === ".claude/CLAUDE.md")!;
    expect(entry.status).toBe("added");
    expect(entry.localHash).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.remoteHash).toBeNull();
    expect(pushes).toHaveLength(0);
    expect(existsSync(join(deps.configDir, ".claude"))).toBe(false);
  });

  it("executes a push, mirroring files and committing scoped paths", async () => {
    const { deps: flowDeps, pushes } = fakeFlowDeps();
    const deps = makeDeps();
    mkdirSync(join(deps.homeDir, ".claude"), { recursive: true });
    writeFileSync(join(deps.homeDir, ".claude", "CLAUDE.md"), "# rules\n", "utf8");

    const preview = await runSyncCommand("push", deps, undefined, flowDeps);
    const expected = preview.agents.flatMap((agent) =>
      agent.paths.map((path) => ({ agentId: agent.agentId, ...path })),
    );
    const result = await runSyncCommand(
      "push",
      deps,
      { execute: true, expected },
      flowDeps,
    );

    expect(result.executed).toBe(true);
    expect(
      readFileSync(join(deps.configDir, ".claude", "CLAUDE.md"), "utf8"),
    ).toBe("# rules\n");
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain(".claude/CLAUDE.md");
    expect(pushes[0]).toContain(".git-agents-sync.json");
  });

  it("refuses execution when files changed since the preview", async () => {
    const { deps: flowDeps, pushes } = fakeFlowDeps();
    const deps = makeDeps(flowDeps);
    mkdirSync(join(deps.homeDir, ".claude"), { recursive: true });
    writeFileSync(join(deps.homeDir, ".claude", "CLAUDE.md"), "# rules\n", "utf8");

    const preview = await runSyncCommand("push", deps, undefined, flowDeps);
    const expected = preview.agents.flatMap((agent) =>
      agent.paths.map((path) => ({ agentId: agent.agentId, ...path })),
    );

    writeFileSync(
      join(deps.homeDir, ".claude", "CLAUDE.md"),
      "# changed since preview\n",
      "utf8",
    );

    const outcome = await runInternalCommand(
      "push",
      { execute: true, expected },
      deps,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("stale-inputs");
    expect(pushes).toHaveLength(0);
  });

  it("executes a pull, mirroring remote files into the home dir", async () => {
    const { deps: flowDeps } = fakeFlowDeps();
    const deps = makeDeps();
    mkdirSync(join(deps.configDir, ".gemini"), { recursive: true });
    writeFileSync(
      join(deps.configDir, ".gemini", "GEMINI.md"),
      "# from remote\n",
      "utf8",
    );

    const result = await runSyncCommand(
      "pull",
      deps,
      { execute: true },
      flowDeps,
    );

    expect(result.executed).toBe(true);
    expect(
      readFileSync(join(deps.homeDir, ".gemini", "GEMINI.md"), "utf8"),
    ).toBe("# from remote\n");
  });

  it("surfaces pull failures as sync-load-failed", async () => {
    const deps = makeDeps();
    const failing: SyncFlowDeps = {
      gitPull: async () => ({ ok: false, error: "network down" }),
      gitAddCommitPush: async () => ({ ok: true }),
    };

    try {
      await runSyncCommand("pull", deps, undefined, failing);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InternalCommandError);
      expect((error as InternalCommandError).code).toBe("sync-load-failed");
      expect((error as InternalCommandError).message).toContain("network down");
    }
  });

  it("rejects malformed input with invalid-input", async () => {
    const { deps: flowDeps } = fakeFlowDeps();

    try {
      await runSyncCommand("push", makeDeps(), { execute: "yes" }, flowDeps);
      expect.unreachable();
    } catch (error) {
      expect((error as InternalCommandError).code).toBe("invalid-input");
    }
  });
});
