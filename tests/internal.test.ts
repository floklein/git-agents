import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  runInternalCommand,
  type InternalDeps,
  type StatusReport,
} from "../src/internal/commands";
import { parseInternalArgs, runInternalCli } from "../src/internal/cli";
import { snapshotSyncPath } from "../src/utils/agents";

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
  const homeDir = makeTmpDir("ga-internal-home");
  const configDir = makeTmpDir("ga-internal-config");
  return { homeDir, configDir, configFile: join(configDir, "config.json") };
}

function statusResult(deps: InternalDeps): StatusReport {
  const outcome = runInternalCommand("status", undefined, deps);
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) throw new Error("unreachable");
  return outcome.result as StatusReport;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe("runInternalCommand", () => {
  it("reports an unknown command as a structured error", () => {
    const outcome = runInternalCommand("does-not-exist", undefined, makeDeps());

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("unknown-command");
      expect(outcome.error.message).toContain("status");
    }
  });

  it("status reports an unconfigured machine truthfully", () => {
    const status = statusResult(makeDeps());

    expect(status.configured).toBe(false);
    expect(status.config).toBeNull();
    expect(status.clonePresent).toBe(false);
    expect(status.canonicalVersion).toBeNull();
    expect(status.generated).toHaveLength(4);
    for (const generated of status.generated) {
      expect(generated.state).toBe("no-canonical");
    }
    expect(status.harnesses).toHaveLength(5);
    for (const harness of status.harnesses) {
      for (const syncPath of harness.syncPaths) {
        expect(syncPath.present).toBe(false);
        expect(syncPath.contentHash).toBeUndefined();
      }
    }
    expect(status.drift.available).toBe(true);
    expect(status.drift.files).toEqual({
      claude: "missing",
      codex: "missing",
      gemini: "missing",
      opencode: "missing",
    });
  });

  it("status reports config, clone, and per-path hashes when present", () => {
    const deps = makeDeps();
    writeFileSync(deps.configFile, JSON.stringify({ remote: "gh" }), "utf8");
    mkdirSync(join(deps.configDir, ".git"), { recursive: true });
    const claudeDir = join(deps.homeDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    const claudeMd = join(claudeDir, "CLAUDE.md");
    writeFileSync(claudeMd, "# instructions\n", "utf8");

    const status = statusResult(deps);

    expect(status.configured).toBe(true);
    expect(status.config).toEqual({ remote: "gh" });
    expect(status.clonePresent).toBe(true);

    const claude = status.harnesses.find((h) => h.id === "claude-code")!;
    const entry = claude.syncPaths.find(
      (p) => p.syncPath === ".claude/CLAUDE.md",
    )!;
    expect(entry.present).toBe(true);
    expect(entry.kind).toBe("file");
    expect(entry.path).toBe(claudeMd);
    expect(entry.contentHash).toBe(snapshotSyncPath(claudeMd)!.contentHash);
  });

  it("status tracks generated-file staleness across the canonical lifecycle", () => {
    const deps = makeDeps();
    mkdirSync(join(deps.configDir, "canonical"), { recursive: true });
    writeFileSync(
      join(deps.configDir, "canonical", "core.md"),
      "# Core\n",
      "utf8",
    );

    let states = () =>
      Object.fromEntries(
        statusResult(deps).generated.map((g) => [g.harness, g.state]),
      );
    expect(states().claude).toBe("missing");

    const propagate = runInternalCommand("propagate", undefined, deps);
    expect(propagate.ok).toBe(true);
    expect(states().claude).toBe("current");
    expect(states().codex).toBe("current");

    const claudeMd = join(deps.homeDir, ".claude", "CLAUDE.md");
    writeFileSync(claudeMd, "# hand-edited\n", "utf8");
    expect(states().claude).toBe("modified");
    expect(states().codex).toBe("current");

    writeFileSync(
      join(deps.configDir, "canonical", "core.md"),
      "# Core v2\n",
      "utf8",
    );
    expect(states().codex).toBe("stale");
  });

  it("status output survives a JSON round trip unchanged", () => {
    const outcome = runInternalCommand("status", undefined, makeDeps());

    expect(JSON.parse(JSON.stringify(outcome))).toEqual(outcome);
  });
});

describe("parseInternalArgs", () => {
  it("rejects a missing command", () => {
    const parsed = parseInternalArgs([]);

    expect("error" in parsed).toBe(true);
    if ("error" in parsed) expect(parsed.error.code).toBe("missing-command");
  });

  it("parses a bare command with no input", () => {
    const parsed = parseInternalArgs(["status"]);

    expect(parsed).toEqual({ command: "status", input: undefined });
  });

  it("parses JSON input", () => {
    const parsed = parseInternalArgs(["status", "--input", '{"a":1}']);

    expect(parsed).toEqual({ command: "status", input: { a: 1 } });
  });

  it("rejects malformed JSON input as a structured error", () => {
    const parsed = parseInternalArgs(["status", "--input", "{nope"]);

    expect("error" in parsed).toBe(true);
    if ("error" in parsed) expect(parsed.error.code).toBe("invalid-input");
  });

  it("rejects --input without a value", () => {
    const parsed = parseInternalArgs(["status", "--input"]);

    expect("error" in parsed).toBe(true);
    if ("error" in parsed) expect(parsed.error.code).toBe("invalid-input");
  });
});

describe("runInternalCli", () => {
  function captureRun(args: string[]) {
    const lines: string[] = [];
    const exitCode = runInternalCli(args, (line) => lines.push(line));
    return { lines, exitCode };
  }

  it("emits exactly one JSON document and exit 0 on success", () => {
    const { lines, exitCode } = captureRun(["status"]);

    expect(exitCode).toBe(0);
    expect(lines).toHaveLength(1);
    const outcome = JSON.parse(lines[0]!);
    expect(outcome.ok).toBe(true);
  });

  it("emits exactly one JSON document and exit 1 on errors", () => {
    const { lines, exitCode } = captureRun(["does-not-exist"]);

    expect(exitCode).toBe(1);
    expect(lines).toHaveLength(1);
    const outcome = JSON.parse(lines[0]!);
    expect(outcome.ok).toBe(false);
    expect(outcome.error.code).toBe("unknown-command");
  });

  it("turns parse failures into the same JSON envelope", () => {
    const { lines, exitCode } = captureRun([]);

    expect(exitCode).toBe(1);
    const outcome = JSON.parse(lines[0]!);
    expect(outcome.error.code).toBe("missing-command");
  });
});
