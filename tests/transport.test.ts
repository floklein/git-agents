import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
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
import { propagateCanonical } from "../src/canonical/canonical";
import { InternalCommandError } from "../src/internal/errors";
import type { InternalDeps } from "../src/internal/commands";

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
