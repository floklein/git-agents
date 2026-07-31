import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { unifiedDiff } from "../src/utils/textdiff";
import {
  canonicalCorePath,
  canonicalOverlayPath,
  propagateCanonical,
  readCanonical,
} from "../src/canonical/canonical";
import { gatherDrift } from "../src/canonical/gather";
import { runApply, runStage, STAGE_FILE } from "../src/canonical/stage";
import { InternalCommandError } from "../src/internal/errors";
import { runInternalCommand } from "../src/internal/commands";

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

function makeDirs() {
  return {
    configDir: makeTmpDir("ga-stage-config"),
    homeDir: makeTmpDir("ga-stage-home"),
  };
}

function seedCanonical(
  configDir: string,
  core: string,
  overlays: Record<string, string> = {},
): void {
  mkdirSync(join(configDir, "canonical", "overlays"), { recursive: true });
  writeFileSync(canonicalCorePath(configDir), core, "utf8");
  for (const [harness, content] of Object.entries(overlays)) {
    writeFileSync(canonicalOverlayPath(configDir, harness as any), content, "utf8");
  }
}

afterEach(() => {
  for (const dir of tmpDirs) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe("unifiedDiff", () => {
  it("returns an empty string for identical inputs", () => {
    expect(unifiedDiff("a\nb\n", "a\nb\n", "x")).toBe("");
  });

  it("renders a standard unified hunk", () => {
    const diff = unifiedDiff("one\ntwo\nthree\n", "one\nTWO\nthree\n", "file.md");

    expect(diff).toBe(
      "--- a/file.md\n+++ b/file.md\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n",
    );
  });

  it("renders creation from empty with a zero-length old range", () => {
    const diff = unifiedDiff("", "new\n", "file.md");

    expect(diff).toBe("--- a/file.md\n+++ b/file.md\n@@ -0,0 +1,1 @@\n+new\n");
  });

  it("separates distant changes into multiple hunks", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
    const oldText = `${lines.join("\n")}\n`;
    const changed = [...lines];
    changed[0] = "line 0 changed";
    changed[29] = "line 29 changed";
    const diff = unifiedDiff(oldText, `${changed.join("\n")}\n`, "file.md");

    expect(diff.match(/@@ /g)).toHaveLength(2);
  });
});

describe("runStage", () => {
  it("rejects malformed input with invalid-input", () => {
    const { configDir, homeDir } = makeDirs();

    try {
      runStage(configDir, homeDir, { nope: true });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InternalCommandError);
      expect((error as InternalCommandError).code).toBe("invalid-input");
    }
  });

  it("refuses stale inputs at stage time", () => {
    const { configDir, homeDir } = makeDirs();
    seedCanonical(configDir, "# Core\n");
    propagateCanonical(configDir, homeDir);
    const gathered = gatherDrift(configDir, homeDir);

    writeFileSync(join(homeDir, ".claude", "CLAUDE.md"), "# changed\n", "utf8");

    try {
      runStage(configDir, homeDir, {
        core: "# Core v2\n",
        inputs: gathered.inputs,
      });
      expect.unreachable();
    } catch (error) {
      expect((error as InternalCommandError).code).toBe("stale-inputs");
    }
  });

  it("produces diffs for every file apply would touch", () => {
    const { configDir, homeDir } = makeDirs();
    seedCanonical(configDir, "# Core\n");
    propagateCanonical(configDir, homeDir);
    const gathered = gatherDrift(configDir, homeDir);

    const result = runStage(configDir, homeDir, {
      core: "# Core v2\n",
      overlays: { claude: "# Claude extra\n" },
      inputs: gathered.inputs,
    });

    const changedPaths = result.files.filter((f) => f.changed).map((f) => f.path);
    expect(changedPaths).toContain("canonical/core.md");
    expect(changedPaths).toContain("canonical/overlays/claude.md");
    expect(changedPaths).toContain(".claude/CLAUDE.md");
    expect(changedPaths).toContain(".codex/AGENTS.md");
    for (const file of result.files) {
      if (file.changed) expect(file.diff).toContain("@@");
      else expect(file.diff).toBe("");
    }
    expect(existsSync(join(configDir, STAGE_FILE))).toBe(true);
  });

  it("stages a no-change proposal with empty diffs", () => {
    const { configDir, homeDir } = makeDirs();
    seedCanonical(configDir, "# Core\n");
    propagateCanonical(configDir, homeDir);
    const gathered = gatherDrift(configDir, homeDir);

    const result = runStage(configDir, homeDir, {
      core: "# Core\n",
      inputs: gathered.inputs,
    });

    for (const file of result.files) {
      expect(file.changed).toBe(false);
      expect(file.diff).toBe("");
    }
  });

  it("warns when the rendered Codex file approaches the 32 KiB cap", () => {
    const { configDir, homeDir } = makeDirs();
    const gathered = gatherDrift(configDir, homeDir);

    const bigCore = `# Big\n${"x".repeat(29 * 1024)}\n`;
    const result = runStage(configDir, homeDir, {
      core: bigCore,
      inputs: gathered.inputs,
    });

    expect(result.warnings).toEqual([
      expect.objectContaining({ harness: "codex", level: "near-cap" }),
    ]);

    const hugeCore = `# Huge\n${"x".repeat(33 * 1024)}\n`;
    const over = runStage(configDir, homeDir, {
      core: hugeCore,
      inputs: gathered.inputs,
    });
    expect(over.warnings).toEqual([
      expect.objectContaining({ harness: "codex", level: "over-cap" }),
    ]);
  });
});

describe("runApply", () => {
  it("refuses when nothing is staged", () => {
    const { configDir, homeDir } = makeDirs();

    try {
      runApply(configDir, homeDir);
      expect.unreachable();
    } catch (error) {
      expect((error as InternalCommandError).code).toBe("no-stage");
    }
  });

  it("applies a staged proposal end to end", () => {
    const { configDir, homeDir } = makeDirs();
    mkdirSync(join(homeDir, ".claude"), { recursive: true });
    writeFileSync(join(homeDir, ".claude", "CLAUDE.md"), "# my rules\n", "utf8");
    const gathered = gatherDrift(configDir, homeDir);

    runStage(configDir, homeDir, {
      core: "# Unified rules\n",
      overlays: { claude: "# Claude specifics\n" },
      inputs: gathered.inputs,
    });
    const result = runApply(configDir, homeDir);

    expect(result.appliedVersion).toMatch(/^[0-9a-f]{12}$/);
    const canonical = readCanonical(configDir)!;
    expect(canonical.core).toBe("# Unified rules\n");
    expect(canonical.overlays.claude).toBe("# Claude specifics\n");
    const claudeMd = readFileSync(join(homeDir, ".claude", "CLAUDE.md"), "utf8");
    expect(claudeMd).toContain("# Unified rules");
    expect(claudeMd).toContain("ga:begin overlay harness=claude");
    expect(existsSync(join(configDir, STAGE_FILE))).toBe(false);

    const drift = gatherDrift(configDir, homeDir);
    expect(drift.files.every((f) => f.present)).toBe(true);
  });

  it("refuses with stale-inputs when a file changed after stage", async () => {
    const { configDir, homeDir } = makeDirs();
    seedCanonical(configDir, "# Core\n");
    propagateCanonical(configDir, homeDir);
    const gathered = gatherDrift(configDir, homeDir);
    runStage(configDir, homeDir, {
      core: "# Core v2\n",
      inputs: gathered.inputs,
    });

    writeFileSync(
      join(homeDir, ".gemini", "GEMINI.md"),
      "# changed after stage\n",
      "utf8",
    );

    const deps = {
      homeDir,
      configDir,
      configFile: join(configDir, "config.json"),
    };
    const outcome = await runInternalCommand("apply", undefined, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("stale-inputs");
  });

  it("removes overlays dropped from the proposal", () => {
    const { configDir, homeDir } = makeDirs();
    seedCanonical(configDir, "# Core\n", { claude: "# Old overlay\n" });
    propagateCanonical(configDir, homeDir);
    const gathered = gatherDrift(configDir, homeDir);

    runStage(configDir, homeDir, { core: "# Core\n", inputs: gathered.inputs });
    runApply(configDir, homeDir);

    expect(existsSync(canonicalOverlayPath(configDir, "claude"))).toBe(false);
    expect(
      readFileSync(join(homeDir, ".claude", "CLAUDE.md"), "utf8"),
    ).not.toContain("ga:begin overlay");
  });
});
