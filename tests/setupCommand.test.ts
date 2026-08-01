import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { runInternalCommand, type InternalDeps } from "../src/internal/commands";
import { runSetup, type SetupFlowDeps } from "../src/internal/setup";
import { InternalCommandError } from "../src/internal/errors";
import { readConfig, writeConfig } from "../src/utils/config";
import type { Config, ShellResult } from "../src/types";

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

function makeDeps(): InternalDeps {
  const homeDir = makeTmpDir("ga-setup-home");
  const configDir = makeTmpDir("ga-setup-config");
  return { homeDir, configDir, configFile: join(configDir, "config.json") };
}

const ok = (output?: string): ShellResult => ({ ok: true, output });
const fail = (error?: string): ShellResult => ({ ok: false, error });

function fakeSetupDeps(
  deps: InternalDeps,
  overrides: Partial<SetupFlowDeps> = {},
): SetupFlowDeps {
  return {
    checkGhInstalled: async () => ok(),
    checkGhAuth: async () => ok(),
    ghRepoExists: async () => ok(),
    ghCreateRepo: async () => ok(),
    ghGetRepoCloneUrl: async () => ok("git@github.com:user/git-agents-remote.git"),
    checkGitRepoExists: async () => ok(),
    cloneRepo: async () => {
      mkdirSync(join(deps.configDir, ".git"), { recursive: true });
      return ok();
    },
    isAlreadyCloned: () => existsSync(join(deps.configDir, ".git")),
    writeConfig: (config: Config) =>
      writeConfig(config, deps.configDir, deps.configFile),
    gitSetRemoteUrl: async () => ok(),
    countUnpushedCommits: async () => 0,
    removeClone: () => rmSync(deps.configDir, { recursive: true, force: true }),
    ...overrides,
  };
}

async function expectSetupError(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await promise;
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(InternalCommandError);
    expect((error as InternalCommandError).code).toBe(code);
  }
}

afterEach(() => {
  for (const dir of tmpDirs) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe("runSetup", () => {
  it("requires input on an unconfigured machine", async () => {
    const deps = makeDeps();

    await expectSetupError(
      runSetup(deps, undefined, fakeSetupDeps(deps)),
      "input-required",
    );
  });

  it("rejects malformed input", async () => {
    const deps = makeDeps();

    await expectSetupError(
      runSetup(deps, { remote: "ftp" }, fakeSetupDeps(deps)),
      "invalid-input",
    );
    await expectSetupError(
      runSetup(deps, { remote: "git" }, fakeSetupDeps(deps)),
      "invalid-input",
    );
  });

  it("configures via gh when the repo already exists", async () => {
    const deps = makeDeps();

    const result = await runSetup(
      deps,
      { remote: "gh" },
      fakeSetupDeps(deps),
    );

    expect(result.alreadyConfigured).toBe(false);
    expect(result.createdRepo).toBe(false);
    expect(result.config).toEqual({ remote: "gh" });
    expect(readConfig(deps.configFile)).toEqual({ remote: "gh" });
    expect(existsSync(join(deps.configDir, ".git"))).toBe(true);
  });

  it("creates the private repo when it does not exist yet", async () => {
    const deps = makeDeps();
    const created: string[] = [];

    const result = await runSetup(
      deps,
      { remote: "gh" },
      fakeSetupDeps(deps, {
        ghRepoExists: async () => fail(),
        ghCreateRepo: async (name) => {
          created.push(name);
          return ok();
        },
      }),
    );

    expect(result.createdRepo).toBe(true);
    expect(created).toEqual(["git-agents-remote"]);
  });

  it("reports gh missing and gh unauthenticated distinctly", async () => {
    const deps = makeDeps();

    await expectSetupError(
      runSetup(
        deps,
        { remote: "gh" },
        fakeSetupDeps(deps, { checkGhInstalled: async () => fail() }),
      ),
      "gh-not-installed",
    );
    await expectSetupError(
      runSetup(
        deps,
        { remote: "gh" },
        fakeSetupDeps(deps, { checkGhAuth: async () => fail() }),
      ),
      "gh-not-authenticated",
    );
  });

  it("configures via a custom git URL", async () => {
    const deps = makeDeps();

    const result = await runSetup(
      deps,
      { remote: "git", repoUrl: "git@example.com:me/agents.git" },
      fakeSetupDeps(deps),
    );

    expect(result.config).toEqual({
      remote: "git",
      repoUrl: "git@example.com:me/agents.git",
    });
    expect(readConfig(deps.configFile)).toEqual(result.config);
  });

  it("reports unreachable git URLs and clone failures distinctly", async () => {
    const deps = makeDeps();

    await expectSetupError(
      runSetup(
        deps,
        { remote: "git", repoUrl: "git@nowhere:x.git" },
        fakeSetupDeps(deps, { checkGitRepoExists: async () => fail() }),
      ),
      "invalid-repo-url",
    );
    await expectSetupError(
      runSetup(
        deps,
        { remote: "git", repoUrl: "git@example.com:me/agents.git" },
        fakeSetupDeps(deps, { cloneRepo: async () => fail("disk full") }),
      ),
      "clone-failed",
    );
  });

  it("is a safe no-op on a configured machine without input", async () => {
    const deps = makeDeps();
    writeFileSync(deps.configFile, JSON.stringify({ remote: "gh" }), "utf8");
    mkdirSync(join(deps.configDir, ".git"), { recursive: true });

    const result = await runSetup(deps, undefined, fakeSetupDeps(deps));

    expect(result).toEqual({
      alreadyConfigured: true,
      config: { remote: "gh" },
    });
  });

  it("refuses to reconfigure a configured machine without force", async () => {
    const deps = makeDeps();
    writeFileSync(deps.configFile, JSON.stringify({ remote: "gh" }), "utf8");
    mkdirSync(join(deps.configDir, ".git"), { recursive: true });

    await expectSetupError(
      runSetup(
        deps,
        { remote: "git", repoUrl: "git@example.com:me/new.git" },
        fakeSetupDeps(deps),
      ),
      "already-configured",
    );
  });

  it("re-clones fresh when forced on an already-cloned machine", async () => {
    const deps = makeDeps();
    writeFileSync(deps.configFile, JSON.stringify({ remote: "gh" }), "utf8");
    mkdirSync(join(deps.configDir, ".git", "stale"), { recursive: true });
    const cloned: string[] = [];
    const remoteUpdates: string[] = [];

    const result = await runSetup(
      deps,
      { remote: "git", repoUrl: "git@example.com:me/new.git", force: true },
      fakeSetupDeps(deps, {
        cloneRepo: async (url) => {
          cloned.push(url);
          expect(existsSync(join(deps.configDir, ".git", "stale"))).toBe(false);
          mkdirSync(join(deps.configDir, ".git"), { recursive: true });
          return ok();
        },
        gitSetRemoteUrl: async (_dir, url) => {
          remoteUpdates.push(url);
          return ok();
        },
      }),
    );

    expect(cloned).toEqual(["git@example.com:me/new.git"]);
    expect(remoteUpdates).toEqual([]);
    expect(result.recloned).toBe(true);
    expect(result.config.remote).toBe("git");
    expect(readConfig(deps.configFile)).toEqual(result.config);
  });

  it("refuses a forced re-clone that would discard unpushed commits", async () => {
    const deps = makeDeps();
    writeFileSync(deps.configFile, JSON.stringify({ remote: "gh" }), "utf8");
    mkdirSync(join(deps.configDir, ".git"), { recursive: true });

    await expectSetupError(
      runSetup(
        deps,
        { remote: "gh", force: true },
        fakeSetupDeps(deps, { countUnpushedCommits: async () => 2 }),
      ),
      "unpushed-commits",
    );
    expect(existsSync(join(deps.configDir, ".git"))).toBe(true);
  });

  it("discards unpushed commits on a forced re-clone with discardLocal", async () => {
    const deps = makeDeps();
    writeFileSync(deps.configFile, JSON.stringify({ remote: "gh" }), "utf8");
    mkdirSync(join(deps.configDir, ".git"), { recursive: true });

    const result = await runSetup(
      deps,
      { remote: "gh", force: true, discardLocal: true },
      fakeSetupDeps(deps, { countUnpushedCommits: async () => 2 }),
    );

    expect(result.recloned).toBe(true);
    expect(result.config).toEqual({ remote: "gh" });
  });

  it("does not report a re-clone on first-time setup", async () => {
    const deps = makeDeps();

    const result = await runSetup(deps, { remote: "gh" }, fakeSetupDeps(deps));

    expect(result.recloned).toBeUndefined();
  });

  it("flows through the command envelope with typed errors", async () => {
    const deps = makeDeps();
    deps.setup = fakeSetupDeps(deps, { checkGhInstalled: async () => fail() });

    const outcome = await runInternalCommand("setup", { remote: "gh" }, deps);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("gh-not-installed");
  });
});
