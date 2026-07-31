import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  runInternalCommand,
  type InternalDeps,
  type StatusReport,
} from "../src/internal/commands";
import { parseInternalArgs, runInternalCli } from "../src/internal/cli";
import type { VersionCheckResult } from "../src/internal/versionCheck";
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

async function statusResult(deps: InternalDeps): Promise<StatusReport> {
  const outcome = await runInternalCommand("status", undefined, deps);
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
  it("reports an unknown command as a structured error", async () => {
    const outcome = await runInternalCommand(
      "does-not-exist",
      undefined,
      makeDeps(),
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("unknown-command");
      expect(outcome.error.message).toContain("status");
    }
  });

  it("status reports an unconfigured machine truthfully", async () => {
    const status = await statusResult(makeDeps());

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
    expect(status.drift.files).toEqual({
      claude: "missing",
      codex: "missing",
      gemini: "missing",
      opencode: "missing",
    });
  });

  it("status reports config, clone, and per-path hashes when present", async () => {
    const deps = makeDeps();
    writeFileSync(deps.configFile, JSON.stringify({ remote: "gh" }), "utf8");
    mkdirSync(join(deps.configDir, ".git"), { recursive: true });
    const claudeDir = join(deps.homeDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    const claudeMd = join(claudeDir, "CLAUDE.md");
    writeFileSync(claudeMd, "# instructions\n", "utf8");

    const status = await statusResult(deps);

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

  it("status tracks generated-file staleness across the canonical lifecycle", async () => {
    const deps = makeDeps();
    mkdirSync(join(deps.configDir, "canonical"), { recursive: true });
    writeFileSync(
      join(deps.configDir, "canonical", "core.md"),
      "# Core\n",
      "utf8",
    );

    const states = async () =>
      Object.fromEntries(
        (await statusResult(deps)).generated.map((g) => [g.harness, g.state]),
      );
    expect((await states()).claude).toBe("missing");

    const propagate = await runInternalCommand("propagate", undefined, deps);
    expect(propagate.ok).toBe(true);
    expect((await states()).claude).toBe("current");
    expect((await states()).codex).toBe("current");

    const claudeMd = join(deps.homeDir, ".claude", "CLAUDE.md");
    writeFileSync(claudeMd, "# hand-edited\n", "utf8");
    expect((await states()).claude).toBe("modified");
    expect((await states()).codex).toBe("current");

    writeFileSync(
      join(deps.configDir, "canonical", "core.md"),
      "# Core v2\n",
      "utf8",
    );
    expect((await states()).codex).toBe("stale");
  });

  it("status output survives a JSON round trip unchanged", async () => {
    const outcome = await runInternalCommand("status", undefined, makeDeps());

    expect(JSON.parse(JSON.stringify(outcome))).toEqual(outcome);
  });
});

describe("version-check", () => {
  async function check(input: unknown, cliVersion?: string) {
    const deps = { ...makeDeps(), ...(cliVersion ? { cliVersion } : {}) };
    const outcome = await runInternalCommand("version-check", input, deps);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("unreachable");
    return outcome.result as VersionCheckResult;
  }

  it("reports an update when the skill is older than the CLI", async () => {
    const result = await check({ skillVersion: "1.0.0" }, "1.1.0");

    expect(result).toEqual({
      skillVersion: "1.0.0",
      cliVersion: "1.1.0",
      updateAvailable: true,
    });
  });

  it("reports no update for an equal or newer skill", async () => {
    expect((await check({ skillVersion: "1.1.0" }, "1.1.0")).updateAvailable).toBe(false);
    expect((await check({ skillVersion: "2.0.0" }, "1.1.0")).updateAvailable).toBe(false);
  });

  it("compares segments numerically, not lexically", async () => {
    expect((await check({ skillVersion: "1.9.0" }, "1.10.0")).updateAvailable).toBe(true);
    expect((await check({ skillVersion: "1.10.0" }, "1.9.0")).updateAvailable).toBe(false);
  });

  it("never errors: missing or malformed input means no update", async () => {
    expect(await check(undefined, "1.1.0")).toEqual({
      skillVersion: null,
      cliVersion: "1.1.0",
      updateAvailable: false,
    });
    expect((await check({}, "1.1.0")).updateAvailable).toBe(false);
    expect((await check({ skillVersion: "banana" }, "1.1.0")).updateAvailable).toBe(false);
    expect((await check({ skillVersion: 42 }, "1.1.0")).updateAvailable).toBe(false);
  });

  it("defaults the CLI version from the package manifest", async () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );

    const result = await check({ skillVersion: "0.0.1" });

    expect(result.cliVersion).toBe(pkg.version);
    expect(result.updateAvailable).toBe(true);
  });

  it("appears in the unknown-command help list", async () => {
    const outcome = await runInternalCommand("nope", undefined, makeDeps());

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.message).toContain("version-check");
  });
});

describe("parseInternalArgs", () => {
  it("rejects a missing command", async () => {
    const parsed = await parseInternalArgs([]);

    expect("error" in parsed).toBe(true);
    if ("error" in parsed) expect(parsed.error.code).toBe("missing-command");
  });

  it("parses a bare command with no input", async () => {
    const parsed = await parseInternalArgs(["status"]);

    expect(parsed).toEqual({ command: "status", input: undefined });
  });

  it("parses JSON input", async () => {
    const parsed = await parseInternalArgs(["status", "--input", '{"a":1}']);

    expect(parsed).toEqual({ command: "status", input: { a: 1 } });
  });

  it("rejects malformed JSON input as a structured error", async () => {
    const parsed = await parseInternalArgs(["status", "--input", "{nope"]);

    expect("error" in parsed).toBe(true);
    if ("error" in parsed) expect(parsed.error.code).toBe("invalid-input");
  });

  it("rejects --input without a value", async () => {
    const parsed = await parseInternalArgs(["status", "--input"]);

    expect("error" in parsed).toBe(true);
    if ("error" in parsed) expect(parsed.error.code).toBe("invalid-input");
  });

  it("reads input from a file, preserving backslashes byte-for-byte", async () => {
    const dir = makeTmpDir("ga-internal-input");
    const payload = {
      content: "use `C:\\nvm4w\\nodejs\\npm.cmd`\nnext line\r\nand `backticks`",
    };
    const file = join(dir, "input.json");
    writeFileSync(file, JSON.stringify(payload), "utf8");

    const parsed = await parseInternalArgs(["stage", "--input-file", file]);

    expect(parsed).toEqual({ command: "stage", input: payload });
  });

  it("reads input from stdin when --input is -", async () => {
    const parsed = await parseInternalArgs(["stage", "--input", "-"], {
      readStdin: async () => '{"a":"C:\\\\nvm4w\\\\nodejs\\\\npm.cmd"}',
    });

    expect(parsed).toEqual({
      command: "stage",
      input: { a: "C:\\nvm4w\\nodejs\\npm.cmd" },
    });
  });

  it("rejects --input-file without a value", async () => {
    const parsed = await parseInternalArgs(["stage", "--input-file"]);

    expect("error" in parsed).toBe(true);
    if ("error" in parsed) expect(parsed.error.code).toBe("invalid-input");
  });

  it("rejects an unreadable input file, naming the channel", async () => {
    const parsed = await parseInternalArgs([
      "stage",
      "--input-file",
      join(makeTmpDir("ga-internal-input"), "missing.json"),
    ]);

    expect("error" in parsed).toBe(true);
    if ("error" in parsed) {
      expect(parsed.error.code).toBe("invalid-input");
      expect(parsed.error.message).toContain("--input-file");
    }
  });

  it("rejects invalid JSON from the file channel, naming the channel", async () => {
    const file = join(makeTmpDir("ga-internal-input"), "input.json");
    writeFileSync(file, "{nope", "utf8");

    const parsed = await parseInternalArgs(["stage", "--input-file", file]);

    expect("error" in parsed).toBe(true);
    if ("error" in parsed) {
      expect(parsed.error.code).toBe("invalid-input");
      expect(parsed.error.message).toContain("--input-file");
    }
  });

  it("rejects invalid JSON from stdin, naming the channel", async () => {
    const parsed = await parseInternalArgs(["stage", "--input", "-"], {
      readStdin: async () => "{nope",
    });

    expect("error" in parsed).toBe(true);
    if ("error" in parsed) {
      expect(parsed.error.code).toBe("invalid-input");
      expect(parsed.error.message).toContain("stdin");
    }
  });

  it("rejects a failing stdin read, naming the channel", async () => {
    const parsed = await parseInternalArgs(["stage", "--input", "-"], {
      readStdin: async () => {
        throw new Error("stream closed");
      },
    });

    expect("error" in parsed).toBe(true);
    if ("error" in parsed) {
      expect(parsed.error.code).toBe("invalid-input");
      expect(parsed.error.message).toContain("stdin");
    }
  });

  it("rejects combining --input and --input-file", async () => {
    const file = join(makeTmpDir("ga-internal-input"), "input.json");
    writeFileSync(file, "{}", "utf8");

    const parsed = await parseInternalArgs([
      "stage",
      "--input",
      "{}",
      "--input-file",
      file,
    ]);

    expect("error" in parsed).toBe(true);
    if ("error" in parsed) expect(parsed.error.code).toBe("invalid-input");
  });
});

describe("runInternalCli", () => {
  async function captureRun(args: string[]) {
    const lines: string[] = [];
    const exitCode = await runInternalCli(args, (line) => lines.push(line));
    return { lines, exitCode };
  }

  it("emits exactly one JSON document and exit 0 on success", async () => {
    const { lines, exitCode } = await captureRun(["status"]);

    expect(exitCode).toBe(0);
    expect(lines).toHaveLength(1);
    const outcome = JSON.parse(lines[0]!);
    expect(outcome.ok).toBe(true);
  });

  it("emits exactly one JSON document and exit 1 on errors", async () => {
    const { lines, exitCode } = await captureRun(["does-not-exist"]);

    expect(exitCode).toBe(1);
    expect(lines).toHaveLength(1);
    const outcome = JSON.parse(lines[0]!);
    expect(outcome.ok).toBe(false);
    expect(outcome.error.code).toBe("unknown-command");
  });

  it("turns parse failures into the same JSON envelope", async () => {
    const { lines, exitCode } = await captureRun([]);

    expect(exitCode).toBe(1);
    const outcome = JSON.parse(lines[0]!);
    expect(outcome.error.code).toBe("missing-command");
  });
});
