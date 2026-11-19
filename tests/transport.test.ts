import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  runTransportAbort,
  runTransportBegin,
  runTransportCommit,
  runTransportResolve,
} from "../src/internal/transport";
import { defaultSetupFlowDeps, runSetup } from "../src/internal/setup";
import { propagateCanonical } from "../src/canonical/canonical";
import { InternalCommandError } from "../src/internal/errors";
import {
  runInternalCommand,
  type InternalDeps,
  type StatusReport,
} from "../src/internal/commands";
import type { GatherResult } from "../src/canonical/gather";
import type { HarnessStageResult } from "../src/internal/harnessCommands";

// Keep temp-repo commits independent of the host's global git config.
process.env.GIT_CONFIG_COUNT = "1";
process.env.GIT_CONFIG_KEY_0 = "commit.gpgsign";
process.env.GIT_CONFIG_VALUE_0 = "false";

const tempDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = join(
    tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

function makeBare(): string {
  const bare = join(makeTmpDir("ga-transport-remote"), "remote.git");
  execFileSync("git", ["init", "--bare", "-b", "main", bare], {
    stdio: "ignore",
  });
  return bare;
}

function makeMachine(bare: string): InternalDeps {
  const homeDir = makeTmpDir("ga-transport-home");
  const configDir = join(makeTmpDir("ga-transport-clone"), "clone");
  execFileSync("git", ["clone", bare, configDir], { stdio: "ignore" });
  execFileSync("git", ["-C", configDir, "checkout", "-B", "main"], {
    stdio: "ignore",
  });
  return { homeDir, configDir, configFile: join(configDir, "config.json") };
}

function writeHome(deps: InternalDeps, relPath: string, content: string): void {
  const target = join(deps.homeDir, ...relPath.split("/"));
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, content, "utf8");
}

function writeHomeBytes(
  deps: InternalDeps,
  relPath: string,
  content: Buffer,
): void {
  const target = join(deps.homeDir, ...relPath.split("/"));
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, content);
}

function readHome(deps: InternalDeps, relPath: string): string {
  return readFileSync(join(deps.homeDir, ...relPath.split("/")), "utf8");
}

async function fullSync(deps: InternalDeps): Promise<void> {
  const begin = await runTransportBegin(deps);
  expect(begin.state).toBe("clean");
  await runTransportCommit(deps, undefined);
}

// Rewrite the remote from scratch: a new root commit force-pushed over
// whatever history the machines synced against.
function rewriteRemote(bare: string): void {
  const rewrite = join(makeTmpDir("ga-transport-rewrite"), "repo");
  execFileSync("git", ["init", "-b", "main", rewrite], { stdio: "ignore" });
  writeFileSync(join(rewrite, "seed.txt"), "new root\n", "utf8");
  execFileSync("git", ["-C", rewrite, "add", "-A"], { stdio: "ignore" });
  execFileSync(
    "git",
    ["-C", rewrite, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "new root"],
    { stdio: "ignore" },
  );
  execFileSync("git", ["-C", rewrite, "push", "--force", bare, "main"], {
    stdio: "ignore",
  });
}

async function expectCode(
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
  for (const dir of tempDirs) {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
  tempDirs.length = 0;
});

describe("transport", () => {
  it("requires a configured clone", async () => {
    const homeDir = makeTmpDir("ga-transport-home");
    const configDir = makeTmpDir("ga-transport-noclone");
    const deps = { homeDir, configDir, configFile: join(configDir, "config.json") };

    await expectCode(runTransportBegin(deps), "not-configured");
  });

  it("syncs a first machine to an empty remote", async () => {
    const bare = makeBare();
    const a = makeMachine(bare);
    writeHome(a, ".claude/CLAUDE.md", "shared line\ncommon\n");

    const begin = await runTransportBegin(a);
    expect(begin.state).toBe("clean");
    if (begin.state === "clean") {
      expect(begin.outgoing).toEqual([
        { path: ".claude/CLAUDE.md", status: "added" },
      ]);
      expect(begin.incoming).toEqual([]);
    }

    const commit = await runTransportCommit(a, undefined);
    expect(commit.pushed).toBe(true);

    const log = execFileSync("git", ["-C", a.configDir, "log", "--oneline", "origin/main"], {
      encoding: "utf8",
    });
    expect(log).toContain("sync: local harness state");
  }, 30000);

  it("is a no-op when nothing changed", async () => {
    const bare = makeBare();
    const a = makeMachine(bare);
    writeHome(a, ".claude/CLAUDE.md", "shared line\ncommon\n");
    await fullSync(a);

    const begin = await runTransportBegin(a);
    expect(begin.state).toBe("clean");
    if (begin.state === "clean") {
      expect(begin.outgoing).toEqual([]);
      expect(begin.incoming).toEqual([]);
    }
    const commit = await runTransportCommit(a, undefined);
    expect(commit.mirroredBack).toEqual([]);
  }, 30000);

  it("carries changes between machines without conflicts", async () => {
    const bare = makeBare();
    const a = makeMachine(bare);
    writeHome(a, ".claude/CLAUDE.md", "shared line\ncommon\n");
    await fullSync(a);

    const b = makeMachine(bare);
    writeHome(b, ".gemini/GEMINI.md", "gemini rules\n");
    const begin = await runTransportBegin(b);
    expect(begin.state).toBe("clean");
    if (begin.state === "clean") {
      expect(begin.outgoing).toEqual([
        { path: ".gemini/GEMINI.md", status: "added" },
      ]);
    }
    await runTransportCommit(b, undefined);
    expect(readHome(b, ".claude/CLAUDE.md")).toBe("shared line\ncommon\n");

    await fullSync(a);
    expect(readHome(a, ".gemini/GEMINI.md")).toBe("gemini rules\n");
  }, 30000);

  it("surfaces a real conflict with base, local, and remote, then resolves it", async () => {
    const bare = makeBare();
    const a = makeMachine(bare);
    writeHome(a, ".claude/CLAUDE.md", "shared line\ncommon\n");
    await fullSync(a);

    const b = makeMachine(bare);
    writeHome(a, ".claude/CLAUDE.md", "A line\ncommon\n");
    await fullSync(a);
    writeHome(b, ".claude/CLAUDE.md", "B line\ncommon\n");

    const begin = await runTransportBegin(b);
    expect(begin.state).toBe("conflicts");
    if (begin.state !== "conflicts") return;
    expect(begin.conflicts).toHaveLength(1);
    const conflict = begin.conflicts[0]!;
    expect(conflict.path).toBe(".claude/CLAUDE.md");
    expect(conflict.binary).toBe(false);
    expect(conflict.base).toContain("shared line");
    expect(conflict.local).toContain("B line");
    expect(conflict.remote).toContain("A line");

    await expectCode(runTransportCommit(b, undefined), "unresolved-conflicts");
    await expectCode(runTransportBegin(b), "transport-in-progress");
    await expectCode(
      runTransportResolve(b, { files: [{ path: ".claude/skills", content: "x" }] }),
      "not-conflicted",
    );

    const resolved = await runTransportResolve(b, {
      files: [{ path: ".claude/CLAUDE.md", content: "A and B line\ncommon\n" }],
    });
    expect(resolved.remaining).toEqual([]);

    const commit = await runTransportCommit(b, undefined);
    expect(commit.mergeCompleted).toBe(true);
    expect(commit.pushed).toBe(true);
    expect(readHome(b, ".claude/CLAUDE.md")).toBe("A and B line\ncommon\n");

    await fullSync(a);
    expect(readHome(a, ".claude/CLAUDE.md")).toBe("A and B line\ncommon\n");
  }, 60000);

  it("aborts a conflicted merge and restores the working state", async () => {
    const bare = makeBare();
    const a = makeMachine(bare);
    writeHome(a, ".claude/CLAUDE.md", "shared line\ncommon\n");
    await fullSync(a);

    const b = makeMachine(bare);
    writeHome(a, ".claude/CLAUDE.md", "A line\ncommon\n");
    await fullSync(a);
    writeHome(b, ".claude/CLAUDE.md", "B line\ncommon\n");

    const begin = await runTransportBegin(b);
    expect(begin.state).toBe("conflicts");

    const abort = await runTransportAbort(b);
    expect(abort.aborted).toBe(true);
    expect(readHome(b, ".claude/CLAUDE.md")).toBe("B line\ncommon\n");

    const again = await runTransportAbort(b);
    expect(again.aborted).toBe(false);

    const retry = await runTransportBegin(b);
    expect(retry.state).toBe("conflicts");
  }, 60000);

  it("defers the push when asked; a fresh begin/commit pushes later", async () => {
    const bare = makeBare();
    const a = makeMachine(bare);
    writeHome(a, ".claude/CLAUDE.md", "shared line\ncommon\n");

    const begin = await runTransportBegin(a);
    expect(begin.state).toBe("clean");
    const deferred = await runTransportCommit(a, { deferPush: true });
    expect(deferred.pushed).toBe(false);
    expect(deferred.pushDeferred).toBe(true);

    const remoteBefore = execFileSync(
      "git",
      ["-C", a.configDir, "ls-remote", "--heads", "origin"],
      { encoding: "utf8" },
    );
    expect(remoteBefore.trim()).toBe("");

    const again = await runTransportBegin(a);
    expect(again.state).toBe("clean");
    const pushed = await runTransportCommit(a, undefined);
    expect(pushed.pushed).toBe(true);
    expect(pushed.pushDeferred).toBe(false);
  }, 30000);

  it("points a failed merge at transport-abort", async () => {
    const bare = makeBare();
    const a = makeMachine(bare);
    writeHome(a, ".claude/CLAUDE.md", "shared line\ncommon\n");
    await fullSync(a);

    // Losing the remote entirely fails the pull without conflicts and
    // without the unrelated-histories signature: the generic path.
    rmSync(bare, { recursive: true, force: true });
    writeHome(a, ".claude/CLAUDE.md", "shared line\ncommon\nlocal edit\n");

    try {
      await runTransportBegin(a);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InternalCommandError);
      const typed = error as InternalCommandError;
      expect(typed.code).toBe("transport-failed");
      expect(typed.message).toContain("transport-abort");
    }

    // The state marker must survive the failure so abort can still
    // restore the pre-sync point.
    expect(existsSync(join(a.configDir, ".git-agents-transport.json"))).toBe(
      true,
    );
    const abort = await runTransportAbort(a);
    expect(abort.aborted).toBe(true);
    expect(existsSync(join(a.configDir, ".git-agents-transport.json"))).toBe(
      false,
    );
  }, 30000);

  it("reports a rewritten remote as unrelated-histories with a remedy", async () => {
    const bare = makeBare();
    const a = makeMachine(bare);
    writeHome(a, ".claude/CLAUDE.md", "shared line\ncommon\n");
    await fullSync(a);
    rewriteRemote(bare);

    writeHome(a, ".claude/CLAUDE.md", "shared line\ncommon\nlocal edit\n");
    try {
      await runTransportBegin(a);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InternalCommandError);
      const typed = error as InternalCommandError;
      expect(typed.code).toBe("unrelated-histories");
      expect(typed.message).toContain("transport-abort");
      expect(typed.message).toContain("force:true");
    }
  }, 30000);

  it("recovers from a rewritten remote: abort, forced re-clone, clean sync", async () => {
    const bare = makeBare();
    const a = makeMachine(bare);
    writeHome(a, ".claude/CLAUDE.md", "shared line\ncommon\n");
    await fullSync(a);
    rewriteRemote(bare);

    writeHome(a, ".claude/CLAUDE.md", "shared line\ncommon\nlocal edit\n");
    await expectCode(runTransportBegin(a), "unrelated-histories");

    const abort = await runTransportAbort(a);
    expect(abort.aborted).toBe(true);

    // The fetch already moved origin/main to the new root, so the old
    // history counts as unpushed: the guard demands an explicit discard.
    const flow = defaultSetupFlowDeps(a);
    const input = { remote: "git" as const, repoUrl: bare, force: true };
    await expectCode(runSetup(a, input, flow), "unpushed-commits");

    const result = await runSetup(a, { ...input, discardLocal: true }, flow);
    expect(result.recloned).toBe(true);

    const begin = await runTransportBegin(a);
    expect(begin.state).toBe("clean");
    const commit = await runTransportCommit(a, undefined);
    expect(commit.pushed).toBe(true);
    expect(readHome(a, ".claude/CLAUDE.md")).toBe(
      "shared line\ncommon\nlocal edit\n",
    );
  }, 30000);

  it("refuses transport-commit without a transport in progress", async () => {
    const bare = makeBare();
    const a = makeMachine(bare);

    await expectCode(runTransportCommit(a, undefined), "no-transport");
  }, 30000);

  it("restores the pre-sync state when a clean transport is declined", async () => {
    const bare = makeBare();
    const a = makeMachine(bare);
    writeHome(a, ".claude/CLAUDE.md", "shared line\ncommon\n");
    await fullSync(a);

    const b = makeMachine(bare);
    writeHome(a, ".claude/CLAUDE.md", "A v2\ncommon\n");
    await fullSync(a);
    writeHome(b, ".gemini/GEMINI.md", "gemini rules\n");

    const begin = await runTransportBegin(b);
    expect(begin.state).toBe("clean");
    if (begin.state === "clean") {
      expect(begin.outgoing).toEqual([
        { path: ".gemini/GEMINI.md", status: "added" },
      ]);
    }

    const abort = await runTransportAbort(b);
    expect(abort.aborted).toBe(true);
    expect(existsSync(join(b.homeDir, ".claude", "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(b.homeDir, ".gemini", "GEMINI.md"))).toBe(true);

    const retry = await runTransportBegin(b);
    expect(retry.state).toBe("clean");
    if (retry.state === "clean") {
      expect(retry.outgoing).toEqual([
        { path: ".gemini/GEMINI.md", status: "added" },
      ]);
    }
    await runTransportCommit(b, undefined);
    expect(readHome(b, ".claude/CLAUDE.md")).toBe("A v2\ncommon\n");
  }, 60000);

  it("resolves a binary conflict by picking a side", async () => {
    const bare = makeBare();
    const a = makeMachine(bare);
    const baseBytes = Buffer.from([0x89, 0x00, 0x01, 0x02, 0x03]);
    writeHomeBytes(a, ".claude/CLAUDE.md", baseBytes);
    await fullSync(a);

    const b = makeMachine(bare);
    const remoteBytes = Buffer.from([0x89, 0x00, 0xaa, 0xbb, 0xcc]);
    writeHomeBytes(a, ".claude/CLAUDE.md", remoteBytes);
    await fullSync(a);
    writeHomeBytes(b, ".claude/CLAUDE.md", Buffer.from([0x89, 0x00, 0xdd]));

    const begin = await runTransportBegin(b);
    expect(begin.state).toBe("conflicts");
    if (begin.state !== "conflicts") return;
    expect(begin.conflicts[0]!.binary).toBe(true);
    expect(begin.conflicts[0]!.local).toBeNull();

    const resolved = await runTransportResolve(b, {
      files: [{ path: ".claude/CLAUDE.md", side: "remote" }],
    });
    expect(resolved.remaining).toEqual([]);
    await runTransportCommit(b, undefined);

    const merged = readFileSync(join(b.homeDir, ".claude", "CLAUDE.md"));
    expect(Buffer.compare(merged, remoteBytes)).toBe(0);
  }, 60000);

  it("propagates deletions instead of resurrecting them", async () => {
    const bare = makeBare();
    const a = makeMachine(bare);
    writeHome(a, ".claude/CLAUDE.md", "shared line\ncommon\n");
    writeHome(a, ".gemini/GEMINI.md", "gemini rules\n");
    await fullSync(a);

    const b = makeMachine(bare);
    await fullSync(b);
    expect(existsSync(join(b.homeDir, ".gemini", "GEMINI.md"))).toBe(true);

    rmSync(join(a.homeDir, ".gemini", "GEMINI.md"));
    const begin = await runTransportBegin(a);
    expect(begin.state).toBe("clean");
    if (begin.state === "clean") {
      expect(begin.outgoing).toEqual([
        { path: ".gemini/GEMINI.md", status: "removed" },
      ]);
    }
    await runTransportCommit(a, undefined);
    expect(existsSync(join(a.homeDir, ".gemini", "GEMINI.md"))).toBe(false);

    await fullSync(b);
    expect(existsSync(join(b.homeDir, ".gemini", "GEMINI.md"))).toBe(false);
    expect(readHome(b, ".claude/CLAUDE.md")).toBe("shared line\ncommon\n");
  }, 60000);

  it("keeps bare sync canonical-free while still carrying regenerated copies", async () => {
    const bare = makeBare();
    const a = makeMachine(bare);
    writeHome(a, ".claude/CLAUDE.md", "old rules\n");

    const begin = await runTransportBegin(a);
    expect(begin.state).toBe("clean");
    await runTransportCommit(a, { deferPush: true });

    mkdirSync(join(a.configDir, "canonical"), { recursive: true });
    writeFileSync(
      join(a.configDir, "canonical", "core.md"),
      "# Unified rules\n",
      "utf8",
    );
    propagateCanonical(a.configDir, a.homeDir);

    const finalBegin = await runTransportBegin(a);
    expect(finalBegin.state).toBe("clean");
    const finalCommit = await runTransportCommit(a, undefined);
    expect(finalCommit.pushed).toBe(true);

    const b = makeMachine(bare);
    await fullSync(b);
    expect(readHome(b, ".claude/CLAUDE.md")).toContain("ga:begin core");
    expect(readHome(b, ".claude/CLAUDE.md")).toContain("# Unified rules");
    expect(
      readFileSync(join(b.configDir, "canonical", "core.md"), "utf8"),
    ).toBe("# Unified rules\n");
    expect(existsSync(join(b.homeDir, "canonical"))).toBe(false);
  }, 60000);

  it("excludes this machine's own outgoing files from the conflict incoming list", async () => {
    const bare = makeBare();
    const a = makeMachine(bare);
    writeHome(a, ".claude/CLAUDE.md", "shared line\ncommon\n");
    await fullSync(a);

    const b = makeMachine(bare);
    writeHome(a, ".claude/CLAUDE.md", "A line\ncommon\n");
    writeHome(a, ".codex/AGENTS.md", "codex rules\n");
    await fullSync(a);
    writeHome(b, ".claude/CLAUDE.md", "B line\ncommon\n");
    writeHome(b, ".gemini/GEMINI.md", "gemini rules\n");

    const begin = await runTransportBegin(b);
    expect(begin.state).toBe("conflicts");
    if (begin.state !== "conflicts") return;
    expect(begin.incoming).toContain(".claude/CLAUDE.md");
    expect(begin.incoming).toContain(".codex/AGENTS.md");
    expect(begin.incoming).not.toContain(".gemini/GEMINI.md");

    await runTransportAbort(b);
  }, 60000);

  it("keeps the original pre-sync point across a rejected-push retry", async () => {
    const bare = makeBare();
    const a = makeMachine(bare);
    writeHome(a, ".claude/CLAUDE.md", "shared line\ncommon\n");
    await fullSync(a);

    const b = makeMachine(bare);
    await fullSync(b);
    const originalHead = execFileSync(
      "git",
      ["-C", b.configDir, "rev-parse", "HEAD"],
      { encoding: "utf8" },
    ).trim();

    writeHome(b, ".gemini/GEMINI.md", "gemini rules\n");
    const begin = await runTransportBegin(b);
    expect(begin.state).toBe("clean");

    writeHome(a, ".codex/AGENTS.md", "codex rules\n");
    await fullSync(a);
    await expectCode(runTransportCommit(b, undefined), "push-rejected");

    const retry = await runTransportBegin(b);
    expect(retry.state).toBe("clean");
    const abort = await runTransportAbort(b);
    expect(abort.aborted).toBe(true);
    const restoredHead = execFileSync(
      "git",
      ["-C", b.configDir, "rev-parse", "HEAD"],
      { encoding: "utf8" },
    ).trim();
    expect(restoredHead).toBe(originalHead);
  }, 60000);

  it("reports push rejection when origin advanced mid-transport", async () => {
    const bare = makeBare();
    const a = makeMachine(bare);
    writeHome(a, ".claude/CLAUDE.md", "shared line\ncommon\n");
    await fullSync(a);

    const b = makeMachine(bare);
    writeHome(b, ".gemini/GEMINI.md", "gemini rules\n");
    const begin = await runTransportBegin(b);
    expect(begin.state).toBe("clean");

    writeHome(a, ".codex/AGENTS.md", "codex rules\n");
    await fullSync(a);

    await expectCode(runTransportCommit(b, undefined), "push-rejected");

    const retry = await runTransportBegin(b);
    expect(retry.state).toBe("clean");
    const commit = await runTransportCommit(b, undefined);
    expect(commit.pushed).toBe(true);
    expect(readHome(b, ".codex/AGENTS.md")).toBe("codex rules\n");
  }, 60000);
});

describe("transport with custom harnesses", () => {
  const DECLARATIONS_FILE = ".git-agents-harnesses.json";
  const DSH = {
    version: 1,
    harnesses: {
      dsh: {
        name: "DeepSeek Harness",
        instructionsFile: ".dsh/AGENTS.md",
        syncPaths: [".dsh/skills"],
      },
    },
  };

  function writeDeclarations(deps: InternalDeps, content: unknown): void {
    writeFileSync(
      join(deps.configDir, DECLARATIONS_FILE),
      typeof content === "string" ? content : JSON.stringify(content, null, 2),
      "utf8",
    );
  }

  it("carries a declared harness's paths and the declarations file to another machine", async () => {
    const bare = makeBare();
    const a = makeMachine(bare);
    writeDeclarations(a, DSH);
    writeHome(a, ".dsh/AGENTS.md", "dsh instructions\n");
    writeHome(a, ".dsh/skills/review/SKILL.md", "review skill\n");
    writeHome(a, ".dsh/cache/tmp.txt", "not declared\n");

    const begin = await runTransportBegin(a);
    expect(begin.state).toBe("clean");
    expect(begin.outgoing).toEqual([
      { path: ".dsh/AGENTS.md", status: "added" },
      { path: ".dsh/skills", status: "added" },
    ]);
    await runTransportCommit(a, undefined);

    const b = makeMachine(bare);
    const incoming = await runTransportBegin(b);
    expect(incoming.state).toBe("clean");
    expect(incoming.incoming).toEqual([
      { path: ".dsh/AGENTS.md", status: "added" },
      { path: ".dsh/skills", status: "added" },
    ]);
    const commit = await runTransportCommit(b, undefined);

    expect(commit.mirroredBack).toEqual(incoming.incoming);
    expect(readHome(b, ".dsh/AGENTS.md")).toBe("dsh instructions\n");
    expect(readHome(b, ".dsh/skills/review/SKILL.md")).toBe("review skill\n");
    expect(existsSync(join(b.homeDir, ".dsh", "cache"))).toBe(false);
    expect(
      JSON.parse(readFileSync(join(b.configDir, DECLARATIONS_FILE), "utf8")),
    ).toEqual(DSH);
  }, 30000);

  it("carries edits and deletions of custom paths in both directions", async () => {
    const bare = makeBare();
    const a = makeMachine(bare);
    writeDeclarations(a, DSH);
    writeHome(a, ".dsh/AGENTS.md", "dsh instructions\n");
    writeHome(a, ".dsh/skills/review/SKILL.md", "review skill\n");
    await fullSync(a);
    const b = makeMachine(bare);
    await fullSync(b);

    writeHome(b, ".dsh/AGENTS.md", "dsh instructions, edited on B\n");
    rmSync(join(b.homeDir, ".dsh", "skills"), { recursive: true });
    const begin = await runTransportBegin(b);
    expect(begin.outgoing).toEqual([
      { path: ".dsh/AGENTS.md", status: "modified" },
      { path: ".dsh/skills", status: "removed" },
    ]);
    await runTransportCommit(b, undefined);

    const back = await runTransportBegin(a);
    expect(back.state).toBe("clean");
    expect(back.incoming).toEqual([
      { path: ".dsh/AGENTS.md", status: "modified" },
      { path: ".dsh/skills", status: "removed" },
    ]);
    await runTransportCommit(a, undefined);
    expect(readHome(a, ".dsh/AGENTS.md")).toBe("dsh instructions, edited on B\n");
    expect(existsSync(join(a.homeDir, ".dsh", "skills"))).toBe(false);
  }, 60000);

  it("records the custom paths the home directory holds after a completed sync", async () => {
    const bare = makeBare();
    const a = makeMachine(bare);
    writeDeclarations(a, DSH);
    writeHome(a, ".claude/CLAUDE.md", "claude rules\n");
    writeHome(a, ".dsh/AGENTS.md", "dsh instructions\n");
    await fullSync(a);

    const record = JSON.parse(
      readFileSync(join(a.configDir, ".git-agents-last-sync.json"), "utf8"),
    );
    expect(record.paths).toEqual([".claude/CLAUDE.md", ".dsh/AGENTS.md"]);
  }, 30000);

  const INVALID = {
    version: 1,
    harnesses: {
      dsh: { syncPaths: [".dsh/skills"], color: "blue" },
      keys: { syncPaths: [".ssh/keys"] },
    },
  };

  function expectInvalidDeclarations(error: unknown): void {
    expect(error).toBeInstanceOf(InternalCommandError);
    const { code, message } = error as InternalCommandError;
    expect(code).toBe("invalid-harness-declarations");
    // Every problem, then the remedy.
    expect(message).toContain('harness "dsh": unknown field "color"');
    expect(message).toContain('".ssh/keys" is in the credential location ".ssh"');
    expect(message).toContain("/git-agents harness");
    expect(message).toContain(DECLARATIONS_FILE);
  }

  it("refuses transport-begin on an invalid declarations file, built-ins included", async () => {
    const bare = makeBare();
    const a = makeMachine(bare);
    writeDeclarations(a, INVALID);
    writeHome(a, ".claude/CLAUDE.md", "claude rules\n");
    writeHome(a, ".dsh/skills/review/SKILL.md", "review skill\n");

    const error = await runTransportBegin(a).catch((e: unknown) => e);

    expectInvalidDeclarations(error);
    // Nothing was mirrored, committed or recorded: no transport began.
    expect(existsSync(join(a.configDir, ".claude"))).toBe(false);
    expect(existsSync(join(a.configDir, ".dsh"))).toBe(false);
    expect(existsSync(join(a.configDir, ".git-agents-transport.json"))).toBe(false);
    await expectCode(runTransportCommit(a, undefined), "no-transport");
    expect(readHome(a, ".claude/CLAUDE.md")).toBe("claude rules\n");
  }, 30000);

  it("refuses transport-commit on an invalid declarations file, before pushing or touching home", async () => {
    const bare = makeBare();
    const a = makeMachine(bare);
    writeHome(a, ".claude/CLAUDE.md", "claude rules\n");
    await fullSync(a);

    const b = makeMachine(bare);
    writeHome(b, ".gemini/GEMINI.md", "gemini rules\n");
    const begin = await runTransportBegin(b);
    expect(begin.incoming).toEqual([
      { path: ".claude/CLAUDE.md", status: "added" },
    ]);
    writeDeclarations(b, INVALID);

    const error = await runTransportCommit(b, undefined).catch((e: unknown) => e);

    expectInvalidDeclarations(error);
    expect(existsSync(join(b.homeDir, ".claude"))).toBe(false);
    const remoteFiles = execFileSync(
      "git",
      ["--git-dir", bare, "ls-tree", "-r", "--name-only", "main"],
      { encoding: "utf8" },
    );
    expect(remoteFiles).not.toContain(".gemini/GEMINI.md");

    // Fixing the file unblocks the same transport.
    rmSync(join(b.configDir, DECLARATIONS_FILE));
    await runTransportCommit(b, undefined);
    expect(readHome(b, ".claude/CLAUDE.md")).toBe("claude rules\n");
  }, 60000);

  function gitOut(deps: InternalDeps, ...args: string[]): string {
    return execFileSync("git", ["-C", deps.configDir, ...args], {
      encoding: "utf8",
    }).trim();
  }

  function readDeclarations(deps: InternalDeps): unknown {
    return JSON.parse(
      readFileSync(join(deps.configDir, DECLARATIONS_FILE), "utf8"),
    );
  }

  it("keeps a declaration that was never committed when the sync is declined", async () => {
    const bare = makeBare();
    const a = makeMachine(bare);
    writeHome(a, ".claude/CLAUDE.md", "claude rules\n");
    await fullSync(a);
    writeDeclarations(a, DSH);
    writeHome(a, ".dsh/AGENTS.md", "dsh instructions\n");

    const begin = await runTransportBegin(a);
    expect(begin.outgoing).toEqual([
      { path: ".dsh/AGENTS.md", status: "added" },
    ]);
    const abort = await runTransportAbort(a);

    expect(abort.aborted).toBe(true);
    expect(readDeclarations(a)).toEqual(DSH);
    // The declaration is committed; the files mirrored for it are undone.
    expect(gitOut(a, "status", "--porcelain")).not.toContain(DECLARATIONS_FILE);
    expect(existsSync(join(a.configDir, ".dsh"))).toBe(false);
    expect(readHome(a, ".dsh/AGENTS.md")).toBe("dsh instructions\n");
  }, 30000);

  it("keeps a declaration made on a machine that never synced when the sync is declined", async () => {
    const bare = makeBare();
    const a = makeMachine(bare);
    writeDeclarations(a, DSH);
    writeHome(a, ".dsh/AGENTS.md", "dsh instructions\n");

    await runTransportBegin(a);
    await runTransportAbort(a);

    expect(readDeclarations(a)).toEqual(DSH);
    expect(gitOut(a, "ls-files")).toBe(DECLARATIONS_FILE);
  }, 30000);

  function remoteDeclarations(bare: string): string | null {
    try {
      return execFileSync(
        "git",
        ["--git-dir", bare, "show", `main:${DECLARATIONS_FILE}`],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
    } catch {
      return null;
    }
  }

  it("keeps a declaration made while an earlier sync was left unfinished", async () => {
    const { bare, a, b } = await twoMachines();
    const original = gitOut(b, "rev-parse", "HEAD");
    // A rejected push leaves B's transport open, with its pre-sync point.
    writeHome(b, ".gemini/GEMINI.md", "gemini rules\n");
    await runTransportBegin(b);
    writeHome(a, ".codex/AGENTS.md", "codex rules\n");
    await fullSync(a);
    await expectCode(runTransportCommit(b, undefined), "push-rejected");

    writeDeclarations(b, DSH);
    writeHome(b, ".dsh/AGENTS.md", "dsh instructions\n");
    await runTransportBegin(b);
    await runTransportAbort(b);

    // Back at the point the first run started from, plus the declaration.
    expect(readDeclarations(b)).toEqual(DSH);
    expect(gitOut(b, "rev-parse", "HEAD~1")).toBe(original);
    expect(gitOut(b, "diff", "--name-only", "HEAD~1", "HEAD")).toBe(
      DECLARATIONS_FILE,
    );
    expect(gitOut(b, "status", "--porcelain", "--untracked-files=no")).toBe("");
    expect(existsSync(join(b.configDir, ".gemini"))).toBe(false);

    await fullSync(b);
    expect(remoteDeclarations(bare)).toBe(JSON.stringify(DSH, null, 2));
  }, 60000);

  it("does not take a path this machine removed for one the remote newly declares", async () => {
    const { a, b } = await twoMachines();
    writeDeclarations(a, DSH);
    writeHome(a, ".dsh/AGENTS.md", "dsh instructions\n");
    await fullSync(a);
    await fullSync(b);
    // B removes the declaration by hand; the remote still carries it.
    rmSync(join(b.configDir, DECLARATIONS_FILE));
    writeHome(b, ".dsh/AGENTS.md", "dsh instructions, edited on B\n");
    writeHome(a, ".claude/CLAUDE.md", "claude rules, edited on A\n");
    await fullSync(a);

    const begin = await runTransportBegin(b);

    expect(begin).toEqual({
      state: "clean",
      outgoing: [],
      incoming: [{ path: ".claude/CLAUDE.md", status: "modified" }],
      firstSync: [],
    });
  }, 60000);

  const DSH_PATH = { harness: "dsh", name: "DeepSeek Harness" };

  // Two machines that already share the repo, before any declaration.
  async function twoMachines(): Promise<{
    bare: string;
    a: InternalDeps;
    b: InternalDeps;
  }> {
    const bare = makeBare();
    const a = makeMachine(bare);
    writeHome(a, ".claude/CLAUDE.md", "claude rules\n");
    await fullSync(a);
    const b = makeMachine(bare);
    await fullSync(b);
    return { bare, a, b };
  }

  it("reports a different file at a newly declared path as a both-added conflict", async () => {
    const { a, b } = await twoMachines();
    writeDeclarations(a, DSH);
    writeHome(a, ".dsh/AGENTS.md", "dsh instructions from A, longer\n");
    await fullSync(a);
    writeHome(b, ".dsh/AGENTS.md", "dsh instructions from B\n");

    const begin = await runTransportBegin(b);

    expect(begin.state).toBe("conflicts");
    if (begin.state !== "conflicts") return;
    expect(begin.conflicts).toEqual([
      {
        path: ".dsh/AGENTS.md",
        binary: false,
        base: null,
        local: "dsh instructions from B\n",
        remote: "dsh instructions from A, longer\n",
        localDeleted: false,
        remoteDeleted: false,
      },
    ]);
    expect(begin.outgoing).toEqual([
      { path: ".dsh/AGENTS.md", status: "added" },
    ]);
    expect(begin.incoming).toContain(".dsh/AGENTS.md");
    expect(begin.firstSync).toEqual([
      { ...DSH_PATH, path: ".dsh/AGENTS.md", direction: "outgoing", fileCount: 1, totalBytes: 24 },
      { ...DSH_PATH, path: ".dsh/AGENTS.md", direction: "incoming", fileCount: 1, totalBytes: 32 },
    ]);
    expect(readHome(b, ".dsh/AGENTS.md")).toBe("dsh instructions from B\n");

    await runTransportResolve(b, {
      files: [{ path: ".dsh/AGENTS.md", content: "dsh instructions from A and B\n" }],
    });
    await runTransportCommit(b, undefined);
    expect(readHome(b, ".dsh/AGENTS.md")).toBe("dsh instructions from A and B\n");
    await fullSync(a);
    expect(readHome(a, ".dsh/AGENTS.md")).toBe("dsh instructions from A and B\n");
  }, 60000);

  it("lists each path synced for the first time, on the declaring and the receiving machine", async () => {
    const { a, b } = await twoMachines();
    writeDeclarations(a, DSH);
    writeHome(a, ".claude/CLAUDE.md", "claude rules, edited\n");
    writeHome(a, ".dsh/AGENTS.md", "dsh instructions\n");
    writeHome(a, ".dsh/skills/review/SKILL.md", "review skill\n");
    writeHome(a, ".dsh/skills/plan/SKILL.md", "plan skill, longer\n");

    const declaring = await runTransportBegin(a);

    expect(declaring.state).toBe("clean");
    expect(declaring.outgoing).toEqual([
      { path: ".claude/CLAUDE.md", status: "modified" },
      { path: ".dsh/AGENTS.md", status: "added" },
      { path: ".dsh/skills", status: "added" },
    ]);
    expect(declaring.firstSync).toEqual([
      { ...DSH_PATH, path: ".dsh/AGENTS.md", direction: "outgoing", fileCount: 1, totalBytes: 17 },
      { ...DSH_PATH, path: ".dsh/skills", direction: "outgoing", fileCount: 2, totalBytes: 32 },
    ]);
    await runTransportCommit(a, undefined);

    const receiving = await runTransportBegin(b);

    expect(receiving.state).toBe("clean");
    expect(receiving.outgoing).toEqual([]);
    expect(receiving.incoming).toEqual([
      { path: ".claude/CLAUDE.md", status: "modified" },
      { path: ".dsh/AGENTS.md", status: "added" },
      { path: ".dsh/skills", status: "added" },
    ]);
    expect(receiving.firstSync).toEqual([
      { ...DSH_PATH, path: ".dsh/AGENTS.md", direction: "incoming", fileCount: 1, totalBytes: 17 },
      { ...DSH_PATH, path: ".dsh/skills", direction: "incoming", fileCount: 2, totalBytes: 32 },
    ]);
    // Nothing reaches the home directory before the gate is accepted.
    expect(existsSync(join(b.homeDir, ".dsh"))).toBe(false);
    await runTransportCommit(b, undefined);
    expect(readHome(b, ".dsh/AGENTS.md")).toBe("dsh instructions\n");
    expect(readHome(b, ".dsh/skills/plan/SKILL.md")).toBe("plan skill, longer\n");

    // Once synced, the paths are no longer first-time, edited or not.
    writeHome(b, ".dsh/AGENTS.md", "dsh instructions, edited on B\n");
    const later = await runTransportBegin(b);
    expect(later.outgoing).toEqual([
      { path: ".dsh/AGENTS.md", status: "modified" },
    ]);
    expect(later.firstSync).toEqual([]);
  }, 60000);

  it("sizes an incoming first-time path the remote declares in another case, in the conflicts state", async () => {
    const { a, b } = await twoMachines();
    writeDeclarations(a, { version: 1, harnesses: { zed: { syncPaths: [".zed/prompts"] } } });
    writeHome(a, ".zed/prompts/a.md", "zed prompt\n");
    await fullSync(a);
    // B declares the same path in another case, so the two files conflict.
    writeDeclarations(b, {
      version: 1,
      harnesses: { zed: { name: "Zed", syncPaths: [".Zed/prompts"] } },
    });

    const begin = await runTransportBegin(b);

    expect(begin.state).toBe("conflicts");
    if (begin.state !== "conflicts") return;
    expect(begin.conflicts.map((conflict) => conflict.path)).toEqual([
      DECLARATIONS_FILE,
    ]);
    expect(begin.firstSync).toEqual([
      {
        harness: "zed",
        name: "Zed",
        path: ".Zed/prompts",
        direction: "incoming",
        fileCount: 1,
        totalBytes: 11,
      },
    ]);
  }, 60000);

  it("lists declared paths as first-time on a machine that joins the repo", async () => {
    const bare = makeBare();
    const a = makeMachine(bare);
    writeDeclarations(a, DSH);
    writeHome(a, ".dsh/AGENTS.md", "dsh instructions\n");
    await fullSync(a);
    const b = makeMachine(bare);
    writeHome(b, ".dsh/skills/review/SKILL.md", "review skill\n");

    const begin = await runTransportBegin(b);

    expect(begin.firstSync).toEqual([
      { ...DSH_PATH, path: ".dsh/AGENTS.md", direction: "incoming", fileCount: 1, totalBytes: 17 },
      { ...DSH_PATH, path: ".dsh/skills", direction: "outgoing", fileCount: 1, totalBytes: 13 },
    ]);
  }, 30000);

  it("lists nothing as first-time without a declarations file", async () => {
    const bare = makeBare();
    const a = makeMachine(bare);
    writeHome(a, ".claude/CLAUDE.md", "claude rules\n");

    const begin = await runTransportBegin(a);

    expect(begin).toEqual({
      state: "clean",
      outgoing: [{ path: ".claude/CLAUDE.md", status: "added" }],
      incoming: [],
      firstSync: [],
    });
  }, 30000);

  // An invalid file can only reach the remote from outside these commands.
  function pushInvalidDeclarations(deps: InternalDeps): string {
    writeDeclarations(deps, INVALID);
    for (const args of [
      ["add", DECLARATIONS_FILE],
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "invalid"],
      ["push", "origin", "HEAD"],
    ]) {
      execFileSync("git", ["-C", deps.configDir, ...args], { stdio: "ignore" });
    }
    return JSON.stringify(INVALID, null, 2);
  }

  it("carries an invalid merged declarations file in the conflicts list until it is fixed", async () => {
    const { bare, a, b } = await twoMachines();
    const invalidText = pushInvalidDeclarations(a);

    const begin = await runTransportBegin(b);

    expect(begin.state).toBe("conflicts");
    if (begin.state !== "conflicts") return;
    expect(begin.conflicts).toHaveLength(1);
    const conflict = begin.conflicts[0]!;
    expect(conflict).toMatchObject({
      path: DECLARATIONS_FILE,
      binary: false,
      base: null,
      local: null,
      remote: invalidText,
      merged: invalidText,
    });
    expect(conflict.problems?.map(({ code, harness }) => [code, harness])).toEqual([
      ["unknown-field", "dsh"],
      ["path-denylisted", "keys"],
    ]);
    expect(begin.incoming).toEqual([DECLARATIONS_FILE]);
    expect(begin.firstSync).toEqual([]);

    // Every problem, then the way out of the merge.
    const expectInvalidMerge = (error: unknown): void => {
      expect(error).toBeInstanceOf(InternalCommandError);
      const { code, message } = error as InternalCommandError;
      expect(code).toBe("invalid-harness-declarations");
      expect(message).toContain('harness "dsh": unknown field "color"');
      expect(message).toContain('".ssh/keys" is in the credential location ".ssh"');
      expect(message).toContain("transport-resolve");
      expect(message).toContain("transport-abort");
    };

    // Blocked until the file is fixed.
    expectInvalidMerge(
      await runTransportCommit(b, undefined).catch((e: unknown) => e),
    );
    await expectCode(runTransportBegin(b), "transport-in-progress");
    expect(remoteDeclarations(bare)).toBe(invalidText);

    // Invalid contents are rejected on the way in and nothing is written.
    expectInvalidMerge(
      await runTransportResolve(b, {
        files: [{ path: DECLARATIONS_FILE, content: invalidText }],
      }).catch((e: unknown) => e),
    );
    await expectCode(
      runTransportResolve(b, {
        files: [{ path: DECLARATIONS_FILE, content: "{ not json" }],
      }),
      "invalid-harness-declarations",
    );
    await expectCode(
      runTransportResolve(b, {
        files: [{ path: DECLARATIONS_FILE, side: "remote" }],
      }),
      "invalid-harness-declarations",
    );
    await expectCode(runTransportCommit(b, undefined), "invalid-harness-declarations");

    const fixed = JSON.stringify(DSH, null, 2);
    const resolved = await runTransportResolve(b, {
      files: [{ path: DECLARATIONS_FILE, content: fixed }],
    });
    expect(resolved).toEqual({ resolved: [DECLARATIONS_FILE], remaining: [] });
    // Once valid, the file is no longer open for resolution.
    await expectCode(
      runTransportResolve(b, {
        files: [{ path: DECLARATIONS_FILE, content: fixed }],
      }),
      "not-conflicted",
    );

    const commit = await runTransportCommit(b, undefined);
    expect(commit).toMatchObject({ mergeCompleted: true, pushed: true });
    expect(readDeclarations(b)).toEqual(DSH);
    expect(remoteDeclarations(bare)).toBe(fixed);
    expect(readHome(b, ".claude/CLAUDE.md")).toBe("claude rules\n");
  }, 60000);

  it("reports an invalid merged declarations file beside ordinary conflicts, and takes a side for it", async () => {
    const { bare, a, b } = await twoMachines();
    writeHome(a, ".claude/CLAUDE.md", "claude rules, edited on A\n");
    await fullSync(a);
    const invalidText = pushInvalidDeclarations(a);
    writeHome(b, ".claude/CLAUDE.md", "claude rules, edited on B\n");

    const begin = await runTransportBegin(b);

    expect(begin.state).toBe("conflicts");
    if (begin.state !== "conflicts") return;
    expect(begin.conflicts.map(({ path }) => path)).toEqual([
      ".claude/CLAUDE.md",
      DECLARATIONS_FILE,
    ]);
    expect(begin.conflicts[0]!.problems).toBeUndefined();
    expect(begin.conflicts[1]).toMatchObject({
      local: null,
      remote: invalidText,
      merged: invalidText,
    });
    expect(begin.conflicts[1]!.problems).toHaveLength(2);

    const first = await runTransportResolve(b, {
      files: [{ path: ".claude/CLAUDE.md", content: "claude rules, edited on A and B\n" }],
    });
    expect(first.remaining).toEqual([]);
    await expectCode(runTransportCommit(b, undefined), "invalid-harness-declarations");

    // This machine declared nothing, so its side is no declarations file.
    await runTransportResolve(b, {
      files: [{ path: DECLARATIONS_FILE, side: "local" }],
    });
    await runTransportCommit(b, undefined);

    expect(existsSync(join(b.configDir, DECLARATIONS_FILE))).toBe(false);
    expect(remoteDeclarations(bare)).toBeNull();
    expect(readHome(b, ".claude/CLAUDE.md")).toBe("claude rules, edited on A and B\n");
  }, 60000);

  it("reports an invalid merged declarations file when this machine has changes of its own", async () => {
    const { a, b } = await twoMachines();
    pushInvalidDeclarations(a);
    writeHome(b, ".gemini/GEMINI.md", "gemini rules\n");
    const before = gitOut(b, "rev-parse", "HEAD");

    const begin = await runTransportBegin(b);

    expect(begin.state).toBe("conflicts");
    if (begin.state !== "conflicts") return;
    expect(begin.conflicts.map(({ path }) => path)).toEqual([DECLARATIONS_FILE]);
    expect(begin.outgoing).toEqual([
      { path: ".gemini/GEMINI.md", status: "added" },
    ]);

    // Declining restores the clone; the home directory was never touched.
    const aborted = await runTransportAbort(b);
    expect(aborted.aborted).toBe(true);
    expect(gitOut(b, "rev-parse", "HEAD")).toBe(before);
    expect(existsSync(join(b.configDir, DECLARATIONS_FILE))).toBe(false);
    expect(readHome(b, ".gemini/GEMINI.md")).toBe("gemini rules\n");
  }, 60000);

  it("leaves a receiving machine's clone and home directory as they were when the sync is declined", async () => {
    const { a, b } = await twoMachines();
    writeDeclarations(a, DSH);
    writeHome(a, ".dsh/AGENTS.md", "dsh instructions\n");
    await fullSync(a);
    const before = gitOut(b, "rev-parse", "HEAD");

    const begin = await runTransportBegin(b);
    expect(begin.incoming).toEqual([
      { path: ".dsh/AGENTS.md", status: "added" },
    ]);
    const aborted = await runTransportAbort(b);

    expect(aborted.aborted).toBe(true);
    expect(gitOut(b, "rev-parse", "HEAD")).toBe(before);
    expect(gitOut(b, "status", "--porcelain", "--untracked-files=no")).toBe("");
    expect(existsSync(join(b.configDir, DECLARATIONS_FILE))).toBe(false);
    expect(existsSync(join(b.configDir, ".dsh"))).toBe(false);
    expect(existsSync(join(b.homeDir, ".dsh"))).toBe(false);

    // The declaration arrives again on the next sync, listed again.
    const again = await runTransportBegin(b);
    expect(again.firstSync).toEqual([
      { ...DSH_PATH, path: ".dsh/AGENTS.md", direction: "incoming", fileCount: 1, totalBytes: 17 },
    ]);
    await runTransportCommit(b, undefined);
    expect(readHome(b, ".dsh/AGENTS.md")).toBe("dsh instructions\n");
  }, 60000);

  describe("removing and changing a declaration", () => {
    const OVERLAY_FILE = "canonical/overlays/dsh.md";
    const MANIFEST_FILE = ".git-agents-sync.json";

    function writeClone(deps: InternalDeps, relPath: string, content: string): void {
      const target = join(deps.configDir, ...relPath.split("/"));
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, content, "utf8");
    }

    // Every file of a home directory, by its path from there, with its content.
    function readTree(root: string, prefix = ""): Record<string, string> {
      const tree: Record<string, string> = {};
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        const relPath = `${prefix}${entry.name}`;
        if (entry.isDirectory()) {
          Object.assign(tree, readTree(join(root, entry.name), `${relPath}/`));
        } else {
          tree[relPath] = readFileSync(join(root, entry.name), "utf8");
        }
      }
      return tree;
    }

    async function command<T>(
      deps: InternalDeps,
      name: string,
      input?: unknown,
    ): Promise<T> {
      const outcome = await runInternalCommand(name, input, deps);
      if (!outcome.ok) throw new Error(`${name} failed: ${outcome.error.message}`);
      return outcome.result as T;
    }

    // What `/git-agents harness` runs once the user confirms the gate.
    async function declare(
      deps: InternalDeps,
      harnesses: Record<string, unknown>,
    ): Promise<HarnessStageResult> {
      const staged = await command<HarnessStageResult>(deps, "harness-stage", {
        harnesses,
      });
      await command(deps, "harness-apply");
      return staged;
    }

    // The files a commit changed, as `<status>\t<path>` lines.
    function changedBy(deps: InternalDeps, commit: string): string[] {
      return gitOut(deps, "show", "--name-status", "--format=", commit)
        .split("\n")
        .sort();
    }

    function committedManifest(deps: InternalDeps): {
      canonical: { version: string; overlays: Record<string, string> };
      generated: Record<string, { path: string; canonicalVersion: string }>;
    } {
      return JSON.parse(gitOut(deps, "show", `HEAD:${MANIFEST_FILE}`));
    }

    // Two machines that share a declared harness with an instructions file, a
    // sync path and an overlay, converged and synced.
    async function sharedDsh(): Promise<{
      bare: string;
      a: InternalDeps;
      b: InternalDeps;
    }> {
      const { bare, a, b } = await twoMachines();
      writeDeclarations(a, DSH);
      writeHome(a, ".dsh/skills/review/SKILL.md", "review skill\n");
      writeClone(a, "canonical/core.md", "# Shared\n");
      writeClone(a, OVERLAY_FILE, "# DSH only\n");
      propagateCanonical(a.configDir, a.homeDir);
      await fullSync(a);
      await fullSync(b);
      expect(readHome(b, ".dsh/AGENTS.md")).toContain("# DSH only");
      return { bare, a, b };
    }

    it("commits a removal made with harness-stage and harness-apply as one commit, and leaves the home directory alone", async () => {
      const { a } = await sharedDsh();
      const homeBefore = readTree(a.homeDir);
      const headBefore = gitOut(a, "rev-parse", "HEAD");

      await declare(a, {});
      const begin = await runTransportBegin(a);
      expect(begin).toMatchObject({ state: "clean", outgoing: [], incoming: [] });
      await runTransportCommit(a, undefined);

      expect(gitOut(a, "rev-list", "--count", `${headBefore}..HEAD`)).toBe("1");
      expect(changedBy(a, "HEAD")).toEqual([
        "D\t.dsh/AGENTS.md",
        "D\t.dsh/skills/review/SKILL.md",
        `D\t${OVERLAY_FILE}`,
        `M\t${DECLARATIONS_FILE}`,
        `M\t${MANIFEST_FILE}`,
      ]);
      expect(gitOut(a, "rev-parse", "origin/main")).toBe(
        gitOut(a, "rev-parse", "HEAD"),
      );
      expect(gitOut(a, "status", "--porcelain", "--untracked-files=no")).toBe("");
      const manifest = committedManifest(a);
      expect(Object.keys(manifest.generated)).not.toContain("dsh");
      expect(Object.keys(manifest.canonical.overlays)).not.toContain("dsh");
      expect(readTree(a.homeDir)).toEqual(homeBefore);
      expect(homeBefore[".dsh/AGENTS.md"]).toContain("ga:begin overlay harness=dsh");
    }, 60000);

    it("lets a machine that pulls the removal keep its home files, with no conflict for its local edits", async () => {
      const { a, b } = await sharedDsh();
      await declare(a, {});
      await fullSync(a);
      // B edited the harness's files since its last sync.
      writeHome(b, ".dsh/AGENTS.md", "dsh instructions, edited on B\n");
      writeHome(b, ".dsh/skills/review/SKILL.md", "review skill, edited on B\n");
      const homeBefore = readTree(b.homeDir);

      const begin = await runTransportBegin(b);

      expect(begin).toEqual({
        state: "clean",
        outgoing: [],
        incoming: [],
        firstSync: [],
        removed: {
          harnesses: [{ harness: "dsh", name: "DeepSeek Harness" }],
          paths: [
            { ...DSH_PATH, path: ".dsh/AGENTS.md", present: true },
            { ...DSH_PATH, path: ".dsh/skills", present: true },
          ],
        },
      });
      const commit = await runTransportCommit(b, undefined);
      expect(commit.mirroredBack).toEqual([]);
      expect(readTree(b.homeDir)).toEqual(homeBefore);
      expect(existsSync(join(b.configDir, ".dsh"))).toBe(false);
      expect(existsSync(join(b.configDir, ...OVERLAY_FILE.split("/")))).toBe(false);
      expect(readDeclarations(b)).toEqual({ version: 1, harnesses: {} });
      // The record is written from the merged set: the removed paths drop out.
      const record = JSON.parse(
        readFileSync(join(b.configDir, ".git-agents-last-sync.json"), "utf8"),
      );
      expect(record.paths).toEqual([
        ".claude/CLAUDE.md",
        ".codex/AGENTS.md",
        ".gemini/GEMINI.md",
        ".config/opencode/AGENTS.md",
      ]);

      // Later syncs name nothing, and the files stay where they are, unsynced.
      rmSync(join(b.homeDir, ".dsh", "skills"), { recursive: true });
      const later = await runTransportBegin(b);
      expect(later).toEqual({
        state: "clean",
        outgoing: [],
        incoming: [],
        firstSync: [],
      });
      await runTransportCommit(b, undefined);
      expect(readHome(b, ".dsh/AGENTS.md")).toBe("dsh instructions, edited on B\n");
      await fullSync(a);
      expect(readHome(a, ".dsh/skills/review/SKILL.md")).toBe("review skill\n");
    }, 90000);

    it("makes the same cleanup, in the same commit, for a removal made by editing the file by hand", async () => {
      const { a } = await sharedDsh();
      const homeBefore = readTree(a.homeDir);
      const headBefore = gitOut(a, "rev-parse", "HEAD");

      // Removed by hand: nothing but the declarations file is edited.
      writeDeclarations(a, { version: 1, harnesses: {} });
      const begin = await runTransportBegin(a);
      expect(begin).toMatchObject({ state: "clean", outgoing: [], incoming: [] });
      await runTransportCommit(a, undefined);

      expect(gitOut(a, "rev-list", "--count", `${headBefore}..HEAD`)).toBe("1");
      expect(changedBy(a, "HEAD")).toEqual([
        "D\t.dsh/AGENTS.md",
        "D\t.dsh/skills/review/SKILL.md",
        `D\t${OVERLAY_FILE}`,
        `M\t${DECLARATIONS_FILE}`,
        `M\t${MANIFEST_FILE}`,
      ]);
      expect(existsSync(join(a.configDir, ".dsh"))).toBe(false);
      const manifest = committedManifest(a);
      expect(Object.keys(manifest.generated)).not.toContain("dsh");
      expect(Object.keys(manifest.canonical.overlays)).not.toContain("dsh");
      expect(readTree(a.homeDir)).toEqual(homeBefore);
    }, 60000);

    it("keeps the removal and its cleanup when the sync is declined", async () => {
      const { a } = await sharedDsh();
      const homeBefore = readTree(a.homeDir);

      await declare(a, {});
      await runTransportBegin(a);
      await runTransportAbort(a);

      expect(readDeclarations(a)).toEqual({ version: 1, harnesses: {} });
      expect(existsSync(join(a.configDir, ".dsh"))).toBe(false);
      expect(existsSync(join(a.configDir, ...OVERLAY_FILE.split("/")))).toBe(false);
      expect(gitOut(a, "status", "--porcelain", "--untracked-files=no")).toBe("");
      expect(readTree(a.homeDir)).toEqual(homeBefore);
    }, 60000);

    // The state of each generated file, as `status` reports it.
    async function generatedStates(
      deps: InternalDeps,
    ): Promise<Record<string, string>> {
      const report = await command<StatusReport>(deps, "status");
      return Object.fromEntries(
        report.generated.map((file) => [file.harness, file.state]),
      );
    }

    // The script side of one `sync unify`: transport with the push deferred,
    // gather, stage, apply, then the push. `overlays` is what the agent's
    // merge adds to the canonical overlays.
    async function unify(
      deps: InternalDeps,
      overlays: Record<string, string> = {},
    ): Promise<GatherResult> {
      expect((await runTransportBegin(deps)).state).toBe("clean");
      await runTransportCommit(deps, { deferPush: true });
      const gathered = await command<GatherResult>(deps, "gather");
      await command(deps, "stage", {
        core: gathered.core,
        overlays: { ...gathered.overlays, ...overlays },
        inputs: gathered.inputs,
      });
      await command(deps, "apply");
      await fullSync(deps);
      return gathered;
    }

    const BUILT_INS_STALE = {
      claude: "stale",
      codex: "stale",
      gemini: "stale",
      opencode: "stale",
    };
    const BUILT_INS_CURRENT = {
      claude: "current",
      codex: "current",
      gemini: "current",
      opencode: "current",
    };

    it("reads the remaining generated files as stale after removing a harness that had an overlay, until one sync unify", async () => {
      const { a, b } = await sharedDsh();
      expect(await generatedStates(a)).toEqual({
        ...BUILT_INS_CURRENT,
        dsh: "current",
      });

      const staged = await declare(a, {});
      expect(staged.removal?.canonicalVersionChanges).toBe(true);
      expect(await generatedStates(a)).toEqual(BUILT_INS_STALE);
      await fullSync(a);
      expect(await generatedStates(a)).toEqual(BUILT_INS_STALE);
      await fullSync(b);
      expect(await generatedStates(b)).toEqual(BUILT_INS_STALE);

      await unify(a);

      expect(await generatedStates(a)).toEqual(BUILT_INS_CURRENT);
      await fullSync(b);
      expect(await generatedStates(b)).toEqual(BUILT_INS_CURRENT);
    }, 120000);

    it("keeps the overlay when the instructions file moves, and leaves the old file in the home directory", async () => {
      const { a, b } = await sharedDsh();
      const oldFile = readHome(a, ".dsh/AGENTS.md");

      const staged = await declare(a, {
        dsh: { ...DSH.harnesses.dsh, instructionsFile: ".dsh/RULES.md" },
      });

      // The old path gets the removal treatment, the new one is newly declared.
      expect(staged.stopSyncing).toEqual([
        { harness: "dsh", field: "instructionsFile", path: ".dsh/AGENTS.md" },
      ]);
      expect(staged.startSyncing).toEqual([
        {
          harness: "dsh",
          field: "instructionsFile",
          path: ".dsh/RULES.md",
          present: false,
          fileCount: 0,
          totalBytes: 0,
        },
      ]);
      expect(staged.removal).toMatchObject({
        harnesses: [],
        repoFiles: [".dsh/AGENTS.md"],
        overlays: [],
        manifest: { generated: ["dsh"], overlays: [] },
        canonicalVersionChanges: false,
      });
      expect(await generatedStates(a)).toEqual({
        ...BUILT_INS_CURRENT,
        dsh: "missing",
      });

      await unify(a);

      expect(existsSync(join(a.configDir, ".dsh", "AGENTS.md"))).toBe(false);
      expect(
        readFileSync(join(a.configDir, ...OVERLAY_FILE.split("/")), "utf8"),
      ).toBe("# DSH only\n");
      expect(readHome(a, ".dsh/RULES.md")).toBe(oldFile);
      expect(readHome(a, ".dsh/AGENTS.md")).toBe(oldFile);
      expect(await generatedStates(a)).toEqual({
        ...BUILT_INS_CURRENT,
        dsh: "current",
      });

      const begin = await runTransportBegin(b);
      expect(begin.removed).toEqual({
        harnesses: [],
        paths: [{ ...DSH_PATH, path: ".dsh/AGENTS.md", present: true }],
      });
      expect(begin.firstSync).toEqual([
        {
          ...DSH_PATH,
          path: ".dsh/RULES.md",
          direction: "incoming",
          fileCount: 1,
          totalBytes: Buffer.byteLength(oldFile),
        },
      ]);
      await runTransportCommit(b, undefined);
      expect(readHome(b, ".dsh/RULES.md")).toBe(oldFile);
      expect(readHome(b, ".dsh/AGENTS.md")).toBe(oldFile);
    }, 120000);

    it("takes an id change for a removal plus a fresh declaration, and keeps syncing the paths the new id declares", async () => {
      const { a, b } = await sharedDsh();
      const homeBefore = readTree(a.homeDir);

      const staged = await declare(a, { deepseek: DSH.harnesses.dsh });

      // The paths only change owner: they never stop being synced.
      expect(staged.stopSyncing).toEqual([]);
      expect(staged.startSyncing).toEqual([]);
      expect(staged.removal).toMatchObject({
        harnesses: [{ harness: "dsh", name: "DeepSeek Harness" }],
        repoFiles: [],
        overlays: [
          { harness: "dsh", path: OVERLAY_FILE, content: "# DSH only\n" },
        ],
        manifest: { generated: ["dsh"], overlays: ["dsh"] },
        canonicalVersionChanges: true,
      });
      await fullSync(a);

      expect(changedBy(a, "HEAD")).toEqual([
        `D\t${OVERLAY_FILE}`,
        `M\t${DECLARATIONS_FILE}`,
        `M\t${MANIFEST_FILE}`,
      ]);
      expect(readTree(a.homeDir)).toEqual(homeBefore);

      writeHome(b, ".dsh/skills/review/SKILL.md", "review skill, edited on B\n");
      const begin = await runTransportBegin(b);
      expect(begin).toEqual({
        state: "clean",
        outgoing: [{ path: ".dsh/skills", status: "modified" }],
        incoming: [],
        firstSync: [],
        removed: {
          harnesses: [{ harness: "dsh", name: "DeepSeek Harness" }],
          paths: [],
        },
      });
      await runTransportCommit(b, undefined);
      await fullSync(a);
      expect(readHome(a, ".dsh/skills/review/SKILL.md")).toBe(
        "review skill, edited on B\n",
      );
    }, 120000);

    it("converges a file left behind with its markers when the harness is declared again", async () => {
      const { a } = await sharedDsh();
      await declare(a, {});
      await fullSync(a);
      const leftBehind = readHome(a, ".dsh/AGENTS.md");
      expect(leftBehind).toContain("ga:begin overlay harness=dsh");

      const staged = await declare(a, DSH.harnesses);
      expect(
        staged.startSyncing.map((entry) => [entry.path, entry.present]),
      ).toEqual([
        [".dsh/AGENTS.md", true],
        [".dsh/skills", true],
      ]);
      expect(await generatedStates(a)).toMatchObject({ dsh: "untracked" });

      // An ordinary first convergence: the markers attribute the file, and the
      // merge carries its overlay block back into the canonical.
      const gathered = await unify(a, { dsh: "# DSH only\n" });

      expect(gathered.files.find((file) => file.harness === "dsh")).toMatchObject({
        markers: "parsed",
        regions: [
          { attribution: "core", changed: false },
          {
            attribution: "overlay",
            changed: true,
            content: "# DSH only\n",
            canonical: null,
          },
        ],
      });
      expect(
        readFileSync(join(a.configDir, ...OVERLAY_FILE.split("/")), "utf8"),
      ).toBe("# DSH only\n");
      expect(readHome(a, ".dsh/AGENTS.md")).toBe(leftBehind);
      expect(await generatedStates(a)).toEqual({
        ...BUILT_INS_CURRENT,
        dsh: "current",
      });
    }, 120000);

    it("keeps a removal made while an earlier sync was left unfinished, cleanup included", async () => {
      const { a, b } = await sharedDsh();
      const original = gitOut(b, "rev-parse", "HEAD");
      // A rejected push leaves B's transport open, with its pre-sync point.
      writeHome(b, ".gemini/GEMINI.md", "gemini rules, edited on B\n");
      await runTransportBegin(b);
      writeHome(a, ".codex/AGENTS.md", "codex rules, edited on A\n");
      await fullSync(a);
      await expectCode(runTransportCommit(b, undefined), "push-rejected");
      const homeBefore = readTree(b.homeDir);

      await declare(b, {});
      await runTransportBegin(b);
      await runTransportAbort(b);

      // Back at the point the first run started from, plus the removal.
      expect(gitOut(b, "rev-parse", "HEAD~1")).toBe(original);
      expect(changedBy(b, "HEAD")).toEqual([
        "D\t.dsh/AGENTS.md",
        "D\t.dsh/skills/review/SKILL.md",
        `D\t${OVERLAY_FILE}`,
        `M\t${DECLARATIONS_FILE}`,
        `M\t${MANIFEST_FILE}`,
      ]);
      expect(gitOut(b, "status", "--porcelain", "--untracked-files=no")).toBe("");
      expect(readTree(b.homeDir)).toEqual(homeBefore);
    }, 90000);

    const RENAMED = {
      version: 1,
      harnesses: { dsh: { ...DSH.harnesses.dsh, name: "DSH" } },
    };

    it("deletes no home file on a machine that pulls a removal and keeps the harness when resolving the conflict", async () => {
      const { a, b } = await sharedDsh();
      await declare(a, {});
      await fullSync(a);
      // Meanwhile B changed the same declaration.
      writeDeclarations(b, RENAMED);
      const homeBefore = readTree(b.homeDir);

      const begin = await runTransportBegin(b);
      expect(begin.state).toBe("conflicts");
      if (begin.state !== "conflicts") return;
      expect(begin.conflicts.map((file) => file.path)).toEqual([DECLARATIONS_FILE]);
      expect(begin.removed).toEqual({
        harnesses: [{ harness: "dsh", name: "DeepSeek Harness" }],
        paths: [
          { ...DSH_PATH, path: ".dsh/AGENTS.md", present: true },
          { ...DSH_PATH, path: ".dsh/skills", present: true },
        ],
      });
      await runTransportResolve(b, {
        files: [{ path: DECLARATIONS_FILE, side: "local" }],
      });
      await runTransportCommit(b, undefined);

      expect(readDeclarations(b)).toEqual(RENAMED);
      expect(readTree(b.homeDir)).toEqual(homeBefore);
    }, 90000);

    it("deletes no home file on the removing machine when a conflict is resolved by keeping the harness", async () => {
      const { a, b } = await sharedDsh();
      writeDeclarations(b, RENAMED);
      await fullSync(b);
      const homeBefore = readTree(a.homeDir);

      await declare(a, {});
      const begin = await runTransportBegin(a);
      expect(begin.state).toBe("conflicts");
      await runTransportResolve(a, {
        files: [{ path: DECLARATIONS_FILE, side: "remote" }],
      });
      await runTransportCommit(a, undefined);

      expect(readDeclarations(a)).toEqual(RENAMED);
      expect(readTree(a.homeDir)).toEqual(homeBefore);
    }, 90000);
  });
});

describe("transport conflicts on deleted paths", () => {
  const SKILL = ".claude/skills/review/SKILL.md";

  // A synced skill both machines have, then a change of A's that B has not
  // pulled yet.
  async function divergeOn(
    changeOnA: (a: InternalDeps) => void,
    changeOnB: (b: InternalDeps) => void,
  ): Promise<{ a: InternalDeps; b: InternalDeps }> {
    const bare = makeBare();
    const a = makeMachine(bare);
    writeHome(a, SKILL, "base\n");
    writeHome(a, ".claude/skills/other/SKILL.md", "other\n");
    await fullSync(a);
    const b = makeMachine(bare);
    await fullSync(b);
    changeOnA(a);
    await fullSync(a);
    changeOnB(b);
    return { a, b };
  }

  const homePath = (deps: InternalDeps, path: string) =>
    join(deps.homeDir, ...path.split("/"));

  it("says which side deleted the path, and deletes it when that side is picked", async () => {
    const { a, b } = await divergeOn(
      (a) => rmSync(homePath(a, ".claude/skills/review"), { recursive: true }),
      (b) => writeHome(b, SKILL, "edited on B\n"),
    );

    const begin = await runTransportBegin(b);
    expect(begin.state).toBe("conflicts");
    if (begin.state !== "conflicts") return;
    expect(begin.conflicts).toEqual([
      {
        path: SKILL,
        binary: false,
        base: "base\n",
        local: "edited on B\n",
        remote: null,
        localDeleted: false,
        remoteDeleted: true,
      },
    ]);

    const resolved = await runTransportResolve(b, {
      files: [{ path: SKILL, side: "remote" }],
    });
    expect(resolved).toEqual({ resolved: [SKILL], remaining: [] });
    await runTransportCommit(b, undefined);
    expect(existsSync(homePath(b, SKILL))).toBe(false);
    expect(readHome(b, ".claude/skills/other/SKILL.md")).toBe("other\n");

    await fullSync(a);
    expect(existsSync(homePath(a, SKILL))).toBe(false);
  }, 60000);

  it("deletes a path on an explicit delete, whichever side kept it", async () => {
    const { b } = await divergeOn(
      (a) => writeHome(a, SKILL, "edited on A\n"),
      (b) => rmSync(homePath(b, ".claude/skills/review"), { recursive: true }),
    );

    const begin = await runTransportBegin(b);
    expect(begin.state).toBe("conflicts");
    if (begin.state !== "conflicts") return;
    expect(begin.conflicts[0]).toMatchObject({
      path: SKILL,
      local: null,
      remote: "edited on A\n",
      localDeleted: true,
      remoteDeleted: false,
    });

    await expectCode(
      runTransportResolve(b, { files: [{ path: SKILL, delete: false }] }),
      "invalid-input",
    );
    await expectCode(
      runTransportResolve(b, { files: [{ path: SKILL, side: "local", delete: true }] }),
      "invalid-input",
    );
    const resolved = await runTransportResolve(b, {
      files: [{ path: SKILL, delete: true }],
    });
    expect(resolved.remaining).toEqual([]);
    await runTransportCommit(b, undefined);
    expect(existsSync(homePath(b, SKILL))).toBe(false);
  }, 60000);

  it("keeps the side that has a file when a pick takes it", async () => {
    const { a, b } = await divergeOn(
      (a) => writeHome(a, SKILL, "edited on A\n"),
      (b) => rmSync(homePath(b, ".claude/skills/review"), { recursive: true }),
    );

    expect((await runTransportBegin(b)).state).toBe("conflicts");
    await runTransportResolve(b, { files: [{ path: SKILL, side: "remote" }] });
    await runTransportCommit(b, undefined);
    expect(readHome(b, SKILL)).toBe("edited on A\n");
    await fullSync(a);
    expect(readHome(a, SKILL)).toBe("edited on A\n");
  }, 60000);

  it("checks the whole batch before applying any of it", async () => {
    const { b } = await divergeOn(
      (a) => {
        writeHome(a, SKILL, "edited on A\n");
        writeHome(a, ".claude/skills/other/SKILL.md", "other on A\n");
      },
      (b) => {
        rmSync(homePath(b, ".claude/skills/review"), { recursive: true });
        writeHome(b, ".claude/skills/other/SKILL.md", "other on B\n");
      },
    );
    const begin = await runTransportBegin(b);
    expect(begin.state).toBe("conflicts");
    if (begin.state !== "conflicts") return;
    expect(begin.conflicts.map(({ path }) => path)).toEqual([
      ".claude/skills/other/SKILL.md",
      SKILL,
    ]);

    // A valid first entry, then one naming no conflict: nothing is applied.
    await expectCode(
      runTransportResolve(b, {
        files: [
          { path: SKILL, side: "local" },
          { path: ".claude/skills/nope.md", side: "local" },
        ],
      }),
      "not-conflicted",
    );
    // The same path twice is refused as well.
    await expectCode(
      runTransportResolve(b, {
        files: [
          { path: SKILL, side: "local" },
          { path: SKILL, delete: true },
        ],
      }),
      "invalid-input",
    );
    const unmerged = execFileSync("git", ["-C", b.configDir, "ls-files", "-u"], {
      encoding: "utf8",
    });
    expect(unmerged).toContain(SKILL);
    expect(unmerged).toContain(".claude/skills/other/SKILL.md");

    const resolved = await runTransportResolve(b, {
      files: [
        { path: SKILL, side: "local" },
        { path: ".claude/skills/other/SKILL.md", content: "other merged\n" },
      ],
    });
    expect(resolved.remaining).toEqual([]);
  }, 60000);

  it("settles a path both sides deleted without listing it", async () => {
    const renamed = (to: string) => (deps: InternalDeps) => {
      rmSync(homePath(deps, ".claude/skills/review"), { recursive: true });
      writeHome(deps, `.claude/skills/${to}/SKILL.md`, "base\n");
    };
    const { b } = await divergeOn(renamed("review-a"), renamed("review-b"));

    const begin = await runTransportBegin(b);
    expect(begin.state).toBe("conflicts");
    if (begin.state !== "conflicts") return;
    // Each side renamed the skill its own way: the old name, which both
    // deleted, is settled; the two new names remain, each held by one side.
    expect(begin.conflicts.map(({ path }) => path)).toEqual([
      ".claude/skills/review-a/SKILL.md",
      ".claude/skills/review-b/SKILL.md",
    ]);
    expect(begin.conflicts[0]).toMatchObject({ localDeleted: true, remoteDeleted: false });
    expect(begin.conflicts[1]).toMatchObject({ localDeleted: false, remoteDeleted: true });

    const resolved = await runTransportResolve(b, {
      files: [
        { path: ".claude/skills/review-a/SKILL.md", side: "local" },
        { path: ".claude/skills/review-b/SKILL.md", side: "local" },
      ],
    });
    expect(resolved.remaining).toEqual([]);
    await runTransportCommit(b, undefined);
    expect(existsSync(homePath(b, ".claude/skills/review-a"))).toBe(false);
    expect(readHome(b, ".claude/skills/review-b/SKILL.md")).toBe("base\n");
    expect(existsSync(homePath(b, SKILL))).toBe(false);
  }, 60000);

  describe("a link on one side, a directory on the other", () => {
    const GCLOUD = ".claude/skills/gcloud";

    // B replaces the synced directory with a link while A edits a file in it.
    async function divergeWithGcloud() {
      const bare = makeBare();
      const a = makeMachine(bare);
      writeHome(a, `${GCLOUD}/SKILL.md`, "gcloud\n");
      writeHome(a, `${GCLOUD}/ref.md`, "ref\n");
      await fullSync(a);
      const b = makeMachine(bare);
      await fullSync(b);
      writeHome(a, `${GCLOUD}/SKILL.md`, "gcloud on A\n");
      await fullSync(a);
      rmSync(homePath(b, GCLOUD), { recursive: true, force: true });
      symlinkSync("../../.agents/skills/gcloud", homePath(b, GCLOUD));
      return { a, b };
    }

    it.skipIf(process.platform === "win32")(
      "reports one conflict on the path, and restores the link under its own name when picked",
      async () => {
        const { a, b } = await divergeWithGcloud();
        const begin = await runTransportBegin(b);
        expect(begin.state).toBe("conflicts");
        if (begin.state !== "conflicts") return;
        expect(begin.conflicts).toEqual([
          {
            path: GCLOUD,
            binary: false,
            base: null,
            local: "../../.agents/skills/gcloud",
            remote: null,
            localDeleted: false,
            remoteDeleted: false,
            fileDirectory: {
              fileSide: "local",
              fileKind: "symlink",
              directorySide: "remote",
              directoryFiles: [`${GCLOUD}/SKILL.md`, `${GCLOUD}/ref.md`],
            },
          },
        ]);

        await expectCode(
          runTransportResolve(b, { files: [{ path: GCLOUD, content: "x" }] }),
          "invalid-resolution",
        );
        await expectCode(
          runTransportResolve(b, { files: [{ path: `${GCLOUD}/SKILL.md`, side: "local" }] }),
          "not-conflicted",
        );

        const resolved = await runTransportResolve(b, {
          files: [{ path: GCLOUD, side: "local" }],
        });
        expect(resolved).toEqual({ resolved: [GCLOUD], remaining: [] });
        const tracked = execFileSync(
          "git",
          ["-C", b.configDir, "ls-files", "-s", "--", ".claude/skills"],
          { encoding: "utf8" },
        );
        expect(tracked).toMatch(/^120000 \S+ 0\t\.claude\/skills\/gcloud$/m);
        expect(tracked).not.toContain("~");
        expect(tracked).not.toContain(`${GCLOUD}/`);

        await runTransportCommit(b, undefined);
        expect(readlinkSync(homePath(b, GCLOUD))).toBe("../../.agents/skills/gcloud");

        await fullSync(a);
        expect(lstatSync(homePath(a, GCLOUD)).isSymbolicLink()).toBe(true);
      },
      60000,
    );

    it.skipIf(process.platform === "win32")(
      "keeps the directory, with the other side's edits, when it is picked",
      async () => {
        const { b } = await divergeWithGcloud();
        expect((await runTransportBegin(b)).state).toBe("conflicts");

        // The name git parked the link under answers for the conflict too.
        const parked = execFileSync("git", ["-C", b.configDir, "ls-files", "-u"], {
          encoding: "utf8",
        }).match(/\.claude\/skills\/gcloud~\S+/)![0];
        const resolved = await runTransportResolve(b, {
          files: [{ path: parked, side: "remote" }],
        });
        expect(resolved).toEqual({ resolved: [GCLOUD], remaining: [] });

        await runTransportCommit(b, undefined);
        expect(lstatSync(homePath(b, GCLOUD)).isDirectory()).toBe(true);
        expect(readHome(b, `${GCLOUD}/SKILL.md`)).toBe("gcloud on A\n");
        expect(readHome(b, `${GCLOUD}/ref.md`)).toBe("ref\n");
        expect(readdirSync(homePath(b, ".claude/skills"))).toEqual(["gcloud"]);
      },
      60000,
    );
  });
});

describe("transport with excludes", () => {
  const SKILLS = ".claude/skills";

  function trackedOnOrigin(deps: InternalDeps): string[] {
    execFileSync("git", ["-C", deps.configDir, "fetch", "-q"], { stdio: "ignore" });
    return execFileSync(
      "git",
      ["-C", deps.configDir, "ls-tree", "-r", "--name-only", "origin/main"],
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);
  }

  // What a git-agents without excludes did: commit whatever the home
  // directory held. Written straight into the clone and pushed.
  function commitAsOldVersion(deps: InternalDeps, files: Record<string, string>): void {
    for (const [path, content] of Object.entries(files)) {
      const target = join(deps.configDir, ...path.split("/"));
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, content, "utf8");
    }
    const run = (...args: string[]) =>
      execFileSync(
        "git",
        ["-C", deps.configDir, "-c", "user.email=t@t", "-c", "user.name=t", ...args],
        { stdio: "ignore" },
      );
    run("add", "-A", "--", ...Object.keys(files));
    run("commit", "-m", "old version sync");
    run("push", "-q", "origin", "HEAD");
  }

  const CLUTTER = {
    [`${SKILLS}/.trash/old/SKILL.md`]: "old\n",
    [`${SKILLS}/synced/manifest.json`]: "{\"round\":1}\n",
    [`${SKILLS}/synced/.last-complete-round`]: "1\n",
    [`${SKILLS}/synced/.staging/4242/SKILL.md`]: "staging\n",
    [`${SKILLS}/synced/web-skill/SKILL.md`]: "web\n",
    [`${SKILLS}/review/.DS_Store`]: "finder\n",
  };

  function writeClutter(deps: InternalDeps): void {
    for (const [path, content] of Object.entries(CLUTTER)) writeHome(deps, path, content);
  }

  function expectClutter(deps: InternalDeps): void {
    for (const [path, content] of Object.entries(CLUTTER)) {
      expect(readHome(deps, path)).toBe(content);
    }
  }

  it("never sends excluded files from the home directory", async () => {
    const bare = makeBare();
    const a = makeMachine(bare);
    writeHome(a, `${SKILLS}/review/SKILL.md`, "review\n");
    writeClutter(a);

    const begin = await runTransportBegin(a);
    expect(begin.state).toBe("clean");
    if (begin.state !== "clean") return;
    expect(begin.outgoing).toEqual([{ path: SKILLS, status: "added" }]);
    expect(begin.firstSync).toEqual([]);
    await runTransportCommit(a, undefined);

    expect(trackedOnOrigin(a)).toEqual([`${SKILLS}/review/SKILL.md`]);
    expectClutter(a);

    const b = makeMachine(bare);
    await fullSync(b);
    expect(readdirSync(join(b.homeDir, ".claude", "skills"))).toEqual(["review"]);
  }, 60000);

  it("leaves excluded files in the home directory alone when changes come in", async () => {
    const bare = makeBare();
    const a = makeMachine(bare);
    writeHome(a, `${SKILLS}/review/SKILL.md`, "review\n");
    await fullSync(a);
    const b = makeMachine(bare);
    await fullSync(b);
    writeClutter(b);

    // An edit replaces the whole directory on B.
    writeHome(a, `${SKILLS}/review/SKILL.md`, "review, edited\n");
    await fullSync(a);
    const begin = await runTransportBegin(b);
    expect(begin.state).toBe("clean");
    if (begin.state !== "clean") return;
    expect(begin.outgoing).toEqual([]);
    expect(begin.incoming).toEqual([{ path: SKILLS, status: "modified" }]);
    await runTransportCommit(b, undefined);
    expect(readHome(b, `${SKILLS}/review/SKILL.md`)).toBe("review, edited\n");
    expectClutter(b);

    // Deleting every skill deletes none of the excluded files, and the
    // directory they keep is not taken for a skill folder to send back.
    rmSync(join(a.homeDir, ".claude", "skills"), { recursive: true });
    await fullSync(a);
    await fullSync(b);
    expect(existsSync(join(b.homeDir, ".claude", "skills", "review", "SKILL.md"))).toBe(false);
    expectClutter(b);
    const again = await runTransportBegin(b);
    expect(again.state).toBe("clean");
    if (again.state !== "clean") return;
    expect(again.outgoing).toEqual([]);
    expect(again.incoming).toEqual([]);
    await runTransportCommit(b, undefined);
  }, 90000);

  it("drops excluded files an earlier version committed, and no home directory loses them", async () => {
    const bare = makeBare();
    const a = makeMachine(bare);
    writeHome(a, `${SKILLS}/review/SKILL.md`, "review\n");
    await fullSync(a);
    const b = makeMachine(bare);
    await fullSync(b);
    // Both machines hold the clutter, and the old version committed it.
    writeClutter(a);
    writeClutter(b);
    commitAsOldVersion(a, CLUTTER);
    expect(trackedOnOrigin(a)).toContain(`${SKILLS}/synced/manifest.json`);

    const begin = await runTransportBegin(a);
    expect(begin.state).toBe("clean");
    if (begin.state !== "clean") return;
    expect(begin.excluded).toEqual([
      `${SKILLS}/.trash`,
      `${SKILLS}/review/.DS_Store`,
      `${SKILLS}/synced`,
    ]);
    expect(begin.outgoing).toEqual([]);
    await runTransportCommit(a, undefined);
    expect(trackedOnOrigin(a)).toEqual([`${SKILLS}/review/SKILL.md`]);
    expectClutter(a);

    // Nothing is left to drop on the next run.
    const next = await runTransportBegin(a);
    expect(next.state === "clean" && next.excluded).toBeUndefined();
    await runTransportCommit(a, undefined);

    // B pulls the deletions; its own copies stay.
    const pulled = await runTransportBegin(b);
    expect(pulled.state).toBe("clean");
    if (pulled.state !== "clean") return;
    expect(pulled.incoming).toEqual([]);
    expect(pulled.excluded).toBeUndefined();
    await runTransportCommit(b, undefined);
    expectClutter(b);
    expect(readHome(b, `${SKILLS}/review/SKILL.md`)).toBe("review\n");
  }, 90000);

  it("settles conflicts on excluded files by dropping them from the sync repo", async () => {
    const bare = makeBare();
    const a = makeMachine(bare);
    writeHome(a, `${SKILLS}/review/SKILL.md`, "review\n");
    await fullSync(a);
    commitAsOldVersion(a, CLUTTER);
    const b = makeMachine(bare);
    // B was synced by the old version too: its clone holds the clutter.
    execFileSync("git", ["-C", b.configDir, "pull", "-q", "origin", "main"], {
      stdio: "ignore",
    });
    // A, still on the old version, changes the clutter again.
    commitAsOldVersion(a, {
      [`${SKILLS}/synced/manifest.json`]: "{\"round\":2}\n",
      [`${SKILLS}/.trash/old/SKILL.md`]: "older\n",
    });
    writeHome(b, `${SKILLS}/review/SKILL.md`, "review from B\n");

    // B's migration deletes what A modified: modify/delete conflicts, none
    // of which reaches the list.
    const begin = await runTransportBegin(b);
    expect(begin.state).toBe("clean");
    if (begin.state !== "clean") return;
    expect(begin.excluded).toEqual([
      `${SKILLS}/.trash`,
      `${SKILLS}/review/.DS_Store`,
      `${SKILLS}/synced`,
    ]);
    await runTransportCommit(b, undefined);
    expect(trackedOnOrigin(b)).toEqual([`${SKILLS}/review/SKILL.md`]);
    expect(readHome(b, `${SKILLS}/review/SKILL.md`)).toBe("review from B\n");
    expect(existsSync(join(b.homeDir, ".claude", "skills", "synced"))).toBe(false);
  }, 90000);

  it("applies the user's excludes file on every machine it reaches", async () => {
    const bare = makeBare();
    const a = makeMachine(bare);
    writeHome(a, `${SKILLS}/review/SKILL.md`, "review\n");
    writeHome(a, `${SKILLS}/review/notes/mine.md`, "notes of A\n");
    await fullSync(a);
    expect(trackedOnOrigin(a)).toContain(`${SKILLS}/review/notes/mine.md`);

    writeFileSync(join(a.configDir, ".git-agents-excludes"), "# local notes\nnotes\n", "utf8");
    const begin = await runTransportBegin(a);
    expect(begin.state === "clean" && begin.excluded).toEqual([
      `${SKILLS}/review/notes`,
    ]);
    await runTransportCommit(a, undefined);
    expect(trackedOnOrigin(a)).toEqual([
      `${SKILLS}/review/SKILL.md`,
      ".git-agents-excludes",
    ]);
    expect(readHome(a, `${SKILLS}/review/notes/mine.md`)).toBe("notes of A\n");

    const b = makeMachine(bare);
    writeHome(b, `${SKILLS}/review/notes/theirs.md`, "notes of B\n");
    await fullSync(b);
    expect(readHome(b, `${SKILLS}/review/SKILL.md`)).toBe("review\n");
    expect(readHome(b, `${SKILLS}/review/notes/theirs.md`)).toBe("notes of B\n");
    expect(existsSync(join(b.homeDir, ".claude", "skills", "review", "notes", "mine.md"))).toBe(false);
    expect(trackedOnOrigin(b)).not.toContain(`${SKILLS}/review/notes/theirs.md`);
  }, 90000);
});
